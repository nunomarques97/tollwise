import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MockProvider, StartMockProviderOptions } from './fixtures/mock-provider.ts';
import { splitIntoChunks, startMockProvider } from './fixtures/mock-provider.ts';

/** Not a real credential and not key-shaped: only proves auth headers pass through. */
const FAKE_KEY = 'fake-test-key';

interface SseFrame {
  readonly event: string | undefined;
  readonly data: string;
}

/** Reads a whole SSE response body as a chunked stream (not response.text()) and splits it into frames. */
async function readSse(response: Response): Promise<{ frames: SseFrame[]; readError: unknown; firstByteAt: number }> {
  const reader = response.body?.getReader();
  assert.ok(reader, 'streaming response must have a readable body');
  const decoder = new TextDecoder();
  let buffer = '';
  let firstByteAt = -1;
  let readError: unknown;

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (firstByteAt === -1) firstByteAt = performance.now();
      buffer += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    readError = error;
  }

  const frames: SseFrame[] = [];
  for (const block of buffer.split('\n\n')) {
    if (block.trim().length === 0) continue;
    let event: string | undefined;
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice('event: '.length);
      else if (line.startsWith('data: ')) dataLines.push(line.slice('data: '.length));
    }
    frames.push({ event, data: dataLines.join('\n') });
  }
  return { frames, readError, firstByteAt };
}

async function withProvider<T>(
  opts: StartMockProviderOptions,
  run: (provider: MockProvider) => Promise<T>,
): Promise<T> {
  const provider = await startMockProvider(opts);
  try {
    return await run(provider);
  } finally {
    await provider.close();
  }
}

// --------------------------------------------------------------------------------
// OpenAI shape
// --------------------------------------------------------------------------------

test('openai: POST /v1/chat/completions returns a chat.completion JSON body', async () => {
  await withProvider({}, async (provider) => {
    const res = await fetch(`${provider.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${FAKE_KEY}` },
      body: JSON.stringify({ model: 'mock-model', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      object: string;
      model: string;
      choices: { message: { role: string; content: string }; finish_reason: string }[];
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };
    assert.equal(body.object, 'chat.completion');
    assert.equal(body.model, 'mock-model');
    assert.equal(body.choices[0]?.message.role, 'assistant');
    assert.equal(body.choices[0]?.finish_reason, 'stop');
    assert.equal(body.usage.total_tokens, body.usage.prompt_tokens + body.usage.completion_tokens);
  });
});

test('openai: streaming SSE emits chat.completion.chunk objects terminated by [DONE]', async () => {
  await withProvider({}, async (provider) => {
    const res = await fetch(`${provider.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mock-model', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    assert.equal(
      res.headers.get('content-length'),
      null,
      'a streamed response must be chunked, not content-length framed',
    );

    const { frames } = await readSse(res);
    assert.ok(frames.length >= 3, 'expects a role delta, at least one content delta and a final [DONE]');
    assert.equal(frames.at(-1)?.data, '[DONE]');

    const roleChunk = JSON.parse(frames[0]?.data ?? '{}') as {
      object: string;
      choices: { delta: { role?: string } }[];
    };
    assert.equal(roleChunk.object, 'chat.completion.chunk');
    assert.equal(roleChunk.choices[0]?.delta.role, 'assistant');

    const contentPieces = frames
      .slice(1, -1)
      .map((frame) => JSON.parse(frame.data) as { choices: { delta: { content?: string } }[] })
      .map((chunk) => chunk.choices[0]?.delta.content ?? '')
      .join('');
    assert.equal(contentPieces, 'Mock response from the mock provider.');
  });
});

test('openai: stream_options.include_usage adds a final usage chunk before [DONE]', async () => {
  await withProvider({}, async (provider) => {
    const res = await fetch(`${provider.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'mock-model',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        stream_options: { include_usage: true },
      }),
    });

    const { frames } = await readSse(res);
    assert.equal(frames.at(-1)?.data, '[DONE]');
    const usageChunk = JSON.parse(frames.at(-2)?.data ?? '{}') as {
      choices: unknown[];
      usage?: { total_tokens: number };
    };
    assert.deepEqual(usageChunk.choices, []);
    assert.equal(usageChunk.usage?.total_tokens, 15);
  });
});

