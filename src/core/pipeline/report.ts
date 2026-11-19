import { FIBONACCI_POINTS, TaskFileSummary, TaskStats, TaskSummary } from './taskStats.js';
import { PipelineState, SpecSummary } from './pipelineState.js';
import { StaleInput } from './pipelineStatus.js';

/**
 * The end of the pipeline, as data: the backlog by spec, the checks across specs (computed from the task files where they can
 * be, recorded by the model where they need reading), the totals of the final report, and what still blocks. Pure: the same
 * state and tasks always give the same report, and nothing here writes anything.
 */

export type CheckState = 'pass' | 'fail' | 'unknown';

export interface CheckResult {
  /** `points`, `cycles`, `story_dependencies` (computed), `coverage` (recorded), or any key the model recorded. */
  key: string;
  state: CheckState;
  source: 'computed' | 'recorded';
  /** What is wrong, as short language-neutral references ("login-sso: 1.2 Title (13 points)"). */
  items: string[];
  /** The model's own words, for a recorded check. */
  detail?: string;
}

export type BlockerKind = 'stage' | 'question' | 'spec_review' | 'check' | 'task_problem' | 'input_changed';

export interface Blocker {
  kind: BlockerKind;
  /** The stage number, question id, spec slug, check key or task problem it is about. */
  ref: string;
  detail?: string;
}

export interface BacklogSpec {
  slug: string;
  title: string;
  file: string;
  tasks: TaskSummary[];
  taskCount: number;
  points: number;
  /** The specs this one depends on, from its summary. */
  dependsOn: string[];
}

export interface PipelineReport {
  specs: number;
  tasks: number;
  points: number;
  adrs: number;
  backlog: BacklogSpec[];
  checks: CheckResult[];
  blockers: Blocker[];
}

const label = (file: string, t: TaskSummary) => `${file}: ${t.id ? `${t.id} ` : ''}${t.title}`;

/** The checks across specs. A computed check says `unknown` when there is nothing to judge it by (no tasks, or no spec summaries). */
export function computeChecks(stats: TaskStats, specs: SpecSummary[], recorded: PipelineState['checks'] = []): CheckResult[] {
  const out: CheckResult[] = [];
  const files = stats.files;
  const tasks = files.flatMap((f) => f.tasks.map((t) => ({ file: f, task: t })));
  const none = tasks.length === 0;

  // Story points: every task has a number, one of the Fibonacci values, at most 8.
  const offPoints = tasks.filter(({ task }) => task.points === undefined || !FIBONACCI_POINTS.includes(task.points));
  out.push({
    key: 'points',
    state: none ? 'unknown' : offPoints.length > 0 ? 'fail' : 'pass',
    source: 'computed',
    items: offPoints.map(({ file, task }) => `${file.slug}: ${task.id ? `${task.id} ` : ''}${task.title} (${task.points === undefined ? 'no points' : `${task.points} points`})`),
  });

  // No dependency cycle: a valid order exists.
  out.push({ key: 'cycles', state: none ? 'unknown' : stats.cycle.length > 0 ? 'fail' : 'pass', source: 'computed', items: stats.cycle.length > 0 ? [stats.cycle.join(' -> ')] : [] });

  // Dependencies: every reference is a task, and a task that waits for another story's task is in a story that depends on that story.
  const unresolved = tasks.flatMap(({ file, task }) => task.unresolvedDependsOn.map((ref) => `${label(file.file, task)} -> ${ref}`));
  const bySlug = new Map(specs.map((s) => [s.slug, s]));
  const crossing = tasks.flatMap(({ file, task }) => task.resolvedDependsOn.filter((d) => d.slug !== file.slug).map((d) => ({ file, task, dep: d })));
  const judgeable = specs.length > 0;
  const undeclared = judgeable
    ? crossing.filter(({ file, dep }) => bySlug.has(file.slug) && bySlug.has(dep.slug) && !bySlug.get(file.slug)!.dependsOn.includes(dep.slug)).map(({ file, task, dep }) => `${file.slug}: ${task.id ? `${task.id} ` : ''}${task.title} -> ${dep.slug}`)
    : [];
  out.push({
    key: 'story_dependencies',
    state: none ? 'unknown' : unresolved.length + undeclared.length > 0 ? 'fail' : crossing.length > 0 && !judgeable ? 'unknown' : 'pass',
    source: 'computed',
    items: [...unresolved, ...undeclared],
  });

  // What needs reading is recorded by the model; until it does, it is not known.
  const coverage = recorded.find((c) => c.key === 'coverage');
  out.push({ key: 'coverage', state: coverage ? coverage.status : 'unknown', source: 'recorded', items: [], ...(coverage?.detail ? { detail: coverage.detail } : {}) });
  for (const c of recorded.filter((x) => x.key !== 'coverage')) out.push({ key: c.key, state: c.status, source: 'recorded', items: [], ...(c.detail ? { detail: c.detail } : {}) });
  return out;
}

/** The final report and what blocks it. `staleInputs` comes from the pipeline status. */
export function buildReport(state: PipelineState, stats: TaskStats, staleInputs: StaleInput[] = []): PipelineReport {
  const checks = computeChecks(stats, state.specs, state.checks);
  const bySlug = new Map(state.specs.map((s) => [s.slug, s]));
  const backlog: BacklogSpec[] = stats.files.map((f: TaskFileSummary) => ({
    slug: f.slug,
    title: bySlug.get(f.slug)?.title ?? f.title ?? f.slug,
    file: f.file,
    tasks: f.tasks,
    taskCount: f.taskCount,
    points: f.points,
    dependsOn: bySlug.get(f.slug)?.dependsOn ?? [],
  }));

  const blockers: Blocker[] = [];
  for (const s of state.stages) if (s.status !== 'done') blockers.push({ kind: 'stage', ref: String(s.stage), detail: s.status });
  for (const g of state.gates) for (const q of g.questions) if (q.status === 'open') blockers.push({ kind: 'question', ref: q.id, detail: g.id });
  for (const r of state.specReviews) if (r.status !== 'reviewed') blockers.push({ kind: 'spec_review', ref: r.spec, detail: r.status });
  for (const c of checks) if (c.state === 'fail') blockers.push({ kind: 'check', ref: c.key });
  for (const p of stats.problems) blockers.push({ kind: 'task_problem', ref: p });
  for (const i of staleInputs) blockers.push({ kind: 'input_changed', ref: i.name, detail: i.reason });

  return {
    specs: Math.max(state.specs.length, stats.files.length),
    tasks: stats.taskCount,
    points: stats.points,
    adrs: state.adrs.length,
    backlog,
    checks,
    blockers,
  };
}
