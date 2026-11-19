import OpenAI from 'openai';
import { ToolRegistry, ToolContext, CANCELLED_OUTPUT_PREFIX, isToolErrorResult } from '../tools/index.js';
import { raceAbort } from '../abort.js';
import { ChangeTracker, FileChangeSummary, RecordedChange } from '../changes/changeTracker.js';
import { SafetyChecker } from '../safety/safetyChecker.js';
import { ContextManager } from '../context/contextManager.js';
import { randomUUID } from 'node:crypto';
import { AgentUI } from './agentUI.js';
import { AgentEvent, EventSink, combineSinks, eventsToAgentUI } from './events.js';
import { AliaModelConfig } from '../config.js';

export interface AgentOptions {
  client: OpenAI;
  model: string;
  modelConfig: AliaModelConfig;
  toolRegistry: ToolRegistry;
  safetyChecker: SafetyChecker;
  contextManager: ContextManager;
  /** Absolute workspace root. Required: core never falls back to the process working directory. */
  workingDirectory: string;
  systemPrompt?: string;
  maxSteps?: number;
  /** Receives every {@link AgentEvent} of this agent's runs (the primary way to observe a run). */
  onEvent?: EventSink;
  /**
   * Called after every change to the conversation history (a message added, older tool output
   * archived, history cleared or replaced), with the live array. Used to persist sessions; the
   * array must be treated as read-only.
   */
  /** Where file writes are recorded for diff and undo. Shared with subagents. Without one, writes are only summarized in events. */
  changeTracker?: ChangeTracker;
  onHistory?: (messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]) => void;
  /** Legacy observer: adapted from the event stream (see `eventsToAgentUI`). May be combined with `onEvent`. */
  ui?: AgentUI;
  /**
   * Ask the endpoint to stream, and emit `assistant_delta` / `thinking_delta` as pieces arrive. Off by default. If the endpoint
   * cannot stream (it refuses the request, or answers with something that is not a stream) the step is repeated without
   * streaming, the agent remembers, and the run goes on: streaming is never a reason for a run to fail.
   */
  stream?: boolean;
}

/**
 * How a run ended:
 * - completed: the model produced a final text answer.
 * - max_steps: the step budget ran out before the model concluded.
 * - failed:    the API call threw, or the endpoint returned no usable message
 *              (see `failure` for which).
 * - cancelled: the caller aborted the run through its AbortSignal.
 */
export type AgentStatus = 'completed' | 'max_steps' | 'failed' | 'cancelled';

export interface RunOptions {
  /**
   * Aborts the run. It stops the model request, stops (or skips) tool calls, and ends with
   * status `cancelled`. The history stays valid, so the same agent can run again.
   */
  signal?: AbortSignal;
}

export interface AgentResult {
  status: AgentStatus;
  /** Final answer on `completed`; a human-readable message otherwise. */
  text: string;
  /** Model round-trips used by this run (not cumulative across runs). */
  steps: number;
  failure?: 'api_error' | 'empty_response';
}

export const DEFAULT_SYSTEM_PROMPT =`You are an expert AI software engineer and autonomous agent operating inside a CLI harness.
You have access to tools that let you read files, execute shell commands, write files, and inspect directories.
Follow these principles:
1. Always explore the existing codebase (inspect directory, read relevant files) before guessing or editing.
2. Use tools step-by-step to gather context and verify changes.
3. Be concise and direct in your final responses. Do not hallucinate file contents or command outputs.`;

class StreamNotSupported extends Error {}

/** Whether an error means "this endpoint will not stream" (as opposed to "the request failed": a bad key, a full quota, a server error). */
function refusedStreaming(err: any): boolean {
  if (err instanceof StreamNotSupported) return true;
  const status: number | undefined = err?.status;
  if (typeof status === 'number') return [400, 404, 405, 415, 422, 501].includes(status);
  // A stream that broke before the first piece, or a body that was not a stream at all.
  return /stream|event-stream|JSON|Unexpected token/i.test(String(err?.message ?? ''));
}

