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
  /** Tools deliberately withheld from this registry (name -> why), for a clear error if called. */
  private withheld: Map<string, string> = new Map();

  /**
   * @param tools use exactly these tools instead of the built-in set (see `without`).
   */
  constructor(tools?: ToolDefinition[]) {
    if (tools) {
      for (const tool of tools) this.register(tool);
      return;
    }
    this.register(readFileTool);
    this.register(runBashTool);
    this.register(writeFileTool);
    this.register(listFilesTool);
    this.register(editFileTool);
    this.register(grepSearchTool);
  }

  /**
   * A copy of this registry minus the named tools. Calling a removed tool returns
   * `reason` instead of the generic "not registered" error. Used to build a subagent's
   * tool set (a subagent cannot spawn subagents).
   */
  without(names: string[], reason?: string): ToolRegistry {
    const drop = new Set(names);
    const copy = new ToolRegistry(this.getAll().filter((t) => !drop.has(t.name)));
    for (const [name, why] of this.withheld) copy.withheld.set(name, why);
    for (const name of drop) {
      copy.withheld.set(name, reason ?? `Tool "${name}" is not available in this context.`);
    }
    return copy;
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
      const why = this.withheld.get(name);
      if (why) return `Error: ${why}`;
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
