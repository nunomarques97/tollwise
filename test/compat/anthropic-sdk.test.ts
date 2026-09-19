// The official `@anthropic-ai/sdk`, constructed with nothing but `baseURL` and `apiKey`, run
// unmodified against an in-process Tollwise server backed by the shared mock provider
// (test/fixtures/mock-provider.ts). No hand-written HTTP calls: every assertion here is evidence that
// the real SDK a caller would install works, not that a stand-in shaped like it does.
//
// Covers: messages.create non-streaming, messages.stream() consumed with finalMessage(), a tool call,
// an image content block, models.list, and provider/routing errors surfaced as the SDK's typed error
// classes -- the Anthropic-format counterpart of test/compat/openai-sdk.test.ts.
//
// Cross-format: the two directions src/proxy/cross-format.ts adds -- the Anthropic SDK talking
// to a model only served through an OpenAI-format provider, and the OpenAI SDK talking to a model only
// served through an Anthropic-format provider -- each exercised through the real SDK, non-streaming and
// streaming, with the translation proven by the x-tollwise-* response headers (read through
// `.withResponse()`, which both official SDKs expose).
//
// Tollwise retries a provider 429 on the next candidate; when every candidate fails it answers 502
// all_providers_failed, so the SDK raises InternalServerError, never RateLimitError. Provider 400 and
// 401 answers, and Tollwise's own 422, reach the SDK with their status unchanged.

import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import Anthropic, {
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  UnprocessableEntityError,
} from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { Catalog, ModelEntry } from '../../src/catalog/schema.ts';
import { type Config, type ConfigInput, ConfigSchema, type ProviderId } from '../../src/config/schema.ts';
import { createLogger, type LogSink } from '../../src/log/logger.ts';
import { buildRegistry } from '../../src/providers/registry.ts';
import { baseUrl, createTollwiseServer, listen, stopServer } from '../../src/server/server.ts';
import { type MockProvider, type StartMockProviderOptions, startMockProvider } from '../fixtures/mock-provider.ts';

// Fake credentials with no known key shape; none of them is a real key.
const FAKE_PROVIDER_KEY = `fakeAnthropicUpstream${'Sc4'.repeat(6)}`; // tollwise-allow-secret
const FAKE_CLIENT_KEY = `fakeSdkClient${'Xq5'.repeat(6)}`; // the apiKey handed to the Anthropic SDK; tollwise-allow-secret
const FAKE_OPENROUTER_KEY = `fakeRouter${'Or2'.repeat(6)}`; // tollwise-allow-secret
const FAKE_ANTHROPIC_KEY = `fakeClaude${'An4'.repeat(6)}`; // tollwise-allow-secret

const ALL_CAPS = { tools: true, json_mode: true, vision: true, streaming: true };
const MOCK_TEXT = 'Mock response from the mock provider.';

function entry(model: string, capabilities = ALL_CAPS): ModelEntry {
  return {
    provider: 'anthropic',
    model,
    canonical_model: model,
    price: { input: 1, output: 2, cached_input: null },
    context_window: 200_000,
    max_output: 16_000,
    capabilities,
    source_url: 'https://example.com/pricing',
    verified_on: '2026-09-01',
  };
}

const CATALOG: Catalog = {
  models: [entry('claude-compat'), entry('claude-compat-no-vision', { ...ALL_CAPS, vision: false })],
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
  readonly anthropic: MockProvider;
  readonly log: string[];
  close(): Promise<void>;
}

interface ProxyOptions {
  readonly routing?: ConfigInput['routing'];
  readonly anthropic?: StartMockProviderOptions;
}

