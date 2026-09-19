// The field mappings every response translation shares, streaming or not: why a response ended, and
// how many tokens it used. Pure functions, no I/O.

import {
  type AnthropicStopReason,
  type AnthropicUsage,
  isNonNegativeInteger,
  isRecord,
  isSet,
  type OpenAIFinishReason,
  type OpenAIUsage,
} from './wire.ts';

const ANTHROPIC_STOP_REASONS: Readonly<Record<string, AnthropicStopReason>> = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  content_filter: 'refusal',
};

const OPENAI_FINISH_REASONS: Readonly<Record<string, OpenAIFinishReason>> = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  max_tokens: 'length',
  model_context_window_exceeded: 'length',
  tool_use: 'tool_calls',
  refusal: 'content_filter',
};

/**
 * The Anthropic stop_reason for an OpenAI finish_reason: stop -> end_turn, length -> max_tokens,
 * tool_calls -> tool_use, content_filter -> refusal. OpenAI does not say whether a stop sequence
 * matched, so a stop is always end_turn. Undefined for anything else.
 */
export function toAnthropicStopReason(finishReason: unknown): AnthropicStopReason | undefined {
  return typeof finishReason === 'string' && Object.hasOwn(ANTHROPIC_STOP_REASONS, finishReason)
    ? ANTHROPIC_STOP_REASONS[finishReason]
    : undefined;
}

/**
 * The OpenAI finish_reason for an Anthropic stop_reason: end_turn and stop_sequence -> stop,
 * max_tokens and model_context_window_exceeded -> length, tool_use -> tool_calls,
 * refusal -> content_filter. Undefined for anything else.
 */
export function toOpenAIFinishReason(stopReason: unknown): OpenAIFinishReason | undefined {
  return typeof stopReason === 'string' && Object.hasOwn(OPENAI_FINISH_REASONS, stopReason)
    ? OPENAI_FINISH_REASONS[stopReason]
    : undefined;
}

/**
 * OpenAI usage in the Anthropic shape; null when `value` is not a valid OpenAI usage object.
 * input_tokens excludes cached tokens (Anthropic counts them apart), cache_read_input_tokens takes
 * prompt_tokens_details.cached_tokens, cache_creation_input_tokens is 0 when cache details are
 * present (OpenAI caching has no write charge) and null when they are not.
 */
export function toAnthropicUsage(value: unknown): AnthropicUsage | null {
  if (
    !isRecord(value) ||
    !isNonNegativeInteger(value.prompt_tokens) ||
    !isNonNegativeInteger(value.completion_tokens)
  ) {
    return null;
  }
  const details = value.prompt_tokens_details;
  let cached: number | null = null;
  if (isRecord(details) && isSet(details.cached_tokens)) {
    if (!isNonNegativeInteger(details.cached_tokens) || details.cached_tokens > value.prompt_tokens) {
      return null;
    }
    cached = details.cached_tokens;
  } else if (isSet(details) && !isRecord(details)) {
    return null;
  }
  return {
    input_tokens: value.prompt_tokens - (cached ?? 0),
    output_tokens: value.completion_tokens,
    cache_creation_input_tokens: cached === null ? null : 0,
    cache_read_input_tokens: cached,
  };
}

/**
 * Anthropic usage in the OpenAI shape; null when `value` is not a valid Anthropic usage object.
 * prompt_tokens counts every input token, cached or not (Anthropic's input_tokens excludes cache
 * reads and writes); cache reads also go to prompt_tokens_details.cached_tokens.
 */
export function toOpenAIUsage(value: unknown): OpenAIUsage | null {
  if (!isRecord(value) || !isNonNegativeInteger(value.input_tokens) || !isNonNegativeInteger(value.output_tokens)) {
    return null;
  }
  const optional = (field: unknown): number | null | undefined => {
    if (!isSet(field)) {
      return undefined;
    }
    return isNonNegativeInteger(field) ? field : null;
  };
  const cacheRead = optional(value.cache_read_input_tokens);
  const cacheWrite = optional(value.cache_creation_input_tokens);
  if (cacheRead === null || cacheWrite === null) {
    return null;
  }
  const prompt = value.input_tokens + (cacheRead ?? 0) + (cacheWrite ?? 0);
  const usage: OpenAIUsage = {
    prompt_tokens: prompt,
    completion_tokens: value.output_tokens,
    total_tokens: prompt + value.output_tokens,
  };
  if (cacheRead !== undefined) {
    usage.prompt_tokens_details = { cached_tokens: cacheRead };
  }
  return usage;
}
