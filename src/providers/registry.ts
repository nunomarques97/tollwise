// The set of providers Tollwise may route to, built from the loaded configuration and the environment.
// A provider is enabled when its configuration says `enabled: true`, an adapter exists for it, and its
// key variable (`api_key_env`) is set, or it needs no key (`api_key_env: null`, e.g. Ollama).
// The registry keeps adapters only; it never keeps the environment or any key.
//
// Adding a provider: write src/providers/<id>.ts exporting a factory (a few lines over
// OpenAiCompatibleAdapter for an OpenAI-compatible API) and add one line to ADAPTER_FACTORIES below.
// A provider id that is not in the configuration yet also needs an entry in PROVIDER_IDS and
// PROVIDER_DEFAULTS (src/config/schema.ts).

import type { Environment } from '../config/load.ts';
import { type Config, PROVIDER_IDS, type ProviderId } from '../config/schema.ts';
import { createAnthropicAdapter } from './anthropic.ts';
import { createDeepSeekAdapter } from './deepseek.ts';
import { createOllamaAdapter } from './ollama.ts';
import { createOpenAiAdapter } from './openai.ts';
import { createOpenRouterAdapter } from './openrouter.ts';
import type { AdapterFactory, ProviderAdapter } from './types.ts';

/** One line per provider with an adapter. A configured provider missing here is reported as `no_adapter`. */
export const ADAPTER_FACTORIES: Readonly<Partial<Record<ProviderId, AdapterFactory>>> = {
  anthropic: createAnthropicAdapter,
  openai: createOpenAiAdapter,
  deepseek: createDeepSeekAdapter,
  openrouter: createOpenRouterAdapter,
  ollama: createOllamaAdapter,
};

/** Why a configured provider is not in the enabled set. */
export type ExclusionReason = 'disabled' | 'missing_key' | 'no_adapter';

export interface ExcludedProvider {
  readonly id: ProviderId;
  readonly reason: ExclusionReason;
  /** Name of the key variable the provider needs (for a message such as "set OPENAI_API_KEY"). */
  readonly apiKeyEnv: string | null;
}

export interface ProviderRegistry {
  /** Enabled adapters, in configuration order. */
  readonly enabled: readonly ProviderAdapter[];
  /** Configured providers left out, with the reason. */
  readonly excluded: readonly ExcludedProvider[];
  get(id: ProviderId): ProviderAdapter | undefined;
}

/**
 * Builds the registry. `env` is only consulted to see which keys are present; adapters read the key
 * again from the environment at call time.
 */
export function buildRegistry(
  config: Pick<Config, 'providers'>,
  env: Environment,
  factories: Readonly<Partial<Record<ProviderId, AdapterFactory>>> = ADAPTER_FACTORIES,
): ProviderRegistry {
  const enabled: ProviderAdapter[] = [];
  const excluded: ExcludedProvider[] = [];

  for (const id of PROVIDER_IDS) {
    const settings = config.providers[id];
    const apiKeyEnv = settings.api_key_env;
    if (!settings.enabled) {
      excluded.push(Object.freeze({ id, reason: 'disabled', apiKeyEnv }));
      continue;
    }
    const factory = factories[id];
    if (factory === undefined) {
      excluded.push(Object.freeze({ id, reason: 'no_adapter', apiKeyEnv }));
      continue;
    }
    const adapter = factory({ base_url: settings.base_url, api_key_env: apiKeyEnv });
    if (!adapter.isConfigured(env)) {
      excluded.push(Object.freeze({ id, reason: 'missing_key', apiKeyEnv }));
      continue;
    }
    enabled.push(Object.freeze(adapter));
  }

  const byId = new Map(enabled.map((adapter) => [adapter.id, adapter] as const));
  return Object.freeze({
    enabled: Object.freeze(enabled),
    excluded: Object.freeze(excluded),
    get: (id: ProviderId) => byId.get(id),
  });
}
