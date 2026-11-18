import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { AgentEvent } from '../src/core/agent/events.js';
import { AliaConfig } from '../src/core/config.js';
import { createSession } from '../src/core/session.js';
import { SkillRegistry, formatSkillForModel, harnessNotes } from '../src/core/skills/skillLoader.js';
import {
  ASK_USER_TOOL_NAME,
  AskUserRequest,
  UserAnswer,
  UserQuestion,
  createAskUserTool,
  validateQuestions,
} from '../src/core/tools/askUser.js';
import { ToolRegistry } from '../src/core/tools/index.js';
import { CANCELLED_OUTPUT_PREFIX, isToolErrorResult } from '../src/core/tools/types.js';
import { SafetyChecker } from '../src/core/safety/safetyChecker.js';
import { ContextManager } from '../src/core/context/contextManager.js';
import { cliAskUser } from '../src/cli/ui/terminal.js';
import { FakeModel, ScriptedTurn } from './lib/fakeModel.js';
import { stripAnsi } from './lib/testUtils.js';

let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.log(`  ✘ ${name} ${extra}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alia-ask-'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const config: AliaConfig = { name: 't', vendor: 't', apiKey: 'k', apiType: 'chat-completions', models: [{ id: 'fake-model', name: 'fake', url: 'http://fake', toolCalling: true }] };

const choiceQ = (id = 'q1', extra: object = {}) => ({
  id,
  kind: 'choice',
  prompt: 'Qual versão do BRD é a oficial?',
  options: [
    { id: 'v1', label: 'v1', detail: 'Primeira versão', source: 'BRD_v1.pdf · p. 1' },
    { id: 'v2', label: 'v2', source: 'BRD_v2.pdf · p. 1' },
  ],
  ...extra,
});

console.log('\n=== validating the model\'s questions ===');
{
  const bad = (raw: unknown) => {
    const r = validateQuestions(raw);
    return 'error' in r ? r.error : '';
  };
  const good = validateQuestions([choiceQ('a', { allowDefer: true, confidence: 'low' }), { id: 'b', kind: 'text', prompt: 'Quem é o dono?' }, { id: 'c', kind: 'confirm', prompt: 'Confirma?' }]);
  check('a valid set passes, cleaned', 'questions' in good && good.questions.length === 3 && good.questions[0].allowDefer === true && good.questions[0].confidence === 'low' && good.questions[0].options![0].source === 'BRD_v1.pdf · p. 1');
  check('not an array / empty', bad(undefined).includes('non-empty array') && bad([]).includes('non-empty array') && bad('q').includes('non-empty array'));
  check('too many at once', bad(Array.from({ length: 11 }, (_, i) => ({ id: `q${i}`, kind: 'confirm', prompt: 'x' }))).includes('at most 10'));
  check('id required and unique', bad([{ kind: 'confirm', prompt: 'x' }]).includes('id is required') && bad([{ id: 'a', kind: 'confirm', prompt: 'x' }, { id: 'a', kind: 'confirm', prompt: 'y' }]).includes('used twice'));
  check('kind must be known', bad([{ id: 'a', kind: 'multi', prompt: 'x' }]).includes('kind must be one of'));
  check('prompt required', bad([{ id: 'a', kind: 'confirm', prompt: '  ' }]).includes('prompt is required'));
  check('a choice needs two options with ids and labels', bad([{ id: 'a', kind: 'choice', prompt: 'x', options: [{ id: 'o', label: 'only' }] }]).includes('at least two') && bad([{ id: 'a', kind: 'choice', prompt: 'x', options: [{ id: 'o', label: 'one' }, { id: 'p' }] }]).includes('"label"'));
  check('option ids must be unique', bad([{ id: 'a', kind: 'choice', prompt: 'x', options: [{ id: 'o', label: 'one' }, { id: 'o', label: 'two' }] }]).includes('used twice'));
  check('options only belong to choices', bad([{ id: 'a', kind: 'text', prompt: 'x', options: [{ id: 'o', label: 'one' }, { id: 'p', label: 'two' }] }]).includes('only applies to kind "choice"'));
  check('confidence must be known', bad([{ id: 'a', kind: 'confirm', prompt: 'x', confidence: 'sure' }]).includes('confidence'));
}

console.log('\n=== the tool, with a fake front-end ===');
{
  const ctx = (extra: object = {}) => ({ workingDirectory: tmp, safetyChecker: new SafetyChecker(true), contextManager: new ContextManager(), ...extra });
  const run = async (questions: unknown[], answers: UserAnswer[] | ((r: AskUserRequest) => Promise<UserAnswer[]>), extra: object = {}) => {
    const seen: AskUserRequest[] = [];
    const tool = createAskUserTool({
      getHandler: () => async (r) => {
        seen.push(r);
        return typeof answers === 'function' ? answers(r) : answers;
      },
    });
    const out = await tool.execute({ questions }, ctx(extra) as any);
    return { out, seen };
  };
  const parse = (s: string) => JSON.parse(s);

  const all = await run(
    [choiceQ('q1'), { id: 'q2', kind: 'text', prompt: 'Quem decide?' }, { id: 'q3', kind: 'confirm', prompt: 'Confirma?' }, choiceQ('q4', { allowDefer: true })],
    [{ id: 'q1', answer: 'v2' }, { id: 'q2', answer: '  Newton  ' }, { id: 'q3', answer: false }, { id: 'q4', deferred: true, owner: ' Newton ' }],
    { toolCallId: 'call_9' }
  );
  const r1 = parse(all.out);
  check('answers come back as JSON, in question order', r1.answers.map((a: any) => a.id).join() === 'q1,q2,q3,q4');
  check('a choice carries the option id and its label', r1.answers[0].answer === 'v2' && r1.answers[0].label === 'v2');
  check('text is trimmed, a confirm stays boolean', r1.answers[1].answer === 'Newton' && r1.answers[2].answer === false);
  check('a deferral carries its owner', r1.answers[3].deferred === true && r1.answers[3].owner === 'Newton' && r1.answers[3].answer === undefined);
  check('a complete set has no unanswered list and no note', r1.unanswered === undefined && r1.note === undefined);
  check('the front-end received the cleaned questions and the call id', all.seen[0].questions.length === 4 && all.seen[0].toolCallId === 'call_9' && all.seen[0].questions[0].options![0].label === 'v1');

  const partial = parse((await run([choiceQ('q1'), choiceQ('q2'), choiceQ('q3')], [{ id: 'q2', answer: 'v1' }])).out);
  check('questions left out come back as unanswered, with a stop-here note', JSON.stringify(partial.unanswered) === '["q1","q3"]' && partial.note.includes('q1, q3') && partial.note.includes('Do not continue') && partial.answers.length === 1);
  const empties = parse((await run([choiceQ('q1')], [{ id: 'q1' }])).out);
  check('an answer with nothing in it counts as unanswered', JSON.stringify(empties.unanswered) === '["q1"]');

  const noOwner = parse((await run([choiceQ('q1', { allowDefer: true })], [{ id: 'q1', deferred: true }])).out);
  check('a deferral with no owner is passed on with a note to ask who owns it', noOwner.answers[0].owner === null && noOwner.note.includes('who owns'));

  const last = parse((await run([choiceQ('q1')], [{ id: 'q1', answer: 'v1' }, { id: 'q1', answer: 'v2' }])).out);
  check('a later answer to the same question wins', last.answers[0].answer === 'v2');

  const other = parse((await run([choiceQ('q1', { allowOther: true })], [{ id: 'q1', answer: 'Nenhuma das duas' }])).out);
  check('allowOther accepts free text', other.answers[0].answer === 'Nenhuma das duas' && other.answers[0].label === undefined);

  const errOf = async (q: unknown[], a: UserAnswer[]) => (await run(q, a)).out;
  const e1 = await errOf([choiceQ('q1')], [{ id: 'q1', answer: 'v9' }]);
  check('a choice answer that is not an option is rejected (a front-end bug is not hidden)', isToolErrorResult(e1) && e1.includes('"v9" is not one of the options'), e1);
  const e2 = await errOf([choiceQ('q1')], [{ id: 'q1', deferred: true, owner: 'x' }]);
  check('deferring a question that does not allow it is rejected', isToolErrorResult(e2) && e2.includes('cannot be deferred'), e2);
  const e3 = await errOf([{ id: 'q1', kind: 'confirm', prompt: 'ok?' }], [{ id: 'q1', answer: 'yes' }]);
  check('a confirm must be answered true or false', isToolErrorResult(e3) && e3.includes('true or false'), e3);
  const e4 = await errOf([{ id: 'q1', kind: 'text', prompt: 'x' }], [{ id: 'q1', answer: '   ' }]);
  check('a blank text answer is rejected', isToolErrorResult(e4) && e4.includes('non-empty'));
  const e5 = await errOf([choiceQ('q1')], [{ id: 'zzz', answer: 'v1' }]);
  check('answers to unknown questions are rejected', isToolErrorResult(e5) && e5.includes('unknown question'));
  check('the front-end must return an array', isToolErrorResult((await run([choiceQ('q1')], (async () => 'nope') as any)).out));

  const thrown = await run([choiceQ('q1')], async () => {
    throw new Error('window closed');
  });
  check('a front-end that throws becomes an error result', isToolErrorResult(thrown.out) && thrown.out.includes('window closed'));

  const bad = (await run([{ id: 'q1', kind: 'nope', prompt: 'x' }], [])).out;
  check('invalid questions are an error for the model, and the user is never bothered', isToolErrorResult(bad) && bad.includes('kind must be one of'));
  const nothing = await run([{ id: 'q1', kind: 'nope', prompt: 'x' }], []);
  check('...the handler is not even called', nothing.seen.length === 0);

  const noHandler = await createAskUserTool({ getHandler: () => undefined }).execute({ questions: [choiceQ('q1')] }, ctx() as any);
  check('with no front-end: an error telling the model to ask in plain text', isToolErrorResult(noHandler) && noHandler.includes('plain text') && noHandler.includes('Never invent answers'));
}

console.log('\n=== cancelling while the questions are open ===');
{
  const ctx = (signal: AbortSignal) => ({ workingDirectory: tmp, safetyChecker: new SafetyChecker(true), contextManager: new ContextManager(), signal });
  let handlerSignal: AbortSignal | undefined;
  const tool = createAskUserTool({
    getHandler: () => (r) => {
      handlerSignal = r.signal;
      return new Promise<UserAnswer[]>(() => {}); // the user never answers
    },
  });
  const c = new AbortController();
  setTimeout(() => c.abort(), 100);
  const t0 = Date.now();
  const out = await tool.execute({ questions: [choiceQ('q1')] }, ctx(c.signal) as any);
  check('the run is not left waiting', out.startsWith(CANCELLED_OUTPUT_PREFIX) && Date.now() - t0 < 1000, out);
  check('the front-end got the signal so it can dismiss its cards', handlerSignal !== undefined && handlerSignal.aborted);

  const pre = new AbortController();
  pre.abort();
  let called = false;
  const asked = await createAskUserTool({ getHandler: () => async () => ((called = true), []) }).execute({ questions: [choiceQ('q1')] }, ctx(pre.signal) as any);
  check('an already-cancelled run does not ask at all', asked.startsWith(CANCELLED_OUTPUT_PREFIX) && !called);
}

console.log('\n=== through a session ===');
{
  const turnsFor = (questions: unknown[]): ScriptedTurn[] => [
    { toolCalls: [{ name: 'ask_user', args: { questions }, id: 'call_q' }] },
    (req) => ({ content: `heard: ${String(req.messages.filter((m) => m.role === 'tool').pop()?.content).replace(/\s+/g, ' ')}` }),
  ];
  const open = (turns: ScriptedTurn[], onAskUser?: Parameters<typeof createSession>[0]['onAskUser']) => {
    const model = new FakeModel(turns);
    const events: AgentEvent[] = [];
    const session = createSession({ workspace: tmp, config, client: model.client, skillRoots: [], permissionsDir: path.join(tmp, 'perm'), onAskUser, onEvent: (e) => events.push(e) });
    return { session, model, events };
  };

  const asked: AskUserRequest[] = [];
  const withUi = open(turnsFor([choiceQ('q1', { allowDefer: true })]), async (r) => {
    asked.push(r);
    return [{ id: 'q1', answer: 'v2' }];
  });
  const result = await withUi.session.run('start the pipeline');
  check('with a front-end, ask_user is offered to the model', withUi.model.requests[0].toolNames.includes(ASK_USER_TOOL_NAME));
  check('the model\'s call reached the front-end, tied to the tool call id', asked.length === 1 && asked[0].toolCallId === 'call_q' && asked[0].questions[0].id === 'q1');
  check("the model got the user's answer as JSON", result.text.includes('"answer": "v2"') && result.text.includes('"label": "v2"'), result.text);
  const fin = withUi.events.find((e) => e.type === 'tool_call_finished' && (e as any).id === 'call_q') as any;
  check('the call shows as a normal, successful tool call', fin && fin.isError === false && fin.name === 'ask_user');

  const without = open([{ content: 'hi' }]);
  await without.session.run('x');
  check('without a front-end the tool is not offered at all', !without.model.requests[0].toolNames.includes(ASK_USER_TOOL_NAME));
  check('and "ask_user" is unknown to the registry', without.session.tools.get('ask_user') === undefined);

  // The registry can still be built by hand, e.g. in another host.
  const reg = new ToolRegistry();
  reg.register(createAskUserTool({ getHandler: () => undefined }));
  check('a hand-built registry gets the plain-text fallback', (await reg.execute('ask_user', JSON.stringify({ questions: [choiceQ('q1')] }), { workingDirectory: tmp, safetyChecker: new SafetyChecker(true), contextManager: new ContextManager() })).includes('plain text'));
}

console.log('\n=== the harness notes follow the tools ===');
{
  const base = ['read_file', 'write_file', 'edit_file', 'list_files', 'grep_search', 'run_bash', 'use_skill'];
  const plain = harnessNotes(base);
  check('without ask_user and subagents: plain-text questions, do the work yourself', plain.includes('There is no AskUserQuestion tool') && plain.includes('plain-text') && plain.includes('There is no Task/subagent tool') && plain.includes('There is no MCP tool'));
  check('the tool list is the real one', plain.includes('- Tools: read_file, write_file, edit_file, list_files, grep_search, run_bash, use_skill.'));
  const full = harnessNotes([...base, 'run_subagent', 'ask_user']);
  check('with ask_user, AskUserQuestion maps onto it, with the unanswered rule', full.includes('`AskUserQuestion` is `ask_user`') && full.includes('`unanswered`') && !full.includes('There is no AskUserQuestion'));
  check('with run_subagent, Task maps onto it and a child is said to be unable to ask', full.includes('`Task` / subagent calls are `run_subagent`') && full.includes('cannot ask the user') && !full.includes('There is no Task'));
  check('the list names ask_user and run_subagent', full.includes('use_skill, run_subagent, ask_user.'));
  check('MCP tools are acknowledged when present', harnessNotes([...base, 'mcp__jira__createJiraIssue']).includes('available under their `mcp__` names') && harnessNotes([...base, 'mcp__jira__createJiraIssue']).includes('mcp__jira__createJiraIssue'));
  check('no tool list at all falls back to the base tools', harnessNotes([]).includes('read_file') && harnessNotes([]).includes('There is no AskUserQuestion tool'));

  const skills = mk();
  const reg = new SkillRegistry({ roots: [{ label: 't', dir: skills }], getToolNames: () => base });
  reg.load();
  const skill = reg.get('gate-skill')!;
  check('formatSkillForModel uses the given tools', formatSkillForModel(skill, reg, [...base, 'ask_user']).includes('`AskUserQuestion` is `ask_user`') && formatSkillForModel(skill, reg, base).includes('There is no AskUserQuestion'));
  check('...or the registry\'s own when none are given', formatSkillForModel(skill, reg).includes('There is no AskUserQuestion'));

  function mk() {
    const dir = fs.mkdtempSync(path.join(tmp, 'skills-'));
    fs.mkdirSync(path.join(dir, 'gate-skill'));
    fs.writeFileSync(path.join(dir, 'gate-skill', 'SKILL.md'), '---\nname: gate-skill\ndescription: a skill with a gate\n---\nAsk with AskUserQuestion at the gate.');
    return dir;
  }
}

console.log('\n=== subagents cannot ask ===');
{
  const skillsDir = fs.mkdtempSync(path.join(tmp, 'skills2-'));
  fs.mkdirSync(path.join(skillsDir, 'gate-skill'));
  fs.writeFileSync(path.join(skillsDir, 'gate-skill', 'SKILL.md'), '---\nname: gate-skill\ndescription: a skill with a gate\n---\nAsk with AskUserQuestion at the gate.');

  let asked = 0;
  const model = new FakeModel([
    { toolCalls: [{ name: 'use_skill', args: { name: 'gate-skill' }, id: 'p_skill' }] }, // parent loads the skill
    { toolCalls: [{ name: 'run_subagent', args: { task: 'run the gate', skill: 'gate-skill' }, id: 'p_sub' }] }, // parent delegates with it pre-loaded
    { toolCalls: [{ name: 'ask_user', args: { questions: [choiceQ('q1')] }, id: 'c_ask' }] }, // the child tries to ask
    { toolCalls: [{ name: 'use_skill', args: { name: 'gate-skill' }, id: 'c_skill' }] }, // the child loads the skill itself
    (req) => ({ content: `STATUS: blocked\nSUMMARY: asked and got: ${String(req.messages.filter((m) => m.role === 'tool').map((m) => m.content).slice(-2).join(' | ')).replace(/\s+/g, ' ').slice(0, 400)}\nQUESTIONS: which BRD?` }),
    (req) => ({ content: String(req.messages.filter((m) => m.role === 'tool').pop()?.content) }),
  ]);
  const session = createSession({
    workspace: tmp,
    config,
    client: model.client,
    skillRoots: [{ label: 't', dir: skillsDir }],
    permissionsDir: path.join(tmp, 'perm'),
    onAskUser: async () => {
      asked++;
      return [];
    },
  });
  const r = await session.run('go');

  const parentSkill = String(model.requests[1].messages.find((m) => m.role === 'tool' && String((m as any).tool_call_id) === 'p_skill')?.content);
  check('the parent loads the skill with ask_user mapped', parentSkill.includes('`AskUserQuestion` is `ask_user`'));
  check('the parent is offered ask_user and run_subagent; the child only has neither', model.requests[0].toolNames.includes('ask_user') && model.requests[0].toolNames.includes('run_subagent') && !model.requests[2].toolNames.includes('ask_user') && !model.requests[2].toolNames.includes('run_subagent'));
  const childFirst = String(model.requests[2].messages[1].content);
  check('the skill pre-loaded into the child says there is no way to ask the user', childFirst.includes('There is no AskUserQuestion tool') && !childFirst.includes('`AskUserQuestion` is `ask_user`') && childFirst.includes('There is no Task/subagent tool'), childFirst.slice(0, 300));
  check('if the child calls ask_user anyway it gets a clear error, and the user is not bothered', asked === 0 && model.requests[3].messages.some((m) => m.role === 'tool' && String(m.content).includes('Tool "ask_user" is not available inside a subagent')));
  const childSkill = String(model.requests[4].messages.find((m) => m.role === 'tool' && String((m as any).tool_call_id) === 'c_skill')?.content);
  check('a skill the child loads itself (use_skill) is described the same way', childSkill.includes('There is no AskUserQuestion tool') && !childSkill.includes('`AskUserQuestion` is `ask_user`'), childSkill.slice(0, 300));
  check('the run completed', r.status === 'completed');
}

console.log('\n=== the terminal front-end ===');
{
  const run = async (lines: string[], questions: UserQuestion[], opts: { signal?: AbortSignal; keepOpen?: boolean } = {}) => {
    const input = new PassThrough();
    let printed = '';
    const output = new Writable({ write: (chunk, _e, cb) => ((printed += chunk.toString()), cb()) });
    const pending = cliAskUser({ questions, signal: opts.signal }, { input, output });
    for (const l of lines) input.write(`${l}\n`); // all at once, as piped stdin delivers them
    if (!opts.keepOpen) input.end();
    return { answers: await pending, printed: stripAnsi(printed) };
  };
  const q = (extra: Partial<UserQuestion> & { id: string; kind: UserQuestion['kind'] }): UserQuestion => ({ prompt: `Pergunta ${extra.id}`, ...extra });
  const opts = [{ id: 'a', label: 'Alfa', detail: 'primeira', source: 'doc.pdf p. 2' }, { id: 'b', label: 'Beta' }];

  const r = await run(['2', 'Alfa', 'sim', 'Texto livre', 'd', 'Newton'], [
    q({ id: '1', kind: 'choice', options: opts }),
    q({ id: '2', kind: 'choice', options: opts }),
    q({ id: '3', kind: 'confirm' }),
    q({ id: '4', kind: 'text' }),
    q({ id: '5', kind: 'choice', options: opts, allowDefer: true }),
  ]);
  check('a number, an option name, sim, free text and a deferral (with its owner), all arriving at once', JSON.stringify(r.answers) === JSON.stringify([{ id: '1', answer: 'b' }, { id: '2', answer: 'a' }, { id: '3', answer: true }, { id: '4', answer: 'Texto livre' }, { id: '5', deferred: true, owner: 'Newton' }]), JSON.stringify(r.answers));
  check('options are shown with their detail and source', r.printed.includes('1) Alfa') && r.printed.includes('primeira') && r.printed.includes('source: doc.pdf p. 2') && r.printed.includes('2) Beta'));
  check('the header counts the questions, and defer is only offered where allowed', r.printed.includes('5 questions') && (r.printed.match(/d = defer/g) ?? []).length === 1);

  const skip = await run(['', '1', ''], [q({ id: '1', kind: 'confirm' }), q({ id: '2', kind: 'choice', options: opts }), q({ id: '3', kind: 'text' })]);
  check('Enter skips a question: it is simply not answered', JSON.stringify(skip.answers) === '[{"id":"2","answer":"a"}]', JSON.stringify(skip.answers));

  const retry = await run(['maybe', 'n', '9', 'zzz', '1'], [q({ id: '1', kind: 'confirm' }), q({ id: '2', kind: 'choice', options: opts })]);
  check('invalid input asks again, up to three times', JSON.stringify(retry.answers) === '[{"id":"1","answer":false},{"id":"2","answer":"a"}]' && retry.printed.includes('Please answer y or n.') && retry.printed.includes('Please choose a number from 1 to 2.'), JSON.stringify(retry.answers));
  const giveUp = await run(['x', 'y?', 'z?', 'sim'], [q({ id: '1', kind: 'confirm' }), q({ id: '2', kind: 'confirm' })]);
  check('after three misses the question is left open', JSON.stringify(giveUp.answers) === '[{"id":"2","answer":true}]', JSON.stringify(giveUp.answers));

  const other = await run(['Nenhuma delas'], [q({ id: '1', kind: 'choice', options: opts, allowOther: true })]);
  check('allowOther takes free text', other.answers[0]?.answer === 'Nenhuma delas' && other.printed.includes('or type your own'));
  const noOwner = await run(['d', ''], [q({ id: '1', kind: 'confirm', allowDefer: true })]);
  check('a deferral with no owner given is passed on without one', JSON.stringify(noOwner.answers) === '[{"id":"1","deferred":true}]', JSON.stringify(noOwner.answers));
  const notAllowed = await run(['d', 'sim'], [q({ id: '1', kind: 'confirm' })]);
  check('"d" is not a deferral when deferring is not allowed', notAllowed.answers.length === 0 || notAllowed.answers[0].deferred === undefined);

  const eof = await run(['1'], [q({ id: '1', kind: 'choice', options: opts }), q({ id: '2', kind: 'text' }), q({ id: '3', kind: 'confirm' })]);
  check('input that ends early leaves the rest open instead of hanging', JSON.stringify(eof.answers) === '[{"id":"1","answer":"a"}]');

  const c = new AbortController();
  setTimeout(() => c.abort(), 100);
  const t0 = Date.now();
  let name = '';
  try {
    await run([], [q({ id: '1', kind: 'text' })], { signal: c.signal, keepOpen: true });
  } catch (e: any) {
    name = e.name;
  }
  check('cancelling the run dismisses the prompt (AbortError, promptly)', name === 'AbortError' && Date.now() - t0 < 1000, `${name} ${Date.now() - t0}ms`);
  await sleep(10);
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll ask_user checks passed.');
