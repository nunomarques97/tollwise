// Normalisation of provider failures, shared by every adapter. Status codes carry most of the meaning;
// the body only supplies a human-readable message, which is masked before it leaves this module because
// providers sometimes echo part of the key they rejected.

import { redactText } from '../log/redact.ts';
import type { ProviderError, ProviderErrorKind, ProviderFailure } from './types.ts';

/** Longest provider message kept, in characters; error bodies can be whole HTML pages. */
export const MAX_ERROR_MESSAGE_LENGTH = 500;

/**
 * The error kind an HTTP status means on its own.
 * - 408, 504 and 524 (a gateway gave up waiting) are timeouts.
 * - 503 and 529 mean the provider is shedding load: overloaded, try elsewhere.
 * - 401, 403 and 402 (no credit left) mean these credentials cannot be used.
 */
export function kindFromStatus(status: number): ProviderErrorKind {
  if (!Number.isInteger(status) || status < 400 || status > 599) return 'unknown';
  if (status === 429) return 'rate_limit';
  if (status === 401 || status === 402 || status === 403) return 'auth';
  if (status === 408 || status === 504 || status === 524) return 'timeout';
  if (status === 503 || status === 529) return 'overloaded';
  if (status >= 500) return 'server';
  return 'bad_request';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function rawMessage(body: unknown): string | undefined {
  if (typeof body === 'string') {
    const text = body.trim();
    if (text === '') return undefined;
    try {
      return rawMessage(JSON.parse(text));
    } catch {
      return text;
    }
  }
  const record = asRecord(body);
  if (record === undefined) return undefined;
  // OpenAI, DeepSeek, OpenRouter and Anthropic: { error: { message } }; Ollama: { error: "text" }.
  const error = record.error;
  if (typeof error === 'string') return error;
  const nested = asRecord(error)?.message;
  if (typeof nested === 'string') return nested;
  if (typeof record.message === 'string') return record.message;
  return undefined;
}

/** The provider's error message from a response body, credentials masked and length capped. */
export function errorMessage(body: unknown): string | undefined {
  const message = rawMessage(body);
  if (message === undefined) return undefined;
  const oneLine = message.replace(/\s+/g, ' ').trim();
  if (oneLine === '') return undefined;
  const masked = redactText(oneLine);
  return masked.length > MAX_ERROR_MESSAGE_LENGTH ? `${masked.slice(0, MAX_ERROR_MESSAGE_LENGTH)}...` : masked;
}

/** The shared mapError: status decides the kind, the body supplies the message. */
export function mapProviderError(status: ProviderFailure, body?: unknown): ProviderError {
  if (status === 'timeout') return { kind: 'timeout', status: null, message: undefined };
  if (status === 'connection') return { kind: 'connection', status: null, message: undefined };
  return { kind: kindFromStatus(status), status, message: errorMessage(body) };
}
