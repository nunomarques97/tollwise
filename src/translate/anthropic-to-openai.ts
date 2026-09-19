// An Anthropic Messages request sent to an OpenAI Chat Completions provider, and that provider's
// non-streaming response brought back to the Anthropic shape. Pure functions, no I/O.
//
// Fidelity rules (anything outside them is reported by untranslatable() and never translated):
// - `system` becomes one leading system message: a string stays a string, text blocks become text
//   parts.
// - A user message's tool_result blocks become `tool` messages, placed before the rest of that
//   message's content (the Anthropic API already requires tool results to come first).
// - An assistant message's text blocks are joined into `content`; its tool_use blocks become
//   `tool_calls`. Text after a tool_use is refused, because OpenAI cannot keep that order.
// - Images: base64 sources become `data:` URLs, url sources stay URLs.
// - `max_tokens` is sent as `max_tokens` by default, which every OpenAI-compatible server accepts;
//   pass `maxTokensField: "max_completion_tokens"` for OpenAI models that only take the newer name.
// - temperature (0 to 1) and top_p are passed unchanged; stop_sequences becomes `stop`.
// - `disable_parallel_tool_use: true` becomes `parallel_tool_calls: false`.
// - `metadata.user_id` becomes `user`.
// - A request sent with an anthropic-beta header (passed in as `anthropicBeta`) is refused: beta
//   features have no OpenAI equivalent.
// - `stream: true` is carried over with `stream_options: {include_usage: true}`, so the provider
//   reports usage and the translated stream (OpenAIToAnthropicStream) carries real counts.

import { type ResponseProblemCode, TranslationError, type UntranslatableCode } from './codes.ts';
import { toAnthropicStopReason, toAnthropicUsage } from './mapping.ts';
import {
  type AnthropicResponse,
  hasUnknownKey,
  isNonEmptyString,
  isNumberInRange,
  isPositiveInteger,
  isRecord,
  isSet,
  type OpenAIImagePart,
  type OpenAIMessage,
  type OpenAIRequest,
  type OpenAITextPart,
  type OpenAITool,
  type OpenAIToolCall,
  type OpenAIToolChoice,
  Problems,
  parseArguments,
} from './wire.ts';

export interface AnthropicToOpenAIOptions {
  /** The model to ask the OpenAI-format provider for; defaults to the request's own `model`. */
  readonly model?: string;
  /** Which field carries the output budget. Default `max_tokens`. */
  readonly maxTokensField?: 'max_tokens' | 'max_completion_tokens';
  /**
   * The anthropic-beta header the request came with, if any. A beta feature has no OpenAI
   * equivalent, so any non-empty value makes the request untranslatable (`anthropic_beta`).
   */
  readonly anthropicBeta?: string | undefined;
}

/** OpenAI accepts at most this many stop sequences. */
const OPENAI_MAX_STOP_SEQUENCES = 4;

const REQUEST_KEYS = new Set([
  'model',
  'messages',
  'system',
  'max_tokens',
  'stream',
  'tools',
  'tool_choice',
  'temperature',
  'top_p',
  'top_k',
  'stop_sequences',
  'metadata',
  'thinking',
  'service_tier',
  'mcp_servers',
]);
const MESSAGE_KEYS = new Set(['role', 'content']);
const TEXT_BLOCK_KEYS = new Set(['type', 'text', 'cache_control', 'citations']);
const IMAGE_BLOCK_KEYS = new Set(['type', 'source', 'cache_control']);
const TOOL_RESULT_KEYS = new Set(['type', 'tool_use_id', 'content', 'is_error', 'cache_control']);
const TOOL_USE_KEYS = new Set(['type', 'id', 'name', 'input', 'cache_control']);
const TOOL_KEYS = new Set(['type', 'name', 'description', 'input_schema', 'cache_control', 'strict']);
const TOOL_CHOICE_KEYS = new Set(['type', 'name', 'disable_parallel_tool_use']);
const METADATA_KEYS = new Set(['user_id']);

type Issues = Problems<UntranslatableCode>;

interface Conversion {
  readonly issues: UntranslatableCode[];
  readonly body: OpenAIRequest;
}

/**
 * Walks the whole request once, building the OpenAI body and collecting every feature it cannot
 * carry over. untranslatable() and the translate function share this walk, so a request is
 * translated if and only if nothing was reported.
 */
