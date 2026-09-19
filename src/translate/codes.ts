// The stable codes cross-format translation reports, and the error it throws.
//
// A code names one feature (or one problem) that a translation between the OpenAI Chat Completions
// and the Anthropic Messages formats cannot carry over faithfully. Codes are part of the public
// contract: routing uses them to exclude a candidate, and they are safe to log, because they never
// contain anything from the request body itself. Never rename or reuse a code; add a new one.

import type { WireFormat } from '../providers/types.ts';

/** Every feature a request translation may refuse, with a one-line description. */
export const UNTRANSLATABLE_FEATURES = {
  malformed_request: 'The request is not a valid body for its own format, so it cannot be translated.',
  unknown_field: 'A field the translator does not know, so it cannot promise to preserve it.',
  unknown_content_type: 'A content part or block type the translator does not know.',
  assistant_prefill:
    'The conversation ends with an assistant message. Anthropic continues it (prefill); OpenAI answers it with a new message.',
  message_name: 'The OpenAI "name" field on a message. Anthropic messages have no participant names.',
  system_message_position:
    'A system or developer message after the conversation started. Anthropic only takes a leading system prompt.',
  max_tokens_missing:
    'No max_completion_tokens or max_tokens, and no default output budget was configured. Anthropic requires one.',
  temperature_out_of_range: 'temperature above 1. Anthropic accepts 0 to 1.',
  image_media_type: 'An inline image in a format the target does not accept (Anthropic: JPEG, PNG, GIF, WebP).',
  openai_image_detail: 'An image with detail "low" or "high". Anthropic has no per-image detail setting.',
  openai_n: 'n greater than 1. Anthropic returns exactly one completion.',
  openai_logprobs: 'logprobs or top_logprobs. Anthropic does not return token log probabilities.',
  openai_logit_bias: 'logit_bias. Anthropic has no token biasing.',
  openai_penalties: 'A non-zero presence_penalty or frequency_penalty. Anthropic has no repetition penalties.',
  openai_seed: 'seed. Anthropic has no deterministic sampling seed.',
  openai_legacy_functions: 'The deprecated functions / function_call fields or the "function" role.',
  openai_audio: 'Audio input or output (input_audio parts, audio, modalities).',
  openai_file_input: 'A "file" content part.',
  openai_store: 'Stored completions (store: true, or metadata tags). Anthropic stores nothing for later retrieval.',
  openai_prediction: 'Predicted outputs (prediction).',
  openai_reasoning_effort: 'reasoning_effort. It has no exact Anthropic equivalent.',
  openai_service_tier: 'A service_tier other than "auto".',
  openai_custom_tool: 'A tool or tool_choice that is not a plain function (custom tools, allowed_tools).',
  json_schema: 'response_format of type json_schema. Schema-constrained output has no faithful Anthropic mapping.',
  json_mode_with_tools:
    'response_format json_object together with tools or tool_choice. JSON mode is carried by a forced tool call, which the caller tools would conflict with.',
  tool_strict: 'A tool with strict: true (schema-constrained arguments).',
  tool_arguments_not_json: 'A tool call in the history whose arguments are not a JSON object.',
  assistant_refusal: 'An assistant refusal in the history. Anthropic messages have no refusal field.',
  anthropic_cache_control: 'cache_control (prompt caching). OpenAI caches automatically and takes no cache markers.',
  anthropic_thinking: 'Extended thinking (thinking, or thinking blocks in the history).',
  anthropic_top_k: 'top_k. OpenAI has no top-k sampling.',
  anthropic_document: 'A document (PDF or text) content block.',
  anthropic_file_source: 'An image that references an uploaded file (source type "file").',
  anthropic_citations: 'Citations on a text block.',
  anthropic_server_tool: 'A server tool or connector (web search, code execution, computer use, MCP servers, ...).',
  anthropic_service_tier: 'A service_tier other than "auto".',
  anthropic_beta: 'The anthropic-beta header. Beta features change what the API does and have no OpenAI equivalent.',
  tool_result_error: 'A tool_result marked is_error. OpenAI tool messages cannot flag an error.',
  tool_result_image: 'An image inside a tool_result. OpenAI tool messages carry text only.',
  assistant_text_after_tool_use:
    'An assistant text block after a tool_use block. OpenAI keeps text and tool calls apart, so the order would be lost.',
  too_many_stop_sequences: 'More than 4 stop sequences. OpenAI accepts at most 4.',
} as const;

export type UntranslatableCode = keyof typeof UNTRANSLATABLE_FEATURES;

/** Every untranslatable code, in a stable order. */
export const UNTRANSLATABLE_CODES = Object.keys(UNTRANSLATABLE_FEATURES) as readonly UntranslatableCode[];

/** Problems with a provider response that make it impossible to translate back to the caller's format. */
export const RESPONSE_PROBLEMS = {
  malformed_response: 'The response is not a valid body, or a valid stream of events, for its format.',
  unsupported_response_content: 'The response carries content the caller format cannot represent.',
  unknown_stop_reason: 'The response ended for a reason that has no mapping in the caller format.',
  multiple_choices: 'The response has more than one choice.',
  tool_arguments_not_json: 'A tool call in the response has arguments that are not a JSON object.',
  incomplete_stream: 'The stream ended before the response said why it stopped.',
  interleaved_tool_calls:
    'A streamed tool call continued after the next one had started. Anthropic streams one content block at a time.',
} as const;

export type ResponseProblemCode = keyof typeof RESPONSE_PROBLEMS;

export type TranslationCode = UntranslatableCode | ResponseProblemCode;

/**
 * Thrown by every translate* function instead of returning a lossy result. `codes` lists every
 * reason found (never empty). The message names the codes only, never request or response content,
 * so the error is safe to log.
 */
export class TranslationError extends Error {
  readonly codes: readonly TranslationCode[];
  readonly from: WireFormat;
  readonly to: WireFormat;
  readonly subject: 'request' | 'response';

  constructor(subject: 'request' | 'response', from: WireFormat, to: WireFormat, codes: readonly TranslationCode[]) {
    super(`cannot translate the ${subject} from the ${from} format to the ${to} format: ${codes.join(', ')}`);
    this.name = 'TranslationError';
    this.subject = subject;
    this.from = from;
    this.to = to;
    this.codes = codes;
  }
}
