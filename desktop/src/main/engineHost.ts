import path from 'node:path';
import { utilityProcess, type UtilityProcess } from 'electron';
import type { EngineMcpMessage, EngineMessage, EngineReplyMessage, EngineRequestName, EngineRequests, PushMessage } from '../shared/ipc';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface EngineHostOptions {
  /** Where `engine.js` is. */
  enginePath?: string;
  log?: (line: string) => void;
  /** Default time to wait for an answer. Requests answer quickly (runs reply at once and report through events). */
  requestTimeoutMs?: number;
  /** Runs after every (re)start, before any request: hands the engine its configuration. */
  onStart?: (host: EngineHost) => Promise<void>;
  /** Pushed messages from the engine (events, interactions) and status changes. */
  onPush?: (message: PushMessage | EngineMcpMessage) => void;
}

/** Slow requests: a compaction asks the model to summarize. */
const LONG_REQUESTS: ReadonlySet<EngineRequestName> = new Set(['session.compact', 'mcp.configure', 'mcp.probe', 'mcp.authorize']);
const LONG_TIMEOUT_MS = 5 * 60_000;

/**
 * Starts the engine process, sends it requests and matches the replies. If the engine dies, every request in
 * flight fails with a clear error, the renderer is told, and a fresh engine is started (and configured again).
 * Saved conversations are on disk, so nothing is lost; open sessions have to be reopened with `resumeId`.
 */
export class EngineHost {
  private child?: UtilityProcess;
  private ready?: Promise<void>;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private stopped = false;
  private starts = 0;
  private readonly enginePath: string;
  private readonly log: (line: string) => void;
  private readonly timeoutMs: number;

  constructor(private readonly options: EngineHostOptions = {}) {
    this.enginePath = options.enginePath ?? path.join(import.meta.dirname, 'engine.js');
    this.log = options.log ?? (() => {});
    this.timeoutMs = options.requestTimeoutMs ?? 60_000;
  }

  /** The engine's process id, once started (tests use it to kill it). */
  get pid(): number | undefined {
    return this.child?.pid;
  }

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    this.stopped = false;
    const child = utilityProcess.fork(this.enginePath, [], { serviceName: 'alia-engine', stdio: 'pipe' });
    this.child = child;
    const generation = ++this.starts;
    child.stdout?.on('data', (d) => this.log(`[engine] ${String(d).trimEnd()}`));
    child.stderr?.on('data', (d) => this.log(`[engine:err] ${String(d).trimEnd()}`));

    const launched = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the engine did not start in time')), 15_000);
      child.on('message', (msg: EngineMessage) => {
        if (msg.kind === 'ready') {
          clearTimeout(timer);
          resolve();
        } else if (msg.kind === 'reply') {
          this.settle(msg);
        } else if (msg.kind !== 'request') {
          this.options.onPush?.(msg);
        }
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        const unexpected = this.child === child && !this.stopped;
        if (this.child === child) {
          this.child = undefined;
          this.ready = undefined;
        }
        reject(new Error(`the engine exited (code ${code})`));
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error(`the engine exited (code ${code}) before answering`));
          this.pending.delete(id);
        }
        if (unexpected) {
          this.log(`[host] the engine exited unexpectedly (code ${code}); restarting`);
          this.options.onPush?.({ kind: 'engine_status', status: 'down' });
          void this.restart(generation);
        }
      });
    });

    // The engine is usable once it is running and configured.
    this.ready = launched.then(async () => {
      this.ready = Promise.resolve(); // let onStart's own requests through
      await this.options.onStart?.(this);
    });
    this.ready.catch(() => {}); // surfaced to whoever awaits it in request()
    return this.ready;
  }

  private async restart(afterGeneration: number): Promise<void> {
    if (this.stopped || this.starts !== afterGeneration) return;
    try {
      await this.start();
      this.options.onPush?.({ kind: 'engine_status', status: 'restarted' });
    } catch (err: any) {
      this.log(`[host] restart failed: ${err?.message ?? err}`);
    }
  }

  private settle(msg: EngineReplyMessage): void {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error));
  }

  async request<K extends EngineRequestName>(name: K, payload: EngineRequests[K]['request']): Promise<EngineRequests[K]['result']> {
    await this.start();
    const child = this.child;
    if (!child) throw new Error('the engine is not running');
    const id = this.nextId++;
    const timeout = LONG_REQUESTS.has(name) ? LONG_TIMEOUT_MS : this.timeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`the engine did not answer "${name}" in time`));
      }, timeout);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      child.postMessage({ kind: 'request', id, name, payload });
    });
  }

  /** Starts the engine now (otherwise it starts with the first request). */
  async ensureStarted(): Promise<void> {
    await this.start();
  }

  /** Stops the engine for good (quit). It will not restart. */
  stop(): void {
    this.stopped = true;
    const child = this.child;
    this.child = undefined;
    this.ready = undefined;
    child?.kill();
  }

  /** Kills the engine as a crash would, so it restarts (tests). */
  crashForTest(): void {
    this.child?.kill();
  }
}
