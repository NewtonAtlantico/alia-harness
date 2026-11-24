import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { McpConnectError, buildTransports, classifyMcpError } from './mcpConnection.js';
import type { McpCredentials, McpResolvedServer } from './types.js';

/** The sign-in page sends the browser back to this address on the person's own computer. */
export const OAUTH_CALLBACK_PORT = 53682;
export const OAUTH_CALLBACK_PATH = '/callback';
const DEFAULT_REDIRECT = `http://127.0.0.1:${OAUTH_CALLBACK_PORT}${OAUTH_CALLBACK_PATH}`;
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

type SavedOAuth = NonNullable<McpCredentials['oauth']>;

export interface McpOAuthProviderOptions {
  /** Where the sign-in page sends the browser back. Default: the fixed local address. */
  redirectUrl?: string;
  /** What was saved by a previous sign-in. */
  initial?: SavedOAuth;
  /** Called whenever the client registration or the tokens change, so they can be kept (encrypted) by the app. */
  onChange?: (saved: SavedOAuth) => void;
  /** Opens the sign-in page. Without it the provider refuses to start a sign-in: the connection fails with `needs_sign_in`. */
  openUrl?: (url: URL) => void | Promise<void>;
}

/**
 * The SDK's OAuth hooks for one server: it remembers the client the server registered for us and the tokens it gave,
 * refreshes the tokens by itself, and (only when `openUrl` is given) sends the person to the sign-in page.
 */
export class McpOAuthProvider implements OAuthClientProvider {
  private saved: SavedOAuth;
  private verifier = '';
  private readonly oauthState = randomBytes(16).toString('hex');
  private readonly redirect: string;

  constructor(private readonly options: McpOAuthProviderOptions = {}) {
    this.saved = { ...(options.initial ?? {}) };
    this.redirect = options.redirectUrl ?? DEFAULT_REDIRECT;
  }

  /** The random value the sign-in page must hand back with the code. */
  get expectedState(): string {
    return this.oauthState;
  }

  get redirectUrl(): string {
    return this.redirect;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Alia Harness',
      redirect_uris: [this.redirect],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  state(): string {
    return this.oauthState;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    const info = this.saved.clientInformation as (OAuthClientInformationMixed & { redirect_uris?: string[] }) | undefined;
    // A client registered for another address (the fixed port was busy last time) cannot be used with this one.
    if (info?.redirect_uris && !info.redirect_uris.includes(this.redirect)) return undefined;
    return info;
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    this.saved = { ...this.saved, clientInformation: info };
    this.options.onChange?.(this.saved);
  }

  tokens(): OAuthTokens | undefined {
    return this.saved.tokens as OAuthTokens | undefined;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.saved = { ...this.saved, tokens };
    this.options.onChange?.(this.saved);
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.verifier = codeVerifier;
  }

  codeVerifier(): string {
    return this.verifier;
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    if (!this.options.openUrl) throw new McpConnectError('needs_sign_in', 'The server needs you to sign in again.');
    await this.options.openUrl(url);
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'all' || scope === 'client') this.saved = { ...this.saved, clientInformation: undefined };
    if (scope === 'all' || scope === 'tokens') this.saved = { ...this.saved, tokens: undefined };
    if (scope === 'verifier') this.verifier = '';
    this.options.onChange?.(this.saved);
  }

  /** What is saved now (for the caller to keep). */
  snapshot(): SavedOAuth {
    return this.saved;
  }
}

interface Loopback {
  redirectUrl: string;
  /** Resolves with the code once the browser comes back with the right state; rejects on an error answer or after the timeout. */
  code: Promise<string>;
  close(): void;
}

const DONE_PAGE = `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Alia</title><body style="font-family:system-ui,sans-serif;margin:15vh auto;max-width:28rem;text-align:center;color:#1f2937"><h1 style="color:#26409a">Tudo certo</h1><p>Você já pode fechar esta janela e voltar para o Alia.</p></body></html>`;
const FAILED_PAGE = `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Alia</title><body style="font-family:system-ui,sans-serif;margin:15vh auto;max-width:28rem;text-align:center;color:#1f2937"><h1 style="color:#b42318">Não deu certo</h1><p>A autorização não foi concluída. Volte para o Alia e tente de novo.</p></body></html>`;

