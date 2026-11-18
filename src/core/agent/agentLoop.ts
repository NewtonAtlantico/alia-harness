import OpenAI from 'openai';
import { ToolRegistry, ToolContext, CANCELLED_OUTPUT_PREFIX } from '../tools/index.js';
import { raceAbort } from '../abort.js';
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
  onHistory?: (messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]) => void;
  /** Legacy observer: adapted from the event stream (see `eventsToAgentUI`). May be combined with `onEvent`. */
  ui?: AgentUI;
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
      result = await this.runLoop(userPrompt, options.signal);
    } catch (err: any) {
      // Unexpected exception: still close the run for observers, then let the caller see it.
      this.emit({ type: 'run_finished', runId, result: { status: 'failed', text: String(err?.message ?? err), steps: 0 } });
      throw err;
    }
    this.emit({ type: 'run_finished', runId, result });
    return result;
  }

  private cancelled(step: number): AgentResult {
    this.emit({ type: 'notice', level: 'info', message: 'Run cancelled.' });
    return { status: 'cancelled', text: 'Run cancelled by user.', steps: step };
  }

  private async runLoop(userPrompt: string, signal?: AbortSignal): Promise<AgentResult> {
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
        response = await raceAbort(
          this.client.chat.completions.create(
            {
              model: this.model,
              messages: this.messages,
              tools: this.toolRegistry.getOpenAITools(),
              tool_choice: 'auto',
            },
            signal ? { signal } : undefined
          ),
          signal
        );
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

        const startTime = Date.now();
        const result = await this.toolRegistry.execute(fnName, fnArgs, { ...baseContext, toolCallId: toolCall.id });
        const durationMs = Date.now() - startTime;

        const isError = result.startsWith('Error:') || result.startsWith(CANCELLED_OUTPUT_PREFIX);
        this.emit({ type: 'tool_call_finished', id: toolCall.id, name: fnName, result, isError, durationMs });

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
