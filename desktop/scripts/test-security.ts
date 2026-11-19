/**
 * Unit tests for the hardening rules (backlog 003, 4.3): hostile input against plain functions, no Electron.
 * Run from desktop/: `npm run test:security`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Broker, ProjectRegistry } from '../src/main/broker';
import { Logger, redact } from '../src/main/logger';
import { commandForInput } from '../src/main/shortcuts';
import { commandForInput } from '../src/main/shortcuts';
import { CONTENT_SECURITY_POLICY, isAllowedRequestUrl, isTrustedUrl, parseExternalUrl, resolveAppPath } from '../src/main/securityRules';

let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.log(`  ✘ ${name} ${extra}`);
  }
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alia-sec-'));
const DEV = 'http://localhost:5173/';

console.log('\n=== which pages are the app ===');
{
  check('the packaged origin is trusted', isTrustedUrl('app://alia/index.html') && isTrustedUrl('app://alia/'));
  check('look-alike hosts are not', !isTrustedUrl('app://alia.evil.com/') && !isTrustedUrl('app://evil/') && !isTrustedUrl('app://alia@evil.com/') && !isTrustedUrl('app://user:pw@alia/'));
  check('other schemes are not, however they are spelled', !isTrustedUrl('https://alia/') && !isTrustedUrl('file:///C:/app/index.html') && !isTrustedUrl('javascript:alert(1)') && !isTrustedUrl('data:text/html,<h1>x</h1>') && !isTrustedUrl('about:blank') && !isTrustedUrl('APP2://alia/'));
  check('garbage is not', !isTrustedUrl('') && !isTrustedUrl('not a url') && !isTrustedUrl('//alia'));
  check('the dev server is trusted only when one is configured, and only its exact origin', !isTrustedUrl(DEV) && isTrustedUrl(DEV, DEV) && !isTrustedUrl('http://localhost:5174/', DEV) && !isTrustedUrl('http://localhost:5173.evil.com/', DEV) && !isTrustedUrl('https://localhost:5173/', DEV));
}

console.log('\n=== what the page may request ===');
{
  check('its own origin, and data and blob URLs it made itself', isAllowedRequestUrl('app://alia/assets/a.js') && isAllowedRequestUrl('data:image/png;base64,AAAA') && isAllowedRequestUrl('blob:app://alia/1234'));
  check('nothing on the internet', !isAllowedRequestUrl('https://example.com/x') && !isAllowedRequestUrl('http://example.com/') && !isAllowedRequestUrl('wss://example.com/') && !isAllowedRequestUrl('ftp://example.com/'));
  check('no local files', !isAllowedRequestUrl('file:///C:/Windows/win.ini'));
  check('the dev server and its hot-reload socket only while developing', !isAllowedRequestUrl('ws://localhost:5173/') && isAllowedRequestUrl('ws://localhost:5173/', DEV) && !isAllowedRequestUrl('ws://localhost:9999/', DEV) && isAllowedRequestUrl('http://localhost:5173/src/main.tsx', DEV));
  check('the policy: nothing inline, nothing remote, no connections', CONTENT_SECURITY_POLICY.includes("default-src 'none'") && CONTENT_SECURITY_POLICY.includes("connect-src 'none'") && CONTENT_SECURITY_POLICY.includes("script-src 'self'") && !/unsafe-(inline|eval)/.test(CONTENT_SECURITY_POLICY) && !/https?:|\*/.test(CONTENT_SECURITY_POLICY) && CONTENT_SECURITY_POLICY.includes("frame-src 'none'") && CONTENT_SECURITY_POLICY.includes("object-src 'none'"));
}

