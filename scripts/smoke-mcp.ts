import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AliaConfig } from '../src/core/config.js';
import { createSession } from '../src/core/session.js';
import { bundledSkillsDir } from '../src/core/skills/skillLoader.js';
import { ToolRegistry } from '../src/core/tools/index.js';
import { McpManager, mcpToolName, projectsFrom } from '../src/core/mcp/mcpManager.js';
import { assessMcpCapabilities, isDestructiveMcpTool } from '../src/core/mcp/mcpCapabilities.js';
import { authorizeMcp, McpOAuthProvider, startLoopback } from '../src/core/mcp/mcpOAuth.js';
import { readJiraTarget, writeJiraTarget } from '../src/core/mcp/jiraTarget.js';
import { JIRA_TARGET_FILE, type McpResolvedServer } from '../src/core/mcp/types.js';
import { FakeModel } from './lib/fakeModel.js';
import { startFakeHttp } from './lib/fakeMcpServer.js';

let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.log(`  ✘ ${name} ${extra}`);
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeServerFile = path.join(here, 'lib', 'fakeMcpServer.ts');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alia-mcp-'));

/** The fake server as a local command, the way a person would set one up. */
function stdioServer(extraEnv: Array<{ name: string; value?: string; secret: boolean }> = [], secrets: Record<string, string> = {}, id = 'jira'): McpResolvedServer {
  return {
    config: {
      id,
      label: 'Jira',
      preset: 'custom',
      auth: 'none',
      transport: { type: 'stdio', command: process.execPath, args: ['--import', 'tsx', fakeServerFile, 'stdio'], env: extraEnv },
    },
    credentials: { env: secrets },
  };
}
function httpServer(url: string, auth: 'token' | 'oauth' | 'none', credentials: McpResolvedServer['credentials'] = {}): McpResolvedServer {
  return { config: { id: 'jira', label: 'Jira', preset: 'custom', auth, transport: { type: 'http', url } }, credentials };
}

console.log('=== what a server can do, from its tool names ===');
{
  const caps = assessMcpCapabilities(['getVisibleJiraProjects', 'createJiraIssue', 'createJiraIssueLink', 'wikiSearch']);
  check('Atlassian names: creates issues, lists projects, links issues', caps.createsIssues && caps.listsProjects && caps.linksIssues);
  const other = assessMcpCapabilities(['jira_create_issue', 'jira_get_all_projects']);
  check('snake_case names of another Jira server are recognised', other.createsIssues && other.listsProjects && !other.linksIssues);
  const none = assessMcpCapabilities(['wikiSearch', 'getPage']);
  check('a wiki server creates nothing', !none.createsIssues && !none.listsProjects && !none.linksIssues);
  check('delete/remove tools are destructive', ['deleteJiraIssue', 'jira_delete_issue', 'removeLabel', 'mcp__x__archive_project'].every(isDestructiveMcpTool));
  check('create/edit/link/search tools are not', ['createJiraIssue', 'editJiraIssue', 'createJiraIssueLink', 'searchJiraIssuesUsingJql', 'getJiraIssue'].every((n) => !isDestructiveMcpTool(n)));
  check('tool names are mcp__<server>__<tool> and fit 64 characters', mcpToolName('jira', 'createJiraIssue') === 'mcp__jira__createJiraIssue' && mcpToolName('jira', 'x'.repeat(100)).length === 64);
  check('projects are found in a list of { key, name } wherever it sits', projectsFrom(JSON.stringify({ values: [{ key: 'A', name: 'Alpha' }] }))[0]?.key === 'A' && projectsFrom('[{"key":"B","name":"Beta"}]')[0]?.name === 'Beta' && projectsFrom('no json').length === 0);
}

