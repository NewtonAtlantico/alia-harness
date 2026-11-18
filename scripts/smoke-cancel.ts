import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import OpenAI from 'openai';
import { AliaAgent } from '../src/core/agent/agentLoop.js';
import { AgentEvent } from '../src/core/agent/events.js';
import { ToolRegistry, ToolDefinition, CANCELLED_OUTPUT_PREFIX } from '../src/core/tools/index.js';
import { SafetyChecker } from '../src/core/safety/safetyChecker.js';
import { ContextManager } from '../src/core/context/contextManager.js';
import { AliaConfig } from '../src/core/config.js';
import { createSession } from '../src/core/session.js';
import { cliConfirmDangerousCommand } from '../src/cli/ui/terminal.js';
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

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const modelConfig = { id: 'fake-model', name: 'fake', url: 'http://fake', toolCalling: true };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alia-cancel-'));

/** Every assistant tool call must be answered by exactly one tool message right after it. */
function historyIsValid(messages: Msg[]): { ok: boolean; why: string } {
  for (let i = 0; i < messages.length; i++) {
    const m: any = messages[i];
    if (m.role !== 'assistant' || !m.tool_calls?.length) continue;
    const ids = m.tool_calls.map((c: any) => c.id).sort().join();
    const following = messages
      .slice(i + 1, i + 1 + m.tool_calls.length)
      .filter((x) => x.role === 'tool')
      .map((x: any) => x.tool_call_id)
      .sort()
      .join();
    if (ids !== following) return { ok: false, why: `assistant at #${i} announced [${ids}] but got [${following}]` };
  }
  return { ok: true, why: '' };
}

function makeAgent(turns: ScriptedTurn[], extra: Partial<ConstructorParameters<typeof AliaAgent>[0]> = {}) {
  const model = new FakeModel(turns);
  const events: AgentEvent[] = [];
  const agent = new AliaAgent({
    client: model.client,
    model: 'fake-model',
    modelConfig,
    toolRegistry: new ToolRegistry(),
    safetyChecker: new SafetyChecker(true),
    contextManager: new ContextManager(),
    workingDirectory: tmp,
    systemPrompt: 'SYS',
    onEvent: (e) => events.push(e),
    ...extra,
  });
  return { agent, model, events };
}

/** Aborts after `ms`; returns the controller and a function giving the time elapsed since the abort. */
function abortAfter(ms: number) {
  const controller = new AbortController();
  let abortedAt = 0;
  setTimeout(() => {
    abortedAt = Date.now();
    controller.abort();
  }, ms);
  return { controller, sinceAbort: () => Date.now() - abortedAt };
}

// A long-running process that records its pid, so we can prove it really died.
const hangScript = path.join(tmp, 'hang.js');
fs.writeFileSync(hangScript, `require('fs').writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);`);
async function readPid(file: string): Promise<number> {
  for (let i = 0; i < 100; i++) {
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').trim()) return Number(fs.readFileSync(file, 'utf8'));
    await sleep(50);
  }
  throw new Error(`pid file ${file} never appeared`);
}
const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function diesWithin(pid: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!isAlive(pid)) return true;
    await sleep(50);
  }
  return !isAlive(pid);
}
const hangCommand = (pidFile: string) => `node "${hangScript.replace(/\\/g, '/')}" "${pidFile.replace(/\\/g, '/')}"`;

console.log('\n=== cancel while the model request is in flight ===');
{
  const { agent, model, events } = makeAgent([{ hang: 'honor-signal' }, { content: 'second run works' }]);
  const { controller, sinceAbort } = abortAfter(100);
  const r = await agent.runDetailed('first', { signal: controller.signal });
  check('status is cancelled', r.status === 'cancelled' && r.text === 'Run cancelled by user.', JSON.stringify(r));
  check('returns within a second of the abort', sinceAbort() < 1000, `${sinceAbort()}ms`);
  check('the signal was handed to the client', model.requests[0].signalPassed === true);
  check('events close cleanly', events.map((e) => e.type).join() === 'run_started,model_started,model_finished,notice,run_finished' && (events.at(-1) as any).result.status === 'cancelled', events.map((e) => e.type).join());
  check('history is valid', historyIsValid(agent.getMessages()).ok);

  const again = await agent.runDetailed('second');
  check('the same agent can run again', again.status === 'completed' && again.text === 'second run works');
  check('the follow-up request is well-formed (system, user, user, ...)', model.requests[1].messages.map((m) => m.role).join() === 'system,user,user');
}

