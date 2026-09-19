// An Anthropic Messages stream brought to an OpenAI Chat Completions client, one event at a time.
// Stateful and pure: the caller feeds each incoming event and writes out the items returned, in
// order. Nothing here reads the clock or the network, and nothing logs.
//
// Mapping:
// - message_start opens the stream with a role chunk (`delta: {role: "assistant", content: ""}`),
//   carrying the message id and model.
// - text_delta pieces become `delta.content` pieces, byte for byte.
// - Each tool_use block becomes one tool call: its start chunk carries the call's `index` (0, 1, ...
//   in block order), id, name and empty arguments; each input_json_delta becomes an arguments piece
//   for that index. A block with no input pieces gets the arguments "{}", as in the non-streaming
//   translation. When the block closes, the arguments must form a JSON object.
// - message_delta's stop_reason maps as in the non-streaming translation (end_turn and
//   stop_sequence -> stop, max_tokens -> length, tool_use -> tool_calls, refusal -> content_filter)
//   and goes out as the finish_reason chunk. Which stop sequence matched is not reported: OpenAI has
//   no field for it.
// - message_stop ends the stream: a usage chunk (`choices: []`) when the caller asked for usage
//   (stream_options.include_usage), then `[DONE]`. Usage merges message_start's counts with
//   message_delta's, which win, and is converted as in the non-streaming translation.
// - JSON mode: the forced tool call's input pieces become `delta.content` pieces instead, and its
//   tool_use stop becomes finish_reason "stop". Text blocks are not passed on in JSON mode, as in
//   the non-streaming translation, where the JSON replaces the message content.
// - ping events are dropped, and so are event types this module does not know, which the Anthropic
//   API may add over time.
//
// Failure is never silent. Content OpenAI cannot carry (thinking, server tools, citations), an
// unknown stop_reason, tool input that is not a JSON object, a malformed event, an `error` event
// from the provider, or a stream that ends before its stop_reason: each ends the output with one
// OpenAI error chunk (`{"error": {...}}`, which the official SDKs raise as an API error) and no
// `[DONE]`; nothing is emitted after it.

import { type ResponseProblemCode, TranslationError } from './codes.ts';
import { toOpenAIFinishReason, toOpenAIUsage } from './mapping.ts';
import { JSON_MODE_TOOL_NAME } from './openai-to-anthropic.ts';
import {
  OPENAI_DONE,
  type OpenAIChunk,
  type OpenAIChunkDelta,
  type OpenAIErrorChunk,
  type OpenAIStreamErrorType,
  type OpenAIStreamItem,
  parseEventData,
  type StreamState,
  upstreamErrorMessage,
  upstreamErrorType,
} from './stream-wire.ts';
import {
  isNonEmptyString,
  isNonNegativeInteger,
  isRecord,
  isSet,
  type OpenAIFinishReason,
  type OpenAIUsage,
  parseArguments,
} from './wire.ts';

export interface AnthropicStreamToOpenAIOptions {
  /** Unix time in seconds for every chunk's `created` field; the caller supplies it so this stays pure. */
  readonly created: number;
  /** The caller's stream_options.include_usage: send the final usage chunk. Default: false. */
  readonly includeUsage?: boolean;
  /** The `jsonMode` returned by translateOpenAIRequestToAnthropic for the same request. */
  readonly jsonMode?: boolean;
}

/** Anthropic error types that have an OpenAI twin; everything else is reported as server_error. */
const OPENAI_ERROR_TYPES: Readonly<Record<string, OpenAIStreamErrorType>> = {
  invalid_request_error: 'invalid_request_error',
  authentication_error: 'authentication_error',
  permission_error: 'permission_error',
  not_found_error: 'not_found_error',
  rate_limit_error: 'rate_limit_error',
};

interface BlockState {
  readonly kind: 'text' | 'tool' | 'json';
  /** The tool call index in the OpenAI stream (tool blocks only). */
  readonly toolIndex: number;
  /** The input JSON received so far (tool and json blocks). */
  input: string;
  /** The block started with a non-empty input, already sent whole; no input pieces may follow. */
  readonly prefilled: boolean;
  closed: boolean;
}

