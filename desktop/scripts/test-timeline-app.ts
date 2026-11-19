/**
 * The chat timeline (A6) in the REAL built app, against a fake model endpoint: a conversation reopened from disk, a run
 * followed live (spinner, tool rows with +/- counts and pass/fail, markdown), hostile markdown, Stop, an API error,
 * the model chip and the context meter. Run from desktop/: `npm run test:timeline-app` (builds first).
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { startFakeServer } from './lib/fakeServer';
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

const KEY = 'sk-test-TIMELINEKEY-12345678';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alia-timeline-app-'));
const project = path.join(tmp, 'projeto');
fs.mkdirSync(path.join(project, 'sub'), { recursive: true });
fs.writeFileSync(path.join(project, 'a.txt'), 'alfa\n');
fs.writeFileSync(path.join(project, 'sub', 'b.txt'), 'beta\n');
const hang = makeHang(tmp);
const pidFile = path.join(tmp, 'hang.pid');

const MARKDOWN = [
  '## Resumo',
  'Texto com **negrito** e `código`.',
  '',
  '- item um',
  '- item dois',
  '',
  '| coluna | valor |',
  '|---|---|',
  '| a | 1 |',
  '',
  '```js',
  "console.log('olá')",
  '```',
  '',
  '[site seguro](https://example.com/docs) e [inseguro](http://example.com/x) e [js](javascript:alert(1)) e [arquivo](file:///C:/Windows/win.ini)',
  '',
  '<script>window.__pwned = 1</script>',
  '',
  '<img src=x onerror="window.__pwned = 2">',
  '',
  '<iframe src="https://evil.example/"></iframe>',
  '',
  '![logotipo](https://evil.example/track.png)',
].join('\n');

const server = await startFakeServer(
  [
    // run A (history)
    { content: 'Vou olhar o projeto.', toolCalls: [{ name: 'list_files', args: { path: '.' }, id: 'a1' }] },
    { toolCalls: [{ name: 'read_file', args: { path: 'a.txt' }, id: 'a2' }, { name: 'read_file', args: { path: 'sub/b.txt' }, id: 'a3' }] },
    { toolCalls: [{ name: 'run_bash', args: { command: 'echo tudo certo' }, id: 'a4' }] },
    { content: 'Primeira parte pronta.' },
    // run B (live)
    { delayMs: 1500, toolCalls: [{ name: 'write_file', args: { path: 'out/novo.md', content: 'um\ndois\n' }, id: 'b1' }] },
    { toolCalls: [{ name: 'edit_file', args: { path: 'a.txt', target: 'alfa', replacement: 'ALFA\nbeta2' }, id: 'b2' }] },
    { toolCalls: [{ name: 'run_bash', args: { command: 'node -e "process.exit(3)"' }, id: 'b3' }] },
    { content: MARKDOWN },
    // run C (stopped)
    { toolCalls: [{ name: 'run_bash', args: { command: hang.command(pidFile), timeout_ms: 120000 }, id: 'c1' }] },
    // run D: nothing left, so the endpoint answers with an error
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
await page.evaluate(() => {
  const w = window as any;
  w.__msgs = [];
  w.alia.onMessage((m: unknown) => w.__msgs.push(m));
});

const call = (name: string, payload: object = {}) =>
  page.evaluate(([n, p]) => (window as any).alia.request(n, p).then((result: unknown) => ({ ok: true, result }), (err: Error) => ({ ok: false, error: String(err.message) })), [name, payload] as const) as Promise<any>;
const ok = async (name: string, payload: object = {}) => {
  const r = await call(name, payload);
  if (!r.ok) throw new Error(`${name}: ${r.error}`);
  return r.result;
};
const messages = (): Promise<any[]> => page.evaluate(() => (window as any).__msgs);
const waitFor = async <T>(fn: () => Promise<T | undefined | false>, ms = 20000, label = 'condition'): Promise<T> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v as T;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
};
const finished = async (id: string, n = 1) => waitFor(async () => (await messages()).filter((m) => m.kind === 'event' && m.sessionId === id && !m.event.subagentId && m.event.type === 'run_finished').length >= n, 30000, `run ${n} of ${id}`);
const tool = (name: string) => page.locator(`[data-tool="${name}"]`);

try {
  await ok('settings.update', { permissionMode: 'auto', models: [{ id: 'fake-model', name: 'fake', maxInputTokens: 128000 }, { id: 'second-model', name: 'second', maxInputTokens: 64000 }] });
  await ok('projects.pick');
  await page.getByRole('button', { name: 'Abrir pasta…' }).click();
  await page.getByText('Projeto: projeto').waitFor();

  console.log('\n=== a conversation reopened from disk ===');
  const s = await ok('session.open', { projectPath: project });
  await ok('session.run', { sessionId: s.sessionId, text: 'organize o projeto' });
  await finished(s.sessionId, 1);
  await page.getByRole('list', { name: 'Conversas de projeto' }).getByRole('button', { name: /organize o projeto/ }).click();
  await page.locator('.timeline').waitFor();
  check('the user\'s words and the assistant\'s text beside tool calls', (await page.locator('.turn.user').first().innerText()).includes('organize o projeto') && (await page.getByText('Vou olhar o projeto.').count()) === 1);
  check('the final answer is marked as the answer', (await page.locator('.turn.assistant.final').innerText()).includes('Primeira parte pronta.'));
  check('listing shows what was listed', (await tool('list_files').innerText()).includes('Listou .'));
  check('two reads in a row are one row: "Leu 2 arquivos"', (await tool('reads').count()) === 1 && (await tool('reads').innerText()).includes('Leu 2 arquivos'));
  await tool('reads').getByRole('button').click();
  check('open it, and the files are listed', (await tool('reads').innerText()).includes('a.txt') && (await tool('reads').innerText()).includes('sub/b.txt') && (await tool('reads').getByRole('button').getAttribute('aria-expanded')) === 'true');
  check('the command shows "Executou ..." and that it passed', (await tool('run_bash').innerText()).includes('Executou echo tudo certo') && (await tool('run_bash').innerText()).includes('passou'));
  check('a reopened conversation shows nothing running', (await page.getByTestId('thinking').count()) === 0);

  console.log('\n=== header: model and context ===');
  const chip = page.getByTestId('model-chip');
  check('the model in use is shown', (await chip.innerText()).includes('fake-model'));
  const meter = page.getByTestId('context-meter');
  const usage = await ok('session.usage', { sessionId: s.sessionId });
  check('the context meter shows how much of the window is used, readable by a screen reader', (await meter.getAttribute('role')) === 'meter' && Number(await meter.getAttribute('aria-valuenow')) === usage.percent && ((await meter.getAttribute('aria-valuetext')) ?? '').includes('Contexto') && ((await meter.getAttribute('title')) ?? '').includes('de 128.000 tokens'), `${await meter.getAttribute('aria-valuenow')} vs ${usage.percent}`);
  await chip.click();
  const menu = page.getByRole('menu', { name: 'Modelos' });
  await menu.waitFor(); // the list is fetched when the chip is clicked
  check('clicking the model lists the configured ones, the current marked', (await menu.getByRole('menuitemradio').count()) === 2 && (await menu.getByRole('menuitemradio', { name: /fake/ }).getAttribute('aria-checked')) === 'true');
  await menu.getByRole('menuitemradio', { name: /second/ }).click();
  await page.getByText('Modelo: second-model').waitFor();
  check('choosing one switches the conversation to it (and the meter follows its smaller window)', (await ok('model.list', { sessionId: s.sessionId })).current === 'second-model' && ((await meter.getAttribute('title')) ?? '').includes('de 64.000 tokens'), (await meter.getAttribute('title')) ?? '');
  await page.keyboard.press('Escape');

  console.log('\n=== a run followed live ===');
  await ok('session.run', { sessionId: s.sessionId, text: 'agora mude os arquivos' });
  await page.getByTestId('thinking').waitFor({ timeout: 8000 });
  check('while the model thinks there is a spinner and the user\'s message is already there', (await page.getByTestId('thinking').innerText()).includes('Pensando') && (await page.locator('.turn.user').last().innerText()).includes('agora mude os arquivos'));
  check('...and the model cannot be switched mid-run', await chip.isDisabled());
  await tool('write_file').waitFor({ timeout: 8000 });
  check('a file written shows its path and how many lines were added', (await tool('write_file').innerText()).includes('Gravou out/novo.md') && (await tool('write_file').innerText()).includes('+2'));
  await tool('edit_file').waitFor();
  const edit = (await tool('edit_file').innerText()).replace(/\s+/g, ' ');
  check('an edit shows +added −removed', edit.includes('Editou a.txt') && edit.includes('+2') && edit.includes('−1'), edit);
  await finished(s.sessionId, 3 - 1 + 0).catch(() => {});
  await waitFor(async () => (await page.locator('.turn.assistant.final').count()) >= 2, 25000, 'the second answer');
  const failedRow = page.locator('[data-tool="run_bash"]').last();
  check('a command that failed says so, with its exit code', (await failedRow.innerText()).includes('falhou (código 3)'));
  check('each call shows how long it took', /\d+(,\d)? (ms|s)/.test(await failedRow.innerText()));
  await failedRow.getByRole('button').press('Enter');
  check('Enter on a row opens its details (the output is a keyboard action, not a mouse trick)', (await failedRow.getByRole('button').getAttribute('aria-expanded')) === 'true' && (await failedRow.locator('pre').count()) >= 1);
  await failedRow.getByRole('button').press('Enter');
  check('and closes them again', (await failedRow.getByRole('button').getAttribute('aria-expanded')) === 'false');
  check('the spinner is gone when the run ends', (await page.getByTestId('thinking').count()) === 0 && !(await chip.isDisabled()));
  const after = await ok('session.usage', { sessionId: s.sessionId });
  check('the context meter follows the conversation as it grows', Number(await meter.getAttribute('aria-valuenow')) === after.percent && after.percent >= usage.percent);

  console.log('\n=== markdown is rendered, and nothing in it can act ===');
  const md = page.locator('.turn.assistant.final').last().locator('.md');
  check('headings, bold, inline code, lists, tables and code blocks render', (await md.locator('h2').innerText()) === 'Resumo' && (await md.locator('strong').innerText()) === 'negrito' && (await md.locator('p code').first().innerText()) === 'código' && (await md.locator('ul li').count()) === 2 && (await md.locator('table td').count()) === 2 && (await md.locator('pre code').innerText()).includes("console.log('olá')"));
  check('raw HTML is not HTML: no script, image or frame exists, and nothing ran', (await md.locator('script, img, iframe, object, embed').count()) === 0 && (await page.evaluate(() => (window as any).__pwned)) === undefined);
  check('...it is shown as text instead', (await md.innerText()).includes('<script>window.__pwned = 1</script>') && (await md.innerText()).includes('<iframe'));
  check('an image is never loaded: its description is shown', (await md.innerText()).includes('[imagem: logotipo]'));
  const links = await md.locator('a').evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).getAttribute('href')));
  check('only the https link is a link', links.length === 1 && links[0] === 'https://example.com/docs', JSON.stringify(links));
  const blocked = await md.locator('.link-blocked').allInnerTexts();
  check('the others (http, javascript:, file:) are plain text, and say why on hover', blocked.length >= 3 && blocked.some((x) => x.startsWith('inseguro')) && (await md.locator('.link-blocked').first().getAttribute('title')) === 'Só links https podem ser abertos.', JSON.stringify(blocked));
  const urlBefore = await page.evaluate(() => location.href);
  await md.getByRole('link', { name: /site seguro/ }).click();
  await sleep(600);
  const opened: string[] = await app.evaluate(() => (globalThis as any).__aliaTest.openedLinks);
  check('clicking it asks main to open it (recorded here instead of opened); the page itself goes nowhere', opened.includes('https://example.com/docs') && (await page.evaluate(() => location.href)) === urlBefore && app.windows().length === 1, JSON.stringify(opened));

  console.log('\n=== Stop ===');
  const c = await ok('session.open', { projectPath: project });
  await page.getByRole('list', { name: 'Conversas de projeto' }).waitFor();
  await ok('session.run', { sessionId: c.sessionId, text: 'inicie o servidor' });
  await page.getByRole('list', { name: 'Conversas de projeto' }).getByRole('button', { name: /inicie o servidor/ }).click();
  await tool('run_bash').waitFor({ timeout: 15000 });
  check('a running command shows as in progress', (await tool('run_bash').innerText()).includes('em andamento') && (await hang.started(pidFile)));
  await ok('session.cancel', { sessionId: c.sessionId });
  const stopNotice = page.locator('[data-notice="cancelled"]');
  await stopNotice.waitFor({ timeout: 10000 });
  check('the run ends with "Execução cancelada."', (await stopNotice.innerText()).includes('Execução cancelada.'));
  check('the command is marked cancelled, and is really gone', (await tool('run_bash').innerText()).includes('cancelado') && (await hang.diesWithin(pidFile, 4000)));

  console.log('\n=== an error from the endpoint ===');
  await ok('session.run', { sessionId: c.sessionId, text: 'tente de novo' });
  const errorRow = page.locator('[data-notice="error"]');
  await errorRow.waitFor({ timeout: 15000 });
  check('an API error is one red row, announced to screen readers', (await errorRow.count()) === 1 && (await errorRow.innerText()).includes('API request failed') && (await errorRow.getAttribute('role')) === 'alert', await errorRow.innerText());
  check('...and the run is over (no spinner)', (await page.getByTestId('thinking').count()) === 0);

  console.log('\n=== other conversations do not leak in ===');
  await page.getByRole('list', { name: 'Conversas de projeto' }).getByRole('button', { name: /organize o projeto/ }).click();
  await page.getByText('Primeira parte pronta.').waitFor();
  check('the first conversation is its own (the later runs of the other did not appear in it)', (await page.locator('.timeline').getByText('inicie o servidor').count()) === 0 && (await page.locator('[data-notice="cancelled"]').count()) === 0);
  check('it keeps the live rows of its second run, from disk', (await page.locator('.timeline').getByText('agora mude os arquivos').count()) === 1 && (await page.locator('[data-tool="write_file"]').count()) === 1);

  console.log('\n=== accessibility ===');
  const unnamed = await page.evaluate(() => {
    const bad: string[] = [];
    for (const el of Array.from(document.querySelectorAll('.conversation button, .conversation [role=menuitemradio]'))) {
      const h = el as HTMLElement;
      if (!(h.getAttribute('aria-label') || h.textContent || '').trim()) bad.push(h.outerHTML.slice(0, 80));
    }
    return bad;
  });
  check('every button in the conversation has a name', unnamed.length === 0, unnamed.join(' | '));
  check('the timeline is a live log region, labelled', (await page.getByRole('log', { name: 'Linha do tempo da conversa' }).count()) === 1 && (await page.locator('.timeline').getAttribute('aria-live')) === 'polite');
  check('every row that can be opened says whether it is open', (await page.locator('.tool-head:not([aria-expanded])').count()) === 0);
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
console.log('\nAll timeline screen checks passed.');
