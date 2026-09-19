import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  TranslationError,
  translateAnthropicRequestToOpenAI,
  translateOpenAIResponseToAnthropic,
} from '../../src/translate/index.ts';

const user = { role: 'user', content: 'Hello' };

/** Translates a request built from `extra` plus a minimal valid base. */
function toOpenAI(extra: Record<string, unknown>, options = {}) {
  return translateAnthropicRequestToOpenAI(
    { model: 'claude-test', max_tokens: 100, messages: [user], ...extra },
    options,
  );
}

describe('Anthropic request to OpenAI — golden cases', () => {
  test('a minimal request keeps model, budget and a plain-string message', () => {
    assert.deepEqual(toOpenAI({}), {
      model: 'claude-test',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Hello' }],
    });
  });

  test('stream: true is carried over and asks the provider for usage', () => {
    assert.deepEqual(toOpenAI({ stream: true }), {
      model: 'claude-test',
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Hello' }],
    });
  });

  test('the model and maxTokensField options', () => {
    const body = toOpenAI({}, { model: 'gpt-test', maxTokensField: 'max_completion_tokens' });
    assert.equal(body.model, 'gpt-test');
    assert.equal(body.max_completion_tokens, 100);
    assert.equal(body.max_tokens, undefined);
  });

  test('a system string becomes a leading system message', () => {
    assert.deepEqual(toOpenAI({ system: 'Be brief.' }).messages, [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Hello' },
    ]);
  });

  test('system text blocks become text parts of one system message', () => {
    assert.deepEqual(
      toOpenAI({
        system: [
          { type: 'text', text: 'One.' },
          { type: 'text', text: 'Two.' },
        ],
      }).messages[0],
      {
        role: 'system',
        content: [
          { type: 'text', text: 'One.' },
          { type: 'text', text: 'Two.' },
        ],
      },
    );
  });

  test('user and assistant roles, multi-part text', () => {
    const body = toOpenAI({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'First.' },
            { type: 'text', text: 'Second.' },
          ],
        },
        { role: 'assistant', content: 'Answer.' },
        { role: 'user', content: 'More.' },
      ],
    });
    assert.deepEqual(body.messages, [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'First.' },
          { type: 'text', text: 'Second.' },
        ],
      },
      { role: 'assistant', content: 'Answer.' },
      { role: 'user', content: 'More.' },
    ]);
  });

  test('assistant text blocks are joined into one content string', () => {
    const body = toOpenAI({
      messages: [
        user,
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Part one, ' },
            { type: 'text', text: 'part two.' },
          ],
        },
        user,
      ],
    });
    assert.deepEqual(body.messages[1], { role: 'assistant', content: 'Part one, part two.' });
  });

  test('base64 images become data URLs and url images stay URLs', () => {
    const body = toOpenAI({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '/9j/4AAQ' } },
            { type: 'image', source: { type: 'url', url: 'https://example.com/cat.png' } },
            { type: 'text', text: 'Compare.' },
          ],
        },
      ],
    });
    assert.deepEqual(body.messages[0], {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/4AAQ' } },
        { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } },
        { type: 'text', text: 'Compare.' },
      ],
    });
  });

  test('tools, tool_use and tool_result map to function tools, tool_calls and tool messages', () => {
    const body = toOpenAI({
      tools: [
        {
          name: 'get_weather',
          description: 'Weather for a city',
          input_schema: { type: 'object', properties: { city: { type: 'string' } } },
        },
        { name: 'get_time', input_schema: { type: 'object', properties: {} }, type: 'custom' },
      ],
      messages: [
        user,
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Checking.' },
            { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Porto' } },
            { type: 'tool_use', id: 'toolu_2', name: 'get_time', input: {} },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: 'Sunny' },
            { type: 'tool_result', tool_use_id: 'toolu_2', content: [{ type: 'text', text: '12:00' }] },
            { type: 'text', text: 'Summarise.' },
          ],
        },
      ],
    });
    assert.deepEqual(body.tools, [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Weather for a city',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        },
      },
      { type: 'function', function: { name: 'get_time', parameters: { type: 'object', properties: {} } } },
    ]);
    assert.deepEqual(body.messages, [
      { role: 'user', content: 'Hello' },
      {
        role: 'assistant',
        content: 'Checking.',
        tool_calls: [
          { id: 'toolu_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Porto"}' } },
          { id: 'toolu_2', type: 'function', function: { name: 'get_time', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'toolu_1', content: 'Sunny' },
      { role: 'tool', tool_call_id: 'toolu_2', content: [{ type: 'text', text: '12:00' }] },
      { role: 'user', content: [{ type: 'text', text: 'Summarise.' }] },
    ]);
  });

  test('an assistant turn of tool calls only has null content; a tool_result without content is empty', () => {
    const body = toOpenAI({
      tools: [{ name: 'f', input_schema: { type: 'object' } }],
      messages: [
        user,
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'f', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1' }] },
      ],
    });
    assert.deepEqual(body.messages.slice(1), [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'f', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'toolu_1', content: '' },
    ]);
  });

  test('tool_choice maps auto/any/none/tool and disable_parallel_tool_use', () => {
    const tools = [{ name: 'f', input_schema: { type: 'object' } }];
    assert.equal(toOpenAI({ tools, tool_choice: { type: 'auto' } }).tool_choice, 'auto');
    assert.equal(toOpenAI({ tools, tool_choice: { type: 'any' } }).tool_choice, 'required');
    assert.equal(toOpenAI({ tools, tool_choice: { type: 'none' } }).tool_choice, 'none');
    assert.deepEqual(toOpenAI({ tools, tool_choice: { type: 'tool', name: 'f' } }).tool_choice, {
      type: 'function',
      function: { name: 'f' },
    });
    const noParallel = toOpenAI({ tools, tool_choice: { type: 'any', disable_parallel_tool_use: true } });
    assert.equal(noParallel.tool_choice, 'required');
    assert.equal(noParallel.parallel_tool_calls, false);
    assert.equal(toOpenAI({ tools, tool_choice: { type: 'auto' } }).parallel_tool_calls, undefined);
  });

  test('stop_sequences, temperature, top_p and metadata.user_id', () => {
    const body = toOpenAI({
      stop_sequences: ['END', '###'],
      temperature: 0.2,
      top_p: 0.8,
      metadata: { user_id: 'end-user-42' },
    });
    assert.deepEqual(body.stop, ['END', '###']);
    assert.equal(body.temperature, 0.2);
    assert.equal(body.top_p, 0.8);
    assert.equal(body.user, 'end-user-42');
  });

  test('neutral values are accepted and dropped', () => {
    const body = toOpenAI({ stream: false, thinking: { type: 'disabled' }, service_tier: 'auto', stop_sequences: [] });
    assert.deepEqual(body, { model: 'claude-test', max_tokens: 100, messages: [{ role: 'user', content: 'Hello' }] });
  });
});

