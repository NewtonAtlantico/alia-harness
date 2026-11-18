import fs from 'node:fs';
import path from 'node:path';
import { IGNORED_DIRS, BINARY_EXTENSIONS } from '../tools/fileUtils.js';

/**
 * A single workspace entry (file or directory) surfaced by the @-mention preview.
 * `path` is always workspace-relative with forward slashes for display purposes.
 */
export interface WorkspaceEntry {
  path: string;
  isDir: boolean;
  /** File size in bytes (0 for directories). */
  size: number;
  /** Number of direct children (directories only). */
  childCount: number;
}

/** Hard caps so huge repositories cannot stall the interactive prompt. */
const MAX_ENTRIES = 10_000;
const MAX_DEPTH = 8;

/** Maximum entries rendered in the @-mention preview box. */
export const FILE_PREVIEW_LIMIT = 8;

/**
 * Lightweight, cached index of workspace files used to power the interactive
 * `@` file-mention preview. The walk skips noise directories (node_modules,
 * .git, ...), binary files, and symlinks to stay fast and relevant.
 */
export class FileIndex {
  private cwd: string;
  private ttlMs: number;
  private entries: WorkspaceEntry[] = [];
  private sorted: WorkspaceEntry[] = [];
  private hasBuilt = false;
  private builtAt = 0;

  constructor(cwd: string, ttlMs = 15_000) {
    this.cwd = cwd;
    this.ttlMs = ttlMs;
  }

  /**
   * Rebuild the index if the cache is stale. Cheap no-op otherwise, so it is
   * safe to call on every keystroke.
   */
  refresh(force = false): void {
    if (!force && this.hasBuilt && Date.now() - this.builtAt < this.ttlMs) {
      return;
    }

    const entries: WorkspaceEntry[] = [];
    try {
      this.collect(this.cwd, '', 0, entries, false);
    } catch {
      // Keep whatever we already have on transient filesystem errors.
      return;
    }

    this.entries = entries;
    this.sorted = [...entries].sort((a, b) => {
      const depthDiff = a.path.split('/').length - b.path.split('/').length;
      if (depthDiff !== 0) return depthDiff;
      return a.path.localeCompare(b.path);
    });
    this.hasBuilt = true;
    this.builtAt = Date.now();
  }

  /**
   * Rank workspace entries against a typed query.
   * Exact > basename prefix > path prefix > substring > fuzzy subsequence.
   */
  search(query: string, limit = FILE_PREVIEW_LIMIT): { matches: WorkspaceEntry[]; total: number } {
    this.refresh();
    const q = normalizeQuery(query);

    if (q === '') {
      return { matches: this.sorted.slice(0, limit), total: this.sorted.length };
    }

    const scored: Array<{ entry: WorkspaceEntry; score: number }> = [];
    for (const entry of this.entries) {
      const p = entry.path.toLowerCase();
      const base = p.slice(p.lastIndexOf('/') + 1);

      let score: number;
      if (p === q || base === q) score = 1000;
      else if (base.startsWith(q)) score = 800;
      else if (p.startsWith(q)) score = 700;
      else if (base.includes(q)) score = 600;
      else if (p.includes(q)) score = 500;
      else {
        score = fuzzyScore(p, q);
        if (score <= 0) continue;
      }

      score -= entry.path.split('/').length; // prefer shallower paths on ties
      scored.push({ entry, score });
    }

    scored.sort((a, b) => b.score - a.score || a.entry.path.localeCompare(b.entry.path));
    return { matches: scored.slice(0, limit).map((s) => s.entry), total: scored.length };
  }

  /**
   * True when the typed query is already the complete path of a known file.
   * Used to auto-dismiss the preview once a mention is fully typed/inserted.
   */
  exactFileMatch(query: string): boolean {
    this.refresh();
    const q = normalizeQuery(query);
    if (!q) return false;
    return this.entries.some((e) => !e.isDir && e.path.toLowerCase() === q);
  }

  private collect(
    absDir: string,
    rel: string,
    depth: number,
    out: WorkspaceEntry[],
    includeSelf: boolean
  ): void {
    if (out.length >= MAX_ENTRIES || depth > MAX_DEPTH) return;

    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }

    dirents.sort((a, b) => a.name.localeCompare(b.name));

    if (includeSelf) {
      out.push({ path: rel, isDir: true, size: 0, childCount: dirents.length });
    }

    for (const dirent of dirents) {
      if (out.length >= MAX_ENTRIES) return;
      if (dirent.isSymbolicLink()) continue; // avoid cycles and foreign trees

      const childRel = rel ? `${rel}/${dirent.name}` : dirent.name;
      const childAbs = path.join(absDir, dirent.name);

      if (dirent.isDirectory()) {
        if (IGNORED_DIRS.has(dirent.name)) continue;
        this.collect(childAbs, childRel, depth + 1, out, true);
      } else if (dirent.isFile()) {
        const ext = path.extname(dirent.name).toLowerCase();
        if (BINARY_EXTENSIONS.has(ext)) continue;
        let size = 0;
        try {
          size = fs.statSync(childAbs).size;
        } catch {
          // Unreadable stat: list it with unknown size
        }
        out.push({ path: childRel, isDir: false, size, childCount: 0 });
      }
    }
  }
}

function normalizeQuery(query: string): string {
  return query.toLowerCase().replace(/\\/g, '/').replace(/^\.?\/+/, '');
}

/**
 * Simple subsequence scoring: rewards consecutive-character streaks and
 * penalizes gaps. Always returns well below the substring tiers (~240 max)
 * so substring matches keep priority.
 */
function fuzzyScore(target: string, query: string): number {
  let targetIdx = 0;
  let score = 240;
  let streak = 0;

  for (let i = 0; i < query.length; i++) {
    const found = target.indexOf(query[i], targetIdx);
    if (found === -1) return 0;

    if (found === targetIdx && i > 0) {
      streak += 1;
      score += 6 * streak;
    } else {
      streak = 0;
      score -= Math.min(8, found - targetIdx);
    }
    targetIdx = found + 1;
  }

  return Math.max(1, score - Math.floor(target.length / 4));
}
