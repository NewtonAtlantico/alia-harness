/**
 * The sidebar, projects, trust and conversations (A5), driven like a person would in the REAL built app, against a
 * fake model endpoint: opening folders, the conversation list, search, rename, delete, the trust question for a
 * project's own skills, running and waiting marks, the pipeline chip, Ctrl N, and what survives a restart.
 * Run from desktop/: `npm run test:sidebar-app` (builds first). Opens a window for a few seconds.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PipelineStateStore } from 'alia-harness/core';
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

const KEY = 'sk-test-SIDEBARKEY-12345678';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alia-sidebar-'));
const dataDir = path.join(tmp, 'data');
const projB = path.join(tmp, 'portal-cliente'); // an ordinary project
const projA = path.join(tmp, 'site-institucional'); // carries its own skill
fs.mkdirSync(projB);
fs.mkdirSync(path.join(projA, '.alia', 'skills', 'greet'), { recursive: true });
fs.writeFileSync(path.join(projA, '.alia', 'skills', 'greet', 'SKILL.md'), '---\nname: greet\ndescription: Greets people\n---\nGREET-BODY\n');

const server = await startFakeServer(
  [
    { content: 'Bananas são ricas em potássio.' },
    { content: 'Abacaxi é uma fruta tropical.' },
    { content: 'Olá do site.' },
    { delayMs: 2500, content: 'terminei a tarefa lenta' },
    { toolCalls: [{ name: 'run_bash', args: { command: 'echo aprovado' }, id: 'b1' }] },
    { content: 'comando executado' },
  ],
  { apiKey: KEY }
);

const config = path.join(tmp, 'alia-config.json');
fs.writeFileSync(config, JSON.stringify({ apiKey: KEY, apiType: 'chat-completions', models: [{ id: 'fake-model', name: 'fake', url: server.url, toolCalling: true, maxInputTokens: 128000 }] }));

const electronBinary: string = createRequire(path.join(desktop, 'package.json'))('electron');
const baseEnv = { ...process.env, ALIA_DESKTOP_DATA_DIR: dataDir, ALIA_DESKTOP_TEST: '1', ALIA_CONFIG: config } as NodeJS.ProcessEnv;
for (const k of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'ALIA_API_KEY', 'OPENAI_API_KEY']) delete baseEnv[k];

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ executablePath: electronBinary, args: ['.'], cwd: desktop, env: baseEnv });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('.sidebar');
  await page.evaluate(() => {
    const w = window as any;
    w.__msgs = [];
    w.alia.onMessage((m: unknown) => w.__msgs.push(m));
  });
  return { app, page };
}
const pickNext = (app: ElectronApplication, folder: string) => app.evaluate((_, f) => { process.env.ALIA_TEST_PICK_FOLDER = f; }, folder);

const call = (page: Page, name: string, payload: object = {}) =>
  page.evaluate(([n, p]) => (window as any).alia.request(n, p).then((result: unknown) => ({ ok: true, result }), (err: Error) => ({ ok: false, error: String(err.message) })), [name, payload] as const) as Promise<any>;
const ok = async (page: Page, name: string, payload: object = {}) => {
  const r = await call(page, name, payload);
  if (!r.ok) throw new Error(`${name}: ${r.error}`);
  return r.result;
};
const messages = (page: Page): Promise<any[]> => page.evaluate(() => (window as any).__msgs);
const waitFor = async <T>(fn: () => Promise<T | undefined | false>, ms = 15000, label = 'condition'): Promise<T> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v as T;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
};
const finishedCount = async (page: Page, id: string) => (await messages(page)).filter((m) => m.kind === 'event' && m.sessionId === id && m.event.type === 'run_finished').length;
/** Starts a conversation in a project and waits for its first answer. */
async function converse(page: Page, project: string, text: string): Promise<string> {
  const s = await ok(page, 'session.open', { projectPath: project });
  await ok(page, 'session.run', { sessionId: s.sessionId, text });
  await waitFor(async () => (await finishedCount(page, s.sessionId)) >= 1, 20000, `the answer to "${text}"`);
  return s.sessionId;
}
const convList = (page: Page, project: string) => page.getByRole('list', { name: `Conversas de ${project}` });
const titles = (page: Page, project: string) => convList(page, project).locator('.conv-title').allInnerTexts();

