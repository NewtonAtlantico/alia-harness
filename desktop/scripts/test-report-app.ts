/**
 * The done screen (A15) in the REAL built app, against a fake model endpoint: the final report with the backlog by spec, the
 * checks across specs (computed from the task files, recorded by the model), what blocks, the assumptions, opening docs/tasks/,
 * and "Publicar issues" in both modes: asking first and writing drafts when there is no tracker connection, publishing when there
 * is one. Run from desktop/: `npm run test:report-app` (builds first).
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

const KEY = 'sk-test-REPORTKEY-12345678';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alia-report-'));
const project = path.join(tmp, 'projeto');
fs.mkdirSync(project, { recursive: true });
fs.cpSync(path.resolve(desktop, '..', 'scripts', 'fixtures', 'pipeline', 'docs'), path.join(project, 'docs'), { recursive: true });
const outside = path.join(tmp, 'downloads');
fs.mkdirSync(outside);
const brd = path.join(outside, 'BRD.pdf');
fs.writeFileSync(brd, makePdf([['Requisitos do portal']]));
const issuesFile = path.join(tmp, 'issues-connection.txt');
const firstTasks = path.join(project, 'docs', 'tasks', '01-login-sso-tasks.md');
const store = () => new PipelineStateStore(project);

const slugs = ['01-login-sso', '02-consultar-pedidos', '03-abrir-chamado', '04-acesso-parceiros'];
const doneOps = [
  ...[1, 2, 3, 4].flatMap((n) => [{ op: 'set_stage', stage: n, status: 'running' }, { op: 'set_stage', stage: n, status: 'done' }, ...(n < 4 ? [{ op: 'set_gate', gate: `G${n}`, status: 'passed' }] : [])]),
  ...slugs.map((slug, i) => ({ op: 'set_spec', slug, title: ['Login com SSO', 'Consultar pedidos', 'Abrir chamado', 'Acesso de parceiros'][i], persona: 'Cliente', depends_on: i === 0 ? [] : i === 3 ? ['01-login-sso', '02-consultar-pedidos'] : ['01-login-sso'] })),
  ...slugs.map((spec) => ({ op: 'set_spec_review', spec, status: 'reviewed', by: 'Ana', date: '2026-11-18' })),
  { op: 'set_gate', gate: 'G3', status: 'passed' }, // specs recorded after the gate reopen it; the people approve it once they are reviewed
  { op: 'add_adr', id: 'ADR-001', title: 'Usar PostgreSQL', status: 'accepted' },
  { op: 'add_adr', id: 'ADR-002', title: 'Fila de mensagens', status: 'accepted' },
  { op: 'add_adr', id: 'ADR-003', title: 'SSO corporativo', status: 'accepted' },
  { op: 'add_assumption', text: 'Sem multi-região no MVP', owner: 'Ana', stage: 2 },
  { op: 'set_check', key: 'coverage', status: 'pass' },
];

const server = await startFakeServer(
  [
    /* 1 */ { toolCalls: [{ name: 'pipeline_state', id: 'p1', args: { action: 'update', ops: doneOps } }] },
    /* 2 */ { content: 'Pipeline concluído: 4 specs, 11 tarefas.' },
    /* 3 (drafts) */ { content: 'Rascunhos gerados em docs/issues/.' },
    /* 4 (publish) */ { content: 'Issues publicadas.' },
  ],
  { apiKey: KEY }
);
const config = path.join(tmp, 'alia-config.json');
fs.writeFileSync(config, JSON.stringify({ apiKey: KEY, apiType: 'chat-completions', models: [{ id: 'fake-model', name: 'fake', url: server.url, toolCalling: true, maxInputTokens: 128000 }] }));
const electronBinary: string = createRequire(path.join(desktop, 'package.json'))('electron');
const env = { ...process.env, ALIA_DESKTOP_DATA_DIR: path.join(tmp, 'data'), ALIA_DESKTOP_TEST: '1', ALIA_CONFIG: config, ALIA_TEST_PICK_FOLDER: project, ALIA_TEST_ISSUES_FILE: issuesFile } as NodeJS.ProcessEnv;
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
const report = () => page.getByTestId('final-report');
const check1 = (key: string) => report().locator(`[data-check="${key}"]`);
const focusEvent = () => page.evaluate(() => window.dispatchEvent(new Event('focus')));
const opened = () => app.evaluate(() => (globalThis as any).__aliaTest.openedFiles as Array<{ abs: string; how: string }>);

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
  await report().waitFor({ timeout: 10000 });
  if (process.env.ALIA_SHOTS) await page.screenshot({ path: path.join(process.env.ALIA_SHOTS, 'report.png') });

  console.log('\n=== the finished pipeline ===');
  check('the header says it is done, and every stage is approved', (await page.getByTestId('run-chip').innerText()) === 'Pipeline concluído' && (await page.locator('[data-step]').evaluateAll((els) => els.every((e) => e.getAttribute('data-state') === 'done'))));
  check('the final report has the totals of the design: 4 specs, 11 tarefas, 45 pontos, 3 ADRs', (await report().getByTestId('report-totals').innerText()) === '4 specs · 11 tarefas · 45 pontos · 3 ADRs');
  check('nothing blocks, and it says so', (await report().getByTestId('report-clear').innerText()).includes('Nada bloqueado') && (await report().getByTestId('report-blocked').count()) === 0);

  console.log('\n=== the backlog by spec ===');
  check('each spec is listed with its title, tasks and points, and what it depends on', (await report().locator('[data-backlog="01-login-sso"] summary').innerText()).includes('Login com SSO') && (await report().locator('[data-backlog="01-login-sso"] summary').innerText()).includes('3 tarefas · 11 pontos') && (await report().locator('[data-backlog="04-acesso-parceiros"] summary').innerText()).includes('depende de 01-login-sso, 02-consultar-pedidos'));
  await report().locator('[data-backlog="02-consultar-pedidos"] summary').click();
  const rows = report().locator('[data-backlog="02-consultar-pedidos"] tbody tr');
  check('opened, it lists the tasks with id, points and dependencies', (await rows.count()) === 3 && (await rows.first().innerText()).includes('T2.1') && (await rows.first().innerText()).includes('5') && (await rows.nth(1).innerText()).length > 0);

  console.log('\n=== the checks across specs ===');
  check('four checks, all passing: points, cycles, dependencies against the stories, coverage (recorded by the model)', (await report().locator('[data-check]').count()) === 4 && (await report().locator('[data-check][data-state="pass"]').count()) === 4);
  check('they are worded as in the design', (await check1('story_dependencies').innerText()).includes('Dependências das tarefas seguem as dependências das histórias') && (await check1('coverage').innerText()).includes('Todo critério de aceite é coberto por uma tarefa'));

  console.log('\n=== a failure is explained, and blocks ===');
  fs.appendFileSync(firstTasks, '\n### 1.9 Enorme\n**Slice:** x\n**Story points:** 13\n**Depends on:** 1.1\n');
  store().apply([{ op: 'set_check', key: 'coverage', status: 'fail', detail: 'RF-12 e RF-13 não têm tarefa.' }]);
  await focusEvent();
  await report().getByTestId('report-blocked').waitFor({ timeout: 10000 });
  check('the points check fails and names the task, in Portuguese', (await check1('points').getAttribute('data-state')) === 'fail' && (await check1('points').innerText()).includes('Estas tarefas estão fora da escala de pontos:') && (await check1('points').innerText()).includes('Enorme (13 pontos)'));
  check('a check the model recorded keeps its own explanation', (await check1('coverage').innerText()).includes('RF-12 e RF-13 não têm tarefa.'));
  const blockedText = await report().getByTestId('report-blocked').innerText();
  check('what blocks is listed: the failed checks and the problem found in the task files', blockedText.includes('Falhou: Todo critério de aceite é coberto por uma tarefa.') && blockedText.includes('Falhou: Nenhuma tarefa acima de 8 pontos') && blockedText.includes('Nas tarefas:') && blockedText.includes('1.9'), blockedText);
  check('"Publicar issues" is off, and says why', (await page.getByTestId('publish-issues').isDisabled()) && (await report().innerText()).includes('Resolva o que bloqueia antes de publicar.'));
  fs.writeFileSync(firstTasks, fs.readFileSync(firstTasks, 'utf8').replace(/\n### 1\.9 Enorme[\s\S]*$/, '\n'));
  store().apply([{ op: 'set_check', key: 'coverage', status: 'pass' }]);
  await focusEvent();
  await report().getByTestId('report-clear').waitFor({ timeout: 10000 });
  check('fixed, it is clear again', (await page.getByTestId('publish-issues').isEnabled()) && (await report().locator('[data-check][data-state="pass"]').count()) === 4);

  console.log('\n=== assumptions, ADRs and the tasks folder ===');
  check('assumptions come with their owner, and the ADRs are listed', (await report().locator('[data-assumption]').innerText()).includes('Sem multi-região no MVP') && (await report().locator('[data-assumption]').innerText()).includes('responsável: Ana') && (await report().locator('[data-adr]').count()) === 3);
  await report().getByRole('button', { name: 'Abrir docs/tasks/' }).click();
  await sleep(300);
  check('"Abrir docs/tasks/" opens the folder with the system', (await opened()).some((f) => f.abs.endsWith(path.join('docs', 'tasks')) && f.how === 'open'), JSON.stringify(await opened()));

  console.log('\n=== publishing without a tracker connection ===');
  const before = server.requests.length;
  await page.getByTestId('publish-issues').click();
  const dialog = page.getByRole('dialog', { name: 'Não há conexão com um rastreador de issues' });
  await dialog.waitFor();
  const body = await dialog.innerText();
  check('it asks first: the tasks will not be published, the drafts go to docs/issues/, and the reason is shown', body.includes('não serão publicadas') && body.includes('docs/issues/') && body.includes('No issue tracker connection was found') && body.includes('no git remote'), body);
  check('the safe button has the focus', (await page.evaluate(() => document.activeElement?.textContent)) === 'Cancelar');
  await page.keyboard.press('Escape');
  await sleep(300);
  check('cancelling starts nothing', (await dialog.count()) === 0 && server.requests.length === before && (await page.locator('.turn.user').last().innerText()).includes('Iniciar o pipeline'));
  await page.getByTestId('publish-issues').click();
  await dialog.waitFor();
  await dialog.getByRole('button', { name: 'Gerar rascunhos' }).click();
  await finals(2);
  check('after the confirmation it writes drafts: the conversation says so and the agent is told not to publish', (await page.locator('.turn.user').last().innerText()).includes('Gerar rascunhos de issues') && JSON.stringify(server.requests[before]).includes('do not try to publish anything') && JSON.stringify(server.requests[before]).includes('docs/issues/') && JSON.stringify(server.requests[before]).includes('issue-writer'));

  console.log('\n=== publishing with a connection ===');
  fs.writeFileSync(issuesFile, 'ready');
  const mid = server.requests.length;
  await page.getByTestId('publish-issues').click();
  await finals(3);
  check('it detected the connection at this attempt: no question, it publishes through the skill', (await page.getByRole('dialog').count()) === 0 && (await page.locator('.turn.user').last().innerText()).includes('Publicar issues') && JSON.stringify(server.requests[mid]).includes('Publish the tasks in docs/tasks/') && JSON.stringify(server.requests[mid]).includes('(gh)'));
  fs.writeFileSync(issuesFile, '');
  await page.getByTestId('publish-issues').click();
  await page.getByRole('dialog', { name: 'Não há conexão com um rastreador de issues' }).waitFor();
  check('and when the connection is gone it asks again (a confirmation does not last)', (await page.getByRole('dialog').count()) === 1 && (await page.getByRole('dialog').innerText()).includes('docs/issues/'));
  await page.keyboard.press('Escape');

  console.log('\n=== accessibility ===');
  const unnamed = await page.evaluate(() => {
    const bad: string[] = [];
    for (const el of Array.from(document.querySelectorAll('[data-testid=final-report] button, [data-testid=final-report] summary'))) {
      const h = el as HTMLElement;
      if (!(h.getAttribute('aria-label') || h.textContent || '').trim()) bad.push(h.outerHTML.slice(0, 90));
    }
    return bad;
  });
  check('every button of the report has a name', unnamed.length === 0, unnamed.join(' | '));
  check('the report is a labelled section, and a check is not told by colour alone (a word and a mark)', (await report().getAttribute('aria-labelledby')) === 'report-title' && (await check1('points').innerText()).includes('passou'));
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
console.log('\nAll final report checks passed.');