async function startProxy(options: ProxyOptions = {}): Promise<Proxy> {
  const anthropic = await startMockProvider(options.anthropic ?? {});
  const config: Config = ConfigSchema.parse({
    providers: {
      anthropic: { base_url: anthropic.url },
      openai: { enabled: false },
      openrouter: { enabled: false },
      deepseek: { enabled: false },
      ollama: { enabled: false },
    },
    routing: options.routing ?? {},
  } satisfies ConfigInput);
  const env = { ANTHROPIC_API_KEY: FAKE_PROVIDER_KEY };
  const registry = buildRegistry(config, env);
  const log = captureLog();
  const server = createTollwiseServer({
    maxBodyBytes: 512 * 1024,
    logger: createLogger({ level: 'debug', sink: log }),
    proxy: { config, catalog: CATALOG, registry, env },
  });
  const address = await listen(server, '127.0.0.1', 0);
  return {
    url: baseUrl('127.0.0.1', address.port),
    anthropic,
    log: log.lines,
    async close() {
      await stopServer(server, 100);
      await anthropic.close();
    },
  };
}

/** The official Anthropic SDK, changed only by `baseURL` and `apiKey` (plus `maxRetries` where noted). */
function sdkClient(proxy: Proxy, options: { apiKey?: string; maxRetries?: number } = {}): Anthropic {
  return new Anthropic({
    baseURL: proxy.url,
    apiKey: options.apiKey ?? FAKE_CLIENT_KEY,
    ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
  });
}

function messagesCalls(mock: MockProvider) {
  return mock.requests.filter((request) => request.method === 'POST');
}

const HELLO = [{ role: 'user' as const, content: 'Say hello.' }];

describe('Anthropic SDK against an in-process Tollwise', () => {
  let proxy: Proxy;
  before(async () => {
    proxy = await startProxy();
  });
  after(async () => {
    await proxy.close();
  });
  afterEach(() => {
    proxy.anthropic.requests.length = 0;
  });

  test('messages.create (non-streaming) returns the mock content and usage unmodified', async () => {
    const sdk = sdkClient(proxy);
    const response = await sdk.messages.create({ model: 'claude-compat', max_tokens: 100, messages: HELLO });

    assert.equal(response.type, 'message');
    assert.equal(response.role, 'assistant');
    assert.equal(response.model, 'claude-compat');
    assert.equal(response.content[0]?.type, 'text');
    assert.equal((response.content[0] as { text: string }).text, MOCK_TEXT);
    assert.equal(response.stop_reason, 'end_turn');
    assert.equal(response.usage.input_tokens, 10);
    assert.equal(response.usage.output_tokens, 5);

    const [sent] = messagesCalls(proxy.anthropic);
    assert.equal(sent?.path, '/v1/messages');
    assert.equal((sent?.body as { model?: unknown })?.model, 'claude-compat');
    assert.equal(sent?.headers['x-api-key'], FAKE_PROVIDER_KEY);
  });

  test('messages.stream() consumed with finalMessage() reassembles the full content', async () => {
    const sdk = sdkClient(proxy);
    const stream = sdk.messages.stream({ model: 'claude-compat', max_tokens: 100, messages: HELLO });
    const final = await stream.finalMessage();

    assert.equal(final.content[0]?.type, 'text');
    assert.equal((final.content[0] as { text: string }).text, MOCK_TEXT);
    assert.equal(final.stop_reason, 'end_turn');
    assert.equal(final.usage.input_tokens, 10);
    assert.equal(final.usage.output_tokens, 5);

    const [sent] = messagesCalls(proxy.anthropic);
    assert.equal((sent?.body as { stream?: unknown })?.stream, true);
  });

  test('a requested tool call comes back in the SDK’s typed tool_use block', async () => {
    const scripted = await startProxy({
      anthropic: { responses: [{ toolCall: { name: 'lookup_weather', arguments: { city: 'Lisbon' } } }] },
    });
    try {
      const sdk = sdkClient(scripted);
      const response = await sdk.messages.create({
        model: 'claude-compat',
        max_tokens: 100,
        tools: [
          {
            name: 'lookup_weather',
            description: 'Looks up the current weather for a city.',
            input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
          },
        ],
        messages: [{ role: 'user', content: "What's the weather in Lisbon?" }],
      });

      const block = response.content[0];
      assert.ok(block !== undefined, 'a content block is present');
      assert.equal(block.type, 'tool_use');
      const toolUse = block as { name: string; input: unknown };
      assert.equal(toolUse.name, 'lookup_weather');
      assert.deepEqual(toolUse.input, { city: 'Lisbon' });
      assert.equal(response.stop_reason, 'tool_use');

      const [sent] = messagesCalls(scripted.anthropic);
      const sentTools = (sent?.body as { tools?: unknown[] } | undefined)?.tools;
      assert.equal(Array.isArray(sentTools), true);
      assert.equal(sentTools?.length, 1);
    } finally {
      await scripted.close();
    }
  });

  test('an image content block reaches the provider exactly as the SDK built it', async () => {
    const sdk = sdkClient(proxy);
    const imageData = 'AAAA';
    await sdk.messages.create({
      model: 'claude-compat',
      max_tokens: 100,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is this?' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageData } },
          ],
        },
      ],
    });

    const [sent] = messagesCalls(proxy.anthropic);
    const sentMessages = (
      sent?.body as
        | { messages?: { content: { type: string; source?: { data: string; media_type: string } }[] }[] }
        | undefined
    )?.messages;
    const imagePart = sentMessages?.[0]?.content.find((part) => part.type === 'image');
    assert.equal(imagePart?.source?.data, imageData);
    assert.equal(imagePart?.source?.media_type, 'image/png');
  });

  test('models.list returns the servable catalog models and calls no provider', async () => {
    const sdk = sdkClient(proxy);
    const page = await sdk.models.list();

    assert.deepEqual(
      page.data.map((model) => model.id),
      ['claude-compat', 'claude-compat-no-vision'],
    );
    assert.equal(page.data[0]?.type, 'model');
    assert.equal(proxy.anthropic.requests.length, 0);
  });
});

