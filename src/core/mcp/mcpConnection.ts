import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, DEFAULT_INHERITED_ENV_VARS } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpFailure, McpResolvedServer } from './types.js';

/** One tool a server offers, as the protocol describes it. */
export interface McpTool {
  name: string;
  description?: string;
  inputSchema: { type: 'object'; properties?: Record<string, unknown>; required?: string[] };
}

export interface McpCallResult {
  text: string;
  isError: boolean;
}

/** A live connection to one MCP server. */
export interface McpConnection {
  readonly serverId: string;
  readonly tools: McpTool[];
  /** True once the server went away (the process exited, the connection dropped). */
  readonly closed: boolean;
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult>;
  close(): Promise<void>;
}

export interface ConnectOptions {
  /** OAuth: gives the SDK the saved client and tokens, and opens the sign-in page when they are missing or expired. */
  authProvider?: OAuthClientProvider;
  /** How long to wait for the server to answer (default 20 s; 60 s for a local command, which may have to download itself first). */
  timeoutMs?: number;
}

/** A connection that did not work, with the reason the person can act on. */
export class McpConnectError extends Error {
  constructor(
    readonly reason: McpFailure,
    message: string
  ) {
    super(message);
    this.name = 'McpConnectError';
  }
}

const CALL_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 100_000;
const CLIENT_INFO = { name: 'alia-harness', version: '1.0.0' };

/** What a remote server needs on every request when the person gave a token. */
function bearerHeaders(server: McpResolvedServer): Record<string, string> {
  return server.config.auth === 'token' && server.credentials.token ? { Authorization: `Bearer ${server.credentials.token}` } : {};
}

/** The environment of a local command: a minimal safe base, then the variables the person set (secret ones from the encrypted store). */
export function stdioEnvironment(server: McpResolvedServer): Record<string, string> {
  const t = server.config.transport;
  // Only a short list of harmless variables (PATH, HOME, ...) is passed on: the command does not see this app's other secrets.
  const env: Record<string, string> = {};
  for (const key of DEFAULT_INHERITED_ENV_VARS) {
    const value = process.env[key];
    if (value !== undefined && !value.startsWith('()')) env[key] = value;
  }
  if (t.type !== 'stdio') return env;
  for (const v of t.env) {
    const value = v.secret ? server.credentials.env?.[v.name] : v.value;
    if (value !== undefined) env[v.name] = value;
  }
  return env;
}

/** Builds the transports to try, in order. A remote server is tried over streamable HTTP, then over the older SSE. */
export function buildTransports(server: McpResolvedServer, options: ConnectOptions = {}): Array<{ kind: 'stdio' | 'streamable-http' | 'sse'; create: () => Transport }> {
  const t = server.config.transport;
  if (t.type === 'stdio') {
    return [
      {
        kind: 'stdio',
        create: () => new StdioClientTransport({ command: t.command, args: t.args, env: stdioEnvironment(server), stderr: 'pipe' }),
      },
    ];
  }
  let url: URL;
  try {
    url = new URL(t.url);
  } catch {
    throw new McpConnectError('bad_config', `"${t.url}" is not a valid address.`);
  }
  const headers = bearerHeaders(server);
  const authProvider = options.authProvider;
  // Servers that offer both keep the older event-stream protocol at `/sse` where the newer one is at `/mcp`.
  const sseUrl = new URL(url);
  if (sseUrl.pathname.endsWith('/mcp')) sseUrl.pathname = sseUrl.pathname.replace(/\/mcp$/, '/sse');
  return [
    { kind: 'streamable-http', create: () => new StreamableHTTPClientTransport(url, { authProvider, requestInit: { headers } }) },
    {
      kind: 'sse',
      create: () =>
        new SSEClientTransport(sseUrl, {
          authProvider,
          requestInit: { headers },
          // The event stream is a GET the SDK makes with its own fetch: the token has to ride on it too.
          eventSourceInit: {
            fetch: (input: string | URL | Request, init?: RequestInit) => fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), ...headers } }),
          },
        }),
    },
  ];
}

/** Turns whatever the SDK or the network threw into a reason the person can act on. */
export function classifyMcpError(err: unknown, server: McpResolvedServer): McpConnectError {
  if (err instanceof McpConnectError) return err;
  const message = String((err as Error)?.message ?? err);
  const code = (err as { code?: unknown })?.code;
  const oauth = server.config.auth === 'oauth';
  if (err instanceof UnauthorizedError || code === 401 || code === 403 || /\b(401|403)\b|unauthori[sz]ed|forbidden/i.test(message)) {
    return new McpConnectError(oauth ? 'needs_sign_in' : 'unauthorized', message);
  }
  // Windows answers a missing command through cmd.exe, in the system's language ("não é reconhecido como um comando").
  if (server.config.transport.type === 'stdio' && (code === 'ENOENT' || /ENOENT|not recognized|reconhecido|not found|n.o encontrado|cannot find/i.test(message))) {
    return new McpConnectError('bad_config', `The command could not be started: ${message}`);
  }
  if (/timed? ?out|AbortError/i.test(message)) return new McpConnectError('timeout', message);
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|EHOSTUNREACH|fetch failed|getaddrinfo|certificate|socket hang up|network/i.test(message)) return new McpConnectError('unreachable', message);
  return new McpConnectError('other', message);
}

