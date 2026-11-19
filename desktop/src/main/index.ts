import path from 'node:path';
import { BrowserWindow, Menu, app, dialog, ipcMain } from 'electron';
import { CHANNELS, type AppCommand, type PushMessage } from '../shared/ipc';
import { registerAppSchemePrivileges, serveApp } from './appProtocol';
import { loadBootConfig, skillRoots } from './bootConfig';
import { Broker, ProjectRegistry } from './broker';
import { EngineHost } from './engineHost';
import { confirmAndOpenExternal, installSessionGuards, installWebContentsGuards, isTrustedSender } from './guards';
import { Logger } from './logger';
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
    onStart: async (host) => {
      const config = loadBootConfig(repoRoot);
      if (!config) {
        log.warn('no usable configuration yet (alia-config.json with an API key); sessions cannot open until there is one');
        return;
      }
      log.addSecret(config.apiKey);
      await host.request('engine.configure', {
        config,
        skillRoots: skillRoots(bundledSkills),
        dataDirs: dataDir ? { sessions: path.join(dataDir, 'sessions'), permissions: path.join(dataDir, 'permissions') } : undefined,
      });
      log.info(`engine configured (${config.models.length} model${config.models.length === 1 ? '' : 's'})`);
    },
  });

  const windowOf = (context: unknown): BrowserWindow | undefined => {
    const sender = (context as { sender?: Electron.WebContents } | undefined)?.sender;
    return sender ? (BrowserWindow.fromWebContents(sender) ?? undefined) : undefined;
  };

  const broker = new Broker({
    engine,
    projects,
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

  void app.whenReady().then(() => {
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
    ipcMain.handle(CHANNELS.ping, (event) => {
      if (!isTrustedSender(event, devUrl)) throw new Error('Request refused: it did not come from the app.');
      return engine.request('ping', {});
    });
    if (testMode) (globalThis as { __aliaTest?: unknown }).__aliaTest = { engine, projects, openedLinks, log };

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
