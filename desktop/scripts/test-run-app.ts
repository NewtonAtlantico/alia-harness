/**
 * The pipeline's run view (A12) in the REAL built app, against a fake model endpoint: the model records gate questions with the
 * real `pipeline_state` tool, and the page shows the stepper, the status chip and the gate card; the answers and the approval
 * are the user's and go straight into state.json; the pipeline goes on afterwards. Also Pausar/Retomar, a live question from
 * the model, the pipeline tab and opening STATE.md. Run from desktop/: `npm run test:run-app` (builds first).
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PipelineStateStore } from 'alia-harness/core';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { makePdf } from '../../scripts/lib/pdfFixture';
import { startFakeServer } from './lib/fakeServer';
import { sleep } from './lib/hang';

let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.log(`  ✘ ${name} ${extra}`);
  }
}

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!fs.existsSync(path.join(desktop, 'out', 'main', 'index.js'))) {
  console.error('The app is not built. Run `npm run build` in desktop/ first.');
  process.exit(2);
}

const KEY = 'sk-test-RUNKEY-12345678';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alia-run-'));
const project = path.join(tmp, 'projeto');
fs.mkdirSync(path.join(project, 'docs', 'requirements'), { recursive: true });
const outside = path.join(tmp, 'downloads');
fs.mkdirSync(outside);
const brd = path.join(outside, 'BRD_PortalCliente_v2.pdf');
fs.writeFileSync(brd, makePdf([['Requisitos do portal do cliente']]));
fs.writeFileSync(path.join(project, 'docs', 'requirements', 'requirements.md'), '# Requisitos\n');
const stateFile = path.join(project, 'docs', 'pipeline', 'state.json');
const loadState = () => new PipelineStateStore(project).load()!;

const ops = [
  { op: 'set_stage', stage: 1, status: 'running' },
  { op: 'add_question', gate: 'G1', id: 'q0', prompt: 'O portal atende parceiros?', kind: 'confirm' },
  { op: 'answer_question', id: 'q0', answer: true, by: 'Ana', date: '2026-11-18' },
  { op: 'add_question', gate: 'G1', id: 'q1', prompt: 'Qual versão do BRD é a oficial?', kind: 'choice', category: 'contradiction', source: 'BRD_v2.pdf · p. 14', confidence: 'low', options: [{ id: 'v2', label: 'v2', detail: 'a mais recente', source: 'BRD_v2.pdf' }, { id: 'v3', label: 'v3', source: 'kickoff.pdf' }] },
  { op: 'add_question', gate: 'G1', id: 'q2', prompt: 'Quantos usuários simultâneos o portal deve suportar?', kind: 'text', category: 'low_confidence', source: 'BRD_v2.pdf · p. 9' },
  { op: 'add_question', gate: 'G1', id: 'q3', prompt: 'A integração com o ERP entra no MVP?', kind: 'confirm', category: 'blocker' },
  { op: 'add_assumption', text: 'Os usuários do portal são clientes', owner: 'Ana', stage: 1 },
  { op: 'add_note', text: 'O BRD v2 substitui o v1.' },
];

const server = await startFakeServer(
  [
    /* 1 */ { toolCalls: [{ name: 'pipeline_state', id: 'p1', args: { action: 'update', ops } }] },
    /* 2 */ { content: 'Tenho 3 perguntas para o Gate 1. Responda para eu continuar.' },
    /* 3 (after "Enviar e seguir") */ { toolCalls: [{ name: 'ask_user', id: 'a1', args: { questions: [{ id: 'z1', kind: 'confirm', prompt: 'Posso seguir para a arquitetura?' }] } }] },
    /* 4 */ { toolCalls: [{ name: 'pipeline_state', id: 'p2', args: { action: 'update', ops: [{ op: 'set_stage', stage: 1, status: 'done' }] } }] },
    /* 5 */ { content: 'Seguindo para a arquitetura.' },
    /* 6 (Retomar) */ { content: 'Trabalhando…', delayMs: 4000 },
    /* 7 (Retomar again) */ { content: 'Retomado.' },
  ],
  { apiKey: KEY }
);
const config = path.join(tmp, 'alia-config.json');
fs.writeFileSync(config, JSON.stringify({ apiKey: KEY, apiType: 'chat-completions', models: [{ id: 'fake-model', name: 'fake', url: server.url, toolCalling: true, maxInputTokens: 128000 }] }));
const electronBinary: string = createRequire(path.join(desktop, 'package.json'))('electron');
const env = { ...process.env, ALIA_DESKTOP_DATA_DIR: path.join(tmp, 'data'), ALIA_DESKTOP_TEST: '1', ALIA_CONFIG: config, ALIA_TEST_PICK_FOLDER: project } as NodeJS.ProcessEnv;
for (const k of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'ALIA_API_KEY', 'OPENAI_API_KEY']) delete env[k];

