import assert from 'node:assert/strict';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { after, afterEach, before, describe, test } from 'node:test';
import type { Catalog, ModelEntry } from '../src/catalog/schema.ts';
import { type Config, type ConfigInput, ConfigSchema, type ProviderId } from '../src/config/schema.ts';
import { createLogger, type LogSink } from '../src/log/logger.ts';
import { ANTHROPIC_VERSION } from '../src/providers/anthropic.ts';
import { buildRegistry } from '../src/providers/registry.ts';
import type { ProxyRequestResult } from '../src/proxy/forward.ts';
import { baseUrl, createTollwiseServer, listen, stopServer } from '../src/server/server.ts';
import type { AnthropicStreamEvent, OpenAIStreamItem } from '../src/translate/index.ts';
import { send, type TestResponse } from './fixtures/http-client.ts';
import {
  type MockProvider,
  type RecordedRequest,
  type StartMockProviderOptions,
  startMockProvider,
} from './fixtures/mock-provider.ts';
import { foldAnthropicEvents, foldOpenAIItems, sseData } from './fixtures/stream-replay.ts';

// Fake credentials with no known key shape; none of them is a real key.
const FAKE_OPENAI_KEY = `fakeOpenai${'Oa1'.repeat(6)}`;
const FAKE_OPENROUTER_KEY = `fakeRouter${'Or2'.repeat(6)}`;
const FAKE_ANTHROPIC_KEY = `fakeClaude${'An4'.repeat(6)}`;

const ENV = {
  OPENAI_API_KEY: FAKE_OPENAI_KEY,
  OPENROUTER_API_KEY: FAKE_OPENROUTER_KEY,
  ANTHROPIC_API_KEY: FAKE_ANTHROPIC_KEY,
};

const CAPS = { tools: true, json_mode: true, vision: true, streaming: true };

function entry(provider: ProviderId, model: string, canonical: string, input: number): ModelEntry {
  return {
    provider,
    model,
    canonical_model: canonical,
    price: { input, output: input * 4, cached_input: null },
    context_window: 200_000,
    max_output: 16_000,
    capabilities: CAPS,
    source_url: 'https://example.com/pricing',
    verified_on: '2026-09-01',
  };
}

/**
 * - claude-x: cheapest on OpenRouter (OpenAI format), dearer on Anthropic. An Anthropic client asking for
 *   it is served by OpenRouter through translation, unless the request cannot be translated.
 * - gpt-x: cheapest on Anthropic (Anthropic format), dearer on OpenAI. An OpenAI client asking for it is
 *   served by Anthropic through translation, unless the request cannot be translated.
 * - router-only: OpenRouter only.
 */
const CATALOG: Catalog = {
  models: [
    entry('openrouter', 'anthropic/claude-x', 'claude-x', 1),
    entry('anthropic', 'claude-x', 'claude-x', 3),
    entry('anthropic', 'claude-gpt-x', 'gpt-x', 1),
    entry('openai', 'gpt-x', 'gpt-x', 3),
    entry('openrouter', 'vendor/router-only', 'router-only', 1),
  ],
};

const JSON_TYPE = { 'content-type': 'application/json' } as const;
const MESSAGES_HEADERS = { ...JSON_TYPE, 'anthropic-version': '2023-06-01' } as const;
const HELLO = [{ role: 'user', content: 'Say hello.' }];
const MOCK_TEXT = 'Mock response from the mock provider.';

type MockId = 'openai' | 'openrouter' | 'anthropic';

interface Proxy {
  readonly url: string;
  readonly mocks: Readonly<Record<MockId, MockProvider>>;
  readonly log: string[];
  readonly results: ProxyRequestResult[];
  /** Resolves with the result of the n-th proxied request (0-based) once it is reported. */
  result(index: number): Promise<ProxyRequestResult>;
  close(): Promise<void>;
}

interface ProxyOptions {
  readonly routing?: ConfigInput['routing'];
  readonly mocks?: Partial<Record<MockId, StartMockProviderOptions>>;
  /** Base URL used instead of a provider's mock (a hand-written server). */
  readonly baseUrls?: Partial<Record<MockId, string>>;
}

