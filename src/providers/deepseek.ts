// DeepSeek. OpenAI-compatible; the default base URL https://api.deepseek.com serves the endpoints at its
// root (a base URL ending in /v1 works as well). Key from DEEPSEEK_API_KEY.

import { OpenAiCompatibleAdapter } from './openai-compatible.ts';
import type { ProviderAdapter, ProviderSettings } from './types.ts';

export function createDeepSeekAdapter(settings: ProviderSettings): ProviderAdapter {
  return new OpenAiCompatibleAdapter({
    id: 'deepseek',
    settings,
    chatPath: '/chat/completions',
    modelsPath: '/models',
  });
}
