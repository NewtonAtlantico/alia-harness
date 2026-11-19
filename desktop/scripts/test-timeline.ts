/**
 * The chat timeline's event-to-row mapper (A6), tested with event sequences RECORDED from the real engine runtime
 * (fake model, real tools, real commands), plus hand-made events for what the fake model cannot easily produce.
 * No browser. Run from desktop/: `npm run test:timeline`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AliaConfig } from 'alia-harness/core';
import { FakeModel, type ScriptedTurn } from '../../scripts/lib/fakeModel';
import { EngineRuntime } from '../src/engine/runtime';
import type { PushMessage } from '../src/shared/ipc';
import { emptyTimeline, applyPush, baseName, bashOutcome, formatDuration, groupReads, rowsFromMessages, summarizeTool, type TimelineState, type ToolRow } from '../src/renderer/src/lib/timeline';
import { sleep } from './lib/hang';

let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.log(`  ✘ ${name} ${extra}`);
  }
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alia-timeline-'));
let n = 0;
const mk = (label = 'd') => {
  const dir = path.join(tmp, `${label}-${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const config: AliaConfig = { name: 't', vendor: 't', apiKey: 'k', apiType: 'chat-completions', models: [{ id: 'fake-model', name: 'fake', url: 'http://fake', toolCalling: true }] };

interface Recorded {
  pushes: PushMessage[];
  state: TimelineState;
  sessionId: string;
  ws: string;
  call: (name: string, payload?: object) => Promise<any>;
}

/** Runs one prompt through the real runtime and folds every push of that conversation into a timeline, as the page does. */
async function record(turns: ScriptedTurn[], prompt: string, opts: { mode?: 'auto' | 'ask-commands'; skills?: boolean; respond?: 'allow_once' | 'deny'; cancelAfterMs?: number; setup?: (ws: string) => void } = {}): Promise<Recorded> {
  const pushes: PushMessage[] = [];
  const model = new FakeModel(turns);
  const rt = new EngineRuntime({ post: (m) => pushes.push(m as PushMessage), clientFor: () => model.client });
  const skills = mk('skills');
  if (opts.skills) {
    fs.mkdirSync(path.join(skills, 'greet'));
    fs.writeFileSync(path.join(skills, 'greet', 'SKILL.md'), '---\nname: greet\ndescription: Greets\n---\nHELLO-BODY\n');
  }
  await rt.handle('engine.configure', { config, skillRoots: opts.skills ? [{ label: 't', dir: skills }] : [], dataDirs: { sessions: mk('s'), permissions: mk('p') }, permissionMode: opts.mode ?? 'auto' });
  const ws = mk('project');
  opts.setup?.(ws);
  const { sessionId } = await rt.handle('session.open', { projectPath: ws });
  await rt.handle('session.run', { sessionId, text: prompt });
  const finished = () => pushes.some((m) => m.kind === 'event' && m.sessionId === sessionId && m.event.type === 'run_finished');
  const end = Date.now() + 15000;
  let responded = 0;
  let cancelled = false;
  const started = Date.now();
  while (!finished() && Date.now() < end) {
    const open = pushes.filter((m) => m.kind === 'interaction');
    if (opts.respond && open.length > responded) {
      await rt.handle('interaction.respond', { id: (open[responded] as any).interaction.id, response: { decision: opts.respond } });
      responded++;
    }
    if (opts.cancelAfterMs && !cancelled && Date.now() - started > opts.cancelAfterMs) {
      cancelled = true;
      await rt.handle('session.cancel', { sessionId });
    }
    await sleep(20);
  }
  const mine = pushes.filter((m) => (m.kind === 'event' || m.kind === 'user_message') && m.sessionId === sessionId);
  const state = mine.reduce(applyPush, emptyTimeline);
  return { pushes: mine, state, sessionId, ws, call: (name, payload = {}) => rt.handle(name as any, payload as any) as Promise<any> };
}
const tool = (name: string, args: unknown, id: string): ScriptedTurn => ({ toolCalls: [{ name, args, id }] });
const tools = (...calls: Array<{ name: string; args: unknown; id: string }>): ScriptedTurn => ({ toolCalls: calls });
const kinds = (s: TimelineState) => s.rows.map((r) => (r.kind === 'tool' ? `tool:${r.name}` : r.kind));
const toolRows = (s: TimelineState) => s.rows.filter((r): r is ToolRow => r.kind === 'tool');

