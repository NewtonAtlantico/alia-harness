import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AliaAgent } from '../src/core/agent/agentLoop.js';
import { AgentEvent, combineSinks, eventsToAgentUI } from '../src/core/agent/events.js';
import { AgentUI } from '../src/core/agent/agentUI.js';
import { ToolRegistry, ToolDefinition } from '../src/core/tools/index.js';
import { SafetyChecker } from '../src/core/safety/safetyChecker.js';
import { ContextManager } from '../src/core/context/contextManager.js';
import { AliaConfig } from '../src/core/config.js';
import { createSession } from '../src/core/session.js';
import { FakeModel, ScriptedTurn } from './lib/fakeModel.js';

let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.log(`  ✘ ${name} ${extra}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alia-events-'));
const modelConfig = { id: 'fake-model', name: 'fake', url: 'http://fake', toolCalling: true };
const types = (evs: AgentEvent[]) => evs.map((e) => e.type).join(',');
const lastTool = (req: { messages: any[] }) => String(req.messages.filter((m) => m.role === 'tool').pop()?.content);

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

console.log('\n=== a run with two tool calls ===');
{
  const { agent, events } = makeAgent([
    {
      reasoning: 'let me think',
      content: 'I will look around first.',
      toolCalls: [
        { name: 'list_files', args: { path: '.' }, id: 'call_a' },
        { name: 'does_not_exist', args: {}, id: 'call_b' },
      ],
    },
    { content: 'all done' },
  ]);
  const result = await agent.runDetailed('go');

  check(
    'event order',
    types(events) ===
      [
        'run_started',
        'model_started',
        'model_finished',
        'thinking',
        'assistant_message',
        'tool_call_started',
        'tool_call_finished',
        'tool_call_started',
        'tool_call_finished',
        'model_started',
        'model_finished',
        'assistant_message',
        'run_finished',
      ].join(','),
    types(events)
  );

  const started = events.filter((e) => e.type === 'tool_call_started') as Extract<AgentEvent, { type: 'tool_call_started' }>[];
  const finished = events.filter((e) => e.type === 'tool_call_finished') as Extract<AgentEvent, { type: 'tool_call_finished' }>[];
  check("tool call ids are the model's tool_call_ids, and pair up", started.map((e) => e.id).join() === 'call_a,call_b' && finished.map((e) => e.id).join() === 'call_a,call_b');
  check('started carries name and raw args', started[0].name === 'list_files' && JSON.parse(started[0].args).path === '.');
  check('finished carries the result and duration', typeof finished[0].durationMs === 'number' && finished[0].durationMs >= 0 && finished[0].result.length > 0);
  check('isError is set for a failing call only', finished[0].isError === false && finished[1].isError === true && finished[1].result.startsWith('Error:'));

  const msgs = events.filter((e) => e.type === 'assistant_message') as Extract<AgentEvent, { type: 'assistant_message' }>[];
  check('text written alongside tool calls is emitted as non-final', msgs[0].final === false && msgs[0].text === 'I will look around first.');
  check('the closing answer is final', msgs[1].final === true && msgs[1].text === 'all done');
  check('reasoning is emitted', (events.find((e) => e.type === 'thinking') as any)?.text === 'let me think');

  const steps = events.filter((e) => e.type === 'model_started').map((e: any) => e.step);
  check('model steps are numbered', steps.join() === '1,2');

  const rs = events[0] as any;
  const rf = events.at(-1) as any;
  check('run_started and run_finished share a runId', typeof rs.runId === 'string' && rs.runId.length > 8 && rs.runId === rf.runId);
  check('run_finished carries the same result runDetailed returned', JSON.stringify(rf.result) === JSON.stringify(result) && result.status === 'completed');
  check('no event is tagged as a subagent', events.every((e) => e.subagentId === undefined));
  check('events are plain data (survive JSON round-trip unchanged)', JSON.stringify(JSON.parse(JSON.stringify(events))) === JSON.stringify(events));
}

console.log('\n=== failure paths still close the run ===');
{
  const api = makeAgent([{ throws: 'boom' }]);
  const r1 = await api.agent.runDetailed('x');
  check('API error: model_finished, error notice, run_finished(failed)', types(api.events) === 'run_started,model_started,model_finished,notice,run_finished' && r1.status === 'failed');
  check('API error notice has the message', (api.events[3] as any).level === 'error' && (api.events[3] as any).message === 'API request failed: boom');

  const empty = makeAgent([{ empty: true }]);
  await empty.agent.runDetailed('x');
  check('empty response: error notice then run_finished(failed)', types(empty.events) === 'run_started,model_started,model_finished,notice,run_finished' && (empty.events.at(-1) as any).result.failure === 'empty_response');

  const loop: ScriptedTurn = { toolCalls: [{ name: 'list_files', args: { path: '.' } }] };
  const capped = makeAgent([loop, loop], { maxSteps: 2 });
  await capped.agent.runDetailed('x');
  const notice = capped.events.find((e) => e.type === 'notice') as any;
  check('step cap: error notice, then run_finished(max_steps)', notice?.level === 'error' && notice.message.includes('maximum allowable steps') && (capped.events.at(-1) as any).result.status === 'max_steps');
}

console.log('\n=== observers cannot break a run ===');
{
  const seen: string[] = [];
  const ui: AgentUI = { printAssistantMessage: (t) => seen.push(t) };
  const { agent } = makeAgent([{ content: 'hi' }], {
    ui,
    onEvent: () => {
      throw new Error('observer bug');
    },
  });
  const r = await agent.runDetailed('x');
  check('a throwing onEvent does not fail the run', r.status === 'completed' && r.text === 'hi');
  check('and does not starve the other observer (ui + onEvent are both fed)', seen.join() === 'hi');
}

console.log('\n=== context compaction ===');
{
  const big: ToolDefinition = {
    name: 'big',
    description: 'lots of text',
    parameters: { type: 'object', properties: {} },
    execute: async () => 'x'.repeat(2000),
  };
  const tools = new ToolRegistry();
  tools.register(big);
  const { events } = await (async () => {
    const turns: ScriptedTurn[] = [...Array.from({ length: 9 }, () => ({ toolCalls: [{ name: 'big', args: {} }] }) as ScriptedTurn), { content: 'done' }];
    const made = makeAgent(turns, { toolRegistry: tools, contextManager: new ContextManager({ maxInputTokens: 600 }) });
    await made.agent.runDetailed('go');
    return made;
  })();
  const idx = events.findIndex((e) => e.type === 'context_compacted');
  check('context_compacted is emitted when history is pruned', idx > 0);
  check('...before the model request that needed the room', events[idx + 1]?.type === 'model_started');
}

console.log('\n=== subagents: events nest under the parent tool call ===');
{
  const model = new FakeModel([
    { toolCalls: [{ name: 'run_subagent', args: { task: 'child task', max_steps: 7 }, id: 'call_p' }] },
    { toolCalls: [{ name: 'list_files', args: { path: '.' }, id: 'call_c' }] },
    { content: 'STATUS: completed\nSUMMARY: child done' },
    (req) => ({ content: lastTool(req) }),
  ]);
  const config: AliaConfig = { name: 't', vendor: 't', apiKey: 'k', apiType: 'chat-completions', models: [modelConfig] };
  const events: AgentEvent[] = [];
  const session = createSession({ workspace: tmp, config, client: model.client, skillRoots: [], onEvent: (e) => events.push(e) });
  await session.run('delegate');

  const startedIdx = events.findIndex((e) => e.type === 'subagent_started');
  const finishedIdx = events.findIndex((e) => e.type === 'subagent_finished');
  const started = events[startedIdx] as Extract<AgentEvent, { type: 'subagent_started' }>;
  const finished = events[finishedIdx] as Extract<AgentEvent, { type: 'subagent_finished' }>;
  check('subagent_started points at the parent run_subagent tool call', started?.parentToolCallId === 'call_p' && started.label === 'child task' && started.maxSteps === 7 && started.quiet === true, JSON.stringify(started));
  check('subagent_finished reports status and steps', finished?.status === 'completed' && finished.steps === 2 && finished.maxSteps === 7 && finished.id === started.id, JSON.stringify(finished));

  const between = events.slice(startedIdx + 1, finishedIdx);
  check('everything between start and finish belongs to the child', between.length > 0 && between.every((e) => e.subagentId === started.id));
  check("child's own tool call is visible with its id", between.some((e) => e.type === 'tool_call_started' && (e as any).id === 'call_c'));
  const outside = events.filter((_, i) => i < startedIdx || i > finishedIdx);
  check('nothing outside that window is tagged', outside.every((e) => e.subagentId === undefined));

  const pStart = events.findIndex((e) => e.type === 'tool_call_started' && (e as any).id === 'call_p');
  const pEnd = events.findIndex((e) => e.type === 'tool_call_finished' && (e as any).id === 'call_p');
  check('the parent row opens before the child and closes after it', pStart < startedIdx && finishedIdx < pEnd, `${pStart} ${startedIdx} ${finishedIdx} ${pEnd}`);
  check('child run has its own run_started/run_finished', between.some((e) => e.type === 'run_started') && between.some((e) => e.type === 'run_finished'));
}

console.log('\n=== permission requests are events too ===');
{
  const model = new FakeModel([
    { toolCalls: [{ name: 'run_bash', args: { command: 'rm -rf not-there' } }] },
    { content: 'ok' },
  ]);
  const config: AliaConfig = { name: 't', vendor: 't', apiKey: 'k', apiType: 'chat-completions', models: [modelConfig] };
  const log: string[] = [];
  const session = createSession({
    workspace: tmp,
    config,
    client: model.client,
    skillRoots: [],
    ui: { getScopeLabel: () => 'scope-x' },
    onEvent: (e) => {
      if (e.type === 'permission_requested') log.push(`event:${e.command}|${e.reasons.length}|${e.requester}`);
    },
    onConfirm: async (ctx) => {
      log.push(`handler:${ctx.command}`);
      return false;
    },
  });
  await session.run('go');
  check('event fires before the handler, with command, reasons and requester', log.length === 2 && log[0] === 'event:rm -rf not-there|1|scope-x' && log[1] === 'handler:rm -rf not-there', JSON.stringify(log));
}

console.log('\n=== eventsToAgentUI adapter ===');
{
  const calls: string[] = [];
  const ui: AgentUI = {
    startThinking: () => {
      calls.push('startThinking');
      return { stop: () => calls.push('stopThinking') };
    },
    printThinking: (t) => calls.push(`thinking:${t}`),
    printAssistantMessage: (t) => calls.push(`assistant:${t}`),
    printToolCall: (n, a) => calls.push(`call:${n}:${a}`),
    printToolResult: (r, e) => calls.push(`result:${r}:${e}`),
    printError: (m) => calls.push(`error:${m}`),
    printInfo: (m) => calls.push(`info:${m}`),
    printSuccess: (m) => calls.push(`success:${m}`),
    pushScope: (o) => calls.push(`push:${o.label}:${o.quiet}`),
    popScope: () => calls.push('pop'),
  };
  const sink = eventsToAgentUI(ui);
  const feed = (...evs: AgentEvent[]) => evs.forEach(sink);
  feed(
    { type: 'run_started', runId: 'r' },
    { type: 'model_started', step: 1 },
    { type: 'model_finished', step: 1 },
    { type: 'assistant_message', text: 'hidden', final: false },
    { type: 'assistant_message', text: 'shown', final: true },
    { type: 'tool_call_started', id: '1', name: 'n', args: '{}' },
    { type: 'tool_call_finished', id: '1', name: 'n', result: 'r', isError: true, durationMs: 5 },
    { type: 'context_compacted' },
    { type: 'subagent_started', id: 's', label: 'L', maxSteps: 3, skill: 'sk', quiet: false },
    { type: 'subagent_finished', id: 's', label: 'L', status: 'completed', steps: 2, maxSteps: 3 },
    { type: 'notice', level: 'success', message: 'yay' },
    { type: 'permission_requested', id: 'p', command: 'c', reasons: [] },
    { type: 'run_finished', runId: 'r', result: { status: 'completed', text: '', steps: 1 } }
  );
  check(
    'maps each event to the call the agent used to make',
    calls.join(' | ') ===
      [
        'startThinking',
        'stopThinking',
        'assistant:shown',
        'call:n:{}',
        'result:r:true',
        'info:Context window compacted to preserve token budget.',
        'info:Subagent started (max 3 steps, skill sk): L',
        'push:L:false',
        'pop',
        'info:Subagent finished: completed (2/3 steps)',
        'success:yay',
      ].join(' | '),
    calls.join(' | ')
  );

  const a: string[] = [];
  const b: string[] = [];
  const both = combineSinks((e) => a.push(e.type), undefined, (e) => b.push(e.type));
  both({ type: 'context_compacted' });
  check('combineSinks feeds every sink and skips undefined ones', a.join() === 'context_compacted' && b.join() === 'context_compacted');
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll event checks passed.');
