import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import util from 'node:util';
import { type Environment, loadConfig } from '../src/config/load.ts';
import { type Config, defaultConfig, type ProviderId } from '../src/config/schema.ts';
import { errorMessage, kindFromStatus, MAX_ERROR_MESSAGE_LENGTH, mapProviderError } from '../src/providers/errors.ts';
import { checkHealth } from '../src/providers/health.ts';
import { OpenAiCompatibleAdapter } from '../src/providers/openai-compatible.ts';
import { ADAPTER_FACTORIES, buildRegistry, type ProviderRegistry } from '../src/providers/registry.ts';
import type { ProviderAdapter, ProviderErrorKind } from '../src/providers/types.ts';
import { FAKE_DEEPSEEK_KEY, FAKE_KEYS } from './fixtures/fake-keys.ts';
import { type MockProvider, type StartMockProviderOptions, startMockProvider } from './fixtures/mock-provider.ts';

function fakeKey(name: string): string {
  const sample = FAKE_KEYS[name];
  assert.ok(sample, `missing fake key sample ${name}`);
  return sample.text;
}

const OPENAI_KEY = fakeKey('OpenAI API key');
const OPENROUTER_KEY = fakeKey('OpenRouter API key');
const ANTHROPIC_KEY = fakeKey('Anthropic API key');
const OLLAMA_PROXY_KEY = fakeKey('Groq API key');

/** Every provider key set, as a user with all providers would have it. */
const ALL_KEYS: Environment = {
  OPENAI_API_KEY: OPENAI_KEY,
  DEEPSEEK_API_KEY: FAKE_DEEPSEEK_KEY,
  OPENROUTER_API_KEY: OPENROUTER_KEY,
  ANTHROPIC_API_KEY: ANTHROPIC_KEY,
  OLLAMA_PROXY_KEY,
};
const ALL_KEY_VALUES = [OPENAI_KEY, FAKE_DEEPSEEK_KEY, OPENROUTER_KEY, ANTHROPIC_KEY, OLLAMA_PROXY_KEY];

interface Case {
  readonly id: ProviderId;
  /** Key the adapter must send, or null for no Authorization header. */
  readonly key: string | null;
  /** base_url pointing at the mock (whose OpenAI routes live under /v1). */
  readonly baseUrl: (mockUrl: string) => string;
  readonly defaultBaseUrl: string;
}

const CASES: readonly Case[] = [
  { id: 'openai', key: OPENAI_KEY, baseUrl: (u) => `${u}/v1`, defaultBaseUrl: 'https://api.openai.com/v1' },
  { id: 'deepseek', key: FAKE_DEEPSEEK_KEY, baseUrl: (u) => `${u}/v1`, defaultBaseUrl: 'https://api.deepseek.com' },
  {
    id: 'openrouter',
    key: OPENROUTER_KEY,
    baseUrl: (u) => `${u}/v1`,
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
  },
  { id: 'ollama', key: null, baseUrl: (u) => u, defaultBaseUrl: 'http://127.0.0.1:11434' },
];

const workRoot = mkdtempSync(path.join(os.tmpdir(), 'tollwise-providers-test-'));
after(() => rmSync(workRoot, { recursive: true, force: true }));
let fileCounter = 0;

/** Loads a real configuration file through the config loader, as the server will. */
function loadYaml(yaml: string, env: Environment): Config {
  fileCounter += 1;
  const name = `providers-${fileCounter}.yaml`;
  writeFileSync(path.join(workRoot, name), yaml);
  return loadConfig({ cwd: workRoot, configPath: name, env }).config;
}

/** A registry whose `id` provider points at the mock through a base_url override in the config file. */
function registryAgainstMock(c: Case, mock: MockProvider, env: Environment = ALL_KEYS): ProviderAdapter {
  const config = loadYaml(`providers:\n  ${c.id}:\n    base_url: ${c.baseUrl(mock.url)}\n`, env);
  const adapter = buildRegistry(config, env).get(c.id);
  assert.ok(adapter, `${c.id} should be enabled`);
  return adapter;
}

