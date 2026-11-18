import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AliaConfig } from '../src/core/config.js';
import { createSession } from '../src/core/session.js';
import { bundledSkillsDir } from '../src/core/skills/skillLoader.js';
import { PipelineStateStore, STATE_FILE, STATE_MD_FILE } from '../src/core/pipeline/pipelineState.js';
import { getPipelineStatus, refreshStateMarkdown } from '../src/core/pipeline/pipelineStatus.js';
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alia-resume-'));
let n = 0;
const mk = () => {
  const dir = path.join(tmp, `ws-${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const NOW = new Date('2026-11-18T12:00:00.000Z');
const store = (ws: string) => new PipelineStateStore(ws, { now: () => NOW });
const apply = (ws: string, ops: unknown[]) => {
  const r = store(ws).apply(ops);
  if (!r.ok) throw new Error(`setup failed: ${r.error}`);
  return r.state;
};
const q = (id: string, prompt: string, extra: object = {}) => ({ op: 'add_question', gate: 'G1', id, prompt, ...extra });

/** A pipeline that stopped at gate 1 with 3 of 5 questions answered: the situation in the design. */
function stoppedAtGate1(ws: string) {
  fs.mkdirSync(path.join(ws, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'docs', 'BRD_PortalCliente_v2.pdf'), 'brd v2 contents');
  apply(ws, [
    { op: 'set_project', name: 'Portal do cliente' },
    { op: 'add_input', name: 'BRD_PortalCliente_v2.pdf', input_kind: 'document', path: 'docs/BRD_PortalCliente_v2.pdf' },
    { op: 'set_stage', stage: 1, status: 'running' },
    q('q1', 'Qual versão do BRD é a oficial?'),
    q('q2', 'Parceiros externos usam o portal?'),
    q('q3', 'Integração com o ERP entra no MVP?'),
    q('q4', 'O BRD v2 exige SSO e o kickoff fala em login por e-mail. Qual vale?'),
    q('q5', 'Quantos usuários simultâneos o portal deve suportar?'),
    { op: 'answer_question', id: 'q1', answer: 'v2', by: 'Newton' },
    { op: 'answer_question', id: 'q2', answer: 'Sim, a partir da fase 2', by: 'Newton' },
    { op: 'defer_question', id: 'q3', owner: 'Newton', assumption: 'Integração com o ERP fica fora do MVP' },
    { op: 'set_stage', stage: 1, status: 'blocked', reason: 'awaiting answers (gate 1)' },
  ]);
}

console.log('\n=== no pipeline, damaged pipeline ===');
{
  const ws = mk();
  const s = getPipelineStatus(ws);
  check('no state: not started, with the way to begin', s.exists === false && s.next.kind === 'not_started' && s.summary === 'The pipeline has not started.' && s.resumePrompt.includes('Step 0') && s.resumePrompt.includes('add_input'));
  check('it created nothing', !fs.existsSync(path.join(ws, 'docs')));

  fs.mkdirSync(path.join(ws, 'docs', 'pipeline'), { recursive: true });
  fs.writeFileSync(path.join(ws, STATE_FILE), '{ nope');
  const d = getPipelineStatus(ws);
  check('a damaged state does not throw: it says so and tells the model to change nothing', d.exists && d.next.kind === 'damaged' && d.summary.includes('cannot be read') && d.resumePrompt.includes('Do not change anything') && fs.readFileSync(path.join(ws, STATE_FILE), 'utf8') === '{ nope');
}

console.log('\n=== stopped at gate 1 (3 of 5 answered) ===');
{
  const ws = mk();
  stoppedAtGate1(ws);
  const s = getPipelineStatus(ws);
  const next: any = s.next;
  check('it reports the gate, the stage and the progress', next.kind === 'answer_questions' && next.gate === 'G1' && next.stage === 1 && next.answered === 3 && next.total === 5, JSON.stringify(s.next));
  check('...and exactly the open questions', next.open.map((o: any) => o.id).join() === 'q4,q5');
  check('the summary is one readable line', s.summary === 'Waiting at gate G1: 3 of 5 questions answered.');
  check('the stages and gates are summarized for a header', s.stages[0].status === 'blocked' && s.stages[0].gateProgress?.open === 2 && s.gates[0].answered === 2 && s.gates[0].deferred === 1 && s.project === 'Portal do cliente');
  const p = s.resumePrompt;
  check('the resume prompt names the open questions and not the answered ones', p.includes('q4') && p.includes('q5') && p.includes('SSO') && !p.includes('Parceiros externos') && !p.includes('Qual versão'), p.slice(0, 400));
  check('it says not to ask them again and how to record the answers', p.includes('do not ask them again') && p.includes('ask_user') && p.includes('answer_question') && p.includes('defer_question') && p.includes('owner') && p.includes('set_gate'));
  check('it points at the state and the skill', p.includes('docs/pipeline/state.json') && p.includes('requirements-to-tasks-pipeline') && p.includes('Do not redo stages that are done'));
  check('status is read-only: nothing was written', fs.readFileSync(path.join(ws, STATE_MD_FILE), 'utf8') === store(ws).render(store(ws).load()!));
}

console.log('\n=== what is next, step by step through the whole pipeline ===');
{
  const ws = mk();
  fs.cpSync(path.join(FIXTURES, 'docs'), path.join(ws, 'docs'), { recursive: true });
  const steps: Array<[string, unknown[], string, string]> = [
    ['stage 1 not started', [{ op: 'add_input', name: 'brief.txt', input_kind: 'brief' }], 'run_stage', 'Next: stage 1 (requirement-extraction-from-documents).'],
    ['stage 1 running', [{ op: 'set_stage', stage: 1, status: 'running' }], 'run_stage', 'In progress: stage 1 (requirement-extraction-from-documents).'],
    ['a question appears at gate 1', [q('q1', 'Qual versão?')], 'answer_questions', 'Waiting at gate G1: 0 of 1 questions answered.'],
    ['answered, but the stage is still marked blocked', [{ op: 'answer_question', id: 'q1', answer: 'v2' }, { op: 'set_stage', stage: 1, status: 'blocked', reason: 'awaiting answers (gate 1)' }], 'run_stage', 'Blocked: stage 1 (requirement-extraction-from-documents): awaiting answers (gate 1).'],
    ['stage 1 done, gate 1 not yet approved', [{ op: 'set_stage', stage: 1, status: 'done' }], 'pass_gate', 'Gate G1 is ready: waiting for approval to move on to stage 2.'],
    ['gate 1 passed: stage 2 is next', [{ op: 'set_gate', gate: 'G1', status: 'passed' }], 'run_stage', 'Next: stage 2 (architecture-from-requirements).'],
    ['stage 2 running', [{ op: 'set_stage', stage: 2, status: 'running' }], 'run_stage', 'In progress: stage 2 (architecture-from-requirements).'],
    ['a blocking question at gate 2', [{ op: 'add_question', gate: 'G2', id: 'q2', prompt: 'Quem é dono das gravações?', category: 'blocker' }], 'answer_questions', 'Waiting at gate G2: 0 of 1 questions answered.'],
    ['answered; stage 2 done; gate 2 awaiting approval', [{ op: 'answer_question', id: 'q2', answer: 'CRM' }, { op: 'set_stage', stage: 2, status: 'done' }], 'pass_gate', 'Gate G2 is ready: waiting for approval to move on to stage 3.'],
    ['gate 2 passed, stage 3 done, specs awaiting review', [{ op: 'set_gate', gate: 'G2', status: 'passed' }, { op: 'set_stage', stage: 3, status: 'running' }, { op: 'set_stage', stage: 3, status: 'done' }, { op: 'set_spec_review', spec: 'login-sso', status: 'reviewed' }, { op: 'set_spec_review', spec: 'abrir-chamado', status: 'in_review' }, { op: 'set_spec_review', spec: 'consultar-pedidos', status: 'draft' }], 'review_specs', 'Waiting at gate G3: 2 specs still to review (abrir-chamado, consultar-pedidos).'],
    ['all specs reviewed: gate 3 awaiting approval', [{ op: 'set_spec_review', spec: 'abrir-chamado', status: 'reviewed' }, { op: 'set_spec_review', spec: 'consultar-pedidos', status: 'reviewed' }], 'pass_gate', 'Gate G3 is ready: waiting for approval to move on to stage 4.'],
    ['gate 3 passed: stage 4 is next', [{ op: 'set_gate', gate: 'G3', status: 'passed' }], 'run_stage', 'Next: stage 4 (spec-to-tasks).'],
    ['everything done', [{ op: 'set_stage', stage: 4, status: 'running' }, { op: 'set_stage', stage: 4, status: 'done', artifact: 'docs/tasks/' }], 'complete', 'Complete: 11 tasks, 45 points.'],
  ];
  for (const [label, ops, kind, summary] of steps) {
    apply(ws, ops);
    const s = getPipelineStatus(ws);
    check(`${label} -> ${kind}`, s.next.kind === kind && s.summary === summary, `${s.next.kind} | ${s.summary}`);
  }
  const done = getPipelineStatus(ws);
  check('a finished pipeline says to give the final report and suggests issue-writer', done.resumePrompt.includes('final report') && done.resumePrompt.includes('issue-writer'));
  check('the task counts come with the status', done.tasks?.taskCount === 11 && done.tasks?.points === 45 && done.tasks?.problems.length === 0);

  // Earlier work reopens: it comes before anything later.
  apply(ws, [{ op: 'reopen_question', id: 'q1' }]);
  const reopened = getPipelineStatus(ws);
  check('a question reopened at gate 1 comes before everything after it, though stage 4 is done', reopened.next.kind === 'answer_questions' && (reopened.next as any).gate === 'G1', JSON.stringify(reopened.next));
  apply(ws, [{ op: 'answer_question', id: 'q1', answer: 'v2' }, { op: 'set_gate', gate: 'G1', status: 'passed' }]);

  apply(ws, [{ op: 'mark_stale', after_stage: 1, reason: 'requirements changed after the gate-1 answers' }]);
  const stale = getPipelineStatus(ws);
  check('stale stages are to be redone, from the first one', stale.next.kind === 'run_stage' && (stale.next as any).stage === 2 && (stale.next as any).reason === 'stale' && stale.summary === 'To redo (stale): stage 2 (architecture-from-requirements): requirements changed after the gate-1 answers.', stale.summary);
  check('and the prompt says to redo it', stale.resumePrompt.includes('Redo stage 2'));
}

console.log('\n=== inputs that changed since they were inventoried ===');
{
  const ws = mk();
  stoppedAtGate1(ws);
  const file = path.join(ws, 'docs', 'BRD_PortalCliente_v2.pdf');
  check('unchanged inputs are fine', getPipelineStatus(ws).staleInputs.length === 0 && getPipelineStatus(ws).next.kind === 'answer_questions');

  fs.writeFileSync(file, 'brd v2 contents, edited after the gate-1 answers');
  const s = getPipelineStatus(ws);
  check('a modified input is flagged, by name and path', s.staleInputs.length === 1 && s.staleInputs[0].name === 'BRD_PortalCliente_v2.pdf' && s.staleInputs[0].reason === 'changed' && s.staleInputs[0].path === 'docs/BRD_PortalCliente_v2.pdf');
  check('it comes first: the answers may no longer hold', s.next.kind === 'inputs_changed' && s.summary === 'Input changed since it was inventoried: BRD_PortalCliente_v2.pdf.', s.summary);
  check('the prompt tells the model to ask whether to redo from stage 1, and how', s.resumePrompt.includes('ask whether to redo') && s.resumePrompt.includes('mark_stale') && s.resumePrompt.includes('add_input'));

  apply(ws, [{ op: 'add_input', name: 'BRD_PortalCliente_v2.pdf', input_kind: 'document', path: 'docs/BRD_PortalCliente_v2.pdf' }]);
  const refreshed = getPipelineStatus(ws);
  check('refreshing the inventory (add_input again) clears it, and the gate is next again', refreshed.staleInputs.length === 0 && refreshed.next.kind === 'answer_questions');

  fs.rmSync(file);
  const gone = getPipelineStatus(ws);
  check('a deleted input is reported as missing', gone.staleInputs[0]?.reason === 'missing' && gone.next.kind === 'inputs_changed');

  const ws2 = mk();
  apply(ws2, [{ op: 'add_input', name: 'pasted text', input_kind: 'brief' }, { op: 'add_input', name: 'ghost.pdf', input_kind: 'document', path: 'docs/ghost.pdf' }]);
  check('an input with no file (or one that never existed) has nothing to compare, so it is never flagged', getPipelineStatus(ws2).staleInputs.length === 0);
}

console.log('\n=== STATE.md out of step with state.json ===');
{
  const ws = mk();
  fs.cpSync(path.join(FIXTURES, 'docs'), path.join(ws, 'docs'), { recursive: true });
  apply(ws, [{ op: 'set_project', name: 'p' }]);
  check('right after an update it matches', getPipelineStatus(ws).markdown === 'ok');
  const md = path.join(ws, STATE_MD_FILE);
  fs.appendFileSync(md, '\n| hand-written row |\n');
  check('edited by hand: it differs (state.json is the source of truth)', getPipelineStatus(ws).markdown === 'differs');
  check('refreshStateMarkdown puts it right', refreshStateMarkdown(ws) === true && getPipelineStatus(ws).markdown === 'ok');
  fs.writeFileSync(md, fs.readFileSync(md, 'utf8').replace(/\n/g, '\r\n'));
  check('line endings alone (a git checkout with autocrlf) are not drift', getPipelineStatus(ws).markdown === 'ok');
  fs.rmSync(md);
  check('deleted: missing', getPipelineStatus(ws).markdown === 'missing');
  refreshStateMarkdown(ws);
  fs.rmSync(path.join(ws, 'docs', 'tasks', '04-acesso-parceiros-tasks.md'));
  check('the task files changing makes STATE.md out of date too (its counts are computed)', getPipelineStatus(ws).markdown === 'differs');
  check('refreshing a workspace with no state does nothing', refreshStateMarkdown(mk()) === false);
}

console.log('\n=== resuming through a session ===');
{
  const config: AliaConfig = { name: 't', vendor: 't', apiKey: 'k', apiType: 'chat-completions', models: [{ id: 'fake-model', name: 'fake', url: 'http://fake', toolCalling: true }] };
  const open = (ws: string, turns: ScriptedTurn[], extra: Partial<Parameters<typeof createSession>[0]> = {}) => {
    const model = new FakeModel(turns);
    const session = createSession({ workspace: ws, config, client: model.client, skillRoots: [{ label: 'bundled', dir: bundledSkillsDir() }], permissionsDir: path.join(tmp, 'perm'), ...extra });
    return { session, model };
  };

  const empty = open(mk(), []);
  const none = await empty.session.resumePipelinePrompt();
  check('nothing to resume when there is no state', none.status.exists === false && none.prompt === undefined);

  const ws = mk();
  stoppedAtGate1(ws);
  const probe = open(ws, []);
  check('session.pipelineStatus() is the same status', JSON.stringify(probe.session.pipelineStatus()) === JSON.stringify(getPipelineStatus(ws)));
  const resumed = await probe.session.resumePipelinePrompt();
  check('the resume prompt carries the pipeline skill, loaded, and where it stopped', !!resumed.prompt && resumed.prompt.includes('<skill name="requirements-to-tasks-pipeline"') && resumed.prompt.includes('Request / input:') && resumed.prompt.includes('Waiting at gate G1: 3 of 5') && resumed.prompt.includes('q4'), resumed.prompt?.slice(0, 200));

  const noSkill = await open(ws, [], { skillRoots: [] }).session.resumePipelinePrompt();
  check('if the skill is not available the plain resume text is still given', !!noSkill.prompt && !noSkill.prompt.includes('<skill ') && noSkill.prompt.includes('q4'));

  // A new session (the app was restarted) picks up where the last one stopped and finishes the gate.
  const ask = (id: string, prompt: string) => ({ id, kind: 'text', prompt, allowDefer: true });
  const turns: ScriptedTurn[] = [
    (req) => {
      const first = String(req.messages.find((m) => m.role === 'user')?.content);
      // The model sees only the open questions, and asks exactly those.
      const ids = ['q4', 'q5'].filter((id) => first.includes(id));
      return { toolCalls: [{ name: 'ask_user', args: { questions: ids.map((id) => ask(id, `Pergunta ${id}`)) }, id: 'c1' }] };
    },
    { toolCalls: [{ name: 'pipeline_state', args: { action: 'update', ops: [
        { op: 'answer_question', id: 'q4', answer: 'SSO corporativo', by: 'Newton' },
        { op: 'defer_question', id: 'q5', owner: 'Newton', assumption: 'Volume de usuários a confirmar com o cliente' },
        { op: 'set_stage', stage: 1, status: 'done', artifact: 'docs/requirements/requirements.md' },
        { op: 'set_gate', gate: 'G1', status: 'passed' },
      ] }, id: 'c2' }] },
    { content: 'gate 1 closed' },
  ];
  const asked: string[][] = [];
  const second = open(ws, turns, {
    onAskUser: async (r) => {
      asked.push(r.questions.map((x) => x.id));
      return [{ id: 'q4', answer: 'SSO corporativo' }, { id: 'q5', deferred: true, owner: 'Newton' }];
    },
  });
  const { prompt } = await second.session.resumePipelinePrompt();
  const result = await second.session.run(prompt!);
  check('the resumed run asks only the two open questions', asked.length === 1 && asked[0].join() === 'q4,q5', JSON.stringify(asked));
  check('and finishes the gate', result.status === 'completed' && result.text === 'gate 1 closed');
  const after = second.session.pipelineStatus();
  check('the state moved on: gate 1 passed, stage 2 is next', after.next.kind === 'run_stage' && (after.next as any).stage === 2 && after.gates[0].status === 'passed' && after.gates[0].open === 0 && after.gates[0].deferred === 2, after.summary);
  check('the deferral became an assumption with its owner', store(ws).load()!.assumptions.map((a) => `${a.text}|${a.owner}`).includes('Volume de usuários a confirmar com o cliente|Newton'));
  check('STATE.md follows along', after.markdown === 'ok');
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll pipeline resume checks passed.');
