import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { describe, test } from 'node:test';
import type { Catalog, ModelEntry } from '../src/catalog/schema.ts';
import { type Config, type ConfigInput, ConfigSchema, type ProviderId } from '../src/config/schema.ts';
import type { HealthMonitor } from '../src/health/monitor.ts';
import { createLogger, type LogSink } from '../src/log/logger.ts';
import { buildRegistry } from '../src/providers/registry.ts';
import { type ProxyRequestResult, RETRYABLE_ERROR_KINDS } from '../src/proxy/forward.ts';
import { baseUrl, createTollwiseServer, listen, stopServer } from '../src/server/server.ts';
import { FAKE_KEYS } from './fixtures/fake-keys.ts';
import { freePort, send, type TestResponse } from './fixtures/http-client.ts';
import { type MockProvider, type StartMockProviderOptions, startMockProvider } from './fixtures/mock-provider.ts';

// Fake credentials with no known key shape; none of them is a real key.
const FAKE_OPENAI_KEY = `fakeOpenai${'Oa1'.repeat(6)}`;
const FAKE_OPENROUTER_KEY = `fakeRouter${'Or2'.repeat(6)}`;
const FAKE_DEEPSEEK_KEY = `fakeDeep${'Ds3'.repeat(6)}`;
const FAKE_ANTHROPIC_KEY = `fakeClaude${'An4'.repeat(6)}`;

