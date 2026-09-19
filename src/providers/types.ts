// The contract every upstream provider implements. An adapter knows where a provider lives, which wire
// format it speaks, how to authenticate to it and how to read its errors. It never holds a credential:
// the key is read from the environment each time authHeaders() is called and handed straight to the
// caller, so an adapter can be logged, inspected or serialised without leaking anything.

import type { Environment } from '../config/load.ts';
import type { ProviderId } from '../config/schema.ts';

/** The request/response format a provider speaks on its chat endpoint. */
export type WireFormat = 'openai' | 'anthropic';

export const PROVIDER_ERROR_KINDS = [
  'rate_limit',
  'overloaded',
  'server',
  'timeout',
  'connection',
  'auth',
  'bad_request',
  'unknown',
] as const;

/** A provider failure reduced to what routing and fallback decisions need. */
export type ProviderErrorKind = (typeof PROVIDER_ERROR_KINDS)[number];

/**
 * What failed: an HTTP status from the provider, no answer in time, or no usable connection (refused,
 * reset, DNS or TLS failure).
 */
export type ProviderFailure = number | 'timeout' | 'connection';

export interface ProviderError {
  readonly kind: ProviderErrorKind;
  /** The HTTP status the provider answered with; null when there was no HTTP answer (timeout, connection). */
  readonly status: number | null;
  /** The provider's own error message with credentials masked, when the body carried one. */
  readonly message: string | undefined;
}

/** A request that costs nothing and tells whether the provider is reachable (and, for most, the key valid). */
export interface HealthRequest {
  readonly method: 'GET';
  /** Path appended to the adapter's baseUrl. */
  readonly path: string;
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly wireFormat: WireFormat;
  /** Base URL from the configuration, without a trailing slash. */
  readonly baseUrl: string;
  /** Path of the chat endpoint, appended to baseUrl. */
  readonly chatPath: string;
  readonly healthRequest: HealthRequest;
  /** True when every credential this provider needs is present in `env`. */
  isConfigured(env: Environment): boolean;
  /**
   * The headers that authenticate one outbound request, built from `env` at call time. Empty for a
   * provider that needs no key. Throws when a key is required and missing. Never log the result.
   */
  authHeaders(env: Environment): Record<string, string>;
  /** Absolute URL for a path on this provider (e.g. chatPath or healthRequest.path). */
  url(path: string): string;
  /** Normalises a failed call: an HTTP status plus the (parsed or raw) body, a timeout or no connection. */
  mapError(status: ProviderFailure, body?: unknown): ProviderError;
}

/** The per-provider settings an adapter is built from (one entry of `providers` in the configuration). */
export interface ProviderSettings {
  readonly base_url: string;
  readonly api_key_env: string | null;
}

/** Builds one provider's adapter from its configured settings. */
export type AdapterFactory = (settings: ProviderSettings) => ProviderAdapter;
