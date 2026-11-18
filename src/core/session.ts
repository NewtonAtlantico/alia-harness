import path from 'node:path';
import OpenAI from 'openai';
import { AliaConfig, AliaModelConfig, validateConfig } from './config.js';
import { createAliaClient, fetchAvailableModels } from './client.js';
import { ToolRegistry } from './tools/index.js';
import { createUseSkillTool } from './tools/useSkill.js';
import { createRunSubagentTool } from './tools/runSubagent.js';
import {
  PermissionMode,
  SafetyChecker,
  SafetyConfirmationHandler,
  normalizeAnswer,
} from './safety/safetyChecker.js';
import { PermissionStore } from './safety/permissionStore.js';
import { ContextManager } from './context/contextManager.js';
import { AttachedFile, resolveFileMentions } from './context/fileMentions.js';
import { AgentResult, AliaAgent, DEFAULT_SYSTEM_PROMPT, RunOptions } from './agent/agentLoop.js';
import { randomUUID } from 'node:crypto';
import { AgentUI } from './agent/agentUI.js';
import { EventSink, combineSinks, eventsToAgentUI } from './agent/events.js';
import {
  Skill,
  SkillRegistry,
  SkillRoot,
  buildSkillCatalog,
  buildSkillInvocationPrompt,
} from './skills/skillLoader.js';

export interface SessionOptions {
  /** Workspace root the agent works in. Resolved to an absolute path. */
  workspace: string;
  /** Config object. Build it with `loadConfig(...)` or in memory (e.g. API key from a secret store). */
  config: AliaConfig;
  /** Model id or name from the config (or any id served by the endpoint). Default: first configured model. */
  modelId?: string;
  /** Receives every `AgentEvent` of this session, including those of its subagents. The primary way to render a run. */
  onEvent?: EventSink;
  /** Legacy `AgentUI` observer (the terminal), adapted from the same event stream. Optional; a session with neither is silent. */
  ui?: AgentUI;
  /**
   * When commands need the user's approval: `ask-dangerous` (default: only destructive ones),
   * `ask-commands` (every command not allowlisted in this project) or `auto` (never).
   */
  permissionMode?: PermissionMode;
  /** Shorthand for `permissionMode: 'auto'`. `permissionMode` wins when both are set. */
  autoApprove?: boolean;
  /**
   * Asked when a command needs approval. Without it (and outside `auto`) such commands are denied.
   * Returns a `PermissionDecision` (`allow_once` | `allow_always` | `deny`), or a boolean (older contract).
   */
  onConfirm?: SafetyConfirmationHandler;
  /** Called when `auto` lets a destructive command through (for an audit line). */
  onAutoApprove?: (command: string) => void;
  /** Where "always allow" is remembered. Default: a per-project file under `~/.alia/permissions`. */
  permissionStore?: PermissionStore;
  /** Folder for the default permission store (tests, or a host that keeps its data elsewhere). */
  permissionsDir?: string;
  /** Skill folders to scan, lowest precedence first. Default: bundled, user, project (`<workspace>/.alia/skills`), env. */
  skillRoots?: SkillRoot[];
  /** Show a subagent's full transcript instead of one line per tool call. */
  subagentVerbose?: boolean;
  /** Step cap of the main agent (default 30). */
  maxSteps?: number;
  /** Use this client instead of building one from the config. Mainly a test seam (see scripts/lib/fakeModel.ts). */
  client?: OpenAI;
}

export interface ContextUsage {
  tokens: number;
  limit: number;
  /** 0-100, one decimal. */
  percent: number;
  messages: number;
}

/** What `resolveSkill` found for a `/command`. */
export type SkillResolution =
  | { status: 'not_a_skill' }
  | { status: 'unavailable'; skill: Skill; missing: string[]; message: string }
  | {
      status: 'ready';
      skill: Skill;
      /** Full prompt to hand to `run()`: the skill body plus the user's input and attached files. */
      prompt: string;
      attachments: AttachedFile[];
      /** Mentions that could not be attached. */
      errors: string[];
    };

export type SwitchModelResult =
  | { ok: true; id: string }
  | { ok: false; available: string[] };

export interface PreparedInput {
  prompt: string;
  attachments: AttachedFile[];
  errors: string[];
}

/**
 * One isolated conversation: its own workspace, tools, skills, history, safety checker and
 * observer. Nothing here is process-wide, so a host (CLI, desktop app) can run several at once.
 */
export class AliaSession {
  readonly workspace: string;
  readonly config: AliaConfig;
  readonly tools: ToolRegistry;
  readonly skills: SkillRegistry;
  readonly agent: AliaAgent;
  readonly contextManager: ContextManager;
  /** The project's allowlist ("always allow"): list, remove and clear rules from a settings screen. */
  readonly permissions: PermissionStore;
  readonly systemPrompt: string;
  private readonly client: OpenAI;