export class AliaAgent {
  private client: OpenAI;
  private model: string;
  private modelConfig: AliaModelConfig;
  private toolRegistry: ToolRegistry;
  private safetyChecker: SafetyChecker;
  private contextManager: ContextManager;
  private workingDirectory: string;
  private systemPrompt: string;
  private maxSteps: number;
  private emit: EventSink;
  private onHistory?: AgentOptions['onHistory'];
  private changeTracker?: ChangeTracker;
  private stream: boolean;
  /** Set after a plain request succeeded where a streaming one was refused: from then on this agent does not ask again. */
  private streamRefused = false;
  private messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

  constructor(options: AgentOptions) {
    this.client = options.client;
    this.model = options.model;
    this.modelConfig = options.modelConfig;
    this.toolRegistry = options.toolRegistry;
    this.safetyChecker = options.safetyChecker;
    this.contextManager = options.contextManager;
    this.workingDirectory = options.workingDirectory;
    this.systemPrompt = options.systemPrompt || DEFAULT_SYSTEM_PROMPT;
    this.maxSteps = options.maxSteps || 30;
    this.onHistory = options.onHistory;
    this.changeTracker = options.changeTracker;
    this.stream = options.stream === true;
    this.emit = combineSinks(options.ui ? eventsToAgentUI(options.ui) : undefined, options.onEvent);

    this.reset();
  }

  reset() {
    this.messages = [
      {
        role: 'system',
        content: this.systemPrompt,
      },
    ];
    this.onHistory?.(this.messages);
  }

  getMessages() {
    return this.messages;
  }

