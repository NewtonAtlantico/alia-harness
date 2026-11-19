/**
 * The engine's brain, free of Electron so it can be tested with a fake model: it owns the sessions, turns
 * `core` events into messages for the UI, and turns "needs approval" and "asks a question" into interactions
 * the UI answers later. `index.ts` only connects it to the utility process's message port.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import OpenAI from 'openai';
import {
  type AgentEvent,
  type AliaConfig,
  type AliaSession,
  type PermissionMode,
  FileIndex,
  PermissionStore,
  STAGES,
  SessionStore,
  createSession,
  newSessionId,
  getPipelineStatus,
  describeShell,
  buildReport,
  type CommandProbe,
  gateProgress,
  PipelineStateStore,
  inspectInput,
  extractMentionPaths,
  listDirectory,
  readDocument,
} from 'alia-harness/core';
import { previewFile } from './preview';
import type {
  ActiveSession,
  ChangeInfo,
  ConnectionTestResult,
  ConversationContent,
  DiffResult,
  EngineMessage,
  EngineRequestName,
  EngineRequests,
  Interaction,
  InteractionResponse,
  ModelList,
  OpenedSession,
  PipelineBrief,
  PipelineResumeResult,
  PipelineView,
  IssuesPublishResult,
  PipelineStartResult,
  PingResult,
  RunStarted,
  SelfTestResult,
} from '../shared/ipc';

type Outbound = Exclude<EngineMessage, { kind: 'request' | 'reply' | 'ready' }>;

export interface RuntimeOptions {
  /** Sends a message to main (and from there to the renderer). */
  post: (message: Outbound) => void;
  /** Test seam: a client to use instead of the one built from the config (a fake model). */
  clientFor?: (config: AliaConfig) => OpenAI | undefined;
  /** Test seam: how the tracker connection is probed (the real one runs git, gh and glab). */
  issueProbe?: CommandProbe;
  /** Max characters of one text field sent in an event (tool output and the like). */
  eventTextCap?: number;
}

const DEFAULT_TEXT_CAP = 32_000;
const DIFF_CAP = 400_000;
const SLASH_COMMAND = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/;

interface Entry {
  id: string;
  session: AliaSession;
  workspace: string;
  files: FileIndex;
  controller?: AbortController;
  busy: boolean;
  projectSkills: { found: number; loaded: boolean };
  /** Calls closed as interrupted when this conversation was resumed; told to the page once, then zero. */
  interruptedPending: number;
  /** A title to give the conversation once its first run has started (a pipeline is not called by its prompt). */
  titleOnStart?: string;
}

interface PendingInteraction {
  interaction: Interaction;
  settle: (response: InteractionResponse | 'closed') => void;
}

export class EngineRuntime {
  private config?: AliaConfig;
  private skillRoots: Array<{ label: string; dir: string }> = [];
  private store = new SessionStore();
  private permissionsDir?: string;
  private permissionMode: PermissionMode = 'ask-commands';
  /** Files outside any project that the user chose (dropped or picked): the only outside paths a mention may read. */
  private allowedOutside: string[] = [];
  private readonly sessions = new Map<string, Entry>();
  private readonly pending = new Map<string, PendingInteraction>();
  private readonly cap: number;

  constructor(private readonly options: RuntimeOptions) {
    this.cap = options.eventTextCap ?? DEFAULT_TEXT_CAP;
  }

  /** Answers one request. Throws with a readable message when it cannot. */
  async handle<K extends EngineRequestName>(name: K, payload: EngineRequests[K]['request']): Promise<EngineRequests[K]['result']> {
    const fn = (this.handlers as Record<string, ((p: unknown) => unknown) | undefined>)[name];
    if (!fn) throw new Error(`unknown request "${String(name)}"`);
    return (await fn.call(this, payload)) as EngineRequests[K]['result'];
  }

  /** Stops everything: used when the engine shuts down. */
  shutdown(): void {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }

  // ---------------------------------------------------------------------------------- plumbing

  private entry(sessionId: string): Entry {
    const e = this.sessions.get(sessionId);
    if (!e) throw new Error(`Session "${sessionId}" is not open (the engine may have restarted: open it again with resumeId).`);
    return e;
  }