describe('Anthropic SDK error mapping', () => {
  test('a provider 400 (the request itself) surfaces as BadRequestError, and is not retried', async () => {
    const proxy = await startProxy({ anthropic: { responses: [{ failWith: { status: 400, message: 'bad field' } }] } });
    try {
      const sdk = sdkClient(proxy);
      await assert.rejects(
        sdk.messages.create({ model: 'claude-compat', max_tokens: 100, messages: HELLO }),
        (error: unknown) => {
          assert.ok(error instanceof BadRequestError);
          assert.equal(error.status, 400);
          return true;
        },
      );
      assert.equal(messagesCalls(proxy.anthropic).length, 1, 'a 400 is answered at once, never retried elsewhere');
    } finally {
      await proxy.close();
    }
  });

  test('a rejected upstream credential surfaces as AuthenticationError', async () => {
    const proxy = await startProxy({
      anthropic: { responses: [{ failWith: { status: 401, message: 'Incorrect credentials provided' } }] },
    });
    try {
      const sdk = sdkClient(proxy);
      await assert.rejects(
        sdk.messages.create({ model: 'claude-compat', max_tokens: 100, messages: HELLO }),
        (error: unknown) => {
          assert.ok(error instanceof AuthenticationError);
          assert.equal(error.status, 401);
          return true;
        },
      );
    } finally {
      await proxy.close();
    }
  });

  test('a request for a capability the only candidate lacks surfaces as UnprocessableEntityError (422)', async () => {
    const proxy = await startProxy({ routing: { on_no_candidate: 'fail' } });
    try {
      const sdk = sdkClient(proxy);
      await assert.rejects(
        sdk.messages.create({
          model: 'claude-compat-no-vision',
          max_tokens: 100,
          messages: [
            {
              role: 'user',
              content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }],
            },
          ],
        }),
        (error: unknown) => {
          assert.ok(error instanceof UnprocessableEntityError);
          assert.equal(error.status, 422);
          return true;
        },
      );
      assert.equal(proxy.anthropic.requests.length, 0, 'no provider is called once the capability check fails');
    } finally {
      await proxy.close();
    }
  });

  test('a 429 from the only candidate is retried by Tollwise, then reported as InternalServerError (502): a bare 429 is never returned', async () => {
    // A rate limit moves on to the next candidate; with only one candidate, the answer is 502
    // all_providers_failed. maxRetries: 0 keeps this test fast: the SDK itself retries a >=500 response
    // with backoff by default.
    const proxy = await startProxy({ anthropic: { responses: [{ failWith: { status: 429, message: 'slow down' } }] } });
    try {
      const sdk = sdkClient(proxy, { maxRetries: 0 });
      await assert.rejects(
        sdk.messages.create({ model: 'claude-compat', max_tokens: 100, messages: HELLO }),
        (error: unknown) => {
          assert.ok(error instanceof InternalServerError);
          assert.equal(error.status, 502);
          assert.equal(error.headers?.get('x-tollwise-attempts'), '1');
          return true;
        },
      );
      assert.equal(messagesCalls(proxy.anthropic).length, 1, 'the only candidate is called exactly once');
    } finally {
      await proxy.close();
    }
  });
});

