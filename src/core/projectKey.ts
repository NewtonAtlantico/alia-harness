import crypto from 'node:crypto';
import path from 'node:path';

/**
 * A folder-safe, stable name for a project: `<folder name>-<hash of its full path>`.
 * Used to keep per-project data (permissions, sessions) in the user's home, outside the repo.
 * On Windows `C:\Proj` and `c:\proj` are one project, so the path is lower-cased before hashing.
 */
export function projectFolderName(workspace: string): string {
  const abs = path.resolve(workspace);
  const key = process.platform === 'win32' ? abs.toLowerCase() : abs;
  const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 10);
  const name = path.basename(abs).replace(/[^\w.-]+/g, '_') || 'workspace';
  return `${name}-${hash}`;
}

/** Same project, ignoring case on Windows. */
export function sameWorkspace(a: string, b: string): boolean {
  const x = path.resolve(a);
  const y = path.resolve(b);
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}
