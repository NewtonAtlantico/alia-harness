import fs from 'node:fs';
import path from 'node:path';
import type { McpCredentials, McpServerConfig } from 'alia-harness/core';
import type { Encryptor } from './secrets';

/** Where the MCP servers are kept, and what is kept about each. No secret is ever in the config file. */
interface StoredMcp {
  version: 1;
  servers: McpServerConfig[];
}

const ID = /^[A-Za-z0-9-]{1,40}$/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Keeps what is usable of a saved server; anything malformed is dropped rather than failing the app's start. */
function normalizeServer(raw: unknown): McpServerConfig | undefined {
  if (!isObject(raw) || typeof raw.id !== 'string' || !ID.test(raw.id)) return undefined;
  const preset = raw.preset === 'atlassian' ? 'atlassian' : 'custom';
  const auth = raw.auth === 'oauth' || raw.auth === 'token' ? raw.auth : 'none';
  const t = raw.transport;
  if (!isObject(t)) return undefined;
  const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim().slice(0, 100) : 'Jira';
  if (t.type === 'http' && typeof t.url === 'string' && t.url.length <= 2048) return { id: raw.id, label, preset, auth, transport: { type: 'http', url: t.url } };
  if (t.type === 'stdio' && typeof t.command === 'string' && t.command.trim()) {
    const args = Array.isArray(t.args) ? t.args.filter((a): a is string => typeof a === 'string').slice(0, 50) : [];
    const env = Array.isArray(t.env)
      ? t.env
          .filter(isObject)
          .filter((e) => typeof e.name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(e.name))
          .slice(0, 50)
          .map((e) => ({ name: e.name as string, secret: e.secret === true, ...(e.secret !== true && typeof e.value === 'string' ? { value: e.value } : {}) }))
      : [];
    return { id: raw.id, label, preset, auth, transport: { type: 'stdio', command: t.command, args, env } };
  }
  return undefined;
}

export class McpConfigStore {
  private current?: McpServerConfig[];

  constructor(private readonly file: string) {}

  list(): McpServerConfig[] {
    if (this.current) return this.current;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as unknown;
      const servers = isObject(raw) && Array.isArray(raw.servers) ? raw.servers.map(normalizeServer).filter((s): s is McpServerConfig => !!s) : [];
      this.current = servers.filter((s, i) => servers.findIndex((x) => x.id === s.id) === i);
    } catch {
      this.current = [];
    }
    return this.current;
  }

  get(id: string): McpServerConfig | undefined {
    return this.list().find((s) => s.id === id);
  }

  upsert(server: McpServerConfig): void {
    const next = this.list().filter((s) => s.id !== server.id);
    next.push(server);
    this.write(next);
  }

  remove(id: string): void {
    this.write(this.list().filter((s) => s.id !== id));
  }

  private write(servers: McpServerConfig[]): void {
    const data: StoredMcp = { version: 1, servers };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
    fs.renameSync(tmp, this.file);
    this.current = servers;
  }
}

/**
 * The secrets of every server (tokens, secret variables, the browser sign-in), encrypted with the operating system and kept
 * in one file, like the API key. When the OS cannot encrypt, nothing is stored: there is no plain-text fallback.
 */
export class McpVault {
  constructor(
    private readonly file: string,
    private readonly encryptor: Encryptor
  ) {}

  get available(): boolean {
    return this.encryptor.isAvailable();
  }

  private readAll(): Record<string, McpCredentials> {
    try {
      const parsed = JSON.parse(this.encryptor.decrypt(fs.readFileSync(this.file))) as unknown;
      return isObject(parsed) ? (parsed as Record<string, McpCredentials>) : {};
    } catch {
      return {};
    }
  }

  get(id: string): McpCredentials {
    const all = this.readAll();
    return Object.prototype.hasOwnProperty.call(all, id) && isObject(all[id]) ? all[id] : {};
  }

  /** Replaces the secrets of one server. An empty set removes its entry. */
  set(id: string, credentials: McpCredentials): void {
    const empty = !credentials.token && !credentials.oauth && (!credentials.env || Object.keys(credentials.env).length === 0);
    const all = this.readAll();
    // Nothing to forget and nothing to keep: the file is left alone (it could not even be rewritten without secure storage).
    if (empty && !Object.prototype.hasOwnProperty.call(all, id)) return;
    if (empty) delete all[id];
    else all[id] = credentials;
    if (Object.keys(all).length === 0) {
      fs.rmSync(this.file, { force: true });
      return;
    }
    if (!this.encryptor.isAvailable()) throw new Error('This computer cannot encrypt secrets, so nothing was stored. Secrets are never written in plain text.');
    const data = this.encryptor.encrypt(JSON.stringify(all));
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, this.file);
  }

  clear(id: string): void {
    this.set(id, {});
  }
}
