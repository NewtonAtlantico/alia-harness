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
 * Loads environment variables from a local .env file.
 * Uses Node's native process.loadEnvFile() when available, with a safe fallback parser.
 */
export function loadEnv(): void {
  const envCandidates = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), '../.env'),
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

export function findConfigFile(customPath?: string): string {
  if (customPath && fs.existsSync(customPath)) {
    return path.resolve(customPath);
  }

  const envPath = process.env.ALIA_CONFIG;
  if (envPath && fs.existsSync(envPath)) {
    return path.resolve(envPath);
  }

  const defaultLocations = [
    path.resolve(process.cwd(), 'alia-config.json'),
    path.resolve(process.cwd(), '../alia-config.json'),
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

export function loadConfig(configPath?: string): AliaConfig {
  // Always load .env file before reading config
  loadEnv();

  const resolvedPath = findConfigFile(configPath);
  try {
    const raw = fs.readFileSync(resolvedPath, 'utf-8');
    const parsed = JSON.parse(raw) as AliaConfig;

    // Highest priority: environment variable from .env or system environment
    const envApiKey = process.env.ALIA_API_KEY || process.env.OPENAI_API_KEY;
    if (envApiKey) {
      parsed.apiKey = envApiKey;
    }

    if (!parsed.apiKey) {
      throw new Error(
        'Missing API key. Please define ALIA_API_KEY in your .env file or environment variables.'
      );
    }

    if (!parsed.models || !Array.isArray(parsed.models) || parsed.models.length === 0) {
      throw new Error('Config file must specify at least one model in "models" array.');
    }

    return parsed;
  } catch (err: any) {
    throw new Error(`Failed to load configuration from ${resolvedPath}: ${err.message}`);
  }
}
