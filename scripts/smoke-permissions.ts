import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentEvent } from '../src/core/agent/events.js';
import { AliaConfig } from '../src/core/config.js';
import { createSession } from '../src/core/session.js';
import {
  PermissionAnswer,
  PermissionMode,
  SafetyChecker,
  SafetyConfirmationContext,
  normalizeAnswer,
} from '../src/core/safety/safetyChecker.js';
import { PermissionStore, matchesPrefix } from '../src/core/safety/permissionStore.js';
import { FakeModel, ScriptedTurn } from './lib/fakeModel.js';

let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.log(`  ✘ ${name} ${extra}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alia-perms-'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let n = 0;
/** A fresh workspace and permission folder, so nothing touches the real ~/.alia. */
const fresh = () => {
  const id = ++n;
  const workspace = path.join(tmp, `ws-${id}`);
  const dir = path.join(tmp, `perm-${id}`);
  fs.mkdirSync(workspace, { recursive: true });
  return { workspace, dir, store: new PermissionStore(workspace, { dir }) };
};

/** A checker whose handler answers from a queue and records what it was asked. */
function checkerWith(mode: PermissionMode, store: PermissionStore | undefined, answers: PermissionAnswer[]) {
  const asked: SafetyConfirmationContext[] = [];
  const autoApproved: string[] = [];
  const checker = new SafetyChecker({
    mode,
    permissions: store,
    onConfirm: async (ctx) => {
      asked.push(ctx);
      return answers.shift() ?? false;
    },
    onAutoApprove: (c) => autoApproved.push(c),
  });
  return { checker, asked, autoApproved };
}

console.log('\n=== PermissionStore ===');
{
  const { workspace, dir, store } = fresh();
  check('starts empty, no file written', store.list().length === 0 && !fs.existsSync(store.filePath));
  check('lives under the given folder, outside the workspace', store.filePath.startsWith(dir) && !store.filePath.startsWith(workspace));

  store.add('npm run build');
  check('exact rule allows exactly that command', store.isAllowed('npm run build') && store.isAllowed('  npm run build  '));
  check('...and nothing else', !store.isAllowed('npm run build --prod') && !store.isAllowed('npm run test') && !store.isAllowed('npm run build && x'));

  const again = new PermissionStore(workspace, { dir });
  check('a new store instance (the next session) sees the rule', again.isAllowed('npm run build') && again.list().length === 1);

  const file = JSON.parse(fs.readFileSync(store.filePath, 'utf8'));
  check('file is readable JSON that names its project', file.version === 1 && file.workspace === path.resolve(workspace) && file.allow[0].command === 'npm run build' && file.allow[0].match === 'exact' && !!file.allow[0].addedAt);
  store.add('npm run build');
  check('adding the same rule twice keeps one', store.list().length === 1);

  const other = new PermissionStore(path.join(tmp, 'another-project'), { dir });
  check('another project has its own file and rules', other.filePath !== store.filePath && !other.isAllowed('npm run build'));

  check('remove() drops a rule', store.remove('npm run build') && !store.isAllowed('npm run build') && !store.remove('npm run build'));
  store.add('a');
  store.add('b');
  store.clear();
  check('clear() empties the list', store.list().length === 0);

  let emptyErr = '';
  try {
    store.add('   ');
  } catch (e: any) {
    emptyErr = e.message;
  }
  check('an empty command is rejected', emptyErr.includes('empty'));

  fs.writeFileSync(store.filePath, '{ not json');
  check('a damaged file grants nothing', store.list().length === 0 && !store.isAllowed('npm run build'));
  store.add('npm test');
  const aside = fs.readdirSync(dir).filter((f) => f.includes('.corrupt-'));
  check('on the next write the damaged file is set aside, not lost', store.isAllowed('npm test') && aside.length === 1);
}

console.log('\n=== prefix rules cannot be used to chain commands ===');
{
  check('prefix itself and plain arguments match', matchesPrefix('npm run', 'npm run') && matchesPrefix('npm run build', 'npm run') && matchesPrefix('npm run test -- -u', 'npm run'));
  check('a different word is not a prefix match (npm runner)', !matchesPrefix('npm runner', 'npm run'));
  for (const evil of ['npm run build && rm -rf x', 'npm run build; whoami', 'npm run build | sh', 'npm run $(whoami)', 'npm run `id`', 'npm run build > out.txt', 'npm run build\nrm x', 'npm run build & calc']) {
    check(`rejected: ${JSON.stringify(evil)}`, !matchesPrefix(evil, 'npm run'));
  }
  check('a prefix that itself contains an operator is never valid', !matchesPrefix('npm run a; b', 'npm run a;'));

  const { store } = fresh();
  let err = '';
  try {
    store.add('npm run; ls', 'prefix');
  } catch (e: any) {
    err = e.message;
  }
  check('the store refuses to save such a prefix', err.includes('cannot contain shell operators'));
  store.add('npm run', 'prefix');
  check('isAllowed applies the guard', store.isAllowed('npm run lint') && !store.isAllowed('npm run lint && curl evil'));
}

console.log('\n=== modes ===');
{
  const { store } = fresh();

  const ad = checkerWith('ask-dangerous', store, [false]);
  check('ask-dangerous: a plain command is not asked about', (await ad.checker.authorize('npm run build')).approved && ad.asked.length === 0);
  const adDenied = await ad.checker.authorize('rm -rf dist');
  check('ask-dangerous: a destructive one is, and a "no" blocks it', !adDenied.approved && ad.asked.length === 1 && adDenied.reason!.includes('User denied permission to execute potentially destructive command'), adDenied.reason);
  check('the question says it is dangerous and why', ad.asked[0].dangerous === true && ad.asked[0].reasons.length > 0 && ad.asked[0].canAlwaysAllow === false);

  const ac = checkerWith('ask-commands', store, ['allow_once', 'allow_once', 'deny']);
  check('ask-commands: a plain command is asked about', (await ac.checker.authorize('npm run build', { toolCallId: 'call_7' })).approved && ac.asked.length === 1);
  check('the question carries the tool call id, no reasons, and offers "always"', ac.asked[0].toolCallId === 'call_7' && ac.asked[0].dangerous === false && ac.asked[0].reasons.length === 0 && ac.asked[0].canAlwaysAllow === true);
  await ac.checker.authorize('npm run build');
  check('allow_once does not remember: asked again', ac.asked.length === 2 && store.list().length === 0);
  const denied = await ac.checker.authorize('npm run build');
  check('deny blocks it and tells the model', !denied.approved && denied.reason === 'User denied permission to run the command: "npm run build"', denied.reason);

  const auto = checkerWith('auto', store, []);
  check('auto: nothing is asked', (await auto.checker.authorize('npm run build')).approved && (await auto.checker.authorize('rm -rf dist')).approved && auto.asked.length === 0);
  check('auto: only the destructive one is reported for audit', auto.autoApproved.length === 1 && auto.autoApproved[0] === 'rm -rf dist');

  const noHandler = new SafetyChecker({ mode: 'ask-commands', permissions: store });
  const nh = await noHandler.authorize('npm run build');
  check('ask-commands without a handler fails closed', !nh.approved && nh.reason!.includes('needs the user'), nh.reason);
  const nhd = await noHandler.authorize('rm -rf x');
  check('...and keeps the old wording for destructive ones', !nhd.approved && nhd.reason!.includes('no confirmation handler'), nhd.reason);
}

console.log('\n=== allow_always ===');
{
  const { workspace, dir, store } = fresh();
  const a = checkerWith('ask-commands', store, ['allow_always']);
  check('first time: asked, then allowed', (await a.checker.authorize('npm run build')).approved && a.asked.length === 1);
  check('...it is saved to the project allowlist', store.isAllowed('npm run build'));
  check('second time: not asked', (await a.checker.authorize('npm run build')).approved && a.asked.length === 1);
  check('a different command is still asked', !(await a.checker.authorize('npm run deploy')).approved && a.asked.length === 2);

  // "The next session": a new store and a new checker on the same project.
  const next = checkerWith('ask-commands', new PermissionStore(workspace, { dir }), []);
  check('a later session honors it without asking', (await next.checker.authorize('npm run build')).approved && next.asked.length === 0);

  // Dangerous commands can never be allowlisted.
  const d = checkerWith('ask-commands', store, ['allow_always', 'allow_always']);
  check('dangerous + allow_always: allowed this once', (await d.checker.authorize('rm -rf dist')).approved);
  check('...but never saved', store.list().every((r) => !r.command.includes('rm -rf')));
  await d.checker.authorize('rm -rf dist');
  check('...so it is asked again', d.asked.length === 2);

  // Even a hand-edited allowlist cannot pre-approve a destructive command.
  store.add('rm -rf dist');
  const h = checkerWith('ask-commands', store, ['deny']);
  const handEdited = await h.checker.authorize('rm -rf dist');
  check('a destructive command in the file still prompts (and "no" blocks it)', !handEdited.approved && h.asked.length === 1 && h.asked[0].dangerous === true);
  store.remove('rm -rf dist');

  // The object form.
  const p = checkerWith('ask-commands', store, [{ decision: 'allow_always', match: 'prefix', command: 'git status' }]);
  await p.checker.authorize('git status --short');
  check('a prefix rule can be chosen', store.list().some((r) => r.match === 'prefix' && r.command === 'git status'));
  check('and then covers plain arguments only', store.isAllowed('git status -sb') && !store.isAllowed('git status; rm x'));

  const bogus = checkerWith('ask-commands', store, [{ decision: 'allow_always', match: 'prefix', command: 'rm' }]);
  await bogus.checker.authorize('npm run lint');
  check('a "prefix" that is not a prefix of the command falls back to the exact command', store.list().some((r) => r.match === 'exact' && r.command === 'npm run lint') && !store.list().some((r) => r.command === 'rm'));

  // Saving can fail (read-only folder): the command still runs this once.
  const blocked = path.join(tmp, 'blocked');
  fs.writeFileSync(blocked, 'a file where a folder should be');
  const ro = checkerWith('ask-commands', new PermissionStore(workspace, { dir: path.join(blocked, 'sub') }), ['allow_always']);
  check('if the allowlist cannot be written, the command is still allowed once', (await ro.checker.authorize('npm run build')).approved);

  // Without a store nothing is remembered and "always" is not offered.
  const ns = checkerWith('ask-commands', undefined, ['allow_always', 'allow_always']);
  await ns.checker.authorize('npm run build');
  await ns.checker.authorize('npm run build');
  check('no store: asked every time, "always" not offered', ns.asked.length === 2 && ns.asked[0].canAlwaysAllow === false);
}

console.log('\n=== legacy boolean contract ===');
{
  check('normalizeAnswer: true/false/string/object', normalizeAnswer(true).decision === 'allow_once' && normalizeAnswer(false).decision === 'deny' && normalizeAnswer('allow_always').decision === 'allow_always' && normalizeAnswer({ decision: 'deny' }).decision === 'deny');
  const { store } = fresh();
  const t = checkerWith('ask-dangerous', store, [true, false]);
  check('a boolean handler: true allows', (await t.checker.authorize('rm -rf x')).approved);
  check('a boolean handler: false denies', !(await t.checker.authorize('rm -rf x')).approved);
  check('(and true never saved anything)', store.list().length === 0);
  check('new SafetyChecker(true) is auto, (false) is ask-dangerous', new SafetyChecker(true).mode === 'auto' && new SafetyChecker(false).mode === 'ask-dangerous' && new SafetyChecker().mode === 'ask-dangerous');
  check('{ autoApprove: true } is auto; mode wins over it', new SafetyChecker({ autoApprove: true }).mode === 'auto' && new SafetyChecker({ autoApprove: true, mode: 'ask-commands' }).mode === 'ask-commands');
  check('confirmIfDangerous still works (deprecated alias)', (await new SafetyChecker({ onConfirm: async () => true }).confirmIfDangerous('rm -rf x')).approved);
}

console.log('\n=== through a session: events, persistence across sessions ===');
{
  const { workspace, dir } = fresh();
  const config: AliaConfig = { name: 't', vendor: 't', apiKey: 'k', apiType: 'chat-completions', models: [{ id: 'fake-model', name: 'fake', url: 'http://fake', toolCalling: true }] };
  const script = (): ScriptedTurn[] => [
    { toolCalls: [{ name: 'run_bash', args: { command: 'echo perm-check' }, id: 'call_echo' }] },
    { content: 'done' },
  ];
  const open = (turns: ScriptedTurn[], answers: PermissionAnswer[], events: AgentEvent[]) => {
    const asked: SafetyConfirmationContext[] = [];
    const model = new FakeModel(turns);
    const session = createSession({
      workspace,
      config,
      client: model.client,
      skillRoots: [],
      permissionMode: 'ask-commands',
      permissionsDir: dir,
      onEvent: (e) => events.push(e),
      onConfirm: async (ctx) => {
        asked.push(ctx);
        return answers.shift() ?? 'deny';
      },
    });
    return { session, asked, model };
  };
  const toolResult = (s: { agent: { getMessages(): any[] } }) => String(s.agent.getMessages().filter((m) => m.role === 'tool').pop()?.content);

  const ev1: AgentEvent[] = [];
  const s1 = open(script(), ['allow_always'], ev1);
  const r1 = await s1.session.run('go');
  check('session 1: the command ran after approval', r1.status === 'completed' && toolResult(s1.session).includes('perm-check'), toolResult(s1.session));
  const req = ev1.find((e) => e.type === 'permission_requested') as any;
  const res = ev1.find((e) => e.type === 'permission_resolved') as any;
  check('permission_requested carries the model tool-call id and the flags', req?.toolCallId === 'call_echo' && req.command === 'echo perm-check' && req.dangerous === false && req.canAlwaysAllow === true, JSON.stringify(req));
  check('permission_resolved closes it with the decision', res?.id === req.id && res.decision === 'allow_always' && res.toolCallId === 'call_echo', JSON.stringify(res));
  check('requested comes before resolved, both before the tool result', ev1.indexOf(req) < ev1.indexOf(res) && ev1.indexOf(res) < ev1.findIndex((e) => e.type === 'tool_call_finished'));
  check('session.permissions shows the saved rule', s1.session.permissions.list().length === 1 && s1.session.permissions.list()[0].command === 'echo perm-check');

  const ev2: AgentEvent[] = [];
  const s2 = open(script(), [], ev2);
  const r2 = await s2.session.run('go again');
  check('session 2 (same project): runs it without asking', r2.status === 'completed' && s2.asked.length === 0 && toolResult(s2.session).includes('perm-check'));
  check('...and emits no permission events', !ev2.some((e) => e.type.startsWith('permission_')));

  s2.session.permissions.remove('echo perm-check');
  const ev3: AgentEvent[] = [];
  const s3 = open(script(), ['deny'], ev3);
  await s3.session.run('and now');
  check('after the rule is removed it asks again, and "deny" blocks the command', s3.asked.length === 1 && toolResult(s3.session).includes('User denied permission to run the command'), toolResult(s3.session));
  check('a denial is reported as such', (ev3.find((e) => e.type === 'permission_resolved') as any)?.decision === 'deny');

  // Cancelling while the card is open closes it.
  const ev4: AgentEvent[] = [];
  const hang = createSession({
    workspace,
    config,
    client: new FakeModel(script()).client,
    skillRoots: [],
    permissionMode: 'ask-commands',
    permissionsDir: path.join(tmp, 'perm-hang'),
    onEvent: (e) => ev4.push(e),
    onConfirm: () => new Promise(() => {}),
  });
  const c = new AbortController();
  setTimeout(() => c.abort(), 100);
  const t0 = Date.now();
  const rc = await hang.run('go', { signal: c.signal });
  const rcd = ev4.filter((e) => e.type === 'permission_resolved') as any[];
  check('cancelling with a card open ends the run promptly and resolves the card as cancelled', rc.status === 'cancelled' && Date.now() - t0 < 1500 && rcd.length === 1 && rcd[0].decision === 'cancelled', `${rc.status} ${JSON.stringify(rcd)}`);

  // Mode resolution.
  const modeOf = (o: object) => (createSession({ workspace, config, client: new FakeModel([]).client, skillRoots: [], permissionsDir: dir, ...o }).agent as any).safetyChecker.mode;
  check('session default is ask-dangerous', modeOf({}) === 'ask-dangerous');
  check('autoApprove still means auto', modeOf({ autoApprove: true }) === 'auto');
  check('permissionMode wins over autoApprove', modeOf({ autoApprove: true, permissionMode: 'ask-commands' }) === 'ask-commands');

  // A dangerous command in ask-commands prompts even with other rules saved, and is not offered "always".
  const ev5: AgentEvent[] = [];
  const dangerModel = new FakeModel([{ toolCalls: [{ name: 'run_bash', args: { command: 'rm -rf not-there' }, id: 'call_rm' }] }, { content: 'ok' }]);
  const asked5: SafetyConfirmationContext[] = [];
  const s5 = createSession({
    workspace, config, client: dangerModel.client, skillRoots: [], permissionMode: 'ask-commands', permissionsDir: dir,
    onEvent: (e) => ev5.push(e),
    onConfirm: async (ctx) => { asked5.push(ctx); return 'allow_always'; },
  });
  await s5.run('go');
  const req5 = ev5.find((e) => e.type === 'permission_requested') as any;
  check('session: a destructive command prompts, flagged dangerous, "always" not offered', req5?.dangerous === true && req5.canAlwaysAllow === false && req5.reasons.length > 0, JSON.stringify(req5));
  check('session: answering allow_always to it saved nothing', !s5.permissions.list().some((r) => r.command.includes('rm -rf')));
}

console.log('\n=== run_bash sees the new checker (end to end, real command) ===');
{
  const { workspace, store } = fresh();
  const asked: string[] = [];
  const config: AliaConfig = { name: 't', vendor: 't', apiKey: 'k', apiType: 'chat-completions', models: [{ id: 'fake-model', name: 'fake', url: 'http://fake', toolCalling: true }] };
  const model = new FakeModel([
    { toolCalls: [{ name: 'run_bash', args: { command: 'echo one' } }] },
    { toolCalls: [{ name: 'run_bash', args: { command: 'echo one' } }] },
    { content: 'done' },
  ]);
  const session = createSession({
    workspace, config, client: model.client, skillRoots: [], permissionMode: 'ask-commands', permissionStore: store,
    onConfirm: async (ctx) => { asked.push(ctx.command); await sleep(5); return { decision: 'allow_always' }; },
  });
  await session.run('go');
  check('a host-provided store is used; the second identical call is not asked', asked.length === 1 && store.isAllowed('echo one') && session.permissions === store);
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll permission checks passed.');