/** Translates one Anthropic Messages stream into OpenAI Chat Completions stream items. */
export class AnthropicToOpenAIStream {
  readonly #created: number;
  readonly #includeUsage: boolean;
  readonly #jsonMode: boolean;

  #state: StreamState = 'streaming';
  #id = '';
  #model = '';
  #started = false;
  readonly #blocks = new Map<number, BlockState>();
  #toolCount = 0;
  #jsonBlockSeen = false;
  #startUsage: Record<string, unknown> = {};
  #deltaUsage: Record<string, unknown> = {};
  #finishReason: OpenAIFinishReason | null = null;
  #usage: OpenAIUsage | null = null;
  #error: TranslationError | null = null;

  constructor(options: AnthropicStreamToOpenAIOptions) {
    this.#created = options.created;
    this.#includeUsage = options.includeUsage === true;
    this.#jsonMode = options.jsonMode === true;
  }

  /** streaming until the stream ends; then completed, or failed when it ended with an error chunk. */
  get state(): StreamState {
    return this.#state;
  }

  /** The finish_reason sent, once message_delta has arrived. */
  get finishReason(): OpenAIFinishReason | null {
    return this.#finishReason;
  }

  /** The usage the provider reported, in the OpenAI shape; null until the stream completes. */
  get usage(): OpenAIUsage | null {
    return this.#usage;
  }

  /** The translation problem that ended the stream; null when it did not fail, or the provider failed it. */
  get error(): TranslationError | null {
    return this.#error;
  }

  /** Feeds the data field of one incoming server-sent event, as text. Returns the items to emit. */
  pushData(data: string): OpenAIStreamItem[] {
    const event = parseEventData(data);
    return event === undefined ? this.push(null) : this.push(event);
  }

  /**
   * Feeds one parsed event (its `type` field names it; the SSE event name is redundant). Returns the
   * items to emit, in order; none once the stream has ended.
   */
  push(event: unknown): OpenAIStreamItem[] {
    if (this.#state !== 'streaming') {
      return [];
    }
    const out: OpenAIStreamItem[] = [];
    if (!isRecord(event) || typeof event.type !== 'string') {
      return this.#fail(out, 'malformed_response');
    }
    if (event.type === 'error') {
      return this.#upstreamError(out, event);
    }
    if (event.type === 'ping') {
      return out;
    }
    if (event.type === 'message_start') {
      return this.#messageStart(event, out);
    }
    if (!this.#started) {
      return this.#fail(out, 'malformed_response');
    }
    let problem: ResponseProblemCode | null = null;
    switch (event.type) {
      case 'content_block_start':
        problem = this.#blockStart(event, out);
        break;
      case 'content_block_delta':
        problem = this.#blockDelta(event, out);
        break;
      case 'content_block_stop':
        problem = this.#blockStop(event, out);
        break;
      case 'message_delta':
        problem = this.#messageDelta(event, out);
        break;
      case 'message_stop':
        return this.#complete(out);
      default:
        // An event type added to the API after this module was written: it carries nothing to translate.
        break;
    }
    return problem === null ? out : this.#fail(out, problem);
  }

  /**
   * Ends the stream when the connection closed. A stream whose stop_reason arrived but whose
   * message_stop did not is completed; any other is reported as cut short with an error chunk.
   * Returns the items to emit; none when the stream already ended.
   */
  end(): OpenAIStreamItem[] {
    if (this.#state !== 'streaming') {
      return [];
    }
    return this.#finishReason === null ? this.#fail([], 'incomplete_stream') : this.#complete([]);
  }

  #messageStart(event: Record<string, unknown>, out: OpenAIStreamItem[]): OpenAIStreamItem[] {
    const message = event.message;
    if (this.#started || !isRecord(message) || !isNonEmptyString(message.id) || typeof message.model !== 'string') {
      return this.#fail(out, 'malformed_response');
    }
    if (isSet(message.usage)) {
      if (!isRecord(message.usage)) {
        return this.#fail(out, 'malformed_response');
      }
      this.#startUsage = message.usage;
    }
    this.#started = true;
    this.#id = message.id;
    this.#model = message.model;
    out.push(this.#chunk({ role: 'assistant', content: '' }, null));
    return out;
  }

