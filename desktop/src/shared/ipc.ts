/**
 * The contract between the three sides of the app. It holds types only, so the renderer can import it
 * (with `import type`). The runtime checks that go with it live in `schemas.ts`.
 *
 *   renderer --(contextBridge: window.alia)--> main --(utilityProcess message port)--> engine
 *
 * Main validates every request before forwarding it; the renderer is not trusted.
 */
import type {
  AgentEvent,
  AliaConfig,
  AliaModelConfig,
  ChatMessage,
  CommandInfo,
  CompactResult,
  ContextUsage,
  PermissionDecision,
  PermissionMode,
  PermissionRule,
  RevertResult,
  SearchHit,
  SessionInfo,
  SwitchModelResult,
  UserAnswer,
  UserQuestion,
  WorkspaceEntry,
} from 'alia-harness/core';

export type { PermissionMode };
export type { AgentEvent, AliaModelConfig, ChatMessage, CommandInfo, CompactResult, ContextUsage, PermissionDecision, PermissionRule, RevertResult, SearchHit, SessionInfo, SwitchModelResult, UserAnswer, UserQuestion, WorkspaceEntry };

// ------------------------------------------------------------------------------------ results

export interface PingResult {
  pong: true;
  /** The engine's own process id: proves it is not the main process. */
  pid: number;
  node: string;
  /** How many pipeline stages `core` knows about (proves `core` was imported). */
  coreStages: number;
}

export interface SelfTestResult {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
}

export interface OpenedSession {
  /** Id of the saved conversation. Use it in every later request. */
  sessionId: string;
  workspace: string;
  model: string;
  /** True when an earlier conversation was loaded (`resumeId`). */
  resumed: boolean;
  /** Messages in the history now. */
  messages: number;
  /** Context window use right after opening (feeds the context meter). */
  usage: ContextUsage;
}

export interface RunStarted {
  started: true;
  /** `skill` when the text was a `/skill-name input` command. */
  kind: 'prompt' | 'skill';
  /** Files attached from `@` mentions, by display path. */
  attached: string[];
  /** Mentions that could not be attached (also reported as error notices). */
  errors: string[];
}

/** A pending change, without file content (fetch the diff on demand). */
export interface ChangeInfo {
  path: string;
  kind: 'created' | 'modified' | 'untracked';
  added: number;
  removed: number;
  /** Why no diff exists, for `untracked` files. */
  untracked?: string;
}

export interface DiffResult {
  /** Unified diff; null for an untracked file or one that is no longer pending. */
  diff: string | null;
  /** True when the diff was cut to keep the message small. */
  truncated: boolean;
}

export interface ModelList {
  current: string;
  configured: AliaModelConfig[];
  remote: string[];
}

export interface ConversationContent {
  info: SessionInfo;
  messages: ChatMessage[];
  skipped: number;
}

// ------------------------------------------------------------------------------------ interactions

/**
 * Something the run is waiting for the user to answer. Two kinds exist, and both are answered with
 * `interaction.respond`. A cancelled run closes its interactions (`interaction_closed`).
 */
export type Interaction =
  | {
      id: string;
      sessionId: string;
      kind: 'permission';
      command: string;
      reasons: string[];
      dangerous: boolean;
      canAlwaysAllow: boolean;
      requester?: string;
      toolCallId?: string;
    }
  | {
      id: string;
      sessionId: string;
      kind: 'ask_user';
      questions: UserQuestion[];
      toolCallId?: string;
    };

export type InteractionResponse = { decision: PermissionDecision } | { answers: UserAnswer[] };

// ------------------------------------------------------------------------------------ settings

/** A model the endpoint serves. `maxInputTokens` is the context size the app plans around. */
export interface ModelSetting {
  id: string;
  name: string;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  toolCalling?: boolean;
  vision?: boolean;
}

/**
 * What the settings screen sees. The API key is never in it: only whether one is stored. The key goes from the
 * form to main and from main to the engine, and nowhere else.
 */
export interface SettingsView {
  displayName: string;
  organization: string;
  endpointUrl: string;
  models: ModelSetting[];
  /** How commands are approved by default in new conversations. */
  permissionMode: PermissionMode;
  hasApiKey: boolean;
  /** False when the OS cannot encrypt secrets: the key cannot be stored (it is never written in plain text). */
  secureStorage: boolean;
  /** An endpoint, a model and a key are all set, so conversations can start. */
  configured: boolean;
}