async function startProxy(options: ProxyOptions = {}): Promise<Proxy> {
  const mocks = {
    openai: await startMockProvider(options.mocks?.openai ?? {}),
    openrouter: await startMockProvider(options.mocks?.openrouter ?? {}),
    anthropic: await startMockProvider(options.mocks?.anthropic ?? {}),
  };
  const url = (id: MockId, fallback: string) => options.baseUrls?.[id] ?? fallback;
  const config: Config = ConfigSchema.parse({
    providers: {
      openai: { base_url: url('openai', `${mocks.openai.url}/v1`) },
      openrouter: { base_url: url('openrouter', `${mocks.openrouter.url}/v1`) },
      anthropic: { base_url: url('anthropic', mocks.anthropic.url) },
      deepseek: { enabled: false },
      ollama: { enabled: false },
    },
    routing: options.routing ?? {},
  } satisfies ConfigInput);
  const lines: string[] = [];
  const sink: LogSink = {
    write(chunk: string) {
      lines.push(chunk);
      return true;
    },
  };
  const results: ProxyRequestResult[] = [];
  const server: Server = createTollwiseServer({
    maxBodyBytes: 64 * 1024,
    logger: createLogger({ level: 'debug', sink }),
    proxy: {
      config,
      catalog: CATALOG,
      registry: buildRegistry(config, ENV),
      env: ENV,
      onRequestResult: (result) => {
        results.push(result);
      },
    },
  });
  const address = await listen(server, '127.0.0.1', 0);
  return {
    url: baseUrl('127.0.0.1', address.port),
    mocks,
    log: lines,
    results,
    async result(index: number) {
      const deadline = performance.now() + 3000;
      while (results[index] === undefined) {
        if (performance.now() > deadline) throw new Error(`no result for request ${index}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return results[index] as ProxyRequestResult;
    },
    async close() {
      await stopServer(server, 100);
      await Promise.all(Object.values(mocks).map((each) => each.close()));
    },
  };
}

function chat(proxy: Proxy, body: Record<string, unknown>): Promise<TestResponse> {
  return send(proxy.url, '/v1/chat/completions', { method: 'POST', headers: JSON_TYPE, body: JSON.stringify(body) });
}

function messages(
  proxy: Proxy,
  body: Record<string, unknown>,
  headers: Readonly<Record<string, string>> = {},
): Promise<TestResponse> {
  return send(proxy.url, '/v1/messages', {
    method: 'POST',
    headers: { ...MESSAGES_HEADERS, ...headers },
    body: JSON.stringify(body),
  });
}

function posts(mock: MockProvider): RecordedRequest[] {
  return mock.requests.filter((request) => request.method === 'POST');
}

/** The one chat call a mock received. */
function onlyPost(mock: MockProvider): RecordedRequest {
  const calls = posts(mock);
  assert.equal(calls.length, 1);
  return calls[0] as RecordedRequest;
}

interface PartialResponse {
  readonly status: number;
  readonly text: string;
  /** False when the body ended early (the connection closed without the final chunk) or was abandoned. */
  readonly complete: boolean;
}

/**
 * Sends one request to /v1/messages and reads its body as far as it goes, without failing when the body
 * ends early. With `abortAfterBytes`, the client goes away once that many body bytes arrived.
 */
function streamMessages(
  proxy: Proxy,
  body: Record<string, unknown>,
  abortAfterBytes?: number,
): Promise<PartialResponse> {
  const url = new URL(proxy.url);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: url.hostname,
        port: url.port,
        path: '/v1/messages',
        method: 'POST',
        headers: { ...MESSAGES_HEADERS, connection: 'close' },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let settled = false;
        const finish = (complete: boolean): void => {
          if (settled) return;
          settled = true;
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8'), complete });
        };
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
          if (abortAfterBytes !== undefined && Buffer.concat(chunks).length >= abortAfterBytes) {
            req.destroy();
            finish(false);
          }
        });
        res.on('end', () => finish(true));
        res.on('error', () => finish(false));
        res.on('close', () => finish(false));
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

/** The Anthropic events of a streamed answer, parsed. */
function anthropicEvents(res: TestResponse): AnthropicStreamEvent[] {
  return sseData(res.text).map((data) => JSON.parse(data) as AnthropicStreamEvent);
}

/** The OpenAI items of a streamed answer, parsed ([DONE] kept as is). */
function openaiItems(res: TestResponse): OpenAIStreamItem[] {
  return sseData(res.text).map((data) => (data === '[DONE]' ? '[DONE]' : (JSON.parse(data) as OpenAIStreamItem)));
}

/** Every `event:` name of an SSE body, in order. */
function eventNames(text: string): string[] {
  return [...text.matchAll(/^event: (.+)$/gm)].map((match) => match[1] as string);
}

function assertTranslatedHeaders(res: TestResponse, provider: ProviderId, model: string): void {
  assert.equal(res.headers['x-tollwise-translated'], 'true');
  assert.equal(res.headers['x-tollwise-provider'], provider);
  assert.equal(res.headers['x-tollwise-model'], model);
  assert.equal(res.headers['x-tollwise-routed'], 'true');
  assert.match(String(res.headers['x-tollwise-request-id']), /^[0-9a-f-]{36}$/);
}

const ANTHROPIC_TOOLS = [
  {
    name: 'get_weather',
    description: 'Current weather for a city.',
    input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  },
];

const OPENAI_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Current weather for a city.',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    },
  },
];

// ---------------------------------------------------------------- Anthropic client, OpenAI-format provider

describe('an Anthropic Messages request served by an OpenAI-format provider', () => {
  let proxy: Proxy;
  before(async () => {
    proxy = await startProxy({
      mocks: {
        openrouter: {
          responses: [
            {},
            {},
            { toolCall: { name: 'get_weather', arguments: { city: 'Lisbon', days: 3 } } },
            { toolCall: { name: 'get_weather', arguments: { city: 'Porto' } } },
          ],
        },
      },
    });
  });
  after(async () => {
    await proxy.close();
  });

  test('non-streaming: the request is sent in the OpenAI format and the answer comes back as a Message', async () => {
    const res = await messages(proxy, { model: 'claude-x', max_tokens: 100, system: 'Be brief.', messages: HELLO });
    assert.equal(res.status, 200);
    assertTranslatedHeaders(res, 'openrouter', 'anthropic/claude-x');
    assert.equal(res.headers['content-type'], 'application/json');
    assert.equal(res.headers['content-length'], String(Buffer.byteLength(res.text)));

    const sent = onlyPost(proxy.mocks.openrouter);
    assert.equal(sent.path, '/v1/chat/completions');
    assert.deepEqual(sent.body, {
      model: 'anthropic/claude-x',
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'Say hello.' },
      ],
      max_tokens: 100,
    });
    // The OpenAI-format provider gets its own key, and none of the Anthropic-only headers.
    assert.equal(sent.headers.authorization, `Bearer ${FAKE_OPENROUTER_KEY}`);
    assert.equal(sent.headers['x-api-key'], undefined);
    assert.equal(sent.headers['anthropic-version'], undefined);
    assert.equal(sent.headers['anthropic-beta'], undefined);
    assert.equal(posts(proxy.mocks.anthropic).length, 0);

    const message = res.json as Record<string, unknown>;
    assert.equal(message.type, 'message');
    assert.equal(message.role, 'assistant');
    assert.equal(message.model, 'anthropic/claude-x');
    assert.match(String(message.id), /^chatcmpl-mock-/);
    assert.deepEqual(message.content, [{ type: 'text', text: MOCK_TEXT }]);
    assert.equal(message.stop_reason, 'end_turn');
    assert.deepEqual(message.usage, {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
    });

    const result = await proxy.result(0);
    assert.equal(result.translated, true);
    assert.equal(result.provider, 'openrouter');
    assert.equal(result.outcome, 'complete');
    assert.deepEqual(result.usage, { input: 10, cachedInput: null, output: 5 });
  });

  test('streaming: the OpenAI chunks come back as Anthropic events, and usage is captured', async () => {
    proxy.mocks.openrouter.requests.length = 0;
    const res = await messages(proxy, { model: 'claude-x', max_tokens: 100, stream: true, messages: HELLO });
    assert.equal(res.status, 200);
    assertTranslatedHeaders(res, 'openrouter', 'anthropic/claude-x');
    assert.equal(res.headers['content-type'], 'text/event-stream; charset=utf-8');

    const sent = onlyPost(proxy.mocks.openrouter);
    // Usage is always asked for, so the translated stream reports real counts.
    assert.deepEqual(sent.body, {
      model: 'anthropic/claude-x',
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: 'Say hello.' }],
      max_tokens: 100,
    });

    // No byte of the provider's own stream reaches the client.
    assert.ok(!res.text.includes('chat.completion.chunk'));
    assert.ok(!res.text.includes('[DONE]'));
    const names = eventNames(res.text);
    assert.equal(names[0], 'message_start');
    assert.equal(names[1], 'content_block_start');
    assert.deepEqual(names.slice(-3), ['content_block_stop', 'message_delta', 'message_stop']);
    const message = foldAnthropicEvents(anthropicEvents(res));
    assert.deepEqual(message.content, [{ type: 'text', text: MOCK_TEXT }]);
    assert.equal(message.stop_reason, 'end_turn');
    assert.deepEqual(message.usage, {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
    });

    const result = await proxy.result(1);
    assert.equal(result.translated, true);
    assert.equal(result.stream, true);
    assert.equal(result.outcome, 'complete');
    assert.deepEqual(result.usage, { input: 10, cachedInput: null, output: 5 });
  });

  test('tools, non-streaming: tools go out as functions and the tool call comes back as tool_use', async () => {
    proxy.mocks.openrouter.requests.length = 0;
    const res = await messages(proxy, {
      model: 'claude-x',
      max_tokens: 100,
      tools: ANTHROPIC_TOOLS,
      tool_choice: { type: 'auto' },
      messages: [{ role: 'user', content: 'Weather in Lisbon?' }],
    });
    assert.equal(res.status, 200);
    assertTranslatedHeaders(res, 'openrouter', 'anthropic/claude-x');
    const sent = onlyPost(proxy.mocks.openrouter).body as Record<string, unknown>;
    assert.deepEqual(sent.tools, OPENAI_TOOLS);
    assert.equal(sent.tool_choice, 'auto');

    const message = res.json as { content: Record<string, unknown>[]; stop_reason: string };
    assert.equal(message.stop_reason, 'tool_use');
    assert.equal(message.content.length, 1);
    const [block] = message.content;
    assert.equal(block?.type, 'tool_use');
    assert.equal(block?.name, 'get_weather');
    assert.deepEqual(block?.input, { city: 'Lisbon', days: 3 });
    assert.match(String(block?.id), /^call-mock-|^call_/);
  });

  test('tools, streaming: the tool call arguments arrive as input_json_delta events', async () => {
    const res = await messages(proxy, {
      model: 'claude-x',
      max_tokens: 100,
      stream: true,
      tools: ANTHROPIC_TOOLS,
      messages: [{ role: 'user', content: 'Weather in Porto?' }],
    });
    assert.equal(res.status, 200);
    assertTranslatedHeaders(res, 'openrouter', 'anthropic/claude-x');
    const events = anthropicEvents(res);
    assert.ok(events.some((event) => event.type === 'content_block_delta' && event.delta.type === 'input_json_delta'));
    const message = foldAnthropicEvents(events);
    const [block] = message.content as Record<string, unknown>[];
    assert.equal(block?.type, 'tool_use');
    assert.equal(block?.name, 'get_weather');
    assert.deepEqual(block?.input, { city: 'Porto' });
    assert.equal(message.stop_reason, 'tool_use');
    const result = await proxy.result(3);
    assert.deepEqual(result.usage, { input: 10, cachedInput: null, output: 5 });
  });
});

// ---------------------------------------------------------------- OpenAI client, Anthropic-format provider

describe('an OpenAI Chat Completions request served by an Anthropic-format provider', () => {
  let proxy: Proxy;
  before(async () => {
    proxy = await startProxy({
      mocks: {
        anthropic: {
          responses: [
            {},
            {},
            {},
            { toolCall: { name: 'get_weather', arguments: { city: 'Lisbon' } } },
            { toolCall: { name: 'get_weather', arguments: { city: 'Faro', unit: 'C' } } },
            { toolCall: { name: 'json_response', arguments: { answer: 42 } } },
          ],
        },
      },
    });
  });
  after(async () => {
    await proxy.close();
  });

  test('non-streaming: the request is sent in the Anthropic format and the answer comes back as a completion', async () => {
    const res = await chat(proxy, {
      model: 'gpt-x',
      max_tokens: 64,
      messages: [{ role: 'system', content: 'Be brief.' }, ...HELLO],
    });
    assert.equal(res.status, 200);
    assertTranslatedHeaders(res, 'anthropic', 'claude-gpt-x');
    assert.equal(res.headers['content-type'], 'application/json');

    const sent = onlyPost(proxy.mocks.anthropic);
    assert.equal(sent.path, '/v1/messages');
    assert.deepEqual(sent.body, {
      model: 'claude-gpt-x',
      max_tokens: 64,
      system: 'Be brief.',
      messages: [{ role: 'user', content: 'Say hello.' }],
    });
    assert.equal(sent.headers['x-api-key'], FAKE_ANTHROPIC_KEY);
    assert.equal(sent.headers['anthropic-version'], ANTHROPIC_VERSION);
    assert.equal(sent.headers.authorization, undefined);
    assert.equal(posts(proxy.mocks.openai).length, 0);

    const completion = res.json as Record<string, unknown>;
    assert.equal(completion.object, 'chat.completion');
    assert.equal(completion.model, 'claude-gpt-x');
    assert.equal(typeof completion.created, 'number');
    assert.deepEqual(completion.choices, [
      {
        index: 0,
        message: { role: 'assistant', content: MOCK_TEXT, refusal: null },
        finish_reason: 'stop',
        logprobs: null,
      },
    ]);
    assert.deepEqual(completion.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });

    const result = await proxy.result(0);
    assert.equal(result.translated, true);
    assert.deepEqual(result.usage, { input: 10, cachedInput: null, output: 5 });
  });

  test('streaming with include_usage: Anthropic events come back as chunks, a usage chunk and [DONE]', async () => {
    proxy.mocks.anthropic.requests.length = 0;
    const res = await chat(proxy, {
      model: 'gpt-x',
      max_completion_tokens: 64,
      stream: true,
      stream_options: { include_usage: true },
      messages: HELLO,
    });
    assert.equal(res.status, 200);
    assertTranslatedHeaders(res, 'anthropic', 'claude-gpt-x');
    assert.equal(res.headers['content-type'], 'text/event-stream; charset=utf-8');
    assert.deepEqual(onlyPost(proxy.mocks.anthropic).body, {
      model: 'claude-gpt-x',
      max_tokens: 64,
      stream: true,
      messages: [{ role: 'user', content: 'Say hello.' }],
    });

    assert.ok(!res.text.includes('event: '));
    const items = openaiItems(res);
    assert.equal(items.at(-1), '[DONE]');
    const usageChunk = items.at(-2) as { choices: unknown[]; usage: unknown };
    assert.deepEqual(usageChunk.choices, []);
    assert.deepEqual(usageChunk.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    const folded = foldOpenAIItems(items);
    assert.deepEqual(folded.message, { role: 'assistant', content: MOCK_TEXT });
    assert.equal(folded.finish_reason, 'stop');

    const result = await proxy.result(1);
    assert.equal(result.outcome, 'complete');
    assert.deepEqual(result.usage, { input: 10, cachedInput: null, output: 5 });
  });

  test('streaming without include_usage: no usage chunk for the client, usage still captured', async () => {
    const res = await chat(proxy, { model: 'gpt-x', max_tokens: 64, stream: true, messages: HELLO });
    assert.equal(res.status, 200);
    const items = openaiItems(res);
    assert.equal(items.at(-1), '[DONE]');
    assert.ok(
      items.every((item) => item === '[DONE]' || ('choices' in item && item.choices.length === 1)),
      'every chunk carries a choice',
    );
    assert.ok(!res.text.includes('"usage"'));
    const result = await proxy.result(2);
    assert.deepEqual(result.usage, { input: 10, cachedInput: null, output: 5 });
  });

  test('tools, non-streaming: functions go out as tools and tool_use comes back as tool_calls', async () => {
    proxy.mocks.anthropic.requests.length = 0;
    const res = await chat(proxy, {
      model: 'gpt-x',
      max_tokens: 64,
      tools: OPENAI_TOOLS,
      tool_choice: 'required',
      messages: [{ role: 'user', content: 'Weather in Lisbon?' }],
    });
    assert.equal(res.status, 200);
    const sent = onlyPost(proxy.mocks.anthropic).body as Record<string, unknown>;
    assert.deepEqual(sent.tools, ANTHROPIC_TOOLS);
    assert.deepEqual(sent.tool_choice, { type: 'any' });

    const [choice] = (res.json as { choices: Record<string, unknown>[] }).choices;
    assert.equal(choice?.finish_reason, 'tool_calls');
    const message = choice?.message as { content: unknown; tool_calls: Record<string, unknown>[] };
    assert.equal(message.content, null);
    assert.equal(message.tool_calls.length, 1);
    const [call] = message.tool_calls;
    assert.equal(call?.type, 'function');
    assert.deepEqual(call?.function, { name: 'get_weather', arguments: '{"city":"Lisbon"}' });
  });

  test('tools, streaming: tool_use input arrives as tool_calls argument pieces', async () => {
    const res = await chat(proxy, {
      model: 'gpt-x',
      max_tokens: 64,
      stream: true,
      tools: OPENAI_TOOLS,
      messages: [{ role: 'user', content: 'Weather in Faro?' }],
    });
    assert.equal(res.status, 200);
    const folded = foldOpenAIItems(openaiItems(res));
    assert.equal(folded.finish_reason, 'tool_calls');
    const calls = (folded.message as { tool_calls: { function: { name: string; arguments: string } }[] }).tool_calls;
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.function.name, 'get_weather');
    assert.deepEqual(JSON.parse(calls[0]?.function.arguments ?? ''), { city: 'Faro', unit: 'C' });
    const result = await proxy.result(4);
    assert.deepEqual(result.usage, { input: 10, cachedInput: null, output: 5 });
  });

  test('JSON mode: carried by a forced tool call, and returned as the message content', async () => {
    proxy.mocks.anthropic.requests.length = 0;
    const res = await chat(proxy, {
      model: 'gpt-x',
      max_tokens: 64,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: 'Answer in JSON.' }],
    });
    assert.equal(res.status, 200);
    const sent = onlyPost(proxy.mocks.anthropic).body as Record<string, unknown>;
    assert.deepEqual(sent.tool_choice, { type: 'tool', name: 'json_response' });
    const [choice] = (res.json as { choices: { message: { content: string }; finish_reason: string }[] }).choices;
    assert.equal(choice?.finish_reason, 'stop');
    assert.deepEqual(JSON.parse(choice?.message.content ?? ''), { answer: 42 });
  });
});

// ---------------------------------------------------------------- untranslatable requests

describe('a request that cannot be translated', () => {
  let proxy: Proxy;
  before(async () => {
    proxy = await startProxy();
  });
  after(async () => {
    await proxy.close();
  });
  afterEach(() => {
    for (const mock of Object.values(proxy.mocks)) mock.requests.length = 0;
  });

  test('an Anthropic feature with no OpenAI equivalent (top_k) goes to the dearer same-format candidate', async () => {
    const res = await messages(proxy, { model: 'claude-x', max_tokens: 100, top_k: 5, messages: HELLO });
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-tollwise-provider'], 'anthropic');
    assert.equal(res.headers['x-tollwise-model'], 'claude-x');
    assert.equal(res.headers['x-tollwise-translated'], 'false');
    assert.equal(posts(proxy.mocks.openrouter).length, 0);
    // Sent as received: only the model field could change, and it did not.
    assert.deepEqual(onlyPost(proxy.mocks.anthropic).body, {
      model: 'claude-x',
      max_tokens: 100,
      top_k: 5,
      messages: HELLO,
    });
  });

  test('an Anthropic request with an anthropic-beta header goes to the same-format candidate, header kept', async () => {
    const res = await messages(
      proxy,
      { model: 'claude-x', max_tokens: 100, messages: HELLO },
      { 'anthropic-beta': 'some-beta-2026-01-01' },
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-tollwise-provider'], 'anthropic');
    assert.equal(res.headers['x-tollwise-translated'], 'false');
    assert.equal(posts(proxy.mocks.openrouter).length, 0);
    assert.equal(onlyPost(proxy.mocks.anthropic).headers['anthropic-beta'], 'some-beta-2026-01-01');
  });

  test('an OpenAI request with no output budget goes to the dearer same-format candidate', async () => {
    const res = await chat(proxy, { model: 'gpt-x', messages: HELLO });
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-tollwise-provider'], 'openai');
    assert.equal(res.headers['x-tollwise-translated'], 'false');
    assert.equal(posts(proxy.mocks.anthropic).length, 0);
  });

  test('an OpenAI feature with no Anthropic equivalent (n > 1) goes to the same-format candidate', async () => {
    const res = await chat(proxy, { model: 'gpt-x', max_tokens: 10, n: 2, messages: HELLO });
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-tollwise-provider'], 'openai');
    assert.equal(posts(proxy.mocks.anthropic).length, 0);
  });

  test('with only an other-format entry, the request passes through unchanged to the native provider', async () => {
    const res = await messages(proxy, { model: 'router-only', max_tokens: 100, top_k: 5, messages: HELLO });
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-tollwise-provider'], 'anthropic');
    assert.equal(res.headers['x-tollwise-model'], 'router-only');
    assert.equal(res.headers['x-tollwise-routed'], 'false');
    assert.equal(res.headers['x-tollwise-translated'], 'false');
    assert.equal(posts(proxy.mocks.openrouter).length, 0);
    assert.equal((onlyPost(proxy.mocks.anthropic).body as { model: string }).model, 'router-only');
  });

  test('the same request translates when the feature is not used', async () => {
    const res = await messages(proxy, { model: 'router-only', max_tokens: 100, messages: HELLO });
    assert.equal(res.status, 200);
    assertTranslatedHeaders(res, 'openrouter', 'vendor/router-only');
    assert.equal(posts(proxy.mocks.anthropic).length, 0);
  });
});

describe('a request that cannot be translated, in fail mode', () => {
  test('is a 422 naming the untranslatable feature and the entry it ruled out', async () => {
    const proxy = await startProxy({ routing: { on_no_candidate: 'fail' } });
    try {
      const res = await messages(proxy, { model: 'router-only', max_tokens: 100, top_k: 5, messages: HELLO });
      assert.equal(res.status, 422);
      const body = res.json as { type: string; error: { type: string; message: string } };
      assert.equal(body.error.type, 'invalid_request_error');
      assert.equal(
        body.error.message,
        'Tollwise cannot route this request: no provider can serve model "router-only" for this request: ' +
          'provider speaks another API format, and the request uses a feature that cannot be translated to it: ' +
          'anthropic_top_k (openrouter/vendor/router-only).',
      );
      for (const mock of Object.values(proxy.mocks)) assert.equal(posts(mock).length, 0);
    } finally {
      await proxy.close();
    }
  });
});

// ---------------------------------------------------------------- fallback across formats

describe('fallback across wire formats', () => {
  test('a failing translated candidate falls back to the same-format one', async () => {
    const proxy = await startProxy({
      mocks: { openrouter: { failWith: { status: 500, message: 'upstream exploded' } } },
    });
    try {
      const res = await messages(proxy, { model: 'claude-x', max_tokens: 100, messages: HELLO });
      assert.equal(res.status, 200);
      assert.equal(res.headers['x-tollwise-provider'], 'anthropic');
      assert.equal(res.headers['x-tollwise-translated'], 'false');
      assert.equal(res.headers['x-tollwise-attempts'], '2');
      assert.equal((res.json as { type: string }).type, 'message');
      const result = await proxy.result(0);
      assert.equal(result.translated, false);
      assert.deepEqual(
        result.attempts.map((attempt) => [attempt.provider, attempt.outcome, attempt.status]),
        [
          ['openrouter', 'server', 500],
          ['anthropic', 'ok', 200],
        ],
      );
    } finally {
      await proxy.close();
    }
  });

  test('a failing same-format candidate falls back to a translated one, streaming', async () => {
    const proxy = await startProxy({
      routing: { policy: 'pinned', pinned: { provider: 'openai', model: 'gpt-x' } },
      mocks: { openai: { failWith: { status: 429, message: 'slow down' } } },
    });
    try {
      const res = await chat(proxy, { model: 'gpt-x', max_tokens: 64, stream: true, messages: HELLO });
      assert.equal(res.status, 200);
      assert.equal(res.headers['x-tollwise-provider'], 'anthropic');
      assert.equal(res.headers['x-tollwise-translated'], 'true');
      assert.equal(res.headers['x-tollwise-attempts'], '2');
      assert.equal(foldOpenAIItems(openaiItems(res)).finish_reason, 'stop');
      const result = await proxy.result(0);
      assert.deepEqual(
        result.attempts.map((attempt) => [attempt.provider, attempt.outcome, attempt.status]),
        [
          ['openai', 'rate_limit', 429],
          ['anthropic', 'ok', 200],
        ],
      );
      assert.deepEqual(result.usage, { input: 10, cachedInput: null, output: 5 });
    } finally {
      await proxy.close();
    }
  });

  test('a provider error from a translated candidate that is not retried comes back in the client format', async () => {
    const proxy = await startProxy({
      mocks: { anthropic: { failWith: { status: 400, type: 'invalid_request_error', message: 'bad input' } } },
    });
    try {
      const res = await chat(proxy, { model: 'gpt-x', max_tokens: 64, messages: HELLO });
      assert.equal(res.status, 400);
      assert.equal(res.headers['x-tollwise-translated'], 'true');
      const error = (res.json as { error: { message: string; code: string } }).error;
      assert.equal(error.code, 'provider_bad_request');
      assert.equal(error.message, 'The anthropic provider answered with HTTP 400: bad input');
      assert.equal(posts(proxy.mocks.openai).length, 0);
    } finally {
      await proxy.close();
    }
  });
});

// ---------------------------------------------------------------- answers that cannot be translated back

/** A hand-written OpenAI-format provider that answers every chat call with `respond`. */
async function openaiServer(respond: (req: IncomingMessage, res: ServerResponse) => void): Promise<{
  readonly url: string;
  close(): Promise<void>;
}> {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => respond(req, res));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const TWO_CHOICES = {
  id: 'chatcmpl-two',
  object: 'chat.completion',
  created: 1,
  model: 'anthropic/claude-x',
  choices: [
    { index: 0, message: { role: 'assistant', content: 'one' }, finish_reason: 'stop' },
    { index: 1, message: { role: 'assistant', content: 'two' }, finish_reason: 'stop' },
  ],
  usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
};

describe('a provider answer that cannot be translated back', () => {
  test('non-streaming: a 502 response_not_translatable in the client format, never a partial answer', async () => {
    const upstream = await openaiServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(TWO_CHOICES));
    });
    const proxy = await startProxy({ baseUrls: { openrouter: upstream.url } });
    try {
      const res = await messages(proxy, { model: 'claude-x', max_tokens: 100, messages: HELLO });
      assert.equal(res.status, 502);
      assert.equal(res.headers['x-tollwise-translated'], 'true');
      assert.deepEqual(res.json, {
        type: 'error',
        error: {
          type: 'api_error',
          message:
            'The OpenAI Chat Completions answer could not be translated to the Anthropic Messages format: ' +
            'multiple_choices.',
        },
      });
      assert.ok(!res.text.includes('two'));
      const result = await proxy.result(0);
      assert.equal(result.outcome, 'translation_failed');
      // The provider did the work: its usage is still recorded.
      assert.deepEqual(result.usage, { input: 7, cachedInput: null, output: 3 });
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  test('streaming: the stream ends with one Anthropic error event and nothing after it', async () => {
    const chunk = (body: Record<string, unknown>) =>
      `data: ${JSON.stringify({ id: 'chatcmpl-s', object: 'chat.completion.chunk', created: 1, model: 'm', ...body })}\n\n`;
    const upstream = await openaiServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Hi' }, finish_reason: null }] }));
      res.write(chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'mystery' }] }));
      res.write(chunk({ choices: [{ index: 0, delta: { content: 'never seen' }, finish_reason: null }] }));
      res.end('data: [DONE]\n\n');
    });
    const proxy = await startProxy({ baseUrls: { openrouter: upstream.url } });
    try {
      const res = await messages(proxy, { model: 'claude-x', max_tokens: 100, stream: true, messages: HELLO });
      assert.equal(res.status, 200);
      const events = anthropicEvents(res);
      assert.deepEqual(
        events.map((event) => event.type),
        ['message_start', 'content_block_start', 'content_block_delta', 'error'],
      );
      assert.deepEqual(events.at(-1), {
        type: 'error',
        error: {
          type: 'api_error',
          message: 'cannot translate the response from the openai format to the anthropic format: unknown_stop_reason',
        },
      });
      assert.ok(!res.text.includes('never seen'));
      const result = await proxy.result(0);
      assert.equal(result.outcome, 'translation_failed');
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  test('streaming: a provider stream cut short is cut for the client too, without a made-up end', async () => {
    const proxy = await startProxy({ mocks: { openrouter: { dropMidStream: true } } });
    try {
      const res = await streamMessages(proxy, { model: 'claude-x', max_tokens: 100, stream: true, messages: HELLO });
      assert.equal(res.status, 200);
      assert.equal(res.complete, false, 'the client sees the body end early');
      const names = eventNames(res.text);
      // The provider sent its first chunk (the role) before the drop: it was translated and relayed, and
      // no end was made up, not even an error event.
      assert.deepEqual(names, ['message_start']);
      const result = await proxy.result(0);
      assert.equal(result.outcome, 'interrupted');
      assert.equal(result.translated, true);
      assert.equal(result.usage, null);
    } finally {
      await proxy.close();
    }
  });
});

describe('a client that goes away during a translated stream', () => {
  test('aborts the provider call', async () => {
    const proxy = await startProxy({ mocks: { openrouter: { chunkDelayMs: 200 } } });
    try {
      const res = await streamMessages(proxy, { model: 'claude-x', max_tokens: 100, stream: true, messages: HELLO }, 1);
      assert.equal(res.complete, false);
      await proxy.mocks.openrouter.waitForDisconnect(0);
      const result = await proxy.result(0);
      assert.equal(result.outcome, 'client_aborted');
      assert.equal(result.translated, true);
      assert.equal(result.status, 200);
    } finally {
      await proxy.close();
    }
  });
});

describe('logging of translated requests', () => {
  test('nothing from the request body or a key reaches the log', async () => {
    const proxy = await startProxy();
    try {
      const marker = 'do-not-log-this-prompt';
      const res = await messages(proxy, {
        model: 'claude-x',
        max_tokens: 100,
        messages: [{ role: 'user', content: marker }],
      });
      assert.equal(res.status, 200);
      await proxy.result(0);
      const log = proxy.log.join('');
      assert.ok(log.includes('"translated":true'));
      assert.ok(!log.includes(marker));
      assert.ok(!log.includes(FAKE_OPENROUTER_KEY));
      assert.ok(!log.includes(FAKE_ANTHROPIC_KEY));
    } finally {
      await proxy.close();
    }
  });
});
