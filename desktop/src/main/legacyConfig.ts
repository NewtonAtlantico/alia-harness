import fs from 'node:fs';
import path from 'node:path';
import type { AliaConfig } from 'alia-harness/core';
import type { ModelSetting, SettingsView } from '../shared/ipc';

/** A configuration from the CLI's setup: `alia-config.json`, with the key from the environment or a `.env` beside it. */
export interface LegacyConfig {
  endpointUrl: string;
  models: ModelSetting[];
  apiKey?: string;
}

const CONFIG_NAME = 'alia-config.json';

/** The first `alia-config.json` found in the given folders (and their parents), or the one named by ALIA_CONFIG. */
export function findLegacyConfig(folders: string[], env: NodeJS.ProcessEnv = process.env): string | undefined {
  const candidates: string[] = [];
  if (env.ALIA_CONFIG) candidates.push(path.resolve(env.ALIA_CONFIG));
  for (const folder of folders) candidates.push(path.join(folder, CONFIG_NAME), path.join(folder, '..', CONFIG_NAME));
  return candidates.find((c) => fs.statSync(c, { throwIfNoEntry: false })?.isFile());
}

function readEnvKey(file: string): string | undefined {
  try {
    for (const raw of fs.readFileSync(file, 'utf-8').split(/\r?\n/)) {
      const m = /^\s*(ALIA_API_KEY|OPENAI_API_KEY)\s*=\s*(.*)$/.exec(raw);
      if (m) return m[2].trim().replace(/^['"](.*)['"]$/, '$1') || undefined;
    }
  } catch {
    /* no .env */
  }
  return undefined;
}

/** Reads a legacy config. Throws a readable error when the file is not one. */
export function readLegacyConfig(file: string, env: NodeJS.ProcessEnv = process.env): LegacyConfig {
  let parsed: Partial<AliaConfig>;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err: any) {
    throw new Error(`Could not read ${path.basename(file)}: ${err?.message ?? err}`);
  }
  const list = Array.isArray(parsed.models) ? parsed.models : [];
  const models: ModelSetting[] = [];
  for (const m of list) {
    if (!m || typeof m.id !== 'string' || !m.id) continue;
    models.push({
      id: m.id,
      name: typeof m.name === 'string' && m.name ? m.name : m.id,
      ...(typeof m.maxInputTokens === 'number' && m.maxInputTokens > 0 ? { maxInputTokens: m.maxInputTokens } : {}),
      ...(typeof m.maxOutputTokens === 'number' && m.maxOutputTokens > 0 ? { maxOutputTokens: m.maxOutputTokens } : {}),
      ...(typeof m.toolCalling === 'boolean' ? { toolCalling: m.toolCalling } : {}),
      ...(typeof m.vision === 'boolean' ? { vision: m.vision } : {}),
    });
  }
  const endpointUrl = list.find((m) => typeof m?.url === 'string' && m.url)?.url;
  if (models.length === 0 || !endpointUrl) throw new Error(`${path.basename(file)} has no models with an address (url).`);

  const apiKey =
    env.ALIA_API_KEY ||
    env.OPENAI_API_KEY ||
    readEnvKey(path.join(path.dirname(file), '.env')) ||
    readEnvKey(path.join(path.dirname(file), '..', '.env')) ||
    (typeof parsed.apiKey === 'string' && parsed.apiKey ? parsed.apiKey : undefined);
  return { endpointUrl, models, ...(apiKey ? { apiKey } : {}) };
}

/** The configuration the engine (core) is given: one endpoint, the models, and the key. */
export function buildEngineConfig(view: Pick<SettingsView, 'endpointUrl' | 'models'>, apiKey: string): AliaConfig {
  return {
    name: 'alia',
    vendor: 'custom',
    apiKey,
    apiType: 'chat-completions',
    models: view.models.map((m) => ({
      id: m.id,
      name: m.name,
      url: view.endpointUrl,
      toolCalling: m.toolCalling ?? true,
      ...(m.vision !== undefined ? { vision: m.vision } : {}),
      ...(m.maxInputTokens ? { maxInputTokens: m.maxInputTokens } : {}),
      ...(m.maxOutputTokens ? { maxOutputTokens: m.maxOutputTokens } : {}),
    })),
  };
}

/** Skill folders the engine scans. Project skills are left out on purpose (they load only for trusted folders, A5). */
export function skillRoots(bundledDir: string, userDir: string): Array<{ label: string; dir: string }> {
  return [
    { label: 'bundled', dir: bundledDir },
    { label: 'user', dir: userDir },
  ];
}
