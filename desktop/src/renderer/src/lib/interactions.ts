/**
 * What is waiting for the user: approvals and questions, as data. The engine pushes them (`interaction`), closes them
 * when a run is cancelled or ends (`interaction_closed`), and the page answers with `interaction.respond`. This module
 * keeps the pending list and turns a form into the answers the engine expects. No React, no DOM.
 */
import type { Interaction, PushMessage, UserAnswer, UserQuestion } from '../../../shared/ipc';

export type PermissionInteraction = Extract<Interaction, { kind: 'permission' }>;
export type QuestionInteraction = Extract<Interaction, { kind: 'ask_user' }>;

/** The pending interactions, oldest first. */
export type Pending = readonly Interaction[];

export type InteractionAction =
  | { type: 'reset'; interactions: Interaction[] }
  | { type: 'push'; message: PushMessage }
  | { type: 'remove'; id: string };

export function reducePending(list: Pending, action: InteractionAction): Pending {
  switch (action.type) {
    case 'reset':
      return action.interactions;
    case 'remove':
      return list.filter((i) => i.id !== action.id);
    case 'push': {
      const m = action.message;
      if (m.kind === 'interaction') return list.some((i) => i.id === m.interaction.id) ? list : [...list, m.interaction];
      if (m.kind === 'interaction_closed') return list.filter((i) => i.id !== m.id);
      // The engine says an approval was decided (here or elsewhere): its card is no longer needed.
      if (m.kind === 'event' && m.event.type === 'permission_resolved' && m.event.toolCallId) {
        const tool = m.event.toolCallId;
        return list.filter((i) => !(i.kind === 'permission' && i.sessionId === m.sessionId && i.toolCallId === tool));
      }
      // The engine went down: whatever was waiting is gone with it.
      if (m.kind === 'engine_status' && m.status === 'down') return [];
      return list;
    }
  }
}

/** The interactions of one conversation, oldest first. */
export const forSession = (list: Pending, sessionId: string): Interaction[] => list.filter((i) => i.sessionId === sessionId);

// ------------------------------------------------------------------------------------ questions

/** The value of the "other" choice in a form (a choice question that allows an answer of the user's own). */
export const OTHER = '__other__';

export interface QuestionForm {
  /** `choice`: an option id, or OTHER. */
  choice?: string;
  /** `choice` with OTHER: what the user typed. */
  other?: string;
  /** `text`. */
  text?: string;
  /** `confirm`. */
  confirm?: boolean;
  /** Carry it as an assumption instead of answering. */
  deferred?: boolean;
  /** Who owns the assumption; defaults to the user. */
  owner?: string;
}

export type Forms = Readonly<Record<string, QuestionForm>>;

/** The answer for one question, or undefined if the form leaves it open. */
export function answerFor(question: UserQuestion, form: QuestionForm | undefined, defaultOwner: string): UserAnswer | undefined {
  if (!form) return undefined;
  if (form.deferred && question.allowDefer) {
    const owner = (form.owner ?? '').trim() || defaultOwner.trim();
    return owner ? { id: question.id, deferred: true, owner } : undefined;
  }
  switch (question.kind) {
    case 'choice': {
      if (form.choice === OTHER) {
        const text = (form.other ?? '').trim();
        return question.allowOther && text ? { id: question.id, answer: text } : undefined;
      }
      return form.choice && question.options?.some((o) => o.id === form.choice) ? { id: question.id, answer: form.choice } : undefined;
    }
    case 'text': {
      const text = (form.text ?? '').trim();
      return text ? { id: question.id, answer: text } : undefined;
    }
    case 'confirm':
      return typeof form.confirm === 'boolean' ? { id: question.id, answer: form.confirm } : undefined;
  }
}

/** Every question the form answers (or defers), in order. Questions left open are simply not in the list. */
export function buildAnswers(questions: UserQuestion[], forms: Forms, defaultOwner: string): UserAnswer[] {
  const out: UserAnswer[] = [];
  for (const q of questions) {
    const a = answerFor(q, forms[q.id], defaultOwner);
    if (a) out.push(a);
  }
  return out;
}

/** How many of the questions have an answer (or a deferral) in the form. */
export const answeredCount = (questions: UserQuestion[], forms: Forms, defaultOwner: string): number => buildAnswers(questions, forms, defaultOwner).length;

/** What to ask the user about a deferred owner, when none is set and there is no name to fall back on. */
export const needsOwner = (questions: UserQuestion[], forms: Forms, defaultOwner: string): string[] =>
  questions.filter((q) => forms[q.id]?.deferred && q.allowDefer && !((forms[q.id]?.owner ?? '').trim() || defaultOwner.trim())).map((q) => q.id);
