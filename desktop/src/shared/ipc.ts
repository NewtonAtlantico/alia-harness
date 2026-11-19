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
  ToolAnnotation,
  UserAnswer,
  UserQuestion,
  WorkspaceEntry,
  DirectoryEntry,
  IntakeItem,
  IntakeProblem,
  PipelineStatus,
  PipelineState,
  GateId,
  GateProgress,
  GateQuestion,
  PipelineStage,
  Assumption,
  PipelineInput,
  SpecReview,
  SpecSummary,
  ArchitectureSummary,
  AdrAlignment,
  AdrRef,
  PipelineReport,
  CheckResult,
  Blocker,
  IssuePublishingStatus,
} from 'alia-harness/core';

export type { PermissionMode };
export type { ToolAnnotation, DirectoryEntry, IntakeItem, IntakeProblem, PipelineStatus, PipelineState, GateId, GateProgress, GateQuestion, PipelineStage, Assumption, PipelineInput, SpecReview, SpecSummary, ArchitectureSummary, AdrAlignment, AdrRef, PipelineReport, CheckResult, Blocker, IssuePublishingStatus };
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
  /** Project skills in the folder, and whether they were loaded (only for a trusted folder). */
  projectSkills: { found: number; loaded: boolean };
  /** Tool calls that had no result because the app stopped mid-run, closed when this conversation was resumed. Reported once. */
  interrupted: number;
  /** Context window use right after opening (feeds the context meter). */
  usage: ContextUsage;
}

/** What main knows about a folder before it is opened: whether the user trusts it, and whether it carries project skills. */
export interface ProjectInspection {
  /** `unknown`: never asked. Project skills load only for `trusted`. */
  trust: 'unknown' | 'trusted' | 'declined';
  /** Skills found in `<project>/.alia/skills`, by folder name. They are instructions the agent follows, hence the question. */
  projectSkills: string[];
}

/** A conversation that is open in the engine, for the sidebar's running and waiting marks. */
export interface ActiveSession {
  sessionId: string;
  workspace: string;
  running: boolean;
  /** How many approvals or questions are waiting for the user. */
  waiting: number;
}

/** The pipeline of a project in a few fields, for the sidebar chip. */
export interface PipelineBrief {
  exists: boolean;
  project?: string;
  summary: string;
  /** What the chip should show. */
  state: 'not_started' | 'damaged' | 'answer_questions' | 'review_specs' | 'pass_gate' | 'run_stage' | 'inputs_changed' | 'complete';
  gate?: 'G1' | 'G2' | 'G3';
  stage?: number;
  answered?: number;
  total?: number;
}

/** A file the pipeline starts with. A recording comes with the transcript that stands for it. */
export interface PipelineInputRef {
  path: string;
  transcriptPath?: string;
}

/** Whether the pipeline started. When not, nothing was written and `problems` say why, file by file. */
export type PipelineStartResult =
  | { started: true; resumed: boolean; inputs: Array<{ name: string; kind: string; handledBy?: string }> }
  | { started: false; problems: IntakeProblem[] };

/** A pipeline as the run view shows it: where it stands, its state (absent when there is none or it is damaged) and the files its stages produce. */
export interface PipelineView {
  status: PipelineStatus;
  state?: PipelineState;
  /** What each stage's artifact is, and whether it exists yet (a folder for stage 4). */
  artifacts: Array<{ stage: number; path: string; exists: boolean; isDir: boolean }>;
  markdownExists: boolean;
  /** The backlog by spec, the checks across specs, the totals and what still blocks. Absent when there is no readable state. */
  report?: PipelineReport;
}

/** Whether "Publicar issues" ran. In drafts mode it asks first: `status.warning` says why, how to fix it and where the drafts go. */
export type IssuesPublishResult = { started: true; mode: 'publish' | 'drafts'; via?: string; skill: string } | { started: false; reason: 'needs_confirmation'; status: IssuePublishingStatus };

