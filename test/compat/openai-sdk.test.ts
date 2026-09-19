// The official `openai` SDK, constructed with nothing but `baseURL` and
// `apiKey`, run unmodified against an in-process Tollwise server backed by the shared mock provider
// (test/fixtures/mock-provider.ts). No hand-written HTTP calls: every assertion here is evidence that
// the real SDK a caller would install works, not that a stand-in shaped like it does.
//
// Covers: chat completions non-streaming and streamed (`for await`), `stream_options.include_usage`,
// a tool call, JSON mode, a vision content part, `models.list`, the local access key on and off, and
// provider/routing errors surfaced as the SDK's typed error classes.
//
// Tollwise retries a provider 429 on the next candidate; when every candidate fails it answers 502
// `all_providers_failed`, so the SDK raises `InternalServerError`, never `RateLimitError`. Provider
// 400 and 401 answers, and Tollwise's own 422, reach the SDK with their status unchanged.

import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import OpenAI, { AuthenticationError, BadRequestError, InternalServerError, UnprocessableEntityError } from 'openai';
import type { Catalog, ModelEntry } from '../../src/catalog/schema.ts';
import { type Config, type ConfigInput, ConfigSchema } from '../../src/config/schema.ts';
import { createLogger, type LogSink } from '../../src/log/logger.ts';
import { buildRegistry } from '../../src/providers/registry.ts';
import { baseUrl, createTollwiseServer, listen, stopServer } from '../../src/server/server.ts';
import { type MockProvider, type StartMockProviderOptions, startMockProvider } from '../fixtures/mock-provider.ts';

// Fake credentials with no known key shape; none of them is a real key.
const FAKE_PROVIDER_KEY = `fakeOpenaiUpstream${'Sc4'.repeat(6)}`; // tollwise-allow-secret
const FAKE_ACCESS_KEY = `fakeAccess${'Ak2'.repeat(8)}`; // tollwise-allow-secret
const FAKE_CLIENT_KEY = `fakeSdkClient${'Xq5'.repeat(6)}`; // the apiKey handed to the OpenAI SDK; tollwise-allow-secret
const WRONG_CLIENT_KEY = `fakeSdkWrong${'Yp1'.repeat(6)}`; // tollwise-allow-secret

const ALL_CAPS = { tools: true, json_mode: true, vision: true, streaming: true };

function entry(model: string, capabilities = ALL_CAPS): ModelEntry {
  return {
    provider: 'openai',
    model,
    canonical_model: model,
    price: { input: 1, output: 2, cached_input: null },
    context_window: 128_000,
    max_output: 16_000,
    capabilities,
    source_url: 'https://example.com/pricing',
    verified_on: '2026-09-01',
  };
}

const CATALOG: Catalog = {
  models: [entry('gpt-compat'), entry('gpt-compat-no-vision', { ...ALL_CAPS, vision: false })],
};

function captureLog(): LogSink & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    write(chunk: string) {
      lines.push(chunk);
      return true;
    },
  };
}

interface Proxy {
  readonly url: string;
  readonly openai: MockProvider;
  readonly log: string[];
  close(): Promise<void>;
}

interface ProxyOptions {
  readonly accessKey?: string;
  readonly routing?: ConfigInput['routing'];
  readonly openai?: StartMockProviderOptions;
}

async function startProxy(options: ProxyOptions = {}): Promise<Proxy> {
  const openai = await startMockProvider(options.openai ?? {});
  const config: Config = ConfigSchema.parse({
    providers: {
      openai: { base_url: `${openai.url}/v1` },
      openrouter: { enabled: false },
      anthropic: { enabled: false },
      deepseek: { enabled: false },
      ollama: { enabled: false },
    },
    routing: options.routing ?? {},
  } satisfies ConfigInput);
  const env = { OPENAI_API_KEY: FAKE_PROVIDER_KEY };
  const registry = buildRegistry(config, env);
  const log = captureLog();
  const server = createTollwiseServer({
    maxBodyBytes: 512 * 1024,
    logger: createLogger({ level: 'debug', sink: log }),
    accessKey: options.accessKey,
    proxy: { config, catalog: CATALOG, registry, env },
  });
  const address = await listen(server, '127.0.0.1', 0);
  return {
    url: baseUrl('127.0.0.1', address.port),
    openai,
    log: log.lines,
    async close() {
      await stopServer(server, 100);
      await openai.close();
    },
  };
}

/** The official OpenAI SDK, changed only by `baseURL` and `apiKey` (plus `maxRetries` where noted). */
function sdkClient(proxy: Proxy, options: { apiKey?: string; maxRetries?: number } = {}): OpenAI {
  return new OpenAI({
    baseURL: `${proxy.url}/v1`,
    apiKey: options.apiKey ?? FAKE_CLIENT_KEY,
    ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
  });
}

function chatCalls(mock: MockProvider) {
  return mock.requests.filter((request) => request.method === 'POST');
}

const HELLO = [{ role: 'user' as const, content: 'Say hello.' }];

