// Serving a chat request through a provider of the other wire format: the request is translated to the
// provider's format before it is sent, and the provider's answer is translated back, so the client only
// ever sees its own format (src/translate holds the translation rules; this module applies them to one
// proxied request).
//
// - Request: translated all or nothing. Routing only picks such a provider when untranslatable() reports
//   nothing for the request, so the translation here never drops a feature.
// - Non-streamed answer: read whole (up to MAX_TRANSLATED_BODY_BYTES), then translated. An answer that
//   cannot be translated (content the client's format cannot carry, a malformed body) is never passed on
//   in part; the caller answers with an error instead.
// - Streamed answer: translated event by event as it arrives (OpenAIToAnthropicStream and
//   AnthropicToOpenAIStream). No byte of the provider's own stream reaches the client. A translation
//   problem mid-stream ends the client's stream with one error event in its format.
// - Usage is read from the provider's answer in the provider's own format, the same way as for a
//   same-format request, so what is recorded does not depend on the translation.
//
// Pure data handling, no I/O and no logging: the caller writes the bytes and reports the outcome.

import type { ProviderAdapter, WireFormat } from '../providers/types.ts';
import {
  AnthropicToOpenAIStream,
  formatAnthropicEvent,
  formatOpenAIItem,
  OpenAIToAnthropicStream,
  TranslationError,
  translateAnthropicRequestToOpenAI,
  translateAnthropicResponseToOpenAI,
  translateOpenAIRequestToAnthropic,
  translateOpenAIResponseToAnthropic,
} from '../translate/index.ts';
import type { StreamWatch } from './forward.ts';
import { type BodyScanner, type SseEvent, SseScanner } from './sse.ts';

/** Largest non-streamed provider answer read back to be translated, in bytes. */
export const MAX_TRANSLATED_BODY_BYTES = 16 * 1024 * 1024;

/** The content type of a translated stream, as both APIs send it. */
export const EVENT_STREAM_CONTENT_TYPE = 'text/event-stream; charset=utf-8';

/** The content type of a translated non-streamed answer. */
export const JSON_CONTENT_TYPE = 'application/json';

/**
 * Provider response headers not copied to a translated answer: they describe the provider's bytes, and
 * the client receives other ones.
 */
export const TRANSLATED_DROPPED_HEADERS: ReadonlySet<string> = new Set([
  'content-type',
  'content-length',
  'content-encoding',
  'content-md5',
  'etag',
]);

/** One request translated for a provider of the other format. */
export interface TranslatedRequest {
  /** The body to send, in the provider's format. */
  readonly body: Record<string, unknown>;
  /** The request asked for JSON mode (OpenAI client, Anthropic provider): the answer's forced tool call is the content. */
  readonly jsonMode: boolean;
}

/**
 * Translates `request` (in `clientFormat`) for `adapter`, which speaks the other format, asking it for
 * `model`. `anthropicBeta` is the anthropic-beta header an Anthropic request came with. A request sent
 * to OpenAI itself carries its budget as max_completion_tokens, the name every OpenAI chat model accepts;
 * other OpenAI-format providers get max_tokens. Throws TranslationError when the request cannot be
 * translated faithfully.
 */
export function translateRequest(
  request: unknown,
  clientFormat: WireFormat,
  adapter: ProviderAdapter,
  model: string,
  anthropicBeta: string | undefined,
): TranslatedRequest {
  if (clientFormat === 'openai') {
    const translated = translateOpenAIRequestToAnthropic(request, { model });
    return { body: { ...translated.body }, jsonMode: translated.jsonMode };
  }
  const body = translateAnthropicRequestToOpenAI(request, {
    model,
    maxTokensField: adapter.id === 'openai' ? 'max_completion_tokens' : 'max_tokens',
    anthropicBeta,
  });
  return { body: { ...body }, jsonMode: false };
}

/** What the client of an OpenAI Chat Completions request asked for with stream_options.include_usage. */
export function clientWantsStreamUsage(request: unknown): boolean {
  if (typeof request !== 'object' || request === null) return false;
  const options = (request as Record<string, unknown>).stream_options;
  return typeof options === 'object' && options !== null && (options as Record<string, unknown>).include_usage === true;
}

/**
 * Translates a complete non-streamed provider answer (its JSON text) to the client's format and returns
 * the JSON text to send. Throws TranslationError when it cannot be translated faithfully, including when
 * it is not JSON.
 */
export function translateResponseBody(
  text: string,
  clientFormat: WireFormat,
  options: { readonly created: number; readonly jsonMode: boolean },
): string {
  const providerFormat: WireFormat = clientFormat === 'openai' ? 'anthropic' : 'openai';
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TranslationError('response', providerFormat, clientFormat, ['malformed_response']);
  }
  const translated =
    clientFormat === 'openai'
      ? translateAnthropicResponseToOpenAI(parsed, { created: options.created, jsonMode: options.jsonMode })
      : translateOpenAIResponseToAnthropic(parsed);
  return JSON.stringify(translated);
}

