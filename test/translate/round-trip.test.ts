import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  translateAnthropicRequestToOpenAI,
  translateAnthropicResponseToOpenAI,
  translateOpenAIRequestToAnthropic,
  translateOpenAIResponseToAnthropic,
  untranslatable,
} from '../../src/translate/index.ts';

const created = 1_758_000_000;

/** Anthropic -> OpenAI -> Anthropic. */
function anthropicRoundTrip(request: unknown): unknown {
  const openai = translateAnthropicRequestToOpenAI(request);
  assert.deepEqual(untranslatable(openai, 'anthropic'), []);
  return translateOpenAIRequestToAnthropic(openai).body;
}

/** OpenAI -> Anthropic -> OpenAI. */
function openaiRoundTrip(request: unknown): unknown {
  const anthropic = translateOpenAIRequestToAnthropic(request).body;
  assert.deepEqual(untranslatable(anthropic, 'openai'), []);
  return translateAnthropicRequestToOpenAI(anthropic);
}

// Canonical requests: already in the normal form the translators emit, so a round trip must give
// back exactly the same body.
const ANTHROPIC_REQUESTS: Record<string, unknown> = {
  'plain conversation with a system string': {
    model: 'claude-test',
    max_tokens: 256,
    system: 'Be brief.',
    messages: [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello.' },
      { role: 'user', content: 'Bye' },
    ],
  },
  'system blocks, multi-part text and images': {
    model: 'claude-test',
    max_tokens: 256,
    system: [
      { type: 'text', text: 'One.' },
      { type: 'text', text: 'Two.' },
    ],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Look:' },
          { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: 'UklGRg==' } },
          { type: 'image', source: { type: 'url', url: 'https://example.com/b.gif' } },
        ],
      },
    ],
  },
  'tool use loop with parallel calls disabled': {
    model: 'claude-test',
    max_tokens: 512,
    tools: [
      {
        name: 'get_weather',
        description: 'Weather',
        input_schema: { type: 'object', properties: { city: { type: 'string' } } },
      },
      { name: 'get_time', input_schema: { type: 'object', properties: {} } },
    ],
    tool_choice: { type: 'any', disable_parallel_tool_use: true },
    messages: [
      { role: 'user', content: 'Weather in Porto?' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Checking.' },
          { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Porto' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'Sunny' },
          { type: 'text', text: 'And the time?' },
        ],
      },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_2', name: 'get_time', input: {} }] },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: [{ type: 'text', text: '12:00' }] }],
      },
    ],
  },
  'sampling, stop sequences and user id': {
    model: 'claude-test',
    max_tokens: 64,
    temperature: 0.3,
    top_p: 0.95,
    stop_sequences: ['END'],
    metadata: { user_id: 'end-user-7' },
    tool_choice: { type: 'tool', name: 'f' },
    tools: [{ name: 'f', input_schema: { type: 'object' } }],
    messages: [{ role: 'user', content: 'Go' }],
  },
};

const OPENAI_REQUESTS: Record<string, unknown> = {
  'plain conversation with a system message': {
    model: 'gpt-test',
    max_tokens: 256,
    messages: [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello.' },
      { role: 'user', content: 'Bye' },
    ],
  },
  'multi-part text and images': {
    model: 'gpt-test',
    max_tokens: 256,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Look:' },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/4AAQ' } },
          { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
        ],
      },
    ],
  },
  'tool calling with results and a forced function': {
    model: 'gpt-test',
    max_tokens: 512,
    tools: [
      { type: 'function', function: { name: 'get_weather', description: 'Weather', parameters: { type: 'object' } } },
    ],
    tool_choice: { type: 'function', function: { name: 'get_weather' } },
    parallel_tool_calls: false,
    messages: [
      { role: 'user', content: 'Weather in Porto and Lisbon?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Porto"}' } },
          { id: 'call_2', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Lisbon"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'Sunny' },
      { role: 'tool', tool_call_id: 'call_2', content: 'Rain' },
    ],
  },
  'sampling, stop and user': {
    model: 'gpt-test',
    max_tokens: 64,
    temperature: 0.9,
    top_p: 0.5,
    stop: ['###', 'END'],
    user: 'end-user-7',
    tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }],
    tool_choice: 'required',
    messages: [{ role: 'user', content: 'Go' }],
  },
};

