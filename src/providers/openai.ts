// OpenAI. Default base URL https://api.openai.com/v1; key from OPENAI_API_KEY.

import { OpenAiCompatibleAdapter } from './openai-compatible.ts';
import type { ProviderAdapter, ProviderSettings } from './types.ts';

export function createOpenAiAdapter(settings: ProviderSettings): ProviderAdapter {
  return new OpenAiCompatibleAdapter({ id: 'openai', settings, chatPath: '/chat/completions', modelsPath: '/models' });
}
