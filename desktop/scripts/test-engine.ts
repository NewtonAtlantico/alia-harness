/**
 * Tests for the engine runtime and the broker (A2), with the fake model: no Electron, no network.
 * Run from desktop/: `npm run test:engine`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PipelineStateStore, type AliaConfig } from 'alia-harness/core';
import { FakeModel, type ScriptedTurn } from '../../scripts/lib/fakeModel';
import { EngineRuntime } from '../src/engine/runtime';
import { Broker, ProjectRegistry } from '../src/main/broker';
import type { Interaction, PushMessage } from '../src/shared/ipc';
import { IpcValidationError } from '../src/shared/schemas';
import { makePdf } from '../../scripts/lib/pdfFixture';
import { startFakeServer } from './lib/fakeServer';
import { makeHang, sleep } from './lib/hang';

let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.log(`  ✘ ${name} ${extra}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alia-engine-'));
let n = 0;
const mk = (label = 'dir') => {
  const dir = path.join(tmp, `${label}-${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const hang = makeHang(mk('hang'));
const config: AliaConfig = { name: 't', vendor: 't', apiKey: 'k', apiType: 'chat-completions', models: [{ id: 'fake-model', name: 'fake', url: 'http://fake', toolCalling: true }, { id: 'second', name: 'second', url: 'http://fake', toolCalling: true }] };

const dataDirs = () => ({ sessions: mk('sessions'), permissions: mk('permissions') });

interface Rig {
  rt: EngineRuntime;
  messages: PushMessage[];
  model: FakeModel;
  ws: string;
  dirs: ReturnType<typeof dataDirs>;
  call: <T = any>(name: string, payload?: object) => Promise<T>;
  open: (resumeId?: string) => Promise<any>;
  events: (sessionId: string, type?: string) => any[];
  finished: (sessionId: string, since?: number) => Promise<any>;
  interactions: () => Interaction[];
  waitInteraction: (since?: number) => Promise<Interaction>;
}

async function rig(turns: ScriptedTurn[] | FakeModel, opts: { permissionMode?: 'ask-dangerous' | 'ask-commands' | 'auto'; cap?: number; dirs?: ReturnType<typeof dataDirs>; ws?: string; skillRoots?: Array<{ label: string; dir: string }> } = {}): Promise<Rig> {
  const messages: PushMessage[] = [];
  const model = turns instanceof FakeModel ? turns : new FakeModel(turns);
  const rt = new EngineRuntime({ post: (m) => messages.push(m as PushMessage), clientFor: () => model.client, eventTextCap: opts.cap });
  const dirs = opts.dirs ?? dataDirs();
  const ws = opts.ws ?? mk('project');
  await rt.handle('engine.configure', { config, skillRoots: opts.skillRoots ?? [], dataDirs: dirs, ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : {}) });
  const call = (name: string, payload: object = {}) => rt.handle(name as any, payload as any) as Promise<any>;
  const events = (sessionId: string, type?: string) => messages.filter((m) => m.kind === 'event' && m.sessionId === sessionId).map((m: any) => m.event).filter((e) => !type || e.type === type);
  const waitFor = async <T>(fn: () => T | undefined, ms = 8000): Promise<T> => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(20);
    }
    throw new Error('timed out waiting');
  };
  return {
    rt, messages, model, ws, dirs, call, events,
    open: (resumeId) => call('session.open', { projectPath: ws, ...(resumeId ? { resumeId } : {}) }),
    finished: (sessionId, since = 0) => waitFor(() => events(sessionId, 'run_finished')[since]),
    interactions: () => messages.filter((m) => m.kind === 'interaction').map((m: any) => m.interaction),
    waitInteraction: (since = 0) => waitFor(() => messages.filter((m) => m.kind === 'interaction').map((m: any) => m.interaction)[since]),
  };
}

const say = (content: string): ScriptedTurn[] => [{ content }];
const toolTurn = (name: string, args: unknown, id = 'c1'): ScriptedTurn => ({ toolCalls: [{ name, args, id }] });
const lastToolContent = (req: { messages: any[] }) => String(req.messages.filter((m) => m.role === 'tool').pop()?.content ?? '');

// ===================================================================================== sessions

console.log('\n=== opening sessions ===');
{
  const messages: PushMessage[] = [];
  const bare = new EngineRuntime({ post: (m) => messages.push(m as PushMessage) });
  let err = '';
  try {
    await bare.handle('session.open', { projectPath: tmp });
  } catch (e: any) {
    err = e.message;
  }
  check('an engine that has not been configured refuses to open a session, and says why', err.includes('not configured'), err);

  const r = await rig(say('hi'));
  const opened = await r.open();
  check('open returns the saved-session id, the workspace, the model and the context use', /^\d{8}-\d{6}-[0-9a-f]{6}$/.test(opened.sessionId) && opened.workspace === r.ws && opened.model === 'fake-model' && opened.resumed === false && opened.usage.limit > 0);
  const again = await r.open(opened.sessionId);
  check('opening a session that is already open returns it (not a second copy)', again.sessionId === opened.sessionId && again.resumed === true);

  let missing = '';
  try {
    await r.call('session.open', { projectPath: path.join(r.ws, 'nope') });
  } catch (e: any) {
    missing = e.message;
  }
  check('a folder that does not exist is an error', missing.includes('Folder not found'), missing);
  check('requests for a session that is not open say how to recover', await r.call('session.usage', { sessionId: 'x' }).then(() => '', (e) => e.message).then((m) => m.includes('not open') && m.includes('resumeId')));
  check('no files were created for an empty conversation (nothing saved until the first message)', fs.readdirSync(r.dirs.sessions).length === 0);
}

console.log('\n=== a run: replies at once, reports through tagged events ===');
{
  const r = await rig([{ content: 'olá' }]);
  const { sessionId } = await r.open();
  const started = await r.call('session.run', { sessionId, text: 'oi' });
  check('session.run replies as soon as the run starts', started.started === true && started.kind === 'prompt' && started.attached.length === 0);
  const fin = await r.finished(sessionId);
  check('the end arrives as run_finished with the result', fin.result.status === 'completed' && fin.result.text === 'olá');
  const types = r.events(sessionId).map((e) => e.type);
  check('events arrive in order: run_started ... model ... run_finished', types[0] === 'run_started' && types.includes('model_started') && types.at(-1) === 'run_finished', types.join());
  check('every pushed event carries the id of its session', r.messages.filter((m) => m.kind === 'event').every((m: any) => m.sessionId === sessionId));
  const cmds = await r.call('commands.list', { sessionId });
  check('commands: the built-ins plus the app\'s own /config', cmds.some((c: any) => c.name === 'compact' && c.kind === 'builtin') && cmds.some((c: any) => c.name === 'config' && c.kind === 'host'));
  const usage = await r.call('session.usage', { sessionId });
  check('the context meter counts the conversation', usage.messages >= 3 && usage.tokens > 0);
}

console.log('\n=== running twice at once, and what counts as a prompt ===');
{
  const r = await rig([{ hang: 'honor-signal' }, { content: 'second' }]);
  const { sessionId } = await r.open();
  await r.call('session.run', { sessionId, text: 'first' });
  const busy = await r.call('session.run', { sessionId, text: 'second' }).then(() => '', (e) => e.message);
  check('a second run on a busy conversation is refused with a clear message', busy.includes('already running'), busy);
  check('so is clearing it', await r.call('session.reset', { sessionId }).then(() => '', (e) => e.message).then((m) => m.includes('Stop the run')));
  await r.call('session.cancel', { sessionId });
  const fin = await r.finished(sessionId);
  check('cancel ends it as cancelled', fin.result.status === 'cancelled');

  const compact = await r.call('session.run', { sessionId, text: '/compact' }).then(() => '', (e) => e.message);
  check('an app command such as /compact is not sent to the model', compact.includes('app command'), compact);
  const unknown = await r.call('session.run', { sessionId, text: '/etc/hosts what is this?' });
  check('text that merely starts with a slash, but is no command, is a normal prompt', unknown.kind === 'prompt');
  await r.finished(sessionId, 1);
  check('cancelling an idle conversation says so', (await r.call('session.cancel', { sessionId })).cancelled === false);
}

console.log('\n=== @ mentions and skills ===');
{
  const skills = mk('skills');
  fs.mkdirSync(path.join(skills, 'greet'));
  fs.writeFileSync(path.join(skills, 'greet', 'SKILL.md'), '---\nname: greet\ndescription: Greets people\n---\nGREET-BODY-MARKER: say hello warmly.\n');
  const r = await rig(
    new FakeModel([{ content: 'a' }, { content: 'b' }, { content: 'c' }], 'repeat-last'),
    { skillRoots: [{ label: 'test', dir: skills }] }
  );
  fs.writeFileSync(path.join(r.ws, 'notes.txt'), 'remember the milk');
  const { sessionId } = await r.open();

  const a = await r.call('session.run', { sessionId, text: 'summarize @notes.txt please' });
  await r.finished(sessionId, 0);
  check('an @ mention attaches the file, and the model receives its content', a.attached.includes('notes.txt') && JSON.stringify(r.model.requests[0].messages).includes('remember the milk'));

  const b = await r.call('session.run', { sessionId, text: 'and @missing.txt?' });
  await r.finished(sessionId, 1);
  const notices = r.events(sessionId, 'notice');
  check('a mention that cannot be attached is reported, as a reply and as an error notice', b.errors.length === 1 && notices.some((e) => e.level === 'error' && e.message.includes('missing.txt')), JSON.stringify(b.errors));

  const c = await r.call('session.run', { sessionId, text: '/greet the new team' });
  await r.finished(sessionId, 2);
  const lastUser = JSON.stringify(r.model.requests[2].messages.filter((m: any) => m.role === 'user').pop());
  check('/skill input expands the skill into the prompt', c.kind === 'skill' && lastUser.includes('GREET-BODY-MARKER') && lastUser.includes('the new team'));
  check('the skill appears in the command list, from the roots the app gave (and only those)', (await r.call('commands.list', { sessionId })).some((x: any) => x.name === 'greet' && x.kind === 'skill'));
  const found = await r.call('files.search', { sessionId, query: 'note' });
  check('files.search ranks workspace files for the @ menu', found.matches[0]?.path === 'notes.txt' && found.total >= 1);
}

// ===================================================================================== interactions

console.log('\n=== permission requests ===');
{
  const r = await rig([
    toolTurn('run_bash', { command: 'echo hello-from-bash' }, 'b1'),
    (req) => ({ content: `result: ${lastToolContent(req).trim()}` }),
    toolTurn('run_bash', { command: 'echo hello-from-bash' }, 'b2'),
    (req) => ({ content: `second: ${lastToolContent(req).trim()}` }),
    toolTurn('run_bash', { command: 'echo other' }, 'b3'),
    (req) => ({ content: `third: ${lastToolContent(req).slice(0, 60)}` }),
  ]);
  const { sessionId } = await r.open();

  await r.call('session.run', { sessionId, text: 'run it' });
  const ask = await r.waitInteraction(0);
  check('a command needing approval becomes an interaction (ask-commands is the default), tied to the tool call', ask.kind === 'permission' && ask.command === 'echo hello-from-bash' && ask.sessionId === sessionId && ask.toolCallId === 'b1' && ask.canAlwaysAllow === true && ask.dangerous === false);
  check('it is listed as pending, so a reloaded page can show it again', (await r.call('interaction.pending')).some((i: Interaction) => i.id === ask.id));
  check('the permission_requested event is in the stream too', r.events(sessionId, 'permission_requested').length === 1);

  check('an answer of the wrong kind is refused', await r.call('interaction.respond', { id: ask.id, response: { answers: [] } }).then(() => '', (e) => e.message).then((m) => m.includes('does not match')));
  await r.call('interaction.respond', { id: ask.id, response: { decision: 'allow_always' } });
  const fin = await r.finished(sessionId, 0);
  check('answering lets the run go on, and the command ran', fin.result.text.includes('hello-from-bash'), fin.result.text);
  check('permission_resolved reports the decision', r.events(sessionId, 'permission_resolved').at(-1)?.decision === 'allow_always');
  check('answering twice is an error (it is gone)', await r.call('interaction.respond', { id: ask.id, response: { decision: 'deny' } }).then(() => '', (e) => e.message).then((m) => m.includes('no longer open')));

  await r.call('session.run', { sessionId, text: 'again' });
  const second = await r.finished(sessionId, 1);
  check('"always allow" is remembered: the same command no longer asks', r.interactions().length === 1 && second.result.text.includes('hello-from-bash'), second.result.text);
  check('...and the project allowlist shows the rule (and can remove it)', (await r.call('permissions.list', { sessionId }))[0]?.command === 'echo hello-from-bash' && (await r.call('permissions.remove', { sessionId, command: 'echo hello-from-bash' })).removed === true);

  await r.call('session.run', { sessionId, text: 'a different one' });
  const other = await r.waitInteraction(1);
  await r.call('interaction.respond', { id: other.id, response: { decision: 'deny' } });
  const denied = await r.finished(sessionId, 2);
  check('deny: the command did not run, and the model is told', !denied.result.text.includes('other\n') && /den|not|refus|approv/i.test(denied.result.text), denied.result.text);
}

console.log('\n=== a dangerous command can be allowed once, never always ===');
{
  const r = await rig([toolTurn('run_bash', { command: 'rm -rf ./some-folder' }, 'd1'), { content: 'done' }]);
  const { sessionId } = await r.open();
  await r.call('session.run', { sessionId, text: 'clean up' });
  const ask = await r.waitInteraction(0);
  check('it asks, says why, and does not offer "always"', ask.kind === 'permission' && ask.dangerous === true && ask.canAlwaysAllow === false && ask.reasons.length > 0);
  await r.call('interaction.respond', { id: ask.id, response: { decision: 'deny' } });
  await r.finished(sessionId);
}

console.log('\n=== ask_user ===');
{
  const q = { id: 'q1', kind: 'choice', prompt: 'Qual versão?', options: [{ id: 'v1', label: 'v1' }, { id: 'v2', label: 'v2' }], allowDefer: true };
  const r = await rig([toolTurn('ask_user', { questions: [q] }, 'u1'), (req) => ({ content: `got ${lastToolContent(req)}` })]);
  const { sessionId } = await r.open();
  await r.call('session.run', { sessionId, text: 'ask me' });
  const ask = await r.waitInteraction(0);
  check('the model\'s questions reach the UI as an interaction, with the options', ask.kind === 'ask_user' && ask.questions[0].options?.length === 2 && ask.toolCallId === 'u1');
  await r.call('interaction.respond', { id: ask.id, response: { answers: [{ id: 'q1', answer: 'v2' }] } });
  const fin = await r.finished(sessionId);
  check('the structured answer goes back to the model with the option label', fin.result.text.includes('"answer": "v2"') && fin.result.text.includes('"label": "v2"'), fin.result.text);
}

console.log('\n=== cancelling closes what is waiting ===');
{
  const r = await rig([toolTurn('run_bash', { command: 'echo never' }, 'k1'), { content: 'unused' }]);
  const { sessionId } = await r.open();
  await r.call('session.run', { sessionId, text: 'go' });
  const ask = await r.waitInteraction(0);
  await r.call('session.cancel', { sessionId });
  const fin = await r.finished(sessionId);
  check('the run ends as cancelled', fin.result.status === 'cancelled');
  check('the open question is dismissed (interaction_closed), not left dangling', r.messages.some((m) => m.kind === 'interaction_closed' && m.id === ask.id) && (await r.call('interaction.pending')).length === 0);
  check('the command never ran', r.events(sessionId, 'tool_call_finished').every((e) => !/never/.test(e.result) || /Cancelled|cancel/i.test(e.result)));
}

console.log('\n=== cancelling a real long command ===');
{
  const pidFile = path.join(mk('pid'), 'hang.pid');
  const r = await rig([toolTurn('run_bash', { command: hang.command(pidFile), timeout_ms: 120000 }, 'h1'), { content: 'unused' }]);
  const { sessionId } = await r.open();
  await r.call('session.run', { sessionId, text: 'start the server' });
  const ask = await r.waitInteraction(0);
  await r.call('interaction.respond', { id: ask.id, response: { decision: 'allow_once' } });
  check('the command is really running', await hang.started(pidFile));
  const t0 = Date.now();
  check('cancel is accepted', (await r.call('session.cancel', { sessionId })).cancelled === true);
  const fin = await r.finished(sessionId);
  const took = Date.now() - t0;
  check('the run ends as cancelled within two seconds', fin.result.status === 'cancelled' && took < 2000, `${took} ms`);
  check('the process is dead, not just the shell (the whole tree)', await hang.diesWithin(pidFile, 4000));
  check('the tool call is reported as failed', r.events(sessionId, 'tool_call_finished').at(-1)?.isError === true);
  await r.call('session.run', { sessionId, text: 'and now?' }).catch(() => {});
}

console.log('\n=== two conversations at once do not mix ===');
{
  const echo = new FakeModel([(req) => ({ content: `echo:${String(req.messages.filter((m: any) => m.role === 'user').pop()?.content)}` })], 'repeat-last');
  const r = await rig(echo);
  const ws2 = mk('project');
  const a = await r.open();
  const b = await r.call('session.open', { projectPath: ws2 });
  await Promise.all([r.call('session.run', { sessionId: a.sessionId, text: 'alpha' }), r.call('session.run', { sessionId: b.sessionId, text: 'beta' })]);
  const [fa, fb] = await Promise.all([r.finished(a.sessionId), r.finished(b.sessionId)]);
  check('each gets its own answer', fa.result.text === 'echo:alpha' && fb.result.text === 'echo:beta');
  check('events are tagged with the right session', !JSON.stringify(r.events(a.sessionId)).includes('beta') && !JSON.stringify(r.events(b.sessionId)).includes('alpha') && r.events(a.sessionId, 'run_finished').length === 1 && r.events(b.sessionId, 'run_finished').length === 1);
  fs.writeFileSync(path.join(ws2, 'only-b.txt'), 'x');
  check('workspaces are separate: files.search in one does not see the other', (await r.call('files.search', { sessionId: a.sessionId, query: 'only-b' })).total === 0 && (await r.call('files.search', { sessionId: b.sessionId, query: 'only-b' })).total === 1);
  check('closing one leaves the other', (await r.call('session.close', { sessionId: a.sessionId })).closed === true && (await r.call('session.usage', { sessionId: b.sessionId })).messages > 0);
  check('closing an unknown session says false', (await r.call('session.close', { sessionId: a.sessionId })).closed === false);
}

console.log('\n=== changes: list, diff, undo, keep ===');
{
  const r = await rig([toolTurn('write_file', { path: 'src/new.ts', content: 'export const a = 1;\nexport const b = 2;\n' }, 'w1'), { content: 'written' }]);
  const { sessionId } = await r.open();
  await r.call('session.run', { sessionId, text: 'write a file' });
  await r.finished(sessionId);
  const done = r.events(sessionId, 'tool_call_finished').find((e) => e.name === 'write_file');
  check('the tool call carries what it changed, without content', done?.changes?.[0]?.path === 'src/new.ts' && done.changes[0].kind === 'created' && done.changes[0].added === 2 && !('after' in done.changes[0]));
  const list = await r.call('changes.list', { sessionId });
  check('changes.list shows the pending file with +/- counts and no content', list.length === 1 && list[0].path === 'src/new.ts' && list[0].added === 2 && !('after' in list[0]));
  const diff = await r.call('changes.diff', { sessionId, path: 'src/new.ts' });
  check('changes.diff returns a unified diff', diff.truncated === false && diff.diff?.includes('+export const a = 1;') === true && diff.diff.includes('@@'));
  check('a file that is not pending has no diff', (await r.call('changes.diff', { sessionId, path: 'nothing.ts' })).diff === null);
  const saved = await r.call('conversations.load', { id: sessionId });
  check('the saved conversation is returned with what each call took and changed (and no file content)', typeof saved.annotations.w1?.durationMs === 'number' && saved.annotations.w1.changes?.[0].path === 'src/new.ts' && saved.annotations.w1.changes[0].added === 2 && !JSON.stringify(saved.annotations).includes('dois'), JSON.stringify(saved.annotations));
  const undone = await r.call('changes.revert', { sessionId, paths: ['src/new.ts'] });
  check('Desfazer deletes a file the agent created', undone.reverted.includes('src/new.ts') && !fs.existsSync(path.join(r.ws, 'src', 'new.ts')) && (await r.call('changes.list', { sessionId })).length === 0);

  const r2 = await rig([toolTurn('write_file', { path: 'keep.txt', content: 'k\n' }, 'w2'), { content: 'ok' }]);
  const s2 = (await r2.open()).sessionId;
  await r2.call('session.run', { sessionId: s2, text: 'x' });
  await r2.finished(s2);
  check('Manter alterações forgets them and leaves the file', (await r2.call('changes.keep', { sessionId: s2 })).kept === 1 && fs.existsSync(path.join(r2.ws, 'keep.txt')) && (await r2.call('changes.list', { sessionId: s2 })).length === 0);
}

console.log('\n=== event size is capped ===');
{
  const big = 'x'.repeat(5000);
  const r = await rig([toolTurn('run_bash', { command: `node -e "console.log('x'.repeat(5000))"` }, 'z1'), { content: 'ok' }], { cap: 300 });
  const { sessionId } = await r.open();
  await r.call('session.run', { sessionId, text: 'go' });
  const ask = await r.waitInteraction(0);
  await r.call('interaction.respond', { id: ask.id, response: { decision: 'allow_once' } });
  await r.finished(sessionId);
  const res = r.events(sessionId, 'tool_call_finished').at(-1)?.result ?? '';
  check('a long tool output is cut in the event, and says how much was left out', res.length < 500 && /more characters not sent/.test(res) && !res.includes(big), `${res.length}`);
}

// ===================================================================================== conversations

console.log('\n=== saved conversations ===');
{
  const dirs = dataDirs();
  const r = await rig([{ content: 'a resposta sobre abacaxi' }, { content: 'second' }], { dirs });
  const { sessionId } = await r.open();
  await r.call('session.run', { sessionId, text: 'Fale sobre bananas' });
  await r.finished(sessionId);

  const list = await r.call('conversations.list', { projectPath: r.ws });
  check('the conversation is listed for its project, titled from the first message', list.length === 1 && list[0].id === sessionId && list[0].title === 'Fale sobre bananas');
  check('another project sees nothing', (await r.call('conversations.list', { projectPath: mk('other') })).length === 0);
  const hit = await r.call('conversations.search', { text: 'abacaxi' });
  check('search finds text inside the messages', hit.length === 1 && hit[0].info.id === sessionId);
  check('rename sticks', (await r.call('conversations.rename', { id: sessionId, title: 'Minhas frutas' })).title === 'Minhas frutas');
  const loaded = await r.call('conversations.load', { id: sessionId });
  check('load returns the messages (user, assistant, ...)', loaded.messages.some((m: any) => m.role === 'user') && loaded.messages.some((m: any) => m.role === 'assistant') && loaded.info.title === 'Minhas frutas');
  check('loading something that does not exist is null, not an error', (await r.call('conversations.load', { id: 'nope' })) === null);

  // The engine restarts (a new runtime over the same folders): the conversation is still there and resumes.
  const back = await rig([{ content: 'third' }], { dirs, ws: r.ws });
  check('after a restart the saved conversation is still listed', (await back.call('conversations.list', { projectPath: r.ws })).length === 1);
  const resumed = await back.open(sessionId);
  check('...and reopens with its history', resumed.resumed === true && resumed.sessionId === sessionId && resumed.messages === loaded.messages.length, JSON.stringify(resumed));
  await back.call('session.run', { sessionId, text: 'continuing' });
  await back.finished(sessionId);
  check('...and carries on in the same conversation', (await back.call('conversations.load', { id: sessionId })).messages.length > loaded.messages.length);

  check('delete removes it, closing it if it was open', (await back.call('conversations.delete', { id: sessionId })).deleted === true && (await back.call('conversations.list', { projectPath: r.ws })).length === 0 && await back.call('session.usage', { sessionId }).then(() => false, () => true));
}

console.log('\n=== a conversation cut off by a crash resumes cleanly ===');
{
  const dirs = dataDirs();
  const r = await rig([toolTurn('list_files', { path: '.' }, 'x1'), { content: 'done' }], { dirs });
  const { sessionId } = await r.open();
  await r.call('session.run', { sessionId, text: 'list' });
  await r.finished(sessionId);
  // Simulate dying right after the model announced the call: keep everything up to the assistant message.
  const folder = fs.readdirSync(dirs.sessions)[0];
  const file = path.join(dirs.sessions, folder, `${sessionId}.jsonl`);
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const at = lines.findIndex((l) => l.includes('"tool_calls"'));
  fs.writeFileSync(file, lines.slice(0, at + 1).join('\n') + '\n');

  const back = await rig([{ content: 'recovered' }], { dirs, ws: r.ws });
  const reopened = await back.open(sessionId);
  check('reopening a conversation cut off mid-run says how many calls were closed, once', reopened.interrupted === 1 && (await back.open(sessionId)).interrupted === 0);
  await back.call('session.run', { sessionId, text: 'are you there?' });
  const fin = await back.finished(sessionId);
  const sent = back.model.requests[0].messages;
  check('the interrupted call gets a result, so the endpoint accepts the history', fin.result.status === 'completed' && sent.some((m: any) => m.role === 'tool' && m.tool_call_id === 'x1' && String(m.content).startsWith('[Interrupted]')));
}

console.log('\n=== models ===');
{
  const r = await rig(say('x'));
  const { sessionId } = await r.open();
  const list = await r.call('model.list', { sessionId });
  check('model.list: the current model and the configured ones', list.current === 'fake-model' && list.configured.length === 2 && Array.isArray(list.remote));
  check('model.switch to a configured model', (await r.call('model.switch', { sessionId, model: 'second' })).ok === true && (await r.call('model.list', { sessionId })).current === 'second');
  const bad = await r.call('model.switch', { sessionId, model: 'nonexistent' });
  check('an unknown model is reported with what is available', bad.ok === false && Array.isArray(bad.available));
}

console.log('\n=== the approval mode is a setting ===');
{
  const auto = await rig([toolTurn('run_bash', { command: 'echo no-prompt-needed' }, 'a1'), (req) => ({ content: `ran: ${lastToolContent(req).trim()}` })], { permissionMode: 'auto' });
  const { sessionId } = await auto.open();
  await auto.call('session.run', { sessionId, text: 'go' });
  const fin = await auto.finished(sessionId);
  check('in "auto" mode a command runs without asking', fin.result.text.includes('no-prompt-needed') && auto.interactions().length === 0, fin.result.text);

  const strict = await rig([toolTurn('run_bash', { command: 'echo asked' }, 's1'), { content: 'done' }], { permissionMode: 'ask-commands' });
  const s = await strict.open();
  await strict.call('session.run', { sessionId: s.sessionId, text: 'go' });
  check('in "ask-commands" mode (the default) it asks', (await strict.waitInteraction(0)).kind === 'permission');
  await strict.call('session.cancel', { sessionId: s.sessionId });
  await strict.finished(s.sessionId);

  // The CLI's mode: only destructive commands ask.
  const lenient = await rig([toolTurn('run_bash', { command: 'echo fine' }, 'l1'), (req) => ({ content: `ran: ${lastToolContent(req).trim()}` })], { permissionMode: 'ask-dangerous' });
  const l = await lenient.open();
  await lenient.call('session.run', { sessionId: l.sessionId, text: 'go' });
  check('in "ask-dangerous" mode an ordinary command does not ask', (await lenient.finished(l.sessionId)).result.text.includes('fine') && lenient.interactions().length === 0);
}

console.log('\n=== the allowlist of a project, without an open conversation ===');
{
  const r = await rig([toolTurn('run_bash', { command: 'echo remembered' }, 'p1'), { content: 'ok' }]);
  const { sessionId } = await r.open();
  await r.call('session.run', { sessionId, text: 'go' });
  const ask = await r.waitInteraction(0);
  await r.call('interaction.respond', { id: ask.id, response: { decision: 'allow_always' } });
  await r.finished(sessionId);
  await r.call('session.close', { sessionId });
  const rules = await r.call('permissions.listForProject', { projectPath: r.ws });
  check('the rules saved by "always allow" can be listed for the project, with no conversation open', rules.length === 1 && rules[0].command === 'echo remembered' && rules[0].match === 'exact');
  check('another project has none', (await r.call('permissions.listForProject', { projectPath: mk('other') })).length === 0);
  check('a rule can be removed, and then it is gone', (await r.call('permissions.removeForProject', { projectPath: r.ws, command: 'echo remembered' })).removed === true && (await r.call('permissions.listForProject', { projectPath: r.ws })).length === 0 && (await r.call('permissions.removeForProject', { projectPath: r.ws, command: 'echo remembered' })).removed === false);
}

console.log('\n=== testing a connection ===');
{
  const KEY = 'sk-test-ENDPOINTKEY-42424242';
  const server = await startFakeServer([], { apiKey: KEY });
  const r = await rig(say('x'));
  const good = await r.call('connection.test', { url: server.url, apiKey: KEY });
  check('with the right key the endpoint\'s models are listed', good.ok === true && good.models.join() === 'fake-model', JSON.stringify(good));
  const noSlash = await r.call('connection.test', { url: server.url.replace(/\/$/, ''), apiKey: KEY });
  check('an address with or without the trailing slash works', noSlash.ok === true);
  const wrong = await r.call('connection.test', { url: server.url, apiKey: 'sk-wrong-KEY-000000000' });
  check('a rejected key is reported as such, without the key in the message', wrong.ok === false && wrong.reason === 'unauthorized' && !JSON.stringify(wrong).includes('sk-wrong-KEY'), JSON.stringify(wrong));
  const missing = await r.call('connection.test', { url: server.url + 'nope/', apiKey: KEY });
  check('an address that does not answer like an endpoint is "not found"', missing.ok === false && missing.reason === 'not_found', JSON.stringify(missing));
  const down = await r.call('connection.test', { url: 'http://127.0.0.1:1/', apiKey: KEY });
  check('a server that is not there is "unreachable"', down.ok === false && down.reason === 'unreachable' && !JSON.stringify(down).includes(KEY), JSON.stringify(down));
  await server.close();
}

console.log('\n=== project skills load only for a trusted folder ===');
{
  const r = await rig(say('x'));
  const dir = path.join(r.ws, '.alia', 'skills', 'proj-skill');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: proj-skill\ndescription: A skill this project carries\n---\nPROJECT-SKILL-BODY\n');
  const plain = await r.open();
  check('by default the project\'s skills are found but not loaded', plain.projectSkills.found === 1 && plain.projectSkills.loaded === false);
  check('...so they are not offered as commands', !(await r.call('commands.list', { sessionId: plain.sessionId })).some((c: any) => c.name === 'proj-skill'));
  const refused = await r.call('session.run', { sessionId: plain.sessionId, text: '/proj-skill do it' }).then((x) => x.kind, () => 'error');
  check('...and /proj-skill is just text, not an instruction from the project', refused === 'prompt');
  await r.finished(plain.sessionId);
  await r.call('session.close', { sessionId: plain.sessionId });

  const trusted = await r.call('session.open', { projectPath: r.ws, trustedProject: true });
  check('for a trusted folder they load', trusted.projectSkills.found === 1 && trusted.projectSkills.loaded === true && (await r.call('commands.list', { sessionId: trusted.sessionId })).some((c: any) => c.name === 'proj-skill' && c.kind === 'skill'));
  const second = await rig(say('x'), { ws: mk('empty-project') });
  check('a folder with no project skills reports zero', (await second.open()).projectSkills.found === 0);
}

console.log('\n=== which conversations are running or waiting ===');
{
  const r = await rig([{ hang: 'honor-signal' }, toolTurn('run_bash', { command: 'echo wait' }, 'w1'), { content: 'done' }]);
  const a = await r.open();
  const b = await r.call('session.open', { projectPath: mk('other') });
  let active: any[] = await r.call('sessions.active');
  check('open conversations are listed, idle at first', active.length === 2 && active.every((s) => s.running === false && s.waiting === 0));
  await r.call('session.run', { sessionId: a.sessionId, text: 'slow one' });
  active = await r.call('sessions.active');
  check('a conversation that is running says so, and the other stays idle', active.find((s) => s.sessionId === a.sessionId)?.running === true && active.find((s) => s.sessionId === b.sessionId)?.running === false);
  await r.call('session.cancel', { sessionId: a.sessionId });
  await r.finished(a.sessionId);
  check('after it ends it is idle again', (await r.call('sessions.active')).every((s: any) => s.running === false));

  await r.call('session.run', { sessionId: b.sessionId, text: 'needs approval' });
  const ask = await r.waitInteraction(0);
  active = await r.call('sessions.active');
  const mine = active.find((s) => s.sessionId === b.sessionId);
  check('a conversation waiting for an approval is running, with one thing waiting (the orange dot)', mine?.running === true && mine.waiting === 1 && active.find((s) => s.sessionId === a.sessionId)?.waiting === 0 && mine.workspace === (await r.call('session.usage', { sessionId: b.sessionId }) && mine.workspace));
  await r.call('interaction.respond', { id: ask.id, response: { decision: 'allow_once' } });
  await r.finished(b.sessionId);
  check('once answered and finished, nothing is waiting', (await r.call('sessions.active')).every((s: any) => s.waiting === 0 && s.running === false));
}

console.log('\n=== the pipeline in the sidebar ===');
{
  const r = await rig(say('x'));
  check('a project without a pipeline says so', (await r.call('pipeline.brief', { projectPath: r.ws })).exists === false && (await r.call('pipeline.brief', { projectPath: r.ws })).state === 'not_started');
  const store = new PipelineStateStore(r.ws);
  const q = (id: string) => ({ op: 'add_question', gate: 'G1', id, prompt: `Pergunta ${id}?` });
  store.apply([{ op: 'set_project', name: 'Portal do cliente' }, { op: 'set_stage', stage: 1, status: 'running' }, q('q1'), q('q2'), q('q3'), q('q4'), q('q5')]);
  store.apply([{ op: 'answer_question', id: 'q1', answer: 'sim' }, { op: 'answer_question', id: 'q2', answer: 'não' }, { op: 'defer_question', id: 'q3', owner: 'Newton' }]);
  const waiting = await r.call('pipeline.brief', { projectPath: r.ws });
  check('stopped at gate 1 with 3 of 5 answered: the chip data says so', waiting.exists && waiting.state === 'answer_questions' && waiting.gate === 'G1' && waiting.answered === 3 && waiting.total === 5 && waiting.project === 'Portal do cliente' && waiting.summary.includes('G1'), JSON.stringify(waiting));
  store.apply([{ op: 'answer_question', id: 'q4', answer: 'a' }, { op: 'answer_question', id: 'q5', answer: 'b' }, { op: 'set_stage', stage: 1, status: 'done' }]);
  const approve = await r.call('pipeline.brief', { projectPath: r.ws });
  check('all answered but not approved: waiting for the user to pass the gate', approve.state === 'pass_gate' && approve.gate === 'G1', JSON.stringify(approve));
  fs.writeFileSync(path.join(r.ws, 'docs', 'pipeline', 'state.json'), '{ broken');
  const damaged = await r.call('pipeline.brief', { projectPath: r.ws });
  check('a damaged state is reported, never thrown', damaged.exists === true && damaged.state === 'damaged');
}

console.log('\n=== @ mentions can only read the project, or what the user attached ===');
{
  const r = await rig(new FakeModel([{ content: 'ok1' }, { content: 'ok2' }, { content: 'ok3' }, { content: 'ok4' }, { content: 'ok5' }], 'repeat-last'));
  const outside = mk('outside');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOP-SECRET-CONTENT');
  fs.writeFileSync(path.join(outside, 'other.txt'), 'OTHER-CONTENT');
  fs.mkdirSync(path.join(outside, 'folder'));
  fs.writeFileSync(path.join(outside, 'folder', 'inner.txt'), 'INNER-CONTENT');
  fs.writeFileSync(path.join(r.ws, 'inside.txt'), 'INSIDE-CONTENT');
  const { sessionId } = await r.open();
  const refused = (text: string) => r.call('session.run', { sessionId, text }).then(() => '', (e) => e.message as string);

  check('a file inside the project is read', (await r.call('session.run', { sessionId, text: 'veja @inside.txt' })).attached.includes('inside.txt'));
  await r.finished(sessionId, 0);
  check('a file outside the project, by absolute path, is refused with a way forward, and was never read', (await refused(`veja @"${path.join(outside, 'secret.txt')}"`)).includes('outside the project folder') && !JSON.stringify(r.model.requests).includes('TOP-SECRET'));
  check('so is one reached with ".."', (await refused('veja @../outside/secret.txt')).includes('outside the project folder'));
  check('so is one named inside a skill command or among other text', (await refused(`faça isso e @inside.txt também @"${path.join(outside, 'secret.txt')}"`)).includes('outside the project folder'));
  check('the refusal starts nothing (the conversation is free to run)', (await r.call('sessions.active')).every((s: any) => !s.running));

  await r.call('attachments.allow', { paths: [path.join(outside, 'secret.txt')] });
  const allowed = await r.call('session.run', { sessionId, text: `veja @"${path.join(outside, 'secret.txt')}"` });
  await r.finished(sessionId, 1);
  check('once the user attached that file (dialog or drop), it is read', allowed.attached.length === 1 && JSON.stringify(r.model.requests.at(-1)).includes('TOP-SECRET-CONTENT'));
  check('...but only that file, not its neighbour', (await refused(`veja @"${path.join(outside, 'other.txt')}"`)).includes('outside the project folder'));

  await r.call('attachments.allow', { paths: [outside] });
  const dir = await r.call('session.run', { sessionId, text: `veja @"${path.join(outside, 'folder', 'inner.txt')}"` });
  await r.finished(sessionId, 2);
  check('a folder the user attached makes what is inside it readable', dir.attached.length === 1 && JSON.stringify(r.model.requests.at(-1)).includes('INNER-CONTENT'));
  check('an email address is not a mention', (await r.call('session.run', { sessionId, text: 'escreva para ana@example.com' })).started === true);
  await r.finished(sessionId, 3);
  const sibling = `${outside}-neighbour`; // its name starts with the allowed folder's whole path
  fs.mkdirSync(sibling, { recursive: true });
  fs.writeFileSync(path.join(sibling, 'x.txt'), 'NEIGHBOUR');
  check('a folder whose name merely starts the same is not covered', (await refused(`@"${path.join(sibling, 'x.txt')}"`)).includes('outside the project folder'));
}

console.log('\n=== the project tree and a read-only preview ===');
{
  const r = await rig(say('x'));
  const w = r.ws;
  fs.mkdirSync(path.join(w, 'src'), { recursive: true });
  fs.mkdirSync(path.join(w, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(w, 'README.md'), '# Título\ncorpo\n');
  fs.writeFileSync(path.join(w, 'src', 'app.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(w, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]));
  fs.writeFileSync(path.join(w, 'big.txt'), 'x'.repeat(250_000));
  fs.writeFileSync(path.join(w, 'brd.pdf'), makePdf([['Primeira página'], ['Segunda página']]));
  fs.writeFileSync(path.join(w, 'bin.dat'), Buffer.from([1, 2, 0, 3, 4]));
  const { sessionId } = await r.open();

  const top = await r.call('files.children', { sessionId });
  const names: string[] = top.entries.map((e: any) => e.name);
  const files = names.slice(1);
  check('the root lists folders first, then files by name, without the noise folders', names[0] === 'src' && !names.includes('node_modules') && files.length === 5 && files.every((n, i) => i === 0 || files[i - 1].localeCompare(n) <= 0), names.join());
  const sub = await r.call('files.children', { sessionId, dir: 'src' });
  check('a folder lists its own children, with paths from the project root', sub.entries.length === 1 && sub.entries[0].path === 'src/app.ts' && sub.entries[0].size === 20);
  const outside = await r.call('files.children', { sessionId, dir: '..' }).then(() => '', (e) => e.message);
  check('a folder outside the project is refused', outside.includes('outside the project folder'), outside);

  const text = await r.call('files.preview', { sessionId, path: 'README.md' });
  check('a text file is shown as text', text.kind === 'text' && text.text === '# Título\ncorpo\n' && text.truncated === false && text.path === 'README.md');
  const big = await r.call('files.preview', { sessionId, path: 'big.txt' });
  check('a large file is cut at 200 KB and says so', big.kind === 'text' && big.text.length === 200_000 && big.truncated === true && big.size === 250_000);
  const pdf = await r.call('files.preview', { sessionId, path: 'brd.pdf' });
  check('a PDF is shown as the text the agent would read, with page markers', pdf.kind === 'document' && pdf.text.includes('[p. 1]') && pdf.text.includes('Segunda página'), JSON.stringify(pdf).slice(0, 200));
  check('a binary file says there is nothing to show (by extension, or by NUL bytes)', (await r.call('files.preview', { sessionId, path: 'logo.png' })).kind === 'binary' && (await r.call('files.preview', { sessionId, path: 'bin.dat' })).kind === 'binary');
  check('a folder and a file that is gone are named as such', (await r.call('files.preview', { sessionId, path: 'src' })).kind === 'not_a_file' && (await r.call('files.preview', { sessionId, path: 'nao-existe.txt' })).kind === 'missing');
  const leaving = await r.call('files.preview', { sessionId, path: '../fora.txt' }).then(() => '', (e) => e.message);
  check('a path that leaves the project is refused', leaving.includes('outside the project folder'), leaving);
  const link = path.join(w, 'atalho');
  let linked = false;
  try {
    fs.symlinkSync(path.join(path.dirname(w), 'segredo.txt'), link);
    linked = true;
  } catch {
    /* creating a link may need rights on Windows: that case is then not testable here */
  }
  if (linked) {
    fs.writeFileSync(path.join(path.dirname(w), 'segredo.txt'), 'NAO-LER');
    const viaLink = await r.call('files.preview', { sessionId, path: 'atalho' }).then((p) => JSON.stringify(p), (e) => e.message);
    check('a link inside the project that leads outside is refused, and the content was not read', !viaLink.includes('NAO-LER') && viaLink.includes('outside'), viaLink);
  }
}