async function withMock<T>(opts: StartMockProviderOptions, run: (mock: MockProvider) => Promise<T>): Promise<T> {
  const mock = await startMockProvider(opts);
  try {
    return await run(mock);
  } finally {
    await mock.close();
  }
}

function withSettings(overrides: Partial<Record<ProviderId, Partial<Config['providers'][ProviderId]>>>): Config {
  const config = defaultConfig();
  const providers = { ...config.providers };
  for (const [id, value] of Object.entries(overrides) as [ProviderId, Partial<Config['providers'][ProviderId]>][]) {
    providers[id] = { ...providers[id], ...value };
  }
  return { ...config, providers };
}

// --------------------------------------------------------------------------------
// Per adapter, against the mock provider
// --------------------------------------------------------------------------------

for (const c of CASES) {
  describe(`${c.id} adapter`, () => {
    test('speaks the OpenAI format and defaults to the documented base URL', () => {
      const adapter = buildRegistry(defaultConfig(), ALL_KEYS).get(c.id);
      assert.ok(adapter);
      assert.equal(adapter.id, c.id);
      assert.equal(adapter.wireFormat, 'openai');
      assert.equal(adapter.baseUrl, c.defaultBaseUrl);
      assert.equal(adapter.healthRequest.method, 'GET');
    });

    test('uses the base_url override from the configuration file', async () => {
      await withMock({}, async (mock) => {
        const adapter = registryAgainstMock(c, mock);
        assert.equal(adapter.baseUrl, c.baseUrl(mock.url));
        assert.equal(adapter.url(adapter.chatPath), `${mock.url}/v1/chat/completions`);
        assert.equal(adapter.url(adapter.healthRequest.path), `${mock.url}/v1/models`);
      });
    });

    test(c.key === null ? 'sends no Authorization header' : 'sends Authorization: Bearer <key>', async () => {
      await withMock({}, async (mock) => {
        const adapter = registryAgainstMock(c, mock);
        const headers = adapter.authHeaders(ALL_KEYS);
        if (c.key === null) {
          assert.deepEqual(headers, {});
        } else {
          assert.deepEqual(headers, { authorization: `Bearer ${c.key}` });
        }

        const res = await fetch(adapter.url(adapter.chatPath), {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify({ model: 'mock-model', messages: [{ role: 'user', content: 'hi' }] }),
        });
        assert.equal(res.status, 200);
        assert.equal(((await res.json()) as { object: string }).object, 'chat.completion');

        const recorded = mock.requests[0];
        assert.ok(recorded);
        assert.equal(recorded.path, '/v1/chat/completions');
        assert.equal(recorded.headers.authorization, c.key === null ? undefined : `Bearer ${c.key}`);
        assert.equal(recorded.headers['x-api-key'], undefined);
      });
    });

    test('health request is a GET of the models list, answered by the mock', async () => {
      await withMock({}, async (mock) => {
        const adapter = registryAgainstMock(c, mock);
        assert.deepEqual(await checkHealth(adapter, ALL_KEYS), { ok: true, status: 200 });
        assert.equal(mock.requests.length, 1);
        const recorded = mock.requests[0];
        assert.ok(recorded);
        assert.equal(recorded.method, 'GET');
        assert.equal(recorded.path, '/v1/models');
        assert.equal(recorded.headers.authorization, c.key === null ? undefined : `Bearer ${c.key}`);
      });
    });

    const statuses: readonly [number, ProviderErrorKind][] = [
      [400, 'bad_request'],
      [401, 'auth'],
      [403, 'auth'],
      [429, 'rate_limit'],
      [500, 'server'],
      [503, 'overloaded'],
    ];
    for (const [status, kind] of statuses) {
      test(`maps HTTP ${status} from the provider to ${kind}`, async () => {
        const message = `upstream said ${status}`;
        await withMock({ failWith: { status, message } }, async (mock) => {
          const adapter = registryAgainstMock(c, mock);
          const result = await checkHealth(adapter, ALL_KEYS);
          assert.deepEqual(result, { ok: false, error: { kind, status, message } });
        });
      });
    }

    test('maps a provider that never answers to timeout', async () => {
      await withMock({ hang: true }, async (mock) => {
        const adapter = registryAgainstMock(c, mock);
        const result = await checkHealth(adapter, ALL_KEYS, { timeoutMs: 150 });
        assert.deepEqual(result, { ok: false, error: { kind: 'timeout', status: null, message: undefined } });
        assert.deepEqual(adapter.mapError('timeout'), { kind: 'timeout', status: null, message: undefined });
      });
    });
  });
}

