// An OpenAI Chat Completions request sent to an Anthropic Messages provider, and that provider's
// non-streaming response brought back to the OpenAI shape. Pure functions, no I/O.
//
// Fidelity rules (anything outside them is reported by untranslatable() and never translated):
// - Leading system and developer messages become the Anthropic `system` prompt, in order. A system
//   or developer message after the first user/assistant/tool message is refused.
// - Consecutive messages that land on the same Anthropic role are merged into one message, in
//   order; `tool` messages become `tool_result` blocks in a user message. Anthropic merges
//   consecutive same-role turns itself, so this changes nothing the model sees.
// - Images: `data:` URLs become base64 sources, http(s) URLs become url sources. `detail` other than
//   "auto" is refused.
// - Output budget: `max_completion_tokens`, else `max_tokens`. Anthropic requires a budget and
//   OpenAI does not: when the request has none, the caller must pass `defaultMaxTokens` (a
//   configured value). Without it the request is refused with `max_tokens_missing`; nothing is
//   invented here.
// - temperature: OpenAI takes 0 to 2, Anthropic 0 to 1. Values up to 1 are passed unchanged;
//   higher ones are refused rather than rescaled.
// - JSON mode (`response_format: {type: "json_object"}`) is carried by one forced tool call whose
//   input is the JSON object; translateAnthropicResponseToOpenAI with `jsonMode: true` turns that
//   call back into the message content. Refused when the request also has tools or tool_choice.
// - `parallel_tool_calls: false` becomes `disable_parallel_tool_use: true` on the tool choice.
// - `user` becomes `metadata.user_id`.
// - `stream: true` is carried over; the response stream is translated back by
//   AnthropicToOpenAIStream, which reads stream_options.include_usage itself.

import { type ResponseProblemCode, TranslationError, type UntranslatableCode } from './codes.ts';
import { toOpenAIFinishReason, toOpenAIUsage } from './mapping.ts';
import {
  type AnthropicContentBlock,
  type AnthropicImageBlock,
  type AnthropicMessage,
  type AnthropicRequest,
  type AnthropicTextBlock,
  type AnthropicTool,
  type AnthropicToolChoice,
  hasUnknownKey,
  isNonEmptyString,
  isNumberInRange,
  isPositiveInteger,
  isRecord,
  isSet,
  type OpenAIResponse,
  type OpenAIToolCall,
  Problems,
  parseArguments,
} from './wire.ts';

export interface OpenAIToAnthropicOptions {
  /** The model to ask the Anthropic provider for; defaults to the request's own `model`. */
  readonly model?: string;
  /** Output budget used only when the request sets neither max_completion_tokens nor max_tokens. */
  readonly defaultMaxTokens?: number;
}

export interface TranslatedAnthropicRequest {
  readonly body: AnthropicRequest;
  /**
   * True when the request asked for JSON mode. Pass it to translateAnthropicResponseToOpenAI so
   * the forced tool call is turned back into JSON message content.
   */
  readonly jsonMode: boolean;
}

/** Name of the tool that carries JSON mode. Only ever sent when the request has no tools of its own. */
export const JSON_MODE_TOOL_NAME = 'json_response';

const JSON_MODE_TOOL: AnthropicTool = {
  name: JSON_MODE_TOOL_NAME,
  description: 'Respond with the JSON object that answers the request.',
  input_schema: { type: 'object' },
};

/** Media types Anthropic accepts for base64 images. */
const ANTHROPIC_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

