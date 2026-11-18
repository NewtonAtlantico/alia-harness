import fs from 'node:fs';
import path from 'node:path';
import { createTwoFilesPatch, diffLines } from 'diff';
import { detectBinaryFile } from '../tools/fileUtils.js';

/**
 * What the agent changed on disk through `write_file` and `edit_file`, for a "Changes" panel with
 * diffs and Undo / Keep. One entry per file, holding the file's content from before the agent
 * first touched it and as it is now, so several edits to one file show as one diff.
 *
 * Known limitation: files changed by commands run with `run_bash` (formatters, `sed`, build
 * output) are not tracked.
 */

/** Files bigger than this (in characters) are not kept in memory for diff/undo. */
export const MAX_TRACKED_CHARS = 1_000_000;

export type UntrackedReason = 'binary' | 'too_large';

/** What a tool reports after writing a file. `before` is null when the file did not exist. */
export interface RecordedChange {
  /** Absolute path of the file. */
  absPath: string;
  before: string | null;
  after: string | null;
  /** Folders the write had to create, outermost first. Undo removes them again when they are empty. */
  createdDirs?: string[];
  /** Set when the content could not be kept (see {@link MAX_TRACKED_CHARS}): shown, but cannot be diffed or undone. */
  untracked?: UntrackedReason;
}

export interface FileChange {
  /** Relative to the workspace, with forward slashes (absolute if outside it). */
  path: string;
  absPath: string;
  /** Content before the agent's first change in this batch; null if the file was created. */
  before: string | null;
  /** Content now, as the agent left it. */
  after: string | null;
  kind: 'created' | 'modified' | 'untracked';
  added: number;
  removed: number;
  createdDirs: string[];
  untracked?: UntrackedReason;
  runId?: string;
  toolCallId?: string;
}

/** The small, content-free description carried by `tool_call_finished` events. */
export interface FileChangeSummary {
  path: string;
  kind: 'created' | 'modified' | 'untracked';
  added: number;
  removed: number;
}

export interface RevertResult {
  /** Files put back (or deleted, if the agent created them). */
  reverted: string[];
  skipped: Array<{ path: string; reason: 'modified' | 'untracked' | 'unknown' | 'failed'; detail?: string }>;
}

function lineStats(before: string | null, after: string | null): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const part of diffLines(before ?? '', after ?? '')) {
    if (part.added) added += part.count ?? 0;
    else if (part.removed) removed += part.count ?? 0;
  }
  return { added, removed };
}

const fsKey = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);

export class ChangeTracker {
  readonly workspace: string;
  private entries = new Map<string, FileChange>();

  constructor(workspace: string) {
    this.workspace = path.resolve(workspace);
  }

  private relative(absPath: string): string {
    const rel = path.relative(this.workspace, absPath);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : absPath;
  }

  /** Describes a change without keeping it (used when no tracker is in play). */
  summarize(change: RecordedChange): FileChangeSummary {
    const untracked = change.untracked;
    const { added, removed } = untracked ? { added: 0, removed: 0 } : lineStats(change.before, change.after);
    return {
      path: this.relative(change.absPath),
      kind: untracked ? 'untracked' : change.before === null ? 'created' : 'modified',
      added,
      removed,
    };
  }

  /**
   * Records one write. Returns the summary of this write alone (what the tool call changed); the
   * tracker's own entry is the net change of the file since the first write.
   */
  record(change: RecordedChange & { runId?: string; toolCallId?: string }): FileChangeSummary {
    const summary = this.summarize(change);
    const key = fsKey(path.resolve(change.absPath));
    const existing = this.entries.get(key);

    if (!existing) {
      // Writing back what is already there changes nothing worth reviewing.
      if (!change.untracked && change.before === change.after) return summary;
      this.entries.set(key, this.entry(change, change.before, change.createdDirs ?? []));
      return summary;
    }

    // If the file was edited by someone else since the agent last wrote it, that edit is theirs: it
    // becomes the new baseline, so Undo never throws it away.
    const baseline = existing.after === change.before || existing.untracked || change.untracked ? existing.before : change.before;
    const dirs = [...new Set([...existing.createdDirs, ...(change.createdDirs ?? [])])];
    const merged = this.entry({ ...change, untracked: existing.untracked ?? change.untracked }, baseline, dirs);
    merged.runId = existing.runId ?? change.runId;
    merged.toolCallId = existing.toolCallId ?? change.toolCallId;

    // Back to exactly what it was: nothing left to review.
    if (!merged.untracked && merged.before === merged.after) this.entries.delete(key);
    else this.entries.set(key, merged);
    return summary;
  }

  private entry(change: RecordedChange & { runId?: string; toolCallId?: string }, before: string | null, dirs: string[]): FileChange {
    const untracked = change.untracked;
    const { added, removed } = untracked ? { added: 0, removed: 0 } : lineStats(before, change.after);
    return {
      path: this.relative(change.absPath),
      absPath: path.resolve(change.absPath),
      before: untracked ? null : before,
      after: untracked ? null : change.after,
      kind: untracked ? 'untracked' : before === null ? 'created' : 'modified',
      added,
      removed,
      createdDirs: dirs,
      untracked,
      runId: change.runId,
      toolCallId: change.toolCallId,
    };
  }

