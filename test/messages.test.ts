import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { after, afterEach, before, describe, test } from 'node:test';
import type { Catalog, ModelEntry } from '../src/catalog/schema.ts';
import { type Config, type ConfigInput, ConfigSchema, type ProviderId } from '../src/config/schema.ts';
import { createLogger, type LogSink } from '../src/log/logger.ts';
import { ANTHROPIC_VERSION } from '../src/providers/anthropic.ts';
import { buildRegistry } from '../src/providers/registry.ts';
import { MISSING_VERSION_MESSAGE, readAnthropicUsage } from '../src/proxy/anthropic.ts';
import type { ProxyRequestResult } from '../src/proxy/forward.ts';
import { inspect } from '../src/routing/inspect.ts';
import { type RoutingSettings, select } from '../src/routing/select.ts';
import { anthropicErrorType } from '../src/server/respond.ts';
import { errorWriterFor } from '../src/server/router.ts';
import { baseUrl, createTollwiseServer, listen, stopServer } from '../src/server/server.ts';
import { untranslatable } from '../src/translate/index.ts';
import { freePort, send, type TestResponse } from './fixtures/http-client.ts';
import { type MockProvider, type StartMockProviderOptions, startMockProvider } from './fixtures/mock-provider.ts';

// Fake credentials with no known key shape; none of them is a real key.
const FAKE_OPENAI_KEY = `fakeOpenai${'Oa1'.repeat(6)}`;
const FAKE_OPENROUTER_KEY = `fakeRouter${'Or2'.repeat(6)}`;
const FAKE_ANTHROPIC_KEY = `fakeClaude${'An4'.repeat(6)}`;
const FAKE_CLIENT_KEY = `fakeClient${'Ck7'.repeat(6)}`;
const FAKE_ACCESS_KEY = `fakeAccess${'Ak9'.repeat(8)}`;

const ENV = {
  OPENAI_API_KEY: FAKE_OPENAI_KEY,
  OPENROUTER_API_KEY: FAKE_OPENROUTER_KEY,
  ANTHROPIC_API_KEY: FAKE_ANTHROPIC_KEY,
};

const ALL_CAPS = { tools: true, json_mode: true, vision: true, streaming: true };
const NO_CAPS = { tools: false, json_mode: false, vision: false, streaming: true };

function entry(
  provider: ProviderId,
  model: string,
  canonical: string,
  input: number,
  output: number,
  capabilities = ALL_CAPS,
): ModelEntry {
  return {
    provider,
    model,
    canonical_model: canonical,
    price: { input, output, cached_input: null },
    context_window: 200_000,
    max_output: 16_000,
    capabilities,
    source_url: 'https://example.com/pricing',
    verified_on: '2026-09-01',
  };
}

/**
 * - claude-x: two Anthropic entries (the dated id dearer than the alias). Serving a model through a
 *   provider of the other format is covered in cross-format.test.ts.
 * - claude-lite: a cheap Anthropic entry without tools/json/vision and a dearer one with all of them.
 * - router-only: OpenRouter only (OpenAI format).
 * - blind-claude: Anthropic only, no vision.
 */
const CATALOG: Catalog = {
  models: [
    entry('anthropic', 'claude-x-20260901', 'claude-x', 3, 15),
    entry('anthropic', 'claude-x', 'claude-x', 1, 5),
    entry('anthropic', 'claude-lite-full', 'claude-lite', 4, 16),
    entry('anthropic', 'claude-lite', 'claude-lite', 0.1, 0.4, NO_CAPS),
    entry('openrouter', 'vendor/router-only', 'router-only', 1, 2),
    entry('anthropic', 'blind-claude', 'blind-claude', 1, 2, { ...ALL_CAPS, vision: false }),
  ],
};

const MESSAGES_HEADERS = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' } as const;

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
  readonly openrouter: MockProvider;
  readonly anthropic: MockProvider;
  readonly log: string[];
  readonly results: ProxyRequestResult[];
  close(): Promise<void>;
}

interface ProxyOptions {
  readonly routing?: ConfigInput['routing'];
  readonly accessKey?: string;
  readonly anthropic?: StartMockProviderOptions;
  /** Base URL for anthropic instead of its mock (e.g. a closed port). */
  readonly anthropicBaseUrl?: string;
  /** Leave anthropic disabled. */
  readonly anthropicDisabled?: boolean;
}

