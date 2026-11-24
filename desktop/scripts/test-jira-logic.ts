/**
 * Unit tests for the Jira connection's pure logic: the argument splitter, the form checks, the input built from the form, the
 * sentence for each failure, and which saved server is the Jira one.
 * Run from desktop/: `npm run test:jira-logic`.
 */
import type { McpServerSummary, McpTestResult, McpView } from '../src/shared/ipc';
import {
  ATLASSIAN_URL,
  atlassianInput,
  buildServerInput,
  buildTarget,
  emptyForm,
  failureText,
  formSignature,
  hasOpenQuote,
  isProjectKey,
  jiraServerFor,
  needsSecureStorage,
  normalizeKey,
  pickJiraServer,
  projectMode,
  resultProblem,
  savedServer,
  splitArgs,
  urlProblem,
  validateForm,
  type OtherForm,
} from '../src/renderer/src/lib/jira';

let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.log(`  ✘ ${name} ${extra}`);
  }
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

console.log('\n=== splitArgs: spaces and "double quotes", the way a shell reads them ===');
{
  check('plain words', same(splitArgs('-y @scope/server --flag'), ['-y', '@scope/server', '--flag']));
  check('extra spaces and edges are ignored', same(splitArgs('   a    b  '), ['a', 'b']));
  check('an empty line has no arguments', same(splitArgs(''), []) && same(splitArgs('   '), []));
  check('double quotes keep the spaces', same(splitArgs('run "my server" --x'), ['run', 'my server', '--x']), JSON.stringify(splitArgs('run "my server" --x')));
  check('a quote can sit inside a word', same(splitArgs('--name="a b"'), ['--name=a b']));
  check('an empty pair of quotes is an empty argument', same(splitArgs('a "" b'), ['a', '', 'b']));
  check('an escaped quote inside quotes is a quote', same(splitArgs('"say \\"hi\\""'), ['say "hi"']));
  check('a Windows path keeps its backslashes', same(splitArgs('C:\\Tools\\srv.exe --x'), ['C:\\Tools\\srv.exe', '--x']));
  check('a quoted Windows path with spaces', same(splitArgs('"C:\\Program Files\\srv.exe" -v'), ['C:\\Program Files\\srv.exe', '-v']));
  check('a tab or a newline also separates', same(splitArgs('a\tb\nc'), ['a', 'b', 'c']));
  check('an unclosed quote takes the rest of the line', same(splitArgs('a "b c'), ['a', 'b c']));
  check('hasOpenQuote tells an unclosed quote', hasOpenQuote('a "b c') && !hasOpenQuote('a "b c"') && !hasOpenQuote('"say \\"hi\\""') && !hasOpenQuote('plain'));
}

console.log('\n=== the address: https anywhere, http only for this computer ===');
{
  check('https is fine', urlProblem('https://mcp.empresa.com/v1/mcp') === null);
  check('http://localhost with a port is fine', urlProblem('http://localhost:8080/mcp') === null);
  check('http://127.0.0.1 and http://[::1] are fine', urlProblem('http://127.0.0.1:3000') === null && urlProblem('http://[::1]:3000/mcp') === null);
  check('http to another host is refused, and says why', (urlProblem('http://mcp.empresa.com') ?? '').includes('https'));
  check('a host that only starts like localhost is refused', urlProblem('http://localhost.evil.com') !== null && urlProblem('http://127.0.0.1.evil.com') !== null);
  check('empty and blank are refused', urlProblem('') !== null && urlProblem('   ') !== null);
  check('not an address is refused', urlProblem('mcp.empresa.com') !== null && urlProblem('not a url') !== null);
  check('another scheme is refused', urlProblem('ftp://x.com') !== null && urlProblem('file:///etc/passwd') !== null && urlProblem('javascript:alert(1)') !== null);
  check('surrounding spaces are fine', urlProblem('  https://x.com  ') === null);
}

