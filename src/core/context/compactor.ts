import OpenAI from 'openai';
import { raceAbort } from '../abort.js';
import { ContextManager, isPinnedToolOutput } from './contextManager.js';

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

/** Marks the message that stands in for the turns that were compacted. */
export const SUMMARY_TAG = '<conversation_summary>';

export const DEFAULT_KEEP_RECENT = 10;
/** Fewer older messages than this is not worth a model call. */
const MIN_TO_SUMMARIZE = 4;

const SUMMARY_SYSTEM = `You compress the earlier part of a conversation between a user and an AI coding agent, so the agent can carry on the work with a smaller context.
Write a faithful, compact summary covering: what the user asked for and why; decisions made and the reasons; files read, created or changed (with paths); commands run and their notable results; errors hit and how they were resolved; open questions and the next steps; any preferences the user stated.
Do not invent anything and do not add advice. No preamble: output the summary only.`;

export type CompactOutcome =
  | { status: 'compacted'; messages: ChatMessage[]; summarized: number; tokensBefore: number; tokensAfter: number }
  | { status: 'nothing_to_compact' }
  | { status: 'failed'; error: string }
  | { status: 'cancelled' };

export interface CompactOptions {
  client: OpenAI;
  model: string;
  contextManager: ContextManager;
  /** Context window of the model, to size the transcript sent for summarizing. */
  maxInputTokens: number;
  /** Messages at the end of the history kept verbatim (default 10). */
  keepRecent?: number;
  signal?: AbortSignal;
}

function textOf(m: ChatMessage): string {
  const c = (m as any).content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (p?.type === 'text' ? p.text : '')).join('\n');
  return '';
}

const cap = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max)} […${text.length - max} more characters]`);

/** A /skill invocation: a user message that carries the skill's playbook. */
const isSkillInvocation = (m: ChatMessage) => m.role === 'user' && /<skill name="/.test(textOf(m));

function renderTranscript(messages: ChatMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role === 'user') parts.push(`USER: ${cap(textOf(m), 4000)}`);
    else if (m.role === 'assistant') {
      const text = textOf(m).trim();
      if (text) parts.push(`ASSISTANT: ${cap(text, 4000)}`);
      for (const call of (m as any).tool_calls ?? []) {
        parts.push(`ASSISTANT called ${call.function?.name}(${cap(String(call.function?.arguments ?? ''), 300)})`);
      }
    } else if (m.role === 'tool') parts.push(`TOOL RESULT: ${cap(textOf(m), 600)}`);
  }
  return parts.join('\n\n');
}

/**
 * Replaces the older part of a conversation with a model-written summary.
 *
 * Kept verbatim: the system prompt, the last `keepRecent` messages (never starting on a tool
 * result, which would orphan it from the call that produced it), and every pinned skill, because
 * a skill is the playbook the model is following. Everything else becomes one summary message.
 * Pure with respect to `messages`: it returns the new history and leaves the input alone.
 */
export async function compactHistory(messages: ChatMessage[], options: CompactOptions): Promise<CompactOutcome> {
  const keepRecent = options.keepRecent ?? DEFAULT_KEEP_RECENT;
  const sysEnd = messages[0]?.role === 'system' ? 1 : 0;

  // Where the verbatim tail starts. A tool result must stay with the assistant message that asked for it.
  let boundary = Math.max(sysEnd, messages.length - keepRecent);
  while (boundary > sysEnd && messages[boundary]?.role === 'tool') boundary--;

  const older = messages.slice(sysEnd, boundary);
  const pinned: ChatMessage[] = [];
  const toSummarize: ChatMessage[] = [];
  for (const m of older) {
    if (m.role === 'tool' && typeof m.content === 'string' && isPinnedToolOutput(m.content)) {
      // Its tool call is going away, so the playbook moves to a user message (never pruned either).
      pinned.push({ role: 'user', content: `A skill loaded earlier in this conversation, which still applies:\n\n${m.content}` });
    } else if (isSkillInvocation(m)) {
      pinned.push(m);
    } else {
      toSummarize.push(m);
    }
  }
  if (toSummarize.length < MIN_TO_SUMMARIZE) return { status: 'nothing_to_compact' };

  let transcript = renderTranscript(toSummarize);
  const budget = Math.max(8000, Math.floor(options.maxInputTokens * 4 * 0.5));
  if (transcript.length > budget) {
    const head = Math.floor(budget * 0.4);
    const tail = budget - head;
    transcript = `${transcript.slice(0, head)}\n\n[… the middle of this transcript was left out to fit …]\n\n${transcript.slice(-tail)}`;
  }

  const tokensBefore = options.contextManager.estimateMessagesTokens(messages);

  let summary: string;
  try {
    const response = await raceAbort(
      options.client.chat.completions.create(
        {
          model: options.model,
          messages: [
            { role: 'system', content: SUMMARY_SYSTEM },
            { role: 'user', content: `Summarize this earlier part of the conversation:\n\n${transcript}` },
          ],
        },
        options.signal ? { signal: options.signal } : undefined
      ),
      options.signal
    );
    summary = (response.choices?.[0]?.message?.content ?? '').trim();
  } catch (err: any) {
    if (options.signal?.aborted) return { status: 'cancelled' };
    return { status: 'failed', error: `Summary request failed: ${err?.message ?? err}` };
  }
  if (options.signal?.aborted) return { status: 'cancelled' };
  if (!summary) return { status: 'failed', error: 'The model returned an empty summary.' };

  const summaryMessage: ChatMessage = {
    role: 'user',
    content: `${SUMMARY_TAG}\nSummary of the earlier conversation (older messages were compacted to save context):\n\n${summary}\n</conversation_summary>`,
  };
  const next: ChatMessage[] = [...messages.slice(0, sysEnd), ...pinned, summaryMessage, ...messages.slice(boundary)];
  const tokensAfter = options.contextManager.estimateMessagesTokens(next);
  // A few short messages can summarize to something longer than they were.
  if (tokensAfter >= tokensBefore) return { status: 'nothing_to_compact' };

  return { status: 'compacted', messages: next, summarized: toSummarize.length, tokensBefore, tokensAfter };
}