describe('OpenAI SDK against an in-process Tollwise', () => {
  let proxy: Proxy;
  before(async () => {
    proxy = await startProxy();
  });
  after(async () => {
    await proxy.close();
  });
  afterEach(() => {
    proxy.openai.requests.length = 0;
  });

  test('chat.completions.create (non-streaming) returns the mock content and usage unmodified', async () => {
    const sdk = sdkClient(proxy);
    const response = await sdk.chat.completions.create({ model: 'gpt-compat', messages: HELLO });

    assert.equal(response.object, 'chat.completion');
    assert.equal(response.model, 'gpt-compat');
    assert.equal(response.choices[0]?.message.content, 'Mock response from the mock provider.');
    assert.equal(response.choices[0]?.finish_reason, 'stop');
    assert.equal(response.usage?.prompt_tokens, 10);
    assert.equal(response.usage?.completion_tokens, 5);
    assert.equal(response.usage?.total_tokens, 15);

    const [sent] = chatCalls(proxy.openai);
    assert.equal(sent?.path, '/v1/chat/completions');
    assert.equal((sent?.body as { model?: unknown })?.model, 'gpt-compat');
  });

  test('a streamed completion is consumed with for-await and reassembles the full content', async () => {
    const sdk = sdkClient(proxy);
    const stream = await sdk.chat.completions.create({ model: 'gpt-compat', messages: HELLO, stream: true });

    let content = '';
    let finishReason: string | null | undefined;
    let sawRole = false;
    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (choice?.delta.role === 'assistant') sawRole = true;
      content += choice?.delta.content ?? '';
      if (choice?.finish_reason) finishReason = choice.finish_reason;
    }

    assert.ok(sawRole, 'the first chunk carries the assistant role, as the mock provider sends it');
    assert.equal(content, 'Mock response from the mock provider.');
    assert.equal(finishReason, 'stop');
  });

  test('stream_options.include_usage puts the usage on the final chunk', async () => {
    const sdk = sdkClient(proxy);
    const stream = await sdk.chat.completions.create({
      model: 'gpt-compat',
      messages: HELLO,
      stream: true,
      stream_options: { include_usage: true },
    });

    let usage: OpenAI.CompletionUsage | undefined;
    let chunksAfterUsage = 0;
    for await (const chunk of stream) {
      if (chunk.usage) usage = chunk.usage;
      else if (usage !== undefined) chunksAfterUsage += 1;
    }

    assert.deepEqual(usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    assert.equal(chunksAfterUsage, 0, 'the usage chunk is the last one the SDK sees');
  });

  test('a requested tool call comes back in the SDK’s typed tool_calls shape', async () => {
    const scripted = await startProxy({
      openai: { responses: [{ toolCall: { name: 'lookup_weather', arguments: { city: 'Lisbon' } } }] },
    });
    try {
      const sdk = sdkClient(scripted);
      const response = await sdk.chat.completions.create({
        model: 'gpt-compat',
        messages: [{ role: 'user', content: "What's the weather in Lisbon?" }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'lookup_weather',
              description: 'Looks up the current weather for a city.',
              parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
            },
          },
        ],
      });

      const call = response.choices[0]?.message.tool_calls?.[0];
      assert.ok(call !== undefined, 'a tool call is present');
      assert.equal(call.type, 'function');
      assert.equal(call.function.name, 'lookup_weather');
      assert.deepEqual(JSON.parse(call.function.arguments), { city: 'Lisbon' });
      assert.equal(response.choices[0]?.finish_reason, 'tool_calls');

      const [sent] = chatCalls(scripted.openai);
      const sentTools = (sent?.body as { tools?: unknown[] } | undefined)?.tools;
      assert.equal(Array.isArray(sentTools), true);
      assert.equal(sentTools?.length, 1);
    } finally {
      await scripted.close();
    }
  });

  test('response_format: json_object is sent as is and the content parses as JSON', async () => {
    const scripted = await startProxy({ openai: { responses: [{ jsonMode: true, content: '{"answer":42}' }] } });
    try {
      const sdk = sdkClient(scripted);
      const response = await sdk.chat.completions.create({
        model: 'gpt-compat',
        messages: [{ role: 'user', content: 'Answer in JSON.' }],
        response_format: { type: 'json_object' },
      });

      assert.deepEqual(JSON.parse(response.choices[0]?.message.content ?? ''), { answer: 42 });

      const [sent] = chatCalls(scripted.openai);
      assert.deepEqual((sent?.body as { response_format?: unknown } | undefined)?.response_format, {
        type: 'json_object',
      });
    } finally {
      await scripted.close();
    }
  });

  test('an image content part reaches the provider exactly as the SDK built it', async () => {
    const sdk = sdkClient(proxy);
    const dataUrl = 'data:image/png;base64,AAAA';
    await sdk.chat.completions.create({
      model: 'gpt-compat',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is this?' },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
    });

    const [sent] = chatCalls(proxy.openai);
    const sentMessages = (
      sent?.body as { messages?: { content: { type: string; image_url?: { url: string } }[] }[] } | undefined
    )?.messages;
    const imagePart = sentMessages?.[0]?.content.find((part) => part.type === 'image_url');
    assert.equal(imagePart?.image_url?.url, dataUrl);
  });

  test('models.list returns the servable catalog models and calls no provider', async () => {
    const sdk = sdkClient(proxy);
    const page = await sdk.models.list();

    assert.deepEqual(
      page.data.map((model) => model.id),
      ['gpt-compat', 'gpt-compat-no-vision'],
    );
    assert.equal(page.data[0]?.owned_by, 'tollwise');
    assert.equal(proxy.openai.requests.length, 0);
  });
});

