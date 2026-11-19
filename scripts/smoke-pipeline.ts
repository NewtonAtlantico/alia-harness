import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentEvent } from '../src/core/agent/events.js';
import { AliaConfig } from '../src/core/config.js';
import { createSession } from '../src/core/session.js';
import { ContextManager } from '../src/core/context/contextManager.js';
import {
  PipelineStateError,
  PipelineStateStore,
  STATE_FILE,
  STATE_MD_FILE,
  applyOps,
  gateProgress,
  newState,
  normalizeState,
  renderStateMd,
} from '../src/core/pipeline/pipelineState.js';
import { FIBONACCI_POINTS, parseTaskFile, summarizeTasks } from '../src/core/pipeline/taskStats.js';
import { createPipelineStateTool } from '../src/core/tools/pipelineState.js';
import { isToolErrorResult } from '../src/core/tools/types.js';
import { SafetyChecker } from '../src/core/safety/safetyChecker.js';
import { FakeModel, ScriptedTurn } from './lib/fakeModel.js';

let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.log(`  ✘ ${name} ${extra}`);
  }
}

const FIXTURES = path.resolve('scripts', 'fixtures', 'pipeline');
const UPDATE = process.env.UPDATE_GOLDEN === '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alia-pipeline-'));
let n = 0;
const mk = (label = 'ws') => {
  const dir = path.join(tmp, `${label}-${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
/** A workspace holding the golden task files. */
const withTasks = () => {
  const dir = mk();
  fs.cpSync(path.join(FIXTURES, 'docs'), path.join(dir, 'docs'), { recursive: true });
  return dir;
};
const NOW = new Date('2026-11-18T12:00:00.000Z');
const store = (ws: string) => new PipelineStateStore(ws, { now: () => NOW });
const ctxOf = (ws: string) => ({ workingDirectory: ws, safetyChecker: new SafetyChecker(true), contextManager: new ContextManager() });
const json = (v: unknown) => JSON.stringify(v);
const taskFile = (dir: string, name: string, content: string) => {
  fs.mkdirSync(path.join(dir, 'docs', 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs', 'tasks', name), content);
};
const task = (title: string, points: string, depends = 'none') => `### ${title}\n\n**Slice:** S\n**Story points:** ${points}\n**Depends on:** ${depends}\n\n`;

console.log('\n=== task counts: the golden backlog ===');
{
  const stats = summarizeTasks(FIXTURES);
  const golden = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'expected-task-stats.json'), 'utf8'));
  check('matches the golden file exactly', json(stats) === json(golden));
  check('4 specs, 11 tasks, 45 points, nothing wrong (the numbers worked out by hand)', stats.files.length === 4 && stats.taskCount === 11 && stats.points === 45 && stats.problems.length === 0);
  check('per spec: 11, 11, 10 and 13 points', stats.files.map((f) => f.points).join() === '11,11,10,13' && stats.files.map((f) => f.taskCount).join() === '3,3,3,2');
  check('files are read in name order', stats.files.map((f) => f.slug).join() === '01-login-sso,02-consultar-pedidos,03-abrir-chamado,04-acesso-parceiros');
  check('a "task" inside a code block is not counted (its 99 points would show)', !stats.files[0].tasks.some((t) => t.title.includes('código')) && stats.files[0].points === 11);
  const deps = Object.fromEntries(stats.files.flatMap((f) => f.tasks.map((t) => [t.id ?? t.title, t.dependsOn])));
  check('dependencies are kept as written, split on commas only', json(deps['3.3']) === json(['3.1', 'Formulário de chamado']) && json(deps['1.1']) === '[]');
  check('all of them resolve (ids, "T"-prefixed ids, titles, other files)', stats.files.every((f) => f.tasks.every((t) => t.unresolvedDependsOn.length === 0)));
  check('headings with ids in several styles keep their titles', stats.files[1].tasks[0].id === 'T2.1' && stats.files[1].tasks[0].title.startsWith('GET /v1/orders') && stats.files[2].tasks[2].title === 'E-mail de confirmação e notificação');
  check('"5 pts" reads as 5', stats.files[1].tasks[0].points === 5);
  check('a missing folder is an empty backlog, not an error', json(summarizeTasks(mk())) === json({ files: [], taskCount: 0, points: 0, problems: [] }));
}

console.log('\n=== task counts: problems are reported ===');
{
  const dir = mk();
  taskFile(dir, 'a-tasks.md', `# A\n\n${task('1.1 Ok', '3')}${task('1.2 Too big', '13')}${task('1.3 Off sequence', '4')}${task('1.4 No points', '')}${task('1.2 Duplicate id', '2', '9.9')}${task('Depends on a ghost', '1', 'Ghost task')}`);
  taskFile(dir, 'b-tasks.md', '# B\n\nnothing here\n');
  const s = summarizeTasks(dir);
  const has = (needle: string) => s.problems.some((p) => p.includes(needle));
  check('over 8 points, and the advice to split', has('"1.2 Too big" has 13 points') && has('split it'));
  check('off the Fibonacci sequence', has('"1.3 Off sequence" has 4 points') && s.problems.some((p) => p.includes(FIBONACCI_POINTS.join(', '))));
  check('missing points', has('"1.4 No points" has no story points'));
  check('a duplicate id', has('the task id 1.2 is used more than once'));
  check('a dependency on something that is not a task', has('depends on "9.9", which is not a task') && has('depends on "Ghost task"'));
  check('a file with no tasks', has('b-tasks.md: has no tasks'));
  check('totals ignore the missing points but count the rest', s.taskCount === 6 && s.points === 3 + 13 + 4 + 2 + 1);
  check('unresolved references are listed on the task itself', s.files[0].tasks[5].unresolvedDependsOn.join() === 'Ghost task');

  const cyc = mk();
  taskFile(cyc, 'c-tasks.md', `${task('1.1 First', '2', '1.3')}${task('1.2 Second', '2', '1.1')}${task('1.3 Third', '2', '1.2')}`);
  check('a dependency cycle is named', summarizeTasks(cyc).problems.some((p) => p.startsWith('dependency cycle:') && p.includes('1.1')));
  const acyclic = mk();
  taskFile(acyclic, 'd-tasks.md', `${task('1.1 First', '2')}${task('1.2 Second', '2', '1.1')}${task('1.3 Third', '2', '1.1, 1.2')}`);
  check('a diamond is not a cycle', summarizeTasks(acyclic).problems.length === 0);

  const none = parseTaskFile(`${task('1.1 A', '2', 'Nenhuma')}${task('1.2 B', '2', '—')}${task('1.3 C', '2', '--')}`);
  check('"none" in any of its spellings means no dependency', none.tasks.every((t) => t.dependsOn.length === 0));
  const crlf = parseTaskFile(`### 1.1 A\r\n\r\n**Story points:** 3\r\n**Depends on:** none\r\n`);
  check('Windows line endings are fine', crlf.tasks.length === 1 && crlf.tasks[0].points === 3);
  const heading = parseTaskFile('### 2FA setup\n**Story points:** 2\n\n### Task 4: Colon style\n**Story points:** 1\n\n### 7 No separator\n**Story points:** 1\n');
  check('a title that merely starts with a digit is not mistaken for an id', heading.tasks[0].id === undefined && heading.tasks[0].title === '2FA setup' && heading.tasks[1].id === '4' && heading.tasks[2].id === '7');
  const outside = parseTaskFile('# T\n\nSome intro **Story points:** 99\n\n## Notes\n\n### 1.1 A\n**Story points:** 3\n\n## Appendix\n**Story points:** 50\n');
  check('fields outside a task are ignored', outside.tasks.length === 1 && outside.tasks[0].points === 3);
}