test('openai: a tool in the request produces a tool_calls response, non-streaming', async () => {
  await withProvider({}, async (provider) => {
    const res = await fetch(`${provider.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'mock-model',
        messages: [{ role: 'user', content: 'weather?' }],
        tools: [{ type: 'function', function: { name: 'get_weather', parameters: {} } }],
      }),
    });
    const body = (await res.json()) as {
      choices: {
        message: { content: null; tool_calls: { function: { name: string; arguments: string } }[] };
        finish_reason: string;
      }[];
    };
    assert.equal(body.choices[0]?.finish_reason, 'tool_calls');
    assert.equal(body.choices[0]?.message.content, null);
    assert.equal(body.choices[0]?.message.tool_calls[0]?.function.name, 'get_weather');
    assert.doesNotThrow(() => JSON.parse(body.choices[0]?.message.tool_calls[0]?.function.arguments ?? ''));
  });
});

test('openai: a tool in the request produces streamed tool_calls deltas', async () => {
  await withProvider({}, async (provider) => {
    const res = await fetch(`${provider.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'mock-model',
        messages: [{ role: 'user', content: 'weather?' }],
        stream: true,
        tools: [{ type: 'function', function: { name: 'get_weather', parameters: {} } }],
      }),
    });
    const { frames } = await readSse(res);
    assert.equal(frames.at(-1)?.data, '[DONE]');
    const toolFrame = frames
      .filter((frame) => frame.data !== '[DONE]')
      .map(
        (frame) =>
          JSON.parse(frame.data) as {
            choices: { delta: { tool_calls?: { id?: string; function?: { name?: string } }[] } }[];
          },
      )
      .find((chunk) => chunk.choices[0]?.delta.tool_calls?.[0]?.id !== undefined);
    assert.equal(toolFrame?.choices[0]?.delta.tool_calls?.[0]?.function?.name, 'get_weather');
    const finishFrame = JSON.parse(frames.at(-2)?.data ?? '{}') as { choices: { finish_reason: string }[] };
    assert.equal(finishFrame.choices[0]?.finish_reason, 'tool_calls');
  });
});

test('openai: response_format json_object produces a JSON-mode string body', async () => {
  await withProvider({}, async (provider) => {
    const res = await fetch(`${provider.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'mock-model',
        messages: [{ role: 'user', content: 'give me json' }],
        response_format: { type: 'json_object' },
      }),
    });
    const body = (await res.json()) as { choices: { message: { content: string } }[] };
    assert.doesNotThrow(() => JSON.parse(body.choices[0]?.message.content ?? ''));
  });
});

test('openai: GET /v1/models returns the configured model list', async () => {
  await withProvider({ models: { openai: ['a-1', 'a-2'] } }, async (provider) => {
    const res = await fetch(`${provider.url}/v1/models`, {
      headers: { authorization: `Bearer ${FAKE_KEY}` },
    });
    const body = (await res.json()) as { object: string; data: { id: string; object: string }[] };
    assert.equal(body.object, 'list');
    assert.deepEqual(
      body.data.map((m) => m.id),
      ['a-1', 'a-2'],
    );
    assert.equal(body.data[0]?.object, 'model');
  });
});

// --------------------------------------------------------------------------------
// Anthropic shape
// --------------------------------------------------------------------------------

test('anthropic: POST /v1/messages returns a message JSON body', async () => {
  await withProvider({}, async (provider) => {
    const res = await fetch(`${provider.url}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': FAKE_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: 'mock-model', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      type: string;
      role: string;
      content: { type: string; text: string }[];
      stop_reason: string;
      usage: { input_tokens: number; output_tokens: number };
    };
    assert.equal(body.type, 'message');
    assert.equal(body.role, 'assistant');
    assert.equal(body.content[0]?.type, 'text');
    assert.equal(body.stop_reason, 'end_turn');
    assert.ok(body.usage.input_tokens > 0 && body.usage.output_tokens > 0);
  });
});

