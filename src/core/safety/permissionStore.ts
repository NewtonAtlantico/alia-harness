import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectFolderName } from '../projectKey.js';

/**
 * Per-project allowlist behind "Always allow in this project".
 *
 * It lives in the user's home (`~/.alia/permissions/<project>-<hash>.json`), not inside the
 * workspace: a committed allowlist would pre-approve commands for everyone who opens the repo.
 * The file is plain JSON so it can be read and edited by hand.
 */

export type PermissionMatch = 'exact' | 'prefix';

export interface PermissionRule {
  command: string;
  match: PermissionMatch;
  addedAt: string;
}

interface PermissionFile {
  version: 1;
  workspace: string;
  allow: PermissionRule[];
}

export interface PermissionStoreOptions {
  /** Folder for the permission files. Default `~/.alia/permissions`. */
  dir?: string;
}

/**
 * After a prefix, nothing may chain, redirect or substitute another command: `npm run build &&
 * rm -rf x` must not ride on an allowed `npm run build`.
 */
const SHELL_CONTROL = /[;&|<>`$\r\n]/;

/** True when `command` is `prefix` itself or `prefix` plus plain arguments. */
export function matchesPrefix(command: string, prefix: string): boolean {
  const cmd = command.trim();
  const pre = prefix.trim();
  if (!pre || SHELL_CONTROL.test(pre)) return false;
  if (cmd === pre) return true;
  return cmd.startsWith(pre + ' ') && !SHELL_CONTROL.test(cmd.slice(pre.length));
}

function ruleMatches(rule: PermissionRule, command: string): boolean {
  return rule.match === 'prefix' ? matchesPrefix(command, rule.command) : command.trim() === rule.command;
}

export class PermissionStore {
  readonly workspace: string;
  readonly filePath: string;

  constructor(workspace: string, options: PermissionStoreOptions = {}) {
    this.workspace = path.resolve(workspace);
    const dir = options.dir ?? path.join(os.homedir(), '.alia', 'permissions');
    this.filePath = path.join(dir, `${projectFolderName(this.workspace)}.json`);
  }

  /** Reads the file every time, so several sessions on one project always agree. */
  list(): PermissionRule[] {
    return this.read().allow;
  }

  isAllowed(command: string): boolean {
    return this.read().allow.some((rule) => ruleMatches(rule, command));
  }

  /** Adds a rule (no-op if it exists) and returns it. Throws if the file cannot be written. */
  add(command: string, match: PermissionMatch = 'exact'): PermissionRule {
    const cmd = command.trim();
    if (!cmd) throw new Error('Cannot allow an empty command.');
    if (match === 'prefix' && SHELL_CONTROL.test(cmd)) {
      throw new Error('A prefix rule cannot contain shell operators (; & | < > ` $).');
    }
    const file = this.read();
    const existing = file.allow.find((r) => r.match === match && r.command === cmd);
    if (existing) return existing;
    const rule: PermissionRule = { command: cmd, match, addedAt: new Date().toISOString() };
    file.allow.push(rule);
    this.write(file);
    return rule;
  }

  remove(command: string, match?: PermissionMatch): boolean {
    const cmd = command.trim();
    const file = this.read();
    const kept = file.allow.filter((r) => !(r.command === cmd && (!match || r.match === match)));
    if (kept.length === file.allow.length) return false;
    file.allow = kept;
    this.write(file);
    return true;
  }

  clear(): void {
    if (fs.existsSync(this.filePath)) this.write({ ...this.read(), allow: [] });
  }

  private read(): PermissionFile {
    const empty: PermissionFile = { version: 1, workspace: this.workspace, allow: [] };
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf-8');
    } catch {
      return empty; // no file yet
    }
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.allow)) throw new Error('unexpected shape');
      const allow = (parsed.allow as any[]).filter(
        (r) => r && typeof r.command === 'string' && (r.match === 'exact' || r.match === 'prefix')
      );
      return { version: 1, workspace: this.workspace, allow };
    } catch {
      // A damaged file grants nothing. It is set aside (not overwritten) on the next write.
      return empty;
    }
  }

  private write(file: PermissionFile): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (fs.existsSync(this.filePath) && !this.isReadable()) {
      fs.renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
    }
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n', 'utf-8');
    fs.renameSync(tmp, this.filePath);
  }

  private isReadable(): boolean {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      return !!parsed && Array.isArray(parsed.allow);
    } catch {
      return false;
    }
  }
}