describe('OpenAI SDK error mapping', () => {
  test('a provider 400 (the request itself) surfaces as BadRequestError, and is not retried', async () => {
    const proxy = await startProxy({ openai: { responses: [{ failWith: { status: 400, message: 'bad field' } }] } });
    try {
      const sdk = sdkClient(proxy);
      await assert.rejects(sdk.chat.completions.create({ model: 'gpt-compat', messages: HELLO }), (error: unknown) => {
        assert.ok(error instanceof BadRequestError);
        assert.equal(error.status, 400);
        return true;
      });
      assert.equal(chatCalls(proxy.openai).length, 1, 'a 400 is answered at once, never retried elsewhere');
    } finally {
      await proxy.close();
    }
  });

  test('a rejected upstream credential surfaces as AuthenticationError', async () => {
    const proxy = await startProxy({
      openai: { responses: [{ failWith: { status: 401, message: 'Incorrect credentials provided' } }] },
    });
    try {
      const sdk = sdkClient(proxy);
      await assert.rejects(sdk.chat.completions.create({ model: 'gpt-compat', messages: HELLO }), (error: unknown) => {
        assert.ok(error instanceof AuthenticationError);
        assert.equal(error.status, 401);
        return true;
      });
    } finally {
      await proxy.close();
    }
  });

  test('a request for a capability the only candidate lacks surfaces as UnprocessableEntityError (422)', async () => {
    const proxy = await startProxy({ routing: { on_no_candidate: 'fail' } });
    try {
      const sdk = sdkClient(proxy);
      await assert.rejects(
        sdk.chat.completions.create({
          model: 'gpt-compat-no-vision',
          messages: [
            {
              role: 'user',
              content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }],
            },
          ],
        }),
        (error: unknown) => {
          assert.ok(error instanceof UnprocessableEntityError);
          assert.equal(error.status, 422);
          return true;
        },
      );
      assert.equal(proxy.openai.requests.length, 0, 'no provider is called once the capability check fails');
    } finally {
      await proxy.close();
    }
  });

  test('a 429 from the only candidate is retried by Tollwise, then reported as InternalServerError (502): a bare 429 is never returned', async () => {
    // A rate limit moves on to the next candidate; with only one candidate, the answer is 502
    // all_providers_failed. maxRetries: 0 keeps this test fast: the SDK itself retries a >=500 response
    // twice with backoff by default.
    const proxy = await startProxy({ openai: { responses: [{ failWith: { status: 429, message: 'slow down' } }] } });
    try {
      const sdk = sdkClient(proxy, { maxRetries: 0 });
      await assert.rejects(sdk.chat.completions.create({ model: 'gpt-compat', messages: HELLO }), (error: unknown) => {
        assert.ok(error instanceof InternalServerError);
        assert.equal(error.status, 502);
        assert.equal(error.headers?.get('x-tollwise-attempts'), '1');
        return true;
      });
      assert.equal(chatCalls(proxy.openai).length, 1, 'the only candidate is called exactly once');
    } finally {
      await proxy.close();
    }
  });
});

describe('OpenAI SDK against the local access key', () => {
  let proxy: Proxy;
  before(async () => {
    proxy = await startProxy({ accessKey: FAKE_ACCESS_KEY });
  });
  after(async () => {
    await proxy.close();
  });
  afterEach(() => {
    proxy.openai.requests.length = 0;
  });

  test('the wrong client key surfaces as AuthenticationError, and no provider is called', async () => {
    const sdk = sdkClient(proxy, { apiKey: WRONG_CLIENT_KEY });
    await assert.rejects(sdk.chat.completions.create({ model: 'gpt-compat', messages: HELLO }), (error: unknown) => {
      assert.ok(error instanceof AuthenticationError);
      assert.equal(error.status, 401);
      return true;
    });
    assert.equal(proxy.openai.requests.length, 0);
  });

  test('the right client key is accepted and the request is routed', async () => {
    const sdk = sdkClient(proxy, { apiKey: FAKE_ACCESS_KEY });
    const response = await sdk.chat.completions.create({ model: 'gpt-compat', messages: HELLO });
    assert.equal(response.choices[0]?.message.content, 'Mock response from the mock provider.');
    assert.equal(chatCalls(proxy.openai).length, 1);
  });
});

describe('OpenAI SDK with the local access key not configured', () => {
  test('any client key is accepted', async () => {
    const proxy = await startProxy();
    try {
      const sdk = sdkClient(proxy, { apiKey: WRONG_CLIENT_KEY });
      const response = await sdk.chat.completions.create({ model: 'gpt-compat', messages: HELLO });
      assert.equal(response.choices[0]?.message.content, 'Mock response from the mock provider.');
    } finally {
      await proxy.close();
    }
  });
});
