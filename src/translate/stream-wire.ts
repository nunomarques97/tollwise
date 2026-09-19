// The streaming (server-sent events) shapes that stream translation produces, how they are written
// on the wire, and how a mid-stream error is carried in each format. Inputs are always read as
// `unknown`; these types describe outputs only.

import { errorMessage } from '../providers/errors.ts';
import type {
  AnthropicStopReason,
  AnthropicToolUseBlock,
  AnthropicUsage,
  OpenAIFinishReason,
  OpenAIUsage,
} from './wire.ts';
import { isRecord } from './wire.ts';

// --- Anthropic Messages events --------------------------------------------------------------------

export interface AnthropicMessageStartEvent {
  type: 'message_start';
  message: {
    id: string;
    type: 'message';
    role: 'assistant';
    model: string;
    content: [];
    stop_reason: null;
    stop_sequence: null;
    usage: AnthropicUsage;
  };
}

export interface AnthropicContentBlockStartEvent {
  type: 'content_block_start';
  index: number;
  content_block: { type: 'text'; text: '' } | AnthropicToolUseBlock;
}

export interface AnthropicContentBlockDeltaEvent {
  type: 'content_block_delta';
  index: number;
  delta: { type: 'text_delta'; text: string } | { type: 'input_json_delta'; partial_json: string };
}

export interface AnthropicContentBlockStopEvent {
  type: 'content_block_stop';
  index: number;
}

export interface AnthropicMessageDeltaEvent {
  type: 'message_delta';
  delta: { stop_reason: AnthropicStopReason; stop_sequence: null };
  usage: AnthropicUsage | { output_tokens: 0 };
}

export interface AnthropicMessageStopEvent {
  type: 'message_stop';
}

export interface AnthropicErrorEvent {
  type: 'error';
  error: { type: AnthropicStreamErrorType; message: string };
}

export type AnthropicStreamErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'permission_error'
  | 'not_found_error'
  | 'rate_limit_error'
  | 'api_error'
  | 'overloaded_error';

/** One Anthropic server-sent event: its `event` name always equals `data.type`. */
export type AnthropicStreamEvent =
  | AnthropicMessageStartEvent
  | AnthropicContentBlockStartEvent
  | AnthropicContentBlockDeltaEvent
  | AnthropicContentBlockStopEvent
  | AnthropicMessageDeltaEvent
  | AnthropicMessageStopEvent
  | AnthropicErrorEvent;

// --- OpenAI Chat Completions chunks ---------------------------------------------------------------

export interface OpenAIToolCallDelta {
  index: number;
  id?: string;
  type?: 'function';
  function: { name?: string; arguments: string };
}

export interface OpenAIChunkDelta {
  role?: 'assistant';
  content?: string;
  tool_calls?: OpenAIToolCallDelta[];
}

export interface OpenAIChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: [] | [{ index: 0; delta: OpenAIChunkDelta; logprobs: null; finish_reason: OpenAIFinishReason | null }];
  /** Present on every chunk when the caller asked for usage: null until the final usage chunk. */
  usage?: OpenAIUsage | null;
}

export type OpenAIStreamErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'permission_error'
  | 'not_found_error'
  | 'rate_limit_error'
  | 'server_error';

/** How OpenAI reports an error inside a stream; the official SDKs raise it as an API error. */
export interface OpenAIErrorChunk {
  error: { message: string; type: OpenAIStreamErrorType; param: null; code: string | null };
}

/** The literal data of the event that ends an OpenAI stream. */
export const OPENAI_DONE = '[DONE]';

/** One OpenAI server-sent event's data: a chunk, an error, or the end marker. */
export type OpenAIStreamItem = OpenAIChunk | OpenAIErrorChunk | typeof OPENAI_DONE;

// --- Writing ------------------------------------------------------------------------------------

/** One Anthropic event as SSE text: `event: <type>`, `data: <json>`, blank line. */
export function formatAnthropicEvent(event: AnthropicStreamEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** One OpenAI stream item as SSE text: `data: <json or [DONE]>`, blank line. */
export function formatOpenAIItem(item: OpenAIStreamItem): string {
  return `data: ${item === OPENAI_DONE ? OPENAI_DONE : JSON.stringify(item)}\n\n`;
}

// --- Shared by both transformers ------------------------------------------------------------------

/** Where a stream transformer is: still running, ended cleanly, or ended with an error event. */
export type StreamState = 'streaming' | 'completed' | 'failed';

/** Parses the data field of one incoming event; undefined when it is not JSON. */
export function parseEventData(data: string): unknown {
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return undefined;
  }
}

const DEFAULT_UPSTREAM_ERROR = 'The provider reported an error in the middle of the stream.';

/** The provider's own message from an error event, credentials masked and length capped. */
export function upstreamErrorMessage(event: unknown): string {
  return errorMessage(event) ?? DEFAULT_UPSTREAM_ERROR;
}

const ERROR_TYPE_SHAPE = /^[a-z][a-z0-9_]{0,63}$/;

/** The `type` of the error object inside an event, when there is one shaped like an identifier. */
export function upstreamErrorType(event: unknown): string | undefined {
  const error = isRecord(event) ? event.error : undefined;
  return isRecord(error) && typeof error.type === 'string' && ERROR_TYPE_SHAPE.test(error.type)
    ? error.type
    : undefined;
}
