/**
 * The settings screen (A4) driven like a person would, in the REAL built app, against a fake model endpoint:
 * first run, typing the key, testing the connection, saving, restarting, the allowlist, removing the key,
 * importing an old configuration. Also proves the API key is never visible to the page and never in a plain file.
 * Run from desktop/: `npm run test:settings-app` (builds first). Opens a window for a few seconds.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
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

const KEY = 'sk-test-ENDPOINTKEY-42424242';
const LEGACY_KEY = 'sk-legacy-OLDCONFIGKEY-98989898';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alia-settings-app-'));
const dataDir = path.join(tmp, 'data');
const project = path.join(tmp, 'project');
fs.mkdirSync(project);

const server = await startFakeServer(
  [
    { content: 'Olá!' },
    { toolCalls: [{ name: 'run_bash', args: { command: 'echo remembered' }, id: 'b1' }] },
    { content: 'feito' },
    { content: 'Voltei depois de reiniciar.' },
    { toolCalls: [{ name: 'run_bash', args: { command: 'echo auto-ok' }, id: 'b2' }] },
    (req) => ({ content: `automático: ${String(req.messages.filter((m: any) => m.role === 'tool').pop()?.content).trim()}` }),
  ],
  { apiKey: KEY }
);

// An earlier setup, for the import: its own folder, its own .env.
const legacyDir = path.join(tmp, 'legacy');
fs.mkdirSync(legacyDir);
const legacyFile = path.join(legacyDir, 'alia-config.json');
fs.writeFileSync(legacyFile, JSON.stringify({ name: 'old', vendor: 'x', apiKey: '', apiType: 'chat-completions', models: [{ id: 'old-model', name: 'Antigo', url: server.url, toolCalling: true, maxInputTokens: 64000 }] }));
fs.writeFileSync(path.join(legacyDir, '.env'), `ALIA_API_KEY=${LEGACY_KEY}\n`);

const electronBinary: string = createRequire(path.join(desktop, 'package.json'))('electron');
const baseEnv = { ...process.env, ALIA_DESKTOP_DATA_DIR: dataDir, ALIA_DESKTOP_TEST: '1', ALIA_TEST_PICK_FOLDER: project, ALIA_TEST_PICK_FILE: legacyFile } as NodeJS.ProcessEnv;
for (const k of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'ALIA_API_KEY', 'OPENAI_API_KEY', 'ALIA_CONFIG']) delete baseEnv[k]; // none of the developer's own settings may leak in

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ executablePath: electronBinary, args: ['.'], cwd: desktop, env: baseEnv });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('.titlebar');
  await page.evaluate(() => {
    const w = window as any;
    w.__msgs = [];
    w.alia.onMessage((m: unknown) => w.__msgs.push(m));
  });
  return { app, page };
}

const call = (page: Page, name: string, payload: object = {}) =>
  page.evaluate(([n, p]) => (window as any).alia.request(n, p).then((result: unknown) => ({ ok: true, result }), (err: Error) => ({ ok: false, error: String(err.message) })), [name, payload] as const) as Promise<any>;
const ok = async (page: Page, name: string, payload: object = {}) => {
  const r = await call(page, name, payload);
  if (!r.ok) throw new Error(`${name}: ${r.error}`);
  return r.result;
};
const waitFor = async <T>(fn: () => Promise<T | undefined>, ms = 15000, label = 'condition'): Promise<T> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
};
const messages = (page: Page): Promise<any[]> => page.evaluate(() => (window as any).__msgs);
const finished = async (page: Page, sessionId: string, n: number) => waitFor(async () => (await messages(page)).filter((m) => m.kind === 'event' && m.sessionId === sessionId && m.event.type === 'run_finished').map((m) => m.event)[n], 20000, `run ${n}`);

const savedStatus = (page: Page) => page.locator('[data-testid=status]');

let { app, page } = await launch();
try {
  console.log('\n=== first run ===');
  await page.waitForSelector('.settings');
  check('with nothing configured the app opens on the settings screen, with a welcome note', (await page.locator('.settings').count()) === 1 && (await page.getByText('Vamos configurar o acesso aos modelos').count()) === 1);
  const v0 = await ok(page, 'settings.get');
  check('nothing is configured, and secure storage is available', v0.configured === false && v0.hasApiKey === false && v0.secureStorage === true && v0.models.length === 0);
  check('the name defaults from the Windows account', typeof v0.displayName === 'string' && v0.displayName.length > 0);
  check('the save button is off until something changes', await page.getByRole('button', { name: 'Salvar' }).isDisabled());

  console.log('\n=== testing the connection ===');
  await page.getByLabel('Endereço do serviço (URL)').fill(server.url);
  await page.getByRole('button', { name: 'Testar conexão' }).click();
  check('testing without a key asks for the key', (await page.getByText('Informe a chave de API para testar.').count()) === 1);
  await page.getByLabel('Chave de API').fill('sk-wrong-KEY-000000000');
  await page.getByRole('button', { name: 'Testar conexão' }).click();
  await page.getByTestId('test-result').waitFor();
  check('a wrong key is explained in plain words', (await page.getByTestId('test-result').innerText()).includes('A chave de API foi recusada'));
  await page.getByLabel('Chave de API').fill(KEY);
  await page.getByRole('button', { name: 'Testar conexão' }).click();
  await page.getByText('Conexão estabelecida').waitFor();
  check('the right key connects, and says how many models the service reports', (await page.getByTestId('test-result').innerText()).includes('1 modelo'));
  await page.getByRole('button', { name: 'Adicionar', exact: true }).click();
  check('a model the service reports can be added with one click', (await page.getByLabel('Identificador 1').inputValue()) === 'fake-model');
  await page.getByLabel('Contexto (tokens) 1').fill('200000');

  console.log('\n=== validation ===');
  await page.getByLabel('Endereço do serviço (URL)').fill('ftp://nope');
  await page.getByRole('button', { name: 'Salvar' }).click();
  check('a bad address is explained next to the field, and nothing is saved', (await page.getByText('Informe um endereço http ou https').count()) >= 1 && (await ok(page, 'settings.get')).endpointUrl === '');
  check('the error is announced to screen readers (role=alert) and the field is marked invalid', (await page.locator('[role=alert]').count()) >= 1 && (await page.getByLabel('Endereço do serviço (URL)').getAttribute('aria-invalid')) === 'true');
  await page.getByLabel('Endereço do serviço (URL)').fill(server.url);
  await page.getByRole('button', { name: 'Adicionar modelo' }).click();
  await page.getByLabel('Identificador 2').fill('fake-model');
  await page.getByRole('button', { name: 'Salvar' }).click();
  check('a repeated model id is refused', (await page.getByText('aparece mais de uma vez').count()) === 1);
  await page.getByLabel('Identificador 2').fill('');
  await page.getByRole('button', { name: 'Salvar' }).click();
  check('an empty model id is refused', (await page.getByText('precisa de um identificador').count()) === 1);
  await page.getByRole('button', { name: 'Remover o modelo' , exact: false }).last().click();
  check('a model row can be removed', (await page.getByLabel('Identificador 2').count()) === 0);

  console.log('\n=== saving ===');
  await page.getByLabel('Seu nome').fill('Maria');
  await page.getByLabel('Organização').fill('Instituto Atlântico');
  await page.getByRole('button', { name: 'Salvar' }).click();
  await savedStatus(page).waitFor();
  check('saving confirms it', (await savedStatus(page).innerText()).includes('Configurações salvas'));
  const v1 = await ok(page, 'settings.get');
  check('what was typed is in the settings, and the app is configured', v1.configured && v1.hasApiKey && v1.endpointUrl === server.url && v1.models.length === 1 && v1.models[0].maxInputTokens === 200000 && v1.displayName === 'Maria' && v1.organization === 'Instituto Atlântico' && v1.permissionMode === 'ask-commands');
  check('the key field is gone, replaced by "saved and protected"', (await page.getByTestId('key-saved').count()) === 1 && (await page.locator('input[type=password]').count()) === 0);

  console.log('\n=== the key is never visible to the page, nor in a plain file ===');
  const pageSees = await page.evaluate(() => ({ html: document.documentElement.outerHTML, values: Array.from(document.querySelectorAll('input')).map((i) => (i as HTMLInputElement).value).join('|'), msgs: JSON.stringify((window as any).__msgs) }));
  check('no part of the key is in the page\'s HTML, in any field, or in anything pushed to it', !pageSees.html.includes('ENDPOINTKEY') && !pageSees.values.includes('ENDPOINTKEY') && !pageSees.msgs.includes('ENDPOINTKEY'));
  check('settings.get and every reply about settings have no key', !JSON.stringify(v1).includes('ENDPOINTKEY') && !JSON.stringify(await ok(page, 'settings.testConnection', {})).includes('ENDPOINTKEY'));
  const userData = path.join(dataDir, 'user-data');
  const settingsJson = fs.readFileSync(path.join(userData, 'settings.json'), 'utf8');
  const creds = fs.readFileSync(path.join(userData, 'credentials.bin'));
  check('settings.json holds the endpoint and models but no key', settingsJson.includes(server.url) && !settingsJson.includes('ENDPOINTKEY'));
  check('credentials.bin exists and is encrypted (the key is not in it, in any form)', creds.length > 20 && !creds.toString('latin1').includes('ENDPOINTKEY') && !creds.toString('utf8').includes('sk-test') && !creds.toString('latin1').includes(Buffer.from(KEY).toString('base64')));

  console.log('\n=== the saved settings drive the engine ===');
  const picked = await ok(page, 'projects.pick');
  const session = await ok(page, 'session.open', { projectPath: project });
  check('a conversation opens with the saved model and context size', session.model === 'fake-model' && session.usage.limit === 200000);
  await ok(page, 'session.run', { sessionId: session.sessionId, text: 'oi' });
  check('and runs against the endpoint with the saved key (the fake endpoint rejects any other)', (await finished(page, session.sessionId, 0)).result.text === 'Olá!');
  await ok(page, 'session.run', { sessionId: session.sessionId, text: 'rode um comando' });
  const card = await waitFor(async () => (await messages(page)).find((m) => m.kind === 'interaction'), 15000, 'the approval card');
  check('the default approval mode asks before a command', card.interaction.command === 'echo remembered');
  await ok(page, 'interaction.respond', { id: card.interaction.id, response: { decision: 'allow_always' } });
  await finished(page, session.sessionId, 1);
  check('the project was remembered', (await ok(page, 'projects.recent')).includes(picked.path));

  console.log('\n=== the allowlist, in the settings screen ===');
  await page.getByRole('button', { name: 'Voltar' }).click();
  await page.getByRole('button', { name: 'Configurações', exact: true }).click();
  await page.waitForSelector('[data-testid=rules]');
  check('the command that was "always allowed" is listed under its project', (await page.getByTestId('rules').innerText()).includes('echo remembered') && (await page.getByLabel('Projeto', { exact: true }).inputValue()) === picked.path);
  await page.getByRole('button', { name: 'Remover a permissão do comando echo remembered' }).click();
  await page.getByText('Nenhum comando permitido neste projeto.').waitFor();
  check('removing it works, and the file agrees', (await ok(page, 'permissions.listForProject', { projectPath: project })).length === 0);

  console.log('\n=== restarting the app ===');
  await app.close();
  ({ app, page } = await launch());
  await page.waitForSelector('.display');
  check('the next start goes straight to the app (nothing to set up again)', (await page.locator('.settings').count()) === 0 && (await page.locator('.display').innerText()).startsWith('Maria'));
  const v2 = await ok(page, 'settings.get');
  check('everything persisted, including the encrypted key', v2.configured && v2.hasApiKey && v2.endpointUrl === server.url && v2.organization === 'Instituto Atlântico');
  const reopened = await ok(page, 'session.open', { projectPath: project });
  check('the folder opened earlier can be opened again without the dialog', reopened.workspace === path.resolve(project));
  const other = await call(page, 'session.open', { projectPath: tmp });
  check('...but a folder never opened still cannot', other.ok === false && /folder dialog/.test(other.error));
  await ok(page, 'session.run', { sessionId: reopened.sessionId, text: 'depois do reinício' });
  check('the decrypted key reaches the engine after a restart', (await finished(page, reopened.sessionId, 0)).result.text === 'Voltei depois de reiniciar.');

  console.log('\n=== changing the approval mode ===');
  await page.getByRole('button', { name: 'Configurações', exact: true }).click();
  await page.getByLabel('Automático (sem perguntas)').check();
  await page.getByRole('button', { name: 'Salvar' }).click();
  await savedStatus(page).waitFor();
  const auto = await ok(page, 'session.open', { projectPath: project });
  await ok(page, 'session.run', { sessionId: auto.sessionId, text: 'rode outro comando' });
  const autoFin = await finished(page, auto.sessionId, 0);
  check('a new conversation follows it: the command runs with no card', autoFin.result.text.includes('auto-ok') && !(await messages(page)).some((m) => m.kind === 'interaction' && m.interaction.sessionId === auto.sessionId));

  console.log('\n=== removing the key, importing an old configuration ===');
  await page.getByRole('button', { name: 'Remover chave' }).click();
  await page.locator('input[type=password]').waitFor();
  const v3 = await ok(page, 'settings.get');
  check('removing the key deletes it and the app is no longer configured', v3.hasApiKey === false && v3.configured === false && !fs.existsSync(path.join(userData, 'credentials.bin')));
  await page.getByRole('button', { name: 'Importar de um arquivo…' }).click();
  await page.getByText('Configuração importada').waitFor();
  const v4 = await ok(page, 'settings.get');
  check('importing brings the endpoint, the models and the key from the old files', v4.configured && v4.models.length === 1 && v4.models[0].id === 'old-model' && v4.models[0].maxInputTokens === 64000 && v4.hasApiKey);
  const credsNow = fs.readFileSync(path.join(userData, 'credentials.bin'));
  check('the imported key is encrypted like any other, and never reached the page', !credsNow.toString('latin1').includes('OLDCONFIGKEY') && !JSON.stringify(await messages(page)).includes('OLDCONFIGKEY') && !(await page.evaluate(() => document.documentElement.outerHTML)).includes('OLDCONFIGKEY'));

  console.log('\n=== accessibility basics ===');
  const unnamed = await page.evaluate(() => {
    const bad: string[] = [];
    for (const el of Array.from(document.querySelectorAll('.settings input, .settings select, .settings button'))) {
      const html = el as HTMLInputElement;
      const labelledBy = html.getAttribute('aria-labelledby');
      const name = (html.getAttribute('aria-label') || (labelledBy && document.getElementById(labelledBy)?.textContent) || (html.labels && html.labels[0]?.textContent) || html.textContent || '').trim();
      if (!name) bad.push(html.outerHTML.slice(0, 80));
    }
    return bad;
  });
  check('every field and button on the screen has a name a screen reader can read', unnamed.length === 0, unnamed.join(' | '));
  const logs = fs.readdirSync(path.join(userData, 'logs')).map((f) => fs.readFileSync(path.join(userData, 'logs', f), 'utf8')).join('\n');
  check('the log never contains either key, but says what happened', !logs.includes('ENDPOINTKEY') && !logs.includes('OLDCONFIGKEY') && logs.includes('engine configured') && logs.includes('imported 1 model'));
} catch (err: any) {
  failures++;
  console.log(`  ✘ ${err?.stack ?? err}`);
} finally {
  await app.close().catch(() => {});
  await server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll settings screen checks passed.');
