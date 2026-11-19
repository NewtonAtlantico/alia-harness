import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AliaConfig } from 'alia-harness/core';

/**
 * Where the engine's configuration comes from until the settings screen exists (A4, which keeps the API key
 * in the OS secret store). For now: `ALIA_CONFIG` or the repository's `alia-config.json`, with the key from
 * `ALIA_API_KEY` or a `.env` beside it. The key is read here, in main, and only ever sent to the engine.
 */
export function loadBootConfig(repoRoot: string): AliaConfig | undefined {
  const file = process.env.ALIA_CONFIG ? path.resolve(process.env.ALIA_CONFIG) : path.join(repoRoot, 'alia-config.json');
  let parsed: AliaConfig;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as AliaConfig;
  } catch {
    return undefined;
  }
  const fromEnv = process.env.ALIA_API_KEY || process.env.OPENAI_API_KEY || readEnvFile(path.join(path.dirname(file), '.env'));
  if (fromEnv) parsed.apiKey = fromEnv;
  return parsed.apiKey && Array.isArray(parsed.models) && parsed.models.length > 0 ? parsed : undefined;
}

function readEnvFile(file: string): string | undefined {
  try {
    for (const raw of fs.readFileSync(file, 'utf-8').split(/\r?\n/)) {
      const line = raw.trim();
      const m = /^(ALIA_API_KEY|OPENAI_API_KEY)\s*=\s*(.*)$/.exec(line);
      if (m) return m[2].trim().replace(/^['"](.*)['"]$/, '$1') || undefined;
    }
  } catch {
    /* no .env */
  }
  return undefined;
}

/** Skill folders the engine scans. Project skills are left out on purpose (they load only for trusted folders, A5). */
export function skillRoots(bundledDir: string): Array<{ label: string; dir: string }> {
  return [
    { label: 'bundled', dir: bundledDir },
    { label: 'user', dir: path.join(os.homedir(), '.alia', 'skills') },
  ];
}