const REQUEST_KEYS = new Set([
  'model',
  'messages',
  'stream',
  'stream_options',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  'response_format',
  'max_tokens',
  'max_completion_tokens',
  'temperature',
  'top_p',
  'stop',
  'user',
  'n',
  'logprobs',
  'top_logprobs',
  'logit_bias',
  'presence_penalty',
  'frequency_penalty',
  'seed',
  'functions',
  'function_call',
  'store',
  'metadata',
  'prediction',
  'reasoning_effort',
  'service_tier',
  'modalities',
  'audio',
]);
const MESSAGE_KEYS = new Set([
  'role',
  'content',
  'name',
  'tool_calls',
  'tool_call_id',
  'refusal',
  'audio',
  'function_call',
]);
const TEXT_PART_KEYS = new Set(['type', 'text']);
const IMAGE_PART_KEYS = new Set(['type', 'image_url']);
const IMAGE_URL_KEYS = new Set(['url', 'detail']);
const TOOL_CALL_KEYS = new Set(['id', 'type', 'function']);
const FUNCTION_CALL_KEYS = new Set(['name', 'arguments']);
const TOOL_KEYS = new Set(['type', 'function']);
const FUNCTION_KEYS = new Set(['name', 'description', 'parameters', 'strict']);

type Issues = Problems<UntranslatableCode>;

interface Conversion {
  readonly issues: UntranslatableCode[];
  readonly body: AnthropicRequest;
  readonly jsonMode: boolean;
}

/** A message being built, remembering whether it is still exactly one plain-string source message. */
interface Draft {
  role: 'user' | 'assistant';
  blocks: AnthropicContentBlock[];
  plain: string | null;
}

/**
 * Walks the whole request once, building the Anthropic body and collecting every feature it
 * cannot carry over. untranslatable() and the translate function share this walk, so a request is
 * translated if and only if nothing was reported.
 */
export function convertOpenAIRequest(request: unknown, options: OpenAIToAnthropicOptions = {}): Conversion {
  const issues: Issues = new Problems();
  const body: AnthropicRequest = { model: '', max_tokens: 0, messages: [] };
  const defaultMaxTokens = options.defaultMaxTokens;
  if (defaultMaxTokens !== undefined && !isPositiveInteger(defaultMaxTokens)) {
    throw new RangeError('defaultMaxTokens must be a positive integer');
  }
  if (!isRecord(request)) {
    issues.add('malformed_request');
    return { issues: issues.list(), body, jsonMode: false };
  }

  if (hasUnknownKey(request, REQUEST_KEYS)) {
    issues.add('unknown_field');
  }
  if (!isNonEmptyString(request.model)) {
    issues.add('malformed_request');
  } else {
    body.model = options.model ?? request.model;
  }
  if (request.stream === true) {
    body.stream = true;
  } else if (isSet(request.stream) && request.stream !== false) {
    issues.add('malformed_request');
  }
  reportUnsupportedFields(request, issues);

  const { system, messages } = convertMessages(request.messages, issues);
  const onlySystem = system.length === 1 ? system[0] : undefined;
  if (onlySystem !== undefined && onlySystem.plain !== null) {
    body.system = onlySystem.plain;
  } else if (system.length > 0) {
    body.system = system.map((entry) => entry.block);
  }
  body.messages = messages;

  const maxTokens = isSet(request.max_completion_tokens) ? request.max_completion_tokens : request.max_tokens;
  if (isSet(maxTokens)) {
    if (isPositiveInteger(maxTokens)) {
      body.max_tokens = maxTokens;
    } else {
      issues.add('malformed_request');
    }
  } else if (defaultMaxTokens !== undefined) {
    body.max_tokens = defaultMaxTokens;
  } else {
    issues.add('max_tokens_missing');
  }

  const tools = convertTools(request.tools, issues);
  let toolChoice = convertToolChoice(request.tool_choice, issues);
  if (isSet(request.parallel_tool_calls)) {
    if (typeof request.parallel_tool_calls !== 'boolean') {
      issues.add('malformed_request');
    } else if (request.parallel_tool_calls === false && tools.length > 0 && toolChoice?.type !== 'none') {
      toolChoice = { ...(toolChoice ?? { type: 'auto' }), disable_parallel_tool_use: true };
    }
  }

  const jsonMode = readJsonMode(request.response_format, issues);
  if (jsonMode) {
    if (tools.length > 0 || isSet(request.tool_choice)) {
      issues.add('json_mode_with_tools');
    }
    body.tools = [JSON_MODE_TOOL];
    body.tool_choice = { type: 'tool', name: JSON_MODE_TOOL_NAME };
  } else {
    if (tools.length > 0) {
      body.tools = tools;
    }
    if (toolChoice !== undefined) {
      body.tool_choice = toolChoice;
    }
  }

  const stop = request.stop;
  if (typeof stop === 'string') {
    body.stop_sequences = [stop];
  } else if (Array.isArray(stop)) {
    if (stop.every((s) => typeof s === 'string')) {
      if (stop.length > 0) {
        body.stop_sequences = [...stop];
      }
    } else {
      issues.add('malformed_request');
    }
  } else if (isSet(stop)) {
    issues.add('malformed_request');
  }

  if (isSet(request.temperature)) {
    if (!isNumberInRange(request.temperature, 0, 2)) {
      issues.add('malformed_request');
    } else if (request.temperature > 1) {
      issues.add('temperature_out_of_range');
    } else {
      body.temperature = request.temperature;
    }
  }
  if (isSet(request.top_p)) {
    if (isNumberInRange(request.top_p, 0, 1)) {
      body.top_p = request.top_p;
    } else {
      issues.add('malformed_request');
    }
  }
  if (isSet(request.user)) {
    if (typeof request.user === 'string') {
      body.metadata = { user_id: request.user };
    } else {
      issues.add('malformed_request');
    }
  }

  return { issues: issues.list(), body, jsonMode };
}

