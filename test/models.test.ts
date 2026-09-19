import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { Catalog, ModelEntry } from '../src/catalog/schema.ts';
import { type Config, type ConfigInput, ConfigSchema, type ProviderId } from '../src/config/schema.ts';
import { createLogger, type LogSink } from '../src/log/logger.ts';
import { buildRegistry } from '../src/providers/registry.ts';
import {
  findServableModel,
  listServableModels,
  type ServableModel,
  toAnthropicModel,
  toAnthropicModelList,
  toOpenAiModel,
  toOpenAiModelList,
} from '../src/proxy/models.ts';
import { baseUrl, createTollwiseServer, listen, stopServer } from '../src/server/server.ts';
import { send, type TestResponse } from './fixtures/http-client.ts';
import { type MockProvider, startMockProvider } from './fixtures/mock-provider.ts';

// Fake credentials with no known key shape; none of them is a real key.
const FAKE_OPENAI_KEY = `fakeOpenai${'Oa1'.repeat(6)}`;
const FAKE_OPENROUTER_KEY = `fakeRouter${'Or2'.repeat(6)}`;
const FAKE_ACCESS_KEY = `fakeAccess${'Ak9'.repeat(8)}`;

// Only openai and openrouter have a key; anthropic and deepseek do not, so their catalog entries are
// excluded whatever their `enabled` setting says.
const ENV = { OPENAI_API_KEY: FAKE_OPENAI_KEY, OPENROUTER_API_KEY: FAKE_OPENROUTER_KEY };

const CAPS = { tools: true, json_mode: true, vision: true, streaming: true };

function entry(provider: ProviderId, model: string, canonical: string, verifiedOn: string): ModelEntry {
  return {
    provider,
    model,
    canonical_model: canonical,
    price: { input: 1, output: 2, cached_input: null },
    context_window: 128_000,
    max_output: 16_000,
    capabilities: CAPS,
    source_url: 'https://example.com/pricing',
    verified_on: verifiedOn,
  };
}

// gpt-x: served by openai (first in catalog order, enabled) and openrouter (enabled) -- dedup keeps
// openai's verified_on. lite-x: openrouter only. claude-x: anthropic only, no key -- hidden.
// deep-x: deepseek only, disabled -- hidden. shared-x: deepseek (disabled, first) and openrouter
// (enabled, second) -- dedup must still pick the enabled one, not skip it because it is not first.
const CATALOG: Catalog = {
  models: [
    entry('openai', 'gpt-x', 'gpt-x', '2026-01-01'),
    entry('openrouter', 'openai/gpt-x', 'gpt-x', '2026-06-01'),
    entry('openrouter', 'vendor/lite-x', 'lite-x', '2026-02-02'),
    entry('anthropic', 'claude-x', 'claude-x', '2026-03-03'),
    entry('deepseek', 'deep-x', 'deep-x', '2026-04-04'),
    entry('deepseek', 'shared-a', 'shared-x', '2020-01-01'),
    entry('openrouter', 'vendor/shared-x', 'shared-x', '2021-01-01'),
  ],
};

function unixSeconds(isoDate: string): number {
  return Math.floor(Date.parse(`${isoDate}T00:00:00Z`) / 1000);
}

// ---------------------------------------------------------------- pure functions

describe('listServableModels', () => {
  const config: Config = ConfigSchema.parse({
    providers: {
      openai: { enabled: true },
      openrouter: { enabled: true },
      anthropic: { enabled: true },
      deepseek: { enabled: false },
      ollama: { enabled: false },
    },
  } satisfies ConfigInput);
  const registry = buildRegistry(config, ENV);
  const enabled = new Set(registry.enabled.map((adapter) => adapter.id));

  test('dedups by canonical_model, hides models with no configured+enabled provider, and sorts', () => {
    const models = listServableModels(CATALOG, enabled);
    assert.deepEqual(
      models.map((m) => m.id),
      ['gpt-x', 'lite-x', 'shared-x'],
    );
  });

  test('a canonical model backed by several entries takes createdAt from the first enabled one', () => {
    const models = listServableModels(CATALOG, enabled);
    const gptX = models.find((m) => m.id === 'gpt-x');
    assert.equal(gptX?.createdAt, unixSeconds('2026-01-01'), 'openai entry is first in catalog order and enabled');

    const sharedX = models.find((m) => m.id === 'shared-x');
    assert.equal(
      sharedX?.createdAt,
      unixSeconds('2021-01-01'),
      'deepseek entry is first in catalog order but disabled, so the openrouter entry supplies createdAt',
    );
  });

  test('a provider that is enabled but has no key configured is excluded, like a disabled one', () => {
    const anthropicOnly: Catalog = { models: [entry('anthropic', 'claude-x', 'claude-x', '2026-01-01')] };
    assert.deepEqual(listServableModels(anthropicOnly, enabled), []);
  });

  test('no configured provider at all yields an empty list', () => {
    assert.deepEqual(listServableModels(CATALOG, new Set()), []);
  });

  test('an enabled provider that needs no key (ollama) is listed with no key set at all', () => {
    const localConfig: Config = ConfigSchema.parse({
      providers: {
        openai: { enabled: false },
        openrouter: { enabled: false },
        anthropic: { enabled: false },
        deepseek: { enabled: false },
        ollama: { enabled: true },
      },
    } satisfies ConfigInput);
    const localEnabled = new Set(buildRegistry(localConfig, {}).enabled.map((adapter) => adapter.id));
    const localOnly: Catalog = { models: [entry('ollama', 'llama-x', 'llama-x', '2026-01-01')] };
    assert.deepEqual(
      listServableModels(localOnly, localEnabled).map((m) => m.id),
      ['llama-x'],
    );
  });
});

