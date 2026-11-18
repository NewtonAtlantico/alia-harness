import fs from 'node:fs';
import path from 'node:path';
import { getDocumentProxy } from 'unpdf';
import { readDocx } from './docx.js';
import { readPptx } from './pptx.js';

/**
 * Reads business documents as text for the agent, with the provenance the requirement-extraction
 * skills need: `[p. 14]` page markers for PDFs, `[slide 7]` for decks (speaker notes included),
 * and `[part 3: Heading]` for Word documents, which have no stable page numbers.
 *
 * Pure JavaScript (no native binaries), so it packages cleanly with Electron.
 *
 * Not supported, and said so plainly instead of guessing:
 *   - scanned documents (a PDF with no text layer): OCR is not available;
 *   - audio and video recordings: they must be transcribed first;
 *   - the old binary Office formats (.doc, .ppt): save them as .docx / .pptx.
 */

export type DocumentKind = 'pdf' | 'docx' | 'pptx' | 'recording' | 'legacy';

/** What `pages` counts in a document. */
export type DocumentUnit = 'page' | 'slide' | 'part';

const RECORDING_EXTENSIONS = new Set([
  '.mp3', '.wav', '.m4a', '.ogg', '.flac', '.aac', '.wma', '.opus',
  '.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi', '.wmv',
]);
const DOCX_EXTENSIONS = new Set(['.docx', '.docm', '.dotx', '.dotm']);
const PPTX_EXTENSIONS = new Set(['.pptx', '.pptm', '.potx', '.ppsx']);
const LEGACY_EXTENSIONS = new Set(['.doc', '.ppt', '.pps']);

/** Largest document we will try to parse, in bytes. */
export const MAX_DOCUMENT_BYTES = 60 * 1024 * 1024;

/** What kind of document a path is by its extension, or undefined for ordinary files. */
export function documentKind(file: string): DocumentKind | undefined {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (DOCX_EXTENSIONS.has(ext)) return 'docx';
  if (PPTX_EXTENSIONS.has(ext)) return 'pptx';
  if (LEGACY_EXTENSIONS.has(ext)) return 'legacy';
  if (RECORDING_EXTENSIONS.has(ext)) return 'recording';
  return undefined;
}

/** "1 page", "12 slides", "3 parts". */
export function unitLabel(unit: DocumentUnit, count: number): string {
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}

export interface ReadDocumentOptions {
  /** Which pages (slides, parts): `"3"`, `"3-5"`, `"1,4-6"`, `"7-"` (to the end). Default: all. */
  pages?: string | number;
  /** Stop adding pages once the text would exceed this many characters. */
  maxChars?: number;
  /** Stop adding pages once the text would exceed this many lines. */
  maxLines?: number;
}

