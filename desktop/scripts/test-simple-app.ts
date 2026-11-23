/**
 * The simple view and the flow list in the REAL built app, against a fake model endpoint. A project is brought to each point of the
 * pipeline with the state the pipeline itself writes, and the screens are used as a person would: questions one at a time (each
 * answer recorded in their name), the features confirmed or sent back, the plan sent to the technical team and taken away as a
 * PDF and a link; a new project made from a name, a request and a file; and, in the technical view, the flow chosen in a list.
 * Run from desktop/: `npm run test:simple-app` (builds first).
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PipelineStateStore } from 'alia-harness/core';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { makePdf } from '../../scripts/lib/pdfFixture';
import { audit } from './lib/axe';
import { startFakeServer } from './lib/fakeServer';

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

const KEY = 'sk-test-SIMPLEKEY-12345678';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alia-simple-'));
const data = path.join(tmp, 'data');
const project = path.join(tmp, 'portal');
fs.mkdirSync(path.join(project, 'docs', 'requirements'), { recursive: true });
fs.mkdirSync(path.join(project, 'docs', 'specs'), { recursive: true });
const outside = path.join(tmp, 'downloads');
fs.mkdirSync(outside);
const brd = path.join(outside, 'Requisitos do portal.pdf');
fs.writeFileSync(brd, makePdf([['Requisitos do portal']]));
fs.writeFileSync(path.join(project, 'docs', 'requirements', 'requirements.md'), '# Requisitos\n\n## Resumo\n- REQ-1: Clientes acompanham seus pedidos pelo portal\n- REQ-2: Clientes abrem chamados sem precisar mandar e-mail\n- REQ-3: Parceiros externos entram em uma segunda fase\n\n## Perguntas em aberto\n- Qual SSO?\n');
fs.writeFileSync(path.join(project, 'docs', 'specs', 'abrir-chamado-spec.md'), '# Clientes abrem chamados pelo portal\n\n## Contexto\nHoje o cliente só consegue abrir um chamado por e-mail, sem confirmação nem acompanhamento.\n\n## Critérios de aceite\n- [ ] O cliente, já logado, abre um chamado com assunto e descrição\n- [ ] Clicar duas vezes em enviar não cria dois chamados\n\n## Fora do escopo\n- Anexar arquivos\n- Conversar com o atendente\n');
fs.writeFileSync(path.join(project, 'docs', 'specs', 'login-spec.md'), '# Login corporativo\n\n## Contexto\nClientes entram com a conta da empresa.\n\n## Critérios de aceite\n- Entrar com a conta da empresa\n');
const store = () => new PipelineStateStore(project);
const stateOf = () => store().load()!;
/** Writes to the state as the pipeline would. The app reads the same file now and then, and on Windows a rename can lose a race with a read: try again. */
const seed = (ops: object[]) => {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = store().apply(ops);
      if (!r.ok) throw new Error(r.error);
      return;
    } catch (err) {
      if (attempt >= 20 || (err as NodeJS.ErrnoException).code !== 'EPERM') throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
};

const server = await startFakeServer(
  [
    /* 1 (after the last answer of gate 1) */ { content: 'Segui para a arquitetura.' },
    /* 2 (after "Pedir ajuste") */ { content: 'Vou refazer a funcionalidade com o seu comentário.' },
    /* 3 ("Enviar ao time técnico": drafts) */ { content: 'Rascunhos gerados em docs/issues/.' },
    /* 4 (the new project) */ { content: 'Comecei a ler os arquivos.' },
  ],
  { apiKey: KEY }
);
const config = path.join(tmp, 'alia-config.json');
fs.writeFileSync(config, JSON.stringify({ apiKey: KEY, apiType: 'chat-completions', models: [{ id: 'fake-model', name: 'fake', url: server.url, toolCalling: true, maxInputTokens: 128000 }] }));
const pdfOut = path.join(tmp, 'resumo.pdf');
const electronBinary: string = createRequire(path.join(desktop, 'package.json'))('electron');
const env = { ...process.env, ALIA_DESKTOP_DATA_DIR: data, ALIA_DESKTOP_TEST: '1', ALIA_CONFIG: config, ALIA_TEST_PICK_FOLDER: project, ALIA_TEST_SAVE_PATH: pdfOut } as NodeJS.ProcessEnv;
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
const focusEvent = () => page.evaluate(() => window.dispatchEvent(new Event('focus')));
const shot = (name: string) => (process.env.ALIA_SHOTS ? page.screenshot({ path: path.join(process.env.ALIA_SHOTS, name) }) : undefined);
const mode = (m: 'simple' | 'technical') => page.locator(`[data-testid=mode-toggle] button[data-mode=${m}]`).click();
const screenText = () => page.locator('.simple-screen').innerText();
const steps = () => page.locator('.simple-steps li');

