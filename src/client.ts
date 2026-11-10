import OpenAI from 'openai';
import { AliaConfig, AliaModelConfig } from './config.js';

export interface AliaClientInstance {
  client: OpenAI;
  model: string;
  modelConfig: AliaModelConfig;
}

export function createAliaClient(config: AliaConfig, selectedModelId?: string): AliaClientInstance {
  let modelConfig = selectedModelId
    ? config.models.find(m => m.id === selectedModelId || m.name === selectedModelId)
    : config.models[0];

  // If user selected a model id that exists on the endpoint but isn't explicitly defined in config,
  // construct a dynamic model config using the base endpoint url
  if (!modelConfig && selectedModelId) {
    const baseModel = config.models[0];
    modelConfig = {
      id: selectedModelId,
      name: selectedModelId,
      url: baseModel.url,
      toolCalling: true,
      maxInputTokens: baseModel.maxInputTokens || 128000,
      maxOutputTokens: baseModel.maxOutputTokens || 16000,
    };
  }

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

export async function fetchAvailableModels(client: OpenAI): Promise<string[]> {
  try {
    const list = await client.models.list();
    return list.data.map(m => m.id);
  } catch {
    return [];
  }
}