console.log('\n=== the state: creating it and enforcing the rules ===');
{
  const ws = mk();
  const st = store(ws);
  check('there is no state to begin with', !st.exists() && st.load() === undefined);

  const first = st.apply([{ op: 'set_project', name: 'Portal do cliente' }]);
  check('the first update creates the state, with the four stages and three gates', first.ok && st.exists() && first.state.stages.map((s) => s.skill).join() === 'requirement-extraction-from-documents,architecture-from-requirements,constitution-to-specs,spec-to-tasks' && first.state.gates.map((g) => g.id).join() === 'G1,G2,G3');
  check('both files are written, and nothing temporary is left behind', fs.existsSync(path.join(ws, STATE_FILE)) && fs.existsSync(path.join(ws, STATE_MD_FILE)) && fs.readdirSync(path.join(ws, 'docs', 'pipeline')).every((f) => !f.endsWith('.tmp')));
  check('the state round-trips through disk unchanged (same content, same layout)', json(st.load()) === json(first.ok && first.state));
  const bytes = fs.readFileSync(path.join(ws, STATE_FILE), 'utf8');
  st.write(st.load()!);
  check('writing it again changes nothing, byte for byte (no reshuffling in a committed file)', fs.readFileSync(path.join(ws, STATE_FILE), 'utf8') === bytes);
  // A state built by hand, with its keys in another order (project last), is still written in the canonical layout.
  const shuffled = applyOps(newState(NOW), [{ op: 'set_project', name: 'Portal do cliente' }], { now: NOW });
  st.write(shuffled.ok ? shuffled.state : newState(NOW));
  check('a state written with its keys in another order still has the canonical layout', Object.keys(JSON.parse(fs.readFileSync(path.join(ws, STATE_FILE), 'utf8'))).slice(0, 3).join() === 'version,updatedAt,project' && fs.readFileSync(path.join(ws, STATE_FILE), 'utf8') === bytes);
  check('the clock is injectable (updatedAt)', st.load()!.updatedAt === NOW.toISOString());

  const fail = (ops: unknown) => {
    const before = fs.readFileSync(path.join(ws, STATE_FILE), 'utf8');
    const r = st.apply(ops);
    const after = fs.readFileSync(path.join(ws, STATE_FILE), 'utf8');
    return { error: r.ok ? '' : r.error, untouched: before === after };
  };

  let r = fail([{ op: 'nope' }]);
  check('an unknown operation lists the known ones', r.error.includes('unknown operation') && r.error.includes('add_question') && r.untouched);
  r = fail([]);
  check('an empty list is an error', r.error.includes('non-empty list'));
  r = fail([{ op: 'set_stage', stage: 1, status: 'running' }, { op: 'set_stage', stage: 9, status: 'done' }]);
  check('all or nothing: the second invalid operation undoes the first (and says which one it was)', r.error.startsWith('ops[1] (set_stage)') && r.error.includes('Nothing was changed') && r.untouched && st.load()!.stages[0].status === 'pending');
  r = fail([{ op: 'set_stage', stage: 2, status: 'running' }]);
  check('stage 2 cannot start before stage 1 is done', r.error.includes('stage 1 is pending, not done'), r.error);
  check('stage forms: a number, a digit string and a name', st.apply([{ op: 'set_stage', stage: 'requirements', status: 'running' }]).ok && st.apply([{ op: 'set_stage', stage: '1', status: 'done', artifact: 'docs/requirements/requirements.md' }]).ok);
  r = fail([{ op: 'set_stage', stage: 2, status: 'running' }]);
  check('stage 2 cannot start while gate G1 has not passed', r.error.includes('gate G1 has not passed'), r.error);
  r = fail([{ op: 'set_stage', stage: 1, status: 'blocked' }]);
  check('a blocked stage needs its reason', r.error.includes('needs a "reason"'));
  check('a stage records when it was finished', st.load()!.stages[0].completedAt === NOW.toISOString());

  const q = (id: string, extra: object = {}) => ({ op: 'add_question', gate: 'G1', id, prompt: `Pergunta ${id}`, ...extra });
  r = fail([q('q1', { kind: 'choice', options: [{ id: 'a', label: 'A' }] })]);
  check('a choice needs two options', r.error.includes('at least two'));
  r = fail([q('q1', { kind: 'weird' })]);
  check('question kind is checked', r.error.includes('"kind" must be one of'));
  r = fail([q('q1', { gate: 'G9' })]);
  check('gate is checked', r.error.includes('"gate" must be G1, G2 or G3'));

  const okQ = st.apply([
    q('q1', { kind: 'choice', category: 'contradiction', source: 'BRD v2 p. 14', options: [{ id: 'sso', label: 'SSO desde o início', source: 'BRD p. 14' }, { id: 'mail', label: 'E-mail na fase 1' }] }),
    q('q2'),
    q('q3', { kind: 'confirm', confidence: 'low' }),
  ]);
  check('questions are added to the gate, which opens', okQ.ok && gateProgress(okQ.state, 'G1').total === 3 && gateProgress(okQ.state, 'G1').open === 3 && gateProgress(okQ.state, 'G1').status === 'open');
  r = fail([{ op: 'set_gate', gate: 'G1', status: 'passed' }]);
  check('a gate cannot pass while questions are open, and the error names them', r.error.includes('3 questions are still open') && r.error.includes('q1, q2, q3'), r.error);
  r = fail([{ op: 'add_question', gate: 'G2', id: 'q1', prompt: 'same id elsewhere' }]);
  check('a question id is unique across gates', r.error.includes('already exists in gate G1'));

  check('answering a choice with an option id stores its label', (() => {
    const a = st.apply([{ op: 'answer_question', id: 'q1', answer: 'sso', by: 'Newton' }]);
    const qq = a.ok ? a.state.gates[0].questions[0] : undefined;
    return !!qq && qq.status === 'answered' && qq.answer === 'sso' && qq.answerLabel === 'SSO desde o início' && qq.by === 'Newton' && qq.date === '2026-11-18';
  })());
  check('free text is kept as it is; a boolean becomes yes/no', (() => {
    const a = st.apply([{ op: 'answer_question', id: 'q2', answer: 'Sim, a partir da fase 2' }, { op: 'answer_question', id: 'q3', answer: false }]);
    const qs = a.ok ? a.state.gates[0].questions : [];
    return qs[1]?.answer === 'Sim, a partir da fase 2' && qs[2]?.answer === 'no';
  })());
  r = fail([{ op: 'answer_question', id: 'zzz', answer: 'x' }]);
  check('answering a question that does not exist', r.error.includes('there is no question "zzz"'));
  r = fail([{ op: 'answer_question', id: 'q1' }]);
  check('an answer is required', r.error.includes('"answer" is required'));
  r = fail([q('q1')]);
  check('an answered question cannot be silently re-added', r.error.includes('already exists and is answered') && r.error.includes('reopen_question'));

  r = fail([{ op: 'defer_question', id: 'q3' }]);
  check('deferring needs an owner (a deferral is an assumption, and an assumption has an owner)', r.error.includes('"owner" is required'), r.error);
  const deferred = st.apply([{ op: 'defer_question', id: 'q3', owner: 'Newton', assumption: 'Integração com o ERP fica fora do MVP' }]);
  check('a deferred question becomes an assumption with its owner and stage', deferred.ok && deferred.state.assumptions.length === 1 && deferred.state.assumptions[0].text === 'Integração com o ERP fica fora do MVP' && deferred.state.assumptions[0].owner === 'Newton' && deferred.state.assumptions[0].stage === 1 && deferred.state.assumptions[0].questionId === 'q3');
  check('...with a default wording when none is given', (() => {
    const a = st.apply([q('q4'), { op: 'defer_question', id: 'q4', owner: 'Ana' }]);
    return a.ok && a.state.assumptions.some((x) => x.text === 'Not yet decided: Pergunta q4' && x.owner === 'Ana');
  })());
  const reopened = st.apply([{ op: 'reopen_question', id: 'q4' }]);
  check('reopening a question drops its assumption and reopens the gate', reopened.ok && !reopened.state.assumptions.some((a) => a.questionId === 'q4') && gateProgress(reopened.state, 'G1').open === 1);
  const answeredLater = st.apply([{ op: 'answer_question', id: 'q3', answer: 'yes' }]);
  check('answering a deferred question removes the assumption', answeredLater.ok && answeredLater.state.assumptions.every((a) => a.questionId !== 'q3'));
  st.apply([{ op: 'defer_question', id: 'q3', owner: 'Newton', assumption: 'Integração com o ERP fica fora do MVP' }, { op: 'defer_question', id: 'q4', owner: 'Ana' }]);

  const passed = st.apply([{ op: 'set_gate', gate: 'g1', status: 'passed' }]);
  check('with everything answered or deferred the gate passes (gate ids are case-insensitive)', passed.ok && gateProgress(passed.state, 'G1').status === 'passed' && gateProgress(passed.state, 'G1').deferred === 2);
  const g2 = st.apply([{ op: 'set_stage', stage: 2, status: 'running' }]);
  check('...and stage 2 can start', g2.ok && g2.state.stages[1].status === 'running');
  const late = st.apply([q('q9')]);
  check('a new question reopens a gate that had passed', late.ok && gateProgress(late.state, 'G1').status === 'open');
  r = fail([{ op: 'set_stage', stage: 2, status: 'done' }]);
  check('...so stage 2 cannot be finished until it is resolved again', r.error.includes('gate G1 has not passed'), r.error);
  st.apply([{ op: 'answer_question', id: 'q9', answer: 'ok' }, { op: 'set_gate', gate: 'G1', status: 'passed' }]);

  r = fail([{ op: 'set_stage', stage: 3, status: 'running' }]);
  check('stage 3 cannot start while stage 2 is not done', r.error.includes('stage 2 is running, not done'));
  st.apply([{ op: 'set_stage', stage: 2, status: 'done' }, { op: 'set_gate', gate: 'G2', status: 'passed' }, { op: 'set_stage', stage: 3, status: 'running' }, { op: 'set_stage', stage: 3, status: 'done' }]);

  // Spec review gates gate 3.
  const reviews = st.apply([{ op: 'set_spec_review', spec: 'login-sso', status: 'reviewed', by: 'Newton' }, { op: 'set_spec_review', spec: 'abrir-chamado', status: 'in_review' }]);
  check('spec reviews are recorded', reviews.ok && reviews.state.specReviews.length === 2 && reviews.state.specReviews[0].date === '2026-11-18');
  r = fail([{ op: 'set_gate', gate: 'G3', status: 'passed' }]);
  check('gate G3 cannot pass while a spec is not reviewed (and names it)', r.error.includes('abrir-chamado') && r.error.includes('not reviewed'), r.error);
  const g3 = st.apply([{ op: 'set_spec_review', spec: 'abrir-chamado', status: 'reviewed', by: 'Newton' }, { op: 'set_gate', gate: 'G3', status: 'passed' }]);
  check('once they are all reviewed it passes', g3.ok && gateProgress(g3.state, 'G3').status === 'passed');
  const un = st.apply([{ op: 'set_spec_review', spec: 'login-sso', status: 'in_review' }]);
  check('taking a spec back into review reopens the gate', un.ok && gateProgress(un.state, 'G3').status === 'open');
  st.apply([{ op: 'set_spec_review', spec: 'login-sso', status: 'reviewed' }, { op: 'set_gate', gate: 'G3', status: 'passed' }, { op: 'set_stage', stage: 4, status: 'running' }, { op: 'set_stage', stage: 4, status: 'done', artifact: 'docs/tasks/' }]);
  check('stage 4 ran after gate 3', st.load()!.stages[3].status === 'done');

  // An upstream change makes later stages stale.
  r = fail([{ op: 'mark_stale', after_stage: 4, reason: 'x' }]);
  check('mark_stale is for stages 1-3', r.error.includes('"after_stage" must be 1, 2 or 3'));
  r = fail([{ op: 'mark_stale', after_stage: 1 }]);
  check('mark_stale needs its reason', r.error.includes('"reason" is required'));
  const stale = st.apply([{ op: 'mark_stale', after_stage: 1, reason: 'requirements changed after the gate-1 answers' }]);
  check('stages after the change become stale, with the reason; their gates must pass again', stale.ok && stale.state.stages.slice(1).every((s) => s.status === 'stale' && s.staleReason === 'requirements changed after the gate-1 answers') && stale.state.stages[0].status === 'done' && gateProgress(stale.state, 'G2').status === 'pending' && gateProgress(stale.state, 'G3').status === 'pending' && gateProgress(stale.state, 'G1').status === 'passed');
  check('...and rendered as stale in STATE.md', fs.readFileSync(path.join(ws, STATE_MD_FILE), 'utf8').includes('stale: requirements changed after the gate-1 answers'));
  check('a stale stage can be redone', st.apply([{ op: 'set_stage', stage: 2, status: 'running' }]).ok);
}