test('ollama sends a bearer key when api_key_env is configured for it', async () => {
  await withMock({}, async (mock) => {
    const config = loadYaml(
      `providers:\n  ollama:\n    base_url: ${mock.url}\n    api_key_env: OLLAMA_PROXY_KEY\n`,
      {},
    );
    const adapter = buildRegistry(config, ALL_KEYS).get('ollama');
    assert.ok(adapter);
    assert.deepEqual(await checkHealth(adapter, ALL_KEYS), { ok: true, status: 200 });
    assert.equal(mock.requests[0]?.headers.authorization, `Bearer ${OLLAMA_PROXY_KEY}`);
  });
});

// --------------------------------------------------------------------------------
// Keys: read at call time, never kept, never serialised
// --------------------------------------------------------------------------------

function assertNoKey(text: string, what: string): void {
  for (const key of ALL_KEY_VALUES) assert.ok(!text.includes(key), `${what} contains a key`);
}

function assertRegistryCarriesNoKey(registry: ProviderRegistry): void {
  const inspectOptions = { depth: Number.POSITIVE_INFINITY, showHidden: true, getters: true };
  for (const adapter of registry.enabled) {
    assertNoKey(JSON.stringify(adapter), `JSON of ${adapter.id}`);
    assertNoKey(util.inspect(adapter, inspectOptions), `inspect of ${adapter.id}`);
    assertNoKey(String(adapter), `String of ${adapter.id}`);
  }
  assertNoKey(JSON.stringify(registry), 'JSON of the registry');
  assertNoKey(util.inspect(registry, inspectOptions), 'inspect of the registry');
}

test('no adapter and no registry holds a key, before or after authHeaders() is called', () => {
  const env = { ...ALL_KEYS };
  const config = withSettings({ ollama: { api_key_env: 'OLLAMA_PROXY_KEY' } });
  const registry = buildRegistry(config, env);
  assert.equal(registry.enabled.length, 5);
  assertRegistryCarriesNoKey(registry);

  // Using the keys must not leave them behind on any object.
  for (const adapter of registry.enabled) {
    const headers = adapter.authHeaders(env);
    const header = adapter.id === 'anthropic' ? headers['x-api-key'] : headers.authorization;
    if (adapter.id === 'anthropic') assert.equal(header, ANTHROPIC_KEY);
    else assert.ok(header?.startsWith('Bearer '));
  }
  assertRegistryCarriesNoKey(registry);
});

test('the key is read from the environment at call time', () => {
  const env: Record<string, string | undefined> = { OPENAI_API_KEY: OPENAI_KEY };
  const adapter = buildRegistry(defaultConfig(), env).get('openai');
  assert.ok(adapter);
  env.OPENAI_API_KEY = FAKE_DEEPSEEK_KEY;
  assert.deepEqual(adapter.authHeaders(env), { authorization: `Bearer ${FAKE_DEEPSEEK_KEY}` });
  env.OPENAI_API_KEY = ` ${OPENAI_KEY}\n`;
  assert.deepEqual(adapter.authHeaders(env), { authorization: `Bearer ${OPENAI_KEY}` });
});

test('authHeaders throws, naming the variable, when the key is missing', () => {
  const adapter = buildRegistry(defaultConfig(), ALL_KEYS).get('openai');
  assert.ok(adapter);
  assert.equal(adapter.isConfigured({}), false);
  assert.throws(() => adapter.authHeaders({}), {
    message: 'openai: the environment variable OPENAI_API_KEY is not set',
  });
  assert.throws(() => adapter.authHeaders({ OPENAI_API_KEY: '   ' }), /OPENAI_API_KEY is not set/);
});

