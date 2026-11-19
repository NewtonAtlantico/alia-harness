import fs from 'node:fs';
import path from 'node:path';

/**
 * Numbers about the task backlog, read from the files `spec-to-tasks` writes
 * (`docs/tasks/<story-slug>-tasks.md`, one `### <title>` block per task with `**Slice:**`,
 * `**Story points:**` and `**Depends on:**` lines), instead of asking the model to count.
 *
 * It is forgiving about how a title carries an id (`1.2 Title`, `T1.2 — Title`, `Task 1.2: Title`)
 * and reports what it cannot make sense of as `problems`, so a wizard can show them.
 */

export const FIBONACCI_POINTS = [1, 2, 3, 5, 8];

export interface TaskSummary {
  /** The id in the heading, when it has one ("1.2"). */
  id?: string;
  title: string;
  slice?: string;
  points?: number;
  /** What the task says it depends on, as written (empty for "none"). */
  dependsOn: string[];
  /** The entries of `dependsOn` that match no task in any file. */
  unresolvedDependsOn: string[];
  /** The entries of `dependsOn` that were found, and in which file (a task of another story, when the file differs from its own). */
  resolvedDependsOn: Array<{ ref: string; file: string; slug: string; id?: string; title: string }>;
}

export interface TaskFileSummary {
  /** Relative to the workspace, with forward slashes. */
  file: string;
  /** `login-sso` for `login-sso-tasks.md`. */
  slug: string;
  /** The file's top heading, if it has one. */
  title?: string;
  tasks: TaskSummary[];
  taskCount: number;
  points: number;
}

export interface TaskStats {
  files: TaskFileSummary[];
  taskCount: number;
  points: number;
  /** Things that break the skill's rules or cannot be read; empty when the backlog is clean. */
  problems: string[];
  /** The tasks of a dependency cycle, in order (the first repeated at the end), or empty. */
  cycle: string[];
}

const ID_PREFIX = /^(?:(?:Task|Tarefa)\s+)?(T?\d+(?:\.\d+)*[a-z]?)\s*(?:[:.\-–—)]\s*|\s+)(.+)$/i;
const FIELD = /^\*\*\s*(Slice|Story points|Points|Pontos|Depends on|Depende de)\s*(?::\s*\*\*|\*\*\s*:)\s*(.*)$/i;
const NO_DEPENDENCY = /^(none|nenhuma?|n\/a|-+|—|–|)$/i;

/** Splits "### 1.2 Title" into its id and title. */
function splitHeading(text: string): { id?: string; title: string } {
  const m = ID_PREFIX.exec(text.trim());
  return m ? { id: m[1], title: m[2].trim() } : { title: text.trim() };
}

