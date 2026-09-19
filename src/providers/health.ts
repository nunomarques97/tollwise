// Sends an adapter's free health request (a models list) and reduces the outcome to ok or a normalised
// ProviderError. Nothing here logs; the fetch error text is dropped because it can repeat the URL.

import type { Environment } from '../config/load.ts';
import type { ProviderAdapter, ProviderError } from './types.ts';

export const DEFAULT_HEALTH_TIMEOUT_MS = 5000;
/** Error bodies are read up to this many bytes; the rest is discarded. */
export const MAX_ERROR_BODY_BYTES = 64 * 1024;

export type HealthResult =
  | { readonly ok: true; readonly status: number }
  | { readonly ok: false; readonly error: ProviderError };

export interface HealthOptions {
  readonly timeoutMs?: number;
  /** Aborts the request without touching its result; the caller decides what an aborted check means. */
  readonly signal?: AbortSignal;
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, maxBytes));
}

function isTimeout(error: unknown): boolean {
  return error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

/**
 * Runs the health request once. A missing key is reported as an auth error without any network call.
 * When `options.signal` fires (see HealthMonitor.stop()), the request is aborted the same as a timeout;
 * the caller is expected to recognise that signal and discard the result rather than treat it as a
 * real failure.
 */
export async function checkHealth(
  adapter: ProviderAdapter,
  env: Environment,
  options: HealthOptions = {},
): Promise<HealthResult> {
  if (!adapter.isConfigured(env)) {
    return { ok: false, error: { kind: 'auth', status: null, message: 'no key configured' } };
  }
  const { method, path } = adapter.healthRequest;
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS);
  const signal = options.signal !== undefined ? AbortSignal.any([timeoutSignal, options.signal]) : timeoutSignal;
  let response: Response;
  try {
    response = await fetch(adapter.url(path), {
      method,
      headers: { accept: 'application/json', ...adapter.authHeaders(env) },
      redirect: 'error',
      signal,
    });
  } catch (error) {
    if (isTimeout(error)) return { ok: false, error: adapter.mapError('timeout') };
    return { ok: false, error: { kind: 'unknown', status: null, message: 'connection failed' } };
  }
  if (response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return { ok: true, status: response.status };
  }
  let body = '';
  try {
    body = await readCapped(response, MAX_ERROR_BODY_BYTES);
  } catch {
    // The status alone still classifies the failure.
  }
  return { ok: false, error: adapter.mapError(response.status, body) };
}