const app: ElectronApplication = await electron.launch({ executablePath: electronBinary, args: ['.'], cwd: desktop, env });
const page: Page = await app.firstWindow();
await page.waitForLoadState('domcontentloaded');
await page.waitForSelector('.sidebar');

const call = (name: string, payload: object = {}) =>
  page.evaluate(([n, p]) => (window as any).alia.request(n, p).then((result: unknown) => ({ ok: true, result }), (err: Error) => ({ ok: false, error: String(err.message) })), [name, payload] as const) as Promise<any>;
const ok = async (name: string, payload: object = {}) => {
  const r = await call(name, payload);
  if (!r.ok) throw new Error(`${name}: ${r.error}`);
  return r.result;
};
const drop = (...files: string[]) => app.evaluate(({ BrowserWindow }, f) => (globalThis as any).__aliaTest.handleDropped(BrowserWindow.getAllWindows()[0].webContents, f), files);
const finals = (n: number) => page.waitForFunction((count) => document.querySelectorAll('.turn.assistant.final').length >= count, n, { timeout: 25000 });
const header = () => page.getByTestId('pipeline-header');
const card = () => page.getByTestId('gate-card');
const chip = () => page.getByTestId('run-chip');
const step = (id: string) => header().locator(`[data-step="${id}"]`);
const q = (id: string) => card().locator(`fieldset[data-question="${id}"]`);
const panel = () => page.getByTestId('side-panel');

