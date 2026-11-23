/**
 * The simple view, worked out from what the pipeline already keeps (`pipeline.state`, `pipeline.brief` and the project's metadata):
 * which mode the app is in, the chip of a project in the sidebar, which screen a project shows, and its four steps in plain words.
 * No React, no DOM: every rule here is unit tested against states made by core itself.
 */
import type { PipelineBrief, PipelineView } from '../../../shared/ipc';
import { t } from '../i18n/pt-BR';
import { stepperFor } from './pipelineRun';
import { projectName } from './projectName';

export type Mode = 'simple' | 'technical';

const MODE_KEY = 'alia.mode';

/** The mode the app was left in. A person who never chose gets the technical view, which is what the app has always shown. */
export function readMode(): Mode {
  try {
    return window.localStorage.getItem(MODE_KEY) === 'simple' ? 'simple' : 'technical';
  } catch {
    return 'technical';
  }
}

export function writeMode(mode: Mode): void {
  try {
    window.localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* the choice is only forgotten */
  }
}

export interface SimpleChip {
  label: string;
  tone: 'waiting' | 'running' | 'done' | 'info' | 'warn' | 'idle';
}

/** A project of the sidebar: the name the person gave it when there is one, and what the pipeline calls it otherwise. */
export const simpleTitle = (project: string, brief?: PipelineBrief): string => brief?.meta?.name ?? brief?.project ?? projectName(project);

/** Whether a project belongs in "Meus projetos": it has a pipeline, or the simple view made it. */
export const isSimpleProject = (brief?: PipelineBrief): boolean => !!brief && (brief.exists || !!brief.meta);

/** The chip beside a project: whose turn it is. Null for a project that is not one of these. */
export function simpleChip(brief?: PipelineBrief): SimpleChip | null {
  if (!isSimpleProject(brief)) return null;
  const b = brief!;
  if (!b.exists) return { label: t.simple.chip.notStarted, tone: 'idle' };
  switch (b.state) {
    case 'answer_questions':
    case 'pass_gate':
      // The architecture is the technical owner's to decide; every other gate is the person's.
      return b.gate === 'G2' ? { label: t.simple.chip.withOwner, tone: 'info' } : { label: t.simple.chip.yourTurn, tone: 'waiting' };
    case 'review_specs':
      return { label: t.simple.chip.yourTurn, tone: 'waiting' };
    case 'run_stage':
      return { label: t.simple.chip.working, tone: 'running' };
    case 'complete':
      return b.meta?.handedOff ? { label: t.simple.chip.handedOff, tone: 'info' } : { label: t.simple.chip.done, tone: 'done' };
    case 'inputs_changed':
    case 'damaged':
      return { label: t.simple.chip.attention, tone: 'warn' };
    default:
      return { label: t.simple.chip.notStarted, tone: 'idle' };
  }
}

export type SimpleScreen =
  /** The pipeline is running: nothing to do but wait. */
  | { kind: 'working' }
  /** Nothing is running and the next stage has not been started (the app was closed, or the run was paused). */
  | { kind: 'stopped' }
  /** Gate 1 or the gaps of gate 3: questions for the person. */
  | { kind: 'questions'; gate: 'G1' | 'G3' }
  /** Gate 1 has every answer and only waits for the person to go on. */
  | { kind: 'approve'; gate: 'G1' }
  /** Gate 2: the technical owner decides. */
  | { kind: 'owner'; open: number }
  /** Gate 3: the person confirms each feature. */
  | { kind: 'features' }
  | { kind: 'plan' }
  | { kind: 'attention'; reason: 'inputs_changed' | 'damaged' }
  | { kind: 'empty' };

/** Which screen a project shows, from where its pipeline waits. */
export function screenFor(view: PipelineView, running: boolean): SimpleScreen {
  const next = view.status.next;
  if (!view.status.exists) return running ? { kind: 'working' } : { kind: 'empty' };
  if (next.kind === 'damaged') return { kind: 'attention', reason: 'damaged' };
  if (next.kind === 'complete') return { kind: 'plan' };
  if (next.kind === 'inputs_changed') return { kind: 'attention', reason: 'inputs_changed' };
  // While the agent works the state is not the person's to change (the engine would refuse their answers).
  if (running) return { kind: 'working' };
  switch (next.kind) {
    case 'answer_questions':
      if (next.gate === 'G2') return { kind: 'owner', open: next.open.length };
      return { kind: 'questions', gate: next.gate === 'G1' ? 'G1' : 'G3' };
    case 'review_specs':
      return { kind: 'features' };
    case 'pass_gate':
      if (next.gate === 'G1') return { kind: 'approve', gate: 'G1' };
      if (next.gate === 'G2') return { kind: 'owner', open: 0 };
      return { kind: 'features' };
    case 'run_stage':
      return { kind: 'stopped' };
    default:
      return { kind: 'empty' };
  }
}

export interface SimpleStep {
  stage: number;
  title: string;
  state: 'done' | 'current' | 'next';
  /** "Concluída", "Você está aqui", "A seguir"… */
  detail: string;
}

/** The four steps of the flow in the words of the simple view, and where the project is among them. */
export function simpleSteps(view: PipelineView, running: boolean): SimpleStep[] {
  const raw = stepperFor(view, running).filter((s) => s.id !== 'inputs');
  const steps = raw.map((s) => {
    const stage = Number(s.id);
    const def = view.flow?.stages.find((x) => x.stage === stage);
    const state: SimpleStep['state'] = s.state === 'done' ? 'done' : s.state === 'pending' ? 'next' : 'current';
    return { stage, title: def?.simple.title ?? s.label, participates: def?.simple.participates ?? true, state };
  });
  // Between two stages (a gate just approved, the next one not started) nothing is current yet: the next one is.
  if (!steps.some((s) => s.state === 'current')) {
    const first = steps.find((s) => s.state === 'next');
    if (first) first.state = 'current';
  }
  return steps.map(({ stage, title, participates, state }) => ({
    stage,
    title,
    state,
    detail: state === 'done' ? t.simple.steps.done : state === 'next' ? t.simple.steps.next : running ? t.simple.steps.working : participates ? t.simple.steps.current : t.simple.steps.withOwner,
  }));
}

/** The step the project is at (the first one that is not done). */
export const currentStep = (steps: SimpleStep[]): SimpleStep | undefined => steps.find((s) => s.state === 'current');
