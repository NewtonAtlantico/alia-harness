import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentEvent } from '../src/core/agent/events.js';
import { AliaConfig } from '../src/core/config.js';
import { createSession } from '../src/core/session.js';
import { CORE_COMMANDS } from '../src/core/commands/commandRegistry.js';
import { SessionStore, ChatMessage, messageText } from '../src/core/sessions/sessionStore.js';
import { SUMMARY_TAG } from '../src/core/context/compactor.js';
import { SLASH_COMMANDS, setSlashCommands } from '../src/cli/ui/prompt.js';
import { FakeModel, ScriptedTurn } from './lib/fakeModel.js';

let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.log(`  ✘ ${name} ${extra}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alia-cmds-'));
let n = 0;
const mk = (label: string) => {
  const dir = path.join(tmp, `${label}-${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const json = (v: unknown) => JSON.stringify(v);

const config: AliaConfig = {
  name: 't',
  vendor: 't',
  apiKey: 'k',
  apiType: 'chat-completions',
  models: [
    { id: 'fake-model', name: 'fake', url: 'http://fake', toolCalling: true, maxInputTokens: 1000 },
    { id: 'other-model', name: 'other', url: 'http://fake', toolCalling: true, maxInputTokens: 5000 },
  ],
};

function open(turns: ScriptedTurn[], extra: Partial<Parameters<typeof createSession>[0]> = {}) {
  const model = new FakeModel(turns);
  const events: AgentEvent[] = [];
  const session = createSession({
    workspace: mk('ws'),
    config,
    client: model.client,
    skillRoots: [],
    permissionsDir: path.join(tmp, 'perm'),
    onEvent: (e) => events.push(e),
    ...extra,
  });
  return { session, model, events };
}

function historyIsValid(messages: ChatMessage[]): boolean {
  for (let i = 0; i < messages.length; i++) {
    const m: any = messages[i];
    if (m.role === 'tool') {
      // every tool message must directly follow its assistant call (or a sibling tool message)
      let j = i - 1;
      while (j >= 0 && messages[j].role === 'tool') j--;
      const owner: any = messages[j];
      if (!owner || owner.role !== 'assistant' || !owner.tool_calls?.some((c: any) => c.id === m.tool_call_id)) return false;
    }
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const ids = m.tool_calls.map((c: any) => c.id).sort().join();
      const got = messages.slice(i + 1, i + 1 + m.tool_calls.length).filter((x) => x.role === 'tool').map((x: any) => x.tool_call_id).sort().join();
      if (ids !== got) return false;
    }
  }
  return true;
}

/** A conversation of `pairs` question/answer turns, with a pinned skill loaded early and one tool exchange. */
function conversation(session: { agent: { getMessages(): ChatMessage[] } }, pairs: number): ChatMessage[] {
  const sys = session.agent.getMessages()[0];
  const msgs: ChatMessage[] = [sys, { role: 'user', content: 'first question about the login flow' }];
  msgs.push({ role: 'assistant', content: null, tool_calls: [{ id: 'c_skill', type: 'function', function: { name: 'use_skill', arguments: '{"name":"alpha"}' } }] } as any);
  msgs.push({ role: 'tool', tool_call_id: 'c_skill', content: '<skill name="alpha" dir="d">\nSKILL-BODY-ALPHA\n</skill>' } as any);
  msgs.push({ role: 'assistant', content: 'MIDDLE-ONLY-TEXT I read the skill and I am ready.' });
  for (let i = 0; i < pairs; i++) {
    msgs.push({ role: 'user', content: `question ${i} ` + 'filler '.repeat(40) });
    msgs.push({ role: 'assistant', content: `answer ${i} ` + 'filler '.repeat(40) });
  }
  msgs.push({ role: 'user', content: 'RECENT-ONLY-TEXT what is next?' });
  msgs.push({ role: 'assistant', content: 'we continue' });
  return msgs;
}

const summarizer = (text: string): ScriptedTurn => ({ content: text });

console.log('\n=== the command list ===');
{
  const skills = mk('skills');
  const skill = (name: string, front = '') => {
    fs.mkdirSync(path.join(skills, name));
    fs.writeFileSync(path.join(skills, name, 'SKILL.md'), `---\nname: ${name}\ndescription: the ${name}   skill\n${front}---\nBODY`);
  };
  skill('alpha');
  skill('gated', 'requires: tool_that_does_not_exist\n');
  skill('help'); // clashes with a built-in
  skill('config'); // will clash with a front-end command
  const { session } = open([], { skillRoots: [{ label: 't', dir: skills }] });
  const reg = session.commands;

  let names = reg.list().map((c) => c.name);
  check('built-ins come first, in a fixed order', names.slice(0, CORE_COMMANDS.length).join() === CORE_COMMANDS.map((c) => c.name).join());
  check('/compact is a built-in', reg.get('compact')?.kind === 'builtin');
  const alpha = reg.get('alpha')!;
  check('an available skill gets a command (description tidied, usage, takes arguments)', alpha.kind === 'skill' && alpha.description === 'the alpha skill' && alpha.usage === '/alpha <input>' && alpha.acceptsArgs);
  check('an unavailable skill does not', !names.includes('gated'));
  check('a skill that clashes with a built-in is left out and reported', !reg.list().some((c) => c.name === 'help' && c.kind === 'skill') && reg.skippedSkills().includes('help'));
  check('built-in /help is still the built-in', reg.get('help')?.kind === 'builtin');

  reg.register({ name: '/config', description: 'Open settings' });
  reg.register({ name: 'exit', description: 'Exit', acceptsArgs: false });
  names = reg.list().map((c) => c.name);
  check('front-end commands are added (slash optional), as kind host', reg.get('config')?.kind === 'host' && names.includes('exit'));
  check('...after the built-ins and before skills', names.indexOf('config') > names.indexOf('tokens') && names.indexOf('config') < names.indexOf('alpha'));
  check('a skill named like a front-end command gives way and is reported', !reg.list().some((c) => c.name === 'config' && c.kind === 'skill') && reg.skippedSkills().includes('config'));

  const throws = (fn: () => void) => {
    try {
      fn();
      return false;
    } catch {
      return true;
    }
  };
  check('a name already taken is rejected (built-in, front-end, any case)', throws(() => reg.register({ name: 'clear', description: 'x' })) && throws(() => reg.register({ name: 'EXIT', description: 'x' })));
  check('a name with spaces or nothing is rejected', throws(() => reg.register({ name: 'two words', description: 'x' })) && throws(() => reg.register({ name: '/', description: 'x' })));
  check('lookup ignores slash and case', reg.get('/ALPHA')?.name === 'alpha' && reg.get('nope') === undefined);

  session.tools.register({ name: 'tool_that_does_not_exist', description: 'x', parameters: { type: 'object', properties: {} }, execute: async () => 'ok' });
  check('the list follows the tools: a skill appears once its requirement is met', reg.list().some((c) => c.name === 'gated'));

  // The terminal's slash menu reads the very same list.
  setSlashCommands(reg.list());
  check('the CLI prompt menu shows exactly the registry list', json(SLASH_COMMANDS.map((c) => c.command)) === json(reg.list().map((c) => `/${c.name}`)));
  const menuAlpha = SLASH_COMMANDS.find((c) => c.command === '/alpha')!;
  const menuModel = SLASH_COMMANDS.find((c) => c.command === '/model')!;
  check('skills are marked and labelled in the menu; others are not', menuAlpha.skill === true && menuAlpha.description.startsWith('[skill] ') && menuModel.skill === false && !menuModel.description.startsWith('[skill]'));
  check('usage and "takes arguments" carry over', menuModel.usage === '/model <id>' && menuModel.acceptsArgs && menuAlpha.acceptsArgs && !SLASH_COMMANDS.find((c) => c.command === '/help')!.acceptsArgs);
  const second = open([], { skillRoots: [{ label: 't', dir: skills }] }).session;
  // (No front-end commands here, so the skill named "config" is no longer shadowed; "gated" needs a tool this one lacks.)
  check('another session over the same skills lists built-ins, then the available skills', json(second.commands.list().map((c) => c.name)) === json([...CORE_COMMANDS.map((c) => c.name), 'alpha', 'config']), json(second.commands.list().map((c) => c.name)));
}

console.log('\n=== /compact ===');
{
  const { session, model, events } = open([summarizer('SUMMARY: the user is working on the login flow.')]);
  const history = conversation(session, 12);
  session.agent.setMessages(history);
  const tokensBefore = session.getContextUsage().tokens;
  const r = await session.compact();

  check('result reports what it did', r.status === 'compacted' && r.summarized > 0 && r.tokensBefore === tokensBefore && r.tokensAfter < r.tokensBefore, json(r));
  const after = session.agent.getMessages();
  check('history got much shorter', after.length < history.length / 2 && after.length === 13, `len=${after.length}`);
  check('the system prompt is kept as is', after[0] === history[0]);
  check('the last 10 messages are kept verbatim', json(after.slice(-10)) === json(history.slice(-10)));
  const summary = after.find((m) => messageText(m).startsWith(SUMMARY_TAG))!;
  check('one summary message stands in for the rest', !!summary && summary.role === 'user' && messageText(summary).includes('the user is working on the login flow') && after.filter((m) => messageText(m).startsWith(SUMMARY_TAG)).length === 1);
  const pinned = after.find((m) => m.role === 'user' && messageText(m).includes('SKILL-BODY-ALPHA'));
  check('a pinned skill survives, as a user message (its tool call is gone)', !!pinned && !after.some((m) => m.role === 'tool' && messageText(m).includes('SKILL-BODY-ALPHA')));
  check('the history is still valid for the API', historyIsValid(after));
  check('the old turns are gone', !after.some((m) => messageText(m).includes('MIDDLE-ONLY-TEXT')) && !after.some((m) => messageText(m).startsWith('question 0')));

  const req = model.requests[0];
  const sent = messageText(req.messages[1]);
  check('the summary request has no tools and its own instructions', req.toolNames.length === 0 && String(req.messages[0].content).includes('compress the earlier part'));
  check('it carries the older turns...', sent.includes('MIDDLE-ONLY-TEXT') && sent.includes('question 0') && sent.includes('called use_skill'));
  check('...but not the recent ones, nor the pinned skill', !sent.includes('RECENT-ONLY-TEXT') && !sent.includes('SKILL-BODY-ALPHA'));

  const ev = events.find((e) => e.type === 'context_compacted') as any;
  check('a context_compacted event says how much was saved', ev && ev.tokensBefore === r.tokensBefore && ev.tokensAfter === (r as any).tokensAfter && ev.summarized === (r as any).summarized);

  // The conversation goes on.
  const cont = open([summarizer('S1'), { content: 'carrying on' }]);
  cont.session.agent.setMessages(conversation(cont.session, 12));
  await cont.session.compact();
  const rr = await cont.session.run('and now?');
  const seen = cont.model.requests[1].messages;
  check('the next run works and the model sees the summary plus the new question', rr.status === 'completed' && seen.some((m) => messageText(m).startsWith(SUMMARY_TAG)) && messageText(seen.at(-1)!) === 'and now?');
}

console.log('\n=== the kept tail never starts on an orphaned tool result ===');
{
  const { session } = open([summarizer('S')]);
  const msgs = conversation(session, 6);
  msgs.push({ role: 'assistant', content: null, tool_calls: [{ id: 'ta', type: 'function', function: { name: 'list_files', arguments: '{}' } }, { id: 'tb', type: 'function', function: { name: 'list_files', arguments: '{}' } }] } as any);
  msgs.push({ role: 'tool', tool_call_id: 'ta', content: 'result a' } as any);
  msgs.push({ role: 'tool', tool_call_id: 'tb', content: 'result b' } as any);
  session.agent.setMessages(msgs);
  const r = await session.compact({ keepRecent: 2 }); // the naive cut would land on a tool message
  const after = session.agent.getMessages();
  check('compacted', r.status === 'compacted', json(r));
  check('the assistant message that made the calls is kept with its results', json(after.slice(-3)) === json(msgs.slice(-3)) && historyIsValid(after));
}

console.log('\n=== when it should not, or cannot, compact ===');
{
  const short = open([summarizer('never used')]);
  short.session.agent.setMessages([short.session.agent.getMessages()[0], { role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }]);
  const r = await short.session.compact();
  check('a short history: nothing to compact, and no model call is made', r.status === 'nothing_to_compact' && short.model.callCount === 0);
  check('...and it says so', short.events.some((e) => e.type === 'notice' && (e as any).message === 'Nothing to compact yet.'));

  const bad = open([{ throws: 'endpoint down' }]);
  const h = conversation(bad.session, 12);
  bad.session.agent.setMessages(h);
  const failed = await bad.session.compact();
  check('an API error leaves the history untouched', failed.status === 'failed' && (failed as any).error.includes('endpoint down') && json(bad.session.agent.getMessages()) === json(h));
  check('...and is reported as an error notice', bad.events.some((e) => e.type === 'notice' && (e as any).level === 'error') && !bad.events.some((e) => e.type === 'context_compacted'));

  const empty = open([summarizer('   ')]);
  const he = conversation(empty.session, 12);
  empty.session.agent.setMessages(he);
  const fe = await empty.session.compact();
  check('an empty summary is a failure, not a silent wipe', fe.status === 'failed' && (fe as any).error.includes('empty') && json(empty.session.agent.getMessages()) === json(he));

  const slow = open([{ hang: 'honor-signal' }]);
  const hs = conversation(slow.session, 12);
  slow.session.agent.setMessages(hs);
  const c = new AbortController();
  setTimeout(() => c.abort(), 100);
  const t0 = Date.now();
  const cancelled = await slow.session.compact({ signal: c.signal });
  check('cancelling stops it promptly and changes nothing', cancelled.status === 'cancelled' && Date.now() - t0 < 1000 && json(slow.session.agent.getMessages()) === json(hs));

  // A summary longer than what it replaces would make things worse.
  const tiny = open([summarizer('x'.repeat(4000))]);
  const ht = tiny.session.agent.getMessages().slice(0, 1);
  for (let i = 0; i < 6; i++) ht.push({ role: i % 2 ? 'assistant' : 'user', content: 'ok' });
  tiny.session.agent.setMessages(ht);
  const rt = await tiny.session.compact({ keepRecent: 1 });
  check('a summary that would not save anything is refused', rt.status === 'nothing_to_compact' && json(tiny.session.agent.getMessages()) === json(ht), json(rt));
}

console.log('\n=== busy ===');
{
  const a = open([{ hang: 'honor-signal' }]);
  const c = new AbortController();
  const running = a.session.run('start', { signal: c.signal });
  await sleep(50);
  check('compact() during a run says busy', (await a.session.compact()).status === 'busy');
  c.abort();
  await running;
  check('...and works again once the run has ended', (await a.session.compact()).status === 'nothing_to_compact');

  const b = open([{ hang: 'honor-signal' }]);
  b.session.agent.setMessages(conversation(b.session, 12));
  const c2 = new AbortController();
  const compacting = b.session.compact({ signal: c2.signal });
  await sleep(50);
  const blocked = await b.session.run('hello?');
  check('run() during a compaction is refused, not interleaved', blocked.status === 'failed' && blocked.text.includes('being compacted') && b.model.callCount === 1);
  c2.abort();
  await compacting;
}

console.log('\n=== long histories and repeated compaction ===');
{
  // The transcript sent for summarizing is capped, however much is being compacted.
  const big = open([summarizer('S')]);
  const msgs: ChatMessage[] = [big.session.agent.getMessages()[0]];
  for (let i = 0; i < 100; i++) {
    msgs.push({ role: 'user', content: `q${i} ` + 'x'.repeat(5000) });
    msgs.push({ role: 'assistant', content: `a${i} ` + 'y'.repeat(5000) });
  }
  big.session.agent.setMessages(msgs);
  await big.session.compact();
  const sentLen = messageText(big.model.requests[0].messages[1]).length;
  check('the text sent for summarizing is capped (and says it left the middle out)', sentLen < 9000 && messageText(big.model.requests[0].messages[1]).includes('left out'), `len=${sentLen}`);

  // Compacting twice leaves one summary, and the second pass sees the first.
  const twice = open([summarizer('FIRST SUMMARY'), summarizer('SECOND SUMMARY')]);
  twice.session.agent.setMessages(conversation(twice.session, 12));
  await twice.session.compact();
  const grown = twice.session.agent.getMessages();
  for (let i = 0; i < 8; i++) grown.push({ role: i % 2 ? 'assistant' : 'user', content: `later ${i} ` + 'z'.repeat(80) });
  twice.session.agent.setMessages(grown);
  const r2 = await twice.session.compact();
  const after = twice.session.agent.getMessages();
  check('second compaction succeeds, with a single summary that replaces the first', r2.status === 'compacted' && after.filter((m) => messageText(m).startsWith(SUMMARY_TAG)).length === 1 && messageText(after.find((m) => messageText(m).startsWith(SUMMARY_TAG))!).includes('SECOND SUMMARY'));
  check('the second pass was given the first summary to fold in', messageText(twice.model.requests[1].messages[1]).includes('FIRST SUMMARY'));
  check('the pinned skill is still there after two passes', after.some((m) => m.role === 'user' && messageText(m).includes('SKILL-BODY-ALPHA')) && historyIsValid(after));
}

console.log('\n=== saved sessions follow a compaction ===');
{
  const store = new SessionStore({ dir: mk('store') });
  const { session } = open([{ content: 'a first answer' }, summarizer('SUMMARY FOR DISK')], { sessionStore: store, sessionId: 'cmp' });
  await session.run('first question about the login flow');
  const grown = session.agent.getMessages();
  for (let i = 0; i < 12; i++) grown.push({ role: i % 2 ? 'assistant' : 'user', content: `turn ${i} ` + 'w'.repeat(100) });
  session.agent.setMessages(grown);
  const before = fs.statSync(path.join(store.projectDir(session.workspace), 'cmp.jsonl')).size;
  const r = await session.compact();
  const file = path.join(store.projectDir(session.workspace), 'cmp.jsonl');
  const saved = store.load('cmp')!;
  check('compacted', r.status === 'compacted', json(r));
  check('the saved history equals the live one', json(saved.messages) === json(session.agent.getMessages()));
  check('the file shrank: the compacted turns are gone from disk', fs.statSync(file).size < before && !fs.readFileSync(file, 'utf8').includes('turn 0'));
  check('the conversation keeps its title', saved.info.title === 'first question about the login flow', saved.info.title);
  const back = open([], { sessionStore: store, resume: 'cmp', workspace: session.workspace }).session.agent.getMessages();
  check('a resumed session starts from the compacted history', back.some((m) => messageText(m).startsWith(SUMMARY_TAG)) && back.length === saved.messages.length);
}

console.log('\n=== the context limit follows the model ===');
{
  const { session } = open([]);
  const big = (n: number): ChatMessage[] => {
    const m: ChatMessage[] = [session.agent.getMessages()[0]];
    for (let i = 0; i < n; i++) {
      m.push({ role: 'assistant', content: null, tool_calls: [{ id: `t${i}`, type: 'function', function: { name: 'read_file', arguments: '{}' } }] } as any);
      m.push({ role: 'tool', tool_call_id: `t${i}`, content: 'x'.repeat(1500) } as any);
    }
    return m;
  };
  const history = big(8); // about 3,000 tokens
  check('starts at the first model: 1000', session.contextManager.getMaxInputTokens() === 1000 && session.getContextUsage().limit === 1000);
  check('...where this history is pruned', session.contextManager.pruneMessages(history).pruned === true);
  await session.switchModel('other-model');
  check('switching to a bigger model raises the pruning limit', session.contextManager.getMaxInputTokens() === 5000 && session.getContextUsage().limit === 5000);
  check('...so the same history is no longer pruned', session.contextManager.pruneMessages(history).pruned === false);
  await session.switchModel('fake-model');
  check('switching back lowers it again', session.contextManager.getMaxInputTokens() === 1000 && session.contextManager.pruneMessages(history).pruned === true);
  const failed = await session.switchModel('zzz');
  check('a failed switch changes nothing', !failed.ok && session.getModel() === 'fake-model' && session.contextManager.getMaxInputTokens() === 1000);
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll command and compaction checks passed.');
