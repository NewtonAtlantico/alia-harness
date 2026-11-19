import type { IntakeItem, PipelineInputRef, PipelineStatus } from '../../../shared/ipc';
import { t } from '../i18n/pt-BR';

/** One file in the intake list, with what the engine said about it (once it has), and the transcript attached to a recording. */
export interface IntakeRow {
  path: string;
  item?: IntakeItem;
  loading?: boolean;
  /** The engine could not look at the file at all (not allowed, gone). */
  failed?: string;
  transcript?: { path: string; item?: IntakeItem; loading?: boolean; failed?: string };
}

export type RowState = 'loading' | 'ok' | 'needs_transcript' | 'problem';

const key = (p: string) => p.replace(/\//g, '\\').toLowerCase();

/** Adds paths that are not in the list yet (the same file dropped twice is one row). */
export function addPaths(rows: IntakeRow[], paths: string[]): { rows: IntakeRow[]; added: string[] } {
  const seen = new Set(rows.flatMap((r) => [key(r.path), ...(r.transcript ? [key(r.transcript.path)] : [])]));
  const added: string[] = [];
  for (const p of paths) {
    if (seen.has(key(p))) continue;
    seen.add(key(p));
    added.push(p);
  }
  return { rows: [...rows, ...added.map((path) => ({ path, loading: true }))], added };
}

/** Puts the engine's answer on the rows it was asked about (`items` in the order of `paths`). */
export function applyInspection(rows: IntakeRow[], paths: string[], items: IntakeItem[] | { error: string }): IntakeRow[] {
  return rows.map((r) => {
    const at = paths.findIndex((p) => key(p) === key(r.path));
    if (at < 0 || !r.loading) return r;
    return 'error' in items ? { ...r, loading: false, failed: items.error } : { ...r, loading: false, item: items[at] };
  });
}

export function applyTranscript(rows: IntakeRow[], recording: string, transcript: IntakeRow['transcript'] | undefined): IntakeRow[] {
  return rows.map((r) => (key(r.path) === key(recording) ? { ...r, transcript } : r));
}

export const removeRow = (rows: IntakeRow[], path: string): IntakeRow[] => rows.filter((r) => key(r.path) !== key(path));

/** Why a row cannot be used, in the reader's own words; undefined when it can. */
export function rowProblem(row: IntakeRow): string | undefined {
  if (row.failed) return row.failed;
  if (row.item?.class === 'recording') {
    const tr = row.transcript;
    if (!tr) return undefined;
    if (tr.failed) return tr.failed;
    if (tr.item?.problem) return tr.item.problem;
    if (tr.item?.class === 'recording') return `"${tr.item.name}" is a recording, not a transcript.`;
    return undefined;
  }
  return row.item?.problem;
}

export function rowState(row: IntakeRow): RowState {
  if (row.loading || (!row.item && !row.failed)) return 'loading';
  if (row.transcript?.loading) return 'loading';
  if (rowProblem(row)) return 'problem';
  if (row.item?.class === 'recording' && !row.transcript) return 'needs_transcript';
  return 'ok';
}

/** The pipeline may start when there is something to read and every file in the list can be used. */
export function canStart(rows: IntakeRow[]): boolean {
  return rows.length > 0 && rows.every((r) => rowState(r) === 'ok');
}

/** Why "Iniciar pipeline" is disabled, or undefined when it is not. */
export function startBlockedReason(rows: IntakeRow[]): string | undefined {
  if (rows.length === 0) return t.pipeline.noInputs;
  if (rows.some((r) => rowState(r) === 'loading')) return t.pipeline.checking;
  if (rows.some((r) => rowState(r) === 'problem')) return t.pipeline.fixFirst;
  if (rows.some((r) => rowState(r) === 'needs_transcript')) return t.pipeline.attachFirst;
  return undefined;
}

/** What the engine is asked to start with. */
export function toInputs(rows: IntakeRow[]): PipelineInputRef[] {
  return rows.map((r) => ({ path: r.path, ...(r.transcript ? { transcriptPath: r.transcript.path } : {}) }));
}

/** Where a pipeline that already exists stopped, as a phrase for "A sessão anterior parou …". */
export function describeStop(status: PipelineStatus): string {
  const next = status.next;
  switch (next.kind) {
    case 'answer_questions':
      return t.pipeline.stop.questions(next.gate, next.answered, next.total);
    case 'review_specs':
      return t.pipeline.stop.review(next.unreviewed.length);
    case 'pass_gate':
      return t.pipeline.stop.approve(next.gate);
    case 'run_stage':
      return t.pipeline.stop.stage(next.stage);
    case 'inputs_changed':
      return t.pipeline.stop.inputsChanged(next.inputs.length);
    case 'complete':
      return t.pipeline.stop.complete;
    case 'damaged':
      return t.pipeline.stop.damaged;
    default:
      return t.pipeline.stop.start;
  }
}
