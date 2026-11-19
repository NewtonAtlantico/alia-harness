/**
 * Drives the REAL app (built, in a real Electron) through Playwright, against a fake model server: the page talks to
 * main over IPC, main validates and forwards to the engine process, and a real shell command is started and
 * cancelled. Run from desktop/: `npm run test:app` (builds first). Opens a window for a few seconds.
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alia-app-'));
const project = path.join(tmp, 'project');
const otherFolder = path.join(tmp, 'never-opened');
fs.mkdirSync(project);
fs.mkdirSync(otherFolder);
const dataDir = path.join(tmp, 'data');
const hang = makeHang(tmp);
const pidFile = path.join(tmp, 'hang.pid');

const server = await startFakeServer([
  { content: 'Olá! Pronto.' },
  { toolCalls: [{ name: 'run_bash', args: { command: hang.command(pidFile), timeout_ms: 120000 }, id: 'long1' }] },
  { toolCalls: [{ name: 'write_file', args: { path: 'notas.md', content: '# Notas\nlinha\n' }, id: 'wf1' }] },
  { content: 'Arquivo criado.' },
  { content: 'Voltei depois da queda do motor.' },
]);

const config = { name: 't', vendor: 't', apiKey: 'test-key', apiType: 'chat-completions', models: [{ id: 'fake-model', name: 'fake', url: server.url, toolCalling: true, maxInputTokens: 128000 }] };
const configFile = path.join(tmp, 'alia-config.json');
fs.writeFileSync(configFile, JSON.stringify(config));

const electronBinary: string = createRequire(path.join(desktop, 'package.json'))('electron');
const env = { ...process.env, ALIA_DESKTOP_DATA_DIR: dataDir, ALIA_DESKTOP_TEST: '1', ALIA_TEST_PICK_FOLDER: project, ALIA_CONFIG: configFile } as NodeJS.ProcessEnv;
delete env.ELECTRON_RUN_AS_NODE; // set in VS Code's terminal; with it the binary would behave as plain Node
delete env.ELECTRON_RENDERER_URL;
delete env.ALIA_API_KEY; // a developer's own key must not leak into the test
delete env.OPENAI_API_KEY;

const app: ElectronApplication = await electron.launch({ executablePath: electronBinary, args: ['.'], cwd: desktop, env });
const page: Page = await app.firstWindow();
await page.waitForLoadState('domcontentloaded');

// What the page does: collect everything pushed to it, and call the API.
await page.evaluate(() => {
  const w = window as any;
  w.__msgs = [];
  w.alia.onMessage((m: unknown) => w.__msgs.push(m));
});
const request = (name: string, payload: object = {}) =>
  page.evaluate(([n, p]) => (window as any).alia.request(n, p).then((result: unknown) => ({ ok: true, result }), (err: Error) => ({ ok: false, error: String(err.message) })), [name, payload] as const);
const ok = async (name: string, payload: object = {}): Promise<any> => {
  const r: any = await request(name, payload);
  if (!r.ok) throw new Error(`${name} failed: ${r.error}`);
  return r.result;
};
const messages = (): Promise<any[]> => page.evaluate(() => (window as any).__msgs);
const waitFor = async <T>(fn: () => Promise<T | undefined>, ms = 15000, label = 'condition'): Promise<T> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
};
const finishedRuns = async (sessionId: string) => (await messages()).filter((m) => m.kind === 'event' && m.sessionId === sessionId && m.event.type === 'run_finished').map((m) => m.event);

try {
  console.log('\n=== the page can only use the API it was given ===');
  check('the page has window.alia and no Node', await page.evaluate(() => typeof (window as any).alia?.request === 'function' && typeof (window as any).require === 'undefined' && typeof (window as any).process === 'undefined'));
  const ping: any = await ok('interaction.pending').then(() => page.evaluate(() => (window as any).alia.ping()));
  check('a round trip reaches the engine process, which is not main', ping.pong === true && ping.pid > 0);
  const enginePid: number = ping.pid;

  const bad: any = await request('session.run', { sessionId: 'x', text: 'hi', extra: 1 });
  check('through the real IPC, an unknown field is rejected by main', bad.ok === false && /Unrecognized key/.test(bad.error), JSON.stringify(bad));
  const unknown: any = await request('engine.configure', { config: {} });
  check('an internal request cannot be made from the page', unknown.ok === false && /Unknown request/.test(unknown.error));
  const refused: any = await request('session.open', { projectPath: project });
  check('a folder that was not picked through the dialog is refused', refused.ok === false && /folder dialog/.test(refused.error), JSON.stringify(refused));

  console.log('\n=== opening a project, chatting ===');
  const picked = await ok('projects.pick');
  check('picking a folder returns it and allows it', picked?.path === path.resolve(project));
  const session = await ok('session.open', { projectPath: project });
  check('the session opens, using the configured model', session.model === 'fake-model' && session.workspace === path.resolve(project));

  await ok('session.run', { sessionId: session.sessionId, text: 'oi' });
  const first = await waitFor(async () => (await finishedRuns(session.sessionId))[0], 15000, 'the first run');
  check('events stream to the page, ending with run_finished', first.result.status === 'completed' && first.result.text === 'Olá! Pronto.');
  const kinds = (await messages()).filter((m) => m.kind === 'event').map((m) => m.event.type);
  check('...in order, all tagged with the session', kinds[0] === 'run_started' && kinds.at(-1) === 'run_finished');

  console.log('\n=== a real long command: approve, then Stop ===');
  await ok('session.run', { sessionId: session.sessionId, text: 'start the server' });
  const card: any = await waitFor(async () => (await messages()).find((m) => m.kind === 'interaction'), 15000, 'the permission card');
  check('the page is asked for permission before the command runs', card.interaction.kind === 'permission' && card.interaction.command.includes('hang.js') && card.interaction.canAlwaysAllow === true);
  check('the command has not started yet', !hang.isRunning(pidFile));
  await ok('interaction.respond', { id: card.interaction.id, response: { decision: 'allow_once' } });
  check('after approval it really runs', await hang.started(pidFile));
  const t0 = Date.now();
  check('Stop is accepted', (await ok('session.cancel', { sessionId: session.sessionId })).cancelled === true);
  const second = await waitFor(async () => (await finishedRuns(session.sessionId))[1], 10000, 'the cancelled run');
  const took = Date.now() - t0;
  check('the run ends as cancelled in under two seconds', second.result.status === 'cancelled' && took < 2000, `${took} ms`);
  check('and the command (its whole process tree) is gone', await hang.diesWithin(pidFile, 4000));

  console.log('\n=== changes and Desfazer ===');
  await ok('session.run', { sessionId: session.sessionId, text: 'create the notes' });
  await waitFor(async () => (await finishedRuns(session.sessionId))[2], 15000, 'the third run');
  const changes = await ok('changes.list', { sessionId: session.sessionId });
  check('the file the agent wrote is listed', changes.length === 1 && changes[0].path === 'notas.md' && changes[0].added === 2);
  check('its diff is available on demand', (await ok('changes.diff', { sessionId: session.sessionId, path: 'notas.md' })).diff.includes('+# Notas'));
  await ok('changes.revert', { sessionId: session.sessionId });
  check('Desfazer removes it', !fs.existsSync(path.join(project, 'notas.md')));

  console.log('\n=== the engine crashes ===');
  const before = (await messages()).length;
  await app.evaluate(() => (globalThis as any).__aliaTest.engine.crashForTest());
  await waitFor(async () => (await messages()).slice(before).find((m) => m.kind === 'engine_status' && m.status === 'down'), 10000, 'the "down" notice');
  const back: any = await waitFor(async () => (await messages()).slice(before).find((m) => m.kind === 'engine_status' && m.status === 'restarted'), 20000, 'the "restarted" notice');
  check('the page is told the engine went down and came back', !!back);
  const lost: any = await request('session.usage', { sessionId: session.sessionId });
  check('the old in-memory session is gone, and the error says how to recover', lost.ok === false && /resumeId/.test(lost.error), JSON.stringify(lost));
  const saved = await ok('conversations.list', { projectPath: project });
  check('but the conversation is still saved', saved.length === 1 && saved[0].id === session.sessionId);
  const reopened = await ok('session.open', { projectPath: project, resumeId: session.sessionId });
  check('it reopens from disk with its history', reopened.resumed === true && reopened.messages > 5);
  await ok('session.run', { sessionId: session.sessionId, text: 'ainda aí?' });
  const after = await waitFor(async () => (await finishedRuns(session.sessionId))[3], 15000, 'the run after the restart');
  check('and the conversation carries on (the restarted engine was configured again)', after.result.text === 'Voltei depois da queda do motor.');
  const newPing: any = await page.evaluate(() => (window as any).alia.ping());
  check('the engine is a new process', newPing.pid !== enginePid);

  console.log('\n=== quitting leaves nothing behind ===');
  const livePid: number = newPing.pid;
  await app.close();
  await sleep(1000);
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  check('the engine process is gone after the app closes', !alive(livePid));
} catch (err: any) {
  failures++;
  console.log(`  ✘ ${err?.stack ?? err}`);
  await app.close().catch(() => {});
} finally {
  await server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll desktop app checks passed.');
