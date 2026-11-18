/**
 * The definition of done for backlog 002, as one story, with no UI:
 * a session is created and streams typed events; it reads a PDF and writes a file (tracked, then
 * reverted); it is cancelled in the middle of a command; the app "restarts" and the conversation is
 * resumed from disk; and the resumed session asks a gate question and records the answer in
 * state.json, with a rendered STATE.md.
 *
 * Each piece has its own suite; this checks that they work together.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import OpenAI from 'openai';
import { AgentEvent } from '../src/core/agent/events.js';
import { AliaConfig } from '../src/core/config.js';
import { createSession } from '../src/core/session.js';
import { SessionStore, messageText } from '../src/core/sessions/sessionStore.js';
import { STATE_FILE, STATE_MD_FILE } from '../src/core/pipeline/pipelineState.js';
import { FakeModel, ScriptedTurn } from './lib/fakeModel.js';
import { makePdf } from './lib/pdfFixture.js';

let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.log(`  ✘ ${name} ${extra}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alia-e2e-'));
const ws = path.join(tmp, 'portal-cliente');
const storeDir = path.join(tmp, 'sessions');
const permsDir = path.join(tmp, 'permissions');
fs.mkdirSync(path.join(ws, 'docs'), { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const json = (v: unknown) => JSON.stringify(v);
const posix = (p: string) => p.split(path.sep).join('/');
const config: AliaConfig = { name: 't', vendor: 't', apiKey: 'k', apiType: 'chat-completions', models: [{ id: 'fake-model', name: 'fake', url: 'http://fake', toolCalling: true }] };
const types = (evs: AgentEvent[]) => evs.map((e) => e.type);

// The inputs: a BRD as a PDF, and a long-running command that proves it is alive with a heartbeat.
fs.writeFileSync(
  path.join(ws, 'docs', 'BRD_PortalCliente_v2.pdf'),
  makePdf([
    ['Requisitos do portal', 'O cliente deve fazer login com autenticação corporativa.'],
    ['Parceiros externos usam o portal?', 'Sim, a partir da fase 2.'],
  ])
);
const hang = path.join(tmp, 'hang.js');
fs.writeFileSync(hang, "const fs = require('fs'); const f = process.argv[2]; fs.writeFileSync(f, String(process.pid)); setInterval(() => fs.writeFileSync(f + '.hb', String(Date.now())), 100);");
const pidFile = path.join(tmp, 'server.pid');
const hangCommand = `node "${posix(hang)}" "${posix(pidFile)}"`;
const beating = () => {
  try {
    return Date.now() - Number(fs.readFileSync(`${pidFile}.hb`, 'utf8')) < 700;
  } catch {
    return false;
  }
};

const lastTool = (req: { messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] }) => String(req.messages.filter((m) => m.role === 'tool').pop()?.content);
const store = new SessionStore({ dir: storeDir });

console.log('\n=== 1. a session streams typed events while it reads a PDF and writes a file ===');
const eventsA: AgentEvent[] = [];
const approvals: string[] = [];
const turnsA: ScriptedTurn[] = [
  { toolCalls: [{ name: 'read_file', args: { path: 'docs/BRD_PortalCliente_v2.pdf' }, id: 'r1' }, { name: 'write_file', args: { path: 'notes/resumo.md', content: '# Resumo\n\n- Login com SSO\n- Parceiros na fase 2\n' }, id: 'w1' }] },
  { content: 'Li o BRD e escrevi notes/resumo.md.' },
  { toolCalls: [{ name: 'run_bash', args: { command: hangCommand, timeout_ms: 60000 }, id: 'b1' }] },
  { content: 'unreachable: the run is cancelled before this' },
];
const modelA = new FakeModel(turnsA);
const sessionA = createSession({
  workspace: ws,
  config,
  client: modelA.client,
  skillRoots: [],
  sessionStore: store,
  sessionId: 'e2e',
  permissionMode: 'ask-commands',
  permissionsDir: permsDir,
  onConfirm: async (ctx) => {
    approvals.push(ctx.command);
    return 'allow_once';
  },
  onEvent: (e) => eventsA.push(e),
});
const run1 = await sessionA.run('Resuma o BRD e anote o essencial');
check('the run completes', run1.status === 'completed' && run1.text.includes('notes/resumo.md'));
check('events arrive in order, ending with run_finished', types(eventsA)[0] === 'run_started' && types(eventsA).at(-1) === 'run_finished' && types(eventsA).includes('tool_call_started'));
const readDone = eventsA.find((e) => e.type === 'tool_call_finished' && (e as any).id === 'r1') as any;
check('the PDF was read, with page markers and accents', readDone.result.includes('[p. 1]') && readDone.result.includes('autenticação corporativa') && readDone.result.includes('[p. 2]') && !readDone.isError);
const writeDone = eventsA.find((e) => e.type === 'tool_call_finished' && (e as any).id === 'w1') as any;
check('the write is reported as a created file, with line counts and no content', json(writeDone.changes) === json([{ path: 'notes/resumo.md', kind: 'created', added: 4, removed: 0 }]) && !json(writeDone.changes).includes('Login'));

console.log('\n=== 2. the change is tracked, shown as a diff, and reverted ===');
check('it is pending in the tracker', sessionA.changes.list().map((c) => c.path).join() === 'notes/resumo.md');
check('with a unified diff', sessionA.changes.diff('notes/resumo.md')!.includes('+++ b/notes/resumo.md') && sessionA.changes.diff('notes/resumo.md')!.includes('+- Login com SSO'));
const reverted = sessionA.changes.revert();
check('revert deletes the file and the folder it created', reverted.reverted.join() === 'notes/resumo.md' && !fs.existsSync(path.join(ws, 'notes')) && sessionA.changes.size === 0);

console.log('\n=== 3. cancelled in the middle of a command: it stops, and nothing is left running ===');
const controller = new AbortController();
const running = sessionA.run('Suba o servidor de testes', { signal: controller.signal });
for (let i = 0; i < 100 && !beating(); i++) await sleep(50);
check('the command asked for approval (ask-commands mode), with the tool call id, and was allowed once', approvals.length === 1 && approvals[0] === hangCommand && eventsA.some((e) => e.type === 'permission_requested' && (e as any).toolCallId === 'b1' && (e as any).canAlwaysAllow === true) && eventsA.some((e) => e.type === 'permission_resolved' && (e as any).decision === 'allow_once'));
check('the server is really running', beating());
const abortedAt = Date.now();
controller.abort();
const run2 = await running;
check('the run ends cancelled within a second', run2.status === 'cancelled' && Date.now() - abortedAt < 1000, `${run2.status} ${Date.now() - abortedAt}ms`);
let dead = false;
for (let i = 0; i < 80 && !dead; i++) {
  dead = !beating();
  if (!dead) await sleep(50);
}
check('the whole process tree is gone', dead);
const b1 = eventsA.find((e) => e.type === 'tool_call_finished' && (e as any).id === 'b1') as any;
check('the interrupted call shows as failed, with the cancelled marker', b1.isError === true && b1.result.startsWith('[Cancelled by user]'));
const liveA = sessionA.agent.getMessages();
const toolReplies = liveA.filter((m) => m.role === 'tool').map((m: any) => m.tool_call_id);
check('the history is valid: every call got a reply', toolReplies.join() === 'r1,w1,b1');

console.log('\n=== 4. everything was saved: the app can restart ===');
const saved = store.load('e2e')!;
check('the saved conversation equals the live one, cancelled turn included', json(saved.messages) === json(liveA) && saved.skipped === 0);
check('it is listed for this project with an automatic title', store.list({ workspace: ws })[0]?.id === 'e2e' && saved.info.title === 'Resuma o BRD e anote o essencial');
check('and nothing was written inside the workspace by the store', !fs.readdirSync(ws).includes('.alia') && fs.readdirSync(storeDir).length === 1);
sessionA.dispose();

console.log('\n=== 5. a new session resumes it, asks a gate question, and records the answer ===');
const eventsB: AgentEvent[] = [];
const asked: string[][] = [];
const ask = { id: 'q1', kind: 'choice', prompt: 'Qual versão do BRD é a oficial?', options: [{ id: 'v1', label: 'v1' }, { id: 'v2', label: 'v2 (BRD_PortalCliente_v2.pdf)', source: 'docs/BRD_PortalCliente_v2.pdf · p. 1' }], allowDefer: true };
const turnsB: ScriptedTurn[] = [
  { toolCalls: [{ name: 'pipeline_state', args: { action: 'update', ops: [{ op: 'set_project', name: 'Portal do cliente' }, { op: 'add_input', name: 'BRD_PortalCliente_v2.pdf', input_kind: 'document', path: 'docs/BRD_PortalCliente_v2.pdf' }, { op: 'set_stage', stage: 1, status: 'running' }, { op: 'add_question', gate: 'G1', id: 'q1', prompt: ask.prompt, kind: 'choice', options: ask.options, source: 'BRD v2' }] }, id: 'p1' }] },
  { toolCalls: [{ name: 'ask_user', args: { questions: [ask] }, id: 'a1' }] },
  (req) => {
    const heard = JSON.parse(lastTool(req));
    return { toolCalls: [{ name: 'pipeline_state', args: { action: 'update', ops: [{ op: 'answer_question', id: 'q1', answer: heard.answers[0].answer, by: 'Newton' }, { op: 'set_stage', stage: 1, status: 'done', artifact: 'docs/requirements/requirements.md' }, { op: 'set_gate', gate: 'G1', status: 'passed' }] }, id: 'p2' }] };
  },
  { content: 'Gate 1 fechado.' },
];
const modelB = new FakeModel(turnsB);
const sessionB = createSession({
  workspace: ws,
  config,
  client: modelB.client,
  skillRoots: [],
  sessionStore: store,
  resume: 'e2e',
  permissionsDir: permsDir,
  onEvent: (e) => eventsB.push(e),
  onAskUser: async (req) => {
    asked.push(req.questions.map((q) => q.id));
    return [{ id: 'q1', answer: 'v2' }];
  },
});
check('it carries on the same session, with the earlier conversation restored', sessionB.id === 'e2e' && json(sessionB.agent.getMessages().slice(1)) === json(liveA.slice(1)));
check('the PDF the first session read is still in its history', sessionB.agent.getMessages().some((m) => m.role === 'tool' && messageText(m).includes('[p. 1]')));
const run3 = await sessionB.run('Agora feche o gate 1 do pipeline');
check('the resumed run completes', run3.status === 'completed' && run3.text === 'Gate 1 fechado.');
check('the model was sent the earlier conversation plus the new request', modelB.requests[0].messages.length === liveA.length + 1 && messageText(modelB.requests[0].messages.at(-1)!) === 'Agora feche o gate 1 do pipeline');
check('the question reached the front-end, tied to its tool call', asked.length === 1 && asked[0].join() === 'q1' && eventsB.some((e) => e.type === 'tool_call_started' && (e as any).name === 'ask_user' && (e as any).id === 'a1'));

const state = JSON.parse(fs.readFileSync(path.join(ws, STATE_FILE), 'utf8'));
const q1 = state.gates[0].questions[0];
check("the user's answer is in state.json, with its label and who gave it", q1.status === 'answered' && q1.answer === 'v2' && q1.answerLabel.startsWith('v2') && q1.by === 'Newton');
check('the gate passed and the stage is done', state.gates[0].status === 'passed' && state.stages[0].status === 'done');
check('the input was inventoried with its hash', state.inputs[0].name === 'BRD_PortalCliente_v2.pdf' && /^[0-9a-f]{64}$/.test(state.inputs[0].hash));
const md = fs.readFileSync(path.join(ws, STATE_MD_FILE), 'utf8');
check('STATE.md was rendered from it', md.includes('# Pipeline state') && md.includes('G1: passed (1 of 1 answered)') && md.includes('| Qual versão do BRD é a oficial? | v2 (BRD_PortalCliente_v2.pdf) | Newton |'));
const status = sessionB.pipelineStatus();
check('and the pipeline knows what is next', status.next.kind === 'run_stage' && (status.next as any).stage === 2 && status.markdown === 'ok' && status.staleInputs.length === 0, status.summary);

const savedB = store.load('e2e')!;
check('the resumed conversation was saved too (one file, grown, nothing duplicated)', json(savedB.messages) === json(sessionB.agent.getMessages()) && savedB.messages.length > saved.messages.length);
check('it all happened through typed events', types(eventsB)[0] === 'run_started' && types(eventsB).at(-1) === 'run_finished' && eventsB.filter((e) => e.type === 'tool_call_finished').every((e: any) => e.isError === false));

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll end-to-end checks passed.');
