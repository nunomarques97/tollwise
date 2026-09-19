// Anthropic. Default base URL https://api.anthropic.com; key from ANTHROPIC_API_KEY.
//
// Anthropic's Messages API speaks its own wire format (not OpenAI-compatible): the key travels in
// x-api-key rather than Authorization, every request carries an anthropic-version header, and the chat
// endpoint is /v1/messages. Error bodies are shaped { type: 'error', error: { type, message } }, but
// mapProviderError() already reads { error: { message } } for any object shape, and every Anthropic
// error type maps to a ProviderErrorKind through its HTTP status alone (kindFromStatus in errors.ts),
// so no Anthropic-specific error-type parsing is needed here.

import { type Environment, isEnvSet } from '../config/load.ts';
import { isCleartextRemoteUrl } from '../config/schema.ts';
import { mapProviderError } from './errors.ts';
import type { HealthRequest, ProviderAdapter, ProviderError, ProviderFailure, ProviderSettings } from './types.ts';

/** Anthropic Messages API version sent on every request; there is no per-provider override for it. */
export const ANTHROPIC_VERSION = '2023-06-01';

export class AnthropicAdapter implements ProviderAdapter {
  readonly id = 'anthropic' as const;
  readonly wireFormat = 'anthropic' as const;
  readonly baseUrl: string;
  readonly chatPath = '/v1/messages';
  readonly healthRequest: HealthRequest = { method: 'GET', path: '/v1/models' };
  /** Name (never the value) of the environment variable holding the key; null when no key is sent. */
  readonly apiKeyEnv: string | null;

  constructor(settings: ProviderSettings) {
    this.baseUrl = settings.base_url.replace(/\/+$/, '');
    this.apiKeyEnv = settings.api_key_env;
  }

  isConfigured(env: Environment): boolean {
    return this.apiKeyEnv === null || isEnvSet(env, this.apiKeyEnv);
  }

  authHeaders(env: Environment): Record<string, string> {
    if (this.apiKeyEnv === null) return {};
    const key = env[this.apiKeyEnv]?.trim();
    if (key === undefined || key === '') {
      throw new Error(`${this.id}: the environment variable ${this.apiKeyEnv} is not set`);
    }
    // The configuration refuses this combination; checked again here because this is where a key
    // would actually leave the machine.
    if (isCleartextRemoteUrl(this.baseUrl)) {
      throw new Error(`${this.id}: refusing to send ${this.apiKeyEnv} over plain http:// to a remote host`);
    }
    return { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION };
  }

  url(path: string): string {
    return `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  }

  mapError(status: ProviderFailure, body?: unknown): ProviderError {
    return mapProviderError(status, body);
  }
}

export function createAnthropicAdapter(settings: ProviderSettings): ProviderAdapter {
  return new AnthropicAdapter(settings);
}