console.log('\n=== a plain answer ===');
{
  const r = await record([{ content: 'Olá! Posso ajudar.' }], 'oi');
  check('the user\'s words, then the answer', kinds(r.state).join() === 'user,assistant' && (r.state.rows[0] as any).text === 'oi' && (r.state.rows[1] as any).text === 'Olá! Posso ajudar.' && (r.state.rows[1] as any).final === true);
  check('nothing is left running or busy when the run is over', r.state.running === false && r.state.modelBusy === false);
  const flags = r.pushes.filter((m) => m.kind === 'event').map((m: any) => m.event.type);
  check('the events that produced it are the real ones, in order', flags[0] === 'run_started' && flags.includes('model_started') && flags.at(-1) === 'run_finished');
  check('row ids are unique', new Set(r.state.rows.map((x) => x.id)).size === r.state.rows.length);
}

console.log('\n=== tool calls: reads, listing, writing ===');
{
  const r = await record(
    [
      { content: 'Vou olhar os arquivos.', toolCalls: [{ name: 'list_files', args: { path: '.' }, id: 'l1' }] },
      tools({ name: 'read_file', args: { path: 'a.txt' }, id: 'r1' }, { name: 'read_file', args: { path: 'sub/b.txt' }, id: 'r2' }),
      tool('write_file', { path: 'out/novo.md', content: 'um\ndois\n' }, 'w1'),
      tool('edit_file', { path: 'a.txt', target: 'alfa', replacement: 'ALFA\nbeta2' }, 'e1'),
      { content: 'Pronto.' },
    ],
    'organize',
    { setup: (ws) => { fs.writeFileSync(path.join(ws, 'a.txt'), 'alfa\n'); fs.mkdirSync(path.join(ws, 'sub')); fs.writeFileSync(path.join(ws, 'sub', 'b.txt'), 'b\n'); } }
  );
  check('rows in the order things happened, the text beside a tool call included', kinds(r.state).join() === 'user,assistant,tool:list_files,tool:read_file,tool:read_file,tool:write_file,tool:edit_file,assistant', kinds(r.state).join());
  check('the text written beside tool calls is not the final answer', (r.state.rows[1] as any).final === false && (r.state.rows.at(-1) as any).final === true);
  const [list, r1, r2, w, e] = toolRows(r.state);
  check('every tool call finished, with a duration', toolRows(r.state).every((t) => t.status === 'done' && typeof t.durationMs === 'number'));
  check('each keeps its arguments, parsed', list.args.path === '.' && r1.args.path === 'a.txt' && r2.args.path === 'sub/b.txt');
  check('the write carries what it changed, with no file content', w.changes?.[0].path === 'out/novo.md' && w.changes[0].kind === 'created' && w.changes[0].added === 2 && !JSON.stringify(w.changes).includes('dois'));
  check('the edit carries +added and -removed', e.changes?.[0].path === 'a.txt' && e.changes[0].added === 2 && e.changes[0].removed === 1, JSON.stringify(e.changes));
  const items = groupReads(r.state.rows);
  const group = items.find((i) => i.kind === 'reads') as any;
  check('two reads in a row become one item ("Leu 2 arquivos")', items.filter((i) => i.kind === 'reads').length === 1 && group.rows.length === 2);
  check('summaries say what each was about', JSON.stringify(summarizeTool(list)) === JSON.stringify({ kind: 'list', target: '.' }) && JSON.stringify(summarizeTool(w)) === JSON.stringify({ kind: 'write', target: 'out/novo.md', added: 2, removed: 0 }) && JSON.stringify(summarizeTool(e)) === JSON.stringify({ kind: 'edit', target: 'a.txt', added: 2, removed: 1 }));
}