test('authHeaders refuses to send a key over plain http to a remote host', () => {
  const adapter = new OpenAiCompatibleAdapter({
    id: 'openai',
    settings: { base_url: 'http://10.1.2.3:8080/v1', api_key_env: 'OPENAI_API_KEY' },
    chatPath: '/chat/completions',
    modelsPath: '/models',
  });
  assert.throws(() => adapter.authHeaders(ALL_KEYS), /refusing to send OPENAI_API_KEY over plain http/);
});

test('health check without a key reports auth and makes no request', async () => {
  await withMock({}, async (mock) => {
    const config = withSettings({ openai: { base_url: `${mock.url}/v1` } });
    const adapter = buildRegistry(config, ALL_KEYS).get('openai');
    assert.ok(adapter);
    const result = await checkHealth(adapter, {});
    assert.deepEqual(result, { ok: false, error: { kind: 'auth', status: null, message: 'no key configured' } });
    assert.equal(mock.requests.length, 0);
  });
});

test('health check reports a refused connection as unknown, without the URL', async () => {
  const mock = await startMockProvider();
  const url = mock.url;
  await mock.close();
  const adapter = buildRegistry(withSettings({ ollama: { base_url: url } }), {}).get('ollama');
  assert.ok(adapter);
  const result = await checkHealth(adapter, {}, { timeoutMs: 2000 });
  assert.deepEqual(result, { ok: false, error: { kind: 'unknown', status: null, message: 'connection failed' } });
});

// --------------------------------------------------------------------------------
// Registry
// --------------------------------------------------------------------------------

describe('registry', () => {
  test('with no keys set only Ollama is enabled', () => {
    const registry = buildRegistry(defaultConfig(), {});
    assert.deepEqual(
      registry.enabled.map((a) => a.id),
      ['ollama'],
    );
    assert.deepEqual(registry.excluded, [
      { id: 'anthropic', reason: 'missing_key', apiKeyEnv: 'ANTHROPIC_API_KEY' },
      { id: 'openai', reason: 'missing_key', apiKeyEnv: 'OPENAI_API_KEY' },
      { id: 'deepseek', reason: 'missing_key', apiKeyEnv: 'DEEPSEEK_API_KEY' },
      { id: 'openrouter', reason: 'missing_key', apiKeyEnv: 'OPENROUTER_API_KEY' },
    ]);
    assert.equal(registry.get('openai'), undefined);
  });

  test('a provider is enabled when enabled is true and its key variable is set', () => {
    const registry = buildRegistry(defaultConfig(), { DEEPSEEK_API_KEY: FAKE_DEEPSEEK_KEY, OPENAI_API_KEY: '  ' });
    assert.deepEqual(
      registry.enabled.map((a) => a.id),
      ['deepseek', 'ollama'],
    );
    assert.equal(registry.get('deepseek')?.id, 'deepseek');
  });

  test('enabled: false excludes a provider even with its key set', () => {
    const config = loadYaml('providers:\n  openai:\n    enabled: false\n  ollama:\n    enabled: false\n', {});
    const registry = buildRegistry(config, ALL_KEYS);
    assert.deepEqual(
      registry.enabled.map((a) => a.id),
      ['anthropic', 'deepseek', 'openrouter'],
    );
    assert.deepEqual(
      registry.excluded.filter((e) => e.reason === 'disabled').map((e) => e.id),
      ['openai', 'ollama'],
    );
  });

  test('a custom api_key_env is the variable that counts', () => {
    const config = loadYaml('providers:\n  openrouter:\n    api_key_env: MY_ROUTER_KEY\n', {});
    assert.equal(buildRegistry(config, { OPENROUTER_API_KEY: OPENROUTER_KEY }).get('openrouter'), undefined);
    const adapter = buildRegistry(config, { MY_ROUTER_KEY: OPENROUTER_KEY }).get('openrouter');
    assert.deepEqual(adapter?.authHeaders({ MY_ROUTER_KEY: OPENROUTER_KEY }), {
      authorization: `Bearer ${OPENROUTER_KEY}`,
    });
  });

  test('an adapter for another wire format plugs in with one factory entry', () => {
    const anthropicLike = (settings: { base_url: string; api_key_env: string | null }): ProviderAdapter => ({
      id: 'anthropic',
      wireFormat: 'anthropic',
      baseUrl: settings.base_url,
      chatPath: '/v1/messages',
      healthRequest: { method: 'GET', path: '/v1/models' },
      isConfigured: (env) => settings.api_key_env !== null && (env[settings.api_key_env] ?? '') !== '',
      authHeaders: () => ({}),
      url: (p) => `${settings.base_url}${p}`,
      mapError: mapProviderError,
    });
    const registry = buildRegistry(defaultConfig(), ALL_KEYS, { ...ADAPTER_FACTORIES, anthropic: anthropicLike });
    assert.deepEqual(
      registry.enabled.map((a) => [a.id, a.wireFormat]),
      [
        ['anthropic', 'anthropic'],
        ['openai', 'openai'],
        ['deepseek', 'openai'],
        ['openrouter', 'openai'],
        ['ollama', 'openai'],
      ],
    );
    assert.deepEqual(registry.excluded, []);
  });

  test('the registry and its adapters are frozen', () => {
    const registry = buildRegistry(defaultConfig(), ALL_KEYS);
    assert.ok(Object.isFrozen(registry));
    assert.ok(Object.isFrozen(registry.enabled));
    for (const adapter of registry.enabled) assert.ok(Object.isFrozen(adapter));
  });

  test('a trailing slash on base_url is dropped', () => {
    const adapter = buildRegistry(withSettings({ ollama: { base_url: 'http://127.0.0.1:11434/' } }), {}).get('ollama');
    assert.equal(adapter?.baseUrl, 'http://127.0.0.1:11434');
    assert.equal(adapter?.url(adapter.chatPath), 'http://127.0.0.1:11434/v1/chat/completions');
  });
});

