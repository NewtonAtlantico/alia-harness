export interface ThinkingHandle {
  stop: () => void;
}

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

let defaultAgentUI: AgentUI | undefined;

export function setDefaultAgentUI(ui: AgentUI | undefined): void {
  defaultAgentUI = ui;
}

export function getDefaultAgentUI(): AgentUI | undefined {
  return defaultAgentUI;
}
