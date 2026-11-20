import path from 'node:path';
import type { ConnectResult, ConnectionTestResult, EngineRequests, ModelSetting, RemoteModel, SettingsUpdate, SettingsView } from '../shared/ipc';
import { buildEngineConfig, readLegacyConfig, skillRoots } from './legacyConfig';
import type { SecretStore } from './secrets';
import type { SettingsStore } from './settings';

/** The context size the app plans around when the service does not state one for a model (the engine's own default). */
export const DEFAULT_CONTEXT_TOKENS = 128_000;

export interface SettingsServiceOptions {
  store: SettingsStore;
  secrets: SecretStore;
  engine: { request<K extends keyof EngineRequests>(name: K, payload: EngineRequests[K]['request']): Promise<EngineRequests[K]['result']> };
  /** The service's address. Fixed (see endpoint.ts): the user never types it. */
  endpointUrl: string;
  bundledSkillsDir: string;
  userSkillsDir: string;
  dataDirs?: { sessions?: string; permissions?: string };
  log?: { info(m: string): void; warn(m: string): void };
  env?: NodeJS.ProcessEnv;
  /** Told about every key the service handles, so the log can mask it. */
  onSecret?: (secret: string) => void;
}

/**
 * Everything behind the settings screen: what is saved, the encrypted key, loading the models the service offers for
 * that key, and keeping the engine configured. The key never appears in anything returned.
 */
export class SettingsService {
  private readonly env: NodeJS.ProcessEnv;

  constructor(private readonly o: SettingsServiceOptions) {
    this.env = o.env ?? process.env;
  }

  view(): SettingsView {
    const s = this.o.store.get();
    const hasApiKey = this.o.secrets.has();
    return {
      displayName: s.displayName,
      organization: s.organization,
      models: s.models,
      permissionMode: s.permissionMode,
      hasApiKey,
      secureStorage: this.o.secrets.available,
      configured: hasApiKey && s.models.length > 0,
    };
  }

  /** Gives the engine its configuration, if there is one. Returns whether it is configured. */
  async configureEngine(): Promise<boolean> {
    const s = this.o.store.get();
    const apiKey = this.o.secrets.get();
    if (!apiKey || s.models.length === 0) {
      this.o.log?.warn('not configured yet (an API key, and the models it gives access to, are needed); conversations cannot start until they are set');
      return false;
    }
    this.o.onSecret?.(apiKey);
    await this.o.engine.request('engine.configure', {
      config: buildEngineConfig(this.o.endpointUrl, s.models, apiKey),
      skillRoots: skillRoots(this.o.bundledSkillsDir, this.o.userSkillsDir),
      permissionMode: s.permissionMode,
      dataDirs: this.o.dataDirs,
    });
    this.o.log?.info(`engine configured (${s.models.length} model${s.models.length === 1 ? '' : 's'}, approval mode ${s.permissionMode})`);
    return true;
  }

  async update(patch: SettingsUpdate): Promise<SettingsView> {
    // Models are identified by id: a duplicate would make /model ambiguous. Checked before anything is saved.
    if (patch.models) {
      const ids = patch.models.map((m) => m.id.trim());
      if (new Set(ids).size !== ids.length) throw new Error('Two models have the same id.');
    }
    this.o.store.update(patch);
    await this.configureEngine();
    return this.view();
  }

  /**
   * Checks the key against the service. Only a key the service accepts is stored; the models it lists become the
   * app's models. A rejected key changes nothing, and the reason comes back for the screen to explain.
   */
  async setApiKey(apiKey: string): Promise<ConnectResult> {
    this.o.onSecret?.(apiKey);
    if (!this.o.secrets.available) this.o.secrets.set(apiKey); // throws the "cannot store securely" error before any network call
    const connection = await this.list(apiKey);
    if (!connection.ok) return { view: this.view(), connection };
    this.o.secrets.set(apiKey);
    this.applyModels(connection.models);
    await this.configureEngine();
    return { view: this.view(), connection };
  }

  /** Asks the service again which models the saved key gives access to. */
  async refreshModels(): Promise<ConnectResult> {
    const apiKey = this.o.secrets.get();
    if (!apiKey) return { view: this.view(), connection: { ok: false, models: [], reason: 'unauthorized', message: 'No API key.' } };
    const connection = await this.list(apiKey);
    if (connection.ok) {
      this.applyModels(connection.models);
      await this.configureEngine();
    }
    return { view: this.view(), connection };
  }

  async clearApiKey(): Promise<SettingsView> {
    this.o.secrets.clear();
    return this.view();
  }

  /** Whether the saved key still works (used by the diagnostics); changes nothing. */
  async checkConnection(): Promise<ConnectionTestResult> {
    const apiKey = this.o.secrets.get();
    if (!apiKey) return { ok: false, models: [], reason: 'unauthorized', message: 'No API key.' };
    return this.list(apiKey);
  }

  private async list(apiKey: string): Promise<ConnectionTestResult> {
    this.o.onSecret?.(apiKey);
    const r = await this.o.engine.request('connection.test', { url: this.o.endpointUrl, apiKey });
    if (r.ok && r.models.length === 0) return { ok: false, models: [], reason: 'no_models', message: 'The service lists no models for this key.' };
    return r;
  }

  /** The service's list replaces the saved one; what the app knew about a model it still offers (its context size) is kept. */
  private applyModels(remote: RemoteModel[]): void {
    const known = new Map(this.o.store.get().models.map((m) => [m.id, m]));
    const models: ModelSetting[] = remote.map((m) => ({
      maxInputTokens: DEFAULT_CONTEXT_TOKENS,
      ...known.get(m.id),
      id: m.id,
      name: m.name,
      // What the service states wins over what was saved.
      ...(m.maxInputTokens ? { maxInputTokens: m.maxInputTokens } : {}),
      ...(m.maxOutputTokens ? { maxOutputTokens: m.maxOutputTokens } : {}),
    }));
    this.o.store.update({ models });
    this.o.log?.info(`models loaded from the service: ${models.length}`);
  }

  /**
   * Test runs only: seeds the settings from the file ALIA_CONFIG names (models and key), so a test starts configured.
   * Production never calls this (see main/index.ts).
   */
  async seedFromEnvironment(): Promise<boolean> {
    const file = this.env.ALIA_CONFIG;
    if (this.o.store.exists() || !file) return false;
    try {
      const c = readLegacyConfig(path.resolve(file), this.env);
      this.o.store.update({ models: c.models });
      if (c.apiKey && this.o.secrets.available) this.o.secrets.set(c.apiKey);
      await this.configureEngine();
      return true;
    } catch (err: any) {
      this.o.log?.warn(`could not seed the settings from ALIA_CONFIG: ${err?.message ?? err}`);
      return false;
    }
  }
}
