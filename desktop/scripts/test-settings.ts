/**
 * Unit tests for settings, the encrypted key, importing an earlier configuration, and the service behind the
 * settings screen (A4). No Electron: a fake encryptor and a fake engine stand in. Run from desktop/: `npm run test:settings`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Broker, ProjectRegistry } from '../src/main/broker';
import { buildEngineConfig, findLegacyConfig, readLegacyConfig } from '../src/main/legacyConfig';
import { SecretStore, SecureStorageUnavailableError, type Encryptor } from '../src/main/secrets';
import { MAX_RECENT_PROJECTS, SettingsStore, defaultSettings, normalizeSettings } from '../src/main/settings';
import { SettingsService } from '../src/main/settingsService';

let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.log(`  ✘ ${name} ${extra}`);
  }
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alia-settings-'));
let n = 0;
const mk = (label = 'd') => {
  const dir = path.join(tmp, `${label}-${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const KEY = 'sk-test-VERYSECRETKEY-0123456789';

/** Not real encryption: just enough that the stored bytes differ from the text, and can be told apart. */
function fakeEncryptor(available = true): Encryptor {
  return {
    isAvailable: () => available,
    encrypt: (plain) => Buffer.from('ENC1:' + Buffer.from(plain, 'utf8').map((b) => b ^ 0x5a).toString('base64')),
    decrypt: (data) => {
      const text = data.toString();
      if (!text.startsWith('ENC1:')) throw new Error('not encrypted by this machine');
      return Buffer.from(Buffer.from(text.slice(5), 'base64').map((b) => b ^ 0x5a)).toString('utf8');
    },
  };
}

console.log('\n=== settings file ===');
{
  const dir = mk();
  const file = path.join(dir, 'settings.json');
  const store = new SettingsStore(file, defaultSettings('Newton'));
  check('with no file: defaults, the display name from the account, and not "saved yet"', store.get().displayName === 'Newton' && store.get().permissionMode === 'ask-commands' && store.get().models.length === 0 && !store.exists());
  store.update({ endpointUrl: 'https://chat.example/api/', organization: 'Instituto Atlântico', models: [{ id: 'gpt-oss:20b', name: 'gpt-oss', maxInputTokens: 128000 }], permissionMode: 'ask-dangerous' });
  check('saving writes the file, and what is saved survives a new instance', store.exists() && new SettingsStore(file, defaultSettings('x')).get().organization === 'Instituto Atlântico' && new SettingsStore(file).get().models[0].maxInputTokens === 128000 && new SettingsStore(file).get().permissionMode === 'ask-dangerous');
  check('only the fields given change', (() => { store.update({ displayName: 'Maria' }); const s = store.get(); return s.displayName === 'Maria' && s.endpointUrl === 'https://chat.example/api/' && s.models.length === 1; })());
  check('the file holds no key and leaves no temporary file behind', !fs.readFileSync(file, 'utf8').toLowerCase().includes('apikey') && fs.readdirSync(dir).join() === 'settings.json');

  const n1 = normalizeSettings({ displayName: 42, permissionMode: 'yolo', endpointUrl: 7, models: [{ id: 'a', name: 'A', maxInputTokens: -5, maxOutputTokens: 1.5 }, { id: 'a', name: 'dup' }, { name: 'no id' }, 'junk', null, { id: 'b' }], recentProjects: ['C:/x', 5, 'C:/x', ''] }, defaultSettings('Dflt'));
  check('a wrong field falls back to its default, field by field', n1.displayName === 'Dflt' && n1.permissionMode === 'ask-commands' && n1.endpointUrl === '');
  check('models: duplicates, entries with no id and junk are dropped; a bad number is dropped; a missing name becomes the id', n1.models.length === 2 && n1.models[0].maxInputTokens === undefined && n1.models[0].maxOutputTokens === undefined && n1.models[1].name === 'b');
  check('recent projects: strings only, no repeats', n1.recentProjects.join() === 'C:/x');
  check('a root that is not an object gives defaults', normalizeSettings([1], defaultSettings('D')).displayName === 'D' && normalizeSettings(null, defaultSettings('D')).displayName === 'D');

  fs.writeFileSync(file, '{ broken json');
  const damaged = new SettingsStore(file, defaultSettings('Newton'));
  check('a damaged file does not stop the app: defaults are used and the file is set aside, not deleted', damaged.get().displayName === 'Newton' && fs.readdirSync(dir).some((f) => f.startsWith('settings.json.damaged-')));
}

