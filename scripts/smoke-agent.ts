import OpenAI from 'openai';
import { AliaAgent } from '../src/agent/agentLoop.js';
import { ToolRegistry, ToolDefinition } from '../src/tools/index.js';
import { SafetyChecker } from '../src/safety/safetyChecker.js';
import { ContextManager } from '../src/context/contextManager.js';
import { FakeModel, ScriptedTurn } from './lib/fakeModel.js';

let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.log(`  ✘ ${name} ${extra}`);
  }
}

/** Runs fn with the agent's UI output (spinner, tool previews) swallowed. */
async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log;
  const write = process.stdout.write;
  console.log = () => {};
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    return await fn();
  } finally {
    console.log = log;
    process.stdout.write = write;
  }
}

const seenContexts: string[] = [];
const echoTool: ToolDefinition<{ text: string }> = {
  name: 'echo',
  description: 'Echo the text back.',
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  execute: async (args, ctx) => {
    seenContexts.push(ctx.workingDirectory);
    return `echo:${args.text}`;
  },
};

function makeAgent(turns: ScriptedTurn[], opts: { maxSteps?: number; repeatLast?: boolean } = {}) {
  const model = new FakeModel(turns, opts.repeatLast ? 'repeat-last' : 'throw');
  const tools = new ToolRegistry();
  tools.register(echoTool);
  const agent = new AliaAgent({
    client: model.client,
    model: 'fake-model',
    modelConfig: { id: 'fake-model', name: 'fake', url: 'http://fake', toolCalling: true },
    toolRegistry: tools,
    safetyChecker: new SafetyChecker(true),
    contextManager: new ContextManager(),
    workingDirectory: process.cwd(),
    systemPrompt: 'test system prompt',
    maxSteps: opts.maxSteps,
  });
  return { model, agent };
}

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;
const lastToolMessage = (msgs: Msg[]) => [...msgs].reverse().find((m) => m.role === 'tool');

console.log('\n=== completed ===');
{
  const { model, agent } = makeAgent([{ content: 'all done' }]);
  const r = await quiet(() => agent.runDetailed('hi'));
  check('status completed', r.status === 'completed', JSON.stringify(r));
  check('text is the final answer', r.text === 'all done');
  check('one step', r.steps === 1);
  check('no failure tag', r.failure === undefined);
  check('request carried system + user', model.requests[0].messages.length === 2 && model.requests[0].messages[0].role === 'system');
  check('tools were advertised', model.requests[0].toolNames.includes('echo'));
}

console.log('\n=== tool round-trip ===');
{
  const { model, agent } = makeAgent([
    { reasoning: 'let me call echo', toolCalls: [{ name: 'echo', args: { text: 'ping' } }] },
    (req) => ({ content: `saw ${(lastToolMessage(req.messages)?.content as string) ?? 'nothing'}` }),
  ]);
  const r = await quiet(() => agent.runDetailed('use echo'));
  check('completed after tool call', r.status === 'completed' && r.steps === 2, JSON.stringify(r));
  check('tool result fed back to the model', r.text === 'saw echo:ping', r.text);
  check('tool got the working directory', seenContexts.at(-1) === process.cwd());
  check('history: system,user,assistant(tool),tool,assistant', agent.getMessages().length === 5);
}

console.log('\n=== tool errors are fed back, loop continues ===');
{
  const { agent } = makeAgent([
    { toolCalls: [{ name: 'does_not_exist', args: {} }, { name: 'echo', args: '{bad json' }] },
    (req) => {
      const tools = req.messages.filter((m) => m.role === 'tool').map((m) => m.content as string);
      const ok = tools.length === 2 && tools[0].startsWith('Error: Tool "does_not_exist"') && tools[1].startsWith('Error parsing JSON');
      return { content: ok ? 'recovered' : `unexpected: ${tools.join(' | ')}` };
    },
  ]);
  const r = await quiet(() => agent.runDetailed('break things'));
  check('both errors reached the model and run completed', r.status === 'completed' && r.text === 'recovered', r.text);
}

console.log('\n=== max_steps ===');
{
  const { model, agent } = makeAgent([{ toolCalls: [{ name: 'echo', args: { text: 'again' } }] }], {
    maxSteps: 3,
    repeatLast: true,
  });
  const r = await quiet(() => agent.runDetailed('loop forever'));
  check('status max_steps', r.status === 'max_steps', JSON.stringify(r));
  check('steps equals the cap', r.steps === 3 && model.callCount === 3);
  check('message names the cap', r.text.includes('(3)'));
}

console.log('\n=== failed: API error ===');
{
  const { agent } = makeAgent([{ throws: 'connection refused' }]);
  const r = await quiet(() => agent.runDetailed('hi'));
  check('status failed / api_error', r.status === 'failed' && r.failure === 'api_error', JSON.stringify(r));
  check('text carries the cause', r.text.includes('connection refused'));
  check('step counted', r.steps === 1);
}

console.log('\n=== failed: empty response ===');
{
  const { agent } = makeAgent([{ empty: true }]);
  const r = await quiet(() => agent.runDetailed('hi'));
  check('status failed / empty_response', r.status === 'failed' && r.failure === 'empty_response', JSON.stringify(r));
}

console.log('\n=== run() is a thin wrapper ===');
{
  const ok = makeAgent([{ content: 'plain' }]);
  check('returns the text on success', (await quiet(() => ok.agent.run('hi'))) === 'plain');

  const capped = makeAgent([{ toolCalls: [{ name: 'echo', args: { text: 'x' } }] }], { maxSteps: 2, repeatLast: true });
  const capText = await quiet(() => capped.agent.run('hi'));
  check('returns the max-steps message (unchanged format)', capText === 'Agent reached maximum allowable steps (2) without concluding.', capText);

  const bad = makeAgent([{ throws: 'boom' }]);
  check('returns the API error message (unchanged format)', (await quiet(() => bad.agent.run('hi'))) === 'API request failed: boom');

  const empty = makeAgent([{ empty: true }]);
  check('returns the empty-response message (unchanged format)', (await quiet(() => empty.agent.run('hi'))) === 'Empty response received.');
}

console.log('\n=== steps are per-run, history is cumulative ===');
{
  const { agent } = makeAgent([{ content: 'first' }, { content: 'second' }]);
  const a = await quiet(() => agent.runDetailed('one'));
  const b = await quiet(() => agent.runDetailed('two'));
  check('each run reports its own step count', a.steps === 1 && b.steps === 1);
  check('history accumulates across runs', agent.getMessages().length === 5);
  agent.reset();
  check('reset clears back to the system prompt', agent.getMessages().length === 1);
}

console.log('\n=== fake model harness itself ===');
{
  const model = new FakeModel([{ content: 'only' }]);
  let threw = false;
  try {
    await model.client.chat.completions.create({ model: 'm', messages: [{ role: 'user', content: 'a' }] });
    await model.client.chat.completions.create({ model: 'm', messages: [{ role: 'user', content: 'b' }] });
  } catch (e: any) {
    threw = e.message.includes('script exhausted');
  }
  check('exhausted script fails loudly by default', threw);
  check('requests are snapshotted', model.requests.length === 2 && model.requests[0].messages[0].content === 'a');
}

console.log(failures === 0 ? '\nAll agent checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