const ENV = {
  OPENAI_API_KEY: FAKE_OPENAI_KEY,
  OPENROUTER_API_KEY: FAKE_OPENROUTER_KEY,
  DEEPSEEK_API_KEY: FAKE_DEEPSEEK_KEY,
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
 * - gpt-x: four OpenAI-format providers; cheapest first: deepseek, openrouter, ollama, openai.
 * - claude-x: three Anthropic entries on the Anthropic provider; cheapest first: claude-x, claude-x-mid,
 *   claude-x-20260901. Fallback onto a provider of the other format is covered in cross-format.test.ts.
 */
const CATALOG: Catalog = {
  models: [
    entry('openai', 'gpt-x', 'gpt-x', 4),
    entry('ollama', 'local-gpt-x', 'gpt-x', 3),
    entry('openrouter', 'openai/gpt-x', 'gpt-x', 2),
    entry('deepseek', 'deep-gpt-x', 'gpt-x', 1),
    entry('anthropic', 'claude-x-20260901', 'claude-x', 3),
    entry('anthropic', 'claude-x-mid', 'claude-x', 2),
    entry('anthropic', 'claude-x', 'claude-x', 1),
  ],
};

/** The OpenAI-format providers in the order routing tries them for gpt-x. */
const GPT_ORDER = ['deepseek', 'openrouter', 'ollama', 'openai'] as const;
type OpenAiFormatProvider = (typeof GPT_ORDER)[number];

const HELLO = [{ role: 'user', content: 'Say hello.' }];
const JSON_TYPE = { 'content-type': 'application/json' } as const;
const MESSAGES_HEADERS = { ...JSON_TYPE, 'anthropic-version': '2023-06-01' } as const;

interface LatencySample {
  readonly provider: ProviderId;
  readonly ms: number;
}

/** A health monitor that only records the latency samples it is fed. */
function recordingMonitor(samples: LatencySample[]): HealthMonitor {
  return {
    start: () => undefined,
    stop: () => undefined,
    checkNow: async () => undefined,
    recordLatency: (provider, ms) => {
      samples.push({ provider, ms });
    },
    snapshot: () => ({ providers: [] }),
  };
}

interface Proxy {
  readonly url: string;
  readonly mocks: Readonly<Record<OpenAiFormatProvider | 'anthropic', MockProvider>>;
  readonly log: string[];
  readonly results: ProxyRequestResult[];
  readonly samples: LatencySample[];
  /** Resolves with the result of the n-th proxied request (0-based) once it is reported. */
  result(index: number): Promise<ProxyRequestResult>;
  close(): Promise<void>;
}

interface ProxyOptions {
  readonly routing?: ConfigInput['routing'];
  readonly mocks?: Partial<Record<OpenAiFormatProvider | 'anthropic', StartMockProviderOptions>>;
  /** Base URL used instead of a provider's mock (e.g. a closed port or a hand-written server). */
  readonly baseUrls?: Partial<Record<OpenAiFormatProvider | 'anthropic', string>>;
}

async function startProxy(options: ProxyOptions = {}): Promise<Proxy> {
  const mock = (id: OpenAiFormatProvider | 'anthropic') => startMockProvider(options.mocks?.[id] ?? {});
  const mocks = {
    deepseek: await mock('deepseek'),
    openrouter: await mock('openrouter'),
    ollama: await mock('ollama'),
    openai: await mock('openai'),
    anthropic: await mock('anthropic'),
  };
  const url = (id: OpenAiFormatProvider | 'anthropic', fallback: string) => options.baseUrls?.[id] ?? fallback;
  const config: Config = ConfigSchema.parse({
    providers: {
      openai: { base_url: url('openai', `${mocks.openai.url}/v1`) },
      openrouter: { base_url: url('openrouter', `${mocks.openrouter.url}/v1`) },
      deepseek: { base_url: url('deepseek', `${mocks.deepseek.url}/v1`) },
      ollama: { base_url: url('ollama', mocks.ollama.url) },
      anthropic: { base_url: url('anthropic', mocks.anthropic.url) },
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
  const samples: LatencySample[] = [];
  const waiters: (() => void)[] = [];
  const server: Server = createTollwiseServer({
    maxBodyBytes: 64 * 1024,
    logger: createLogger({ level: 'debug', sink }),
    healthMonitor: recordingMonitor(samples),
    proxy: {
      config,
      catalog: CATALOG,
      registry: buildRegistry(config, ENV),
      env: ENV,
      onRequestResult: (result) => {
        results.push(result);
        for (const wake of waiters.splice(0)) wake();
      },
    },
  });
  const address = await listen(server, '127.0.0.1', 0);
  return {
    url: baseUrl('127.0.0.1', address.port),
    mocks,
    log: lines,
    results,
    samples,
    async result(index: number) {
      const deadline = performance.now() + 3000;
      while (results[index] === undefined) {
        if (performance.now() > deadline) throw new Error(`no result for request ${index}`);
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          setTimeout(resolve, 50);
        });
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

function messages(proxy: Proxy, body: Record<string, unknown>): Promise<TestResponse> {
  return send(proxy.url, '/v1/messages', { method: 'POST', headers: MESSAGES_HEADERS, body: JSON.stringify(body) });
}

function postCount(mock: MockProvider): number {
  return mock.requests.filter((request) => request.method === 'POST').length;
}

/** How many chat calls each OpenAI-format provider received, in routing order. */
function gptCalls(proxy: Proxy): number[] {
  return GPT_ORDER.map((id) => postCount(proxy.mocks[id]));
}

/** The trace without durations, as [provider, model, outcome, status] rows. */
function traceRows(result: ProxyRequestResult): [string, string, string, number | null][] {
  return result.attempts.map((attempt) => [attempt.provider, attempt.model, attempt.outcome, attempt.status]);
}

function errorOf(res: TestResponse): { message: string; type: string; code: string } {
  return (res.json as { error: { message: string; type: string; code: string } }).error;
}

const FAIL_500 = { failWith: { status: 500, message: 'upstream exploded at host internal-7' } };

describe('fallback: which failures move a request to the next candidate', () => {
  test('only connection, timeout, rate-limit, server and overloaded errors are retried', () => {
    assert.deepEqual([...RETRYABLE_ERROR_KINDS].sort(), [
      'connection',
      'overloaded',
      'rate_limit',
      'server',
      'timeout',
    ]);
  });

  test('a 429 moves the request to the next candidate, which serves it', async () => {
    const proxy = await startProxy({ mocks: { deepseek: { failWith: { status: 429, message: 'slow down' } } } });
    try {
      const res = await chat(proxy, { model: 'gpt-x', messages: HELLO });
      assert.equal(res.status, 200);
      assert.equal(res.headers['x-tollwise-provider'], 'openrouter');
      assert.equal(res.headers['x-tollwise-model'], 'openai/gpt-x');
      assert.equal(res.headers['x-tollwise-attempts'], '2');
      assert.equal((res.json as { model: string }).model, 'openai/gpt-x');
      assert.deepEqual(gptCalls(proxy), [1, 1, 0, 0]);
      const result = await proxy.result(0);
      assert.equal(result.outcome, 'complete');
      assert.equal(result.provider, 'openrouter');
      assert.deepEqual(traceRows(result), [
        ['deepseek', 'deep-gpt-x', 'rate_limit', 429],
        ['openrouter', 'openai/gpt-x', 'ok', 200],
      ]);
    } finally {
      await proxy.close();
    }
  });

  test('a 500 moves the request to the next candidate, which serves it', async () => {
    const proxy = await startProxy({ mocks: { deepseek: FAIL_500 } });
    try {
      const res = await chat(proxy, { model: 'gpt-x', messages: HELLO });
      assert.equal(res.status, 200);
      assert.equal(res.headers['x-tollwise-provider'], 'openrouter');
      assert.equal(res.headers['x-tollwise-attempts'], '2');
      assert.deepEqual(traceRows(await proxy.result(0)), [
        ['deepseek', 'deep-gpt-x', 'server', 500],
        ['openrouter', 'openai/gpt-x', 'ok', 200],
      ]);
    } finally {
      await proxy.close();
    }
  });

  test('a 503 and a 529 are overloaded errors and move on too', async () => {
    const proxy = await startProxy({
      routing: { retries: 2 },
      mocks: { deepseek: { failWith: { status: 503 } }, openrouter: { failWith: { status: 529 } } },
    });
    try {
      const res = await chat(proxy, { model: 'gpt-x', messages: HELLO });
      assert.equal(res.status, 200);
      assert.equal(res.headers['x-tollwise-provider'], 'ollama');
      assert.deepEqual(
        (await proxy.result(0)).attempts.map((attempt) => attempt.outcome),
        ['overloaded', 'overloaded', 'ok'],
      );
    } finally {
      await proxy.close();
    }
  });

  test('a provider that does not answer in time moves the request to the next candidate', async () => {
    const proxy = await startProxy({
      mocks: { deepseek: { hang: true } },
      routing: { timeouts: { connect_ms: 1000, first_byte_ms: 200, total_ms: 2000 } },
    });
    try {
      const started = performance.now();
      const res = await chat(proxy, { model: 'gpt-x', messages: HELLO });
      assert.equal(res.status, 200);
      assert.equal(res.headers['x-tollwise-provider'], 'openrouter');
      assert.ok(performance.now() - started < 1500, 'the fallback happened after first_byte_ms, not total_ms');
      const result = await proxy.result(0);
      assert.deepEqual(traceRows(result), [
        ['deepseek', 'deep-gpt-x', 'timeout', null],
        ['openrouter', 'openai/gpt-x', 'ok', 200],
      ]);
      const timedOut = result.attempts[0];
      assert.ok(timedOut !== undefined && timedOut.duration_ms >= 190, 'the timeout attempt lasted first_byte_ms');
    } finally {
      await proxy.close();
    }
  });

  test('an unreachable provider moves the request to the next candidate', async () => {
    const closedPort = await freePort();
    const proxy = await startProxy({ baseUrls: { deepseek: `http://127.0.0.1:${closedPort}/v1` } });
    try {
      const res = await chat(proxy, { model: 'gpt-x', messages: HELLO });
      assert.equal(res.status, 200);
      assert.equal(res.headers['x-tollwise-provider'], 'openrouter');
      assert.deepEqual(traceRows(await proxy.result(0)), [
        ['deepseek', 'deep-gpt-x', 'connection', null],
        ['openrouter', 'openai/gpt-x', 'ok', 200],
      ]);
    } finally {
      await proxy.close();
    }
  });

  for (const status of [400, 401, 403, 404, 422]) {
    test(`a ${status} is not retried and comes back with its status in the OpenAI shape`, async () => {
      const proxy = await startProxy({
        routing: { retries: 3 },
        mocks: { deepseek: { failWith: { status, message: `refused with ${status}` } } },
      });
      try {
        const res = await chat(proxy, { model: 'gpt-x', messages: HELLO });
        assert.equal(res.status, status);
        assert.equal(res.headers['x-tollwise-provider'], 'deepseek');
        assert.equal(res.headers['x-tollwise-attempts'], '1');
        assert.equal(
          errorOf(res).message,
          `The deepseek provider answered with HTTP ${status}: refused with ${status}`,
        );
        assert.deepEqual(gptCalls(proxy), [1, 0, 0, 0]);
        const result = await proxy.result(0);
        assert.equal(result.outcome, 'provider_error');
        assert.equal(result.status, status);
        assert.equal(result.attempts.length, 1);
      } finally {
        await proxy.close();
      }
    });
  }

  test('a 400 on /v1/messages is not retried and comes back in the Anthropic shape', async () => {
    const proxy = await startProxy({
      mocks: {
        anthropic: {
          responses: [{ failWith: { status: 400, type: 'invalid_request_error', message: 'messages: required' } }],
        },
      },
    });
    try {
      const res = await messages(proxy, { model: 'claude-x', max_tokens: 64, messages: HELLO });
      assert.equal(res.status, 400);
      assert.deepEqual(res.json, {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'The anthropic provider answered with HTTP 400: messages: required',
        },
      });
      assert.equal(postCount(proxy.mocks.anthropic), 1);
      assert.equal(postCount(proxy.mocks.openrouter), 0);
    } finally {
      await proxy.close();
    }
  });

  test('a 429 on /v1/messages moves on to the next Anthropic-format candidate only', async () => {
    const proxy = await startProxy({
      mocks: { anthropic: { responses: [{ failWith: { status: 429, type: 'rate_limit_error' } }] } },
    });
    try {
      const res = await messages(proxy, { model: 'claude-x', max_tokens: 64, messages: HELLO });
      assert.equal(res.status, 200);
      assert.equal(res.headers['x-tollwise-model'], 'claude-x-mid');
      assert.equal(res.headers['x-tollwise-attempts'], '2');
      assert.equal((res.json as { model: string }).model, 'claude-x-mid');
      // The cheapest claude-x entry is on OpenRouter, in the OpenAI format: never tried from /v1/messages.
      assert.equal(postCount(proxy.mocks.openrouter), 0);
      assert.deepEqual(traceRows(await proxy.result(0)), [
        ['anthropic', 'claude-x', 'rate_limit', 429],
        ['anthropic', 'claude-x-mid', 'ok', 200],
      ]);
    } finally {
      await proxy.close();
    }
  });
});

describe('fallback: the retry budget (routing.retries)', () => {
  const allFail = { deepseek: FAIL_500, openrouter: FAIL_500, ollama: FAIL_500, openai: FAIL_500 };

  for (const [retries, calls] of [
    [0, [1, 0, 0, 0]],
    [1, [1, 1, 0, 0]],
    [2, [1, 1, 1, 0]],
    [5, [1, 1, 1, 1]],
  ] as const) {
    test(`with retries ${retries}, ${Math.min(retries + 1, 4)} candidate(s) are tried and no more`, async () => {
      const proxy = await startProxy({ routing: { retries }, mocks: allFail });
      try {
        const res = await chat(proxy, { model: 'gpt-x', messages: HELLO });
        assert.equal(res.status, 502);
        assert.deepEqual(gptCalls(proxy), calls);
        const tried = calls.filter((count) => count === 1).length;
        assert.equal(res.headers['x-tollwise-attempts'], String(tried));
        assert.equal((await proxy.result(0)).attempts.length, tried);
      } finally {
        await proxy.close();
      }
    });
  }

  test('when every attempt fails the answer is a 502 in the OpenAI shape listing the error kinds', async () => {
    const closedPort = await freePort();
    // deepseek is rate limited, openrouter fails with a 500 carrying a message, ollama is unreachable.
    const proxy = await startProxy({
      routing: { retries: 2 },
      baseUrls: { ollama: `http://127.0.0.1:${closedPort}` },
      mocks: {
        deepseek: { failWith: { status: 429, message: 'Rate limit reached for org-internal-42' } },
        openrouter: FAIL_500,
      },
    });
    try {
      const res = await chat(proxy, { model: 'gpt-x', messages: HELLO });
      assert.equal(res.status, 502);
      assert.deepEqual(errorOf(res), {
        message:
          'Tollwise tried 3 providers and every attempt failed: deepseek model deep-gpt-x (rate_limit, HTTP 429), ' +
          'openrouter model openai/gpt-x (server, HTTP 500), ollama model local-gpt-x (connection).',
        type: 'server_error',
        param: null,
        code: 'all_providers_failed',
      });
      assert.equal(res.headers['x-tollwise-provider'], 'ollama');
      assert.equal(res.headers['x-tollwise-attempts'], '3');
      assert.match(String(res.headers['x-tollwise-request-id']), /^[0-9a-f-]{36}$/);
      // No provider message reaches the client.
      assert.ok(!res.text.includes('org-internal-42'));
      assert.ok(!res.text.includes('upstream exploded'));
      assert.equal(postCount(proxy.mocks.openai), 0);
      const result = await proxy.result(0);
      assert.equal(result.status, 502);
      assert.equal(result.outcome, 'provider_error');
      assert.equal(result.usage, null);
    } finally {
      await proxy.close();
    }
  });
});

describe('fallback: streaming', () => {
  test('a stream that fails after its first byte is cut, never retried on another provider', async () => {
    const proxy = await startProxy({ mocks: { deepseek: { dropMidStream: true } } });
    try {
      const res = await send(proxy.url, '/v1/chat/completions', {
        method: 'POST',
        headers: JSON_TYPE,
        body: JSON.stringify({ model: 'gpt-x', messages: HELLO, stream: true }),
      }).catch((error: unknown) => error);
      // The client either sees the body end early or the connection reset; never another provider's answer.
      if (!(res instanceof Error)) {
        assert.equal((res as TestResponse).status, 200);
        assert.ok(!(res as TestResponse).text.includes('[DONE]'));
      }
      const result = await proxy.result(0);
      assert.equal(result.outcome, 'interrupted');
      assert.equal(result.provider, 'deepseek');
      assert.deepEqual(traceRows(result), [['deepseek', 'deep-gpt-x', 'ok', 200]]);
      assert.deepEqual(gptCalls(proxy), [1, 0, 0, 0]);
    } finally {
      await proxy.close();
    }
  });

  test('an Anthropic stream that fails after its first byte is not retried either', async () => {
    const proxy = await startProxy({ mocks: { anthropic: { dropMidStream: true } } });
    try {
      await send(proxy.url, '/v1/messages', {
        method: 'POST',
        headers: MESSAGES_HEADERS,
        body: JSON.stringify({ model: 'claude-x', max_tokens: 64, messages: HELLO, stream: true }),
      }).catch(() => undefined);
      const result = await proxy.result(0);
      assert.equal(result.outcome, 'interrupted');
      assert.equal(postCount(proxy.mocks.anthropic), 1);
      assert.equal(result.attempts.length, 1);
    } finally {
      await proxy.close();
    }
  });

  test('a non-streamed body that fails after the response head is cut, never retried', async () => {
    const partial = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': '200' });
        res.write('{"id":"chatcmpl-1",', () => res.destroy());
      });
    });
    const port = (await listen(partial, '127.0.0.1', 0)).port;
    const proxy = await startProxy({ baseUrls: { deepseek: `http://127.0.0.1:${port}/v1` } });
    try {
      await chat(proxy, { model: 'gpt-x', messages: HELLO }).catch(() => undefined);
      const result = await proxy.result(0);
      assert.equal(result.outcome, 'interrupted');
      assert.equal(result.provider, 'deepseek');
      assert.deepEqual(gptCalls(proxy), [0, 0, 0, 0]);
      assert.equal(result.attempts.length, 1);
    } finally {
      await proxy.close();
      await stopServer(partial, 100);
    }
  });
});

describe('fallback: the routing trace', () => {
  test('each attempt holds exactly provider, model, outcome, status, duration_ms and substitution, and no URL, header or body', async () => {
    const proxy = await startProxy({
      routing: { retries: 2 },
      mocks: {
        deepseek: { failWith: { status: 429, message: 'limit for sk-internal hidden detail' } },
        openrouter: { failWith: { status: 500, message: 'upstream exploded at host internal-7' } },
      },
    });
    try {
      const res = await chat(proxy, { model: 'gpt-x', messages: HELLO });
      assert.equal(res.status, 200);
      assert.equal(res.headers['x-tollwise-attempts'], '3');
      const result = await proxy.result(0);
      assert.equal(result.requestId, res.headers['x-tollwise-request-id']);
      for (const attempt of result.attempts) {
        assert.deepEqual(Object.keys(attempt).sort(), [
          'duration_ms',
          'model',
          'outcome',
          'provider',
          'status',
          'substitution',
        ]);
        assert.equal(attempt.substitution, null);
        assert.ok(Number.isInteger(attempt.duration_ms) && attempt.duration_ms >= 0);
      }
      assert.deepEqual(traceRows(result), [
        ['deepseek', 'deep-gpt-x', 'rate_limit', 429],
        ['openrouter', 'openai/gpt-x', 'server', 500],
        ['ollama', 'local-gpt-x', 'ok', 200],
      ]);

      // The trace is logged once, with the same content, and neither it nor any line carries a URL, a
      // key, a header or a provider message.
      const traceLines = proxy.log.filter((line) => line.includes('chat request attempts'));
      assert.equal(traceLines.length, 1);
      const logged = JSON.parse(traceLines[0] as string) as { attempts: unknown; requestId: string };
      assert.deepEqual(logged.attempts, result.attempts);
      assert.equal(logged.requestId, result.requestId);
      const everything = JSON.stringify(result.attempts) + proxy.log.join('');
      for (const forbidden of [
        proxy.mocks.deepseek.url,
        proxy.mocks.openrouter.url,
        FAKE_DEEPSEEK_KEY,
        FAKE_OPENROUTER_KEY,
        'authorization',
        'hidden detail',
        'internal-7',
        'Say hello',
      ]) {
        assert.ok(!everything.includes(forbidden), `the trace and the log never contain ${forbidden}`);
      }
    } finally {
      await proxy.close();
    }
  });

  test('a key-shaped model id is masked in the trace and in the 502 message', async () => {
    const keyShaped = FAKE_KEYS['OpenAI API key']?.text as string;
    const proxy = await startProxy({ mocks: { openai: FAIL_500 } });
    try {
      // Not in the catalog: passed through, unchanged, to openai, the native provider of the format.
      const res = await chat(proxy, { model: keyShaped, messages: HELLO });
      assert.equal(res.status, 502);
      assert.equal(
        errorOf(res).message,
        'Tollwise tried 1 provider and every attempt failed: openai model [REDACTED] (server, HTTP 500).',
      );
      const result = await proxy.result(0);
      assert.deepEqual(traceRows(result), [['openai', '[REDACTED]', 'server', 500]]);
      assert.ok(!proxy.log.join('').includes(keyShaped));
    } finally {
      await proxy.close();
    }
  });

  test('a request served at the first attempt has a one-entry trace and logs no trace line', async () => {
    const proxy = await startProxy();
    try {
      const res = await chat(proxy, { model: 'gpt-x', messages: HELLO });
      assert.equal(res.status, 200);
      assert.equal(res.headers['x-tollwise-attempts'], '1');
      assert.deepEqual(traceRows(await proxy.result(0)), [['deepseek', 'deep-gpt-x', 'ok', 200]]);
      assert.ok(!proxy.log.some((line) => line.includes('request attempts')));
    } finally {
      await proxy.close();
    }
  });

  test('every attempt with a round trip feeds the health monitor, a connection failure does not', async () => {
    const closedPort = await freePort();
    const proxy = await startProxy({
      routing: { retries: 3, timeouts: { connect_ms: 1000, first_byte_ms: 150, total_ms: 2000 } },
      baseUrls: { openrouter: `http://127.0.0.1:${closedPort}/v1` },
      mocks: { deepseek: { failWith: { status: 429 } }, ollama: { hang: true } },
    });
    try {
      const res = await chat(proxy, { model: 'gpt-x', messages: HELLO });
      assert.equal(res.status, 200);
      const result = await proxy.result(0);
      assert.deepEqual(
        result.attempts.map((attempt) => [attempt.provider, attempt.outcome]),
        [
          ['deepseek', 'rate_limit'],
          ['openrouter', 'connection'],
          ['ollama', 'timeout'],
          ['openai', 'ok'],
        ],
      );
      const byProvider = (id: ProviderId) => result.attempts.find((attempt) => attempt.provider === id)?.duration_ms;
      assert.deepEqual(proxy.samples, [
        { provider: 'deepseek', ms: byProvider('deepseek') },
        { provider: 'ollama', ms: byProvider('ollama') },
        { provider: 'openai', ms: byProvider('openai') },
      ]);
    } finally {
      await proxy.close();
    }
  });

  test('a client that goes away during a fallback stops it: no further candidate is called', async () => {
    const proxy = await startProxy({
      routing: { retries: 3 },
      mocks: { deepseek: { failWith: { status: 500 } }, openrouter: { latencyMs: 1000 } },
    });
    try {
      const controller = new AbortController();
      const url = new URL(proxy.url);
      const pending = fetch(`${url.origin}/v1/chat/completions`, {
        method: 'POST',
        headers: JSON_TYPE,
        body: JSON.stringify({ model: 'gpt-x', messages: HELLO }),
        signal: controller.signal,
      }).catch(() => undefined);
      const deadline = performance.now() + 2000;
      while (proxy.mocks.openrouter.requests.length === 0 && performance.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      controller.abort();
      await pending;
      const result = await proxy.result(0);
      assert.equal(result.outcome, 'client_aborted');
      assert.deepEqual(
        result.attempts.map((attempt) => [attempt.provider, attempt.outcome]),
        [
          ['deepseek', 'server'],
          ['openrouter', 'client_aborted'],
        ],
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.deepEqual(gptCalls(proxy), [1, 1, 0, 0]);
    } finally {
      await proxy.close();
    }
  });
});