  constructor(options: SessionOptions) {
    this.workspace = path.resolve(options.workspace);
    this.config = validateConfig(options.config);

    const selected = createAliaClient(this.config, options.modelId);
    this.client = options.client ?? selected.client;

    this.tools = new ToolRegistry();

    // Skills: scan folders, expose use_skill, and advertise a catalog in the system prompt.
    this.skills = new SkillRegistry({
      roots: options.skillRoots,
      cwd: this.workspace,
      getToolNames: () => this.tools.getAll().map((t) => t.name),
    });
    this.skills.load();
    this.tools.register(createUseSkillTool(this.skills));
    const catalog = buildSkillCatalog(this.skills);
    this.systemPrompt = catalog ? `${DEFAULT_SYSTEM_PROMPT}\n\n${catalog}` : DEFAULT_SYSTEM_PROMPT;

    const ui = options.ui;
    const emit = combineSinks(ui ? eventsToAgentUI(ui) : undefined, options.onEvent);
    const onConfirm = options.onConfirm;
    this.permissions = options.permissionStore ?? new PermissionStore(this.workspace, { dir: options.permissionsDir });
    const safetyChecker = new SafetyChecker({
      mode: options.permissionMode ?? (options.autoApprove ? 'auto' : 'ask-dangerous'),
      permissions: this.permissions,
      onConfirm: onConfirm
        ? async (ctx) => {
            const id = randomUUID();
            let resolved = false;
            const resolve = (decision: 'allow_once' | 'allow_always' | 'deny' | 'cancelled') => {
              if (resolved) return;
              resolved = true;
              emit({ type: 'permission_resolved', id, toolCallId: ctx.toolCallId, decision });
            };
            emit({
              type: 'permission_requested',
              id,
              toolCallId: ctx.toolCallId,
              command: ctx.command,
              reasons: ctx.reasons,
              dangerous: ctx.dangerous,
              canAlwaysAllow: ctx.canAlwaysAllow,
              requester: ctx.requester,
            });
            // The run may be cancelled while the card is open; the handler may never answer then.
            ctx.signal?.addEventListener('abort', () => resolve('cancelled'), { once: true });
            const answer = await onConfirm(ctx);
            resolve(normalizeAnswer(answer).decision);
            return answer;
          }
        : undefined,
      onAutoApprove: options.onAutoApprove,
      getScopeLabel: () => ui?.getScopeLabel?.(),
    });

    this.contextManager = new ContextManager({
      maxInputTokens: selected.modelConfig.maxInputTokens || 128000,
    });

    this.agent = new AliaAgent({
      client: this.client,
      model: selected.model,
      modelConfig: selected.modelConfig,
      toolRegistry: this.tools,
      safetyChecker,
      contextManager: this.contextManager,
      workingDirectory: this.workspace,
      systemPrompt: this.systemPrompt,
      maxSteps: options.maxSteps,
      onEvent: emit,
    });

    // Registered after the agent exists so the tool reads the live model. A child gets a copy
    // of the registry without it (depth 1 only).
    this.tools.register(
      createRunSubagentTool({
        getClient: () => this.client,
        getModel: () => ({ id: this.agent.getModel(), config: this.agent.getModelConfig() }),
        getRegistry: () => this.tools,
        systemPrompt: this.systemPrompt,
        getSkills: () => this.skills,
        verbose: options.subagentVerbose,
      })
    );
  }

  /** Runs one user turn through the agent loop. Pass `{ signal }` to make it cancellable (Stop button). */
  run(prompt: string, options: RunOptions = {}): Promise<AgentResult> {
    return this.agent.runDetailed(prompt, options);
  }

  /** Expands `@path` mentions in user text into attached file contents. */
  prepareInput(text: string): PreparedInput {
    return resolveFileMentions(text, this.workspace);
  }

  /**
   * Turns `/skill-name <input>` into the prompt for `run()`. `not_a_skill` means the host
   * should treat the command as its own (or unknown).
   */
  resolveSkill(command: string, input: string): SkillResolution {
    const skill = this.skills.get(command);
    if (!skill) return { status: 'not_a_skill' };
    const missing = this.skills.missingRequirements(skill);
    if (missing.length > 0) {
      return {
        status: 'unavailable',
        skill,
        missing,
        message: `Skill "${skill.name}" is unavailable: it requires ${missing.join(', ')} (no matching tool is registered in this harness).`,
      };
    }
    const { prompt, attachments, errors } = this.prepareInput(input);
    return {
      status: 'ready',
      skill,
      prompt: buildSkillInvocationPrompt(skill, this.skills, prompt),
      attachments,
      errors,
    };
  }

  getModel(): string {
    return this.agent.getModel();
  }

  getModelConfig(): AliaModelConfig {
    return this.agent.getModelConfig();
  }

  /** Models from the config plus whatever the endpoint reports (empty if it cannot be reached). */
  async listModels(): Promise<{ configured: AliaModelConfig[]; remote: string[] }> {
    return { configured: this.config.models, remote: await fetchAvailableModels(this.client) };
  }

  /** Switches the model used by later turns (and by subagents started afterwards). */
  async switchModel(idOrName: string): Promise<SwitchModelResult> {
    const configured = this.config.models.find((m) => m.id === idOrName || m.name === idOrName);
    if (configured) {
      this.agent.setModel(configured.id, configured);
      return { ok: true, id: configured.id };
    }
    // Any model served by the endpoint can be selected, with the default limits.
    const remote = await fetchAvailableModels(this.client);
    if (!remote.includes(idOrName)) return { ok: false, available: remote };
    this.agent.setModel(idOrName, {
      id: idOrName,
      name: idOrName,
      url: this.agent.getModelConfig().url,
      toolCalling: true,
      maxInputTokens: 128000,
      maxOutputTokens: 16000,
    });
    return { ok: true, id: idOrName };
  }

  /** Clears the conversation history (keeps the system prompt, tools and skills). */
  reset(): void {
    this.agent.reset();
  }

  getContextUsage(): ContextUsage {
    const messages = this.agent.getMessages();
    const tokens = this.contextManager.estimateMessagesTokens(messages);
    const limit = this.agent.getModelConfig().maxInputTokens || 128000;
    return { tokens, limit, percent: Math.round((tokens / limit) * 1000) / 10, messages: messages.length };
  }

  /** Releases resources held by the session. Nothing needs closing yet; hosts should still call it. */
  dispose(): void {}
}

export function createSession(options: SessionOptions): AliaSession {
  return new AliaSession(options);
}