export function convertAnthropicRequest(request: unknown, options: AnthropicToOpenAIOptions = {}): Conversion {
  const issues: Issues = new Problems();
  const body: OpenAIRequest = { model: '', messages: [] };
  if (!isRecord(request)) {
    issues.add('malformed_request');
    return { issues: issues.list(), body };
  }

  if (hasUnknownKey(request, REQUEST_KEYS)) {
    issues.add('unknown_field');
  }
  if (!isNonEmptyString(request.model)) {
    issues.add('malformed_request');
  } else {
    body.model = options.model ?? request.model;
  }
  if (options.anthropicBeta !== undefined && options.anthropicBeta.trim() !== '') {
    issues.add('anthropic_beta');
  }
  if (request.stream === true) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  } else if (isSet(request.stream) && request.stream !== false) {
    issues.add('malformed_request');
  }
  if (isSet(request.top_k)) {
    issues.add('anthropic_top_k');
  }
  if (isSet(request.thinking) && !(isRecord(request.thinking) && request.thinking.type === 'disabled')) {
    issues.add('anthropic_thinking');
  }
  if (isSet(request.service_tier) && request.service_tier !== 'auto') {
    issues.add('anthropic_service_tier');
  }
  if (Array.isArray(request.mcp_servers) ? request.mcp_servers.length > 0 : isSet(request.mcp_servers)) {
    issues.add('anthropic_server_tool');
  }

  const system = systemMessage(request.system, issues);
  body.messages = system === null ? [] : [system];
  body.messages.push(...convertMessages(request.messages, issues));

  if (isPositiveInteger(request.max_tokens)) {
    body[options.maxTokensField ?? 'max_tokens'] = request.max_tokens;
  } else {
    issues.add('malformed_request');
  }

  const tools = convertTools(request.tools, issues);
  if (tools.length > 0) {
    body.tools = tools;
  }
  convertToolChoice(request.tool_choice, tools.length > 0, body, issues);

  const stop = request.stop_sequences;
  if (Array.isArray(stop) && stop.every((s) => typeof s === 'string')) {
    if (stop.length > OPENAI_MAX_STOP_SEQUENCES) {
      issues.add('too_many_stop_sequences');
    } else if (stop.length > 0) {
      body.stop = [...stop];
    }
  } else if (isSet(stop)) {
    issues.add('malformed_request');
  }

  if (isSet(request.temperature)) {
    if (isNumberInRange(request.temperature, 0, 1)) {
      body.temperature = request.temperature;
    } else {
      issues.add('malformed_request');
    }
  }
  if (isSet(request.top_p)) {
    if (isNumberInRange(request.top_p, 0, 1)) {
      body.top_p = request.top_p;
    } else {
      issues.add('malformed_request');
    }
  }
  const metadata = request.metadata;
  if (isRecord(metadata)) {
    if (hasUnknownKey(metadata, METADATA_KEYS)) {
      issues.add('unknown_field');
    }
    if (typeof metadata.user_id === 'string') {
      body.user = metadata.user_id;
    } else if (isSet(metadata.user_id)) {
      issues.add('malformed_request');
    }
  } else if (isSet(metadata)) {
    issues.add('malformed_request');
  }

  return { issues: issues.list(), body };
}

/**
 * Translates an Anthropic Messages request to an OpenAI Chat Completions request. Throws
 * TranslationError, carrying every code, when untranslatable() would report anything: a request
 * is translated faithfully or not at all.
 */
export function translateAnthropicRequestToOpenAI(
  request: unknown,
  options: AnthropicToOpenAIOptions = {},
): OpenAIRequest {
  const conversion = convertAnthropicRequest(request, options);
  if (conversion.issues.length > 0) {
    throw new TranslationError('request', 'anthropic', 'openai', conversion.issues);
  }
  return conversion.body;
}

function reportCacheControl(block: Record<string, unknown>, issues: Issues): void {
  if (isSet(block.cache_control)) {
    issues.add('anthropic_cache_control');
  }
}

function systemMessage(value: unknown, issues: Issues): OpenAIMessage | null {
  if (!isSet(value)) {
    return null;
  }
  if (typeof value === 'string') {
    return { role: 'system', content: value };
  }
  if (!Array.isArray(value)) {
    issues.add('malformed_request');
    return null;
  }
  const parts: OpenAITextPart[] = [];
  for (const block of value) {
    const part = textPart(block, issues);
    if (part !== null) {
      parts.push(part);
    }
  }
  return { role: 'system', content: parts };
}