console.log('\n=== applyOps never touches the state it was given ===');
{
  const s0 = newState(NOW);
  const before = json(s0);
  const bad = applyOps(s0, [{ op: 'set_stage', stage: 1, status: 'running' }, { op: 'add_question', gate: 'G1', id: 'q1', prompt: 'x' }, { op: 'bogus' }], { now: NOW });
  check('a failing batch leaves the input state exactly as it was', !bad.ok && json(s0) === before);
  const good = applyOps(s0, [{ op: 'set_stage', stage: 1, status: 'running' }], { now: NOW });
  check('a successful batch returns a new state and leaves the input alone', good.ok && good.state.stages[0].status === 'running' && s0.stages[0].status === 'pending' && json(s0) === before);
}

console.log('\n=== the state: inputs, assumptions, decisions, ADRs ===');
{
  const ws = mk();
  const st = store(ws);
  const file = path.join(ws, 'docs', 'BRD.pdf');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'brd contents v2');
  const added = st.apply([
    { op: 'add_input', name: 'BRD.pdf', version: 'v2', input_kind: 'document', path: 'docs/BRD.pdf', handled_by: 'requirement-extraction-from-documents' },
    { op: 'add_input', name: 'kickoff.txt', input_kind: 'transcript' },
    { op: 'add_input', name: 'ghost.pdf', path: 'docs/ghost.pdf' },
  ]);
  const inputs = added.ok ? added.state.inputs : [];
  check('an input records what it contained when inventoried (to notice later changes)', inputs[0].hash === crypto.createHash('sha256').update('brd contents v2').digest('hex') && inputs[0].size === 15 && inputs[0].version === 'v2' && inputs[0].handledBy === 'requirement-extraction-from-documents');
  check('an input without a readable file has no hash, and kind defaults to document', inputs[1].hash === undefined && inputs[2].hash === undefined && inputs[2].kind === 'document');
  const again = st.apply([{ op: 'add_input', name: 'brd.PDF', version: 'v3', path: 'docs/BRD.pdf' }]);
  check('adding an input again updates it (names compare without case)', again.ok && again.state.inputs.length === 3 && again.state.inputs[0].version === 'v3');
  check('input kind is checked', !st.apply([{ op: 'add_input', name: 'x', input_kind: 'video' }]).ok);

  const more = st.apply([
    { op: 'add_assumption', text: 'Dono dos logs a definir', owner: 'Newton', stage: 'architecture' },
    { op: 'add_assumption', text: 'Dono dos logs a definir', owner: 'Newton' },
    { op: 'add_decision', question: 'Quem é dono das gravações?', answer: 'O CRM continua dono', by: 'Newton', stage: 2, adr: 'ADR-0009' },
    { op: 'add_adr', id: 'ADR-0007', title: 'Monólito modular' },
    { op: 'add_adr', id: 'ADR-0007', title: 'Monólito modular', status: 'Accepted', path: 'adr/0007.md' },
    { op: 'add_note', text: 'Primeira sessão\ncom quebra de linha' },
  ]);
  check('an assumption is not duplicated, and its stage can be given by name', more.ok && more.state.assumptions.length === 1 && more.state.assumptions[0].stage === 2);
  check('decisions are dated; ADRs update in place and default to Proposed', more.ok && more.state.decisions[0].date === '2026-11-18' && more.state.adrs.length === 1 && more.state.adrs[0].status === 'Accepted');
  check('an assumption needs an owner', !st.apply([{ op: 'add_assumption', text: 'x' }]).ok && (st.apply([{ op: 'add_assumption', text: 'x' }]) as any).error.includes('owner'));
  check('an ADR needs an id and a title', !st.apply([{ op: 'add_adr', id: 'ADR-1' }]).ok);
}

