import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AliaConfig } from '../src/core/config.js';
import { createSession } from '../src/core/session.js';
import { bundledSkillsDir } from '../src/core/skills/skillLoader.js';
import { DEFAULT_FLOW_ID, EMBRAPII_FLOW, FLOWS, PipelineFlow, findFlow, getFlow } from '../src/core/pipeline/flows.js';
import { PipelineStateStore, STAGES, STATE_FILE, applyOps, newState, normalizeState } from '../src/core/pipeline/pipelineState.js';
import { classifyInput, describeFlow, describePipelineStart } from '../src/core/pipeline/intake.js';
import { getPipelineStatus } from '../src/core/pipeline/pipelineStatus.js';
import { FakeModel } from './lib/fakeModel.js';
import { makePdf } from './lib/pdfFixture.js';

/**
 * Flows: the skills and the steps the pipeline runs for one kind of project. Embrapii is the flow the pipeline has always run, and
 * it has to stay exactly that; a second flow (made up here) shows that what runs comes from the flow and not from the code.
 */

let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.log(`  ✘ ${name} ${extra}`);
  }
}

const NOW = new Date('2026-11-18T12:00:00Z');
const OTHER: PipelineFlow = {
  id: 'outro',
  name: 'Outro',
  description: 'Um fluxo de teste.',
  orchestrator: 'requirements-to-tasks-pipeline',
  stages: EMBRAPII_FLOW.stages.map((s) => ({ ...s, skill: `outro-${s.key}`, artifact: s.artifact.replace('docs/', 'docs/outro/') })),
  intake: { documents: 'outro-documents', threads: 'outro-threads', brief: 'outro-brief' },
};

console.log('\n=== the flows ===');
{
  check('Embrapii is the first flow and the default', FLOWS[0].id === 'embrapii' && DEFAULT_FLOW_ID === 'embrapii' && FLOWS.length === 1);
  check('a flow is found by its id, and the default one by none', findFlow('embrapii') === EMBRAPII_FLOW && findFlow() === EMBRAPII_FLOW && findFlow('') === EMBRAPII_FLOW);
  check('an id no flow has is not a flow, and `getFlow` falls back to the default (a state written by a newer version)', findFlow('nao-existe') === undefined && getFlow('nao-existe') === EMBRAPII_FLOW);
  check('it has four stages with their skills, artifacts and gates, as the pipeline always had', EMBRAPII_FLOW.stages.map((s) => `${s.stage}:${s.skill}:${s.gate ?? '-'}`).join(' ') === '1:requirement-extraction-from-documents:G1 2:architecture-from-requirements:G2 3:constitution-to-specs:G3 4:spec-to-tasks:-');
  check('`STAGES` is still the default flow’s list', STAGES.length === 4 && STAGES.every((s, i) => s.skill === EMBRAPII_FLOW.stages[i].skill && s.artifact === EMBRAPII_FLOW.stages[i].artifact && s.gate === EMBRAPII_FLOW.stages[i].gate));
  check('every stage has a name and, for the simple view, a title, a line and whether the person takes part', EMBRAPII_FLOW.stages.every((s) => s.label && s.simple.title && s.simple.description) && EMBRAPII_FLOW.stages.map((s) => s.simple.participates).join() === 'true,false,true,false');
  check('every skill the flow names exists in the bundled skills', [...EMBRAPII_FLOW.stages.map((s) => s.skill), ...Object.values(EMBRAPII_FLOW.intake), EMBRAPII_FLOW.orchestrator].every((name) => fs.readdirSync(bundledSkillsDir()).some((dir) => fs.existsSync(path.join(bundledSkillsDir(), dir, 'SKILL.md')) && fs.readFileSync(path.join(bundledSkillsDir(), dir, 'SKILL.md'), 'utf8').match(/^name:\s*(.+)$/m)?.[1].trim() === name || dir === name)));
}

