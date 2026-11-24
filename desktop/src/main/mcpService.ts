import type { McpCredentials, McpResolvedServer, McpServerConfig, McpTestResult } from 'alia-harness/core';
import type { EngineRequests, McpServerInput, McpServerSummary, McpView } from '../shared/ipc';
import type { McpConfigStore, McpVault } from './mcpStore';

/** Atlassian's remote MCP server. The page can only ask for "atlassian": the address is fixed here. */
export const ATLASSIAN_MCP_URL = 'https://mcp.atlassian.com/v1/mcp';
const DEFAULT_ID = 'jira';

export interface McpServiceOptions {
  store: McpConfigStore;
  vault: McpVault;
  engine: { request<K extends keyof EngineRequests>(name: K, payload: EngineRequests[K]['request']): Promise<EngineRequests[K]['result']> };
  /**
   * A native question the page cannot answer for itself: this command will run on this computer, with the person's
   * permissions. Asked before one is tested or saved. Resolves to whether the person agreed.
   */
  approveCommand: (commandLine: string) => Promise<boolean>;
  log?: { info(m: string): void; warn(m: string): void };
}

/** What the person can fix: written for them (pt-BR), not for support. */
export class McpInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpInputError';
  }
}

const NO_SECURE_STORAGE = 'Este computador não consegue criptografar segredos, então o token ou o login não podem ser guardados. Eles nunca são gravados em texto puro.';

const isLoopback = (host: string) => host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');

/** A server address is https, or http only to this computer: a token or a sign-in never crosses the network in the clear. */
export function validateServerUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new McpInputError('Esse endereço não é válido. Use algo como https://jira.suaempresa.com/mcp.');
  }
  if (url.username || url.password) throw new McpInputError('O endereço não pode conter usuário ou senha. Use o campo de token.');
  if (url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback(url.hostname))) return url.href;
  throw new McpInputError('O endereço precisa começar com https:// (http só é aceito para este computador).');
}

export const commandLineOf = (config: McpServerConfig): string => (config.transport.type === 'stdio' ? [config.transport.command, ...config.transport.args].join(' ') : config.transport.url);

/**
 * Everything behind the Jira connection that main owns: which servers are saved (in a plain file, no secret), their secrets
 * (encrypted with the OS), and keeping the engine connected to them. The page only ever sees summaries.
 */
export class McpService {
  /** What the engine said last time it was configured: which servers are connected, with how many tools. */
  private connected = new Map<string, { ok: boolean; tools: number; capabilities?: McpServerSummary['capabilities'] }>();

  constructor(private readonly o: McpServiceOptions) {}

  view(): McpView {
    const servers: McpServerSummary[] = this.o.store.list().map((c) => {
      const creds = this.o.vault.get(c.id);
      const live = this.connected.get(c.id);
      return {
        id: c.id,
        label: c.label,
        preset: c.preset,
        transport: c.transport.type,
        address: commandLineOf(c),
        auth: c.auth,
        signedIn: this.hasSecrets(c, creds),
        connected: live?.ok === true,
        tools: live?.tools ?? 0,
        ...(live?.capabilities ? { capabilities: live.capabilities } : {}),
      };
    });
    return { servers, secureStorage: this.o.vault.available };
  }

  private hasSecrets(c: McpServerConfig, creds: McpCredentials): boolean {
    if (c.auth === 'oauth') return !!creds.oauth && !!(creds.oauth as { tokens?: unknown }).tokens;
    if (c.auth === 'token') return !!creds.token;
    if (c.transport.type === 'stdio') return c.transport.env.filter((e) => e.secret).every((e) => !!creds.env?.[e.name]);
    return true;
  }

  /** Turns what the page asked into a server with its secrets (saved ones fill in what the request leaves out). Throws McpInputError. */
  resolve(input: McpServerInput): McpResolvedServer {
    const id = input.id ?? DEFAULT_ID;
    const stored = this.o.vault.get(id);
    const atlassian = input.preset === 'atlassian';

    let config: McpServerConfig;
    const credentials: McpCredentials = {};
    if (atlassian) {
      config = { id, label: input.label ?? 'Jira (Atlassian)', preset: 'atlassian', auth: 'oauth', transport: { type: 'http', url: ATLASSIAN_MCP_URL } };
    } else if (input.transport.type === 'http') {
      config = { id, label: input.label ?? 'Jira', preset: 'custom', auth: input.auth, transport: { type: 'http', url: validateServerUrl(input.transport.url) } };
    } else {
      const names = input.transport.env.map((e) => e.name);
      if (new Set(names).size !== names.length) throw new McpInputError('Há duas variáveis com o mesmo nome.');
      if (!input.transport.command.trim()) throw new McpInputError('Informe o comando que inicia o servidor.');
      // A command takes no token and no browser sign-in: its secrets are its environment variables.
      config = {
        id,
        label: input.label ?? 'Jira',
        preset: 'custom',
        auth: 'none',
        transport: { type: 'stdio', command: input.transport.command.trim(), args: input.transport.args, env: input.transport.env.map((e) => ({ name: e.name, secret: e.secret, ...(e.secret ? {} : { value: e.value ?? '' }) })) },
      };
      const secretValues: Record<string, string> = {};
      for (const e of input.transport.env) {
        if (!e.secret) continue;
        const value = e.value ?? stored.env?.[e.name];
        if (value !== undefined) secretValues[e.name] = value;
      }
      if (Object.keys(secretValues).length > 0) credentials.env = secretValues;
    }
    if (config.auth === 'token') {
      const token = input.token ?? stored.token;
      if (!token) throw new McpInputError('Informe o token de acesso.');
      credentials.token = token;
    }
    if (config.auth === 'oauth' && stored.oauth) credentials.oauth = stored.oauth;
    return { config, credentials };
  }

