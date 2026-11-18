import type { AgentResult } from './agentLoop.js';
import type { AgentUI, ThinkingHandle } from './agentUI.js';
import type { PermissionDecision } from '../safety/safetyChecker.js';

/**
 * Everything a front-end needs to render a run, as plain serializable data.
 *
 * - Tool calls are paired by `id` (the model's `tool_call_id`): create a row on
 *   `tool_call_started`, update the same row on `tool_call_finished`.
 * - Events produced inside a subagent carry its `subagentId`, so they can be rendered under the
 *   parent's `run_subagent` row (`subagent_started.parentToolCallId`).
 * - Events are data only (no functions, no class instances), so they can cross an IPC boundary as is.
 */
export type AgentEventBody =
  | { type: 'run_started'; runId: string }
  /** A request to the model is in flight (the "thinking" spinner). Always followed by `model_finished`. */
  | { type: 'model_started'; step: number }
  | { type: 'model_finished'; step: number }
  /** Reasoning text returned by the model (reasoning_content and friends). */
  | { type: 'thinking'; text: string }
  /**
   * Assistant text. `final: true` is the answer that ends the run; `final: false` is text the model
   * wrote alongside tool calls ("I'll read the file first..."), which the terminal UI does not show.
   */
  | { type: 'assistant_message'; text: string; final: boolean }
  | { type: 'tool_call_started'; id: string; name: string; args: string }
  | { type: 'tool_call_finished'; id: string; name: string; result: string; isError: boolean; durationMs: number }
  /**
   * A command is waiting for the user's decision. `toolCallId` is the tool call that wants to run it.
   * `canAlwaysAllow` is false for a dangerous command: offer "allow once" and "deny" only.
   */
  | {
      type: 'permission_requested';
      id: string;
      toolCallId?: string;
      command: string;
      reasons: string[];
      dangerous: boolean;
      canAlwaysAllow: boolean;
      requester?: string;
    }
  /** The request was answered (or the run was cancelled while it was open): close the card. */
  | { type: 'permission_resolved'; id: string; toolCallId?: string; decision: PermissionDecision | 'cancelled' }
  /**
   * The history was made smaller: older tool output archived (no extra fields), or a `/compact`
   * summary (the fields say how much it saved).
   */
  | { type: 'context_compacted'; summarized?: number; tokensBefore?: number; tokensAfter?: number }
  | {
      type: 'subagent_started';
      id: string;
      /** The parent's `run_subagent` tool call this child belongs to, when known. */
      parentToolCallId?: string;
      label: string;
      maxSteps: number;
      skill?: string;
      /** One line per step instead of the full transcript (terminal UI hint). */
      quiet: boolean;
    }
  | { type: 'subagent_finished'; id: string; label: string; status: string; steps: number; maxSteps: number }
  | { type: 'notice'; level: 'info' | 'success' | 'error'; message: string }
  | { type: 'run_finished'; runId: string; result: AgentResult };

export type AgentEvent = AgentEventBody & {
  /** Set on events produced inside a subagent. */
  subagentId?: string;
};

export type EventSink = (event: AgentEvent) => void;

/** Fans one event out to several sinks. A throwing sink never breaks the run or the other sinks. */
export function combineSinks(...sinks: Array<EventSink | undefined>): EventSink {
  const active = sinks.filter((s): s is EventSink => !!s);
  return (event) => {
    for (const sink of active) {
      try {
        sink(event);
      } catch {
        // An observer must not be able to crash the agent.
      }
    }
  };
}

/**
 * Adapts the event stream to the older `AgentUI` interface, so the terminal UI keeps working
 * without knowing about events. Produces exactly the calls the agent used to make directly.
 */
export function eventsToAgentUI(ui: AgentUI): EventSink {
  const spinners = new Map<string | undefined, ThinkingHandle>();

  return (e) => {
    switch (e.type) {
      case 'model_started': {
        const handle = ui.startThinking?.();
        if (handle) spinners.set(e.subagentId, handle);
        return;
      }
      case 'model_finished':
        spinners.get(e.subagentId)?.stop();
        spinners.delete(e.subagentId);
        return;
      case 'thinking':
        ui.printThinking?.(e.text);
        return;
      case 'assistant_message':
        if (e.final) ui.printAssistantMessage?.(e.text);
        return;
      case 'tool_call_started':
        ui.printToolCall?.(e.name, e.args);
        return;
      case 'tool_call_finished':
        ui.printToolResult?.(e.result, e.isError);
        return;
      case 'context_compacted':
        ui.printInfo?.(
          e.tokensBefore !== undefined
            ? `Conversation compacted: ${e.tokensBefore} -> ${e.tokensAfter} estimated tokens (${e.summarized} earlier messages summarized).`
            : 'Context window compacted to preserve token budget.'
        );
        return;
      case 'subagent_started':
        ui.printInfo?.(
          `Subagent started (max ${e.maxSteps} steps${e.skill ? `, skill ${e.skill}` : ''}): ${e.label}`
        );
        ui.pushScope?.({ label: e.label, quiet: e.quiet });
        return;
      case 'subagent_finished':
        ui.popScope?.();
        ui.printInfo?.(`Subagent finished: ${e.status} (${e.steps}/${e.maxSteps} steps)`);
        return;
      case 'notice':
        if (e.level === 'error') ui.printError?.(e.message);
        else if (e.level === 'success') ui.printSuccess?.(e.message);
        else ui.printInfo?.(e.message);
        return;
      // No terminal equivalent: run_started, run_finished, permission_requested, permission_resolved
      // (the terminal asks through its own confirmation handler).
      default:
        return;
    }
  };
}