console.log('\n=== links that leave the app ===');
{
  const bad = (u: string) => {
    try {
      parseExternalUrl(u);
      return false;
    } catch {
      return true;
    }
  };
  check('https links are fine, in any letter case', parseExternalUrl('https://example.com/a?b=1#c').href === 'https://example.com/a?b=1#c' && parseExternalUrl('HTTPS://EXAMPLE.COM').hostname === 'example.com');
  check('http, file, javascript, data, mailto and the rest are not', ['http://example.com', 'file:///C:/x', 'javascript:alert(1)', 'data:text/html,x', 'mailto:a@b.c', 'ftp://example.com', 'app://alia/', 'ms-msdt:/id', 'vbscript:x', 'chrome://settings'].every(bad));
  check('an address with a user name or password is not (it shows one host and goes to another)', bad('https://bank.com@evil.example/') && bad('https://user:pw@example.com/'));
  check('garbage and empty are not', bad('') && bad('not a url') && bad('https://'));
}

console.log('\n=== files the app protocol serves ===');
{
  const root = path.join(tmp, 'renderer');
  const inside = (p: string | null) => p !== null && !path.relative(root, p).startsWith('..') && !path.isAbsolute(path.relative(root, p));
  check('the root is the index page', resolveAppPath(root, '/') === path.join(root, 'index.html') && resolveAppPath(root, '') === path.join(root, 'index.html'));
  check('a normal file resolves inside the folder', resolveAppPath(root, '/assets/index-abc.js') === path.join(root, 'assets', 'index-abc.js'));
  check('"..", in plain and encoded forms, is refused', resolveAppPath(root, '/../package.json') === null && resolveAppPath(root, '/%2e%2e/package.json') === null && resolveAppPath(root, '/a/../../package.json') === null && resolveAppPath(root, '/assets/%2E%2E/%2E%2E/x') === null);
  check('drive letters and absolute paths are refused', resolveAppPath(root, '/C:/Windows/win.ini') === null && resolveAppPath(root, '/C%3A/Windows/win.ini') === null && resolveAppPath(root, '//C:/x') === null);
  check('a NUL byte and broken encoding are refused', resolveAppPath(root, '/index.html%00.png') === null && resolveAppPath(root, '/%E0%A4%A') === null);
  const tricks = ['/..%5c..%5cpackage.json', '/%252e%252e/x', '/assets/..%2f..%2fx', '/....//x', '/./../x'];
  check('backslashes and double-encoding never escape the folder, whatever the platform makes of them', tricks.every((t) => { const r = resolveAppPath(root, t); return r === null || inside(r); }), tricks.map((t) => `${t}=>${resolveAppPath(root, t)}`).join(' '));
  if (process.platform === 'win32') check('on Windows a backslash is a separator, so it is refused too', resolveAppPath(root, '/..%5c..%5cpackage.json') === null);
}

console.log('\n=== secrets in logs ===');
{
  const key = 'sk-live-ABCDEF1234567890';
  check('a known secret is removed wherever it appears', redact(`calling with ${key} now, again ${key}`, [key]) === 'calling with [redacted] now, again [redacted]');
  check('Bearer tokens and sk- keys are masked even if nobody registered them', redact('Authorization: Bearer abc.def-123_456') .includes('[redacted]') && !redact('Authorization: Bearer abc.def-123_456').includes('abc.def') && !redact('key sk-proj-abcdefgh12345678').includes('abcdefgh'));
  const json = redact('{"apiKey":"abc123456xyz","name":"ok","password":"hunter22"}');
  check('values of keys such as apiKey, password and token are masked in JSON and in key=value text', !json.includes('abc123456xyz') && !json.includes('hunter22') && json.includes('"name":"ok"') && !redact('ALIA_API_KEY=abc123456xyz').includes('abc123456xyz') && !redact('access_token: zzzzzzzz9999').includes('zzzzzzzz9999'));
  check('ordinary text is left alone', redact('the engine restarted after 3 tries, pid 4412') === 'the engine restarted after 3 tries, pid 4412');
  check('a very short "secret" is ignored rather than mangling every log line', redact('a b c abc', ['abc']) === 'a b c abc');

  const dir = path.join(tmp, 'logs');
  const now = new Date('2026-11-18T12:00:00Z');
  fs.mkdirSync(dir);
  const old = path.join(dir, 'main-2026-10-01.log');
  fs.writeFileSync(old, 'old');
  fs.utimesSync(old, new Date('2026-10-01'), new Date('2026-10-01'));
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not ours');
  const log = new Logger(dir, () => now);
  log.addSecret(key);
  log.info(`engine configured with ${key}`);
  log.error(`request failed: Authorization: Bearer abcdef123456\nsecond line ${key}`);
  const written = fs.readFileSync(log.file, 'utf8');
  check('the log file is daily and named by date', path.basename(log.file) === 'main-2026-11-18.log');
  check('what reaches the file has no secret in it', !written.includes(key) && !written.includes('abcdef123456') && written.includes('[redacted]') && written.includes('engine configured with'));
  check('each line has a time and a level, and a multi-line message stays together', /2026-11-18T12:00:00.000Z INFO engine configured/.test(written) && /ERROR request failed[\s\S]*\n {2}second line/.test(written));
  check('files older than two weeks are deleted, other files are left', !fs.existsSync(old) && fs.existsSync(path.join(dir, 'notes.txt')));
  check('a log folder that cannot be created does not stop the app', (() => { try { new Logger(path.join(dir, 'notes.txt', 'sub')).info('x'); return true; } catch { return false; } })());
}

