/**
 * The whole journey in the REAL built app against the fake model endpoint (A16): a chat with an approval and a change, then a
 * pipeline from a PDF and a transcript through all three gates, with the people making every decision, to the final report and
 * the drafts of the issues. The model writes the artifacts with the real tools and records the state with the real
 * `pipeline_state` tool, so core enforces its own rules along the way. Set ALIA_SHOTS to a folder to keep a screenshot of every
 * screen. Run from desktop/: `npm run test:journey-app` (builds first).
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PipelineStateStore, summarizeTasks } from 'alia-harness/core';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { makePdf } from '../../scripts/lib/pdfFixture';
import { startFakeServer, type FakeTurn } from './lib/fakeServer';
import { audit, describeViolations, focusAudit, type Violation } from './lib/axe';
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

const KEY = 'sk-test-JOURNEYKEY-12345678';
// The screenshots are kept in the repository: they are taken in a neutral folder, not under the profile of whoever ran them.
const base = process.env.ALIA_JOURNEY_TMP ?? os.tmpdir();
fs.mkdirSync(base, { recursive: true });
const tmp = fs.mkdtempSync(path.join(base, 'alia-journey-'));
const project = path.join(tmp, 'portal-do-cliente');
fs.mkdirSync(project, { recursive: true });
const downloads = path.join(tmp, 'downloads');
fs.mkdirSync(downloads);
const brd = path.join(downloads, 'BRD_PortalCliente_v2.pdf');
fs.writeFileSync(brd, makePdf([['Portal do cliente: requisitos'], ['Login com SSO, consulta de pedidos, abertura de chamados e acesso de parceiros.']]));
const kickoff = path.join(downloads, 'kickoff-transcricao.txt');
fs.writeFileSync(kickoff, 'Ana: o portal precisa de SSO.\nBruno: parceiros entram depois.\n'.repeat(40));
const issuesFile = path.join(tmp, 'issues-connection.txt');
const shots = process.env.ALIA_SHOTS;
const stateFile = path.join(project, 'docs', 'pipeline', 'state.json');
const store = () => new PipelineStateStore(project);

const fixtureTasks = path.resolve(desktop, '..', 'scripts', 'fixtures', 'pipeline', 'docs', 'tasks');
const slugs = ['01-login-sso', '02-consultar-pedidos', '03-abrir-chamado', '04-acesso-parceiros'];
const titles = ['Login com SSO', 'Consultar pedidos', 'Abrir chamado', 'Acesso de parceiros'];
const write = (file: string, content: string, id: string): FakeTurn => ({ toolCalls: [{ name: 'write_file', id, args: { path: file, content } }] });
const state = (ops: unknown[], id: string): FakeTurn => ({ toolCalls: [{ name: 'pipeline_state', id, args: { action: 'update', ops } }] });

const turns: FakeTurn[] = [
  // --- chat
  { toolCalls: [{ name: 'run_bash', id: 'a1', args: { command: 'echo testes-ok' } }] },
  { content: 'Os testes passaram.' },
  write('notas.md', '# Notas\n- primeira\n', 'a2'),
  { content: 'Criei notas.md.' },
  // --- pipeline, gate 1
  state(
    [
      { op: 'set_stage', stage: 1, status: 'running' },
      { op: 'add_question', gate: 'G1', id: 'q1', prompt: 'Qual versão do BRD é a oficial?', kind: 'choice', category: 'contradiction', source: 'BRD_v2.pdf · p. 1', confidence: 'low', options: [{ id: 'v2', label: 'v2', detail: 'a mais recente' }, { id: 'v3', label: 'v3' }] },
      { op: 'add_question', gate: 'G1', id: 'q2', prompt: 'Quantos usuários simultâneos?', kind: 'text', category: 'low_confidence' },
      { op: 'add_question', gate: 'G1', id: 'q3', prompt: 'A integração com o ERP entra no MVP?', kind: 'confirm', category: 'blocker' },
    ],
    'g1'
  ),
  { content: 'Tenho 3 perguntas para o Gate 1.' },
  // --- stage 1 finishes, stage 2 (after the user approves gate 1)
  write('docs/requirements/requirements.md', '# Requisitos\n\n- RF-01 Login com SSO\n- RF-02 Consulta de pedidos\n', 'r1'),
  state(
    [
      { op: 'set_stage', stage: 1, status: 'done' },
      { op: 'set_stage', stage: 2, status: 'running' },
      { op: 'set_architecture', style: 'Monolito modular', driver: 'Equipe pequena e prazo curto', contexts: [{ name: 'Atendimento', role: 'Chamados' }, { name: 'Pedidos', role: 'Consulta de pedidos' }], recommendation: 'approve_with_notes', notes: 'Revisar o limite entre contextos.' },
      { op: 'add_adr', id: 'ADR-001', title: 'Usar PostgreSQL', status: 'accepted', path: 'adr/ADR-001-usar-postgresql.md' },
      { op: 'add_adr', id: 'ADR-002', title: 'Fila de mensagens', status: 'accepted' },
      { op: 'add_adr', id: 'ADR-003', title: 'SSO corporativo', status: 'accepted' },
      { op: 'set_adr_alignment', adr: 'ADR-001', alignment: 'aligned' },
      { op: 'add_assumption', text: 'Sem multi-região no MVP', owner: 'Ana', stage: 2 },
      { op: 'add_question', gate: 'G2', id: 'b1', prompt: 'Quem é o dono das gravações dos chamados?', kind: 'text', category: 'blocker' },
    ],
    'g2'
  ),
  write('adr/ADR-001-usar-postgresql.md', '# ADR-001: Usar PostgreSQL\n\nStatus: aceita\n', 'r2'),
  write('docs/architecture/architecture.md', '# Arquitetura\n\nMonolito modular com dois contextos.\n', 'r3'),
  { content: 'Arquitetura pronta para a sua revisão.' },
  // --- stage 3 (after gate 2)
  state(
    [
      { op: 'set_stage', stage: 2, status: 'done' },
      { op: 'set_stage', stage: 3, status: 'running' },
      ...slugs.map((slug, i) => ({ op: 'set_spec', slug, title: titles[i], persona: 'Cliente', depends_on: i === 0 ? [] : i === 3 ? ['01-login-sso', '02-consultar-pedidos'] : ['01-login-sso'], path: `docs/specs/${slug}-spec.md` })),
      { op: 'add_question', gate: 'G3', id: 'g1', prompt: 'Qual persona usa o painel do atendente?', kind: 'text' },
    ],
    's1'
  ),
  ...slugs.map((slug, i) => write(`docs/specs/${slug}-spec.md`, `# ${titles[i]}\n\n## Problema\nTexto do problema de ${titles[i]}.\n\n## Critérios de aceite\n- Critério de ${titles[i]}\n`, `s-${i}`)),
  write('docs/specs/INDEX.md', `# Specs\n\n${slugs.map((s, i) => `- ${s}: ${titles[i]}`).join('\n')}\n`, 's-index'),
  state([{ op: 'set_stage', stage: 3, status: 'done' }], 's2'),
  { content: 'Specs prontas para revisão.' },
  // --- stage 4 (after gate 3)
  state([{ op: 'set_stage', stage: 4, status: 'running' }], 't0'),
  ...slugs.map((slug, i) => write(`docs/tasks/${slug}-tasks.md`, fs.readFileSync(path.join(fixtureTasks, `${slug}-tasks.md`), 'utf8'), `t-${i}`)),
  state([{ op: 'set_stage', stage: 4, status: 'done' }, { op: 'set_check', key: 'coverage', status: 'pass' }], 't9'),
  { content: 'Pipeline concluído: 4 specs, 11 tarefas.' },
  // --- drafts
  write('docs/issues/portal-do-cliente.md', '# Rascunhos de issues\n', 'i1'),
  { content: 'Rascunhos gerados em docs/issues/.' },
];

const server = await startFakeServer(turns, { apiKey: KEY });
const config = path.join(tmp, 'alia-config.json');
fs.writeFileSync(config, JSON.stringify({ apiKey: KEY, apiType: 'chat-completions', models: [{ id: 'fake-model', name: 'fake', url: server.url, toolCalling: true, maxInputTokens: 128000 }] }));
const electronBinary: string = createRequire(path.join(desktop, 'package.json'))('electron');
const env = { ...process.env, ALIA_DESKTOP_DATA_DIR: path.join(tmp, 'data'), ALIA_DESKTOP_TEST: '1', ALIA_CONFIG: config, ALIA_TEST_PICK_FOLDER: project, ALIA_TEST_ISSUES_FILE: issuesFile } as NodeJS.ProcessEnv;
for (const k of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'ALIA_API_KEY', 'OPENAI_API_KEY']) delete env[k];

const app: ElectronApplication = await electron.launch({ executablePath: electronBinary, args: ['.'], cwd: desktop, env });
const page: Page = await app.firstWindow();
await page.waitForLoadState('domcontentloaded');
await page.waitForSelector('.sidebar');
await page.setViewportSize({ width: 1280, height: 800 }).catch(() => {});

const call = (name: string, payload: object = {}) =>
  page.evaluate(([n, p]) => (window as any).alia.request(n, p).then((result: unknown) => ({ ok: true, result }), (err: Error) => ({ ok: false, error: String(err.message) })), [name, payload] as const) as Promise<any>;
const ok = async (name: string, payload: object = {}) => {
  const r = await call(name, payload);
  if (!r.ok) throw new Error(`${name}: ${r.error}`);
  return r.result;
};
const drop = (...files: string[]) => app.evaluate(({ BrowserWindow }, f) => (globalThis as any).__aliaTest.handleDropped(BrowserWindow.getAllWindows()[0].webContents, f), files);
/** Accessibility audit of every screen the journey shows (axe-core, WCAG 2.1 A and AA): judged at the end, so one run lists everything. */
const found: Array<{ screen: string; violations: Violation[]; hidden: string[] }> = [];
const shot = async (name: string) => {
  found.push({ screen: name, violations: await audit(page), hidden: await focusAudit(page) });
  if (shots) {
    fs.mkdirSync(shots, { recursive: true });
    await sleep(250);
    await page.screenshot({ path: path.join(shots, `${name}.png`) });
  }
};
const finals = (n: number) => page.waitForFunction((count) => document.querySelectorAll('.turn.assistant.final').length >= count, n, { timeout: 30000 });
const box = () => page.getByRole('combobox', { name: 'Mensagem' });
const card = () => page.getByTestId('gate-card');
const spec = (slug: string) => page.getByTestId('specs-panel').locator(`tr[data-spec="${slug}"]`);
const readText = (rel: string) => fs.readFileSync(path.join(project, rel), 'utf8');

