import fs from 'node:fs';
import path from 'node:path';
import { detectBinaryFile, readDocument } from 'alia-harness/core';
import type { FilePreview } from '../shared/ipc';

const TEXT_BYTES = 200_000;
const DOCUMENT_CHARS = 40_000;
const TOO_LARGE_BYTES = 20_000_000;
const DOCUMENTS = new Set(['.pdf', '.docx', '.pptx']);

/** True when `child` is `parent` or inside it, comparing real paths (a link inside the project may not lead out of it). */
function inside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * A read-only look at one file of the project, for the Files tab. It never reads outside the project (also through a
 * symbolic link), never returns more than a few hundred kilobytes, shows a document as the text the agent would read, and
 * says plainly when there is nothing to show (a binary file, a folder, a file that is gone).
 */
export async function previewFile(workspace: string, relative: string): Promise<FilePreview> {
  const root = path.resolve(workspace);
  const abs = path.resolve(root, relative);
  if (!inside(root, abs)) throw new Error(`"${relative}" is outside the project folder.`);
  const shown = path.relative(root, abs).split(path.sep).join('/');

  let real: string;
  try {
    real = fs.realpathSync(abs);
  } catch {
    return { path: shown, size: 0, kind: 'missing' };
  }
  if (!inside(fs.realpathSync(root), real)) throw new Error(`"${relative}" leads outside the project folder.`);

  const stat = fs.statSync(real);
  if (!stat.isFile()) return { path: shown, size: 0, kind: 'not_a_file' };
  const size = stat.size;

  if (DOCUMENTS.has(path.extname(real).toLowerCase())) {
    const doc = await readDocument(real, { maxChars: DOCUMENT_CHARS });
    if (!doc.ok) return { path: shown, size, kind: 'binary', note: doc.error };
    return {
      path: shown,
      size,
      kind: 'document',
      text: doc.text,
      truncated: doc.nextPage !== undefined,
      ...(doc.warnings.length > 0 ? { note: doc.warnings.join(' ') } : {}),
    };
  }

  if (size > TOO_LARGE_BYTES) return { path: shown, size, kind: 'too_large' };
  const binary = detectBinaryFile(real);
  if (binary.binary) return { path: shown, size, kind: 'binary', note: binary.reason };

  const fd = fs.openSync(real, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(size, TEXT_BYTES));
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return { path: shown, size, kind: 'text', text: buffer.subarray(0, read).toString('utf-8'), truncated: size > TEXT_BYTES };
  } finally {
    fs.closeSync(fd);
  }
}
