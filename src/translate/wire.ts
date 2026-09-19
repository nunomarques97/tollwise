// The subset of the OpenAI Chat Completions and Anthropic Messages wire shapes that translation
// produces, plus the small readers both directions share. Inputs are always read as `unknown` and
// checked field by field; these types describe outputs only.

// --- Anthropic Messages ---------------------------------------------------------------------------

export interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

export type AnthropicImageSource = { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string };

export interface AnthropicImageBlock {
  type: 'image';
  source: AnthropicImageSource;
}

export interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | AnthropicTextBlock[];
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export type AnthropicToolChoice =
  | { type: 'auto' | 'any' | 'none'; disable_parallel_tool_use?: boolean }
  | { type: 'tool'; name: string; disable_parallel_tool_use?: boolean };

export interface AnthropicRequest {
  model: string;
  max_tokens: number;
  stream?: true;
  system?: string | AnthropicTextBlock[];
  messages: AnthropicMessage[];
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  stop_sequences?: string[];
  temperature?: number;
  top_p?: number;
  metadata?: { user_id: string };
}

export type AnthropicStopReason = 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | 'refusal';

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
}

export interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: (AnthropicTextBlock | AnthropicToolUseBlock)[];
  stop_reason: AnthropicStopReason;
  stop_sequence: string | null;
  usage: AnthropicUsage;
}

// --- OpenAI Chat Completions ----------------------------------------------------------------------

export interface OpenAITextPart {
  type: 'text';
  text: string;
}

export interface OpenAIImagePart {
  type: 'image_url';
  image_url: { url: string };
}

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type OpenAIMessage =
  | { role: 'system'; content: string | OpenAITextPart[] }
  | { role: 'user'; content: string | (OpenAITextPart | OpenAIImagePart)[] }
  | { role: 'assistant'; content: string | null; tool_calls?: OpenAIToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string | OpenAITextPart[] };

export interface OpenAITool {
  type: 'function';
  function: { name: string; description?: string; parameters: Record<string, unknown> };
}

export type OpenAIToolChoice = 'none' | 'auto' | 'required' | { type: 'function'; function: { name: string } };

export interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  stream?: true;
  /** Set with `stream`: usage is always asked for, so the translated stream can report real counts. */
  stream_options?: { include_usage: true };
  max_tokens?: number;
  max_completion_tokens?: number;
  tools?: OpenAITool[];
  tool_choice?: OpenAIToolChoice;
  parallel_tool_calls?: boolean;
  stop?: string[];
  temperature?: number;
  top_p?: number;
  user?: string;
}

export type OpenAIFinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter';

export interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens: number };
}

export interface OpenAIResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: [
    {
      index: 0;
      message: { role: 'assistant'; content: string | null; refusal: null; tool_calls?: OpenAIToolCall[] };
      finish_reason: OpenAIFinishReason;
      logprobs: null;
    },
  ];
  usage: OpenAIUsage;
}

// --- Readers --------------------------------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** True when a field is set. Both formats treat an explicit null like an absent optional field. */
export function isSet(value: unknown): boolean {
  return value !== undefined && value !== null;
}

/** True when `record` has a key outside `known`. */
export function hasUnknownKey(record: Record<string, unknown>, known: ReadonlySet<string>): boolean {
  return Object.keys(record).some((key) => !known.has(key));
}

export function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export function isNumberInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

/** Parses tool-call arguments; returns null unless they are a JSON object. */
export function parseArguments(text: unknown): Record<string, unknown> | null {
  if (typeof text !== 'string') {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Collects codes once each, in the order first seen. */
export class Problems<Code extends string> {
  readonly #seen = new Set<Code>();

  add(code: Code): void {
    this.#seen.add(code);
  }

  list(): Code[] {
    return [...this.#seen];
  }

  get empty(): boolean {
    return this.#seen.size === 0;
  }
}