/** What may be changed with `settings.update`; only the fields present change. */
export interface SettingsUpdate {
  displayName?: string;
  organization?: string;
  endpointUrl?: string;
  models?: ModelSetting[];
  permissionMode?: PermissionMode;
}

export interface ConnectionTestResult {
  ok: boolean;
  /** Model ids the endpoint reports (empty when it does not list any). */
  models: string[];
  reason?: 'unauthorized' | 'not_found' | 'unreachable' | 'timeout' | 'other';
  /** Detail for the log or a tooltip; never contains the key. */
  message?: string;
}

/** A configuration from an earlier setup (the CLI's alia-config.json) that can be imported. */
export interface LegacyCandidate {
  path: string;
  endpointUrl: string;
  models: number;
  /** A key was found beside it (environment or .env). The key itself is never shown. */
  hasApiKey: boolean;
}

export interface ImportSummary {
  endpointUrl: string;
  models: number;
  importedKey: boolean;
}

// ------------------------------------------------------------------------------------ requests

/** What the renderer may ask for, with the shape of each request and reply. */
export interface RendererRequests {
  'session.open': { request: { projectPath: string; resumeId?: string }; result: OpenedSession };
  'session.close': { request: { sessionId: string }; result: { closed: boolean } };
  /** Starts a turn and replies at once; progress and the end (`run_finished`) arrive as events. */
  'session.run': { request: { sessionId: string; text: string }; result: RunStarted };
  'session.cancel': { request: { sessionId: string }; result: { cancelled: boolean } };
  'session.compact': { request: { sessionId: string }; result: CompactResult };
  'session.reset': { request: { sessionId: string }; result: { ok: true } };
  'session.usage': { request: { sessionId: string }; result: ContextUsage };
  'model.list': { request: { sessionId: string }; result: ModelList };
  'model.switch': { request: { sessionId: string; model: string }; result: SwitchModelResult };
  'commands.list': { request: { sessionId: string }; result: CommandInfo[] };
  'files.search': { request: { sessionId: string; query: string; limit?: number }; result: { matches: WorkspaceEntry[]; total: number } };
  'changes.list': { request: { sessionId: string }; result: ChangeInfo[] };
  'changes.diff': { request: { sessionId: string; path: string }; result: DiffResult };
  'changes.revert': { request: { sessionId: string; paths?: string[] }; result: RevertResult };
  'changes.keep': { request: { sessionId: string; paths?: string[] }; result: { kept: number } };
  'permissions.list': { request: { sessionId: string }; result: PermissionRule[] };
  'permissions.remove': { request: { sessionId: string; command: string; match?: 'exact' | 'prefix' }; result: { removed: boolean } };
  /** The same, for a project that has no open conversation (the settings screen). */
  'permissions.listForProject': { request: { projectPath: string }; result: PermissionRule[] };
  'permissions.removeForProject': { request: { projectPath: string; command: string; match?: 'exact' | 'prefix' }; result: { removed: boolean } };
  'conversations.list': { request: { projectPath?: string; limit?: number }; result: SessionInfo[] };
  'conversations.search': { request: { text: string; projectPath?: string; limit?: number }; result: SearchHit[] };
  'conversations.rename': { request: { id: string; title: string }; result: SessionInfo };
  'conversations.delete': { request: { id: string }; result: { deleted: boolean } };
  'conversations.load': { request: { id: string }; result: ConversationContent | null };
  'interaction.respond': { request: { id: string; response: InteractionResponse }; result: { ok: true } };
  'interaction.pending': { request: Record<string, never>; result: Interaction[] };
  /** Asks the user for a project folder with the native dialog; only folders chosen this way can be opened. */
  'projects.pick': { request: Record<string, never>; result: { path: string } | null };
  /** Projects the user opened before, newest first. Only these (and ones picked now) can be opened. */
  'projects.recent': { request: Record<string, never>; result: string[] };
  'settings.get': { request: Record<string, never>; result: SettingsView };
  'settings.update': { request: SettingsUpdate; result: SettingsView };
  /** Stores the API key, encrypted with the OS. Write-only: nothing ever returns it. */
  'settings.setApiKey': { request: { apiKey: string }; result: SettingsView };
  'settings.clearApiKey': { request: Record<string, never>; result: SettingsView };
  /** Lists the endpoint's models with the given address and key (or the saved ones). */
  'settings.testConnection': { request: { endpointUrl?: string; apiKey?: string }; result: ConnectionTestResult };
  'settings.legacyCandidate': { request: Record<string, never>; result: LegacyCandidate | null };
  /** Asks the user for an alia-config.json (native dialog) and imports it, with the key from the environment or its .env. */
  'settings.importLegacy': { request: Record<string, never>; result: ImportSummary | null };
  'window.minimize': { request: Record<string, never>; result: { ok: true } };
  'window.toggleMaximize': { request: Record<string, never>; result: { maximized: boolean } };
  'window.close': { request: Record<string, never>; result: { ok: true } };
  'window.state': { request: Record<string, never>; result: { maximized: boolean } };
  'app.info': { request: Record<string, never>; result: AppInfo };
  /** Opens an https link in the system browser, after the user confirms it in a native dialog. */
  'app.openExternal': { request: { url: string }; result: { opened: boolean } };
}