// --------------------------------------------------------------------------------
// Error normalisation
// --------------------------------------------------------------------------------

describe('mapError', () => {
  test('kind by status', () => {
    const expected: readonly [number, ProviderErrorKind][] = [
      [400, 'bad_request'],
      [401, 'auth'],
      [402, 'auth'],
      [403, 'auth'],
      [404, 'bad_request'],
      [408, 'timeout'],
      [413, 'bad_request'],
      [422, 'bad_request'],
      [429, 'rate_limit'],
      [500, 'server'],
      [502, 'server'],
      [503, 'overloaded'],
      [504, 'timeout'],
      [524, 'timeout'],
      [529, 'overloaded'],
      [200, 'unknown'],
      [302, 'unknown'],
      [600, 'unknown'],
      [Number.NaN, 'unknown'],
    ];
    for (const [status, kind] of expected) assert.equal(kindFromStatus(status), kind, `status ${status}`);
  });

  test('reads the message from each provider body shape', () => {
    assert.equal(errorMessage({ error: { message: 'bad model', type: 'x' } }), 'bad model');
    assert.equal(errorMessage({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }), 'busy');
    assert.equal(errorMessage({ error: 'model "x" not found' }), 'model "x" not found');
    assert.equal(errorMessage('{"error":{"message":"from text"}}'), 'from text');
    assert.equal(errorMessage('Bad Gateway\n  upstream'), 'Bad Gateway upstream');
    assert.equal(errorMessage(''), undefined);
    assert.equal(errorMessage({ unrelated: true }), undefined);
    assert.equal(errorMessage(undefined), undefined);
    assert.deepEqual(mapProviderError(429, { error: { message: 'slow down' } }), {
      kind: 'rate_limit',
      status: 429,
      message: 'slow down',
    });
  });

  test('masks a key echoed in a provider message', () => {
    const message = errorMessage({ error: { message: `Incorrect API key provided: ${OPENAI_KEY}.` } });
    assert.equal(message, 'Incorrect API key provided: [REDACTED].');
    const result = mapProviderError(401, `{"error":{"message":"bad Bearer ${OPENROUTER_KEY}"}}`);
    assertNoKey(JSON.stringify(result), 'mapped error');
    assert.equal(result.kind, 'auth');
  });

  test('caps long messages', () => {
    const message = errorMessage({ error: { message: 'x'.repeat(5000) } });
    assert.equal(message?.length, MAX_ERROR_MESSAGE_LENGTH + 3);
    assert.ok(message?.endsWith('...'));
  });
});
