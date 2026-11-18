import OpenAI from 'openai';
import { SafetyChecker } from '../safety/safetyChecker.js';
import { ContextManager } from '../context/contextManager.js';
import type { AgentEvent } from '../agent/events.js';

export interface ToolContext {
  workingDirectory: string;
  safetyChecker: SafetyChecker;
  contextManager: ContextManager;
  /** The model's id for the tool call being executed (absent when a tool is invoked outside a run). */
  toolCallId?: string;
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
