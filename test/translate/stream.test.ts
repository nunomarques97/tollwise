import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  AnthropicToOpenAIStream,
  OPENAI_DONE,
  OpenAIToAnthropicStream,
  translateAnthropicResponseToOpenAI,
  translateOpenAIResponseToAnthropic,
} from '../../src/translate/index.ts';
import { FAKE_KEYS } from '../fixtures/fake-keys.ts';
import { type MockProvider, type ScriptedResponse, startMockProvider } from '../fixtures/mock-provider.ts';
import {
  anthropicToOpenAI,
  foldAnthropicEvents,
  foldOpenAIItems,
  openaiToAnthropic,
  readStream,
  readTranslated,
} from '../fixtures/stream-replay.ts';

const created = 1_758_000_000;

// Golden files: test/fixtures/streams/<name>.sse is what the provider sent (recorded from the mock
// provider, or shaped after the provider's documented stream); translated/<name>.sse is exactly what
// the caller must receive.
const OPENAI_GOLDEN = [
  'openai-text-usage',
  'openai-text-no-usage',
  'openai-tool-call',
  'openai-parallel-tools-with-text',
  'openai-cut-off',
  'openai-upstream-error',
  'openai-tool-arguments-not-json',
];

const ANTHROPIC_GOLDEN: [string, { includeUsage?: boolean; jsonMode?: boolean }][] = [
  ['anthropic-text', {}],
  ['anthropic-tool-call', { includeUsage: true }],
  ['anthropic-parallel-tools-with-text', { includeUsage: true }],
  ['anthropic-max-length', {}],
  ['anthropic-cut-off', { includeUsage: true }],
  ['anthropic-overloaded', {}],
  ['anthropic-json-mode', { includeUsage: true, jsonMode: true }],
];

describe('OpenAI stream to Anthropic events: golden streams', () => {
  for (const name of OPENAI_GOLDEN) {
    test(name, () => {
      assert.equal(openaiToAnthropic(readStream(`${name}.sse`)).text, readTranslated(`${name}.sse`));
    });
  }
});

describe('Anthropic stream to OpenAI chunks: golden streams', () => {
  for (const [name, options] of ANTHROPIC_GOLDEN) {
    test(name, () => {
      assert.equal(
        anthropicToOpenAI(readStream(`${name}.sse`), { created, ...options }).text,
        readTranslated(`${name}.sse`),
      );
    });
  }
});

describe('OpenAI stream to Anthropic events: what the client ends up with', () => {
  test('tool call arguments split across chunks arrive whole, as an input object', () => {
    const { events, stream } = openaiToAnthropic(readStream('openai-tool-call.sse'));
    const message = foldAnthropicEvents(events);
    assert.deepEqual(message.content, [
      {
        type: 'tool_use',
        id: 'call-mock-4',
        name: 'get_weather',
        input: { location: 'San Francisco, CA', unit: 'celsius', note: 'bring an umbrella if it rains' },
      },
    ]);
    assert.equal(message.stop_reason, 'tool_use');
    const pieces = events.filter((event) => event.type === 'content_block_delta');
    assert.equal(pieces.length, 4);
    assert.equal(stream.state, 'completed');
    assert.deepEqual(stream.usage, {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
    });
  });

  test('text then parallel tool calls become three blocks in order, with cached tokens apart', () => {
    const { events, stream } = openaiToAnthropic(readStream('openai-parallel-tools-with-text.sse'));
    const message = foldAnthropicEvents(events);
    assert.deepEqual(message.content, [
      { type: 'text', text: 'Let me check both cities.' },
      { type: 'tool_use', id: 'call_Q1a', name: 'get_weather', input: { city: 'Paris' } },
      { type: 'tool_use', id: 'call_Q1b', name: 'get_weather', input: { city: 'Tokyo' } },
    ]);
    assert.deepEqual(message.usage, {
      input_tokens: 56,
      output_tokens: 40,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 64,
    });
    assert.equal(stream.stopReason, 'tool_use');
  });

  test('a stream that ends without usage completes, and says the usage is unknown', () => {
    const { events, stream } = openaiToAnthropic(readStream('openai-text-no-usage.sse'));
    assert.equal(stream.state, 'completed');
    assert.equal(stream.usage, null);
    assert.deepEqual(events.at(-2), {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 0 },
    });
    assert.deepEqual(events.at(-1), { type: 'message_stop' });
  });

  test('a stream cut off before its finish_reason ends with an error event, not message_stop', () => {
    const { events, stream } = openaiToAnthropic(readStream('openai-cut-off.sse'));
    assert.equal(stream.state, 'failed');
    assert.deepEqual(stream.error?.codes, ['incomplete_stream']);
    assert.equal(events.at(-1)?.type, 'error');
    assert.equal(
      events.some((event) => event.type === 'message_stop'),
      false,
    );
  });

  test('matches the non-streaming translation of the same mock answer', async () => {
    const scripts: ScriptedResponse[] = [
      { content: 'Plain text\n  with  odd   spacing. ' },
      { toolCall: { name: 'search', arguments: { query: 'streaming in node', limit: 5, filters: { lang: 'en' } } } },
    ];
    for (const script of scripts) {
      const mock = await startMockProvider({ responses: [script, script] });
      try {
        const body = { model: 'mock-openai-fast', messages: [{ role: 'user', content: 'hi' }] };
        const whole = await postJson(mock, '/v1/chat/completions', body);
        const streamed = await postText(mock, '/v1/chat/completions', {
          ...body,
          stream: true,
          stream_options: { include_usage: true },
        });
        const expected = translateOpenAIResponseToAnthropic(whole);
        const { events } = openaiToAnthropic(streamed);
        const actual = foldAnthropicEvents(events);
        assert.deepEqual(stripIds(actual.content), stripIds(expected.content));
        assert.equal(actual.stop_reason, expected.stop_reason);
        assert.deepEqual(actual.usage, expected.usage);
        assert.equal(actual.model, expected.model);
      } finally {
        await mock.close();
      }
    }
  });
});