console.log('\n=== the state carries its flow ===');
{
  const plain = newState(NOW);
  check('a state made with no flow is written as before (no `flow` field), and reads as the default', plain.flow === undefined && normalizeState(JSON.parse(JSON.stringify(plain))).flow === undefined && !JSON.stringify(plain).includes('"flow"'));
  const other = newState(NOW, OTHER);
  check('a state made for a flow has that flow’s stages', other.flow === 'outro' && other.stages.map((s) => s.skill).join() === 'outro-requirements,outro-architecture,outro-specs,outro-tasks' && other.stages[0].artifact === 'docs/outro/requirements/requirements.md');

  const set = applyOps(plain, [{ op: 'set_flow', flow: 'embrapii' }], { now: NOW });
  check('`set_flow` records the flow before anything has run', set.ok && set.state.flow === 'embrapii');
  const bad = applyOps(plain, [{ op: 'set_flow', flow: 'nao-existe' }], { now: NOW });
  check('an unknown flow is refused, and nothing changes', !bad.ok && bad.error.includes('known flow') && bad.error.includes('Nothing was changed'));
  const started = applyOps(plain, [{ op: 'set_stage', stage: 1, status: 'running' }], { now: NOW });
  if (!started.ok) throw new Error(started.error);
  const same = applyOps(started.state, [{ op: 'set_flow', flow: 'embrapii' }], { now: NOW });
  check('saying the flow it already runs is fine once work has started', same.ok && same.state.flow === 'embrapii' && same.state.stages[0].status === 'running');
  const noMid = applyOps(started.state, [{ op: 'set_flow', flow: 'embrapii' }, { op: 'set_stage', stage: 2, status: 'pending' }], { now: NOW });
  check('(and the other operations go on as usual)', noMid.ok);
}