test('anthropic: streaming SSE emits the documented event sequence', async () => {
  await withProvider({}, async (provider) => {
    const res = await fetch(`${provider.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': FAKE_KEY },
      body: JSON.stringify({
        model: 'mock-model',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    });
    assert.equal(res.status, 200);
    const { frames } = await readSse(res);
    const eventNames = frames.map((frame) => frame.event);
    assert.deepEqual(eventNames, [
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);

    const messageDelta = JSON.parse(frames.find((f) => f.event === 'message_delta')?.data ?? '{}') as {
      delta: { stop_reason: string };
      usage: { output_tokens: number };
    };
    assert.equal(messageDelta.delta.stop_reason, 'end_turn');
    assert.ok(messageDelta.usage.output_tokens > 0);
  });
});

test('anthropic: a tool in the request produces a tool_use content block, non-streaming', async () => {
  await withProvider({}, async (provider) => {
    const res = await fetch(`${provider.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': FAKE_KEY },
      body: JSON.stringify({
        model: 'mock-model',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'weather?' }],
        tools: [{ name: 'get_weather', input_schema: {} }],
      }),
    });
    const body = (await res.json()) as {
      content: { type: string; name: string; input: unknown }[];
      stop_reason: string;
    };
    assert.equal(body.stop_reason, 'tool_use');
    assert.equal(body.content[0]?.type, 'tool_use');
  });
});