/**
 * Translates an OpenAI Chat Completions request to an Anthropic Messages request. Throws
 * TranslationError, carrying every code, when untranslatable() would report anything: a request
 * is translated faithfully or not at all.
 */
export function translateOpenAIRequestToAnthropic(
  request: unknown,
  options: OpenAIToAnthropicOptions = {},
): TranslatedAnthropicRequest {
  const conversion = convertOpenAIRequest(request, options);
  if (conversion.issues.length > 0) {
    throw new TranslationError('request', 'openai', 'anthropic', conversion.issues);
  }
  return { body: conversion.body, jsonMode: conversion.jsonMode };
}

/** Fields that have no Anthropic equivalent unless they hold their neutral value. */
function reportUnsupportedFields(request: Record<string, unknown>, issues: Issues): void {
  if (isSet(request.n) && request.n !== 1) {
    issues.add('openai_n');
  }
  if (request.logprobs === true || (isSet(request.top_logprobs) && request.top_logprobs !== 0)) {
    issues.add('openai_logprobs');
  }
  if (isSet(request.logit_bias) && !(isRecord(request.logit_bias) && Object.keys(request.logit_bias).length === 0)) {
    issues.add('openai_logit_bias');
  }
  if (
    (isSet(request.presence_penalty) && request.presence_penalty !== 0) ||
    (isSet(request.frequency_penalty) && request.frequency_penalty !== 0)
  ) {
    issues.add('openai_penalties');
  }
  if (isSet(request.seed)) {
    issues.add('openai_seed');
  }
  if ((Array.isArray(request.functions) && request.functions.length > 0) || isSet(request.function_call)) {
    issues.add('openai_legacy_functions');
  }
  if (
    request.store === true ||
    (isSet(request.metadata) && !(isRecord(request.metadata) && Object.keys(request.metadata).length === 0))
  ) {
    issues.add('openai_store');
  }
  if (isSet(request.prediction)) {
    issues.add('openai_prediction');
  }
  if (isSet(request.reasoning_effort)) {
    issues.add('openai_reasoning_effort');
  }
  if (isSet(request.service_tier) && request.service_tier !== 'auto') {
    issues.add('openai_service_tier');
  }
  const modalities = request.modalities;
  const textOnly = Array.isArray(modalities) && modalities.length === 1 && modalities[0] === 'text';
  if ((isSet(modalities) && !textOnly) || isSet(request.audio)) {
    issues.add('openai_audio');
  }
}