console.log('\n=== STATE.md: generated, deterministic, golden ===');
{
  const ws = withTasks();
  const st = store(ws);
  const q = (gate: string, id: string, prompt: string, extra: object = {}) => ({ op: 'add_question', gate, id, prompt, ...extra });
  const batches: unknown[][] = [
    [{ op: 'set_project', name: 'Portal do cliente' },
     { op: 'add_input', name: 'BRD_PortalCliente_v2.pdf', version: 'v2', input_kind: 'document', handled_by: 'requirement-extraction-from-documents' },
     { op: 'add_input', name: 'kickoff-transcricao.txt', input_kind: 'transcript', handled_by: 'requirement-extraction-from-threads' },
     { op: 'add_input', name: 'pedido-diretoria.txt', input_kind: 'brief', handled_by: 'ticket-to-brief' },
     { op: 'add_input', name: 'reuniao-kickoff.mp4', input_kind: 'recording', notes: 'Gravações não podem ser lidas. Envie a transcrição.' },
     { op: 'set_stage', stage: 1, status: 'running' }],
    [q('G1', 'q1', 'Qual versão do BRD é a oficial?', { kind: 'choice', options: [{ id: 'v1', label: 'v1' }, { id: 'v2', label: 'v2' }], source: 'BRD_PortalCliente_v2.pdf' }),
     q('G1', 'q2', 'Parceiros externos usam o portal?'),
     q('G1', 'q3', 'Integração com o ERP entra no MVP?', { kind: 'confirm' }),
     q('G1', 'q4', 'O BRD v2 (p. 14) exige SSO | o kickoff (12:40) fala em login por e-mail. Qual vale?', { kind: 'choice', category: 'contradiction', options: [{ id: 'sso', label: 'SSO corporativo desde o início', source: 'BRD v2 p. 14' }, { id: 'mail', label: 'Login por e-mail na fase 1', source: 'kickoff 12:40' }] }),
     q('G1', 'q5', 'Quantos usuários simultâneos o portal deve suportar?', { category: 'low_confidence', confidence: 'low' })],
    [{ op: 'answer_question', id: 'q1', answer: 'v2', by: 'Newton' },
     { op: 'answer_question', id: 'q2', answer: 'Sim, a partir da fase 2', by: 'Newton' },
     { op: 'defer_question', id: 'q3', owner: 'Newton', assumption: 'Integração com o ERP fica fora do MVP' },
     { op: 'answer_question', id: 'q4', answer: 'sso', by: 'Newton' },
     { op: 'defer_question', id: 'q5', owner: 'Newton', assumption: 'Volume de usuários simultâneos a confirmar com o cliente' },
     { op: 'set_gate', gate: 'G1', status: 'passed' },
     { op: 'set_stage', stage: 1, status: 'done', artifact: 'docs/requirements/requirements.md' },
     { op: 'set_stage', stage: 2, status: 'running' },
     { op: 'add_adr', id: 'ADR-0007', title: 'Estilo: monólito modular' },
     { op: 'add_adr', id: 'ADR-0008', title: 'Autenticação via SSO corporativo (OIDC)' },
     q('G2', 'q6', 'A proposta grava dados de cliente no portal, mas o ADR-0003 diz que o CRM é dono. Quem é dono das gravações?', { kind: 'choice', category: 'blocker', options: [{ id: 'portal', label: 'O portal é dono e publica eventos para o CRM' }, { id: 'acl', label: 'O CRM continua dono; o portal usa uma camada anticorrupção' }] })],
    [{ op: 'answer_question', id: 'q6', answer: 'acl', by: 'Newton' },
     { op: 'add_adr', id: 'ADR-0009', title: 'Camada anticorrupção para o CRM' },
     { op: 'add_assumption', text: 'Dono dos logs e traces do portal a definir', owner: 'Newton', stage: 2 },
     { op: 'set_gate', gate: 'G2', status: 'passed' },
     { op: 'set_stage', stage: 2, status: 'done', artifact: 'docs/architecture/architecture.md' },
     { op: 'set_stage', stage: 3, status: 'running' },
     { op: 'set_stage', stage: 3, status: 'done', artifact: 'docs/specs/INDEX.md' },
     { op: 'set_spec_review', spec: 'login-sso', status: 'reviewed', by: 'Newton' },
     { op: 'set_spec_review', spec: 'consultar-pedidos', status: 'reviewed', by: 'Newton' },
     { op: 'set_spec_review', spec: 'abrir-chamado', status: 'reviewed', by: 'Newton' },
     { op: 'set_spec_review', spec: 'acesso-parceiros', status: 'reviewed', by: 'Newton' },
     { op: 'set_gate', gate: 'G3', status: 'passed' },
     { op: 'set_stage', stage: 4, status: 'running' },
     { op: 'set_stage', stage: 4, status: 'done', artifact: 'docs/tasks/' },
     { op: 'add_note', text: 'Pipeline concluído em uma única conversa.' }],
  ];
  let allOk = true;
  for (const [i, ops] of batches.entries()) {
    const r = st.apply(ops);
    if (!r.ok) {
      allOk = false;
      console.log(`    batch ${i} failed: ${r.error}`);
    }
  }
  check('the whole design scenario (inputs, 3 gates, deferrals, ADRs, 4 spec reviews, 4 stages) applies', allOk);

  const md = fs.readFileSync(path.join(ws, STATE_MD_FILE), 'utf8');
  const goldenFile = path.join(FIXTURES, 'expected-STATE.md');
  if (UPDATE) fs.writeFileSync(goldenFile, md);
  // (A git checkout with autocrlf may give the golden file CRLF line endings; the content is what matters.)
  check('STATE.md equals the golden file', md === fs.readFileSync(goldenFile, 'utf8').replace(/\r\n/g, '\n'), 'run with UPDATE_GOLDEN=1 to regenerate, then review the diff');
  check('it is pure: rendering the same state again gives the same text', renderStateMd(st.load()!, st.tasks()) === md && st.render(st.load()!) === md);
  check('the stage-4 row carries the counts computed from the task files', md.includes('docs/tasks/ (11 tasks, 45 points)'));
  check('gate cells show the progress, with deferrals', md.includes('G1: passed (5 of 5 answered, 2 deferred)') && md.includes('G3: passed'));
  check('a pipe inside a question does not break the table', md.includes('exige SSO \\| o kickoff'));
  check('answered choices show their label, deferrals appear as assumptions', md.includes('| Qual versão do BRD é a oficial? | v2 | Newton |') && md.includes('| Integração com o ERP fica fora do MVP | Newton | 1 |'));
  check('STATE.md says it is generated', md.includes('Generated from `docs/pipeline/state.json`'));

  const opened = applyOps(newState(NOW), [{ op: 'add_question', gate: 'G1', id: 'q1', prompt: 'Aberta?', source: 'doc p. 3' }], { now: NOW });
  const partial = renderStateMd(opened.ok ? opened.state : newState(NOW));
  check('open questions get a section of their own', partial.includes('## Open questions') && partial.includes('| G1 | q1 | Aberta? | doc p. 3 |') && partial.includes('G1: open (0 of 1 answered)'));
  check('an empty state still renders', renderStateMd(newState(NOW)).includes('_none recorded_'));

  // Task problems surface in STATE.md.
  const bad = withTasks();
  taskFile(bad, '05-ruim-tasks.md', task('5.1 Grande demais', '13'));
  store(bad).apply([{ op: 'set_project', name: 'p' }]);
  check('backlog problems are listed in STATE.md', fs.readFileSync(path.join(bad, STATE_MD_FILE), 'utf8').includes('## Backlog problems') && fs.readFileSync(path.join(bad, STATE_MD_FILE), 'utf8').includes('13 points'));
}