console.log('\n=== reads that are not next to each other stay apart ===');
{
  const rows = [
    { kind: 'tool', id: '1', name: 'read_file', args: {}, status: 'done', children: [] },
    { kind: 'tool', id: '2', name: 'grep_search', args: { pattern: 'x' }, status: 'done', children: [] },
    { kind: 'tool', id: '3', name: 'read_file', args: {}, status: 'done', children: [] },
    { kind: 'tool', id: '4', name: 'read_file', args: {}, status: 'running', children: [] },
  ] as ToolRow[];
  const items = groupReads(rows);
  check('a search between two reads splits the group; a running read joins its neighbour', items.map((i) => (i.kind === 'reads' ? `reads${i.rows.length}` : (i as ToolRow).name)).join() === 'reads1,grep_search,reads2');
  check('with no reads nothing is grouped', groupReads([]).length === 0);
}

console.log('\n=== shell commands: passed, failed, timed out, denied, cancelled ===');
{
  const r = await record(
    [
      tool('run_bash', { command: 'echo tudo certo' }, 'b1'),
      tool('run_bash', { command: 'node -e "console.error(\'quebrou\'); process.exit(3)"' }, 'b2'),
      tool('run_bash', { command: 'node -e "setTimeout(()=>{},8000)"', timeout_ms: 400 }, 'b3'),
      { content: 'fim' },
    ],
    'rode os comandos'
  );
  const [b1, b2, b3] = toolRows(r.state);
  check('exit code 0 passed', bashOutcome(b1).state === 'passed' && bashOutcome(b1).exitCode === 0 && b1.result!.includes('tudo certo'));
  check('a non-zero exit code failed, and says which', bashOutcome(b2).state === 'failed' && bashOutcome(b2).exitCode === 3, b2.result);
  check('a command that outlived its timeout says so', bashOutcome(b3).state === 'timeout', b3.result);
  check('the command line is the title\'s subject', JSON.stringify(summarizeTool(b1)) === JSON.stringify({ kind: 'bash', target: 'echo tudo certo' }));

  const denied = await record([tool('run_bash', { command: 'echo nunca roda' }, 'd1'), { content: 'ok' }], 'rode', { mode: 'ask-commands', respond: 'deny' });
  check('a command the user refused is "negado", and its text never ran', bashOutcome(toolRows(denied.state)[0]).state === 'denied' && !toolRows(denied.state)[0].result!.includes('nunca roda\n'), toolRows(denied.state)[0].result);

  const pidDir = mk('pid');
  const stopped = await record([tool('run_bash', { command: `node -e "setInterval(()=>{},100)" ${path.join(pidDir, 'x')}`, timeout_ms: 60000 }, 'c1'), { content: 'unused' }], 'rode e pare', { cancelAfterMs: 800 });
  const [c1] = toolRows(stopped.state);
  check('Stop mid-command: the call is cancelled, and the run ends with a "cancelled" row', bashOutcome(c1).state === 'cancelled' && c1.status === 'cancelled' && stopped.state.rows.at(-1)!.kind === 'notice' && (stopped.state.rows.at(-1) as any).code === 'cancelled' && stopped.state.running === false);
}

console.log('\n=== approvals leave their mark on the command that needed them ===');
{
  const once = await record([tool('run_bash', { command: 'echo uma vez' }, 'p1'), { content: 'ok' }], 'rode', { mode: 'ask-commands', respond: 'allow_once' });
  check('allowed once: the call says so', toolRows(once.state)[0].permission === 'allow_once' && bashOutcome(toolRows(once.state)[0]).state === 'passed');
  const denied = await record([tool('run_bash', { command: 'echo nunca' }, 'p2'), { content: 'ok' }], 'rode', { mode: 'ask-commands', respond: 'deny' });
  check('denied: the call says so', toolRows(denied.state)[0].permission === 'deny');
  const auto = await record([tool('run_bash', { command: 'echo sem perguntar' }, 'p3'), { content: 'ok' }], 'rode', { mode: 'auto' });
  check('in auto mode nobody asked, so nothing is recorded', toolRows(auto.state)[0].permission === undefined);
  const ev = (event: any): PushMessage => ({ kind: 'event', sessionId: 's', event });
  let s = [ev({ type: 'tool_call_started', id: 'c', name: 'run_bash', args: '{}' }), ev({ type: 'permission_requested', id: 'i', toolCallId: 'c', command: 'x', reasons: [], dangerous: false, canAlwaysAllow: true })].reduce(applyPush, emptyTimeline);
  check('while the card is open, the call is "pending"', toolRows(s)[0].permission === 'pending');
  s = applyPush(s, ev({ type: 'permission_resolved', id: 'i', toolCallId: 'c', decision: 'cancelled' }));
  check('a cancelled run closes it as cancelled', toolRows(s)[0].permission === 'cancelled');
  s = [ev({ type: 'permission_requested', id: 'i', toolCallId: 'unknown', command: 'x', reasons: [], dangerous: false, canAlwaysAllow: true }), ev({ type: 'permission_requested', id: 'j', command: 'x', reasons: [], dangerous: false, canAlwaysAllow: true })].reduce(applyPush, emptyTimeline);
  check('a request for a call that is not shown, or with no call id, changes nothing', s.rows.length === 0);
}