console.log('\n=== a client that ignores the signal cannot hold the run ===');
{
  const { agent } = makeAgent([{ hang: 'ignore-signal' }]);
  const { controller, sinceAbort } = abortAfter(100);
  const r = await agent.runDetailed('x', { signal: controller.signal });
  check('still cancelled, still prompt', r.status === 'cancelled' && sinceAbort() < 1000, `${r.status} ${sinceAbort()}ms`);
}

console.log('\n=== already-aborted signal ===');
{
  const { agent, model } = makeAgent([{ content: 'never' }]);
  const c = new AbortController();
  c.abort();
  const r = await agent.runDetailed('x', { signal: c.signal });
  check('cancelled without calling the model', r.status === 'cancelled' && r.steps === 0 && model.callCount === 0, JSON.stringify(r));
  check('run() returns the cancellation text', (await makeAgent([{ content: 'never' }]).agent.run('x', { signal: c.signal })) === 'Run cancelled by user.');
}

console.log('\n=== cancel in the middle of run_bash: the whole process tree dies ===');
{
  const pidFile = path.join(tmp, 'bash.pid');
  const { agent, events } = makeAgent(
    [
      {
        toolCalls: [
          { name: 'run_bash', args: { command: hangCommand(pidFile), timeout_ms: 60000 }, id: 'call_hang' },
          { name: 'list_files', args: { path: '.' }, id: 'call_two' },
          { name: 'list_files', args: { path: '.' }, id: 'call_three' },
        ],
      },
      { content: 'back to normal' },
    ],
    { toolRegistry: new ToolRegistry() }
  );
  const controller = new AbortController();
  const running = agent.runDetailed('start the server', { signal: controller.signal });
  const pid = await readPid(pidFile);
  check('the command is really running', isAlive(pid));
  const abortedAt = Date.now();
  controller.abort();
  const r = await running;
  const took = Date.now() - abortedAt;

  check('run ends cancelled within a second', r.status === 'cancelled' && took < 1000, `${r.status} ${took}ms`);
  check('the process is dead (grandchild of the shell, not just the shell)', await diesWithin(pid, 3000), `pid ${pid} still alive`);

  const finished = events.filter((e) => e.type === 'tool_call_finished') as any[];
  check('the interrupted call is reported as a failed tool call', finished.length === 1 && finished[0].id === 'call_hang' && finished[0].isError === true && finished[0].result.startsWith(CANCELLED_OUTPUT_PREFIX), JSON.stringify(finished));
  check('the other two calls never started', events.filter((e) => e.type === 'tool_call_started').length === 1);

  const msgs = agent.getMessages();
  const toolMsgs = msgs.filter((m) => m.role === 'tool') as any[];
  check('all three announced calls have a tool message', toolMsgs.map((m) => m.tool_call_id).join() === 'call_hang,call_two,call_three');
  check('the unexecuted ones say so', toolMsgs[1].content.startsWith(CANCELLED_OUTPUT_PREFIX) && toolMsgs[2].content.startsWith(CANCELLED_OUTPUT_PREFIX));
  check('history is valid', historyIsValid(msgs).ok, historyIsValid(msgs).why);

  const again = await agent.runDetailed('are you ok?');
  check('a new run after the cancel completes', again.status === 'completed' && again.text === 'back to normal');
}

console.log('\n=== tools receive the signal; the registry refuses new work once aborted ===');
{
  let ran = 0;
  let seen: AbortSignal | undefined;
  const probe: ToolDefinition = {
    name: 'probe',
    description: 'records',
    parameters: { type: 'object', properties: {} },
    execute: async (_a, ctx) => {
      ran++;
      seen = ctx.signal;
      return 'ok';
    },
  };
  const tools = new ToolRegistry();
  tools.register(probe);
  const ctx = { workingDirectory: tmp, safetyChecker: new SafetyChecker(true), contextManager: new ContextManager() };
  const c = new AbortController();
  await tools.execute('probe', '{}', { ...ctx, signal: c.signal });
  check('a running tool sees the run signal', ran === 1 && seen === c.signal);
  c.abort();
  const out = await tools.execute('probe', '{}', { ...ctx, signal: c.signal });
  check('after abort the tool is not executed', ran === 1 && out.startsWith(CANCELLED_OUTPUT_PREFIX), out);
  const bash = await tools.execute('does_not_matter', '{}', { ...ctx, signal: c.signal });
  check('(and the cancelled message wins over "not registered")', bash.startsWith(CANCELLED_OUTPUT_PREFIX));
}

