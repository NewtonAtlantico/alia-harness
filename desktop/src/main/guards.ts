import { app, dialog, session, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import type { Logger } from './logger';
import { isAllowedRequestUrl, isTrustedUrl, parseExternalUrl } from './securityRules';
import { mainStrings } from './strings';

export interface GuardOptions {
  devUrl?: string;
  log: Logger;
  /** Test hook: record links instead of opening them (set only when ALIA_DESKTOP_TEST=1). */
  onExternalLink?: (url: string) => void;
}

let linkDialogOpen = false;

/**
 * Asks the user, in a native dialog the page cannot draw or click, before a link leaves the app. One question at a
 * time: a page that asks repeatedly gets no more dialogs than the first.
 */
export async function confirmAndOpenExternal(rawUrl: string, parent: BrowserWindow | undefined, options: GuardOptions): Promise<boolean> {
  const url = parseExternalUrl(rawUrl);
  if (options.onExternalLink) {
    options.onExternalLink(url.href);
    return true;
  }
  if (linkDialogOpen) return false;
  linkDialogOpen = true;
  try {
    const box = {
      type: 'question' as const,
      buttons: [mainStrings.dialogs.open, mainStrings.dialogs.cancel],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      message: mainStrings.dialogs.openLinkTitle,
      detail: mainStrings.dialogs.openLinkDetail(url.href),
    };
    const { response } = parent ? await dialog.showMessageBox(parent, box) : await dialog.showMessageBox(box);
    if (response !== 0) return false;
    await shell.openExternal(url.href);
    return true;
  } finally {
    linkDialogOpen = false;
  }
}

/** True when an IPC message comes from the app's own page, in its top frame. */
export function isTrustedSender(event: IpcMainInvokeEvent, devUrl?: string): boolean {
  const frame = event.senderFrame;
  return !!frame && frame.parent === null && isTrustedUrl(frame.url, devUrl);
}

/**
 * Applied to every web contents the app ever creates (so a window opened later is covered too): no navigation,
 * no new windows, no webviews. A link the page wants opened goes through the confirmation dialog, https only.
 */
export function installWebContentsGuards(options: GuardOptions): void {
  app.on('web-contents-created', (_event, contents) => {
    const deny = (kind: string) => (details: { preventDefault(): void; url: string }) => {
      details.preventDefault();
      options.log.warn(`blocked ${kind} to ${details.url.slice(0, 200)}`);
    };
    contents.on('will-navigate', deny('navigation'));
    contents.on('will-frame-navigate', deny('frame navigation'));
    contents.on('will-redirect', deny('redirect'));
    contents.on('will-attach-webview', (event) => {
      event.preventDefault();
      options.log.warn('blocked a webview');
    });
    contents.setWindowOpenHandler(({ url }) => {
      options.log.warn(`blocked a new window for ${url.slice(0, 200)}`);
      if (url.startsWith('https:')) void confirmAndOpenExternal(url, undefined, options).catch(() => {});
      return { action: 'deny' };
    });
  });
}

/** Session-wide rules: the page may use no device or sensor permission, and may request nothing outside the app. */
export function installSessionGuards(options: GuardOptions): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_contents, permission, callback) => {
    options.log.warn(`denied permission request: ${permission}`);
    callback(false);
  });
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.webRequest.onBeforeRequest((details, callback) => {
    const allowed = isAllowedRequestUrl(details.url, options.devUrl);
    if (!allowed) options.log.warn(`blocked request to ${details.url.slice(0, 200)}`);
    callback({ cancel: !allowed });
  });
}