  /** Pending changes, in the order the agent first touched each file. */
  list(): FileChange[] {
    return [...this.entries.values()];
  }

  get(file: string): FileChange | undefined {
    return this.find(file);
  }

  get size(): number {
    return this.entries.size;
  }

  /** The net change of one file as a unified diff (`git diff` style). Undefined if the file is not tracked. */
  diff(file: string): string | undefined {
    const change = this.find(file);
    if (!change) return undefined;
    if (change.untracked) {
      return `(${change.path}: ${change.untracked === 'binary' ? 'binary file' : 'file too large'}; no diff available)\n`;
    }
    const patch = createTwoFilesPatch(
      change.before === null ? '/dev/null' : `a/${change.path}`,
      `b/${change.path}`,
      change.before ?? '',
      change.after ?? '',
      undefined,
      undefined,
      { context: 3 }
    );
    // jsdiff prefixes the patch with an "Index:" banner; the diff proper starts at the --- line.
    return patch.slice(patch.indexOf('--- '));
  }

  /**
   * Puts files back as they were: restores the old content, or deletes a file the agent created
   * (and the folders it had to create, if they are empty). A file that was changed again after the
   * agent wrote it (by the user, an editor, a command) is skipped and reported, never overwritten.
   * With no `paths`, every pending change.
   */
  revert(paths?: string[]): RevertResult {
    const result: RevertResult = { reverted: [], skipped: [] };
    const targets: Array<[string, FileChange | undefined]> = paths
      ? paths.map((p) => [p, this.find(p)])
      : this.list().map((c) => [c.path, c]);

    for (const [label, change] of targets) {
      if (!change) {
        result.skipped.push({ path: label, reason: 'unknown' });
        continue;
      }
      if (change.untracked) {
        result.skipped.push({ path: change.path, reason: 'untracked', detail: change.untracked });
        continue;
      }
      let current: string | null;
      try {
        current = fs.existsSync(change.absPath) ? fs.readFileSync(change.absPath, 'utf-8') : null;
      } catch (err: any) {
        result.skipped.push({ path: change.path, reason: 'failed', detail: err.message });
        continue;
      }
      if (current !== change.after) {
        result.skipped.push({ path: change.path, reason: 'modified' });
        continue;
      }
      try {
        if (change.before === null) {
          if (current !== null) fs.rmSync(change.absPath, { force: true });
          this.removeEmptyDirs(change.createdDirs);
        } else {
          fs.writeFileSync(change.absPath, change.before, 'utf-8');
        }
        this.entries.delete(fsKey(change.absPath));
        result.reverted.push(change.path);
      } catch (err: any) {
        result.skipped.push({ path: change.path, reason: 'failed', detail: err.message });
      }
    }
    return result;
  }

  /** Accepts changes: forgets them (the files stay as they are). With no `paths`, all. Returns how many were cleared. */
  keep(paths?: string[]): number {
    if (!paths) {
      const n = this.entries.size;
      this.entries.clear();
      return n;
    }
    let n = 0;
    for (const p of paths) {
      const change = this.find(p);
      if (change && this.entries.delete(fsKey(change.absPath))) n++;
    }
    return n;
  }

  private find(file: string): FileChange | undefined {
    const abs = path.isAbsolute(file) ? file : path.resolve(this.workspace, file);
    return this.entries.get(fsKey(path.resolve(abs)));
  }

  private removeEmptyDirs(dirs: string[]): void {
    for (const dir of [...dirs].reverse()) {
      try {
        // rmdir refuses a folder with anything in it, which is exactly the guard we want.
        fs.rmdirSync(dir);
      } catch {
        // not empty, or already gone
      }
    }
  }
}

/**
 * What a file contained before it is overwritten: its text, null if it does not exist, or the
 * reason it cannot be kept (binary, too big).
 */
export function readBeforeState(file: string): { content: string | null; untracked?: UntrackedReason } {
  try {
    if (!fs.existsSync(file)) return { content: null };
    const stat = fs.statSync(file);
    if (!stat.isFile()) return { content: null };
    if (stat.size > MAX_TRACKED_CHARS * 4) return { content: null, untracked: 'too_large' };
    if (detectBinaryFile(file).binary) return { content: null, untracked: 'binary' };
    const text = fs.readFileSync(file, 'utf-8');
    if (text.length > MAX_TRACKED_CHARS) return { content: null, untracked: 'too_large' };
    return { content: text };
  } catch {
    return { content: null };
  }
}

/** The folders `mkdir -p dirname(file)` would have to create, outermost first. */
export function missingDirs(file: string): string[] {
  const missing: string[] = [];
  let dir = path.dirname(path.resolve(file));
  while (!fs.existsSync(dir)) {
    missing.unshift(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return missing;
}
