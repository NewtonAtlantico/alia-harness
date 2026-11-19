import path from 'node:path';
import { BrowserWindow, app, dialog, ipcMain } from 'electron';
import { CHANNELS, type PushMessage } from '../shared/ipc';
import { loadBootConfig, skillRoots } from './bootConfig';
import { Broker, ProjectRegistry } from './broker';
import { EngineHost } from './engineHost';

/*
 * Environment switches (set by whoever launches the app, never by the page):
 *   ALIA_DESKTOP_DATA_DIR  keeps settings, conversations and allowlists in this folder (tests and the smoke run)
 *   ALIA_DESKTOP_SMOKE     folder of sample documents: run the startup self-test, print the result and exit
 *   ALIA_DESKTOP_TEST      test hooks: ALIA_TEST_PICK_FOLDER answers the folder dialog, and a test handle is exposed
 */
const dataDir = process.env.ALIA_DESKTOP_DATA_DIR;
const smokeDir = process.env.ALIA_DESKTOP_SMOKE;
const testMode = process.env.ALIA_DESKTOP_TEST === '1';
if (dataDir) app.setPath('userData', path.join(dataDir, 'user-data'));

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const bundledSkills = app.isPackaged ? path.join(process.resourcesPath, 'skills') : path.join(repoRoot, 'skills');

const projects = new ProjectRegistry();

function broadcast(message: PushMessage): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(CHANNELS.push, message);
  }
}

const engine: EngineHost = new EngineHost({
  log: (line) => console.log(line),
  onPush: broadcast,
  onStart: async (host) => {
    const config = loadBootConfig(repoRoot);
    if (!config) {
      console.log('[main] no usable configuration yet (alia-config.json with an API key); sessions cannot open until there is one');
      return;
    }
    await host.request('engine.configure', {
      config,
      skillRoots: skillRoots(bundledSkills),
      dataDirs: dataDir ? { sessions: path.join(dataDir, 'sessions'), permissions: path.join(dataDir, 'permissions') } : undefined,
    });
  },
});

const broker = new Broker({
  engine,
  projects,
  pickFolder: async () => {
    if (testMode && process.env.ALIA_TEST_PICK_FOLDER) return process.env.ALIA_TEST_PICK_FOLDER;
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const options = { title: 'Escolher pasta do projeto', properties: ['openDirectory' as const] };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  },
});

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    backgroundColor: '#f6f7f9',
    webPreferences: {
      preload: path.join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once('ready-to-show', () => win.show());

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(path.join(import.meta.dirname, '../renderer/index.html'));
  return win;
}

/** Packaged-stack check: renderer -> preload -> main -> engine -> core. Prints one line and exits. */
async function runSmoke(win: BrowserWindow, dir: string): Promise<void> {
  const fail = (why: string) => {
    console.log(`SMOKE_RESULT ${JSON.stringify({ ok: false, why })}`);
    app.exit(1);
  };
  const timer = setTimeout(() => fail('timed out'), 60_000);
  try {
    await new Promise<void>((resolve) => win.webContents.once('did-finish-load', () => resolve()));
    const viaRenderer = await win.webContents.executeJavaScript('window.alia.ping()');
    const selfTest = await engine.request('selfTest', { dir });
    clearTimeout(timer);
    const ok = viaRenderer?.pong === true && viaRenderer.pid !== process.pid && viaRenderer.coreStages === 4 && selfTest.ok;
    console.log(`SMOKE_RESULT ${JSON.stringify({ ok, mainPid: process.pid, viaRenderer, selfTest })}`);
    app.exit(ok ? 0 : 1);
  } catch (err: any) {
    fail(String(err?.stack ?? err));
  }
}

app.whenReady().then(() => {
  ipcMain.handle(CHANNELS.request, (_event, name: unknown, payload: unknown) => broker.handle(name, payload));
  ipcMain.handle(CHANNELS.ping, () => engine.request('ping', {}));
  if (testMode) (globalThis as { __aliaTest?: unknown }).__aliaTest = { engine, projects };
  const win = createWindow();
  if (smokeDir) void runSmoke(win, smokeDir);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => engine.stop());
