/**
 * The questions of a gate for someone who is not technical: one at a time, each with its category in plain words, the files that
 * disagree side by side, and the two ways out ("Não sei: perguntar a outra pessoa" and "Decidir depois"), which are recorded as
 * deferrals owned by the technical owner and by the person. No React, no DOM.
 */
import type { GateQuestion, UserAnswer } from '../../../shared/ipc';
import { t } from '../i18n/pt-BR';

/** The two ways out, in the same list as the options. */
export const PICK_OWNER = '__owner__';
export const PICK_LATER = '__later__';

export interface SimpleOption {
  id: string;
  label: string;
  detail?: string;
  source?: string;
}

export interface SimpleQuestion {
  id: string;
  prompt: string;
  kind: GateQuestion['kind'];
  /** The category as a chip: "Os arquivos discordam". Absent for an ordinary question. */
  category?: string;
  contradiction: boolean;
  /** What the person may choose between: the question's options, or Sim and Não. */
  options: SimpleOption[];
  /** Where the options come from, when the files disagree: the file and place, and what it says. */
  sources: Array<{ source: string; text: string }>;
  status: GateQuestion['status'];
  answer?: string;
  answerLabel?: string;
  owner?: string;
}

export function simpleQuestion(q: GateQuestion): SimpleQuestion {
  const options: SimpleOption[] =
    q.kind === 'confirm'
      ? [
          { id: 'yes', label: t.simple.questions.yes },
          { id: 'no', label: t.simple.questions.no },
        ]
      : (q.options ?? []).map((o) => ({ id: o.id, label: o.label, ...(o.detail ? { detail: o.detail } : {}), ...(o.source ? { source: o.source } : {}) }));
  const withSource = options.filter((o) => o.source);
  const category = t.simple.questions.categories[q.category];
  return {
    id: q.id,
    prompt: q.prompt,
    kind: q.kind,
    ...(q.category !== 'open_question' && category ? { category } : {}),
    contradiction: q.category === 'contradiction',
    options,
    // Two or more sources are a comparison; one alone is just where the question came from.
    sources: withSource.length >= 2 ? withSource.map((o) => ({ source: o.source!, text: o.label })) : [],
    status: q.status,
    ...(q.answer !== undefined ? { answer: q.answer } : {}),
    ...(q.answerLabel ? { answerLabel: q.answerLabel } : {}),
    ...(q.owner ? { owner: q.owner } : {}),
  };
}

/** What the person picked for one question. */
export interface Pick {
  /** An option id (`yes` or `no` for a confirmation), `PICK_OWNER` or `PICK_LATER`. */
  option?: string;
  /** For a text question: what was typed. */
  text?: string;
}

export type Picks = Readonly<Record<string, Pick>>;

const isWayOut = (option?: string) => option === PICK_OWNER || option === PICK_LATER;

/** Whether the pick settles the question (an answer, or one of the ways out). */
export function isAnswered(q: SimpleQuestion, pick?: Pick): boolean {
  if (!pick) return false;
  if (isWayOut(pick.option)) return true;
  if (q.kind === 'text') return !!pick.text?.trim();
  return !!pick.option && q.options.some((o) => o.id === pick.option);
}

/**
 * The answer the engine records for the pick, or undefined while the question is open. `me` is the person (owner of what they
 * decide to leave for later), `owner` is who answers the technical questions.
 */
export function answerOf(q: SimpleQuestion, pick: Pick | undefined, who: { me: string; owner: string }): UserAnswer | undefined {
  if (!pick || !isAnswered(q, pick)) return undefined;
  if (pick.option === PICK_LATER) return { id: q.id, deferred: true, owner: who.me };
  if (pick.option === PICK_OWNER) return { id: q.id, deferred: true, owner: who.owner };
  if (q.kind === 'text') return { id: q.id, answer: pick.text!.trim() };
  if (q.kind === 'confirm') return { id: q.id, answer: pick.option === 'yes' };
  return { id: q.id, answer: pick.option! };
}

/** The pick that shows an already recorded answer (the card of a question that was answered, when the person goes back to it). */
export function pickOfSettled(q: SimpleQuestion, who: { me: string; owner: string }): Pick | undefined {
  if (q.status === 'open') return undefined;
  if (q.status === 'deferred') return { option: q.owner && q.owner !== who.me ? PICK_OWNER : PICK_LATER };
  if (q.kind === 'text') return { text: q.answer ?? '' };
  if (q.kind === 'confirm') return { option: q.answer === 'yes' || q.answer === 'true' ? 'yes' : 'no' };
  return { option: q.answer };
}

/** How an answered question reads in "Já respondidas": the answer, or who the question went to. */
export function settledLine(q: SimpleQuestion, me: string): string {
  if (q.status === 'deferred') return !q.owner || q.owner === me ? t.simple.questions.deferredMe : t.simple.questions.deferredAsked(q.owner);
  if (q.kind === 'confirm') return q.answer === 'yes' || q.answer === 'true' ? t.simple.questions.yes : t.simple.questions.no;
  return q.answerLabel ?? q.answer ?? '—';
}

/** The explanation under "Por que estamos perguntando?". */
export const whyText = (q: SimpleQuestion): string => (q.contradiction ? t.simple.questions.whyContradiction : t.simple.questions.whyOther);