console.log('\n=== recent projects ===');
{
  const dir = mk();
  const store = new SettingsStore(path.join(dir, 'settings.json'));
  const a = mk('proj');
  const b = mk('proj');
  store.rememberProject(a);
  store.rememberProject(b);
  store.rememberProject(a);
  check('newest first, each folder once', store.get().recentProjects.join('|') === [a, b].join('|'));
  if (process.platform === 'win32') {
    store.rememberProject(b.toUpperCase());
    check('on Windows the same folder in another letter case is the same folder', store.get().recentProjects.length === 2);
  }
  fs.rmSync(b, { recursive: true });
  check('folders that no longer exist are not offered', store.recentProjects().join() === a);
  for (let i = 0; i < MAX_RECENT_PROJECTS + 5; i++) store.rememberProject(path.join(dir, `p${i}`));
  check(`the list is capped at ${MAX_RECENT_PROJECTS}`, store.get().recentProjects.length === MAX_RECENT_PROJECTS);
}

console.log('\n=== the API key ===');
{
  const dir = mk();
  const file = path.join(dir, 'credentials.bin');
  const secrets = new SecretStore(file, fakeEncryptor());
  check('nothing stored yet', !secrets.has() && secrets.get() === undefined && secrets.available);
  secrets.set(KEY);
  check('the key round-trips', secrets.get() === KEY && secrets.has());
  const raw = fs.readFileSync(file);
  check('the file on disk does not contain the key, in text or base64', !raw.toString('latin1').includes(KEY) && !raw.toString('latin1').includes(Buffer.from(KEY).toString('base64')) && !raw.toString('latin1').includes('VERYSECRET'));
  check('no temporary file is left', fs.readdirSync(dir).join() === 'credentials.bin');
  secrets.set('sk-second-KEY-9999999');
  check('setting again replaces it', secrets.get() === 'sk-second-KEY-9999999');
  secrets.clear();
  check('clear removes it, and clearing again is fine', !secrets.has() && !fs.existsSync(file) && (secrets.clear(), true));
  fs.writeFileSync(file, 'plain text, not encrypted');
  check('a file that cannot be decrypted (another user or machine) reads as no key', secrets.get() === undefined);

  const noOs = new SecretStore(path.join(dir, 'x.bin'), fakeEncryptor(false));
  let err: unknown;
  try {
    noOs.set(KEY);
  } catch (e) {
    err = e;
  }
  check('when the OS cannot encrypt, nothing is stored: there is no plain-text fallback', err instanceof SecureStorageUnavailableError && !fs.existsSync(path.join(dir, 'x.bin')) && !noOs.available);
}