console.log('\n=== structured summaries: architecture, ADR alignment, specs (A13) ===');
{
  const ok = (ops: unknown[], from = newState(NOW)) => {
    const r = applyOps(from, ops, { now: NOW });
    return r.ok ? r.state : undefined;
  };
  const err = (ops: unknown[], from = newState(NOW)) => {
    const r = applyOps(from, ops, { now: NOW });
    return r.ok ? '' : r.error;
  };

  const arch = ok([{ op: 'set_architecture', style: 'Monólito modular', driver: 'Time pequeno e prazo curto', contexts: ['Acesso', { name: 'Pedidos', role: 'Consulta e histórico' }, 'Acesso'], recommendation: 'approve_with_notes', notes: 'Rever o dono dos logs' }]);
  check('set_architecture records style, driver, contexts (names or objects, without duplicates) and the recommendation', arch?.architecture?.style === 'Monólito modular' && json(arch.architecture.contexts) === json([{ name: 'Acesso' }, { name: 'Pedidos', role: 'Consulta e histórico' }]) && arch.architecture.recommendation === 'approve_with_notes' && arch.architecture.driver === 'Time pequeno e prazo curto');
  check('...and recording it again replaces it', ok([{ op: 'set_architecture', style: 'Microsserviços' }], arch!)?.architecture?.contexts.length === 0);
  check('style is required; a recommendation must be a known one; contexts must be a list', err([{ op: 'set_architecture' }]).includes('"style" is required') && err([{ op: 'set_architecture', style: 'x', recommendation: 'maybe' }]).includes('"recommendation" must be one of') && err([{ op: 'set_architecture', style: 'x', contexts: 'a' }]).includes('"contexts" must be a list') && err([{ op: 'set_architecture', style: 'x', contexts: [{ role: 'r' }] }]).includes('needs a "name"'));

  const align = ok([{ op: 'set_adr_alignment', adr: 'ADR-0001', alignment: 'aligned' }, { op: 'set_adr_alignment', adr: 'ADR-0003', alignment: 'misaligned', note: 'O CRM é dono das gravações' }, { op: 'set_adr_alignment', adr: 'ADR-0001', alignment: 'aligned', note: 'ok' }]);
  check('set_adr_alignment records each ADR once (a repeat replaces it)', align?.adrAlignment.length === 2 && align.adrAlignment[0].note === 'ok' && align.adrAlignment[1].status === 'misaligned');
  check('a misaligned ADR needs a note, and the alignment must be known', err([{ op: 'set_adr_alignment', adr: 'ADR-3', alignment: 'misaligned' }]).includes('needs a "note"') && err([{ op: 'set_adr_alignment', adr: 'ADR-3', alignment: 'so-so' }]).includes('"alignment" must be one of') && err([{ op: 'set_adr_alignment', alignment: 'aligned' }]).includes('"adr" is required'));

  const specs = ok([
    { op: 'set_spec', slug: 'login-sso', title: 'Login com SSO', persona: 'Cliente corporativo', constraints: ['LGPD', 'WCAG AA'] },
    { op: 'set_spec', slug: 'consultar-pedidos', title: 'Consultar pedidos', persona: 'Cliente', depends_on: 'login-sso, , login-sso' },
    { op: 'set_spec', slug: 'abrir-chamado', title: 'Abrir chamado', depends_on: ['login-sso', 'consultar-pedidos'] },
  ]);
  check('set_spec records slug, title, persona, dependencies (list or comma-separated, without blanks or repeats) and constraints', specs?.specs.length === 3 && json(specs.specs[1].dependsOn) === json(['login-sso']) && json(specs.specs[0].constraints) === json(['LGPD', 'WCAG AA']) && specs.specs[0].persona === 'Cliente corporativo' && json(specs.specs[2].dependsOn) === json(['login-sso', 'consultar-pedidos']));
  check('every recorded spec starts as a draft review, so gate 3 cannot skip it', json(specs?.specReviews.map((r) => [r.spec, r.status])) === json([['login-sso', 'draft'], ['consultar-pedidos', 'draft'], ['abrir-chamado', 'draft']]));
  const cannot = err([{ op: 'set_gate', gate: 'G3', status: 'passed' }], specs!);
  check('...and gate G3 refuses until all are reviewed', cannot.includes('not reviewed yet') && cannot.includes('login-sso'), cannot);
  const reviewed = ok(['login-sso', 'consultar-pedidos', 'abrir-chamado'].map((spec) => ({ op: 'set_spec_review', spec, status: 'reviewed', by: 'Newton' })).concat([{ op: 'set_gate', gate: 'G3', status: 'passed' } as any]), specs!);
  check('once they are reviewed the gate passes', reviewed?.gates[2].status === 'passed');
  const added = ok([{ op: 'set_spec', slug: 'novo', title: 'Novo' }], reviewed!);
  check('a spec added after the gate passed reopens it', added?.gates[2].status === 'open' && added.specReviews.at(-1)?.status === 'draft');
  const edited = ok([{ op: 'set_spec', slug: 'login-sso', title: 'Login com SSO (v2)' }], reviewed!);
  check('editing a spec that was already reviewed does not undo its review', edited?.gates[2].status === 'passed' && edited.specReviews.find((r) => r.spec === 'login-sso')?.status === 'reviewed' && edited.specs[0].title === 'Login com SSO (v2)');
  check('a spec needs a plain slug and a title, cannot depend on itself, and dependencies must be a list', err([{ op: 'set_spec', title: 'x' }]).includes('"slug" is required') && err([{ op: 'set_spec', slug: 'a b', title: 'x' }]).includes('"slug" is required') && err([{ op: 'set_spec', slug: 'a' }]).includes('"title" is required') && err([{ op: 'set_spec', slug: 'a', title: 'x', depends_on: ['a'] }]).includes('cannot depend on itself') && err([{ op: 'set_spec', slug: 'a', title: 'x', depends_on: 5 }]).includes('"depends_on" must be a list') && err([{ op: 'set_spec', slug: 'a', title: 'x', constraints: [1] }]).includes('"constraints" must be a list'));
  check('a batch with one bad summary changes nothing (all or nothing)', err([{ op: 'set_architecture', style: 'x' }, { op: 'set_spec', slug: 'a' }]).includes('Nothing was changed'));

  // Round trip through the store and the tool; states without summaries keep working.
  const ws = mk();
  const st = store(ws);
  st.apply([{ op: 'set_project', name: 'Portal do cliente' }]);
  check('a state without summaries renders no summary sections', !fs.readFileSync(path.join(ws, STATE_MD_FILE), 'utf8').match(/## (Architecture|ADR alignment|Specs)\n/));
  fs.writeFileSync(path.join(ws, STATE_FILE), JSON.stringify({ version: 1, project: 'old' }));
  const old = st.load()!;
  check('an older state.json (no summaries) loads with empty ones', old.architecture === undefined && old.adrAlignment.length === 0 && old.specs.length === 0);

  const tool = createPipelineStateTool();
  const ws2 = mk();
  const call = (args: object) => tool.execute(args as any, ctxOf(ws2) as any);
  const r = JSON.parse(await call({ action: 'update', ops: [{ op: 'set_architecture', style: 'Monólito modular', contexts: ['Acesso'] }, { op: 'set_adr_alignment', adr: 'ADR-0001', alignment: 'aligned' }, { op: 'set_spec', slug: 'login-sso', title: 'Login', depends_on: [] }] }));
  check('through the tool: update accepts them', r.ok === true && r.applied === 3);
  const g = JSON.parse(await call({ action: 'get' }));
  check('get returns them', g.architecture.style === 'Monólito modular' && g.adrAlignment[0].adr === 'ADR-0001' && g.specs[0].slug === 'login-sso' && g.specReviews[0].status === 'draft');
  check('the tool lists the new operations for the model', /set_architecture/.test(tool.description) && /set_adr_alignment/.test(tool.description) && /set_spec\b/.test(tool.description));

  // Golden: the rendered sections.
  const gws = mk();
  const gst = store(gws);
  gst.apply([
    { op: 'set_project', name: 'Portal do cliente' },
    { op: 'set_architecture', style: 'Monólito modular', driver: 'Time pequeno e prazo curto', contexts: [{ name: 'Acesso', role: 'Login e perfis' }, { name: 'Pedidos | histórico', role: 'Consulta' }], recommendation: 'approve_with_notes', notes: 'Definir o dono dos logs' },
    { op: 'set_adr_alignment', adr: 'ADR-0001', alignment: 'aligned' },
    { op: 'set_adr_alignment', adr: 'ADR-0003', alignment: 'misaligned', note: 'O CRM é dono das gravações de cliente' },
    { op: 'set_spec', slug: 'login-sso', title: 'Login com SSO', persona: 'Cliente corporativo', constraints: ['LGPD', 'WCAG AA'] },
    { op: 'set_spec', slug: 'consultar-pedidos', title: 'Consultar pedidos', persona: 'Cliente', depends_on: ['login-sso'] },
    { op: 'set_spec_review', spec: 'login-sso', status: 'reviewed', by: 'Newton' },
  ]);
  const gmd = fs.readFileSync(path.join(gws, STATE_MD_FILE), 'utf8');
  const gfile = path.join(FIXTURES, 'expected-STATE-structured.md');
  if (UPDATE) fs.writeFileSync(gfile, gmd);
  check('STATE.md with summaries equals its golden file', gmd === fs.readFileSync(gfile, 'utf8').replace(/\r\n/g, '\n'), 'run with UPDATE_GOLDEN=1 to regenerate, then review the diff');
  check('the golden shows the recommendation, the misaligned ADR and a spec that waits for review', gmd.includes('**Review recommendation:** approve with notes') && gmd.includes('| ADR-0003 | misaligned |') && gmd.includes('| consultar-pedidos | draft |'));
}

console.log('\n=== loading is strict about damage, tolerant about gaps ===');
{
  const ws = mk();
  const st = store(ws);
  st.apply([{ op: 'set_project', name: 'p' }]);
  const file = path.join(ws, STATE_FILE);

  fs.writeFileSync(file, '{ not json');
  let threw = '';
  try {
    st.load();
  } catch (e: any) {
    threw = e instanceof PipelineStateError ? e.message : `wrong type: ${e}`;
  }
  check('a damaged file is an error that says it will not be overwritten', threw.includes('damaged') && threw.includes('will not be overwritten'), threw);
  const r = st.apply([{ op: 'add_note', text: 'x' }]);
  check('an update refuses to run over it, and leaves it as it was', !r.ok && r.error.includes('damaged') && fs.readFileSync(file, 'utf8') === '{ not json');

  fs.writeFileSync(file, JSON.stringify({ version: 2 }));
  check('a version this harness does not know is refused', (() => {
    try {
      st.load();
      return false;
    } catch (e: any) {
      return e.message.includes('version 2');
    }
  })());
  fs.writeFileSync(file, JSON.stringify({ version: 1, project: 'sparse' }));
  const sparse = st.load()!;
  check('missing lists default to empty; the four stages and three gates always exist', sparse.inputs.length === 0 && sparse.stages.length === 4 && sparse.gates.length === 3 && sparse.project === 'sparse');
  fs.writeFileSync(file, JSON.stringify({ version: 1, stages: [{ stage: 1, status: 'done', artifact: 'elsewhere/req.md' }] }));
  check('a stage keeps what the file says and the defaults for the rest', st.load()!.stages[0].status === 'done' && st.load()!.stages[0].artifact === 'elsewhere/req.md' && st.load()!.stages[0].skill === 'requirement-extraction-from-documents');
  let shape = '';
  try {
    normalizeState({ version: 1, inputs: 'nope' });
  } catch (e: any) {
    shape = e.message;
  }
  check('a list that is not a list is an error', shape.includes('"inputs" must be a list'));
}

console.log('\n=== the pipeline_state tool ===');
{
  const ws = withTasks();
  const tool = createPipelineStateTool();
  const call = (args: object) => tool.execute(args as any, ctxOf(ws) as any);

  const none = JSON.parse(await call({ action: 'get' }));
  check('with no state, get says so and how to start', none.exists === false && none.hint.includes('update'));

  const upd = await call({ action: 'update', ops: [{ op: 'add_input', name: 'BRD.pdf', input_kind: 'document' }, { op: 'set_stage', stage: 1, status: 'running' }, { op: 'add_question', gate: 'G1', id: 'q1', prompt: 'Qual versão?' }] });
  const u = JSON.parse(upd);
  check('update applies the operations and returns an overview', u.ok === true && u.applied === 3 && u.stages[0].status === 'running' && u.gates[0].open === 1);
  check('...including what is still waiting and where the files are', u.openQuestions[0].id === 'q1' && u.files.state === STATE_FILE && u.files.markdown === STATE_MD_FILE);
  check('the files exist', fs.existsSync(path.join(ws, STATE_FILE)) && fs.readFileSync(path.join(ws, STATE_MD_FILE), 'utf8').includes('BRD.pdf'));

  const bad = await call({ action: 'update', ops: [{ op: 'set_gate', gate: 'G1', status: 'passed' }] });
  check('a rule violation is an error result the model can act on', isToolErrorResult(bad) && bad.includes('gate G1 cannot pass') && bad.includes('q1'), bad);
  check('...and nothing changed', JSON.parse(await call({ action: 'get' })).gates[0].status === 'open');
  check('a missing "ops" is an error', isToolErrorResult(await call({ action: 'update' })));
  check('an unknown action is an error', isToolErrorResult(await call({ action: 'delete' })));

  const got = JSON.parse(await call({ action: 'get' }));
  check('get returns the state, with the task counts computed from the files', got.exists && got.tasks.taskCount === 11 && got.tasks.points === 45 && got.tasks.files.length === 4 && got.tasks.problems.length === 0);
  check('...questions in full, inputs without the internal hash', got.questions[0].prompt === 'Qual versão?' && got.inputs[0].name === 'BRD.pdf' && got.inputs[0].hash === undefined);

  fs.writeFileSync(path.join(ws, STATE_FILE), '{ broken');
  check('a damaged state is an error for both actions, and is not overwritten', isToolErrorResult(await call({ action: 'get' })) && isToolErrorResult(await call({ action: 'update', ops: [{ op: 'add_note', text: 'x' }] })) && fs.readFileSync(path.join(ws, STATE_FILE), 'utf8') === '{ broken');
}

console.log('\n=== through a session: a gate, end to end ===');
{
  const ws = mk();
  const config: AliaConfig = { name: 't', vendor: 't', apiKey: 'k', apiType: 'chat-completions', models: [{ id: 'fake-model', name: 'fake', url: 'http://fake', toolCalling: true }] };
  const ask = { id: 'q1', kind: 'choice', prompt: 'Qual versão do BRD é a oficial?', options: [{ id: 'v1', label: 'v1' }, { id: 'v2', label: 'v2' }], allowDefer: true };
  const turns: ScriptedTurn[] = [
    { toolCalls: [{ name: 'pipeline_state', args: { action: 'update', ops: [{ op: 'add_input', name: 'BRD.pdf', input_kind: 'document' }, { op: 'set_stage', stage: 1, status: 'running' }, { op: 'add_question', gate: 'G1', id: 'q1', prompt: ask.prompt, kind: 'choice', options: ask.options }] }, id: 'c1' }] },
    { toolCalls: [{ name: 'ask_user', args: { questions: [ask] }, id: 'c2' }] },
    (req) => {
      const answers = JSON.parse(String(req.messages.filter((m) => m.role === 'tool').pop()?.content));
      return { toolCalls: [{ name: 'pipeline_state', args: { action: 'update', ops: [{ op: 'answer_question', id: 'q1', answer: answers.answers[0].answer, by: 'Newton' }, { op: 'set_gate', gate: 'G1', status: 'passed' }, { op: 'set_stage', stage: 1, status: 'done', artifact: 'docs/requirements/requirements.md' }] }, id: 'c3' }] };
    },
    { toolCalls: [{ name: 'pipeline_state', args: { action: 'update', ops: [{ op: 'set_stage', stage: 2, status: 'running' }] }, id: 'c4' }] },
    (req) => ({ content: `stage 2 is ${JSON.parse(String(req.messages.filter((m) => m.role === 'tool').pop()?.content)).stages[1].status}` }),
  ];
  const model = new FakeModel(turns);
  const events: AgentEvent[] = [];
  const session = createSession({
    workspace: ws,
    config,
    client: model.client,
    skillRoots: [],
    permissionsDir: path.join(tmp, 'perm'),
    onEvent: (e) => events.push(e),
    onAskUser: async () => [{ id: 'q1', answer: 'v2' }],
  });
  const r = await session.run('run the pipeline');
  check('the tool is offered to the model by default', model.requests[0].toolNames.includes('pipeline_state'));
  check('the whole gate works: record, ask the user, record the answer, pass the gate, start the next stage', r.status === 'completed' && r.text === 'stage 2 is running', r.text);
  const state = JSON.parse(fs.readFileSync(path.join(ws, STATE_FILE), 'utf8'));
  check("the user's answer is in state.json with who gave it", state.gates[0].questions[0].answer === 'v2' && state.gates[0].questions[0].answerLabel === 'v2' && state.gates[0].questions[0].by === 'Newton' && state.gates[0].status === 'passed');
  const md = fs.readFileSync(path.join(ws, STATE_MD_FILE), 'utf8');
  check('STATE.md was regenerated along the way', md.includes('| 1 | requirement-extraction-from-documents | done |') && md.includes('G1: passed (1 of 1 answered)') && md.includes('| 2 | architecture-from-requirements | running |'));
  check('every state update shows as a normal tool call', events.filter((e) => e.type === 'tool_call_finished' && (e as any).name === 'pipeline_state').every((e: any) => e.isError === false));

  // The rule bites when the model tries to skip a gate.
  const skip = new FakeModel([
    { toolCalls: [{ name: 'pipeline_state', args: { action: 'update', ops: [{ op: 'add_question', gate: 'G1', id: 'q1', prompt: 'x' }, { op: 'set_stage', stage: 1, status: 'done' }, { op: 'set_stage', stage: 2, status: 'running' }] }, id: 's1' }] },
    (req) => ({ content: String(req.messages.filter((m) => m.role === 'tool').pop()?.content) }),
  ]);
  const ws2 = mk();
  const s2 = createSession({ workspace: ws2, config, client: skip.client, skillRoots: [], permissionsDir: path.join(tmp, 'perm') });
  const r2 = await s2.run('skip the gate');
  check('a model that tries to start stage 2 before the gate passes is stopped, with the reason', r2.text.startsWith('Error:') && r2.text.includes('gate G1 has not passed') && !fs.existsSync(path.join(ws2, STATE_FILE)), r2.text.slice(0, 200));
}

console.log('\n=== the pipeline skill tells the model about it ===');
{
  const skill = fs.readFileSync(path.resolve('skills', 'e2e-pipeline', 'SKILL.md'), 'utf8');
  check('SKILL.md says to use pipeline_state when available, and to fall back to writing STATE.md', skill.includes('pipeline_state') && /otherwise[^.]*STATE\.md by hand/i.test(skill));
  check('it covers recording inputs, gate questions and answers through the tool', skill.includes('add_input') && skill.includes('add_question') && skill.includes('answer_question') && skill.includes('defer_question'));
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll pipeline state checks passed.');
