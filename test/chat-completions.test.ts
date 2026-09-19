import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import type { Catalog, ModelEntry } from '../src/catalog/schema.ts';
import { type Config, type ConfigInput, ConfigSchema, type ProviderId } from '../src/config/schema.ts';
import { createLogger, type LogSink } from '../src/log/logger.ts';
import { clearSecretValues } from '../src/log/redact.ts';
import { buildRegistry } from '../src/providers/registry.ts';
import { modelHeaderValue, readOverrides, replaceModelField } from '../src/proxy/forward.ts';
import { inspect } from '../src/routing/inspect.ts';
import { type RoutingSettings, select } from '../src/routing/select.ts';
import { baseUrl, createTollwiseServer, listen, stopServer } from '../src/server/server.ts';
import { type SignalSource, startTollwise } from '../src/server/start.ts';
import { untranslatable } from '../src/translate/index.ts';
import { freePort, send, type TestResponse } from './fixtures/http-client.ts';
import { type MockProvider, type StartMockProviderOptions, startMockProvider } from './fixtures/mock-provider.ts';

// Fake credentials with no known key shape; none of them is a real key.
const FAKE_OPENAI_KEY = `fakeOpenai${'Oa1'.repeat(6)}`;
const FAKE_OPENROUTER_KEY = `fakeRouter${'Or2'.repeat(6)}`;
const FAKE_DEEPSEEK_KEY = `fakeDeep${'Ds3'.repeat(6)}`;
const FAKE_ANTHROPIC_KEY = `fakeClaude${'An4'.repeat(6)}`;
const FAKE_ACCESS_KEY = `fakeAccess${'Ak9'.repeat(8)}`;

const ENV = {
  OPENAI_API_KEY: FAKE_OPENAI_KEY,
  OPENROUTER_API_KEY: FAKE_OPENROUTER_KEY,
  DEEPSEEK_API_KEY: FAKE_DEEPSEEK_KEY,
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
    context_window: 128_000,
    max_output: 16_000,
    capabilities,
    source_url: 'https://example.com/pricing',
    verified_on: '2026-09-01',
  };
}

/**
 * - gpt-x: served by openai (dearer) and openrouter (cheaper), both with every capability.
 * - lite-x: openrouter entry (cheap, no tools/json/vision) and openai entry (dear, all capabilities).
 * - claude-x: anthropic (cheapest, Anthropic format) and openrouter (OpenAI format).
 * - claude-only: anthropic only.
 * - blind-x: openai only, no vision.
 */
const CATALOG: Catalog = {
  models: [
    entry('openai', 'gpt-x', 'gpt-x', 10, 50),
    entry('openrouter', 'openai/gpt-x', 'gpt-x', 5, 25),
    entry('openai', 'lite-x', 'lite-x', 4, 16),
    entry('openrouter', 'vendor/lite-x', 'lite-x', 0.1, 0.4, NO_CAPS),
    entry('anthropic', 'claude-x', 'claude-x', 1, 5),
    entry('openrouter', 'anthropic/claude-x', 'claude-x', 3, 15),
    entry('anthropic', 'claude-only', 'claude-only', 1, 5),
    entry('openai', 'blind-x', 'blind-x', 1, 2, { ...ALL_CAPS, vision: false }),
  ],
};

const JSON_TYPE = { 'content-type': 'application/json' } as const;

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
  close(): Promise<void>;
}

interface ProxyOptions {
  readonly routing?: ConfigInput['routing'];
  readonly accessKey?: string;
  readonly openai?: StartMockProviderOptions;
  readonly openrouter?: StartMockProviderOptions;
  /** Base URL for openai instead of its mock (e.g. a closed port). */
  readonly openaiBaseUrl?: string;
  /** Leave openai disabled. */
  readonly openaiDisabled?: boolean;
}

async function startProxy(options: ProxyOptions = {}): Promise<Proxy> {
  const openai = await startMockProvider(options.openai ?? {});
  const openrouter = await startMockProvider(options.openrouter ?? {});
  const anthropic = await startMockProvider({});
  const config: Config = ConfigSchema.parse({
    providers: {
      openai: {
        enabled: options.openaiDisabled !== true,
        base_url: options.openaiBaseUrl ?? `${openai.url}/v1`,
      },
      openrouter: { base_url: `${openrouter.url}/v1` },
      anthropic: { base_url: anthropic.url },
      deepseek: { enabled: false },
      ollama: { enabled: false },
    },
    routing: options.routing ?? {},
  } satisfies ConfigInput);
  const registry = buildRegistry(config, ENV);
  const log = captureLog();
  const server: Server = createTollwiseServer({
    maxBodyBytes: 64 * 1024,
    logger: createLogger({ level: 'debug', sink: log }),
    accessKey: options.accessKey,
    proxy: { config, catalog: CATALOG, registry, env: ENV },
  });
  const address = await listen(server, '127.0.0.1', 0);
  return {
    url: baseUrl('127.0.0.1', address.port),
    openai,
    openrouter,
    anthropic,
    log: log.lines,
    async close() {
      await stopServer(server, 100);
      await Promise.all([openai.close(), openrouter.close(), anthropic.close()]);
    },
  };
}

