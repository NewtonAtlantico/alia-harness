/**
 * What the pipeline's run view shows, worked out from `pipeline.state` alone: the stepper, the status chip, the gate card
 * and the answers it sends. No React, no DOM: every rule here is unit tested against states made by core itself.
 */
import type { GateId, GateQuestion, PipelineView, UserAnswer, UserQuestion } from '../../../shared/ipc';
import { t } from '../i18n/pt-BR';
import { OTHER, answerFor, buildAnswers, type Forms } from './interactions';

export type StepState = 'done' | 'active' | 'waiting' | 'pending' | 'stale' | 'blocked';

export interface Step {
  id: 'inputs' | '1' | '2' | '3' | '4';
  label: string;
  state: StepState;
  /** A few words under the label: "3/5", "aprovar", "5 arquivos". */
  detail?: string;
}

/** The stepper: Entradas, then the four stages with the status and gate progress of each. */
export function stepperFor(view: PipelineView, running: boolean): Step[] {
  const label = (stage: number) => stageLabel(view, stage);
  const { status, state } = view;
  const inputs = state?.inputs.length ?? 0;
  const next = status.next;
  const steps: Step[] = [
    {
      id: 'inputs',
      label: t.run.steps.inputs,
      state: next.kind === 'inputs_changed' ? 'stale' : inputs > 0 ? 'done' : 'pending',
      detail: inputs > 0 ? t.run.inputsCount(inputs) : undefined,
    },
  ];
  for (const s of status.stages) {
    const gp = s.gateProgress;
    let step: StepState;
    let detail: string | undefined;
    const waitingOnGate = !!gp && gp.open > 0 && s.status !== 'pending' && s.status !== 'stale';
    if (s.status === 'stale') step = 'stale';
    else if (waitingOnGate) {
      step = 'waiting';
      detail = t.run.gateOpen(gp.answered + gp.deferred, gp.total);
    } else if (s.status === 'done') {
      if (gp && gp.status !== 'passed') {
        step = 'waiting';
        detail = t.run.gateReady;
      } else {
        step = 'done';
        detail = gp ? t.run.gatePassed : undefined;
      }
    } else if (s.status === 'running') step = 'active';
    else if (s.status === 'blocked') step = 'blocked';
    else step = running && next.kind === 'run_stage' && next.stage === s.stage ? 'active' : 'pending';
    steps.push({ id: String(s.stage) as Step['id'], label: label(s.stage), state: step, detail });
  }
  return steps;
}

/** A stage as the flow of the pipeline calls it ("Requisitos"); the catalog's name when the view carries no flow. */
export const stageLabel = (view: PipelineView, stage: number): string => view.flow?.stages.find((s) => s.stage === stage)?.label ?? t.run.steps[String(stage)] ?? String(stage);

export interface RunChip {
  label: string;
  tone: 'waiting' | 'running' | 'done' | 'warn' | 'idle';
}

/** "Aguardando suas respostas", "Aguardando sua decisão", "Aguardando revisão das specs", "Pipeline concluído"… */
export function runChip(view: PipelineView, running: boolean): RunChip | null {
  if (!view.status.exists) return null;
  const next = view.status.next;
  switch (next.kind) {
    case 'damaged':
      return { label: t.run.chip.damaged, tone: 'warn' };
    case 'inputs_changed':
      return { label: t.run.chip.inputsChanged, tone: 'warn' };
    case 'complete':
      return { label: t.run.chip.complete, tone: 'done' };
    case 'answer_questions':
      return running ? { label: t.run.chip.running(next.stage), tone: 'running' } : { label: t.run.chip.answers, tone: 'waiting' };
    case 'pass_gate':
      return running ? { label: t.run.chip.runningGeneric, tone: 'running' } : { label: t.run.chip.decision, tone: 'waiting' };
    case 'review_specs':
      return running ? { label: t.run.chip.runningGeneric, tone: 'running' } : { label: t.run.chip.review, tone: 'waiting' };
    case 'run_stage':
      return running ? { label: t.run.chip.running(next.stage), tone: 'running' } : { label: t.run.chip.stopped(next.stage), tone: 'idle' };
    default:
      return null;
  }
}

