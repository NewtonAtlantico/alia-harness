/**
 * What stands between the renderer and the engine. Free of Electron, so it is tested directly.
 *
 * Every request from the page is (1) checked against a strict schema, (2) checked against the folders the
 * user opened through the native dialog, and only then (3) forwarded to the engine. A request that names a
 * folder the user never opened is refused here and never reaches the engine.
 */
import path from 'node:path';
import type { EngineRequests, RendererRequestName, RendererRequests } from '../shared/ipc';
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

export interface BrokerOptions {
  engine: EngineLink;
  projects: ProjectRegistry;
  /** Shows the native folder dialog; resolves to the chosen folder, or null if the user cancelled. */
  pickFolder: () => Promise<string | null>;
}

export class Broker {
  constructor(private readonly options: BrokerOptions) {}

  /** The one entry point for renderer requests. Rejects with a readable error; never forwards anything unchecked. */
  async handle(name: unknown, payload: unknown): Promise<unknown> {
    if (!isRendererRequest(name)) throw new IpcValidationError(`Unknown request "${String(name).slice(0, 60)}".`);
    const request = parseRendererRequest(name, payload);
    return this.dispatch(name, request);
  }

  private dispatch<K extends RendererRequestName>(name: K, request: RendererRequests[K]['request']): Promise<unknown> {
    const { engine, projects } = this.options;

    if (name === 'projects.pick') {
      return this.options.pickFolder().then((picked) => (picked ? { path: projects.allow(picked) } : null));
    }

    // Anything that names a folder must name one the user opened.
    const folder = (request as { projectPath?: string }).projectPath;
    if (folder !== undefined && !projects.isAllowed(folder)) {
      return Promise.reject(new IpcValidationError('That folder was not opened through the folder dialog, so it cannot be used.'));
    }

    return engine.request(name as Exclude<K, 'projects.pick'>, request as never);
  }
}
