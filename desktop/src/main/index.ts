import os from 'node:os';
import path from 'node:path';
import { BrowserWindow, Menu, app, dialog, ipcMain, safeStorage } from 'electron';
import { CHANNELS, type AppCommand, type PushMessage } from '../shared/ipc';
import { registerAppSchemePrivileges, serveApp } from './appProtocol';
import { sanitizePaths } from './attachments';
import { Broker, ProjectRegistry } from './broker';
import { EngineHost } from './engineHost';
import { confirmAndOpenExternal, installSessionGuards, installWebContentsGuards, isTrustedSender } from './guards';
import { Logger } from './logger';
import { SecretStore } from './secrets';
import { SettingsService } from './settingsService';
import { SettingsStore, defaultSettings } from './settings';
import { TrustStore, inspectProject } from './trust';
import { buildMenu } from './menu';
import { APP_ORIGIN } from './securityRules';
import { commandForInput } from './shortcuts';
import { mainStrings } from './strings';

/*
 * Environment switches (set by whoever launches the app, never by the page):
 *   ALIA_DESKTOP_DATA_DIR  keeps settings, conversations, allowlists and logs in this folder (tests and the smoke run)
 *   ALIA_DESKTOP_SMOKE     folder of sample documents: run the startup self-test, print the result and exit
 *   ALIA_DESKTOP_TEST      test hooks: ALIA_TEST_PICK_FOLDER answers the folder dialog, links are recorded instead of
 *                          opened, and a test handle is exposed on globalThis
 */
const dataDir = process.env.ALIA_DESKTOP_DATA_DIR;
const smokeDir = process.env.ALIA_DESKTOP_SMOKE;
const testMode = process.env.ALIA_DESKTOP_TEST === '1';
const devUrl = process.env.ELECTRON_RENDERER_URL || undefined;
if (dataDir) app.setPath('userData', path.join(dataDir, 'user-data'));

// Must happen before the app is ready.
registerAppSchemePrivileges();
app.enableSandbox();

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  // Another window of the app is running (for this user profile): it gets focus, this process ends.
  app.quit();
} else {
  start();
}