describe('Anthropic stream to OpenAI chunks: what the client ends up with', () => {
  test('tool input split across events arrives whole, with the tool call index', () => {
    const { items, stream } = anthropicToOpenAI(readStream('anthropic-tool-call.sse'), { created, includeUsage: true });
    const completion = foldOpenAIItems(items);
    assert.deepEqual(completion.message, {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'toolu-mock-7',
          type: 'function',
          function: {
            name: 'get_weather',
            arguments: '{"location":"San Francisco, CA","unit":"celsius","note":"bring an umbrella if it rains"}',
          },
        },
      ],
    });
    assert.equal(completion.finish_reason, 'tool_calls');
    assert.deepEqual(completion.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    assert.equal(items.at(-1), OPENAI_DONE);
    assert.equal(stream.state, 'completed');
  });

  test('text then parallel tool calls: content, then calls 0 and 1, and "{}" for an input-less call', () => {
    const { items, stream } = anthropicToOpenAI(readStream('anthropic-parallel-tools-with-text.sse'), {
      created,
      includeUsage: true,
    });
    const completion = foldOpenAIItems(items);
    assert.deepEqual(completion.message, {
      role: 'assistant',
      content: 'Let me check both cities.',
      tool_calls: [
        { id: 'toolu_01A', type: 'function', function: { name: 'get_weather', arguments: '{"city": "Paris"}' } },
        { id: 'toolu_01B', type: 'function', function: { name: 'get_time', arguments: '{}' } },
      ],
    });
    assert.deepEqual(stream.usage, {
      prompt_tokens: 150,
      completion_tokens: 80,
      total_tokens: 230,
      prompt_tokens_details: { cached_tokens: 100 },
    });
  });

  test('without includeUsage there is no usage chunk and no usage field, but usage is still known', () => {
    const { items, stream } = anthropicToOpenAI(readStream('anthropic-text.sse'), { created });
    for (const item of items) {
      if (item !== OPENAI_DONE) {
        assert.equal('usage' in item, false);
        assert.equal('choices' in item && item.choices.length, 1);
      }
    }
    assert.deepEqual(stream.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    assert.deepEqual(foldOpenAIItems(items).message, {
      role: 'assistant',
      content: 'The capital of France is Paris.\nIt sits on the Seine.',
    });
  });

  test('a provider error mid-stream becomes an OpenAI error chunk and no [DONE]', () => {
    const { items, stream } = anthropicToOpenAI(readStream('anthropic-overloaded.sse'), { created });
    assert.equal(stream.state, 'failed');
    assert.equal(stream.error, null);
    assert.deepEqual(items.at(-1), {
      error: { message: 'Overloaded', type: 'server_error', param: null, code: 'overloaded_error' },
    });
    assert.equal(items.includes(OPENAI_DONE), false);
  });

  test('JSON mode streams the forced tool input as content and finishes with stop', () => {
    const { items } = anthropicToOpenAI(readStream('anthropic-json-mode.sse'), { created, jsonMode: true });
    const completion = foldOpenAIItems(items);
    assert.deepEqual(completion.message, { role: 'assistant', content: '{"name": "Ada", "born": 1815}' });
    assert.equal(completion.finish_reason, 'stop');
  });

  test('matches the non-streaming translation of the same mock answer', async () => {
    const scripts: ScriptedResponse[] = [
      { content: 'Plain text\n  with  odd   spacing. ' },
      { toolCall: { name: 'search', arguments: { query: 'streaming in node', limit: 5, filters: { lang: 'en' } } } },
    ];
    for (const script of scripts) {
      const mock = await startMockProvider({ responses: [script, script] });
      try {
        const body = { model: 'mock-anthropic-fast', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] };
        const whole = await postJson(mock, '/v1/messages', body);
        const streamed = await postText(mock, '/v1/messages', { ...body, stream: true });
        const expected = translateAnthropicResponseToOpenAI(whole, { created });
        const { items } = anthropicToOpenAI(streamed, { created, includeUsage: true });
        const actual = foldOpenAIItems(items);
        const expectedChoice = expected.choices[0];
        assert.deepEqual(stripIds(actual.message), stripIds(expectedChoice.message, ['refusal']));
        assert.equal(actual.finish_reason, expectedChoice.finish_reason);
        assert.deepEqual(actual.usage, expected.usage);
        assert.equal(actual.model, expected.model);
      } finally {
        await mock.close();
      }
    }
  });
});