try {
  await ok('settings.update', { permissionMode: 'auto', displayName: 'Newton', organization: 'Instituto Atlântico' });
  await ok('projects.pick');
  await ok('projectMeta.set', { projectPath: project, patch: { name: 'Portal do cliente', owner: 'Ana' } });
  seed([
    { op: 'set_project', name: 'Portal do cliente' },
    { op: 'add_input', name: 'Requisitos do portal.pdf', input_kind: 'document', handled_by: 'requirement-extraction-from-documents' },
    { op: 'add_input', name: 'Ata do kickoff.txt', input_kind: 'transcript', handled_by: 'requirement-extraction-from-threads' },
    { op: 'set_stage', stage: 1, status: 'running' },
    { op: 'add_question', gate: 'G1', id: 'q1', prompt: 'Como os clientes vão entrar no portal?', kind: 'choice', category: 'contradiction', options: [{ id: 'sso', label: 'Login corporativo desde o início', detail: 'Mais seguro, um pouco mais de trabalho', source: 'Requisitos do portal.pdf · p. 14' }, { id: 'senha', label: 'E-mail e senha primeiro', detail: 'O login corporativo fica para depois', source: 'Ata do kickoff.txt · 12:40' }] },
    { op: 'add_question', gate: 'G1', id: 'q2', prompt: 'Parceiros externos vão usar o portal?', kind: 'confirm', category: 'open_question' },
    { op: 'add_question', gate: 'G1', id: 'q3', prompt: 'Quantos usuários ao mesmo tempo o portal deve suportar?', kind: 'text', category: 'low_confidence' },
    { op: 'set_stage', stage: 1, status: 'done' },
  ]);
  await page.reload();
  await page.waitForSelector('.sidebar');

  console.log('\n=== the two views ===');
  check('the technical view is the one the app opens in, with the switch in the title bar', (await page.locator('.titlebar [data-testid=mode-toggle]').count()) === 1 && (await page.locator('.titlebar [data-mode=technical]').getAttribute('aria-pressed')) === 'true');
  await mode('simple');
  await page.getByTestId('simple-new').waitFor();
  check('the simple view has its own sidebar: "Novo projeto", "Meus projetos", "Como funciona" and who the person is', /novo projeto/i.test(await page.locator('.simple-sidebar').innerText()) && /meus projetos/i.test(await page.locator('.simple-sidebar').innerText()) && (await page.locator('.simple-sidebar').innerText()).includes('Como funciona') && (await page.locator('.simple-sidebar').innerText()).includes('Newton'));
  check('the choice of view is kept for the next time', (await page.evaluate(() => localStorage.getItem('alia.mode'))) === 'simple');
  const mine = page.getByTestId('simple-project');
  check('the project is in "Meus projetos" under the name the person gave it, and it is their turn', (await mine.count()) === 1 && (await mine.getAttribute('data-project')) === 'Portal do cliente' && (await page.getByTestId('simple-chip').innerText()) === 'Sua vez');
  check('the app opens on the project that was open last', (await page.getByRole('heading', { level: 1 }).innerText()) === 'Portal do cliente');

  console.log('\n=== the questions, one at a time ===');
  await mine.click();
  await page.getByTestId('simple-questions').waitFor({ timeout: 15000 });
  await page.waitForTimeout(600); // opening a project may swap its draft conversation once: let the screen settle
  await page.getByTestId('simple-questions').waitFor();
  await shot('simple-1-perguntas.png');
  check('the header says what the project is and for which client, with the switch in the page', (await page.locator('.simple-titlebar h1').innerText()) === 'Portal do cliente' && (await page.locator('.simple-titlebar .chip').innerText()) === 'Cliente: Embrapii' && (await page.locator('.simple-titlebar [data-testid=mode-toggle]').count()) === 1);
  check('the four steps of the flow are in plain words, the first is where the person is', (await steps().count()) === 4 && (await steps().nth(0).innerText()).includes('Entender o pedido') && (await steps().nth(0).getAttribute('data-state')) === 'current' && (await steps().nth(0).innerText()).includes('Você está aqui') && (await steps().nth(1).innerText()).includes('Desenhar a solução') && (await steps().nth(1).innerText()).includes('A seguir') && (await steps().nth(3).innerText()).includes('Planejar as entregas'), JSON.stringify(await steps().allInnerTexts()) + JSON.stringify(await steps().evaluateAll((e) => e.map((x) => x.getAttribute('data-state')))));
  check('it says how many files were read, and what was understood (from the requirements)', (await screenText()).includes('Lemos os 2 arquivos') && (await page.getByTestId('simple-understood').locator('li').count()) === 3 && (await page.getByTestId('simple-understood').innerText()).includes('Clientes acompanham seus pedidos pelo portal') && !(await page.getByTestId('simple-understood').innerText()).includes('REQ-1'));
  const question = page.getByTestId('simple-question');
  check('the first question is "Pergunta 1 de 3", with the files that disagree side by side', (await question.innerText()).includes('Pergunta 1 de 3') && (await question.innerText()).includes('Os arquivos discordam') && (await page.getByTestId('simple-sources').locator('figure').count()) === 2 && (await page.getByTestId('simple-sources').innerText()).includes('Requisitos do portal.pdf · p. 14'));
  check('besides the options there are two ways out, with what each means', (await question.innerText()).includes('Não sei: perguntar a outra pessoa') && (await question.innerText()).includes('Decidir depois') && (await question.innerText()).includes('Fica registrado como pendência, com você como responsável'));
  check('it cannot go on before the person picks, and it cannot go back from the first', (await page.getByTestId('simple-next').isDisabled()) && (await question.getByRole('button', { name: 'Voltar' }).isDisabled()));
  await question.getByRole('radio', { name: /Login corporativo desde o início/ }).check();
  await page.getByTestId('simple-next').click();
  await page.waitForFunction(() => document.querySelector('[data-testid=simple-question]')?.textContent?.includes('Pergunta 2 de 3'));
  const q1 = stateOf().gates[0].questions.find((q) => q.id === 'q1')!;
  check('the answer is recorded when the person goes on, in their name', q1.status === 'answered' && q1.answer === 'sso' && q1.by === 'Newton');
  check('what was answered is listed below, in the person’s words', (await page.getByTestId('simple-answered').innerText()).includes('Já respondidas (1)') && (await page.getByTestId('simple-answered').innerText()).includes('Login corporativo desde o início'));
  await question.getByRole('button', { name: 'Voltar' }).click();
  check('going back shows the answer already given, and it cannot be changed', (await question.innerText()).includes('Pergunta 1 de 3') && (await question.getByRole('radio', { name: /Login corporativo desde o início/ }).isChecked()) && (await question.innerText()).includes('Esta resposta já foi registrada.'));
  await page.getByTestId('simple-next').click();
  await question.getByRole('radio', { name: 'Sim' }).check();
  await page.getByTestId('simple-next').click();
  await page.waitForFunction(() => document.querySelector('[data-testid=simple-question]')?.textContent?.includes('Pergunta 3 de 3'));
  check('a yes-or-no question is answered Sim or Não', stateOf().gates[0].questions.find((q) => q.id === 'q2')!.answer === 'yes');
  check('the last question offers to send the answers and go on', (await page.getByTestId('simple-next').innerText()) === 'Enviar respostas e continuar');
  await question.getByRole('radio', { name: /Não sei: perguntar a outra pessoa/ }).check();
  check('"Não sei" is enough to go on, even to a text question', !(await page.getByTestId('simple-next').isDisabled()));
  const violations = await audit(page, { include: '.simple-screen' });
  check('the question screen has no accessibility violations (axe)', violations.length === 0, JSON.stringify(violations));
  await page.getByTestId('simple-next').click();
  await page.waitForFunction(() => ['stopped', 'working'].includes(document.querySelector('[data-testid=simple-status]')?.getAttribute('data-screen') ?? ''), undefined, { timeout: 20000 });
  const g1 = stateOf();
  check('"Não sei" went to the technical owner as a deferral they own, and the gate was approved by the person', g1.gates[0].questions.find((q) => q.id === 'q3')!.status === 'deferred' && g1.gates[0].questions.find((q) => q.id === 'q3')!.owner === 'Ana' && g1.gates[0].status === 'passed');
  for (let i = 0; i < 100 && server.requests.length === 0; i++) await new Promise((r) => setTimeout(r, 100));
  check('the work went on in the engine (the model was asked to continue)', server.requests.length >= 1);

  console.log('\n=== the architecture is the technical owner’s ===');
  await page.waitForFunction(() => document.querySelector('[data-testid=simple-status]')?.getAttribute('data-screen') === 'stopped' || document.querySelector('[data-testid=simple-status]')?.getAttribute('data-screen') === 'working', undefined, { timeout: 20000 });
  seed([
    { op: 'set_stage', stage: 2, status: 'running' },
    { op: 'add_question', gate: 'G2', id: 'b1', prompt: 'Quem é o dono das gravações?', kind: 'text', category: 'blocker' },
    { op: 'set_stage', stage: 2, status: 'done' },
  ]);
  await focusEvent();
  await page.waitForFunction(() => document.querySelector('[data-testid=simple-status]')?.getAttribute('data-screen') === 'owner', undefined, { timeout: 15000 });
  check('while the architecture waits, the screen says who decides and that there is nothing to do', (await screenText()).includes('Aguardando o responsável técnico') && (await screenText()).includes('Ana precisa decidir') && (await page.getByTestId('simple-open-technical').count()) === 1);
  check('the chip says it is with the technical owner, and the step says so too', (await page.getByTestId('simple-chip').innerText()) === 'Com o responsável técnico' && (await steps().nth(1).innerText()).includes('Com o responsável técnico'));
  await shot('simple-2-responsavel.png');

  console.log('\n=== the features ===');
  seed([
    { op: 'answer_question', id: 'b1', answer: 'O CRM continua dono', by: 'Ana' },
    { op: 'set_gate', gate: 'G2', status: 'passed' },
    { op: 'add_decision', question: 'Dados de cliente', answer: 'Os dados dos clientes continuam no CRM', stage: 2, by: 'Ana' },
    { op: 'set_stage', stage: 3, status: 'running' },
    { op: 'set_spec', slug: 'login', title: 'Clientes entram no portal com o login corporativo', persona: 'Clientes', depends_on: [], path: 'docs/specs/login-spec.md' },
    { op: 'set_spec', slug: 'abrir-chamado', title: 'Clientes abrem chamados pelo portal', persona: 'Clientes', depends_on: ['login'], path: 'docs/specs/abrir-chamado-spec.md' },
    { op: 'set_stage', stage: 3, status: 'done' },
  ]);
  await focusEvent();
  await page.getByTestId('simple-features').waitFor({ timeout: 15000 });
  await page.getByTestId('simple-right').waitFor();
  await shot('simple-3-funcionalidades.png');
  const features = page.getByTestId('simple-features');
  check('what the technical owner decided is reported, with a way to see the details', (await page.getByTestId('simple-solution-done').innerText()).includes('Desenhar a solução: concluída.') && (await page.getByTestId('simple-solution-done').innerText()).includes('Os dados dos clientes continuam no CRM'));
  check('the specs are features to confirm, "0 de 2 confirmadas"', (await features.innerText()).includes('Dividimos o projeto em 2 funcionalidades') && (await features.innerText()).includes('0 de 2 confirmadas'));
  check('the first one is open, with what it is, what must be true, and what is left for later (read from the spec)', (await features.locator('[data-feature="login"]').getAttribute('data-status')) !== 'reviewed' && (await features.innerText()).includes('Clientes entram com a conta da empresa.') && (await features.innerText()).includes('Vai estar pronto quando:'));
  await features.getByTestId('simple-right').click();
  await page.waitForFunction(() => document.querySelector('[data-testid=simple-features]')?.textContent?.includes('1 de 2 confirmadas'));
  check('"Está certo" confirms it in the person’s name', stateOf().specReviews.find((r) => r.spec === 'login')?.status === 'reviewed' && stateOf().specReviews.find((r) => r.spec === 'login')?.by === 'Newton');
  const second = features.locator('[data-feature="abrir-chamado"]');
  check('the next is open: for whom, what it depends on, the criteria and what stays for later', (await second.innerText()).includes('Para: Clientes') && (await second.innerText()).includes('Vem depois da funcionalidade 1') && (await second.innerText()).includes('Clicar duas vezes em enviar não cria dois chamados') && (await second.innerText()).includes('Fica para depois') && (await second.innerText()).includes('Anexar arquivos, Conversar com o atendente.'));
  await page.getByTestId('simple-wrong-open').click();
  check('"Algo está errado" asks what, and needs a comment', (await page.getByTestId('simple-wrong').innerText()).includes('O que está errado?') && (await page.getByRole('button', { name: 'Pedir ajuste' }).isDisabled()));
  await page.getByTestId('simple-wrong-text').fill('Parceiros também precisam abrir chamados.');
  await page.getByRole('button', { name: 'Pedir ajuste' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Pedir ajuste' }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid=simple-status]'), undefined, { timeout: 20000 });
  const sent = stateOf();
  check('sending it back reopens the specs: the feature is a draft, the stage is to be redone, and the comment is kept', sent.specReviews.find((r) => r.spec === 'abrir-chamado')?.status === 'draft' && sent.stages[2].status === 'stale' && sent.notes.some((n) => n.includes('Parceiros também precisam abrir chamados.')));

  console.log('\n=== the plan ===');
  fs.cpSync(path.resolve(desktop, '..', 'scripts', 'fixtures', 'pipeline', 'docs', 'tasks'), path.join(project, 'docs', 'tasks'), { recursive: true });
  const slugs = ['01-login-sso', '02-consultar-pedidos', '03-abrir-chamado', '04-acesso-parceiros'];
  const fresh = new PipelineStateStore(project);
  const base = fresh.load()!;
  fs.rmSync(path.join(project, 'docs', 'pipeline'), { recursive: true });
  const done = [
    { op: 'set_project', name: 'Portal do cliente' },
    { op: 'add_input', name: 'Requisitos do portal.pdf', input_kind: 'document' },
    ...[1, 2, 3, 4].flatMap((n) => [{ op: 'set_stage', stage: n, status: 'running' }, { op: 'set_stage', stage: n, status: 'done' }, ...(n < 4 ? [{ op: 'set_gate', gate: `G${n}`, status: 'passed' }] : [])]),
    ...slugs.map((slug, i) => ({ op: 'set_spec', slug, title: ['Clientes entram no portal com o login corporativo', 'Clientes consultam seus pedidos', 'Clientes abrem chamados pelo portal', 'Parceiros externos acessam o portal'][i], persona: 'Clientes', depends_on: i === 0 ? [] : i === 3 ? ['01-login-sso', '02-consultar-pedidos'] : ['01-login-sso'] })),
    ...slugs.map((spec) => ({ op: 'set_spec_review', spec, status: 'reviewed', by: 'Newton', date: '2026-11-18' })),
    { op: 'set_gate', gate: 'G3', status: 'passed' },
    { op: 'add_decision', question: 'Login', answer: 'Clientes entram com o login corporativo desde a primeira entrega', stage: 1, by: 'Newton' },
    { op: 'add_decision', question: 'Dados', answer: 'Os dados dos clientes continuam no CRM', stage: 2, by: 'Ana' },
    { op: 'add_assumption', text: 'Integração com o ERP fica fora da primeira entrega', owner: 'Newton', stage: 1 },
    { op: 'add_assumption', text: 'Definir quem acompanha os registros de erro do portal', owner: 'Ana', stage: 2 },
    { op: 'add_adr', id: 'ADR-001', title: 'Usar PostgreSQL', status: 'accepted' },
    { op: 'set_check', key: 'coverage', status: 'pass' },
  ];
  void base;
  seed(done);
  await focusEvent();
  await page.getByTestId('simple-plan-screen').waitFor({ timeout: 15000 });
  await page.getByTestId('simple-order').waitFor();
  await shot('simple-4-plano.png');
  const plan = page.getByTestId('simple-plan-screen');
  check('the project is "Pronto" and every step is done', (await page.getByTestId('simple-chip').innerText()) === 'Pronto' && (await page.locator('.simple-steps [data-state=done]').count()) === 4);
  check('the totals are in plain words: 4 funcionalidades, 11 tarefas, 45 pontos de esforço', (await page.getByTestId('simple-stats').innerText()).replace(/\s+/g, ' ') === '4 funcionalidades 11 tarefas 45 pontos de esforço');
  const order = page.getByTestId('simple-order').locator('li');
  check('the order of delivery says why: what is the base and what comes after what', (await order.count()) === 4 && (await order.nth(0).innerText()).includes('Base para todas as outras') && (await order.nth(1).innerText()).includes('Depois da 1') && (await order.nth(3).innerText()).includes('Depois da 1 e da 2') && (await order.nth(0).innerText()).includes('11 pontos · 3 tarefas'));
  check('what was decided is listed', (await page.getByTestId('simple-decisions').locator('li').count()) === 2 && (await page.getByTestId('simple-decisions').innerText()).includes('Os dados dos clientes continuam no CRM'));
  check('what is open is listed with whom and at which step', (await page.getByTestId('simple-pending').locator('li').count()) === 2 && (await page.getByTestId('simple-pending').innerText()).includes('Ana · Desenhar a solução') && (await plan.innerText()).includes('2 em aberto'));
  const planViolations = await audit(page, { include: '.simple-screen' });
  check('the plan screen has no accessibility violations (axe)', planViolations.length === 0, JSON.stringify(planViolations));

  await page.getByTestId('simple-pdf').click();
  await page.getByTestId('simple-plan-message').waitFor();
  const pdf = fs.readFileSync(pdfOut);
  check('the summary is a PDF the person saves where they choose', pdf.subarray(0, 4).toString() === '%PDF' && pdf.length > 1000 && (await page.getByTestId('simple-plan-message').innerText()).includes('Resumo salvo em'));
  await page.getByTestId('simple-link').click();
  await page.waitForFunction(() => document.querySelector('[data-testid=simple-plan-message]')?.textContent?.includes('Link copiado'));
  const resumo = fs.readFileSync(path.join(project, 'docs', 'pipeline', 'RESUMO.md'), 'utf8');
  check('the link leads to a Markdown summary kept in the project, with the same plan', resumo.includes('# Resumo do plano: Portal do cliente') && resumo.includes('4 funcionalidades · 11 tarefas · 45 pontos de esforço') && resumo.includes('Os dados dos clientes continuam no CRM'));

  await page.getByTestId('simple-send-button').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Salvar na pasta' }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid=simple-send]')?.classList.contains('sent'), undefined, { timeout: 25000 });
  await page.waitForFunction(() => document.querySelector('[data-testid=simple-chip]')?.textContent === 'Com o time técnico', undefined, { timeout: 10000 }).catch(() => {});
  check('with no connection to the team’s system it asks before writing drafts, and afterwards says it was sent', (await page.getByTestId('simple-send').innerText()).includes('Enviado ao time técnico') && (await page.getByTestId('simple-chip').innerText()) === 'Com o time técnico');
  check('the hand-over is kept in the project, so it survives a restart', JSON.parse(fs.readFileSync(path.join(project, '.alia', 'project.json'), 'utf8')).handedOff?.mode === 'drafts');

  console.log('\n=== a new project ===');
  await page.getByTestId('simple-new').click();
  await page.getByTestId('simple-new-project').waitFor();
  await shot('simple-0-novo-projeto.png');
  check('the client is a list of the flows, and what happens next in that flow is shown with where the person takes part', (await page.getByTestId('simple-client').inputValue()) === 'embrapii' && (await page.getByTestId('simple-flow-steps').locator('li').count()) === 4 && (await page.getByTestId('simple-flow-steps').innerText()).includes('Entender o pedido') && (await page.getByTestId('simple-flow-steps').locator('.chip').count()) === 2 && (await screenText()).includes('O que acontece depois no fluxo Embrapii'));
  check('it cannot begin without a name, and says so', (await page.getByTestId('simple-start').isDisabled()) && (await screenText()).includes('Dê um nome ao projeto.'));
  await page.getByTestId('simple-name').fill('Reembolso de despesas');
  check('with a name it still needs something to start from', (await page.getByTestId('simple-start').isDisabled()) && (await screenText()).includes('Conte o que você precisa ou anexe ao menos um arquivo.'));
  await page.getByTestId('simple-request').fill('Um jeito de pedir reembolso sem planilha.');
  await drop(brd);
  await page.waitForFunction(() => !!document.querySelector('.simple-files .input[data-state="ok"]'), undefined, { timeout: 15000 });
  check('a file is looked at before there is a project, and shown as ready, as what it is', (await page.locator('.simple-files .input').innerText()).includes('Documento') && (await page.locator('.simple-files .input').innerText()).includes('Pronto'));
  await page.getByTestId('simple-owner').fill('Ana');
  check('now it can begin', !(await page.getByTestId('simple-start').isDisabled()));
  await page.getByTestId('simple-start').click();
  await page.getByTestId('simple-project-screen').waitFor({ timeout: 25000 });
  const created = path.join(data, 'projects', 'reembolso-de-despesas');
  await page.waitForFunction(() => document.querySelector('.simple-titlebar h1')?.textContent === 'Reembolso de despesas', undefined, { timeout: 15000 });
  for (let i = 0; i < 100 && !new PipelineStateStore(created).load(); i++) await new Promise((r) => setTimeout(r, 100));
  const made = new PipelineStateStore(created).load()!;
  check('the project got a folder named after it, in the app’s own place', fs.existsSync(created));
  check('what was asked for is a file of the project and one of the inputs, beside the one attached', fs.readFileSync(path.join(created, 'docs', 'inputs', 'pedido-inicial.txt'), 'utf8').includes('sem planilha') && made.inputs.length === 2 && made.inputs.some((i) => i.name === 'pedido-inicial.txt'));
  check('the pipeline runs the flow of the client and carries the project’s name', made.flow === 'embrapii' && made.project === 'Reembolso de despesas');
  check('the name and the technical owner are kept with the project', JSON.parse(fs.readFileSync(path.join(created, '.alia', 'project.json'), 'utf8')).owner === 'Ana');
  check('both projects are in the list now', (await page.getByTestId('simple-project').count()) === 2);

  console.log('\n=== the flow in the technical view ===');
  await mode('technical');
  await page.getByTestId('new-pipeline').click();
  await page.getByTestId('flow-card').waitFor();
  await shot('flow-0-novo-pipeline.png');
  check('the intake has a list of flows, with Embrapii as the only one and the chosen', (await page.getByTestId('flow-select').locator('option').count()) === 1 && (await page.getByTestId('flow-select').inputValue()) === 'embrapii');
  check('the list is a labelled field: "Fluxo"', (await page.getByRole('combobox', { name: 'Fluxo' }).count()) === 1);
  check('it says what a flow defines', (await page.getByTestId('flow-card').innerText()).includes('Define as etapas, os gates e as skills do pipeline.') || (await page.getByTestId('flow-card').innerText()).includes('o fluxo não muda'), await page.getByTestId('flow-card').innerText());
  check('it names the stages of the flow with their skills', (await page.getByTestId('flow-stages').innerText()).includes('1 · Requisitos (requirement-extraction-from-documents)') && (await page.getByTestId('flow-stages').innerText()).includes('4 · Tarefas (spec-to-tasks)'));
  check('the old row of four stages is gone from the intake', (await page.getByRole('list', { name: 'Etapas do pipeline' }).count()) === 0);
  check('"Entradas" says the skill comes from the flow', (await page.getByTestId('pipeline-intake').innerText()).includes('escolhe a skill da etapa 1 do fluxo'));
  await page.locator('#intake-project').selectOption(project);
  await page.getByTestId('resume-banner').waitFor();
  check('a project that already has a pipeline says in which flow it stopped, and the flow cannot change', (await page.getByTestId('resume-banner').innerText()).includes('no fluxo Embrapii') && (await page.getByTestId('flow-select').isDisabled()));
  await page.getByTestId('open-state').count();
  await page.getByTestId('simple-new').count();
  await page.getByRole('button', { name: /Portal do cliente/ }).first().click();
  await page.getByTestId('pipeline-header').waitFor({ timeout: 15000 });
  check('the run shows which flow it is running', (await page.getByTestId('pipeline-flow').innerText()) === 'e2e-pipeline · fluxo embrapii');
  check('and its steps are named by the flow', (await page.locator('[data-step="1"]').innerText()).includes('Requisitos') && (await page.locator('[data-step="4"]').innerText()).includes('Tarefas'));
  await mode('simple');
  await page.getByTestId('simple-plan-screen').waitFor({ timeout: 15000 });
  check('the same project is in the simple view again, as it was', (await page.getByTestId('simple-plan-screen').count()) === 1);
} catch (err) {
  failures++;
  console.log(`  ✘ the suite stopped: ${(err as Error).stack ?? err}`);
  if (process.env.ALIA_SHOTS) await page.screenshot({ path: path.join(process.env.ALIA_SHOTS, 'simple-failed.png') }).catch(() => {});
} finally {
  await app.close();
  await server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`\n${failures} simple view check(s) failed.`);
  process.exit(1);
}
console.log('\nAll simple view and flow checks passed.');
