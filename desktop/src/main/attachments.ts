import fs from 'node:fs';
import path from 'node:path';

export const MAX_DROPPED = 100;

/**
 * What the preload reports as dropped on the window. The preload only reports genuine drops, but main still checks
 * what it is given: a list of absolute paths that exist, with a limit on how many. Anything else is dropped silently.
 */
export function sanitizePaths(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw.slice(0, MAX_DROPPED)) {
    if (typeof item !== 'string' || item.length === 0 || item.length > 1024 || item.includes('\0')) continue;
    if (!path.isAbsolute(item)) continue;
    const resolved = path.resolve(item);
    if (!fs.statSync(resolved, { throwIfNoEntry: false })) continue;
    if (!out.includes(resolved)) out.push(resolved);
  }
  return out;
}
