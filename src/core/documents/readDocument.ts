import fs from 'node:fs';
import path from 'node:path';
import { getDocumentProxy } from 'unpdf';

/**
 * Reads business documents as text for the agent, with the provenance the requirement-extraction
 * skills need: `[p. 14]` page markers, so a requirement can cite where it came from.
 *
 * Pure JavaScript (no native binaries), so it packages cleanly with Electron.
 *
 * Not supported, and said so plainly instead of guessing:
 *   - scanned documents (a PDF with no text layer): OCR is not available;
 *   - audio and video recordings: they must be transcribed first.
 */

export type DocumentKind = 'pdf' | 'recording';

const RECORDING_EXTENSIONS = new Set([
  '.mp3', '.wav', '.m4a', '.ogg', '.flac', '.aac', '.wma', '.opus',
  '.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi', '.wmv',
]);

/** Largest document we will try to parse, in bytes. */
export const MAX_DOCUMENT_BYTES = 60 * 1024 * 1024;

/** What kind of document a path is by its extension, or undefined for ordinary files. */
export function documentKind(file: string): DocumentKind | undefined {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (RECORDING_EXTENSIONS.has(ext)) return 'recording';
  return undefined;
}

export interface ReadDocumentOptions {
  /** Which pages: `"3"`, `"3-5"`, `"1,4-6"`, `"7-"` (to the end). Default: all. */
  pages?: string | number;
  /** Stop adding pages once the text would exceed this many characters. */
  maxChars?: number;
  /** Stop adding pages once the text would exceed this many lines. */
  maxLines?: number;
}

export interface DocumentText {
  ok: true;
  kind: 'pdf';
  /** The text, each page introduced by `[p. N]`. */
  text: string;
  totalPages: number;
  /** The page numbers included in `text`. */
  pagesShown: number[];
  /** The first requested page that did not fit the budget, to continue from. */
  nextPage?: number;
  /** Things the reader should know (pages without text, ignored page numbers). */
  warnings: string[];
}

export interface DocumentError {
  ok: false;
  error: string;
}

export type DocumentResult = DocumentText | DocumentError;

/** Parses a page selection against a document of `total` pages. */
export function parsePageSpec(
  spec: string | number | undefined,
  total: number
): { pages: number[]; warnings: string[] } | { error: string } {
  const all = Array.from({ length: total }, (_, i) => i + 1);
  if (spec === undefined || spec === null || String(spec).trim() === '') return { pages: all, warnings: [] };

  const chosen = new Set<number>();
  let outOfRange = false;
  for (const raw of String(spec).split(',')) {
    const part = raw.trim();
    const m = /^(\d+)(?:\s*-\s*(\d*))?$/.exec(part);
    if (!m) return { error: `Invalid pages "${spec}". Use a page number, a range, or a list: "3", "3-5", "1,4-6", "7-".` };
    const from = Number(m[1]);
    const to = m[2] === undefined ? from : m[2] === '' ? total : Number(m[2]);
    if (from < 1 || to < from) return { error: `Invalid pages "${spec}": "${part}" is not a valid range (pages start at 1).` };
    for (let p = from; p <= to; p++) {
      if (p > total) {
        outOfRange = true;
        break;
      }
      chosen.add(p);
    }
  }
  if (chosen.size === 0) return { error: `The document has ${total} page${total === 1 ? '' : 's'}; none of "${spec}" exists.` };
  const warnings = outOfRange ? [`The document has ${total} pages; page numbers beyond ${total} were ignored.`] : [];
  return { pages: [...chosen].sort((a, b) => a - b), warnings };
}

/** Collapses the ragged whitespace PDF text extraction leaves behind. */
function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const hasText = (text: string) => text.replace(/\s+/g, '').length >= 5;