let { app, page } = await launch();
try {
  console.log('\n=== the start screen ===');
  await page.waitForSelector('.home');
  const greeting = await page.locator('.home h1').innerText();
  const osName = os.userInfo().username.replace(/^./, (c) => c.toUpperCase());
  check('the greeting follows the time of day and uses the display name', /^(Bom dia|Boa tarde|Boa noite), /.test(greeting) && greeting.endsWith(osName), greeting);
  check('with no project open it says so', (await page.getByTestId('project-chip').innerText()) === 'Nenhum projeto aberto' && (await page.getByText('Abra a pasta de um projeto para começar.').count()) === 1);

  console.log('\n=== opening a project ===');
  await pickNext(app, projB);
  await page.getByRole('button', { name: 'Abrir pasta…' }).click();
  await page.getByText('Nenhuma conversa neste projeto.').waitFor();
  check('the folder appears in Projetos and is the current one', (await page.getByRole('list', { name: 'Projetos' }).locator('[aria-current=true]').innerText()).includes('portal-cliente') && (await page.getByTestId('project-chip').innerText()) === 'Projeto: portal-cliente');

  console.log('\n=== the conversation list ===');
  const c1 = await converse(page, projB, 'Fale sobre bananas');
  await sleep(1100);
  const c2 = await converse(page, projB, 'Explique abacaxi');
  await page.getByText('Explique abacaxi').first().waitFor();
  check('conversations appear as they are made, newest first, titled from the first message', (await titles(page, 'portal-cliente')).join('|') === 'Explique abacaxi|Fale sobre bananas', (await titles(page, 'portal-cliente')).join('|'));
  check('each shows how long ago it was active', (await convList(page, 'portal-cliente').locator('.conv-meta .hint').first().innerText()) === 'agora');

  console.log('\n=== search ===');
  await page.getByRole('searchbox', { name: 'Buscar conversas' }).fill('abacaxi');
  await page.getByText('em portal-cliente').first().waitFor();
  check('search finds a conversation by what was said, across projects, and says where it is', (await page.locator('.results .conv').count()) === 1 && (await page.locator('.results').innerText()).includes('Explique abacaxi'));
  await page.getByRole('searchbox', { name: 'Buscar conversas' }).fill('potássio');
  await page.getByText('Fale sobre bananas').first().waitFor();
  check('...also by what the assistant answered, with a snippet', (await page.locator('.results .snippet').first().innerText()).includes('potássio'));
  await page.getByRole('searchbox', { name: 'Buscar conversas' }).fill('zzzz-nada');
  await page.getByText('Nada encontrado.').waitFor();
  check('a search with no match says so', (await page.getByText('Nada encontrado.').count()) === 1);
  await page.getByRole('searchbox', { name: 'Buscar conversas' }).fill('');
  await page.getByRole('list', { name: 'Conversas de portal-cliente' }).waitFor();
  check('clearing the search brings the list back', (await titles(page, 'portal-cliente')).length === 2);

  console.log('\n=== opening a conversation ===');
  await convList(page, 'portal-cliente').getByRole('button', { name: /Fale sobre bananas/ }).first().click();
  await page.locator('.conversation').waitFor();
  const body = await page.locator('.conversation').innerText();
  check('it opens with what was said, who said it, and the model', body.includes('Fale sobre bananas') && body.includes('Bananas são ricas em potássio.') && body.includes('Você') && body.includes('Modelo: fake-model'));
  check('it is marked as the current one in the list', (await convList(page, 'portal-cliente').locator('[aria-current=true]').innerText()).includes('Fale sobre bananas'));

  console.log('\n=== rename ===');
  const row = convList(page, 'portal-cliente').locator('li', { hasText: 'Fale sobre bananas' });
  await row.hover();
  await row.getByRole('button', { name: /Renomear a conversa Fale sobre bananas/ }).click();
  await page.getByLabel('Novo nome da conversa').fill('Descartável');
  await page.keyboard.press('Escape');
  check('Esc cancels a rename', (await titles(page, 'portal-cliente')).includes('Fale sobre bananas'));
  await row.hover();
  await row.getByRole('button', { name: /Renomear a conversa/ }).click();
  await page.getByLabel('Novo nome da conversa').fill('Frutas');
  await page.keyboard.press('Enter');
  await convList(page, 'portal-cliente').getByText('Frutas').waitFor();
  check('Enter saves it, in the list and in the open conversation, and it is saved on disk', (await page.locator('.conversation h1').innerText()) === 'Frutas' && (await ok(page, 'conversations.list', { projectPath: projB })).some((i: any) => i.title === 'Frutas'));

  console.log('\n=== delete ===');
  const rowDel = convList(page, 'portal-cliente').locator('li', { hasText: 'Explique abacaxi' });
  await rowDel.hover();
  await rowDel.getByRole('button', { name: /Excluir a conversa/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Excluir esta conversa?' });
  await dialog.waitFor();
  check('deleting asks first, names the conversation, and the safe button has the focus', (await dialog.innerText()).includes('Explique abacaxi') && (await page.evaluate(() => document.activeElement?.textContent)) === 'Cancelar');
  await page.keyboard.press('Escape');
  check('Esc keeps it', (await dialog.count()) === 0 && (await titles(page, 'portal-cliente')).includes('Explique abacaxi'));
  await rowDel.hover();
  await rowDel.getByRole('button', { name: /Excluir a conversa/ }).click();
  await dialog.getByRole('button', { name: 'Excluir' }).click();
  await sleep(600);
  check('confirming deletes it from the list and from disk', !(await titles(page, 'portal-cliente')).includes('Explique abacaxi') && (await ok(page, 'conversations.list', { projectPath: projB })).length === 1);
  void c2;

  console.log('\n=== keyboard ===');
  await convList(page, 'portal-cliente').getByRole('button', { name: /Frutas/ }).first().focus();
  await page.keyboard.press('Tab');
  check('the rename and delete buttons of a row are reachable with Tab (they appear when the row has focus)', ((await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))) ?? '').startsWith('Renomear a conversa'));

  console.log('\n=== a project that carries its own skills ===');
  await pickNext(app, projA);
  await page.getByRole('button', { name: 'Abrir pasta…' }).click();
  const trust = page.getByRole('dialog', { name: 'Confiar nesta pasta?' });
  await trust.waitFor();
  check('before anything loads, the user is asked, told what the skills are, and "Agora não" has the focus', (await trust.innerText()).includes('greet') && (await trust.innerText()).includes('site-institucional') && (await page.evaluate(() => document.activeElement?.textContent)) === 'Agora não');
  check('nothing is trusted yet', (await ok(page, 'projects.inspect', { projectPath: projA })).trust === 'unknown');
  await page.keyboard.press('Escape');
  await page.getByText('Projeto: site-institucional').waitFor();
  check('Esc is "Agora não": the folder opens, and the answer is remembered as a refusal', (await ok(page, 'projects.inspect', { projectPath: projA })).trust === 'declined');
  const a1 = await converse(page, projA, 'oi do projeto A');
  check('a conversation there runs without the project\'s skills', !(await ok(page, 'commands.list', { sessionId: a1 })).some((c: any) => c.name === 'greet'));
  await page.getByRole('list', { name: 'Projetos' }).getByRole('button', { name: /portal-cliente/ }).click();
  await convList(page, 'portal-cliente').waitFor();
  await page.getByRole('list', { name: 'Projetos' }).getByRole('button', { name: /site-institucional/ }).click();
  await sleep(500);
  check('switching projects changes the list, and the question is not asked again', (await page.getByRole('dialog').count()) === 0 && (await titles(page, 'site-institucional')).join() === 'oi do projeto A');

  console.log('\n=== changing the trust decision ===');
  await page.getByRole('button', { name: 'Configurações', exact: true }).click();
  await page.getByTestId('trust-list').waitFor();
  check('the settings list every project with its answer', (await page.getByTestId('trust-list').innerText()).includes('Não confiável') && (await page.getByTestId('trust-list').innerText()).includes('1 skill própria'));
  await page.getByRole('button', { name: 'Confiar na pasta site-institucional' }).click();
  await page.getByRole('button', { name: 'Deixar de confiar na pasta site-institucional' }).waitFor();
  check('trusting from there is recorded', (await ok(page, 'projects.inspect', { projectPath: projA })).trust === 'trusted');
  await page.getByRole('button', { name: 'Voltar' }).click();
  await convList(page, 'site-institucional').getByRole('button', { name: /oi do projeto A/ }).click();
  await page.locator('.conversation').waitFor();
  const afterTrust = await ok(page, 'commands.list', { sessionId: a1 });
  check('the conversation, opened again, now has the project\'s skill (it was reopened to load it)', afterTrust.some((c: any) => c.name === 'greet' && c.kind === 'skill'));

  console.log('\n=== running and waiting marks ===');
  await page.getByRole('list', { name: 'Projetos' }).getByRole('button', { name: /portal-cliente/ }).click();
  await convList(page, 'portal-cliente').waitFor();
  const slow = await ok(page, 'session.open', { projectPath: projB });
  await ok(page, 'session.run', { sessionId: slow.sessionId, text: 'tarefa lenta' });
  const spinner = convList(page, 'portal-cliente').getByRole('img', { name: 'Em execução' });
  await spinner.waitFor({ timeout: 8000 });
  check('a conversation that is running shows a spinner', (await spinner.count()) === 1);
  await page.getByRole('list', { name: 'Projetos' }).getByRole('button', { name: /site-institucional/ }).click();
  await sleep(300);
  check('...and its project shows it too while another project is open (background runs)', (await page.getByRole('list', { name: 'Projetos' }).locator('li', { hasText: 'portal-cliente' }).getByRole('img', { name: 'Em execução' }).count()) === 1);
  await waitFor(async () => (await finishedCount(page, slow.sessionId)) >= 1, 15000, 'the slow run');
  await sleep(500);
  check('when it finishes the spinner goes away', (await page.getByRole('img', { name: 'Em execução' }).count()) === 0);

  await page.getByRole('list', { name: 'Projetos' }).getByRole('button', { name: /portal-cliente/ }).click();
  const mainBefore = await page.locator('main.content').innerText();
  await page.evaluate(() => { (window as any).__focusBefore = document.activeElement; }); // the element itself, not its markup (a mark may appear inside it)
  const needs = await ok(page, 'session.open', { projectPath: projB });
  await ok(page, 'session.run', { sessionId: needs.sessionId, text: 'precisa de aprovação' });
  const card = await waitFor(async () => (await messages(page)).find((m) => m.kind === 'interaction' && m.interaction.sessionId === needs.sessionId), 15000, 'the approval request');
  const dot = convList(page, 'portal-cliente').getByRole('img', { name: 'Aguardando sua aprovação' });
  await dot.waitFor({ timeout: 8000 });
  check('a conversation waiting for an approval shows the orange dot', (await dot.count()) === 1);
  check('...without switching screens or taking the focus away from where the user was', (await page.locator('main.content').innerText()) === mainBefore && (await page.evaluate(() => document.activeElement === (window as any).__focusBefore)));
  await page.getByRole('list', { name: 'Projetos' }).getByRole('button', { name: /site-institucional/ }).click();
  await sleep(300);
  check('...and the project carries the dot while another is open', (await page.getByRole('list', { name: 'Projetos' }).locator('li', { hasText: 'portal-cliente' }).getByRole('img', { name: 'Aguardando sua aprovação' }).count()) === 1);
  await ok(page, 'interaction.respond', { id: card.interaction.id, response: { decision: 'allow_once' } });
  await waitFor(async () => (await finishedCount(page, needs.sessionId)) >= 1, 15000, 'the approved run');
  await sleep(500);
  check('once answered the dot goes away', (await page.getByRole('img', { name: 'Aguardando sua aprovação' }).count()) === 0);

  console.log('\n=== the pipeline of a project ===');
  const store = new PipelineStateStore(projB);
  const q = (id: string) => ({ op: 'add_question', gate: 'G1', id, prompt: `Pergunta ${id}?` });
  store.apply([{ op: 'set_project', name: 'Portal do cliente' }, { op: 'set_stage', stage: 1, status: 'running' }, q('q1'), q('q2'), q('q3'), q('q4'), q('q5')]);
  store.apply([{ op: 'answer_question', id: 'q1', answer: 'a' }, { op: 'answer_question', id: 'q2', answer: 'b' }, { op: 'defer_question', id: 'q3', owner: 'Newton' }]);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const chip = page.getByTestId('pipeline-chip');
  await chip.waitFor();
  check('a project with a pipeline stopped at a gate gets a section with its chip: gate and progress', (await chip.innerText()) === 'G1 · 3/5' && (await page.getByRole('heading', { name: 'Pipelines' }).count()) === 1);
  await page.getByRole('button', { name: 'Pipeline de portal-cliente' }).click();
  await page.getByText('Projeto: portal-cliente').waitFor();
  check('clicking it goes to that project', (await page.getByTestId('project-chip').innerText()) === 'Projeto: portal-cliente');

  console.log('\n=== Ctrl N ===');
  await convList(page, 'portal-cliente').getByRole('button', { name: /Frutas/ }).first().click();
  await page.locator('.conversation').waitFor();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.sendInputEvent({ type: 'keyDown', keyCode: 'N', modifiers: ['control'] }));
  await page.locator('.home').waitFor({ timeout: 5000 });
  check('Ctrl N leaves the open conversation for a new one (the start screen)', (await page.locator('.conversation').count()) === 0 && (await page.locator('.home').count()) === 1);

  console.log('\n=== restarting ===');
  await app.close();
  ({ app, page } = await launch());
  await page.waitForSelector('.home');
  await page.getByRole('list', { name: 'Projetos' }).locator('li').first().waitFor();
  check('both projects are still in the list, and the last one used is the current one', (await page.getByRole('list', { name: 'Projetos' }).locator('li').count()) === 2 && (await page.getByTestId('project-chip').innerText()) === 'Projeto: portal-cliente');
  await convList(page, 'portal-cliente').waitFor();
  check('its conversations are still listed (what is saved is saved)', (await titles(page, 'portal-cliente')).includes('Frutas'));
  check('the pipeline chip is still there', (await page.getByTestId('pipeline-chip').innerText()) === 'G1 · 3/5');
  await page.getByRole('list', { name: 'Projetos' }).getByRole('button', { name: /site-institucional/ }).click();
  await sleep(500);
  check('the trust given earlier is remembered: no question, even after a restart', (await page.getByRole('dialog').count()) === 0 && (await ok(page, 'projects.inspect', { projectPath: projA })).trust === 'trusted');
  const reopened = await ok(page, 'session.open', { projectPath: projA, resumeId: a1 });
  check('and the project\'s skill loads in a reopened conversation', reopened.projectSkills.loaded === true);

  console.log('\n=== accessibility basics ===');
  const unnamed = await page.evaluate(() => {
    const bad: string[] = [];
    for (const el of Array.from(document.querySelectorAll('.sidebar button, .sidebar input'))) {
      const h = el as HTMLElement;
      const name = (h.getAttribute('aria-label') || (h as HTMLInputElement).placeholder || h.textContent || '').trim();
      if (!name) bad.push(h.outerHTML.slice(0, 80));
    }
    return bad;
  });
  check('every button and field in the sidebar has a name', unnamed.length === 0, unnamed.join(' | '));
  check('the sidebar is a labelled navigation landmark, and the search is a search landmark', (await page.getByRole('navigation', { name: 'Navegação' }).count()) === 1 && (await page.getByRole('search').count()) === 1);
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
console.log('\nAll sidebar checks passed.');