function start(): void {
  const log = new Logger(app.getPath('logs'));
  log.info(`starting alia Harness ${app.getVersion()} (${app.isPackaged ? 'packaged' : 'development'}, Electron ${process.versions.electron})`);
  process.on('uncaughtException', (err) => log.error(`uncaught exception: ${err.stack ?? err}`));
  process.on('unhandledRejection', (err) => log.error(`unhandled rejection: ${String((err as Error)?.stack ?? err)}`));

  const repoRoot = path.resolve(import.meta.dirname, '../../..');
  const bundledSkills = app.isPackaged ? path.join(process.resourcesPath, 'skills') : path.join(repoRoot, 'skills');
  const projects = new ProjectRegistry();
  const openedLinks: string[] = [];
  const guardOptions = { devUrl, log, onExternalLink: testMode ? (url: string) => void openedLinks.push(url) : undefined };

  // Settings and the encrypted API key live in the user's data folder, never in the project and never in a plain file.
  const userData = app.getPath('userData');
  const defaultName = os.userInfo().username.replace(/^./, (c) => c.toUpperCase());
  const store = new SettingsStore(path.join(userData, 'settings.json'), defaultSettings(defaultName));
  const secrets = new SecretStore(path.join(userData, 'credentials.bin'), {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => safeStorage.encryptString(plain),
    decrypt: (data) => safeStorage.decryptString(data),
  });
  const trust = new TrustStore(path.join(userData, 'trust.json'));
  const pickLegacyFile = async (suggestedFolder?: string): Promise<string | null> => {
    if (testMode && process.env.ALIA_TEST_PICK_FILE) return process.env.ALIA_TEST_PICK_FILE;
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const options = { title: mainStrings.dialogs.pickConfig, defaultPath: suggestedFolder, filters: [{ name: 'alia-config.json', extensions: ['json'] }], properties: ['openFile' as const] };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  };

  // eslint-disable-next-line prefer-const
  let settings: SettingsService;

  const broadcast = (message: PushMessage): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(CHANNELS.push, message);
    }
  };

  const engine: EngineHost = new EngineHost({
    log: (line) => log.info(line),
    onPush: (message) => {
      if (message.kind === 'engine_status') log.warn(`engine ${message.status}`);
      broadcast(message);
    },
    // Every (re)start of the engine: give it the saved configuration (the service reads the key from the encrypted file).
    onStart: async () => {
      await settings.configureEngine();
    },
  });

  settings = new SettingsService({
    store,
    secrets,
    engine,
    legacyFolders: [repoRoot, process.cwd(), path.join(os.homedir(), '.alia')],
    pickLegacyFile,
    bundledSkillsDir: bundledSkills,
    userSkillsDir: path.join(os.homedir(), '.alia', 'skills'),
    dataDirs: dataDir ? { sessions: path.join(dataDir, 'sessions'), permissions: path.join(dataDir, 'permissions') } : undefined,
    log,
    onSecret: (secret) => log.addSecret(secret),
  });
  // Folders the user opened before stay openable after a restart.
  for (const folder of store.recentProjects()) projects.allow(folder);

  const pickAttachments = async (parent?: BrowserWindow): Promise<string[]> => {
    if (testMode && process.env.ALIA_TEST_PICK_FILES) return process.env.ALIA_TEST_PICK_FILES.split(path.delimiter).filter(Boolean);
    const options = { title: mainStrings.dialogs.pickAttachments, properties: ['openFile' as const, 'multiSelections' as const] };
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    return result.canceled ? [] : result.filePaths;
  };

  /** Files dropped on the window (reported by the preload for a genuine drop): the engine may read them, and the page is told. */
  const handleDropped = async (sender: Electron.WebContents, raw: unknown): Promise<string[]> => {
    const paths = sanitizePaths(raw);
    if (paths.length === 0) return [];
    await engine.request('attachments.allow', { paths });
    if (!sender.isDestroyed()) sender.send(CHANNELS.push, { kind: 'files_dropped', paths } satisfies PushMessage);
    return paths;
  };

  const windowOf = (context: unknown): BrowserWindow | undefined => {
    const sender = (context as { sender?: Electron.WebContents } | undefined)?.sender;
    return sender ? (BrowserWindow.fromWebContents(sender) ?? undefined) : undefined;
  };

  const broker = new Broker({
    engine,
    projects,
    onProjectPicked: (folder) => store.rememberProject(folder),
    // Only main knows whether a folder is trusted; the page cannot say so (its request schema has no such field).
    enrich: (name, request) => (name === 'session.open' ? { ...(request as object), trustedProject: trust.isTrusted((request as { projectPath: string }).projectPath) } : request),
    pickFolder: async () => {
      if (testMode && process.env.ALIA_TEST_PICK_FOLDER) return process.env.ALIA_TEST_PICK_FOLDER;
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const options = { title: mainStrings.dialogs.pickFolder, properties: ['openDirectory' as const] };
      const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
      return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
    },
    main: {
      'window.minimize': (_req, ctx) => (windowOf(ctx)?.minimize(), { ok: true as const }),
      'window.toggleMaximize': (_req, ctx) => {
        const win = windowOf(ctx);
        if (!win) return { maximized: false };
        if (win.isMaximized()) win.unmaximize();
        else win.maximize();
        return { maximized: win.isMaximized() };
      },
      'window.close': (_req, ctx) => (windowOf(ctx)?.close(), { ok: true as const }),
      'window.state': (_req, ctx) => ({ maximized: windowOf(ctx)?.isMaximized() ?? false }),
      'attachments.pick': async (_req, ctx) => {
        const picked = await pickAttachments(windowOf(ctx));
        const paths = sanitizePaths(picked);
        if (paths.length > 0) await engine.request('attachments.allow', { paths });
        return { paths };
      },
      'projects.recent': () => store.recentProjects(),
      'projects.inspect': ({ projectPath }) => inspectProject(trust, projectPath),
      'projects.setTrust': ({ projectPath, trusted }) => {
        trust.set(projectPath, trusted);
        log.info(`project skills ${trusted ? 'trusted' : 'not trusted'} for ${path.basename(projectPath)}`);
        return inspectProject(trust, projectPath);
      },
      'settings.get': () => settings.view(),
      'settings.update': (patch) => settings.update(patch),
      'settings.setApiKey': ({ apiKey }) => settings.setApiKey(apiKey),
      'settings.clearApiKey': () => settings.clearApiKey(),
      'settings.testConnection': (args) => settings.testConnection(args),
      'settings.legacyCandidate': () => settings.legacyCandidate(),
      'settings.importLegacy': () => settings.importLegacy(),
      'app.info': () => ({ name: mainStrings.appName, version: app.getVersion(), platform: process.platform }),
      'app.openExternal': async ({ url }, ctx) => ({ opened: await confirmAndOpenExternal(url, windowOf(ctx), guardOptions) }),
    },
  });

  const mainWindow = (): BrowserWindow | undefined => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());

  function focusMainWindow(): void {
    const win = mainWindow();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  function sendCommand(command: AppCommand): void {
    focusMainWindow();
    broadcast({ kind: 'command', command });
  }

  function createWindow(): BrowserWindow {
    const win = new BrowserWindow({
      width: 1280,
      height: 800,
      minWidth: 960,
      minHeight: 600,
      show: false,
      frame: false, // the title bar and its buttons are drawn by the app
      title: mainStrings.appName,
      backgroundColor: '#f6f7f9',
      webPreferences: {
        preload: path.join(import.meta.dirname, '../preload/index.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        devTools: !app.isPackaged || testMode,
      },
    });
    win.once('ready-to-show', () => win.show());
    win.webContents.on('before-input-event', (event, input) => {
      const command = commandForInput(input);
      if (!command) return;
      event.preventDefault(); // the app handles it; the page never sees the key
      sendCommand(command);
    });
    const sendState = () => {
      if (!win.isDestroyed()) win.webContents.send(CHANNELS.push, { kind: 'window_state', maximized: win.isMaximized() } satisfies PushMessage);
    };
    win.on('maximize', sendState);
    win.on('unmaximize', sendState);
    win.on('enter-full-screen', sendState);
    win.on('leave-full-screen', sendState);

    void win.loadURL(devUrl ?? `${APP_ORIGIN}/index.html`);
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

  app.on('second-instance', () => {
    log.info('a second instance was started; focusing the first');
    focusMainWindow();
  });

  installWebContentsGuards(guardOptions);

  void app.whenReady().then(async () => {
    await settings.seedFromEnvironment();
    if (!devUrl) serveApp(path.join(import.meta.dirname, '../renderer'));
    installSessionGuards(guardOptions);

    Menu.setApplicationMenu(
      buildMenu({
        send: sendCommand,
        quit: () => app.quit(),
        developer: !app.isPackaged,
        about: () =>
          void dialog.showMessageBox({ type: 'info', title: mainStrings.appName, message: mainStrings.appName, detail: mainStrings.dialogs.aboutDetail(app.getVersion()), noLink: true }),
      })
    );

    ipcMain.handle(CHANNELS.request, (event, name: unknown, payload: unknown) => {
      if (!isTrustedSender(event, devUrl)) {
        log.warn(`refused a request from an untrusted sender (${String(event.senderFrame?.url).slice(0, 120)})`);
        throw new Error('Request refused: it did not come from the app.');
      }
      return broker.handle(name, payload, event);
    });
    ipcMain.on(CHANNELS.dropped, (event, paths: unknown) => {
      if (!isTrustedSender(event, devUrl)) return log.warn('ignored a drop report from an untrusted sender');
      void handleDropped(event.sender, paths).catch((err) => log.warn(`could not register dropped files: ${err?.message ?? err}`));
    });
    ipcMain.handle(CHANNELS.ping, (event) => {
      if (!isTrustedSender(event, devUrl)) throw new Error('Request refused: it did not come from the app.');
      return engine.request('ping', {});
    });
    if (testMode) (globalThis as { __aliaTest?: unknown }).__aliaTest = { engine, projects, openedLinks, log, handleDropped };

    const win = createWindow();
    if (smokeDir) void runSmoke(win, smokeDir);
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    log.info('quitting');
    engine.stop();
  });
}