export type PipelineResumeResult = { started: true } | { started: false; reason: 'no_pipeline' };

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

/** A read-only look at one file of the project (the Files tab). */
export interface FilePreview {
  path: string;
  size: number;
  /** `document`: a PDF, Word or PowerPoint file shown as the text the agent would read. */
  kind: 'text' | 'document' | 'binary' | 'too_large' | 'missing' | 'not_a_file';
  text?: string;
  /** More exists than is shown. */
  truncated?: boolean;
  /** Why there is nothing to show, or a warning from reading a document. */
  note?: string;
}

export interface ModelList {
  current: string;
  configured: AliaModelConfig[];
  remote: string[];
}

export interface ConversationContent {
  info: SessionInfo;
  messages: ChatMessage[];
  /** How long each tool call took and what it changed, by call id. */
  annotations: Record<string, ToolAnnotation>;
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
  /** One level of the project's folders and files (a tree, expanded as the user opens it). */
  'files.children': { request: { sessionId: string; dir?: string }; result: { entries: DirectoryEntry[] } };
  'files.preview': { request: { sessionId: string; path: string }; result: FilePreview };
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
  /** Trust state and project skills of a folder the user opened. */
  'projects.inspect': { request: { projectPath: string }; result: ProjectInspection };
  /** Records the user's answer to "trust this folder?". Project skills load only after `trusted: true`. */
  'projects.setTrust': { request: { projectPath: string; trusted: boolean }; result: ProjectInspection };
  /** Conversations currently open in the engine, with whether each is running or waiting for an answer. */
  'sessions.active': { request: Record<string, never>; result: ActiveSession[] };
  'pipeline.brief': { request: { projectPath: string }; result: PipelineBrief };
  /** Where a project's pipeline stands (stages, gates, what is next). Reads `docs/pipeline/state.json`; changes nothing. */
  'pipeline.status': { request: { projectPath: string }; result: PipelineStatus };
  /** What each file is, which skill would read it, and why it cannot be used (in the reader's own words). Files must be in the project or chosen by the user. */
  'pipeline.inspect': { request: { projectPath: string; paths: string[] }; result: { items: IntakeItem[] } };
  /** Writes the input inventory to state.json, then starts the pipeline in this conversation. Refuses (and writes nothing) if a file cannot be used. */
  'pipeline.start': { request: { sessionId: string; inputs: PipelineInputRef[] }; result: PipelineStartResult };
  /** The pipeline's state, status and artifacts for the run view. Reads only. */
  'pipeline.state': { request: { projectPath: string }; result: PipelineView };
  /** Records the user's answers (or deferrals) to a gate's open questions in state.json, as the person who gave them. Not while the conversation is running. */
  'pipeline.answer': { request: { sessionId: string; gate: GateId; answers: UserAnswer[]; by: string }; result: { progress: GateProgress; clean: boolean } };
  /** The user's approval of a gate (a human decision, never the model's): passes it if nothing is open. */
  'pipeline.approveGate': { request: { sessionId: string; gate: GateId }; result: { status: PipelineStatus } };
  /** The user's review of one spec (gate 3): approve it (`reviewed`) or put it back (`in_review`, `draft`). A comment is kept as a note. Not while the conversation runs. */
  'pipeline.reviewSpec': { request: { sessionId: string; spec: string; status: 'reviewed' | 'in_review' | 'draft'; comment?: string; by: string }; result: { status: PipelineStatus } };
  /** The user asks for changes to a spec: the comment goes to the agent, the specs stage (and what follows) is marked stale, and the run starts. */
  'pipeline.requestChanges': { request: { sessionId: string; spec: string; comment: string; by: string }; result: { started: true } };
  /** Publishes the backlog as issues. Detects at every attempt: with a tracker connection it runs the suggested skill; without one it answers `needs_confirmation` with the warning, and writes drafts only when called again with `confirmDrafts`. */
  'issues.publish': { request: { sessionId: string; confirmDrafts?: boolean }; result: IssuesPublishResult };
  /** Resumes the pipeline from where `state.json` says it stopped. */
  'pipeline.resume': { request: { sessionId: string }; result: PipelineResumeResult };
  /** Opens a file or folder of the project with the system. Documents are opened, a folder is shown, anything else is only shown in its folder. */
  'projects.openFile': { request: { projectPath: string; path: string }; result: { how: 'open' | 'reveal' } };
  /** What the app needs from this machine (Git Bash, Git, Python, the skills, the endpoint) and whether it is there. */
  'diagnostics.run': { request: Record<string, never>; result: DiagnosticsResult };
  /** Copies a report (the same checks, the app and the machine; no secrets) to the clipboard, to paste in a message to support. */
  'diagnostics.copy': { request: Record<string, never>; result: { copied: true; lines: number } };
  /** Lets the user choose files to attach (native dialog). Returns their paths, which the engine may then read. */
  'attachments.pick': { request: Record<string, never>; result: { paths: string[] } };
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
export type MainRequestName = 'attachments.pick' | 'diagnostics.run' | 'diagnostics.copy' | 'projects.openFile' | 'projects.pick' | 'projects.recent' | 'projects.inspect' | 'projects.setTrust' | 'settings.get' | 'settings.update' | 'settings.setApiKey' | 'settings.clearApiKey' | 'settings.testConnection' | 'settings.legacyCandidate' | 'settings.importLegacy' | 'window.minimize' | 'window.toggleMaximize' | 'window.close' | 'window.state' | 'app.info' | 'app.openExternal';

export interface DiagnosticsResult {
  items: Array<{ id: 'bash' | 'git' | 'python' | 'python-docx' | 'skills' | 'endpoint'; status: 'ok' | 'warn' | 'missing'; value?: string; optional: boolean }>;
  app: { name: string; version: string; electron: string; node: string; platform: string; arch: string };
}

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
  /** Tells the engine which files outside a project the user chose (dropped or picked), so `@` mentions of them may be read. */
  'attachments.allow': { request: { paths: string[] }; result: { ok: true } };
  /** The shell commands run in (for diagnostics). */
  'diagnostics.shell': { request: Record<string, never>; result: { shell: string; label: string; posix: boolean } };
  /** Lists the models at an endpoint, to test an address and key. Runs in the engine (it has the HTTP client). */
  'connection.test': { request: { url: string; apiKey: string }; result: ConnectionTestResult };
}