  /**
   * Replaces the whole history (resuming a saved conversation). The first message should be the
   * system prompt; callers that resume are expected to have refreshed it.
   */
  setMessages(messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]) {
    this.messages = messages;
    this.onHistory?.(this.messages);
  }

  private pushMessage(message: OpenAI.Chat.Completions.ChatCompletionMessageParam) {
    this.messages.push(message);
    this.onHistory?.(this.messages);
  }

  getModel() {
    return this.model;
  }

  getModelConfig() {
    return this.modelConfig;
  }

  setModel(newModel: string, config?: AliaModelConfig) {
    this.model = newModel;
    if (config) {
      this.modelConfig = config;
    }
  }

  /**
   * Core Agent Loop (The Master While Loop)
   * Feeds user input, intercepts tool calls, runs them locally, feeds results back,
   * and repeats until the model finishes its task with a final text response.
   */
  async run(userPrompt: string, options: RunOptions = {}): Promise<string> {
    return (await this.runDetailed(userPrompt, options)).text;
  }

  /**
   * Same loop as `run()`, but reports how it ended so callers (subagents, tests) can branch
   * on completed / max_steps / failed instead of string-matching the text.
   */
  async runDetailed(userPrompt: string, options: RunOptions = {}): Promise<AgentResult> {
    const runId = randomUUID();
    this.emit({ type: 'run_started', runId });
    let result: AgentResult;
    try {
      result = await this.runLoop(userPrompt, options.signal, runId);
    } catch (err: any) {
      // Unexpected exception: still close the run for observers, then let the caller see it.
      this.emit({ type: 'run_finished', runId, result: { status: 'failed', text: String(err?.message ?? err), steps: 0 } });
      throw err;
    }
    this.emit({ type: 'run_finished', runId, result });
    return result;
  }

  /** One model round-trip: streamed when asked to (and when the endpoint allows), otherwise in one piece. */
  private async requestModel(step: number, signal: AbortSignal | undefined): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    const params = { model: this.model, messages: this.messages, tools: this.toolRegistry.getOpenAITools(), tool_choice: 'auto' as const };
    const options = signal ? { signal } : undefined;
    let streamAttemptFailed = false;
    if (this.stream && !this.streamRefused) {
      try {
        return await raceAbort(this.streamResponse(params, options, step), signal);
      } catch (err: any) {
        // A cancelled run, or an endpoint that answered and failed (bad key, rate limit, server error), is not about streaming.
        if (signal?.aborted || !refusedStreaming(err)) throw err;
        streamAttemptFailed = true;
      }
    }
    const response = await raceAbort(this.client.chat.completions.create(params, options), signal);
    // The plain request worked where the stream did not: this endpoint cannot stream. Say so once, and stop asking.
    if (streamAttemptFailed) {
      this.streamRefused = true;
      this.emit({ type: 'notice', level: 'info', message: 'This endpoint does not stream: answers will appear when they are complete.' });
    }
    return response;
  }

  /** Reads a streamed answer into the same shape a plain one has, emitting the deltas on the way. */
  private async streamResponse(params: { model: string; messages: any; tools: any; tool_choice: 'auto' }, options: { signal: AbortSignal } | undefined, step: number): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    const stream: any = await this.client.chat.completions.create({ ...params, stream: true } as any, options);
    // An endpoint that ignores the flag answers with the whole completion: that is the answer, and it will not stream.
    if (stream?.choices && typeof stream[Symbol.asyncIterator] !== 'function') {
      this.streamRefused = true;
      return stream as OpenAI.Chat.Completions.ChatCompletion;
    }
    if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') throw new StreamNotSupported('the endpoint did not answer with a stream');
    let content = '';
    let reasoning = '';
    let finish: string | undefined;
    let chunks = 0;
    const calls = new Map<number, { id: string; name: string; args: string }>();
    for await (const chunk of stream) {
      chunks++;
      const choice = chunk?.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finish = choice.finish_reason;
      const delta = choice.delta ?? {};
      const thought: string | undefined = delta.reasoning_content ?? delta.reasoning ?? delta.provider_specific_fields?.reasoning;
      if (thought) {
        reasoning += thought;
        this.emit({ type: 'thinking_delta', step, text: thought });
      }
      if (typeof delta.content === 'string' && delta.content) {
        content += delta.content;
        this.emit({ type: 'assistant_delta', step, text: delta.content });
      }
      for (const tc of delta.tool_calls ?? []) {
        const at = typeof tc.index === 'number' ? tc.index : calls.size;
        const call = calls.get(at) ?? { id: '', name: '', args: '' };
        if (tc.id) call.id = tc.id;
        if (tc.function?.name) call.name += tc.function.name;
        if (tc.function?.arguments) call.args += tc.function.arguments;
        calls.set(at, call);
      }
    }
    if (chunks === 0) throw new StreamNotSupported('the stream was empty');
    const message: any = { role: 'assistant', content: content || null };
    if (reasoning) message.reasoning_content = reasoning;
    if (calls.size > 0) {
      message.tool_calls = [...calls.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, c], i) => ({ id: c.id || `call_${randomUUID().slice(0, 8)}_${i}`, type: 'function', function: { name: c.name, arguments: c.args } }));
    }
    return { id: 'stream', object: 'chat.completion', created: 0, model: params.model, choices: [{ index: 0, finish_reason: finish ?? (message.tool_calls ? 'tool_calls' : 'stop'), message }] } as unknown as OpenAI.Chat.Completions.ChatCompletion;
  }

  private cancelled(step: number): AgentResult {
    this.emit({ type: 'notice', level: 'info', message: 'Run cancelled.' });
    return { status: 'cancelled', text: 'Run cancelled by user.', steps: step };
  }

  private async runLoop(userPrompt: string, signal: AbortSignal | undefined, runId: string): Promise<AgentResult> {
    // 1. Append user prompt to message history
    this.pushMessage({
      role: 'user',
      content: userPrompt,
    });

    let step = 0;

    while (step < this.maxSteps) {
      if (signal?.aborted) return this.cancelled(step);
      step++;

      // Manage and prune context window if getting close to token budget
      const { messages: prunedMessages, pruned } = this.contextManager.pruneMessages(this.messages);
      if (pruned) {
        this.messages = prunedMessages;
        this.onHistory?.(this.messages);
        this.emit({ type: 'context_compacted' });
      }

      this.emit({ type: 'model_started', step });

      let response: OpenAI.Chat.Completions.ChatCompletion;
      try {
        // The signal is handed to the client (so the HTTP request is dropped) and also raced here,
        // so a client that ignores it still cannot keep a cancelled run waiting.
        response = await this.requestModel(step, signal);
      } catch (err: any) {
        this.emit({ type: 'model_finished', step });
        if (signal?.aborted) return this.cancelled(step);
        const errorMsg = `API request failed: ${err.message}`;
        this.emit({ type: 'notice', level: 'error', message: errorMsg });
        return { status: 'failed', text: errorMsg, steps: step, failure: 'api_error' };
      }

      this.emit({ type: 'model_finished', step });
      // The answer arrived just as the user cancelled: drop it rather than act on it.
      if (signal?.aborted) return this.cancelled(step);

      const choice = response.choices?.[0];
      if (!choice || !choice.message) {
        this.emit({ type: 'notice', level: 'error', message: 'Empty response received from LLM endpoint.' });
        return { status: 'failed', text: 'Empty response received.', steps: step, failure: 'empty_response' };
      }

      const assistantMessage = choice.message;

      // Handle reasoning / thinking content if present (common in models like gpt-oss / deepseek)
      const reasoning =
        (assistantMessage as any).reasoning_content ||
        (assistantMessage as any).provider_specific_fields?.reasoning ||
        (assistantMessage as any).reasoning;

      if (reasoning) {
        this.emit({ type: 'thinking', text: reasoning });
      }

      // Check if the model requested tool calls
      const toolCalls = assistantMessage.tool_calls;

      if (!toolCalls || toolCalls.length === 0) {
        // No tool calls: model has concluded and produced a final text response
        const content = assistantMessage.content || '';
        this.pushMessage(assistantMessage);
        this.emit({ type: 'assistant_message', text: content, final: true });
        return { status: 'completed', text: content, steps: step };
      }

      // Model returned tool calls: append assistant's tool-call request to messages
      this.pushMessage(assistantMessage);
      if (assistantMessage.content) {
        this.emit({ type: 'assistant_message', text: assistantMessage.content, final: false });
      }

      // Execute each tool call
      const baseContext: ToolContext = {
        workingDirectory: this.workingDirectory,
        safetyChecker: this.safetyChecker,
        contextManager: this.contextManager,
        signal,
        runId,
        changes: this.changeTracker,
        emit: this.emit,
      };
      const answered = new Set<string>();

      for (const toolCall of toolCalls) {
        // Only function tool calls supported by standard OpenAI spec
        if (toolCall.type !== 'function') continue;
        if (signal?.aborted) break;

        const fnName = toolCall.function.name;
        const fnArgs = toolCall.function.arguments;

        this.emit({ type: 'tool_call_started', id: toolCall.id, name: fnName, args: fnArgs });

        // Files this call writes: kept by the tracker (if any) and summarized for the event.
        const changes: FileChangeSummary[] = [];
        const recordChange = (change: RecordedChange) => {
          changes.push(
            this.changeTracker
              ? this.changeTracker.record({ ...change, runId, toolCallId: toolCall.id })
              : new ChangeTracker(this.workingDirectory).summarize(change)
          );
        };

        const startTime = Date.now();
        const result = await this.toolRegistry.execute(fnName, fnArgs, { ...baseContext, toolCallId: toolCall.id, recordChange });
        const durationMs = Date.now() - startTime;

        const isError = isToolErrorResult(result) || result.startsWith(CANCELLED_OUTPUT_PREFIX);
        this.emit({
          type: 'tool_call_finished',
          id: toolCall.id,
          name: fnName,
          result,
          isError,
          durationMs,
          ...(changes.length > 0 ? { changes } : {}),
        });

        // Feedback: Append tool result back into message history as a tool role message
        this.pushMessage({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: result,
        });
        answered.add(toolCall.id);
      }

      if (signal?.aborted) {
        // The model announced these calls, so each needs a tool message or the next request is
        // rejected for a dangling tool_call_id. Tell it they did not run.
        for (const toolCall of toolCalls) {
          if (answered.has(toolCall.id)) continue;
          this.pushMessage({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: `${CANCELLED_OUTPUT_PREFIX} Tool call was not run because the run was cancelled.`,
          });
        }
        return this.cancelled(step);
      }

      // Loop repeats: next iteration will send tool results back to LLM for reasoning
    }

    const maxStepsMsg = `Agent reached maximum allowable steps (${this.maxSteps}) without concluding.`;
    this.emit({ type: 'notice', level: 'error', message: maxStepsMsg });
    return { status: 'max_steps', text: maxStepsMsg, steps: step };
  }
}