interface SystemEntry {
  readonly block: AnthropicTextBlock;
  /** The text when it came from a plain-string system message. */
  readonly plain: string | null;
}

function convertMessages(value: unknown, issues: Issues): { system: SystemEntry[]; messages: AnthropicMessage[] } {
  const system: SystemEntry[] = [];
  const drafts: Draft[] = [];
  if (!Array.isArray(value)) {
    issues.add('malformed_request');
    return { system, messages: [] };
  }

  const push = (role: Draft['role'], blocks: AnthropicContentBlock[], plain: string | null): void => {
    const last = drafts.at(-1);
    if (last !== undefined && last.role === role) {
      last.blocks.push(...blocks);
      last.plain = null;
    } else {
      drafts.push({ role, blocks, plain });
    }
  };

  for (const message of value) {
    if (!isRecord(message)) {
      issues.add('malformed_request');
      continue;
    }
    if (hasUnknownKey(message, MESSAGE_KEYS)) {
      issues.add('unknown_field');
    }
    if (isSet(message.name)) {
      issues.add('message_name');
    }
    switch (message.role) {
      case 'system':
      case 'developer': {
        if (drafts.length > 0) {
          issues.add('system_message_position');
        }
        system.push(...systemEntries(message.content, issues));
        break;
      }
      case 'user': {
        if (typeof message.content === 'string') {
          push('user', [{ type: 'text', text: message.content }], message.content);
        } else {
          push('user', userBlocks(message.content, issues), null);
        }
        break;
      }
      case 'assistant': {
        const { blocks, plain } = assistantBlocks(message, issues);
        push('assistant', blocks, plain);
        break;
      }
      case 'tool': {
        push('user', [toolResultBlock(message, issues)], null);
        break;
      }
      case 'function': {
        issues.add('openai_legacy_functions');
        break;
      }
      default:
        issues.add('malformed_request');
    }
  }

  if (drafts.at(-1)?.role === 'assistant') {
    issues.add('assistant_prefill');
  }
  const messages = drafts.map(
    (draft): AnthropicMessage => ({
      role: draft.role,
      content: draft.plain ?? draft.blocks,
    }),
  );
  return { system, messages };
}

function systemEntries(content: unknown, issues: Issues): SystemEntry[] {
  if (typeof content === 'string') {
    return [{ block: { type: 'text', text: content }, plain: content }];
  }
  return textBlocks(content, issues).map((block) => ({ block, plain: null }));
}

/** Content that may only hold text: a string, or an array of text parts. */
function textBlocks(content: unknown, issues: Issues): AnthropicTextBlock[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  if (!Array.isArray(content)) {
    issues.add('malformed_request');
    return [];
  }
  const blocks: AnthropicTextBlock[] = [];
  for (const part of content) {
    const block = textPart(part, issues);
    if (block !== null) {
      blocks.push(block);
    }
  }
  return blocks;
}

function textPart(part: unknown, issues: Issues): AnthropicTextBlock | null {
  if (!isRecord(part) || part.type !== 'text' || typeof part.text !== 'string') {
    if (isRecord(part) && part.type === 'refusal') {
      issues.add('assistant_refusal');
    } else if (isRecord(part) && typeof part.type === 'string' && part.type !== 'text') {
      issues.add('unknown_content_type');
    } else {
      issues.add('malformed_request');
    }
    return null;
  }
  if (hasUnknownKey(part, TEXT_PART_KEYS)) {
    issues.add('unknown_field');
  }
  return { type: 'text', text: part.text };
}