function withTimeout<T>(work: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new McpConnectError('timeout', `The server did not answer in ${Math.round(ms / 1000)} seconds.`));
    }, ms);
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

async function listAllTools(client: Client): Promise<McpTool[]> {
  const tools: McpTool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const res = await client.listTools(cursor ? { cursor } : undefined);
    for (const t of res.tools) {
      tools.push({ name: t.name, ...(t.description ? { description: t.description } : {}), inputSchema: t.inputSchema as McpTool['inputSchema'] });
    }
    cursor = res.nextCursor;
    if (!cursor) break;
  }
  return tools;
}

/** Plain text out of a tool result: text parts joined, other parts named. Capped, so one answer cannot fill the context. */
export function flattenToolResult(res: { content?: unknown; structuredContent?: unknown; isError?: unknown }): McpCallResult {
  const parts: string[] = [];
  if (Array.isArray(res.content)) {
    for (const c of res.content as Array<Record<string, any>>) {
      if (c?.type === 'text' && typeof c.text === 'string') parts.push(c.text);
      else if (c?.type === 'image') parts.push('[image]');
      else if (c?.type === 'audio') parts.push('[audio]');
      else if (c?.type === 'resource' && c.resource) parts.push(typeof c.resource.text === 'string' ? c.resource.text : `[resource ${String(c.resource.uri ?? '')}]`);
      else if (c?.type === 'resource_link') parts.push(`[link ${String(c.uri ?? '')}]`);
    }
  }
  if (parts.length === 0 && res.structuredContent !== undefined) parts.push(JSON.stringify(res.structuredContent));
  let text = parts.join('\n');
  if (text.length > MAX_OUTPUT_CHARS) text = `${text.slice(0, MAX_OUTPUT_CHARS)}\n[output cut at ${MAX_OUTPUT_CHARS} characters]`;
  return { text, isError: res.isError === true };
}

class Connection implements McpConnection {
  closed = false;
  constructor(
    readonly serverId: string,
    private readonly client: Client,
    private readonly transport: Transport,
    readonly tools: McpTool[]
  ) {
    client.onclose = () => {
      this.closed = true;
    };
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult> {
    const res = await this.client.callTool({ name, arguments: args }, undefined, { signal, timeout: CALL_TIMEOUT_MS });
    return flattenToolResult(res as Record<string, unknown>);
  }

  async close(): Promise<void> {
    this.closed = true;
    try {
      await this.client.close();
    } catch {
      /* already gone */
    }
    try {
      await this.transport.close();
    } catch {
      /* already gone */
    }
  }
}

/**
 * Connects to a server and lists its tools. Throws `McpConnectError` with a reason. A server that asks for a sign-in
 * (`needs_sign_in`) or rejects the token (`unauthorized`) is not retried over another transport.
 */
export async function connectMcp(server: McpResolvedServer, options: ConnectOptions = {}): Promise<McpConnection> {
  const timeoutMs = options.timeoutMs ?? (server.config.transport.type === 'stdio' ? 60_000 : 20_000);
  let first: McpConnectError | undefined;
  for (const attempt of buildTransports(server, options)) {
    const client = new Client(CLIENT_INFO, { capabilities: {} });
    let transport: Transport | undefined;
    try {
      transport = attempt.create();
      const t = transport;
      const tail = captureStderr(t);
      try {
        await withTimeout(client.connect(t), timeoutMs, () => void t.close().catch(() => {}));
        const tools = await withTimeout(listAllTools(client), timeoutMs, () => void t.close().catch(() => {}));
        return new Connection(server.config.id, client, t, tools);
      } catch (err) {
        const detail = tail();
        throw detail && !(err instanceof McpConnectError && err.reason === 'timeout') ? new Error(`${String((err as Error)?.message ?? err)}\n${detail}`, { cause: err }) : err;
      }
    } catch (err) {
      await Promise.allSettled([client.close(), transport?.close()]);
      const failure = classifyMcpError(err, server);
      first ??= failure;
      if (failure.reason === 'needs_sign_in' || failure.reason === 'unauthorized' || failure.reason === 'timeout' || failure.reason === 'bad_config') throw failure;
    }
  }
  throw first ?? new McpConnectError('other', 'No way to reach the server.');
}

/** Keeps the last of a local command's error output, to explain why it did not start. */
function captureStderr(transport: Transport): () => string {
  let tail = '';
  const stderr = (transport as StdioClientTransport).stderr;
  stderr?.on?.('data', (chunk: Buffer) => {
    tail = (tail + String(chunk)).slice(-1500);
  });
  return () => tail.trim();
}
