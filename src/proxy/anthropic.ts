// POST /v1/messages: an Anthropic Messages request, routed to the provider chosen for it.
//
// The flow (inspection, routing, the x-tollwise-* headers, relaying the answer) is the one every chat
// endpoint shares, in ./forward.ts; the handler is in ./chat.ts. What is specific to the Anthropic format
// lives here:
// - Errors use the Anthropic error shape, `{ "type": "error", "error": { "type", "message" } }`, with the
//   error type the Anthropic API uses for the status (e.g. 429 rate_limit_error, 529 overloaded_error).
// - The anthropic-version header is required, as on the Anthropic API: a request without it is answered
//   400 before its body is read. The anthropic-version and anthropic-beta headers are forwarded to the
//   provider; the version sent is the one the Anthropic adapter pins (src/providers/anthropic.ts), since
//   Tollwise relays answers of that version.
// - A provider that speaks the OpenAI format (OpenRouter entries included) is reached through
//   translation (./cross-format.ts) when the request can be translated without losing anything; the
//   answer comes back in this format. The anthropic-version header is not sent to such a provider, and
//   a request with an anthropic-beta header is never translated (its beta feature would be lost).
// - Usage: a non-streamed answer reports it in its `usage` object; input counts the cache reads and cache
//   writes Anthropic reports apart from input_tokens. A streamed answer (`"stream": true`) is relayed
//   byte for byte as the provider sends it, every event untouched, while its usage is read on the way:
//   the message_start event carries the input counts (in message.usage), and each message_delta event
//   the running totals (usage.output_tokens, and on newer API versions the input counts too), which
//   replace the ones read before. Only those two events are parsed; every other event is only relayed.
//   A stream that stops early reports the counts read so far (its outcome says it was cut short).

import type { IncomingHttpHeaders } from 'node:http';
import { sendAnthropicError } from '../server/respond.ts';
import {
  isCount,
  isRecord,
  type ProxyProtocol,
  type Refusal,
  type ReportedUsage,
  type StreamWatch,
} from './forward.ts';
import type { SseEvent, SseVerdict } from './sse.ts';

export const ANTHROPIC_VERSION_HEADER = 'anthropic-version';

export const MISSING_VERSION_MESSAGE =
  'The anthropic-version header is required. Set it to the Anthropic API version your client targets, ' +
  'for example 2023-06-01 (the official Anthropic SDKs send it for you).';

/** Refuses a request without an anthropic-version header (or with an empty one). */
function checkVersionHeader(headers: IncomingHttpHeaders): Refusal | undefined {
  const value = headers[ANTHROPIC_VERSION_HEADER];
  const text = Array.isArray(value) ? value.join(', ') : value;
  if (text !== undefined && text.trim() !== '') return undefined;
  return {
    status: 400,
    type: 'invalid_request_error',
    code: 'missing_anthropic_version',
    message: MISSING_VERSION_MESSAGE,
  };
}

/**
 * Reads an Anthropic `usage` object; null when it is missing or not a usage report. Anthropic's
 * input_tokens leaves out the tokens read from and written to the prompt cache, so they are added back:
 * `input` is every input token, and `cachedInput` the cache reads (null when the answer does not say).
 */
export function readAnthropicUsage(value: unknown): ReportedUsage | null {
  if (!isRecord(value) || !isCount(value.input_tokens) || !isCount(value.output_tokens)) return null;
  const cacheRead = isCount(value.cache_read_input_tokens) ? value.cache_read_input_tokens : null;
  const cacheWrite = isCount(value.cache_creation_input_tokens) ? value.cache_creation_input_tokens : 0;
  return {
    input: value.input_tokens + (cacheRead ?? 0) + cacheWrite,
    cachedInput: cacheRead,
    output: value.output_tokens,
  };
}

/** The usage fields of an Anthropic stream, as last reported. */
interface StreamCounts {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

const COUNT_FIELDS = [
  'input_tokens',
  'output_tokens',
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
] as const;

const MESSAGE_START = 'message_start';
const MESSAGE_DELTA = 'message_delta';
const MESSAGE_START_BYTES = Buffer.from(`"${MESSAGE_START}"`);
const MESSAGE_DELTA_BYTES = Buffer.from(`"${MESSAGE_DELTA}"`);

/**
 * The type of a stream event that may carry usage (message_start or message_delta), else undefined. The
 * event name decides; an event without a name is recognised by a cheap byte check for its type, so the
 * content events that make up most of a stream are never parsed.
 */
function usageEventType(event: SseEvent): typeof MESSAGE_START | typeof MESSAGE_DELTA | undefined {
  if (event.name === MESSAGE_START || event.name === MESSAGE_DELTA) return event.name;
  if (event.name !== undefined) return undefined;
  if (event.data.includes(MESSAGE_START_BYTES)) return MESSAGE_START;
  if (event.data.includes(MESSAGE_DELTA_BYTES)) return MESSAGE_DELTA;
  return undefined;
}

/** Reads the usage object a message_start or message_delta event carries; undefined when it has none. */
function eventUsage(
  type: typeof MESSAGE_START | typeof MESSAGE_DELTA,
  data: Buffer,
): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.toString('utf8'));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed.type !== type) return undefined;
  const holder = type === MESSAGE_START ? parsed.message : parsed;
  return isRecord(holder) && isRecord(holder.usage) ? holder.usage : undefined;
}

/**
 * Watches an Anthropic stream: every byte is forwarded as it arrives, and the usage is read from
 * message_start (the starting counts) and message_delta (running totals that replace them, field by field).
 * Usage stays null until a message_start with input and output counts has been read.
 */
export function watchAnthropicStream(): StreamWatch {
  let counts: StreamCounts | null = null;
  return {
    hold: false,
    onEvent(event: SseEvent): SseVerdict {
      const type = usageEventType(event);
      if (type === undefined) return 'forward';
      const usage = eventUsage(type, event.data);
      if (usage === undefined) return 'forward';
      if (type === MESSAGE_START) {
        if (isCount(usage.input_tokens) && isCount(usage.output_tokens)) {
          counts = { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens };
          for (const field of COUNT_FIELDS) if (isCount(usage[field])) counts[field] = usage[field];
        }
      } else if (counts !== null) {
        for (const field of COUNT_FIELDS) if (isCount(usage[field])) counts[field] = usage[field];
      }
      return 'forward';
    },
    usage: () => (counts === null ? null : readAnthropicUsage(counts)),
  };
}

/** The Anthropic Messages format, as the shared flow needs it. */
export const ANTHROPIC_PROTOCOL: ProxyProtocol = {
  format: 'anthropic',
  apiName: 'Anthropic Messages',
  logLabel: 'messages',
  sendError: sendAnthropicError,
  checkHeaders: checkVersionHeader,
  plan: () => ({ edits: {}, watchStream: watchAnthropicStream }),
  readBodyUsage: (body) => (isRecord(body) ? readAnthropicUsage(body.usage) : null),
};