describe('OpenAIToAnthropicStream edge cases', () => {
  const head = { id: 'chatcmpl-1', object: 'chat.completion.chunk', created, model: 'm' };
  const chunk = (delta: unknown, finish: string | null = null) => ({
    ...head,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  const call = (index: number, fields: Record<string, unknown>) => ({ tool_calls: [{ index, ...fields }] });
  const errorCodes = (stream: OpenAIToAnthropicStream) => stream.error?.codes;

  test('arguments arriving one character at a time are forwarded piece by piece, unchanged', () => {
    const stream = new OpenAIToAnthropicStream();
    const events = [...stream.push(chunk(call(0, { id: 'c1', type: 'function', function: { name: 'f' } })))];
    const text = '{"a": [1, "}"]}';
    for (const character of text) {
      events.push(...stream.push(chunk(call(0, { function: { arguments: character } }))));
    }
    events.push(...stream.push(chunk({}, 'tool_calls')), ...stream.pushData('[DONE]'));
    const pieces = events.flatMap((event) =>
      event.type === 'content_block_delta' && event.delta.type === 'input_json_delta' ? [event.delta.partial_json] : [],
    );
    assert.deepEqual(pieces, [...text]);
    assert.deepEqual(foldAnthropicEvents(events).content, [
      { type: 'tool_use', id: 'c1', name: 'f', input: { a: [1, '}'] } },
    ]);
  });

  test('a whole tool call in one chunk, and no arguments at all, both work', () => {
    const stream = new OpenAIToAnthropicStream();
    const events = [
      ...stream.push(
        chunk({
          tool_calls: [
            { index: 0, id: 'c1', type: 'function', function: { name: 'f', arguments: '{"x":1}' } },
            { index: 1, id: 'c2', type: 'function', function: { name: 'g', arguments: '' } },
          ],
        }),
      ),
      ...stream.push(chunk({}, 'tool_calls')),
      ...stream.end(),
    ];
    assert.deepEqual(foldAnthropicEvents(events).content, [
      { type: 'tool_use', id: 'c1', name: 'f', input: { x: 1 } },
      { type: 'tool_use', id: 'c2', name: 'g', input: {} },
    ]);
    assert.equal(stream.state, 'completed');
  });

  test('a tool call that continues after the next one started is refused', () => {
    const stream = new OpenAIToAnthropicStream();
    stream.push(chunk(call(0, { id: 'c1', function: { name: 'f', arguments: '{"a":1}' } })));
    stream.push(chunk(call(1, { id: 'c2', function: { name: 'g', arguments: '{}' } })));
    const events = stream.push(chunk(call(0, { function: { arguments: ' ' } })));
    assert.deepEqual(errorCodes(stream), ['interleaved_tool_calls']);
    assert.equal(events.at(-1)?.type, 'error');
    assert.deepEqual(stream.push(chunk({ content: 'more' })), []);
    assert.deepEqual(stream.end(), []);
  });

  test('text after a tool call opens a new text block after closing the call', () => {
    const stream = new OpenAIToAnthropicStream();
    const events = [
      ...stream.push(chunk(call(0, { id: 'c1', function: { name: 'f', arguments: '{}' } }))),
      ...stream.push(chunk({ content: 'after' })),
      ...stream.push(chunk({}, 'stop')),
      ...stream.end(),
    ];
    assert.deepEqual(
      events.map((event) => event.type),
      [
        'message_start',
        'content_block_start',
        'content_block_delta',
        'content_block_stop',
        'content_block_start',
        'content_block_delta',
        'content_block_stop',
        'message_delta',
        'message_stop',
      ],
    );
  });

  test('finish reasons map like the non-streaming translation', () => {
    for (const [finish, stop] of [
      ['stop', 'end_turn'],
      ['length', 'max_tokens'],
      ['tool_calls', 'tool_use'],
      ['content_filter', 'refusal'],
    ]) {
      const stream = new OpenAIToAnthropicStream();
      stream.push(chunk({ content: 'x' }, finish));
      assert.equal(stream.stopReason, stop);
    }
  });

  test('a refusal is streamed as text', () => {
    const stream = new OpenAIToAnthropicStream();
    const events = [
      ...stream.push(chunk({ refusal: "I can't help with that." })),
      ...stream.push(chunk({}, 'content_filter')),
      ...stream.end(),
    ];
    const message = foldAnthropicEvents(events);
    assert.deepEqual(message.content, [{ type: 'text', text: "I can't help with that." }]);
    assert.equal(message.stop_reason, 'refusal');
  });

  test('usage on the finish chunk itself, and a repeated finish_reason on the usage chunk, are accepted', () => {
    const stream = new OpenAIToAnthropicStream();
    stream.push(chunk({ content: 'x' }, 'stop'));
    stream.push({
      ...head,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    });
    stream.end();
    assert.equal(stream.state, 'completed');
    assert.equal(stream.usage?.input_tokens, 3);
  });

  test('a stream closed after its finish_reason but before [DONE] still completes', () => {
    const stream = new OpenAIToAnthropicStream();
    stream.push(chunk({ content: 'x' }, 'stop'));
    assert.deepEqual(
      stream.end().map((event) => event.type),
      ['message_delta', 'message_stop'],
    );
  });

  test('every refusal to translate is reported with its code', () => {
    const cases: [string, unknown[], string][] = [
      [
        'two choices',
        [
          {
            ...head,
            choices: [
              { index: 0, delta: {} },
              { index: 1, delta: {} },
            ],
          },
        ],
        'multiple_choices',
      ],
      ['a second choice index', [{ ...head, choices: [{ index: 1, delta: { content: 'x' } }] }], 'multiple_choices'],
      ['an unknown finish_reason', [chunk({ content: 'x' }, 'eos')], 'unknown_stop_reason'],
      [
        'a legacy function call',
        [chunk({ function_call: { name: 'f', arguments: '{}' } })],
        'unsupported_response_content',
      ],
      ['a tool call without an id', [chunk(call(0, { function: { name: 'f' } }))], 'malformed_response'],
      [
        'a custom tool call',
        [chunk(call(0, { id: 'c', type: 'custom', function: { name: 'f' } }))],
        'unsupported_response_content',
      ],
      ['a first chunk without an id', [{ choices: [] }], 'malformed_response'],
      ['text after the finish_reason', [chunk({}, 'stop'), chunk({ content: 'late' })], 'malformed_response'],
      ['a contradicting finish_reason', [chunk({}, 'stop'), chunk({}, 'length')], 'malformed_response'],
      [
        'invalid usage',
        [{ ...head, choices: [], usage: { prompt_tokens: -1, completion_tokens: 0 } }],
        'malformed_response',
      ],
      [
        'arguments that are a JSON array',
        [chunk(call(0, { id: 'c', function: { name: 'f', arguments: '[1]' } })), chunk({}, 'tool_calls')],
        'tool_arguments_not_json',
      ],
    ];
    for (const [label, chunks, code] of cases) {
      const stream = new OpenAIToAnthropicStream();
      for (const item of chunks) {
        stream.push(item);
      }
      assert.deepEqual(errorCodes(stream), [code], label);
      assert.equal(stream.state, 'failed', label);
    }
  });

  test('data that is not JSON, and an empty stream, fail cleanly', () => {
    const garbled = new OpenAIToAnthropicStream();
    assert.deepEqual(garbled.pushData('{not json'), [
      {
        type: 'error',
        error: {
          type: 'api_error',
          message: 'cannot translate the response from the openai format to the anthropic format: malformed_response',
        },
      },
    ]);
    const empty = new OpenAIToAnthropicStream();
    assert.equal(empty.end()[0]?.type, 'error');
    assert.deepEqual(empty.error?.codes, ['incomplete_stream']);
  });

  test('a provider error keeps its type and masks any credential in its message', () => {
    const key = FAKE_KEYS['OpenAI API key']?.text ?? '';
    const stream = new OpenAIToAnthropicStream();
    const events = stream.push({ error: { message: `Invalid key ${key} given`, type: 'rate_limit_exceeded' } });
    assert.equal(events.length, 1);
    const event = events[0];
    assert.equal(event?.type, 'error');
    if (event?.type === 'error') {
      assert.equal(event.error.type, 'rate_limit_error');
      assert.equal(event.error.message.includes(key), false);
      assert.match(event.error.message, /^Invalid key .*REDACTED.* given$/);
    }
    assert.equal(stream.error, null);
  });
});

describe('AnthropicToOpenAIStream edge cases', () => {
  const start = {
    type: 'message_start',
    message: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'm',
      usage: { input_tokens: 4, output_tokens: 1 },
    },
  };
  const block = (index: number, contentBlock: unknown) => ({
    type: 'content_block_start',
    index,
    content_block: contentBlock,
  });
  const delta = (index: number, value: unknown) => ({ type: 'content_block_delta', index, delta: value });
  const stop = (index: number) => ({ type: 'content_block_stop', index });
  const messageDelta = (stopReason: string, usage: unknown = { output_tokens: 2 }) => ({
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage,
  });
  const run = (events: unknown[], options: { jsonMode?: boolean; includeUsage?: boolean } = {}) => {
    const stream = new AnthropicToOpenAIStream({ created, ...options });
    const items = events.flatMap((event) => stream.push(event));
    items.push(...stream.end());
    return { stream, items };
  };

  test('stop reasons map like the non-streaming translation', () => {
    for (const [stopReason, finish] of [
      ['end_turn', 'stop'],
      ['stop_sequence', 'stop'],
      ['max_tokens', 'length'],
      ['model_context_window_exceeded', 'length'],
      ['tool_use', 'tool_calls'],
      ['refusal', 'content_filter'],
    ]) {
      const { stream } = run([start, messageDelta(stopReason as string), { type: 'message_stop' }]);
      assert.equal(stream.finishReason, finish, stopReason);
      assert.equal(stream.state, 'completed');
    }
  });

  test('ping and event types added later are skipped', () => {
    const { items, stream } = run([
      start,
      { type: 'ping' },
      { type: 'some_future_event', detail: 1 },
      block(0, { type: 'text', text: '' }),
      delta(0, { type: 'text_delta', text: 'hi' }),
      stop(0),
      messageDelta('end_turn'),
      { type: 'message_stop' },
    ]);
    assert.equal(stream.state, 'completed');
    assert.deepEqual(foldOpenAIItems(items).message, { role: 'assistant', content: 'hi' });
  });

  test('usage in message_delta overrides message_start, cache counts included', () => {
    const { stream } = run([
      start,
      messageDelta('end_turn', {
        input_tokens: 7,
        output_tokens: 9,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 3,
      }),
      { type: 'message_stop' },
    ]);
    assert.deepEqual(stream.usage, {
      prompt_tokens: 30,
      completion_tokens: 9,
      total_tokens: 39,
      prompt_tokens_details: { cached_tokens: 20 },
    });
  });

  test('a tool_use block that starts with its whole input sends it as the arguments', () => {
    const { items } = run([
      start,
      block(0, { type: 'tool_use', id: 't1', name: 'f', input: { a: 1 } }),
      stop(0),
      messageDelta('tool_use'),
      { type: 'message_stop' },
    ]);
    assert.deepEqual(foldOpenAIItems(items).message, {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 't1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }],
    });
  });

  test('a stream closed after message_delta but before message_stop still completes', () => {
    const { items, stream } = run([start, messageDelta('end_turn')], { includeUsage: true });
    assert.equal(stream.state, 'completed');
    assert.equal(items.at(-1), OPENAI_DONE);
  });

  test('every refusal to translate is reported with its code', () => {
    const cases: [string, unknown[], string, { jsonMode?: boolean }?][] = [
      ['an event before message_start', [block(0, { type: 'text', text: '' })], 'malformed_response'],
      ['a second message_start', [start, start], 'malformed_response'],
      ['a thinking block', [start, block(0, { type: 'thinking', thinking: '' })], 'unsupported_response_content'],
      [
        'a server tool block',
        [start, block(0, { type: 'server_tool_use', id: 's', name: 'web_search', input: {} })],
        'unsupported_response_content',
      ],
      [
        'a citations delta',
        [start, block(0, { type: 'text', text: '' }), delta(0, { type: 'citations_delta', citation: {} })],
        'unsupported_response_content',
      ],
      [
        'text with citations',
        [start, block(0, { type: 'text', text: '', citations: [{}] })],
        'unsupported_response_content',
      ],
      ['a delta for an unknown block', [start, delta(3, { type: 'text_delta', text: 'x' })], 'malformed_response'],
      [
        'a delta after the block stopped',
        [start, block(0, { type: 'text', text: '' }), stop(0), delta(0, { type: 'text_delta', text: 'x' })],
        'malformed_response',
      ],
      [
        'input pieces for a text block',
        [start, block(0, { type: 'text', text: '' }), delta(0, { type: 'input_json_delta', partial_json: '{}' })],
        'malformed_response',
      ],
      [
        'input that is not a JSON object',
        [
          start,
          block(0, { type: 'tool_use', id: 't', name: 'f', input: {} }),
          delta(0, { type: 'input_json_delta', partial_json: '"text"' }),
          stop(0),
        ],
        'tool_arguments_not_json',
      ],
      ['an unknown stop_reason', [start, messageDelta('pause_turn')], 'unknown_stop_reason'],
      [
        'invalid usage',
        [start, messageDelta('end_turn', { output_tokens: 'many' }), { type: 'message_stop' }],
        'malformed_response',
      ],
      ['a cut-off stream', [start, block(0, { type: 'text', text: '' })], 'incomplete_stream'],
      [
        'JSON mode without the forced tool call',
        [start, messageDelta('end_turn')],
        'malformed_response',
        { jsonMode: true },
      ],
      [
        'JSON mode with another tool',
        [start, block(0, { type: 'tool_use', id: 't', name: 'other', input: {} })],
        'unsupported_response_content',
        { jsonMode: true },
      ],
    ];
    for (const [label, events, code, options] of cases) {
      const { stream, items } = run(events, options);
      assert.deepEqual(stream.error?.codes, [code], label);
      assert.equal(stream.state, 'failed', label);
      const last = items.at(-1);
      assert.ok(last !== undefined && last !== OPENAI_DONE && 'error' in last && last.error.code === code, label);
    }
  });

  test('message_stop without a stop_reason is reported as an incomplete stream', () => {
    const stream = new AnthropicToOpenAIStream({ created });
    stream.push(start);
    const items = stream.push({ type: 'message_stop' });
    assert.deepEqual(stream.error?.codes, ['incomplete_stream']);
    assert.equal(items.length, 1);
  });

  test('data that is not JSON fails cleanly, and nothing is emitted after the failure', () => {
    const stream = new AnthropicToOpenAIStream({ created });
    const items = stream.pushData('event: nope');
    assert.deepEqual(items, [
      {
        error: {
          message: 'cannot translate the response from the anthropic format to the openai format: malformed_response',
          type: 'server_error',
          param: null,
          code: 'malformed_response',
        },
      },
    ]);
    assert.deepEqual(stream.push(start), []);
    assert.deepEqual(stream.end(), []);
  });

  test('a provider error masks any credential in its message and keeps a known type', () => {
    const key = FAKE_KEYS['Anthropic API key']?.text ?? '';
    const { items } = run([start, { type: 'error', error: { type: 'rate_limit_error', message: `bad ${key}` } }]);
    const last = items.at(-1);
    assert.ok(last !== undefined && last !== OPENAI_DONE && 'error' in last);
    assert.equal(last.error.type, 'rate_limit_error');
    assert.equal(last.error.message.includes(key), false);
  });
});

// --- helpers ---------------------------------------------------------------------------------------

async function postJson(mock: MockProvider, path: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${mock.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await response.json()) as unknown;
}

async function postText(mock: MockProvider, path: string, body: unknown): Promise<string> {
  const response = await fetch(`${mock.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return response.text();
}

/** Drops fields that legitimately differ between two answers of the mock (ids), or that `omit` names. */
function stripIds(value: unknown, omit: readonly string[] = []): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripIds(item, omit));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'id' && !omit.includes(key))
        .map(([key, item]) => [key, stripIds(item, omit)]),
    );
  }
  return value;
}