console.log('\n=== an earlier configuration (alia-config.json) ===');
{
  const dir = mk('legacy');
  const cfg = path.join(dir, 'alia-config.json');
  const write = (o: object) => fs.writeFileSync(cfg, JSON.stringify(o));
  write({ name: 'q', vendor: 'v', apiKey: '', apiType: 'chat-completions', models: [{ id: 'gpt-oss:20b', name: 'gpt-oss', url: 'https://chat.example/api/', toolCalling: true, vision: true, maxInputTokens: 128000, maxOutputTokens: 16000 }, { id: 'second', url: 'https://chat.example/api/' }, { name: 'no id', url: 'x' }] });
  const c = readLegacyConfig(cfg, {});
  check('models and the endpoint come across (an entry with no id is skipped, a missing name becomes the id)', c.endpointUrl === 'https://chat.example/api/' && c.models.length === 2 && c.models[0].maxInputTokens === 128000 && c.models[0].vision === true && c.models[1].name === 'second' && c.apiKey === undefined);
  fs.writeFileSync(path.join(dir, '.env'), '# comment\nALIA_API_KEY="from-dotenv-1234567"\n');
  check('the key comes from a .env beside it', readLegacyConfig(cfg, {}).apiKey === 'from-dotenv-1234567');
  check('...but the environment wins', readLegacyConfig(cfg, { ALIA_API_KEY: 'from-env-7654321' }).apiKey === 'from-env-7654321');
  fs.rmSync(path.join(dir, '.env'));
  write({ apiKey: 'inline-key-12345', models: [{ id: 'm', url: 'https://e/' }] });
  check('a key written inside the file is used last', readLegacyConfig(cfg, {}).apiKey === 'inline-key-12345');
  write({ models: [] });
  check('a file with no usable models is refused with a reason', (() => { try { readLegacyConfig(cfg, {}); return false; } catch (e: any) { return e.message.includes('no models'); } })());
  fs.writeFileSync(cfg, 'not json');
  check('a file that is not JSON is refused, naming the file', (() => { try { readLegacyConfig(cfg, {}); return false; } catch (e: any) { return e.message.includes('alia-config.json'); } })());

  const sub = path.join(dir, 'sub');
  fs.mkdirSync(sub);
  write({ models: [{ id: 'm', url: 'https://e/' }] });
  check('the file is found in a folder or its parent', findLegacyConfig([sub], {}) === cfg && findLegacyConfig([dir], {}) === cfg && findLegacyConfig([mk()], {}) === undefined);
  check('ALIA_CONFIG, when set, comes first', findLegacyConfig([dir], { ALIA_CONFIG: cfg }) === cfg);

  const built = buildEngineConfig({ endpointUrl: 'https://e/api/', models: [{ id: 'a', name: 'A', maxInputTokens: 1000 }, { id: 'b', name: 'B', toolCalling: false, vision: true }] }, KEY);
  check('the engine config applies the endpoint to every model, with sensible defaults', built.apiKey === KEY && built.models.every((m) => m.url === 'https://e/api/') && built.models[0].toolCalling === true && built.models[1].toolCalling === false && built.models[1].vision === true && built.models[0].maxInputTokens === 1000 && built.apiType === 'chat-completions');
}