/** Keeps a non-streamed answer (up to MAX_TRANSLATED_BODY_BYTES) and forwards nothing while it arrives. */
export class TranslatedBodyCollector implements BodyScanner {
  private readonly pieces: Buffer[] = [];
  private size = 0;

  scan(chunk: Buffer): void {
    this.size += chunk.length;
    if (this.size <= MAX_TRANSLATED_BODY_BYTES) this.pieces.push(chunk);
    else this.pieces.length = 0;
  }

  end(): void {}

  /** The whole body as text; null when it was larger than MAX_TRANSLATED_BODY_BYTES. */
  text(): string | null {
    if (this.size > MAX_TRANSLATED_BODY_BYTES) return null;
    return Buffer.concat(this.pieces, this.size).toString('utf8');
  }
}

export interface StreamTranslatorOptions {
  /** Unix time in seconds for OpenAI chunks' `created` field. */
  readonly created: number;
  /** JSON mode, as translateRequest reported it. */
  readonly jsonMode: boolean;
  /** The OpenAI client's stream_options.include_usage (ignored for an Anthropic client). */
  readonly includeUsage: boolean;
  /** Reads usage from the provider's events, in the provider's own format. */
  readonly usageWatch: StreamWatch;
}

/**
 * Turns a provider's event stream into the client's, event by event. As a BodyScanner it forwards only
 * translated events: every provider byte is consumed here. An event too large to read (see SseScanner)
 * cannot be translated, so the client's stream ends there with an error event.
 */
export class StreamTranslator implements BodyScanner {
  private readonly scanner: SseScanner;
  private readonly toAnthropic: OpenAIToAnthropicStream | null;
  private readonly toOpenAI: AnthropicToOpenAIStream | null;
  private readonly usageWatch: StreamWatch;
  private pending: string[] = [];

  constructor(clientFormat: WireFormat, options: StreamTranslatorOptions) {
    this.usageWatch = options.usageWatch;
    this.toAnthropic = clientFormat === 'anthropic' ? new OpenAIToAnthropicStream() : null;
    this.toOpenAI =
      clientFormat === 'openai'
        ? new AnthropicToOpenAIStream({
            created: options.created,
            includeUsage: options.includeUsage,
            jsonMode: options.jsonMode,
          })
        : null;
    this.scanner = new SseScanner({ hold: true, onEvent: (event) => this.onEvent(event) });
  }

  /** The translation problem that ended the stream; null when there was none (a provider error is not one). */
  get error(): TranslationError | null {
    return this.toAnthropic?.error ?? this.toOpenAI?.error ?? null;
  }

  scan(chunk: Buffer, out: Buffer[]): void {
    const untranslated: Buffer[] = [];
    this.scanner.scan(chunk, untranslated);
    // The scanner only releases bytes itself for an event too large to read: that event is lost to the
    // translation, so the stream fails rather than go on without it.
    if (untranslated.length > 0) this.emitText(this.feed(null));
    this.drain(out);
  }

  /** The provider's body ended; an unfinished last event is discarded, never passed on untranslated. */
  end(out: Buffer[]): void {
    this.scanner.end([]);
    this.drain(out);
  }

  /**
   * Appends to `out` what ends the client's stream once the provider's body has ended cleanly: the
   * closing events, or an error event when the provider's stream stopped before saying why it ended.
   */
  finish(out: Buffer[]): void {
    this.emitText(this.toAnthropic !== null ? this.formatAnthropic(this.toAnthropic.end()) : this.formatOpenAI());
    this.drain(out);
  }

  private onEvent(event: SseEvent): 'drop' {
    this.usageWatch.onEvent(event);
    this.emitText(this.feed(event.data.toString('utf8')));
    return 'drop';
  }

  /** Feeds one event's data (null: an event that could not be read) and returns the translated text. */
  private feed(data: string | null): string {
    if (this.toAnthropic !== null) {
      return this.formatAnthropic(data === null ? this.toAnthropic.push(null) : this.toAnthropic.pushData(data));
    }
    const stream = this.toOpenAI as AnthropicToOpenAIStream;
    const items = data === null ? stream.push(null) : stream.pushData(data);
    return items.map(formatOpenAIItem).join('');
  }

  private formatAnthropic(events: ReturnType<OpenAIToAnthropicStream['end']>): string {
    return events.map(formatAnthropicEvent).join('');
  }

  private formatOpenAI(): string {
    return (this.toOpenAI as AnthropicToOpenAIStream).end().map(formatOpenAIItem).join('');
  }

  private emitText(text: string): void {
    if (text !== '') this.pending.push(text);
  }

  private drain(out: Buffer[]): void {
    if (this.pending.length === 0) return;
    out.push(Buffer.from(this.pending.join(''), 'utf8'));
    this.pending = [];
  }
}
