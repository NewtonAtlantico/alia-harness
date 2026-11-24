import path from 'node:path';
import OpenAI from 'openai';
import { AliaConfig, AliaModelConfig, validateConfig } from './config.js';
import { createAliaClient, fetchAvailableModels } from './client.js';
import { ToolRegistry } from './tools/index.js';
import { createUseSkillTool } from './tools/useSkill.js';
import { createRunSubagentTool } from './tools/runSubagent.js';
import { AskUserHandler, createAskUserTool } from './tools/askUser.js';
import { createPipelineStateTool } from './tools/pipelineState.js';
import { PipelineStatus, getPipelineStatus } from './pipeline/pipelineStatus.js';
import { IntakeProblem, PipelineStartInput, describePipelineStart, planPipelineInputs, recordPipelineInputs } from './pipeline/intake.js';
import { findFlow, getFlow } from './pipeline/flows.js';
import { PipelineStateStore, type PipelineInput } from './pipeline/pipelineState.js';
import { CommandProbe, IssuePublishingStatus, detectIssuePublishing } from './issues/issuePublishing.js';
import type { McpToolSource } from './mcp/mcpManager.js';
import {
  PermissionMode,
  SafetyChecker,
  SafetyConfirmationHandler,
  normalizeAnswer,
} from './safety/safetyChecker.js';
import { PermissionStore } from './safety/permissionStore.js';
import { SessionRecorder, SessionStore, newSessionId } from './sessions/sessionStore.js';
import { repairInterruptedHistory } from './sessions/repairHistory.js';
import { sameWorkspace } from './projectKey.js';
import { CommandRegistry } from './commands/commandRegistry.js';
import { ChangeTracker } from './changes/changeTracker.js';
import { compactHistory } from './context/compactor.js';
import { ContextManager } from './context/contextManager.js';
import { AttachedFile, resolveFileMentionsAsync } from './context/fileMentions.js';
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
  /** Stream the model's answers (`assistant_delta` and `thinking_delta` events). Off by default; falls back to plain requests by itself when the endpoint cannot stream. Without it (and in subagents) requests still stream, silently, so a long generation is not cut off by the headers timeout. */
  streaming?: boolean;
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
  /**
   * Shows the user structured questions (the `ask_user` tool): cards in the desktop app, prompts in
   * the terminal. The tool exists only when this is given, so without it skills fall back to asking
   * in plain text. Subagents never get it.
   */
  onAskUser?: AskUserHandler;
  /** Where "always allow" is remembered. Default: a per-project file under `~/.alia/permissions`. */
  permissionStore?: PermissionStore;
  /** Folder for the default permission store (tests, or a host that keeps its data elsewhere). */
  permissionsDir?: string;
  /**
   * Saves the conversation (to `~/.alia/sessions` by default) so it can be listed, searched and
   * resumed. Opt-in: without it nothing is written. The files appear with the first message.
   */
  sessionStore?: SessionStore;
  /** Id for a new saved session (default: generated). Needs `sessionStore`. */
  sessionId?: string;
  /**
   * Continues a saved session: its history is loaded and the conversation carries on in the same
   * files. The system prompt is refreshed (skills may have changed); everything else is as it was.
   * The model it used is restored unless `modelId` is given. Needs `sessionStore`, and the session
   * must belong to this workspace.
   */
  resume?: string;
  /** Skill folders to scan, lowest precedence first. Default: bundled, user, project (`<workspace>/.alia/skills`), env. */
  skillRoots?: SkillRoot[];
  /** Show a subagent's full transcript instead of one line per tool call. */
  subagentVerbose?: boolean;
  /** Step cap of one run of the main agent (default: ALIA_MAX_STEPS, else 100). Subagents have their own budget. */
  maxSteps?: number;
  /** Use this client instead of building one from the config. Mainly a test seam (see scripts/lib/fakeModel.ts). */
  client?: OpenAI;
  /**
   * Tools of the MCP servers the person connected (Jira). Asked at every use, so a server connected after this
   * conversation opened is available at once. Subagents never get them.
   */
  mcp?: McpToolSource;
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

