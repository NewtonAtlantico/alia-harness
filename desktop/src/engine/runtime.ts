/**
 * The engine's brain, free of Electron so it can be tested with a fake model: it owns the sessions, turns
 * `core` events into messages for the UI, and turns "needs approval" and "asks a question" into interactions
 * the UI answers later. `index.ts` only connects it to the utility process's message port.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type OpenAI from 'openai';
import {
  type AgentEvent,
  type AliaConfig,
  type AliaSession,
  FileIndex,
  STAGES,
  SessionStore,
  createSession,
  newSessionId,
  readDocument,
} from 'alia-harness/core';
import type {
  ChangeInfo,
  ConversationContent,
  DiffResult,
  EngineMessage,
  EngineRequestName,
  EngineRequests,
  Interaction,
  InteractionResponse,
  ModelList,
  OpenedSession,
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
    return { sessionId: e.id, workspace: e.workspace, model: e.session.getModel(), resumed, messages: usage.messages, usage };
  }

  // ---------------------------------------------------------------------------------- requests

  private readonly handlers: { [K in EngineRequestName]: (p: EngineRequests[K]['request']) => Promise<EngineRequests[K]['result']> | EngineRequests[K]['result'] } = {
    ping: (): PingResult => ({ pong: true, pid: process.pid, node: process.versions.node, coreStages: STAGES.length }),

    selfTest: ({ dir }) => this.selfTest(dir),

    'engine.configure': ({ config, skillRoots, dataDirs }) => {
      this.config = config;
      this.skillRoots = skillRoots;
      this.store = new SessionStore({ dir: dataDirs?.sessions });
      this.permissionsDir = dataDirs?.permissions;
      return { ok: true, models: config.models.length };
    },

    'session.open': ({ projectPath, resumeId }) => {
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
        client: this.options.clientFor?.(config),
        skillRoots: this.skillRoots,
        sessionStore: this.store,
        permissionsDir: this.permissionsDir,
        ...(resumeId ? { resume: resumeId } : { sessionId: id }),
        permissionMode: 'ask-commands',
        onEvent: (event) => {
          // The run is over the moment run_finished is emitted; waiting for the promise to settle would make
          // a message sent right after the UI shows the end look like "still running".
          if (event.type === 'run_finished' && !event.subagentId) {
            const e = this.sessions.get(id);
            if (e) {
              e.busy = false;
              e.controller = undefined;
            }
          }
          post({ kind: 'event', sessionId: id, event: this.capEvent(event) });
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

      const entry: Entry = { id, session, workspace, files: new FileIndex(workspace), busy: false };
      this.sessions.set(id, entry);
      return this.describe(entry, Boolean(resumeId));
    },

    'session.close': ({ sessionId }) => ({ closed: this.close(sessionId) }),

    'session.run': async ({ sessionId, text }): Promise<RunStarted> => {
      const e = this.entry(sessionId);
      if (e.busy) throw new Error('This conversation is already running. Stop it first, or wait for it to finish.');

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

    'conversations.list': ({ projectPath, limit }) => this.store.list({ ...(projectPath ? { workspace: path.resolve(projectPath) } : {}), limit }),

    'conversations.search': ({ text, projectPath, limit }) => this.store.search(text, { ...(projectPath ? { workspace: path.resolve(projectPath) } : {}), limit }),

    'conversations.rename': ({ id, title }) => this.store.rename(id, title),

    'conversations.delete': ({ id }) => {
      this.close(id);
      return { deleted: this.store.delete(id) };
    },

    'conversations.load': ({ id }): ConversationContent | null => {
      const loaded = this.store.load(id);
      return loaded ? { info: loaded.info, messages: loaded.messages, skipped: loaded.skipped } : null;
    },

    'interaction.respond': ({ id, response }) => {
      const p = this.pending.get(id);
      if (!p) throw new Error('That question is no longer open (it was answered or the run was cancelled).');
      const wantsDecision = p.interaction.kind === 'permission';
      if (wantsDecision !== 'decision' in response) throw new Error(`The answer does not match the question (${p.interaction.kind}).`);
      p.settle(response);
      return { ok: true };
    },

    'interaction.pending': () => [...this.pending.values()].map((p) => p.interaction),
  };

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