/**
 * A text block; anything else in a text-only position is reported. `inToolResult` marks tool_result
 * content, where Anthropic also allows images and documents that OpenAI tool messages cannot carry.
 */
function textPart(block: unknown, issues: Issues, inToolResult = false): OpenAITextPart | null {
  if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') {
    if (inToolResult && isRecord(block) && block.type === 'image') {
      issues.add('tool_result_image');
    } else if (inToolResult && isRecord(block) && block.type === 'document') {
      issues.add('anthropic_document');
    } else {
      issues.add(isRecord(block) && typeof block.type === 'string' ? 'unknown_content_type' : 'malformed_request');
    }
    return null;
  }
  if (hasUnknownKey(block, TEXT_BLOCK_KEYS)) {
    issues.add('unknown_field');
  }
  reportCacheControl(block, issues);
  if (isSet(block.citations) && !(Array.isArray(block.citations) && block.citations.length === 0)) {
    issues.add('anthropic_citations');
  }
  return { type: 'text', text: block.text };
}

function convertMessages(value: unknown, issues: Issues): OpenAIMessage[] {
  if (!Array.isArray(value)) {
    issues.add('malformed_request');
    return [];
  }
  const out: OpenAIMessage[] = [];
  let lastRole: unknown;
  for (const message of value) {
    if (!isRecord(message)) {
      issues.add('malformed_request');
      continue;
    }
    if (hasUnknownKey(message, MESSAGE_KEYS)) {
      issues.add('unknown_field');
    }
    lastRole = message.role;
    if (message.role === 'user') {
      out.push(...userMessages(message.content, issues));
    } else if (message.role === 'assistant') {
      const converted = assistantMessage(message.content, issues);
      if (converted !== null) {
        out.push(converted);
      }
    } else {
      issues.add('malformed_request');
    }
  }
  if (lastRole === 'assistant') {
    issues.add('assistant_prefill');
  }
  return out;
}

/** One user message becomes its tool results (as `tool` messages) followed by the rest, if any. */
function userMessages(content: unknown, issues: Issues): OpenAIMessage[] {
  if (typeof content === 'string') {
    return [{ role: 'user', content }];
  }
  if (!Array.isArray(content)) {
    issues.add('malformed_request');
    return [];
  }
  const toolMessages: OpenAIMessage[] = [];
  const parts: (OpenAITextPart | OpenAIImagePart)[] = [];
  let sawOtherContent = false;
  for (const block of content) {
    if (!isRecord(block)) {
      issues.add('malformed_request');
      continue;
    }
    if (block.type === 'tool_result') {
      if (sawOtherContent) {
        // The Anthropic API rejects this order; translating it would silently reorder the turn.
        issues.add('malformed_request');
      }
      toolMessages.push(toolMessage(block, issues));
      continue;
    }
    sawOtherContent = true;
    switch (block.type) {
      case 'text': {
        const part = textPart(block, issues);
        if (part !== null) {
          parts.push(part);
        }
        break;
      }
      case 'image': {
        const part = imagePart(block, issues);
        if (part !== null) {
          parts.push(part);
        }
        break;
      }
      case 'document':
        issues.add('anthropic_document');
        break;
      default:
        issues.add(typeof block.type === 'string' ? 'unknown_content_type' : 'malformed_request');
    }
  }
  if (content.length === 0) {
    issues.add('malformed_request');
  }
  return parts.length > 0 ? [...toolMessages, { role: 'user', content: parts }] : toolMessages;
}

function imagePart(block: Record<string, unknown>, issues: Issues): OpenAIImagePart | null {
  if (hasUnknownKey(block, IMAGE_BLOCK_KEYS)) {
    issues.add('unknown_field');
  }
  reportCacheControl(block, issues);
  const source = block.source;
  if (!isRecord(source)) {
    issues.add('malformed_request');
    return null;
  }
  if (source.type === 'base64' && isNonEmptyString(source.media_type) && typeof source.data === 'string') {
    return { type: 'image_url', image_url: { url: `data:${source.media_type};base64,${source.data}` } };
  }
  if (source.type === 'url' && isNonEmptyString(source.url)) {
    return { type: 'image_url', image_url: { url: source.url } };
  }
  issues.add(source.type === 'file' ? 'anthropic_file_source' : 'malformed_request');
  return null;
}

