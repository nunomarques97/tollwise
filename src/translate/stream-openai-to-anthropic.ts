// An OpenAI Chat Completions stream brought to an Anthropic Messages client, one chunk at a time.
// Stateful and pure: the caller feeds each incoming event and writes out the events returned, in
// order. Nothing here reads the clock or the network, and nothing logs.
//
// Mapping:
// - The first chunk opens the message (message_start), with the chunk's id and model. OpenAI reports
//   usage only at the end, so message_start carries zero tokens and message_delta the real counts.
// - Text (`delta.content`, and `delta.refusal` as in the non-streaming translation) goes to a text
//   block, opened on the first piece of text after anything else.
// - Each tool call (`delta.tool_calls[i]`) opens a tool_use block when its id and name arrive; its
//   argument pieces become input_json_delta events, byte for byte. A block is closed
//   (content_block_stop) when the next block opens or the choice finishes. When it closes, the
//   arguments must form a JSON object (empty arguments mean an empty input), as the non-streaming
//   translation requires.
// - finish_reason maps as in the non-streaming translation (stop -> end_turn, length -> max_tokens,
//   tool_calls -> tool_use, content_filter -> refusal). The message_delta that carries it waits for
//   the usage chunk OpenAI sends after it, and goes out with message_stop when the stream ends.
// - A stream that ends without usage (the request did not set stream_options.include_usage) still
//   completes: message_delta then reports `usage: {output_tokens: 0}` and `usage` stays null here,
//   so the caller knows the counts are unknown rather than zero.
//
// Failure is never silent. Anything the Anthropic format cannot carry faithfully (more than one
// choice, an unknown finish_reason, tool arguments that are not a JSON object, a tool call that
// continues after the next one started, legacy function calls), a malformed chunk, an error the
// provider reports mid-stream, or a stream that ends before its finish_reason: each ends the output
// with one Anthropic `error` event, and nothing is emitted after it.

import { type ResponseProblemCode, TranslationError } from './codes.ts';
import { toAnthropicStopReason, toAnthropicUsage } from './mapping.ts';
import {
  type AnthropicErrorEvent,
  type AnthropicStreamErrorType,
  type AnthropicStreamEvent,
  OPENAI_DONE,
  parseEventData,
  type StreamState,
  upstreamErrorMessage,
  upstreamErrorType,
} from './stream-wire.ts';
import {
  type AnthropicStopReason,
  type AnthropicUsage,
  isNonEmptyString,
  isNonNegativeInteger,
  isRecord,
  isSet,
  parseArguments,
} from './wire.ts';

/** OpenAI error types that have an Anthropic twin; everything else is reported as api_error. */
const ANTHROPIC_ERROR_TYPES: Readonly<Record<string, AnthropicStreamErrorType>> = {
  invalid_request_error: 'invalid_request_error',
  authentication_error: 'authentication_error',
  permission_error: 'permission_error',
  not_found_error: 'not_found_error',
  rate_limit_error: 'rate_limit_error',
  rate_limit_exceeded: 'rate_limit_error',
};

interface ToolCallState {
  readonly blockIndex: number;
  readonly id: string;
  readonly name: string;
  arguments: string;
  closed: boolean;
}

type OpenBlock =
  | { readonly kind: 'text'; readonly index: number }
  | { readonly kind: 'tool'; readonly call: ToolCallState };

/** Translates one OpenAI Chat Completions stream into Anthropic Messages stream events. */
export class OpenAIToAnthropicStream {
  #state: StreamState = 'streaming';
  #started = false;
  #nextBlock = 0;
  #open: OpenBlock | null = null;
  readonly #toolCalls = new Map<number, ToolCallState>();
  #stopReason: AnthropicStopReason | null = null;
  #usage: AnthropicUsage | null = null;
  #error: TranslationError | null = null;

  /** streaming until the stream ends; then completed, or failed when it ended with an error event. */
  get state(): StreamState {
    return this.#state;
  }

  /** Why the response stopped, once its finish_reason has arrived. */
  get stopReason(): AnthropicStopReason | null {
    return this.#stopReason;
  }

  /** The usage the provider reported, in the Anthropic shape; null until it arrives, or if it never does. */
  get usage(): AnthropicUsage | null {
    return this.#usage;
  }

