/**
 * The composer (A7) driven like a person would, in the REAL built app, against a fake model endpoint: typing and
 * sending, multi-line, history, the @ and / menus, the app's own slash commands, attaching files (button, drop),
 * what a mention may read, and Stop. Run from desktop/: `npm run test:composer-app` (builds first).
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { startFakeServer } from './lib/fakeServer';
import { audit, describeViolations } from './lib/axe';
import { makeHang, sleep } from './lib/hang';

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

const KEY = 'sk-test-COMPOSERKEY-12345678';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alia-composer-'));
const project = path.join(tmp, 'projeto');
fs.mkdirSync(path.join(project, 'src'), { recursive: true });
fs.mkdirSync(path.join(project, 'docs'), { recursive: true });
fs.writeFileSync(path.join(project, 'README.md'), '# Projeto\n');
fs.writeFileSync(path.join(project, 'src', 'app.ts'), 'export const app = 1;\n');
fs.writeFileSync(path.join(project, 'src', 'util.ts'), 'export const UTIL_MARKER = 42;\n');
fs.writeFileSync(path.join(project, 'docs', 'Proposta Técnica.txt'), 'PROPOSTA-CONTEUDO\n');
const outside = path.join(tmp, 'fora');
fs.mkdirSync(outside);
const brd = path.join(outside, 'BRD de teste.txt');
fs.writeFileSync(brd, 'BRD-CONTEUDO-EXTERNO\n');
const dropped = path.join(outside, 'solto.txt');
fs.writeFileSync(dropped, 'SOLTO-CONTEUDO\n');
const hang = makeHang(tmp);
const pidFile = path.join(tmp, 'hang.pid');

const server = await startFakeServer(
  [
    { content: 'Olá! Como posso ajudar?' },
    { content: 'ok2' },
    { content: 'li o util' },
    { content: 'li a pasta' },
    { content: 'li o anexo' },
    { toolCalls: [{ name: 'run_bash', args: { command: hang.command(pidFile), timeout_ms: 120000 }, id: 'h1' }] },
  ],
  { apiKey: KEY }
);

const config = path.join(tmp, 'alia-config.json');
fs.writeFileSync(config, JSON.stringify({ apiKey: KEY, apiType: 'chat-completions', models: [{ id: 'fake-model', name: 'fake', url: server.url, toolCalling: true, maxInputTokens: 128000 }] }));
const electronBinary: string = createRequire(path.join(desktop, 'package.json'))('electron');
const env = { ...process.env, ALIA_DESKTOP_DATA_DIR: path.join(tmp, 'data'), ALIA_DESKTOP_TEST: '1', ALIA_CONFIG: config, ALIA_TEST_PICK_FOLDER: project, ALIA_TEST_PICK_FILES: brd } as NodeJS.ProcessEnv;
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
const box = () => page.getByRole('combobox', { name: 'Mensagem' });
const menu = () => page.getByTestId('composer-menu');
const options = () => menu().getByRole('option');
const rowsText = () => page.locator('.timeline').innerText();
const lastUser = () => page.locator('.turn.user').last().innerText();
const answers = (n: number) => page.locator('.turn.assistant.final').nth(n);
async function sendText(text: string) {
  await box().fill(text);
  await box().press('Enter');
}
async function waitAnswers(n: number) {
  await page.waitForFunction((count) => document.querySelectorAll('.turn.assistant.final').length >= count, n, { timeout: 20000 });
}

try {
  // Two models, before any conversation exists (a session keeps the models it started with).
  await ok('settings.update', { models: [{ id: 'fake-model', name: 'fake', maxInputTokens: 128000 }, { id: 'second-model', name: 'second', maxInputTokens: 64000 }] });
  await ok('projects.pick');
  await page.getByRole('button', { name: 'Abrir pasta…' }).click();
  await box().waitFor({ timeout: 15000 });

  console.log('\n=== a new conversation starts on the start screen, with the composer ===');
  check('the start screen has the greeting and the message box ready for typing', (await page.locator('.home h1').count()) === 1 && (await box().evaluate((el) => el === document.activeElement)));
  check('the send button is off until there is something to send', await page.getByRole('button', { name: 'Enviar' }).isDisabled());
  check('nothing is saved yet (a draft leaves no trace until the first message)', (await ok('conversations.list', { projectPath: project })).length === 0);

  console.log('\n=== sending ===');
  await sendText('olá');
  await waitAnswers(1);
  check('Enter sends: the user\'s words and the answer appear, and the box is empty again', (await lastUser()).includes('olá') && (await answers(0).innerText()).includes('Olá! Como posso ajudar?') && (await box().inputValue()) === '');
  await page.getByRole('list', { name: 'Conversas de projeto' }).getByText('olá').first().waitFor(); // the list refreshes a moment after the run
  check('the greeting gives way to the conversation, now in the list', (await page.locator('.home').count()) === 0 && (await page.getByRole('list', { name: 'Conversas de projeto' }).getByText('olá').count()) >= 1, `home=${await page.locator('.home').count()} list=${await page.locator('.sidebar').innerText()}`);
  check('the project and model are in the header, with the context meter', (await page.getByTestId('model-chip').innerText()).includes('fake-model') && (await page.getByTestId('context-meter').count()) === 1);

  console.log('\n=== multi-line and history ===');
  await box().fill('linha 1');
  await box().press('Shift+Enter');
  await page.keyboard.type('linha 2');
  check('Shift+Enter breaks the line instead of sending', (await box().inputValue()) === 'linha 1\nlinha 2' && (await page.locator('.turn.user').count()) === 1);
  const grew = await box().evaluate((el) => el.clientHeight);
  check('the box grows with the text', grew > 30);
  await box().press('Enter');
  await waitAnswers(2);
  check('the whole text, both lines, is what was said', (await lastUser()).includes('linha 1') && (await lastUser()).includes('linha 2'));
  await box().press('ArrowUp');
  check('Up brings back the last message', (await box().inputValue()) === 'linha 1\nlinha 2');
  await box().press('ArrowUp'); // the caret is at the end of the second line: this moves within the text
  await box().press('Control+Home');
  await box().press('ArrowUp');
  check('...and Up from the first line goes further back', (await box().inputValue()) === 'olá');
  await box().press('ArrowDown');
  check('Down comes forward again', (await box().inputValue()) === 'linha 1\nlinha 2');
  await box().press('Control+End');
  await box().press('ArrowDown');
  check('...and ends at what was being typed (nothing)', (await box().inputValue()) === '');

  console.log('\n=== the @ menu ===');
  await box().fill('@sr');
  await menu().waitFor();
  { const v = await audit(page); check('the @ menu open: no accessibility violations', v.length === 0, '\n' + describeViolations(v)); }
  check('typing @ offers the project\'s files, with the folder marked "pasta inteira"', (await options().filter({ hasText: 'src/' }).first().innerText()).includes('pasta inteira') && (await options().filter({ hasText: 'src/' }).first().innerText()).includes('2 itens'));
  check('the box says what it is: a combobox with the list it controls, and the active option', (await box().getAttribute('aria-expanded')) === 'true' && !!(await box().getAttribute('aria-controls')) && !!(await box().getAttribute('aria-activedescendant')) && (await options().first().getAttribute('aria-selected')) === 'true');
  await box().press('Tab');
  await page.waitForFunction(() => (document.querySelector('[role=combobox]') as HTMLTextAreaElement).value === '@src/');
  await options().filter({ hasText: 'util.ts' }).waitFor();
  check('Tab on a folder opens it: its files are listed', (await options().filter({ hasText: 'app.ts' }).count()) === 1 && (await options().filter({ hasText: 'util.ts' }).count()) === 1);
  const ids = await options().evaluateAll((os) => os.map((o) => o.textContent ?? ''));
  const utilIndex = ids.findIndex((x) => x.includes('util.ts'));
  for (let i = 0; i < utilIndex; i++) await box().press('ArrowDown');
  await box().press('Enter');
  check('Enter on a file inserts it with a space, and the menu goes away', (await box().inputValue()) === '@src/util.ts ' && (await menu().count()) === 0);
  await page.keyboard.type('resuma');
  await box().press('Enter');
  await waitAnswers(3);
  check('the message shows what was typed, not the file\'s content', (await lastUser()).includes('@src/util.ts resuma') && !(await lastUser()).includes('UTIL_MARKER'));
  check('...while the model received the file', JSON.stringify(server.requests.at(-1)).includes('UTIL_MARKER'));

  await box().fill('@sr');
  await options().first().waitFor();
  await box().press('Enter');
  check('Enter on a folder attaches the whole folder (the slash is kept)', (await box().inputValue()) === '@src/ ');
  await page.keyboard.type('liste');
  await box().press('Enter');
  await waitAnswers(4);
  check('the model received the folder\'s listing', JSON.stringify(server.requests.at(-1)).includes('app.ts') && JSON.stringify(server.requests.at(-1)).includes('util.ts'));

  await box().fill('@Prop');
  await options().filter({ hasText: 'Proposta' }).first().waitFor();
  await box().press('Enter');
  check('a path with spaces is inserted in quotes', (await box().inputValue()) === '@"docs/Proposta Técnica.txt" ', await box().inputValue());
  await box().fill('');
  await box().fill('@');
  await menu().waitFor();
  await box().press('Escape');
  check('Esc closes the menu', (await menu().count()) === 0);
  await box().fill('@s');
  await options().first().waitFor();
  check('...until the text changes', (await options().count()) >= 1);
  await box().fill('ana@exemplo.com');
  check('an email address does not open it', (await menu().count()) === 0);
  await box().fill('');

  console.log('\n=== what a mention may read ===');
  await box().fill(`veja @"${path.join(outside, 'solto.txt')}"`);
  await box().press('Enter');
  const err = page.getByTestId('composer-error');
  await err.waitFor();
  check('a file outside the project, typed by path, is refused in plain words, and the text is kept', (await err.innerText()).includes('fora da pasta') || (await err.innerText()).includes('outside the project folder'), await err.innerText());
  check('...and it was not read', !JSON.stringify(server.requests).includes('SOLTO-CONTEUDO'));
  await box().fill('');

  console.log('\n=== the / menu and the app\'s own commands ===');
  await box().fill('/');
  await menu().waitFor();
  const names = await options().evaluateAll((os) => os.map((o) => o.querySelector('code')?.textContent));
  check('a slash offers the commands, including the app\'s /config', ['/help', '/model', '/clear', '/compact', '/config', '/tokens'].every((c) => names.includes(c)), names.join(' '));
  await box().fill('/mo');
  await options().first().waitFor();
  await box().press('Tab');
  check('Tab completes the command, with a space when it takes an argument', (await box().inputValue()) === '/model ');
  await box().fill('/he');
  await options().first().waitFor();
  await box().press('Enter');
  check('Enter on the menu completes without sending', (await box().inputValue()) === '/help' && (await page.locator('[data-local="help"]').count()) === 0);
  await box().press('Enter');
  const help = page.locator('[data-local="help"]');
  await help.waitFor();
  check('/help lists the commands, in the timeline, without asking the model', (await help.innerText()).includes('/config') && (await help.innerText()).includes('/compact') && server.requests.length === 4);
  await sendText('/tokens');
  check('/tokens shows the context use', (await page.locator('[data-local="tokens"]').innerText()).includes('Contexto:'));
  await sendText('/models');
  check('/models lists them, the current one marked', (await page.locator('[data-local="models"]').innerText()).includes('● fake-model'));
  await sendText('/model second-model');
  await page.getByText('Modelo trocado para second-model.').waitFor();
  check('/model <id> switches (the chip follows)', (await page.getByTestId('model-chip').innerText()).includes('second-model'));
  await sendText('/model nope');
  await page.getByText(/O modelo "nope" não está disponível/).waitFor();
  check('an unknown model says what is available', (await page.getByText(/O modelo "nope" não está disponível/).count()) === 1);
  await sendText('/tools');
  await page.getByText('O comando /tools não existe neste aplicativo').waitFor();
  check('a command the CLI has and the app does not says so', (await page.getByText('O comando /tools não existe neste aplicativo').count()) === 1);
  await sendText('/compact');
  await page.getByText('Não há o que compactar').waitFor({ timeout: 10000 }).catch(() => {});
  check('/compact on a short conversation says there is nothing to compact', (await page.getByText('Não há o que compactar').count()) === 1, (await page.locator('.timeline').innerText()).slice(-300));
  await sendText('/clear');
  await page.getByText('Conversa limpa.').waitFor();
  const afterClear = await ok('conversations.load', { id: (await ok('sessions.active')).find((s: any) => s.workspace)!.sessionId });
  check('/clear empties the timeline, and the saved conversation too', (await page.locator('.turn.user').count()) === 0 && afterClear.messages.filter((m: any) => m.role !== 'system').length === 0, JSON.stringify(afterClear.messages.length));
  await sendText('/config');
  await page.getByRole('heading', { name: 'Configurações' }).waitFor();
  check('/config opens the settings', (await page.locator('.settings').count()) === 1);
  await page.getByRole('button', { name: 'Voltar' }).click();
  await box().waitFor();

  console.log('\n=== attaching files ===');
  await page.getByRole('button', { name: 'Anexar arquivos' }).click();
  const chip = page.getByRole('list', { name: 'Arquivos anexados' }).getByRole('listitem');
  await chip.waitFor();
  check('the paperclip opens the file dialog; the choice appears as a chip with the file name', (await chip.innerText()).includes('BRD de teste.txt') && ((await chip.getAttribute('title')) ?? '') === brd);
  await chip.getByRole('button', { name: /Remover o anexo/ }).click();
  check('a chip can be removed', (await chip.count()) === 0);
  await page.getByRole('button', { name: 'Anexar arquivos' }).click();
  await chip.waitFor();
  await box().fill('leia o anexo');
  await box().press('Enter');
  await waitAnswers(5);
  check('the file, from outside the project, was read because the user attached it', JSON.stringify(server.requests.at(-1)).includes('BRD-CONTEUDO-EXTERNO'));
  check('the chips are gone after sending', (await chip.count()) === 0);

  console.log('\n=== dropping files ===');
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['x'], 'falso.txt'));
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await sleep(500);
  check('a drop event made up by the page does nothing (only a genuine drop counts)', (await chip.count()) === 0);
  await app.evaluate(({ BrowserWindow }, f) => (globalThis as any).__aliaTest.handleDropped(BrowserWindow.getAllWindows()[0].webContents, [f, 'relativo.txt', '/nao/existe.txt']), dropped);
  await chip.first().waitFor();
  check('files the preload reports as dropped become chips; paths that do not exist or are relative are ignored', (await chip.count()) === 1 && (await chip.first().innerText()).includes('solto.txt'));
  await chip.getByRole('button', { name: /Remover o anexo/ }).click();

  console.log('\n=== Stop ===');
  await ok('settings.update', { permissionMode: 'auto' });
  await page.getByRole('button', { name: 'Nova conversa' }).first().click();
  await box().waitFor();
  await box().fill('inicie o servidor');
  await box().press('Enter');
  await page.getByRole('button', { name: /Parar/ }).waitFor({ timeout: 15000 });
  check('while a run goes on, Send becomes Stop', (await page.getByRole('button', { name: 'Enviar' }).count()) === 0 && (await hang.started(pidFile)));
  await box().fill('outra coisa');
  await box().press('Enter');
  check('sending another message meanwhile is refused with a clear reason, and the text stays', (await err.innerText()).includes('Aguarde') && (await box().inputValue()) === 'outra coisa');
  await page.getByRole('button', { name: /Parar/ }).click();
  await page.locator('[data-notice="cancelled"]').waitFor({ timeout: 10000 });
  check('Stop cancels the run and the command, and the box is ready again', (await hang.diesWithin(pidFile, 4000)) && (await page.getByRole('button', { name: 'Enviar' }).count()) === 1);
  check('the conversation list shows the new conversation too', (await page.getByRole('list', { name: 'Conversas de projeto' }).locator('.conv').count()) >= 2);

  console.log('\n=== keyboard and accessibility ===');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.sendInputEvent({ type: 'keyDown', keyCode: 'N', modifiers: ['control'] }));
  await page.locator('.home').waitFor({ timeout: 8000 });
  check('Ctrl N gives a fresh start screen with an empty, focused box', (await box().inputValue()) === '' && (await box().evaluate((el) => el === document.activeElement)));
  const unnamed = await page.evaluate(() => {
    const bad: string[] = [];
    for (const el of Array.from(document.querySelectorAll('.composer button, .composer textarea'))) {
      const h = el as HTMLElement;
      if (!(h.getAttribute('aria-label') || h.textContent || '').trim()) bad.push(h.outerHTML.slice(0, 80));
    }
    return bad;
  });
  check('every control of the composer has a name', unnamed.length === 0, unnamed.join(' | '));
  void rowsText;
} catch (err: any) {
  failures++;
  console.log(`  ✘ ${err?.stack ?? err}`);
} finally {
  await app.close().catch(() => {});
  await server.close();
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* a just-killed command may still hold its folder */
  }
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll composer checks passed.');
