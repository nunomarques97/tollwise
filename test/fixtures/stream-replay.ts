// Replays recorded provider streams (test/fixtures/streams/*.sse) through the stream transformers of
// src/translate, and folds translated streams back into whole messages so they can be compared with
// the non-streaming translation.

import { readFileSync } from 'node:fs';
import { SseScanner } from '../../src/proxy/sse.ts';
import {
  type AnthropicStreamEvent,
  type AnthropicStreamToOpenAIOptions,
  AnthropicToOpenAIStream,
  formatAnthropicEvent,
  formatOpenAIItem,
  type OpenAIStreamItem,
  OpenAIToAnthropicStream,
} from '../../src/translate/index.ts';

export const STREAMS_DIR = new URL('./streams/', import.meta.url);
export const TRANSLATED_DIR = new URL('./streams/translated/', import.meta.url);

/** The data field of every event in an SSE body, in order, read with the proxy's own scanner. */
export function sseData(body: string): string[] {
  const data: string[] = [];
  const scanner = new SseScanner({
    onEvent: (event) => {
      data.push(event.data.toString('utf8'));
      return 'forward';
    },
  });
  scanner.scan(Buffer.from(body, 'utf8'), []);
  scanner.end([]);
  return data;
}

export function readStream(name: string): string {
  return readFileSync(new URL(name, STREAMS_DIR), 'utf8');
}

export function readTranslated(name: string): string {
  return readFileSync(new URL(name, TRANSLATED_DIR), 'utf8');
}

/** An OpenAI stream body through OpenAIToAnthropicStream, fed event by event, then ended. */
export function openaiToAnthropic(body: string): {
  events: AnthropicStreamEvent[];
  text: string;
  stream: OpenAIToAnthropicStream;
} {
  const stream = new OpenAIToAnthropicStream();
  const events: AnthropicStreamEvent[] = [];
  for (const data of sseData(body)) {
    events.push(...stream.pushData(data));
  }
  events.push(...stream.end());
  return { events, text: events.map(formatAnthropicEvent).join(''), stream };
}

/** An Anthropic stream body through AnthropicToOpenAIStream, fed event by event, then ended. */
export function anthropicToOpenAI(
  body: string,
  options: AnthropicStreamToOpenAIOptions,
): { items: OpenAIStreamItem[]; text: string; stream: AnthropicToOpenAIStream } {
  const stream = new AnthropicToOpenAIStream(options);
  const items: OpenAIStreamItem[] = [];
  for (const data of sseData(body)) {
    items.push(...stream.pushData(data));
  }
  items.push(...stream.end());
  return { items, text: items.map(formatOpenAIItem).join(''), stream };
}

/** Folds Anthropic stream events into the message a client SDK would build from them. */
export function foldAnthropicEvents(events: readonly AnthropicStreamEvent[]): Record<string, unknown> {
  let message: Record<string, unknown> = {};
  const content: Record<string, unknown>[] = [];
  const partialJson = new Map<number, string>();
  for (const event of events) {
    switch (event.type) {
      case 'message_start':
        message = { ...event.message, content, usage: { ...event.message.usage } };
        break;
      case 'content_block_start':
        content[event.index] = { ...event.content_block };
        break;
      case 'content_block_delta': {
        const block = content[event.index] as Record<string, unknown>;
        if (event.delta.type === 'text_delta') {
          block.text = `${block.text as string}${event.delta.text}`;
        } else {
          partialJson.set(event.index, `${partialJson.get(event.index) ?? ''}${event.delta.partial_json}`);
        }
        break;
      }
      case 'content_block_stop': {
        const json = partialJson.get(event.index);
        if (json !== undefined) {
          (content[event.index] as Record<string, unknown>).input = JSON.parse(json);
        }
        break;
      }
      case 'message_delta':
        message.stop_reason = event.delta.stop_reason;
        message.stop_sequence = event.delta.stop_sequence;
        message.usage = { ...(message.usage as Record<string, unknown>), ...event.usage };
        break;
      case 'message_stop':
      case 'error':
        break;
    }
  }
  return message;
}

/** Folds OpenAI stream items into the completion a client SDK would build from them. */
export function foldOpenAIItems(items: readonly OpenAIStreamItem[]): Record<string, unknown> {
  let completion: Record<string, unknown> = {};
  let content: string | null = null;
  const toolCalls: { id: string; type: 'function'; function: { name: string; arguments: string } }[] = [];
  let finishReason: string | null = null;
  for (const item of items) {
    if (item === '[DONE]' || 'error' in item) {
      continue;
    }
    completion = { id: item.id, model: item.model, created: item.created, usage: item.usage ?? completion.usage };
    const choice = item.choices[0];
    if (choice === undefined) {
      continue;
    }
    if (choice.delta.content !== undefined) {
      content = (content ?? '') + choice.delta.content;
    }
    for (const call of choice.delta.tool_calls ?? []) {
      const existing = toolCalls[call.index];
      if (existing === undefined) {
        toolCalls[call.index] = {
          id: call.id ?? '',
          type: 'function',
          function: { name: call.function.name ?? '', arguments: call.function.arguments },
        };
      } else {
        existing.function.arguments += call.function.arguments;
      }
    }
    finishReason = choice.finish_reason ?? finishReason;
  }
  const message: Record<string, unknown> = { role: 'assistant', content: content === '' ? null : content };
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }
  return { ...completion, message, finish_reason: finishReason };
}