console.log('\n=== skills and subagents ===');
{
  const r = await record([tool('use_skill', { name: 'greet' }, 'u1'), { content: 'carregada' }], 'use a skill', { skills: true });
  const [u] = toolRows(r.state);
  check('use_skill is a row naming the skill', JSON.stringify(summarizeTool(u)) === JSON.stringify({ kind: 'skill', target: 'greet' }) && u.status === 'done');

  const sub = await record(
    [
      tool('run_subagent', { task: 'Liste os arquivos e resuma.' }, 'p1'),
      tool('list_files', { path: '.' }, 'k1'), // the child's first call
      { content: 'STATUS: done\nSUMMARY: dois arquivos\nARTIFACTS: none\nQUESTIONS: none' }, // the child's report
      { content: 'O subagente terminou.' },
    ],
    'delegue'
  );
  const top = toolRows(sub.state);
  check('the subagent is ONE row for the parent\'s call, with the work nested under it', top.length === 1 && top[0].name === 'run_subagent' && top[0].children.length === 1 && top[0].children[0].name === 'list_files' && top[0].children[0].status === 'done', JSON.stringify(kinds(sub.state)));
  check('it knows its label and how it ended', top[0].subagent?.label === 'Liste os arquivos e resuma.' && top[0].subagent.status === 'completed' && top[0].subagent.steps! >= 1, JSON.stringify(top[0].subagent));
  check('the child\'s own answer is not shown as the parent\'s', sub.state.rows.filter((x) => x.kind === 'assistant').length === 1);
}

console.log('\n=== errors ===');
{
  const r = await record([{ throws: 'o endpoint caiu' }], 'oi');
  const notices = r.state.rows.filter((x) => x.kind === 'notice') as any[];
  check('an API error is one error row, not two (the run\'s end repeats it)', notices.length === 1 && notices[0].code === 'error' && notices[0].message.includes('o endpoint caiu'), JSON.stringify(notices));
  check('...and the run is over', r.state.running === false && r.state.modelBusy === false);
}

