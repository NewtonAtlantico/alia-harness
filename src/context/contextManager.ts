import OpenAI from 'openai';

export interface ContextLimits {
  maxInputTokens: number;
  maxToolOutputChars: number;
  maxToolOutputLines: number;
  pruneThresholdRatio: number;
}

export const DEFAULT_CONTEXT_LIMITS: ContextLimits = {
  maxInputTokens: 128000,
  maxToolOutputChars: 16000,
  maxToolOutputLines: 250,
  pruneThresholdRatio: 0.75, // Prune when exceeding 75% of context window
};

export class ContextManager {
  private limits: ContextLimits;

  constructor(limits: Partial<ContextLimits> = {}) {
    this.limits = { ...DEFAULT_CONTEXT_LIMITS, ...limits };
  }

  /**
   * Truncate large tool outputs (stdout, file contents) to prevent blowing up the context window.
   * Keeps the head and tail of the output for debugging visibility.
   */
  truncateToolOutput(rawOutput: string): { output: string; truncated: boolean } {
    if (!rawOutput) return { output: '', truncated: false };

    const lines = rawOutput.split('\n');
    const isOverChars = rawOutput.length > this.limits.maxToolOutputChars;
    const isOverLines = lines.length > this.limits.maxToolOutputLines;

    if (!isOverChars && !isOverLines) {
      return { output: rawOutput, truncated: false };
    }

    // Keep head and tail lines
    const headCount = Math.floor(this.limits.maxToolOutputLines * 0.6);
    const tailCount = Math.floor(this.limits.maxToolOutputLines * 0.3);

    if (lines.length > this.limits.maxToolOutputLines) {
      const head = lines.slice(0, headCount).join('\n');
      const tail = lines.slice(-tailCount).join('\n');
      const omitted = lines.length - headCount - tailCount;

      const output = `${head}\n\n[... Truncated ${omitted} lines (${rawOutput.length - head.length - tail.length} characters omitted) to preserve context window ...]\n\n${tail}`;
      return { output, truncated: true };
    }

    // If characters alone exceed limit
    const halfChars = Math.floor(this.limits.maxToolOutputChars / 2);
    const head = rawOutput.slice(0, halfChars);
    const tail = rawOutput.slice(-halfChars);
    const output = `${head}\n\n[... Truncated ${rawOutput.length - this.limits.maxToolOutputChars} characters to preserve context window ...]\n\n${tail}`;

    return { output, truncated: true };
  }

  /**
   * Approximate token count for a string (~4 chars per token).
   */
  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /**
   * Estimate total tokens across message history.
   */
  estimateMessagesTokens(messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]): number {
    let total = 0;
    for (const msg of messages) {
      if (typeof msg.content === 'string') {
        total += this.estimateTokens(msg.content);
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'text') {
            total += this.estimateTokens(part.text);
          }
        }
      }

      // Estimate tool calls tokens
      if ('tool_calls' in msg && Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          if ('function' in tc && tc.function) {
            total += 20 + this.estimateTokens(tc.function.name) + this.estimateTokens(tc.function.arguments);
          }
        }
      }
    }
    return total;
  }

  /**
   * Prune or compact older messages if context gets too close to the token limit.
   * Preserves:
   * 1. System prompt (first message)
   * 2. Recent turns (last N messages)
   * In between: replaces bulky tool outputs with concise markers.
   */
  pruneMessages(
    messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    keepRecentCount = 10
  ): { messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]; pruned: boolean } {
    const currentTokens = this.estimateMessagesTokens(messages);
    const tokenLimit = this.limits.maxInputTokens * this.limits.pruneThresholdRatio;

    if (currentTokens < tokenLimit || messages.length <= keepRecentCount + 2) {
      return { messages, pruned: false };
    }

    const prunedMessages = [...messages];
    const systemMessage = prunedMessages[0]?.role === 'system' ? prunedMessages[0] : null;
    const startIndex = systemMessage ? 1 : 0;
    const endIndex = Math.max(startIndex, prunedMessages.length - keepRecentCount);

    let changed = false;

    // Prune stale tool responses in the older segment
    for (let i = startIndex; i < endIndex; i++) {
      const msg = prunedMessages[i];
      if (msg.role === 'tool' && typeof msg.content === 'string' && msg.content.length > 300) {
        prunedMessages[i] = {
          ...msg,
          content: `[Previous tool output archived to save context: ${msg.content.slice(0, 80)}...]`,
        };
        changed = true;
      }
    }

    return { messages: prunedMessages, pruned: changed };
  }
}
