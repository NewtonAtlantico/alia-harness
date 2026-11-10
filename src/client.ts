import OpenAI from 'openai';
import { AliaConfig, AliaModelConfig } from './config.js';

export interface AliaClientInstance {
  client: OpenAI;
  model: string;
  modelConfig: AliaModelConfig;
}

export function createAliaClient(config: AliaConfig, selectedModelId?: string): AliaClientInstance {
  const modelConfig = selectedModelId
    ? config.models.find(m => m.id === selectedModelId || m.name === selectedModelId)
    : config.models[0];

  if (!modelConfig) {
    const available = config.models.map(m => m.id).join(', ');
    throw new Error(
      `Model "${selectedModelId}" not found in config. Available models: ${available}`
    );
  }

  // Ensure baseURL has no duplicate slashes or proper trailing slash
  const baseURL = modelConfig.url.endsWith('/') ? modelConfig.url : `${modelConfig.url}/`;

  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: baseURL,
  });

  return {
    client,
    model: modelConfig.id,
    modelConfig,
  };
}
