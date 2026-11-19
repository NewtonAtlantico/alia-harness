import type { ChatMessage } from './sessionStore.js';

export const INTERRUPTED_OUTPUT_PREFIX = '[Interrupted]';

/**
 * Makes a history that stopped in the middle of a run valid again. If the app or engine died after the
 * model announced tool calls but before every result was saved, those calls have no `tool` message, and
 * the endpoint rejects the next request for a dangling `tool_call_id`. Each missing result is added
 * (right after the other results of that turn) saying the call did not finish.
 *
 * Pure: the input is not changed. A history that is already valid is returned as it is.
 */
export function repairInterruptedHistory(messages: ChatMessage[]): { messages: ChatMessage[]; repaired: number } {
  const out: ChatMessage[] = [];
  let repaired = 0;

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    out.push(message);
    if (message.role !== 'assistant' || !('tool_calls' in message) || !message.tool_calls?.length) continue;

    // The results of this turn are the `tool` messages that follow directly.
    let end = i + 1;
    const answered = new Set<string>();
    while (end < messages.length && messages[end].role === 'tool') {
      answered.add((messages[end] as { tool_call_id: string }).tool_call_id);
      out.push(messages[end]);
      end++;
    }
    for (const call of message.tool_calls) {
      if (answered.has(call.id)) continue;
      out.push({ role: 'tool', tool_call_id: call.id, content: `${INTERRUPTED_OUTPUT_PREFIX} This tool call did not finish because the app stopped before it completed.` });
      repaired++;
    }
    i = end - 1;
  }
  return repaired === 0 ? { messages, repaired: 0 } : { messages: out, repaired };
}