export type CompactResult =
  | { status: 'compacted'; summarized: number; tokensBefore: number; tokensAfter: number }
  /** The history is already short, or summarizing it would not save anything. */
  | { status: 'nothing_to_compact' }
  /** A run (or another compaction) is in progress. */
  | { status: 'busy' }
  | { status: 'failed'; error: string }
  | { status: 'cancelled' };

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
/** Step cap of one main-agent run when the host gives none. A chat turn needs a handful; a pipeline needs many. */
export const DEFAULT_MAX_STEPS = 100;

/** An explicit option wins, then the ALIA_MAX_STEPS environment variable, then {@link DEFAULT_MAX_STEPS}. */
export function resolveMaxSteps(option?: number): number {
  if (typeof option === 'number' && Number.isInteger(option) && option > 0) return option;
  const env = Number(process.env.ALIA_MAX_STEPS);
  return Number.isInteger(env) && env > 0 ? env : DEFAULT_MAX_STEPS;
}

export class AliaSession {
  readonly workspace: string;
  readonly config: AliaConfig;
  readonly tools: ToolRegistry;
  readonly skills: SkillRegistry;
  readonly agent: AliaAgent;
  readonly contextManager: ContextManager;
  /** The project's allowlist ("always allow"): list, remove and clear rules from a settings screen. */
  readonly permissions: PermissionStore;
  /** Id of the saved session; undefined when no `sessionStore` was given. */
  readonly id: string | undefined;
  /**
   * Files the agent has written (including through subagents) and not yet kept or undone: list them,
   * show a diff, `revert()` (Undo) or `keep()`. In memory only: it does not survive a restart.
   */
  readonly changes: ChangeTracker;
  /** The slash commands to offer: built-ins, the front-end's own (`register`), and one per available skill. */
  readonly commands: CommandRegistry;
  private recorder?: SessionRecorder;
  /** Tool calls that had no result when this conversation was resumed (the app stopped mid-run), closed as interrupted. */
  interruptedCalls = 0;
  private emit: EventSink;
  private activeRuns = 0;
  private compacting = false;
  readonly systemPrompt: string;
  private readonly client: OpenAI;