export interface DocumentText {
  ok: true;
  kind: 'pdf' | 'docx' | 'pptx';
  /** What the "pages" below are: pages (PDF), slides (decks) or parts (Word documents). */
  unit: DocumentUnit;
  /** The text, each page/slide/part introduced by its marker. */
  text: string;
  totalPages: number;
  /** The numbers included in `text`. */
  pagesShown: number[];
  /** The first requested number that did not fit the budget, to continue from. */
  nextPage?: number;
  /** Things the reader should know (pages without text, ignored numbers, images left out). */
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
  total: number,
  unit: DocumentUnit = 'page'
): { pages: number[]; warnings: string[] } | { error: string } {
  const all = Array.from({ length: total }, (_, i) => i + 1);
  if (spec === undefined || spec === null || String(spec).trim() === '') return { pages: all, warnings: [] };

  const chosen = new Set<number>();
  let outOfRange = false;
  for (const raw of String(spec).split(',')) {
    const part = raw.trim();
    const m = /^(\d+)(?:\s*-\s*(\d*))?$/.exec(part);
    if (!m) return { error: `Invalid pages "${spec}". Use a number, a range, or a list: "3", "3-5", "1,4-6", "7-".` };
    const from = Number(m[1]);
    const to = m[2] === undefined ? from : m[2] === '' ? total : Number(m[2]);
    if (from < 1 || to < from) return { error: `Invalid pages "${spec}": "${part}" is not a valid range (numbering starts at 1).` };
    for (let p = from; p <= to; p++) {
      if (p > total) {
        outOfRange = true;
        break;
      }
      chosen.add(p);
    }
  }
  if (chosen.size === 0) return { error: `The document has ${unitLabel(unit, total)}; none of "${spec}" exists.` };
  const warnings = outOfRange ? [`The document has ${unitLabel(unit, total)}; numbers beyond ${total} were ignored.`] : [];
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

/** A document, seen as a numbered series of units that can be read one at a time. */
interface UnitSource {
  kind: 'pdf' | 'docx' | 'pptx';
  unit: DocumentUnit;
  count: number;
  marker(n: number): string;
  /** The text of unit `n` (1-based). */
  text(n: number): Promise<string>;
  isEmpty(text: string): boolean;
  /** What to say when every unit is empty. */
  allEmptyError(name: string, total: number): string;
  /** What to say about specific empty units (`list` is "2, 5", `count` how many). */
  emptyWarning(list: string, count: number): string;
  warnings: string[];
  close(): Promise<void>;
}

const hasText = (text: string) => text.replace(/\s+/g, '').length >= 5;

async function pdfSource(data: Buffer, name: string): Promise<UnitSource | DocumentError> {
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
  return {
    kind: 'pdf',
    unit: 'page',
    count: pdf.numPages,
    marker: (n) => `[p. ${n}]`,
    text: async (n) => {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      return tidy(content.items.map((item: any) => (typeof item.str === 'string' ? item.str + (item.hasEOL ? '\n' : '') : '')).join(''));
    },
    isEmpty: (t) => !hasText(t),
    allEmptyError: (n, total) =>
      `"${n}" looks like a scanned document: it has ${unitLabel('page', total)} but no text layer, ` +
      'and OCR is not available. Ask for a text version of it, or have its content typed or transcribed.',
    emptyWarning: (list, count) => `No text could be extracted from page${count === 1 ? '' : 's'} ${list} (scanned or image-only): their content is missing.`,
    warnings: [],
    close: async () => {
      await pdf.loadingTask.destroy().catch(() => {});
    },
  };
}

function docxSource(data: Buffer, name: string): UnitSource | DocumentError {
  try {
    const { parts, warnings } = readDocx(new Uint8Array(data));
    return {
      kind: 'docx',
      unit: 'part',
      count: parts.length,
      marker: (n) => `[part ${n}${parts[n - 1]?.title ? `: ${parts[n - 1].title}` : ''}]`,
      text: async (n) => parts[n - 1].text,
      isEmpty: (t) => t.trim() === '',
      allEmptyError: (n) => `"${n}" contains no text.`,
      emptyWarning: (list, count) => `Part${count === 1 ? '' : 's'} ${list} ${count === 1 ? 'has' : 'have'} no text.`,
      warnings,
      close: async () => {},
    };
  } catch (err: any) {
    return { ok: false, error: `Could not read "${name}": ${wordFileHint(err)}.` };
  }
}

function pptxSource(data: Buffer, name: string): UnitSource | DocumentError {
  try {
    const { slides, warnings } = readPptx(new Uint8Array(data));
    return {
      kind: 'pptx',
      unit: 'slide',
      count: slides.length,
      marker: (n) => `[slide ${n}${slides[n - 1]?.hidden ? ', hidden' : ''}]`,
      text: async (n) => slides[n - 1].text,
      isEmpty: (t) => t.trim() === '',
      allEmptyError: (n, total) => `"${n}" has ${unitLabel('slide', total)} but no text could be extracted from them (they appear to contain only images). Ask for the content as text.`,
      emptyWarning: (list, count) => `Slide${count === 1 ? '' : 's'} ${list} ${count === 1 ? 'has' : 'have'} no text and no notes.`,
      warnings,
      close: async () => {},
    };
  } catch (err: any) {
    return { ok: false, error: `Could not read "${name}": ${wordFileHint(err)}.` };
  }
}

function wordFileHint(err: any): string {
  const message = String(err?.message ?? err);
  // An encrypted Office file is not a zip at all, so it fails the same way as a damaged one.
  return `it is not a valid Office file, or it is password protected or damaged (${message})`;
}

export async function readDocument(file: string, options: ReadDocumentOptions = {}): Promise<DocumentResult> {
  const kind = documentKind(file);
  const name = path.basename(file);

  if (kind === 'recording') {
    return { ok: false, error: `"${name}" is an audio/video recording and cannot be read. Send a transcript (text) instead.` };
  }
  if (kind === 'legacy') {
    const ext = path.extname(file).toLowerCase();
    return {
      ok: false,
      error: `"${name}" is an old binary Office format (${ext}) that cannot be read. Open it in Word or PowerPoint and save it as ${ext.startsWith('.d') ? '.docx' : '.pptx'}, then try again.`,
    };
  }
  if (kind === undefined) return { ok: false, error: `"${name}" is not a supported document type.` };

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

  const source = kind === 'pdf' ? await pdfSource(data, name) : kind === 'docx' ? docxSource(data, name) : pptxSource(data, name);
  if ('ok' in source) return source;

  try {
    const total = source.count;
    if (total === 0) return { ok: false, error: `"${name}" has no content to read.` };
    const selection = parsePageSpec(options.pages, total, source.unit);
    if ('error' in selection) {
      return { ok: false, error: `${selection.error} ("${name}" has ${unitLabel(source.unit, total)}.)` };
    }

    const maxChars = options.maxChars ?? Infinity;
    const maxLines = options.maxLines ?? Infinity;
    const blocks: string[] = [];
    const shown: number[] = [];
    const empty: number[] = [];
    let chars = 0;
    let lines = 0;
    let nextPage: number | undefined;

    for (let i = 0; i < selection.pages.length; i++) {
      const number = selection.pages[i];
      const body = await source.text(number);
      if (source.isEmpty(body)) empty.push(number);

      let block = `${source.marker(number)}\n${body || '(no text)'}`;
      const blockLines = block.split('\n').length + 1;

      if (shown.length > 0 && (chars + block.length + 2 > maxChars || lines + blockLines > maxLines)) {
        nextPage = number;
        break;
      }
      if (shown.length === 0 && (block.length > maxChars || blockLines > maxLines)) {
        // One unit alone is over budget: keep its start and say so.
        const keepLines = block.split('\n').slice(0, Math.max(1, maxLines - 2)).join('\n');
        const cut = keepLines.slice(0, Math.max(200, maxChars - 120));
        block = `${cut}\n[... ${source.unit} ${number} cut: ${block.length - cut.length} more characters ...]`;
        if (i + 1 < selection.pages.length) nextPage = selection.pages[i + 1];
        blocks.push(block);
        shown.push(number);
        break;
      }
      blocks.push(block);
      shown.push(number);
      chars += block.length + 2;
      lines += blockLines;
    }

    // Nothing but empty units from start to end: a scan, a deck of pictures, a blank file.
    if (nextPage === undefined && shown.length > 0 && empty.length === shown.length) {
      return { ok: false, error: source.allEmptyError(name, total) };
    }

    const warnings = [...selection.warnings, ...source.warnings];
    const emptyShown = empty.filter((p) => shown.includes(p));
    if (emptyShown.length > 0) {
      const list = emptyShown.slice(0, 20).join(', ') + (emptyShown.length > 20 ? ', ...' : '');
      warnings.push(source.emptyWarning(list, emptyShown.length));
    }

    return { ok: true, kind: source.kind, unit: source.unit, text: blocks.join('\n\n'), totalPages: total, pagesShown: shown, nextPage, warnings };
  } catch (err: any) {
    return { ok: false, error: `Could not read "${name}": ${err?.message ?? err}` };
  } finally {
    await source.close();
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
