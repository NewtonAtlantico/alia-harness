import fs from 'node:fs';
import path from 'node:path';

/**
 * Masks anything that looks like a secret. Known secrets (the API key, once main has read it) are replaced
 * wherever they appear; common shapes are masked even when nobody registered them.
 */
export function redact(text: string, secrets: Iterable<string> = []): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 6) out = out.split(secret).join('[redacted]');
  }
  return out
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/((?:api[_-]?key|authorization|access[_-]?token|auth[_-]?token|password|secret)["']?\s*[:=]\s*["']?)[^\s"',}&]+/gi, '$1[redacted]');
}

const KEEP_DAYS = 14;

/**
 * A daily log file in `dir`. It records what the app does (starts, restarts, errors), never conversation
 * content, and everything written goes through `redact`.
 */
export class Logger {
  private readonly secrets = new Set<string>();
  readonly dir: string;

  constructor(dir: string, private readonly now: () => Date = () => new Date()) {
    this.dir = dir;
    try {
      fs.mkdirSync(dir, { recursive: true });
      this.prune();
    } catch {
      /* logging must never stop the app */
    }
  }

  /** Registers a value that must never reach the file (the API key). */
  addSecret(secret: string | undefined): void {
    if (secret) this.secrets.add(secret);
  }

  get file(): string {
    return path.join(this.dir, `main-${this.now().toISOString().slice(0, 10)}.log`);
  }

  write(level: 'info' | 'warn' | 'error', message: string): void {
    const line = `${this.now().toISOString()} ${level.toUpperCase()} ${redact(message, this.secrets).replace(/\r?\n/g, '\n  ')}\n`;
    try {
      fs.appendFileSync(this.file, line, 'utf-8');
    } catch {
      /* ignore */
    }
  }

  info = (message: string) => this.write('info', message);
  warn = (message: string) => this.write('warn', message);
  error = (message: string) => this.write('error', message);

  private prune(): void {
    const cutoff = this.now().getTime() - KEEP_DAYS * 24 * 3600 * 1000;
    for (const name of fs.readdirSync(this.dir)) {
      if (!/^main-\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue;
      const file = path.join(this.dir, name);
      if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
    }
  }
}