console.log('\n=== the service behind the settings screen ===');
{
  const calls: Array<{ name: string; payload: any }> = [];
  const seenSecrets: string[] = [];
  const mkService = (opts: { encryptor?: Encryptor; env?: NodeJS.ProcessEnv; legacyFolders?: string[]; pick?: string | null } = {}) => {
    const dir = mk('svc');
    const store = new SettingsStore(path.join(dir, 'settings.json'), defaultSettings('Newton'));
    const secrets = new SecretStore(path.join(dir, 'credentials.bin'), opts.encryptor ?? fakeEncryptor());
    calls.length = 0;
    const service = new SettingsService({
      store,
      secrets,
      engine: { request: async (name: any, payload: any) => (calls.push({ name, payload }), (name === 'connection.test' ? { ok: true, models: ['m1', 'm2'] } : { ok: true, models: 1 })) as any },
      legacyFolders: opts.legacyFolders ?? [],
      pickLegacyFile: async () => opts.pick ?? null,
      bundledSkillsDir: path.join(dir, 'skills'),
      userSkillsDir: path.join(dir, 'user-skills'),
      env: opts.env ?? {},
      onSecret: (s) => seenSecrets.push(s),
    });
    return { service, store, secrets, dir };
  };

  const a = mkService();
  const v0 = a.service.view();
  check('a fresh install is not configured, offers no key, and says secure storage is available', !v0.configured && !v0.hasApiKey && v0.secureStorage && v0.displayName === 'Newton' && v0.permissionMode === 'ask-commands');
  check('with nothing to configure the engine is not asked to', (await a.service.configureEngine()) === false && calls.length === 0);

  await a.service.update({ endpointUrl: 'https://chat.example/api/', models: [{ id: 'gpt-oss:20b', name: 'gpt-oss', maxInputTokens: 128000 }] });
  check('an endpoint and models are not enough: the key is missing', !a.service.view().configured && calls.length === 0);
  const v1 = await a.service.setApiKey(KEY);
  check('with the key the engine is configured, with models, the key, the skill folders and the approval mode', v1.configured && calls.length === 1 && calls[0].name === 'engine.configure' && calls[0].payload.config.apiKey === KEY && calls[0].payload.config.models[0].url === 'https://chat.example/api/' && calls[0].payload.skillRoots.length === 2 && calls[0].payload.permissionMode === 'ask-commands');
  check('nothing the page can receive contains the key', !JSON.stringify(v1).includes(KEY) && !('apiKey' in v1) && !JSON.stringify(a.service.view()).includes('VERYSECRET'));
  check('the log is told about the key so it can mask it', seenSecrets.includes(KEY));
  check('on disk the key is only in the encrypted file', !fs.readFileSync(a.store.file, 'utf8').includes('VERYSECRET') && !fs.readFileSync(path.join(a.dir, 'credentials.bin')).toString('latin1').includes('VERYSECRET'));

  await a.service.update({ permissionMode: 'auto' });
  check('changing the approval mode reconfigures the engine', calls.at(-1)!.payload.permissionMode === 'auto');
  const before = calls.length;
  const dup = await a.service.update({ models: [{ id: 'x', name: 'one' }, { id: 'x', name: 'two' }] }).then(() => '', (e) => e.message);
  check('two models with the same id are refused before anything is saved', dup.includes('same id') && a.service.view().models[0].id === 'gpt-oss:20b' && calls.length === before);

  const cleared = await a.service.clearApiKey();
  check('removing the key leaves the app unconfigured', !cleared.hasApiKey && !cleared.configured);

  const noOs = mkService({ encryptor: fakeEncryptor(false) });
  check('without OS encryption the screen can say so, and the key is refused', noOs.service.view().secureStorage === false && (await noOs.service.setApiKey(KEY).then(() => '', (e) => e.constructor.name)) === 'SecureStorageUnavailableError' && !noOs.service.view().hasApiKey);

  // Testing a connection
  const t = mkService();
  check('testing with no key is refused without calling the endpoint', (await t.service.testConnection({ endpointUrl: 'https://e/' })).reason === 'unauthorized' && calls.length === 0);
  const res = await t.service.testConnection({ endpointUrl: 'https://e/api/', apiKey: KEY });
  check('testing with what is typed in the form asks the engine to list models, and returns them', res.ok && res.models.join() === 'm1,m2' && calls[0].name === 'connection.test' && calls[0].payload.url === 'https://e/api/' && calls[0].payload.apiKey === KEY);
  await t.service.update({ endpointUrl: 'https://saved/api/', models: [{ id: 'm', name: 'm' }] });
  await t.service.setApiKey('saved-key-1234567');
  calls.length = 0;
  await t.service.testConnection({});
  check('testing with nothing typed uses the saved address and key', calls[0].payload.url === 'https://saved/api/' && calls[0].payload.apiKey === 'saved-key-1234567');

  // Importing
  const legacyDir = mk('legacy');
  const legacyFile = path.join(legacyDir, 'alia-config.json');
  fs.writeFileSync(legacyFile, JSON.stringify({ models: [{ id: 'gpt-oss:20b', name: 'gpt-oss', url: 'https://old.example/api/', maxInputTokens: 128000 }] }));
  fs.writeFileSync(path.join(legacyDir, '.env'), 'ALIA_API_KEY=legacy-key-123456789\n');
  const i = mkService({ legacyFolders: [legacyDir], pick: legacyFile });
  const cand = i.service.legacyCandidate();
  check('an earlier configuration is offered, with what it holds and whether it has a key (never the key)', cand?.path === legacyFile && cand.models === 1 && cand.hasApiKey === true && cand.endpointUrl === 'https://old.example/api/' && !JSON.stringify(cand).includes('legacy-key'));
  const summary = await i.service.importLegacy();
  check('importing takes the endpoint, models and key, and configures the engine', summary?.models === 1 && summary.importedKey === true && i.service.view().configured && i.service.view().endpointUrl === 'https://old.example/api/' && calls.at(-1)!.payload.config.apiKey === 'legacy-key-123456789');
  check('the imported key is encrypted like any other', !fs.readFileSync(path.join(i.dir, 'credentials.bin')).toString('latin1').includes('legacy-key'));
  check('nothing to offer when there is no earlier file', mkService({ legacyFolders: [mk()] }).service.legacyCandidate() === null);
  check('cancelling the file dialog imports nothing', (await mkService({ legacyFolders: [legacyDir], pick: null }).service.importLegacy()) === null);
  const bad = mkService({ pick: path.join(mk(), 'nope.json') });
  check('a file that cannot be read is an error and changes nothing', (await bad.service.importLegacy().then(() => '', (e) => e.message)).includes('nope.json') && !bad.service.view().configured && !bad.store.exists());

  // First run
  const seed = mkService({ env: { ALIA_CONFIG: legacyFile } });
  check('first run with ALIA_CONFIG set (by whoever launched the app) takes that configuration', (await seed.service.seedFromEnvironment()) === true && seed.service.view().configured);
  check('...but only once: later changes are not overwritten', (await seed.service.update({ endpointUrl: 'https://mine/' }), (await seed.service.seedFromEnvironment()) === false && seed.service.view().endpointUrl === 'https://mine/'));
  check('without ALIA_CONFIG nothing is imported behind the user\'s back', (await mkService({ legacyFolders: [legacyDir] }).service.seedFromEnvironment()) === false);
  check('a broken ALIA_CONFIG does not stop the app', (await mkService({ env: { ALIA_CONFIG: path.join(mk(), 'missing.json') } }).service.seedFromEnvironment()) === false);
}