console.log('\n=== hand-made events: what the fake model cannot easily produce ===');
{
  const ev = (event: any, sessionId = 's'): PushMessage => ({ kind: 'event', sessionId, event });
  const fold = (...ms: PushMessage[]) => ms.reduce(applyPush, emptyTimeline);

  let s = fold(ev({ type: 'run_started', runId: 'r' }), ev({ type: 'model_started', step: 1 }));
  check('the spinner is on from model_started...', s.modelBusy && s.running);
  s = applyPush(s, ev({ type: 'model_finished', step: 1 }));
  check('...to model_finished', !s.modelBusy && s.running);
  s = applyPush(applyPush(s, ev({ type: 'model_started', step: 2 })), ev({ type: 'run_finished', runId: 'r', result: { status: 'completed', text: 'x', steps: 2 } }));
  check('the end of a run turns everything off, even a model request left open', !s.modelBusy && !s.running);

  s = fold(ev({ type: 'thinking', text: 'Vou ' }), ev({ type: 'thinking', text: 'pensar.' }), ev({ type: 'assistant_message', text: 'ok', final: true }), ev({ type: 'thinking', text: 'de novo' }));
  check('reasoning text arriving in pieces is one row, until something else comes', s.rows.length === 3 && (s.rows[0] as any).text === 'Vou pensar.' && (s.rows[2] as any).text === 'de novo');

  s = fold(ev({ type: 'assistant_message', text: '   ', final: true }));
  check('an empty message adds nothing', s.rows.length === 0);

  s = fold(ev({ type: 'run_started', runId: 'r' }), ev({ type: 'run_finished', runId: 'r', result: { status: 'completed', text: 'Resposta que ninguém anunciou', steps: 1 } }));
  check('a completed run whose answer never came as a message still shows it', s.rows.length === 1 && (s.rows[0] as any).text === 'Resposta que ninguém anunciou' && (s.rows[0] as any).final === true);
  s = fold(ev({ type: 'run_started', runId: 'r' }), ev({ type: 'assistant_message', text: 'A resposta', final: true }), ev({ type: 'run_finished', runId: 'r', result: { status: 'completed', text: 'A resposta', steps: 1 } }));
  check('...but one that did is not shown twice', s.rows.length === 1);

  s = fold(ev({ type: 'notice', level: 'error', message: 'Agent reached maximum allowable steps (30)' }), ev({ type: 'run_finished', runId: 'r', result: { status: 'max_steps', text: 'Agent reached maximum allowable steps (30)', steps: 30 } }));
  check('the step cap is one row', s.rows.length === 1 && (s.rows[0] as any).code === 'error');
  s = fold(ev({ type: 'run_finished', runId: 'r', result: { status: 'max_steps', text: 'Passou do limite', steps: 30 } }));
  check('...and one row even when no notice came first', s.rows.length === 1 && (s.rows[0] as any).code === 'max_steps');

  s = fold(ev({ type: 'context_compacted', summarized: 12, tokensBefore: 90000, tokensAfter: 8000 }));
  check('compaction is a row with the sizes before and after', (s.rows[0] as any).code === 'compacted' && (s.rows[0] as any).tokensBefore === 90000 && (s.rows[0] as any).tokensAfter === 8000);

  s = fold(ev({ type: 'notice', level: 'info', message: 'ok' }), ev({ type: 'notice', level: 'success', message: 'feito' }));
  check('info and success notices keep their level', (s.rows[0] as any).code === 'info' && (s.rows[1] as any).code === 'success');

  s = fold(ev({ type: 'tool_call_finished', id: 'late', name: 'read_file', result: 'x', isError: false, durationMs: 5 }));
  check('a call seen only at its end (the page opened mid-run) still appears', toolRows(s).length === 1 && toolRows(s)[0].status === 'done');
  s = fold(ev({ type: 'tool_call_started', id: 'a', name: 'read_file', args: '{"path":"1"}' }), ev({ type: 'tool_call_started', id: 'a', name: 'read_file', args: '{"path":"2"}' }));
  check('a call announced twice with one id is one row', toolRows(s).length === 1 && toolRows(s)[0].args.path === '2');
  s = fold(ev({ type: 'tool_call_started', id: 'a', name: 'read_file', args: '{ not json' }));
  check('arguments that are not JSON do not break the row', toolRows(s)[0].name === 'read_file' && Object.keys(toolRows(s)[0].args).length === 0);
  s = fold(ev({ type: 'tool_call_started', id: 'a', name: 'run_bash', args: '{}' }), ev({ type: 'tool_call_finished', id: 'a', name: 'run_bash', result: '[Cancelled by user] x', isError: true, durationMs: 1 }));
  check('a cancelled call is "cancelled", not an error', toolRows(s)[0].status === 'cancelled');
  s = fold(ev({ type: 'tool_call_started', id: 'a', name: 'read_file', args: '{}' }), ev({ type: 'tool_call_finished', id: 'a', name: 'read_file', result: 'Error: File not found', isError: true, durationMs: 1 }));
  check('a failed call is an error', toolRows(s)[0].status === 'error');

  s = fold(ev({ type: 'subagent_started', id: 'sub1', parentToolCallId: 'p', label: 'x', maxSteps: 5, quiet: true }), ev({ type: 'tool_call_started', id: 'c', name: 'grep_search', args: '{}', subagentId: 'sub1' }), ev({ type: 'assistant_message', text: 'interno', final: true, subagentId: 'sub1' }), ev({ type: 'run_finished', runId: 'child', result: { status: 'completed', text: 'x', steps: 1 }, subagentId: 'sub1' }));
  check('a subagent with no parent row still gets one; its events never end the parent\'s run, and its chatter is not shown', toolRows(s).length === 1 && toolRows(s)[0].children.length === 1 && s.rows.every((x) => x.kind === 'tool') && toolRows(s)[0].id === 'p' && toolRows(s)[0].name === 'run_subagent' && s.running === false);

  s = fold({ kind: 'user_message', sessionId: 's', text: 'Olá' });
  check('the user\'s message is a row', s.rows.length === 1 && s.rows[0].kind === 'user');
  const other: PushMessage[] = [{ kind: 'interaction_closed', id: 'i', sessionId: 's' }, { kind: 'window_state', maximized: true }, ev({ type: 'permission_requested', id: 'p', command: 'x', reasons: [], dangerous: false, canAlwaysAllow: true })];
  check('what is not for the timeline (cards, window state) changes nothing', fold(...other).rows.length === 0);
}

