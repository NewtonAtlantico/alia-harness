/**
 * The end of the pipeline as the page words it: the checks across specs with their explanation, what blocks, and the one-line
 * totals. The report itself comes from core (`buildReport`); this only turns its language-neutral references into Portuguese.
 * No React, no DOM.
 */
import type { Blocker, CheckResult, PipelineReport } from '../../../shared/ipc';
import { t } from '../i18n/pt-BR';

export interface CheckRow {
  key: string;
  label: string;
  state: CheckResult['state'];
  /** One sentence saying what the state means (why it failed, or why it is not known yet). */
  explanation: string;
  /** What is wrong, one reference each (empty unless it failed). */
  items: string[];
}

/** Core's references are language-neutral except for a few English words; the page says them in Portuguese. */
export function localizeItem(item: string): string {
  return item.replace(/\(no points\)/g, '(sem pontos)').replace(/\((\d+) points\)/g, '($1 pontos)').replace(/ -> /g, ' → ');
}

export function checkRow(c: CheckResult): CheckRow {
  const label = t.run.report.checks.labels[c.key] ?? c.key;
  const base = { key: c.key, label, state: c.state };
  if (c.state === 'pass') return { ...base, explanation: t.run.report.checks.pass, items: [] };
  if (c.state === 'unknown') {
    const why = c.source === 'recorded' ? t.run.report.checks.notRecorded : c.key === 'story_dependencies' ? t.run.report.checks.noSpecSummary : t.run.report.checks.noTasks;
    return { ...base, explanation: why, items: [] };
  }
  // A failure: the model's own words when it recorded the check, otherwise what the files say.
  const explanation = c.detail ?? t.run.report.checks.fail[c.key] ?? t.run.report.checks.failGeneric;
  return { ...base, explanation, items: c.items.map(localizeItem) };
}

/** A blocker as a sentence. */
export function blockerText(b: Blocker): string {
  switch (b.kind) {
    case 'stage':
      return t.run.report.blockers.stage(b.ref, t.run.stepState[b.detail === 'blocked' ? 'blocked' : b.detail === 'stale' ? 'stale' : b.detail === 'running' ? 'active' : 'pending']);
    case 'question':
      return t.run.report.blockers.question(b.ref, (b.detail ?? '').replace('G', 'Gate '));
    case 'spec_review':
      return t.run.report.blockers.specReview(b.ref);
    case 'check':
      return t.run.report.blockers.check(t.run.report.checks.labels[b.ref] ?? b.ref);
    case 'task_problem':
      return t.run.report.blockers.taskProblem(b.ref);
    case 'input_changed':
      return t.run.report.blockers.inputChanged(b.ref);
  }
}

/** "4 specs · 11 tarefas · 45 pontos · 3 ADRs". */
export function totalsLine(r: PipelineReport): string {
  return [t.run.report.n.specs(r.specs), t.run.report.n.tasks(r.tasks), t.run.report.n.points(r.points), t.run.report.n.adrs(r.adrs)].join(' · ');
}

/** Whether the backlog can be published: nothing blocks it. */
export const canPublish = (r: PipelineReport): boolean => r.blockers.length === 0 && r.tasks > 0;