console.log('\n=== the form: what each transport needs ===');
{
  const http = (patch: Partial<OtherForm> = {}): OtherForm => ({ ...emptyForm(), kind: 'http', url: 'https://mcp.empresa.com', ...patch });
  const stdio = (patch: Partial<OtherForm> = {}): OtherForm => ({ ...emptyForm(), kind: 'stdio', command: 'npx', args: '-y srv', ...patch });
  const row = (name: string, value: string, secret = false) => ({ name, value, secret });

  check('the empty form is not valid (the address)', !validateForm(emptyForm()).ok && !!validateForm(emptyForm()).errors.url);
  check('an http form with a good address is valid', validateForm(http()).ok);
  check('a token is required when the auth is a token', !validateForm(http({ auth: 'token' })).ok && !!validateForm(http({ auth: 'token' })).errors.token && validateForm(http({ auth: 'token', token: 'abc' })).ok);
  check('the token is not asked for with the other auths', validateForm(http({ auth: 'oauth' })).ok && validateForm(http({ auth: 'none' })).ok);
  check('http fields are not checked on a command form, and the other way round', validateForm(stdio({ url: 'nope' })).ok && validateForm(http({ command: '' })).ok);
  check('a command form needs a command', !validateForm(stdio({ command: '  ' })).ok && !!validateForm(stdio({ command: '' })).errors.command);
  check('an unclosed quote in the arguments is reported', !validateForm(stdio({ args: 'a "b' })).ok && !!validateForm(stdio({ args: 'a "b' })).errors.args);
  check('a good variable passes, a blank row is ignored', validateForm(stdio({ env: [row('JIRA_URL', 'x'), row('', '')] })).ok);
  check('a variable name must be a name', !validateForm(stdio({ env: [row('1BAD', 'x')] })).ok && !validateForm(stdio({ env: [row('A B', 'x')] })).ok && !validateForm(stdio({ env: [row('A-B', 'x')] })).ok);
  check('a value with no name is reported on its row', validateForm(stdio({ env: [row('', 'x')] })).errors.env[0] !== undefined);
  check('a repeated name is reported on the second row', validateForm(stdio({ env: [row('A', '1'), row('A', '2')] })).errors.env[1] !== undefined);

  console.log('\n=== the input the app is asked to connect ===');
  check('Atlassian: the preset, the official address, the browser sign-in, no label', same(atlassianInput(), { preset: 'atlassian', transport: { type: 'http', url: 'https://mcp.atlassian.com/v1/mcp' }, auth: 'oauth' }) && ATLASSIAN_URL === 'https://mcp.atlassian.com/v1/mcp');
  check('http + browser sign-in: no token goes along', same(buildServerInput(http({ token: 'leftover' })), { preset: 'custom', transport: { type: 'http', url: 'https://mcp.empresa.com' }, auth: 'oauth' }));
  check('http + token: the (trimmed) token goes along', same(buildServerInput(http({ auth: 'token', token: ' abc ' })), { preset: 'custom', transport: { type: 'http', url: 'https://mcp.empresa.com' }, auth: 'token', token: 'abc' }));
  check('http + none: no token', !('token' in buildServerInput(http({ auth: 'none', token: 'x' }))));
  const local = buildServerInput(stdio({ args: '-y "my srv"', env: [row('JIRA_URL', 'https://j'), row('JIRA_TOKEN', 'tok', true), row('EMPTY', '', true), row('', '')] }));
  check('a command: split arguments, auth none, no token', local.transport.type === 'stdio' && same(local.transport.args, ['-y', 'my srv']) && local.auth === 'none' && !('token' in local));
  check(
    'the variables keep their secret flag, blank rows go, an empty value is left out',
    local.transport.type === 'stdio' && same(local.transport.env, [{ name: 'JIRA_URL', value: 'https://j', secret: false }, { name: 'JIRA_TOKEN', value: 'tok', secret: true }, { name: 'EMPTY', secret: true }]),
    JSON.stringify(local.transport)
  );
  const trimmed = buildServerInput(stdio({ command: '  npx ' }));
  check('the command is trimmed', trimmed.transport.type === 'stdio' && trimmed.transport.command === 'npx');

  console.log('\n=== an edit makes a passed test stale ===');
  check('the same values give the same signature', formSignature(http()) === formSignature(http()));
  check(
    'a changed address, token, command, argument or variable changes it',
    formSignature(http()) !== formSignature(http({ url: 'https://other.com' })) &&
      formSignature(http({ auth: 'token', token: 'a' })) !== formSignature(http({ auth: 'token', token: 'b' })) &&
      formSignature(stdio()) !== formSignature(stdio({ command: 'node' })) &&
      formSignature(stdio()) !== formSignature(stdio({ args: '-y other' })) &&
      formSignature(stdio()) !== formSignature(stdio({ env: [row('A', '1')] }))
  );
  check('a change that does not reach the server (spaces around, the other transport) does not', formSignature(http()) === formSignature(http({ url: ' https://mcp.empresa.com ' })) && formSignature(http()) === formSignature(http({ command: 'x' })));

  console.log('\n=== secure storage ===');
  check(
    'a sign-in, a token and a secret variable need it; none and plain variables do not',
    needsSecureStorage(http({ auth: 'oauth' })) &&
      needsSecureStorage(http({ auth: 'token', token: 'a' })) &&
      !needsSecureStorage(http({ auth: 'none' })) &&
      needsSecureStorage(stdio({ env: [row('A', 'b', true)] })) &&
      !needsSecureStorage(stdio({ env: [row('A', 'b')] })) &&
      !needsSecureStorage(stdio())
  );
}

