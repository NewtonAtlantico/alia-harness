import type { ChatMessage } from '../../../shared/ipc';

export interface TextRow {
  role: 'user' | 'assistant';
  text: string;
}

/** The text of a message, whether the model API stored it as a string or as parts. Empty for a message with none. */
export function textOf(message: ChatMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === 'object' && 'text' in part && typeof (part as { text: unknown }).text === 'string' ? (part as { text: string }).text : ''))
      .join('');
  }
  return '';
}

/** The conversation as plain rows: what the user said and what the assistant answered (tool calls and system text left out). */
export function textRows(messages: ChatMessage[]): TextRow[] {
  const rows: TextRow[] = [];
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const text = textOf(m).trim();
    if (text) rows.push({ role: m.role, text });
  }
  return rows;
}
