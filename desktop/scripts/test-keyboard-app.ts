/**
 * Using the app with the keyboard alone (A18), in the REAL built app: the Tab order follows the screen (sidebar first, then the
 * conversation, the composer in reach, no trap), menus and dialogs open with Enter or Space and close with Esc, and focus goes
 * back to what opened them. The visible focus ring and the names are audited on every screen by the journey and its axe run.
 * Run from desktop/: `npm run test:keyboard-app` (builds first).
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
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

const KEY = 'sk-test-KEYBOARDKEY-12345678';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alia-keyboard-'));
const project = path.join(tmp, 'projeto');
fs.mkdirSync(project, { recursive: true });
const server = await startFakeServer([{ content: 'Olá! Como posso ajudar?' }], { apiKey: KEY });
const config = path.join(tmp, 'alia-config.json');
fs.writeFileSync(config, JSON.stringify({ apiKey: KEY, apiType: 'chat-completions', models: [{ id: 'fake-model', name: 'fake', url: server.url, toolCalling: true, maxInputTokens: 128000 }, { id: 'second', name: 'second', url: server.url, toolCalling: true, maxInputTokens: 128000 }] }));
const electronBinary: string = createRequire(path.join(desktop, 'package.json'))('electron');
const env = { ...process.env, ALIA_DESKTOP_DATA_DIR: path.join(tmp, 'data'), ALIA_DESKTOP_TEST: '1', ALIA_CONFIG: config, ALIA_TEST_PICK_FOLDER: project } as NodeJS.ProcessEnv;
for (const k of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'ALIA_API_KEY', 'OPENAI_API_KEY']) delete env[k];

const app: ElectronApplication = await electron.launch({ executablePath: electronBinary, args: ['.'], cwd: desktop, env });
const page: Page = await app.firstWindow();
await page.waitForLoadState('domcontentloaded');
await page.waitForSelector('.sidebar');
const call = (name: string, payload: object = {}) => page.evaluate(([n, p]) => (window as any).alia.request(n, p), [name, payload] as const) as Promise<any>;
const focused = () => page.evaluate(() => { const e = document.activeElement as HTMLElement | null; return e ? ((e.getAttribute('aria-label') || e.textContent || e.tagName).trim().replace(/\s+/g, ' ').slice(0, 40)) : ''; });
const inside = (selector: string) => page.evaluate((s) => !!document.activeElement?.closest(s), selector);

try {
  await call('settings.update', { permissionMode: 'auto' });
  await call('projects.pick');
  await page.getByRole('button', { name: 'Abrir pasta…' }).click();
  const box = page.getByRole('combobox', { name: 'Mensagem' });
  await box.waitFor({ timeout: 15000 });
  await box.fill('oi');
  await box.press('Enter');
  await page.getByText('Olá! Como posso ajudar?').waitFor({ timeout: 15000 });

  console.log('\n=== the Tab order ===');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const order: string[] = [];
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Tab');
    order.push(await focused());
  }
  const at = (needle: RegExp) => order.findIndex((o) => needle.test(o));
  check('it starts in the sidebar (the window buttons are not stops: the system has its own keys for them), at "Nova conversa", then "Novo pipeline" and the search', /^Nova conversa/.test(order[0]) && /Novo pipeline/.test(order[1]) && /Buscar conversas/.test(order[2]), order.slice(0, 5).join(' | '));
  check('the sidebar comes before the conversation, and the composer is within reach', at(/Configurações/) >= 0 && at(/Configurações/) < at(/Mensagem/) && at(/Mensagem/) > 0 && at(/Mensagem/) < 40, order.join(' | '));
  const firstRepeat = order.findIndex((o, i) => i > 0 && order.indexOf(o) !== i && o !== '' && !/^(Copiar|Fechar|OK)/.test(o));
  check('no control is visited twice before the composer (no trap, no loop)', firstRepeat === -1 || firstRepeat > at(/Mensagem/), `repeat at ${firstRepeat}: ${order[firstRepeat]}`);

  console.log('\n=== menus: Enter opens, Esc closes, focus goes back ===');
  const chip = page.getByTestId('model-chip');
  await chip.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('menu').waitFor();
  check('the model menu opens with Enter and lists the models', (await page.getByRole('menuitemradio').count()) === 2);
  await page.keyboard.press('Escape');
  await page.getByRole('menu').waitFor({ state: 'detached' });
  check('Esc closes it, and the focus is still on the button that opened it', (await focused()).startsWith('Modelo'));
  await chip.focus();
  await page.keyboard.press('Space');
  await page.getByRole('menu').waitFor();
  check('Space opens it too', (await page.getByRole('menu').count()) === 1);
  await page.keyboard.press('Escape');

  console.log('\n=== dialogs: the safe button first, Esc closes, focus goes back ===');
  // The row's buttons appear when the row has the focus (the title gets the room otherwise): Tab from the row reaches them.
  await page.locator('.conv-main').first().focus();
  const seen: string[] = [];
  for (let i = 0; i < 4 && !/^Excluir a conversa/.test(await focused()); i++) {
    await page.keyboard.press('Tab');
    seen.push(await focused());
  }
  check('Tab from a conversation reaches its rename and then its delete button', seen.some((x) => /^Renomear a conversa/.test(x)) && /^Excluir a conversa/.test(await focused()), seen.join(' | '));
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  check('the dialog opens, and the focus is inside it, on Cancelar', (await inside('[role=dialog]')) && /Cancelar/.test(await focused()), await focused());
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  check('Tab does not leave the dialog (the page behind is out of reach)', await inside('[role=dialog]'));
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  check('Esc closes it without deleting, and the focus returns to the button that opened it', /^Excluir a conversa/.test(await focused()) && (await page.getByRole('button', { name: /^Excluir a conversa/ }).count()) >= 1, await focused());

  console.log('\n=== the settings screen, by keyboard ===');
  await page.getByRole('button', { name: 'Configurações' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: 'Configurações', level: 1 }).waitFor();
  await page.getByRole('button', { name: 'Voltar' }).focus();
  await page.keyboard.press('Enter');
  await box.waitFor();
  check('it opens with Enter and Voltar brings the conversation back', (await box.count()) === 1);

  console.log('\n=== the composer menu ===');
  await box.fill('@');
  await page.getByTestId('composer-menu').waitFor();
  await box.press('Escape');
  await page.getByTestId('composer-menu').waitFor({ state: 'detached' });
  check('Esc closes the @ menu and the focus stays in the box', (await focused()) === 'Mensagem');

  console.log('\n=== the panel ===');
  await page.getByTestId('panel-toggle').focus();
  await page.keyboard.press('Enter');
  await page.getByTestId('side-panel').waitFor();
  await page.getByRole('tab', { name: 'Alterações' }).focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  check('the tabs move with the arrows and the focus follows', (await page.getByRole('tab', { selected: true }).innerText()) === 'Terminal' && (await focused()) === 'Terminal');
  await page.keyboard.press('Home');
  check('Home goes to the first', (await focused()) === 'Alterações');
} catch (err: any) {
  failures++;
  console.log(`  ✘ ${err?.stack ?? err}`);
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
console.log('\nAll keyboard checks passed.');
