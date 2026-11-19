/**
 * Unit tests for the pipeline intake's pure logic (A11): the list of files, what may start, and how a stopped pipeline is
 * described. The engine's answers are built by core's own `inspectInput`, so the rows are tested against what they will receive.
 * Run from desktop/: `npm run test:intake-logic`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getPipelineStatus, inspectInput, PipelineStateStore } from 'alia-harness/core';
import { makePdf } from '../../scripts/lib/pdfFixture';
import { addPaths, applyInspection, applyTranscript, canStart, describeStop, removeRow, rowProblem, rowState, startBlockedReason, toInputs, type IntakeRow } from '../src/renderer/src/lib/intake';

let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.log(`  ✘ ${name} ${extra}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alia-intake-ui-'));
const put = (name: string, data: string | Buffer) => {
  const f = path.join(tmp, name);
  fs.writeFileSync(f, data);
  return f;
};
const brd = put('BRD.pdf', makePdf([['Requisitos']]));
const scan = put('scan.pdf', makePdf([null]));
const video = put('kickoff.mp4', 'video');
const notes = put('kickoff-transcricao.txt', 'Ana: SSO.\n'.repeat(200));
const request = put('pedido.txt', 'um pedido curto');

/** Rows as the page builds them: added (loading), then answered by the engine. */
async function rowsFor(paths: string[]): Promise<IntakeRow[]> {
  const { rows } = addPaths([], paths);
  return applyInspection(rows, paths, await Promise.all(paths.map((p) => inspectInput(p))));
}

console.log('\n=== the list of files ===');
{
  const first = addPaths([], [brd, video]);
  check('files are added as rows that are still being checked', first.rows.length === 2 && first.rows.every((r) => r.loading && rowState(r) === 'loading') && first.added.length === 2);
  const again = addPaths(first.rows, [brd.toUpperCase(), request, request.replace(/\\/g, '/')]);
  check('the same file again (other case or slashes) is not added twice', again.added.length === 1 && again.rows.length === 3 && again.added[0] === request, JSON.stringify(again.added));
  const withTranscript = applyTranscript(again.rows, video, { path: notes });
  check('a transcript attached to a recording is not a new row, and cannot be added again as one', addPaths(withTranscript, [notes]).added.length === 0);
  check('rows can be removed', removeRow(again.rows, video).map((r) => r.path).join() === [brd, request].join());
  check('an answer from the engine goes only to the rows that asked', applyInspection(first.rows, [brd], [{ path: brd, name: 'BRD.pdf', size: 1, class: 'document', kind: 'document', needsTranscript: false, warnings: [] }]).filter((r) => !r.loading).length === 1);
  check('a failed inspection is shown on the row, and blocks it', rowState(applyInspection(first.rows, [brd], { error: 'outside the project folder' })[0]) === 'problem');
}

console.log('\n=== what may start ===');
{
  check('nothing at all cannot start, and says to add a file', !canStart([]) && startBlockedReason([]) === 'Adicione ao menos um arquivo.');
  check('while files are being checked it cannot start', !canStart(addPaths([], [brd]).rows) && startBlockedReason(addPaths([], [brd]).rows) === 'Conferindo os arquivos…');

  const ok = await rowsFor([brd, request]);
  check('readable files can start, with nothing in the way', canStart(ok) && startBlockedReason(ok) === undefined && ok.every((r) => rowState(r) === 'ok'));
  check('each shows the skill that will read it', ok[0].item?.handledBy === 'requirement-extraction-from-documents' && ok[1].item?.handledBy === 'ticket-to-brief');

  const withScan = await rowsFor([brd, scan]);
  check('a scanned PDF blocks the start, with the reader\'s explanation and a way forward', !canStart(withScan) && rowState(withScan[1]) === 'problem' && !!rowProblem(withScan[1]) && startBlockedReason(withScan) === 'Remova ou corrija os arquivos com problema para continuar.', rowProblem(withScan[1]));
  check('removing it lets the rest start', canStart(removeRow(withScan, scan)));

  const rec = await rowsFor([video]);
  check('a recording alone needs a transcript, and says so', rowState(rec[0]) === 'needs_transcript' && !canStart(rec) && startBlockedReason(rec) === 'Anexe a transcrição de cada gravação para continuar.' && rowProblem(rec[0]) === undefined);
  const attaching = applyTranscript(rec, video, { path: notes, loading: true });
  check('while the transcript is checked, it waits', rowState(attaching[0]) === 'loading' && !canStart(attaching));
  const inspected = await inspectInput(notes);
  const done = applyTranscript(rec, video, { path: notes, item: inspected });
  check('a readable transcript makes the recording usable', rowState(done[0]) === 'ok' && canStart(done) && done[0].transcript?.item?.class === 'transcript');
  const badT = applyTranscript(rec, video, { path: scan, item: await inspectInput(scan) });
  check('a transcript that cannot be read blocks it, naming the problem', rowState(badT[0]) === 'problem' && !!rowProblem(badT[0]));
  const asRecording = applyTranscript(rec, video, { path: video, item: await inspectInput(video) });
  check('a recording offered as the transcript does not count', rowState(asRecording[0]) === 'problem');
  check('removing the transcript brings back the need for one', rowState(applyTranscript(done, video, undefined)[0]) === 'needs_transcript');

  check('what is sent to the engine is each path, and the transcript of a recording', JSON.stringify(toInputs([...ok, ...done])) === JSON.stringify([{ path: brd }, { path: request }, { path: video, transcriptPath: notes }]));
}

console.log('\n=== describing where a pipeline stopped (from real states) ===');
{
  const ws = path.join(tmp, 'ws');
  fs.mkdirSync(ws);
  const store = new PipelineStateStore(ws);
  const q = (id: string) => ({ op: 'add_question', gate: 'G1', id, prompt: `Pergunta ${id}?` });
  store.apply([{ op: 'add_input', name: 'a.txt', input_kind: 'brief' }, { op: 'set_stage', stage: 1, status: 'running' }, q('q1'), q('q2'), q('q3'), q('q4'), q('q5')]);
  store.apply([{ op: 'answer_question', id: 'q1', answer: 'a' }, { op: 'answer_question', id: 'q2', answer: 'b' }, { op: 'defer_question', id: 'q3', owner: 'N' }]);
  const t = () => describeStop(getPipelineStatus(ws));
  check('at a gate with open questions, in the words of the design', t() === 'no Gate 1 (3 de 5 perguntas respondidas)', t());
  store.apply([{ op: 'answer_question', id: 'q4', answer: 'a' }, { op: 'answer_question', id: 'q5', answer: 'b' }, { op: 'set_stage', stage: 1, status: 'done' }]);
  check('all answered: waiting for the approval', t() === 'esperando você aprovar o Gate 1', t());
  store.apply([{ op: 'set_gate', gate: 'G1', status: 'passed' }]);
  check('a stage to run', t() === 'na etapa 2', t());
  fs.writeFileSync(path.join(ws, 'a.txt'), 'x');
  store.apply([{ op: 'add_input', name: 'a.txt', input_kind: 'brief', path: 'a.txt' }]);
  fs.writeFileSync(path.join(ws, 'a.txt'), 'changed');
  check('an input that changed', t() === 'com 1 entrada alterada desde o registro', t());
  fs.writeFileSync(path.join(ws, 'docs', 'pipeline', 'state.json'), '{ broken');
  check('a damaged state', t() === 'com um estado inválido');
  check('no state at all', describeStop(getPipelineStatus(path.join(tmp, 'none'))) === 'antes de começar');
}

fs.rmSync(tmp, { recursive: true, force: true });
if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll intake logic checks passed.');
