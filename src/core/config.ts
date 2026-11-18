import fs from 'node:fs';
import path from 'node:path';

export interface AliaModelConfig {
  id: string;
  name: string;
  url: string;
  toolCalling: boolean;
  vision?: boolean;
  maxInputTokens?: number;
  maxOutputTokens?: number;
}

export interface AliaConfig {
  name: string;
  vendor: string;
  apiKey: string;
  apiType: string;
  models: AliaModelConfig[];
}

/**
 * Loads environment variables from a `.env` file in `baseDir` (or its parent).
 * Uses Node's native process.loadEnvFile() when available, with a safe fallback parser.
 * Opt-in and explicit: core never reads the process working directory.
 */
export function loadEnv(baseDir: string): void {
  const envCandidates = [
    path.resolve(baseDir, '.env'),
    path.resolve(baseDir, '../.env'),
  ];

  for (const envFile of envCandidates) {
    if (fs.existsSync(envFile)) {
      if (typeof (process as any).loadEnvFile === 'function') {
        try {
          (process as any).loadEnvFile(envFile);
        } catch {
          parseAndInjectEnv(envFile);
        }
      } else {
        parseAndInjectEnv(envFile);
      }
      break;
    }
  }
}

function parseAndInjectEnv(envFile: string): void {
  try {
    const content = fs.readFileSync(envFile, 'utf-8');
    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eqIdx = line.indexOf('=');
      if (eqIdx !== -1) {
        const key = line.slice(0, eqIdx).trim();
        const value = line.slice(eqIdx + 1).trim().replace(/^['"](.*)['"]$/, '$1');
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
    }
  } catch {}
}

export interface LoadConfigOptions {
  /** Directory that relative paths and the default `alia-config.json` / `.env` lookups start from. */
  baseDir: string;
  /** Explicit config file (absolute, or relative to `baseDir`). */
  configPath?: string;
  /** Also read a `.env` next to the config lookup (default true). Hosts that keep secrets elsewhere pass false. */
  loadEnvFile?: boolean;
}

export function findConfigFile(baseDir: string, customPath?: string): string {
  if (customPath) {
    const resolved = path.resolve(baseDir, customPath);
    if (fs.existsSync(resolved)) return resolved;
  }

  const envPath = process.env.ALIA_CONFIG;
  if (envPath) {
    const resolved = path.resolve(baseDir, envPath);
    if (fs.existsSync(resolved)) return resolved;
  }

  const defaultLocations = [
    path.resolve(baseDir, 'alia-config.json'),
    path.resolve(baseDir, '../alia-config.json'),
  ];

  for (const loc of defaultLocations) {
    if (fs.existsSync(loc)) {
      return loc;
    }
  }

  throw new Error(
    `Configuration file not found. Checked: ${defaultLocations.join(', ')}. ` +
    `Ensure alia-config.json exists or pass the path via --config or ALIA_CONFIG env var.`
  );
}

/**
 * Checks an in-memory config (for hosts that build it themselves, e.g. a desktop app that keeps
 * the API key in the OS secret store). Throws a readable error when it cannot be used.
 */
export function validateConfig(config: AliaConfig): AliaConfig {
  if (!config.apiKey) {
    throw new Error(
      'Missing API key. Please define ALIA_API_KEY in your .env file or environment variables.'
    );
  }
  if (!config.models || !Array.isArray(config.models) || config.models.length === 0) {
    throw new Error('Config file must specify at least one model in "models" array.');
  }
  return config;
}

export function loadConfig(options: LoadConfigOptions): AliaConfig {
  if (options.loadEnvFile !== false) loadEnv(options.baseDir);

  const resolvedPath = findConfigFile(options.baseDir, options.configPath);
  try {
    const raw = fs.readFileSync(resolvedPath, 'utf-8');
    const parsed = JSON.parse(raw) as AliaConfig;

    // Highest priority: environment variable from .env or system environment
    const envApiKey = process.env.ALIA_API_KEY || process.env.OPENAI_API_KEY;
    if (envApiKey) {
      parsed.apiKey = envApiKey;
    }

    return validateConfig(parsed);
  } catch (err: any) {
    throw new Error(`Failed to load configuration from ${resolvedPath}: ${err.message}`);
  }
}
