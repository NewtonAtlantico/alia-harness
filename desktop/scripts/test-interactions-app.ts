/**
 * Approvals and questions (A8) in the REAL built app: the permission card with its three answers, a dangerous command,
 * "always allow" being remembered, the model's questions with partial answers and deferral, a cancelled run closing its
 * card, a request from a background conversation, and the queue. Run from desktop/: `npm run test:interactions-app`.
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

const KEY = 'sk-test-INTERACTKEY-12345678';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alia-interactions-'));
const project = path.join(tmp, 'projeto');
fs.mkdirSync(project);
const osName = os.userInfo().username.replace(/^./, (c) => c.toUpperCase());

const lastTool = (req: { messages: any[] }) => String(req.messages.filter((m: any) => m.role === 'tool').pop()?.content ?? '');
const bash = (command: string, id: string) => ({ toolCalls: [{ name: 'run_bash', args: { command }, id }] });

const server = await startFakeServer(
  [
    // R1: allow once
    bash('echo uma-vez', 'b1'),
    { content: 'feito 1' },
    // R2: always allow
    bash('echo para-sempre', 'b2'),
    { content: 'feito 2' },
    // R3: the same command again: no card
    bash('echo para-sempre', 'b3'),
    { content: 'feito 3' },
    // R4: dangerous, denied
    bash('rm -rf ./pasta-que-nao-existe', 'b4'),
    { content: 'ok, negado' },
    // R5: three questions, partly answered, one deferred
    {
      toolCalls: [
        {
          name: 'ask_user',
          id: 'a1',
          args: {
            questions: [
              { id: 'q1', kind: 'choice', prompt: 'Qual versão do BRD é a oficial?', confidence: 'low', allowOther: true, allowDefer: true, options: [{ id: 'v1', label: 'BRD v1', source: 'BRD_v1.pdf · p. 3' }, { id: 'v2', label: 'BRD v2', detail: 'a mais recente', source: 'BRD_v2.pdf · p. 14' }] },
              { id: 'q2', kind: 'text', prompt: 'Quantos usuários simultâneos?', allowDefer: true },
              { id: 'q3', kind: 'confirm', prompt: 'A integração com o ERP entra no MVP?' },
            ],
          },
        },
      ],
    },
    (req) => ({ content: `RESPOSTAS ${lastTool(req)}` }),
    // R6: "answer later" with nothing answered
    { toolCalls: [{ name: 'ask_user', id: 'a2', args: { questions: [{ id: 'z1', kind: 'confirm', prompt: 'Posso continuar?' }] } }] },
    (req) => ({ content: `DEPOIS ${lastTool(req)}` }),
    // R7: cancelled while the card is open
    bash('echo cancele', 'b7'),
    // R8: a background conversation
    bash('echo fundo', 'b8'),
    { content: 'fundo ok' },
    // R9: the app stops while a card is open
    bash('echo queda', 'b9'),
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

const call = (name: string, payload: object = {}) =>
  page.evaluate(([n, p]) => (window as any).alia.request(n, p).then((result: unknown) => ({ ok: true, result }), (err: Error) => ({ ok: false, error: String(err.message) })), [name, payload] as const) as Promise<any>;
const ok = async (name: string, payload: object = {}) => {
  const r = await call(name, payload);
  if (!r.ok) throw new Error(`${name}: ${r.error}`);
  return r.result;
};
const box = () => page.getByRole('combobox', { name: 'Mensagem' });
const card = () => page.getByTestId('interaction-card');
const said = async (text: string) => {
  await box().fill(text);
  await box().press('Enter');
};
const finalAnswers = () => page.locator('.turn.assistant.final');
const waitAnswer = (text: string | RegExp) => finalAnswers().filter({ hasText: text }).first().waitFor({ timeout: 20000 });

try {
  await ok('projects.pick');
  await page.getByRole('button', { name: 'Abrir pasta…' }).click();
  await box().waitFor({ timeout: 15000 });

  console.log('\n=== allow once ===');
  await said('rode o primeiro comando');
  await card().waitFor({ timeout: 15000 });
  check('a command that needs approval shows a card in the conversation, with the command and three answers', (await card().innerText()).includes('echo uma-vez') && (await card().getByRole('button').allInnerTexts()).join('|') === 'Permitir uma vez|Sempre permitir neste projeto|Negar', (await card().innerText()).slice(0, 200));
  check('it is the card of an ordinary command, not a dangerous one', (await card().getAttribute('data-dangerous')) === 'false' && (await card().getByText('Comando perigoso').count()) === 0);
  check('the command is shown as waiting for approval', (await page.locator('[data-tool="run_bash"]').innerText()).includes('aguardando aprovação'));
  await page.getByRole('img', { name: 'Aguardando sua aprovação' }).first().waitFor({ timeout: 5000 }).catch(() => {}); // the list refreshes a moment after the run starts
  check('the sidebar shows the orange dot for this conversation', (await page.getByRole('img', { name: 'Aguardando sua aprovação' }).count()) >= 1);
  check('the card did not take the focus away from the message box', await box().evaluate((el) => el === document.activeElement) || (await page.evaluate(() => document.activeElement?.closest('[data-testid=interaction-card]') === null)));
  await card().getByRole('button', { name: 'Permitir uma vez' }).click();
  await waitAnswer('feito 1');
  check('after the answer the card is gone, the command ran, and the row says "permitido"', (await card().count()) === 0 && (await page.locator('[data-tool="run_bash"]').innerText()).includes('permitido') && (await page.locator('[data-tool="run_bash"]').innerText()).includes('passou'));
  check('the dot is gone too', (await page.getByRole('img', { name: 'Aguardando sua aprovação' }).count()) === 0);

  console.log('\n=== always allow, remembered ===');
  await said('rode o segundo');
  await card().waitFor({ timeout: 15000 });
  await card().getByRole('button', { name: 'Sempre permitir neste projeto' }).click();
  await waitAnswer('feito 2');
  check('"always" is recorded for the project (and shown on the row)', (await ok('permissions.listForProject', { projectPath: project })).some((r: any) => r.command === 'echo para-sempre') && (await page.locator('[data-tool="run_bash"]').last().innerText()).includes('sempre permitido'));
  await said('rode o segundo de novo');
  await waitAnswer('feito 3');
  check('the same command later does not ask again', (await card().count()) === 0 && (await page.locator('[data-tool="run_bash"]').last().innerText()).includes('passou'));

  console.log('\n=== a dangerous command ===');
  await said('apague a pasta');
  await card().waitFor({ timeout: 15000 });
  const danger = (await card().innerText()).replace(/\s+/g, ' ');
  check('it is marked dangerous and shows why', (await card().getAttribute('data-dangerous')) === 'true' && danger.includes('Comando perigoso') && (await card().locator('.reasons li').count()) >= 1, danger);
  check('"Sempre permitir" is not offered, and the card says why', (await card().getByRole('button', { name: /Sempre permitir/ }).count()) === 0 && danger.includes('nunca podem ficar sempre permitidos'));
  await card().getByRole('button', { name: 'Negar' }).click();
  await waitAnswer('ok, negado');
  check('denied: the command did not run and the row says so', (await page.locator('[data-tool="run_bash"]').last().innerText()).includes('negado') && !fs.existsSync(path.join(project, 'pasta-que-nao-existe')));

  console.log('\n=== questions from the model ===');
  await said('faça as perguntas');
  await card().waitFor({ timeout: 15000 });
  check('the questions arrive as a card: prompts, options with their sources, and the confidence', (await card().getAttribute('data-kind')) === 'ask_user' && (await card().innerText()).includes('Qual versão do BRD é a oficial?') && (await card().innerText()).includes('Fonte: BRD_v2.pdf · p. 14') && (await card().innerText()).includes('a mais recente') && (await card().innerText()).includes('confiança baixa'));
  check('nothing answered yet: "Enviar" is off, "Responder depois" is on', await card().getByRole('button', { name: 'Enviar respostas' }).isDisabled() && (await card().getByRole('button', { name: 'Responder depois' }).isEnabled()));
  await card().getByRole('radio', { name: /BRD v2/ }).check();
  const q2 = card().locator('[data-question="q2"]');
  await q2.getByLabel('Adiar: registrar como suposição').check();
  check('deferring asks for an owner, and offers the user\'s name', (await q2.getByLabel(/Responsável pela suposição/).inputValue()) === osName);
  await card().locator('[data-question="q1"]').getByLabel('Outra resposta', { exact: true }).first().focus();
  await card().getByRole('radio', { name: /BRD v2/ }).check();
  check('the button counts what is answered', await card().getByRole('button', { name: 'Enviar respostas (2 de 3)' }).isEnabled());
  await card().getByRole('button', { name: 'Enviar respostas (2 de 3)' }).click();
  const answerBlock = finalAnswers().filter({ hasText: 'RESPOSTAS' }).first();
  await answerBlock.waitFor({ timeout: 20000 });
  const echoed = await answerBlock.innerText();
  check('the model received the answers: the choice with its label, the deferral with its owner', echoed.includes('"answer": "v2"') && echoed.includes('"label": "BRD v2"') && echoed.includes('"deferred": true') && echoed.includes(`"owner": "${osName}"`), echoed.slice(0, 400));
  check('...and was told which question stayed open', echoed.includes('unanswered') && echoed.includes('q3'));

  await said('pergunte de novo');
  await card().waitFor({ timeout: 15000 });
  await card().getByRole('button', { name: 'Responder depois' }).click();
  const later = finalAnswers().filter({ hasText: 'DEPOIS' }).first();
  await later.waitFor({ timeout: 20000 });
  check('"Responder depois" with nothing answered sends no answers, and the agent is told to stop there', (await later.innerText()).includes('unanswered') && (await later.innerText()).includes('z1'));

  console.log('\n=== cancelling closes the card ===');
  await said('rode e eu vou cancelar');
  await card().waitFor({ timeout: 15000 });
  const sessionId = (await ok('sessions.active')).find((s: any) => s.waiting > 0).sessionId;
  await page.getByRole('button', { name: /Parar/ }).click();
  await page.locator('[data-notice="cancelled"]').waitFor({ timeout: 10000 });
  check('Stop while the card is open dismisses it, and nothing is left waiting', (await card().count()) === 0 && (await ok('interaction.pending')).length === 0 && (await page.getByRole('img', { name: 'Aguardando sua aprovação' }).count()) === 0);
  check('the command that never ran is marked cancelled', (await page.locator('[data-tool="run_bash"]').last().innerText()).includes('cancelado'), (await page.locator('[data-tool="run_bash"]').last().innerText()) + ' || TIMELINE TAIL: ' + (await page.locator('.timeline').innerText()).slice(-500).replace(/\n+/g, ' / ') + ' || RULES: ' + JSON.stringify(await ok('permissions.listForProject', { projectPath: project })));
  void sessionId;

  console.log('\n=== a request from a conversation that is not on screen ===');
  const open = await ok('sessions.active').then((l: any[]) => l.map((s) => s.sessionId));
  const other = await ok('session.open', { projectPath: project });
  await sleep(600); // let the header settle after the cancelled run (the context meter refreshes a moment later)
  await box().focus();
  await page.evaluate(() => { (window as any).__focusBefore = document.activeElement; });
  const screenBefore = await page.locator('main.content').innerText();
  await ok('session.run', { sessionId: other.sessionId, text: 'rode em segundo plano' });
  await page.getByRole('img', { name: 'Aguardando sua aprovação' }).first().waitFor({ timeout: 15000 });
  const screenAfter = await page.locator('main.content').innerText();
  const focusKept = await page.evaluate(() => document.activeElement === (window as any).__focusBefore);
  check('only the sidebar dot appears: no card here, no change of screen, the focus stays where it was', (await card().count()) === 0 && screenAfter === screenBefore && focusKept, `card=${await card().count()} sameScreen=${screenAfter === screenBefore} focusKept=${focusKept} BEFORE=${screenBefore.slice(-200).replace(/\n+/g, ' / ')} AFTER=${screenAfter.slice(-200).replace(/\n+/g, ' / ')}`);
  await page.getByRole('list', { name: 'Conversas de projeto' }).getByRole('button', { name: /rode em segundo plano/ }).click();
  await card().waitFor({ timeout: 10000 });
  check('opening that conversation shows its card (found again from what is pending)', (await card().innerText()).includes('echo fundo'));
  await card().getByRole('button', { name: 'Permitir uma vez' }).click();
  await waitAnswer('fundo ok');
  check('answered, and the dot is gone', (await page.getByRole('img', { name: 'Aguardando sua aprovação' }).count()) === 0);
  void open;

  console.log('\n=== several requests queue ===');
  const activeId = (await ok('sessions.active')).find((s: any) => s.sessionId === other.sessionId)!.sessionId;
  for (const n of [1, 2, 3]) {
    await app.evaluate(({ BrowserWindow }, [id, k]) => BrowserWindow.getAllWindows()[0].webContents.send('alia:push', { kind: 'interaction', interaction: { id: `fake-${k}`, sessionId: id, kind: 'permission', command: `echo fila-${k}`, reasons: [], dangerous: false, canAlwaysAllow: true } }), [activeId, n] as const);
  }
  await card().waitFor();
  check('the oldest is the card, with a count of the others behind it', (await card().innerText()).includes('echo fila-1') && (await card().innerText()).includes('Mais 2 pedidos aguardando.'));
  await card().getByRole('button', { name: 'Negar' }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid=interaction-card]')?.textContent?.includes('echo fila-2'));
  check('answering it brings the next', (await card().innerText()).includes('Mais 1 pedido aguardando.'));
  await card().getByRole('button', { name: 'Negar' }).click();
  await card().getByRole('button', { name: 'Negar' }).click();
  await sleep(300);
  check('and when the last is answered the card is gone', (await card().count()) === 0);
  check('the orange dot and the "aguardando" notice go with it at once (not when the run ends)', (await page.getByRole('img', { name: 'Aguardando sua aprovação' }).count()) === 0 && (await page.getByText('Aguardando sua aprovação.').count()) === 0);

  console.log('\n=== the app stops while a card is open ===');
  await box().waitFor();
  await said('rode antes da queda');
  await card().waitFor({ timeout: 15000 });
  await app.evaluate(() => (globalThis as any).__aliaTest.engine.crashForTest());
  const interrupted = page.locator('[data-notice="interrupted"]');
  await interrupted.waitFor({ timeout: 30000 });
  check('the card is gone (nothing is waiting any more), and the conversation says it was interrupted', (await card().count()) === 0 && (await interrupted.innerText()).includes('foi interrompida') && (await interrupted.innerText()).includes('1 chamada'), await interrupted.innerText());
  check('the command that was waiting is shown as cancelled, not as waiting for an approval nobody can give', (await page.locator('[data-tool="run_bash"]').last().innerText()).includes('cancelado') && !(await page.locator('[data-tool="run_bash"]').last().innerText()).includes('aguardando'));
  check('nothing is left pending, no dot, and the box is ready to carry on', (await ok('interaction.pending')).length === 0 && (await page.getByRole('img', { name: 'Aguardando sua aprovação' }).count()) === 0 && (await page.getByRole('button', { name: 'Enviar' }).count()) === 1);

  console.log('\n=== accessibility ===');
  await page.evaluate(() => {});
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].webContents.send('alia:push', { kind: 'interaction', interaction: { id: 'a11y', sessionId: id, kind: 'permission', command: 'echo a11y', reasons: ['apaga arquivos'], dangerous: true, canAlwaysAllow: false } }), activeId);
  await card().waitFor();
  check('the card is a labelled group, announced to screen readers, with named buttons', (await card().getAttribute('role')) === 'group' && !!(await card().getAttribute('aria-labelledby')) && (await card().locator('[role=alert]').innerText()).includes('echo a11y') && (await card().getByRole('button').count()) === 2);
  check('a stray Enter in the message box does not approve anything', await (async () => { await box().focus(); await box().press('Enter'); return (await card().count()) === 1; })());
  await card().getByRole('button', { name: 'Negar' }).click();
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
console.log('\nAll approval and question checks passed.');