const normalizeRef = (s: string) => s.trim().replace(/^(?:task|tarefa)\s+/i, '').replace(/^["'`“”]+|["'`“”.]+$/g, '').toLowerCase();

/** Parses one task file's text. Fenced code blocks are ignored, so an example inside a task is not read as a task. */
export function parseTaskFile(text: string): { title?: string; tasks: Array<TaskSummary & { rawPoints?: string }> } {
  const tasks: Array<TaskSummary & { rawPoints?: string }> = [];
  let title: string | undefined;
  let current: (TaskSummary & { rawPoints?: string }) | undefined;
  let fence = false;

  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;

    const h1 = /^#\s+(.+?)\s*$/.exec(line);
    if (h1 && !current && title === undefined) {
      title = h1[1];
      continue;
    }
    const h3 = /^###\s+(.+?)\s*$/.exec(line);
    if (h3) {
      const { id, title: t } = splitHeading(h3[1]);
      current = { id, title: t, dependsOn: [], unresolvedDependsOn: [], resolvedDependsOn: [] };
      tasks.push(current);
      continue;
    }
    // Another heading of equal or higher rank ends the current task's fields.
    if (/^#{1,2}\s/.test(line)) {
      current = undefined;
      continue;
    }
    if (!current) continue;

    const f = FIELD.exec(line.trim());
    if (!f) continue;
    const key = f[1].toLowerCase();
    const value = f[2].trim();
    if (key === 'slice') current.slice = value || undefined;
    else if (key === 'story points' || key === 'points' || key === 'pontos') {
      current.rawPoints = value;
      const n = /\d+/.exec(value);
      current.points = n ? Number(n[0]) : undefined;
    } else {
      current.dependsOn = value
        // Only commas and semicolons separate references: titles may well contain "and" / "e".
        .split(/\s*[,;]\s*/)
        .map((d) => d.trim())
        .filter((d) => !NO_DEPENDENCY.test(d));
    }
  }
  return { title, tasks };
}

/** Compares "01-a-tasks.md" before "02-b-tasks.md" and "x2" before "x10". */
const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

/**
 * Reads every `*-tasks.md` under `tasksDir` (default `docs/tasks`) and totals them.
 * A missing folder is an empty backlog, not an error.
 */
export function summarizeTasks(workspace: string, tasksDir = 'docs/tasks'): TaskStats {
  const dir = path.resolve(workspace, tasksDir);
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((f) => /-tasks\.md$/i.test(f)).sort(byName);
  } catch {
    // no folder yet
  }

  const problems: string[] = [];
  const files: TaskFileSummary[] = [];
  type Parsed = TaskSummary & { rawPoints?: string };
  const parsedByFile: Array<{ summary: TaskFileSummary; tasks: Parsed[] }> = [];

  for (const name of names) {
    const rel = `${tasksDir.replace(/\\/g, '/').replace(/\/$/, '')}/${name}`;
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, name), 'utf-8');
    } catch (err: any) {
      problems.push(`${rel}: could not be read (${err.message})`);
      continue;
    }
    const { title, tasks } = parseTaskFile(text);
    const summary: TaskFileSummary = {
      file: rel,
      slug: name.replace(/-tasks\.md$/i, ''),
      title,
      tasks: [],
      taskCount: tasks.length,
      points: tasks.reduce((sum, t) => sum + (t.points ?? 0), 0),
    };
    if (tasks.length === 0) problems.push(`${rel}: has no tasks (no "### <title>" blocks)`);

    const ids = new Set<string>();
    for (const t of tasks) {
      const label = `${rel}: "${t.id ? `${t.id} ` : ''}${t.title}"`;
      if (t.points === undefined) problems.push(`${label} has no story points`);
      else if (!FIBONACCI_POINTS.includes(t.points)) {
        problems.push(
          `${label} has ${t.points} points (allowed: ${FIBONACCI_POINTS.join(', ')}${t.points > 8 ? '; split it' : ''})`
        );
      }
      if (t.id) {
        if (ids.has(t.id.toLowerCase())) problems.push(`${rel}: the task id ${t.id} is used more than once`);
        ids.add(t.id.toLowerCase());
      }
    }
    files.push(summary);
    parsedByFile.push({ summary, tasks });
  }

  // Resolve dependencies: same file first, then any file; by id, then by exact title.
  const keyOf = (file: string, t: Parsed) => `${file}::${(t.id ?? t.title).toLowerCase()}`;
  const graph = new Map<string, string[]>();
  for (const { summary, tasks } of parsedByFile) {
    // "T2.1" and "2.1" name the same task.
    const idKey = (id: string) => id.toLowerCase().replace(/^t(?=\d)/, '');
    const find = (ref: string, scope: Array<{ summary: TaskFileSummary; tasks: Parsed[] }>): { file: string; task: Parsed } | undefined => {
      const r = normalizeRef(ref);
      for (const s of scope) {
        const hit = s.tasks.find((t) => (t.id && idKey(t.id) === idKey(r)) || t.title.toLowerCase() === r);
        if (hit) return { file: s.summary.file, task: hit };
      }
      return undefined;
    };
    for (const t of tasks) {
      const edges: string[] = [];
      for (const ref of t.dependsOn) {
        const hit = find(ref, parsedByFile.filter((p) => p.summary === summary)) ?? find(ref, parsedByFile);
        if (hit) {
          edges.push(keyOf(hit.file, hit.task));
          t.resolvedDependsOn.push({ ref, file: hit.file, slug: hit.file.split('/').pop()!.replace(/-tasks\.md$/i, ''), ...(hit.task.id ? { id: hit.task.id } : {}), title: hit.task.title });
        } else {
          t.unresolvedDependsOn.push(ref);
          problems.push(`${summary.file}: "${t.id ? `${t.id} ` : ''}${t.title}" depends on "${ref}", which is not a task`);
        }
      }
      graph.set(keyOf(summary.file, t), edges);
    }
    summary.tasks = tasks.map(({ rawPoints: _raw, ...task }) => task);
  }

  // A cycle means no valid order exists.
  const state = new Map<string, 1 | 2>();
  const cycle: string[] = [];
  const cycleOut: string[] = [];
  const visit = (key: string, trail: string[]): boolean => {
    if (state.get(key) === 2) return false;
    if (state.get(key) === 1) {
      cycle.push(...trail.slice(trail.indexOf(key)), key);
      return true;
    }
    state.set(key, 1);
    for (const next of graph.get(key) ?? []) if (visit(next, [...trail, key])) return true;
    state.set(key, 2);
    return false;
  };
  for (const key of graph.keys()) {
    if (visit(key, [])) {
      problems.push(`dependency cycle: ${cycle.map((k) => k.split('::')[1]).join(' -> ')}`);
      cycleOut.push(...cycle.map((k) => k.split('::')[1]));
      break;
    }
  }

  return {
    files,
    taskCount: files.reduce((n, f) => n + f.taskCount, 0),
    points: files.reduce((n, f) => n + f.points, 0),
    problems,
    cycle: cycleOut,
  };
}
