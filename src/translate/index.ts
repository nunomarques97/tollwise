// Cross-format translation between the OpenAI Chat Completions and the Anthropic Messages formats:
// requests, non-streaming responses (pure functions) and streamed responses (stateful transformers
// fed one event at a time). No I/O: nothing here reads the environment, the clock or the network,
// and nothing logs.
//
// The contract is all or nothing. untranslatable() lists, as stable codes, every feature of a
// request that the translation would not preserve; every translate* function throws a
// TranslationError carrying those codes instead of returning a lossy result. Routing calls
// untranslatable() first and excludes a candidate that would need a lossy translation. A stream
// transformer cannot throw once bytes have gone out, so it ends its output with an error event in
// the caller's format instead, and reports the TranslationError on its `error` property.

import type { WireFormat } from '../providers/types.ts';
import { convertAnthropicRequest } from './anthropic-to-openai.ts';
import type { UntranslatableCode } from './codes.ts';
import { convertOpenAIRequest } from './openai-to-anthropic.ts';

export {
  type AnthropicToOpenAIOptions,
  translateAnthropicRequestToOpenAI,
  translateOpenAIResponseToAnthropic,
} from './anthropic-to-openai.ts';
export {
  RESPONSE_PROBLEMS,
  type ResponseProblemCode,
  type TranslationCode,
  TranslationError,
  UNTRANSLATABLE_CODES,
  UNTRANSLATABLE_FEATURES,
  type UntranslatableCode,
} from './codes.ts';
export {
  type AnthropicResponseToOpenAIOptions,
  JSON_MODE_TOOL_NAME,
  type OpenAIToAnthropicOptions,
  type TranslatedAnthropicRequest,
  translateAnthropicResponseToOpenAI,
  translateOpenAIRequestToAnthropic,
} from './openai-to-anthropic.ts';
export { type AnthropicStreamToOpenAIOptions, AnthropicToOpenAIStream } from './stream-anthropic-to-openai.ts';
export { OpenAIToAnthropicStream } from './stream-openai-to-anthropic.ts';
export {
  type AnthropicStreamEvent,
  formatAnthropicEvent,
  formatOpenAIItem,
  OPENAI_DONE,
  type OpenAIChunk,
  type OpenAIErrorChunk,
  type OpenAIStreamItem,
  type StreamState,
} from './stream-wire.ts';

export interface UntranslatableOptions {
  /**
   * The configured output budget for OpenAI requests that set none (see
   * translateOpenAIRequestToAnthropic). Without it such a request reports `max_tokens_missing`.
   */
  readonly defaultMaxTokens?: number;
  /**
   * The anthropic-beta header an Anthropic Messages request came with, if any (see
   * translateAnthropicRequestToOpenAI). Any non-empty value reports `anthropic_beta`.
   */
  readonly anthropicBeta?: string | undefined;
}

/**
 * The features of `request` that a translation to `targetFormat` would not preserve, each as a
 * stable code, in the order first found; empty when the translation is faithful. `request` is in
 * the other format: an OpenAI Chat Completions body when `targetFormat` is "anthropic", an
 * Anthropic Messages body when it is "openai". A body that is not valid for its own format reports
 * `malformed_request`.
 */
export function untranslatable(
  request: unknown,
  targetFormat: WireFormat,
  options: UntranslatableOptions = {},
): readonly UntranslatableCode[] {
  return targetFormat === 'anthropic'
    ? convertOpenAIRequest(request, options).issues
    : convertAnthropicRequest(request, { anthropicBeta: options.anthropicBeta }).issues;
}
