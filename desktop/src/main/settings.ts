import fs from 'node:fs';
import path from 'node:path';
import type { ModelSetting, PermissionMode, SettingsUpdate } from '../shared/ipc';

/** What `settings.json` holds. No secret is ever in it: the API key lives in the encrypted credentials file. */
export interface StoredSettings {
  version: 1;
  displayName: string;
  organization: string;
  models: ModelSetting[];
  permissionMode: PermissionMode;
  /** Folders the user opened, newest first. Also the list of projects the app will open without asking again. */
  recentProjects: string[];
}

export const MAX_RECENT_PROJECTS = 20;
const MODES: PermissionMode[] = ['ask-dangerous', 'ask-commands', 'auto'];

export function defaultSettings(displayName = ''): StoredSettings {
  return { version: 1, displayName, organization: '', models: [], permissionMode: 'ask-commands', recentProjects: [] };
}

const str = (v: unknown, fallback: string, max = 2048) => (typeof v === 'string' ? v.trim().slice(0, max) : fallback);
const posInt = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined);

/** Reads whatever is in the file and keeps what is usable; a field that is wrong falls back to its default. */
export function normalizeSettings(raw: unknown, defaults: StoredSettings): StoredSettings {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return defaults;
  const r = raw as Record<string, unknown>;
  const models: ModelSetting[] = [];
  if (Array.isArray(r.models)) {
    for (const m of r.models) {
      if (typeof m !== 'object' || m === null) continue;
      const mm = m as Record<string, unknown>;
      const id = str(mm.id, '', 200);
      if (!id || models.some((x) => x.id === id)) continue;
      models.push({
        id,
        name: str(mm.name, id, 200) || id,
        ...(posInt(mm.maxInputTokens) ? { maxInputTokens: posInt(mm.maxInputTokens) } : {}),
        ...(posInt(mm.maxOutputTokens) ? { maxOutputTokens: posInt(mm.maxOutputTokens) } : {}),
        ...(typeof mm.toolCalling === 'boolean' ? { toolCalling: mm.toolCalling } : {}),
        ...(typeof mm.vision === 'boolean' ? { vision: mm.vision } : {}),
      });
    }
  }
  const recent = Array.isArray(r.recentProjects) ? r.recentProjects.filter((p): p is string => typeof p === 'string' && p.length > 0 && p.length <= 1024) : [];
  return {
    version: 1,
    displayName: typeof r.displayName === 'string' ? str(r.displayName, defaults.displayName, 100) : defaults.displayName,
    organization: str(r.organization, defaults.organization, 100),
    models,
    permissionMode: MODES.includes(r.permissionMode as PermissionMode) ? (r.permissionMode as PermissionMode) : defaults.permissionMode,
    recentProjects: [...new Set(recent)].slice(0, MAX_RECENT_PROJECTS),
  };
}

function writeAtomic(file: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

const sameFolder = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

/** The app's settings, in one JSON file in the user's data folder. Written atomically; a damaged file is set aside, not lost. */
export class SettingsStore {
  private current?: StoredSettings;

  constructor(
    readonly file: string,
    private readonly defaults: StoredSettings = defaultSettings()
  ) {}

  /** True once settings have been saved at least once (the first-run test). */
  exists(): boolean {
    return fs.existsSync(this.file);
  }

  get(): StoredSettings {
    if (this.current) return this.current;
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT' && fs.existsSync(this.file)) {
        // Damaged: keep it for inspection and start from defaults rather than failing to start.
        try {
          fs.renameSync(this.file, `${this.file}.damaged-${Date.now()}`);
        } catch {
          /* ignore */
        }
      }
      raw = undefined;
    }
    this.current = normalizeSettings(raw, this.defaults);
    return this.current;
  }

  private save(next: StoredSettings): StoredSettings {
    writeAtomic(this.file, JSON.stringify(next, null, 2) + '\n');
    this.current = next;
    return next;
  }

  update(patch: SettingsUpdate): StoredSettings {
    const cur = this.get();
    return this.save(
      normalizeSettings(
        {
          ...cur,
          ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
          ...(patch.organization !== undefined ? { organization: patch.organization } : {}),
          ...(patch.models !== undefined ? { models: patch.models } : {}),
          ...(patch.permissionMode !== undefined ? { permissionMode: patch.permissionMode } : {}),
        },
        this.defaults
      )
    );
  }

  /** Puts a folder at the top of the recent list. */
  rememberProject(projectPath: string): void {
    const cur = this.get();
    const next = [projectPath, ...cur.recentProjects.filter((p) => !sameFolder(p, projectPath))].slice(0, MAX_RECENT_PROJECTS);
    this.save({ ...cur, recentProjects: next });
  }

  /** Recent folders that still exist. */
  recentProjects(): string[] {
    return this.get().recentProjects.filter((p) => fs.statSync(p, { throwIfNoEntry: false })?.isDirectory());
  }
}
