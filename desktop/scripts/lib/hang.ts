import fs from 'node:fs';
import path from 'node:path';

/**
 * A long-running command that proves it is alive by touching a heartbeat file every 100 ms. "Dead" means the
 * heartbeat stopped (checking the pid is unreliable: Windows reuses pids quickly). Same idea as scripts/smoke-cancel.ts.
 */
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function makeHang(dir: string) {
  const script = path.join(dir, 'hang.js');
  fs.writeFileSync(
    script,
    "const fs = require('fs'); const hb = process.argv[2] + '.hb'; fs.writeFileSync(process.argv[2], String(process.pid)); setInterval(() => fs.writeFileSync(hb, String(Date.now())), 100);"
  );
  const STALE_MS = 700;
  const age = (pidFile: string): number => {
    try {
      return Date.now() - Number(fs.readFileSync(`${pidFile}.hb`, 'utf8'));
    } catch {
      return Infinity;
    }
  };
  const isRunning = (pidFile: string) => age(pidFile) < STALE_MS;
  return {
    /** The shell command that starts it. */
    command: (pidFile: string) => `node "${script.replace(/\\/g, '/')}" "${pidFile.replace(/\\/g, '/')}"`,
    async started(pidFile: string): Promise<boolean> {
      for (let i = 0; i < 200; i++) {
        if (isRunning(pidFile)) return true;
        await sleep(50);
      }
      return false;
    },
    isRunning,
    async diesWithin(pidFile: string, ms: number): Promise<boolean> {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (!isRunning(pidFile)) return true;
        await sleep(50);
      }
      return !isRunning(pidFile);
    },
  };
}
