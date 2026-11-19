/**
 * The decisions behind the hardening in 4.3 of the backlog, as plain functions with no Electron in them, so a test
 * can throw hostile input at them. `guards.ts` wires them to Electron.
 */
import path from 'node:path';

/** The app's own origin. The renderer is served from here, never from file://. */
export const APP_SCHEME = 'app';
export const APP_HOST = 'alia';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

/**
 * Nothing remote, nothing inline: scripts, styles, fonts and images come from the app itself (fonts are
 * bundled), and the page cannot open a connection of its own: everything goes through `window.alia`.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** True for the page this app loaded (the packaged origin, or the dev server while developing). */
export function isTrustedUrl(url: string, devUrl?: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === `${APP_SCHEME}:` && parsed.host === APP_HOST && !parsed.username && !parsed.password) return true;
  if (devUrl) {
    try {
      return parsed.origin === new URL(devUrl).origin;
    } catch {
      return false;
    }
  }
  return false;
}

/** Network and file requests the renderer may make: its own origin, and inline data it built itself. */
export function isAllowedRequestUrl(url: string, devUrl?: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === 'data:' || parsed.protocol === 'blob:' || parsed.protocol === 'devtools:') return true;
  if (isTrustedUrl(url, devUrl)) return true;
  if (devUrl) {
    // The dev server's websocket for hot reload.
    const dev = new URL(devUrl);
    return (parsed.protocol === 'ws:' || parsed.protocol === 'wss:') && parsed.host === dev.host;
  }
  return false;
}

/**
 * A link the page wants opened in the system browser. Only https, with a host, and without credentials in the
 * address (`https://bank.com@evil.example` shows one name and goes to another). Throws a readable error.
 */
export function parseExternalUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('That is not a valid link.');
  }
  if (url.protocol !== 'https:') throw new Error('Only https links can be opened.');
  if (!url.hostname) throw new Error('The link has no address.');
  if (url.username || url.password) throw new Error('Links with a user name or password in them are not opened.');
  return url;
}

/**
 * Maps a request path of the app protocol to a file inside `rootDir`, or null if it points anywhere else
 * (`..`, encoded tricks, drive letters, backslashes, NUL bytes).
 */
export function resolveAppPath(rootDir: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const relative = decoded === '/' || decoded === '' ? 'index.html' : decoded.replace(/^[/\\]+/, '');
  if (/^[a-zA-Z]:/.test(relative) || path.isAbsolute(relative)) return null;
  const file = path.resolve(rootDir, relative);
  const back = path.relative(rootDir, file);
  if (!back || back.startsWith('..') || path.isAbsolute(back)) return null;
  return file;
}
