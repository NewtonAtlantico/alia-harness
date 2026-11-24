/**
 * A fake Jira MCP server for the tests: run as a local command (`tsx scripts/lib/fakeMcpServer.ts stdio`) or started
 * in-process over HTTP, with a bearer token or a (minimal) OAuth server in front. Every tool call is recorded.
 *
 * Environment of the stdio form: FAKE_MCP_LOG (file that gets one JSON line per call), FAKE_MCP_SECRET (the process
 * exits unless it equals "shh": how the tests prove a secret variable reached the command), FAKE_MCP_VARIANT
 * ("jira", the default, or "wiki": a server whose tools cannot create issues).
 */
import fs from 'node:fs';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

export interface FakeCall {
  tool: string;
  args: unknown;
}

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

export function buildFakeServer(record: (call: FakeCall) => void, variant: 'jira' | 'wiki' = 'jira'): McpServer {
  const server = new McpServer({ name: 'fake-jira', version: '1.0.0' });
  const tool = <S extends z.ZodRawShape>(name: string, description: string, shape: S, run: (args: z.infer<z.ZodObject<S>>) => ReturnType<typeof text>) =>
    server.registerTool(name, { description, inputSchema: shape }, (async (args: any) => {
      record({ tool: name, args });
      return run(args);
    }) as any);

  if (variant === 'wiki') {
    tool('wikiSearch', 'Search wiki pages', { query: z.string() }, () => text('[]'));
    tool('wikiGetPage', 'Get a wiki page', { id: z.string() }, () => text('{}'));
    return server;
  }
  let n = 0;
  tool('getAccessibleAtlassianResources', 'Sites the person can reach', {}, () => text(JSON.stringify([{ id: 'cloud-1', url: 'https://acme.atlassian.net', name: 'acme' }])));
  tool('getVisibleJiraProjects', 'Projects the person can see', { cloudId: z.string() }, () => text(JSON.stringify({ values: [{ key: 'LOJA', name: 'Loja online' }, { key: 'APP', name: 'App de entregas' }] })));
  tool('searchJiraIssuesUsingJql', 'Search issues', { cloudId: z.string().optional(), jql: z.string() }, () => text(JSON.stringify({ issues: [] })));
  tool('createJiraIssue', 'Create an issue', { cloudId: z.string().optional(), projectKey: z.string(), issueTypeName: z.string().optional(), summary: z.string() }, (a) => text(JSON.stringify({ key: `${a.projectKey}-${++n}` })));
  tool('createJiraIssueLink', 'Link two issues', { inwardIssue: z.string(), outwardIssue: z.string(), type: z.string().optional() }, () => text('linked'));
  tool('editJiraIssue', 'Edit an issue', { issueKey: z.string(), summary: z.string().optional() }, () => text('edited'));
  tool('deleteJiraIssue', 'Delete an issue', { issueKey: z.string() }, () => text('deleted'));
  return server;
}

export interface FakeHttp {
  url: string;
  calls: FakeCall[];
  /** What the server saw as the Authorization header of each MCP request. */
  authorizations: string[];
  /** Sign-in codes handed out (OAuth mode). */
  close(): Promise<void>;
}

/**
 * The server over streamable HTTP on a free port. `token`: requests need `Authorization: Bearer <token>`.
 * `oauth`: the same, but the token comes from a minimal OAuth server on the same origin (discovery, registration, authorize, token).
 */
export async function startFakeHttp(options: { token?: string; oauth?: boolean; variant?: 'jira' | 'wiki' } = {}): Promise<FakeHttp> {
  const calls: FakeCall[] = [];
  const authorizations: string[] = [];
  const accessToken = options.oauth ? `tok-${randomBytes(6).toString('hex')}` : options.token;
  const codes = new Set<string>();
  let origin = '';

  const json = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
  };
  const readBody = (req: http.IncomingMessage) =>
    new Promise<string>((resolve) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => resolve(data));
    });

  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', origin || 'http://127.0.0.1');
    if (options.oauth) {
      if (url.pathname === '/.well-known/oauth-protected-resource' || url.pathname === '/.well-known/oauth-protected-resource/mcp') return json(res, 200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
      if (url.pathname.startsWith('/.well-known/oauth-authorization-server')) {
        return json(res, 200, {
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
        });
      }
      if (url.pathname === '/register' && req.method === 'POST') {
        const meta = JSON.parse(await readBody(req));
        return json(res, 201, { ...meta, client_id: 'client-1' });
      }
      if (url.pathname === '/authorize') {
        const code = randomBytes(8).toString('hex');
        codes.add(code);
        const back = new URL(url.searchParams.get('redirect_uri')!);
        back.searchParams.set('code', code);
        back.searchParams.set('state', url.searchParams.get('state') ?? '');
        res.writeHead(302, { location: back.href }).end();
        return;
      }
      if (url.pathname === '/token' && req.method === 'POST') {
        const form = new URLSearchParams(await readBody(req));
        if (form.get('grant_type') === 'authorization_code' && codes.delete(form.get('code') ?? '')) return json(res, 200, { access_token: accessToken, token_type: 'Bearer', expires_in: 3600 });
        return json(res, 400, { error: 'invalid_grant' });
      }
    }
    if (url.pathname !== '/mcp' && url.pathname !== '/') return void res.writeHead(404).end();
    const auth = String(req.headers.authorization ?? '');
    authorizations.push(auth);
    if (accessToken && auth !== `Bearer ${accessToken}`) {
      const challenge = options.oauth ? `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` : 'Bearer';
      return json(res, 401, { error: 'unauthorized' }, { 'www-authenticate': challenge });
    }
    const body = req.method === 'POST' ? JSON.parse((await readBody(req)) || '{}') : undefined;
    const server = buildFakeServer((c) => calls.push(c), options.variant ?? 'jira');
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });

  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = (srv.address() as { port: number }).port;
  origin = `http://127.0.0.1:${port}`;
  return {
    url: `${origin}/mcp`,
    calls,
    authorizations,
    close: () =>
      new Promise<void>((resolve) => {
        srv.closeAllConnections?.();
        srv.close(() => resolve());
      }),
  };
}

// As a local command: `tsx scripts/lib/fakeMcpServer.ts stdio`
if (process.argv[2] === 'stdio') {
  if (process.env.FAKE_MCP_SECRET !== undefined && process.env.FAKE_MCP_SECRET !== 'shh') {
    console.error('fake-mcp: the secret variable is wrong');
    process.exit(2);
  }
  if (process.env.FAKE_MCP_REQUIRE_SECRET === '1' && process.env.FAKE_MCP_SECRET !== 'shh') {
    console.error('fake-mcp: FAKE_MCP_SECRET is required');
    process.exit(2);
  }
  const log = process.env.FAKE_MCP_LOG;
  const server = buildFakeServer((c) => log && fs.appendFileSync(log, `${JSON.stringify(c)}\n`), process.env.FAKE_MCP_VARIANT === 'wiki' ? 'wiki' : 'jira');
  await server.connect(new StdioServerTransport());
}
