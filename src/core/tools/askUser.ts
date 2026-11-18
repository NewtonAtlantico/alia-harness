import { RunCancelledError, raceAbort } from '../abort.js';
import { CANCELLED_OUTPUT_PREFIX, ToolDefinition } from './types.js';

/**
 * `ask_user`: structured questions for the person using the agent (decisions, gate questions,
 * open questions), as an alternative to asking in plain text and waiting for the next message.
 *
 * The front-end decides how to show them (the desktop app draws cards, the terminal prompts);
 * core only defines the questions, validates what comes back, and hands the model clean JSON.
 */

export const ASK_USER_TOOL_NAME = 'ask_user';

export type QuestionKind = 'choice' | 'text' | 'confirm';

export interface QuestionOption {
  id: string;
  label: string;
  /** A line of explanation shown under the label. */
  detail?: string;
  /** Where this option comes from ("BRD_v2.pdf · p. 14"), so the person can check it. */
  source?: string;
}

export interface UserQuestion {
  id: string;
  kind: QuestionKind;
  prompt: string;
  /** `choice` only: at least two. */
  options?: QuestionOption[];
  /** `choice` only: the person may also type an answer that is not one of the options. */
  allowOther?: boolean;
  /** Offer "defer": record it as an assumption with an owner instead of answering. */
  allowDefer?: boolean;
  confidence?: 'low' | 'medium' | 'high';
}

/** What a front-end returns for one question. A question it leaves out is "unanswered". */
export interface UserAnswer {
  id: string;
  /** A `choice`: the option id (or free text if `allowOther`). `text`: the text. `confirm`: true or false. */
  answer?: string | boolean;
  /** The person chose to carry it as an assumption rather than answer it. Needs `allowDefer`. */
  deferred?: boolean;
  /** Who owns the assumption (with `deferred`). */
  owner?: string;
}

export interface AskUserRequest {
  questions: UserQuestion[];
  /** The tool call that is asking. */
  toolCallId?: string;
  /** Aborts when the run is cancelled while the questions are open: dismiss them. */
  signal?: AbortSignal;
}

export type AskUserHandler = (request: AskUserRequest) => Promise<UserAnswer[]>;

export interface AskUserDeps {
  /** Read on every call, so a front-end can attach or replace its handler later. */
  getHandler: () => AskUserHandler | undefined;
}

const MAX_QUESTIONS = 10;
const KINDS: QuestionKind[] = ['choice', 'text', 'confirm'];

type Raw = Record<string, any>;