function chat(proxy: Proxy, body: unknown, headers: Readonly<Record<string, string>> = {}): Promise<TestResponse> {
  return send(proxy.url, '/v1/chat/completions', {
    method: 'POST',
    headers: { ...JSON_TYPE, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const HELLO = [{ role: 'user', content: 'Say hello.' }];

function chatCalls(mock: MockProvider) {
  return mock.requests.filter((request) => request.method === 'POST');
}

/** The model field of the first chat request a mock received. */
function sentModel(mock: MockProvider): unknown {
  const body = chatCalls(mock)[0]?.body as { model?: unknown } | undefined;
  return body?.model;
}

function assertOpenAiError(res: TestResponse, status: number, code: string): string {
  assert.equal(res.status, status);
  const body = res.json as { error?: { message?: unknown; type?: unknown; param?: unknown; code?: unknown } };
  assert.ok(body.error !== undefined, 'OpenAI error object present');
  assert.equal(typeof body.error.message, 'string');
  assert.equal(typeof body.error.type, 'string');
  assert.equal(body.error.param, null);
  assert.equal(body.error.code, code);
  assert.match(String(res.headers['x-tollwise-request-id']), /^[0-9a-f-]{36}$/);
  return body.error.message as string;
}

function assertNoUpstreamCall(proxy: Proxy): void {
  assert.equal(chatCalls(proxy.openai).length, 0);
  assert.equal(chatCalls(proxy.openrouter).length, 0);
  assert.equal(chatCalls(proxy.anthropic).length, 0);
}

// ---------------------------------------------------------------- helpers

describe('replaceModelField', () => {
  test('changes only the model value and keeps every other byte', () => {
    const text = '{ "seed" : 12345678901234567890,\n"model":"gpt-x" ,"messages":[{"content":"a \\"model\\": b"}]}';
    assert.equal(
      replaceModelField(text, 'openai/gpt-x'),
      '{ "seed" : 12345678901234567890,\n"model":"openai/gpt-x" ,"messages":[{"content":"a \\"model\\": b"}]}',
    );
  });

  test('replaces every top-level model field, escaped key names included, and no nested one', () => {
    const text = '{"model":"a","metadata":{"model":"keep"},"\\u006dodel":"b"}';
    assert.equal(replaceModelField(text, 'z'), '{"model":"z","metadata":{"model":"keep"},"\\u006dodel":"z"}');
    assert.deepEqual(JSON.parse(replaceModelField(text, 'z')), { model: 'z', metadata: { model: 'keep' } });
  });

  test('escapes the new model id as a JSON string', () => {
    assert.equal(replaceModelField('{"model":1}', 'a"b\\c'), '{"model":"a\\"b\\\\c"}');
  });

  test('refuses a text that is not a JSON object', () => {
    assert.throws(() => replaceModelField('[1]', 'x'), SyntaxError);
  });
});

describe('modelHeaderValue', () => {
  test('keeps printable ASCII and percent-encodes anything else', () => {
    assert.equal(modelHeaderValue('openai/gpt-x'), 'openai/gpt-x');
    assert.equal(modelHeaderValue('m\r\nx-injected: 1'), 'm%0D%0Ax-injected%3A%201');
    assert.equal(modelHeaderValue('modèle'), 'mod%C3%A8le');
  });
});

describe('readOverrides', () => {
  test('reads a policy and a provider in any letter case, trimmed', () => {
    const read = readOverrides({ 'x-tollwise-policy': ' Fastest ', 'x-tollwise-provider': 'OpenRouter' }, {});
    assert.deepEqual(read, { overrides: { policy: 'fastest', provider: 'openrouter' } });
  });

  test('no header means no override', () => {
    assert.deepEqual(readOverrides({}, {}), { overrides: { policy: undefined, provider: undefined } });
  });

  test('refuses an unknown value, a repeated header and pinned without a pinned target', () => {
    for (const headers of [
      { 'x-tollwise-policy': 'cheap' },
      { 'x-tollwise-policy': '' },
      { 'x-tollwise-policy': ['cheapest', 'fastest'] },
      { 'x-tollwise-policy': 'pinned' },
      { 'x-tollwise-provider': 'azure' },
    ]) {
      const read = readOverrides(headers, {});
      assert.ok('refusal' in read, JSON.stringify(headers));
      assert.equal(read.refusal.status, 400);
    }
    const pinned = readOverrides({ 'x-tollwise-policy': 'pinned' }, { pinned: { provider: 'openai', model: 'gpt-x' } });
    assert.deepEqual(pinned, { overrides: { policy: 'pinned', provider: undefined } });
  });
});

describe('select across wire formats', () => {
  const routing: RoutingSettings = { policy: 'cheapest', on_no_candidate: 'fail', equivalence_groups: [] };
  const registry = {
    enabled: [
      { id: 'anthropic', wireFormat: 'anthropic' },
      { id: 'openrouter', wireFormat: 'openai' },
    ] as const,
  };

  test('an entry of the other wire format is excluded as untranslatable:<code> when a feature would be lost', () => {
    const body = { model: 'claude-x', messages: HELLO, seed: 7 };
    const asked: string[] = [];
    const selection = select({
      inspection: inspect('openai', body),
      catalog: CATALOG,
      registry,
      health: { providers: [] },
      routing,
      untranslatable: (target) => {
        asked.push(target);
        return untranslatable(body, target);
      },
    });
    assert.equal(selection.decision, 'routed');
    assert.deepEqual(
      selection.candidates.map((candidate) => `${candidate.provider}/${candidate.model}`),
      ['openrouter/anthropic/claude-x'],
    );
    assert.deepEqual(selection.trace.excluded, [
      { provider: 'anthropic', model: 'claude-x', reason: 'untranslatable:openai_seed' },
    ]);
    assert.deepEqual(asked, ['anthropic']);
  });

  test('an entry of the other wire format stays a candidate when the request translates faithfully', () => {
    const body = { model: 'claude-x', messages: HELLO, max_tokens: 50 };
    const selection = select({
      inspection: inspect('openai', body),
      catalog: CATALOG,
      registry,
      health: { providers: [] },
      routing,
      untranslatable: (target) => untranslatable(body, target),
    });
    assert.deepEqual(
      selection.candidates.map((candidate) => candidate.provider),
      ['anthropic', 'openrouter'],
    );
    assert.deepEqual(selection.trace.excluded, []);
  });

  test('when no candidate is left, the failure names the untranslatable feature', () => {
    const body = { model: 'claude-x', messages: HELLO, max_tokens: 50, logprobs: true };
    const selection = select({
      inspection: inspect('openai', body),
      catalog: CATALOG,
      registry: { enabled: [{ id: 'anthropic', wireFormat: 'anthropic' }] },
      health: { providers: [] },
      routing,
      untranslatable: (target) => untranslatable(body, target),
    });
    assert.equal(selection.decision, 'fail');
    assert.equal(
      selection.decision === 'fail' ? selection.message : '',
      'no provider can serve model "claude-x" for this request: provider speaks another API format, and the ' +
        'request uses a feature that cannot be translated to it: openai_logprobs (anthropic/claude-x); ' +
        'provider not configured (disabled or its key is not set) (openrouter/anthropic/claude-x)',
    );
  });

  test('without an untranslatable check every format stays a candidate', () => {
    const selection = select({
      inspection: inspect('openai', { model: 'claude-x', messages: HELLO }),
      catalog: CATALOG,
      registry,
      health: { providers: [] },
      routing,
    });
    assert.equal(selection.candidates[0]?.provider, 'anthropic');
  });
});

// ---------------------------------------------------------------- the route

describe('POST /v1/chat/completions', () => {
  let proxy: Proxy;
  before(async () => {
    proxy = await startProxy();
  });
  after(async () => {
    await proxy.close();
  });
  afterEach(() => {
    for (const mock of [proxy.openai, proxy.openrouter, proxy.anthropic]) mock.requests.length = 0;
  });

  test('routes to the cheaper provider of the same canonical model, rewriting only the model', async () => {
    const request = {
      model: 'gpt-x',
      messages: HELLO,
      temperature: 0.25,
      user: 'u-1',
      unknown_field: { kept: [1, 2] },
    };
    const res = await chat(proxy, request, { authorization: `Bearer ${FAKE_ACCESS_KEY}`, 'user-agent': 'test-sdk/1' });

    assert.equal(res.status, 200);
    assert.equal(res.headers['x-tollwise-provider'], 'openrouter');
    assert.equal(res.headers['x-tollwise-model'], 'openai/gpt-x');
    assert.equal(res.headers['x-tollwise-policy'], 'cheapest');
    assert.equal(res.headers['x-tollwise-routed'], 'true');
    assert.match(String(res.headers['x-tollwise-request-id']), /^[0-9a-f-]{36}$/);

    assert.equal(chatCalls(proxy.openai).length, 0);
    const [sent] = chatCalls(proxy.openrouter);
    assert.ok(sent !== undefined);
    assert.equal(sent.path, '/v1/chat/completions');
    assert.deepEqual(sent.body, { ...request, model: 'openai/gpt-x' });
    // The provider gets its own key, never the client's credential, and no x-tollwise-* header.
    assert.equal(sent.headers.authorization, `Bearer ${FAKE_OPENROUTER_KEY}`);
    assert.equal(sent.headers['user-agent'], 'test-sdk/1');
    assert.deepEqual(
      Object.keys(sent.headers).filter((name) => name.startsWith('x-tollwise')),
      [],
    );

    // The provider's body comes back as it was sent.
    const body = res.json as { object: string; model: string; choices: { message: { content: string } }[] };
    assert.equal(body.object, 'chat.completion');
    assert.equal(body.model, 'openai/gpt-x');
    assert.equal(body.choices[0]?.message.content, 'Mock response from the mock provider.');
    assert.equal(res.headers['content-length'], String(Buffer.byteLength(res.text)));
  });

  test('sends the body byte for byte when the model id does not change', async () => {
    const raw = '{"model" : "unlisted-model",  "messages":[{"role":"user","content":"hi"}], "seed": 7}';
    const res = await chat(proxy, raw);
    assert.equal(res.status, 200);
    const [sent] = chatCalls(proxy.openai);
    assert.deepEqual(sent?.body, JSON.parse(raw));
    assert.equal(sent?.headers['content-length'], String(Buffer.byteLength(raw)));
  });

  test('a model not in the catalog passes through unchanged to the native provider', async () => {
    const res = await chat(proxy, { model: 'unlisted-model', messages: HELLO });
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-tollwise-provider'], 'openai');
    assert.equal(res.headers['x-tollwise-model'], 'unlisted-model');
    assert.equal(res.headers['x-tollwise-routed'], 'false');
    assert.equal(chatCalls(proxy.openai).length, 1);
    assert.equal(sentModel(proxy.openai), 'unlisted-model');
    assert.equal(chatCalls(proxy.openrouter).length, 0);
  });

  test('a catalog model no provider can serve for this request passes through unchanged, never downgraded', async () => {
    const raw =
      '{"model":"blind-x","messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"data:image/png;base64,AAAA"}}]}]}';
    const res = await chat(proxy, raw);
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-tollwise-provider'], 'openai');
    assert.equal(res.headers['x-tollwise-model'], 'blind-x');
    assert.equal(res.headers['x-tollwise-routed'], 'false');
    const [sent] = chatCalls(proxy.openai);
    assert.deepEqual(sent?.body, JSON.parse(raw));
    assert.equal(chatCalls(proxy.openrouter).length, 0);
  });

  test('a passthrough honours x-tollwise-provider', async () => {
    const res = await chat(
      proxy,
      { model: 'unlisted-model', messages: HELLO },
      { 'x-tollwise-provider': 'openrouter' },
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-tollwise-provider'], 'openrouter');
    assert.equal(chatCalls(proxy.openrouter).length, 1);
  });

  test('a passthrough to an Anthropic-format provider that cannot be translated is refused with 422', async () => {
    const res = await chat(proxy, { model: 'unlisted-model', messages: HELLO }, { 'x-tollwise-provider': 'anthropic' });
    const message = assertOpenAiError(res, 422, 'format_not_supported');
    assert.match(
      message,
      /anthropic, which speaks the Anthropic Messages format; the request uses features that cannot be translated to it: max_tokens_missing\./,
    );
    assert.equal(res.headers['x-tollwise-routed'], 'false');
    assertNoUpstreamCall(proxy);
  });

  test('x-tollwise-provider restricts routing to that provider', async () => {
    const res = await chat(proxy, { model: 'gpt-x', messages: HELLO }, { 'x-tollwise-provider': 'openai' });
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-tollwise-provider'], 'openai');
    assert.equal(res.headers['x-tollwise-model'], 'gpt-x');
    assert.equal(chatCalls(proxy.openai).length, 1);
    assert.equal(chatCalls(proxy.openrouter).length, 0);
  });

  test('x-tollwise-policy is applied and reported', async () => {
    const res = await chat(proxy, { model: 'gpt-x', messages: HELLO }, { 'x-tollwise-policy': 'balanced' });
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-tollwise-policy'], 'balanced');
  });

  test('Anthropic-format candidates are skipped: the OpenAI-format entry serves the request', async () => {
    const res = await chat(proxy, { model: 'claude-x', messages: HELLO });
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-tollwise-provider'], 'openrouter');
    assert.equal(res.headers['x-tollwise-model'], 'anthropic/claude-x');
    assert.equal(chatCalls(proxy.anthropic).length, 0);
  });

  const capabilityRequests: [string, Record<string, unknown>][] = [
    [
      'tools',
      {
        tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: {} } } }],
      },
    ],
    ['json_mode', { response_format: { type: 'json_object' } }],
    [
      'vision',
      {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What is this?' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
            ],
          },
        ],
      },
    ],
  ];
  for (const [capability, extra] of capabilityRequests) {
    test(`a ${capability} request is never sent to the cheaper entry lacking ${capability}`, async () => {
      const res = await chat(proxy, { model: 'lite-x', messages: HELLO, ...extra });
      assert.equal(res.status, 200);
      assert.equal(res.headers['x-tollwise-provider'], 'openai');
      assert.equal(res.headers['x-tollwise-model'], 'lite-x');
      assert.equal(chatCalls(proxy.openrouter).length, 0);
      assert.equal(chatCalls(proxy.openai).length, 1);
    });
  }

  test('the same model without those capabilities goes to the cheaper entry', async () => {
    const res = await chat(proxy, { model: 'lite-x', messages: HELLO });
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-tollwise-provider'], 'openrouter');
    assert.equal(sentModel(proxy.openrouter), 'vendor/lite-x');
  });

  test('invalid JSON is a 400 and no provider is called', async () => {
    const res = await chat(proxy, '{"model": "gpt-x", ');
    const message = assertOpenAiError(res, 400, 'invalid_json');
    assert.equal(message, 'The request body is not valid JSON.');
    assertNoUpstreamCall(proxy);
  });

  test('an empty body, a non-object body and a body without a model are 400', async () => {
    assertOpenAiError(await chat(proxy, ''), 400, 'invalid_json');
    assert.match(assertOpenAiError(await chat(proxy, '[1, 2]'), 400, 'invalid_request'), /JSON object/);
    assert.match(assertOpenAiError(await chat(proxy, { messages: HELLO }), 400, 'invalid_request'), /"model"/);
    assertNoUpstreamCall(proxy);
  });

  test('bad override headers are 400 and never echo the value sent', async () => {
    const badPolicy = await chat(proxy, { model: 'gpt-x', messages: HELLO }, { 'x-tollwise-policy': 'cheapest-ish' });
    const policyMessage = assertOpenAiError(badPolicy, 400, 'invalid_routing_policy');
    assert.equal(policyMessage, 'The x-tollwise-policy header must be one of: cheapest, fastest, balanced, pinned.');

    const pinned = await chat(proxy, { model: 'gpt-x', messages: HELLO }, { 'x-tollwise-policy': 'pinned' });
    assert.match(assertOpenAiError(pinned, 400, 'invalid_routing_policy'), /routing\.pinned is not set/);

    const badProvider = await chat(proxy, { model: 'gpt-x', messages: HELLO }, { 'x-tollwise-provider': 'azure' });
    const providerMessage = assertOpenAiError(badProvider, 400, 'invalid_provider');
    assert.equal(
      providerMessage,
      'The x-tollwise-provider header must be one of: anthropic, openai, deepseek, openrouter, ollama.',
    );
    assert.ok(!badProvider.text.includes('azure'));
    assertNoUpstreamCall(proxy);
  });

  test('a body above max_body_size sent in chunks is a 413', async () => {
    const address = new URL(proxy.url);
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: address.hostname,
          port: address.port,
          method: 'POST',
          path: '/v1/chat/completions',
          headers: JSON_TYPE,
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.write(`{"model":"gpt-x","messages":[{"role":"user","content":"${'a'.repeat(40 * 1024)}`);
      req.write(`${'b'.repeat(40 * 1024)}"}]}`);
      req.end();
    });
    assert.equal(status, 413);
    assertNoUpstreamCall(proxy);
  });

  test('the log carries no body, header or key', async () => {
    proxy.log.length = 0;
    await chat(proxy, { model: 'gpt-x', messages: [{ role: 'user', content: 'private words' }] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const output = proxy.log.join('');
    assert.match(output, /chat request routed/);
    for (const forbidden of ['private words', FAKE_OPENROUTER_KEY, 'Bearer', 'openai/gpt-x']) {
      assert.ok(!output.includes(forbidden), `log must not contain ${forbidden}`);
    }
  });
});