describe('round trip: Anthropic request -> OpenAI -> Anthropic', () => {
  for (const [name, request] of Object.entries(ANTHROPIC_REQUESTS)) {
    test(name, () => {
      assert.deepEqual(anthropicRoundTrip(request), request);
    });
  }
});

describe('round trip: OpenAI request -> Anthropic -> OpenAI', () => {
  for (const [name, request] of Object.entries(OPENAI_REQUESTS)) {
    test(name, () => {
      assert.deepEqual(openaiRoundTrip(request), request);
    });
  }

  test('non-canonical forms come back in their documented normal form', () => {
    const result = openaiRoundTrip({
      model: 'gpt-test',
      max_completion_tokens: 32,
      stop: 'END',
      messages: [
        { role: 'developer', content: 'Rules.' },
        { role: 'user', content: 'a' },
        { role: 'user', content: 'b' },
      ],
    });
    assert.deepEqual(result, {
      model: 'gpt-test',
      max_tokens: 32,
      stop: ['END'],
      messages: [
        { role: 'system', content: 'Rules.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'a' },
            { type: 'text', text: 'b' },
          ],
        },
      ],
    });
  });
});

describe('round trip: responses', () => {
  test('Anthropic response -> OpenAI -> Anthropic keeps content, tool calls, stop reason and usage', () => {
    const response = {
      id: 'msg_01',
      type: 'message',
      role: 'assistant',
      model: 'claude-test',
      content: [
        { type: 'text', text: 'Checking.' },
        { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Porto', days: 3 } },
      ],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 40, output_tokens: 12, cache_creation_input_tokens: 0, cache_read_input_tokens: 25 },
    };
    const back = translateOpenAIResponseToAnthropic(translateAnthropicResponseToOpenAI(response, { created }));
    assert.deepEqual(back, response);
  });

  for (const stop_reason of ['end_turn', 'max_tokens', 'refusal'] as const) {
    test(`Anthropic stop_reason ${stop_reason} survives the round trip`, () => {
      const response = {
        id: 'msg_02',
        type: 'message',
        role: 'assistant',
        model: 'claude-test',
        content: [{ type: 'text', text: 'Text.' }],
        stop_reason,
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 1, cache_creation_input_tokens: null, cache_read_input_tokens: null },
      };
      assert.deepEqual(
        translateOpenAIResponseToAnthropic(translateAnthropicResponseToOpenAI(response, { created })),
        response,
      );
    });
  }

  test('OpenAI response -> Anthropic -> OpenAI keeps content, tool calls, finish reason and usage', () => {
    const response = {
      id: 'chatcmpl-9',
      object: 'chat.completion',
      created,
      model: 'gpt-test',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'Checking.',
            refusal: null,
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'f', arguments: '{"a":[1,2]}' } }],
          },
          finish_reason: 'tool_calls',
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: 90,
        completion_tokens: 10,
        total_tokens: 100,
        prompt_tokens_details: { cached_tokens: 64 },
      },
    };
    assert.deepEqual(
      translateAnthropicResponseToOpenAI(translateOpenAIResponseToAnthropic(response), { created }),
      response,
    );
  });

  for (const finish_reason of ['stop', 'length', 'content_filter'] as const) {
    test(`OpenAI finish_reason ${finish_reason} survives the round trip`, () => {
      const response = {
        id: 'chatcmpl-10',
        object: 'chat.completion',
        created,
        model: 'gpt-test',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'Text.', refusal: null }, finish_reason, logprobs: null },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      };
      assert.deepEqual(
        translateAnthropicResponseToOpenAI(translateOpenAIResponseToAnthropic(response), { created }),
        response,
      );
    });
  }
});
