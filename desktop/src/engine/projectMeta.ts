/**
 * What the simple view keeps about a project: its name as the person wrote it, what they asked for, who answers the technical
 * questions, and whether the plan went to the technical team. One small JSON file in the project (`.alia/project.json`), written
 * atomically; a file that cannot be read counts as no file. No Electron in here.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ProjectMeta } from '../shared/ipc';

export const META_FILE = path.join('.alia', 'project.json');

const text = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

/** Keeps the fields that are usable; anything else in the file is dropped. */
export function normalizeMeta(raw: unknown): ProjectMeta {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const handed = r.handedOff as Record<string, unknown> | undefined;
  const at = text(handed?.at, 40);
  return {
    ...(text(r.name, 200) ? { name: text(r.name, 200) } : {}),
    ...(text(r.request, 20_000) ? { request: text(r.request, 20_000) } : {}),
    ...(text(r.owner, 200) ? { owner: text(r.owner, 200) } : {}),
    ...(at && (handed?.mode === 'publish' || handed?.mode === 'drafts') ? { handedOff: { at, mode: handed.mode } } : {}),
  };
}

/** The project's metadata, or null when it has none. Never throws. */
export function readProjectMeta(workspace: string): ProjectMeta | null {
  try {
    const meta = normalizeMeta(JSON.parse(fs.readFileSync(path.join(workspace, META_FILE), 'utf-8')));
    return Object.keys(meta).length > 0 ? meta : null;
  } catch {
    return null;
  }
}

/** Changes the fields present in `patch` (`handedOff: null` clears the mark) and writes the file. */
export function writeProjectMeta(workspace: string, patch: Omit<ProjectMeta, 'handedOff'> & { handedOff?: ProjectMeta['handedOff'] | null }): ProjectMeta {
  const current = readProjectMeta(workspace) ?? {};
  const { handedOff, ...fields } = patch;
  const merged: Record<string, unknown> = { ...current, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) };
  if (handedOff === null) delete merged.handedOff;
  else if (handedOff) merged.handedOff = handedOff;
  const next = normalizeMeta(merged);
  const file = path.join(workspace, META_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return next;
}