describe('POST /v1/chat/completions in fail mode', () => {
  let proxy: Proxy;
  before(async () => {
    proxy = await startProxy({ routing: { on_no_candidate: 'fail' } });
  });
  after(async () => {
    await proxy.close();
  });

  test('a missing capability is a 422 naming it, and nothing is sent', async () => {
    const res = await chat(proxy, {
      model: 'blind-x',
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }],
    });
    const message = assertOpenAiError(res, 422, 'no_capable_provider');
    assert.match(message, /missing capability: vision \(openai\/blind-x\)/);
    assert.equal(res.headers['x-tollwise-routed'], 'false');
    assert.equal(res.headers['x-tollwise-policy'], 'cheapest');
    assertNoUpstreamCall(proxy);
  });

  test('a model served only in the Anthropic format is a 422 that says so', async () => {
    const res = await chat(proxy, { model: 'claude-only', messages: HELLO });
    const message = assertOpenAiError(res, 422, 'no_capable_provider');
    assert.match(message, /provider speaks another API format.*\(anthropic\/claude-only\)/);
    assertNoUpstreamCall(proxy);
  });

  test('a model not in the catalog is a 422', async () => {
    const res = await chat(proxy, { model: 'unlisted-model', messages: HELLO });
    assert.match(
      assertOpenAiError(res, 422, 'model_not_in_catalog'),
      /"unlisted-model" is not in the Tollwise catalog/,
    );
    assertNoUpstreamCall(proxy);
  });
});