  /** The translation problem that ended the stream; null when it did not fail, or the provider failed it. */
  get error(): TranslationError | null {
    return this.#error;
  }

  /**
   * Feeds the data field of one incoming server-sent event, as text. `[DONE]` ends the stream
   * (see end()). Returns the events to emit, in order.
   */
  pushData(data: string): AnthropicStreamEvent[] {
    if (data.trim() === OPENAI_DONE) {
      return this.end();
    }
    const chunk = parseEventData(data);
    return chunk === undefined ? this.push(null) : this.push(chunk);
  }

  /** Feeds one parsed chunk. Returns the events to emit, in order; none once the stream has ended. */
  push(chunk: unknown): AnthropicStreamEvent[] {
    if (this.#state !== 'streaming') {
      return [];
    }
    const out: AnthropicStreamEvent[] = [];
    if (!isRecord(chunk)) {
      return this.#fail(out, 'malformed_response');
    }
    if (isSet(chunk.error)) {
      return this.#upstreamError(out, chunk);
    }
    if (!this.#started) {
      if (!isNonEmptyString(chunk.id) || typeof chunk.model !== 'string') {
        return this.#fail(out, 'malformed_response');
      }
      this.#started = true;
      out.push({
        type: 'message_start',
        message: {
          id: chunk.id,
          type: 'message',
          role: 'assistant',
          model: chunk.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
          },
        },
      });
    }

    const choices = chunk.choices;
    if (isSet(choices)) {
      if (!Array.isArray(choices)) {
        return this.#fail(out, 'malformed_response');
      }
      if (choices.length > 1) {
        return this.#fail(out, 'multiple_choices');
      }
      if (choices.length === 1) {
        const problem = this.#choice(choices[0], out);
        if (problem !== null) {
          return this.#fail(out, problem);
        }
      }
    }