function toolMessage(block: Record<string, unknown>, issues: Issues): OpenAIMessage {
  if (hasUnknownKey(block, TOOL_RESULT_KEYS)) {
    issues.add('unknown_field');
  }
  reportCacheControl(block, issues);
  if (block.is_error === true) {
    issues.add('tool_result_error');
  }
  const id = block.tool_use_id;
  if (!isNonEmptyString(id)) {
    issues.add('malformed_request');
  }
  const toolCallId = typeof id === 'string' ? id : '';
  const content = block.content;
  if (!isSet(content)) {
    return { role: 'tool', tool_call_id: toolCallId, content: '' };
  }
  if (typeof content === 'string') {
    return { role: 'tool', tool_call_id: toolCallId, content };
  }
  if (!Array.isArray(content)) {
    issues.add('malformed_request');
    return { role: 'tool', tool_call_id: toolCallId, content: '' };
  }
  const parts: OpenAITextPart[] = [];
  for (const inner of content) {
    const part = textPart(inner, issues, true);
    if (part !== null) {
      parts.push(part);
    }
  }
  return { role: 'tool', tool_call_id: toolCallId, content: parts };
}

function assistantMessage(content: unknown, issues: Issues): OpenAIMessage | null {
  if (typeof content === 'string') {
    return { role: 'assistant', content };
  }
  if (!Array.isArray(content) || content.length === 0) {
    issues.add('malformed_request');
    return null;
  }
  const texts: string[] = [];
  const toolCalls: OpenAIToolCall[] = [];
  for (const block of content) {
    if (!isRecord(block)) {
      issues.add('malformed_request');
      continue;
    }
    switch (block.type) {
      case 'text': {
        if (toolCalls.length > 0) {
          issues.add('assistant_text_after_tool_use');
        }
        const part = textPart(block, issues);
        if (part !== null) {
          texts.push(part.text);
        }
        break;
      }
      case 'tool_use': {
        if (hasUnknownKey(block, TOOL_USE_KEYS)) {
          issues.add('unknown_field');
        }
        reportCacheControl(block, issues);
        if (!isNonEmptyString(block.id) || !isNonEmptyString(block.name) || !isRecord(block.input)) {
          issues.add('malformed_request');
          break;
        }
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: JSON.stringify(block.input) },
        });
        break;
      }
      case 'thinking':
      case 'redacted_thinking':
        issues.add('anthropic_thinking');
        break;
      case 'server_tool_use':
      case 'web_search_tool_result':
      case 'web_fetch_tool_result':
      case 'code_execution_tool_result':
      case 'mcp_tool_use':
      case 'mcp_tool_result':
        issues.add('anthropic_server_tool');
        break;
      default:
        issues.add(typeof block.type === 'string' ? 'unknown_content_type' : 'malformed_request');
    }
  }
  const message: OpenAIMessage = { role: 'assistant', content: texts.length > 0 ? texts.join('') : null };
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }
  return message;
}

function convertTools(value: unknown, issues: Issues): OpenAITool[] {
  if (!isSet(value)) {
    return [];
  }
  if (!Array.isArray(value)) {
    issues.add('malformed_request');
    return [];
  }
  const tools: OpenAITool[] = [];
  for (const tool of value) {
    if (!isRecord(tool)) {
      issues.add('malformed_request');
      continue;
    }
    if (isSet(tool.type) && tool.type !== 'custom') {
      issues.add('anthropic_server_tool');
      continue;
    }
    if (hasUnknownKey(tool, TOOL_KEYS)) {
      issues.add('unknown_field');
    }
    reportCacheControl(tool, issues);
    if (tool.strict === true) {
      issues.add('tool_strict');
    }
    if (!isNonEmptyString(tool.name) || !isRecord(tool.input_schema)) {
      issues.add('malformed_request');
      continue;
    }
    if (isSet(tool.description) && typeof tool.description !== 'string') {
      issues.add('malformed_request');
    }
    const fn: OpenAITool['function'] = { name: tool.name, parameters: tool.input_schema };
    if (typeof tool.description === 'string') {
      fn.description = tool.description;
    }
    tools.push({ type: 'function', function: fn });
  }
  return tools;
}

