// The shared adapter for every provider that speaks the OpenAI Chat Completions format: bearer
// authentication, a chat completions endpoint and a free models list for health checks.

import { type Environment, isEnvSet } from '../config/load.ts';
import type { ProviderId } from '../config/schema.ts';
import { isCleartextRemoteUrl } from '../config/schema.ts';
import { mapProviderError } from './errors.ts';
import type { HealthRequest, ProviderAdapter, ProviderError, ProviderFailure, ProviderSettings } from './types.ts';

export interface OpenAiCompatibleOptions {
  readonly id: ProviderId;
  readonly settings: ProviderSettings;
  /** Chat endpoint path relative to the base URL, e.g. '/chat/completions'. */
  readonly chatPath: string;
  /** Models list path relative to the base URL, e.g. '/models'. */
  readonly modelsPath: string;
}

/** Removes trailing slashes so that `baseUrl + path` never produces '//'. */
export function trimBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

export class OpenAiCompatibleAdapter implements ProviderAdapter {
  readonly id: ProviderId;
  readonly wireFormat = 'openai' as const;
  readonly baseUrl: string;
  readonly chatPath: string;
  readonly healthRequest: HealthRequest;
  /** Name (never the value) of the environment variable holding the key; null when no key is sent. */
  readonly apiKeyEnv: string | null;

  constructor(options: OpenAiCompatibleOptions) {
    this.id = options.id;
    this.baseUrl = trimBaseUrl(options.settings.base_url);
    this.chatPath = options.chatPath;
    this.healthRequest = { method: 'GET', path: options.modelsPath };
    this.apiKeyEnv = options.settings.api_key_env;
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
    return { authorization: `Bearer ${key}` };
  }

  url(path: string): string {
    return `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  }

  mapError(status: ProviderFailure, body?: unknown): ProviderError {
    return mapProviderError(status, body);
  }
}
