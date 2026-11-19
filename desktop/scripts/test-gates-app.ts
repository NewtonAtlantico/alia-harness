/**
 * Gates 2 and 3 (A14) in the REAL built app, against a fake model endpoint: the model records the architecture and the specs
 * with the real `pipeline_state` tool; the page shows the proposal, the ADRs and their alignment, the spec table with a preview,
 * and the reviews, requests for changes and the follow to the tasks are the user's own. Run from desktop/: `npm run test:gates-app` (builds first).
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

const KEY = 'sk-test-GATESKEY-12345678';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alia-gates-'));
const project = path.join(tmp, 'projeto');
fs.mkdirSync(path.join(project, 'docs', 'specs'), { recursive: true });
fs.mkdirSync(path.join(project, 'docs', 'architecture'), { recursive: true });
const outside = path.join(tmp, 'downloads');
fs.mkdirSync(outside);
const brd = path.join(outside, 'BRD.pdf');
fs.writeFileSync(brd, makePdf([['Requisitos do portal']]));
fs.writeFileSync(path.join(project, 'docs', 'specs', 'login-sso-spec.md'), '# Login com SSO\n\n## Problema\nClientes têm várias senhas.\n\n## Critérios de aceite\n- Entrar com a conta da empresa\n- Sair em todos os dispositivos\n\n## Fora do escopo\nCadastro de novos usuários.\n');
fs.writeFileSync(path.join(project, 'docs', 'specs', 'abrir-chamado-spec.md'), '# Abrir chamado\n\n## Problema\nChamados chegam por e-mail.\n\n## Critérios de aceite\n- Abrir um chamado com anexo\n');
const stateFile = path.join(project, 'docs', 'pipeline', 'state.json');
const store = () => new PipelineStateStore(project);

const gate2Ops = [
  { op: 'set_stage', stage: 1, status: 'running' },
  { op: 'set_stage', stage: 1, status: 'done' },
  { op: 'set_gate', gate: 'G1', status: 'passed' },
  { op: 'set_stage', stage: 2, status: 'running' },
  { op: 'set_architecture', style: 'Monolito modular', driver: 'Equipe pequena e prazo curto', contexts: [{ name: 'Atendimento', role: 'Abertura e acompanhamento de chamados' }, { name: 'Pedidos', role: 'Consulta de pedidos' }], recommendation: 'approve_with_notes', notes: 'Revisar o limite entre Atendimento e Pedidos.' },
  { op: 'add_adr', id: 'ADR-001', title: 'Usar PostgreSQL', status: 'accepted' },
  { op: 'add_adr', id: 'ADR-002', title: 'Mensageria assíncrona', status: 'proposed' },
  { op: 'set_adr_alignment', adr: 'ADR-001', alignment: 'aligned' },
  { op: 'set_adr_alignment', adr: 'ADR-002', alignment: 'misaligned', note: 'A proposta usa uma fila própria.' },
  { op: 'add_assumption', text: 'Sem multi-região no MVP', owner: 'Ana', stage: 2 },
  { op: 'add_question', gate: 'G2', id: 'b1', prompt: 'Quem é o dono das gravações dos chamados?', kind: 'text', category: 'blocker', source: 'Kickoff.pdf · p. 3' },
];
const gate3Ops = [
  { op: 'set_stage', stage: 2, status: 'done' },
  { op: 'set_stage', stage: 3, status: 'running' },
  { op: 'set_spec', slug: 'login-sso', title: 'Login com SSO', persona: 'Cliente', depends_on: [], constraints: ['LGPD'], path: 'docs/specs/login-sso-spec.md' },
  { op: 'set_spec', slug: 'abrir-chamado', title: 'Abrir chamado', persona: 'Cliente', depends_on: ['login-sso'], path: 'docs/specs/abrir-chamado-spec.md' },
  { op: 'add_question', gate: 'G3', id: 'g1', prompt: 'Qual persona usa o painel do atendente?', kind: 'text', category: 'open_question' },
  { op: 'set_stage', stage: 3, status: 'done' },
];

const server = await startFakeServer(
  [
    /* 1 */ { toolCalls: [{ name: 'pipeline_state', id: 'p1', args: { action: 'update', ops: gate2Ops } }] },
    /* 2 */ { content: 'Proposta de arquitetura pronta para a sua revisão.' },
    /* 3 (after "Enviar e seguir" at gate 2) */ { toolCalls: [{ name: 'pipeline_state', id: 'p2', args: { action: 'update', ops: gate3Ops } }] },
    /* 4 */ { content: 'Specs prontas para revisão.' },
    /* 5 (after "Pedir alterações") */ { content: 'Vou refazer as specs com o seu comentário.' },
    /* 6 (after "Seguir para Tarefas") */ { content: 'Começando as tarefas.' },
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
const card = () => page.getByTestId('gate-card');
const chip = () => page.getByTestId('run-chip');
const arch = () => page.getByTestId('architecture-panel');
const specs = () => page.getByTestId('specs-panel');
const spec = (slug: string) => specs().locator(`tr[data-spec="${slug}"]`);
const focusEvent = () => page.evaluate(() => window.dispatchEvent(new Event('focus')));