async function startProxy(options: ProxyOptions = {}): Promise<Proxy> {
  const openai = await startMockProvider({});
  const openrouter = await startMockProvider({});
  const anthropic = await startMockProvider(options.anthropic ?? {});
  const config: Config = ConfigSchema.parse({
    providers: {
      openai: { base_url: `${openai.url}/v1` },
      openrouter: { base_url: `${openrouter.url}/v1` },
      anthropic: {
        enabled: options.anthropicDisabled !== true,
        base_url: options.anthropicBaseUrl ?? anthropic.url,
      },
      deepseek: { enabled: false },
      ollama: { enabled: false },
    },
    routing: options.routing ?? {},
  } satisfies ConfigInput);
  const registry = buildRegistry(config, ENV);
  const log = captureLog();
  const results: ProxyRequestResult[] = [];
  const server: Server = createTollwiseServer({
    maxBodyBytes: 64 * 1024,
    logger: createLogger({ level: 'debug', sink: log }),
    accessKey: options.accessKey,
    proxy: { config, catalog: CATALOG, registry, env: ENV, onRequestResult: (result) => results.push(result) },
  });
  const address = await listen(server, '127.0.0.1', 0);
  return {
    url: baseUrl('127.0.0.1', address.port),
    openai,
    openrouter,
    anthropic,
    log: log.lines,
    results,
    async close() {
      await stopServer(server, 100);
      await Promise.all([openai.close(), openrouter.close(), anthropic.close()]);
    },
  };
}

