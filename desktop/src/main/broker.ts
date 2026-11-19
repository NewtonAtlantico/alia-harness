/**
 * What stands between the renderer and the engine. Free of Electron, so it is tested directly.
 *
 * Every request from the page is (1) checked against a strict schema, (2) checked against the folders the
 * user opened through the native dialog, and only then (3) answered by main itself (windows, dialogs) or
 * forwarded to the engine. A request that names a folder the user never opened is refused here.
 */
import path from 'node:path';
import type { EngineRequests, MainRequestName, RendererRequestName, RendererRequests } from '../shared/ipc';
import { IpcValidationError, isRendererRequest, parseRendererRequest } from '../shared/schemas';

/** The folders the user has opened (through the native dialog). The engine only works inside these. */
export class ProjectRegistry {
  private readonly allowed = new Set<string>();

  private key(p: string): string {
    const resolved = path.resolve(p);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }

  allow(projectPath: string): string {
    this.allowed.add(this.key(projectPath));
    return path.resolve(projectPath);
  }

  isAllowed(projectPath: string): boolean {
    return this.allowed.has(this.key(projectPath));
  }
}

export interface EngineLink {
  request<K extends keyof EngineRequests>(name: K, payload: EngineRequests[K]['request']): Promise<EngineRequests[K]['result']>;
}

/** Answers for the requests main handles itself. `context` is whatever the caller passed to `handle` (the IPC event). */
export type MainHandlers = { [K in Exclude<MainRequestName, 'projects.pick'>]: (request: RendererRequests[K]['request'], context: unknown) => Promise<RendererRequests[K]['result']> | RendererRequests[K]['result'] };

export interface BrokerOptions {
  engine: EngineLink;
  projects: ProjectRegistry;
  /** Shows the native folder dialog; resolves to the chosen folder, or null if the user cancelled. */
  pickFolder: () => Promise<string | null>;
  /** Window controls, app info and the like. Optional so the engine-facing rules can be tested alone. */
  main?: Partial<MainHandlers>;
}

export class Broker {
  constructor(private readonly options: BrokerOptions) {}

  /** The one entry point for renderer requests. Rejects with a readable error; never forwards anything unchecked. */
  async handle(name: unknown, payload: unknown, context?: unknown): Promise<unknown> {
    if (!isRendererRequest(name)) throw new IpcValidationError(`Unknown request "${String(name).slice(0, 60)}".`);
    const request = parseRendererRequest(name, payload);
    return this.dispatch(name, request, context);
  }

  private dispatch<K extends RendererRequestName>(name: K, request: RendererRequests[K]['request'], context: unknown): Promise<unknown> {
    const { engine, projects } = this.options;

    if (name === 'projects.pick') {
      return this.options.pickFolder().then((picked) => (picked ? { path: projects.allow(picked) } : null));
    }

    const handler = (this.options.main as Record<string, ((r: unknown, c: unknown) => unknown) | undefined> | undefined)?.[name];
    if (handler) return Promise.resolve(handler(request, context));
    if (isMainOnly(name)) return Promise.reject(new Error(`"${name}" is not available here.`));

    // Anything that names a folder must name one the user opened.
    const folder = (request as { projectPath?: string }).projectPath;
    if (folder !== undefined && !projects.isAllowed(folder)) {
      return Promise.reject(new IpcValidationError('That folder was not opened through the folder dialog, so it cannot be used.'));
    }

    return engine.request(name as keyof EngineRequests, request as never);
  }
}

const MAIN_ONLY: ReadonlySet<string> = new Set<MainRequestName>(['projects.pick', 'window.minimize', 'window.toggleMaximize', 'window.close', 'window.state', 'app.info', 'app.openExternal']);

/** Requests that are never forwarded to the engine. */
function isMainOnly(name: string): boolean {
  return MAIN_ONLY.has(name);
}