try {
  await ok('settings.update', { permissionMode: 'auto', displayName: 'Newton' });
  await ok('projects.pick');
  await page.getByRole('button', { name: 'Abrir pasta…' }).click();
  await page.getByRole('combobox', { name: 'Mensagem' }).waitFor({ timeout: 15000 });
  await page.getByTestId('new-pipeline').click();
  await drop(brd);
  await page.waitForFunction(() => !!document.querySelector('.input[data-state="ok"]'), undefined, { timeout: 15000 });
  await page.getByRole('button', { name: 'Iniciar pipeline' }).click();
  await finals(1);
  await arch().waitFor({ timeout: 10000 });
  if (process.env.ALIA_SHOTS) await page.screenshot({ path: path.join(process.env.ALIA_SHOTS, 'gate2.png') });

  console.log('\n=== gate 2: the proposed architecture ===');
  check('the screen is "Arquitetura proposta", with the style and what drove it', (await arch().getByRole('heading', { level: 3 }).innerText()) === 'Arquitetura proposta' && (await arch().getByTestId('arch-style').innerText()) === 'Monolito modular' && (await arch().innerText()).includes('Equipe pequena e prazo curto'));
  check('the contexts come with their role', (await arch().locator('[data-context="Atendimento"]').innerText()).includes('Abertura e acompanhamento de chamados') && (await arch().locator('[data-context]').count()) === 2);
  check('ADRs are listed with their status', (await arch().locator('[data-adr="ADR-001"]').innerText()).includes('Usar PostgreSQL') && (await arch().locator('[data-adr="ADR-001"]').innerText()).includes('accepted') && (await arch().locator('[data-adr="ADR-002"]').innerText()).includes('proposed'));
  check('alignment with the ADRs that exist: Alinhado, and Desalinhado with the note', (await arch().locator('[data-alignment="ADR-001"]').innerText()).includes('Alinhado') && (await arch().locator('[data-alignment="ADR-002"]').innerText()).includes('Desalinhado') && (await arch().locator('[data-alignment="ADR-002"]').innerText()).includes('A proposta usa uma fila própria.'));
  check('what goes forward without blocking is listed as assumptions with their owner', (await arch().locator('[data-assumption]').innerText()).includes('Sem multi-região no MVP') && (await arch().locator('[data-assumption]').innerText()).includes('responsável: Ana'));
  check('the gate card is the architecture review, with the recommendation as a chip', (await card().getByRole('heading', { level: 3 }).innerText()).includes('Revisão da arquitetura') && (await card().getByTestId('gate-chip').innerText()) === 'Aprovar com notas');
  check('the blocking question is in the card, with its category and source', (await card().innerText()).includes('Quem é o dono das gravações dos chamados?') && (await card().innerText()).includes('Bloqueia as specs') && (await card().innerText()).includes('Fonte: Kickoff.pdf · p. 3'));
  check('the stepper shows Arquitetura waiting', (await page.locator('[data-step="2"]').getAttribute('data-state')) === 'waiting');

  console.log('\n=== gate 2: no structured summary ===');
  const good = fs.readFileSync(stateFile, 'utf8');
  const bare = JSON.parse(good);
  delete bare.architecture;
  bare.adrAlignment = [];
  fs.writeFileSync(stateFile, JSON.stringify(bare, null, 2));
  fs.writeFileSync(path.join(project, 'docs', 'architecture', 'architecture.md'), '# Arquitetura\n\nO sistema é um monolito modular com dois contextos.\n');
  await focusEvent();
  await page.getByTestId('arch-fallback').waitFor({ timeout: 10000 });
  check('without a summary it says so and shows the document instead (and the ADRs still list)', (await arch().innerText()).includes('Sem resumo estruturado') && (await arch().innerText()).includes('O sistema é um monolito modular com dois contextos.') && (await arch().locator('[data-adr]').count()) === 2);
  check('no recommendation chip is invented', (await card().getByTestId('gate-chip').count()) === 0);
  fs.writeFileSync(stateFile, good);
  await focusEvent();
  await arch().getByTestId('arch-style').waitFor({ timeout: 10000 });

  console.log('\n=== gate 2: answering and going on ===');
  await card().getByRole('textbox').first().fill('O CRM é o dono das gravações.');
  await card().getByRole('button', { name: 'Enviar e seguir' }).click();
  await finals(2);
  await specs().waitFor({ timeout: 15000 });
  check('the user approved gate 2 with the answer recorded as theirs', store().load()!.gates[1].status === 'passed' && store().load()!.gates[1].questions[0].answer === 'O CRM é o dono das gravações.' && store().load()!.gates[1].questions[0].by === 'Newton');
  check('the architecture screen is gone, and Arquitetura shows approved', (await arch().count()) === 0 && (await page.locator('[data-step="2"]').getAttribute('data-state')) === 'done');

  console.log('\n=== gate 3: the specs ===');
  if (process.env.ALIA_SHOTS) await page.screenshot({ path: path.join(process.env.ALIA_SHOTS, 'gate3.png') });
  check('the spec table has persona, what each depends on, and the status', (await spec('login-sso').innerText()).includes('Login com SSO') && (await spec('login-sso').innerText()).includes('Cliente') && (await spec('login-sso').innerText()).includes('Rascunho') && (await spec('abrir-chamado').innerText()).includes('login-sso') && (await specs().locator('tbody tr').count()) === 2);
  check('the progress is counted', (await specs().getByRole('heading', { level: 3 }).innerText()).includes('0 de 2 revisadas'));
  check('"Seguir para Tarefas" is off, and says why (the specs come first)', (await page.getByTestId('follow-tasks').isDisabled()) && (await specs().innerText()).includes('Faltam revisar 2 specs.'));
  check('the gap the skill raised is a question in the card, which does not approve the gate', (await card().innerText()).includes('Qual persona usa o painel do atendente?') && (await card().getByRole('button', { name: /^Enviar/ }).count()) === 1);
  await card().getByRole('textbox').first().fill('O atendente de primeira linha.');
  check('answering it offers to send the answers (not "e seguir")', (await card().getByRole('button', { name: 'Enviar respostas' }).count()) === 1);
  await card().getByRole('button', { name: 'Enviar respostas' }).click();
  await page.getByTestId('resolved-gap').waitFor({ timeout: 10000 });
  check('the gap is shown as resolved (green), and the gate is still open for the reviews', (await page.getByTestId('resolved-gap').innerText()).includes('Lacuna resolvida') && store().load()!.gates[2].status !== 'passed' && (await card().count()) === 0);

  console.log('\n=== reviewing a spec ===');
  await spec('login-sso').getByRole('button', { name: 'Revisar a spec Login com SSO' }).click();
  await page.getByTestId('spec-preview').waitFor();
  check('the spec file is shown, rendered: the problem, the acceptance criteria, the scope', (await page.getByTestId('spec-preview').locator('h2').allInnerTexts()).join() === 'Problema,Critérios de aceite,Fora do escopo' && (await page.getByTestId('spec-preview').locator('li').count()) === 2);
  check('asking for changes needs a comment', await specs().getByRole('button', { name: 'Pedir alterações' }).isDisabled());
  await specs().getByLabel('Comentário da revisão').fill('Conferi com o BRD.');
  await specs().getByRole('button', { name: 'Aprovar spec' }).click();
  await specs().getByTestId('specs-message').waitFor();
  const reviewed = store().load()!;
  check('approving records the review as the user and keeps the comment as a note', reviewed.specReviews.find((r) => r.spec === 'login-sso')!.status === 'reviewed' && reviewed.specReviews.find((r) => r.spec === 'login-sso')!.by === 'Newton' && reviewed.notes.some((n) => n.includes('Conferi com o BRD.')));
  check('the table shows who approved it and when, and the count', (await spec('login-sso').innerText()).includes('Aprovada por Newton em') && (await specs().getByRole('heading', { level: 3 }).innerText()).includes('1 de 2 revisadas') && (await specs().innerText()).includes('Falta revisar 1 spec.'));
  check('the stepper for specs is still waiting', (await page.locator('[data-step="3"]').getAttribute('data-state')) === 'waiting');

  console.log('\n=== asking for changes ===');
  await spec('abrir-chamado').getByRole('button', { name: 'Revisar a spec Abrir chamado' }).click();
  await specs().getByLabel('Comentário da revisão').fill('Falta o critério de aceite sobre o tamanho do anexo.');
  await specs().getByRole('button', { name: 'Pedir alterações' }).click();
  const dialog = page.getByRole('dialog', { name: 'Pedir alterações nesta spec?' });
  await dialog.waitFor();
  check('it asks first, with the safe button focused, and says what happens', (await page.evaluate(() => document.activeElement?.textContent)) === 'Cancelar' && (await dialog.innerText()).includes('a etapa de specs volta a ser feita'));
  await page.keyboard.press('Escape');
  check('Esc keeps everything as it was', (await dialog.count()) === 0 && store().load()!.specReviews.find((r) => r.spec === 'abrir-chamado')!.status === 'draft' && store().load()!.stages[2].status === 'done');
  await specs().getByRole('button', { name: 'Pedir alterações' }).click();
  await dialog.getByRole('button', { name: 'Pedir alterações' }).click();
  await finals(3);
  await sleep(400);
  const redo = store().load()!;
  check('the specs stage is to be redone and gate 3 must pass again; the request is kept', redo.stages[2].status === 'stale' && redo.gates[2].status !== 'passed' && redo.specReviews.find((r) => r.spec === 'abrir-chamado')!.status === 'draft' && redo.notes.some((n) => n.includes('Falta o critério de aceite sobre o tamanho do anexo.')));
  const told = JSON.stringify(server.requests[4]);
  check('the agent got the comment and was told the review stays with people', told.includes('Falta o critério de aceite sobre o tamanho do anexo.') && told.includes('a revisão é humana'));
  check('the user said it in the conversation, and the chip says the stage is to be redone', (await page.locator('.turn.user').last().innerText()).includes('Pedir alterações na spec abrir-chamado') && (await chip().innerText()) === 'Parado na etapa 3');
  check('with the stage stale there is no review screen (nothing to review until it is redone)', (await specs().count()) === 0);

  console.log('\n=== following to the tasks ===');
  // The agent redid the specs (written here as the model would); the user reviews the second one.
  store().apply([{ op: 'set_stage', stage: 3, status: 'running' }, { op: 'set_spec', slug: 'abrir-chamado', title: 'Abrir chamado', persona: 'Cliente', depends_on: ['login-sso'], path: 'docs/specs/abrir-chamado-spec.md' }, { op: 'set_stage', stage: 3, status: 'done' }]);
  await focusEvent();
  await specs().waitFor({ timeout: 10000 });
  check('the redone specs wait for review again, the first one still approved', (await spec('login-sso').getAttribute('data-status')) === 'reviewed' && (await spec('abrir-chamado').getAttribute('data-status')) === 'draft' && (await page.getByTestId('follow-tasks').isDisabled()));
  await spec('abrir-chamado').getByRole('button', { name: 'Revisar a spec Abrir chamado' }).click();
  await specs().getByRole('button', { name: 'Aprovar spec' }).click();
  await page.waitForFunction(() => !document.querySelector('[data-testid=follow-tasks]')?.hasAttribute('disabled'), undefined, { timeout: 10000 });
  check('every spec reviewed: "Seguir para Tarefas" is on, and the hint is gone', (await page.getByTestId('follow-tasks').isEnabled()) && (await specs().innerText()).includes('2 de 2 revisadas') && !(await specs().innerText()).includes('Faltam') && (await chip().innerText()) === 'Aguardando sua decisão');
  await page.getByTestId('follow-tasks').click();
  await finals(4);
  await sleep(400);
  check('gate 3 was passed by the user, and the run went on to the tasks', store().load()!.gates[2].status === 'passed' && (await page.locator('.turn.assistant.final').last().innerText()).includes('Começando as tarefas.') && (await specs().count()) === 0);
  check('the agent was resumed with the state', JSON.stringify(server.requests[5]).includes('Where it stopped'));

  console.log('\n=== accessibility ===');
  store().apply([{ op: 'set_stage', stage: 3, status: 'running' }, { op: 'set_spec', slug: 'abrir-chamado', title: 'Abrir chamado', persona: 'Cliente', depends_on: ['login-sso'] }]);
  await ok('sessions.active');
  void drop;
  const unnamed = await page.evaluate(() => {
    const bad: string[] = [];
    for (const el of Array.from(document.querySelectorAll('[data-testid=architecture-panel] button, [data-testid=specs-panel] button, [data-testid=specs-panel] textarea, [data-testid=specs-panel] th'))) {
      const h = el as HTMLElement;
      const labelled = h.getAttribute('aria-label') || h.textContent || h.closest('label')?.textContent;
      if (!labelled?.trim() && h.tagName !== 'TH') bad.push(h.outerHTML.slice(0, 90));
    }
    return bad;
  });
  check('every control of the two screens has a name', unnamed.length === 0, unnamed.join(' | '));
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
console.log('\nAll gate 2 and gate 3 checks passed.');
