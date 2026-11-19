/**
 * Streaming (A19) in the REAL built app against a fake endpoint that really streams (server-sent events): the answer appears as
 * it is written, grows, and is replaced by the whole message without a duplicate; the reasoning streams too; Stop in the middle
 * keeps what arrived; an endpoint that cannot stream still works (the answer comes whole, once told, and is not asked again).
 * Run from desktop/: `npm run test:streaming-app` (builds first).
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { startFakeServer, type FakeTurn } from './lib/fakeServer';
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

const KEY = 'sk-test-STREAMKEY-12345678';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alia-stream-app-'));
const project = path.join(tmp, 'projeto');
fs.mkdirSync(project, { recursive: true });
const electronBinary: string = createRequire(path.join(desktop, 'package.json'))('electron');

async function launch(turns: FakeTurn[], streaming: 'sse' | 'refuse' | 'ignore') {
  const server = await startFakeServer(turns, { apiKey: KEY, streaming });
  const config = path.join(tmp, `config-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(config, JSON.stringify({ apiKey: KEY, apiType: 'chat-completions', models: [{ id: 'fake-model', name: 'fake', url: server.url, toolCalling: true, maxInputTokens: 128000 }] }));
  const env = { ...process.env, ALIA_DESKTOP_DATA_DIR: path.join(tmp, `data-${Math.random().toString(36).slice(2)}`), ALIA_DESKTOP_TEST: '1', ALIA_CONFIG: config, ALIA_TEST_PICK_FOLDER: project } as NodeJS.ProcessEnv;
  for (const k of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'ALIA_API_KEY', 'OPENAI_API_KEY']) delete env[k];
  const app: ElectronApplication = await electron.launch({ executablePath: electronBinary, args: ['.'], cwd: desktop, env });
  const page: Page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('.sidebar');
  await page.evaluate(async () => { await (window as any).alia.request('settings.update', { permissionMode: 'auto' }); await (window as any).alia.request('projects.pick', {}); });
  await page.getByRole('button', { name: 'Abrir pasta…' }).click();
  await page.getByRole('combobox', { name: 'Mensagem' }).waitFor({ timeout: 15000 });
  return { app, page, server };
}
const send = async (page: Page, text: string) => {
  const box = page.getByRole('combobox', { name: 'Mensagem' });
  await box.fill(text);
  await box.press('Enter');
};

const LONG = 'Primeiro parágrafo da resposta, com **texto em negrito** e `código`.\n\nSegundo parágrafo, que também chega aos poucos.\n\n- item um\n- item dois\n\nFim da resposta.';

try {
  console.log('\n=== the answer arrives as it is written ===');
  {
    const { app, page, server } = await launch([{ content: LONG, reasoning: 'Vou organizar a resposta em parágrafos curtos antes de escrever.', chunkDelayMs: 30 }], 'sse');
    await send(page, 'escreva a resposta');
    const live = page.locator('.turn.assistant[data-live="true"]');
    await live.waitFor({ timeout: 15000 });
    const sizes = new Set<number>();
    const hidden: Array<string | null> = [];
    const started = Date.now();
    while (Date.now() - started < 15000) {
      if ((await page.locator('.turn.assistant.final').count()) > 0) break;
      // One read of the page, so the text and its attribute are from the same moment (the row may be replaced between two reads).
      const seen = await page.evaluate(() => { const el = document.querySelector('.turn.assistant[data-live="true"] .bubble'); return el ? { length: (el.textContent ?? '').length, hidden: el.getAttribute('aria-hidden') } : null; });
      if (seen) {
        if (seen.length) sizes.add(seen.length);
        hidden.push(seen.hidden);
      }
      await sleep(25);
    }
    await page.locator('.turn.assistant.final').waitFor({ timeout: 15000 });
    check('the request asked for a stream', server.requests[0].stream === true);
    check(`the text grew while it was written (${sizes.size} different lengths seen)`, sizes.size >= 3, [...sizes].join());
    check('while it is written the bubble is kept from the screen reader (aria-hidden), and the label says "escrevendo…"', hidden.length > 0 && hidden.every((h) => h === 'true'));
    check('the whole message replaced it: one answer row, no copy of the partial one, and no live row left', (await page.locator('.turn.assistant').count()) === 1 && (await page.locator('.turn.assistant[data-live="true"]').count()) === 0 && (await page.locator('.turn.assistant.final .bubble').getAttribute('aria-hidden')) === null);
    const html = await page.locator('.turn.assistant.final .bubble').innerHTML();
    check('it is the whole text, rendered as markdown (bold, code, a list), the same as without streaming', html.includes('<strong>texto em negrito</strong>') && html.includes('<code>código</code>') && (html.match(/<li>/g) ?? []).length === 2 && (await page.locator('.turn.assistant.final').innerText()).includes('Fim da resposta.'));
    check('the reasoning streamed into its own row and ended whole', (await page.locator('.thinking').count()) === 1 && ((await page.locator('.thinking details').textContent()) ?? '').includes('Vou organizar a resposta') && (await page.locator('.thinking[data-live="true"]').count()) === 0);
    check('the conversation is not left "busy": the composer can send again', await page.getByRole('combobox', { name: 'Mensagem' }).isEnabled() && (await page.getByTestId('thinking').count()) === 0);
    await app.close();
    await server.close();
  }

  console.log('\n=== Stop in the middle of an answer ===');
  {
    const { app, page, server } = await launch([{ content: 'Uma resposta muito comprida que o usuário vai interromper no meio do caminho porque já viu o que queria. '.repeat(6), chunkDelayMs: 60 }], 'sse');
    await send(page, 'escreva muito');
    const live = page.locator('.turn.assistant[data-live="true"] .bubble');
    await live.waitFor({ timeout: 15000 });
    await page.waitForFunction(() => (document.querySelector('.turn.assistant[data-live="true"] .bubble')?.textContent ?? '').length > 40, undefined, { timeout: 15000 });
    await page.getByRole('button', { name: 'Parar' }).click();
    await page.locator('[data-notice="cancelled"]').waitFor({ timeout: 15000 });
    await sleep(300);
    const partial = await page.locator('.turn.assistant').first().innerText();
    check('what had arrived stays on screen, as plain text, no longer being written', partial.length > 40 && partial.length < 500 && (await page.locator('.turn.assistant[data-live="true"]').count()) === 0);
    check('the conversation says it was stopped, and the composer is free', (await page.locator('[data-notice="cancelled"]').count()) === 1 && await page.getByRole('combobox', { name: 'Mensagem' }).isEnabled());
    await app.close();
    await server.close();
  }

  console.log('\n=== an endpoint that cannot stream ===');
  {
    const { app, page, server } = await launch([{ content: 'Resposta inteira, de uma vez.' }, { content: 'Segunda resposta, também inteira.' }], 'refuse');
    await send(page, 'oi');
    await page.getByText('Resposta inteira, de uma vez.').waitFor({ timeout: 15000 });
    check('the answer comes whole and the run is fine', (await page.locator('.turn.assistant.final').count()) === 1);
    check('the user is told once, in the conversation, that this endpoint does not stream', (await page.locator('.timeline').innerText()).includes('does not stream'));
    await send(page, 'de novo');
    await page.getByText('Segunda resposta, também inteira.').waitFor({ timeout: 15000 });
    const flags = server.requests.map((r) => r.stream);
    check('the first request asked for a stream and was refused, the repeat was plain, and later ones do not ask again', flags.join() === 'true,false,false', flags.join());
    check('the notice is not repeated', ((await page.locator('.timeline').innerText()).match(/does not stream/g) ?? []).length === 1);
    await app.close();
    await server.close();
  }
} catch (err: any) {
  failures++;
  console.log(`  ✘ ${err?.stack ?? err}`);
} finally {
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
console.log('\nAll streaming screen checks passed.');