describe('OpenAI response to Anthropic — golden cases', () => {
  const base = { id: 'chatcmpl-1', object: 'chat.completion', created: 1_758_000_000, model: 'gpt-test' };
  const usage = { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 };
  const reply = (message: Record<string, unknown>, finish_reason: string, extra: Record<string, unknown> = {}) => ({
    ...base,
    choices: [{ index: 0, message: { role: 'assistant', refusal: null, ...message }, finish_reason, logprobs: null }],
    usage,
    ...extra,
  });

  test('text content, stop and usage', () => {
    assert.deepEqual(translateOpenAIResponseToAnthropic(reply({ content: 'Hello.' }, 'stop')), {
      id: 'chatcmpl-1',
      type: 'message',
      role: 'assistant',
      model: 'gpt-test',
      content: [{ type: 'text', text: 'Hello.' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 12, output_tokens: 5, cache_creation_input_tokens: null, cache_read_input_tokens: null },
    });
  });

  test('tool_calls become tool_use blocks with parsed input and stop_reason tool_use', () => {
    const result = translateOpenAIResponseToAnthropic(
      reply(
        {
          content: null,
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city": "Porto"}' } },
          ],
        },
        'tool_calls',
      ),
    );
    assert.deepEqual(result.content, [
      { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Porto' } },
    ]);
    assert.equal(result.stop_reason, 'tool_use');
  });

  test('finish reasons map to stop reasons', () => {
    const stop = (finish: string) => translateOpenAIResponseToAnthropic(reply({ content: 'x' }, finish)).stop_reason;
    assert.equal(stop('stop'), 'end_turn');
    assert.equal(stop('length'), 'max_tokens');
    assert.equal(stop('tool_calls'), 'tool_use');
    assert.equal(stop('content_filter'), 'refusal');
  });

  test('cached prompt tokens are split out of input_tokens', () => {
    const result = translateOpenAIResponseToAnthropic(
      reply({ content: 'x' }, 'stop', {
        usage: {
          prompt_tokens: 130,
          completion_tokens: 4,
          total_tokens: 134,
          prompt_tokens_details: { cached_tokens: 100 },
        },
      }),
    );
    assert.deepEqual(result.usage, {
      input_tokens: 30,
      output_tokens: 4,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 100,
    });
  });

  test('empty content gives no blocks; a refusal becomes a text block', () => {
    assert.deepEqual(translateOpenAIResponseToAnthropic(reply({ content: '' }, 'length')).content, []);
    assert.deepEqual(
      translateOpenAIResponseToAnthropic(reply({ content: null, refusal: 'I cannot help with that.' }, 'stop')).content,
      [{ type: 'text', text: 'I cannot help with that.' }],
    );
  });

  test('responses that cannot be represented throw TranslationError with stable codes', () => {
    const codes = (response: unknown) => {
      try {
        translateOpenAIResponseToAnthropic(response);
      } catch (error) {
        assert.ok(error instanceof TranslationError);
        assert.equal(error.subject, 'response');
        assert.equal(error.from, 'openai');
        return error.codes;
      }
      return assert.fail('expected a TranslationError');
    };
    const two = reply({ content: 'a' }, 'stop');
    assert.deepEqual(codes({ ...two, choices: [...two.choices, ...two.choices] }), ['multiple_choices']);
    assert.deepEqual(codes(reply({ content: 'a' }, 'function_call')), ['unknown_stop_reason']);
    assert.deepEqual(
      codes(
        reply(
          { content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: '{oops' } }] },
          'tool_calls',
        ),
      ),
      ['tool_arguments_not_json'],
    );
    assert.deepEqual(codes(reply({ content: 'a' }, 'stop', { usage: undefined })), ['malformed_response']);
    assert.deepEqual(codes(reply({ content: null, function_call: { name: 'f', arguments: '{}' } }, 'function_call')), [
      'unsupported_response_content',
      'unknown_stop_reason',
    ]);
  });
});