/**
 * What the engine receives for `session.open`: the page's request plus a flag only main can set. The page's schema is
 * strict, so it cannot send `trustedProject` itself.
 */
export interface EngineSessionOpen {
  request: RendererRequests['session.open']['request'] & { trustedProject?: boolean };
  result: OpenedSession;
}

export type EngineRequests = Omit<RendererRequests, MainRequestName | 'session.open'> & InternalRequests & { 'session.open': EngineSessionOpen };
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
  /** What the user said, when a run starts (whoever started it: the composer, another window, a test). */
  | { kind: 'user_message'; sessionId: string; text: string }
  | { kind: 'interaction'; interaction: Interaction }
  | { kind: 'interaction_closed'; id: string; sessionId: string }
  /** The engine process died and was started again: its sessions are gone, so reopen them with `resumeId`. */
  | { kind: 'engine_status'; status: 'restarted' | 'down' }
  /** Files the user dropped on the window. Only a genuine drop produces this (the preload checks it). */
  | { kind: 'files_dropped'; paths: string[] }
  | { kind: 'window_state'; maximized: boolean }
  | { kind: 'command'; command: AppCommand };

export type EngineMessage = EngineRequestMessage | EngineReplyMessage | { kind: 'ready' } | Extract<PushMessage, { kind: 'event' | 'user_message' | 'interaction' | 'interaction_closed' }>;

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
  dropped: 'alia:dropped',
  push: 'alia:push',
  ping: 'alia:ping',
} as const;