    if (isSet(chunk.usage)) {
      const usage = toAnthropicUsage(chunk.usage);
      if (usage === null) {
        return this.#fail(out, 'malformed_response');
      }
      this.#usage = usage;
    }
    return out;
  }

  /**
   * Ends the stream: on `[DONE]`, or when the connection closed. Completes the message
   * (message_delta, message_stop) when its finish_reason arrived; otherwise the response was cut
   * short and the output ends with an error event. Returns the events to emit.
   */
  end(): AnthropicStreamEvent[] {
    if (this.#state !== 'streaming') {
      return [];
    }
    const out: AnthropicStreamEvent[] = [];
    if (this.#stopReason === null) {
      return this.#fail(out, 'incomplete_stream');
    }
    out.push({
      type: 'message_delta',
      delta: { stop_reason: this.#stopReason, stop_sequence: null },
      usage: this.#usage ?? { output_tokens: 0 },
    });
    out.push({ type: 'message_stop' });
    this.#state = 'completed';
    return out;
  }

  /** Reads one choice; returns the problem that makes it untranslatable, or null. */
  #choice(choice: unknown, out: AnthropicStreamEvent[]): ResponseProblemCode | null {
    if (!isRecord(choice)) {
      return 'malformed_response';
    }
    if (isSet(choice.index) && choice.index !== 0) {
      return 'multiple_choices';
    }
    const delta = isSet(choice.delta) ? choice.delta : {};
    if (!isRecord(delta)) {
      return 'malformed_response';
    }
    const finished = this.#stopReason !== null;
    if (isSet(delta.function_call) || isSet(delta.audio)) {
      return 'unsupported_response_content';
    }
    for (const field of [delta.content, delta.refusal]) {
      if (typeof field === 'string') {
        if (field !== '') {
          if (finished) {
            return 'malformed_response';
          }
          const problem = this.#text(field, out);
          if (problem !== null) {
            return problem;
          }
        }
      } else if (isSet(field)) {
        return 'unsupported_response_content';
      }
    }
    if (isSet(delta.tool_calls)) {
      if (!Array.isArray(delta.tool_calls)) {
        return 'malformed_response';
      }
      for (const call of delta.tool_calls) {
        if (finished) {
          return 'malformed_response';
        }
        const problem = this.#toolCall(call, out);
        if (problem !== null) {
          return problem;
        }
      }
    }
    if (isSet(choice.finish_reason)) {
      const stopReason = toAnthropicStopReason(choice.finish_reason);
      if (stopReason === undefined) {
        return 'unknown_stop_reason';
      }
      if (finished) {
        // Some servers repeat the finish_reason on the usage chunk; a different one is a contradiction.
        return stopReason === this.#stopReason ? null : 'malformed_response';
      }
      const problem = this.#closeOpenBlock(out);
      if (problem !== null) {
        return problem;
      }
      this.#stopReason = stopReason;
    }
    return null;
  }

  #text(text: string, out: AnthropicStreamEvent[]): ResponseProblemCode | null {
    const open = this.#open;
    let index: number;
    if (open?.kind === 'text') {
      index = open.index;
    } else {
      const problem = this.#closeOpenBlock(out);
      if (problem !== null) {
        return problem;
      }
      index = this.#nextBlock++;
      this.#open = { kind: 'text', index };
      out.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
    }
    out.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } });
    return null;
  }

  #toolCall(call: unknown, out: AnthropicStreamEvent[]): ResponseProblemCode | null {
    if (!isRecord(call) || !isNonNegativeInteger(call.index)) {
      return 'malformed_response';
    }
    if (isSet(call.type) && call.type !== 'function') {
      return 'unsupported_response_content';
    }
    const fn = isSet(call.function) ? call.function : {};
    if (!isRecord(fn) || (isSet(fn.arguments) && typeof fn.arguments !== 'string')) {
      return 'malformed_response';
    }
    const pieces = typeof fn.arguments === 'string' ? fn.arguments : '';

    let state = this.#toolCalls.get(call.index);
    if (state === undefined) {
      if (!isNonEmptyString(call.id) || !isNonEmptyString(fn.name)) {
        return 'malformed_response';
      }
      const problem = this.#closeOpenBlock(out);
      if (problem !== null) {
        return problem;
      }
      state = { blockIndex: this.#nextBlock++, id: call.id, name: fn.name, arguments: '', closed: false };
      this.#toolCalls.set(call.index, state);
      this.#open = { kind: 'tool', call: state };
      out.push({
        type: 'content_block_start',
        index: state.blockIndex,
        content_block: { type: 'tool_use', id: state.id, name: state.name, input: {} },
      });
    } else {
      if ((isSet(call.id) && call.id !== state.id) || (isNonEmptyString(fn.name) && fn.name !== state.name)) {
        return 'malformed_response';
      }
      if (state.closed) {
        return pieces === '' ? null : 'interleaved_tool_calls';
      }
    }
    if (pieces !== '') {
      state.arguments += pieces;
      out.push({
        type: 'content_block_delta',
        index: state.blockIndex,
        delta: { type: 'input_json_delta', partial_json: pieces },
      });
    }
    return null;
  }

  /** Closes the open block, if any; a tool call whose arguments are not a JSON object is a problem. */
  #closeOpenBlock(out: AnthropicStreamEvent[]): ResponseProblemCode | null {
    const open = this.#open;
    if (open?.kind === 'tool' && open.call.arguments !== '' && parseArguments(open.call.arguments) === null) {
      return 'tool_arguments_not_json';
    }
    if (open === null) {
      return null;
    }
    if (open.kind === 'tool') {
      open.call.closed = true;
    }
    out.push({ type: 'content_block_stop', index: open.kind === 'text' ? open.index : open.call.blockIndex });
    this.#open = null;
    return null;
  }

  #fail(out: AnthropicStreamEvent[], code: ResponseProblemCode): AnthropicStreamEvent[] {
    const error = new TranslationError('response', 'openai', 'anthropic', [code]);
    this.#error = error;
    return this.#terminate(out, { type: 'error', error: { type: 'api_error', message: error.message } });
  }

  #upstreamError(out: AnthropicStreamEvent[], chunk: Record<string, unknown>): AnthropicStreamEvent[] {
    const type = upstreamErrorType(chunk);
    return this.#terminate(out, {
      type: 'error',
      error: {
        type:
          (type !== undefined && Object.hasOwn(ANTHROPIC_ERROR_TYPES, type)
            ? ANTHROPIC_ERROR_TYPES[type]
            : undefined) ?? 'api_error',
        message: upstreamErrorMessage(chunk),
      },
    });
  }

  #terminate(out: AnthropicStreamEvent[], event: AnthropicErrorEvent): AnthropicStreamEvent[] {
    out.push(event);
    this.#state = 'failed';
    this.#open = null;
    return out;
  }
}
