import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSession, AliaSession } from '../src/core/session.js';
import { AliaConfig, loadConfig, validateConfig } from '../src/core/config.js';
import { AgentUI } from '../src/core/agent/agentUI.js';
import { SafetyConfirmationContext } from '../src/core/safety/safetyChecker.js';
import { TerminalUI } from '../src/cli/ui/terminal.js'; // imported on purpose: must have no side effects
import { FakeModel, ScriptedTurn } from './lib/fakeModel.js';
import { capture } from './lib/testUtils.js';

let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.log(`  ✘ ${name} ${extra}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alia-session-'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mkdir = (...p: string[]) => {
  const dir = path.join(tmp, ...p);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const baseConfig = (): AliaConfig => ({
  name: 'test',
  vendor: 'test',
  apiKey: 'test-key',
  apiType: 'chat-completions',
  models: [
    { id: 'fake-model', name: 'fake', url: 'http://fake', toolCalling: true, maxInputTokens: 1000 },
    { id: 'other-model', name: 'other', url: 'http://fake', toolCalling: true },
  ],
});

/** Records everything a session reports to its UI. */
function recordingUI(label: string) {
  const rec = { toolCalls: [] as string[], scopePushes: [] as string[], infos: [] as string[] };
  const ui: AgentUI = {
    printToolCall: (name, args) => rec.toolCalls.push(`${name} ${args}`),
    printInfo: (m) => rec.infos.push(m),
    pushScope: (o) => rec.scopePushes.push(o.label),
    popScope: () => {},
    getScopeLabel: () => label,
  };
  return { ui, rec };
}

function makeSession(
  workspace: string,
  turns: ScriptedTurn[],
  extra: Partial<Parameters<typeof createSession>[0]> = {}
): { session: AliaSession; model: FakeModel } {
  const model = new FakeModel(turns);
  const session = createSession({
    workspace,
    config: baseConfig(),
    client: model.client,
    skillRoots: [], // hermetic: no bundled, user or project skills
    ...extra,
  });
  return { session, model };
}

console.log('\n=== config: explicit base directory, no cwd reads ===');
{
  const savedConfigEnv = process.env.ALIA_CONFIG;
  delete process.env.ALIA_CONFIG;
  try {
    const dir = mkdir('cfg');
    fs.writeFileSync(
      path.join(dir, 'alia-config.json'),
      JSON.stringify({ ...baseConfig(), models: [{ id: 'from-base', name: 'b', url: 'http://x', toolCalling: true }] })
    );
    const found = loadConfig({ baseDir: dir, loadEnvFile: false });
    check('finds alia-config.json in baseDir', found.models[0].id === 'from-base');

    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(
      path.join(dir, 'sub', 'custom.json'),
      JSON.stringify({ ...baseConfig(), models: [{ id: 'from-custom', name: 'c', url: 'http://x', toolCalling: true }] })
    );
    const custom = loadConfig({ baseDir: dir, configPath: 'sub/custom.json', loadEnvFile: false });
    check('configPath is resolved against baseDir', custom.models[0].id === 'from-custom');

    let msg = '';
    try {
      loadConfig({ baseDir: fs.mkdtempSync(path.join(os.tmpdir(), 'alia-nocfg-')), loadEnvFile: false });
    } catch (e: any) {
      msg = e.message;
    }
    check('missing config -> readable error', msg.includes('Configuration file not found'), msg);

    let keyErr = '';
    try {
      validateConfig({ ...baseConfig(), apiKey: '' });
    } catch (e: any) {
      keyErr = e.message;
    }
    check('in-memory config without API key is rejected', keyErr.includes('Missing API key'), keyErr);
    let modelsErr = '';
    try {
      validateConfig({ ...baseConfig(), models: [] });
    } catch (e: any) {
      modelsErr = e.message;
    }
    check('in-memory config without models is rejected', modelsErr.includes('at least one model'), modelsErr);
  } finally {
    if (savedConfigEnv !== undefined) process.env.ALIA_CONFIG = savedConfigEnv;
  }
}

console.log('\n=== core has no process-wide state or cwd reads ===');
{
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.ts')) {
        const text = fs.readFileSync(p, 'utf8');
        if (text.includes('process.cwd(')) offenders.push(`${p}: process.cwd()`);
        if (/\bsetDefault\w+|\bgetDefault\w+/.test(text)) offenders.push(`${p}: default-handler global`);
      }
    }
  };
  walk(path.resolve('src', 'core'));
  check('no process.cwd() and no setDefault*/getDefault* in src/core', offenders.length === 0, offenders.join('; '));

  // TerminalUI is imported at the top of this file: a session without a UI must stay silent.
  void TerminalUI;
  const dir = mkdir('silent');
  const { session } = makeSession(dir, [
    { toolCalls: [{ name: 'list_files', args: { path: '.' } }] },
    { content: 'done' },
  ]);
  const out = await capture(() => session.run('hi'));
  check('importing terminal.ts registers nothing: a UI-less session prints nothing', out.lines.length === 0, out.lines.join(' | '));
  check('the run itself worked', out.result.status === 'completed' && out.result.text === 'done');
}

console.log('\n=== two sessions in one process do not interfere ===');
{
  const wsA = mkdir('ws-a');
  const wsB = mkdir('ws-b');
  const a = recordingUI('label-A');
  const b = recordingUI('label-B');
  const confirmA: SafetyConfirmationContext[] = [];
  const confirmB: SafetyConfirmationContext[] = [];

  const turnsFor = (file: string, content: string, final: string): ScriptedTurn[] => [
    { toolCalls: [{ name: 'write_file', args: { path: file, content } }] },
    { toolCalls: [{ name: 'run_bash', args: { command: 'rm -rf not-there' } }] },
    (req) => ({ content: `${final}:${(req.messages.filter((m) => m.role === 'tool').pop()?.content as string).slice(0, 60)}` }),
  ];

  const A = makeSession(wsA, turnsFor('a.txt', 'from A', 'A'), {
    ui: a.ui,
    onConfirm: async (ctx) => {
      confirmA.push(ctx);
      await sleep(25);
      return false; // A's user denies
    },
  });
  const B = makeSession(wsB, turnsFor('b.txt', 'from B', 'B'), {
    ui: b.ui,
    onConfirm: async (ctx) => {
      confirmB.push(ctx);
      await sleep(10);
      return true; // B's user approves
    },
  });

  const [ra, rb] = await Promise.all([A.session.run('go A'), B.session.run('go B')]);

  check('both runs completed', ra.status === 'completed' && rb.status === 'completed', `${ra.text} / ${rb.text}`);
  check("A wrote only into A's workspace", fs.readFileSync(path.join(wsA, 'a.txt'), 'utf8') === 'from A' && !fs.existsSync(path.join(wsA, 'b.txt')));
  check("B wrote only into B's workspace", fs.readFileSync(path.join(wsB, 'b.txt'), 'utf8') === 'from B' && !fs.existsSync(path.join(wsB, 'a.txt')));
  check("each confirm handler was asked exactly once, for its own session", confirmA.length === 1 && confirmB.length === 1);
  check("A's denial applied to A only", ra.text.includes('denied') && !rb.text.includes('denied'), `${ra.text} / ${rb.text}`);
  check("approval requests carry the session's own scope label", confirmA[0].requester === 'label-A' && confirmB[0].requester === 'label-B');
  check("each UI saw only its own tool calls", a.rec.toolCalls.every((c) => !c.includes('b.txt')) && b.rec.toolCalls.every((c) => !c.includes('a.txt')) && a.rec.toolCalls.length === 2 && b.rec.toolCalls.length === 2);
  check('histories are independent', A.session.agent.getMessages().length === 7 && B.session.agent.getMessages().length === 7);

  A.session.reset();
  check('reset() clears only that session', A.session.agent.getMessages().length === 1 && B.session.agent.getMessages().length === 7);

  const sandboxed = makeSession(mkdir('ws-c'), [
    { toolCalls: [{ name: 'run_bash', args: { command: 'rm -rf not-there' } }] },
    (req) => ({ content: String(req.messages.filter((m) => m.role === 'tool').pop()?.content) }),
  ]);
  const rc = await sandboxed.session.run('go');
  check('no handler and no auto-approve -> dangerous command is denied, not run', rc.text.includes('no confirmation handler'), rc.text);
}

console.log('\n=== auto-approve and its audit hook ===');
{
  const seen: string[] = [];
  const { session } = makeSession(mkdir('ws-auto'), [
    { toolCalls: [{ name: 'run_bash', args: { command: 'rm -rf not-there' } }] },
    { content: 'ok' },
  ], { autoApprove: true, onAutoApprove: (c) => seen.push(c) });
  const r = await session.run('go');
  check('autoApprove lets it through and reports it', r.status === 'completed' && seen.length === 1 && seen[0].includes('rm -rf'), JSON.stringify(seen));
}

console.log('\n=== skills through the session ===');
{
  const ws = mkdir('ws-skills');
  const skillsDir = mkdir('skill-root');
  const mk = (name: string, front: string) => {
    fs.mkdirSync(path.join(skillsDir, name), { recursive: true });
    fs.writeFileSync(path.join(skillsDir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: test skill ${name}\n${front}---\nBODY-OF-${name}\n`);
  };
  mk('alpha', '');
  mk('gated', 'requires: tool_that_does_not_exist\n');
  fs.writeFileSync(path.join(ws, 'notes.txt'), 'attached contents');

  const { session, model } = makeSession(ws, [{ content: 'hello' }], { skillRoots: [{ label: 'test', dir: skillsDir }] });

  const ready = session.resolveSkill('/alpha', 'summarize @notes.txt');
  check('known skill -> ready', ready.status === 'ready');
  if (ready.status === 'ready') {
    check('prompt carries the skill body and the user input', ready.prompt.includes('BODY-OF-alpha') && ready.prompt.includes('summarize'));
    check('@mentions resolve against the session workspace', ready.attachments.length === 1 && ready.prompt.includes('attached contents'), JSON.stringify(ready.errors));
  }
  const gated = session.resolveSkill('gated', '');
  check('requires: unmet -> unavailable with a message', gated.status === 'unavailable' && gated.message.includes('tool_that_does_not_exist'));
  check('unknown command -> not_a_skill', session.resolveSkill('/nope', '').status === 'not_a_skill');

  await session.run('hi');
  const advertised = model.requests[0].toolNames;
  check('use_skill and run_subagent are registered', advertised.includes('use_skill') && advertised.includes('run_subagent'));
  check('system prompt advertises the available skill only', String(model.requests[0].messages[0].content).includes('- alpha:') && !String(model.requests[0].messages[0].content).includes('- gated:'));
}