console.log('\n=== cancel while an approval is open ===');
{
  let handlerSignal: AbortSignal | undefined;
  const { agent, events } = makeAgent(
    [{ toolCalls: [{ name: 'run_bash', args: { command: 'rm -rf not-there' }, id: 'call_rm' }] }, { content: 'unused' }],
    {
      safetyChecker: new SafetyChecker({
        onConfirm: (ctx) => {
          handlerSignal = ctx.signal;
          return new Promise<boolean>(() => {}); // the user never answers
        },
      }),
    }
  );
  const { controller, sinceAbort } = abortAfter(100);
  const r = await agent.runDetailed('delete it', { signal: controller.signal });
  check('the run is not stuck waiting for the user', r.status === 'cancelled' && sinceAbort() < 1000, `${r.status} ${sinceAbort()}ms`);
  check('the handler got the signal, so a UI can dismiss its card', handlerSignal !== undefined && handlerSignal.aborted);
  const finished = events.find((e) => e.type === 'tool_call_finished') as any;
  check('the command was not run and says why', finished?.result.includes('Cancelled by user before the command was approved'), finished?.result);

  const pre = new AbortController();
  pre.abort();
  const checker = new SafetyChecker({ onConfirm: async () => true });
  const denied = await checker.confirmIfDangerous('rm -rf x', pre.signal);
  check('an already-aborted signal denies without asking', denied.approved === false);
}

console.log('\n=== the CLI approval prompt dismisses itself ===');
{
  const c = new AbortController();
  setTimeout(() => c.abort(), 100);
  const t0 = Date.now();
  const res = await capture(() => cliConfirmDangerousCommand({ command: 'rm -rf x', reasons: ['r'], signal: c.signal }));
  check('abort answers "no" instead of waiting on stdin', res.result === false && Date.now() - t0 < 1500, `${res.result} ${Date.now() - t0}ms`);
}

console.log('\n=== a subagent is cancelled with its parent ===');
{
  const pidFile = path.join(tmp, 'child.pid');
  const model = new FakeModel([
    { toolCalls: [{ name: 'run_subagent', args: { task: 'start the thing' }, id: 'call_sub' }] },
    { toolCalls: [{ name: 'run_bash', args: { command: hangCommand(pidFile), timeout_ms: 60000 }, id: 'call_child_bash' }] },
    { content: 'must not be reached' },
  ]);
  const config: AliaConfig = { name: 't', vendor: 't', apiKey: 'k', apiType: 'chat-completions', models: [modelConfig] };
  const events: AgentEvent[] = [];
  const session = createSession({
    workspace: tmp,
    config,
    client: model.client,
    skillRoots: [],
    autoApprove: true,
    onEvent: (e) => events.push(e),
  });
  const controller = new AbortController();
  const running = session.run('delegate', { signal: controller.signal });
  const pid = await readPid(pidFile);
  const abortedAt = Date.now();
  controller.abort();
  const r = await running;
  const took = Date.now() - abortedAt;

  check('parent run is cancelled within a second', r.status === 'cancelled' && took < 1000, `${r.status} ${took}ms`);
  check("the child's process is dead", await diesWithin(pid, 3000));
  const fin = events.find((e) => e.type === 'subagent_finished') as any;
  check('subagent_finished reports cancelled', fin?.status === 'cancelled', JSON.stringify(fin));
  check('no model call happened after the cancel', model.callCount === 2, `calls=${model.callCount}`);
  const msgs = session.agent.getMessages();
  check('parent history is valid (the run_subagent call got its tool message)', historyIsValid(msgs).ok, historyIsValid(msgs).why);
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll cancellation checks passed.');
