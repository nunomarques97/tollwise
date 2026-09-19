// POST /v1/chat/completions: an OpenAI Chat Completions request, routed to the provider chosen for it.
//
// The flow (inspection, routing, the x-tollwise-* headers, relaying the answer) is the one every chat
// endpoint shares, in ./forward.ts; the handler is in ./chat.ts. What is specific to the OpenAI format
// lives here:
// - Errors use the OpenAI error shape, `{ "error": { "message", "type", "param", "code" } }`.
// - A provider that speaks the Anthropic format is reached through translation (./cross-format.ts) when
//   the request can be translated without losing anything; the answer comes back in this format.
// - Usage: a non-streamed answer reports it in its `usage` object. A stream reports token usage only when
//   stream_options.include_usage is true. When the client set it, the stream reaches the client byte for
//   byte as the provider sent it. When it did not, Tollwise sets it upstream (keeping the client's other
//   stream options) and removes the extra usage-only chunk (`"choices": []`) from what the client
//   receives, so the client gets the stream it asked for. A provider that reports usage on a chunk that
//   also carries choices is relayed unchanged. A stream that stops early gets no made-up
//   `data: [DONE]`.

import { sendError } from '../server/respond.ts';
import {
  isCount,
  isRecord,
  type OutboundPlan,
  type ProxyProtocol,
  type ReportedUsage,
  type StreamWatch,
} from './forward.ts';
import type { SseEvent, SseVerdict } from './sse.ts';

/** Reads an OpenAI `usage` object; null when it is missing or not a usage report. */
export function readOpenAiUsage(value: unknown): ReportedUsage | null {
  if (!isRecord(value) || !isCount(value.prompt_tokens) || !isCount(value.completion_tokens)) return null;
  const details = value.prompt_tokens_details;
  const cached = isRecord(details) && isCount(details.cached_tokens) ? details.cached_tokens : null;
  return { input: value.prompt_tokens, cachedInput: cached, output: value.completion_tokens };
}

const USAGE_KEY = Buffer.from('"usage"');

function isWhitespaceByte(byte: number | undefined): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

/**
 * True when a stream chunk's JSON text has a "usage" key whose value is an object. A cheap byte check
 * run on every chunk, so only the chunk that reports usage is parsed (OpenAI sends `"usage": null` on
 * every other chunk when usage is requested).
 */
export function hasUsageObject(data: Buffer): boolean {
  let from = 0;
  for (;;) {
    const found = data.indexOf(USAGE_KEY, from);
    if (found === -1) return false;
    let at = found + USAGE_KEY.length;
    while (isWhitespaceByte(data[at])) at += 1;
    if (data[at] === 0x3a) {
      at += 1;
      while (isWhitespaceByte(data[at])) at += 1;
      if (data[at] === 0x7b) return true;
    }
    from = found + USAGE_KEY.length;
  }
}

/** Reads the usage a stream chunk reports; null for a chunk without a usage object. */
function streamChunkUsage(data: Buffer): { readonly usage: ReportedUsage; readonly usageOnly: boolean } | null {
  if (!hasUsageObject(data)) return null;
  let chunk: unknown;
  try {
    chunk = JSON.parse(data.toString('utf8'));
  } catch {
    return null;
  }
  if (!isRecord(chunk)) return null;
  const usage = readOpenAiUsage(chunk.usage);
  if (usage === null) return null;
  // The extra chunk include_usage adds carries no choice at all.
  return { usage, usageOnly: Array.isArray(chunk.choices) && chunk.choices.length === 0 };
}

/**
 * Whether usage has to be asked for upstream. A streamed response reports usage only when
 * stream_options.include_usage is true; when the client did not set it, Tollwise sets it (keeping any
 * other stream option) and later removes the extra chunk it adds. A stream_options value that is not an
 * object is left for the provider to judge, unchanged.
 */
function usageStreamOptions(body: Record<string, unknown>, stream: boolean): string | undefined {
  if (!stream) return undefined;
  const options = body.stream_options;
  if (isRecord(options) && options.include_usage === true) return undefined;
  if (options !== undefined && options !== null && !isRecord(options)) return undefined;
  return JSON.stringify({ ...(isRecord(options) ? options : {}), include_usage: true });
}

function watchOpenAiStream(hold: boolean): StreamWatch {
  let usage: ReportedUsage | null = null;
  return {
    hold,
    onEvent(event: SseEvent): SseVerdict {
      const found = streamChunkUsage(event.data);
      if (found === null) return 'forward';
      usage = found.usage;
      // Holding events back (to drop the usage chunk the client did not ask for) is only needed when
      // Tollwise asked for usage itself; otherwise every byte is forwarded as it arrives.
      return hold && found.usageOnly ? 'drop' : 'forward';
    },
    usage: () => usage,
  };
}

/** The OpenAI Chat Completions format, as the shared flow needs it. */
export const OPENAI_PROTOCOL: ProxyProtocol = {
  format: 'openai',
  apiName: 'OpenAI Chat Completions',
  logLabel: 'chat',
  sendError,
  checkHeaders: () => undefined,
  plan(body, stream): OutboundPlan {
    const streamOptions = usageStreamOptions(body, stream);
    return {
      edits: streamOptions === undefined ? {} : { stream_options: streamOptions },
      watchStream: () => watchOpenAiStream(streamOptions !== undefined),
    };
  },
  readBodyUsage: (body) => (isRecord(body) ? readOpenAiUsage(body.usage) : null),
};