try {
  await ok('settings.update', { permissionMode: 'auto', displayName: 'Newton' });
  await ok('projects.pick');
  await page.getByRole('button', { name: 'Abrir pasta…' }).click();
  await page.getByRole('combobox', { name: 'Mensagem' }).waitFor({ timeout: 15000 });

  console.log('\n=== a conversation that is not a pipeline has none of it ===');
  check('an ordinary conversation shows no stepper and no pipeline tab', (await header().count()) === 0 && (await card().count()) === 0);

  console.log('\n=== the model records the questions; the page shows them ===');
  await page.getByTestId('new-pipeline').click();
  await drop(brd);
  await page.waitForFunction(() => !!document.querySelector('.input[data-state="ok"]'), undefined, { timeout: 15000 });
  await page.getByRole('button', { name: 'Iniciar pipeline' }).click();
  await finals(1);
  await card().waitFor({ timeout: 10000 });
  if (process.env.ALIA_SHOTS) await page.screenshot({ path: path.join(process.env.ALIA_SHOTS, 'run-gate.png') });
  check('the pipeline conversation has the stepper, with Entradas done and Requisitos waiting on its gate', (await step('inputs').getAttribute('data-state')) === 'done' && (await step('inputs').innerText()).includes('1 arquivo') && (await step('1').getAttribute('data-state')) === 'waiting' && (await step('1').innerText()).includes('1/4') && (await step('2').getAttribute('data-state')) === 'pending', await header().innerText());
  check('the chip asks for the answers', (await chip().innerText()) === 'Aguardando suas respostas');
  check('with the model done, it can be resumed, and there is no Pausar', (await page.getByTestId('pipeline-resume').count()) === 1 && (await page.getByTestId('pipeline-pause').count()) === 0);

  console.log('\n=== the gate card ===');
  check('the card is for the gate, with its stage and progress', (await card().getByRole('heading', { level: 3 }).innerText()).includes('Gate 1 · Requisitos') && (await card().getByRole('heading', { level: 3 }).innerText()).includes('1 de 4'));
  check('answered questions are collapsed, and open with who answered and when', (await card().getByTestId('gate-settled').evaluate((el) => (el as HTMLDetailsElement).open)) === false && (await card().getByTestId('gate-settled').locator('summary').innerText()) === '1 pergunta respondida');
  await card().getByTestId('gate-settled').locator('summary').click();
  check('...the question, the answer as Sim, and Ana with the date', (await card().getByTestId('gate-settled').innerText()).includes('O portal atende parceiros?') && (await card().getByTestId('gate-settled').innerText()).includes('Sim') && (await card().getByTestId('gate-settled').innerText()).includes('Ana · 2026-11-18'));
  check('the open questions carry their category', (await q('q1').innerText()).includes('Contradição entre documentos') && (await q('q2').innerText()).includes('Baixa confiança') && (await q('q3').innerText()).includes('Bloqueia as specs'));
  check('options show their detail and source, and the confidence', (await q('q1').innerText()).includes('a mais recente') && (await q('q1').innerText()).includes('Fonte: BRD_v2.pdf') && (await q('q1').innerText()).includes('confiança baixa'));
  check('a text question shows where it comes from, and what blank means', (await q('q2').innerText()).includes('Fonte: BRD_v2.pdf · p. 9') && (await q('q2').innerText()).includes('Em branco: será registrada como suposição'));
  check('each can be deferred, with an owner', (await card().getByRole('checkbox', { name: /Adiar/ }).count()) === 3);

  console.log('\n=== answering part of it ("Enviar respostas (n de m)") ===');
  const send = () => card().getByRole('button', { name: /^Enviar/ });
  await q('q1').getByRole('radio', { name: /v2/ }).check();
  check('a partial form offers to send what is filled in, with the count (a blank text is not sent as a partial answer)', (await send().innerText()) === 'Enviar respostas (1 de 3)', await send().innerText());
  await send().click();
  await card().getByTestId('gate-message').waitFor();
  check('the card says what was recorded and what is left', (await card().getByTestId('gate-message').innerText()) === 'Resposta registrada. Ficaram 2 perguntas em aberto.', await card().getByTestId('gate-message').innerText());
  const afterPartial = loadState().gates[0];
  check('q1 is answered as the user (with the label of the option); the others are still open', afterPartial.questions.find((x) => x.id === 'q1')!.status === 'answered' && afterPartial.questions.find((x) => x.id === 'q1')!.by === 'Newton' && afterPartial.questions.find((x) => x.id === 'q1')!.answerLabel === 'v2' && afterPartial.questions.filter((x) => x.status === 'open').map((x) => x.id).join() === 'q2,q3', JSON.stringify(afterPartial.questions.map((x) => [x.id, x.status, x.by, x.owner])));
  check('the stepper and the card follow: 2 of 4 settled, two questions left, answered ones collapsed', (await step('1').innerText()).includes('2/4') && (await q('q3').count()) === 1 && (await q('q2').count()) === 1 && (await q('q1').count()) === 0 && (await card().getByTestId('gate-settled').locator('summary').innerText()) === '2 perguntas respondidas', `${await step('1').innerText()} | ${await card().innerText()}`);

  console.log('\n=== "Enviar e seguir": the answers, the approval and the next run ===');
  check('with a yes/no still open, the button is the partial one, and it has nothing to send yet', (await send().innerText()) === 'Enviar respostas (0 de 2)' && (await send().isDisabled()));
  await q('q3').getByRole('radio', { name: 'Não' }).check();
  check('once the yes/no is answered, the blank text question counts as an assumption, and the button is "Enviar e seguir"', (await send().innerText()) === 'Enviar e seguir');
  await send().click();
  // the run that follows: the model asks a live question
  await page.getByTestId('interaction-card').waitFor({ timeout: 15000 });
  const g1 = loadState().gates[0];
  check('all the answers are in state.json (q3: no; q2, left blank, is an assumption owned by the user), and the gate was passed by the user, not the model', g1.questions.find((x) => x.id === 'q3')!.answer === 'no' && g1.questions.find((x) => x.id === 'q2')!.status === 'deferred' && g1.questions.find((x) => x.id === 'q2')!.owner === 'Newton' && g1.questions.every((x) => x.status !== 'open') && g1.status === 'passed', JSON.stringify(g1.questions.map((x) => [x.id, x.status, x.owner])));
  check('the gate card is gone, and Requisitos is the stage being worked on', (await card().count()) === 0 && (await step('1').getAttribute('data-state')) === 'active', await header().innerText());
  const resumeText = String((server.requests[2].messages as any[]).filter((m) => m.role === 'user').pop()?.content ?? '');
  check('the model was resumed with the state, and told only what is still to do (the answered questions are not asked again)', resumeText.includes('Where it stopped') && !resumeText.includes('Qual versão do BRD é a oficial?') && !resumeText.includes('Quantos usuários simultâneos'), resumeText.slice(-600));
  check('while the run goes on the chip says so, with Pausar', (await chip().innerText()) === 'Executando a etapa 1' && (await page.getByTestId('pipeline-pause').count()) === 1 && (await page.getByTestId('pipeline-resume').count()) === 0);
  check('a live question from the model uses the same card, and says where it comes from', (await page.getByTestId('interaction-card').getAttribute('data-kind')) === 'ask_user' && (await page.locator('.conversation').innerText()).includes('O agente fez estas perguntas ao vivo'));
  await page.getByTestId('interaction-card').getByRole('radio', { name: 'Sim' }).check();
  await page.getByTestId('interaction-card').getByRole('button', { name: 'Enviar respostas' }).click();
  await finals(2);
  await sleep(500);
  check('when the model finishes the stage, the stepper shows Requisitos approved', (await step('1').getAttribute('data-state')) === 'done' && (await step('1').innerText()).includes('aprovado') && (await step('2').getAttribute('data-state')) === 'pending', await header().innerText());

  console.log('\n=== Pausar and Retomar ===');
  check('stopped: "Parado na etapa 2" with Retomar', (await chip().innerText()) === 'Parado na etapa 2' && (await page.getByTestId('pipeline-resume').count()) === 1, await chip().innerText());
  await page.getByTestId('pipeline-resume').click();
  await page.getByTestId('pipeline-pause').waitFor();
  check('Retomar starts a run: the chip says it is working, and Pausar replaces Retomar', (await chip().innerText()) === 'Executando a etapa 2' && (await page.getByTestId('pipeline-resume').count()) === 0);
  await page.getByTestId('pipeline-pause').click();
  await page.getByTestId('pipeline-resume').waitFor({ timeout: 10000 });
  check('Pausar stops it at once (the model had 4 s to go) and Retomar is back', (await chip().innerText()) === 'Parado na etapa 2');
  await page.getByTestId('pipeline-resume').click();
  await finals(3);
  await sleep(300);
  check('and it carries on from where it was, in the same conversation', (await page.locator('.turn.assistant.final').last().innerText()).includes('Retomado'));

  console.log('\n=== the pipeline panel ===');
  await page.getByTestId('panel-toggle').click();
  await panel().waitFor();
  check('the right panel opens on the pipeline tab, the first of four', (await panel().getByRole('tab').allInnerTexts()).join() === 'Pipeline,Alterações,Arquivos,Terminal' && (await panel().getByRole('tab', { selected: true }).innerText()) === 'Pipeline');
  const tab = page.getByTestId('pipeline-tab');
  check('artifacts: the ones that exist can be opened, the others say they are not generated yet', (await tab.locator('[data-artifact="docs/requirements/requirements.md"] button').count()) === 1 && (await tab.locator('[data-artifact="docs/architecture/architecture.md"]').innerText()).includes('ainda não gerado'));
  check('inputs with their kind and the skill, assumptions with their owners (the deferred question too), and the note', (await tab.locator('[data-input]').innerText()).includes('BRD_PortalCliente_v2.pdf') && (await tab.locator('[data-assumption]').allInnerTexts()).some((t) => t.includes('Os usuários do portal são clientes') && t.includes('responsável: Ana')) && (await tab.locator('[data-assumption]').allInnerTexts()).some((t) => t.includes('Quantos usuários simultâneos') && t.includes('responsável: Newton')) && (await tab.innerText()).includes('O BRD v2 substitui o v1.'), await tab.innerText());

  console.log('\n=== opening files with the system ===');
  await tab.locator('[data-artifact="docs/requirements/requirements.md"] button').click();
  await sleep(300);
  const opened = () => app.evaluate(() => (globalThis as any).__aliaTest.openedFiles as Array<{ abs: string; how: string }>);
  check('an artifact is opened by the system', (await opened()).some((f) => f.abs.endsWith(path.join('docs', 'requirements', 'requirements.md')) && f.how === 'open'), JSON.stringify(await opened()));
  await page.getByTestId('open-state').click();
  await sleep(300);
  check('"Abrir STATE.md" opens docs/pipeline/STATE.md', (await opened()).some((f) => f.abs.endsWith(path.join('docs', 'pipeline', 'STATE.md')) && f.how === 'open'));
  const forged = await call('projects.openFile', { projectPath: project, path: '../downloads/BRD_PortalCliente_v2.pdf' });
  check('the page cannot open a file outside the project', forged.ok === false && /outside the project/.test(forged.error), JSON.stringify(forged));
  fs.writeFileSync(path.join(project, 'run.bat'), 'echo hi');
  const bat = await ok('projects.openFile', { projectPath: project, path: 'run.bat' });
  check('a script is only shown in its folder, never run', bat.how === 'reveal' && (await opened()).some((f) => f.abs.endsWith('run.bat') && f.how === 'reveal'));

  console.log('\n=== coming back to it ===');
  await page.getByRole('button', { name: 'Nova conversa' }).click();
  await header().waitFor({ state: 'detached', timeout: 10000 });
  check('a new ordinary conversation does not show the pipeline', (await header().count()) === 0 && (await card().count()) === 0);
  await page.getByRole('button', { name: /Pipeline de|Abrir o pipeline/ }).first().click();
  await header().waitFor({ timeout: 10000 });
  check('the pipeline in the sidebar opens the conversation that runs it, with its stepper', (await header().count()) === 1 && (await step('1').getAttribute('data-state')) === 'done');

  console.log('\n=== a gate that is only waiting for the approval ===');
  const store = new PipelineStateStore(project);
  store.apply([{ op: 'set_stage', stage: 1, status: 'done' }, { op: 'set_gate', gate: 'G1', status: 'open' }]);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await card().waitFor({ timeout: 10000 });
  check('with nothing open it is only the approval, in the user\'s hands', (await card().innerText()).includes('Gate 1 está pronto') && (await card().getByTestId('gate-approve').count()) === 1 && (await chip().innerText()) === 'Aguardando sua decisão');

  console.log('\n=== accessibility ===');
  const unnamed = await page.evaluate(() => {
    const bad: string[] = [];
    for (const el of Array.from(document.querySelectorAll('[data-testid=pipeline-header] button, [data-testid=gate-card] button, [data-testid=gate-card] input, [data-testid=gate-card] textarea, [data-testid=pipeline-tab] button'))) {
      const h = el as HTMLElement;
      const labelled = h.getAttribute('aria-label') || h.textContent || (h.id && document.querySelector(`label[for="${h.id}"]`)?.textContent) || h.closest('label')?.textContent;
      if (!labelled?.trim()) bad.push(h.outerHTML.slice(0, 90));
    }
    return bad;
  });
  check('every control of the header, the card and the tab has a name', unnamed.length === 0, unnamed.join(' | '));
  check('the stepper is an ordered list with the state of each step readable by a screen reader', (await header().getByRole('list', { name: 'Etapas do pipeline' }).count()) === 1 && (await step('inputs').innerText()).includes('concluída') && (await step('1').innerText()).includes('aguardando você'));
  check('the card is a labelled group', (await card().getAttribute('role')) === 'group' && !!(await card().getAttribute('aria-labelledby')));
  void stateFile;
} catch (err: any) {
  failures++;
  console.log(`  ✘ ${err?.stack ?? err}`);
  await page.screenshot({ path: path.join(tmp, 'failure.png') }).catch(() => {});
  console.log(`  (screenshot of the failure: ${path.join(tmp, 'failure.png')})`);
} finally {
  await app.close().catch(() => {});
  await server.close();
  if (failures === 0) {
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* ignore */
    }
  }
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll pipeline run view checks passed.');
