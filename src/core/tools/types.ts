import OpenAI from 'openai';
import { SafetyChecker } from '../safety/safetyChecker.js';
import { ContextManager } from '../context/contextManager.js';
import type { AgentEvent } from '../agent/events.js';
import type { ChangeTracker, RecordedChange } from '../changes/changeTracker.js';

/**
 * Tool results that begin with this text mean "stopped because the run was cancelled".
 * The agent loop reports them as failed tool calls.
 */
export const CANCELLED_OUTPUT_PREFIX = '[Cancelled by user]';

/**
 * Whether a tool result reports a failure. Tools return plain strings: most start with `Error:`,
 * but the catch blocks in the file tools say `Error writing file ...`, `Error editing file ...` and so on.
 */
export function isToolErrorResult(result: string): boolean {
  return /^Error(:| (editing|executing|listing|parsing|performing|reading|writing)\b)/.test(result);
}

export interface ToolContext {
  workingDirectory: string;
  safetyChecker: SafetyChecker;
  contextManager: ContextManager;
  /** The model's id for the tool call being executed (absent when a tool is invoked outside a run). */
  toolCallId?: string;
  /** Aborts when the user cancels the run. Long-running tools must stop work and return promptly. */
  signal?: AbortSignal;
  /** The id of the run this call belongs to. */
  runId?: string;
  /** Tools that write files report each write here, so it can be shown as a diff and undone. */
  recordChange?: (change: RecordedChange) => void;
  /** The tracker behind `recordChange` (handed on to subagents). */
  changes?: ChangeTracker;
  /** Lets a tool report structured events (e.g. subagent start/finish). Absent outside a run. */
  emit?: (event: AgentEvent) => void;
}

export interface ToolDefinition<TArgs = any> {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
  execute: (args: TArgs, context: ToolContext) => Promise<string>;
}

export function toOpenAITool(tool: ToolDefinition): OpenAI.Chat.Completions.ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}
