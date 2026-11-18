import OpenAI from 'openai';
import { SafetyChecker } from '../safety/safetyChecker.js';
import { ContextManager } from '../context/contextManager.js';

export interface ToolContext {
  workingDirectory: string;
  safetyChecker: SafetyChecker;
  contextManager: ContextManager;
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