/** Checks the model's questions. Returns them cleaned, or an error written for the model. */
export function validateQuestions(raw: unknown): { questions: UserQuestion[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { error: 'Parameter "questions" must be a non-empty array.' };
  if (raw.length > MAX_QUESTIONS) return { error: `Ask at most ${MAX_QUESTIONS} questions at a time (got ${raw.length}); group or prioritize them.` };

  const questions: UserQuestion[] = [];
  const seen = new Set<string>();
  for (const [i, item] of (raw as Raw[]).entries()) {
    const at = `questions[${i}]`;
    if (!item || typeof item !== 'object') return { error: `${at} must be an object.` };
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (!id) return { error: `${at}.id is required (a short unique id such as "q1").` };
    if (seen.has(id)) return { error: `${at}: the id "${id}" is used twice.` };
    seen.add(id);
    if (!KINDS.includes(item.kind)) return { error: `${at}.kind must be one of: ${KINDS.join(', ')}.` };
    const prompt = typeof item.prompt === 'string' ? item.prompt.trim() : '';
    if (!prompt) return { error: `${at}.prompt is required: the question, in the user's language.` };

    const question: UserQuestion = { id, kind: item.kind, prompt };
    if (item.kind === 'choice') {
      if (!Array.isArray(item.options) || item.options.length < 2) return { error: `${at} is a choice: give at least two "options".` };
      const optionIds = new Set<string>();
      question.options = [];
      for (const [j, o] of (item.options as Raw[]).entries()) {
        const oid = typeof o?.id === 'string' ? o.id.trim() : '';
        const label = typeof o?.label === 'string' ? o.label.trim() : '';
        if (!oid || !label) return { error: `${at}.options[${j}] needs an "id" and a "label".` };
        if (optionIds.has(oid)) return { error: `${at}.options: the id "${oid}" is used twice.` };
        optionIds.add(oid);
        question.options.push({
          id: oid,
          label,
          ...(typeof o.detail === 'string' && o.detail.trim() ? { detail: o.detail.trim() } : {}),
          ...(typeof o.source === 'string' && o.source.trim() ? { source: o.source.trim() } : {}),
        });
      }
      if (item.allowOther === true) question.allowOther = true;
    } else if (item.options !== undefined && !(Array.isArray(item.options) && item.options.length === 0)) {
      return { error: `${at}: "options" only applies to kind "choice".` };
    }
    if (item.allowDefer === true) question.allowDefer = true;
    if (item.confidence !== undefined) {
      if (!['low', 'medium', 'high'].includes(item.confidence)) return { error: `${at}.confidence must be low, medium or high.` };
      question.confidence = item.confidence;
    }
    questions.push(question);
  }
  return { questions };
}

/** Checks what the front-end returned against the questions asked. */
function checkAnswers(
  questions: UserQuestion[],
  returned: unknown
): { answers: Array<UserAnswer & { label?: string }>; unanswered: string[] } | { error: string } {
  if (!Array.isArray(returned)) return { error: 'the answer handler must return an array of answers' };
  const byId = new Map(questions.map((q) => [q.id, q]));
  const given = new Map<string, UserAnswer>();
  for (const a of returned as UserAnswer[]) {
    if (!a || typeof a.id !== 'string' || !byId.has(a.id)) return { error: `the handler answered an unknown question ("${(a as any)?.id}")` };
    given.set(a.id, a); // a later answer to the same question replaces the earlier one
  }

  const answers: Array<UserAnswer & { label?: string }> = [];
  const unanswered: string[] = [];
  for (const q of questions) {
    const a = given.get(q.id);
    if (!a || (a.answer === undefined && !a.deferred)) {
      unanswered.push(q.id);
      continue;
    }
    if (a.deferred) {
      if (!q.allowDefer) return { error: `question "${q.id}" cannot be deferred, but the handler deferred it` };
      answers.push({ id: q.id, deferred: true, owner: a.owner?.trim() || undefined });
      continue;
    }
    if (q.kind === 'confirm') {
      if (typeof a.answer !== 'boolean') return { error: `question "${q.id}" is a confirm: the answer must be true or false` };
      answers.push({ id: q.id, answer: a.answer });
    } else if (q.kind === 'text') {
      if (typeof a.answer !== 'string' || !a.answer.trim()) return { error: `question "${q.id}" is a text question: the answer must be a non-empty string` };
      answers.push({ id: q.id, answer: a.answer.trim() });
    } else {
      if (typeof a.answer !== 'string' || !a.answer.trim()) return { error: `question "${q.id}" is a choice: the answer must be an option id` };
      const option = q.options!.find((o) => o.id === a.answer);
      if (option) answers.push({ id: q.id, answer: option.id, label: option.label });
      else if (q.allowOther) answers.push({ id: q.id, answer: a.answer.trim() });
      else return { error: `"${a.answer}" is not one of the options of question "${q.id}"` };
    }
  }
  return { answers, unanswered };
}

export function createAskUserTool(deps: AskUserDeps): ToolDefinition<{ questions: unknown }> {
  return {
    name: ASK_USER_TOOL_NAME,
    description:
      'Asks the user one or more structured questions and returns their answers as JSON. Use it for decisions only the user can make: ' +
      'open questions, contradictions between sources, gate questions, choices between approaches. Prefer kind "choice" with concrete ' +
      'options (and each option\'s "source" when it comes from a document); use "confirm" for yes/no and "text" for free answers. ' +
      'Set allowDefer so the user can record a question as an assumption with an owner instead of answering. ' +
      'Questions the user leaves out come back in "unanswered": stop at that gate and wait, never answer for them. ' +
      'Do not use it for things you can find out yourself or for trivial confirmations.',
    parameters: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          description: `1 to ${MAX_QUESTIONS} questions, asked together.`,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Short unique id, e.g. "q1".' },
              kind: { type: 'string', enum: KINDS, description: '"choice" (pick an option), "text" (free answer) or "confirm" (yes/no).' },
              prompt: { type: 'string', description: 'The question, in the language the user writes in.' },
              options: {
                type: 'array',
                description: 'For "choice": at least two options.',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    label: { type: 'string' },
                    detail: { type: 'string', description: 'One line of explanation.' },
                    source: { type: 'string', description: 'Where the option comes from, e.g. "BRD_v2.pdf p. 14".' },
                  },
                  required: ['id', 'label'],
                },
              },
              allowOther: { type: 'boolean', description: 'For "choice": also accept an answer that is not an option.' },
              allowDefer: { type: 'boolean', description: 'Let the user defer it as an assumption, with an owner.' },
              confidence: { type: 'string', enum: ['low', 'medium', 'high'], description: 'How sure you are about your reading of the sources.' },
            },
            required: ['id', 'kind', 'prompt'],
          },
        },
      },
      required: ['questions'],
    },
    execute: async (args, ctx) => {
      const checked = validateQuestions(args?.questions);
      if ('error' in checked) return `Error: ${checked.error}`;

      const handler = deps.getHandler();
      if (!handler) {
        return 'Error: This environment cannot show structured questions to the user. Ask your questions in plain text, then end your turn and wait for the answer. Never invent answers.';
      }
      if (ctx.signal?.aborted) return `${CANCELLED_OUTPUT_PREFIX} The questions were not asked because the run was cancelled.`;

      let returned: UserAnswer[];
      try {
        returned = await raceAbort(handler({ questions: checked.questions, toolCallId: ctx.toolCallId, signal: ctx.signal }), ctx.signal);
      } catch (err: any) {
        if (err instanceof RunCancelledError || ctx.signal?.aborted) {
          return `${CANCELLED_OUTPUT_PREFIX} The questions were dismissed because the run was cancelled.`;
        }
        return `Error: Could not ask the user: ${err?.message ?? err}`;
      }

      const result = checkAnswers(checked.questions, returned);
      if ('error' in result) return `Error: The user interface returned an invalid answer: ${result.error}.`;

      const notes: string[] = [];
      const ownerless = result.answers.filter((a) => a.deferred && !a.owner).map((a) => a.id);
      if (ownerless.length > 0) {
        notes.push(`No owner was given for the deferred question(s) ${ownerless.join(', ')}: ask the user who owns each assumption before you record it.`);
      }
      if (result.unanswered.length > 0) {
        notes.push(`Question(s) ${result.unanswered.join(', ')} are still open. Do not continue past this point until they are answered or deferred: stop here and say what is waiting.`);
      }
      return JSON.stringify(
        {
          answers: result.answers.map((a) => (a.deferred ? { id: a.id, deferred: true, owner: a.owner ?? null } : a)),
          ...(result.unanswered.length > 0 ? { unanswered: result.unanswered } : {}),
          ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
        },
        null,
        2
      );
    },
  };
}