/** Listens on this computer only, for the one request the sign-in page makes when it sends the browser back. */
export function startLoopback(expectedState: () => string, timeoutMs = SIGN_IN_TIMEOUT_MS): Promise<Loopback> {
  return new Promise((resolveStart, rejectStart) => {
    let settle!: { resolve: (code: string) => void; reject: (err: Error) => void };
    const code = new Promise<string>((resolve, reject) => {
      settle = { resolve, reject };
    });
    code.catch(() => {}); // an unread rejection must not crash the process

    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const host = String(req.headers.host ?? '');
      if (url.pathname !== OAUTH_CALLBACK_PATH || !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) {
        res.writeHead(404).end();
        return;
      }
      const headers = { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'", 'cache-control': 'no-store' };
      const error = url.searchParams.get('error');
      const got = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      if (error || !got || state !== expectedState()) {
        res.writeHead(400, headers).end(FAILED_PAGE);
        settle.reject(new McpConnectError(error === 'access_denied' ? 'cancelled' : 'unauthorized', error ? `The sign-in was not completed (${error}).` : 'The sign-in answer did not match this request.'));
        return;
      }
      res.writeHead(200, headers).end(DONE_PAGE);
      settle.resolve(got);
    });

    const timer = setTimeout(() => settle.reject(new McpConnectError('timeout', 'The sign-in was not completed in time.')), timeoutMs);
    const close = () => {
      clearTimeout(timer);
      server.close();
      server.closeAllConnections?.();
    };
    void code.finally(() => setTimeout(close, 1000)).catch(() => {});

    const listen = (port: number) => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && port !== 0) listen(0);
        else rejectStart(err);
      });
      server.listen(port, '127.0.0.1', () => {
        const address = server.address();
        const actual = typeof address === 'object' && address ? address.port : port;
        resolveStart({ redirectUrl: `http://127.0.0.1:${actual}${OAUTH_CALLBACK_PATH}`, code, close });
      });
    };
    listen(OAUTH_CALLBACK_PORT);
  });
}

export interface AuthorizeHooks {
  /** Opens the sign-in page in the person's browser. */
  openUrl: (url: string) => void | Promise<void>;
  /** Keeps what the sign-in gave (client registration and tokens). Called as they arrive. */
  onSaved: (oauth: SavedOAuth) => void;
  timeoutMs?: number;
}

/**
 * Signs in to a server through the browser: connects, and when the server asks for a sign-in opens the page, waits for the
 * browser to come back to this computer with the code, and finishes the exchange. Returns what to keep. Throws `McpConnectError`.
 */
export async function authorizeMcp(server: McpResolvedServer, hooks: AuthorizeHooks): Promise<SavedOAuth> {
  if (server.config.transport.type !== 'http') throw new McpConnectError('bad_config', 'Signing in through the browser needs a server address.');
  // The provider's state is read by the listener, so it is made first and the listener only needs the value.
  let provider!: McpOAuthProvider;
  const loopback = await startLoopback(() => provider.expectedState, hooks.timeoutMs);
  provider = new McpOAuthProvider({
    redirectUrl: loopback.redirectUrl,
    initial: server.credentials.oauth,
    onChange: hooks.onSaved,
    openUrl: (url) => hooks.openUrl(url.href),
  });
  try {
    let first: McpConnectError | undefined;
    for (const attempt of buildTransports(server, { authProvider: provider })) {
      const client = new Client({ name: 'alia-harness', version: '1.0.0' }, { capabilities: {} });
      // Both the streamable HTTP and the SSE transports finish a sign-in this way.
      const transport = attempt.create() as unknown as AuthTransport;
      try {
        try {
          await client.connect(transport);
        } catch (err) {
          if (!(err instanceof UnauthorizedError)) throw err;
          // The sign-in page is open. Wait for the browser to come back, then trade the code for tokens.
          const code = await loopback.code;
          await transport.finishAuth(code);
        }
        return provider.snapshot();
      } catch (err) {
        const failure = classifyMcpError(err, server);
        first ??= failure;
        if (failure.reason === 'needs_sign_in' || failure.reason === 'cancelled' || failure.reason === 'timeout' || failure.reason === 'unauthorized') throw failure;
      } finally {
        await Promise.allSettled([client.close(), transport.close()]);
      }
    }
    throw first ?? new McpConnectError('other', 'No way to reach the server.');
  } finally {
    loopback.close();
  }
}

type AuthTransport = Transport & { finishAuth(code: string): Promise<void> };