function userBlocks(content: unknown, issues: Issues): AnthropicContentBlock[] {
  if (!Array.isArray(content) || content.length === 0) {
    issues.add('malformed_request');
    return [];
  }
  const blocks: AnthropicContentBlock[] = [];
  for (const part of content) {
    if (!isRecord(part)) {
      issues.add('malformed_request');
      continue;
    }
    switch (part.type) {
      case 'text': {
        const block = textPart(part, issues);
        if (block !== null) {
          blocks.push(block);
        }
        break;
      }
      case 'image_url': {
        const block = imageBlock(part, issues);
        if (block !== null) {
          blocks.push(block);
        }
        break;
      }
      case 'input_audio':
        issues.add('openai_audio');
        break;
      case 'file':
        issues.add('openai_file_input');
        break;
      default:
        issues.add(typeof part.type === 'string' ? 'unknown_content_type' : 'malformed_request');
    }
  }
  return blocks;
}

const DATA_URL = /^data:([^;,]+);base64,(.*)$/s;

function imageBlock(part: Record<string, unknown>, issues: Issues): AnthropicImageBlock | null {
  if (hasUnknownKey(part, IMAGE_PART_KEYS)) {
    issues.add('unknown_field');
  }
  const image = part.image_url;
  if (!isRecord(image) || typeof image.url !== 'string') {
    issues.add('malformed_request');
    return null;
  }
  if (hasUnknownKey(image, IMAGE_URL_KEYS)) {
    issues.add('unknown_field');
  }
  if (isSet(image.detail) && image.detail !== 'auto') {
    issues.add('openai_image_detail');
  }
  const url = image.url;
  if (url.startsWith('data:')) {
    const match = DATA_URL.exec(url);
    if (match === null) {
      issues.add('malformed_request');
      return null;
    }
    const mediaType = (match[1] ?? '').toLowerCase();
    if (!ANTHROPIC_IMAGE_TYPES.has(mediaType)) {
      issues.add('image_media_type');
      return null;
    }
    return { type: 'image', source: { type: 'base64', media_type: mediaType, data: match[2] ?? '' } };
  }
  if (/^https?:\/\//i.test(url)) {
    return { type: 'image', source: { type: 'url', url } };
  }
  issues.add('malformed_request');
  return null;
}

function assistantBlocks(
  message: Record<string, unknown>,
  issues: Issues,
): { blocks: AnthropicContentBlock[]; plain: string | null } {
  if (isSet(message.refusal)) {
    issues.add('assistant_refusal');
  }
  if (isSet(message.audio)) {
    issues.add('openai_audio');
  }
  if (isSet(message.function_call)) {
    issues.add('openai_legacy_functions');
  }
  const toolCalls = message.tool_calls;
  const hasToolCalls = Array.isArray(toolCalls) && toolCalls.length > 0;
  if (isSet(toolCalls) && !Array.isArray(toolCalls)) {
    issues.add('malformed_request');
  }

  const blocks: AnthropicContentBlock[] = [];
  const content = message.content;
  if (typeof content === 'string') {
    // An empty string next to tool calls is how many clients say "no text"; it is not content.
    if (content !== '' || !hasToolCalls) {
      blocks.push({ type: 'text', text: content });
    }
  } else if (Array.isArray(content)) {
    blocks.push(...textBlocks(content, issues));
  } else if (isSet(content)) {
    issues.add('malformed_request');
  } else if (!hasToolCalls && !isSet(message.function_call) && !isSet(message.refusal)) {
    issues.add('malformed_request');
  }

  if (hasToolCalls) {
    for (const call of toolCalls) {
      const block = toolUseBlock(call, issues);
      if (block !== null) {
        blocks.push(block);
      }
    }
  }
  const plain = typeof content === 'string' && !hasToolCalls ? content : null;
  return { blocks, plain };
}

function toolUseBlock(call: unknown, issues: Issues): AnthropicContentBlock | null {
  if (!isRecord(call)) {
    issues.add('malformed_request');
    return null;
  }
  if (call.type !== 'function') {
    issues.add(typeof call.type === 'string' ? 'openai_custom_tool' : 'malformed_request');
    return null;
  }
  if (hasUnknownKey(call, TOOL_CALL_KEYS)) {
    issues.add('unknown_field');
  }
  const fn = call.function;
  if (!isNonEmptyString(call.id) || !isRecord(fn) || !isNonEmptyString(fn.name)) {
    issues.add('malformed_request');
    return null;
  }
  if (hasUnknownKey(fn, FUNCTION_CALL_KEYS)) {
    issues.add('unknown_field');
  }
  const input = parseArguments(fn.arguments);
  if (input === null) {
    issues.add('tool_arguments_not_json');
    return null;
  }
  return { type: 'tool_use', id: call.id, name: fn.name, input };
}