describe('POST /v1/chat/completions with provider errors', () => {
  test('a provider error that is not retried comes back with its status, in the OpenAI error shape', async () => {
    const proxy = await startProxy({
      openrouter: {
        responses: [
          { failWith: { status: 400, message: 'bad field' } },
          { failWith: { status: 401, message: 'Incorrect credentials provided' } },
          { failWith: { status: 404, message: 'no such model' } },
        ],
      },
    });
    try {
      const rejected = await chat(proxy, { model: 'gpt-x', messages: HELLO });
      const message = assertOpenAiError(rejected, 400, 'provider_bad_request');
      assert.equal(message, 'The openrouter provider answered with HTTP 400: bad field');
      assert.equal((rejected.json as { error: { type: string } }).error.type, 'invalid_request_error');
      assert.equal(rejected.headers['x-tollwise-provider'], 'openrouter');
      assert.equal(rejected.headers['x-tollwise-model'], 'openai/gpt-x');
      assert.equal(rejected.headers['x-tollwise-routed'], 'true');
      assert.equal(rejected.headers['x-tollwise-attempts'], '1');

      const unauthorised = await chat(proxy, { model: 'gpt-x', messages: HELLO });
      assertOpenAiError(unauthorised, 401, 'provider_auth');
      assert.equal((unauthorised.json as { error: { type: string } }).error.type, 'authentication_error');

      const missing = await chat(proxy, { model: 'gpt-x', messages: HELLO });
      assert.match(assertOpenAiError(missing, 404, 'provider_bad_request'), /HTTP 404: no such model/);
      // None of them is retried: the dearer openai entry is never tried.
      assert.equal(chatCalls(proxy.openai).length, 0);
    } finally {
      await proxy.close();
    }
  });

  test('an unreachable provider, with no other candidate, is a 502 naming the error kind', async () => {
    const closedPort = await freePort();
    const proxy = await startProxy({ openaiBaseUrl: `http://127.0.0.1:${closedPort}/v1` });
    try {
      const res = await chat(proxy, { model: 'gpt-x', messages: HELLO }, { 'x-tollwise-provider': 'openai' });
      const message = assertOpenAiError(res, 502, 'all_providers_failed');
      assert.equal(message, 'Tollwise tried 1 provider and every attempt failed: openai model gpt-x (connection).');
      assert.equal(res.headers['x-tollwise-attempts'], '1');
    } finally {
      await proxy.close();
    }
  });

  test('a provider that does not answer in time, with no other candidate, is a 502 naming the timeout', async () => {
    const proxy = await startProxy({
      openrouter: { hang: true },
      routing: { timeouts: { connect_ms: 1000, first_byte_ms: 200, total_ms: 1000 } },
    });
    try {
      const res = await chat(proxy, { model: 'gpt-x', messages: HELLO }, { 'x-tollwise-provider': 'openrouter' });
      assert.equal(
        assertOpenAiError(res, 502, 'all_providers_failed'),
        'Tollwise tried 1 provider and every attempt failed: openrouter model openai/gpt-x (timeout).',
      );
    } finally {
      await proxy.close();
    }
  });

  test('a passthrough to a provider that is not configured is a 422', async () => {
    const proxy = await startProxy({ openaiDisabled: true });
    try {
      const res = await chat(proxy, { model: 'unlisted-model', messages: HELLO });
      assert.match(assertOpenAiError(res, 422, 'provider_not_configured'), /to openai, which is not configured/);
      assertNoUpstreamCall(proxy);
    } finally {
      await proxy.close();
    }
  });
});

