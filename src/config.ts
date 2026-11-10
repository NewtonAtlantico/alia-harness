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
  const resolvedPath = findConfigFile(configPath);
  try {
    const raw = fs.readFileSync(resolvedPath, 'utf-8');
    const parsed = JSON.parse(raw) as AliaConfig;

    if (!parsed.apiKey && process.env.ALIA_API_KEY) {
      parsed.apiKey = process.env.ALIA_API_KEY;
    }

    if (!parsed.models || !Array.isArray(parsed.models) || parsed.models.length === 0) {
      throw new Error('Config file must specify at least one model in "models" array.');
    }

    return parsed;
  } catch (err: any) {
    throw new Error(`Failed to load configuration from ${resolvedPath}: ${err.message}`);
  }
}