console.log('\n=== the same conversation, reopened from disk ===');
{
  const live = await record(
    [
      { content: 'Vou ler.', toolCalls: [{ name: 'read_file', args: { path: 'a.txt' }, id: 'r1' }] },
      tool('run_bash', { command: 'node -e "process.exit(2)"' }, 'b1'),
      { content: 'Resumo final.' },
    ],
    'leia e rode',
    { setup: (ws) => fs.writeFileSync(path.join(ws, 'a.txt'), 'x\n') }
  );
  const saved = await live.call('conversations.load', { id: live.sessionId });
  const reopened = rowsFromMessages(saved.messages, { annotations: saved.annotations });
  check('the saved conversation carries how long each call took', toolRows(reopened).every((t) => typeof t.durationMs === 'number') && toolRows(reopened).length === 2);
  check('...the same numbers the live run showed', toolRows(reopened).map((t) => t.durationMs).join() === toolRows(live.state).map((t) => t.durationMs).join());
  check('the rows are the same kinds in the same order', kinds(reopened).join() === kinds(live.state).join(), `${kinds(reopened).join()}  vs  ${kinds(live.state).join()}`);
  check('the same tool calls, with the same arguments and outcomes', toolRows(reopened).map((t) => `${t.name}:${t.status}:${JSON.stringify(t.args)}`).join('|') === toolRows(live.state).map((t) => `${t.name}:${t.status}:${JSON.stringify(t.args)}`).join('|'));
  check('the command still reads as failed with its exit code', bashOutcome(toolRows(reopened)[1]).state === 'failed' && bashOutcome(toolRows(reopened)[1]).exitCode === 2);
  check('the words are the same (the system prompt is not shown)', (reopened.rows[0] as any).text === 'leia e rode' && (reopened.rows.at(-1) as any).text === 'Resumo final.' && !reopened.rows.some((r) => r.kind === 'user' && (r as any).text.includes('You are')));
  check('nothing is running in a reopened conversation', !reopened.running && !reopened.modelBusy);

  const withGap = rowsFromMessages([
    { role: 'user', content: 'x' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'run_bash', arguments: '{"command":"sleep 9"}' } }, { id: 'c2', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: '[Interrupted] This tool call did not finish because the app stopped before it completed.' },
    { role: 'tool', tool_call_id: 'zzz', content: 'orphan' },
  ] as any);
  check('a call closed by the crash repair is shown as cancelled; one with no result at all too; a result with no call is ignored', toolRows(withGap).map((t) => t.status).join() === 'cancelled,cancelled' && withGap.rows.length === 3);
  const parts = rowsFromMessages([{ role: 'user', content: [{ type: 'text', text: 'em ' }, { type: 'text', text: 'partes' }] }] as any);
  const withNotes = rowsFromMessages(
    [
      { role: 'user', content: 'x' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'w', type: 'function', function: { name: 'write_file', arguments: '{"path":"a.md"}' } }] },
      { role: 'tool', tool_call_id: 'w', content: 'ok' },
    ] as any,
    { annotations: { w: { durationMs: 420, changes: [{ path: 'a.md', kind: 'created', added: 3, removed: 0 }] }, ghost: { durationMs: 1 } }, interrupted: 2 }
  );
  check('a reopened write shows its +/- again, from the annotations; an annotation for a call that is not there is ignored', JSON.stringify(summarizeTool(toolRows(withNotes)[0])) === JSON.stringify({ kind: 'write', target: 'a.md', added: 3, removed: 0 }) && toolRows(withNotes)[0].durationMs === 420 && toolRows(withNotes).length === 1);
  check('a conversation that was interrupted says so, at the end, with how many calls', withNotes.rows.at(-1)!.kind === 'notice' && (withNotes.rows.at(-1) as any).code === 'interrupted' && (withNotes.rows.at(-1) as any).message === '2');
  check('without interrupted calls there is no such row', !rowsFromMessages([{ role: 'user', content: 'x' }] as any, { interrupted: 0 }).rows.some((r) => r.kind === 'notice'));
  const midRun = rowsFromMessages([{ role: 'user', content: 'x' }, { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'run_bash', arguments: '{}' } }] }] as any, { running: true });
  check('opened mid-run, a call with no result yet is running (live events will finish it), not cancelled', toolRows(midRun)[0].status === 'running' && midRun.running === true);
  check('text stored as parts reads as text', (parts.rows[0] as any).text === 'em partes');
}