console.log('\n=== a local command ===');
const manager = new McpManager();
{
  const log = path.join(tmp, 'calls.jsonl');
  const server = stdioServer([{ name: 'FAKE_MCP_LOG', value: log, secret: false }, { name: 'FAKE_MCP_SECRET', secret: true }], { FAKE_MCP_SECRET: 'shh' });
  const probe = await manager.probe(server);
  check('it connects, lists its tools and can create issues', probe.ok && probe.toolCount === 7 && probe.capabilities.createsIssues && probe.capabilities.listsProjects && probe.capabilities.linksIssues, JSON.stringify(probe));

  const wrongSecret = await manager.probe(stdioServer([{ name: 'FAKE_MCP_SECRET', secret: true }], { FAKE_MCP_SECRET: 'nope' }));
  check('the secret variable really reaches the command (a wrong one makes it exit)', !wrongSecret.ok && wrongSecret.reason !== 'no_issue_tool', JSON.stringify(wrongSecret));

  const wiki = await manager.probe(stdioServer([{ name: 'FAKE_MCP_VARIANT', value: 'wiki', secret: false }]));
  check('a server that cannot create issues is refused, saying how many tools it has', !wiki.ok && wiki.reason === 'no_issue_tool' && wiki.toolCount === 2 && !wiki.capabilities.createsIssues, JSON.stringify(wiki));

  const missing = await manager.probe({ config: { ...server.config, transport: { type: 'stdio', command: 'alia-no-such-command-xyz', args: [], env: [] } }, credentials: {} });
  check('a command that does not exist is a configuration problem', !missing.ok && missing.reason === 'bad_config', JSON.stringify(missing));

  const [connected] = await manager.configure([server]);
  check('configure connects it', connected.ok && connected.tools === 7, JSON.stringify(connected));
  const names = manager.toolDefinitions().map((t) => t.name);
  check('its tools are named mcp__jira__<tool>', names.includes('mcp__jira__createJiraIssue') && names.includes('mcp__jira__searchJiraIssuesUsingJql'));
  check('...and the destructive one is never offered', !names.some((n) => n.endsWith('deleteJiraIssue')));

  const create = manager.toolDefinitions().find((t) => t.name === 'mcp__jira__createJiraIssue')!;
  const out = await create.execute({ projectKey: 'LOJA', summary: 'T-001 Cadastro' }, { workingDirectory: tmp } as any);
  check('calling the tool reaches the server and returns its answer', out.includes('LOJA-1'), out);
  check('the call was recorded by the server with its arguments', fs.readFileSync(log, 'utf8').includes('"summary":"T-001 Cadastro"'));

  const projects = await manager.projects('jira');
  check('projects are listed through the site the server reports', projects.listed && projects.projects.length === 2 && projects.projects[0].key === 'LOJA' && projects.projects[0].site === 'https://acme.atlassian.net', JSON.stringify(projects));

  const [again] = await manager.configure([server]);
  check('configure with the same server keeps the connection', again.ok);
  const none = await manager.configure([]);
  check('configure without it disconnects it and removes its tools', none.length === 0 && manager.toolDefinitions().length === 0);
}

console.log('\n=== through a session ===');
{
  const config: AliaConfig = { name: 't', vendor: 't', apiKey: 'k', apiType: 'chat-completions', models: [{ id: 'fake-model', name: 'fake', url: 'http://fake', toolCalling: true }] };
  const ws = path.join(tmp, 'ws');
  fs.mkdirSync(ws);
  const session = createSession({ workspace: ws, config, client: new FakeModel([]).client, skillRoots: [{ label: 'bundled', dir: bundledSkillsDir() }], permissionsDir: path.join(tmp, 'perm'), mcp: manager });
  const skill = () => session.skills.get('add-tasks-to-jira')!;
  check('before a server is connected the Jira skill is unavailable', !session.skills.isAvailable(skill()));
  await manager.configure([stdioServer()]);
  check('a server connected AFTER the conversation opened makes its tools available at once', session.tools.get('mcp__jira__createJiraIssue') !== undefined && session.skills.isAvailable(skill()));
  const status = await session.issuePublishing({ probe: async () => ({ code: null, stdout: '', missing: true, timedOut: false }) });
  check('publishing detects it: through MCP, with the Jira skill', status.mode === 'publish' && status.via === 'mcp' && status.skill === 'add-tasks-to-jira', JSON.stringify(status));
  const child = session.tools.without(['run_subagent'], 'x');
  check('the registry copies carry the MCP tools too (a subagent drops them separately, in run_subagent)', child.get('mcp__jira__createJiraIssue') !== undefined);
  await manager.configure([]);
  check('and when the server goes away so do the tools', session.tools.get('mcp__jira__createJiraIssue') === undefined && !session.skills.isAvailable(skill()));
  session.dispose();
  check('a registry without a dynamic source is unchanged', new ToolRegistry().getAll().length === 6);
}

