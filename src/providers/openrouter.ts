// OpenRouter. OpenAI-compatible at https://openrouter.ai/api/v1; key from OPENROUTER_API_KEY.

import { OpenAiCompatibleAdapter } from './openai-compatible.ts';
import type { ProviderAdapter, ProviderSettings } from './types.ts';

export function createOpenRouterAdapter(settings: ProviderSettings): ProviderAdapter {
  return new OpenAiCompatibleAdapter({
    id: 'openrouter',
    settings,
    chatPath: '/chat/completions',
    modelsPath: '/models',
  });
}