  constructor(options: SessionOptions) {
    this.workspace = path.resolve(options.workspace);
    this.config = validateConfig(options.config);

    // Resuming: load first, so the saved model and history are known before the agent exists.
    let resumed: ReturnType<SessionStore['load']>;
    if (options.resume) {
      if (!options.sessionStore) throw new Error('"resume" needs a "sessionStore".');
      resumed = options.sessionStore.load(options.resume);
      if (!resumed) throw new Error(`Session "${options.resume}" not found.`);
      if (!sameWorkspace(resumed.info.workspace, this.workspace)) {
        throw new Error(`Session "${options.resume}" belongs to ${resumed.info.workspace}, not ${this.workspace}.`);
      }
    }
    const savedModel = resumed && this.config.models.some((m) => m.id === resumed!.info.model) ? resumed.info.model : undefined;

    const selected = createAliaClient(this.config, options.modelId ?? savedModel);
    this.client = options.client ?? selected.client;

    this.tools = new ToolRegistry();
    if (options.mcp) {
      const mcp = options.mcp;
      this.tools.setDynamicSource(() => mcp.toolDefinitions());
    }

    // Skills: scan folders, expose use_skill, and advertise a catalog in the system prompt.
    this.skills = new SkillRegistry({
      roots: options.skillRoots,
      cwd: this.workspace,
      getToolNames: () => this.tools.getAll().map((t) => t.name),
    });
    this.skills.load();
    this.tools.register(createUseSkillTool(this.skills));
    this.tools.register(createPipelineStateTool());
    if (options.onAskUser) {
      const handler = options.onAskUser;
      this.tools.register(createAskUserTool({ getHandler: () => handler }));
    }
    const catalog = buildSkillCatalog(this.skills);
    this.systemPrompt = catalog ? `${DEFAULT_SYSTEM_PROMPT}\n\n${catalog}` : DEFAULT_SYSTEM_PROMPT;

    const ui = options.ui;
    // What a reopened conversation needs to look as it did: how long each call took, and what it changed.
    const annotate: EventSink = (event) => {
      if (event.type !== 'tool_call_finished' || event.subagentId) return;
      const changes = event.changes?.map((c) => ({ path: c.path, kind: c.kind, added: c.added, removed: c.removed }));
      this.recorder?.annotate(event.id, { durationMs: event.durationMs, ...(changes && changes.length > 0 ? { changes } : {}) });
    };
    const emit = combineSinks(ui ? eventsToAgentUI(ui) : undefined, options.onEvent, annotate);
    this.emit = emit;
    this.changes = new ChangeTracker(this.workspace);
    this.commands = new CommandRegistry(() => this.skills);
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
      maxSteps: resolveMaxSteps(options.maxSteps),
      onEvent: emit,
      onHistory: (messages) => this.recorder?.sync(messages),
      changeTracker: this.changes,
      stream: options.streaming === true,
    });

    if (options.sessionStore) {
      this.id = options.resume ?? options.sessionId ?? newSessionId();
      this.recorder = options.sessionStore.recorder(this.id, {
        workspace: this.workspace,
        getModel: () => this.agent.getModel(),
        initial: resumed?.messages,
        annotations: resumed?.annotations,
      });
      if (resumed) {
        // Same conversation, current system prompt.
        // A run cut short (the app or engine died) can leave tool calls without results; the endpoint would reject those.
        const { messages: whole, repaired } = repairInterruptedHistory(resumed.messages);
        this.interruptedCalls = repaired;
        const rest = whole[0]?.role === 'system' ? whole.slice(1) : whole;
        this.agent.setMessages([{ role: 'system', content: this.systemPrompt }, ...rest]);
      }
    } else {
      this.id = undefined;
    }

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
  async run(prompt: string, options: RunOptions = {}): Promise<AgentResult> {
    if (this.compacting) {
      return { status: 'failed', text: 'The conversation is being compacted; try again in a moment.', steps: 0 };
    }
    this.activeRuns++;
    try {
      return await this.agent.runDetailed(prompt, options);
    } finally {
      this.activeRuns--;
    }
  }

  /**
   * Replaces the older part of the conversation with a model-written summary (`/compact`).
   * Keeps the system prompt, pinned skills and the most recent messages. Leaves the history
   * untouched unless it succeeds.
   */
  async compact(options: { keepRecent?: number; signal?: AbortSignal } = {}): Promise<CompactResult> {
    if (this.activeRuns > 0 || this.compacting) return { status: 'busy' };
    this.compacting = true;
    try {
      const outcome = await compactHistory(this.agent.getMessages(), {
        client: this.client,
        model: this.agent.getModel(),
        contextManager: this.contextManager,
        maxInputTokens: this.contextManager.getMaxInputTokens(),
        keepRecent: options.keepRecent,
        signal: options.signal,
      });
      switch (outcome.status) {
        case 'compacted':
          this.agent.setMessages(outcome.messages);
          this.emit({
            type: 'context_compacted',
            summarized: outcome.summarized,
            tokensBefore: outcome.tokensBefore,
            tokensAfter: outcome.tokensAfter,
          });
          return { status: 'compacted', summarized: outcome.summarized, tokensBefore: outcome.tokensBefore, tokensAfter: outcome.tokensAfter };
        case 'nothing_to_compact':
          this.emit({ type: 'notice', level: 'info', message: 'Nothing to compact yet.' });
          return outcome;
        case 'failed':
          this.emit({ type: 'notice', level: 'error', message: outcome.error });
          return outcome;
        case 'cancelled':
          this.emit({ type: 'notice', level: 'info', message: 'Compaction cancelled.' });
          return outcome;
      }
    } finally {
      this.compacting = false;
    }
  }

  /**
   * Whether "Publicar issues" can publish (an issue tool is registered, or `gh`/`glab` is signed in for this
   * repository's remote) or will fall back to drafts in `docs/issues/`. When it will fall back, `warning` is the
   * text to show the user before they confirm; ask again at every publish attempt.
   */
  issuePublishing(options: { probe?: CommandProbe } = {}): Promise<IssuePublishingStatus> {
    return detectIssuePublishing({ workspace: this.workspace, toolNames: this.tools.getAll().map((t) => t.name) }, options);
  }

  /** Where this project's requirements-to-tasks pipeline stands, read from `docs/pipeline/state.json`. Changes nothing. */
  pipelineStatus(): PipelineStatus {
    return getPipelineStatus(this.workspace);
  }

  /**
   * The prompt that resumes the pipeline ("Retomar sessão"): the pipeline skill, already loaded, plus
   * where it stopped and exactly what to do next. Pass `prompt` to `run()`. No `prompt` when there is
   * no pipeline state to resume.
   */
  async resumePipelinePrompt(): Promise<{ status: PipelineStatus; prompt?: string }> {
    const status = this.pipelineStatus();
    if (!status.exists) return { status };
    const resolved = await this.resolveSkill(`/${this.pipelineFlow().orchestrator}`, status.resumePrompt);
    // If the skill is not available the model can still load it with use_skill, as the text says.
    return { status, prompt: resolved.status === 'ready' ? resolved.prompt : status.resumePrompt };
  }

  /** The flow this project's pipeline runs (the default flow when there is no pipeline yet, or its state cannot be read). */
  private pipelineFlow() {
    try {
      return getFlow(new PipelineStateStore(this.workspace).load()?.flow);
    } catch {
      return getFlow();
    }
  }

  /**
   * Starts the pipeline from the files the user gave ("Iniciar pipeline"). Every file must be readable (a recording needs its
   * transcript); if any is not, nothing is written and `refused` says why, file by file. Otherwise the inventory (names, kinds,
   * the skill that reads each, and the hash of each file) is written to `docs/pipeline/state.json` **first**, and the prompt to
   * pass to `run()` is returned. Starting on a project that already has a pipeline adds the inputs to it, in the flow it already runs;
   * a new pipeline runs `options.flow` (the default flow when none is given) and is called `options.project`.
   */
  async startPipelinePrompt(inputs: PipelineStartInput[], options: { flow?: string; project?: string } = {}): Promise<
    | { status: 'ready'; prompt: string; inputs: PipelineInput[]; resumed: boolean }
    | { status: 'refused'; problems: IntakeProblem[] }
  > {
    const before = this.pipelineStatus();
    if (before.exists && before.next.kind === 'damaged') {
      return { status: 'refused', problems: [{ path: '', name: 'state.json', message: before.next.message }] };
    }
    const requested = findFlow(options.flow);
    if (!requested) return { status: 'refused', problems: [{ path: '', name: 'flow', message: `There is no flow "${options.flow}".` }] };
    const flow = before.exists ? this.pipelineFlow() : requested;
    const plan = await planPipelineInputs(inputs, flow);
    if (plan.problems.length > 0) return { status: 'refused', problems: plan.problems };
    const recorded = recordPipelineInputs(this.workspace, plan, { flow: flow.id, ...(options.project ? { project: options.project } : {}) });
    if (!recorded.ok) return { status: 'refused', problems: [{ path: '', name: 'state.json', message: recorded.error }] };
    const text = describePipelineStart(this.workspace, recorded.inputs, before.exists, flow);
    const resolved = await this.resolveSkill(`/${flow.orchestrator}`, text);
    // If the skill is not available the model can still load it with use_skill, as in a resume.
    return { status: 'ready', prompt: resolved.status === 'ready' ? resolved.prompt : text, inputs: recorded.inputs, resumed: before.exists };
  }

  /** Expands `@path` mentions in user text into attached file contents. */
  prepareInput(text: string): Promise<PreparedInput> {
    return resolveFileMentionsAsync(text, this.workspace);
  }

  /**
   * Turns `/skill-name <input>` into the prompt for `run()`. `not_a_skill` means the host
   * should treat the command as its own (or unknown).
   */
  async resolveSkill(command: string, input: string): Promise<SkillResolution> {
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
    const { prompt, attachments, errors } = await this.prepareInput(input);
    return {
      status: 'ready',
      skill,
      prompt: buildSkillInvocationPrompt(skill, this.skills, prompt, this.tools.getAll().map((t) => t.name)),
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
      this.contextManager.setMaxInputTokens(configured.maxInputTokens || 128000);
      this.recorder?.setModel(configured.id);
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
    this.contextManager.setMaxInputTokens(128000);
    this.recorder?.setModel(idOrName);
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
