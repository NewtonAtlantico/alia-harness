import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { ToolDefinition } from '../tools/types.js';
import { McpConnectError, connectMcp, type McpConnection, type McpTool } from './mcpConnection.js';
import { assessMcpCapabilities, isDestructiveMcpTool, isProjectListTool } from './mcpCapabilities.js';
import type { McpCapabilities, McpFailure, McpProject, McpProjectList, McpResolvedServer, McpTestResult } from './types.js';

const NO_CAPABILITIES: McpCapabilities = { createsIssues: false, listsProjects: false, linksIssues: false };

/** What `McpManager.configure` says about each server it was given. */
export interface McpConfigured {
  id: string;
  ok: boolean;
  tools: number;
  capabilities: McpCapabilities;
  error?: string;
}

export interface McpServerState {
  id: string;
  connected: boolean;
  tools: number;
  capabilities: McpCapabilities;
  error?: string;
  reason?: McpFailure;
}

export interface McpManagerOptions {
  /**
   * The OAuth provider for a server that signs in through the browser, or none. It must NOT open the browser on its own
   * (the sign-in is a separate, explicit step): without saved tokens the connection fails with `needs_sign_in`.
   */
  authProviderFor?: (server: McpResolvedServer) => OAuthClientProvider | undefined;
  log?: (message: string) => void;
}

interface Entry {
  server: McpResolvedServer;
  conn?: McpConnection;
  error?: string;
  reason?: McpFailure;
}

/** What a conversation's tool registry reads from: the tools of every server that is connected right now. */
export interface McpToolSource {
  toolDefinitions(): ToolDefinition[];
}

/** `jira` + `createJiraIssue` -> `mcp__jira__createJiraIssue`, cut to the 64 characters a function name may have. */
export function mcpToolName(serverId: string, tool: string): string {
  const safe = tool.replace(/[^A-Za-z0-9_-]/g, '_');
  return `mcp__${serverId}__${safe}`.slice(0, 64);
}

/**
 * Keeps the MCP servers the person connected, and gives their tools to the conversations as `mcp__<server>__<tool>`.
 * Nothing destructive is offered (see `isDestructiveMcpTool`). A server that fails to connect is recorded, not thrown:
 * the app still works without it.
 */
export class McpManager implements McpToolSource {
  private entries = new Map<string, Entry>();
  private tools: ToolDefinition[] = [];

  constructor(private readonly options: McpManagerOptions = {}) {}

  /** Makes these the connected servers: new or changed ones connect, ones no longer listed disconnect. Never throws. */
  async configure(servers: McpResolvedServer[]): Promise<McpConfigured[]> {
    const wanted = new Map(servers.map((s) => [s.config.id, s]));
    for (const [id, entry] of [...this.entries]) {
      const next = wanted.get(id);
      if (!next || JSON.stringify(next) !== JSON.stringify(entry.server) || !entry.conn || entry.conn.closed) {
        await entry.conn?.close();
        this.entries.delete(id);
      }
    }
    const fresh = servers.filter((s) => !this.entries.has(s.config.id));
    await Promise.all(
      fresh.map(async (server) => {
        const entry: Entry = { server };
        this.entries.set(server.config.id, entry);
        await this.connect(entry);
      })
    );
    this.rebuildTools();
    return servers.map((s) => {
      const e = this.entries.get(s.config.id)!;
      return {
        id: s.config.id,
        ok: !!e.conn,
        tools: e.conn?.tools.length ?? 0,
        capabilities: e.conn ? assessMcpCapabilities(e.conn.tools.map((t) => t.name)) : NO_CAPABILITIES,
        ...(e.error ? { error: e.error } : {}),
      };
    });
  }

  private async connect(entry: Entry): Promise<void> {
    try {
      entry.conn = await connectMcp(entry.server, { authProvider: this.options.authProviderFor?.(entry.server) });
      entry.error = undefined;
      entry.reason = undefined;
      this.options.log?.(`mcp: ${entry.server.config.id} connected (${entry.conn.tools.length} tools)`);
    } catch (err) {
      const failure = err instanceof McpConnectError ? err : new McpConnectError('other', String((err as Error)?.message ?? err));
      entry.conn = undefined;
      entry.error = failure.message;
      entry.reason = failure.reason;
      this.options.log?.(`mcp: ${entry.server.config.id} did not connect (${failure.reason})`);
    }
  }

  /** One state per server, for the settings and the report. */
  state(): McpServerState[] {
    return [...this.entries.values()].map((e) => ({
      id: e.server.config.id,
      connected: !!e.conn && !e.conn.closed,
      tools: e.conn?.tools.length ?? 0,
      capabilities: e.conn ? assessMcpCapabilities(e.conn.tools.map((t) => t.name)) : NO_CAPABILITIES,
      ...(e.error ? { error: e.error } : {}),
      ...(e.reason ? { reason: e.reason } : {}),
    }));
  }

  toolDefinitions(): ToolDefinition[] {
    return this.tools;
  }

  private rebuildTools(): void {
    const defs: ToolDefinition[] = [];
    for (const entry of this.entries.values()) {
      if (!entry.conn) continue;
      const { id, label } = entry.server.config;
      for (const tool of entry.conn.tools) {
        if (isDestructiveMcpTool(tool.name)) continue;
        defs.push(this.toDefinition(id, label, tool));
      }
    }
    this.tools = defs;
  }