function convertToolChoice(value: unknown, hasTools: boolean, body: OpenAIRequest, issues: Issues): void {
  if (!isSet(value)) {
    return;
  }
  if (!isRecord(value)) {
    issues.add('malformed_request');
    return;
  }
  if (hasUnknownKey(value, TOOL_CHOICE_KEYS)) {
    issues.add('unknown_field');
  }
  let choice: OpenAIToolChoice;
  switch (value.type) {
    case 'auto':
      choice = 'auto';
      break;
    case 'any':
      choice = 'required';
      break;
    case 'none':
      choice = 'none';
      break;
    case 'tool':
      if (!isNonEmptyString(value.name)) {
        issues.add('malformed_request');
        return;
      }
      choice = { type: 'function', function: { name: value.name } };
      break;
    default:
      issues.add('malformed_request');
      return;
  }
  body.tool_choice = choice;
  const disable = value.disable_parallel_tool_use;
  if (isSet(disable) && typeof disable !== 'boolean') {
    issues.add('malformed_request');
  } else if (disable === true && hasTools && choice !== 'none') {
    body.parallel_tool_calls = false;
  }
}

// --- Response: OpenAI Chat Completions -> Anthropic Messages --------------------------------------

/**
 * Translates a non-streaming OpenAI Chat Completions response to an Anthropic Messages response.
 *
 * - `message.content` becomes one text block (none when it is empty or null); a `refusal` becomes
 *   a text block after it.
 * - `tool_calls` become tool_use blocks; arguments that are not a JSON object make the whole
 *   response untranslatable, since Anthropic clients receive the input as an object.
 * - finish_reason: stop -> end_turn, length -> max_tokens, tool_calls -> tool_use,
 *   content_filter -> refusal. OpenAI does not say whether a stop sequence matched, so a stop is
 *   always reported as end_turn with stop_sequence null.
 * - usage: input_tokens excludes cached tokens (Anthropic counts them apart), cache_read_input_tokens
 *   takes prompt_tokens_details.cached_tokens, cache_creation_input_tokens is 0 when cache details
 *   are present (OpenAI caching has no write charge) and null when they are not.
 *
 * Throws TranslationError for more than one choice, an unknown finish_reason, legacy function calls
 * or missing usage.
 */
export function translateOpenAIResponseToAnthropic(response: unknown): AnthropicResponse {
  const problems = new Problems<ResponseProblemCode>();
  const fail = (): never => {
    throw new TranslationError('response', 'openai', 'anthropic', problems.list());
  };
  if (
    !isRecord(response) ||
    !Array.isArray(response.choices) ||
    typeof response.id !== 'string' ||
    typeof response.model !== 'string'
  ) {
    problems.add('malformed_response');
    return fail();
  }
  if (response.choices.length !== 1) {
    problems.add(response.choices.length === 0 ? 'malformed_response' : 'multiple_choices');
    return fail();
  }
  const choice: unknown = response.choices[0];
  const message = isRecord(choice) ? choice.message : undefined;
  if (!isRecord(choice) || !isRecord(message)) {
    problems.add('malformed_response');
    return fail();
  }

  const content: AnthropicResponse['content'] = [];
  if (typeof message.content === 'string') {
    if (message.content !== '') {
      content.push({ type: 'text', text: message.content });
    }
  } else if (isSet(message.content)) {
    problems.add('unsupported_response_content');
  }
  if (typeof message.refusal === 'string') {
    content.push({ type: 'text', text: message.refusal });
  } else if (isSet(message.refusal)) {
    problems.add('malformed_response');
  }
  if (isSet(message.function_call) || isSet(message.audio)) {
    problems.add('unsupported_response_content');
  }
  const toolCalls = message.tool_calls;
  if (Array.isArray(toolCalls)) {
    for (const call of toolCalls) {
      const fn = isRecord(call) ? call.function : undefined;
      if (!isRecord(call) || call.type !== 'function' || !isRecord(fn)) {
        problems.add(
          isRecord(call) && call.type !== 'function' ? 'unsupported_response_content' : 'malformed_response',
        );
        continue;
      }
      if (!isNonEmptyString(call.id) || !isNonEmptyString(fn.name)) {
        problems.add('malformed_response');
        continue;
      }
      const input = parseArguments(fn.arguments);
      if (input === null) {
        problems.add('tool_arguments_not_json');
        continue;
      }
      content.push({ type: 'tool_use', id: call.id, name: fn.name, input });
    }
  } else if (isSet(toolCalls)) {
    problems.add('malformed_response');
  }

  const stopReason = toAnthropicStopReason(choice.finish_reason);
  if (stopReason === undefined) {
    problems.add('unknown_stop_reason');
  }
  const usage = toAnthropicUsage(response.usage);
  if (usage === null) {
    problems.add('malformed_response');
  }
  if (!problems.empty || stopReason === undefined || usage === null) {
    return fail();
  }
  return {
    id: response.id,
    type: 'message',
    role: 'assistant',
    model: response.model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage,
  };
}
