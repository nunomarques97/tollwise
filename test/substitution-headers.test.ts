// Model substitution made visible: select() marks each candidate, and every answer of
// /v1/chat/completions and /v1/messages (streamed or not, served, routed error, passthrough and refused)
// says which model was asked for, whether another one served it, and which equivalence group allowed it.
// The same fact is in each routing trace attempt and in the RequestOutcome event.

import assert from 'node:assert/strict';
import type { IncomingHttpHeaders, Server } from 'node:http';
import { after, afterEach, before, describe, test } from 'node:test';
import { toRecentEntry } from '../src/analytics/metrics.ts';
import type { Catalog, ModelEntry } from '../src/catalog/schema.ts';
import { type Config, type ConfigInput, ConfigSchema, type ProviderId } from '../src/config/schema.ts';
import { createLogger } from '../src/log/logger.ts';
import { buildRegistry } from '../src/providers/registry.ts';
import { headerSafeValue, type ProxyRequestResult, TOLLWISE_HEADERS } from '../src/proxy/forward.ts';
import {
  buildRequestOutcome,
  clearRequestOutcomeListeners,
  maskSubstitution,
  onRequestOutcome,
  type RequestOutcome,
} from '../src/proxy/outcome.ts';
import { type RoutedCandidate, type RoutingSettings, type SelectInput, select } from '../src/routing/select.ts';
import { baseUrl, createTollwiseServer, listen, stopServer } from '../src/server/server.ts';
import { FAKE_KEYS } from './fixtures/fake-keys.ts';
import { send, type TestResponse } from './fixtures/http-client.ts';
import { type MockProvider, type StartMockProviderOptions, startMockProvider } from './fixtures/mock-provider.ts';