// ===================================================================================== broker

console.log('\n=== the broker: strict validation ===');
{
  const calls: Array<{ name: string; payload: any }> = [];
  const projects = new ProjectRegistry();
  const engine = { request: async (name: string, payload: any) => (calls.push({ name, payload }), { forwarded: name }) } as any;
  const broker = new Broker({ engine, projects, pickFolder: async () => picked });
  let picked: string | null = null;
  const reject = (name: unknown, payload?: unknown) => broker.handle(name, payload).then(() => '', (e) => (e instanceof IpcValidationError ? e.message : `WRONG ERROR TYPE: ${e}`));

  check('a well-formed request is forwarded', (await broker.handle('session.run', { sessionId: 's-1', text: 'oi' }) as any).forwarded === 'session.run' && calls.length === 1);
  const before = calls.length;
  check('an unknown field is rejected, not passed along', (await reject('session.run', { sessionId: 's-1', text: 'oi', sneaky: true })).includes('Unrecognized key'));
  check('a missing field is rejected', (await reject('session.run', { sessionId: 's-1' })).includes('text'));
  check('a wrong type is rejected', (await reject('session.cancel', { sessionId: 42 })).includes('sessionId'));
  check('an id that could name a path is rejected', (await reject('session.cancel', { sessionId: '../../etc' })).includes('not a valid id') && (await reject('conversations.delete', { id: 'a/b' })).includes('not a valid id'));
  check('a prompt over the size limit is rejected', (await reject('session.run', { sessionId: 's', text: 'x'.repeat(200_001) })).includes('text'));
  check('an empty prompt is rejected', (await reject('session.run', { sessionId: 's', text: '' })).includes('text'));
  check('a request nobody defined is rejected', (await reject('session.explode', {})).includes('Unknown request'));
  check('internal engine requests cannot be reached from the page', (await reject('engine.configure', { config: {} })).includes('Unknown request') && (await reject('selfTest', { dir: 'C:/' })).includes('Unknown request') && (await reject('ping', {})).includes('Unknown request'));
  check('names that exist on every object are not requests', (await reject('constructor', {})).includes('Unknown request') && (await reject('__proto__', {})).includes('Unknown request') && (await reject('toString', {})).includes('Unknown request'));
  check('a request name that is not a string is rejected', (await reject({ name: 'x' }, {})).includes('Unknown request') && (await reject(undefined, {})).includes('Unknown request'));
  check('a response of an unknown shape is rejected', (await reject('interaction.respond', { id: 'i', response: { decision: 'maybe' } })).includes('response') && (await reject('interaction.respond', { id: 'i', response: { decision: 'deny', extra: 1 } })).includes('response'));
  check('a request that has no fields takes {} or nothing, but not extras', (await broker.handle('interaction.pending', undefined) as any).forwarded === 'interaction.pending' && (await reject('interaction.pending', { x: 1 })).includes('Unrecognized key'));
  check('nothing rejected reached the engine', calls.length === before + 1, `${calls.length - before - 1} extra`);

  console.log('\n=== the broker: only folders the user opened ===');
  const folder = mk('opened');
  check('a folder the user never opened is refused (and the engine is not asked)', (await reject('session.open', { projectPath: folder })).includes('folder dialog') && !calls.some((c) => c.name === 'session.open'));
  check('...for conversation queries too', (await reject('conversations.list', { projectPath: folder })).includes('folder dialog') && (await reject('conversations.search', { text: 'x', projectPath: folder })).includes('folder dialog'));
  check('a query that names no folder needs none', (await broker.handle('conversations.list', {}) as any).forwarded === 'conversations.list');

  picked = folder;
  const pick = (await broker.handle('projects.pick', {})) as { path: string } | null;
  check('the folder dialog returns the folder and remembers it', pick?.path === path.resolve(folder) && projects.isAllowed(folder));
  check('now it can be opened', (await broker.handle('session.open', { projectPath: folder }) as any).forwarded === 'session.open');
  check('a folder next to it, or inside it, is not covered', (await reject('session.open', { projectPath: path.join(folder, 'sub') })).includes('folder dialog') && (await reject('session.open', { projectPath: path.dirname(folder) })).includes('folder dialog'));
  check('"..", relative tricks and other spellings of the same folder resolve to the same answer', projects.isAllowed(path.join(folder, 'x', '..')) && !projects.isAllowed(path.join(folder, '..')));
  picked = null;
  check('cancelling the dialog returns null and allows nothing new', (await broker.handle('projects.pick', {})) === null);

  const failing = new Broker({ engine: { request: async () => { throw new Error('engine says no'); } } as any, projects, pickFolder: async () => null });
  check('an error from the engine reaches the caller with its message', await failing.handle('session.cancel', { sessionId: 's' }).then(() => '', (e) => e.message) === 'engine says no');
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll engine and broker checks passed.');