function toolResultBlock(message: Record<string, unknown>, issues: Issues): AnthropicContentBlock {
  const id = message.tool_call_id;
  if (!isNonEmptyString(id)) {
    issues.add('malformed_request');
  }
  const content = typeof message.content === 'string' ? message.content : textBlocks(message.content, issues);
  return { type: 'tool_result', tool_use_id: typeof id === 'string' ? id : '', content };
}

function convertTools(value: unknown, issues: Issues): AnthropicTool[] {
  if (!isSet(value)) {
    return [];
  }
  if (!Array.isArray(value)) {
    issues.add('malformed_request');
    return [];
  }
  const tools: AnthropicTool[] = [];
  for (const tool of value) {
    if (!isRecord(tool)) {
      issues.add('malformed_request');
      continue;
    }
    if (tool.type !== 'function') {
      issues.add(typeof tool.type === 'string' ? 'openai_custom_tool' : 'malformed_request');
      continue;
    }
    if (hasUnknownKey(tool, TOOL_KEYS)) {
      issues.add('unknown_field');
    }
    const fn = tool.function;
    if (!isRecord(fn) || !isNonEmptyString(fn.name)) {
      issues.add('malformed_request');
      continue;
    }
    if (hasUnknownKey(fn, FUNCTION_KEYS)) {
      issues.add('unknown_field');
    }
    if (fn.strict === true) {
      issues.add('tool_strict');
    }
    if (isSet(fn.description) && typeof fn.description !== 'string') {
      issues.add('malformed_request');
    }
    if (isSet(fn.parameters) && !isRecord(fn.parameters)) {
      issues.add('malformed_request');
    }
    // OpenAI treats a function without parameters as taking none; Anthropic requires a schema.
    const inputSchema = isRecord(fn.parameters) ? fn.parameters : { type: 'object', properties: {} };
    const converted: AnthropicTool = { name: fn.name, input_schema: inputSchema };
    if (typeof fn.description === 'string') {
      converted.description = fn.description;
    }
    tools.push(converted);
  }
  return tools;
}

function convertToolChoice(value: unknown, issues: Issues): AnthropicToolChoice | undefined {
  if (!isSet(value)) {
    return undefined;
  }
  if (value === 'none' || value === 'auto') {
    return { type: value };
  }
  if (value === 'required') {
    return { type: 'any' };
  }
  if (isRecord(value)) {
    if (value.type === 'function') {
      const fn = value.function;
      if (isRecord(fn) && isNonEmptyString(fn.name)) {
        if (hasUnknownKey(value, TOOL_KEYS) || hasUnknownKey(fn, new Set(['name']))) {
          issues.add('unknown_field');
        }
        return { type: 'tool', name: fn.name };
      }
    } else if (typeof value.type === 'string') {
      issues.add('openai_custom_tool');
      return undefined;
    }
  }
  issues.add('malformed_request');
  return undefined;
}

/** True for JSON mode; json_schema and anything unexpected are reported. */
function readJsonMode(value: unknown, issues: Issues): boolean {
  if (!isSet(value)) {
    return false;
  }
  if (!isRecord(value)) {
    issues.add('malformed_request');
    return false;
  }
  switch (value.type) {
    case 'text':
      return false;
    case 'json_object':
      return true;
    case 'json_schema':
      issues.add('json_schema');
      return false;
    default:
      issues.add('malformed_request');
      return false;
  }
}

// --- Response: Anthropic Messages -> OpenAI Chat Completions --------------------------------------

