/**
 * Long conversations and very large diffs in the REAL built app (A18): a saved conversation of 8,000 messages opens quickly and
 * draws only its last rows (older ones are one click away, and what the user was reading stays where it was); typing stays
 * responsive; a change of tens of thousands of lines opens without freezing the panel. The budgets are generous (they are for a
 * busy test machine): they catch a page that draws everything, not a few milliseconds. Run from desktop/: `npm run test:performance-app`.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionStore, type ChatMessage } from 'alia-harness/core';
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

const KEY = 'sk-test-PERFKEY-12345678';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alia-perf-'));
const project = path.join(tmp, 'projeto');
fs.mkdirSync(project, { recursive: true });
const data = path.join(tmp, 'data');
const TURNS = 2000; // 4 messages each: 8,000 messages, 6,000 rows

// A long conversation, saved the way the app saves one.
const store = new SessionStore({ dir: path.join(data, 'sessions') });
const info = store.create({ workspace: project, model: 'fake-model', title: 'Conversa muito longa' });
const messages: ChatMessage[] = [{ role: 'system', content: 'system' } as ChatMessage];
for (let i = 1; i <= TURNS; i++) {
  messages.push({ role: 'user', content: `Pergunta número ${i}` } as ChatMessage);
  messages.push({ role: 'assistant', content: null, tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: `arquivo-${i}.txt` }) } }] } as ChatMessage);
  messages.push({ role: 'tool', tool_call_id: `c${i}`, content: `conteúdo do arquivo ${i}` } as ChatMessage);
  messages.push({ role: 'assistant', content: `Resposta número ${i}` } as ChatMessage);
}
store.recorder(info.id, { workspace: project, getModel: () => 'fake-model' }).sync(messages);

const bigLines = Array.from({ length: 18_000 }, (_, i) => `linha ${i + 1}: texto para ocupar espaço no arquivo grande`).join('\n');
const server = await startFakeServer([{ toolCalls: [{ name: 'write_file', id: 'w1', args: { path: 'grande.txt', content: bigLines } }] }, { content: 'Gravei o arquivo grande.' }], { apiKey: KEY });
const config = path.join(tmp, 'alia-config.json');
fs.writeFileSync(config, JSON.stringify({ apiKey: KEY, apiType: 'chat-completions', models: [{ id: 'fake-model', name: 'fake', url: server.url, toolCalling: true, maxInputTokens: 128000 }] }));
const electronBinary: string = createRequire(path.join(desktop, 'package.json'))('electron');
const env = { ...process.env, ALIA_DESKTOP_DATA_DIR: data, ALIA_DESKTOP_TEST: '1', ALIA_CONFIG: config, ALIA_TEST_PICK_FOLDER: project } as NodeJS.ProcessEnv;
for (const k of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'ALIA_API_KEY', 'OPENAI_API_KEY']) delete env[k];

const app: ElectronApplication = await electron.launch({ executablePath: electronBinary, args: ['.'], cwd: desktop, env });
const page: Page = await app.firstWindow();
await page.waitForLoadState('domcontentloaded');
await page.waitForSelector('.sidebar');
const call = (name: string, payload: object = {}) => page.evaluate(([n, p]) => (window as any).alia.request(n, p), [name, payload] as const) as Promise<any>;
/** How long the page takes to answer: a frame after asking. Near zero when idle; seconds when something froze it. */
const frame = () => page.evaluate(() => new Promise<number>((resolve) => { const t0 = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - t0))); }));
const rows = () => page.locator('.timeline > li');