describe('POST /v1/chat/completions behind the access key and the request guard', () => {
  let proxy: Proxy;
  before(async () => {
    proxy = await startProxy({ accessKey: FAKE_ACCESS_KEY });
  });
  after(async () => {
    await proxy.close();
  });

  test('without the access key the request is a 401 and never reaches a provider', async () => {
    const res = await chat(proxy, { model: 'gpt-x', messages: HELLO });
    assert.equal(res.status, 401);
    assertNoUpstreamCall(proxy);
  });

  test('a foreign Origin is a 403 and a non-JSON POST a 415, before any provider call', async () => {
    const foreign = await chat(
      proxy,
      { model: 'gpt-x', messages: HELLO },
      { authorization: `Bearer ${FAKE_ACCESS_KEY}`, origin: 'http://evil.example' },
    );
    assert.equal(foreign.status, 403);
    const plain = await send(proxy.url, '/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${FAKE_ACCESS_KEY}`, 'content-type': 'text/plain' },
      body: JSON.stringify({ model: 'gpt-x', messages: HELLO }),
    });
    assert.equal(plain.status, 415);
    assertNoUpstreamCall(proxy);
  });

  test('with the access key the request is routed, and the key is not forwarded', async () => {
    const res = await chat(proxy, { model: 'gpt-x', messages: HELLO }, { authorization: `Bearer ${FAKE_ACCESS_KEY}` });
    assert.equal(res.status, 200);
    const [sent] = chatCalls(proxy.openrouter);
    assert.equal(sent?.headers.authorization, `Bearer ${FAKE_OPENROUTER_KEY}`);
    assert.ok(!JSON.stringify(sent?.headers).includes(FAKE_ACCESS_KEY));
  });
});