export interface AnthropicResponseToOpenAIOptions {
  /** Unix time in seconds for the `created` field; the caller supplies it so this stays pure. */
  readonly created: number;
  /** The `jsonMode` returned by translateOpenAIRequestToAnthropic for the same request. */
  readonly jsonMode?: boolean;
}

/**
 * Translates a non-streaming Anthropic Messages response to an OpenAI Chat Completions response.
 *
 * - Text blocks are joined, in order, into `message.content` (null when there is none).
 * - tool_use blocks become `tool_calls`, their input serialised as the JSON `arguments`.
 * - stop_reason: end_turn and stop_sequence -> stop, max_tokens -> length, tool_use -> tool_calls,
 *   refusal -> content_filter. Which stop sequence matched is not reported: OpenAI has no field.
 * - usage: prompt_tokens counts every input token, cached or not (Anthropic's input_tokens
 *   excludes cache reads and writes); cache reads also go to prompt_tokens_details.cached_tokens.
 * - In JSON mode the forced tool call becomes the message content and finish_reason "stop".
 *
 * Throws TranslationError for anything else (thinking or server-tool blocks, an unknown stop reason,
 * a missing usage): a response is never passed on with parts silently dropped.
 */
export function translateAnthropicResponseToOpenAI(
  response: unknown,
  options: AnthropicResponseToOpenAIOptions,
): OpenAIResponse {
  const problems = new Problems<ResponseProblemCode>();
  const fail = (): never => {
    throw new TranslationError('response', 'anthropic', 'openai', problems.list());
  };
  if (
    !isRecord(response) ||
    !Array.isArray(response.content) ||
    typeof response.id !== 'string' ||
    typeof response.model !== 'string'
  ) {
    problems.add('malformed_response');
    return fail();
  }
  const jsonMode = options.jsonMode === true;

  const texts: string[] = [];
  const toolCalls: OpenAIToolCall[] = [];
  let jsonContent: string | null = null;
  for (const block of response.content) {
    if (!isRecord(block)) {
      problems.add('malformed_response');
      continue;
    }
    if (block.type === 'text' && typeof block.text === 'string') {
      if (isSet(block.citations) && !(Array.isArray(block.citations) && block.citations.length === 0)) {
        problems.add('unsupported_response_content');
      }
      texts.push(block.text);
    } else if (block.type === 'tool_use') {
      if (!isNonEmptyString(block.id) || !isNonEmptyString(block.name) || !isRecord(block.input)) {
        problems.add('malformed_response');
      } else if (jsonMode) {
        if (block.name === JSON_MODE_TOOL_NAME && jsonContent === null) {
          jsonContent = JSON.stringify(block.input);
        } else {
          problems.add('unsupported_response_content');
        }
      } else {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: JSON.stringify(block.input) },
        });
      }
    } else {
      problems.add('unsupported_response_content');
    }
  }

  let finishReason = toOpenAIFinishReason(response.stop_reason);
  if (finishReason === undefined) {
    problems.add('unknown_stop_reason');
  }
  let content: string | null = texts.length > 0 ? texts.join('') : null;
  if (jsonMode) {
    if (jsonContent !== null) {
      content = jsonContent;
      if (finishReason === 'tool_calls') {
        finishReason = 'stop';
      }
    } else if (problems.empty && finishReason !== 'length' && finishReason !== 'content_filter') {
      // A forced tool call that never came, without running out of budget: there is no JSON to return.
      problems.add('malformed_response');
    }
  }

  const usage = toOpenAIUsage(response.usage);
  if (usage === null) {
    problems.add('malformed_response');
  }
  if (!problems.empty || usage === null || finishReason === undefined) {
    return fail();
  }

  const message: OpenAIResponse['choices'][0]['message'] = { role: 'assistant', content, refusal: null };
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }
  return {
    id: response.id,
    object: 'chat.completion',
    created: options.created,
    model: response.model,
    choices: [{ index: 0, message, finish_reason: finishReason, logprobs: null }],
    usage,
  };
}
