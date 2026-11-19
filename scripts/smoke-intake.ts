import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AliaConfig } from '../src/core/config.js';
import { createSession } from '../src/core/session.js';
import { bundledSkillsDir } from '../src/core/skills/skillLoader.js';
import { PipelineStateStore, STATE_FILE } from '../src/core/pipeline/pipelineState.js';
import { getPipelineStatus } from '../src/core/pipeline/pipelineStatus.js';
import { SHORT_REQUEST_BYTES, classifyInput, inspectInput, inventoryPath, planPipelineInputs } from '../src/core/pipeline/intake.js';
import { FakeModel } from './lib/fakeModel.js';
import { makeDocx, w } from './lib/officeFixture.js';
import { makePdf } from './lib/pdfFixture.js';

let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.log(`  ✘ ${name} ${extra}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alia-intake-'));
const ws = path.join(tmp, 'projeto');
const away = path.join(tmp, 'downloads');
fs.mkdirSync(path.join(ws, 'docs'), { recursive: true });
fs.mkdirSync(away, { recursive: true });
const put = (dir: string, name: string, data: string | Uint8Array) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, data);
  return file;
};

const brd = put(ws + '/docs', 'BRD_v2.pdf', makePdf([['Requisitos do portal'], ['Segunda página']]));
const docx = put(away, 'SOW.docx', makeDocx({ body: w.p('Escopo do contrato: portal do cliente.') }));
const scan = put(away, 'scan.pdf', makePdf([null, null]));
const old = put(away, 'proposta.doc', 'binary-ish');
const recording = put(away, 'reuniao-kickoff.mp4', 'not really a video');
const transcript = put(away, 'kickoff-transcricao.txt', 'Ana: precisamos de SSO.\n'.repeat(120));
const request = put(away, 'pedido.txt', 'Adicionar um botão de exportar na lista de pedidos.');
const longNote = put(away, 'visao-geral.md', '# Visão geral\n' + 'Texto sobre o produto.\n'.repeat(120));
const vtt = put(away, 'legenda.vtt', 'WEBVTT\n\n00:00.000 --> 00:02.000\nOlá\n');
const exe = put(away, 'setup.exe', 'MZ');
const empty = put(away, 'vazio.txt', '');

console.log('\n=== classifying by extension and size (nothing is read) ===');
{
  const c = (f: string) => classifyInput(f);
  check('a PDF, a Word file: documents, read by the documents skill', c(brd).class === 'document' && c(brd).handledBy === 'requirement-extraction-from-documents' && c(docx).class === 'document' && c(docx).kind === 'document');
  check('a small text file is a short request, read by ticket-to-brief', c(request).class === 'request' && c(request).kind === 'brief' && c(request).handledBy === 'ticket-to-brief' && c(request).size <= SHORT_REQUEST_BYTES);
  check('a long one named like a transcript is a transcript, by the threads skill', c(transcript).class === 'transcript' && c(transcript).handledBy === 'requirement-extraction-from-threads');
  check('a long text file with another name is a document', c(longNote).class === 'document' && c(longNote).handledBy === 'requirement-extraction-from-documents');
  check('subtitles are a transcript', c(vtt).class === 'transcript');
  check('audio and video are recordings: no skill reads them, a transcript is needed', c(recording).class === 'recording' && c(recording).kind === 'recording' && c(recording).needsTranscript && !c(recording).handledBy);
  check('an old binary Office file is its own class', c(old).class === 'legacy');
  check('an unknown type is unsupported, with a reason', c(exe).class === 'unsupported' && c(exe).problem!.includes('not a supported document type'));
  check('a missing file says so', classifyInput(path.join(away, 'nao-existe.pdf')).class === 'missing' && classifyInput(away).class === 'unsupported');
}

console.log('\n=== inspecting: what cannot be read is explained in readDocument\'s own words ===');
{
  const good = await inspectInput(brd);
  check('a readable PDF has no problem and keeps its skill', !good.problem && good.handledBy === 'requirement-extraction-from-documents', JSON.stringify(good));
  check('a Word file is readable', !(await inspectInput(docx)).problem);
  const s = await inspectInput(scan);
  check('a scanned PDF is refused with the reader\'s explanation (and has no skill)', !!s.problem && /scan|no (selectable )?text|image/i.test(s.problem) && !s.handledBy, s.problem);
  const o = await inspectInput(old);
  check('a .doc is refused, and the message says to save it as .docx', !!o.problem && o.problem.includes('.docx'), o.problem);
  const r = await inspectInput(recording);
  check('a recording says to send a transcript', r.needsTranscript && !!r.problem && r.problem.includes('transcript'), r.problem);
  check('an empty text file is refused', (await inspectInput(empty)).problem === '"vazio.txt" is empty.');
}

console.log('\n=== planning: every file must be usable; a recording needs its transcript ===');
{
  const ok = await planPipelineInputs([{ path: brd }, { path: docx }, { path: request }]);
  check('readable files make a plan, in order', ok.problems.length === 0 && ok.entries.map((e) => e.item.name).join() === 'BRD_v2.pdf,SOW.docx,pedido.txt');
  const dup = await planPipelineInputs([{ path: brd }, { path: brd }]);
  check('the same file twice is one input', dup.entries.length === 1);

  const bad = await planPipelineInputs([{ path: brd }, { path: scan }, { path: old }, { path: recording }, { path: exe }]);
  check('each unusable file is reported, by name, and the usable ones are kept apart', bad.problems.map((p) => p.name).join() === 'scan.pdf,proposta.doc,reuniao-kickoff.mp4,setup.exe' && bad.entries.length === 1);
  check('...with a message each', bad.problems.every((p) => p.message.length > 10));

  const withT = await planPipelineInputs([{ path: recording, transcriptPath: transcript }]);
  check('a recording with a readable transcript is recorded together with it', withT.problems.length === 0 && withT.entries.length === 2 && withT.entries[0].item.kind === 'recording' && withT.entries[1].item.kind === 'transcript' && withT.entries[1].item.handledBy === 'requirement-extraction-from-threads');
  check('the recording is noted as not read, and the transcript as standing in for it', withT.entries[0].notes!.includes('Not read') && withT.entries[0].notes!.includes('kickoff-transcricao.txt') && withT.entries[1].notes === 'Transcript of reuniao-kickoff.mp4.');
  const badT = await planPipelineInputs([{ path: recording, transcriptPath: scan }]);
  check('a transcript that cannot be read does not count', badT.problems.length === 1 && badT.problems[0].name === 'scan.pdf');
  const none = await planPipelineInputs([]);
  check('nothing at all is a problem too', none.problems.length === 1);
}

console.log('\n=== starting: the inventory is written first ===');
{
  const config: AliaConfig = { name: 't', vendor: 't', apiKey: 'k', apiType: 'chat-completions', models: [{ id: 'fake-model', name: 'fake', url: 'http://fake', toolCalling: true }] };
  const open = (dir: string) => createSession({ workspace: dir, config, client: new FakeModel([]).client, skillRoots: [{ label: 'bundled', dir: bundledSkillsDir() }], permissionsDir: path.join(tmp, 'perm') });

  const session = open(ws);
  const refused = await session.startPipelinePrompt([{ path: brd }, { path: scan }]);
  check('one unreadable file refuses everything, and writes nothing', refused.status === 'refused' && refused.problems[0].name === 'scan.pdf' && !fs.existsSync(path.join(ws, STATE_FILE)));

  const started = await session.startPipelinePrompt([{ path: brd }, { path: docx }, { path: recording, transcriptPath: transcript }, { path: request }]);
  if (started.status !== 'ready') throw new Error('expected ready: ' + JSON.stringify(started));
  const state = new PipelineStateStore(ws).load()!;
  check('state.json exists before any run, with the project and every input', state.project === 'projeto' && state.inputs.map((i) => i.name).join() === 'BRD_v2.pdf,SOW.docx,reuniao-kickoff.mp4,kickoff-transcricao.txt,pedido.txt');
  const byName = Object.fromEntries(state.inputs.map((i) => [i.name, i]));
  check('each has its kind and the skill that reads it', byName['BRD_v2.pdf'].kind === 'document' && byName['BRD_v2.pdf'].handledBy === 'requirement-extraction-from-documents' && byName['pedido.txt'].kind === 'brief' && byName['kickoff-transcricao.txt'].kind === 'transcript' && byName['reuniao-kickoff.mp4'].kind === 'recording' && !byName['reuniao-kickoff.mp4'].handledBy);
  const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  check('each has the hash and size of the file as it was', byName['BRD_v2.pdf'].hash === sha(brd) && byName['SOW.docx'].hash === sha(docx) && byName['BRD_v2.pdf'].size === fs.statSync(brd).size);
  check('a file in the project is recorded relative to it, one outside by its full path', byName['BRD_v2.pdf'].path === 'docs/BRD_v2.pdf' && byName['SOW.docx'].path === path.resolve(docx) && inventoryPath(ws, docx) === path.resolve(docx));
  check('the inventory is also in STATE.md', fs.readFileSync(path.join(ws, 'docs', 'pipeline', 'STATE.md'), 'utf8').includes('BRD_v2.pdf'));
  check('the prompt carries the pipeline skill, loaded, and the inputs with their skills', started.prompt.includes('<skill name="requirements-to-tasks-pipeline"') && started.prompt.includes('docs/BRD_v2.pdf') && started.prompt.includes('requirement-extraction-from-threads') && started.prompt.includes('already inventoried') && !started.resumed);
  check('the status afterwards reads the inventory and starts at stage 1', getPipelineStatus(ws).next.kind === 'run_stage' && getPipelineStatus(ws).staleInputs.length === 0);

  fs.writeFileSync(brd, makePdf([['Requisitos do portal, editados']]));
  check('a file changed after the inventory is noticed (that is what the hash is for)', getPipelineStatus(ws).staleInputs.length === 1 && getPipelineStatus(ws).next.kind === 'inputs_changed');

  const again = await open(ws).startPipelinePrompt([{ path: docx }, { path: put(away, 'extra.docx', makeDocx({ body: w.p('Outro documento.') })) }]);
  const after = new PipelineStateStore(ws).load()!;
  check('starting on a project that already has a pipeline adds to it (the same name is replaced) and says so', again.status === 'ready' && again.resumed && after.inputs.length === 6 && after.project === 'projeto' && again.prompt.includes('already exists'), again.status === 'ready' ? again.prompt.slice(0, 300) : '');

  const damaged = path.join(tmp, 'damaged');
  fs.mkdirSync(path.join(damaged, 'docs', 'pipeline'), { recursive: true });
  fs.writeFileSync(path.join(damaged, STATE_FILE), '{ nope');
  const d = await open(damaged).startPipelinePrompt([{ path: docx }]);
  check('a damaged state is never overwritten', d.status === 'refused' && fs.readFileSync(path.join(damaged, STATE_FILE), 'utf8') === '{ nope');
}

fs.rmSync(tmp, { recursive: true, force: true });
if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll pipeline intake checks passed.');