  private toDefinition(serverId: string, label: string, tool: McpTool): ToolDefinition {
    const properties = (tool.inputSchema?.properties as Record<string, unknown> | undefined) ?? {};
    const required = tool.inputSchema?.required;
    return {
      name: mcpToolName(serverId, tool.name),
      description: `[${label}, MCP] ${tool.description ?? tool.name}`.slice(0, 1500),
      parameters: { type: 'object', properties, ...(required && required.length > 0 ? { required } : {}) },
      execute: async (args, context) => {
        const conn = await this.liveConnection(serverId);
        if (!conn) return `Error: the "${label}" connection is not available. Connect it again from the report screen ("Conectar ao Jira").`;
        try {
          const result = await conn.callTool(tool.name, (args ?? {}) as Record<string, unknown>, context.signal);
          return result.isError ? `Error: ${result.text || 'the server reported an error'}` : result.text || '(no output)';
        } catch (err) {
          return `Error: ${String((err as Error)?.message ?? err)}`;
        }
      },
    };
  }

  /** The connection, reconnected once if it dropped since the last call. */
  private async liveConnection(serverId: string): Promise<McpConnection | undefined> {
    const entry = this.entries.get(serverId);
    if (!entry) return undefined;
    if (entry.conn && !entry.conn.closed) return entry.conn;
    await entry.conn?.close();
    await this.connect(entry);
    this.rebuildTools();
    return entry.conn;
  }

  /** Connects once to see what a server can do. Nothing is kept. */
  async probe(server: McpResolvedServer): Promise<McpTestResult> {
    let conn: McpConnection | undefined;
    try {
      conn = await connectMcp(server, { authProvider: this.options.authProviderFor?.(server) });
      const names = conn.tools.map((t) => t.name);
      const capabilities = assessMcpCapabilities(names);
      if (!capabilities.createsIssues) {
        return { ok: false, reason: 'no_issue_tool', message: `The server offers ${names.length} tools and none of them creates issues.`, toolCount: names.length, capabilities };
      }
      return { ok: true, toolCount: names.length, capabilities };
    } catch (err) {
      const failure = err instanceof McpConnectError ? err : new McpConnectError('other', String((err as Error)?.message ?? err));
      return { ok: false, reason: failure.reason, message: failure.message, toolCount: 0, capabilities: NO_CAPABILITIES };
    } finally {
      await conn?.close();
    }
  }

  /**
   * The projects a connected server offers. Servers that are not Atlassian's say `listed: false` unless their project tool
   * answers with something that reads as a list of `{ key, name }`: then the person types the key.
   */
  async projects(serverId: string): Promise<McpProjectList> {
    const conn = await this.liveConnection(serverId);
    const none: McpProjectList = { listed: false, projects: [] };
    if (!conn) return none;
    const listTool = conn.tools.find((t) => isProjectListTool(t.name));
    if (!listTool) return none;
    try {
      const sites = await this.sites(conn);
      const wantsCloudId = 'cloudId' in ((listTool.inputSchema?.properties as Record<string, unknown> | undefined) ?? {});
      const found: McpProject[] = [];
      const targets = wantsCloudId && sites.length > 0 ? sites : [{ id: undefined, label: undefined as string | undefined }];
      for (const site of targets) {
        const res = await conn.callTool(listTool.name, site.id ? { cloudId: site.id } : {});
        if (res.isError) continue;
        for (const p of projectsFrom(res.text)) found.push({ ...p, ...(site.label ? { site: site.label } : {}) });
      }
      return found.length > 0 ? { listed: true, projects: found } : none;
    } catch {
      return none;
    }
  }

  /** Atlassian: the Jira sites the signed-in person can reach (`getAccessibleAtlassianResources`). Other servers have none. */
  private async sites(conn: McpConnection): Promise<Array<{ id: string; label: string }>> {
    const tool = conn.tools.find((t) => t.name.replace(/[_-]/g, '').toLowerCase() === 'getaccessibleatlassianresources');
    if (!tool) return [];
    const res = await conn.callTool(tool.name, {});
    if (res.isError) return [];
    const parsed = safeJson(res.text);
    const list = Array.isArray(parsed) ? parsed : Array.isArray((parsed as { resources?: unknown })?.resources) ? (parsed as { resources: unknown[] }).resources : [];
    return list
      .filter((r): r is { id: string; url?: string; name?: string } => typeof r === 'object' && r !== null && typeof (r as { id?: unknown }).id === 'string')
      .map((r) => ({ id: r.id, label: r.url ?? r.name ?? r.id }));
  }

  async close(): Promise<void> {
    const open = [...this.entries.values()];
    this.entries.clear();
    this.tools = [];
    await Promise.allSettled(open.map((e) => e.conn?.close()));
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.search(/[[{]/);
    if (start < 0) return undefined;
    try {
      return JSON.parse(text.slice(start));
    } catch {
      return undefined;
    }
  }
}

/** The first list of `{ key, name }` objects found anywhere in a tool's answer. */
export function projectsFrom(text: string): Array<{ key: string; name: string }> {
  const seen = (value: unknown, depth: number): Array<{ key: string; name: string }> | undefined => {
    if (depth > 4 || value === null || typeof value !== 'object') return undefined;
    if (Array.isArray(value)) {
      const items = value.filter((v): v is { key: string; name?: string } => typeof v === 'object' && v !== null && typeof (v as { key?: unknown }).key === 'string');
      if (items.length > 0 && items.length === value.length) return items.map((p) => ({ key: p.key, name: typeof p.name === 'string' ? p.name : p.key }));
      for (const v of value) {
        const inner = seen(v, depth + 1);
        if (inner) return inner;
      }
      return undefined;
    }
    for (const v of Object.values(value)) {
      const inner = seen(v, depth + 1);
      if (inner) return inner;
    }
    return undefined;
  };
  return seen(safeJson(text), 0) ?? [];
}