// ---------------------------------------------------------------- cross-format, real SDKs on both sides

/**
 * claude-x is servable only through OpenRouter (OpenAI wire format): an Anthropic SDK request for it is
 * served through translation (src/proxy/cross-format.ts). gpt-x is servable only through Anthropic
 * (Anthropic wire format): an OpenAI SDK request for it is served through translation the other way.
 * Each model has exactly one candidate, so there is no same-format fallback to silently take instead --
 * a cross-format test that stops translating would fail loudly, not fall back unnoticed.
 */
const CROSS_CATALOG: Catalog = {
  models: [
    { ...entry('anthropic/claude-x'), provider: 'openrouter', canonical_model: 'claude-x' },
    { ...entry('claude-gpt-x'), provider: 'anthropic', canonical_model: 'gpt-x' },
  ],
};

interface CrossProxy {
  readonly url: string;
  readonly openrouter: MockProvider;
  readonly anthropic: MockProvider;
  close(): Promise<void>;
}

async function startCrossProxy(): Promise<CrossProxy> {
  const openrouter = await startMockProvider({});
  const anthropic = await startMockProvider({});
  const config: Config = ConfigSchema.parse({
    providers: {
      openrouter: { base_url: `${openrouter.url}/v1` },
      anthropic: { base_url: anthropic.url },
      openai: { enabled: false },
      deepseek: { enabled: false },
      ollama: { enabled: false },
    },
    routing: {},
  } satisfies ConfigInput);
  const env = { OPENROUTER_API_KEY: FAKE_OPENROUTER_KEY, ANTHROPIC_API_KEY: FAKE_ANTHROPIC_KEY };
  const registry = buildRegistry(config, env);
  const server = createTollwiseServer({
    maxBodyBytes: 512 * 1024,
    logger: createLogger({ level: 'debug', sink: captureLog() }),
    proxy: { config, catalog: CROSS_CATALOG, registry, env },
  });
  const address = await listen(server, '127.0.0.1', 0);
  return {
    url: baseUrl('127.0.0.1', address.port),
    openrouter,
    anthropic,
    async close() {
      await stopServer(server, 100);
      await Promise.all([openrouter.close(), anthropic.close()]);
    },
  };
}

function anthropicSdkClient(proxy: CrossProxy): Anthropic {
  return new Anthropic({ baseURL: proxy.url, apiKey: FAKE_CLIENT_KEY });
}

function openaiSdkClient(proxy: CrossProxy): OpenAI {
  return new OpenAI({ baseURL: `${proxy.url}/v1`, apiKey: FAKE_CLIENT_KEY });
}

function postsTo(mock: MockProvider, path: string) {
  return mock.requests.filter((request) => request.method === 'POST' && request.path === path);
}