function messages(proxy: Proxy, body: unknown, headers: Readonly<Record<string, string>> = {}): Promise<TestResponse> {
  return send(proxy.url, '/v1/messages', {
    method: 'POST',
    headers: { ...MESSAGES_HEADERS, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const HELLO = [{ role: 'user', content: 'Say hello.' }];

function request(model: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { model, max_tokens: 256, messages: HELLO, ...extra };
}

function postCalls(mock: MockProvider) {
  return mock.requests.filter((recorded) => recorded.method === 'POST');
}

/** The model field of the first request a mock received. */
function sentModel(mock: MockProvider): unknown {
  const body = postCalls(mock)[0]?.body as { model?: unknown } | undefined;
  return body?.model;
}

/** Asserts an Anthropic-shaped error, exactly `{ type: "error", error: { type, message } }`; returns the message. */
function assertAnthropicError(res: TestResponse, status: number, type: string): string {
  assert.equal(res.status, status);
  const body = res.json as { type?: unknown; error?: { type?: unknown; message?: unknown } };
  assert.equal(body.type, 'error');
  assert.ok(body.error !== undefined, 'Anthropic error object present');
  assert.deepEqual(Object.keys(body), ['type', 'error']);
  assert.deepEqual(Object.keys(body.error), ['type', 'message']);
  assert.equal(body.error.type, type);
  assert.equal(typeof body.error.message, 'string');
  return body.error.message as string;
}

function assertRequestId(res: TestResponse): void {
  assert.match(String(res.headers['x-tollwise-request-id']), /^[0-9a-f-]{36}$/);
}

function assertNoUpstreamCall(proxy: Proxy): void {
  assert.equal(postCalls(proxy.openai).length, 0);
  assert.equal(postCalls(proxy.openrouter).length, 0);
  assert.equal(postCalls(proxy.anthropic).length, 0);
}

// ---------------------------------------------------------------- helpers

describe('readAnthropicUsage', () => {
  test('reads input and output tokens', () => {
    assert.deepEqual(readAnthropicUsage({ input_tokens: 12, output_tokens: 7 }), {
      input: 12,
      cachedInput: null,
      output: 7,
    });
  });

  test('counts cache reads and cache writes as input, and cache reads as cached input', () => {
    assert.deepEqual(
      readAnthropicUsage({
        input_tokens: 20,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 30,
        output_tokens: 4,
      }),
      { input: 150, cachedInput: 100, output: 4 },
    );
  });

  test('is null for anything that is not a usage report', () => {
    assert.equal(readAnthropicUsage(undefined), null);
    assert.equal(readAnthropicUsage({ output_tokens: 5 }), null);
    assert.equal(readAnthropicUsage({ input_tokens: -1, output_tokens: 5 }), null);
    assert.equal(readAnthropicUsage({ prompt_tokens: 10, completion_tokens: 5 }), null);
  });
});

describe('Anthropic error types', () => {
  test('follow the status the way the Anthropic API does', () => {
    assert.equal(anthropicErrorType(400, 'invalid_request_error'), 'invalid_request_error');
    assert.equal(anthropicErrorType(401, 'invalid_request_error'), 'authentication_error');
    assert.equal(anthropicErrorType(413, 'invalid_request_error'), 'request_too_large');
    assert.equal(anthropicErrorType(429, 'rate_limit_error'), 'rate_limit_error');
    assert.equal(anthropicErrorType(504, 'server_error'), 'timeout_error');
    assert.equal(anthropicErrorType(529, 'server_error'), 'overloaded_error');
    assert.equal(anthropicErrorType(502, 'server_error'), 'api_error');
    assert.equal(anthropicErrorType(422, 'invalid_request_error'), 'invalid_request_error');
  });

  test('only the Messages endpoint and the paths below it answer in the Anthropic shape', () => {
    assert.equal(errorWriterFor('/v1/messages').name, 'sendAnthropicError');
    assert.equal(errorWriterFor('/v1/messages/count_tokens').name, 'sendAnthropicError');
    assert.equal(errorWriterFor('/v1/messagesx').name, 'sendError');
    assert.equal(errorWriterFor('/v1/chat/completions').name, 'sendError');
  });
});

describe('select for the Messages API', () => {
  const routing: RoutingSettings = { policy: 'cheapest', on_no_candidate: 'fail', equivalence_groups: [] };
  const registry = {
    enabled: [
      { id: 'anthropic', wireFormat: 'anthropic' },
      { id: 'openrouter', wireFormat: 'openai' },
    ] as const,
  };

  test('an OpenAI-format entry is excluded as untranslatable:<code> when a feature would be lost', () => {
    const body = { ...request('router-only'), top_k: 5 };
    const selection = select({
      inspection: inspect('anthropic', body),
      catalog: CATALOG,
      registry,
      health: { providers: [] },
      routing,
      untranslatable: (target) => untranslatable(body, target),
    });
    assert.equal(selection.decision, 'fail');
    assert.deepEqual(selection.trace.excluded, [
      { provider: 'openrouter', model: 'vendor/router-only', reason: 'untranslatable:anthropic_top_k' },
    ]);
  });
});

// ---------------------------------------------------------------- the route

describe('POST /v1/messages', () => {
  let proxy: Proxy;
  before(async () => {
    proxy = await startProxy();
  });
  after(async () => {
    await proxy.close();
  });
  afterEach(() => {
    for (const mock of [proxy.openai, proxy.openrouter, proxy.anthropic]) mock.requests.length = 0;
    proxy.results.length = 0;
  });

  test('routes to the cheaper entry of the same canonical model, rewriting only the model', async () => {
    const body = request('claude-x-20260901', {
      system: 'Be brief.',
      temperature: 0.25,
      metadata: { user_id: 'u-1' },
      unknown_field: { kept: [1, 2] },
    });
    const res = await messages(proxy, body, { 'x-api-key': FAKE_CLIENT_KEY, 'user-agent': 'test-sdk/1' });

    assert.equal(res.status, 200);
    assert.equal(res.headers['x-tollwise-provider'], 'anthropic');
    assert.equal(res.headers['x-tollwise-model'], 'claude-x');
    assert.equal(res.headers['x-tollwise-policy'], 'cheapest');
    assert.equal(res.headers['x-tollwise-routed'], 'true');
    assertRequestId(res);

    const [sent] = postCalls(proxy.anthropic);
    assert.ok(sent !== undefined);
    assert.equal(sent.path, '/v1/messages');
    assert.deepEqual(sent.body, { ...body, model: 'claude-x' });
    // The provider gets its own key, never the client's, and no x-tollwise-* header.
    assert.equal(sent.headers['x-api-key'], FAKE_ANTHROPIC_KEY);
    assert.equal(sent.headers.authorization, undefined);
    assert.equal(sent.headers['user-agent'], 'test-sdk/1');
    assert.deepEqual(
      Object.keys(sent.headers).filter((name) => name.startsWith('x-tollwise')),
      [],
    );
    assert.equal(res.headers['x-tollwise-translated'], 'false');
    assert.equal(postCalls(proxy.openrouter).length, 0);

    // The provider's body comes back as it was sent.
    const message = res.json as { type: string; model: string; content: { type: string; text: string }[] };
    assert.equal(message.type, 'message');
    assert.equal(message.model, 'claude-x');
    assert.deepEqual(message.content, [{ type: 'text', text: 'Mock response from the mock provider.' }]);
    assert.equal(res.headers['content-length'], String(Buffer.byteLength(res.text)));
  });

  test('reports the usage of the answer', async () => {
    const res = await messages(proxy, request('claude-x'));
    assert.equal(res.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(proxy.results.length, 1);
    const [result] = proxy.results;
    assert.deepEqual(
      { ...result, requestId: undefined, attempts: undefined },
      {
        requestId: undefined,
        provider: 'anthropic',
        model: 'claude-x',
        stream: false,
        translated: false,
        status: 200,
        outcome: 'complete',
        usage: { input: 10, cachedInput: null, output: 5 },
        attempts: undefined,
      },
    );
    assert.deepEqual(
      result?.attempts.map(({ duration_ms: _, ...attempt }) => attempt),
      [{ provider: 'anthropic', model: 'claude-x', outcome: 'ok', status: 200, substitution: null }],
    );
    assert.equal(result?.requestId, res.headers['x-tollwise-request-id']);
  });

  test('forwards anthropic-beta, and anthropic-version as the adapter pins it', async () => {
    const res = await messages(proxy, request('claude-x'), {
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31,token-efficient-tools-2025-02-19',
    });
    assert.equal(res.status, 200);
    const [sent] = postCalls(proxy.anthropic);
    assert.equal(sent?.headers['anthropic-beta'], 'prompt-caching-2024-07-31,token-efficient-tools-2025-02-19');
    assert.equal(sent?.headers['anthropic-version'], ANTHROPIC_VERSION);
  });

  test('a request without anthropic-version is a 400 and no provider is called', async () => {
    const res = await send(proxy.url, '/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request('claude-x')),
    });
    const message = assertAnthropicError(res, 400, 'invalid_request_error');
    assert.equal(message, MISSING_VERSION_MESSAGE);
    assert.match(message, /anthropic-version header is required/);
    assertRequestId(res);

    const blank = await messages(proxy, request('claude-x'), { 'anthropic-version': '  ' });
    assert.equal(assertAnthropicError(blank, 400, 'invalid_request_error'), MISSING_VERSION_MESSAGE);
    assertNoUpstreamCall(proxy);
  });

  test('sends the body byte for byte when the model id does not change', async () => {
    const raw =
      '{"model" : "unlisted-model", "max_tokens": 64,  "messages":[{"role":"user","content":"hi"}], "top_k": 7}';
    const res = await messages(proxy, raw);
    assert.equal(res.status, 200);
    const [sent] = postCalls(proxy.anthropic);
    assert.deepEqual(sent?.body, JSON.parse(raw));
    assert.equal(sent?.headers['content-length'], String(Buffer.byteLength(raw)));
  });

  test('a model not in the catalog passes through unchanged to Anthropic', async () => {
    const res = await messages(proxy, request('unlisted-model'));
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-tollwise-provider'], 'anthropic');
    assert.equal(res.headers['x-tollwise-model'], 'unlisted-model');
    assert.equal(res.headers['x-tollwise-routed'], 'false');
    assert.equal(sentModel(proxy.anthropic), 'unlisted-model');
    assert.equal(postCalls(proxy.openai).length, 0);
  });

  test('a passthrough to an OpenAI-format provider that cannot be translated is refused with 422', async () => {
    const res = await messages(
      proxy,
      { ...request('unlisted-model'), top_k: 5 },
      { 'x-tollwise-provider': 'openrouter' },
    );
    const message = assertAnthropicError(res, 422, 'invalid_request_error');
    assert.match(
      message,
      /openrouter, which speaks the OpenAI Chat Completions format; the request uses features that cannot be translated to it: anthropic_top_k\./,
    );
    assert.equal(res.headers['x-tollwise-routed'], 'false');
    assertRequestId(res);
    assertNoUpstreamCall(proxy);
  });

  test('x-tollwise-provider naming an OpenAI-format provider leaves no candidate for a catalog model', async () => {
    const res = await messages(proxy, { ...request('claude-x'), top_k: 5 }, { 'x-tollwise-provider': 'openrouter' });
    // routing.on_no_candidate defaults to passthrough: the request goes to the named provider, which
    // cannot take this request in its format.
    assert.match(
      assertAnthropicError(res, 422, 'invalid_request_error'),
      /speaks the OpenAI Chat Completions format; the request uses features that cannot be translated to it: anthropic_top_k/,
    );
    assertNoUpstreamCall(proxy);
  });

  test('x-tollwise-policy is applied and reported', async () => {
    const res = await messages(proxy, request('claude-x'), { 'x-tollwise-policy': 'balanced' });
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-tollwise-policy'], 'balanced');
  });

  const capabilityRequests: [string, Record<string, unknown>][] = [
    ['tools', { tools: [{ name: 'lookup', input_schema: { type: 'object', properties: {} } }] }],
    ['json_mode', { response_format: { type: 'json_object' } }],
    [
      'vision',
      {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What is this?' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
            ],
          },
        ],
      },
    ],
  ];
  for (const [capability, extra] of capabilityRequests) {
    test(`a ${capability} request is never sent to the cheaper entry lacking ${capability}`, async () => {
      const res = await messages(proxy, request('claude-lite', extra));
      assert.equal(res.status, 200);
      assert.equal(res.headers['x-tollwise-provider'], 'anthropic');
      assert.equal(res.headers['x-tollwise-model'], 'claude-lite-full');
      assert.equal(sentModel(proxy.anthropic), 'claude-lite-full');
    });
  }

  test('the same model without those capabilities goes to the cheaper entry', async () => {
    const res = await messages(proxy, request('claude-lite'));
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-tollwise-model'], 'claude-lite');
    assert.equal(sentModel(proxy.anthropic), 'claude-lite');
  });

  test('a stream request is relayed byte for byte, with the Tollwise headers', async () => {
    const res = await messages(proxy, request('claude-x', { stream: true }));
    assert.equal(res.status, 200);
    assert.match(String(res.headers['content-type']), /^text\/event-stream/);
    assert.equal(res.headers['x-tollwise-provider'], 'anthropic');
    assert.equal(res.headers['x-tollwise-model'], 'claude-x');
    assert.equal(res.text, proxy.anthropic.streams.at(-1)?.text);
    assert.match(res.text, /event: message_stop/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(proxy.results[0]?.stream, true);
    assert.equal(proxy.results[0]?.outcome, 'complete');
  });

  test('invalid JSON is a 400 and no provider is called', async () => {
    const res = await messages(proxy, '{"model": "claude-x", ');
    assert.equal(assertAnthropicError(res, 400, 'invalid_request_error'), 'The request body is not valid JSON.');
    assertRequestId(res);
    assertNoUpstreamCall(proxy);
  });

  test('an empty body, a non-object body and a body without a model are 400', async () => {
    assertAnthropicError(await messages(proxy, ''), 400, 'invalid_request_error');
    assert.match(assertAnthropicError(await messages(proxy, '[1, 2]'), 400, 'invalid_request_error'), /JSON object/);
    assert.match(
      assertAnthropicError(await messages(proxy, { max_tokens: 5, messages: HELLO }), 400, 'invalid_request_error'),
      /"model"/,
    );
    assertNoUpstreamCall(proxy);
  });

  test('bad override headers are 400 and never echo the value sent', async () => {
    const badPolicy = await messages(proxy, request('claude-x'), { 'x-tollwise-policy': 'cheapest-ish' });
    assert.equal(
      assertAnthropicError(badPolicy, 400, 'invalid_request_error'),
      'The x-tollwise-policy header must be one of: cheapest, fastest, balanced, pinned.',
    );
    const badProvider = await messages(proxy, request('claude-x'), { 'x-tollwise-provider': 'bedrock' });
    assert.equal(
      assertAnthropicError(badProvider, 400, 'invalid_request_error'),
      'The x-tollwise-provider header must be one of: anthropic, openai, deepseek, openrouter, ollama.',
    );
    assert.ok(!badProvider.text.includes('bedrock'));
    assertNoUpstreamCall(proxy);
  });

  test('a body above max_body_size sent in chunks is a 413 in the Anthropic shape', async () => {
    const address = new URL(proxy.url);
    const res = await new Promise<TestResponse>((resolve, reject) => {
      const req = httpRequest(
        { host: address.hostname, port: address.port, method: 'POST', path: '/v1/messages', headers: MESSAGES_HEADERS },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            resolve({ status: response.statusCode ?? 0, headers: response.headers, text, json: JSON.parse(text) });
          });
        },
      );
      req.on('error', reject);
      req.write(`{"model":"claude-x","max_tokens":5,"messages":[{"role":"user","content":"${'a'.repeat(40 * 1024)}`);
      req.write(`${'b'.repeat(40 * 1024)}"}]}`);
      req.end();
    });
    assert.match(assertAnthropicError(res, 413, 'request_too_large'), /larger than the 65536-byte limit/);
    assertNoUpstreamCall(proxy);
  });

  test('a path below /v1/messages that Tollwise does not serve is a 404 in the Anthropic shape', async () => {
    const res = await send(proxy.url, '/v1/messages/count_tokens', {
      method: 'POST',
      headers: MESSAGES_HEADERS,
      body: JSON.stringify(request('claude-x')),
    });
    assert.match(assertAnthropicError(res, 404, 'not_found_error'), /not a Tollwise endpoint/);
    const wrongMethod = await send(proxy.url, '/v1/messages', { headers: MESSAGES_HEADERS });
    assert.match(assertAnthropicError(wrongMethod, 405, 'invalid_request_error'), /Allowed: POST/);
  });

  test('the log carries no body, header or key', async () => {
    proxy.log.length = 0;
    await messages(proxy, request('claude-x', { messages: [{ role: 'user', content: 'private words' }] }), {
      'x-api-key': FAKE_CLIENT_KEY,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const output = proxy.log.join('');
    assert.match(output, /messages request routed/);
    for (const forbidden of ['private words', FAKE_ANTHROPIC_KEY, FAKE_CLIENT_KEY, 'x-api-key', '2023-06-01']) {
      assert.ok(!output.includes(forbidden), `log must not contain ${forbidden}`);
    }
  });
});

describe('POST /v1/messages in fail mode', () => {
  let proxy: Proxy;
  before(async () => {
    proxy = await startProxy({ routing: { on_no_candidate: 'fail' } });
  });
  after(async () => {
    await proxy.close();
  });

  test('a missing capability is a 422 naming it, and nothing is sent', async () => {
    const res = await messages(
      proxy,
      request('blind-claude', {
        messages: [
          {
            role: 'user',
            content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/cat.png' } }],
          },
        ],
      }),
    );
    const message = assertAnthropicError(res, 422, 'invalid_request_error');
    assert.match(message, /missing capability: vision \(anthropic\/blind-claude\)/);
    assert.equal(res.headers['x-tollwise-routed'], 'false');
    assert.equal(res.headers['x-tollwise-policy'], 'cheapest');
    assertRequestId(res);
    assertNoUpstreamCall(proxy);
  });

  test('a model served only in the OpenAI format, with a feature that cannot be translated, is a 422 that says so', async () => {
    const res = await messages(proxy, { ...request('router-only'), top_k: 5 });
    const message = assertAnthropicError(res, 422, 'invalid_request_error');
    assert.match(
      message,
      /provider speaks another API format, and the request uses a feature that cannot be translated to it: anthropic_top_k \(openrouter\/vendor\/router-only\)/,
    );
    assertNoUpstreamCall(proxy);
  });

  test('a model not in the catalog is a 422', async () => {
    const res = await messages(proxy, request('unlisted-model'));
    assert.match(
      assertAnthropicError(res, 422, 'invalid_request_error'),
      /"unlisted-model" is not in the Tollwise catalog/,
    );
    assertNoUpstreamCall(proxy);
  });
});

describe('POST /v1/messages with provider errors', () => {
  test('a provider error that is not retried comes back with its status, in the Anthropic error shape', async () => {
    const proxy = await startProxy({
      anthropic: {
        responses: [
          { failWith: { status: 400, type: 'invalid_request_error', message: 'max_tokens: field required' } },
          { failWith: { status: 403, type: 'permission_error', message: 'Not allowed' } },
          { failWith: { status: 422, type: 'invalid_request_error', message: 'unprocessable' } },
        ],
      },
    });
    try {
      const rejected = await messages(proxy, request('claude-x'));
      assert.equal(
        assertAnthropicError(rejected, 400, 'invalid_request_error'),
        'The anthropic provider answered with HTTP 400: max_tokens: field required',
      );
      assert.equal(rejected.headers['x-tollwise-provider'], 'anthropic');
      assert.equal(rejected.headers['x-tollwise-model'], 'claude-x');
      assert.equal(rejected.headers['x-tollwise-routed'], 'true');
      assert.equal(rejected.headers['x-tollwise-attempts'], '1');
      assertRequestId(rejected);

      const forbidden = await messages(proxy, request('claude-x'));
      assert.match(assertAnthropicError(forbidden, 403, 'permission_error'), /HTTP 403: Not allowed/);

      const unprocessable = await messages(proxy, request('claude-x'));
      assert.match(assertAnthropicError(unprocessable, 422, 'invalid_request_error'), /HTTP 422: unprocessable/);

      // None of them is retried: the dearer dated entry is never tried.
      assert.equal(postCalls(proxy.anthropic).length, 3);
      assert.equal(postCalls(proxy.openrouter).length, 0);
      assert.deepEqual(
        proxy.results.map((result) => [result.status, result.outcome, result.attempts.length, result.usage]),
        [
          [400, 'provider_error', 1, null],
          [403, 'provider_error', 1, null],
          [422, 'provider_error', 1, null],
        ],
      );
    } finally {
      await proxy.close();
    }
  });

  test('a retryable error moves to the next Anthropic candidate; when every one fails the answer is a 502', async () => {
    const proxy = await startProxy({
      anthropic: {
        responses: [
          { failWith: { status: 500, type: 'api_error', message: 'upstream exploded' } },
          {},
          {
            failWith: { status: 429, type: 'rate_limit_error', message: 'Number of requests has exceeded your limit' },
          },
          { failWith: { status: 529, type: 'overloaded_error', message: 'Overloaded' } },
        ],
      },
    });
    try {
      const served = await messages(proxy, request('claude-x'));
      assert.equal(served.status, 200);
      assert.equal(served.headers['x-tollwise-provider'], 'anthropic');
      assert.equal(served.headers['x-tollwise-model'], 'claude-x-20260901');
      assert.equal(served.headers['x-tollwise-attempts'], '2');
      assert.deepEqual(
        postCalls(proxy.anthropic).map((call) => (call.body as { model: string }).model),
        ['claude-x', 'claude-x-20260901'],
      );

      const failed = await messages(proxy, request('claude-x'));
      assert.equal(
        assertAnthropicError(failed, 502, 'api_error'),
        'Tollwise tried 2 providers and every attempt failed: anthropic model claude-x (rate_limit, HTTP 429), ' +
          'anthropic model claude-x-20260901 (overloaded, HTTP 529).',
      );
      assert.equal(failed.headers['x-tollwise-attempts'], '2');
      // The provider's own messages never reach the client in the aggregate error.
      assert.ok(!failed.text.includes('Number of requests'));
      assert.ok(!failed.text.includes('Overloaded'));
      assert.equal(postCalls(proxy.openrouter).length, 0);
    } finally {
      await proxy.close();
    }
  });

  test('an unreachable provider is a 502 naming the error kind of every attempt', async () => {
    const closedPort = await freePort();
    const proxy = await startProxy({ anthropicBaseUrl: `http://127.0.0.1:${closedPort}` });
    try {
      const res = await messages(proxy, request('claude-x'));
      assert.equal(
        assertAnthropicError(res, 502, 'api_error'),
        'Tollwise tried 2 providers and every attempt failed: anthropic model claude-x (connection), ' +
          'anthropic model claude-x-20260901 (connection).',
      );
    } finally {
      await proxy.close();
    }
  });

  test('a provider that does not answer in time is a 502 naming the timeout', async () => {
    const proxy = await startProxy({
      anthropic: { hang: true },
      routing: { retries: 0, timeouts: { connect_ms: 1000, first_byte_ms: 200, total_ms: 1000 } },
    });
    try {
      const res = await messages(proxy, request('claude-x'));
      assert.equal(
        assertAnthropicError(res, 502, 'api_error'),
        'Tollwise tried 1 provider and every attempt failed: anthropic model claude-x (timeout).',
      );
    } finally {
      await proxy.close();
    }
  });

  test('a passthrough to Anthropic when it is not configured is a 422', async () => {
    const proxy = await startProxy({ anthropicDisabled: true });
    try {
      const res = await messages(proxy, request('unlisted-model'));
      assert.match(assertAnthropicError(res, 422, 'invalid_request_error'), /to anthropic, which is not configured/);
      assertNoUpstreamCall(proxy);
    } finally {
      await proxy.close();
    }
  });
});

describe('POST /v1/messages behind the access key and the request guard', () => {
  let proxy: Proxy;
  before(async () => {
    proxy = await startProxy({ accessKey: FAKE_ACCESS_KEY });
  });
  after(async () => {
    await proxy.close();
  });

  test('without the access key the request is a 401 in the Anthropic shape and never reaches a provider', async () => {
    const res = await messages(proxy, request('claude-x'));
    assert.match(assertAnthropicError(res, 401, 'authentication_error'), /TOLLWISE_ACCESS_KEY/);
    const wrong = await messages(proxy, request('claude-x'), { 'x-api-key': FAKE_CLIENT_KEY });
    assertAnthropicError(wrong, 401, 'authentication_error');
    assertNoUpstreamCall(proxy);
  });

  test('a foreign Origin is a 403 and a non-JSON POST a 415, before any provider call', async () => {
    const foreign = await messages(proxy, request('claude-x'), {
      'x-api-key': FAKE_ACCESS_KEY,
      origin: 'http://evil.example',
    });
    assertAnthropicError(foreign, 403, 'permission_error');
    const plain = await send(proxy.url, '/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': FAKE_ACCESS_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'text/plain' },
      body: JSON.stringify(request('claude-x')),
    });
    assertAnthropicError(plain, 415, 'invalid_request_error');
    assertNoUpstreamCall(proxy);
  });

  test('with the access key in x-api-key the request is routed, and the key is not forwarded', async () => {
    const res = await messages(proxy, request('claude-x'), { 'x-api-key': FAKE_ACCESS_KEY });
    assert.equal(res.status, 200);
    const [sent] = postCalls(proxy.anthropic);
    assert.equal(sent?.headers['x-api-key'], FAKE_ANTHROPIC_KEY);
    assert.ok(!JSON.stringify(sent?.headers).includes(FAKE_ACCESS_KEY));
  });
});

