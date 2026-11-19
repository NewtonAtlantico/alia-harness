/**
 * The diagnostics card of the settings screen (A17) in the REAL built app: what the machine has or lacks, what to do about
 * each missing piece, the endpoint tested for real against the fake server, and the report copied to the clipboard without any
 * secret. The machine is described to the app through the test seam, so the answer does not depend on this one.
 * Run from desktop/: `npm run test:diagnostics-app` (builds first).
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { startFakeServer } from './lib/fakeServer';
import { audit, describeViolations } from './lib/axe';

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

const KEY = 'sk-test-DIAGKEY-12345678';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alia-diag-app-'));
const server = await startFakeServer([], { apiKey: KEY });
const config = path.join(tmp, 'alia-config.json');
fs.writeFileSync(config, JSON.stringify({ apiKey: KEY, apiType: 'chat-completions', models: [{ id: 'fake-model', name: 'fake', url: server.url, toolCalling: true, maxInputTokens: 128000 }] }));
const electronBinary: string = createRequire(path.join(desktop, 'package.json'))('electron');

async function launch(machine: object): Promise<{ app: ElectronApplication; page: Page }> {
  const env = { ...process.env, ALIA_DESKTOP_DATA_DIR: path.join(tmp, `data-${Math.random().toString(36).slice(2)}`), ALIA_DESKTOP_TEST: '1', ALIA_CONFIG: config, ALIA_TEST_DIAG: JSON.stringify(machine) } as NodeJS.ProcessEnv;
  for (const k of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'ALIA_API_KEY', 'OPENAI_API_KEY']) delete env[k];
  const app = await electron.launch({ executablePath: electronBinary, args: ['.'], cwd: desktop, env });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('.sidebar');
  await page.getByRole('button', { name: 'Configurações' }).click();
  await page.getByTestId('diagnostics').waitFor();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid=diagnostics] [data-diag]').length === 6, undefined, { timeout: 20000 });
  return { app, page };
}
const row = (page: Page, id: string) => page.locator(`[data-testid=diagnostics] [data-diag="${id}"]`);

try {
  console.log('\n=== a machine with nothing on it ===');
  {
    const { app, page } = await launch({ bash: null, git: null, python: null, docx: false });
    check('all six checks are listed, in order', (await page.locator('[data-testid=diagnostics] [data-diag]').evaluateAll((els) => els.map((e) => e.getAttribute('data-diag')))).join() === 'bash,git,python,python-docx,skills,endpoint');
    check('Git Bash is missing, and the card says why it matters and how to get it', (await row(page, 'bash').getAttribute('data-tone')) === 'bad' && (await row(page, 'bash').innerText()).includes('PowerShell') && (await row(page, 'bash').innerText()).includes('Instale o Git para Windows (git-scm.com)'));
    check('Git is missing, with the instruction', (await row(page, 'git').getAttribute('data-tone')) === 'bad' && (await row(page, 'git').innerText()).includes('git-scm.com'));
    check('Python and python-docx are only a warning, marked optional, saying who needs them and how to install', (await row(page, 'python').getAttribute('data-tone')) === 'warn' && (await row(page, 'python').innerText()).includes('opcional') && (await row(page, 'python').innerText()).includes('embrapii-docs') && (await row(page, 'python-docx').innerText()).includes('pip install python-docx'));
    check('the skills that ship with the app are found (counted for real)', (await row(page, 'skills').getAttribute('data-status')) === 'ok' && /\d+ skills encontradas/.test(await row(page, 'skills').innerText()));
    check('the endpoint is tested for real against the fake server: it answers', (await row(page, 'endpoint').getAttribute('data-status')) === 'ok' && (await row(page, 'endpoint').innerText()).includes('Respondeu'));
    check('the app and the machine are shown', /alia Harness 1\.0\.0 · Electron \d+/.test(await page.getByTestId('diag-app').innerText()));
    await page.getByRole('button', { name: 'Copiar relatório' }).click();
    await page.getByText('Relatório copiado').waitFor();
    const clip = await app.evaluate(({ clipboard }) => clipboard.readText());
    check('the report is on the clipboard: the app, the machine, one line per check', clip.includes('version: 1.0.0') && clip.includes('bash: missing') && clip.includes('git: missing') && clip.includes('python: missing (optional)') && clip.includes('endpoint: ok'), clip);
    check('and it holds no secret: not the key, not the address of the service', !clip.includes(KEY) && !clip.includes(server.url) && !/sk-/.test(clip), clip);
    await page.getByRole('button', { name: 'Verificar de novo' }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid=diagnostics] [data-diag]').length === 6);
    { const v = await audit(page); check('settings with the missing and warning results: no accessibility violations', v.length === 0, '\n' + describeViolations(v)); }
    check('it can be checked again', (await row(page, 'bash').getAttribute('data-status')) === 'missing');
    const unnamed = await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid=diagnostics] button')).filter((b) => !(b.textContent || '').trim()).length);
    check('every button has a name, and each result is a word as well as a colour', unnamed === 0 && (await row(page, 'bash').innerText()).includes('faltando'));
    await app.close();
  }

  console.log('\n=== a machine with everything ===');
  {
    const { app, page } = await launch({ bash: 'C:\\Program Files\\Git\\bin\\bash.exe', git: 'git version 2.45.1', python: 'Python 3.12.4', docx: true });
    check('everything is ok, with the values, and nothing asks for anything', (await page.locator('[data-testid=diagnostics] [data-status="ok"]').count()) === 6 && (await row(page, 'bash').innerText()).includes('C:\\Program Files\\Git\\bin\\bash.exe') && (await row(page, 'python').innerText()).includes('Python 3.12.4') && !(await page.getByTestId('diagnostics').innerText()).includes('Instale'));
    await app.close();
  }
} catch (err: any) {
  failures++;
  console.log(`  ✘ ${err?.stack ?? err}`);
} finally {
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
console.log('\nAll diagnostics screen checks passed.');