// Fake credentials with no known key shape; none of them is a real key.
const ENV = {
  OPENAI_API_KEY: `fakeOpenai${'Oa1'.repeat(6)}`,
  OPENROUTER_API_KEY: `fakeRouter${'Or2'.repeat(6)}`,
  DEEPSEEK_API_KEY: `fakeDeep${'Ds3'.repeat(6)}`,
  ANTHROPIC_API_KEY: `fakeClaude${'An4'.repeat(6)}`,
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
 * The three members of the `frontier` preset, cheapest first: deepseek-v4-pro-0813 (deepseek, 1),
 * gpt-6-astra (openrouter 2, openai 10) and claude-opus-5 (anthropic 5). gpt-x is in no group: it
 * only switches providers (openrouter 2, openai 4). mini-a and mini-b form a group written by hand.
 */
const CATALOG: Catalog = {
  models: [
    entry('deepseek', 'deepseek-v4-pro', 'deepseek-v4-pro-0813', 1),
    entry('openrouter', 'openai/gpt-6-astra', 'gpt-6-astra', 2),
    entry('anthropic', 'claude-opus-5', 'claude-opus-5', 5),
    entry('openai', 'gpt-6-astra', 'gpt-6-astra', 10),
    entry('openrouter', 'openai/gpt-x', 'gpt-x', 2),
    entry('openai', 'gpt-x', 'gpt-x', 4),
    entry('deepseek', 'mini-b', 'mini-b', 1),
    entry('openai', 'mini-a', 'mini-a', 3),
  ],
};

type MockId = 'deepseek' | 'openrouter' | 'openai' | 'anthropic';

interface Proxy {
  readonly url: string;
  readonly mocks: Readonly<Record<MockId, MockProvider>>;
  /** Resolves with the result of the n-th proxied request (0-based) once it is reported. */
  result(index: number): Promise<ProxyRequestResult>;
  close(): Promise<void>;
}

interface ProxyOptions {
  readonly routing?: ConfigInput['routing'];
  readonly mocks?: Partial<Record<MockId, StartMockProviderOptions>>;
}

async function startProxy(options: ProxyOptions = {}): Promise<Proxy> {
  const mock = (id: MockId) => startMockProvider(options.mocks?.[id] ?? {});
  const mocks = {
    deepseek: await mock('deepseek'),
    openrouter: await mock('openrouter'),
    openai: await mock('openai'),
    anthropic: await mock('anthropic'),
  };
  const config: Config = ConfigSchema.parse({
    providers: {
      openai: { base_url: `${mocks.openai.url}/v1` },
      openrouter: { base_url: `${mocks.openrouter.url}/v1` },
      deepseek: { base_url: `${mocks.deepseek.url}/v1` },
      anthropic: { base_url: mocks.anthropic.url },
    },
    routing: options.routing ?? { equivalence_presets: ['frontier'] },
  } satisfies ConfigInput);
  const results: ProxyRequestResult[] = [];
  const server: Server = createTollwiseServer({
    maxBodyBytes: 64 * 1024,
    logger: createLogger({ level: 'error', sink: { write: () => true }, env: {} }),
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
    async result(index: number) {
      await waitFor(() => results[index] !== undefined, `no result for request ${index}`);
      return results[index] as ProxyRequestResult;
    },
    async close() {
      await stopServer(server, 100);
      await Promise.all(Object.values(mocks).map((each) => each.close()));
    },
  };
}

const HELLO = [{ role: 'user', content: 'Say hello.' }];
const JSON_TYPE = { 'content-type': 'application/json' } as const;
const MESSAGES_HEADERS = { ...JSON_TYPE, 'anthropic-version': '2023-06-01' } as const;

function chat(proxy: Proxy, body: Record<string, unknown>): Promise<TestResponse> {
  return send(proxy.url, '/v1/chat/completions', { method: 'POST', headers: JSON_TYPE, body: JSON.stringify(body) });
}

function messages(proxy: Proxy, body: Record<string, unknown>): Promise<TestResponse> {
  return send(proxy.url, '/v1/messages', { method: 'POST', headers: MESSAGES_HEADERS, body: JSON.stringify(body) });
}

async function waitFor(check: () => boolean, message: string): Promise<void> {
  const deadline = performance.now() + 3000;
  while (!check()) {
    if (performance.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Every RequestOutcome emitted from now on, found by request id. */
function captureOutcomes(): { outcomeFor(res: TestResponse): Promise<RequestOutcome>; stop(): void } {
  const outcomes: RequestOutcome[] = [];
  const stop = onRequestOutcome((outcome) => outcomes.push(outcome));
  return {
    async outcomeFor(res) {
      const id = res.headers[TOLLWISE_HEADERS.requestId];
      assert.equal(typeof id, 'string', 'the answer carries a request id');
      await waitFor(() => outcomes.some((each) => each.requestId === id), `no outcome for ${String(id)}`);
      return outcomes.find((each) => each.requestId === id) as RequestOutcome;
    },
    stop,
  };
}

/** The x-tollwise-* headers that describe the model, as one object (undefined when absent). */
function modelHeaders(headers: IncomingHttpHeaders) {
  return {
    provider: headers['x-tollwise-provider'],
    model: headers['x-tollwise-model'],
    requested: headers['x-tollwise-requested-model'],
    substituted: headers['x-tollwise-substituted'],
    group: headers['x-tollwise-equivalence-group'],
  };
}

/** The trace as [provider, model, outcome, substitution] rows. */
function traceRows(result: ProxyRequestResult) {
  return result.attempts.map((attempt) => [attempt.provider, attempt.model, attempt.outcome, attempt.substitution]);
}

const FRONTIER_TO_DEEPSEEK = {
  requested_model: 'gpt-6-astra',
  served_model: 'deepseek-v4-pro',
  group: 'frontier',
} as const;

describe('select(): each candidate says whether it is a substitution, and which group allowed it', () => {
  const NO_NEEDS = { tools: false, json_mode: false, vision: false, streaming: false };
  function selectFor(model: string, routing: Partial<RoutingSettings>) {
    const input: SelectInput = {
      inspection: {
        format: 'openai',
        requestedModel: model,
        needs: NO_NEEDS,
        estimatedInput: { tokens: 100, origin: 'estimated' },
        maxOutput: null,
      },
      catalog: CATALOG,
      registry: { enabled: (['openai', 'openrouter', 'deepseek', 'anthropic'] as const).map((id) => ({ id })) },
      health: { providers: [] },
      routing: { policy: 'cheapest', on_no_candidate: 'passthrough', equivalence_groups: [], ...routing },
    };
    const selection = select(input);
    assert.equal(selection.decision, 'routed');
    return (selection.candidates as readonly RoutedCandidate[]).map((c) => [c.provider, c.model, c.substitution]);
  }
  const FRONTIER = { name: 'frontier', models: ['claude-opus-5', 'gpt-6-astra', 'deepseek-v4-pro-0813'] };

  test('a preset group: every other member is a substitution from the preset, the requested model is not', () => {
    const preset = { group: 'frontier', source: 'preset' };
    assert.deepEqual(selectFor('gpt-6-astra', { equivalence_groups: [FRONTIER], equivalence_presets: ['frontier'] }), [
      ['deepseek', 'deepseek-v4-pro', preset],
      ['openrouter', 'openai/gpt-6-astra', null],
      ['anthropic', 'claude-opus-5', preset],
      ['openai', 'gpt-6-astra', null],
    ]);
  });

  test('a group written by hand is a custom substitution', () => {
    const groups = [{ name: 'minis', models: ['mini-a', 'mini-b'] }];
    assert.deepEqual(selectFor('mini-a', { equivalence_groups: groups }), [
      ['deepseek', 'mini-b', { group: 'minis', source: 'custom' }],
      ['openai', 'mini-a', null],
    ]);
  });

  test('a provider switch of the same model, with no group, is never a substitution', () => {
    assert.deepEqual(selectFor('gpt-x', { equivalence_groups: [FRONTIER], equivalence_presets: ['frontier'] }), [
      ['openrouter', 'openai/gpt-x', null],
      ['openai', 'gpt-x', null],
    ]);
  });
});

describe('substitution headers, trace and outcome', () => {
  let proxy: Proxy;
  let requests = 0;
  before(async () => {
    proxy = await startProxy();
  });
  after(async () => {
    await proxy.close();
  });
  afterEach(() => {
    clearRequestOutcomeListeners();
  });

  /** Sends one request to the shared proxy and returns it with its reported result. */
  async function run(send: (p: Proxy) => Promise<TestResponse>) {
    const index = requests;
    requests += 1;
    const res = await send(proxy);
    return { res, result: await proxy.result(index) };
  }

  test('a provider switch of the same model: substituted false, no group header, null in trace and outcome', async () => {
    const capture = captureOutcomes();
    const { res, result } = await run((p) => chat(p, { model: 'gpt-x', messages: HELLO }));
    assert.equal(res.status, 200);
    assert.deepEqual(modelHeaders(res.headers), {
      provider: 'openrouter',
      model: 'openai/gpt-x',
      requested: 'gpt-x',
      substituted: 'false',
      group: undefined,
    });
    assert.deepEqual(traceRows(result), [['openrouter', 'openai/gpt-x', 'ok', null]]);
    const outcome = await capture.outcomeFor(res);
    assert.equal(outcome.substitution, null);
    assert.equal(outcome.trace[0]?.substitution, null);
    capture.stop();
  });

  test('a substitution inside a preset: substituted true with the group, in headers, trace and outcome', async () => {
    const capture = captureOutcomes();
    const { res, result } = await run((p) => chat(p, { model: 'gpt-6-astra', messages: HELLO }));
    assert.equal(res.status, 200);
    assert.deepEqual(modelHeaders(res.headers), {
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      requested: 'gpt-6-astra',
      substituted: 'true',
      group: 'frontier',
    });
    assert.equal(res.headers['x-tollwise-routed'], 'true');
    assert.equal(res.headers['x-tollwise-translated'], 'false');
    assert.deepEqual(traceRows(result), [['deepseek', 'deepseek-v4-pro', 'ok', FRONTIER_TO_DEEPSEEK]]);
    const outcome = await capture.outcomeFor(res);
    assert.deepEqual(outcome.substitution, FRONTIER_TO_DEEPSEEK);
    assert.deepEqual(outcome.trace[0]?.substitution, FRONTIER_TO_DEEPSEEK);
    // The selection and price fields are unchanged by the new field.
    assert.equal(outcome.usedModel, 'deepseek-v4-pro');
    assert.equal(outcome.requestedModel, 'gpt-6-astra');
    // Anthropic is left out: without max_tokens the request cannot be translated to its format.
    assert.deepEqual(
      outcome.selection?.candidates.map((candidate) => candidate.model),
      ['deepseek-v4-pro', 'openai/gpt-6-astra', 'gpt-6-astra'],
    );
    assert.equal(outcome.price?.used?.input, 1);
    capture.stop();
  });

  test('a streamed OpenAI answer carries the same headers', async () => {
    const { res, result } = await run((p) => chat(p, { model: 'gpt-6-astra', messages: HELLO, stream: true }));
    assert.equal(res.status, 200);
    assert.match(String(res.headers['content-type']), /^text\/event-stream/);
    assert.ok(res.text.includes('data: [DONE]'));
    assert.deepEqual(modelHeaders(res.headers), {
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      requested: 'gpt-6-astra',
      substituted: 'true',
      group: 'frontier',
    });
    assert.deepEqual(traceRows(result), [['deepseek', 'deepseek-v4-pro', 'ok', FRONTIER_TO_DEEPSEEK]]);
  });

  test('a cross-format substitution: an Anthropic request translated to the OpenAI format', async () => {
    const capture = captureOutcomes();
    const { res } = await run((p) => messages(p, { model: 'claude-opus-5', max_tokens: 64, messages: HELLO }));
    assert.equal(res.status, 200);
    assert.equal((res.json as { type: string }).type, 'message');
    assert.equal(res.headers['x-tollwise-translated'], 'true');
    assert.deepEqual(modelHeaders(res.headers), {
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      requested: 'claude-opus-5',
      substituted: 'true',
      group: 'frontier',
    });
    const outcome = await capture.outcomeFor(res);
    assert.deepEqual(outcome.substitution, {
      requested_model: 'claude-opus-5',
      served_model: 'deepseek-v4-pro',
      group: 'frontier',
    });
    capture.stop();
  });

  test('a streamed Anthropic answer carries the same headers', async () => {
    const { res } = await run((p) =>
      messages(p, { model: 'claude-opus-5', max_tokens: 64, messages: HELLO, stream: true }),
    );
    assert.equal(res.status, 200);
    assert.match(String(res.headers['content-type']), /^text\/event-stream/);
    assert.ok(res.text.includes('event: message_stop'));
    assert.equal(res.headers['x-tollwise-translated'], 'true');
    assert.deepEqual(modelHeaders(res.headers), {
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      requested: 'claude-opus-5',
      substituted: 'true',
      group: 'frontier',
    });
  });
});

describe('substitution headers after a failure, on errors, passthrough and refusal', () => {
  afterEach(() => {
    clearRequestOutcomeListeners();
  });

  test('a substitute fails and the requested model serves: headers describe the serving provider', async () => {
    const proxy = await startProxy({ mocks: { deepseek: { failWith: { status: 500 } } } });
    const capture = captureOutcomes();
    try {
      const res = await chat(proxy, { model: 'gpt-6-astra', messages: HELLO });
      assert.equal(res.status, 200);
      assert.equal(res.headers['x-tollwise-attempts'], '2');
      assert.deepEqual(modelHeaders(res.headers), {
        provider: 'openrouter',
        model: 'openai/gpt-6-astra',
        requested: 'gpt-6-astra',
        substituted: 'false',
        group: undefined,
      });
      assert.deepEqual(traceRows(await proxy.result(0)), [
        ['deepseek', 'deepseek-v4-pro', 'server', FRONTIER_TO_DEEPSEEK],
        ['openrouter', 'openai/gpt-6-astra', 'ok', null],
      ]);
      const outcome = await capture.outcomeFor(res);
      assert.equal(outcome.substitution, null);
      assert.deepEqual(
        outcome.trace.map((attempt) => attempt.substitution),
        [FRONTIER_TO_DEEPSEEK, null],
      );
    } finally {
      capture.stop();
      await proxy.close();
    }
  });

  test('the requested model fails and a substitute serves: headers describe the serving provider', async () => {
    const proxy = await startProxy({ mocks: { deepseek: { failWith: { status: 503 } } } });
    const capture = captureOutcomes();
    try {
      const res = await chat(proxy, { model: 'deepseek-v4-pro', messages: HELLO });
      assert.equal(res.status, 200);
      assert.equal(res.headers['x-tollwise-attempts'], '2');
      assert.deepEqual(modelHeaders(res.headers), {
        provider: 'openrouter',
        model: 'openai/gpt-6-astra',
        requested: 'deepseek-v4-pro',
        substituted: 'true',
        group: 'frontier',
      });
      const served = { requested_model: 'deepseek-v4-pro', served_model: 'openai/gpt-6-astra', group: 'frontier' };
      assert.deepEqual(traceRows(await proxy.result(0)), [
        ['deepseek', 'deepseek-v4-pro', 'overloaded', null],
        ['openrouter', 'openai/gpt-6-astra', 'ok', served],
      ]);
      assert.deepEqual((await capture.outcomeFor(res)).substitution, served);
    } finally {
      capture.stop();
      await proxy.close();
    }
  });

  test('every attempt failed: the error carries the headers of the last provider tried', async () => {
    const proxy = await startProxy({
      mocks: { deepseek: { failWith: { status: 503 } }, openrouter: { failWith: { status: 500 } } },
    });
    try {
      const res = await chat(proxy, { model: 'gpt-6-astra', messages: HELLO });
      // retries 1: deepseek (a substitute) then openrouter (the requested model) were tried.
      assert.ok(res.status >= 500, `status ${res.status}`);
      assert.equal(res.headers['x-tollwise-attempts'], '2');
      assert.deepEqual(modelHeaders(res.headers), {
        provider: 'openrouter',
        model: 'openai/gpt-6-astra',
        requested: 'gpt-6-astra',
        substituted: 'false',
        group: undefined,
      });
    } finally {
      await proxy.close();
    }
  });

  test('a routed error from a substitute keeps the substitution headers', async () => {
    const proxy = await startProxy({
      routing: { equivalence_presets: ['frontier'], retries: 0 },
      mocks: { deepseek: { failWith: { status: 500 } } },
    });
    const capture = captureOutcomes();
    try {
      const res = await chat(proxy, { model: 'gpt-6-astra', messages: HELLO });
      assert.ok(res.status >= 500, `status ${res.status}`);
      assert.deepEqual(modelHeaders(res.headers), {
        provider: 'deepseek',
        model: 'deepseek-v4-pro',
        requested: 'gpt-6-astra',
        substituted: 'true',
        group: 'frontier',
      });
      const outcome = await capture.outcomeFor(res);
      assert.deepEqual(outcome.substitution, FRONTIER_TO_DEEPSEEK);
    } finally {
      capture.stop();
      await proxy.close();
    }
  });

  test('a provider rejecting a substituted request (not retried) keeps the substitution headers', async () => {
    const proxy = await startProxy({ mocks: { deepseek: { failWith: { status: 400, message: 'bad request' } } } });
    try {
      const res = await chat(proxy, { model: 'gpt-6-astra', messages: HELLO });
      assert.equal(res.status, 400);
      assert.equal(res.headers['x-tollwise-substituted'], 'true');
      assert.equal(res.headers['x-tollwise-equivalence-group'], 'frontier');
      assert.equal(res.headers['x-tollwise-requested-model'], 'gpt-6-astra');
    } finally {
      await proxy.close();
    }
  });

  test('a passthrough is never a substitution', async () => {
    const proxy = await startProxy({ routing: { equivalence_presets: ['frontier'], on_no_candidate: 'passthrough' } });
    const capture = captureOutcomes();
    try {
      const res = await chat(proxy, { model: 'unlisted-model', messages: HELLO });
      assert.equal(res.status, 200);
      assert.equal(res.headers['x-tollwise-routed'], 'false');
      assert.deepEqual(modelHeaders(res.headers), {
        provider: 'openai',
        model: 'unlisted-model',
        requested: 'unlisted-model',
        substituted: 'false',
        group: undefined,
      });
      const outcome = await capture.outcomeFor(res);
      assert.equal(outcome.decision, 'passthrough');
      assert.equal(outcome.substitution, null);
      assert.equal(outcome.trace[0]?.substitution, null);
    } finally {
      capture.stop();
      await proxy.close();
    }
  });

  test('a refused request says what was asked for and that nothing was substituted', async () => {
    const proxy = await startProxy({ routing: { equivalence_presets: ['frontier'], on_no_candidate: 'fail' } });
    const capture = captureOutcomes();
    try {
      const res = await messages(proxy, { model: 'unlisted-model', max_tokens: 64, messages: HELLO });
      assert.equal(res.status, 422);
      assert.equal(res.headers['x-tollwise-routed'], 'false');
      assert.equal(res.headers['x-tollwise-provider'], undefined);
      assert.equal(res.headers['x-tollwise-requested-model'], 'unlisted-model');
      assert.equal(res.headers['x-tollwise-substituted'], 'false');
      assert.equal(res.headers['x-tollwise-equivalence-group'], undefined);
      const outcome = await capture.outcomeFor(res);
      assert.equal(outcome.status, 'refused');
      assert.equal(outcome.substitution, null);
      assert.deepEqual(outcome.trace, []);
    } finally {
      capture.stop();
      await proxy.close();
    }
  });
});

describe('header injection: client model ids and configured group names can never add a header line', () => {
  const INJECTED = 'x-injected';

  function assertNoInjection(res: TestResponse): void {
    assert.equal(res.headers[INJECTED], undefined, 'no header was injected');
    for (const [name, value] of Object.entries(res.headers)) {
      if (!name.startsWith('x-tollwise-')) continue;
      assert.match(String(value), /^[\x20-\x7e]*$/, `${name} is printable ASCII`);
    }
  }

  test('a group name with CR/LF is percent-encoded in x-tollwise-equivalence-group', async () => {
    const name = `minis\r\n${INJECTED}: 1`;
    const proxy = await startProxy({ routing: { equivalence_groups: [{ name, models: ['mini-a', 'mini-b'] }] } });
    const capture = captureOutcomes();
    try {
      const res = await chat(proxy, { model: 'mini-a', messages: HELLO });
      assert.equal(res.status, 200);
      assertNoInjection(res);
      assert.equal(res.headers['x-tollwise-substituted'], 'true');
      assert.equal(res.headers['x-tollwise-equivalence-group'], encodeURIComponent(name));
      assert.equal(decodeURIComponent(String(res.headers['x-tollwise-equivalence-group'])), name);
      // The group name is configuration, not client input: the outcome keeps it as written.
      assert.equal((await capture.outcomeFor(res)).substitution?.group, name);
    } finally {
      capture.stop();
      await proxy.close();
    }
  });

  test('a non-ASCII group name is percent-encoded in x-tollwise-equivalence-group', async () => {
    const name = 'kleine Modelle – günstig';
    const proxy = await startProxy({ routing: { equivalence_groups: [{ name, models: ['mini-a', 'mini-b'] }] } });
    try {
      const res = await chat(proxy, { model: 'mini-a', messages: HELLO, stream: true });
      assert.equal(res.status, 200);
      assertNoInjection(res);
      assert.equal(res.headers['x-tollwise-equivalence-group'], encodeURIComponent(name));
    } finally {
      await proxy.close();
    }
  });

  test('a requested model with CR/LF or non-ASCII is percent-encoded in x-tollwise-requested-model', async () => {
    const proxy = await startProxy({ routing: { on_no_candidate: 'passthrough' } });
    try {
      for (const model of [`evil\r\n${INJECTED}: 1`, 'modèle-ü']) {
        const res = await chat(proxy, { model, messages: HELLO });
        assertNoInjection(res);
        assert.equal(res.headers['x-tollwise-requested-model'], encodeURIComponent(model));
        assert.equal(res.headers['x-tollwise-model'], encodeURIComponent(model));
      }
    } finally {
      await proxy.close();
    }
    const refusing = await startProxy({ routing: { on_no_candidate: 'fail' } });
    try {
      const model = `evil\r\n${INJECTED}: 1`;
      const res = await messages(refusing, { model, max_tokens: 64, messages: HELLO });
      assert.equal(res.status, 422);
      assertNoInjection(res);
      assert.equal(res.headers['x-tollwise-requested-model'], encodeURIComponent(model));
    } finally {
      await refusing.close();
    }
  });

  test('headerSafeValue keeps printable ASCII and encodes everything else', () => {
    assert.equal(headerSafeValue('frontier'), 'frontier');
    assert.equal(headerSafeValue('a b/c:d'), 'a b/c:d');
    assert.equal(headerSafeValue('a\r\nb'), 'a%0D%0Ab');
    assert.equal(headerSafeValue('a\tb'), 'a%09b');
    assert.equal(headerSafeValue('ü'), '%C3%BC');
  });
});

describe('masking: model ids of a substitution are masked like the rest of the outcome', () => {
  test('a key-shaped model id in a substitution is redacted; the group name is kept', () => {
    const pasted = FAKE_KEYS['Anthropic API key']?.text;
    assert.ok(pasted !== undefined);
    const masked = maskSubstitution({ requested_model: pasted, served_model: `x ${pasted}`, group: 'frontier' });
    assert.ok(masked !== null);
    assert.ok(!JSON.stringify(masked).includes(pasted));
    assert.equal(masked.group, 'frontier');
    assert.equal(maskSubstitution(null), null);
  });

  test('buildRequestOutcome masks the substitution and every trace attempt substitution', () => {
    const pasted = FAKE_KEYS['OpenAI API key']?.text;
    assert.ok(pasted !== undefined);
    const substitution = { requested_model: pasted, served_model: 'deepseek-v4-pro', group: 'frontier' };
    const outcome = buildRequestOutcome({
      timestamp: new Date().toISOString(),
      requestId: 'r1',
      format: 'openai',
      requestedModel: pasted,
      requestedProvider: 'openai',
      usedModel: 'deepseek-v4-pro',
      usedProvider: 'deepseek',
      needs: { tools: false, json_mode: false, vision: false, streaming: false },
      policy: 'cheapest',
      decision: 'routed',
      attempts: 1,
      trace: [
        { provider: 'deepseek', model: 'deepseek-v4-pro', outcome: 'ok', status: 200, duration_ms: 5, substitution },
      ],
      usage: null,
      cost: null,
      latencyMs: 5,
      firstByteMs: null,
      status: 'complete',
      selection: null,
      price: null,
      substitution,
    });
    assert.ok(!JSON.stringify(outcome).includes(pasted));
    assert.equal(outcome.substitution?.served_model, 'deepseek-v4-pro');
    assert.equal(outcome.trace[0]?.substitution?.group, 'frontier');
  });

  test('the local API shows the substitution on the entry, and its trace attempts without it', () => {
    const substitution = { requested_model: 'gpt-6-astra', served_model: 'deepseek-v4-pro', group: 'frontier' };
    const entry = toRecentEntry({
      timestamp: new Date().toISOString(),
      requestId: 'r2',
      format: 'openai',
      requestedModel: 'gpt-6-astra',
      requestedProvider: 'openai',
      usedModel: 'deepseek-v4-pro',
      usedProvider: 'deepseek',
      needs: { tools: false, json_mode: false, vision: false, streaming: false },
      policy: 'cheapest',
      decision: 'routed',
      attempts: 1,
      trace: [
        { provider: 'deepseek', model: 'deepseek-v4-pro', outcome: 'ok', status: 200, duration_ms: 5, substitution },
      ],
      usage: null,
      cost: null,
      latencyMs: 5,
      firstByteMs: null,
      status: 'complete',
      selection: null,
      price: null,
      substitution,
    });
    assert.deepEqual(entry.trace, [
      { provider: 'deepseek', model: 'deepseek-v4-pro', outcome: 'ok', status: 200, duration_ms: 5 },
    ]);
    assert.equal(entry.substituted, true);
    assert.deepEqual(entry.substitution, substitution);
  });
});