describe('POST /v1/messages without a proxy configuration', () => {
  test('answers 503 in the Anthropic shape', async () => {
    const server = createTollwiseServer({ maxBodyBytes: 1024, logger: createLogger({ sink: captureLog() }) });
    const address = await listen(server, '127.0.0.1', 0);
    try {
      const res = await send(baseUrl('127.0.0.1', address.port), '/v1/messages', {
        method: 'POST',
        headers: MESSAGES_HEADERS,
        body: '{}',
      });
      assert.match(assertAnthropicError(res, 503, 'api_error'), /no provider configuration loaded/);
    } finally {
      await stopServer(server, 100);
    }
  });
});

describe('POST /v1/messages response handling', () => {
  test('provider headers pass through, but not its x-tollwise-* or cookie headers', async () => {
    const payload = JSON.stringify({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'unlisted-model',
      content: [],
      usage: { input_tokens: 3, cache_read_input_tokens: 40, output_tokens: 2 },
    });
    const fake = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, {
          'content-type': 'application/json',
          'request-id': 'req_provider_1',
          'anthropic-ratelimit-requests-remaining': '49',
          'x-tollwise-provider': 'spoofed',
          'set-cookie': 'session=abc',
        });
        res.end(payload);
      });
    });
    const port = (await listen(fake, '127.0.0.1', 0)).port;
    const proxy = await startProxy({ anthropicBaseUrl: `http://127.0.0.1:${port}` });
    try {
      const res = await messages(proxy, request('unlisted-model'));
      assert.equal(res.status, 200);
      assert.equal(res.text, payload);
      assert.equal(res.headers['request-id'], 'req_provider_1');
      assert.equal(res.headers['anthropic-ratelimit-requests-remaining'], '49');
      assert.equal(res.headers['x-tollwise-provider'], 'anthropic');
      assert.equal(res.headers['set-cookie'], undefined);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(proxy.results[0]?.usage, { input: 43, cachedInput: 40, output: 2 });
    } finally {
      await proxy.close();
      await stopServer(fake, 100);
    }
  });

  test('a client that goes away aborts the provider call', async () => {
    const proxy = await startProxy({ anthropic: { latencyMs: 1000 } });
    try {
      const address = new URL(proxy.url);
      const req = httpRequest({
        host: address.hostname,
        port: address.port,
        method: 'POST',
        path: '/v1/messages',
        headers: MESSAGES_HEADERS,
      });
      req.on('error', () => {});
      req.end(JSON.stringify(request('claude-x')));
      const deadline = performance.now() + 1000;
      while (proxy.anthropic.requests.length === 0 && performance.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(proxy.anthropic.requests.length, 1);
      const started = performance.now();
      req.destroy();
      await proxy.anthropic.waitForDisconnect(0);
      assert.ok(performance.now() - started < 500, 'the provider connection closed well before its answer');
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(proxy.results[0]?.outcome, 'client_aborted');
    } finally {
      await proxy.close();
    }
  });
});
