import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  JSON_MODE_TOOL_NAME,
  TranslationError,
  translateAnthropicResponseToOpenAI,
  translateOpenAIRequestToAnthropic,
} from '../../src/translate/index.ts';

const user = { role: 'user', content: 'Hello' };

/** Translates a request built from `extra` plus a minimal valid base. */
function toAnthropic(extra: Record<string, unknown>, options = {}) {
  return translateOpenAIRequestToAnthropic({ model: 'gpt-test', max_tokens: 100, messages: [user], ...extra }, options)
    .body;
}

describe('OpenAI request to Anthropic — golden cases', () => {
  test('a minimal request keeps model, budget and a plain-string message', () => {
    assert.deepEqual(toAnthropic({}), {
      model: 'gpt-test',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Hello' }],
    });
  });

  test('the model option replaces the requested model', () => {
    assert.equal(toAnthropic({}, { model: 'claude-test' }).model, 'claude-test');
  });

  test('a single leading system message becomes the system string', () => {
    const body = toAnthropic({ messages: [{ role: 'system', content: 'Be brief.' }, user] });
    assert.equal(body.system, 'Be brief.');
    assert.deepEqual(body.messages, [{ role: 'user', content: 'Hello' }]);
  });

  test('several leading system and developer messages become system text blocks, in order', () => {
    const body = toAnthropic({
      messages: [
        { role: 'system', content: 'One.' },
        { role: 'developer', content: [{ type: 'text', text: 'Two.' }] },
        user,
      ],
    });
    assert.deepEqual(body.system, [
      { type: 'text', text: 'One.' },
      { type: 'text', text: 'Two.' },
    ]);
  });

  test('multi-part user text becomes text blocks', () => {
    const body = toAnthropic({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'First.' },
            { type: 'text', text: 'Second.' },
          ],
        },
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
    ]);
  });

  test('a base64 data URL image becomes a base64 source; an https URL becomes a url source', () => {
    const body = toAnthropic({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Compare.' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
            { type: 'image_url', image_url: { url: 'https://example.com/cat.jpg', detail: 'auto' } },
          ],
        },
      ],
    });
    assert.deepEqual(body.messages[0]?.content, [
      { type: 'text', text: 'Compare.' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
      { type: 'image', source: { type: 'url', url: 'https://example.com/cat.jpg' } },
    ]);
  });

  test('tools, tool calls and tool results map to tools, tool_use and tool_result', () => {
    const body = toAnthropic({
      messages: [
        user,
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Porto"}' } },
            { id: 'call_2', type: 'function', function: { name: 'get_time', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'Sunny' },
        { role: 'tool', tool_call_id: 'call_2', content: [{ type: 'text', text: '12:00' }] },
        { role: 'user', content: 'Thanks. Summarise.' },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Weather for a city',
            parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
          },
        },
        { type: 'function', function: { name: 'get_time' } },
      ],
    });
    assert.deepEqual(body.tools, [
      {
        name: 'get_weather',
        description: 'Weather for a city',
        input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      },
      { name: 'get_time', input_schema: { type: 'object', properties: {} } },
    ]);
    assert.deepEqual(body.messages, [
      { role: 'user', content: 'Hello' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Porto' } },
          { type: 'tool_use', id: 'call_2', name: 'get_time', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: 'Sunny' },
          { type: 'tool_result', tool_use_id: 'call_2', content: [{ type: 'text', text: '12:00' }] },
          { type: 'text', text: 'Thanks. Summarise.' },
        ],
      },
    ]);
  });

  test('assistant text next to tool calls is kept before the tool_use blocks; an empty string is dropped', () => {
    const call = { id: 'call_1', type: 'function', function: { name: 'f', arguments: '{}' } };
    const tail = { role: 'tool', tool_call_id: 'call_1', content: 'ok' };
    const withText = toAnthropic({
      messages: [user, { role: 'assistant', content: 'Checking.', tool_calls: [call] }, tail],
    });
    assert.deepEqual(withText.messages[1]?.content, [
      { type: 'text', text: 'Checking.' },
      { type: 'tool_use', id: 'call_1', name: 'f', input: {} },
    ]);
    const empty = toAnthropic({ messages: [user, { role: 'assistant', content: '', tool_calls: [call] }, tail] });
    assert.deepEqual(empty.messages[1]?.content, [{ type: 'tool_use', id: 'call_1', name: 'f', input: {} }]);
  });

  test('tool_choice maps none/auto/required/function', () => {
    const tools = [{ type: 'function', function: { name: 'f' } }];
    assert.deepEqual(toAnthropic({ tools, tool_choice: 'none' }).tool_choice, { type: 'none' });
    assert.deepEqual(toAnthropic({ tools, tool_choice: 'auto' }).tool_choice, { type: 'auto' });
    assert.deepEqual(toAnthropic({ tools, tool_choice: 'required' }).tool_choice, { type: 'any' });
    assert.deepEqual(toAnthropic({ tools, tool_choice: { type: 'function', function: { name: 'f' } } }).tool_choice, {
      type: 'tool',
      name: 'f',
    });
  });

  test('parallel_tool_calls: false becomes disable_parallel_tool_use on the tool choice', () => {
    const tools = [{ type: 'function', function: { name: 'f' } }];
    assert.deepEqual(toAnthropic({ tools, parallel_tool_calls: false }).tool_choice, {
      type: 'auto',
      disable_parallel_tool_use: true,
    });
    assert.deepEqual(toAnthropic({ tools, tool_choice: 'required', parallel_tool_calls: false }).tool_choice, {
      type: 'any',
      disable_parallel_tool_use: true,
    });
    assert.deepEqual(toAnthropic({ tools, tool_choice: 'none', parallel_tool_calls: false }).tool_choice, {
      type: 'none',
    });
    assert.equal(toAnthropic({ tools, parallel_tool_calls: true }).tool_choice, undefined);
  });

  test('stop as a string or an array becomes stop_sequences', () => {
    assert.deepEqual(toAnthropic({ stop: 'END' }).stop_sequences, ['END']);
    assert.deepEqual(toAnthropic({ stop: ['a', 'b'] }).stop_sequences, ['a', 'b']);
    assert.equal(toAnthropic({ stop: [] }).stop_sequences, undefined);
    assert.equal(toAnthropic({ stop: null }).stop_sequences, undefined);
  });

  test('max_completion_tokens wins over max_tokens', () => {
    assert.equal(toAnthropic({ max_tokens: 50, max_completion_tokens: 70 }).max_tokens, 70);
    assert.equal(toAnthropic({ max_tokens: 50 }).max_tokens, 50);
  });

  test('without a budget, defaultMaxTokens is used; without either the request is refused', () => {
    const request = { model: 'gpt-test', messages: [user] };
    assert.equal(translateOpenAIRequestToAnthropic(request, { defaultMaxTokens: 4096 }).body.max_tokens, 4096);
    assert.throws(
      () => translateOpenAIRequestToAnthropic(request),
      (error: unknown) => error instanceof TranslationError && error.codes.includes('max_tokens_missing'),
    );
  });

  test('an invalid defaultMaxTokens is a programming error', () => {
    assert.throws(
      () => translateOpenAIRequestToAnthropic({ model: 'm', messages: [user] }, { defaultMaxTokens: 0 }),
      RangeError,
    );
  });

  test('temperature up to 1 and top_p pass unchanged', () => {
    const body = toAnthropic({ temperature: 0.7, top_p: 0.9 });
    assert.equal(body.temperature, 0.7);
    assert.equal(body.top_p, 0.9);
    assert.equal(toAnthropic({ temperature: 1 }).temperature, 1);
  });

  test('stream: true is carried over; stream_options stays on the Tollwise side', () => {
    assert.deepEqual(toAnthropic({ stream: true, stream_options: { include_usage: true } }), {
      model: 'gpt-test',
      max_tokens: 100,
      stream: true,
      messages: [{ role: 'user', content: 'Hello' }],
    });
  });

  test('user becomes metadata.user_id', () => {
    assert.deepEqual(toAnthropic({ user: 'end-user-42' }).metadata, { user_id: 'end-user-42' });
  });

  test('neutral values of unsupported fields are accepted and dropped', () => {
    const body = toAnthropic({
      n: 1,
      logprobs: false,
      presence_penalty: 0,
      frequency_penalty: 0,
      logit_bias: {},
      store: false,
      service_tier: 'auto',
      modalities: ['text'],
      stream: false,
      response_format: { type: 'text' },
      seed: null,
    });
    assert.deepEqual(body, { model: 'gpt-test', max_tokens: 100, messages: [{ role: 'user', content: 'Hello' }] });
  });

  test('JSON mode becomes one forced tool and reports jsonMode', () => {
    const result = translateOpenAIRequestToAnthropic({
      model: 'gpt-test',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Return a JSON object with a "city" key.' }],
      response_format: { type: 'json_object' },
    });
    assert.equal(result.jsonMode, true);
    assert.deepEqual(result.body.tools, [
      {
        name: JSON_MODE_TOOL_NAME,
        description: 'Respond with the JSON object that answers the request.',
        input_schema: { type: 'object' },
      },
    ]);
    assert.deepEqual(result.body.tool_choice, { type: 'tool', name: JSON_MODE_TOOL_NAME });
  });

  test('a request without JSON mode reports jsonMode false', () => {
    assert.equal(translateOpenAIRequestToAnthropic({ model: 'm', max_tokens: 1, messages: [user] }).jsonMode, false);
  });
});