  private text(s: string): string {
    return s.length > this.cap ? `${s.slice(0, this.cap)}\n… [${s.length - this.cap} more characters not sent]` : s;
  }

  /** Keeps messages small: a long tool output is cut here (the model still saw all of it). */
  /**
   * Sends an event to the page. Pieces of an answer (deltas) arrive many times a second; they are merged for a few milliseconds
   * so the page redraws a handful of times a second, not hundreds. Any other event first sends what is waiting, so the order
   * the page sees is the order things happened.
   */
  private readonly pendingDeltas = new Map<string, { event: Extract<AgentEvent, { type: 'assistant_delta' | 'thinking_delta' }>; timer: ReturnType<typeof setTimeout> }>();
  private flushDeltas(sessionId: string): void {
    const pending = this.pendingDeltas.get(sessionId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingDeltas.delete(sessionId);
    this.options.post({ kind: 'event', sessionId, event: pending.event });
  }
  private deliver(sessionId: string, event: AgentEvent): void {
    if ((event.type === 'assistant_delta' || event.type === 'thinking_delta') && !event.subagentId) {
      const pending = this.pendingDeltas.get(sessionId);
      if (pending && pending.event.type === event.type && pending.event.step === event.step) {
        pending.event = { ...pending.event, text: pending.event.text + event.text };
        return;
      }
      this.flushDeltas(sessionId);
      this.pendingDeltas.set(sessionId, { event, timer: setTimeout(() => this.flushDeltas(sessionId), 40) });
      return;
    }
    this.flushDeltas(sessionId);
    this.options.post({ kind: 'event', sessionId, event: this.capEvent(event) });
  }

  private capEvent(e: AgentEvent): AgentEvent {
    switch (e.type) {
      case 'tool_call_started':
        return { ...e, args: this.text(e.args) };
      case 'tool_call_finished':
        return { ...e, result: this.text(e.result) };
      case 'assistant_message':
      case 'thinking':
        return { ...e, text: this.text(e.text) };
      case 'run_finished':
        return { ...e, result: { ...e.result, text: this.text(e.result.text) } };
      default:
        return e;
    }
  }

  private notice(sessionId: string, level: 'info' | 'success' | 'error', message: string): void {
    this.options.post({ kind: 'event', sessionId, event: { type: 'notice', level, message } });
  }

  /** Waits for the UI to answer. Closing it (cancel, session closed) settles it as 'closed'. */
  private ask(interaction: Interaction, signal?: AbortSignal): Promise<InteractionResponse | 'closed'> {
    return new Promise((resolve) => {
      let done = false;
      const settle = (r: InteractionResponse | 'closed') => {
        if (done) return;
        done = true;
        this.pending.delete(interaction.id);
        if (r === 'closed') this.options.post({ kind: 'interaction_closed', id: interaction.id, sessionId: interaction.sessionId });
        resolve(r);
      };
      this.pending.set(interaction.id, { interaction, settle });
      signal?.addEventListener('abort', () => settle('closed'), { once: true });
      if (signal?.aborted) return settle('closed');
      this.options.post({ kind: 'interaction', interaction });
    });
  }

  /** Starts a run in the background: shows `text` as what the user said and gives the model `prompt`. */
  private launch(e: Entry, text: string, prompt: string, title?: string): void {
    const sessionId = e.id;
    // Only the first run names a conversation: later ones (Retomar) keep the name it has.
    if (title && !this.store.exists(e.id)) e.titleOnStart = title;
    this.options.post({ kind: 'user_message', sessionId, text });
    const controller = new AbortController();
    e.busy = true;
    e.controller = controller;
    void e.session
      .run(prompt, { signal: controller.signal })
      .catch((err: unknown) => this.notice(sessionId, 'error', `The run failed: ${(err as Error)?.message ?? err}`))
      .finally(() => {
        // A newer run may already have started (the event above freed the conversation); leave it alone.
        if (e.controller === controller) {
          e.busy = false;
          e.controller = undefined;
        }
        if (!e.busy) this.closeInteractions(sessionId);
      });
  }

  /** A spec the state knows of (a typo in a slug must not create a review of nothing). */
  private requireSpec(store: PipelineStateStore, spec: string): void {
    const state = store.load();
    if (!state?.specs.some((x) => x.slug === spec) && !state?.specReviews.some((x) => x.spec === spec)) throw new Error(`There is no spec "${spec}" in this pipeline.`);
  }

  /** The user chose these files in the page (or dropped them); only those, or files in the project, may be inventoried. */
  private checkInputPaths(workspace: string, paths: string[]): void {
    for (const p of paths) {
      const abs = path.resolve(p);
      if (isInside(workspace, abs)) continue;
      if (this.allowedOutside.some((allowed) => sameFile(allowed, abs) || isInside(allowed, abs))) continue;
      throw new Error(`"${abs}" is outside the project folder. Choose it with the file dialog or drag it into the window.`);
    }
  }

  private closeInteractions(sessionId: string): void {
    for (const p of [...this.pending.values()]) if (p.interaction.sessionId === sessionId) p.settle('closed');
  }

  private close(sessionId: string): boolean {
    const e = this.sessions.get(sessionId);
    if (!e) return false;
    e.controller?.abort();
    this.closeInteractions(sessionId);
    e.session.dispose();
    this.sessions.delete(sessionId);
    return true;
  }

  private describe(e: Entry, resumed: boolean): OpenedSession {
    const usage = e.session.getContextUsage();
    const interrupted = e.interruptedPending;
    e.interruptedPending = 0;
    return { sessionId: e.id, workspace: e.workspace, model: e.session.getModel(), resumed, messages: usage.messages, usage, projectSkills: e.projectSkills, interrupted };
  }

  // ---------------------------------------------------------------------------------- requests

  private readonly handlers: { [K in EngineRequestName]: (p: EngineRequests[K]['request']) => Promise<EngineRequests[K]['result']> | EngineRequests[K]['result'] } = {
    ping: (): PingResult => ({ pong: true, pid: process.pid, node: process.versions.node, coreStages: STAGES.length }),

    selfTest: ({ dir }) => this.selfTest(dir),

    'diagnostics.shell': () => describeShell(),

    'attachments.allow': ({ paths }) => {
      for (const p of paths) {
        const abs = path.resolve(p);
        if (!this.allowedOutside.some((x) => sameFile(x, abs))) this.allowedOutside.push(abs);
      }
      return { ok: true };
    },

    'engine.configure': ({ config, skillRoots, dataDirs, permissionMode }) => {
      this.config = config;
      this.permissionMode = permissionMode ?? 'ask-commands';
      this.skillRoots = skillRoots;
      this.store = new SessionStore({ dir: dataDirs?.sessions });
      this.permissionsDir = dataDirs?.permissions;
      return { ok: true, models: config.models.length };
    },

    'session.open': ({ projectPath, resumeId, trustedProject }) => {
      const config = this.config;
      if (!config) throw new Error('The engine is not configured yet (no endpoint or API key).');
      const workspace = path.resolve(projectPath);
      if (!fs.statSync(workspace, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Folder not found: ${workspace}`);

      const existing = resumeId ? this.sessions.get(resumeId) : undefined;
      if (existing) return this.describe(existing, true);

      const id = resumeId ?? newSessionId();
      const post = this.options.post;
      const session = createSession({
        workspace,
        config,
        streaming: true, // the answer appears as it is written; core falls back to whole answers by itself when the endpoint cannot stream
        client: this.options.clientFor?.(config),
        // Project skills are instructions the agent follows: they load only for a folder the user trusts (main decides).
        skillRoots: trustedProject ? [...this.skillRoots, { label: 'project', dir: path.join(workspace, '.alia', 'skills') }] : this.skillRoots,
        sessionStore: this.store,
        permissionsDir: this.permissionsDir,
        ...(resumeId ? { resume: resumeId } : { sessionId: id }),
        permissionMode: this.permissionMode,
        onEvent: (event) => {
          // The run is over the moment run_finished is emitted; waiting for the promise to settle would make
          // a message sent right after the UI shows the end look like "still running".
          {
            // The conversation's file exists once its first message is saved: until then the rename has nothing to change.
            const e = this.sessions.get(id);
            if (e?.titleOnStart) {
              try {
                this.store.rename(id, e.titleOnStart);
                e.titleOnStart = undefined;
              } catch {
                /* not saved yet: try again at the next event */
              }
            }
          }
          if (event.type === 'run_finished' && !event.subagentId) {
            const e = this.sessions.get(id);
            if (e) {
              e.busy = false;
              e.controller = undefined;
            }
          }
          this.deliver(id, event);
        },
        onConfirm: async (ctx) => {
          const answer = await this.ask(
            { id: randomUUID(), sessionId: id, kind: 'permission', command: ctx.command, reasons: ctx.reasons, dangerous: ctx.dangerous, canAlwaysAllow: ctx.canAlwaysAllow, requester: ctx.requester, toolCallId: ctx.toolCallId },
            ctx.signal
          );
          return answer !== 'closed' && 'decision' in answer ? answer.decision : 'deny';
        },
        onAskUser: async (request) => {
          const answer = await this.ask({ id: randomUUID(), sessionId: id, kind: 'ask_user', questions: request.questions, toolCallId: request.toolCallId }, request.signal);
          return answer !== 'closed' && 'answers' in answer ? answer.answers : [];
        },
      });
      // Commands only the app can perform; the renderer decides how.
      session.commands.register({ name: 'config', description: 'Open settings' });

      const entry: Entry = { id, session, workspace, files: new FileIndex(workspace), busy: false, projectSkills: { found: countProjectSkills(workspace), loaded: trustedProject === true }, interruptedPending: session.interruptedCalls };
      this.sessions.set(id, entry);
      return this.describe(entry, Boolean(resumeId));
    },

    'session.close': ({ sessionId }) => ({ closed: this.close(sessionId) }),

    'session.run': async ({ sessionId, text }): Promise<RunStarted> => {
      const e = this.entry(sessionId);
      if (e.busy) throw new Error('This conversation is already running. Stop it first, or wait for it to finish.');

      this.checkMentions(e.workspace, text);

      let kind: RunStarted['kind'] = 'prompt';
      let prompt: string;
      let attached: string[];
      let errors: string[];

      const slash = SLASH_COMMAND.exec(text.trim());
      const command = slash ? e.session.commands.get(slash[1]) : undefined;
      if (command && command.kind !== 'skill') {
        throw new Error(`/${command.name} is an app command, not a prompt. Use its own request.`);
      }
      if (slash && command) {
        const resolved = await e.session.resolveSkill(slash[1], slash[2] ?? '');
        if (resolved.status === 'unavailable') throw new Error(resolved.message);
        if (resolved.status === 'not_a_skill') throw new Error(`/${slash[1]} is not a skill.`);
        kind = 'skill';
        prompt = resolved.prompt;
        attached = resolved.attachments.map((a) => a.displayPath);
        errors = resolved.errors;
      } else {
        const prepared = await e.session.prepareInput(text);
        prompt = prepared.prompt;
        attached = prepared.attachments.map((a) => a.displayPath);
        errors = prepared.errors;
      }
      for (const message of errors) this.notice(sessionId, 'error', message);

      this.launch(e, text, prompt);
      return { started: true, kind, attached, errors };
    },

    'session.cancel': ({ sessionId }) => {
      const e = this.entry(sessionId);
      if (!e.controller) return { cancelled: false };
      e.controller.abort();
      return { cancelled: true };
    },

    'session.compact': async ({ sessionId }) => {
      const e = this.entry(sessionId);
      const controller = new AbortController();
      e.controller = controller;
      try {
        return await e.session.compact({ signal: controller.signal });
      } finally {
        if (e.controller === controller) e.controller = undefined;
      }
    },

    'session.reset': ({ sessionId }) => {
      const e = this.entry(sessionId);
      if (e.busy) throw new Error('Stop the run before clearing the conversation.');
      e.session.reset();
      return { ok: true };
    },

    'session.usage': ({ sessionId }) => this.entry(sessionId).session.getContextUsage(),

    'model.list': async ({ sessionId }): Promise<ModelList> => {
      const e = this.entry(sessionId);
      return { current: e.session.getModel(), ...(await e.session.listModels()) };
    },

    'model.switch': ({ sessionId, model }) => this.entry(sessionId).session.switchModel(model),

    'commands.list': ({ sessionId }) => this.entry(sessionId).session.commands.list(),

    'files.search': ({ sessionId, query, limit }) => this.entry(sessionId).files.search(query, limit),

    'files.children': ({ sessionId, dir }) => ({ entries: listDirectory(this.entry(sessionId).workspace, dir ?? '') }),

    'files.preview': ({ sessionId, path: file }) => previewFile(this.entry(sessionId).workspace, file),

    'changes.list': ({ sessionId }): ChangeInfo[] =>
      this.entry(sessionId).session.changes.list().map((c) => ({ path: c.path, kind: c.kind, added: c.added, removed: c.removed, ...(c.untracked ? { untracked: String(c.untracked) } : {}) })),

    'changes.diff': ({ sessionId, path: file }): DiffResult => {
      const diff = this.entry(sessionId).session.changes.diff(file);
      if (diff === undefined) return { diff: null, truncated: false };
      return diff.length > DIFF_CAP ? { diff: diff.slice(0, DIFF_CAP), truncated: true } : { diff, truncated: false };
    },

    'changes.revert': ({ sessionId, paths }) => this.entry(sessionId).session.changes.revert(paths),

    'changes.keep': ({ sessionId, paths }) => ({ kept: this.entry(sessionId).session.changes.keep(paths) }),

    'permissions.list': ({ sessionId }) => this.entry(sessionId).session.permissions.list(),

    'permissions.remove': ({ sessionId, command, match }) => ({ removed: this.entry(sessionId).session.permissions.remove(command, match) }),

    'permissions.listForProject': ({ projectPath }) => this.permissionsFor(projectPath).list(),

    'permissions.removeForProject': ({ projectPath, command, match }) => ({ removed: this.permissionsFor(projectPath).remove(command, match) }),

    'connection.test': ({ url, apiKey }) => this.testConnection(url, apiKey),

    'conversations.list': ({ projectPath, limit }) => this.store.list({ ...(projectPath ? { workspace: path.resolve(projectPath) } : {}), limit }),

    'conversations.search': ({ text, projectPath, limit }) => this.store.search(text, { ...(projectPath ? { workspace: path.resolve(projectPath) } : {}), limit }),

    'conversations.rename': ({ id, title }) => this.store.rename(id, title),

    'conversations.delete': ({ id }) => {
      this.close(id);
      return { deleted: this.store.delete(id) };
    },

    'conversations.load': ({ id }): ConversationContent | null => {
      const loaded = this.store.load(id);
      return loaded ? { info: loaded.info, messages: loaded.messages, annotations: loaded.annotations, skipped: loaded.skipped } : null;
    },

    'interaction.respond': ({ id, response }) => {
      const p = this.pending.get(id);
      if (!p) throw new Error('That question is no longer open (it was answered or the run was cancelled).');
      const wantsDecision = p.interaction.kind === 'permission';
      if (wantsDecision !== 'decision' in response) throw new Error(`The answer does not match the question (${p.interaction.kind}).`);
      p.settle(response);
      return { ok: true };
    },

    'sessions.active': (): ActiveSession[] =>
      [...this.sessions.values()].map((e) => ({
        sessionId: e.id,
        workspace: e.workspace,
        running: e.busy,
        waiting: [...this.pending.values()].filter((p) => p.interaction.sessionId === e.id).length,
      })),

    'pipeline.brief': ({ projectPath }) => pipelineBrief(path.resolve(projectPath)),

    'pipeline.status': ({ projectPath }) => getPipelineStatus(path.resolve(projectPath)),

    'pipeline.inspect': async ({ projectPath, paths }) => {
      const workspace = path.resolve(projectPath);
      this.checkInputPaths(workspace, paths);
      return { items: await Promise.all(paths.map((p) => inspectInput(path.resolve(p)))) };
    },

    'pipeline.start': async ({ sessionId, inputs }): Promise<PipelineStartResult> => {
      const e = this.entry(sessionId);
      if (e.busy) throw new Error('This conversation is already running. Stop it first, or wait for it to finish.');
      this.checkInputPaths(e.workspace, inputs.flatMap((i) => (i.transcriptPath ? [i.path, i.transcriptPath] : [i.path])));
      const started = await e.session.startPipelinePrompt(inputs.map((i) => ({ path: path.resolve(i.path), ...(i.transcriptPath ? { transcriptPath: path.resolve(i.transcriptPath) } : {}) })));
      if (started.status === 'refused') return { started: false, problems: started.problems };
      const count = started.inputs.length;
      this.launch(e, `Iniciar o pipeline com ${count} ${count === 1 ? 'entrada' : 'entradas'}: ${started.inputs.map((i) => i.name).join(', ')}`, started.prompt, pipelineTitle(e.workspace));
      return { started: true, resumed: started.resumed, inputs: started.inputs.map((i) => ({ name: i.name, kind: i.kind, handledBy: i.handledBy })) };
    },

    'pipeline.state': ({ projectPath }): PipelineView => {
      const workspace = path.resolve(projectPath);
      const status = getPipelineStatus(workspace);
      let state;
      try {
        state = new PipelineStateStore(workspace).load();
      } catch {
        /* a damaged state: the status already says so */
      }
      const artifacts = (state?.stages ?? []).map((st) => {
        const stat = fs.statSync(path.join(workspace, st.artifact), { throwIfNoEntry: false });
        return { stage: st.stage, path: st.artifact, exists: !!stat, isDir: !!stat?.isDirectory() };
      });
      const report = state ? buildReport(state, new PipelineStateStore(workspace).tasks(), status.staleInputs) : undefined;
      return { status, state, artifacts, markdownExists: fs.existsSync(path.join(workspace, 'docs', 'pipeline', 'STATE.md')), report };
    },

    'pipeline.answer': ({ sessionId, gate, answers, by }) => {
      const e = this.entry(sessionId);
      if (e.busy) throw new Error('This conversation is running. Pause it before answering here.');
      const store = new PipelineStateStore(e.workspace);
      const ops = answers.map((a) => {
        if (a.deferred) return { op: 'defer_question', id: a.id, owner: a.owner, by };
        return { op: 'answer_question', id: a.id, answer: a.answer, by };
      });
      // Only the open questions of this gate: an answer cannot rewrite a question that was settled before, or one of another gate.
      const current = store.load();
      const mine = new Map((current?.gates.find((g) => g.id === gate)?.questions ?? []).map((q) => [q.id, q]));
      for (const a of answers) {
        const q = mine.get(a.id);
        if (!q) throw new Error(`There is no question "${a.id}" at gate ${gate}.`);
        if (q.status !== 'open') throw new Error(`Question "${a.id}" is already ${q.status === 'answered' ? 'answered' : 'deferred'}.`);
      }
      const result = store.apply(ops);
      if (!result.ok) throw new Error(result.error);
      const progress = gateProgress(result.state, gate);
      return { progress, clean: progress.open === 0 };
    },

    'pipeline.reviewSpec': ({ sessionId, spec, status, comment, by }) => {
      const e = this.entry(sessionId);
      if (e.busy) throw new Error('This conversation is running. Pause it before reviewing here.');
      const store = new PipelineStateStore(e.workspace);
      this.requireSpec(store, spec);
      const ops: Array<Record<string, unknown>> = [{ op: 'set_spec_review', spec, status, by }];
      if (comment?.trim()) ops.push({ op: 'add_note', text: `Revisão de ${spec} (${by}): ${comment.trim()}` });
      const result = store.apply(ops);
      if (!result.ok) throw new Error(result.error);
      return { status: getPipelineStatus(e.workspace) };
    },

    'pipeline.requestChanges': async ({ sessionId, spec, comment, by }): Promise<{ started: true }> => {
      const e = this.entry(sessionId);
      if (e.busy) throw new Error('This conversation is running. Pause it before asking for changes.');
      const store = new PipelineStateStore(e.workspace);
      this.requireSpec(store, spec);
      const text = comment.trim();
      // The specs stage (and what follows it) has to be redone and pass its gate again; the spec goes back to draft.
      const result = store.apply([
        { op: 'set_spec_review', spec, status: 'draft', by },
        { op: 'add_note', text: `Alterações pedidas na spec ${spec} por ${by}: ${text}` },
        { op: 'mark_stale', after_stage: 2, reason: `${by} pediu alterações na spec ${spec}: ${text}` },
      ]);
      if (!result.ok) throw new Error(result.error);
      const resumed = await e.session.resumePipelinePrompt();
      const prompt = `${resumed.prompt ?? ''}\n\nPedido de alterações de ${by} na spec "${spec}":\n${text}\n\nRefaça a etapa de specs levando isso em conta e registre a spec de novo (set_spec). Não aprove nada por conta própria: a revisão é humana.`;
      this.launch(e, `Pedir alterações na spec ${spec}: ${text}`, prompt);
      return { started: true };
    },

    'issues.publish': async ({ sessionId, confirmDrafts }): Promise<IssuesPublishResult> => {
      const e = this.entry(sessionId);
      if (e.busy) throw new Error('This conversation is already running. Stop it first, or wait for it to finish.');
      // Detected at every attempt: a connection made (or lost) since the last one is what counts.
      const status = await e.session.issuePublishing({ probe: this.options.issueProbe });
      if (status.mode === 'drafts' && !confirmDrafts) return { started: false, reason: 'needs_confirmation', status };
      const publish = status.mode === 'publish';
      const request = publish
        ? `Publish the tasks in docs/tasks/ as issues, using the tracker connection that is available (${status.via}). Report the issue links when done.`
        : `There is no tracker connection. Write each task in docs/tasks/ as an issue draft under ${status.draftsDir}/ and do not try to publish anything. Say where the drafts are when done.`;
      const resolved = await e.session.resolveSkill(`/${status.skill}`, request);
      this.launch(e, publish ? 'Publicar issues' : 'Gerar rascunhos de issues', resolved.status === 'ready' ? resolved.prompt : request);
      return { started: true, mode: status.mode, ...(status.via ? { via: status.via } : {}), skill: status.skill };
    },

    'pipeline.approveGate': ({ sessionId, gate }) => {
      const e = this.entry(sessionId);
      if (e.busy) throw new Error('This conversation is running. Pause it before approving here.');
      const result = new PipelineStateStore(e.workspace).apply([{ op: 'set_gate', gate, status: 'passed' }]);
      if (!result.ok) throw new Error(result.error);
      return { status: getPipelineStatus(e.workspace) };
    },

    'pipeline.resume': async ({ sessionId }): Promise<PipelineResumeResult> => {
      const e = this.entry(sessionId);
      if (e.busy) throw new Error('This conversation is already running. Stop it first, or wait for it to finish.');
      const resumed = await e.session.resumePipelinePrompt();
      if (!resumed.prompt) return { started: false, reason: 'no_pipeline' };
      this.launch(e, 'Retomar o pipeline', resumed.prompt, pipelineTitle(e.workspace));
      return { started: true };
    },

    'interaction.pending': () => [...this.pending.values()].map((p) => p.interaction),
  };

  /**
   * A mention may read a file inside the project, or one the user chose with the file dialog or by dropping it. Anything
   * else is refused before it is read: the page could otherwise ask for any file on the computer by typing its path.
   */
  private checkMentions(workspace: string, text: string): void {
    for (const abs of extractMentionPaths(text, workspace)) {
      if (isInside(workspace, abs)) continue;
      if (this.allowedOutside.some((allowed) => sameFile(allowed, abs) || isInside(allowed, abs))) continue;
      throw new Error(`"${abs}" is outside the project folder. Attach it with the paperclip button or by dragging it into the window.`);
    }
  }

  /** The project's allowlist, read straight from its file (an open conversation reads the same file). */
  private permissionsFor(projectPath: string): PermissionStore {
    return new PermissionStore(path.resolve(projectPath), { dir: this.permissionsDir });
  }

  /** Lists the models at an endpoint. Fails with a reason the settings screen can explain; the key is never in the message. */
  private async testConnection(url: string, apiKey: string): Promise<ConnectionTestResult> {
    const client = new OpenAI({ apiKey, baseURL: url.endsWith('/') ? url : `${url}/`, timeout: 10_000, maxRetries: 0 });
    try {
      const list = await client.models.list();
      return { ok: true, models: list.data.map((m) => m.id).slice(0, 500) };
    } catch (err: any) {
      const message = String(err?.message ?? err).split(apiKey).join('[redacted]').slice(0, 300);
      const status: number | undefined = err?.status;
      // The SDK's errors are named by class (`APIConnectionError`), while `name` is just "Error".
      const name = `${err?.constructor?.name ?? ''} ${err?.name ?? ''}`;
      let reason: NonNullable<ConnectionTestResult['reason']> = 'other';
      if (status === 401 || status === 403) reason = 'unauthorized';
      else if (status === 404) reason = 'not_found';
      else if (/Timeout/i.test(name)) reason = 'timeout';
      else if (/Connection/i.test(name) || ['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'EHOSTUNREACH'].includes(err?.code ?? err?.cause?.code)) reason = 'unreachable';
      return { ok: false, models: [], reason, message };
    }
  }

  // ---------------------------------------------------------------------------------- self test

  private async selfTest(dir: string): Promise<SelfTestResult> {
    const checks: SelfTestResult['checks'] = [];
    const check = async (name: string, fn: () => Promise<string | true>) => {
      try {
        const r = await fn();
        checks.push({ name, ok: r === true, ...(r === true ? {} : { detail: r }) });
      } catch (err: any) {
        checks.push({ name, ok: false, detail: String(err?.stack ?? err) });
      }
    };
    const read = async (file: string, marker: string): Promise<string | true> => {
      const r = await readDocument(path.join(dir, file));
      if (!r.ok) return r.error;
      return r.text.includes(marker) ? true : `marker ${marker} not found in: ${r.text.slice(0, 200)}`;
    };

    await check('reads a PDF with page markers (unpdf / pdf.js inside the bundle)', () => read('sample.pdf', '[p. 2]'));
    await check('reads a Word file (fflate and the XML reader)', () => read('sample.docx', '[part 1'));
    await check('reads a PowerPoint deck', () => read('sample.pptx', '[slide 1]'));
    await check('creates an isolated session and lists its commands', async () => {
      const session = createSession({
        workspace: dir,
        config: { name: 'smoke', vendor: 'smoke', apiKey: 'unused', apiType: 'chat-completions', models: [{ id: 'm', name: 'm', url: 'http://127.0.0.1:9', toolCalling: true }] },
        skillRoots: [],
      });
      const names = session.commands.list().map((c) => c.name);
      session.dispose();
      return names.includes('compact') ? true : `commands: ${names.join(', ')}`;
    });
    return { ok: checks.every((c) => c.ok), checks };
  }
}

/** How many skills a folder carries in `.alia/skills` (a folder with a SKILL.md each). */
export function countProjectSkills(workspace: string): number {
  const dir = path.join(workspace, '.alia', 'skills');
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && fs.existsSync(path.join(dir, d.name, 'SKILL.md'))).length;
  } catch {
    return 0;
  }
}

/** What a pipeline conversation is called: "Pipeline: Portal do cliente". */
function pipelineTitle(workspace: string): string {
  let name = path.basename(workspace);
  try {
    name = new PipelineStateStore(workspace).load()?.project ?? name;
  } catch {
    /* the folder name will do */
  }
  return `Pipeline: ${name}`;
}

/** The pipeline of a project, reduced to what the sidebar chip needs. Never throws. */
export function pipelineBrief(workspace: string): PipelineBrief {
  const status = getPipelineStatus(workspace);
  if (!status.exists) return { exists: false, summary: status.summary, state: 'not_started' };
  const base = { exists: true, ...(status.project ? { project: status.project } : {}), summary: status.summary };
  const next = status.next;
  switch (next.kind) {
    case 'answer_questions':
      return { ...base, state: 'answer_questions', gate: next.gate, answered: next.answered, total: next.total };
    case 'review_specs':
      return { ...base, state: 'review_specs', gate: next.gate };
    case 'pass_gate':
      return { ...base, state: 'pass_gate', gate: next.gate };
    case 'run_stage':
      return { ...base, state: 'run_stage', stage: next.stage };
    case 'inputs_changed':
      return { ...base, state: 'inputs_changed' };
    case 'complete':
      return { ...base, state: 'complete' };
    case 'damaged':
      return { ...base, state: 'damaged' };
    default:
      return { ...base, state: 'not_started' };
  }
}

const fsKey = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
const sameFile = (a: string, b: string) => fsKey(a) === fsKey(b);
/** True when `child` is `parent` itself or inside it. */
function isInside(parent: string, child: string): boolean {
  const rel = path.relative(fsKey(parent), fsKey(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
