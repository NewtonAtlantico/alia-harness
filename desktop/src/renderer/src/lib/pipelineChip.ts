import type { PipelineBrief } from '../../../shared/ipc';
import { t } from '../i18n/pt-BR';

export interface Chip {
  label: string;
  /** `waiting`: the user has something to do; `running`: the pipeline is working; `done`; `warn`: something is wrong. */
  tone: 'waiting' | 'running' | 'done' | 'warn';
}

/** The little chip beside a pipeline in the sidebar, or null when the project has no pipeline to show. */
export function chipFor(brief: PipelineBrief): Chip | null {
  if (!brief.exists) return null;
  switch (brief.state) {
    case 'answer_questions':
      return { label: t.chip.gateQuestions(brief.gate ?? '', brief.answered ?? 0, brief.total ?? 0), tone: 'waiting' };
    case 'pass_gate':
      return { label: t.chip.gateApprove(brief.gate ?? ''), tone: 'waiting' };
    case 'review_specs':
      return { label: t.chip.gateReview(brief.gate ?? ''), tone: 'waiting' };
    case 'run_stage':
      return { label: t.chip.stage(brief.stage ?? 1), tone: 'running' };
    case 'inputs_changed':
      return { label: t.chip.inputsChanged, tone: 'warn' };
    case 'complete':
      return { label: t.chip.complete, tone: 'done' };
    case 'damaged':
      return { label: t.chip.damaged, tone: 'warn' };
    default:
      return null;
  }
}
