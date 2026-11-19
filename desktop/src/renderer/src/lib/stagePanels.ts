/**
 * What the gate 2 and gate 3 screens show, worked out from `pipeline.state` alone: the architecture proposal with its ADRs
 * and alignment, and the table of specs with their human reviews. No React, no DOM; tested against states made by core.
 */
import type { GateQuestion, PipelineView } from '../../../shared/ipc';
import { t } from '../i18n/pt-BR';

export type StagePanel = 'architecture' | 'specs';

/** Which stage screen goes with where the pipeline waits: the architecture at gate 2, the specs at gate 3 (and their review). */
export function stagePanelFor(view: PipelineView): StagePanel | null {
  const next = view.status.next;
  if (!view.state) return null;
  if ((next.kind === 'answer_questions' || next.kind === 'pass_gate') && next.gate === 'G2') return 'architecture';
  if ((next.kind === 'answer_questions' || next.kind === 'pass_gate') && next.gate === 'G3') return 'specs';
  if (next.kind === 'review_specs') return 'specs';
  return null;
}

type State = NonNullable<PipelineView['state']>;

export interface ArchitectureData {
  /** Absent when the model did not record a summary: the screen then shows the document itself. */
  summary?: State['architecture'];
  recommendation?: { label: string; tone: 'ok' | 'warn' | 'bad' };
  adrs: State['adrs'];
  alignment: Array<{ adr: string; aligned: boolean; note?: string }>;
  /** What goes forward without being decided: the assumptions of this stage. */
  assumptions: State['assumptions'];
  /** The architecture document, to show when there is no summary. */
  document?: string;
}

const RECOMMENDATIONS: Record<string, { label: string; tone: 'ok' | 'warn' | 'bad' }> = {
  approve: { label: 'Aprovar', tone: 'ok' },
  approve_with_notes: { label: 'Aprovar com notas', tone: 'warn' },
  request_changes: { label: 'Pedir alterações', tone: 'bad' },
};

export function architectureFor(view: PipelineView): ArchitectureData | null {
  const state = view.state;
  if (!state) return null;
  const summary = state.architecture;
  return {
    summary,
    recommendation: summary?.recommendation ? RECOMMENDATIONS[summary.recommendation] : undefined,
    adrs: state.adrs,
    alignment: state.adrAlignment.map((a) => ({ adr: a.adr, aligned: a.status === 'aligned', note: a.note })),
    assumptions: state.assumptions.filter((a) => a.stage === 2),
    document: view.artifacts.find((a) => a.stage === 2 && a.exists && !a.isDir)?.path,
  };
}

export type SpecStatus = 'draft' | 'in_review' | 'reviewed';

export interface SpecRow {
  slug: string;
  title: string;
  persona?: string;
  dependsOn: string[];
  status: SpecStatus;
  by?: string;
  date?: string;
  path?: string;
}

export interface SpecsData {
  rows: SpecRow[];
  reviewed: number;
  /** Every spec has been reviewed (and there is at least one). */
  allReviewed: boolean;
  /** Gaps the skill raised at this gate that are settled now. */
  resolvedGaps: GateQuestion[];
  /** Gaps still open (they are answered in the gate card). */
  openGaps: number;
  /** The specs index, to show when there is no structured list of specs. */
  index?: string;
}

/** The spec table: the structured summaries joined with the human reviews, in the order the specs were recorded. */
export function specsFor(view: PipelineView): SpecsData | null {
  const state = view.state;
  if (!state) return null;
  const reviews = new Map(state.specReviews.map((r) => [r.spec, r]));
  const slugs = [...state.specs.map((s) => s.slug), ...state.specReviews.map((r) => r.spec).filter((s) => !state.specs.some((x) => x.slug === s))];
  const rows: SpecRow[] = slugs.map((slug) => {
    const spec = state.specs.find((s) => s.slug === slug);
    const review = reviews.get(slug);
    return { slug, title: spec?.title ?? slug, persona: spec?.persona, dependsOn: spec?.dependsOn ?? [], status: review?.status ?? 'draft', by: review?.by, date: review?.date, path: spec?.path };
  });
  const g3 = state.gates.find((g) => g.id === 'G3');
  const reviewed = rows.filter((r) => r.status === 'reviewed').length;
  return {
    rows,
    reviewed,
    allReviewed: rows.length > 0 && reviewed === rows.length,
    resolvedGaps: (g3?.questions ?? []).filter((q) => q.status !== 'open'),
    openGaps: (g3?.questions ?? []).filter((q) => q.status === 'open').length,
    index: view.artifacts.find((a) => a.stage === 3 && a.exists && !a.isDir)?.path,
  };
}

/** Whether "Seguir para Tarefas" is available: every spec reviewed and no gap left open. */
export const canFollowToTasks = (data: SpecsData): boolean => data.allReviewed && data.openGaps === 0;

/** The review column of a spec: who approved it and when, or its status. */
export function reviewLine(row: SpecRow): string {
  if (row.status === 'reviewed') return t.run.specs.reviewedBy(row.by ?? '—', row.date);
  return t.run.specs.status[row.status];
}
