/**
 * The pipeline intake (A11) in the REAL built app, against a fake model endpoint: files dropped or chosen, each classified with
 * the skill that reads it, what cannot be read explained, a recording that needs its transcript, the inventory written before
 * the run, a start the engine refuses, the banner and "Retomar sessão". Run from desktop/: `npm run test:intake-app` (builds first).
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { makeDocx, w } from '../../scripts/lib/officeFixture';
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

const KEY = 'sk-test-INTAKEKEY-12345678';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alia-intake-'));
const project = path.join(tmp, 'projeto');
fs.mkdirSync(path.join(project, 'docs'), { recursive: true });
const outside = path.join(tmp, 'downloads');
fs.mkdirSync(outside);
const put = (name: string, data: string | Uint8Array) => {
  const file = path.join(outside, name);
  fs.writeFileSync(file, data);
  return file;
};
const brd = put('BRD_PortalCliente_v2.pdf', makePdf([['Requisitos do portal do cliente'], ['Segunda página']]));
const sow = put('SOW.docx', makeDocx({ body: w.p('Escopo do contrato: portal do cliente.') }));
const scan = put('contrato-escaneado.pdf', makePdf([null, null]));
const legacy = put('proposta.doc', 'binary-ish');
const video = put('kickoff.mp4', 'not really a video');
const transcript = put('kickoff-transcricao.txt', 'Ana: precisamos de SSO.\n'.repeat(120));
const request = put('pedido.txt', 'Adicionar um botão de exportar na lista de pedidos.');
const fragile = put('rascunho.txt', 'Um pedido que vai sumir antes de começar.');
const stateFile = path.join(project, 'docs', 'pipeline', 'state.json');

const server = await startFakeServer([{ content: 'Pipeline iniciado: li as entradas.', delayMs: 1500 }, { content: 'Retomando de onde parou.' }], { apiKey: KEY });
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
const drop = (...files: string[]) => app.evaluate(({ BrowserWindow }, f) => (globalThis as any).__aliaTest.handleDropped(BrowserWindow.getAllWindows()[0].webContents, f), files);
const pickNext = (...files: string[]) => app.evaluate((_e, v) => void (process.env.ALIA_TEST_PICK_FILES = v), files.join(path.delimiter));
const intake = () => page.getByTestId('pipeline-intake');
const row = (name: string) => intake().locator(`.input[data-name="${name}"]`);
const start = () => intake().getByRole('button', { name: 'Iniciar pipeline' });
const settled = () => page.waitForFunction(() => !document.querySelector('.input.loading'), undefined, { timeout: 15000 });
const openIntake = async () => {
  await page.getByTestId('new-pipeline').click();
  await intake().waitFor();
};

try {
  await ok('settings.update', { permissionMode: 'auto' });
  await ok('projects.pick');
  await page.getByRole('button', { name: 'Abrir pasta…' }).click();
  await page.getByRole('combobox', { name: 'Mensagem' }).waitFor({ timeout: 15000 });

  console.log('\n=== the screen ===');
  await openIntake();
  check('"Novo pipeline" in the sidebar opens it, and says it is the current page', (await page.getByTestId('new-pipeline').getAttribute('aria-current')) === 'page' && (await intake().getByRole('heading', { level: 1 }).innerText()) === 'Novo pipeline');
  check('the flow comes first: a labelled list with Embrapii, and what a flow defines', (await intake().getByRole('combobox', { name: 'Fluxo' }).inputValue()) === 'embrapii' && (await intake().getByTestId('flow-card').innerText()).includes('Define as etapas, os gates e as skills do pipeline.'));
  check('the stages come from the flow, each with its skill (the row of four cards is gone)', (await intake().getByTestId('flow-stages').innerText()).includes('2 · Arquitetura (architecture-from-requirements)') && (await intake().getByRole('list', { name: 'Etapas do pipeline' }).count()) === 0);
  check('the target project is a labelled choice, and it is the open one', (await intake().getByLabel('Projeto de destino').inputValue()) === project);
  check('with no file, it cannot start and says why (the button points at the reason)', (await start().isDisabled()) && (await intake().innerText()).includes('Adicione ao menos um arquivo.') && (await page.locator('#' + (await start().getAttribute('aria-describedby'))).innerText()) === 'Adicione ao menos um arquivo.');
  check('with no pipeline yet there is no banner', (await page.getByTestId('resume-banner').count()) === 0);

  console.log('\n=== files dropped: what each one is ===');
  await drop(brd, scan, legacy, sow);
  await settled();
  check('each file is a row, with its class and the skill that reads it', (await row('BRD_PortalCliente_v2.pdf').innerText()).includes('Documento') && (await row('BRD_PortalCliente_v2.pdf').innerText()).includes('Lido por requirement-extraction-from-documents') && (await row('SOW.docx').innerText()).includes('Documento'));
  check('a scanned PDF cannot be used, in the reader\'s own words', (await row('contrato-escaneado.pdf').getAttribute('data-state')) === 'problem' && /Não dá para usar este arquivo/.test(await row('contrato-escaneado.pdf').innerText()) && /scan|text|image/i.test(await row('contrato-escaneado.pdf').locator('.problem').innerText()), await row('contrato-escaneado.pdf').innerText());
  check('an old .doc says to save it as .docx', (await row('proposta.doc').locator('.problem').innerText()).includes('.docx'));
  check('with problems in the list it cannot start, and says what to do', (await start().isDisabled()) && (await intake().innerText()).includes('Remova ou corrija os arquivos com problema'));
  await row('contrato-escaneado.pdf').getByRole('button', { name: 'Remover contrato-escaneado.pdf' }).click();
  await row('proposta.doc').getByRole('button', { name: 'Remover proposta.doc' }).click();
  check('removing them lets the rest start', (await row('contrato-escaneado.pdf').count()) === 0 && (await start().isEnabled()));
  await drop(brd);
  await sleep(300);
  check('dropping the same file again does not add it twice', (await intake().locator('.input').count()) === 2);

  console.log('\n=== a recording needs its transcript ===');
  await drop(video);
  await settled();
  check('a recording is refused as it is, and offers to attach a transcript', (await row('kickoff.mp4').getAttribute('data-state')) === 'needs_transcript' && (await row('kickoff.mp4').innerText()).includes('Gravação') && (await row('kickoff.mp4').getByRole('button', { name: 'Anexar transcrição' }).count()) === 1);
  check('until it has one, nothing starts', (await start().isDisabled()) && (await intake().innerText()).includes('Anexe a transcrição de cada gravação'));
  await pickNext(transcript);
  await row('kickoff.mp4').getByRole('button', { name: 'Anexar transcrição' }).click();
  await row('kickoff.mp4').getByText(/Transcrição: kickoff-transcricao.txt/).waitFor();
  check('the transcript is attached to the recording, with the skill that reads it', (await row('kickoff.mp4').innerText()).includes('requirement-extraction-from-threads') && (await row('kickoff.mp4').getAttribute('data-state')) === 'ok' && (await start().isEnabled()));
  check('it is not a row of its own', (await intake().locator('.input').count()) === 3);
  await row('kickoff.mp4').getByRole('button', { name: 'Remover a transcrição kickoff-transcricao.txt' }).click();
  check('removing it brings the need back', (await row('kickoff.mp4').getAttribute('data-state')) === 'needs_transcript' && (await start().isDisabled()));
  await pickNext(transcript);
  await row('kickoff.mp4').getByRole('button', { name: 'Anexar transcrição' }).click();
  await row('kickoff.mp4').getByText(/Transcrição: kickoff-transcricao.txt/).waitFor();

  console.log('\n=== files chosen with the button ===');
  await pickNext(request);
  await intake().getByRole('button', { name: 'Escolher arquivos' }).click();
  await settled();
  check('a short text file is a short request, read by ticket-to-brief', (await row('pedido.txt').innerText()).includes('Pedido curto') && (await row('pedido.txt').innerText()).includes('Lido por ticket-to-brief'));
  await page.screenshot({ path: path.join(tmp, 'intake.png') });

  console.log('\n=== starting: the inventory comes first ===');
  check('nothing is on disk before the start', !fs.existsSync(stateFile));
  await start().click();
  await page.getByRole('combobox', { name: 'Mensagem' }).waitFor({ timeout: 15000 });
  check('the conversation is on screen, with what the user "said"', (await page.locator('.turn.user').first().innerText()).includes('Iniciar o pipeline com 5 entradas'), await page.locator('.timeline').innerText());
  // The model is still "thinking" (1.5 s): the inventory must already be written.
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const byName = Object.fromEntries(state.inputs.map((i: any) => [i.name, i]));
  check('state.json has every input before the model answered: names, kinds, skills, hashes', Object.keys(byName).length === 5 && byName['BRD_PortalCliente_v2.pdf'].kind === 'document' && /^[0-9a-f]{64}$/.test(byName['BRD_PortalCliente_v2.pdf'].hash) && byName['kickoff.mp4'].kind === 'recording' && byName['kickoff-transcricao.txt'].kind === 'transcript' && byName['pedido.txt'].handledBy === 'ticket-to-brief', JSON.stringify(Object.keys(byName)));
  check('...and the model had not answered yet', (await page.locator('.turn.assistant.final').count()) === 0);
  await page.waitForFunction(() => document.querySelectorAll('.turn.assistant.final').length >= 1, undefined, { timeout: 20000 });
  check('the run goes on in the conversation', (await page.locator('.turn.assistant.final').first().innerText()).includes('Pipeline iniciado'));
  check('the model was given the pipeline skill and the inputs', JSON.stringify(server.requests[0]).includes('requirements-to-tasks-pipeline') && JSON.stringify(server.requests[0]).includes('kickoff-transcricao.txt'));
  check('the intake list is empty again for the next time', (await (async () => (await openIntake(), await intake().locator('.input').count()))()) === 0);

  console.log('\n=== the project already has a pipeline ===');
  await page.getByTestId('resume-banner').waitFor();
  const banner = await page.getByTestId('resume-banner').innerText();
  check('a banner says so and where it stopped', banner.includes('Este projeto já tem um STATE.md') && banner.includes('parou na etapa 1'), banner);
  await page.getByRole('button', { name: 'Retomar sessão' }).click();
  await page.getByRole('combobox', { name: 'Mensagem' }).waitFor({ timeout: 15000 });
  await page.waitForFunction(() => document.querySelectorAll('.turn.assistant.final').length >= 1, undefined, { timeout: 20000 });
  check('"Retomar sessão" resumes from the state, in a conversation of its own', (await page.locator('.turn.assistant.final').first().innerText()).includes('Retomando') && JSON.stringify(server.requests[1]).includes('Where it stopped'));

  console.log('\n=== a start the engine refuses writes nothing ===');
  await openIntake();
  await pickNext(fragile);
  await intake().getByRole('button', { name: 'Escolher arquivos' }).click();
  await settled();
  check('with a pipeline in place, a new file says it will be added', (await row('rascunho.txt').getAttribute('data-state')) === 'ok' && (await intake().innerText()).includes('somados às entradas'));
  const before = fs.readFileSync(stateFile, 'utf8');
  fs.writeFileSync(fragile, ''); // it changes after the check
  await start().click();
  await intake().getByTestId('start-refused').waitFor();
  const refusedText = await intake().getByTestId('start-refused').innerText();
  check('the engine refuses, the page says nothing was written and why, and the files stay in the list', refusedText.includes('nada foi gravado') && refusedText.includes('rascunho.txt') && (await row('rascunho.txt').count()) === 1, refusedText);
  check('state.json is exactly as it was', fs.readFileSync(stateFile, 'utf8') === before);
  check('the user is still on the intake (not in a conversation)', (await intake().count()) === 1);

  console.log('\n=== a damaged state, and files the page never chose ===');
  fs.writeFileSync(stateFile, '{ broken');
  await page.getByTestId('new-pipeline').click(); // the same screen: the banner is read again when the project or the app changes
  await page.getByRole('combobox', { name: 'Projeto de destino' }).selectOption(project);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await sleep(200);
  // Leave and come back: the screen reads the state again when it opens.
  await page.getByRole('button', { name: 'Nova conversa' }).click();
  await page.getByRole('combobox', { name: 'Mensagem' }).waitFor({ timeout: 15000 });
  await openIntake();
  await intake().getByTestId('intake-damaged').waitFor();
  check('a damaged state is reported, nothing offers to resume, and nothing can start', (await intake().getByTestId('intake-damaged').innerText()).includes('inválido') && (await page.getByTestId('resume-banner').count()) === 0 && (await start().isDisabled()));
  check('and it was not overwritten', fs.readFileSync(stateFile, 'utf8') === '{ broken');
  fs.writeFileSync(path.join(outside, 'nunca-escolhido.txt'), 'x');
  const forged = await call('pipeline.inspect', { projectPath: project, paths: [path.join(outside, 'nunca-escolhido.txt')] });
  check('the page cannot inspect a file it was never given (even though it exists)', forged.ok === false && /outside the project folder/.test(forged.error), JSON.stringify(forged));
  const forgedStart = await call('pipeline.start', { sessionId: (await ok('sessions.active'))[0].sessionId, inputs: [{ path: path.join(outside, 'nunca-escolhido.txt') }] });
  check('...nor start a pipeline with it', forgedStart.ok === false && /outside the project folder/.test(forgedStart.error), JSON.stringify(forgedStart));

  console.log('\n=== accessibility ===');
  fs.writeFileSync(stateFile, before);
  await drop(brd);
  await settled();
  const unnamed = await page.evaluate(() => {
    const bad: string[] = [];
    for (const el of Array.from(document.querySelectorAll('[data-testid=pipeline-intake] button, [data-testid=pipeline-intake] select, [data-testid=pipeline-intake] input'))) {
      const h = el as HTMLElement;
      const labelled = h.getAttribute('aria-label') || h.textContent || (h.id && document.querySelector(`label[for="${h.id}"]`)?.textContent);
      if (!labelled?.trim()) bad.push(h.outerHTML.slice(0, 80));
    }
    return bad;
  });
  check('every control on the screen has a name', unnamed.length === 0, unnamed.join(' | '));
  check('the files are a labelled list, and a problem is announced', (await intake().getByRole('list', { name: 'Arquivos do pipeline' }).count()) === 1);
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
console.log('\nAll pipeline intake checks passed.');