describe('POST /v1/chat/completions without a proxy configuration', () => {
  test('answers 503', async () => {
    const server = createTollwiseServer({ maxBodyBytes: 1024, logger: createLogger({ sink: captureLog() }) });
    const address = await listen(server, '127.0.0.1', 0);
    try {
      const res = await send(baseUrl('127.0.0.1', address.port), '/v1/chat/completions', {
        method: 'POST',
        headers: JSON_TYPE,
        body: '{}',
      });
      assert.equal(res.status, 503);
      assert.equal((res.json as { error: { code: string } }).error.code, 'proxy_not_configured');
    } finally {
      await stopServer(server, 100);
    }
  });
});

describe('startTollwise wires the proxy', () => {
  test('a request for a catalog model is routed to the cheaper configured provider', async () => {
    const deepseek = await startMockProvider({});
    const openrouter = await startMockProvider({});
    const dir = mkdtempSync(path.join(tmpdir(), 'tollwise-proxy-start-'));
    let running: Awaited<ReturnType<typeof startTollwise>> | undefined;
    try {
      writeFileSync(
        path.join(dir, 'tollwise.yaml'),
        'providers:\n' +
          '  anthropic: { enabled: false }\n' +
          '  openai: { enabled: false }\n' +
          `  deepseek: { base_url: "${deepseek.url}/v1" }\n` +
          `  openrouter: { base_url: "${openrouter.url}/v1" }\n` +
          '  ollama: { enabled: false }\n',
      );
      running = await startTollwise({
        env: {
          TOLLWISE_PORT: String(await freePort()),
          DEEPSEEK_API_KEY: FAKE_DEEPSEEK_KEY,
          OPENROUTER_API_KEY: FAKE_OPENROUTER_KEY,
        },
        cwd: dir,
        logSink: captureLog(),
        signals: new EventEmitter() as SignalSource,
      });
      const res = await send(running.url, '/v1/chat/completions', {
        method: 'POST',
        headers: JSON_TYPE,
        body: JSON.stringify({ model: 'deepseek-v4-pro', messages: HELLO }),
      });
      assert.equal(res.status, 200);
      // In the shipped catalog OpenRouter lists deepseek-v4-pro-0813 below DeepSeek's own price.
      assert.equal(res.headers['x-tollwise-provider'], 'openrouter');
      assert.equal(res.headers['x-tollwise-model'], 'deepseek/deepseek-v4-pro-0813');
      assert.equal(chatCalls(deepseek).length, 0);
      assert.equal(sentModel(openrouter), 'deepseek/deepseek-v4-pro-0813');
    } finally {
      await running?.stop();
      await deepseek.close();
      await openrouter.close();
      rmSync(dir, { recursive: true, force: true });
      clearSecretValues();
    }
  });
});

