import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import util from 'node:util';
import { type Environment, loadConfig } from '../src/config/load.ts';
import { defaultConfig } from '../src/config/schema.ts';
import { ANTHROPIC_VERSION, AnthropicAdapter, createAnthropicAdapter } from '../src/providers/anthropic.ts';
import { checkHealth } from '../src/providers/health.ts';
import { buildRegistry } from '../src/providers/registry.ts';
import type { ProviderErrorKind } from '../src/providers/types.ts';
import { FAKE_KEYS } from './fixtures/fake-keys.ts';
import { type MockProvider, startMockProvider } from './fixtures/mock-provider.ts';

const ANTHROPIC_KEY = FAKE_KEYS['Anthropic API key']?.text;
assert.ok(ANTHROPIC_KEY, 'missing fake key sample "Anthropic API key"');

const workRoot = mkdtempSync(path.join(os.tmpdir(), 'tollwise-anthropic-test-'));
after(() => rmSync(workRoot, { recursive: true, force: true }));
let fileCounter = 0;

/** Loads a real configuration file through the config loader, as the server will. */
function loadYaml(yaml: string, env: Environment) {
  fileCounter += 1;
  const name = `anthropic-${fileCounter}.yaml`;
  writeFileSync(path.join(workRoot, name), yaml);
  return loadConfig({ cwd: workRoot, configPath: name, env }).config;
}

/** The anthropic adapter from the registry, pointed at the mock through a base_url override. */
function adapterAgainstMock(mock: MockProvider, env: Environment = { ANTHROPIC_API_KEY: ANTHROPIC_KEY }) {
  const config = loadYaml(`providers:\n  anthropic:\n    base_url: ${mock.url}\n`, env);
  const adapter = buildRegistry(config, env).get('anthropic');
  assert.ok(adapter, 'anthropic should be enabled');
  return adapter;
}

async function withMock<T>(opts: Parameters<typeof startMockProvider>[0], run: (mock: MockProvider) => Promise<T>) {
  const mock = await startMockProvider(opts);
  try {
    return await run(mock);
  } finally {
    await mock.close();
  }
}

// --------------------------------------------------------------------------------
// Shape and defaults
// --------------------------------------------------------------------------------

test('anthropic adapter speaks the anthropic format and defaults to the documented base URL', () => {
  const adapter = buildRegistry(defaultConfig(), { ANTHROPIC_API_KEY: ANTHROPIC_KEY }).get('anthropic');
  assert.ok(adapter);
  assert.equal(adapter.id, 'anthropic');
  assert.equal(adapter.wireFormat, 'anthropic');
  assert.equal(adapter.baseUrl, 'https://api.anthropic.com');
  assert.equal(adapter.chatPath, '/v1/messages');
  assert.equal(adapter.healthRequest.method, 'GET');
  assert.equal(adapter.healthRequest.path, '/v1/models');
});

test('registered in the registry with one factory entry, and enabled when its key is set', () => {
  const adapter = createAnthropicAdapter({ base_url: 'https://api.anthropic.com', api_key_env: 'ANTHROPIC_API_KEY' });
  assert.ok(adapter instanceof AnthropicAdapter);
  const registry = buildRegistry(defaultConfig(), { ANTHROPIC_API_KEY: ANTHROPIC_KEY });
  assert.equal(registry.get('anthropic')?.wireFormat, 'anthropic');
});

test('a trailing slash on base_url is dropped', () => {
  const adapter = createAnthropicAdapter({
    base_url: 'https://api.anthropic.com/',
    api_key_env: 'ANTHROPIC_API_KEY',
  });
  assert.equal(adapter.baseUrl, 'https://api.anthropic.com');
  assert.equal(adapter.url(adapter.chatPath), 'https://api.anthropic.com/v1/messages');
});

// --------------------------------------------------------------------------------
// Auth headers
// --------------------------------------------------------------------------------

test('uses the base_url override from the configuration file', async () => {
  await withMock({}, async (mock) => {
    const adapter = adapterAgainstMock(mock);
    assert.equal(adapter.baseUrl, mock.url);
    assert.equal(adapter.url(adapter.chatPath), `${mock.url}/v1/messages`);
    assert.equal(adapter.url(adapter.healthRequest.path), `${mock.url}/v1/models`);
  });
});