try {
  await call('settings.update', { permissionMode: 'auto' });
  await call('projects.pick');
  await page.getByRole('button', { name: 'Abrir pasta…' }).click();
  await page.getByRole('combobox', { name: 'Mensagem' }).waitFor({ timeout: 15000 });

  console.log('\n=== a conversation of 8,000 messages ===');
  const t0 = Date.now();
  await page.getByRole('button', { name: /Conversa muito longa/ }).click();
  await page.getByText(`Resposta número ${TURNS}`).waitFor({ timeout: 30000 });
  const opened = Date.now() - t0;
  check(`it opens in a few seconds (${opened} ms), at its end`, opened < 8000, `${opened} ms`);
  const drawn = await rows().count();
  check(`only the last rows are drawn (${drawn} of about ${TURNS * 3})`, drawn > 100 && drawn <= 320, String(drawn));
  const older = page.getByTestId('older');
  check('the rest is one click away, and says how many there are', (await older.innerText()).includes('Mostrar 300 anteriores') && /\(\d+ escondidas\)/.test(await older.innerText()), await older.innerText());
  check('the page answers at once (a frame is not held up)', (await frame()) < 500);
  check('the conversation is at its end, not at the top', await page.evaluate(() => { const s = document.querySelector('.pane-main') as HTMLElement; return s.scrollHeight - s.scrollTop - s.clientHeight < 300; }));

  const typed = Date.now();
  await page.getByRole('combobox', { name: 'Mensagem' }).click();
  const sentence = 'uma mensagem digitada com a conversa longa aberta';
  await page.keyboard.type(sentence, { delay: 0 });
  const typing = Date.now() - typed;
  check(`typing is not slowed by the length (${typing} ms for ${sentence.length} characters)`, typing < 4000 && (await page.getByRole('combobox', { name: 'Mensagem' }).inputValue()).length === sentence.length, `${typing} ms`);
  await page.getByRole('combobox', { name: 'Mensagem' }).fill('');

  console.log('\n=== showing the older ones ===');
  await page.evaluate(() => { const s = document.querySelector('.pane-main') as HTMLElement; s.scrollTop = 0; });
  const olderButton = older.getByRole('button');
  await olderButton.scrollIntoViewIfNeeded();
  const topBefore = await page.evaluate(() => { const li = document.querySelectorAll('.timeline > li')[1] as HTMLElement; return { text: li.textContent, top: li.getBoundingClientRect().top }; });
  await olderButton.click();
  await page.waitForFunction((n) => document.querySelectorAll('.timeline > li').length > n + 250, drawn);
  const after = await page.evaluate((text) => { const li = Array.from(document.querySelectorAll('.timeline > li')).find((x) => x.textContent === text) as HTMLElement | undefined; return li ? li.getBoundingClientRect().top : null; }, topBefore.text);
  check('300 more rows came in', (await rows().count()) > drawn + 250);
  check('what the user was looking at stayed where it was (the page did not jump)', after !== null && Math.abs(after - topBefore.top) < 60, `${after} vs ${topBefore.top}`);
  check('the page still answers', (await frame()) < 800);

  console.log('\n=== a change of 18,000 lines ===');
  await page.getByRole('combobox', { name: 'Mensagem' }).fill('grave o arquivo grande');
  await page.getByRole('combobox', { name: 'Mensagem' }).press('Enter');
  await page.getByText('Gravei o arquivo grande.').waitFor({ timeout: 30000 });
  await page.getByTestId('panel-toggle').click();
  await page.getByTestId('side-panel').waitFor();
  const change = page.locator('.change[data-path="grande.txt"]');
  await change.waitFor({ timeout: 15000 });
  check('the list shows it with its size in lines', (await change.innerText()).includes('+18000'));
  const d0 = Date.now();
  await change.locator('.change-main').click();
  await change.getByTestId('diff').waitFor({ timeout: 15000 });
  const diffTime = Date.now() - d0;
  const lineCount = await change.locator('.dl').count();
  check(`the diff opens without freezing the panel (${diffTime} ms)`, diffTime < 5000, `${diffTime} ms`);
  check(`only its first 1,500 lines are drawn (${lineCount}), with a button for the rest`, lineCount === 1500 && (await change.getByRole('button', { name: /Mostrar tudo|Mostrar as/ }).count()) === 1, String(lineCount));
  check('the page answers right after', (await frame()) < 800);
  const all = change.getByRole('button', { name: /Mostrar/ }).last();
  const a0 = Date.now();
  await all.click();
  await page.waitForFunction(() => document.querySelectorAll('[data-path="grande.txt"] .dl').length > 1500, undefined, { timeout: 20000 });
  const allTime = Date.now() - a0;
  check(`showing all of it (up to the app's own cap) does not hang either (${allTime} ms)`, allTime < 10000, `${allTime} ms`);
  check('and says the diff was cut when it was', (await change.innerText()).includes('O diff é grande e foi cortado.') || (await change.locator('.dl').count()) >= 18000);
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
console.log('\nAll performance checks passed.');
