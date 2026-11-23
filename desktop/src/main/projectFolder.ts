/**
 * The folder of a project the simple view creates: named after what the person called it, inside the app's own projects folder.
 * No Electron in here, so a test can throw odd names at it.
 */
import fs from 'node:fs';
import path from 'node:path';

/** "Reembolso de despesas" becomes `reembolso-de-despesas`: no accents, nothing a file system dislikes, never empty. */
export function folderSlug(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug || 'projeto';
}

/** Creates the folder (a new one: `-2`, `-3`… when the name is taken) and returns its path. */
export function createProjectFolder(root: string, name: string): string {
  fs.mkdirSync(root, { recursive: true });
  const base = folderSlug(name);
  for (let n = 1; n < 1000; n++) {
    const folder = path.join(root, n === 1 ? base : `${base}-${n}`);
    try {
      fs.mkdirSync(folder);
      return folder;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  throw new Error('There are too many projects with that name.');
}