describe('cross-format: the Anthropic SDK served by an OpenAI-format provider through translation', () => {
  let proxy: CrossProxy;
  before(async () => {
    proxy = await startCrossProxy();
  });
  after(async () => {
    await proxy.close();
  });
  afterEach(() => {
    proxy.openrouter.requests.length = 0;
  });

  test('non-streaming: messages.create() behaves exactly as it does against a native Anthropic provider', async () => {
    const sdk = anthropicSdkClient(proxy);
    const { data: message, response } = await sdk.messages
      .create({ model: 'claude-x', max_tokens: 100, messages: HELLO })
      .withResponse();

    assert.equal(response.headers.get('x-tollwise-translated'), 'true');
    assert.equal(response.headers.get('x-tollwise-provider'), 'openrouter');
    assert.equal(message.type, 'message');
    assert.equal(message.role, 'assistant');
    assert.equal(message.content[0]?.type, 'text');
    assert.equal((message.content[0] as { text: string }).text, MOCK_TEXT);
    assert.equal(message.stop_reason, 'end_turn');

    const [sent] = postsTo(proxy.openrouter, '/v1/chat/completions');
    assert.equal((sent?.body as { model?: unknown })?.model, 'anthropic/claude-x');
  });

  test('streaming: messages.stream() with finalMessage() behaves the same, over a translated stream', async () => {
    const sdk = anthropicSdkClient(proxy);
    const stream = sdk.messages.stream({ model: 'claude-x', max_tokens: 100, messages: HELLO });
    const { response } = await stream.withResponse();

    assert.equal(response.headers.get('x-tollwise-translated'), 'true');
    const final = await stream.finalMessage();
    assert.equal((final.content[0] as { text: string })?.text, MOCK_TEXT);
    assert.equal(final.stop_reason, 'end_turn');

    const [sent] = postsTo(proxy.openrouter, '/v1/chat/completions');
    assert.equal((sent?.body as { stream?: unknown })?.stream, true);
  });
});

describe('cross-format: the OpenAI SDK served by an Anthropic-format provider through translation', () => {
  let proxy: CrossProxy;
  before(async () => {
    proxy = await startCrossProxy();
  });
  after(async () => {
    await proxy.close();
  });
  afterEach(() => {
    proxy.anthropic.requests.length = 0;
  });

  test('non-streaming: chat.completions.create() behaves exactly as it does against a native OpenAI provider', async () => {
    const sdk = openaiSdkClient(proxy);
    const { data: completion, response } = await sdk.chat.completions
      .create({ model: 'gpt-x', max_completion_tokens: 100, messages: HELLO })
      .withResponse();

    assert.equal(response.headers.get('x-tollwise-translated'), 'true');
    assert.equal(response.headers.get('x-tollwise-provider'), 'anthropic');
    assert.equal(completion.object, 'chat.completion');
    assert.equal(completion.choices[0]?.message.content, MOCK_TEXT);
    assert.equal(completion.choices[0]?.finish_reason, 'stop');

    const [sent] = postsTo(proxy.anthropic, '/v1/messages');
    assert.equal((sent?.body as { model?: unknown })?.model, 'claude-gpt-x');
  });

  test('streaming: a for-await loop reassembles the translated stream unchanged', async () => {
    const sdk = openaiSdkClient(proxy);
    const { data: stream, response } = await sdk.chat.completions
      .create({ model: 'gpt-x', max_completion_tokens: 100, stream: true, messages: HELLO })
      .withResponse();

    assert.equal(response.headers.get('x-tollwise-translated'), 'true');
    let content = '';
    let finishReason: string | null | undefined;
    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      content += choice?.delta.content ?? '';
      if (choice?.finish_reason) finishReason = choice.finish_reason;
    }
    assert.equal(content, MOCK_TEXT);
    assert.equal(finishReason, 'stop');

    const [sent] = postsTo(proxy.anthropic, '/v1/messages');
    assert.equal((sent?.body as { stream?: unknown })?.stream, true);
  });
});