describe('startTollwise masks a configured key a provider echoes back', () => {
  test('a provider 401 quoting the key reaches the client and the log masked', async () => {
    // The configured key has no known key shape: only its registration at start-up can mask it.
    const openrouter = await startMockProvider({
      failWith: { status: 401, message: `Incorrect API key provided: ${FAKE_OPENROUTER_KEY}` },
    });
    const dir = mkdtempSync(path.join(tmpdir(), 'tollwise-proxy-echo-'));
    const log = captureLog();
    let running: Awaited<ReturnType<typeof startTollwise>> | undefined;
    try {
      writeFileSync(
        path.join(dir, 'tollwise.yaml'),
        'providers:\n' +
          '  anthropic: { enabled: false }\n' +
          '  openai: { enabled: false }\n' +
          '  deepseek: { enabled: false }\n' +
          `  openrouter: { base_url: "${openrouter.url}/v1" }\n` +
          '  ollama: { enabled: false }\n',
      );
      running = await startTollwise({
        env: { TOLLWISE_PORT: String(await freePort()), OPENROUTER_API_KEY: FAKE_OPENROUTER_KEY },
        cwd: dir,
        logSink: log,
        signals: new EventEmitter() as SignalSource,
      });
      const res = await send(running.url, '/v1/chat/completions', {
        method: 'POST',
        headers: JSON_TYPE,
        body: JSON.stringify({ model: 'deepseek-v4-pro', messages: HELLO }),
      });
      assert.equal(res.status, 401);
      assert.equal(
        (res.json as { error: { message: string } }).error.message,
        'The openrouter provider answered with HTTP 401: Incorrect API key provided: [REDACTED]',
      );
      assert.ok(!res.text.includes(FAKE_OPENROUTER_KEY), 'the client answer holds the key');
      assert.ok(!log.lines.join('').includes(FAKE_OPENROUTER_KEY), 'the log holds the key');
    } finally {
      await running?.stop();
      await openrouter.close();
      rmSync(dir, { recursive: true, force: true });
      clearSecretValues();
    }
  });
});