try {
  await ok('settings.update', { displayName: 'Newton' });
  // The window reads the settings once, when it starts: without this it keeps the OS user's name (the CI runner's is not Newton).
  await page.reload();
  await page.waitForSelector('.sidebar');
  console.log('\n=== first run: settings, then a project ===');
  await page.getByRole('button', { name: 'Configurações' }).click();
  await page.getByRole('heading', { name: 'Configurações', level: 1 }).waitFor();
  await shot('01-configuracoes');
  await ok('projects.pick');
  await page.getByRole('button', { name: 'Abrir pasta…' }).click();
  await box().waitFor({ timeout: 15000 });
  check('the folder opens and the conversation is ready', (await page.getByTestId('project-chip').innerText()).includes('portal-do-cliente'));
  await shot('02-inicio');

  console.log('\n=== chat: a command that needs approval, and a change ===');
  await box().fill('rode os testes');
  await box().press('Enter');
  await page.getByTestId('interaction-card').waitFor({ timeout: 15000 });
  await shot('03-pedido-de-permissao');
  await page.getByRole('button', { name: 'Permitir uma vez' }).click();
  await finals(1);
  check('the command ran after the user allowed it, and its result is in the conversation', (await page.locator('.timeline').innerText()).includes('testes-ok') || (await page.locator('.timeline').innerText()).includes('passou'));
  await box().fill('crie as notas');
  await box().press('Enter');
  await finals(2);
  await page.getByTestId('panel-toggle').click();
  await page.getByTestId('side-panel').waitFor();
  await page.getByRole('tab', { name: 'Alterações' }).click();
  await page.locator('.change[data-path="notas.md"]').waitFor({ timeout: 10000 });
  await shot('04-chat-com-painel');
  check('the file is in the changes panel, as a new file', (await page.locator('.change[data-path="notas.md"]').innerText()).includes('novo'));
  await page.locator('.change[data-path="notas.md"]').getByRole('button', { name: /Manter as alterações em notas.md/ }).click();
  await page.getByTestId('panel-toggle').click();

  console.log('\n=== the pipeline: intake with a PDF and a transcript ===');
  await page.getByTestId('new-pipeline').click();
  await drop(brd, kickoff);
  await page.waitForFunction(() => document.querySelectorAll('.input[data-state="ok"]').length === 2, undefined, { timeout: 20000 });
  await shot('05-pipeline-entradas');
  await page.getByRole('button', { name: 'Iniciar pipeline' }).click();
  await card().waitFor({ timeout: 30000 });
  check('state.json exists with the inputs (hashed), and the model recorded the gate questions', store().load()!.inputs.length === 2 && !!store().load()!.inputs[0].hash && store().load()!.gates[0].questions.length === 3);

  console.log('\n=== gate 1 ===');
  await shot('06-gate-1');
  await card().locator('fieldset[data-question="q1"]').getByRole('radio', { name: /v2/ }).check();
  await card().locator('fieldset[data-question="q3"]').getByRole('radio', { name: 'Não' }).check();
  await card().getByRole('button', { name: 'Enviar e seguir' }).click();
  await page.getByTestId('architecture-panel').waitFor({ timeout: 30000 });
  check('the user answered and approved gate 1; the model went on to the architecture', store().load()!.gates[0].status === 'passed' && store().load()!.gates[0].questions.every((q) => q.status !== 'open') && store().load()!.stages[1].status === 'running');

  console.log('\n=== gate 2 ===');
  await shot('07-gate-2');
  check('the proposal is on screen with its recommendation and ADRs', (await page.getByTestId('architecture-panel').innerText()).includes('Monolito modular') && (await page.getByTestId('gate-chip').innerText()) === 'Aprovar com notas' && (await page.getByTestId('architecture-panel').locator('[data-adr]').count()) === 3);
  await card().getByRole('textbox').first().fill('O CRM é o dono das gravações.');
  await card().getByRole('button', { name: 'Enviar e seguir' }).click();
  await page.getByTestId('specs-panel').waitFor({ timeout: 30000 });
  check('the user answered and approved gate 2; the model wrote the specs', store().load()!.gates[1].status === 'passed' && store().load()!.specs.length === 4 && fs.existsSync(path.join(project, 'docs', 'specs', '04-acesso-parceiros-spec.md')));

  console.log('\n=== gate 3 ===');
  await card().getByRole('textbox').first().fill('O atendente de primeira linha.');
  await card().getByRole('button', { name: 'Enviar respostas' }).click();
  await page.getByTestId('resolved-gap').waitFor({ timeout: 10000 });
  await shot('08-gate-3');
  for (const [i, slug] of slugs.entries()) {
    await spec(slug).getByRole('button', { name: `Revisar a spec ${titles[i]}` }).click();
    await page.getByTestId('spec-preview').waitFor();
    await page.getByTestId('specs-panel').getByRole('button', { name: 'Aprovar spec' }).click();
    await page.waitForFunction((s) => document.querySelector(`tr[data-spec="${s}"]`)?.getAttribute('data-status') === 'reviewed', slug, { timeout: 10000 });
  }
  await page.waitForFunction(() => !document.querySelector('[data-testid=follow-tasks]')?.hasAttribute('disabled'), undefined, { timeout: 10000 });
  await page.getByTestId('follow-tasks').click();
  await page.getByTestId('final-report').waitFor({ timeout: 40000 });
  check('every spec was reviewed by a person, and the user passed gate 3', store().load()!.specReviews.every((r) => r.status === 'reviewed' && r.by === 'Newton') && store().load()!.gates[2].status === 'passed', JSON.stringify(store().load()!.specReviews));

  console.log('\n=== done: the report and the drafts ===');
  await shot('09-relatorio-final');
  check('4 specs, 11 tarefas, 45 pontos, 3 ADRs, and nothing blocks', (await page.getByTestId('report-totals').innerText()) === '4 specs · 11 tarefas · 45 pontos · 3 ADRs' && (await page.getByTestId('report-clear').count()) === 1);
  await page.getByTestId('publish-issues').click();
  const dialog = page.getByRole('dialog', { name: 'Não há conexão com um rastreador de issues' });
  await dialog.waitFor();
  await shot('10-publicar-rascunhos');
  await dialog.getByRole('button', { name: 'Gerar rascunhos' }).click();
  await page.waitForFunction(() => document.body.innerText.includes('Rascunhos gerados em docs/issues/.'), undefined, { timeout: 30000 });

  console.log('\n=== accessibility of every screen ===');
  for (const f of found) check(`${f.screen}: no violations, and every control shows where the keyboard is`, f.violations.length === 0 && f.hidden.length === 0, '\n' + describeViolations(f.violations) + (f.hidden.length ? '\nno focus ring: ' + f.hidden.join(', ') : ''));

  console.log('\n=== what is on disk ===');
  const final = store().load()!;
  check('state.json: every stage done, every gate passed, the coverage check recorded', final.stages.every((s) => s.status === 'done') && final.gates.every((g) => g.status === 'passed') && final.checks[0]?.key === 'coverage');
  check('STATE.md follows the state', readText('docs/pipeline/STATE.md').includes('Pipeline state') && readText('docs/pipeline/STATE.md').includes('04-acesso-parceiros'));
  check('the artifacts are there: requirements, architecture, an ADR, the specs and their index', ['docs/requirements/requirements.md', 'docs/architecture/architecture.md', 'adr/ADR-001-usar-postgresql.md', 'docs/specs/INDEX.md', ...slugs.map((s) => `docs/specs/${s}-spec.md`)].every((f) => fs.existsSync(path.join(project, f))));
  const tasks = summarizeTasks(project);
  check('the tasks are in docs/tasks: 4 files, 11 tasks, 45 points, nothing wrong', tasks.files.length === 4 && tasks.taskCount === 11 && tasks.points === 45 && tasks.problems.length === 0);
  check('the drafts of the issues were written, since there was no tracker', fs.existsSync(path.join(project, 'docs', 'issues', 'portal-do-cliente.md')));
  const modelOps = server.requests.flatMap((r) => r.messages).filter((m: any) => m.role === 'assistant').flatMap((m: any) => m.tool_calls ?? []).filter((c: any) => c.function.name === 'pipeline_state').map((c: any) => String(c.function.arguments));
  check('the model never passed a gate nor reviewed a spec: those were the people', modelOps.length > 0 && modelOps.every((a) => !a.includes('"set_gate"') && !a.includes('"set_spec_review"') && !a.includes('"answer_question"')), modelOps.join('\n').slice(0, 200));
  check('the fake model was used up exactly: nothing scripted was left over', server.requests.length === turns.length, `${server.requests.length} requests for ${turns.length} turns`);
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
void stateFile;

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nThe whole journey passed.');