console.log('\n=== the intake reads files with the flow’s skills ===');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alia-flows-'));
  const doc = path.join(tmp, 'BRD.pdf');
  const note = path.join(tmp, 'ata-reuniao.md');
  const ask = path.join(tmp, 'pedido.txt');
  fs.writeFileSync(doc, makePdf([['Requisitos']]));
  fs.writeFileSync(note, 'Texto da ata.\n'.repeat(200));
  fs.writeFileSync(ask, 'Adicionar um botão.');
  check('with no flow named the skills are the default flow’s', classifyInput(doc).handledBy === 'requirement-extraction-from-documents' && classifyInput(note).handledBy === 'requirement-extraction-from-threads' && classifyInput(ask).handledBy === 'ticket-to-brief');
  check('another flow reads the same files with its own skills', classifyInput(doc, OTHER).handledBy === 'outro-documents' && classifyInput(note, OTHER).handledBy === 'outro-threads' && classifyInput(ask, OTHER).handledBy === 'outro-brief');
  const text = describeFlow(EMBRAPII_FLOW);
  check('the flow is described to the orchestrator with each stage’s skill and artifact', text.startsWith('Flow: Embrapii (embrapii).') && text.includes('Stage 3 (specs): skill constitution-to-specs, writes docs/specs/INDEX.md; gate G3 follows') && text.includes('Stage 4 (tasks): skill spec-to-tasks, writes docs/tasks/') && !text.includes('Stage 4 (tasks): skill spec-to-tasks, writes docs/tasks/; gate'));
  check('and it is in the text that starts the pipeline', describePipelineStart(tmp, [], false, OTHER).includes('Flow: Outro (outro).') && describePipelineStart(tmp, [], false).includes('Flow: Embrapii (embrapii).'));

  const config: AliaConfig = { name: 't', vendor: 't', apiKey: 'k', apiType: 'chat-completions', models: [{ id: 'fake-model', name: 'fake', url: 'http://fake', toolCalling: true }] };
  const open = (dir: string) => createSession({ workspace: dir, config, client: new FakeModel([]).client, skillRoots: [{ label: 'bundled', dir: bundledSkillsDir() }], permissionsDir: path.join(tmp, 'perm') });

  console.log('\n=== starting in a flow ===');
  const ws = path.join(tmp, 'projeto');
  fs.mkdirSync(ws);
  const unknown = await open(ws).startPipelinePrompt([{ path: doc }], { flow: 'nao-existe' });
  check('a flow that does not exist refuses the start, and writes nothing', unknown.status === 'refused' && unknown.problems[0].message.includes('no flow') && !fs.existsSync(path.join(ws, STATE_FILE)));

  const first = await open(ws).startPipelinePrompt([{ path: doc }, { path: ask }], { flow: 'embrapii', project: 'Portal do cliente' });
  if (first.status !== 'ready') throw new Error(JSON.stringify(first));
  const state = new PipelineStateStore(ws).load()!;
  check('the flow chosen is recorded in the state, with the name the person gave the project', state.flow === 'embrapii' && state.project === 'Portal do cliente');
  check('the prompt tells the orchestrator which flow it runs', first.prompt.includes('Flow: Embrapii (embrapii).') && first.prompt.includes('<skill name="requirements-to-tasks-pipeline"'));
  const status = getPipelineStatus(ws);
  check('the status says which flow the pipeline runs, and so does the text for resuming it', status.flow === 'embrapii' && status.resumePrompt.includes('Flow: Embrapii (embrapii).'));
  const resumed = await open(ws).resumePipelinePrompt();
  check('resuming loads the pipeline skill of the flow', resumed.prompt?.includes('<skill name="requirements-to-tasks-pipeline"') === true);

  // A second flow, registered for this test only: what runs comes from the flow.
  (FLOWS as PipelineFlow[]).push(OTHER);
  const again = await open(ws).startPipelinePrompt([{ path: note }], { flow: 'outro' });
  const after = new PipelineStateStore(ws).load()!;
  check('adding to a pipeline that already exists keeps its flow, whatever is asked', again.status === 'ready' && after.flow === 'embrapii' && again.prompt.includes('Flow: Embrapii') && after.stages[0].skill === 'requirement-extraction-from-documents');

  const wsOther = path.join(tmp, 'outro');
  fs.mkdirSync(wsOther);
  const second = await open(wsOther).startPipelinePrompt([{ path: doc }, { path: ask }], { flow: 'outro' });
  const stateOther = new PipelineStateStore(wsOther).load()!;
  check('a pipeline started in another flow runs that flow’s skills, reads the files with them and says so', second.status === 'ready' && stateOther.flow === 'outro' && stateOther.stages.map((s) => s.skill).join() === 'outro-requirements,outro-architecture,outro-specs,outro-tasks' && stateOther.inputs.map((i) => i.handledBy).join() === 'outro-documents,outro-brief' && second.prompt.includes('Stage 1 (requirements): skill outro-requirements'));
  const statusOther = getPipelineStatus(wsOther);
  check('its status and its next step follow the flow', statusOther.flow === 'outro' && statusOther.next.kind === 'run_stage' && (statusOther.next as { skill: string }).skill === 'outro-requirements' && statusOther.stages[0].skill === 'outro-requirements');
  (FLOWS as PipelineFlow[]).pop();

  const legacy = path.join(tmp, 'legado');
  fs.mkdirSync(path.join(legacy, 'docs', 'pipeline'), { recursive: true });
  fs.writeFileSync(path.join(legacy, STATE_FILE), JSON.stringify(newState(NOW)));
  const old = getPipelineStatus(legacy);
  check('a state written before flows existed runs the default flow', old.exists && old.flow === 'embrapii' && old.stages.length === 4);

  const noFlow = path.join(tmp, 'sem-fluxo');
  fs.mkdirSync(noFlow);
  const plain = await open(noFlow).startPipelinePrompt([{ path: doc }]);
  check('starting with no flow named runs the default one', plain.status === 'ready' && new PipelineStateStore(noFlow).load()!.flow === 'embrapii');
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`\n${failures} flow check(s) failed.`);
  process.exit(1);
}
console.log('\nAll flow checks passed.');