describe('POST /v1/chat/completions response handling', () => {
  test('provider headers pass through, but not its x-tollwise-* or cookie headers', async () => {
    const payload = JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion', choices: [] });
    const fake = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, {
          'content-type': 'application/json',
          'x-request-id': 'provider-request-1',
          'x-tollwise-provider': 'spoofed',
          'set-cookie': 'session=abc',
        });
        res.end(payload);
      });
    });
    const port = (await listen(fake, '127.0.0.1', 0)).port;
    const proxy = await startProxy({ openaiBaseUrl: `http://127.0.0.1:${port}/v1` });
    try {
      const res = await chat(proxy, { model: 'unlisted-model', messages: HELLO });
      assert.equal(res.status, 200);
      assert.equal(res.text, payload);
      assert.equal(res.headers['x-request-id'], 'provider-request-1');
      assert.equal(res.headers['x-tollwise-provider'], 'openai');
      assert.equal(res.headers['set-cookie'], undefined);
    } finally {
      await proxy.close();
      await stopServer(fake, 100);
    }
  });

  test('a client that goes away aborts the provider call', async () => {
    const proxy = await startProxy({ openrouter: { latencyMs: 1000 } });
    try {
      const address = new URL(proxy.url);
      const req = httpRequest({
        host: address.hostname,
        port: address.port,
        method: 'POST',
        path: '/v1/chat/completions',
        headers: JSON_TYPE,
      });
      req.on('error', () => {});
      req.end(JSON.stringify({ model: 'gpt-x', messages: HELLO }));
      const deadline = performance.now() + 1000;
      while (proxy.openrouter.requests.length === 0 && performance.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(proxy.openrouter.requests.length, 1);
      const started = performance.now();
      req.destroy();
      await proxy.openrouter.waitForDisconnect(0);
      assert.ok(performance.now() - started < 500, 'the provider connection closed well before its answer');
    } finally {
      await proxy.close();
    }
  });
});
