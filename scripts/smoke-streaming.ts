import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AliaConfig } from '../src/core/config.js';
import { AgentEvent } from '../src/core/agent/events.js';
import { createSession } from '../src/core/session.js';
import { FakeModel, ScriptedTurn, StreamBehaviour } from './lib/fakeModel.js';

let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.log(`  ✘ ${name} ${extra}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alia-stream-'));
fs.writeFileSync(path.join(tmp, 'a.txt'), 'conteúdo do arquivo\n');
const config: AliaConfig = { name: 't', vendor: 't', apiKey: 'k', apiType: 'chat-completions', models: [{ id: 'fake-model', name: 'fake', url: 'http://fake', toolCalling: true }] };

function open(turns: ScriptedTurn[], behaviour: StreamBehaviour = 'ok', streaming = true) {
  const model = new FakeModel(turns, 'throw', behaviour);
  const events: AgentEvent[] = [];
  const session = createSession({ workspace: tmp, config, client: model.client, onEvent: (e) => events.push(e), autoApprove: true, ...(streaming ? { streaming: true } : {}) });
  return { model, events, session };
}
const types = (events: AgentEvent[]) => events.map((e) => e.type);
const joined = (events: AgentEvent[], type: 'assistant_delta' | 'thinking_delta') => events.filter((e) => e.type === type).map((e: any) => e.text).join('');

console.log('\n=== a streamed answer ===');
{
  const { model, events, session } = open([{ content: 'Olá! Esta é a resposta completa.', reasoning: 'Vou pensar um pouco.' }]);
  const result = await session.run('oi');
  check('the request asked for a stream, and the run completed', model.requests[0].stream === true && result.status === 'completed' && result.text === 'Olá! Esta é a resposta completa.');
  const deltas = events.filter((e) => e.type === 'assistant_delta');
  check('the text came in pieces, which add up to the answer', deltas.length > 3 && joined(events, 'assistant_delta') === 'Olá! Esta é a resposta completa.');
  check('so did the reasoning', events.filter((e) => e.type === 'thinking_delta').length > 1 && joined(events, 'thinking_delta') === 'Vou pensar um pouco.');
  check('the whole answer and the whole reasoning still come as the events that always existed (a front-end that ignores deltas loses nothing)', events.some((e) => e.type === 'assistant_message' && e.final && e.text === 'Olá! Esta é a resposta completa.') && events.some((e) => e.type === 'thinking' && e.text === 'Vou pensar um pouco.'));
  const order = types(events);
  check('the order is: model starts, deltas, model finishes, then the whole messages', order.indexOf('model_started') < order.indexOf('assistant_delta') && order.lastIndexOf('assistant_delta') < order.indexOf('model_finished') && order.indexOf('model_finished') < order.indexOf('assistant_message'), order.join());
  check('every delta says which step it belongs to', events.filter((e) => e.type === 'assistant_delta').every((e: any) => e.step === 1));
  const last: any = session.getHistory?.().at(-1) ?? undefined;
  check('the saved history is the same as without streaming: one assistant message with the whole text', last === undefined || last.content === 'Olá! Esta é a resposta completa.');
}

console.log('\n=== tool calls arrive in fragments ===');
{
  const { events, session } = open([
    { content: 'Vou ler o arquivo.', toolCalls: [{ name: 'read_file', args: { path: 'a.txt' }, id: 'c1' }] },
    { content: 'Li: ok.' },
  ]);
  const result = await session.run('leia');
  const started = events.find((e) => e.type === 'tool_call_started') as any;
  const finished = events.find((e) => e.type === 'tool_call_finished') as any;
  check('the call is put together from its pieces and runs: its name, its id, its arguments', started?.name === 'read_file' && started.id === 'c1' && JSON.parse(started.args).path === 'a.txt' && finished && !finished.isError && finished.result.includes('conteúdo do arquivo'));
  check('the text beside the call is streamed too, then arrives whole as a non-final message', joined(events, 'assistant_delta').startsWith('Vou ler o arquivo.') && events.some((e) => e.type === 'assistant_message' && !e.final && e.text === 'Vou ler o arquivo.'));
  check('the second step streams as well, with its own step number', events.some((e) => e.type === 'assistant_delta' && (e as any).step === 2) && result.status === 'completed' && result.text === 'Li: ok.');
}

console.log('\n=== off by default ===');
{
  const { model, events, session } = open([{ content: 'Sem streaming.' }], 'ok', false);
  const result = await session.run('oi');
  check('without the option nothing is streamed: no stream requested, no deltas, same answer', !model.requests[0].stream && !types(events).includes('assistant_delta') && result.text === 'Sem streaming.');
}

console.log('\n=== an endpoint that cannot stream ===');
{
  const { model, events, session } = open([{ content: 'Resposta inteira.' }, { content: 'Outra resposta.' }], 'refuse-400');
  const result = await session.run('oi');
  check('the step is repeated without streaming, and the run completes (streaming is never a reason to fail)', result.status === 'completed' && result.text === 'Resposta inteira.' && model.requests.length === 2 && model.requests[0].stream && !model.requests[1].stream);
  check('no deltas, and one notice says why the answer came whole', !types(events).includes('assistant_delta') && events.filter((e) => e.type === 'notice' && /does not stream/.test((e as any).message)).length === 1);
  const second = await session.run('de novo');
  check('the agent remembers: the next request does not ask for a stream, and the notice is not repeated', second.text === 'Outra resposta.' && !model.requests[2].stream && model.requests.length === 3 && events.filter((e) => e.type === 'notice' && /does not stream/.test((e as any).message)).length === 1);
}
{
  const { model, events, session } = open([{ content: 'Resposta única.' }], 'ignore-flag');
  const result = await session.run('oi');
  check('an endpoint that ignores the flag and answers whole: that answer is used (one request, no repeat), no deltas', result.text === 'Resposta única.' && model.requests.length === 1 && !types(events).includes('assistant_delta'));
}
{
  const { model, session } = open([{ content: 'Depois do stream vazio.' }], 'empty');
  const result = await session.run('oi');
  check('a stream with nothing in it is treated as "cannot stream": the step is repeated', result.text === 'Depois do stream vazio.' && model.requests.length === 2);
}
{
  const { model, events, session } = open([{ content: 'x' }], 'unauthorized');
  const result = await session.run('oi');
  check('a bad key is not about streaming: the run fails as it always did, and nothing is retried', result.status === 'failed' && result.failure === 'api_error' && model.requests.length === 1 && !events.some((e) => e.type === 'notice' && /does not stream/.test((e as any).message)));
}

console.log('\n=== cancelling in the middle of an answer ===');
{
  const controller = new AbortController();
  const { events, session } = open([{ content: 'Uma resposta bem comprida que vai ser interrompida no meio do caminho.' }], 'slow');
  let seen = 0;
  const run = session.run('oi', { signal: controller.signal });
  const watch = setInterval(() => {
    seen = events.filter((e) => e.type === 'assistant_delta').length;
    if (seen >= 3) controller.abort();
  }, 10);
  const result = await run;
  clearInterval(watch);
  const got = events.filter((e) => e.type === 'assistant_delta').length;
  check('the run ends as cancelled, with only part of the text streamed', result.status === 'cancelled' && got >= 3 && joined(events, 'assistant_delta').length < 60);
  check('no whole message is invented for the part that arrived, and the history stays valid (the user message only)', !events.some((e) => e.type === 'assistant_message'));
  const again = open([{ content: 'Voltei.' }]);
  void again;
}

fs.rmSync(tmp, { recursive: true, force: true });
if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll streaming checks passed.');