describe('findServableModel', () => {
  const config: Config = ConfigSchema.parse({
    providers: { openai: { enabled: true }, openrouter: { enabled: true }, deepseek: { enabled: false } },
  } satisfies ConfigInput);
  const registry = buildRegistry(config, ENV);
  const enabled = new Set(registry.enabled.map((adapter) => adapter.id));

  test('finds a servable model by id', () => {
    assert.equal(findServableModel(CATALOG, enabled, 'lite-x')?.id, 'lite-x');
  });

  test('a catalog id whose only provider is not configured is not found', () => {
    assert.equal(findServableModel(CATALOG, enabled, 'claude-x'), undefined);
  });

  test('an id absent from the catalog entirely is not found', () => {
    assert.equal(findServableModel(CATALOG, enabled, 'no-such-model'), undefined);
  });
});

describe('OpenAI and Anthropic shapes', () => {
  const model: ServableModel = { id: 'gpt-x', createdAt: unixSeconds('2026-01-01') };

  test('toOpenAiModel/toOpenAiModelList', () => {
    assert.deepEqual(toOpenAiModel(model), {
      id: 'gpt-x',
      object: 'model',
      created: unixSeconds('2026-01-01'),
      owned_by: 'tollwise',
    });
    assert.deepEqual(toOpenAiModelList([model]), {
      object: 'list',
      data: [{ id: 'gpt-x', object: 'model', created: unixSeconds('2026-01-01'), owned_by: 'tollwise' }],
    });
    assert.deepEqual(toOpenAiModelList([]), { object: 'list', data: [] });
  });

  test('toAnthropicModel/toAnthropicModelList', () => {
    assert.deepEqual(toAnthropicModel(model), {
      type: 'model',
      id: 'gpt-x',
      display_name: 'gpt-x',
      created_at: new Date(unixSeconds('2026-01-01') * 1000).toISOString(),
    });
    const other: ServableModel = { id: 'lite-x', createdAt: unixSeconds('2026-02-02') };
    assert.deepEqual(toAnthropicModelList([model, other]), {
      data: [toAnthropicModel(model), toAnthropicModel(other)],
      has_more: false,
      first_id: 'gpt-x',
      last_id: 'lite-x',
    });
    assert.deepEqual(toAnthropicModelList([]), { data: [], has_more: false, first_id: null, last_id: null });
  });
});

// ---------------------------------------------------------------- the route

const ANTHROPIC_HEADERS = { 'anthropic-version': '2023-06-01' } as const;

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
  close(): Promise<void>;
}

async function startProxy(options: { accessKey?: string } = {}): Promise<Proxy> {
  const openai = await startMockProvider({});
  const openrouter = await startMockProvider({});
  const config: Config = ConfigSchema.parse({
    providers: {
      openai: { enabled: true, base_url: `${openai.url}/v1` },
      openrouter: { enabled: true, base_url: `${openrouter.url}/v1` },
      anthropic: { enabled: true },
      deepseek: { enabled: false },
      ollama: { enabled: false },
    },
  } satisfies ConfigInput);
  const registry = buildRegistry(config, ENV);
  const server = createTollwiseServer({
    maxBodyBytes: 64 * 1024,
    logger: createLogger({ level: 'debug', sink: captureLog() }),
    accessKey: options.accessKey,
    proxy: { config, catalog: CATALOG, registry, env: ENV },
  });
  const address = await listen(server, '127.0.0.1', 0);
  return {
    url: baseUrl('127.0.0.1', address.port),
    openai,
    openrouter,
    async close() {
      await stopServer(server, 100);
      await Promise.all([openai.close(), openrouter.close()]);
    },
  };
}

function assertNoUpstreamCall(proxy: Proxy): void {
  assert.equal(proxy.openai.requests.length, 0);
  assert.equal(proxy.openrouter.requests.length, 0);
}

function models(proxy: Proxy, path: string, headers: Readonly<Record<string, string>> = {}): Promise<TestResponse> {
  return send(proxy.url, path, { headers });
}

