import path from 'node:path';
import type { EngineRequests, ImportSummary, LegacyCandidate, SettingsUpdate, SettingsView, ConnectionTestResult } from '../shared/ipc';
import { buildEngineConfig, findLegacyConfig, readLegacyConfig, skillRoots } from './legacyConfig';
import type { SecretStore } from './secrets';
import type { SettingsStore } from './settings';

export interface SettingsServiceOptions {
  store: SettingsStore;
  secrets: SecretStore;
  engine: { request<K extends keyof EngineRequests>(name: K, payload: EngineRequests[K]['request']): Promise<EngineRequests[K]['result']> };
  /** Folders to look in for an existing alia-config.json (besides ALIA_CONFIG). */
  legacyFolders: string[];
  /** Asks the user for an alia-config.json (native file dialog); null if they cancel. */
  pickLegacyFile: (suggestedFolder?: string) => Promise<string | null>;
  bundledSkillsDir: string;
  userSkillsDir: string;
  dataDirs?: { sessions?: string; permissions?: string };
  log?: { info(m: string): void; warn(m: string): void };
  env?: NodeJS.ProcessEnv;
  /** Told about every key the service handles, so the log can mask it. */
  onSecret?: (secret: string) => void;
}

/**
 * Everything behind the settings screen: what is saved, the encrypted key, testing a connection, importing an
 * earlier configuration, and keeping the engine configured. The key never appears in anything returned.
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
      endpointUrl: s.endpointUrl,
      models: s.models,
      permissionMode: s.permissionMode,
      hasApiKey,
      secureStorage: this.o.secrets.available,
      configured: hasApiKey && !!s.endpointUrl && s.models.length > 0,
    };
  }

  /** Gives the engine its configuration, if there is one. Returns whether it is configured. */
  async configureEngine(): Promise<boolean> {
    const s = this.o.store.get();
    const apiKey = this.o.secrets.get();
    if (!apiKey || !s.endpointUrl || s.models.length === 0) {
      this.o.log?.warn('not configured yet (endpoint, a model and an API key are needed); conversations cannot start until they are set');
      return false;
    }
    this.o.onSecret?.(apiKey);
    await this.o.engine.request('engine.configure', {
      config: buildEngineConfig({ endpointUrl: s.endpointUrl, models: s.models }, apiKey),
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

  async setApiKey(apiKey: string): Promise<SettingsView> {
    this.o.onSecret?.(apiKey);
    this.o.secrets.set(apiKey);
    await this.configureEngine();
    return this.view();
  }

  async clearApiKey(): Promise<SettingsView> {
    this.o.secrets.clear();
    return this.view();
  }

  /** Lists the endpoint's models with the given address and key, or the saved ones. */
  async testConnection(args: { endpointUrl?: string; apiKey?: string }): Promise<ConnectionTestResult> {
    const url = args.endpointUrl ?? this.o.store.get().endpointUrl;
    const apiKey = args.apiKey ?? this.o.secrets.get();
    if (!url) return { ok: false, models: [], reason: 'not_found', message: 'No endpoint address.' };
    if (!apiKey) return { ok: false, models: [], reason: 'unauthorized', message: 'No API key.' };
    this.o.onSecret?.(apiKey);
    return this.o.engine.request('connection.test', { url, apiKey });
  }

  legacyCandidate(): LegacyCandidate | null {
    const file = findLegacyConfig(this.o.legacyFolders, this.env);
    if (!file) return null;
    try {
      const c = readLegacyConfig(file, this.env);
      return { path: file, endpointUrl: c.endpointUrl, models: c.models.length, hasApiKey: !!c.apiKey };
    } catch {
      return null;
    }
  }

  /** Imports an earlier configuration from a file the user chooses. */
  async importLegacy(): Promise<ImportSummary | null> {
    const suggested = findLegacyConfig(this.o.legacyFolders, this.env);
    const file = await this.o.pickLegacyFile(suggested ? path.dirname(suggested) : undefined);
    return file ? this.importFrom(file) : null;
  }

  /** Imports from a known file (also used for the first run when the launcher names one with ALIA_CONFIG). */
  async importFrom(file: string): Promise<ImportSummary> {
    const c = readLegacyConfig(file, this.env);
    this.o.store.update({ endpointUrl: c.endpointUrl, models: c.models });
    let importedKey = false;
    if (c.apiKey && this.o.secrets.available) {
      this.o.secrets.set(c.apiKey);
      importedKey = true;
    }
    this.o.log?.info(`imported ${c.models.length} model(s) from ${path.basename(file)}${importedKey ? ' and an API key' : ''}`);
    await this.configureEngine();
    return { endpointUrl: c.endpointUrl, models: c.models.length, importedKey };
  }

  /** First run: when nothing has been saved and the launcher names a configuration, take it. */
  async seedFromEnvironment(): Promise<boolean> {
    if (this.o.store.exists() || !this.env.ALIA_CONFIG) return false;
    try {
      await this.importFrom(path.resolve(this.env.ALIA_CONFIG));
      return true;
    } catch (err: any) {
      this.o.log?.warn(`could not seed the settings from ALIA_CONFIG: ${err?.message ?? err}`);
      return false;
    }
  }
}
