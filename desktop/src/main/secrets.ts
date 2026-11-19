import fs from 'node:fs';
import path from 'node:path';

/** What the OS secret store offers (Electron's `safeStorage`: DPAPI on Windows). A fake stands in for it in tests. */
export interface Encryptor {
  isAvailable(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(data: Buffer): string;
}

export class SecureStorageUnavailableError extends Error {
  constructor() {
    super('This computer cannot encrypt secrets, so the API key cannot be stored. It is never written in plain text.');
    this.name = 'SecureStorageUnavailableError';
  }
}

/**
 * The API key, encrypted with the operating system and kept in one file. It is read only in main (and handed to
 * the engine in memory). When the OS cannot encrypt, nothing is stored: there is no plain-text fallback.
 */
export class SecretStore {
  constructor(
    private readonly file: string,
    private readonly encryptor: Encryptor
  ) {}

  get available(): boolean {
    return this.encryptor.isAvailable();
  }

  /** The key, or undefined if none is stored or it cannot be decrypted (a different user or machine). */
  get(): string | undefined {
    try {
      const plain = this.encryptor.decrypt(fs.readFileSync(this.file));
      const key = (JSON.parse(plain) as { apiKey?: unknown }).apiKey;
      return typeof key === 'string' && key ? key : undefined;
    } catch {
      return undefined;
    }
  }

  has(): boolean {
    return this.get() !== undefined;
  }

  set(apiKey: string): void {
    if (!this.encryptor.isAvailable()) throw new SecureStorageUnavailableError();
    const data = this.encryptor.encrypt(JSON.stringify({ apiKey }));
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, this.file);
  }

  clear(): void {
    fs.rmSync(this.file, { force: true });
  }
}
