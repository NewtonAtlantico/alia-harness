/**
 * Unit tests for the pipeline run view's pure logic (A12): the stepper, the status chip, the gate card and the answers it sends.
 * The views are built from real states made by core's own store, step by step through a whole pipeline.
 * Run from desktop/: `npm run test:run-logic`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PipelineStateStore, getPipelineStatus } from 'alia-harness/core';
import type { PipelineView } from '../src/shared/ipc';
import { canResume, categoryLabel, finishAnswers, gateCardFor, isBlankText, partialAnswers, runChip, settledText, stepperFor, toUserQuestions } from '../src/renderer/src/lib/pipelineRun';

let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.log(`  ✘ ${name} ${extra}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alia-run-'));
const store = new PipelineStateStore(tmp);
const apply = (ops: unknown[]) => {
  const r = store.apply(ops);
  if (!r.ok) throw new Error(r.error);
};
const view = (): PipelineView => ({ status: getPipelineStatus(tmp), state: store.load(), artifacts: [], markdownExists: true });
const steps = (running = false) => stepperFor(view(), running).map((s) => `${s.id}:${s.state}${s.detail ? `(${s.detail})` : ''}`).join(' ');
const q = (id: string, extra: object = {}) => ({ op: 'add_question', gate: 'G1', id, prompt: `Pergunta ${id}?`, ...extra });

console.log('\n=== the stepper and the chip, from the start to the end ===');
{
  check('with no state there is nothing to show', runChip({ status: getPipelineStatus(tmp), artifacts: [], markdownExists: false }, false) === null && gateCardFor({ status: getPipelineStatus(tmp), artifacts: [], markdownExists: false }) === null);

  apply([{ op: 'add_input', name: 'a.pdf', input_kind: 'document' }, { op: 'add_input', name: 'b.txt', input_kind: 'brief' }]);
  check('inputs registered: Entradas is done, with how many; the stages wait', steps() === 'inputs:done(2 arquivos) 1:pending 2:pending 3:pending 4:pending', steps());
  check('not running: "Parado na etapa 1", and it can be resumed', runChip(view(), false)?.label === 'Parado na etapa 1' && runChip(view(), false)?.tone === 'idle' && canResume(view(), false));
  check('running: "Executando a etapa 1", nothing to resume, and the stage is active', runChip(view(), true)?.label === 'Executando a etapa 1' && runChip(view(), true)?.tone === 'running' && !canResume(view(), true) && steps(true).includes('1:active'), steps(true));

  apply([{ op: 'set_stage', stage: 1, status: 'running' }, q('q1', { category: 'contradiction' }), q('q2'), q('q3')]);
  apply([{ op: 'answer_question', id: 'q1', answer: 'a' }]);
  check('a gate with open questions: the stage waits, with the progress', steps() === 'inputs:done(2 arquivos) 1:waiting(1/3) 2:pending 3:pending 4:pending', steps());
  check('the chip asks for the answers (and says "executando" while the model is still working)', runChip(view(), false)?.label === 'Aguardando suas respostas' && runChip(view(), false)?.tone === 'waiting' && runChip(view(), true)?.label === 'Executando a etapa 1');
  apply([{ op: 'defer_question', id: 'q2', owner: 'Newton' }]);
  check('deferred questions count as handled in the progress', steps().includes('1:waiting(2/3)'), steps());

  apply([{ op: 'answer_question', id: 'q3', answer: 'c' }, { op: 'set_stage', stage: 1, status: 'done' }]);
  check('all settled, gate not approved: it waits for the decision', steps().includes('1:waiting(aprovar)') && runChip(view(), false)?.label === 'Aguardando sua decisão', steps());
  apply([{ op: 'set_gate', gate: 'G1', status: 'passed' }]);
  check('approved: stage 1 is done and says so, the chip is back to "parado"', steps().includes('1:done(aprovado)') && runChip(view(), false)?.label === 'Parado na etapa 2', steps());

  apply([{ op: 'set_stage', stage: 2, status: 'running' }, { op: 'set_stage', stage: 2, status: 'done' }, { op: 'set_gate', gate: 'G2', status: 'passed' }, { op: 'set_stage', stage: 3, status: 'running' }, { op: 'set_stage', stage: 3, status: 'done' }, { op: 'set_spec_review', spec: 'login', status: 'in_review' }]);
  check('specs awaiting a human review: that is its own chip', runChip(view(), false)?.label === 'Aguardando revisão das specs' && steps().includes('3:waiting(aprovar)'), steps() + ' | ' + runChip(view(), false)?.label);
  apply([{ op: 'set_spec_review', spec: 'login', status: 'reviewed' }, { op: 'set_gate', gate: 'G3', status: 'passed' }, { op: 'set_stage', stage: 4, status: 'running' }, { op: 'set_stage', stage: 4, status: 'done' }]);
  check('everything done: "Pipeline concluído", all stages done, nothing to resume', runChip(view(), false)?.label === 'Pipeline concluído' && runChip(view(), false)?.tone === 'done' && steps() === 'inputs:done(2 arquivos) 1:done(aprovado) 2:done(aprovado) 3:done(aprovado) 4:done' && !canResume(view(), false), steps());

  apply([{ op: 'mark_stale', after_stage: 1, reason: 'requirements changed' }]);
  check('stale stages are shown as to redo', steps().includes('2:stale') && steps().includes('3:stale'), steps());
}

console.log('\n=== inputs that changed, a damaged state ===');
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'alia-run2-'));
  const s2 = new PipelineStateStore(ws);
  fs.writeFileSync(path.join(ws, 'a.txt'), 'one');
  s2.apply([{ op: 'add_input', name: 'a.txt', input_kind: 'brief', path: 'a.txt' }]);
  fs.writeFileSync(path.join(ws, 'a.txt'), 'two');
  const changed: PipelineView = { status: getPipelineStatus(ws), state: s2.load(), artifacts: [], markdownExists: true };
  check('a changed input marks Entradas and the chip', stepperFor(changed, false)[0].state === 'stale' && runChip(changed, false)?.label === 'Entradas mudaram' && runChip(changed, false)?.tone === 'warn');
  fs.writeFileSync(path.join(ws, 'docs', 'pipeline', 'state.json'), '{ broken');
  const damaged: PipelineView = { status: getPipelineStatus(ws), artifacts: [], markdownExists: true };
  check('a damaged state is a warning, with nothing to resume and no gate card', runChip(damaged, false)?.label === 'Estado inválido' && !canResume(damaged, false) && gateCardFor(damaged) === null);
}

console.log('\n=== the gate card ===');
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'alia-run3-'));
  const s3 = new PipelineStateStore(ws);
  s3.apply([
    { op: 'add_input', name: 'a.pdf', input_kind: 'document' },
    { op: 'set_stage', stage: 1, status: 'running' },
    { op: 'add_question', gate: 'G1', id: 'q1', prompt: 'Qual versão é a oficial?', kind: 'choice', category: 'contradiction', source: 'BRD_v2.pdf · p. 14', confidence: 'low', options: [{ id: 'v2', label: 'v2', detail: 'a mais recente', source: 'BRD_v2.pdf' }, { id: 'v3', label: 'v3' }] },
    { op: 'add_question', gate: 'G1', id: 'q2', prompt: 'Quantos usuários simultâneos?', kind: 'text', category: 'low_confidence' },
    { op: 'add_question', gate: 'G1', id: 'q3', prompt: 'Há integração com o ERP?', kind: 'confirm', category: 'blocker' },
    { op: 'add_question', gate: 'G1', id: 'q4', prompt: 'Pergunta antiga?', kind: 'text' },
  ]);
  s3.apply([{ op: 'answer_question', id: 'q4', answer: 'sim', by: 'Ana', date: '2026-11-18' }]);
  const v = (): PipelineView => ({ status: getPipelineStatus(ws), state: s3.load(), artifacts: [], markdownExists: true });
  const card = gateCardFor(v())!;
  check('it is for the gate the pipeline waits at, with its stage', card.gate === 'G1' && card.stage === 1 && card.title === 'Gate 1 · Requisitos' && !card.ready);
  check('answered questions are apart from the open ones, in order', card.settled.map((x) => x.id).join() === 'q4' && card.open.map((x) => x.id).join() === 'q1,q2,q3');
  check('categories read as in the design', categoryLabel(card.open[0]) === 'Contradição entre documentos' && categoryLabel(card.open[1]) === 'Baixa confiança' && categoryLabel(card.open[2]) === 'Bloqueia as specs' && categoryLabel(card.settled[0]) === undefined);
  check('a settled question reads as its answer, with a label for a choice and Sim/Não for a yes/no', settledText(card.settled[0]) === 'sim');

  const qs = toUserQuestions(card.open);
  check('the open questions become form questions: options keep their detail and source, a choice allows another answer, everything can be deferred', qs[0].options?.[0].source === 'BRD_v2.pdf' && qs[0].options?.[0].detail === 'a mais recente' && qs[0].allowOther === true && qs.every((x) => x.allowDefer === true) && qs[0].confidence === 'low' && qs[1].allowOther === undefined);

  const forms = { q1: { choice: 'v2' } };
  check('a partial form sends only what is filled in, and is not complete (the others are not blank text)', partialAnswers(qs, forms, 'Newton').length === 1 && finishAnswers(qs, forms, 'Newton').complete === false);
  const all = { q1: { choice: 'v3' }, q3: { confirm: false } };
  const fin = finishAnswers(qs, all, 'Newton');
  check('a blank text question is registered as an assumption owned by the user, so the gate can finish', isBlankText(qs[1], all) && fin.complete && JSON.stringify(fin.answers) === JSON.stringify([{ id: 'q1', answer: 'v3' }, { id: 'q2', deferred: true, owner: 'Newton' }, { id: 'q3', answer: false }]), JSON.stringify(fin));
  check('...but not without a name to own it', finishAnswers(qs, all, '  ').complete === false);
  check('a typed text answer is an answer, not a deferral', JSON.stringify(finishAnswers(qs, { ...all, q2: { text: '200' } }, 'Newton').answers[1]) === JSON.stringify({ id: 'q2', answer: '200' }));
  check('an explicit deferral keeps the owner the user typed', JSON.stringify(finishAnswers(qs, { ...all, q2: { deferred: true, owner: 'Ana' } }, 'Newton').answers[1]) === JSON.stringify({ id: 'q2', deferred: true, owner: 'Ana' }));

  s3.apply([{ op: 'answer_question', id: 'q1', answer: 'v2' }, { op: 'defer_question', id: 'q2', owner: 'Newton' }, { op: 'answer_question', id: 'q3', answer: false }, { op: 'set_stage', stage: 1, status: 'done' }]);
  const ready = gateCardFor(v())!;
  check('with nothing open, the card is only the approval', ready.ready && ready.open.length === 0 && ready.settled.length === 4);
  check('a deferred question reads as an assumption of its owner, a yes/no as Sim/Não, a choice by its label', settledText(ready.settled.find((x) => x.id === 'q2')!) === 'adiada, suposição de Newton' && settledText(ready.settled.find((x) => x.id === 'q3')!) === 'Não' && settledText(ready.settled.find((x) => x.id === 'q1')!) === 'v2');
  s3.apply([{ op: 'set_gate', gate: 'G1', status: 'passed' }]);
  check('after the approval there is no card', gateCardFor(v()) === null);
}

fs.rmSync(tmp, { recursive: true, force: true });
if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll run logic checks passed.');