/** Requests answered by main itself; they never reach the engine. */
export type MainRequestName = 'projects.pick' | 'projects.recent' | 'settings.get' | 'settings.update' | 'settings.setApiKey' | 'settings.clearApiKey' | 'settings.testConnection' | 'settings.legacyCandidate' | 'settings.importLegacy' | 'window.minimize' | 'window.toggleMaximize' | 'window.close' | 'window.state' | 'app.info' | 'app.openExternal';

export interface AppInfo {
  name: string;
  version: string;
  platform: string;
}

/** A command from the app menu or a shortcut (Ctrl N and so on). The page decides what it means on the current screen. */
export type AppCommand = 'new_conversation' | 'open_project' | 'open_settings' | 'toggle_panel';

/** What only main may ask of the engine (never reachable from the renderer). */
export interface InternalRequests {
  ping: { request: Record<string, never>; result: PingResult };
  /** Exercises what packaging tends to break. */
  selfTest: { request: { dir: string }; result: SelfTestResult };
  /**
   * Hands the engine its configuration, API key included, and where skills are. Sent again after every
   * restart. Project skills (`<project>/.alia/skills`) are deliberately not in the roots: they load only
   * once the user trusts the folder (A5).
   */
  'engine.configure': {
    request: { config: AliaConfig; skillRoots: Array<{ label: string; dir: string }>; permissionMode?: PermissionMode; dataDirs?: { sessions?: string; permissions?: string } };
    result: { ok: true; models: number };
  };
  /** Lists the models at an endpoint, to test an address and key. Runs in the engine (it has the HTTP client). */
  'connection.test': { request: { url: string; apiKey: string }; result: ConnectionTestResult };
}

export type EngineRequests = Omit<RendererRequests, MainRequestName> & InternalRequests;
export type RendererRequestName = keyof RendererRequests;
export type EngineRequestName = keyof EngineRequests;

// ------------------------------------------------------------------------------------ messages

export interface EngineRequestMessage {
  kind: 'request';
  id: number;
  name: EngineRequestName;
  payload: unknown;
}

export type EngineReplyMessage =
  | { kind: 'reply'; id: number; ok: true; result: unknown }
  | { kind: 'reply'; id: number; ok: false; error: string };

/** Pushed to the renderer (through main) whenever something happens in a session. */
export type PushMessage =
  | { kind: 'event'; sessionId: string; event: AgentEvent }
  | { kind: 'interaction'; interaction: Interaction }
  | { kind: 'interaction_closed'; id: string; sessionId: string }
  /** The engine process died and was started again: its sessions are gone, so reopen them with `resumeId`. */
  | { kind: 'engine_status'; status: 'restarted' | 'down' }
  | { kind: 'window_state'; maximized: boolean }
  | { kind: 'command'; command: AppCommand };

export type EngineMessage = EngineRequestMessage | EngineReplyMessage | { kind: 'ready' } | Extract<PushMessage, { kind: 'event' | 'interaction' | 'interaction_closed' }>;

// ------------------------------------------------------------------------------------ renderer API

/** What the renderer sees as `window.alia`. */
export interface AliaApi {
  request<K extends RendererRequestName>(name: K, payload: RendererRequests[K]['request']): Promise<RendererRequests[K]['result']>;
  /** Subscribes to pushed messages. Returns the unsubscribe function. */
  onMessage(listener: (message: PushMessage) => void): () => void;
  /** Smoke-test helper kept from the scaffold: a round trip to the engine. */
  ping(): Promise<PingResult>;
}

/** IPC channel names used between renderer and main. */
export const CHANNELS = {
  request: 'alia:request',
  push: 'alia:push',
  ping: 'alia:ping',
} as const;