console.log('\n=== the sentence for each failure ===');
{
  const reasons = ['unreachable', 'unauthorized', 'needs_sign_in', 'no_issue_tool', 'timeout', 'bad_config', 'cancelled', 'other'] as const;
  const texts = reasons.map((r) => failureText(r, 3));
  check('every reason has a sentence of its own, in Portuguese', new Set(texts).size === reasons.length && texts.every((x) => x.length > 15 && /[a-zãéç]/.test(x)), texts.join(' | '));
  check('no reason says "undefined"', failureText(undefined) === failureText('other') && texts.every((x) => !x.includes('undefined')));
  check('no_issue_tool says how many tools there are and that none creates issues', failureText('no_issue_tool', 14).includes('14 ferramentas') && failureText('no_issue_tool', 14).includes('nenhuma cria issues'));
  check('no_issue_tool with one tool is singular, and tells what to check', failureText('no_issue_tool', 1).includes('1 ferramenta ') && failureText('no_issue_tool', 6).includes('token'));
  const bad: McpTestResult = { ok: false, reason: 'unreachable', message: 'ECONNREFUSED', toolCount: 0, capabilities: { createsIssues: false, listsProjects: false, linksIssues: false } };
  check("resultProblem is the sentence of the result's reason, the generic one without a reason", resultProblem(bad) === failureText('unreachable') && resultProblem({ ...bad, reason: undefined }) === failureText('other'));
}

console.log('\n=== which server is Jira ===');
{
  const caps = (createsIssues: boolean) => ({ createsIssues, listsProjects: true, linksIssues: true });
  const server = (id: string, patch: Partial<McpServerSummary> = {}): McpServerSummary => ({ id, label: id, preset: 'custom', transport: 'http', address: 'https://x', auth: 'oauth', signedIn: true, connected: true, tools: 10, capabilities: caps(true), ...patch });
  const view = (...servers: McpServerSummary[]): McpView => ({ servers, secureStorage: true });

  check('no view, no servers: none', pickJiraServer(undefined) === undefined && pickJiraServer(view()) === undefined);
  check('the first connected server that creates issues', pickJiraServer(view(server('wiki', { capabilities: caps(false) }), server('off', { connected: false }), server('jira'), server('other')))?.id === 'jira');
  check('a server with no capabilities read yet is not Jira', pickJiraServer(view(server('a', { capabilities: undefined }))) === undefined);
  check('a target needs its own server, connected and able to create issues', jiraServerFor(view(server('jira'), server('b')), { serverId: 'b', projectKey: 'X' })?.id === 'b');
  check(
    'a target whose server is gone, offline or cannot create issues is not ready',
    jiraServerFor(view(server('jira')), { serverId: 'gone', projectKey: 'X' }) === undefined &&
      jiraServerFor(view(server('jira', { connected: false })), { serverId: 'jira', projectKey: 'X' }) === undefined &&
      jiraServerFor(view(server('jira', { capabilities: caps(false) })), { serverId: 'jira', projectKey: 'X' }) === undefined
  );
  check('no target, no Jira', jiraServerFor(view(server('jira')), null) === undefined && jiraServerFor(undefined, { serverId: 'jira', projectKey: 'X' }) === undefined);

  const before = view(server('wiki'));
  check('a saved server is the new one', savedServer(before, view(server('wiki'), server('jira')))?.id === 'jira');
  check('or the one asked for by id', savedServer(before, view(server('wiki'), server('jira'), server('mine')), 'mine')?.id === 'mine');
  check('with nothing new (it replaced the old `jira`), the Jira one', savedServer(view(server('jira')), view(server('jira')))?.id === 'jira');
  check('nothing saved: nothing', savedServer(before, view(), 'x') === undefined);
}

console.log('\n=== the project: a list to choose from, or a key to type ===');
{
  const list = { listed: true, projects: [{ key: 'LOJA', name: 'Loja online', site: 'empresa.atlassian.net' }, { key: 'APP', name: 'App de entregas' }] };
  check(
    'a list with projects is a choice; not listed or empty is a text box; nothing yet is a text box',
    projectMode(list) === 'select' && projectMode({ listed: false, projects: [] }) === 'text' && projectMode({ listed: true, projects: [] }) === 'text' && projectMode({ listed: false, projects: list.projects }) === 'text' && projectMode(undefined) === 'text'
  );
  check('keys are normalised to upper case and checked', normalizeKey(' loja ') === 'LOJA' && isProjectKey('loja') && isProjectKey('AB_12') && !isProjectKey('') && !isProjectKey('1AB') && !isProjectKey('A B') && !isProjectKey('A-B'));
  check('a chosen project brings its name and site', same(buildTarget('jira', 'LOJA', list.projects), { serverId: 'jira', projectKey: 'LOJA', projectName: 'Loja online', site: 'empresa.atlassian.net' }));
  check('a project with no site brings none', same(buildTarget('jira', 'APP', list.projects), { serverId: 'jira', projectKey: 'APP', projectName: 'App de entregas' }));
  check('a typed key brings only the key (and the site already known)', same(buildTarget('jira', 'abc', []), { serverId: 'jira', projectKey: 'ABC' }) && same(buildTarget('jira', 'abc', [], 's.net'), { serverId: 'jira', projectKey: 'ABC', site: 's.net' }));
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll Jira logic checks passed.');
