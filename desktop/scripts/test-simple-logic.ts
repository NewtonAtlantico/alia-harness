/**
 * Unit tests for the simple view's pure logic: which screen a project shows and the chip it gets in the sidebar, its four steps, the
 * questions one at a time (what a pick records), what a spec and the requirements say in plain words, and the plan with its summary.
 * The views are built from real states made by core's own store, through a whole pipeline.
 * Run from desktop/: `npm run test:simple-logic`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PipelineStateStore, buildReport, getFlow, getPipelineStatus } from 'alia-harness/core';
import type { PipelineBrief, PipelineView } from '../src/shared/ipc';
import { joinRefs, deliveryOrder, planFor, planHtml, planMarkdown } from '../src/renderer/src/lib/plan';
import { currentStep, isSimpleProject, screenFor, simpleChip, simpleSteps, simpleTitle } from '../src/renderer/src/lib/simple';
import { PICK_LATER, PICK_OWNER, answerOf, isAnswered, pickOfSettled, settledLine, simpleQuestion } from '../src/renderer/src/lib/simpleQuestions';
import { parseSpec, understoodFrom } from '../src/renderer/src/lib/specText';

let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.log(`  ✘ ${name} ${extra}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alia-simple-logic-'));
const store = new PipelineStateStore(tmp);
const apply = (ops: unknown[]) => {
  const r = store.apply(ops);
  if (!r.ok) throw new Error(r.error);
};
const view = (): PipelineView => {
  const state = store.load();
  const status = getPipelineStatus(tmp);
  return { flow: getFlow(state?.flow), status, state, artifacts: [], markdownExists: true, ...(state ? { report: buildReport(state, store.tasks(), status.staleInputs) } : {}) };
};
const screen = (running = false) => screenFor(view(), running).kind;
const q = (id: string, extra: object = {}) => ({ op: 'add_question', gate: 'G1', id, prompt: `Pergunta ${id}?`, ...extra });
const through = (n: number) => [1, 2, 3, 4].slice(0, n).flatMap((s) => [{ op: 'set_stage', stage: s, status: 'running' }, { op: 'set_stage', stage: s, status: 'done' }, ...(s < 4 ? [{ op: 'set_gate', gate: `G${s}`, status: 'passed' }] : [])]);
const brief = (over: Partial<PipelineBrief>): PipelineBrief => ({ exists: true, summary: '', state: 'not_started', ...over });

console.log('\n=== which screen a project shows ===');
{
  check('no pipeline yet: nothing to show, or the work if it is starting', screenFor({ ...view(), status: getPipelineStatus(tmp) }, false).kind === 'empty' && screen(true) === 'working');
  apply([{ op: 'set_project', name: 'Portal do cliente' }, { op: 'add_input', name: 'a.pdf', input_kind: 'document' }]);
  check('stage 1 not started and nothing runs: it is stopped, and while it runs it is working', screen() === 'stopped' && screen(true) === 'working');
  apply([{ op: 'set_stage', stage: 1, status: 'running' }, q('q1', { kind: 'choice', category: 'contradiction', options: [{ id: 'a', label: 'A', source: 'x.pdf · p. 1' }, { id: 'b', label: 'B', source: 'y.txt · 2:00' }] }), q('q2', { kind: 'confirm' }), { op: 'set_stage', stage: 1, status: 'done' }]);
  check('gate 1 with open questions: the person answers them, one at a time', screen() === 'questions' && (screenFor(view(), false) as { gate: string }).gate === 'G1');
  check('but not while the agent is working (the engine would refuse their answers)', screen(true) === 'working');
  apply([{ op: 'answer_question', id: 'q1', answer: 'a', by: 'Newton' }, { op: 'defer_question', id: 'q2', owner: 'Ana' }]);
  check('gate 1 settled, not approved: the person only has to go on', screen() === 'approve');
  apply([{ op: 'set_gate', gate: 'G1', status: 'passed' }]);
  check('between the stages it is stopped (the next one has not started)', screen() === 'stopped');
  apply([{ op: 'set_stage', stage: 2, status: 'running' }, { op: 'add_question', gate: 'G2', id: 'b1', prompt: 'Quem é o dono?', kind: 'text', category: 'blocker' }, { op: 'set_stage', stage: 2, status: 'done' }]);
  check('gate 2 is the technical owner\u2019s: the person has nothing to do, and sees how many points are open', screen() === 'owner' && (screenFor(view(), false) as { open: number }).open === 1);
  apply([{ op: 'answer_question', id: 'b1', answer: 'CRM', by: 'Ana' }]);
  check('gate 2 settled, not approved: still the technical owner\u2019s', screen() === 'owner' && (screenFor(view(), false) as { open: number }).open === 0);
  apply([{ op: 'set_gate', gate: 'G2', status: 'passed' }, { op: 'set_stage', stage: 3, status: 'running' }, { op: 'add_question', gate: 'G3', id: 'g1', prompt: 'Qual persona?', kind: 'text' }, { op: 'set_spec', slug: 'login', title: 'Login', persona: 'Clientes', depends_on: [] }, { op: 'set_stage', stage: 3, status: 'done' }]);
  check('gaps at gate 3 are questions first', screen() === 'questions' && (screenFor(view(), false) as { gate: string }).gate === 'G3');
  apply([{ op: 'answer_question', id: 'g1', answer: 'Cliente', by: 'Newton' }, { op: 'set_spec_review', spec: 'login', status: 'in_review' }]);
  check('then the features are confirmed one by one', screen() === 'features');
  apply([{ op: 'set_spec_review', spec: 'login', status: 'reviewed', by: 'Newton' }]);
  check('every feature confirmed, the gate not approved: still the features screen (it has the way on)', screen() === 'features');
  apply([{ op: 'set_gate', gate: 'G3', status: 'passed' }, { op: 'set_stage', stage: 4, status: 'running' }, { op: 'set_stage', stage: 4, status: 'done' }]);
  check('all done: the plan', screen() === 'plan' && screen(true) === 'plan');
  apply([{ op: 'mark_stale', after_stage: 1, reason: 'changed' }]);
  check('a stage to redo (stale) is stopped work, not a plan', screen() === 'stopped', screen());
  check('a damaged state asks for the technical view', screenFor({ ...view(), status: { ...view().status, next: { kind: 'damaged', message: 'x' } } }, false).kind === 'attention');
}

console.log('\n=== the four steps ===');
{
  fs.rmSync(path.join(tmp, 'docs'), { recursive: true });
  apply([{ op: 'add_input', name: 'a.pdf', input_kind: 'document' }]);
  const at = (running = false) => simpleSteps(view(), running).map((s) => `${s.stage}:${s.state}`).join(' ');
  check('the steps are the flow\u2019s, in the words of the simple view', simpleSteps(view(), false).map((s) => s.title).join('|') === 'Entender o pedido|Desenhar a solução|Detalhar as funcionalidades|Planejar as entregas');
  check('at the start the first step is the one the person is at', at() === '1:current 2:next 3:next 4:next' && currentStep(simpleSteps(view(), false))?.detail === 'Você está aqui', at());
  apply([{ op: 'set_stage', stage: 1, status: 'running' }, q('q1'), { op: 'set_stage', stage: 1, status: 'done' }]);
  check('waiting at a gate keeps that step current', at() === '1:current 2:next 3:next 4:next', at());
  apply([{ op: 'answer_question', id: 'q1', answer: 'x', by: 'Newton' }, { op: 'set_gate', gate: 'G1', status: 'passed' }]);
  check('between steps the next one is current', at() === '1:done 2:current 3:next 4:next', at());
  check('the step the technical owner has says so, and one that is running says that', currentStep(simpleSteps(view(), false))?.detail === 'Com o responsável técnico' && currentStep(simpleSteps(view(), true))?.detail === 'Em andamento');
  apply([...through(4).slice(3)]);
  check('a step that is done says "Concluída"', simpleSteps(view(), false)[0].detail === 'Concluída');
  check('a view with no flow still has titles (from the stepper)', simpleSteps({ ...view(), flow: undefined as never }, false)[0].title === 'Requisitos');
}

console.log('\n=== the chip and the name in the sidebar ===');
{
  const label = (b: PipelineBrief) => simpleChip(b)?.label;
  check('a folder with no pipeline and no metadata is not one of the person\u2019s projects', !isSimpleProject(brief({ exists: false })) && simpleChip(brief({ exists: false })) === null && !isSimpleProject(undefined));
  check('one the simple view made, but not started', isSimpleProject(brief({ exists: false, meta: { name: 'X' } })) && label(brief({ exists: false, meta: { name: 'X' } })) === 'Não iniciado');
  check('questions, a gate to approve and specs to review are the person\u2019s turn', label(brief({ state: 'answer_questions', gate: 'G1' })) === 'Sua vez' && label(brief({ state: 'pass_gate', gate: 'G1' })) === 'Sua vez' && label(brief({ state: 'review_specs', gate: 'G3' })) === 'Sua vez' && label(brief({ state: 'answer_questions', gate: 'G3' })) === 'Sua vez');
  check('the architecture is with the technical owner', label(brief({ state: 'answer_questions', gate: 'G2' })) === 'Com o responsável técnico' && label(brief({ state: 'pass_gate', gate: 'G2' })) === 'Com o responsável técnico');
  check('a stage to run is "Em andamento"', label(brief({ state: 'run_stage', stage: 2 })) === 'Em andamento' && simpleChip(brief({ state: 'run_stage' }))?.tone === 'running');
  check('complete is "Pronto", and "Com o time técnico" once it was handed over', label(brief({ state: 'complete' })) === 'Pronto' && label(brief({ state: 'complete', meta: { handedOff: { at: '2026-01-01T00:00:00Z', mode: 'publish' } } })) === 'Com o time técnico');
  check('a changed input or a damaged state asks for attention', label(brief({ state: 'inputs_changed' })) === 'Atenção' && label(brief({ state: 'damaged' })) === 'Atenção' && simpleChip(brief({ state: 'damaged' }))?.tone === 'warn');
  check('the name the person gave wins over the pipeline\u2019s and the folder\u2019s', simpleTitle('C:\\p\\portal-1', brief({ meta: { name: 'Portal do cliente' }, project: 'x' })) === 'Portal do cliente' && simpleTitle('C:\\p\\portal-1', brief({ project: 'Pipeline X' })) === 'Pipeline X' && simpleTitle('C:\\p\\portal-1') === 'portal-1');
}

console.log('\n=== the questions ===');
{
  const choice = simpleQuestion({ id: 'q1', prompt: 'Como entram?', kind: 'choice', category: 'contradiction', status: 'open', options: [{ id: 'a', label: 'Corporativo', source: 'BRD · p. 14' }, { id: 'b', label: 'E-mail e senha', source: 'Ata · 12:40' }] });
  const plain = simpleQuestion({ id: 'q2', prompt: 'Qual?', kind: 'choice', category: 'open_question', status: 'open', options: [{ id: 'a', label: 'A', source: 'BRD · p. 1' }, { id: 'b', label: 'B' }] });
  const confirm = simpleQuestion({ id: 'q3', prompt: 'Sim?', kind: 'confirm', category: 'low_confidence', status: 'open' });
  const text = simpleQuestion({ id: 'q4', prompt: 'Quantos?', kind: 'text', category: 'blocker', status: 'open' });
  const who = { me: 'Newton', owner: 'Ana' };
  check('a contradiction says the files disagree and puts what each says side by side', choice.category === 'Os arquivos discordam' && choice.contradiction && choice.sources.length === 2 && choice.sources[0].source === 'BRD · p. 14' && choice.sources[0].text === 'Corporativo');
  check('one source alone is not a comparison, and an ordinary question has no chip', plain.sources.length === 0 && plain.category === undefined);
  check('the other categories have their own words', confirm.category === 'Não temos certeza' && text.category === 'Precisa de uma decisão');
  check('a confirmation is answered Sim or Não', confirm.options.map((o) => o.label).join('|') === 'Sim|Não' && answerOf(confirm, { option: 'yes' }, who)?.answer === true && answerOf(confirm, { option: 'no' }, who)?.answer === false);
  check('a choice records the option, and only an option the question has', answerOf(choice, { option: 'a' }, who)?.answer === 'a' && !isAnswered(choice, { option: 'zzz' }) && !isAnswered(choice, undefined) && !isAnswered(choice, {}));
  check('a text question needs words (spaces are not)', !isAnswered(text, { text: '   ' }) && answerOf(text, { text: ' 500 ' }, who)?.answer === '500');
  check('"Não sei" defers the question to the technical owner, "Decidir depois" to the person', JSON.stringify(answerOf(choice, { option: PICK_OWNER }, who)) === JSON.stringify({ id: 'q1', deferred: true, owner: 'Ana' }) && JSON.stringify(answerOf(text, { option: PICK_LATER }, who)) === JSON.stringify({ id: 'q4', deferred: true, owner: 'Newton' }));
  check('the ways out settle any kind of question, even a text one with nothing typed', isAnswered(text, { option: PICK_OWNER }) && isAnswered(confirm, { option: PICK_LATER }));
  const answered = simpleQuestion({ id: 'q1', prompt: 'x', kind: 'choice', category: 'open_question', status: 'answered', answer: 'a', answerLabel: 'Corporativo', options: [{ id: 'a', label: 'Corporativo' }, { id: 'b', label: 'Outro' }] });
  const deferredOwner = simpleQuestion({ id: 'q5', prompt: 'x', kind: 'text', category: 'open_question', status: 'deferred', owner: 'Ana' });
  const deferredMe = simpleQuestion({ id: 'q6', prompt: 'x', kind: 'text', category: 'open_question', status: 'deferred', owner: 'Newton' });
  check('an answered question shows its answer again, locked', pickOfSettled(answered, who)?.option === 'a' && pickOfSettled(choice, who) === undefined);
  check('a deferred one shows which way out it took', pickOfSettled(deferredOwner, who)?.option === PICK_OWNER && pickOfSettled(deferredMe, who)?.option === PICK_LATER);
  check('"Já respondidas" says what was answered, or who the question went to', settledLine(answered, 'Newton') === 'Corporativo' && settledLine(deferredMe, 'Newton') === 'Decidir depois · pendência sua' && settledLine(deferredOwner, 'Newton') === 'Perguntamos a Ana');
}

console.log('\n=== what a spec and the requirements say ===');
{
  const spec = parseSpec('# Clientes abrem chamados\n\n> Status: rascunho\n\n## Contexto\nHoje o cliente só consegue abrir um chamado por **e-mail**, sem confirmação nem acompanhamento.\n\n## Critérios de aceite\n- [ ] O cliente, já logado, abre um chamado com assunto e descrição\n- [x] Clicar duas vezes em enviar não cria dois chamados\n1. O cliente recebe um e-mail confirmando\n\n## Fora do escopo\n- Anexar arquivos\n- Conversar com o atendente\n');
  check('what the feature is comes from its context, without emphasis marks', spec.summary === 'Hoje o cliente só consegue abrir um chamado por e-mail, sem confirmação nem acompanhamento.', spec.summary);
  check('the criteria are the list items, with no check boxes', spec.criteria.length === 3 && spec.criteria[0] === 'O cliente, já logado, abre um chamado com assunto e descrição' && spec.criteria[2] === 'O cliente recebe um e-mail confirmando', JSON.stringify(spec.criteria));
  check('what is left for later is one line', spec.later === 'Anexar arquivos, Conversar com o atendente.', spec.later);
  const english = parseSpec('# Login\n\n## Problem\nUsers have many passwords.\n\n## Acceptance criteria\n- Sign in with the company account\n\n## Out of scope\nSelf registration.\n');
  check('a spec in English is read by what its headings say', english.summary === 'Users have many passwords.' && english.criteria[0] === 'Sign in with the company account' && english.later === 'Self registration.', JSON.stringify(english));
  const bare = parseSpec('# Só um título\n\nUm parágrafo qualquer sobre a funcionalidade.\n');
  check('without the sections it leaves out what it cannot find (and falls back to the first paragraph)', bare.summary === 'Um parágrafo qualquer sobre a funcionalidade.' && bare.criteria.length === 0 && bare.later === undefined);
  check('metadata lines are not the summary', parseSpec('# X\n\nStatus: rascunho\nDono: Ana\n\nO que a funcionalidade faz.\n').summary === 'O que a funcionalidade faz.');
  check('an empty file is empty', JSON.stringify(parseSpec('')) === JSON.stringify({ criteria: [] }));
  const understood = understoodFrom('# Requisitos\n\n## Resumo\n- REQ-1: Clientes acompanham seus pedidos pelo portal\n- **RF2** - Clientes abrem chamados sem precisar mandar e-mail.\n- curto\n- Parceiros externos entram em uma segunda fase\n- Mais um item de requisito aqui\n- Outro item que passa do limite\n\n## Perguntas em aberto\n- Qual SSO vale para o portal inteiro?\n');
  check('what was understood is the first lines of the requirements, without ids, at most four, and never the open questions', understood.length === 4 && understood[0] === 'Clientes acompanham seus pedidos pelo portal' && understood[1] === 'Clientes abrem chamados sem precisar mandar e-mail' && !understood.some((u) => u.includes('SSO')), JSON.stringify(understood));
  check('with no list there is nothing to say', understoodFrom('# Requisitos\n\nSó prosa.').length === 0);
}

console.log('\n=== the plan ===');
{
  const slugs = ['01-login-sso', '02-consultar-pedidos', '03-abrir-chamado', '04-acesso-parceiros'];
  const plan = fs.mkdtempSync(path.join(os.tmpdir(), 'alia-simple-plan-'));
  fs.cpSync(path.resolve(import.meta.dirname, '..', '..', 'scripts', 'fixtures', 'pipeline', 'docs'), path.join(plan, 'docs'), { recursive: true });
  const ps = new PipelineStateStore(plan);
  const r = ps.apply([
    { op: 'set_project', name: 'Portal do cliente' },
    ...through(4),
    ...slugs.map((slug, i) => ({ op: 'set_spec', slug, title: ['Login', 'Pedidos', 'Chamados', 'Parceiros'][i], persona: 'Clientes', depends_on: i === 0 ? [] : i === 3 ? ['01-login-sso', '02-consultar-pedidos'] : ['01-login-sso'] })),
    ...slugs.map((spec) => ({ op: 'set_spec_review', spec, status: 'reviewed', by: 'Newton' })),
    { op: 'set_gate', gate: 'G3', status: 'passed' },
    { op: 'add_decision', question: 'Login', answer: 'Clientes entram com o login corporativo desde a primeira entrega', stage: 1 },
    { op: 'add_decision', question: 'Qual versão do BRD?', answer: 'v2', stage: 1 },
    { op: 'add_assumption', text: 'ERP fica fora', owner: 'Newton', stage: 1 },
    { op: 'add_assumption', text: 'Quem acompanha os logs', owner: 'Ana', stage: 2 },
  ]);
  if (!r.ok) throw new Error(r.error);
  const state = ps.load()!;
  const v: PipelineView = { flow: getFlow(state.flow), status: getPipelineStatus(plan), state, artifacts: [], markdownExists: true, report: buildReport(state, ps.tasks(), []) };
  const p = planFor(v)!;
  check('the totals are core\u2019s: 4 features, 11 tasks, 45 points', p.features === 4 && p.tasks === 11 && p.points === 45);
  check('the order says what is the base and what follows what', p.order.map((f) => f.note).join('|') === 'Base para todas as outras|Depois da 1|Depois da 1|Depois da 1 e da 2', p.order.map((f) => f.note).join('|'));
  check('every feature has its points and tasks, and the bar is relative to the largest', p.order[0].points === 11 && p.order[0].tasks === 3 && p.order[3].share === 1 && p.order[0].share < 1);
  check('a decision that is a sentence stands alone; one that is a word is read with its question', p.decisions[0] === 'Clientes entram com o login corporativo desde a primeira entrega' && p.decisions[1] === 'Qual versão do BRD? v2', JSON.stringify(p.decisions));
  check('what is open names who has it and at which step, in plain words', p.pending.length === 2 && p.pending[1].who === 'Ana' && p.pending[1].step === 'Desenhar a solução' && p.pending[0].step === 'Entender o pedido');
  check('nothing blocks this plan', p.blockers === 0);
  check('refs read as "1", "1 e 2" and "1, 2 e 3"', joinRefs(['1']) === '1' && joinRefs(['1', '2']) === '1 e 2' && joinRefs(['1', '2', '3']) === '1, 2 e 3' && joinRefs([]) === '');
  const messy = deliveryOrder([{ slug: 'c', dependsOn: ['a', 'b'] }, { slug: 'b', dependsOn: ['a'] }, { slug: 'a', dependsOn: [] }]).map((x) => x.slug).join('');
  const cycle = deliveryOrder([{ slug: 'x', dependsOn: ['y'] }, { slug: 'y', dependsOn: ['x'] }]).map((x) => x.slug).join('');
  check('features are delivered after what they depend on, and a cycle does not hang', messy === 'abc' && cycle.length === 2, `${messy} ${cycle}`);
  const md = planMarkdown(p, 'Portal do cliente', 'Embrapii');
  check('the summary as Markdown has the totals, the order, the decisions and what is open', md.startsWith('# Resumo do plano: Portal do cliente') && md.includes('Cliente: Embrapii') && md.includes('4 funcionalidades · 11 tarefas · 45 pontos de esforço') && md.includes('1. **Login** — Base para todas as outras') && md.includes('- Qual versão do BRD? v2') && md.includes('- Quem acompanha os logs (Ana · Desenhar a solução)'), md);
  const html = planHtml({ ...p, decisions: ['<script>alert(1)</script>'] }, 'A & B', 'Embrapii');
  check('the summary for printing escapes what the person wrote', html.startsWith('<!doctype html>') && !html.includes('<script>') && html.includes('&lt;script&gt;') && html.includes('A &amp; B'));
  check('with no report there is no plan', planFor({ ...v, report: undefined }) === null);
}

fs.rmSync(tmp, { recursive: true, force: true });
if (failures > 0) {
  console.log(`\n${failures} simple view logic check(s) failed.`);
  process.exit(1);
}
console.log('\nAll simple view logic checks passed.');
