// Reads a chat request just enough for routing to decide where it can go: which capabilities it
// needs, an estimated input size (for ranking candidates by price, see ../pricing/estimate.ts)
// and the output budget the caller asked for. Pure, synchronous, no I/O; never reads env or
// config, and never inspects anything beyond the request body itself.

import { estimateInput, type TokenEstimate } from '../pricing/estimate.ts';
import type { WireFormat } from '../providers/types.ts';

export interface RequestNeeds {
  readonly tools: boolean;
  readonly json_mode: boolean;
  readonly vision: boolean;
  readonly streaming: boolean;
}

export interface Inspection {
  readonly format: WireFormat;
  readonly requestedModel: string;
  readonly stream: boolean;
  readonly needs: RequestNeeds;
  readonly estimatedInput: TokenEstimate;
  /** From `max_completion_tokens`/`max_tokens` (OpenAI) or `max_tokens` (Anthropic); null when absent or not a positive number. */
  readonly maxOutput: number | null;
  /** Top-level request fields this inspector does not recognise for `format`, in the order they appear. */
  readonly unknownFields: readonly string[];
}

/** Thrown by inspect() when the request cannot be read at all -- never for a request that is merely unusual. */
export class InspectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InspectionError';
  }
}

/** Top-level fields the OpenAI Chat Completions request body defines. */
const OPENAI_KNOWN_FIELDS = new Set([
  'model',
  'messages',
  'stream',
  'stream_options',
  'tools',
  'functions',
  'tool_choice',
  'function_call',
  'response_format',
  'max_tokens',
  'max_completion_tokens',
  'temperature',
  'top_p',
  'n',
  'stop',
  'presence_penalty',
  'frequency_penalty',
  'logit_bias',
  'logprobs',
  'top_logprobs',
  'user',
  'seed',
  'service_tier',
  'parallel_tool_calls',
  'metadata',
  'store',
  'reasoning_effort',
  'modalities',
  'audio',
  'prediction',
]);

/** Top-level fields the Anthropic Messages request body defines. */
const ANTHROPIC_KNOWN_FIELDS = new Set([
  'model',
  'messages',
  'system',
  'stream',
  'tools',
  'tool_choice',
  'max_tokens',
  'temperature',
  'top_p',
  'top_k',
  'stop_sequences',
  'metadata',
  'thinking',
  'service_tier',
  'mcp_servers',
]);

/**
 * Inspects one chat request body already known to speak `format`. Throws InspectionError when the
 * body is not a JSON object, or has no usable `model` field -- both make routing impossible, not
 * merely unusual.
 */
export function inspect(format: WireFormat, body: unknown): Inspection {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new InspectionError('the request body must be a JSON object');
  }
  const record = body as Record<string, unknown>;

  const requestedModel = record.model;
  if (typeof requestedModel !== 'string' || requestedModel.trim() === '') {
    throw new InspectionError('the request body has no usable "model" field');
  }

  const stream = record.stream === true;
  const needs: RequestNeeds = format === 'openai' ? openaiNeeds(record, stream) : anthropicNeeds(record, stream);
  const estimatedInput = estimateInput(format, record);
  const maxOutput = readMaxOutput(format, record);
  const known = format === 'openai' ? OPENAI_KNOWN_FIELDS : ANTHROPIC_KNOWN_FIELDS;
  const unknownFields = Object.keys(record).filter((key) => !known.has(key));

  return { format, requestedModel, stream, needs, estimatedInput, maxOutput, unknownFields };
}

function openaiNeeds(record: Record<string, unknown>, stream: boolean): RequestNeeds {
  const hasTools = isNonEmptyArray(record.tools) || isNonEmptyArray(record.functions);
  const toolChoiceForces = isActiveChoice(record.tool_choice) || isActiveChoice(record.function_call);
  return {
    tools: hasTools || toolChoiceForces,
    json_mode: hasJsonMode(record.response_format),
    vision: hasOpenAIImage(record.messages),
    streaming: stream,
  };
}

/**
 * The Anthropic Messages API has no `response_format`. A client that sends one anyway (an
 * OpenAI-style body pointed at the Anthropic endpoint) is still treated as asking for JSON output,
 * so routing never drops that request; the field is also reported in `unknownFields`.
 */
function anthropicNeeds(record: Record<string, unknown>, stream: boolean): RequestNeeds {
  const hasTools = isNonEmptyArray(record.tools);
  const toolChoiceForces = isActiveChoice(record.tool_choice);
  return {
    tools: hasTools || toolChoiceForces,
    json_mode: hasJsonMode(record.response_format),
    vision: hasAnthropicImage(record.messages),
    streaming: stream,
  };
}

function isNonEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

/** True when a tool_choice/function_call value actively asks for a tool, i.e. is not absent or "none". */
function isActiveChoice(value: unknown): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value === 'string') {
    return value !== 'none';
  }
  if (typeof value === 'object') {
    const choice = value as Record<string, unknown>;
    return choice.type !== 'none';
  }
  return false;
}

/** True for OpenAI's `response_format: {type: "json_object" | "json_schema", ...}`. */
function hasJsonMode(value: unknown): boolean {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const type = (value as Record<string, unknown>).type;
  return type === 'json_object' || type === 'json_schema';
}

/** True when any message carries an OpenAI `image_url` content part. */
function hasOpenAIImage(messages: unknown): boolean {
  if (!Array.isArray(messages)) {
    return false;
  }
  for (const message of messages) {
    const content = messageContent(message);
    if (!Array.isArray(content)) {
      continue;
    }
    for (const part of content) {
      if (part !== null && typeof part === 'object' && (part as Record<string, unknown>).type === 'image_url') {
        return true;
      }
    }
  }
  return false;
}

/**
 * True when any message carries an Anthropic `image` content block, whatever its source (base64,
 * url or an uploaded file), including one returned inside a `tool_result` block.
 */
function hasAnthropicImage(messages: unknown): boolean {
  if (!Array.isArray(messages)) {
    return false;
  }
  return messages.some((message) => hasAnthropicImageBlock(messageContent(message)));
}

function hasAnthropicImageBlock(content: unknown): boolean {
  if (!Array.isArray(content)) {
    return false;
  }
  for (const part of content) {
    if (part === null || typeof part !== 'object') {
      continue;
    }
    const block = part as Record<string, unknown>;
    if (block.type === 'tool_result' && hasAnthropicImageBlock(block.content)) {
      return true;
    }
    if (block.type === 'image') {
      return true;
    }
  }
  return false;
}

function messageContent(message: unknown): unknown {
  if (message === null || typeof message !== 'object') {
    return undefined;
  }
  return (message as Record<string, unknown>).content;
}

/** A finite, positive number; anything else (missing, negative, NaN, non-number) reads as absent. */
function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function readMaxOutput(format: WireFormat, record: Record<string, unknown>): number | null {
  if (format === 'anthropic') {
    return positiveNumber(record.max_tokens);
  }
  return positiveNumber(record.max_completion_tokens) ?? positiveNumber(record.max_tokens);
}
