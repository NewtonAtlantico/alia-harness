import OpenAI from 'openai';
import { ToolDefinition, ToolContext, toOpenAITool } from './types.js';
import { readFileTool } from './readFile.js';
import { runBashTool } from './runBash.js';
import { writeFileTool } from './writeFile.js';
import { listFilesTool } from './listFiles.js';
import { editFileTool } from './editFile.js';
import { grepSearchTool } from './grepSearch.js';

export * from './types.js';
export { readFileTool } from './readFile.js';
export { runBashTool } from './runBash.js';
export { writeFileTool } from './writeFile.js';
export { listFilesTool } from './listFiles.js';
export { editFileTool } from './editFile.js';
export { grepSearchTool } from './grepSearch.js';

export class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();

  constructor() {
    this.register(readFileTool);
    this.register(runBashTool);
    this.register(writeFileTool);
    this.register(listFilesTool);
    this.register(editFileTool);
    this.register(grepSearchTool);
  }

  register(tool: ToolDefinition) {
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  getAll(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  getOpenAITools(): OpenAI.Chat.Completions.ChatCompletionTool[] {
    return this.getAll().map(toOpenAITool);
  }

  async execute(
    name: string,
    rawArguments: string,
    context: ToolContext
  ): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) {
      return `Error: Tool "${name}" is not registered. Available tools: ${Array.from(this.tools.keys()).join(', ')}`;
    }

    let parsedArgs: any = {};
    if (rawArguments && rawArguments.trim()) {
      try {
        parsedArgs = JSON.parse(rawArguments);
      } catch (err: any) {
        return `Error parsing JSON arguments for tool "${name}": ${err.message}. Provided raw arguments: "${rawArguments}"`;
      }
    }

    try {
      return await tool.execute(parsedArgs, context);
    } catch (err: any) {
      return `Error executing tool "${name}": ${err.message}`;
    }
  }
}