console.log('\n=== over HTTP with a token ===');
{
  const fake = await startFakeHttp({ token: 'secret-token' });
  const good = await manager.probe(httpServer(fake.url, 'token', { token: 'secret-token' }));
  check('the token is sent as a bearer on every request', good.ok && fake.authorizations.length > 0 && fake.authorizations.every((a) => a === 'Bearer secret-token'), JSON.stringify(good));
  const bad = await manager.probe(httpServer(fake.url, 'token', { token: 'wrong' }));
  check('a wrong token is "unauthorized", not "unreachable"', !bad.ok && bad.reason === 'unauthorized', JSON.stringify(bad));
  const none = await manager.probe(httpServer(fake.url, 'none'));
  check('no token against a server that wants one is "unauthorized" too', !none.ok && none.reason === 'unauthorized', JSON.stringify(none));
  await fake.close();
  const gone = await manager.probe(httpServer(fake.url, 'token', { token: 'secret-token' }));
  check('a server that is not there is "unreachable"', !gone.ok && gone.reason === 'unreachable', JSON.stringify(gone));
  const invalid = await manager.probe(httpServer('not a url', 'none'));
  check('an address that is not an address is a configuration problem', !invalid.ok && invalid.reason === 'bad_config', JSON.stringify(invalid));
}

console.log('\n=== signing in through the browser (OAuth) ===');
{
  const fake = await startFakeHttp({ oauth: true });
  const server = httpServer(fake.url, 'oauth');
  const saved: Array<Record<string, unknown>> = [];

  const quiet = await manager.probe(server);
  check('without a sign-in the connection says it needs one (and opens nothing)', !quiet.ok && quiet.reason === 'needs_sign_in', JSON.stringify(quiet));

  // The "browser": follows the sign-in page's redirect back to the address on this computer.
  const opened: string[] = [];
  const oauth = await authorizeMcp(server, {
    openUrl: async (url) => {
      opened.push(url);
      const hop = await fetch(url, { redirect: 'manual' });
      const back = hop.headers.get('location')!;
      await fetch(back);
    },
    onSaved: (o) => saved.push(o as Record<string, unknown>),
  });
  check('the sign-in page was opened once, with PKCE and a state', opened.length === 1 && /code_challenge=/.test(opened[0]) && /state=/.test(opened[0]));
  check('the client the server registered and the tokens it gave are returned', !!oauth.clientInformation && !!oauth.tokens && saved.length >= 2);

  const signedIn = { ...server, credentials: { oauth } };
  const withTokens = new McpManager({ authProviderFor: (s) => new McpOAuthProvider({ initial: s.credentials.oauth }) });
  const after = await withTokens.probe(signedIn);
  check('afterwards the saved tokens connect without opening anything', after.ok && after.capabilities.createsIssues, JSON.stringify(after));
  await withTokens.close();

  // The listener only accepts the browser coming back with the state it was waiting for.
  const loop = await startLoopback(() => 'right-state', 5000);
  const wrong = await fetch(`${loop.redirectUrl}?code=abc&state=wrong`);
  check('a callback with the wrong state is refused', wrong.status === 400);
  await loop.code.then(() => check('...and rejects the sign-in', false), (e) => check('...and rejects the sign-in', /did not match/.test(String(e.message))));
  const other = await startLoopback(() => 's', 5000);
  const notFound = await fetch(other.redirectUrl.replace('/callback', '/other'));
  check('any other path on the listener is a 404', notFound.status === 404);
  other.close();
  await fake.close();
}

console.log('\n=== where the tasks go in Jira ===');
{
  const ws = path.join(tmp, 'target');
  fs.mkdirSync(ws);
  check('nothing saved yet: no target', readJiraTarget(ws) === null);
  const saved = writeJiraTarget(ws, { serverId: 'jira', projectKey: 'loja', projectName: 'Loja online', site: 'https://acme.atlassian.net' });
  check('the key is normalised to upper case and saved in the project', saved?.projectKey === 'LOJA' && fs.existsSync(path.join(ws, JIRA_TARGET_FILE)));
  check('it reads back the same', JSON.stringify(readJiraTarget(ws)) === JSON.stringify(saved));
  fs.writeFileSync(path.join(ws, JIRA_TARGET_FILE), '{ nope');
  check('a damaged file reads as no target', readJiraTarget(ws) === null);
  check('null removes it', writeJiraTarget(ws, null) === null && !fs.existsSync(path.join(ws, JIRA_TARGET_FILE)));
}

await manager.close();
fs.rmSync(tmp, { recursive: true, force: true });
if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll MCP checks passed.');
process.exit(0);
