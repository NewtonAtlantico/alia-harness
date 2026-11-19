/**
 * Opening a file of the project with the system ("Abrir STATE.md", the pipeline's artifacts). The page names a path inside
 * the project and main decides what is safe: a document is opened by the program the user has for it; a folder is shown;
 * anything else (a script, an executable, a shortcut, an HTML page) is only shown in its folder, never run. Nothing outside
 * the project, and nothing a symlink points out of it. No Electron in here, so a test can throw hostile paths at it.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Documents and images: opening them cannot run code of the project's own. */
const OPENABLE = new Set(['.md', '.markdown', '.txt', '.json', '.csv', '.pdf', '.docx', '.pptx', '.xlsx', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.log']);

export type OpenDecision =
  | { ok: true; abs: string; how: 'open' | 'reveal' }
  | { ok: false; reason: 'outside' | 'missing' };

const within = (root: string, target: string): boolean => {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

export function decideOpen(projectPath: string, relPath: string): OpenDecision {
  let root: string;
  try {
    root = fs.realpathSync(path.resolve(projectPath));
  } catch {
    return { ok: false, reason: 'missing' };
  }
  const wanted = path.resolve(root, relPath);
  if (!within(root, wanted)) return { ok: false, reason: 'outside' };
  let real: string;
  let stat: fs.Stats;
  try {
    real = fs.realpathSync(wanted);
    stat = fs.statSync(real);
  } catch {
    return { ok: false, reason: 'missing' };
  }
  if (!within(root, real)) return { ok: false, reason: 'outside' };
  if (stat.isDirectory()) return { ok: true, abs: real, how: 'open' };
  return { ok: true, abs: real, how: OPENABLE.has(path.extname(real).toLowerCase()) ? 'open' : 'reveal' };
}
