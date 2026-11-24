/**
 * The Jira connection through MCP, from the engine and main's side: the engine keeps the servers connected and gives their
 * tools to conversations, "Publicar no Jira" runs the Jira skill through them, and main keeps the config and the secrets apart.
 * Uses a fake Jira MCP server (root scripts/lib/fakeMcpServer.ts) and the fake model. Run from desktop/: `npm run test:mcp`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AliaConfig, McpResolvedServer } from 'alia-harness/core';
import { FakeModel } from '../../scripts/lib/fakeModel';
import { startFakeHttp } from '../../scripts/lib/fakeMcpServer';
import { EngineRuntime } from '../src/engine/runtime';
import { Broker, ProjectRegistry } from '../src/main/broker';
import { McpConfigStore, McpVault } from '../src/main/mcpStore';
import { ATLASSIAN_MCP_URL, McpInputError, McpService, validateServerUrl } from '../src/main/mcpService';
import type { Encryptor } from '../src/main/secrets';
import type { PushMessage } from '../src/shared/ipc';
import { IpcValidationError, parseRendererRequest } from '../src/shared/schemas';

let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.log(`  ✘ ${name} ${extra}`);
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeServerFile = path.resolve(here, '../../scripts/lib/fakeMcpServer.ts');
const skillsDir = path.resolve(here, '../../skills');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alia-mcp-app-'));
const mk = (label: string) => fs.mkdtempSync(path.join(tmp, `${label}-`));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const config: AliaConfig = { name: 't', vendor: 't', apiKey: 'k', apiType: 'chat-completions', models: [{ id: 'fake-model', name: 'fake', url: 'http://fake', toolCalling: true }] };

function stdioServer(env: Array<{ name: string; value?: string; secret: boolean }> = [], secrets: Record<string, string> = {}): McpResolvedServer {
  return {
    config: { id: 'jira', label: 'Jira', preset: 'custom', auth: 'none', transport: { type: 'stdio', command: process.execPath, args: ['--import', 'tsx', fakeServerFile, 'stdio'], env } },
    credentials: { env: secrets },
  };
}

console.log('=== the engine: servers, tools and "Publicar no Jira" ===');
{
  const messages: Array<Record<string, any>> = [];
  const model = new FakeModel([{ content: 'publicado' }], 'repeat-last');
  const rt = new EngineRuntime({ post: (m) => messages.push(m as Record<string, any>), clientFor: () => model.client, issueProbe: async () => ({ code: null, stdout: '', missing: true, timedOut: false }) });
  await rt.handle('engine.configure', { config, skillRoots: [{ label: 'bundled', dir: skillsDir }], dataDirs: { sessions: mk('sessions'), permissions: mk('permissions') } });
  const call = (name: string, payload: object = {}) => rt.handle(name as any, payload as any) as Promise<any>;
  const ws = mk('project');
  const { sessionId } = await call('session.open', { projectPath: ws });
  const fails = (name: string, payload: object) => call(name, payload).then(() => '', (e: Error) => e.message);

  check('before a server is connected, "Publicar no Jira" refuses: no project was chosen', (await fails('issues.publish', { sessionId, destination: 'jira' })).includes('No Jira project'));

  const log = path.join(tmp, 'calls.jsonl');
  const server = stdioServer([{ name: 'FAKE_MCP_LOG', value: log, secret: false }, { name: 'FAKE_MCP_SECRET', secret: true }], { FAKE_MCP_SECRET: 'shh' });
  const { connected } = await call('mcp.configure', { servers: [server] });
  check('mcp.configure connects it and says what it can do', connected[0].ok && connected[0].tools === 7 && connected[0].capabilities.createsIssues && connected[0].capabilities.listsProjects, JSON.stringify(connected));

  check('with a connection but no project chosen it still refuses', (await fails('issues.publish', { sessionId, destination: 'jira' })).includes('No Jira project'));
  const projects = await call('mcp.projects', { serverId: 'jira' });
  check('mcp.projects lists the projects of the site', projects.listed && projects.projects.map((p: any) => p.key).join() === 'LOJA,APP');

  check('there is no target yet', (await call('jira.getTarget', { projectPath: ws })) === null);
  const saved = await call('jira.setTarget', { projectPath: ws, target: { serverId: 'jira', projectKey: 'loja', projectName: 'Loja online', site: 'https://acme.atlassian.net' } });
  check('jira.setTarget saves it in the project (key in capitals), and jira.getTarget reads it back', saved.projectKey === 'LOJA' && fs.existsSync(path.join(ws, 'docs/tasks/.jira-target.json')) && (await call('jira.getTarget', { projectPath: ws })).projectName === 'Loja online');

  const started = await call('issues.publish', { sessionId, destination: 'jira' });
  const finishedAt = Date.now() + 8000;
  while (Date.now() < finishedAt && !messages.some((m) => m.kind === 'event' && m.event?.type === 'run_finished')) await sleep(20);
  const sent = JSON.stringify(model.requests[0]);
  check('it starts the Jira skill through MCP, telling the agent where the target is', started.started === true && started.via === 'mcp' && started.skill === 'add-tasks-to-jira' && sent.includes('.jira-target.json') && sent.includes('project LOJA'));
  check('the conversation says what is happening', messages.some((m) => m.kind === 'user_message' && m.text === 'Publicar no Jira'));
  check('the agent has the Jira tools in this conversation, but not the destructive one', sent.includes('mcp__jira__createJiraIssue') && !sent.includes('deleteJiraIssue'));

  const wiki = await call('mcp.probe', { server: stdioServer([{ name: 'FAKE_MCP_VARIANT', value: 'wiki', secret: false }]) });
  check('mcp.probe of a server that cannot create issues says so', !wiki.ok && wiki.reason === 'no_issue_tool' && wiki.toolCount === 2);

  await call('mcp.configure', { servers: [] });
  check('after the server is removed the publish refuses again (the tools are gone from the open conversation)', (await fails('issues.publish', { sessionId, destination: 'jira' })).includes('not available'));
  await call('session.close', { sessionId }).catch(() => {});

  // The browser sign-in, with a fake OAuth server; the "browser" is this test, answering the engine's request to open a page.
  const fake = await startFakeHttp({ oauth: true });
  const oauthServer: McpResolvedServer = { config: { id: 'jira', label: 'Jira', preset: 'custom', auth: 'oauth', transport: { type: 'http', url: fake.url } }, credentials: {} };
  const before = messages.length;
  const pending = call('mcp.authorize', { server: oauthServer });
  const opened = await (async () => {
    const end = Date.now() + 8000;
    while (Date.now() < end) {
      const m = messages.slice(before).find((x) => x.kind === 'mcp_open_url');
      if (m) return m.url as string;
      await sleep(20);
    }
    return undefined;
  })();
  if (opened) {
    const hop = await fetch(opened, { redirect: 'manual' });
    await fetch(hop.headers.get('location')!);
  }
  const signedIn = await pending;
  const kept = messages.slice(before).filter((m) => m.kind === 'mcp_credentials');
  check('the sign-in asks main to open the page, then tests the server with the new sign-in', !!opened && signedIn.ok === true && signedIn.capabilities.createsIssues, JSON.stringify(signedIn));
  check('and hands main the sign-in to keep (client and tokens), for that server', kept.length > 0 && kept.every((m) => m.serverId === 'jira') && kept.some((m) => !!m.credentials.oauth?.tokens));
  const denied = await call('mcp.authorize', { server: { ...oauthServer, config: { ...oauthServer.config, transport: { type: 'stdio', command: 'x', args: [], env: [] } } } });
  check('signing in through the browser needs an address, not a command', !denied.ok && denied.reason === 'bad_config');
  await fake.close();
  await call('mcp.configure', { servers: [] });
}

console.log('\n=== main: what is kept, and where ===');
{
  const dir = mk('main');
  const fakeEncryptor = (available = true): Encryptor => ({ isAvailable: () => available, encrypt: (plain) => Buffer.from(`enc:${plain}`).reverse(), decrypt: (data) => Buffer.from(data).reverse().toString().replace(/^enc:/, '') });
  const requests: Array<{ name: string; payload: any }> = [];
  const asked: string[] = [];
  let approve = true;
  let secure = true;
  const build = () => {
    const vault = new McpVault(path.join(dir, 'mcp-credentials.bin'), { ...fakeEncryptor(), isAvailable: () => secure });
    const store = new McpConfigStore(path.join(dir, 'mcp.json'));
    const service = new McpService({
      store,
      vault,
      engine: {
        request: async (name: any, payload: any) => {
          requests.push({ name, payload });
          if (name === 'mcp.configure') return { connected: payload.servers.map((s: any) => ({ id: s.config.id, ok: true, tools: 7, capabilities: { createsIssues: true, listsProjects: true, linksIssues: true } })) } as any;
          return { ok: true, toolCount: 7, capabilities: { createsIssues: true, listsProjects: true, linksIssues: true } } as any;
        },
      },
      approveCommand: async (line) => (asked.push(line), approve),
    });
    return { service, vault, store };
  };
  const { service, vault } = build();
  const fails = (p: Promise<unknown>) => p.then(() => undefined, (e: Error) => e);

  check('nothing saved: an empty view that says secrets can be stored', service.view().servers.length === 0 && service.view().secureStorage === true);

  const view = await service.save({ preset: 'custom', transport: { type: 'http', url: 'https://jira.acme.com/mcp' }, auth: 'token', token: 'tok-123' });
  const configText = fs.readFileSync(path.join(dir, 'mcp.json'), 'utf8');
  const vaultBytes = fs.readFileSync(path.join(dir, 'mcp-credentials.bin'));
  check('a server with a token is saved: the view shows it connected, signed in, and never the token', view.servers[0].id === 'jira' && view.servers[0].connected && view.servers[0].signedIn && view.servers[0].tools === 7 && !JSON.stringify(view).includes('tok-123'));
  check('the config file has the address but no secret; the secret is only in the encrypted file', configText.includes('jira.acme.com') && !configText.includes('tok-123') && !vaultBytes.toString('latin1').includes('tok-123'.split('').join('')) === true && vault.get('jira').token === 'tok-123');
  const configured = requests.filter((r) => r.name === 'mcp.configure').pop()!;
  check('the engine got the server with its secret (in memory) to connect', configured.payload.servers[0].credentials.token === 'tok-123');

  const edited = await service.test({ id: 'jira', preset: 'custom', transport: { type: 'http', url: 'https://jira.acme.com/mcp' }, auth: 'token' });
  const probe = requests.filter((r) => r.name === 'mcp.probe').pop()!;
  check('testing an edit without retyping the token uses the saved one', edited.ok && probe.payload.server.credentials.token === 'tok-123');

  check('an address that is not https is refused (a token must not cross the network in the clear)', (await fails(service.test({ preset: 'custom', transport: { type: 'http', url: 'http://jira.acme.com/mcp' }, auth: 'token', token: 'x' }))) instanceof McpInputError);
  check('...but http to this computer is fine', validateServerUrl('http://127.0.0.1:8080/mcp').startsWith('http://127.0.0.1'));
  check('an address with a password in it is refused', (await fails(service.test({ preset: 'custom', transport: { type: 'http', url: 'https://u:p@jira.acme.com/mcp' }, auth: 'none' }))) instanceof McpInputError);
  check('a token connection without a token is refused', (await fails(service.test({ id: 'other', preset: 'custom', transport: { type: 'http', url: 'https://jira.acme.com/mcp' }, auth: 'token' }))) instanceof McpInputError);

  // The Atlassian preset: the address is fixed in main, whatever the page sends.
  await service.test({ preset: 'atlassian', transport: { type: 'http', url: 'https://evil.example/mcp' }, auth: 'none' });
  const atl = requests.filter((r) => r.name === 'mcp.probe').pop()!;
  check('the Atlassian preset always connects to Atlassian, with a browser sign-in, whatever address the page sent', atl.payload.server.config.transport.url === ATLASSIAN_MCP_URL && atl.payload.server.config.auth === 'oauth');

  // A command runs on this computer: a native question first (the page cannot answer it).
  asked.length = 0;
  const cmd = { preset: 'custom' as const, transport: { type: 'stdio' as const, command: 'npx', args: ['-y', '@acme/jira-mcp'], env: [{ name: 'JIRA_URL', value: 'https://jira.acme.com', secret: false }, { name: 'JIRA_TOKEN', value: 's3cret', secret: true }] }, auth: 'none' as const };
  await service.test({ ...cmd, id: 'local' });
  check('testing a local command asks first, showing the exact command', asked.length === 1 && asked[0] === 'npx -y @acme/jira-mcp');
  await service.test({ ...cmd, id: 'local' });
  check('testing the same command again does not ask again', asked.length === 1);
  approve = false;
  const probesBefore = requests.filter((r) => r.name === 'mcp.probe').length;
  const refused = await fails(service.test({ ...cmd, id: 'local', transport: { ...cmd.transport, command: 'other-cmd' } }));
  check('and if the person says no to a command, nothing runs', refused instanceof McpInputError && requests.filter((r) => r.name === 'mcp.probe').length === probesBefore);
  approve = true;
  const saved = await service.save({ ...cmd, id: 'local' });
  const cfg = fs.readFileSync(path.join(dir, 'mcp.json'), 'utf8');
  check('a saved command keeps its plain variable in the config and its secret variable only in the vault', cfg.includes('JIRA_URL') && cfg.includes('https://jira.acme.com') && !cfg.includes('s3cret') && vault.get('local').env?.JIRA_TOKEN === 's3cret' && saved.servers.length === 2);
  asked.length = 0;
  await service.save({ ...cmd, id: 'local', transport: { ...cmd.transport, env: cmd.transport.env.map((e) => (e.secret ? { name: e.name, secret: true } : e)) } });
  check('saving the same command again does not ask again, and keeps the saved secret', asked.length === 0 && vault.get('local').env?.JIRA_TOKEN === 's3cret');

  // What the engine learned while signing in is kept, but it can only ever change the sign-in.
  service.keepCredentials('jira', { oauth: { tokens: { access_token: 'a' } }, token: 'hijack', env: { X: 'y' } });
  check('a sign-in handed over by the engine is kept, and only the sign-in part', (vault.get('jira').oauth as any)?.tokens?.access_token === 'a' && vault.get('jira').token === 'tok-123' && vault.get('jira').env === undefined);
  service.keepCredentials('../bad id', { oauth: { tokens: {} } });
  check('an id that is not an id keeps nothing', Object.keys(JSON.parse(JSON.stringify(vault.get('../bad id')))).length === 0);

  const removed = await service.remove('jira');
  check('removing forgets the server and its secrets, and tells the engine', removed.servers.map((s) => s.id).join() === 'local' && Object.keys(vault.get('jira')).length === 0 && requests.filter((r) => r.name === 'mcp.configure').pop()!.payload.servers.length === 1);

  secure = false;
  const noStore = await fails(service.save({ id: 'again', preset: 'custom', transport: { type: 'http', url: 'https://jira.acme.com/mcp' }, auth: 'token', token: 'z' }));
  check('when this computer cannot encrypt, a token is not stored in plain text: it says why', noStore instanceof McpInputError && /criptografar/.test(noStore.message) && !fs.readFileSync(path.join(dir, 'mcp.json'), 'utf8').includes('again'));
  const noSignIn = await fails(service.signIn({ preset: 'atlassian', transport: { type: 'http', url: ATLASSIAN_MCP_URL }, auth: 'oauth' }));
  check('...nor can a sign-in be started that could not be kept', noSignIn instanceof McpInputError);
  const open = await service.save({ id: 'plain', preset: 'custom', transport: { type: 'http', url: 'https://jira.acme.com/mcp' }, auth: 'none' });
  check('a server with no secret needs no secure storage', open.servers.some((s) => s.id === 'plain') && open.secureStorage === false);
  secure = true;

  const reborn = build();
  check('a restart finds the saved servers again', reborn.service.view().servers.map((s) => s.id).sort().join() === 'local,plain');
  fs.writeFileSync(path.join(dir, 'mcp.json'), '{ damaged');
  check('a damaged config file reads as no servers (the app still starts)', build().service.view().servers.length === 0);
}

console.log('\n=== the page can only ask what the contract allows ===');
{
  const ok = { server: { preset: 'custom', transport: { type: 'http', url: 'https://jira.acme.com/mcp' }, auth: 'token', token: 'x' } };
  check('a well-formed request passes', (() => { try { parseRendererRequest('mcp.save', ok as any); return true; } catch { return false; } })());
  const bad = (name: any, payload: any) => { try { parseRendererRequest(name, payload); return false; } catch (e) { return e instanceof IpcValidationError; } };
  check('an unknown field is an error, not passed along', bad('mcp.save', { server: { ...ok.server, run: 'rm -rf /' } }));
  check('an environment variable name that is not a name is refused', bad('mcp.test', { server: { preset: 'custom', transport: { type: 'stdio', command: 'npx', args: [], env: [{ name: 'A B;', secret: false }] }, auth: 'none' } }));
  check('a server id with odd characters is refused', bad('mcp.remove', { id: '../x' }) && bad('mcp.projects', { serverId: 'a b' }));
  check('only "jira" is a publish destination', bad('issues.publish', { sessionId: 's1', destination: 'elsewhere' }));
  const projects = new ProjectRegistry();
  const broker = new Broker({ engine: { request: async () => null as any }, projects, pickFolder: async () => null, main: {} });
  const err = await broker.handle('jira.setTarget', { projectPath: tmp, target: null }).then(() => undefined, (e: Error) => e);
  check('the Jira target can only be written in a folder the person opened', err instanceof IpcValidationError);
}

fs.rmSync(tmp, { recursive: true, force: true });
if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll Jira connection checks passed.');
process.exit(0);
