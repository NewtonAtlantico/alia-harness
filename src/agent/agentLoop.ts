import OpenAI from 'openai';
import { ToolRegistry, ToolContext } from '../tools/index.js';
import { SafetyChecker } from '../safety/safetyChecker.js';
import { ContextManager } from '../context/contextManager.js';
import { TerminalUI } from '../ui/terminal.js';
import { AliaModelConfig } from '../config.js';

export interface AgentOptions {
  client: OpenAI;
  model: string;
  modelConfig: AliaModelConfig;
  toolRegistry: ToolRegistry;
  safetyChecker: SafetyChecker;
  contextManager: ContextManager;
  workingDirectory?: string;
  systemPrompt?: string;
  maxSteps?: number;
}

const DEFAULT_SYSTEM_PROMPT = `You are an expert AI software engineer and autonomous agent operating inside a CLI harness.
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
  private messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

  constructor(options: AgentOptions) {
    this.client = options.client;
    this.model = options.model;
    this.modelConfig = options.modelConfig;
    this.toolRegistry = options.toolRegistry;
    this.safetyChecker = options.safetyChecker;
    this.contextManager = options.contextManager;
    this.workingDirectory = options.workingDirectory || process.cwd();
    this.systemPrompt = options.systemPrompt || DEFAULT_SYSTEM_PROMPT;
    this.maxSteps = options.maxSteps || 30;

    this.reset();
  }

  reset() {
    this.messages = [
      {
        role: 'system',
        content: this.systemPrompt,
      },
    ];
  }

  getMessages() {
    return this.messages;
  }

  getModel() {
    return this.model;
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
  async run(userPrompt: string): Promise<string> {
    // 1. Append user prompt to message history
    this.messages.push({
      role: 'user',
      content: userPrompt,
    });

    let step = 0;

    while (step < this.maxSteps) {
      step++;

      // Manage and prune context window if getting close to token budget
      const { messages: prunedMessages, pruned } = this.contextManager.pruneMessages(this.messages);
      if (pruned) {
        this.messages = prunedMessages;
        TerminalUI.printInfo('Context window compacted to preserve token budget.');
      }

      TerminalUI.printThinking();

      let response: OpenAI.Chat.Completions.ChatCompletion;
      try {
        response = await this.client.chat.completions.create({
          model: this.model,
          messages: this.messages,
          tools: this.toolRegistry.getOpenAITools(),
          tool_choice: 'auto',
        });
      } catch (err: any) {
        TerminalUI.clearLine();
        const errorMsg = `API request failed: ${err.message}`;
        TerminalUI.printError(errorMsg);
        return errorMsg;
      }

      TerminalUI.clearLine();

      const choice = response.choices?.[0];
      if (!choice || !choice.message) {
        TerminalUI.printError('Empty response received from LLM endpoint.');
        return 'Empty response received.';
      }

      const assistantMessage = choice.message;

      // Handle reasoning / thinking content if present (common in models like gpt-oss / deepseek)
      const reasoning =
        (assistantMessage as any).reasoning_content ||
        (assistantMessage as any).provider_specific_fields?.reasoning ||
        (assistantMessage as any).reasoning;

      if (reasoning) {
        TerminalUI.printThinking(reasoning);
      }

      // Check if the model requested tool calls
      const toolCalls = assistantMessage.tool_calls;

      if (!toolCalls || toolCalls.length === 0) {
        // No tool calls: model has concluded and produced a final text response
        const content = assistantMessage.content || '';
        this.messages.push(assistantMessage);
        TerminalUI.printAssistantMessage(content);
        return content;
      }

      // Model returned tool calls: append assistant's tool-call request to messages
      this.messages.push(assistantMessage);

      // Execute each tool call
      const toolContext: ToolContext = {
        workingDirectory: this.workingDirectory,
        safetyChecker: this.safetyChecker,
        contextManager: this.contextManager,
      };

      for (const toolCall of toolCalls) {
        // Only function tool calls supported by standard OpenAI spec
        if (toolCall.type !== 'function') continue;

        const fnName = toolCall.function.name;
        const fnArgs = toolCall.function.arguments;

        TerminalUI.printToolCall(fnName, fnArgs);

        const startTime = Date.now();
        const result = await this.toolRegistry.execute(fnName, fnArgs, toolContext);
        const duration = Date.now() - startTime;

        const isError = result.startsWith('Error:');
        TerminalUI.printToolResult(result, isError);

        // Feedback: Append tool result back into message history as a tool role message
        this.messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: result,
        });
      }

      // Loop repeats: next iteration will send tool results back to LLM for reasoning
    }

    const maxStepsMsg = `Agent reached maximum allowable steps (${this.maxSteps}) without concluding.`;
    TerminalUI.printError(maxStepsMsg);
    return maxStepsMsg;
  }
}
