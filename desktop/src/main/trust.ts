import fs from 'node:fs';
import path from 'node:path';
import type { ProjectInspection } from '../shared/ipc';

/**
 * Which project folders the user trusts. A project's own skills (`<project>/.alia/skills`) are instructions the agent
 * follows, and a repository someone else wrote can carry any instructions, so they load only for a folder the user
 * said yes to. The answer is asked once and remembered, in the app's own data folder (never in the project, where
 * a committed file could grant trust to everyone who opens it).
 */
export type TrustState = ProjectInspection['trust'];

interface TrustFile {
  version: 1;
  /** Folder (normalized) to the user's answer. */
  folders: Record<string, { trusted: boolean; at: string }>;
}

const key = (p: string) => {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

export class TrustStore {
  constructor(
    private readonly file: string,
    private readonly now: () => Date = () => new Date()
  ) {}

  private read(): TrustFile {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as Partial<TrustFile>;
      const folders: TrustFile['folders'] = {};
      for (const [k, v] of Object.entries(raw.folders ?? {})) {
        if (v && typeof v.trusted === 'boolean') folders[k] = { trusted: v.trusted, at: typeof v.at === 'string' ? v.at : '' };
      }
      return { version: 1, folders };
    } catch {
      return { version: 1, folders: {} }; // missing or damaged: nothing is trusted
    }
  }

  get(projectPath: string): TrustState {
    const entry = this.read().folders[key(projectPath)];
    return entry ? (entry.trusted ? 'trusted' : 'declined') : 'unknown';
  }

  isTrusted(projectPath: string): boolean {
    return this.get(projectPath) === 'trusted';
  }

  set(projectPath: string, trusted: boolean): void {
    const data = this.read();
    data.folders[key(projectPath)] = { trusted, at: this.now().toISOString() };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
    fs.renameSync(tmp, this.file);
  }
}

/** Names of the skills a folder carries in `.alia/skills` (a folder with a SKILL.md each). */
export function listProjectSkills(projectPath: string): string[] {
  const dir = path.join(projectPath, '.alia', 'skills');
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(dir, d.name, 'SKILL.md')))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

export function inspectProject(trust: TrustStore, projectPath: string): ProjectInspection {
  return { trust: trust.get(projectPath), projectSkills: listProjectSkills(projectPath) };
}