test('anthropic: a tool in the request streams a tool_use block with input_json_delta', async () => {
  await withProvider({}, async (provider) => {
    const res = await fetch(`${provider.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': FAKE_KEY },
      body: JSON.stringify({
        model: 'mock-model',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'weather?' }],
        tools: [{ name: 'get_weather', input_schema: {} }],
        stream: true,
      }),
    });
    const { frames } = await readSse(res);
    const startFrame = JSON.parse(frames.find((f) => f.event === 'content_block_start')?.data ?? '{}') as {
      content_block: { type: string; name: string };
    };
    assert.equal(startFrame.content_block.type, 'tool_use');
    assert.equal(startFrame.content_block.name, 'get_weather');

    const deltaFrames = frames.filter((f) => f.event === 'content_block_delta');
    assert.ok(deltaFrames.length > 0);
    const firstDelta = JSON.parse(deltaFrames[0]?.data ?? '{}') as { delta: { type: string; partial_json: string } };
    assert.equal(firstDelta.delta.type, 'input_json_delta');

    const messageDelta = JSON.parse(frames.find((f) => f.event === 'message_delta')?.data ?? '{}') as {
      delta: { stop_reason: string };
    };
    assert.equal(messageDelta.delta.stop_reason, 'tool_use');
  });
});

test('anthropic: GET /v1/models (selected by header) returns the configured model list', async () => {
  await withProvider({ models: { anthropic: ['claude-mock-1'] } }, async (provider) => {
    const res = await fetch(`${provider.url}/v1/models`, { headers: { 'x-api-key': FAKE_KEY } });
    const body = (await res.json()) as { data: { type: string; id: string }[]; has_more: boolean; first_id: string };
    assert.deepEqual(
      body.data.map((m) => m.id),
      ['claude-mock-1'],
    );
    assert.equal(body.data[0]?.type, 'model');
    assert.equal(body.has_more, false);
    assert.equal(body.first_id, 'claude-mock-1');
  });
});

// --------------------------------------------------------------------------------
// Lossless chunking
// --------------------------------------------------------------------------------

/** Text whose whitespace would be damaged by a naive split/join. */
const WHITESPACE_HEAVY = '  leading spaces, a  double\tand a tab,\n\nblank line, trailing   ';

test('splitIntoChunks keeps every character: joining the pieces gives back the input', () => {
  const inputs = ['', ' ', '   ', 'one', 'a  b  ', '  a', WHITESPACE_HEAVY, '{"q":"hello  world"}', 'x\r\ny'];
  for (const input of inputs) {
    assert.equal(splitIntoChunks(input).join(''), input, `lossless for ${JSON.stringify(input)}`);
  }
  assert.deepEqual(splitIntoChunks(''), ['']);
  assert.deepEqual(splitIntoChunks('a  b  c d e'), ['a  b  ', 'c d ', 'e']);
  assert.deepEqual(splitIntoChunks('  a b'), ['  a ', 'b']);
});

// --------------------------------------------------------------------------------
// Every option, proven for both shapes
// --------------------------------------------------------------------------------

interface ReassembledToolCall {
  readonly name: string | undefined;
  readonly rawArguments: string;
}

interface ShapeDriver {
  readonly name: 'openai' | 'anthropic';
  readonly path: string;
  readonly headers: Record<string, string>;
  body(extra?: Record<string, unknown>): Record<string, unknown>;
  /** Assistant text of a non-streaming response. */
  text(json: unknown): string | undefined;
  /** Model id reported by a non-streaming response. */
  model(json: unknown): string | undefined;
  toolCall(json: unknown): ReassembledToolCall;
  /** Assistant text reassembled from every delta of a stream. */
  streamText(frames: readonly SseFrame[]): string;
  streamModel(frames: readonly SseFrame[]): string | undefined;
  streamToolCall(frames: readonly SseFrame[]): ReassembledToolCall;
  /** True when the first frame is the shape's opening frame. */
  opensCorrectly(frames: readonly SseFrame[]): boolean;
  /** True when the shape's terminal frame arrived. */
  completed(frames: readonly SseFrame[]): boolean;
  /** Reads a provider-shaped error body, asserting its envelope. */
  error(json: unknown): { type: string | undefined; message: string | undefined };
  modelIds(json: unknown): string[];
}

// Loose structural views of the response bodies, only for reading values in tests.
interface OpenAiJson {
  object?: string;
  model?: string;
  choices?: {
    message?: { content?: string | null; tool_calls?: { function?: { name?: string; arguments?: string } }[] };
    delta?: { role?: string; content?: string; tool_calls?: { function?: { name?: string; arguments?: string } }[] };
  }[];
  error?: { type?: string; message?: string; code?: string };
  data?: { id: string }[];
}

interface AnthropicJson {
  type?: string;
  model?: string;
  message?: { model?: string };
  content?: { type: string; text?: string; name?: string; input?: unknown }[];
  content_block?: { type: string; name?: string };
  delta?: { type?: string; text?: string; partial_json?: string };
  error?: { type?: string; message?: string };
  data?: { id: string }[];
}

function jsonFrames<T>(frames: readonly SseFrame[], event?: string): T[] {
  return frames
    .filter((frame) => frame.data !== '[DONE]' && (event === undefined || frame.event === event))
    .map((frame) => JSON.parse(frame.data) as T);
}

const openaiDriver: ShapeDriver = {
  name: 'openai',
  path: '/v1/chat/completions',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${FAKE_KEY}` },
  body: (extra = {}) => ({ model: 'mock-model', messages: [{ role: 'user', content: 'hi' }], ...extra }),
  text: (json) => (json as OpenAiJson).choices?.[0]?.message?.content ?? undefined,
  model: (json) => (json as OpenAiJson).model,
  toolCall: (json) => {
    const call = (json as OpenAiJson).choices?.[0]?.message?.tool_calls?.[0]?.function;
    return { name: call?.name, rawArguments: call?.arguments ?? '' };
  },
  streamText: (frames) =>
    jsonFrames<OpenAiJson>(frames)
      .map((chunk) => chunk.choices?.[0]?.delta?.content ?? '')
      .join(''),
  streamModel: (frames) => jsonFrames<OpenAiJson>(frames)[0]?.model,
  streamToolCall: (frames) => {
    const calls = jsonFrames<OpenAiJson>(frames).flatMap((chunk) => chunk.choices?.[0]?.delta?.tool_calls ?? []);
    return {
      name: calls.find((call) => call.function?.name !== undefined)?.function?.name,
      rawArguments: calls.map((call) => call.function?.arguments ?? '').join(''),
    };
  },
  opensCorrectly: (frames) => {
    const first = JSON.parse(frames[0]?.data ?? '{}') as OpenAiJson;
    return first.object === 'chat.completion.chunk' && first.choices?.[0]?.delta?.role === 'assistant';
  },
  completed: (frames) => frames.at(-1)?.data === '[DONE]',
  error: (json) => {
    const body = json as OpenAiJson & { type?: unknown };
    assert.equal(body.type, undefined, 'OpenAI errors have no top-level type field');
    assert.equal(typeof body.error?.code, 'string');
    return { type: body.error?.type, message: body.error?.message };
  },
  modelIds: (json) => ((json as OpenAiJson).data ?? []).map((model) => model.id),
};

const anthropicDriver: ShapeDriver = {
  name: 'anthropic',
  path: '/v1/messages',
  headers: { 'content-type': 'application/json', 'x-api-key': FAKE_KEY, 'anthropic-version': '2023-06-01' },
  body: (extra = {}) => ({
    model: 'mock-model',
    max_tokens: 100,
    messages: [{ role: 'user', content: 'hi' }],
    ...extra,
  }),
  text: (json) => (json as AnthropicJson).content?.find((block) => block.type === 'text')?.text,
  model: (json) => (json as AnthropicJson).model,
  toolCall: (json) => {
    const block = (json as AnthropicJson).content?.find((b) => b.type === 'tool_use');
    return { name: block?.name, rawArguments: JSON.stringify(block?.input ?? null) };
  },
  streamText: (frames) =>
    jsonFrames<AnthropicJson>(frames, 'content_block_delta')
      .map((event) => (event.delta?.type === 'text_delta' ? (event.delta.text ?? '') : ''))
      .join(''),
  streamModel: (frames) => jsonFrames<AnthropicJson>(frames, 'message_start')[0]?.message?.model,
  streamToolCall: (frames) => ({
    name: jsonFrames<AnthropicJson>(frames, 'content_block_start')[0]?.content_block?.name,
    rawArguments: jsonFrames<AnthropicJson>(frames, 'content_block_delta')
      .map((event) => (event.delta?.type === 'input_json_delta' ? (event.delta.partial_json ?? '') : ''))
      .join(''),
  }),
  opensCorrectly: (frames) => frames[0]?.event === 'message_start',
  completed: (frames) => frames.some((frame) => frame.event === 'message_stop'),
  error: (json) => {
    const body = json as AnthropicJson;
    assert.equal(body.type, 'error', 'Anthropic errors carry type: "error" at the top level');
    return { type: body.error?.type, message: body.error?.message };
  },
  modelIds: (json) => ((json as AnthropicJson).data ?? []).map((model) => model.id),
};

function post(provider: MockProvider, shape: ShapeDriver, extra?: Record<string, unknown>, signal?: AbortSignal) {
  return fetch(`${provider.url}${shape.path}`, {
    method: 'POST',
    headers: shape.headers,
    body: JSON.stringify(shape.body(extra)),
    ...(signal === undefined ? {} : { signal }),
  });
}

for (const shape of [openaiDriver, anthropicDriver]) {
  const label = shape.name;

  test(`${label}: latencyMs delays the whole response, JSON and streaming`, async () => {
    await withProvider({ latencyMs: 150 }, async (provider) => {
      let start = performance.now();
      const plain = await post(provider, shape);
      await plain.json();
      const plainElapsed = performance.now() - start;
      assert.ok(plainElapsed >= 140, `JSON response expected after >= 150 ms, measured ${plainElapsed} ms`);

      start = performance.now();
      const streamed = await post(provider, shape, { stream: true });
      const headersElapsed = performance.now() - start;
      assert.ok(headersElapsed >= 140, `stream headers expected after >= 150 ms, measured ${headersElapsed} ms`);
      const { frames } = await readSse(streamed);
      assert.ok(shape.completed(frames));
    });
  });

  test(`${label}: firstByteDelayMs sends headers at once and delays only the first streamed chunk`, async () => {
    await withProvider({ firstByteDelayMs: 400 }, async (provider) => {
      const start = performance.now();
      const res = await post(provider, shape, { stream: true });
      const headersAt = performance.now();
      const { frames, firstByteAt } = await readSse(res);
      assert.equal(res.status, 200);
      assert.ok(
        headersAt - start < 400,
        `headers must arrive before the delay elapses, measured ${headersAt - start} ms`,
      );
      assert.ok(
        firstByteAt - headersAt >= 300,
        `first chunk expected ~400 ms after the headers, measured ${firstByteAt - headersAt} ms`,
      );
      assert.ok(shape.opensCorrectly(frames));
      assert.ok(shape.completed(frames));
    });
  });

  for (const failure of [
    { status: 429, type: 'rate_limit_error', message: 'slow down' },
    { status: 500, type: 'api_error', message: 'boom' },
  ]) {
    test(`${label}: failWith ${failure.status} returns an error body in the ${label} shape`, async () => {
      await withProvider({ failWith: failure }, async (provider) => {
        for (const extra of [{}, { stream: true }]) {
          const res = await post(provider, shape, extra);
          assert.equal(res.status, failure.status);
          assert.match(res.headers.get('content-type') ?? '', /application\/json/);
          assert.deepEqual(shape.error(await res.json()), { type: failure.type, message: failure.message });
        }
      });
    });
  }

  test(`${label}: hang accepts the request, never answers, and close() still resolves promptly`, async () => {
    const provider = await startMockProvider({ hang: true });
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 150);
      await assert.rejects(post(provider, shape, { stream: true }, controller.signal), { name: 'AbortError' });
      clearTimeout(timer);
      assert.equal(provider.requests.length, 1, 'the unanswered request is still recorded');
      assert.equal(provider.requests[0]?.path, shape.path);
    } finally {
      const closeStart = performance.now();
      await provider.close();
      const closeElapsed = performance.now() - closeStart;
      assert.ok(closeElapsed < 1000, `close() must not wait on a hanging request, took ${closeElapsed} ms`);
    }
  });

  test(`${label}: dropMidStream sends the opening frame, then cuts the connection before the terminal frame`, async () => {
    await withProvider({ dropMidStream: true }, async (provider) => {
      const res = await post(provider, shape, { stream: true });
      assert.equal(res.status, 200);
      const { frames, readError } = await readSse(res);
      assert.equal(frames.length, 1, 'exactly the opening frame arrives');
      assert.ok(shape.opensCorrectly(frames));
      assert.equal(shape.completed(frames), false, 'the terminal frame never arrives');
      assert.ok(readError instanceof Error, 'reading the body fails because the connection was cut');
    });
  });

  test(`${label}: GET /v1/models returns the configured list, or the default one`, async () => {
    const modelHeaders: Record<string, string> =
      shape.name === 'openai' ? { authorization: `Bearer ${FAKE_KEY}` } : { 'x-api-key': FAKE_KEY };
    await withProvider({ models: { openai: ['o-1', 'o-2'], anthropic: ['c-1', 'c-2', 'c-3'] } }, async (provider) => {
      const res = await fetch(`${provider.url}/v1/models`, { headers: modelHeaders });
      assert.equal(res.status, 200);
      assert.deepEqual(
        shape.modelIds(await res.json()),
        shape.name === 'openai' ? ['o-1', 'o-2'] : ['c-1', 'c-2', 'c-3'],
      );
    });
    await withProvider({}, async (provider) => {
      const res = await fetch(`${provider.url}/v1/models`, { headers: modelHeaders });
      assert.deepEqual(
        shape.modelIds(await res.json()),
        shape.name === 'openai'
          ? ['mock-openai-fast', 'mock-openai-quality']
          : ['mock-anthropic-fast', 'mock-anthropic-quality'],
      );
    });
  });

  test(`${label}: streamed text reassembles to exactly the non-streaming text, whitespace included`, async () => {
    await withProvider(
      { responses: [{ content: WHITESPACE_HEAVY }, { content: WHITESPACE_HEAVY }] },
      async (provider) => {
        const plain = await post(provider, shape);
        assert.equal(shape.text(await plain.json()), WHITESPACE_HEAVY);

        const { frames } = await readSse(await post(provider, shape, { stream: true }));
        const marker = shape.name === 'openai' ? '"content"' : 'text_delta';
        assert.ok(frames.filter((frame) => frame.data.includes(marker)).length > 1, 'text spread over several deltas');
        assert.equal(shape.streamText(frames), WHITESPACE_HEAVY);
        assert.ok(shape.completed(frames));
      },
    );
  });

  test(`${label}: scripted toolCall answers with that tool and its exact arguments, JSON and streaming`, async () => {
    const toolCall = {
      name: 'search_docs',
      arguments: { q: 'hello  world ', limit: 3, nested: { tags: [' a', 'b '] } },
    };
    await withProvider({ responses: [{ toolCall }, { toolCall }] }, async (provider) => {
      const plain = shape.toolCall(await (await post(provider, shape)).json());
      assert.equal(plain.name, 'search_docs');
      assert.deepEqual(JSON.parse(plain.rawArguments), toolCall.arguments);

      const { frames } = await readSse(await post(provider, shape, { stream: true }));
      const streamed = shape.streamToolCall(frames);
      assert.equal(streamed.name, 'search_docs');
      assert.equal(streamed.rawArguments, JSON.stringify(toolCall.arguments), 'argument text is not altered');
      assert.deepEqual(JSON.parse(streamed.rawArguments), toolCall.arguments);
      assert.ok(shape.completed(frames));
    });
  });

  test(`${label}: scripted jsonMode answers with the scripted or a default JSON object, JSON and streaming`, async () => {
    const scripted = '{"answer": 42,  "items": ["x", "y"]}';
    await withProvider(
      {
        responses: [
          { jsonMode: true, content: scripted },
          { jsonMode: true, content: scripted },
          { jsonMode: true },
          { jsonMode: true },
        ],
      },
      async (provider) => {
        assert.equal(shape.text(await (await post(provider, shape)).json()), scripted);
        assert.equal(shape.streamText((await readSse(await post(provider, shape, { stream: true }))).frames), scripted);
        assert.deepEqual(JSON.parse(shape.text(await (await post(provider, shape)).json()) ?? ''), { mock: true });
        const { frames } = await readSse(await post(provider, shape, { stream: true }));
        assert.deepEqual(JSON.parse(shape.streamText(frames)), { mock: true });
      },
    );
  });

  test(`${label}: scripted model overrides the reported model, JSON and streaming`, async () => {
    await withProvider(
      {
        responses: [
          { model: 'scripted-model-a', content: 'a' },
          { model: 'scripted-model-b', content: 'b' },
        ],
      },
      async (provider) => {
        const plain = await (await post(provider, shape)).json();
        assert.equal(shape.model(plain), 'scripted-model-a');
        assert.equal(shape.text(plain), 'a');
        const { frames } = await readSse(await post(provider, shape, { stream: true }));
        assert.equal(shape.streamModel(frames), 'scripted-model-b');
        assert.equal(shape.streamText(frames), 'b');
        const unscripted = await (await post(provider, shape)).json();
        assert.equal(shape.model(unscripted), 'mock-model', 'without a script the requested model is echoed');
      },
    );
  });

  test(`${label}: scripted responses are consumed in call order, including a per-call failure`, async () => {
    await withProvider(
      {
        responses: [
          { failWith: { status: 429, type: 'rate_limit_error', message: 'retry later' } },
          { content: 'second answer' },
          { content: 'third answer' },
        ],
      },
      async (provider) => {
        const first = await post(provider, shape);
        assert.equal(first.status, 429);
        assert.deepEqual(shape.error(await first.json()), { type: 'rate_limit_error', message: 'retry later' });

        const second = await post(provider, shape);
        assert.equal(second.status, 200);
        assert.equal(shape.text(await second.json()), 'second answer');

        const third = await readSse(await post(provider, shape, { stream: true }));
        assert.equal(shape.streamText(third.frames), 'third answer');

        const afterQueue = await post(provider, shape);
        assert.equal(shape.text(await afterQueue.json()), 'Mock response from the mock provider.');
      },
    );
  });

  test(`${label}: requests[] records method, path, headers and the parsed body of every call`, async () => {
    await withProvider({}, async (provider) => {
      const body = shape.body({ stream: true, temperature: 0.5 });
      const res = await fetch(`${provider.url}${shape.path}`, {
        method: 'POST',
        headers: { ...shape.headers, 'x-test-header': 'present' },
        body: JSON.stringify(body),
      });
      await readSse(res);
      await fetch(`${provider.url}/v1/models`, { headers: shape.headers });

      assert.equal(provider.requests.length, 2);
      const [postCall, getCall] = provider.requests;
      assert.equal(postCall?.method, 'POST');
      assert.equal(postCall?.path, shape.path);
      assert.equal(postCall?.headers['x-test-header'], 'present');
      for (const [name, value] of Object.entries(shape.headers)) {
        assert.equal(postCall?.headers[name], value, `header ${name} is recorded`);
      }
      assert.deepEqual(postCall?.body, body);

      assert.equal(getCall?.method, 'GET');
      assert.equal(getCall?.path, '/v1/models');
      assert.equal(getCall?.body, undefined, 'a request without a body records undefined');
    });
  });
}

test('openai: response_format json_object produces a JSON-mode answer when streaming too', async () => {
  await withProvider({}, async (provider) => {
    const { frames } = await readSse(
      await post(provider, openaiDriver, { stream: true, response_format: { type: 'json_object' } }),
    );
    assert.deepEqual(JSON.parse(openaiDriver.streamText(frames)), { mock: true });
  });
});

test('an unknown route returns a shape-appropriate 404', async () => {
  await withProvider({}, async (provider) => {
    const openai = await fetch(`${provider.url}/v1/unknown`, { headers: { authorization: `Bearer ${FAKE_KEY}` } });
    assert.equal(openai.status, 404);
    assert.match(openaiDriver.error(await openai.json()).message ?? '', /unknown mock route GET \/v1\/unknown/);

    const anthropic = await fetch(`${provider.url}/v1/unknown`, { headers: { 'x-api-key': FAKE_KEY } });
    assert.equal(anthropic.status, 404);
    assert.match(anthropicDriver.error(await anthropic.json()).message ?? '', /unknown mock route GET \/v1\/unknown/);
  });
});