  #blockStart(event: Record<string, unknown>, out: OpenAIStreamItem[]): ResponseProblemCode | null {
    const block = event.content_block;
    if (
      this.#finishReason !== null ||
      !isNonNegativeInteger(event.index) ||
      this.#blocks.has(event.index) ||
      !isRecord(block)
    ) {
      return 'malformed_response';
    }
    if (block.type === 'text') {
      if (typeof block.text !== 'string') {
        return 'malformed_response';
      }
      if (isSet(block.citations) && !(Array.isArray(block.citations) && block.citations.length === 0)) {
        return 'unsupported_response_content';
      }
      this.#blocks.set(event.index, { kind: 'text', toolIndex: -1, input: '', prefilled: false, closed: false });
      if (block.text !== '' && !this.#jsonMode) {
        out.push(this.#chunk({ content: block.text }, null));
      }
      return null;
    }
    if (block.type !== 'tool_use') {
      return 'unsupported_response_content';
    }
    if (!isNonEmptyString(block.id) || !isNonEmptyString(block.name) || !isRecord(block.input)) {
      return 'malformed_response';
    }
    const prefill = Object.keys(block.input).length > 0 ? JSON.stringify(block.input) : '';
    if (this.#jsonMode) {
      if (block.name !== JSON_MODE_TOOL_NAME || this.#jsonBlockSeen) {
        return 'unsupported_response_content';
      }
      this.#jsonBlockSeen = true;
      this.#blocks.set(event.index, {
        kind: 'json',
        toolIndex: -1,
        input: prefill,
        prefilled: prefill !== '',
        closed: false,
      });
      if (prefill !== '') {
        out.push(this.#chunk({ content: prefill }, null));
      }
      return null;
    }
    const toolIndex = this.#toolCount++;
    this.#blocks.set(event.index, {
      kind: 'tool',
      toolIndex,
      input: prefill,
      prefilled: prefill !== '',
      closed: false,
    });
    out.push(
      this.#chunk(
        {
          tool_calls: [
            { index: toolIndex, id: block.id, type: 'function', function: { name: block.name, arguments: prefill } },
          ],
        },
        null,
      ),
    );
    return null;
  }

  #blockDelta(event: Record<string, unknown>, out: OpenAIStreamItem[]): ResponseProblemCode | null {
    const block = isNonNegativeInteger(event.index) ? this.#blocks.get(event.index) : undefined;
    const delta = event.delta;
    if (block === undefined || block.closed || !isRecord(delta)) {
      return 'malformed_response';
    }
    if (delta.type === 'text_delta') {
      if (block.kind !== 'text' || typeof delta.text !== 'string') {
        return 'malformed_response';
      }
      if (delta.text !== '' && !this.#jsonMode) {
        out.push(this.#chunk({ content: delta.text }, null));
      }
      return null;
    }
    if (delta.type === 'input_json_delta') {
      if (block.kind === 'text' || typeof delta.partial_json !== 'string') {
        return 'malformed_response';
      }
      if (delta.partial_json === '') {
        return null;
      }
      if (block.prefilled) {
        return 'malformed_response';
      }
      block.input += delta.partial_json;
      out.push(
        block.kind === 'json'
          ? this.#chunk({ content: delta.partial_json }, null)
          : this.#chunk(
              { tool_calls: [{ index: block.toolIndex, function: { arguments: delta.partial_json } }] },
              null,
            ),
      );
      return null;
    }
    // citations_delta, thinking_delta, signature_delta and anything newer: nothing OpenAI can carry.
    return 'unsupported_response_content';
  }

  #blockStop(event: Record<string, unknown>, out: OpenAIStreamItem[]): ResponseProblemCode | null {
    const block = isNonNegativeInteger(event.index) ? this.#blocks.get(event.index) : undefined;
    if (block === undefined || block.closed) {
      return 'malformed_response';
    }
    block.closed = true;
    if (block.kind === 'text') {
      return null;
    }
    if (block.input === '') {
      // No input at all: the empty object, as the non-streaming translation serialises it.
      out.push(
        block.kind === 'json'
          ? this.#chunk({ content: '{}' }, null)
          : this.#chunk({ tool_calls: [{ index: block.toolIndex, function: { arguments: '{}' } }] }, null),
      );
      return null;
    }
    return parseArguments(block.input) === null ? 'tool_arguments_not_json' : null;
  }

  #messageDelta(event: Record<string, unknown>, out: OpenAIStreamItem[]): ResponseProblemCode | null {
    const delta = event.delta;
    if (this.#finishReason !== null || !isRecord(delta)) {
      return 'malformed_response';
    }
    let finishReason = toOpenAIFinishReason(delta.stop_reason);
    if (finishReason === undefined) {
      return isSet(delta.stop_reason) ? 'unknown_stop_reason' : 'malformed_response';
    }
    if (this.#jsonMode) {
      if (this.#jsonBlockSeen) {
        if (finishReason === 'tool_calls') {
          finishReason = 'stop';
        }
      } else if (finishReason !== 'length' && finishReason !== 'content_filter') {
        // A forced tool call that never came, without running out of budget: there is no JSON to return.
        return 'malformed_response';
      }
    }
    if (isSet(event.usage)) {
      if (!isRecord(event.usage)) {
        return 'malformed_response';
      }
      this.#deltaUsage = event.usage;
    }
    this.#finishReason = finishReason;
    out.push(this.#chunk({}, finishReason));
    return null;
  }

  #complete(out: OpenAIStreamItem[]): OpenAIStreamItem[] {
    if (this.#finishReason === null) {
      return this.#fail(out, 'incomplete_stream');
    }
    const merged: Record<string, unknown> = { ...this.#startUsage };
    for (const [key, value] of Object.entries(this.#deltaUsage)) {
      if (isSet(value)) {
        merged[key] = value;
      }
    }
    const usage = toOpenAIUsage(merged);
    if (usage === null) {
      return this.#fail(out, 'malformed_response');
    }
    this.#usage = usage;
    if (this.#includeUsage) {
      out.push({ ...this.#base(), choices: [], usage });
    }
    out.push(OPENAI_DONE);
    this.#state = 'completed';
    return out;
  }

  #base(): Omit<OpenAIChunk, 'choices'> {
    return { id: this.#id, object: 'chat.completion.chunk', created: this.#created, model: this.#model };
  }

  #chunk(delta: OpenAIChunkDelta, finishReason: OpenAIFinishReason | null): OpenAIChunk {
    const chunk: OpenAIChunk = {
      ...this.#base(),
      choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }],
    };
    if (this.#includeUsage) {
      chunk.usage = null;
    }
    return chunk;
  }

  #fail(out: OpenAIStreamItem[], code: ResponseProblemCode): OpenAIStreamItem[] {
    const error = new TranslationError('response', 'anthropic', 'openai', [code]);
    this.#error = error;
    return this.#terminate(out, { error: { message: error.message, type: 'server_error', param: null, code } });
  }

  #upstreamError(out: OpenAIStreamItem[], event: Record<string, unknown>): OpenAIStreamItem[] {
    const type = upstreamErrorType(event);
    return this.#terminate(out, {
      error: {
        message: upstreamErrorMessage(event),
        type:
          (type !== undefined && Object.hasOwn(OPENAI_ERROR_TYPES, type) ? OPENAI_ERROR_TYPES[type] : undefined) ??
          'server_error',
        param: null,
        code: type ?? null,
      },
    });
  }

  #terminate(out: OpenAIStreamItem[], item: OpenAIErrorChunk): OpenAIStreamItem[] {
    out.push(item);
    this.#state = 'failed';
    return out;
  }
}
