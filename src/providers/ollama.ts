// Ollama, running locally. Its OpenAI-compatible API lives under /v1 of the server root
// (default http://127.0.0.1:11434). No key by default, so no Authorization header is sent; setting
// api_key_env (e.g. for an Ollama behind an authenticating reverse proxy) sends a bearer key.

import { OpenAiCompatibleAdapter } from './openai-compatible.ts';
import type { ProviderAdapter, ProviderSettings } from './types.ts';

export function createOllamaAdapter(settings: ProviderSettings): ProviderAdapter {
  return new OpenAiCompatibleAdapter({
    id: 'ollama',
    settings,
    chatPath: '/v1/chat/completions',
    modelsPath: '/v1/models',
  });
}