console.log('\n=== the broker knows every main request ===');
{
  const calls: string[] = [];
  const projects = new ProjectRegistry();
  const broker = new Broker({ engine: { request: async (name: any) => (calls.push(name), {}) } as any, projects, pickFolder: async () => null, main: { 'settings.get': () => ({ ok: 1 }) as any } });
  check('a settings request main has no handler for is never forwarded to the engine', (await broker.handle('settings.clearApiKey', {}).then(() => '', (e) => e.message)).includes('not available') && calls.length === 0);
  check('the settings handler gets validated input only', (await broker.handle('settings.update', { endpointUrl: 'ftp://x' }).then(() => '', (e) => e.message)).includes('endpointUrl') && (await broker.handle('settings.update', { endpointUrl: 'https://u:p@x/' }).then(() => '', (e) => e.message)).includes('endpointUrl'));
  check('...extra fields, an API key that is too short, an empty model list and a bad mode are refused', (await broker.handle('settings.update', { extra: 1 }).then(() => '', (e) => e.message)).includes('Unrecognized') && (await broker.handle('settings.setApiKey', { apiKey: 'abc' }).then(() => '', (e) => e.message)).includes('short') && (await broker.handle('settings.update', { models: [] }).then(() => '', (e) => e.message)).includes('model') && (await broker.handle('settings.update', { permissionMode: 'yolo' }).then(() => '', (e) => e.message)).includes('permissionMode'));
  check('a model with a field nobody declared is refused', (await broker.handle('settings.update', { models: [{ id: 'a', name: 'a', apiKey: 'sneaky' }] }).then(() => '', (e) => e.message)).includes('Unrecognized'));
  check('the project allowlist requests for a folder the user never opened are refused', (await broker.handle('permissions.listForProject', { projectPath: tmp }).then(() => '', (e) => e.message)).includes('folder dialog') && (await broker.handle('permissions.removeForProject', { projectPath: tmp, command: 'x' }).then(() => '', (e) => e.message)).includes('folder dialog') && calls.length === 0);
  projects.allow(tmp);
  check('...and reach the engine once it was opened', (await broker.handle('permissions.listForProject', { projectPath: tmp }), calls.includes('permissions.listForProject')));
}

fs.rmSync(tmp, { recursive: true, force: true });
if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll settings checks passed.');