console.log('\n=== small helpers ===');
{
  check('how long a call took', formatDuration(undefined) === '' && formatDuration(340) === '340 ms' && formatDuration(1200) === '1,2 s' && formatDuration(12_400) === '12 s' && formatDuration(125_000) === '2 min 5 s');
  check('file names', baseName('src/app/main.ts') === 'main.ts' && baseName('C:\\x\\y.txt') === 'y.txt' && baseName('solo') === 'solo');
  check('a long command is shortened for the title, whitespace collapsed', (summarizeTool({ kind: 'tool', id: '1', name: 'run_bash', args: { command: 'echo   a\n  b ' + 'x'.repeat(200) }, status: 'done', children: [] }) as any).target.length <= 120);
  check('other tools are named', JSON.stringify(summarizeTool({ kind: 'tool', id: '1', name: 'mcp__x__y', args: {}, status: 'done', children: [] })) === JSON.stringify({ kind: 'other', name: 'mcp__x__y' }) && (summarizeTool({ kind: 'tool', id: '1', name: 'pipeline_state', args: { action: 'update' }, status: 'done', children: [] }) as any).action === 'update' && summarizeTool({ kind: 'tool', id: '1', name: 'ask_user', args: {}, status: 'done', children: [] }).kind === 'ask');
  check('core\'s refusals are not "passed": cancelled before approval, no one to ask, destructive and unconfirmed', bashOutcome({ status: 'done', result: 'Cancelled by user before the command was approved: "echo x"' }).state === 'cancelled' && bashOutcome({ status: 'done', result: 'Command "x" needs the user\'s approval, but no confirmation handler is available.' }).state === 'denied' && bashOutcome({ status: 'done', result: 'Potentially destructive command detected: "rm -rf x". Reasons: y, but no confirmation handler is available.' }).state === 'denied');
  check('an archived output still says how it ended, when its first characters do', bashOutcome({ status: 'done', result: '[Previous tool output archived to save context: [Exit Code: 3]\nstderr...]' }).state === 'failed' && bashOutcome({ status: 'done', result: '[Previous tool output archived to save context: [Exit Code: 0]\nok...]' }).state === 'passed');
  check('a result that says nothing about how it ended gets no tag, rather than a wrong one', bashOutcome({ status: 'done', result: 'something unexpected' }).state === 'unknown' && bashOutcome({ status: 'done', result: '' }).state === 'unknown' && bashOutcome({ status: 'done', result: '[Previous tool output archived to save context: lots of text...]' }).state === 'unknown');
  check('outcomes of odd shell results', bashOutcome({ status: 'running' }).state === 'running' && bashOutcome({ status: 'done', result: 'Command executed successfully with no output (exit code: 0).' }).state === 'passed' && bashOutcome({ status: 'error', result: 'Error: boom' }).state === 'error' && bashOutcome({ status: 'done', result: 'User denied permission to run the command: "x"' }).state === 'denied');
}

try {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
} catch {
  /* a command killed a moment ago may still hold its folder; the OS temp folder is cleaned later */
}
if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll timeline checks passed.');
