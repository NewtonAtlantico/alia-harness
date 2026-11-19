/**
 * The right panel (A10) in the REAL built app, against a fake model endpoint: what the agent changed (list, diff, keep,
 * undo, a conflict, a file with no diff), the project's files with a read-only preview (a PDF included), and the log of the
 * agent's commands. Run from desktop/: `npm run test:panel-app` (builds first).
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

const KEY = 'sk-test-PANELKEY-12345678';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alia-panel-'));
const project = path.join(tmp, 'projeto');
for (const d of ['src', 'docs', 'node_modules/pkg']) fs.mkdirSync(path.join(project, d), { recursive: true });
fs.writeFileSync(path.join(project, 'a.txt'), 'alfa\nbeta\ngama\n');
fs.writeFileSync(path.join(project, 'b.txt'), 'um\n');
fs.writeFileSync(path.join(project, 'README.md'), '# Projeto\nLeia-me do projeto.\n');
fs.writeFileSync(path.join(project, 'src', 'app.ts'), 'export const app = 1;\n');
fs.writeFileSync(path.join(project, 'docs', 'BRD.pdf'), makePdf([['Primeira página do BRD'], ['Segunda página']]));
fs.writeFileSync(path.join(project, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]));

const LONG = 'linha muito longa '.repeat(30).trim();
const call = (name: string, args: unknown, id: string) => ({ toolCalls: [{ name, args, id }] });
const server = await startFakeServer(
  [
    // run 1
    call('write_file', { path: 'new.md', content: 'um\ndois\ntrês\n' }, 'w1'),
    call('edit_file', { path: 'a.txt', target: 'beta', replacement: `BETA\n${LONG}` }, 'e1'),
    call('run_bash', { command: 'echo ola-terminal' }, 'c1'),
    call('run_bash', { command: 'node -e "console.error(\'falhou feio\'); process.exit(4)"' }, 'c2'),
    { content: 'pronto' },
    // run 2: a file the agent creates
    call('write_file', { path: 'c.txt', content: 'c1\n' }, 'w2'),
    { content: 'ok2' },
    // run 3: a file the agent edits, which the user then edits too
    call('edit_file', { path: 'b.txt', target: 'um', replacement: 'dois' }, 'e3'),
    { content: 'ok3' },
    // run 4: a file with nothing to diff (too large to keep a copy)
    call('write_file', { path: 'big.txt', content: 'x'.repeat(1_000_100) }, 'w4'),
    { content: 'ok4' },
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

const call2 = (name: string, payload: object = {}) =>
  page.evaluate(([n, p]) => (window as any).alia.request(n, p).then((result: unknown) => ({ ok: true, result }), (err: Error) => ({ ok: false, error: String(err.message) })), [name, payload] as const) as Promise<any>;
const ok = async (name: string, payload: object = {}) => {
  const r = await call2(name, payload);
  if (!r.ok) throw new Error(`${name}: ${r.error}`);
  return r.result;
};
const box = () => page.getByRole('combobox', { name: 'Mensagem' });
const panel = () => page.getByTestId('side-panel');
const rows = () => panel().locator('.change');
const row = (p: string) => panel().locator(`.change[data-path="${p}"]`);
const answers = (n: number) => page.waitForFunction((count) => document.querySelectorAll('.turn.assistant.final').length >= count, n, { timeout: 25000 });
async function said(text: string, finalAnswers: number) {
  await box().fill(text);
  await box().press('Enter');
  await answers(finalAnswers);
  await sleep(500); // the panel refreshes a moment after the run ends
}

try {
  await ok('settings.update', { permissionMode: 'auto' });
  await ok('projects.pick');
  await page.getByRole('button', { name: 'Abrir pasta…' }).click();
  await box().waitFor({ timeout: 15000 });

  console.log('\n=== the panel ===');
  check('the panel starts closed, and the button says so', (await panel().count()) === 0 && (await page.getByTestId('panel-toggle').getAttribute('aria-pressed')) === 'false');
  await said('faça as alterações', 1);
  await page.getByTestId('panel-toggle').click();
  await panel().waitFor();
  check('"Painel" opens it, on the changes tab, and the button reflects it', (await page.getByTestId('panel-toggle').getAttribute('aria-pressed')) === 'true' && (await panel().getByRole('tab', { selected: true }).innerText()) === 'Alterações');
  check('it has three tabs', (await panel().getByRole('tab').allInnerTexts()).join() === 'Alterações,Arquivos,Terminal');

  console.log('\n=== changes: the list ===');
  await rows().first().waitFor();
  check('the files the agent wrote are listed, each with its kind and +/- counts', (await rows().count()) === 2 && (await row('new.md').innerText()).replace(/\s+/g, ' ').includes('novo') && (await row('new.md').innerText()).includes('+3') && (await row('a.txt').innerText()).includes('modificado') && (await row('a.txt').innerText()).includes('+2') && (await row('a.txt').innerText()).includes('−1'), (await panel().innerText()).slice(0, 300));
  check('the header totals them', (await panel().locator('.changes-head').innerText()).replace(/\s+/g, ' ').includes('2 arquivos alterados') && (await panel().locator('.changes-head').innerText()).includes('+5'));
  check('it says, always, that changes made by commands are not tracked', (await page.getByTestId('not-tracked').innerText()).includes('não são rastreadas'));

  console.log('\n=== changes: the diff ===');
  await row('a.txt').getByRole('button', { name: /Mostrar o que mudou/ }).click();
  const diff = row('a.txt').getByTestId('diff');
  await diff.waitFor();
  check('a file opens to its diff: removed line red, added lines green, with line numbers', (await diff.locator('.dl.remove').count()) === 1 && (await diff.locator('.dl.add').count()) === 2 && (await diff.locator('.dl.remove .code').innerText()).trim() === 'beta' && (await diff.locator('.dl.add .code').first().innerText()).trim() === 'BETA');
  const geometry = await diff.evaluate((el) => ({ overflowX: getComputedStyle(el).overflowX, scrollable: el.scrollWidth > el.clientWidth, wrap: getComputedStyle(el.querySelector('.dl')!).whiteSpace }));
  check('a long line scrolls sideways instead of wrapping', geometry.overflowX === 'auto' && geometry.scrollable && geometry.wrap === 'pre', JSON.stringify(geometry));
  check('the diff is a focusable region with a name (the keyboard can scroll it)', (await diff.getAttribute('tabindex')) === '0' && (await diff.getAttribute('aria-label')) === 'a.txt');
  await row('a.txt').getByRole('button', { name: /Mostrar o que mudou/ }).click();
  check('clicking again closes it', (await diff.count()) === 0);

  console.log('\n=== keep one, undo one ===');
  await row('new.md').getByRole('button', { name: /Manter as alterações em new.md/ }).click();
  await page.getByTestId('changes-summary').waitFor();
  check('Manter accepts that file: it leaves the list and stays on disk', (await rows().count()) === 1 && fs.existsSync(path.join(project, 'new.md')) && (await page.getByTestId('changes-summary').innerText()).includes('Mantida: 1 alteração.'));
  await row('a.txt').getByRole('button', { name: /Desfazer as alterações em a.txt/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Desfazer a alteração neste arquivo?' });
  await dialog.waitFor();
  check('Desfazer asks first, and the safe button has the focus', (await page.evaluate(() => document.activeElement?.textContent)) === 'Cancelar' && (await dialog.innerText()).includes('Arquivos que você mesmo editou depois do agente não são tocados'));
  await page.keyboard.press('Escape');
  check('Esc keeps everything as it was', (await dialog.count()) === 0 && fs.readFileSync(path.join(project, 'a.txt'), 'utf8').includes('BETA'));
  await row('a.txt').getByRole('button', { name: /Desfazer as alterações em a.txt/ }).click();
  await dialog.getByRole('button', { name: 'Desfazer' }).click();
  await page.getByText('Desfeito: 1 arquivo.').waitFor();
  check('confirming puts the file back exactly as it was, and it leaves the list', fs.readFileSync(path.join(project, 'a.txt'), 'utf8') === 'alfa\nbeta\ngama\n' && (await rows().count()) === 0 && (await panel().getByText('Nenhuma alteração pendente.').count()) === 1);

  console.log('\n=== terminal ===');
  await panel().getByRole('tab', { name: 'Terminal' }).click();
  const term = page.getByTestId('terminal');
  await term.waitFor();
  const entries = term.locator('.term-entry');
  check('the commands the agent ran are logged, in order, with their output', (await entries.count()) === 2 && (await entries.nth(0).innerText()).includes('echo ola-terminal') && (await entries.nth(0).innerText()).includes('ola-terminal') && (await entries.nth(1).innerText()).includes('falhou feio'));
  check('each says how it ended: passed, and failed with the exit code', (await entries.nth(0).innerText()).includes('passou') && (await entries.nth(1).innerText()).includes('falhou (código 4)'));
  check('it is a log, not a terminal: nothing can be typed into it, and it says so', (await term.locator('input, textarea, [contenteditable]').count()) === 0 && (await term.getAttribute('role')) === 'log' && (await term.innerText()).includes('Somente leitura'));

  console.log('\n=== files ===');
  await panel().getByRole('tab', { name: 'Arquivos' }).click();
  const tree = page.getByTestId('file-tree');
  await tree.getByText('docs/').waitFor();
  const top = await tree.locator(':scope > li > button .name, :scope > li > .tree-row .name').allInnerTexts();
  check('the project tree shows folders first, then files, without the noise folders', top[0] === 'docs/' && top.includes('src/') && top.includes('README.md') && top.includes('logo.png') && !top.some((n) => n.includes('node_modules')), top.join(' '));
  await tree.getByRole('button', { name: 'Abrir a pasta docs' }).click();
  await tree.getByText('BRD.pdf').waitFor();
  await tree.getByRole('button', { name: /BRD.pdf/ }).click();
  const preview = page.getByTestId('file-preview');
  await preview.getByText('Primeira página do BRD').waitFor();
  check('a PDF is shown as the text the agent would read, with its page markers', (await preview.innerText()).includes('[p. 1]') && (await preview.innerText()).includes('Texto extraído do documento'));
  await tree.getByRole('button', { name: /README.md/ }).click();
  await preview.getByText('Leia-me do projeto.').waitFor();
  check('a text file is shown as text, read-only', (await preview.innerText()).includes('Somente leitura') && (await preview.locator('input, textarea').count()) === 0);
  await tree.getByRole('button', { name: /logo.png/ }).click();
  await preview.getByText('Arquivo binário').waitFor();
  check('a binary file says there is nothing to show', true);
  await tree.getByRole('button', { name: 'Fechar a pasta docs' }).click();
  check('a folder closes again', (await tree.getByText('BRD.pdf').count()) === 0);

  console.log('\n=== undo all, a conflict, and a file with no diff ===');
  await panel().getByRole('tab', { name: 'Alterações' }).click();
  await said('crie o c', 2);
  await rows().first().waitFor();
  check('a new file created later shows up (the panel follows the run)', (await rows().count()) === 1 && (await row('c.txt').innerText()).includes('novo'));
  await said('edite o b', 3);
  await row('b.txt').waitFor();
  fs.writeFileSync(path.join(project, 'b.txt'), 'minha edição\n'); // the user edits it too, after the agent
  await said('crie o grande', 4);
  await row('big.txt').waitFor();
  check('a file too large to keep a copy of is listed as "sem diff", with no diff to open and nothing to undo', (await row('big.txt').innerText()).includes('sem diff') && await row('big.txt').getByRole('button', { name: /Mostrar o que mudou/ }).isDisabled() && await row('big.txt').getByRole('button', { name: /Desfazer/ }).isDisabled());
  await row('b.txt').getByRole('button', { name: /Desfazer as alterações em b.txt/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Desfazer' }).click();
  const conflict = row('b.txt').getByTestId('conflict');
  await conflict.waitFor();
  check('a file edited after the agent is not overwritten: it is reported, and stays pending', (await conflict.innerText()).includes('foi editado depois do agente') && fs.readFileSync(path.join(project, 'b.txt'), 'utf8') === 'minha edição\n' && (await row('b.txt').count()) === 1);
  await panel().getByRole('button', { name: 'Desfazer tudo' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Desfazer' }).click();
  await page.getByText('Desfeito: 1 arquivo.').waitFor();
  check('Desfazer tudo undoes what it can (the created file is deleted) and reports the rest', !fs.existsSync(path.join(project, 'c.txt')) && (await row('c.txt').count()) === 0 && (await row('b.txt').count()) === 1 && (await row('big.txt').count()) === 1 && fs.readFileSync(path.join(project, 'b.txt'), 'utf8') === 'minha edição\n');
  await panel().getByRole('button', { name: 'Manter tudo' }).click();
  await page.getByText('Nenhuma alteração pendente.').waitFor();
  check('Manter tudo clears the list and touches no file', (await rows().count()) === 0 && fs.existsSync(path.join(project, 'big.txt')) && fs.readFileSync(path.join(project, 'b.txt'), 'utf8') === 'minha edição\n');

  console.log('\n=== opening, closing, keyboard ===');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.sendInputEvent({ type: 'keyDown', keyCode: 'J', modifiers: ['control'] }));
  await panel().waitFor({ state: 'detached', timeout: 5000 });
  check('Ctrl J closes it (and the button follows)', (await page.getByTestId('panel-toggle').getAttribute('aria-pressed')) === 'false');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.sendInputEvent({ type: 'keyDown', keyCode: 'J', modifiers: ['control'] }));
  await panel().waitFor();
  check('...and opens it again, on the tab that was last used', (await panel().getByRole('tab', { selected: true }).innerText()) === 'Alterações');
  await panel().getByRole('tab', { name: 'Alterações' }).focus();
  await page.keyboard.press('ArrowRight');
  check('the arrow keys move between tabs (the focused tab is the selected one)', (await panel().getByRole('tab', { selected: true }).innerText()) === 'Arquivos' && (await page.evaluate(() => document.activeElement?.textContent)) === 'Arquivos');
  await page.keyboard.press('End');
  check('End goes to the last tab', (await panel().getByRole('tab', { selected: true }).innerText()) === 'Terminal');
  await panel().getByRole('button', { name: 'Fechar o painel' }).click();
  check('the close button closes it', (await panel().count()) === 0);

  console.log('\n=== accessibility ===');
  await page.getByTestId('panel-toggle').click();
  await panel().waitFor();
  const unnamed = await page.evaluate(() => {
    const bad: string[] = [];
    for (const el of Array.from(document.querySelectorAll('[data-testid=side-panel] button, [data-testid=side-panel] [role=tab]'))) {
      const h = el as HTMLElement;
      if (!(h.getAttribute('aria-label') || h.textContent || '').trim()) bad.push(h.outerHTML.slice(0, 80));
    }
    return bad;
  });
  check('every button and tab in the panel has a name', unnamed.length === 0, unnamed.join(' | '));
  check('the panel is a labelled region with a tablist and a labelled tabpanel', (await panel().getAttribute('aria-label')) === 'Painel da conversa' && (await panel().getByRole('tablist').count()) === 1 && !!(await panel().getByRole('tabpanel').getAttribute('aria-labelledby')));
} catch (err: any) {
  failures++;
  console.log(`  ✘ ${err?.stack ?? err}`);
} finally {
  await app.close().catch(() => {});
  await server.close();
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* ignore */
  }
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll panel checks passed.');
