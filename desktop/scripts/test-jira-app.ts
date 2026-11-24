/**
 * "Conectar ao Jira" in the REAL built app, against a fake model endpoint and a fake Jira MCP server run as a local command:
 * the button on the final report, the dialog (Outro servidor MCP > Comando local), the connection test, the project, the pill,
 * "Publicar no Jira" with its confirmation, what is stored where (no secret in a plain file), and disconnecting.
 * Run from desktop/: `npm run test:jira-app` (builds first).
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
const fakeMcp = path.resolve(desktop, '..', 'scripts', 'lib', 'fakeMcpServer.ts');

const KEY = 'sk-test-JIRAKEY-12345678';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alia-jira-'));
const project = path.join(tmp, 'projeto');
fs.mkdirSync(project, { recursive: true });
fs.cpSync(path.resolve(desktop, '..', 'scripts', 'fixtures', 'pipeline', 'docs'), path.join(project, 'docs'), { recursive: true });
const outside = path.join(tmp, 'downloads');
fs.mkdirSync(outside);
const brd = path.join(outside, 'BRD.pdf');
fs.writeFileSync(brd, makePdf([['Requisitos do portal']]));
const data = path.join(tmp, 'data');

const slugs = ['01-login-sso', '02-consultar-pedidos', '03-abrir-chamado', '04-acesso-parceiros'];
const doneOps = [
  ...[1, 2, 3, 4].flatMap((n) => [{ op: 'set_stage', stage: n, status: 'running' }, { op: 'set_stage', stage: n, status: 'done' }, ...(n < 4 ? [{ op: 'set_gate', gate: `G${n}`, status: 'passed' }] : [])]),
  ...slugs.map((slug, i) => ({ op: 'set_spec', slug, title: ['Login com SSO', 'Consultar pedidos', 'Abrir chamado', 'Acesso de parceiros'][i], persona: 'Cliente', depends_on: i === 0 ? [] : i === 3 ? ['01-login-sso', '02-consultar-pedidos'] : ['01-login-sso'] })),
  ...slugs.map((spec) => ({ op: 'set_spec_review', spec, status: 'reviewed', by: 'Ana', date: '2026-11-18' })),
  { op: 'set_gate', gate: 'G3', status: 'passed' },
  { op: 'add_adr', id: 'ADR-001', title: 'Usar PostgreSQL', status: 'accepted' },
  { op: 'set_check', key: 'coverage', status: 'pass' },
];

const server = await startFakeServer(
  [
    /* 1 */ { toolCalls: [{ name: 'pipeline_state', id: 'p1', args: { action: 'update', ops: doneOps } }] },
    /* 2 */ { content: 'Pipeline concluído: 4 specs, 11 tarefas.' },
    /* 3 (publicar no Jira) */ { content: 'Issues criadas no Jira.' },
  ],
  { apiKey: KEY }
);
const config = path.join(tmp, 'alia-config.json');
fs.writeFileSync(config, JSON.stringify({ apiKey: KEY, apiType: 'chat-completions', models: [{ id: 'fake-model', name: 'fake', url: server.url, toolCalling: true, maxInputTokens: 128000 }] }));
const electronBinary: string = createRequire(path.join(desktop, 'package.json'))('electron');
const env = { ...process.env, ALIA_DESKTOP_DATA_DIR: data, ALIA_DESKTOP_TEST: '1', ALIA_CONFIG: config, ALIA_TEST_PICK_FOLDER: project } as NodeJS.ProcessEnv;
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
const dialog = () => page.getByTestId('jira-dialog');
const shot = (name: string) => (process.env.ALIA_SHOTS ? page.screenshot({ path: path.join(process.env.ALIA_SHOTS, name + '.png') }) : Promise.resolve());
const readData = (file: string) => {
  try {
    return fs.readFileSync(path.join(data, 'user-data', file));
  } catch {
    return undefined;
  }
};

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

  console.log('\n=== the button on the final report ===');
  check('"Conectar ao Jira" sits beside "Publicar issues", which is still there', (await page.getByTestId('jira-connect').isVisible()) && (await page.getByTestId('publish-issues').isVisible()));
  check('with nothing connected there is no pill and no "Publicar no Jira"', (await page.getByTestId('jira-pill').count()) === 0 && (await page.getByTestId('jira-publish').count()) === 0);

  console.log('\n=== the dialog: Outro servidor MCP, Comando local ===');
  await shot('jira-report');
  await page.getByTestId('jira-connect').click();
  await dialog().waitFor();
  await shot('jira-account');
  check('it opens on the account step, with Atlassian first and the can / cannot lists', (await dialog().getAttribute('data-step')) === 'account' && (await page.getByTestId('jira-choice-atlassian').isChecked()) && (await dialog().innerText()).includes('Apagar issues'));
  await page.getByTestId('jira-choice-other').check();
  await page.getByTestId('jira-next').click();
  check('"Outro servidor" leads to the form, where Continuar waits for a test', (await dialog().getAttribute('data-step')) === 'other' && (await page.getByTestId('jira-continue').isDisabled()));
  await page.getByTestId('jira-kind-stdio').click();
  check('a local command shows the warning that it runs on this computer', (await page.getByTestId('jira-stdio-warning').innerText()).includes('roda no seu computador'));

  await page.getByLabel('Comando', { exact: true }).fill(process.execPath);
  await page.getByLabel('Argumentos', { exact: true }).fill(`--import tsx "${fakeMcp}" stdio`);
  await page.getByRole('button', { name: '+ Adicionar variável' }).click();
  await page.getByLabel('Nome da variável 1').fill('FAKE_MCP_SECRET');
  await page.getByLabel('Valor da variável 1').fill('shh');
  await page.getByLabel('secreta').check();
  await page.getByRole('button', { name: '+ Adicionar variável' }).click();
  await page.getByLabel('Nome da variável 2').fill('FAKE_MCP_VARIANT');
  await page.getByLabel('Valor da variável 2').fill('wiki');

  await shot('jira-other-stdio');
  await page.getByTestId('jira-test').click();
  await page.getByTestId('jira-result-bad').waitFor({ timeout: 60000 });
  const bad = await page.getByTestId('jira-result-bad').innerText();
  check('a server that cannot create issues is refused, saying how many tools it has, and Continuar stays off', bad.includes('Este servidor não cria issues') && bad.includes('2 ferramentas') && (await page.getByTestId('jira-continue').isDisabled()), bad);

  await page.getByLabel('Valor da variável 2').fill('jira');
  check('changing the form throws away the old result', (await page.getByTestId('jira-result-bad').count()) === 0 && (await page.getByTestId('jira-continue').isDisabled()));
  await page.getByTestId('jira-test').click();
  await page.getByTestId('jira-result-ok').waitFor({ timeout: 60000 });
  const good = await page.getByTestId('jira-result-ok').innerText();
  check('a working server is "Conectado", with its tools and what it can do', good.includes('Conectado') && good.includes('7 ferramentas') && good.includes('Cria issues') && good.includes('Lista projetos'), good);
  await shot('jira-test-ok');
  await page.getByTestId('jira-continue').click();
  await page.getByTestId('jira-project-select').waitFor({ timeout: 30000 });
  check('the project step lists the projects the server offers', (await page.getByTestId('jira-project-select').locator('option').allInnerTexts()).some((o) => o.includes('Loja online') && o.includes('LOJA')));
  check('the mapping table is there, read only', (await page.getByTestId('jira-map').innerText()).includes('Épico'));
  check('and the server is already saved, with the secret in neither plain file', (await ok('mcp.get')).servers[0]?.connected === true);
  await shot('jira-project');
  await page.getByTestId('jira-project-select').selectOption({ label: 'Loja online (LOJA)' });
  await page.getByTestId('jira-save').click();
  await dialog().waitFor({ state: 'detached', timeout: 15000 });

  console.log('\n=== connected ===');
  await page.getByTestId('jira-pill').waitFor({ timeout: 15000 });
  await shot('jira-connected');
  check('the pill says Jira conectado · LOJA, with Gerenciar, and the primary action is now "Publicar no Jira"', (await page.getByTestId('jira-pill').innerText()).includes('Jira conectado · LOJA') && (await page.getByTestId('jira-manage').isVisible()) && (await page.getByTestId('jira-publish').innerText()).includes('Publicar no Jira') && (await page.getByTestId('jira-connect').count()) === 0);
  const view = await ok('mcp.get');
  check('the app says: connected, signed in, 7 tools, can create issues', view.servers.length === 1 && view.servers[0].connected && view.servers[0].signedIn && view.servers[0].tools === 7 && view.servers[0].capabilities.createsIssues);
  const target = JSON.parse(fs.readFileSync(path.join(project, 'docs', 'tasks', '.jira-target.json'), 'utf8'));
  check('the target is saved in the project, with no secret', target.projectKey === 'LOJA' && target.serverId === 'jira' && !JSON.stringify(target).includes('shh'));
  const cfg = readData('mcp.json')?.toString('utf8') ?? '';
  const vault = readData('mcp-credentials.bin');
  check('the config file has the command and the plain variable, never the secret one', cfg.includes('FAKE_MCP_SECRET') && !cfg.includes('shh') && cfg.includes('FAKE_MCP_VARIANT'));
  check('the secret is in the encrypted file only (not readable in it)', !!vault && !vault.toString('latin1').includes('shh') && !vault.toString('utf8').includes('shh'));

  console.log('\n=== Publicar no Jira ===');
  const before = server.requests.length;
  await page.getByTestId('jira-publish').click();
  const body = await page.getByTestId('jira-confirm-body').innerText();
  check('it asks first: how many tasks, how many points, which project', body.includes('11 tarefas') && body.includes('45 pontos') && body.includes('LOJA'), body);
  check('...and nothing was sent yet', server.requests.length === before);
  await page.getByTestId('jira-confirm').click();
  await finals(2);
  check('after the confirmation the conversation says it is publishing to Jira', (await page.locator('.turn.user').last().innerText()).includes('Publicar no Jira'));
  const sent = JSON.stringify(server.requests[before]);
  check('the agent got the Jira skill, the target, and the Jira tools (not the destructive one)', sent.includes('.jira-target.json') && sent.includes('project LOJA') && sent.includes('mcp__jira__createJiraIssue') && !sent.includes('deleteJiraIssue'));

  console.log('\n=== managing and disconnecting ===');
  await page.getByTestId('jira-manage').click();
  check('Gerenciar shows the connection and the project', (await page.getByTestId('jira-manage-status').innerText()).includes('LOJA'));
  await page.getByTestId('jira-disconnect').click();
  await page.getByRole('button', { name: 'Desconectar', exact: true }).last().click();
  await page.getByTestId('jira-connect').waitFor({ timeout: 15000 });
  check('disconnecting brings the button back and forgets the server, the secret and the target', (await ok('mcp.get')).servers.length === 0 && (await ok('jira.getTarget', { projectPath: project })) === null && !fs.existsSync(path.join(project, 'docs', 'tasks', '.jira-target.json')) && !readData('mcp-credentials.bin'));

  const unnamed = await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid=final-report] button')).filter((b) => !(b.getAttribute('aria-label') || b.textContent || '').trim()).length);
  check('every button of the report still has a name', unnamed === 0);
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
console.log('\nAll Jira connection app checks passed.');
