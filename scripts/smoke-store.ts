import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AliaConfig } from '../src/core/config.js';
import { createSession } from '../src/core/session.js';
import { projectFolderName } from '../src/core/projectKey.js';
import { SessionStore, ChatMessage, deriveTitle, messageText } from '../src/core/sessions/sessionStore.js';
import { INTERRUPTED_OUTPUT_PREFIX, repairInterruptedHistory } from '../src/core/sessions/repairHistory.js';
import { FakeModel, ScriptedTurn } from './lib/fakeModel.js';

let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.log(`  ✘ ${name} ${extra}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alia-store-'));
let n = 0;
const mk = (label: string) => {
  const dir = path.join(tmp, `${label}-${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const newStore = () => new SessionStore({ dir: mk('store') });
const json = (v: unknown) => JSON.stringify(v);
const lines = (file: string) => fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());

const config = (maxInputTokens?: number): AliaConfig => ({
  name: 't',
  vendor: 't',
  apiKey: 'k',
  apiType: 'chat-completions',
  models: [
    { id: 'fake-model', name: 'fake', url: 'http://fake', toolCalling: true, maxInputTokens },
    { id: 'other-model', name: 'other', url: 'http://fake', toolCalling: true, maxInputTokens },
  ],
});

function open(
  store: SessionStore | undefined,
  workspace: string,
  turns: ScriptedTurn[],
  extra: Partial<Parameters<typeof createSession>[0]> = {}
) {
  const model = new FakeModel(turns);
  const session = createSession({
    workspace,
    config: config(),
    client: model.client,
    skillRoots: [],
    sessionStore: store,
    permissionsDir: path.join(tmp, 'perm'),
    ...extra,
  });
  return { session, model };
}

const sessionFile = (store: SessionStore, ws: string, id: string) => path.join(store.projectDir(ws), `${id}.jsonl`);
const say = (content: string): ScriptedTurn[] => [{ content }];

console.log('\n=== store basics ===');
{
  const store = newStore();
  const ws = mk('ws');
  const info = store.create({ workspace: ws, model: 'm1', id: 's1' });
  check('create returns the info', info.id === 's1' && info.model === 'm1' && info.title === 'New conversation' && info.titleSource === 'auto');
  check('files live under <root>/<project>/, named by id', fs.existsSync(path.join(store.root, projectFolderName(ws), 's1.meta.json')) && fs.existsSync(sessionFile(store, ws, 's1')));
  check('nothing is written inside the workspace', fs.readdirSync(ws).length === 0);
  check('list / load see it', store.list().length === 1 && store.load('s1')!.messages.length === 0 && store.load('s1')!.skipped === 0);

  const renamed = store.rename('s1', '  My   title ');
  check('rename sets a user title (whitespace tidied)', renamed.title === 'My title' && renamed.titleSource === 'user');
  let err = '';
  try {
    store.rename('s1', '   ');
  } catch (e: any) {
    err = e.message;
  }
  check('an empty title is rejected', err.includes('empty'));

  for (const bad of ['../x', 'a/b', '..', '', 'a b']) {
    let threw = false;
    try {
      store.info(bad);
    } catch {
      threw = true;
    }
    check(`id ${JSON.stringify(bad)} is rejected (no path tricks)`, threw);
  }
  let dup = '';
  try {
    store.create({ workspace: ws, model: 'm', id: 's1' });
  } catch (e: any) {
    dup = e.message;
  }
  check('a duplicate id is rejected', dup.includes('already exists'));

  check('delete removes both files', store.delete('s1') === true && store.info('s1') === undefined && !fs.existsSync(sessionFile(store, ws, 's1')) && store.delete('s1') === false);
}

console.log('\n=== a run is persisted, and nothing is written in the workspace ===');
{
  const store = newStore();
  const ws = mk('ws');
  const { session } = open(store, ws, [{ toolCalls: [{ name: 'list_files', args: { path: '.' }, id: 'call_1' }] }, { content: 'all done' }], { sessionId: 'rec1' });
  check('the session has an id', session.id === 'rec1');
  check('nothing is created until there is a message', !store.exists('rec1') && store.list().length === 0);

  await session.run('Explain the project structure');
  const loaded = store.load('rec1')!;
  check('the saved history equals the live one, message for message', json(loaded.messages) === json(session.agent.getMessages()) && loaded.messages.length === 5);
  check('auto title comes from the first user message', loaded.info.title === 'Explain the project structure' && loaded.info.titleSource === 'auto');
  check('model and workspace are recorded', loaded.info.model === 'fake-model' && loaded.info.workspace === path.resolve(ws));
  check('one line per message, no duplicates', lines(sessionFile(store, ws, 'rec1')).length === 5);
  check('the workspace is untouched', fs.readdirSync(ws).length === 0);
  check('the system prompt is saved too (resume sees what the model saw)', loaded.messages[0].role === 'system');
}

console.log('\n=== resume ===');
{
  const store = newStore();
  const ws = mk('ws');
  const first = open(store, ws, [{ toolCalls: [{ name: 'list_files', args: { path: '.' }, id: 'call_1' }] }, { content: 'all done' }], { sessionId: 'r1' });
  await first.session.run('first question');
  const before = first.session.agent.getMessages().slice();

  const second = open(store, ws, say('second answer'), { resume: 'r1' });
  check('same id, same history', second.session.id === 'r1' && json(second.session.agent.getMessages()) === json(before));
  await second.session.run('and then?');
  check('the model received the earlier conversation plus the new question', second.model.requests[0].messages.length === 6 && messageText(second.model.requests[0].messages[5]) === 'and then?');
  const after = store.load('r1')!;
  check('the same files carry on (7 messages, no duplicates)', after.messages.length === 7 && lines(sessionFile(store, ws, 'r1')).length === 7 && json(after.messages) === json(second.session.agent.getMessages()));
  check('an unchanged system prompt writes no spurious edit', !lines(sessionFile(store, ws, 'r1')).some((l) => l.includes('"t":"set"')));
  check('the title is kept', after.info.title === 'first question');

  // Skills may have changed since: the system prompt is refreshed, the conversation is not.
  const skills = mk('skills');
  fs.mkdirSync(path.join(skills, 'alpha'));
  fs.writeFileSync(path.join(skills, 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: brand new skill\n---\nBODY');
  const third = open(store, ws, say('third'), { resume: 'r1', skillRoots: [{ label: 't', dir: skills }] });
  const msgs = third.session.agent.getMessages();
  check('system prompt is refreshed', String(msgs[0].content).includes('- alpha:') && !String(before[0].content).includes('- alpha:'));
  check('the conversation itself is unchanged', msgs.length === after.messages.length && json(msgs.slice(1)) === json(after.messages.slice(1)));
  check('the refreshed prompt was saved', String(store.load('r1')!.messages[0].content).includes('- alpha:'));

  // Model: restored unless overridden.
  const m1 = open(store, ws, say('x'), { sessionId: 'rm', modelId: 'other-model' });
  await m1.session.run('hi');
  check('a new session records its model', store.info('rm')!.model === 'other-model');
  check('resume restores the saved model', open(store, ws, [], { resume: 'rm' }).session.getModel() === 'other-model');
  check('an explicit modelId wins', open(store, ws, [], { resume: 'rm', modelId: 'fake-model' }).session.getModel() === 'fake-model');
  await m1.session.switchModel('fake-model');
  check('switching model updates what is saved', store.info('rm')!.model === 'fake-model');

  // Errors.
  // `null` means "no store" (an omitted/undefined argument would fall back to the default).
  const errOf = (o: Partial<Parameters<typeof createSession>[0]>, s: SessionStore | null = store, w = ws) => {
    try {
      open(s ?? undefined, w, [], o);
      return '';
    } catch (e: any) {
      return e.message as string;
    }
  };
  check('resume without a store', errOf({ resume: 'r1' }, null).includes('needs a "sessionStore"'));
  check('unknown session', errOf({ resume: 'nope' }).includes('not found'));
  check("a session of another project cannot be resumed here", errOf({ resume: 'r1' }, store, mk('other-ws')).includes('belongs to'));
  store.delete('rm');
  check('a deleted session cannot be resumed', errOf({ resume: 'rm' }).includes('not found'));
}

console.log('\n=== archived tool output is saved as the model saw it ===');
{
  const store = newStore();
  const ws = mk('ws');
  fs.writeFileSync(path.join(ws, 'big.txt'), 'line of text\n'.repeat(260));
  const read: ScriptedTurn = { toolCalls: [{ name: 'read_file', args: { path: 'big.txt' } }] };
  const { session } = open(store, ws, [...Array.from({ length: 9 }, () => read), { content: 'done' }], { sessionId: 'prune', config: config(600) });
  await session.run('read it a lot');
  const live = session.agent.getMessages();
  check('older tool output was archived in memory', live.some((m) => m.role === 'tool' && String(m.content).startsWith('[Previous tool output archived')));
  check('the saved history matches the pruned one exactly', json(store.load('prune')!.messages) === json(live));
  check('the file records the rewrites as edits, not a second copy', lines(sessionFile(store, ws, 'prune')).some((l) => l.includes('"t":"set"')));
  check('resuming gives back the pruned history', json(open(store, ws, [], { resume: 'prune', config: config(600) }).session.agent.getMessages().slice(1)) === json(live.slice(1)));
}

console.log('\n=== /clear really erases ===');
{
  const store = newStore();
  const ws = mk('ws');
  const { session } = open(store, ws, [...say('first reply'), ...say('second reply')], { sessionId: 'clr' });
  await session.run('my secret-text-123 request');
  check('before: the text is on disk and in the title', fs.readFileSync(sessionFile(store, ws, 'clr'), 'utf8').includes('secret-text-123') && store.info('clr')!.title.includes('secret-text-123'));
  session.reset();
  const raw = fs.readFileSync(sessionFile(store, ws, 'clr'), 'utf8');
  check('after reset the history file no longer contains it', !raw.includes('secret-text-123') && store.load('clr')!.messages.length === 1);
  check("...and neither does the title", !fs.readFileSync(path.join(store.projectDir(ws), 'clr.meta.json'), 'utf8').includes('secret-text-123') && store.info('clr')!.title === 'New conversation');
  await session.run('second topic');
  check('a new first message gets a fresh title', store.info('clr')!.title === 'second topic' && store.load('clr')!.messages.length === 3);

  const kept = open(store, ws, say('x'), { sessionId: 'clr2' });
  await kept.session.run('anything');
  store.rename('clr2', 'Chosen by user');
  kept.session.reset();
  check('a title the user chose survives a reset', store.info('clr2')!.title === 'Chosen by user');
}

console.log('\n=== damaged files do not break anything ===');
{
  const store = newStore();
  const ws = mk('ws');
  const a = open(store, ws, say('answer one'), { sessionId: 'dmg' });
  await a.session.run('question one');
  const file = sessionFile(store, ws, 'dmg');
  const good = store.load('dmg')!.messages;

  fs.appendFileSync(file, '{"t":"msg","m":{"role":"user","con'); // a write cut short by a crash
  const cut = store.load('dmg')!;
  check('a torn last line is skipped, the rest loads', cut.skipped === 1 && json(cut.messages) === json(good));

  const b = open(store, ws, say('answer two'), { resume: 'dmg' });
  await b.session.run('question two');
  const healed = store.load('dmg')!;
  check('after resuming, new entries are readable (they start on a fresh line)', healed.messages.length === good.length + 2 && messageText(healed.messages.at(-1)!) === 'answer two', `len=${healed.messages.length}`);
  check('...and only the one torn line is ignored', healed.skipped === 1);

  // Damage in the middle.
  const c = open(store, ws, say('c'), { sessionId: 'mid' });
  await c.session.run('hello');
  const midFile = sessionFile(store, ws, 'mid');
  const ls = lines(midFile);
  ls[1] = 'garbage';
  fs.writeFileSync(midFile, ls.join('\n') + '\n');
  const mid = store.load('mid')!;
  check('a damaged line in the middle is skipped', mid.skipped === 1 && mid.messages.length === ls.length - 1);

  // A damaged meta file hides that session only.
  const d = open(store, ws, say('d'), { sessionId: 'badmeta' });
  await d.session.run('hello');
  fs.writeFileSync(path.join(store.projectDir(ws), 'badmeta.meta.json'), '{ not json');
  const listed = store.list().map((s) => s.id).sort();
  check('list() skips it and keeps the others', listed.includes('dmg') && listed.includes('mid') && !listed.includes('badmeta'));
  check('load() of it is undefined, not an exception', store.load('badmeta') === undefined);
}

console.log('\n=== list: order, project filter, limit ===');
{
  const store = newStore();
  const wsA = mk('ws-a');
  const wsB = mk('ws-b');
  const touch = (id: string, ws: string, secondsAgo: number) => {
    store.create({ workspace: ws, model: 'm', id });
    const t = new Date(Date.now() - secondsAgo * 1000);
    fs.utimesSync(sessionFile(store, ws, id), t, t);
    fs.utimesSync(path.join(store.projectDir(ws), `${id}.meta.json`), t, t);
  };
  touch('a-old', wsA, 300);
  touch('a-new', wsA, 10);
  touch('b-mid', wsB, 100);
  check('newest first across projects', store.list().map((s) => s.id).join() === 'a-new,b-mid,a-old');
  check('filter by project', store.list({ workspace: wsA }).map((s) => s.id).join() === 'a-new,a-old' && store.list({ workspace: wsB }).length === 1);
  check('limit', store.list({ limit: 2 }).length === 2);
  check('an unknown project has none', store.list({ workspace: mk('empty') }).length === 0);
  if (process.platform === 'win32') {
    check('Windows: the project filter ignores drive/path letter case', store.list({ workspace: wsA.toUpperCase() }).length === 2);
  }
  fs.appendFileSync(sessionFile(store, wsA, 'a-old'), '');
  const bump = new Date();
  fs.utimesSync(sessionFile(store, wsA, 'a-old'), bump, bump);
  check('a session that just changed moves to the top', store.list()[0].id === 'a-old');
}

console.log('\n=== search ===');
{
  const store = newStore();
  const wsA = mk('ws-a');
  const wsB = mk('ws-b');
  const put = (id: string, ws: string, msgs: ChatMessage[], title?: string) => {
    store.create({ workspace: ws, model: 'm', id, title });
    store.recorder(id, { workspace: ws, getModel: () => 'm' }).sync(msgs);
  };
  put('s1', wsA, [
    { role: 'system', content: 'SYS needle-system' },
    { role: 'user', content: 'How do I configure the Frobnicator?' },
    { role: 'assistant', content: 'Use the Frobnicator settings page.' },
    { role: 'tool', tool_call_id: 'c', content: 'needle-tool output' } as any,
    { role: 'user', content: '<skill name="x" dir="d">\nneedle-skill body\n</skill>\n\nRequest / input: real request here' },
  ]);
  put('s2', wsB, [{ role: 'user', content: 'frobnicator in the other project' }]);
  put('s3', wsA, [{ role: 'user', content: 'unrelated' }], 'Quarterly report');

  const hits = store.search('FROBNICATOR');
  check('case-insensitive, across projects', hits.map((h) => h.info.id).sort().join() === 's1,s2');
  const s1 = hits.find((h) => h.info.id === 's1')!;
  check('matches name where they were found (the auto title counts)', s1.matches.map((m) => m.where).join() === 'title,user,assistant', s1.matches.map((m) => m.where).join());
  check('the snippet shows the term in context', s1.matches[1].snippet.includes('Frobnicator') && s1.matches[2].snippet.length < 120, s1.matches[2].snippet);
  check('filter by project', store.search('frobnicator', { workspace: wsA }).map((h) => h.info.id).join() === 's1');
  check('titles are searched', store.search('quarterly')[0]?.matches[0].where === 'title' && store.search('quarterly')[0].info.id === 's3');
  check('system prompt is not searched', store.search('needle-system').length === 0);
  check('tool output is not searched', store.search('needle-tool').length === 0);
  check('pinned skill text is not searched', store.search('needle-skill').length === 0);
  check('...but what the user typed alongside it is', store.search('real request').length === 1);
  check('no match, and an empty query, give nothing', store.search('zzzzz').length === 0 && store.search('   ').length === 0);
  check('limit', store.search('frobnicator', { limit: 1 }).length === 1);
  check('matches per session are capped', store.search('e', { maxMatchesPerSession: 2 }).every((h) => h.matches.length <= 2));
}

console.log('\n=== titles ===');
{
  check('plain', deriveTitle('Fix the login bug') === 'Fix the login bug');
  check('first non-empty line, whitespace collapsed', deriveTitle('\n\n  Fix   the\tlogin bug  \nmore details') === 'Fix the login bug');
  const long = deriveTitle('Please refactor the agent loop so that tool execution is separated from the model call and add tests');
  check('long titles are cut at a word, with an ellipsis', long.length <= 60 && long.endsWith('…') && !long.slice(0, -1).endsWith(' '), long);
  check('empty input gets a fallback', deriveTitle('   \n ') === 'New conversation');
  const invoked = 'I invoked the "spec-to-tasks" skill. It is already loaded below.\n\n<skill name="spec-to-tasks" dir="d">\nlong body\n</skill>\n\nRequest / input: break down @docs/specs/login.md';
  check('a /skill invocation becomes "/name input"', deriveTitle(invoked) === '/spec-to-tasks break down @docs/specs/login.md', deriveTitle(invoked));
  check('...or just "/name" when no input was given', deriveTitle('I invoked the "adr-reader" skill.\n\nRequest / input: (none given. Begin with the skill\'s own first step)') === '/adr-reader');
}

console.log('\n=== opt-in, lazy, resilient ===');
{
  const ws = mk('ws');
  const none = open(undefined, ws, say('hi'));
  await none.session.run('hello');
  check('without a store nothing is saved and there is no id', none.session.id === undefined);

  const store = newStore();
  open(store, ws, say('hi'));
  check('opening a session with a store creates no files', store.list().length === 0 && !fs.existsSync(store.projectDir(ws)));

  // Two conversations on one project at once.
  const [x, y] = [open(store, ws, say('reply X'), { sessionId: 'cx' }), open(store, ws, say('reply Y'), { sessionId: 'cy' })];
  await Promise.all([x.session.run('question X'), y.session.run('question Y')]);
  const lx = store.load('cx')!;
  const ly = store.load('cy')!;
  const talk = (l: typeof lx) => l.messages.filter((m) => m.role !== 'system').map(messageText).join('|');
  check('concurrent sessions keep separate histories', talk(lx) === 'question X|reply X' && talk(ly) === 'question Y|reply Y', `${talk(lx)} / ${talk(ly)}`);
  check('sessions for the same project are listed together', store.list({ workspace: ws }).length === 2);

  // A store that cannot be written must not stop the conversation.
  const blocker = path.join(tmp, 'a-file');
  fs.writeFileSync(blocker, 'x');
  const broken = open(new SessionStore({ dir: path.join(blocker, 'sub') }), ws, say('still works'));
  const r = await broken.session.run('save me if you can');
  check('an unwritable store does not break the run', r.status === 'completed' && r.text === 'still works');
}

console.log('\n=== a run that was cut short can be resumed ===');
{
  const call = (id: string) => ({ id, type: 'function' as const, function: { name: 'list_files', arguments: '{}' } });
  const history: ChatMessage[] = [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: null, tool_calls: [call('a'), call('b'), call('c')] },
    { role: 'tool', tool_call_id: 'a', content: 'ok' },
  ];
  const fixed = repairInterruptedHistory(history);
  check('missing tool results are added right after the turn, in call order', fixed.repaired === 2 && fixed.messages.map((m) => (m.role === 'tool' ? (m as any).tool_call_id : m.role)).join() === 'user,assistant,a,b,c');
  check('...saying they did not finish', String((fixed.messages[3] as any).content).startsWith(INTERRUPTED_OUTPUT_PREFIX));
  check('the input is not changed, and a valid history comes back as it is', history.length === 3 && repairInterruptedHistory(fixed.messages).messages === fixed.messages && repairInterruptedHistory(fixed.messages).repaired === 0);
  const twoTurns: ChatMessage[] = [...history, { role: 'assistant', content: null, tool_calls: [call('d')] }];
  check('every turn is checked, including a last one with no results at all', repairInterruptedHistory(twoTurns).repaired === 3);

  // The real thing: a saved file that stops after one of two results, resumed and run.
  const store = newStore();
  const ws = mk('ws');
  const first = open(store, ws, [{ toolCalls: [{ name: 'list_files', args: { path: '.' }, id: 'x1' }, { name: 'list_files', args: { path: '.' }, id: 'x2' }] }, { content: 'done' }], { sessionId: 'cut' });
  await first.session.run('list twice');
  const file = sessionFile(store, ws, 'cut');
  const kept = lines(file);
  // Drop the second tool result and the final answer: the process died between them.
  fs.writeFileSync(file, kept.slice(0, kept.findIndex((l) => l.includes('"tool_call_id":"x2"'))).join('\n') + '\n');
  const resumed = open(store, ws, say('picking up'), { resume: 'cut' });
  const r = await resumed.session.run('what happened?');
  const sent = resumed.model.requests[0].messages;
  const toolIds = sent.filter((m) => m.role === 'tool').map((m: any) => m.tool_call_id);
  check('the resumed conversation answers every tool call it announced', r.status === 'completed' && toolIds.join() === 'x1,x2');
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll session store checks passed.');
