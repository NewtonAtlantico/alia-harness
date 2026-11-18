export interface ThinkingHandle {
  stop: () => void;
}

/**
 * How a front-end observes a run. Passed explicitly to `createSession` / `AliaAgent`; there is
 * no process-wide default, so several sessions in one process never share a UI.
 */
export interface AgentUI {
  startThinking?(label?: string): ThinkingHandle | void;
  printThinking?(reasoning: string): void;
  printAssistantMessage?(content: string): void;
  printToolCall?(toolName: string, argsStr: string): void;
  printToolResult?(output: string, isError?: boolean): void;
  printError?(msg: string): void;
  printInfo?(msg: string): void;
  printSuccess?(msg: string): void;
  pushScope?(opts: { label: string; quiet?: boolean }): void;
  popScope?(): void;
  getScopeLabel?(): string | undefined;
}