describe('Anthropic response to OpenAI — golden cases', () => {
  const created = 1_758_000_000;
  const base = {
    id: 'msg_01',
    type: 'message',
    role: 'assistant',
    model: 'claude-test',
    stop_sequence: null,
  };

  test('text blocks, end_turn and usage', () => {
    const result = translateAnthropicResponseToOpenAI(
      {
        ...base,
        content: [
          { type: 'text', text: 'Hello, ' },
          { type: 'text', text: 'world.' },
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 12, output_tokens: 5 },
      },
      { created },
    );
    assert.deepEqual(result, {
      id: 'msg_01',
      object: 'chat.completion',
      created,
      model: 'claude-test',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Hello, world.', refusal: null },
          finish_reason: 'stop',
          logprobs: null,
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
    });
  });

  test('tool_use blocks become tool_calls with JSON arguments and finish_reason tool_calls', () => {
    const result = translateAnthropicResponseToOpenAI(
      {
        ...base,
        content: [
          { type: 'text', text: 'Let me check.' },
          { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Porto' } },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 20, output_tokens: 9 },
      },
      { created },
    );
    const choice = result.choices[0];
    assert.equal(choice.finish_reason, 'tool_calls');
    assert.equal(choice.message.content, 'Let me check.');
    assert.deepEqual(choice.message.tool_calls, [
      { id: 'toolu_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Porto"}' } },
    ]);
  });

  test('stop reasons map to finish reasons', () => {
    const finish = (stop_reason: string) =>
      translateAnthropicResponseToOpenAI(
        { ...base, content: [{ type: 'text', text: 'x' }], stop_reason, usage: { input_tokens: 1, output_tokens: 1 } },
        { created },
      ).choices[0].finish_reason;
    assert.equal(finish('end_turn'), 'stop');
    assert.equal(finish('stop_sequence'), 'stop');
    assert.equal(finish('max_tokens'), 'length');
    assert.equal(finish('model_context_window_exceeded'), 'length');
    assert.equal(finish('refusal'), 'content_filter');
  });

  test('cache reads and writes count as prompt tokens; cache reads are reported as cached', () => {
    const result = translateAnthropicResponseToOpenAI(
      {
        ...base,
        content: [{ type: 'text', text: 'x' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 },
      },
      { created },
    );
    assert.deepEqual(result.usage, {
      prompt_tokens: 130,
      completion_tokens: 4,
      total_tokens: 134,
      prompt_tokens_details: { cached_tokens: 100 },
    });
  });

  test('an empty content array gives null content', () => {
    const result = translateAnthropicResponseToOpenAI(
      { ...base, content: [], stop_reason: 'max_tokens', usage: { input_tokens: 3, output_tokens: 0 } },
      { created },
    );
    assert.equal(result.choices[0].message.content, null);
    assert.equal(result.choices[0].finish_reason, 'length');
  });

  test('in JSON mode the forced tool call becomes the content and finish_reason stop', () => {
    const result = translateAnthropicResponseToOpenAI(
      {
        ...base,
        content: [{ type: 'tool_use', id: 'toolu_9', name: JSON_MODE_TOOL_NAME, input: { city: 'Porto', ok: true } }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 30, output_tokens: 8 },
      },
      { created, jsonMode: true },
    );
    assert.equal(result.choices[0].message.content, '{"city":"Porto","ok":true}');
    assert.equal(result.choices[0].message.tool_calls, undefined);
    assert.equal(result.choices[0].finish_reason, 'stop');
  });

  test('in JSON mode a truncated answer keeps finish_reason length', () => {
    const result = translateAnthropicResponseToOpenAI(
      { ...base, content: [], stop_reason: 'max_tokens', usage: { input_tokens: 30, output_tokens: 100 } },
      { created, jsonMode: true },
    );
    assert.equal(result.choices[0].finish_reason, 'length');
    assert.equal(result.choices[0].message.content, null);
  });

  test('responses that cannot be represented throw TranslationError with stable codes', () => {
    const usage = { input_tokens: 1, output_tokens: 1 };
    const codes = (response: unknown, jsonMode = false) => {
      try {
        translateAnthropicResponseToOpenAI(response, { created, jsonMode });
      } catch (error) {
        assert.ok(error instanceof TranslationError);
        assert.equal(error.subject, 'response');
        return error.codes;
      }
      return assert.fail('expected a TranslationError');
    };
    assert.deepEqual(
      codes({
        ...base,
        content: [{ type: 'thinking', thinking: 'hmm', signature: 's' }],
        stop_reason: 'end_turn',
        usage,
      }),
      ['unsupported_response_content'],
    );
    assert.deepEqual(codes({ ...base, content: [], stop_reason: 'pause_turn', usage }), ['unknown_stop_reason']);
    assert.deepEqual(codes({ ...base, content: [], stop_reason: 'end_turn' }), ['malformed_response']);
    assert.deepEqual(codes('not a response'), ['malformed_response']);
    assert.deepEqual(
      codes({ ...base, content: [{ type: 'text', text: 'no JSON' }], stop_reason: 'end_turn', usage }, true),
      ['malformed_response'],
    );
    assert.deepEqual(
      codes(
        { ...base, content: [{ type: 'tool_use', id: 't', name: 'other', input: {} }], stop_reason: 'tool_use', usage },
        true,
      ),
      ['unsupported_response_content'],
    );
  });
});