export async function readDocument(file: string, options: ReadDocumentOptions = {}): Promise<DocumentResult> {
  const kind = documentKind(file);
  const name = path.basename(file);

  if (kind === 'recording') {
    return { ok: false, error: `"${name}" is an audio/video recording and cannot be read. Send a transcript (text) instead.` };
  }
  if (kind !== 'pdf') return { ok: false, error: `"${name}" is not a supported document type.` };

  let data: Buffer;
  try {
    const stat = fs.statSync(file);
    if (stat.size > MAX_DOCUMENT_BYTES) {
      return { ok: false, error: `"${name}" is too large to read (${Math.round(stat.size / 1048576)} MB; the limit is ${MAX_DOCUMENT_BYTES / 1048576} MB).` };
    }
    data = fs.readFileSync(file);
  } catch (err: any) {
    return { ok: false, error: `Could not open "${name}": ${err.message}` };
  }

  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    // verbosity 0: pdf.js logs warnings for damaged-but-readable files; that is noise for a user.
    pdf = await getDocumentProxy(new Uint8Array(data), { verbosity: 0 });
  } catch (err: any) {
    const why = /password/i.test(String(err?.message ?? err))
      ? 'it is password protected'
      : `it could not be parsed (${err?.message ?? err})`;
    return { ok: false, error: `Could not read "${name}": ${why}.` };
  }

  try {
    const totalPages = pdf.numPages;
    const selection = parsePageSpec(options.pages, totalPages);
    if ('error' in selection) return { ok: false, error: `${selection.error} ("${name}" has ${totalPages} page${totalPages === 1 ? '' : 's'}.)` };

    const maxChars = options.maxChars ?? Infinity;
    const maxLines = options.maxLines ?? Infinity;
    const blocks: string[] = [];
    const shown: number[] = [];
    const empty: number[] = [];
    let chars = 0;
    let lines = 0;
    let nextPage: number | undefined;

    for (let i = 0; i < selection.pages.length; i++) {
      const pageNumber = selection.pages[i];
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const raw = content.items.map((item: any) => (typeof item.str === 'string' ? item.str + (item.hasEOL ? '\n' : '') : '')).join('');
      const body = tidy(raw);
      if (!hasText(body)) empty.push(pageNumber);

      let block = `[p. ${pageNumber}]\n${body || '(no text)'}`;
      const blockLines = block.split('\n').length + 1;

      if (shown.length > 0 && (chars + block.length + 2 > maxChars || lines + blockLines > maxLines)) {
        nextPage = pageNumber;
        break;
      }
      if (shown.length === 0 && (block.length > maxChars || blockLines > maxLines)) {
        // One page alone is over budget: keep its start and say so.
        const keepLines = block.split('\n').slice(0, Math.max(1, maxLines - 2)).join('\n');
        const cut = keepLines.slice(0, Math.max(200, maxChars - 120));
        block = `${cut}\n[... page ${pageNumber} cut: ${block.length - cut.length} more characters ...]`;
        if (i + 1 < selection.pages.length) nextPage = selection.pages[i + 1];
        blocks.push(block);
        shown.push(pageNumber);
        break;
      }
      blocks.push(block);
      shown.push(pageNumber);
      chars += block.length + 2;
      lines += blockLines;
    }

    // Nothing but empty pages from start to end: this is a scan (or a drawing), not a text document.
    if (nextPage === undefined && shown.length > 0 && empty.length === shown.length) {
      return {
        ok: false,
        error:
          `"${name}" looks like a scanned document: it has ${totalPages} page${totalPages === 1 ? '' : 's'} but no text layer, ` +
          'and OCR is not available. Ask for a text version of it, or have its content typed or transcribed.',
      };
    }

    const warnings = [...selection.warnings];
    const emptyShown = empty.filter((p) => shown.includes(p));
    if (emptyShown.length > 0) {
      const list = emptyShown.slice(0, 20).join(', ') + (emptyShown.length > 20 ? ', ...' : '');
      warnings.push(`No text could be extracted from page${emptyShown.length === 1 ? '' : 's'} ${list} (scanned or image-only): their content is missing.`);
    }

    return { ok: true, kind: 'pdf', text: blocks.join('\n\n'), totalPages, pagesShown: shown, nextPage, warnings };
  } catch (err: any) {
    return { ok: false, error: `Could not read "${name}": ${err?.message ?? err}` };
  } finally {
    await pdf.loadingTask.destroy().catch(() => {});
  }
}

/** "1-6" for [1..6], "2,4,5" for a gap-ridden list. */
export function describePages(pages: number[]): string {
  if (pages.length === 0) return '';
  const parts: string[] = [];
  let start = pages[0];
  let prev = pages[0];
  for (const p of [...pages.slice(1), Infinity]) {
    if (p === prev + 1) {
      prev = p;
      continue;
    }
    parts.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = p;
    prev = p;
  }
  return parts.join(',');
}
