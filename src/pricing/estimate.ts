// Pre-call token estimation, used only to rank candidate providers by price before any request
// is sent. This is never the number shown to the user as actual cost or savings: once a call has
// happened, the token usage the provider reports in its response is always the source of truth.
// Pure, synchronous, no I/O.

import { countTokens } from 'gpt-tokenizer';
import type { WireFormat } from '../providers/types.ts';

/**
 * Characters per token for the Anthropic-format heuristic. Anthropic publishes no offline
 * tokenizer; the only exact option is its `count_tokens` endpoint, which is a network call per
 * routing decision and unacceptable on the hot path. Roughly four characters per token is the
 * commonly cited approximation for English prose; it is coarse, and good enough only for ranking.
 */
export const ANTHROPIC_CHARS_PER_TOKEN = 4;

/**
 * Request text is user content, not a prompt template: a message may legitimately contain strings
 * such as `<|endoftext|>`. Counting them as plain text (instead of gpt-tokenizer's default, which
 * throws on special-token strings) keeps estimation total over every input.
 */
const COUNT_OPTIONS: Parameters<typeof countTokens>[1] = { disallowedSpecial: new Set<string>() };

export interface TokenEstimate {
  readonly tokens: number;
  /** Always "estimated": this module never reports a provider-verified count. */
  readonly origin: 'estimated';
}

/**
 * Longest piece of text handed to the tokenizer in one call. gpt-tokenizer's byte-pair merge is
 * quadratic in the length of a single pre-token, and a run with no whitespace (one repeated
 * character, zero padding, a base64 blob) is a single pre-token however long it is. Cutting the
 * text into short pieces caps that quadratic term, so the cost grows linearly with the input.
 * Pieces are cut just before a space that starts a word when one is near the limit: the tokenizer
 * splits there anyway (a word carries its leading space), so on ordinary text the pieces add up to
 * the same count as the whole. The count only drifts where no such space exists and a cut lands
 * inside a run of non-space characters.
 */
export const TOKENIZER_CHUNK_CHARS = 256;

/**
 * Most characters that are ever run through the tokenizer for one request. Linear is not enough on
 * the hot path: high-entropy text (random CJK, punctuation, accented letters) costs up to about
 * 2 ms per 1,000 characters even in short pieces, and a request body can be many megabytes. Text up
 * to this size is counted in full; longer text is sampled with evenly spaced pieces whose
 * tokens-per-character ratio is scaled to the whole length. That bounds the tokenizer work per
 * request to about 20 ms in the worst case measured (random CJK text) and under 1 ms for ordinary
 * prose, at the price of an error of a few percent on large requests, which is harmless for ranking.
 */
export const TOKENIZER_SAMPLE_CHARS = 8_192;

/**
 * Estimates the input token count of a chat request body, purely to rank candidate providers by
 * price before any call is made. OpenAI-format requests are counted with `gpt-tokenizer`, always
 * with its default `o200k_base` encoding whatever the target model (older models use
 * `cl100k_base`; the difference is small and does not matter for ranking), within the bounds
 * described above. Anthropic-format requests use the characters-per-token heuristic above.
 * `body` is read defensively: unrecognised or malformed shapes simply contribute no text, they
 * never throw here (validation is inspect()'s job). Runs in time linear in the size of the text.
 */
export function estimateInput(format: WireFormat, body: object): TokenEstimate {
  const text = extractText(format, body);
  const tokens = format === 'openai' ? countOpenAiTokens(text) : Math.ceil(text.length / ANTHROPIC_CHARS_PER_TOKEN);
  return { tokens, origin: 'estimated' };
}

function countOpenAiTokens(text: string): number {
  if (text.length <= TOKENIZER_SAMPLE_CHARS) {
    let tokens = 0;
    for (let start = 0; start < text.length; ) {
      const end = pieceEnd(text, start);
      tokens += countTokens(text.slice(start, end), COUNT_OPTIONS);
      start = end;
    }
    return tokens;
  }

  const pieces = TOKENIZER_SAMPLE_CHARS / TOKENIZER_CHUNK_CHARS;
  const stride = (text.length - TOKENIZER_CHUNK_CHARS) / (pieces - 1);
  let sampledTokens = 0;
  let sampledChars = 0;
  for (let i = 0; i < pieces; i++) {
    const start = sampleStart(text, Math.floor(i * stride));
    const end = pieceEnd(text, start);
    sampledTokens += countTokens(text.slice(start, end), COUNT_OPTIONS);
    sampledChars += end - start;
  }
  return Math.round((sampledTokens * text.length) / sampledChars);
}