console.log('\n=== shortcuts ===');
{
  const key = (k: string, extra: object = {}) => commandForInput({ type: 'keyDown', key: k, control: true, ...extra });
  check('Ctrl N, O, comma and J (any letter case) are the app commands', key('n') === 'new_conversation' && key('N') === 'new_conversation' && key('o') === 'open_project' && key(',') === 'open_settings' && key('j') === 'toggle_panel');
  check('Cmd works the same (macOS)', commandForInput({ type: 'keyDown', key: 'n', meta: true }) === 'new_conversation');
  check('the key must go down with Ctrl or Cmd, and nothing else', commandForInput({ type: 'keyUp', key: 'n', control: true }) === undefined && commandForInput({ type: 'keyDown', key: 'n' }) === undefined && key('n', { shift: true }) === undefined && key('n', { alt: true }) === undefined);
  check('other keys, including the usual editing ones, are left to the page', ['a', 'c', 'v', 'x', 'z', 'f', 'p', 's', 'w', 'Enter', ' '].every((k) => key(k) === undefined));
}

console.log('\n=== main-handled requests never reach the engine ===');
{
  const calls: string[] = [];
  const engine = { request: async (name: string) => (calls.push(name), {}) } as any;
  const handled: Array<{ name: string; ctx: unknown }> = [];
  const broker = new Broker({
    engine,
    projects: new ProjectRegistry(),
    pickFolder: async () => null,
    main: { 'window.minimize': (_r, ctx) => (handled.push({ name: 'window.minimize', ctx }), { ok: true as const }), 'app.openExternal': async () => ({ opened: false }) },
  });
  const sender = { sender: 'the-ipc-event' };
  check('a window request is answered by main, with the caller passed along', ((await broker.handle('window.minimize', {}, sender)) as any).ok === true && handled[0].ctx === sender && calls.length === 0);
  const noHandler = await broker.handle('window.close', {}).then(() => '', (e) => e.message);
  check('one main should answer but cannot is an error, never forwarded to the engine', noHandler.includes('not available') && calls.length === 0, noHandler);
  check('the link request is validated first: extra fields and an empty address are refused', await broker.handle('app.openExternal', { url: 'https://a.b', extra: 1 }).then(() => '', (e) => e.message).then((m) => m.includes('Unrecognized key')) && await broker.handle('app.openExternal', { url: '' }).then(() => '', (e) => e.message).then((m) => m.includes('url')));
  check('window requests take no fields', await broker.handle('window.minimize', { x: 1 }).then(() => '', (e) => e.message).then((m) => m.includes('Unrecognized key')));
}

fs.rmSync(tmp, { recursive: true, force: true });
if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll security rule checks passed.');