describe('GET /v1/models', () => {
  let proxy: Proxy;
  before(async () => {
    proxy = await startProxy();
  });
  after(async () => {
    await proxy.close();
  });

  test('OpenAI shape by default: configured+enabled models only, deduplicated and sorted', async () => {
    const res = await models(proxy, '/v1/models');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, {
      object: 'list',
      data: [
        { id: 'gpt-x', object: 'model', created: unixSeconds('2026-01-01'), owned_by: 'tollwise' },
        { id: 'lite-x', object: 'model', created: unixSeconds('2026-02-02'), owned_by: 'tollwise' },
        { id: 'shared-x', object: 'model', created: unixSeconds('2021-01-01'), owned_by: 'tollwise' },
      ],
    });
    assertNoUpstreamCall(proxy);
  });

  test('Anthropic shape with an anthropic-version header', async () => {
    const res = await models(proxy, '/v1/models', ANTHROPIC_HEADERS);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, {
      data: [
        {
          type: 'model',
          id: 'gpt-x',
          display_name: 'gpt-x',
          created_at: new Date(unixSeconds('2026-01-01') * 1000).toISOString(),
        },
        {
          type: 'model',
          id: 'lite-x',
          display_name: 'lite-x',
          created_at: new Date(unixSeconds('2026-02-02') * 1000).toISOString(),
        },
        {
          type: 'model',
          id: 'shared-x',
          display_name: 'shared-x',
          created_at: new Date(unixSeconds('2021-01-01') * 1000).toISOString(),
        },
      ],
      has_more: false,
      first_id: 'gpt-x',
      last_id: 'shared-x',
    });
    assertNoUpstreamCall(proxy);
  });

  test('HEAD is accepted like any other GET route, POST is 405', async () => {
    const head = await send(proxy.url, '/v1/models', { method: 'HEAD' });
    assert.equal(head.status, 200);
    const post = await send(proxy.url, '/v1/models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(post.status, 405);
    assert.equal(post.headers.allow, 'GET, HEAD');
    assertNoUpstreamCall(proxy);
  });
});

describe('GET /v1/models/{id}', () => {
  let proxy: Proxy;
  before(async () => {
    proxy = await startProxy();
  });
  after(async () => {
    await proxy.close();
  });

  test('OpenAI shape for a configured model', async () => {
    const res = await models(proxy, '/v1/models/gpt-x');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, {
      id: 'gpt-x',
      object: 'model',
      created: unixSeconds('2026-01-01'),
      owned_by: 'tollwise',
    });
  });

  test('Anthropic shape for a configured model', async () => {
    const res = await models(proxy, '/v1/models/gpt-x', ANTHROPIC_HEADERS);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, {
      type: 'model',
      id: 'gpt-x',
      display_name: 'gpt-x',
      created_at: new Date(unixSeconds('2026-01-01') * 1000).toISOString(),
    });
  });

  test('a catalog id whose only provider is not configured is a 404, OpenAI shape', async () => {
    const res = await models(proxy, '/v1/models/claude-x');
    assert.equal(res.status, 404);
    const body = res.json as { error?: { message?: unknown; type?: unknown; code?: unknown } };
    assert.equal(body.error?.type, 'invalid_request_error');
    assert.equal(body.error?.code, 'model_not_found');
    assert.match(String(body.error?.message), /claude-x/);
  });

  test('an id absent from the catalog is a 404, Anthropic shape', async () => {
    const res = await models(proxy, '/v1/models/no-such-model', ANTHROPIC_HEADERS);
    assert.equal(res.status, 404);
    const body = res.json as { type?: unknown; error?: { type?: unknown; message?: unknown } };
    assert.equal(body.type, 'error');
    assert.equal(body.error?.type, 'not_found_error');
    assert.match(String(body.error?.message), /no-such-model/);
  });

  test('never calls a provider', async () => {
    await models(proxy, '/v1/models/gpt-x');
    await models(proxy, '/v1/models/no-such-model');
    assertNoUpstreamCall(proxy);
  });
});

describe('GET /v1/models behind the access key and the request guard', () => {
  let proxy: Proxy;
  before(async () => {
    proxy = await startProxy({ accessKey: FAKE_ACCESS_KEY });
  });
  after(async () => {
    await proxy.close();
  });

  test('without the access key the request is a 401 and never reaches a provider', async () => {
    const res = await models(proxy, '/v1/models');
    assert.equal(res.status, 401);
    assertNoUpstreamCall(proxy);
  });

  test('with the access key it answers normally', async () => {
    const res = await models(proxy, '/v1/models', { authorization: `Bearer ${FAKE_ACCESS_KEY}` });
    assert.equal(res.status, 200);
  });
});

describe('GET /v1/models without a proxy configuration', () => {
  test('answers 503 in the matching shape', async () => {
    const server = createTollwiseServer({ maxBodyBytes: 1024, logger: createLogger({ sink: captureLog() }) });
    const address = await listen(server, '127.0.0.1', 0);
    try {
      const openai = await send(baseUrl('127.0.0.1', address.port), '/v1/models');
      assert.equal(openai.status, 503);
      assert.equal((openai.json as { error: { code: string } }).error.code, 'proxy_not_configured');

      const anthropic = await send(baseUrl('127.0.0.1', address.port), '/v1/models', { headers: ANTHROPIC_HEADERS });
      assert.equal(anthropic.status, 503);
      assert.equal((anthropic.json as { type: string }).type, 'error');
    } finally {
      await stopServer(server, 100);
    }
  });
});
