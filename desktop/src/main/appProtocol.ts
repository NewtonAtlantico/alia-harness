import fs from 'node:fs';
import path from 'node:path';
import { protocol } from 'electron';
import { APP_HOST, APP_SCHEME, CONTENT_SECURITY_POLICY, resolveAppPath } from './securityRules';

/**
 * The renderer is served from `app://alia/`, not from file://. A standard, secure origin lets the page's policy say
 * 'self' and lets the Electron fuse that removes file:// privileges stay off. Must run before the app is ready.
 */
export function registerAppSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

/**
 * Answers `app://alia/...` with files from `rootDir` (the built renderer), and the policy header on every response.
 * Files are read directly (not through the network stack), so the session's request filter can stay strict.
 */
export function serveApp(rootDir: string): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== APP_HOST) return new Response('Not found', { status: 404 });
    const file = resolveAppPath(rootDir, url.pathname);
    if (!file) return new Response('Forbidden', { status: 403 });
    let data: Buffer;
    try {
      data = await fs.promises.readFile(file);
    } catch {
      return new Response('Not found', { status: 404 });
    }
    return new Response(new Uint8Array(data), {
      status: 200,
      headers: {
        'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        'Content-Security-Policy': CONTENT_SECURITY_POLICY,
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });
}