/** Whether "Retomar" makes sense: a pipeline that exists, is readable, is not finished and is not being worked on. */
export function canResume(view: PipelineView, running: boolean): boolean {
  if (running || !view.status.exists) return false;
  return !['complete', 'damaged', 'not_started'].includes(view.status.next.kind);
}

export interface GateCardData {
  gate: GateId;
  stage: number;
  title: string;
  /** Answered and deferred questions, in the order they were asked. */
  settled: GateQuestion[];
  open: GateQuestion[];
  /** Nothing is open: the gate only needs the user's approval. */
  ready: boolean;
}

/** The card for the gate the pipeline is waiting at, or null when it is waiting for something else (or for nothing). */
export function gateCardFor(view: PipelineView): GateCardData | null {
  const next = view.status.next;
  if (!view.state || (next.kind !== 'answer_questions' && next.kind !== 'pass_gate')) return null;
  const gate = view.state.gates.find((g) => g.id === next.gate);
  if (!gate) return null;
  const open = gate.questions.filter((q) => q.status === 'open');
  const settled = gate.questions.filter((q) => q.status !== 'open');
  return { gate: next.gate, stage: next.stage, title: t.run.gate.title(next.gate, stageLabel(view, next.stage)), settled, open, ready: next.kind === 'pass_gate' || open.length === 0 };
}

/** A gate's open questions in the shape the question form takes. Choices may always be answered in the user's own words, and anything may be deferred. */
export function toUserQuestions(questions: GateQuestion[]): UserQuestion[] {
  return questions.map((q) => ({
    id: q.id,
    kind: q.kind,
    prompt: q.prompt,
    ...(q.options ? { options: q.options.map((o) => ({ id: o.id, label: o.label, ...(o.detail ? { detail: o.detail } : {}), ...(o.source ? { source: o.source } : {}) })) } : {}),
    ...(q.kind === 'choice' ? { allowOther: true } : {}),
    allowDefer: true,
    ...(q.confidence ? { confidence: q.confidence } : {}),
  }));
}

/** A text question with nothing typed in it is "register as an assumption": it is deferred to the default owner. */
export const isBlankText = (q: UserQuestion, forms: Forms): boolean => q.kind === 'text' && !(forms[q.id]?.deferred) && !(forms[q.id]?.text ?? '').trim();

/**
 * What "Enviar e seguir" sends. `complete` is true when every question ends up answered or deferred (a blank text question
 * counts, as a deferral to `defaultOwner`), so the gate can be approved and the pipeline can go on. Otherwise only what is
 * filled in is sent, and the rest stays open.
 */
export function finishAnswers(questions: UserQuestion[], forms: Forms, defaultOwner: string): { answers: UserAnswer[]; complete: boolean } {
  const owner = defaultOwner.trim();
  const answers: UserAnswer[] = [];
  for (const q of questions) {
    const given = answerFor(q, forms[q.id], defaultOwner);
    if (given) answers.push(given);
    else if (owner && q.allowDefer && isBlankText(q, forms)) answers.push({ id: q.id, deferred: true, owner });
  }
  return { answers, complete: answers.length === questions.length };
}

/** What "Responder depois" and a partial send record: only what the user filled in. */
export const partialAnswers = (questions: UserQuestion[], forms: Forms, defaultOwner: string): UserAnswer[] => buildAnswers(questions, forms, defaultOwner);

export { OTHER };

/** The category of a question as a label for a chip, or undefined for an ordinary one. */
export const categoryLabel = (q: GateQuestion): string | undefined => t.run.gate.categories[q.category] || undefined;

/** How a settled question reads in the collapsed list. */
export function settledText(q: GateQuestion): string {
  if (q.status === 'deferred') return t.run.gate.deferred(q.owner ?? '—');
  if (q.kind === 'confirm' && (q.answer === 'yes' || q.answer === 'no')) return q.answer === 'yes' ? t.approval.yes : t.approval.no;
  return q.answerLabel ?? q.answer ?? t.run.gate.noAnswer;
}