test('sends x-api-key and anthropic-version, and no Authorization header', async () => {
  await withMock({}, async (mock) => {
    const env = { ANTHROPIC_API_KEY: ANTHROPIC_KEY };
    const adapter = adapterAgainstMock(mock, env);
    const headers = adapter.authHeaders(env);
    assert.equal(headers.authorization, undefined);
    assert.deepEqual(headers, { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': ANTHROPIC_VERSION });

    const res = await fetch(adapter.url(adapter.chatPath), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ model: 'mock-model', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { type: string }).type, 'message');

    const recorded = mock.requests[0];
    assert.ok(recorded);
    assert.equal(recorded.path, '/v1/messages');
    assert.equal(recorded.headers['x-api-key'], ANTHROPIC_KEY);
    assert.equal(recorded.headers['anthropic-version'], ANTHROPIC_VERSION);
    assert.equal(recorded.headers.authorization, undefined);
  });
});

test('health request is a GET of the models list, answered by the mock in the anthropic shape', async () => {
  await withMock({ models: { anthropic: ['claude-mock-1'] } }, async (mock) => {
    const env = { ANTHROPIC_API_KEY: ANTHROPIC_KEY };
    const adapter = adapterAgainstMock(mock, env);
    assert.deepEqual(await checkHealth(adapter, env), { ok: true, status: 200 });
    assert.equal(mock.requests.length, 1);
    const recorded = mock.requests[0];
    assert.ok(recorded);
    assert.equal(recorded.method, 'GET');
    assert.equal(recorded.path, '/v1/models');
    assert.equal(recorded.headers['x-api-key'], ANTHROPIC_KEY);
    assert.equal(recorded.headers.authorization, undefined);
  });
});

// --------------------------------------------------------------------------------
// Errors, including Anthropic's documented error types
// --------------------------------------------------------------------------------

const ANTHROPIC_STATUSES: readonly [number, string, ProviderErrorKind][] = [
  [400, 'invalid_request_error', 'bad_request'],
  [401, 'authentication_error', 'auth'],
  [403, 'permission_error', 'auth'],
  [429, 'rate_limit_error', 'rate_limit'],
  [500, 'api_error', 'server'],
  [529, 'overloaded_error', 'overloaded'],
];

for (const [status, type, kind] of ANTHROPIC_STATUSES) {
  test(`maps HTTP ${status} (${type}) from Anthropic to ${kind}`, async () => {
    const message = `anthropic said ${status}`;
    await withMock({ failWith: { status, type, message } }, async (mock) => {
      const env = { ANTHROPIC_API_KEY: ANTHROPIC_KEY };
      const adapter = adapterAgainstMock(mock, env);
      const result = await checkHealth(adapter, env);
      assert.deepEqual(result, { ok: false, error: { kind, status, message } });
    });
  });
}

test('maps a provider that never answers to timeout', async () => {
  await withMock({ hang: true }, async (mock) => {
    const env = { ANTHROPIC_API_KEY: ANTHROPIC_KEY };
    const adapter = adapterAgainstMock(mock, env);
    const result = await checkHealth(adapter, env, { timeoutMs: 150 });
    assert.deepEqual(result, { ok: false, error: { kind: 'timeout', status: null, message: undefined } });
    assert.deepEqual(adapter.mapError('timeout'), { kind: 'timeout', status: null, message: undefined });
  });
});

// --------------------------------------------------------------------------------
// Keys: read at call time, never kept, never serialised
// --------------------------------------------------------------------------------

test('the key is read from the environment at call time', () => {
  const env: Record<string, string | undefined> = { ANTHROPIC_API_KEY: ANTHROPIC_KEY };
  const adapter = buildRegistry(defaultConfig(), env).get('anthropic');
  assert.ok(adapter);
  const otherKey = FAKE_KEYS['OpenRouter API key']?.text;
  assert.ok(otherKey);
  env.ANTHROPIC_API_KEY = otherKey;
  assert.deepEqual(adapter.authHeaders(env), { 'x-api-key': otherKey, 'anthropic-version': ANTHROPIC_VERSION });
  env.ANTHROPIC_API_KEY = ` ${ANTHROPIC_KEY}\n`;
  assert.deepEqual(adapter.authHeaders(env), {
    'x-api-key': ANTHROPIC_KEY,
    'anthropic-version': ANTHROPIC_VERSION,
  });
});

test('authHeaders throws, naming the variable, when the key is missing', () => {
  const adapter = buildRegistry(defaultConfig(), { ANTHROPIC_API_KEY: ANTHROPIC_KEY }).get('anthropic');
  assert.ok(adapter);
  assert.equal(adapter.isConfigured({}), false);
  assert.throws(() => adapter.authHeaders({}), {
    message: 'anthropic: the environment variable ANTHROPIC_API_KEY is not set',
  });
  assert.throws(() => adapter.authHeaders({ ANTHROPIC_API_KEY: '   ' }), /ANTHROPIC_API_KEY is not set/);
});

test('authHeaders refuses to send a key over plain http to a remote host', () => {
  const adapter = new AnthropicAdapter({ base_url: 'http://10.1.2.3:8080', api_key_env: 'ANTHROPIC_API_KEY' });
  assert.throws(
    () => adapter.authHeaders({ ANTHROPIC_API_KEY: ANTHROPIC_KEY }),
    /refusing to send ANTHROPIC_API_KEY over plain http/,
  );
});

test('no adapter or registry holds the anthropic key, before or after authHeaders() is called', () => {
  const env = { ANTHROPIC_API_KEY: ANTHROPIC_KEY };
  const registry = buildRegistry(defaultConfig(), env);
  const adapter = registry.get('anthropic');
  assert.ok(adapter);

  const inspectOptions = { depth: Number.POSITIVE_INFINITY, showHidden: true, getters: true };
  const assertNoKey = (text: string, what: string) =>
    assert.ok(!text.includes(ANTHROPIC_KEY), `${what} contains a key`);

  assertNoKey(JSON.stringify(adapter), 'JSON of the adapter');
  assertNoKey(util.inspect(adapter, inspectOptions), 'inspect of the adapter');
  assertNoKey(JSON.stringify(registry), 'JSON of the registry');
  assertNoKey(util.inspect(registry, inspectOptions), 'inspect of the registry');

  adapter.authHeaders(env);

  assertNoKey(JSON.stringify(adapter), 'JSON of the adapter after use');
  assertNoKey(util.inspect(adapter, inspectOptions), 'inspect of the adapter after use');
  assertNoKey(JSON.stringify(registry), 'JSON of the registry after use');
  assertNoKey(util.inspect(registry, inspectOptions), 'inspect of the registry after use');
});
