/**
 * A unified diff (`git diff` style, as core produces it) as lines a view can draw: what each line is, and its number in
 * the old and the new file. No React, no DOM.
 */
export type DiffLineKind = 'meta' | 'hunk' | 'add' | 'remove' | 'context' | 'note';

export interface DiffLine {
  kind: DiffLineKind;
  /** The line without its leading +, - or space (the whole line for meta, hunk and note lines). */
  text: string;
  oldNo?: number;
  newNo?: number;
}

export interface ParsedDiff {
  lines: DiffLine[];
  added: number;
  removed: number;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Parses a unified diff. The `---`/`+++` header lines are kept as `meta` lines (a view may hide them: the path is shown elsewhere). */
export function parseDiff(diff: string): ParsedDiff {
  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;

  for (const raw of diff.replace(/\r\n/g, '\n').split('\n')) {
    if (raw === '' && lines.length > 0 && !inHunk) continue;
    const hunk = HUNK.exec(raw);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      inHunk = true;
      lines.push({ kind: 'hunk', text: raw });
      continue;
    }
    if (!inHunk) {
      if (raw.trim()) lines.push({ kind: 'meta', text: raw });
      continue;
    }
    if (raw.startsWith('\\')) {
      lines.push({ kind: 'note', text: raw.replace(/^\\ ?/, '') });
    } else if (raw.startsWith('+')) {
      lines.push({ kind: 'add', text: raw.slice(1), newNo: newNo++ });
      added++;
    } else if (raw.startsWith('-')) {
      lines.push({ kind: 'remove', text: raw.slice(1), oldNo: oldNo++ });
      removed++;
    } else if (raw.startsWith(' ')) {
      lines.push({ kind: 'context', text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ });
    } else if (raw === '') {
      // A blank context line that lost its leading space (some tools trim it), at the very end of the diff or inside a hunk.
      lines.push({ kind: 'context', text: '', oldNo: oldNo++, newNo: newNo++ });
    } else {
      lines.push({ kind: 'meta', text: raw });
      inHunk = false;
    }
  }
  // A trailing empty "context" line is only the diff's final newline.
  while (lines.length > 0 && lines.at(-1)!.kind === 'context' && lines.at(-1)!.text === '' && diff.endsWith('\n')) lines.pop();
  return { lines, added, removed };
}

/** A short name for what happened to a file, from the diff's own header. */
export function diffKind(diff: string): 'created' | 'deleted' | 'modified' {
  if (/^--- \/dev\/null/m.test(diff)) return 'created';
  if (/^\+\+\+ \/dev\/null/m.test(diff)) return 'deleted';
  return 'modified';
}
