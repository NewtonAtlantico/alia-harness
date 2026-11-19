/**
 * The security checklist (backlog 003, 4.3) and the shell (A3), proven against the REAL built app: the page tries to
 * navigate, open windows, use Node, load remote code and so on, and fails. Run from desktop/: `npm run test:hardening`
 * (builds first). Opens a window for a few seconds.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
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

const SECRET = 'sk-test-SECRETVALUE-1234567890';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alia-hard-'));
const dataDir = path.join(tmp, 'data');
const configFile = path.join(tmp, 'alia-config.json');
fs.writeFileSync(configFile, JSON.stringify({ name: 't', vendor: 't', apiKey: SECRET, apiType: 'chat-completions', models: [{ id: 'm', name: 'm', url: 'http://127.0.0.1:9/', toolCalling: true }] }));

const electronBinary: string = createRequire(path.join(desktop, 'package.json'))('electron');
const env = { ...process.env, ALIA_DESKTOP_DATA_DIR: dataDir, ALIA_DESKTOP_TEST: '1', ALIA_CONFIG: configFile } as NodeJS.ProcessEnv;
delete env.ELECTRON_RUN_AS_NODE; // set in VS Code's terminal; with it the binary would behave as plain Node
delete env.ELECTRON_RENDERER_URL;

const app: ElectronApplication = await electron.launch({ executablePath: electronBinary, args: ['.'], cwd: desktop, env });
const page: Page = await app.firstWindow();
await page.waitForLoadState('domcontentloaded');
await page.waitForSelector('.titlebar');
await page.evaluate(() => {
  const w = window as any;
  w.__msgs = [];
  w.alia.onMessage((m: unknown) => w.__msgs.push(m));
});

const windowCount = () => app.windows().length;
const inPage = <T>(fn: () => T | Promise<T>): Promise<T> => page.evaluate(fn);
const request = (name: string, payload: object = {}) =>
  page.evaluate(([n, p]) => (window as any).alia.request(n, p).then((result: unknown) => ({ ok: true, result }), (err: Error) => ({ ok: false, error: String(err.message) })), [name, payload] as const) as Promise<any>;
const pushed = (): Promise<any[]> => page.evaluate(() => (window as any).__msgs);

try {
  console.log('\n=== the window ===');
  const prefs = await app.evaluate(({ BrowserWindow }) => {
    const p = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences()!;
    return { contextIsolation: p.contextIsolation, nodeIntegration: p.nodeIntegration, sandbox: p.sandbox, webviewTag: p.webviewTag, webSecurity: p.webSecurity, insecure: p.allowRunningInsecureContent };
  });
  check('contextIsolation on, nodeIntegration off, sandbox on, no webview, web security on', prefs.contextIsolation === true && prefs.nodeIntegration === false && prefs.sandbox === true && !prefs.webviewTag && prefs.webSecurity === true && !prefs.insecure, JSON.stringify(prefs));
  check('the page is served from the app\'s own origin, not from a file', (await inPage(() => location.href)).startsWith('app://alia/'));
  check('there is no native frame (the app draws its own title bar)', await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; return w.getBounds().height === w.getContentBounds().height; }));

  console.log('\n=== the page has no Node ===');
  const node = await inPage(async () => {
    const w = window as any;
    let importFs = 'loaded';
    try {
      await import(/* @vite-ignore */ 'node:fs' as string);
    } catch {
      importFs = 'blocked';
    }
    let evalResult = 'ran';
    try {
      // eslint-disable-next-line no-eval
      (0, eval)('1+1');
    } catch {
      evalResult = 'blocked';
    }
    let fnResult = 'ran';
    try {
      new Function('return 1')();
    } catch {
      fnResult = 'blocked';
    }
    return { require: typeof w.require, process: typeof w.process, module: typeof w.module, buffer: typeof w.Buffer, electron: typeof w.electron, dirname: typeof w.__dirname, importFs, evalResult, fnResult, keys: Object.keys(w.alia).sort() };
  });
  check('require, process, module, Buffer, __dirname and electron do not exist', node.require === 'undefined' && node.process === 'undefined' && node.module === 'undefined' && node.buffer === 'undefined' && node.dirname === 'undefined' && node.electron === 'undefined', JSON.stringify(node));
  check('importing a Node module fails', node.importFs === 'blocked');
  check('eval and new Function are refused by the policy', node.evalResult === 'blocked' && node.fnResult === 'blocked');
  check('window.alia offers only request, onMessage and ping', node.keys.join() === 'onMessage,ping,request', node.keys.join());

  console.log('\n=== the policy blocks remote and inline content ===');
  const csp = await inPage(async () => {
    const out: Record<string, unknown> = {};
    const s = document.createElement('script');
    s.textContent = 'window.__injected = true';
    document.body.appendChild(s);
    out.inlineScript = (window as any).__injected === true;
    out.remoteScript = await new Promise((resolve) => {
      const r = document.createElement('script');
      r.src = 'https://example.com/x.js';
      r.onerror = () => resolve('blocked');
      r.onload = () => resolve('loaded');
      document.body.appendChild(r);
      setTimeout(() => resolve('no answer'), 4000);
    });
    out.fetchRemote = await fetch('https://example.com/').then(() => 'allowed', () => 'blocked');
    out.fetchOwn = await fetch('app://alia/index.html').then(() => 'allowed', () => 'blocked');
    out.xhr = await new Promise((resolve) => { const x = new XMLHttpRequest(); x.onerror = () => resolve('blocked'); x.onload = () => resolve('allowed'); try { x.open('GET', 'https://example.com/'); x.send(); } catch { resolve('blocked'); } });
    out.image = await new Promise((resolve) => { const i = new Image(); i.onerror = () => resolve('blocked'); i.onload = () => resolve('loaded'); i.src = 'https://example.com/a.png'; setTimeout(() => resolve('no answer'), 4000); });
    const before = getComputedStyle(document.body).backgroundColor;
    const st = document.createElement('style');
    st.textContent = 'body{background:rgb(255,0,0) !important}';
    document.head.appendChild(st);
    out.inlineStyle = getComputedStyle(document.body).backgroundColor !== before;
    out.websocket = await new Promise((resolve) => { try { const ws = new WebSocket('wss://example.com/'); ws.onerror = () => resolve('blocked'); ws.onopen = () => resolve('allowed'); setTimeout(() => resolve('no answer'), 4000); } catch { resolve('blocked'); } });
    const frame = document.createElement('iframe');
    frame.src = 'app://alia/index.html';
    document.body.appendChild(frame);
    await new Promise((r) => setTimeout(r, 500));
    out.iframeLoaded = !!(frame.contentDocument && frame.contentDocument.body && frame.contentDocument.body.children.length > 0);
    return out;
  });
  check('an inline script does not run', csp.inlineScript === false);
  check('a script from the internet does not load', csp.remoteScript === 'blocked', String(csp.remoteScript));
  check('the page cannot make network requests of its own (fetch, XHR, WebSocket), not even to itself', csp.fetchRemote === 'blocked' && csp.fetchOwn === 'blocked' && csp.xhr === 'blocked' && csp.websocket === 'blocked', JSON.stringify(csp));
  check('an image from the internet does not load', csp.image === 'blocked', String(csp.image));
  check('an injected <style> has no effect', csp.inlineStyle === false);
  check('a frame cannot be embedded', csp.iframeLoaded === false);

  const headers = await app.evaluate(async ({ net }) => {
    // (Anonymous arrows only: a named helper would be serialized with a build-tool shim the app does not have.)
    const ok = await net.fetch('app://alia/index.html');
    return {
      status: ok.status,
      csp: ok.headers.get('content-security-policy'),
      nosniff: ok.headers.get('x-content-type-options'),
      up: await net.fetch('app://alia/%2e%2e/package.json').then((r) => r.status, () => 'blocked'),
      up2: await net.fetch('app://alia/..%5c..%5cpackage.json').then((r) => r.status, () => 'blocked'),
      other: await net.fetch('app://evil/index.html').then((r) => r.status, () => 'blocked'),
    };
  });
  check('every page the protocol serves carries the policy header', headers.status === 200 && !!headers.csp?.includes("default-src 'none'") && headers.nosniff === 'nosniff', JSON.stringify(headers));
  check('the protocol will not serve files outside the app, and other hosts are refused', headers.up !== 200 && headers.up2 !== 200 && (headers.other === 404 || headers.other === 'blocked'), JSON.stringify(headers));

  console.log('\n=== navigation and new windows ===');
  await inPage(() => { location.href = 'https://example.com/'; });
  await sleep(800);
  await inPage(() => { location.href = 'file:///C:/Windows/win.ini'; });
  await sleep(500);
  await inPage(() => { location.href = 'app://alia/index.html?other=1'; });
  await sleep(500);
  check('setting location to a remote, a local file, or even another page of the app goes nowhere', (await inPage(() => location.href)) === 'app://alia/index.html' && windowCount() === 1);
  const opened = await inPage(() => ({ https: window.open('https://example.com/a'), http: window.open('http://example.com/'), js: window.open('javascript:alert(1)'), file: window.open('file:///C:/Windows/win.ini'), blank: window.open('about:blank') }));
  await sleep(800);
  check('window.open never gives the page a window', Object.values(opened).every((v) => v === null) && windowCount() === 1, JSON.stringify(opened));
  await inPage(() => { const a = document.createElement('a'); a.href = 'https://example.org/linked'; a.target = '_blank'; document.body.appendChild(a); a.click(); });
  await sleep(500);
  const links: string[] = await app.evaluate(() => (globalThis as any).__aliaTest.openedLinks);
  check('only https links reach the system browser, and only through the confirmation step (recorded here instead of opened)', links.includes('https://example.com/a') && links.includes('https://example.org/linked') && !links.some((l) => !l.startsWith('https:')), JSON.stringify(links));
  check('still one window', windowCount() === 1);

  const ok = await request('app.openExternal', { url: 'https://example.net/docs' });
  const http = await request('app.openExternal', { url: 'http://example.net/' });
  const creds = await request('app.openExternal', { url: 'https://bank.com@evil.example/' });
  const js = await request('app.openExternal', { url: 'javascript:alert(1)' });
  check('app.openExternal accepts https, and refuses http, user:pass@ and javascript:', ok.ok === true && ok.result.opened === true && http.ok === false && creds.ok === false && js.ok === false, JSON.stringify({ ok, http, creds, js }));

  console.log('\n=== permissions and devices ===');
  const perms = await inPage(async () => {
    const geo = await new Promise((resolve) => navigator.geolocation.getCurrentPosition(() => resolve('granted'), (e) => resolve(`denied:${e.code}`), { timeout: 3000 }));
    const media = await navigator.mediaDevices.getUserMedia({ audio: true, video: true }).then(() => 'granted', (e) => `denied:${e.name}`);
    const notif = typeof Notification === 'undefined' ? 'none' : await Notification.requestPermission();
    return { geo, media, notif };
  });
  check('location, camera and microphone are denied, notifications are not granted', perms.geo === 'denied:1' && String(perms.media).startsWith('denied') && perms.notif !== 'granted', JSON.stringify(perms));

  console.log('\n=== the shell: title bar, menu, shortcuts ===');
  check('the title bar shows the version, from the app', (await page.textContent('.titlebar-version')) === 'Harness v1.0.0');
  const regions = await inPage(() => ({ bar: getComputedStyle(document.querySelector('.titlebar')!).getPropertyValue('-webkit-app-region'), button: getComputedStyle(document.querySelector('.titlebar-controls button')!).getPropertyValue('-webkit-app-region') }));
  check('the bar drags the window and its buttons do not', regions.bar === 'drag' && regions.button === 'no-drag', JSON.stringify(regions));
  const labels = await page.$$eval('.titlebar-controls button', (b) => b.map((x) => x.getAttribute('aria-label')));
  check('the three buttons have names for screen readers (from the string catalog)', labels.join() === 'Minimizar,Maximizar,Fechar', labels.join());
  const isMax = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized());
  await page.dispatchEvent('button[aria-label="Maximizar"]', 'click');
  await sleep(600);
  check('Maximizar maximizes the window, and the button becomes Restaurar', (await isMax()) === true && (await page.locator('button[aria-label="Restaurar"]').count()) === 1);
  await page.dispatchEvent('button[aria-label="Restaurar"]', 'click');
  await sleep(600);
  check('Restaurar brings it back', (await isMax()) === false && (await page.locator('button[aria-label="Maximizar"]').count()) === 1);
  await page.dispatchEvent('button[aria-label="Minimizar"]', 'click');
  await sleep(600);
  check('Minimizar minimizes it', await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized()));
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.restore(); w.focus(); });
  await sleep(400);

  const items = await app.evaluate(({ Menu }) => Object.fromEntries(['new-conversation', 'open-project', 'open-settings', 'toggle-panel', 'quit'].map((id) => [id, Menu.getApplicationMenu()?.getMenuItemById(id)?.accelerator ?? null])));
  check('the menu defines the shortcuts (Ctrl N, O, comma, J, Q)', items['new-conversation'] === 'CmdOrCtrl+N' && items['open-project'] === 'CmdOrCtrl+O' && items['open-settings'] === 'CmdOrCtrl+,' && items['toggle-panel'] === 'CmdOrCtrl+J' && items.quit === 'CmdOrCtrl+Q', JSON.stringify(items));
  const received: string[] = [];
  const commandsSince = async (from: number) => (await pushed()).slice(from).filter((m) => m.kind === 'command').map((m) => m.command as string);
  for (const [keys, wanted] of [['Control+N', 'new_conversation'], ['Control+O', 'open_project'], ['Control+,', 'open_settings'], ['Control+J', 'toggle_panel']] as const) {
    const from = (await pushed()).length;
    await page.keyboard.press(keys);
    await sleep(400);
    let got = await commandsSince(from);
    let how = 'key press';
    if (got.length === 0) {
      // Not every synthetic key press reaches the browser process; send the same input event from main.
      const [mod, key] = keys.split('+');
      await app.evaluate(({ BrowserWindow }, [k, m]) => BrowserWindow.getAllWindows()[0].webContents.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers: [m as 'control'] }), [key, mod.toLowerCase()] as const);
      await sleep(400);
      got = await commandsSince(from);
      how = 'input event sent from main';
    }
    received.push(`${keys}=>${got.join('|') || 'nothing'} (${how})`);
    check(`${keys} reaches the page as "${wanted}", once`, got.length === 1 && got[0] === wanted, received.at(-1));
  }
  console.log(`    ${received.join('; ')}`);
  const menuFrom = (await pushed()).length;
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('open-settings')?.click());
  await sleep(300);
  check('the menu items do the same when clicked', (await commandsSince(menuFrom)).join() === 'open_settings');

  console.log('\n=== one instance at a time, and logs without secrets ===');
  const second = spawn(electronBinary, ['.'], { cwd: desktop, env, stdio: 'ignore' });
  const exitCode: number | null = await new Promise((resolve) => {
    const t = setTimeout(() => { second.kill(); resolve(null); }, 20000);
    second.on('exit', (c) => { clearTimeout(t); resolve(c); });
  });
  await sleep(500);
  check('a second copy exits at once, and the first keeps its single window', exitCode === 0 && windowCount() === 1, `exit ${exitCode}, windows ${windowCount()}`);

  await app.evaluate(() => (globalThis as any).__aliaTest.log.error('boom: key sk-test-SECRETVALUE-1234567890 and Authorization: Bearer abcdefgh12345678'));
  const logDir = path.join(dataDir, 'user-data', 'logs');
  const logs = fs.readdirSync(logDir).map((f) => fs.readFileSync(path.join(logDir, f), 'utf8')).join('\n');
  check('the log records the start, the second instance and the engine, in the app data folder', logs.includes('starting alia Harness') && logs.includes('a second instance was started') && logs.includes('engine configured'), logs.slice(0, 400));
  check('the API key and tokens are not in the log', !logs.includes(SECRET) && !logs.includes('abcdefgh12345678') && logs.includes('[redacted]'));
  const everything = fs
    .readdirSync(dataDir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => {
      const file = path.join(e.parentPath, e.name);
      try {
        return fs.readFileSync(file, 'utf8').includes(SECRET) ? file : '';
      } catch {
        return ''; // a file Chromium holds open (its own databases); it never holds our key
      }
    })
    .filter(Boolean);
  check('the API key is not written anywhere in the app data folder', everything.length === 0, everything.join(', '));

  console.log('\n=== closing ===');
  const closed = app.waitForEvent('close', { timeout: 15000 }).then(() => true, () => false);
  await page.dispatchEvent('button[aria-label="Fechar"]', 'click');
  check('the close button ends the app', await closed);
} catch (err: any) {
  failures++;
  console.log(`  ✘ ${err?.stack ?? err}`);
  await app.close().catch(() => {});
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll hardening checks passed.');