/**
 * End (exclusive) of the piece that starts at `start`: at most TOKENIZER_CHUNK_CHARS long, cut
 * before the last word-starting space in its second half when there is one, and never between the two
 * halves of a surrogate pair.
 */
function pieceEnd(text: string, start: number): number {
  const limit = start + TOKENIZER_CHUNK_CHARS;
  if (limit >= text.length) {
    return text.length;
  }
  for (let i = limit; i > start + TOKENIZER_CHUNK_CHARS / 2; i--) {
    if (text.charCodeAt(i) === SPACE && !isWhitespace(text.charCodeAt(i + 1))) {
      return i;
    }
  }
  return isHighSurrogate(text.charCodeAt(limit - 1)) ? limit - 1 : limit;
}

/**
 * Where a sample piece starts: at the next word-starting space if one is within a few characters,
 * so the piece does not begin with a cut word (which the tokenizer would count as extra tokens and
 * inflate the ratio). The search is kept short so dense text without spaces, such as base64, is
 * still sampled where it lies instead of being skipped in favour of nearby prose.
 */
function sampleStart(text: string, position: number): number {
  const limit = Math.min(text.length - 1, position + SAMPLE_ALIGN_CHARS);
  for (let i = position; i < limit; i++) {
    if (text.charCodeAt(i) === SPACE && !isWhitespace(text.charCodeAt(i + 1))) {
      return i;
    }
  }
  return alignToCodePoint(text, position);
}

const SAMPLE_ALIGN_CHARS = 16;

/** Moves a cut position forward when it would fall between the two halves of a surrogate pair. */
function alignToCodePoint(text: string, position: number): number {
  return isLowSurrogate(text.charCodeAt(position)) ? position + 1 : position;
}

const SPACE = 0x20;

function isWhitespace(code: number): boolean {
  return code === SPACE || code === 0x0a || code === 0x0d || code === 0x09;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Concatenates every piece of text the request would actually send to the model. */
function extractText(format: WireFormat, body: object): string {
  const record = body as Record<string, unknown>;
  const parts: string[] = [];

  if (format === 'anthropic') {
    parts.push(...textFromContent(record.system));
  }

  const messages = Array.isArray(record.messages) ? record.messages : [];
  for (const message of messages) {
    if (message !== null && typeof message === 'object') {
      const entry = message as Record<string, unknown>;
      parts.push(...textFromContent(entry.content));
      if (format === 'openai') {
        parts.push(...toolCallArguments(entry.tool_calls));
      }
    }
  }

  if (Array.isArray(record.tools)) {
    parts.push(safeStringify(record.tools));
  }
  if (format === 'openai' && Array.isArray(record.functions)) {
    parts.push(safeStringify(record.functions));
  }

  return parts.join('\n');
}

/**
 * Pulls every string of readable text out of a message's `content` field, whatever shape it has,
 * including the nested `content` of an Anthropic `tool_result` block.
 */
function textFromContent(content: unknown): string[] {
  if (typeof content === 'string') {
    return [content];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  const out: string[] = [];
  for (const part of content) {
    if (part === null || typeof part !== 'object') {
      continue;
    }
    const block = part as Record<string, unknown>;
    if (typeof block.text === 'string') {
      out.push(block.text);
    }
    if (block.type === 'tool_result') {
      out.push(...textFromContent(block.content));
    }
  }
  return out;
}

/** The JSON argument strings of the tool calls in an OpenAI assistant message. */
function toolCallArguments(toolCalls: unknown): string[] {
  if (!Array.isArray(toolCalls)) {
    return [];
  }
  const out: string[] = [];
  for (const call of toolCalls) {
    if (call === null || typeof call !== 'object') {
      continue;
    }
    const fn = (call as Record<string, unknown>).function;
    if (fn !== null && typeof fn === 'object') {
      const args = (fn as Record<string, unknown>).arguments;
      if (typeof args === 'string') {
        out.push(args);
      }
    }
  }
  return out;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}