  private needsSecureStorage(server: McpResolvedServer): boolean {
    return server.config.auth !== 'none' || Object.keys(server.credentials.env ?? {}).length > 0;
  }

  /** Command lines the person already allowed since the app started: testing and then saving the same one asks once. */
  private readonly approved = new Set<string>();

  private async approve(server: McpResolvedServer): Promise<void> {
    if (server.config.transport.type !== 'stdio') return;
    const line = commandLineOf(server.config);
    if (this.approved.has(line)) return;
    if (!(await this.o.approveCommand(line))) throw new McpInputError('Você não autorizou rodar esse comando neste computador.');
    this.approved.add(line);
  }

  async test(input: McpServerInput): Promise<McpTestResult> {
    const server = this.resolve(input);
    await this.approve(server);
    return this.o.engine.request('mcp.probe', { server });
  }

  /** The browser sign-in. The engine asks main to open the page and to keep what comes back (see `keepCredentials`). */
  async signIn(input: McpServerInput): Promise<McpTestResult> {
    const server = this.resolve(input);
    if (server.config.auth !== 'oauth' || server.config.transport.type !== 'http') throw new McpInputError('Esse servidor não usa login pelo navegador.');
    if (!this.o.vault.available) throw new McpInputError(NO_SECURE_STORAGE);
    // A fresh sign-in: the old tokens are not reused, but the client the server registered for us is (no new registration).
    const clientInformation = (server.credentials.oauth as { clientInformation?: unknown } | undefined)?.clientInformation;
    return this.o.engine.request('mcp.authorize', { server: { ...server, credentials: clientInformation ? { oauth: { clientInformation } } : {} } });
  }

  async save(input: McpServerInput): Promise<McpView> {
    const server = this.resolve(input);
    const before = this.o.store.get(server.config.id);
    if (!before || commandLineOf(before) !== commandLineOf(server.config)) await this.approve(server);
    if (this.needsSecureStorage(server) && !this.o.vault.available) throw new McpInputError(NO_SECURE_STORAGE);
    // The sign-in made a moment ago is already in the vault; an address that changed makes it no good.
    const kept = this.o.vault.get(server.config.id);
    const sameAddress = !before || commandLineOf(before) === commandLineOf(server.config);
    const credentials: McpCredentials = { ...server.credentials, ...(server.config.auth === 'oauth' && sameAddress && kept.oauth ? { oauth: kept.oauth } : {}) };
    this.o.vault.set(server.config.id, credentials);
    this.o.store.upsert(server.config);
    this.o.log?.info(`mcp: saved "${server.config.id}" (${server.config.transport.type}, ${server.config.auth})`);
    await this.configureEngine();
    return this.view();
  }

  async remove(id: string): Promise<McpView> {
    this.o.store.remove(id);
    this.o.vault.clear(id);
    this.connected.delete(id);
    await this.configureEngine();
    return this.view();
  }

  /** Gives the engine the saved servers (with their secrets, in memory). Never throws: a server that does not connect is just not connected. */
  async configureEngine(): Promise<void> {
    const servers: McpResolvedServer[] = this.o.store.list().map((config) => ({ config, credentials: this.o.vault.get(config.id) }));
    try {
      const { connected } = await this.o.engine.request('mcp.configure', { servers });
      this.connected = new Map(connected.map((c) => [c.id, { ok: c.ok, tools: c.tools, capabilities: c.capabilities }]));
      for (const c of connected) if (!c.ok) this.o.log?.warn(`mcp: "${c.id}" is not connected${c.error ? ` (${c.error.split('\n')[0].slice(0, 200)})` : ''}`);
    } catch (err) {
      this.o.log?.warn(`mcp: could not configure the engine: ${String((err as Error)?.message ?? err)}`);
    }
  }

  /** What the engine learned while connecting (a sign-in finished, a token was refreshed): kept encrypted. */
  keepCredentials(serverId: string, credentials: McpCredentials): void {
    if (!/^[A-Za-z0-9-]{1,40}$/.test(serverId)) return;
    try {
      // Only the sign-in state comes from the engine: a token or a secret variable is never changed from that side.
      const current = this.o.vault.get(serverId);
      this.o.vault.set(serverId, { ...current, ...(credentials.oauth ? { oauth: credentials.oauth } : {}) });
    } catch (err) {
      this.o.log?.warn(`mcp: could not keep the sign-in of "${serverId}": ${String((err as Error)?.message ?? err)}`);
    }
  }
}
