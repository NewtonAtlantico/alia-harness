/**
 * Unit tests for settings, the encrypted key, the models loaded from the service, and the service behind the
 * settings screen (A4). No Electron: a fake encryptor and a fake engine stand in. Run from desktop/: `npm run test:settings`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Broker, ProjectRegistry } from '../src/main/broker';
import { ALIA_ENDPOINT, resolveEndpoint } from '../src/main/endpoint';
import { buildEngineConfig, readLegacyConfig } from '../src/main/legacyConfig';
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
  store.update({ organization: 'Instituto Atlântico', models: [{ id: 'gpt-oss:20b', name: 'gpt-oss', maxInputTokens: 128000 }], permissionMode: 'ask-dangerous' });
  check('saving writes the file, and what is saved survives a new instance', store.exists() && new SettingsStore(file, defaultSettings('x')).get().organization === 'Instituto Atlântico' && new SettingsStore(file).get().models[0].maxInputTokens === 128000 && new SettingsStore(file).get().permissionMode === 'ask-dangerous');
  check('only the fields given change', (() => { store.update({ displayName: 'Maria' }); const s = store.get(); return s.displayName === 'Maria' && s.organization === 'Instituto Atlântico' && s.models.length === 1; })());
  check('the file holds no key and leaves no temporary file behind', !fs.readFileSync(file, 'utf8').toLowerCase().includes('apikey') && fs.readdirSync(dir).join() === 'settings.json');

  const n1 = normalizeSettings({ displayName: 42, permissionMode: 'yolo', models: [{ id: 'a', name: 'A', maxInputTokens: -5, maxOutputTokens: 1.5 }, { id: 'a', name: 'dup' }, { name: 'no id' }, 'junk', null, { id: 'b' }], recentProjects: ['C:/x', 5, 'C:/x', ''] }, defaultSettings('Dflt'));
  check('a wrong field falls back to its default, field by field', n1.displayName === 'Dflt' && n1.permissionMode === 'ask-commands');
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

console.log('\n=== the fixed address, and the file that seeds the tests (alia-config.json) ===');
{
  check('the address is fixed, and is the Alia chat service', ALIA_ENDPOINT === 'https://chat.alia.atlantico.com.br/api/');
  check('outside tests nothing can change it: not ALIA_TEST_ENDPOINT, not ALIA_CONFIG', resolveEndpoint({ ALIA_TEST_ENDPOINT: 'http://127.0.0.1:1/', ALIA_CONFIG: 'x.json' }, false) === ALIA_ENDPOINT);
  const dir = mk('legacy');
  const cfg = path.join(dir, 'alia-config.json');
  const write = (o: object) => fs.writeFileSync(cfg, JSON.stringify(o));
  write({ name: 'q', vendor: 'v', apiKey: '', apiType: 'chat-completions', models: [{ id: 'gpt-oss:20b', name: 'gpt-oss', url: 'https://chat.example/api/', toolCalling: true, vision: true, maxInputTokens: 128000, maxOutputTokens: 16000 }, { id: 'second', url: 'https://chat.example/api/' }, { name: 'no id', url: 'x' }] });
  const c = readLegacyConfig(cfg, {});
  check('models and the endpoint come across (an entry with no id is skipped, a missing name becomes the id)', c.endpointUrl === 'https://chat.example/api/' && c.models.length === 2 && c.models[0].maxInputTokens === 128000 && c.models[0].vision === true && c.models[1].name === 'second' && c.apiKey === undefined);
  check('under test the address comes from ALIA_TEST_ENDPOINT first, then from ALIA_CONFIG, then the fixed one', resolveEndpoint({ ALIA_TEST_ENDPOINT: 'http://127.0.0.1:9/', ALIA_CONFIG: cfg }, true) === 'http://127.0.0.1:9/' && resolveEndpoint({ ALIA_CONFIG: cfg }, true) === 'https://chat.example/api/' && resolveEndpoint({ ALIA_CONFIG: path.join(dir, 'missing.json') }, true) === ALIA_ENDPOINT && resolveEndpoint({}, true) === ALIA_ENDPOINT);
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

  const built = buildEngineConfig('https://e/api/', [{ id: 'a', name: 'A', maxInputTokens: 1000 }, { id: 'b', name: 'B', toolCalling: false, vision: true }], KEY);
  check('the engine config applies the endpoint to every model, with sensible defaults', built.apiKey === KEY && built.models.every((m) => m.url === 'https://e/api/') && built.models[0].toolCalling === true && built.models[1].toolCalling === false && built.models[1].vision === true && built.models[0].maxInputTokens === 1000 && built.apiType === 'chat-completions');
}

console.log('\n=== the service behind the settings screen ===');
{
  const calls: Array<{ name: string; payload: any }> = [];
  const seenSecrets: string[] = [];
  const ENDPOINT = 'https://chat.example/api/';
  // What the fake service answers when asked which models a key gives access to; a key it does not know is refused.
  let remote: Array<{ id: string; name: string }> = [{ id: 'gpt-oss:20b', name: 'gpt-oss' }, { id: 'llama3', name: 'Llama 3' }];
  const mkService = (opts: { encryptor?: Encryptor; env?: NodeJS.ProcessEnv } = {}) => {
    const dir = mk('svc');
    const store = new SettingsStore(path.join(dir, 'settings.json'), defaultSettings('Newton'));
    const secrets = new SecretStore(path.join(dir, 'credentials.bin'), opts.encryptor ?? fakeEncryptor());
    calls.length = 0;
    const service = new SettingsService({
      store,
      secrets,
      engine: {
        request: async (name: any, payload: any) => {
          calls.push({ name, payload });
          if (name !== 'connection.test') return { ok: true, models: 1 } as any;
          if (payload.apiKey.startsWith('bad-')) return { ok: false, models: [], reason: 'unauthorized', message: 'The key was not accepted (401)' } as any;
          return { ok: true, models: remote } as any;
        },
      },
      endpointUrl: ENDPOINT,
      bundledSkillsDir: path.join(dir, 'skills'),
      userSkillsDir: path.join(dir, 'user-skills'),
      env: opts.env ?? {},
      onSecret: (s) => seenSecrets.push(s),
    });
    return { service, store, secrets, dir };
  };

  const a = mkService();
  const v0 = a.service.view();
  check('a fresh install is not configured, offers no key, and says secure storage is available', !v0.configured && !v0.hasApiKey && v0.secureStorage && v0.displayName === 'Newton' && v0.permissionMode === 'ask-commands' && v0.models.length === 0);
  check('the settings screen has no address to show: the view carries none', !('endpointUrl' in v0));
  check('with nothing to configure the engine is not asked to', (await a.service.configureEngine()) === false && calls.length === 0);

  const bad = await a.service.setApiKey('bad-key-12345678');
  check('a key the service refuses is not stored, and the reason comes back', bad.connection.ok === false && bad.connection.reason === 'unauthorized' && !bad.view.hasApiKey && !bad.view.configured && !a.secrets.has() && !fs.existsSync(path.join(a.dir, 'credentials.bin')));
  check('a refused key changes nothing else: no models, and the engine is not configured', bad.view.models.length === 0 && !calls.some((c) => c.name === 'engine.configure'));

  const v1 = await a.service.setApiKey(KEY);
  check('the key is checked against the fixed address', calls.some((c) => c.name === 'connection.test' && c.payload.url === ENDPOINT && c.payload.apiKey === KEY));
  check('an accepted key stores it, and the models the service lists become the app\'s models', v1.connection.ok && v1.view.hasApiKey && v1.view.configured && v1.view.models.map((m) => m.id).join() === 'gpt-oss:20b,llama3' && v1.view.models[1].name === 'Llama 3');
  check('each model gets the default context size', v1.view.models.every((m) => m.maxInputTokens === 128000));
  const configure = calls.find((c) => c.name === 'engine.configure');
  check('the engine is configured with the models, the key, the fixed address, the skill folders and the approval mode', !!configure && configure.payload.config.apiKey === KEY && configure.payload.config.models.length === 2 && configure.payload.config.models.every((m: any) => m.url === ENDPOINT) && configure.payload.skillRoots.length === 2 && configure.payload.permissionMode === 'ask-commands');
  check('nothing the page can receive contains the key', !JSON.stringify(v1).includes(KEY) && !('apiKey' in v1.view) && !JSON.stringify(a.service.view()).includes('VERYSECRET'));
  check('the log is told about the key so it can mask it', seenSecrets.includes(KEY));
  check('on disk the key is only in the encrypted file', !fs.readFileSync(a.store.file, 'utf8').includes('VERYSECRET') && !fs.readFileSync(path.join(a.dir, 'credentials.bin')).toString('latin1').includes('VERYSECRET'));

  await a.service.update({ permissionMode: 'auto' });
  check('changing the approval mode reconfigures the engine', calls.at(-1)!.payload.permissionMode === 'auto');
  const before = calls.length;
  const dup = await a.service.update({ models: [{ id: 'x', name: 'one' }, { id: 'x', name: 'two' }] }).then(() => '', (e) => e.message);
  check('two models with the same id are refused before anything is saved', dup.includes('same id') && a.service.view().models[0].id === 'gpt-oss:20b' && calls.length === before);

  // Refreshing
  a.store.update({ models: [{ id: 'gpt-oss:20b', name: 'gpt-oss', maxInputTokens: 32000 }, { id: 'gone', name: 'Gone' }] });
  remote = [{ id: 'gpt-oss:20b', name: 'gpt-oss' }, { id: 'new-one', name: 'New', maxInputTokens: 200000, maxOutputTokens: 8000 }];
  const r1 = await a.service.refreshModels();
  check('refreshing replaces the list with the service\'s (a model it no longer offers goes away)', r1.connection.ok && r1.view.models.map((m) => m.id).join() === 'gpt-oss:20b,new-one');
  check('...and keeps what the app knew about a model that is still offered (its context size)', r1.view.models[0].maxInputTokens === 32000);
  check('a limit the service states for a model is used (input and output), and wins over the default', r1.view.models[1].maxInputTokens === 200000 && r1.view.models[1].maxOutputTokens === 8000);
  check('...and the engine is told the new list', calls.at(-1)!.name === 'engine.configure' && calls.at(-1)!.payload.config.models.length === 2);
  remote = [];
  const none = await a.service.refreshModels();
  check('a key that gives access to no model is explained, and the models already saved stay', none.connection.ok === false && none.connection.reason === 'no_models' && none.view.models.length === 2);
  remote = [{ id: 'gpt-oss:20b', name: 'gpt-oss' }];
  const noKeyYet = mkService();
  check('refreshing with no saved key says the key is missing, without asking the service', (await noKeyYet.service.refreshModels()).connection.reason === 'unauthorized' && calls.length === 0);

  const checked = await a.service.checkConnection();
  check('checking the connection (the diagnostics) lists the models with the saved key and changes nothing', checked.ok && checked.models.length === 1 && a.service.view().models.length === 2);

  const cleared = await a.service.clearApiKey();
  check('removing the key leaves the app unconfigured', !cleared.hasApiKey && !cleared.configured);

  // A key on a machine that cannot store it
  const noOs = mkService({ encryptor: fakeEncryptor(false) });
  check('without OS encryption the screen can say so, and the key is refused before any call to the service', noOs.service.view().secureStorage === false && (await noOs.service.setApiKey(KEY).then(() => '', (e) => e.constructor.name)) === 'SecureStorageUnavailableError' && !noOs.service.view().hasApiKey && calls.length === 0);

  // First run of an automated test
  const legacyDir = mk('legacy');
  const legacyFile = path.join(legacyDir, 'alia-config.json');
  fs.writeFileSync(legacyFile, JSON.stringify({ models: [{ id: 'gpt-oss:20b', name: 'gpt-oss', url: 'https://old.example/api/', maxInputTokens: 64000 }] }));
  fs.writeFileSync(path.join(legacyDir, '.env'), 'ALIA_API_KEY=legacy-key-123456789\n');
  const seed = mkService({ env: { ALIA_CONFIG: legacyFile } });
  check('a test run with ALIA_CONFIG set starts configured, with that file\'s models and key (the endpoint is not a setting)', (await seed.service.seedFromEnvironment()) === true && seed.service.view().configured && seed.service.view().models[0].maxInputTokens === 64000 && calls.at(-1)!.payload.config.apiKey === 'legacy-key-123456789');
  check('the seeded key is encrypted like any other', !fs.readFileSync(path.join(seed.dir, 'credentials.bin')).toString('latin1').includes('legacy-key'));
  check('...but only once: later changes are not overwritten', (await seed.service.update({ models: [{ id: 'mine', name: 'Mine' }] }), (await seed.service.seedFromEnvironment()) === false && seed.service.view().models[0].id === 'mine'));
  check('without ALIA_CONFIG nothing is imported behind the user\'s back', (await mkService().service.seedFromEnvironment()) === false);
  check('a broken ALIA_CONFIG does not stop the app', (await mkService({ env: { ALIA_CONFIG: path.join(mk(), 'missing.json') } }).service.seedFromEnvironment()) === false);
}

console.log('\n=== the broker knows every main request ===');
{
  const calls: string[] = [];
  const projects = new ProjectRegistry();
  const broker = new Broker({ engine: { request: async (name: any) => (calls.push(name), {}) } as any, projects, pickFolder: async () => null, main: { 'settings.get': () => ({ ok: 1 }) as any } });
  check('a settings request main has no handler for is never forwarded to the engine', (await broker.handle('settings.clearApiKey', {}).then(() => '', (e) => e.message)).includes('not available') && calls.length === 0);
  check('the address is not something the page can change: it is not a field of any settings request', (await broker.handle('settings.update', { endpointUrl: 'https://evil.example/' }).then(() => '', (e) => e.message)).includes('Unrecognized') && (await broker.handle('settings.testConnection', { endpointUrl: 'https://evil.example/', apiKey: 'sk-test-12345678' }).then(() => '', (e) => e.message)).length > 0 && calls.length === 0);
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