console.log('\n=== subagents report to the parent session UI ===');
{
  const { ui, rec } = recordingUI('x');
  const { session } = makeSession(mkdir('ws-sub'), [
    { toolCalls: [{ name: 'run_subagent', args: { task: 'child task' } }] },
    { content: 'STATUS: completed\nSUMMARY: ok' },
    (req) => ({ content: String(req.messages.filter((m) => m.role === 'tool').pop()?.content) }),
  ], { ui });
  const r = await session.run('delegate');
  check('child ran and the parent got its result', r.status === 'completed' && r.text.startsWith('STATUS: completed'), r.text);
  check("the session's UI got the nested scope", rec.scopePushes.length === 1 && rec.scopePushes[0] === 'child task', JSON.stringify(rec.scopePushes));
}

console.log('\n=== models, context usage, workspace ===');
{
  const { session } = makeSession('.', [{ content: 'hi there' }]);
  check('workspace is resolved to an absolute path', session.workspace === path.resolve('.') && path.isAbsolute(session.workspace));
  check('default model is the first configured', session.getModel() === 'fake-model');

  const sw = await session.switchModel('other');
  check('switch by configured name', sw.ok && sw.id === 'other-model' && session.getModel() === 'other-model');
  const bad = await session.switchModel('zzz');
  check('unknown model -> not ok, with the endpoint list (empty for the fake)', !bad.ok && bad.available.length === 0);

  const before = session.getContextUsage();
  await session.run('hello');
  const after = session.getContextUsage();
  check('context usage grows with the conversation', after.tokens > before.tokens && after.messages === before.messages + 2);
  check('limit follows the active model (default 128000 for "other")', after.limit === 128000, String(after.limit));
  check('percent is computed', after.percent === Math.round((after.tokens / after.limit) * 1000) / 10);

  let err = '';
  try {
    createSession({ workspace: '.', config: { ...baseConfig(), apiKey: '' }, skillRoots: [] });
  } catch (e: any) {
    err = e.message;
  }
  check('createSession rejects an unusable config', err.includes('Missing API key'), err);

  let modelErr = '';
  try {
    createSession({ workspace: '.', config: baseConfig(), modelId: 'does-not-exist-in-config', skillRoots: [] });
  } catch (e: any) {
    modelErr = e.message;
  }
  // createAliaClient treats an unknown id as an endpoint model (same as before), so this must NOT throw.
  check('an id missing from the config is accepted as an endpoint model (unchanged behavior)', modelErr === '', modelErr);
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll session checks passed.');
