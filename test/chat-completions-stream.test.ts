import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import { after, afterEach, before, describe, test } from 'node:test';
import type { Catalog, ModelEntry } from '../src/catalog/schema.ts';
import { type Config, type ConfigInput, ConfigSchema, type ProviderId } from '../src/config/schema.ts';
import { createLogger, type LogSink } from '../src/log/logger.ts';
import { buildRegistry } from '../src/providers/registry.ts';
import { type ProxyRequestResult, setTopLevelFields } from '../src/proxy/forward.ts';
import { hasUsageObject, readOpenAiUsage } from '../src/proxy/openai.ts';
import { baseUrl, createTollwiseServer, listen, stopServer } from '../src/server/server.ts';
import { type MockProvider, type StartMockProviderOptions, startMockProvider } from './fixtures/mock-provider.ts';

// Fake credentials with no known key shape; none of them is a real key.
const FAKE_OPENAI_KEY = `fakeOpenai${'Oa1'.repeat(6)}`;
const FAKE_OPENROUTER_KEY = `fakeRouter${'Or2'.repeat(6)}`;
const ENV = { OPENAI_API_KEY: FAKE_OPENAI_KEY, OPENROUTER_API_KEY: FAKE_OPENROUTER_KEY };

const CAPS = { tools: true, json_mode: true, vision: true, streaming: true };

function entry(provider: ProviderId, model: string, input: number, output: number): ModelEntry {
  return {
    provider,
    model,
    canonical_model: 'gpt-x',
    price: { input, output, cached_input: null },
    context_window: 128_000,
    max_output: 16_000,
    capabilities: CAPS,
    source_url: 'https://example.com/pricing',
    verified_on: '2026-09-01',
  };
}

/** gpt-x: served by openai (dearer) and openrouter (cheaper, as openai/gpt-x). */
const CATALOG: Catalog = { models: [entry('openai', 'gpt-x', 10, 50), entry('openrouter', 'openai/gpt-x', 5, 25)] };

const HELLO = [{ role: 'user', content: 'Say hello.' }];
const LONG_TEXT = Array.from({ length: 40 }, (_, index) => `word${index}`).join(' ');

interface Proxy {
  readonly url: string;
  readonly openai: MockProvider;
  readonly openrouter: MockProvider;
  readonly log: string[];
  readonly results: ProxyRequestResult[];
  /** Resolves with the result of the n-th proxied request (0-based) once it is reported. */
  result(index: number): Promise<ProxyRequestResult>;
  close(): Promise<void>;
}

interface ProxyOptions {
  readonly openai?: StartMockProviderOptions;
  readonly openrouter?: StartMockProviderOptions;
  /** Base URL for openai instead of its mock. */
  readonly openaiBaseUrl?: string;
}

async function startProxy(options: ProxyOptions = {}): Promise<Proxy> {
  const openai = await startMockProvider(options.openai ?? {});
  const openrouter = await startMockProvider(options.openrouter ?? {});
  const config: Config = ConfigSchema.parse({
    providers: {
      openai: { base_url: options.openaiBaseUrl ?? `${openai.url}/v1` },
      openrouter: { base_url: `${openrouter.url}/v1` },
      anthropic: { enabled: false },
      deepseek: { enabled: false },
      ollama: { enabled: false },
    },
  } satisfies ConfigInput);
  const lines: string[] = [];
  const sink: LogSink = {
    write(chunk: string) {
      lines.push(chunk);
      return true;
    },
  };
  const results: ProxyRequestResult[] = [];
  const waiters: (() => void)[] = [];
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
        for (const wake of waiters.splice(0)) wake();
      },
    },
  });
  const address = await listen(server, '127.0.0.1', 0);
  return {
    url: baseUrl('127.0.0.1', address.port),
    openai,
    openrouter,
    log: lines,
    results,
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
      await Promise.all([openai.close(), openrouter.close()]);
    },
  };
}

interface StreamedResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly text: string;
  /** True when the response body ended normally (not cut). */
  readonly complete: boolean;
  /** Milliseconds from sending the request to the response head, to the first body byte, to the end. */
  readonly headersMs: number;
  readonly firstByteMs: number | null;
  /** performance.now() when the first body byte arrived. */
  readonly firstByteAt: number | null;
}

interface StreamOptions {
  /** Destroy the request once this many body bytes have arrived. */
  readonly abortAfterBytes?: number;
}

/** POSTs a chat request and reads the streamed response with timings. */
function streamChat(proxy: Proxy, body: unknown, options: StreamOptions = {}): Promise<StreamedResponse> {
  const url = new URL(proxy.url);
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const req = httpRequest(
      {
        host: url.hostname,
        port: url.port,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: { 'content-type': 'application/json', connection: 'close' },
      },
      (res) => {
        const headersAt = performance.now();
        const chunks: Buffer[] = [];
        let size = 0;
        let firstByteAt: number | null = null;
        let settled = false;
        const finish = (complete: boolean): void => {
          if (settled) return;
          settled = true;
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8'),
            complete,
            headersMs: headersAt - started,
            firstByteMs: firstByteAt === null ? null : firstByteAt - started,
            firstByteAt,
          });
        };
        res.on('data', (chunk: Buffer) => {
          firstByteAt ??= performance.now();
          chunks.push(chunk);
          size += chunk.length;
          if (options.abortAfterBytes !== undefined && size >= options.abortAfterBytes) {
            req.destroy();
            finish(false);
          }
        });
        res.on('end', () => finish(true));
        res.on('aborted', () => finish(false));
        res.on('error', () => finish(false));
        res.on('close', () => finish(res.complete));
      },
    );
    req.on('error', (error) => {
      if (options.abortAfterBytes === undefined) reject(error);
    });
    req.end(payload);
  });
}

function chatCalls(mock: MockProvider) {
  return mock.requests.filter((request) => request.method === 'POST');
}

/** The usage-only chunk the mock appends when include_usage is on, as one SSE frame. */
const USAGE_FRAME = /data: \{[^\n]*"choices":\[\],"usage":\{[^\n]*\}\}\n\n/;

const MOCK_USAGE = { input: 10, cachedInput: null, output: 5 };

function warnOrErrorLines(log: readonly string[]): string[] {
  return log.filter((line) => /"level":"(warn|error)"/.test(line));
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] as number;
}

// ---------------------------------------------------------------- helpers

describe('setTopLevelFields', () => {
  test('replaces an existing field and keeps every other byte', () => {
    const text = '{ "model":"a" , "stream_options" : {"x":1},\n"n":1.50 }';
    assert.equal(
      setTopLevelFields(text, { stream_options: '{"x":1,"include_usage":true}' }),
      '{ "model":"a" , "stream_options" : {"x":1,"include_usage":true},\n"n":1.50 }',
    );
  });

  test('appends a missing field after the last one', () => {
    assert.equal(
      setTopLevelFields('{"model":"a", "stream":true }', { stream_options: '{"include_usage":true}' }),
      '{"model":"a", "stream":true,"stream_options":{"include_usage":true} }',
    );
    assert.equal(setTopLevelFields('{ }', { a: '1' }), '{"a":1 }');
  });
});

describe('usage reading', () => {
  test('readOpenAiUsage reads counts and cached tokens, and refuses anything else', () => {
    assert.deepEqual(readOpenAiUsage({ prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 }), {
      input: 12,
      cachedInput: null,
      output: 3,
    });
    assert.deepEqual(
      readOpenAiUsage({ prompt_tokens: 12, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 8 } }),
      { input: 12, cachedInput: 8, output: 3 },
    );
    for (const bad of [null, undefined, {}, { prompt_tokens: '1', completion_tokens: 1 }, { prompt_tokens: -1 }]) {
      assert.equal(readOpenAiUsage(bad), null);
    }
  });

  test('hasUsageObject finds a usage object and ignores null usage and quoted text', () => {
    assert.equal(hasUsageObject(Buffer.from('{"choices":[],"usage" : {"prompt_tokens":1}}')), true);
    assert.equal(hasUsageObject(Buffer.from('{"choices":[{"delta":{}}],"usage":null}')), false);
    assert.equal(hasUsageObject(Buffer.from('{"delta":{"content":"the \\"usage\\": {x}"}}')), false);
    assert.equal(hasUsageObject(Buffer.from('[DONE]')), false);
  });
});

// ---------------------------------------------------------------- the route

describe('POST /v1/chat/completions with stream: true', () => {
  let proxy: Proxy;
  before(async () => {
    proxy = await startProxy();
  });
  after(async () => {
    await proxy.close();
  });
  afterEach(() => {
    for (const mock of [proxy.openai, proxy.openrouter]) mock.requests.length = 0;
    proxy.results.length = 0;
    proxy.log.length = 0;
  });

  test('with include_usage requested, the client receives the provider stream byte for byte', async () => {
    const request = { model: 'gpt-x', messages: HELLO, stream: true, stream_options: { include_usage: true } };
    const streamsBefore = proxy.openrouter.streams.length;
    const res = await streamChat(proxy, request);

    assert.equal(res.status, 200);
    assert.ok(res.complete);
    assert.match(String(res.headers['content-type']), /^text\/event-stream/);
    assert.equal(res.headers['x-tollwise-provider'], 'openrouter');
    assert.equal(res.headers['x-tollwise-model'], 'openai/gpt-x');
    assert.equal(res.headers['x-tollwise-policy'], 'cheapest');
    assert.equal(res.headers['x-tollwise-routed'], 'true');
    assert.match(String(res.headers['x-tollwise-request-id']), /^[0-9a-f-]{36}$/);

    const upstream = proxy.openrouter.streams[streamsBefore];
    assert.ok(upstream !== undefined);
    assert.equal(res.text, upstream.text);
    assert.match(res.text, USAGE_FRAME);
    assert.ok(res.text.endsWith('data: [DONE]\n\n'));
    // Only the model was rewritten; the client's stream options went out as sent.
    assert.deepEqual(chatCalls(proxy.openrouter)[0]?.body, { ...request, model: 'openai/gpt-x' });

    const result = await proxy.result(0);
    assert.equal(result.outcome, 'complete');
    assert.equal(result.stream, true);
    assert.equal(result.status, 200);
    assert.equal(result.provider, 'openrouter');
    assert.deepEqual(result.usage, MOCK_USAGE);
    assert.equal(result.requestId, res.headers['x-tollwise-request-id']);
  });

  test('without include_usage, Tollwise asks for usage upstream and strips the extra usage chunk', async () => {
    const streamsBefore = proxy.openrouter.streams.length;
    const res = await streamChat(proxy, { model: 'gpt-x', messages: HELLO, stream: true });

    assert.equal(res.status, 200);
    assert.ok(res.complete);
    const sent = chatCalls(proxy.openrouter)[0]?.body as Record<string, unknown>;
    assert.deepEqual(sent.stream_options, { include_usage: true });

    const upstream = proxy.openrouter.streams[streamsBefore];
    assert.ok(upstream !== undefined);
    assert.match(upstream.text, USAGE_FRAME);
    assert.equal(res.text, upstream.text.replace(USAGE_FRAME, ''));
    assert.ok(!res.text.includes('"usage"'));
    assert.ok(res.text.endsWith('data: [DONE]\n\n'));
    assert.equal(res.headers['content-length'], undefined);

    const result = await proxy.result(0);
    assert.equal(result.outcome, 'complete');
    assert.deepEqual(result.usage, MOCK_USAGE);
  });

  test("the client's other stream options are kept when include_usage is added", async () => {
    const raw = '{"model":"gpt-x","messages":[],"stream":true,"stream_options":{"include_obfuscation":false}}';
    const res = await streamChat(proxy, raw);
    assert.equal(res.status, 200);
    const sent = chatCalls(proxy.openrouter)[0]?.body as Record<string, unknown>;
    assert.deepEqual(sent.stream_options, { include_obfuscation: false, include_usage: true });
    assert.ok(!res.text.includes('"usage"'));
    assert.deepEqual((await proxy.result(0)).usage, MOCK_USAGE);
  });

  test('include_usage: false is treated as not asked: usage is read, and the chunk stripped', async () => {
    const res = await streamChat(proxy, {
      model: 'gpt-x',
      messages: HELLO,
      stream: true,
      stream_options: { include_usage: false },
    });
    const sent = chatCalls(proxy.openrouter)[0]?.body as Record<string, unknown>;
    assert.deepEqual(sent.stream_options, { include_usage: true });
    assert.ok(!res.text.includes('"usage"'));
    assert.deepEqual((await proxy.result(0)).usage, MOCK_USAGE);
  });

  test('a non-streaming request reports the usage of its JSON body', async () => {
    const res = await streamChat(proxy, { model: 'gpt-x', messages: HELLO });
    assert.equal(res.status, 200);
    const result = await proxy.result(0);
    assert.equal(result.stream, false);
    assert.equal(result.outcome, 'complete');
    assert.deepEqual(result.usage, MOCK_USAGE);
  });

  test('the stream logs nothing of its content, headers or keys', async () => {
    await streamChat(proxy, { model: 'gpt-x', messages: [{ role: 'user', content: 'private words' }], stream: true });
    await proxy.result(0);
    const output = proxy.log.join('');
    for (const forbidden of ['private words', 'Mock response', FAKE_OPENROUTER_KEY, 'Bearer', 'openai/gpt-x']) {
      assert.ok(!output.includes(forbidden), `log must not contain ${forbidden}`);
    }
    assert.deepEqual(warnOrErrorLines(proxy.log), []);
  });
});

describe('POST /v1/chat/completions streaming timing', () => {
  const FIRST_BYTE_DELAY_MS = 200;
  const CHUNK_DELAY_MS = 100;
  let proxy: Proxy;
  before(async () => {
    proxy = await startProxy({
      openrouter: { firstByteDelayMs: FIRST_BYTE_DELAY_MS, chunkDelayMs: CHUNK_DELAY_MS },
      openai: {},
    });
  });
  after(async () => {
    await proxy.close();
  });

  for (const includeUsage of [true, false]) {
    test(`headers leave at once and the first event is not held back (include_usage ${includeUsage})`, async (t) => {
      const streamsBefore = proxy.openrouter.streams.length;
      const request = {
        model: 'gpt-x',
        messages: HELLO,
        stream: true,
        ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
      };
      const res = await streamChat(proxy, request);
      assert.equal(res.status, 200);
      assert.ok(res.complete);
      assert.equal(res.headers['x-tollwise-provider'], 'openrouter');

      const upstream = proxy.openrouter.streams[streamsBefore];
      assert.ok(upstream?.firstFrameAt !== null && upstream?.firstFrameAt !== undefined);
      assert.ok(res.firstByteAt !== null && res.firstByteMs !== null);
      // The response head does not wait for the provider's first event (sent FIRST_BYTE_DELAY_MS later).
      assert.ok(res.headersMs < FIRST_BYTE_DELAY_MS / 2, `head after ${res.headersMs.toFixed(1)} ms`);
      // The first event reaches the client long before the provider's second one exists.
      const added = res.firstByteAt - upstream.firstFrameAt;
      t.diagnostic(`first byte: provider frame flushed -> client received in ${added.toFixed(2)} ms`);
      assert.ok(added < CHUNK_DELAY_MS / 2, `first event arrived ${added.toFixed(1)} ms after the provider sent it`);
    });
  }
});

describe('POST /v1/chat/completions streaming first-byte overhead', () => {
  test('median added first-byte latency over 15 streams is within the 10 ms budget', async (t) => {
    const proxy = await startProxy({ openrouter: { firstByteDelayMs: 30, chunkDelayMs: 5 } });
    try {
      const added: number[] = [];
      for (let run = 0; run < 15; run += 1) {
        const streamsBefore = proxy.openrouter.streams.length;
        const res = await streamChat(proxy, { model: 'gpt-x', messages: HELLO, stream: true });
        const upstream = proxy.openrouter.streams[streamsBefore];
        assert.ok(res.firstByteAt !== null && upstream?.firstFrameAt != null);
        added.push(res.firstByteAt - upstream.firstFrameAt);
      }
      const p50 = median(added);
      t.diagnostic(`added first-byte latency p50 ${p50.toFixed(2)} ms, max ${Math.max(...added).toFixed(2)} ms`);
      assert.ok(p50 <= 10, `p50 ${p50.toFixed(2)} ms`);
    } finally {
      await proxy.close();
    }
  });
});

describe('POST /v1/chat/completions streaming failures', () => {
  test('a client that goes away mid-stream aborts the provider call, with no false failure logged', async () => {
    const proxy = await startProxy({
      openrouter: { chunkDelayMs: 100, responses: [{ content: LONG_TEXT }] },
    });
    try {
      const res = await streamChat(proxy, { model: 'gpt-x', messages: HELLO, stream: true }, { abortAfterBytes: 1 });
      assert.equal(res.complete, false);
      const aborted = performance.now();
      await proxy.openrouter.waitForDisconnect(0);
      const closedIn = performance.now() - aborted;
      // The whole stream would take about 2 s (20 frames, 100 ms apart).
      assert.ok(closedIn < 500, `provider connection closed ${closedIn.toFixed(0)} ms after the client left`);
      assert.ok(!(proxy.openrouter.streams[0]?.text ?? '').includes('[DONE]'), 'the provider never finished');

      const result = await proxy.result(0);
      assert.equal(result.outcome, 'client_aborted');
      assert.equal(result.usage, null);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.deepEqual(warnOrErrorLines(proxy.log), []);
      assert.ok(proxy.log.some((line) => line.includes('upstream response aborted')));
    } finally {
      await proxy.close();
    }
  });

  test('a provider stream that drops mid-way is cut for the client too, without a made-up [DONE]', async () => {
    const proxy = await startProxy({ openrouter: { dropMidStream: true } });
    try {
      const res = await streamChat(proxy, { model: 'gpt-x', messages: HELLO, stream: true });
      assert.equal(res.status, 200);
      assert.equal(res.complete, false, 'the client sees the body end early');
      const upstream = proxy.openrouter.streams[0];
      assert.ok(upstream !== undefined);
      // Everything the provider sent before the drop reached the client, and nothing more.
      assert.equal(res.text, upstream.text);
      assert.match(res.text, /"role":"assistant"/);
      assert.ok(!res.text.includes('[DONE]'));

      const result = await proxy.result(0);
      assert.equal(result.outcome, 'interrupted');
      assert.equal(result.usage, null);
    } finally {
      await proxy.close();
    }
  });

  test('a provider error before the stream starts falls back to the next provider, which streams', async () => {
    const proxy = await startProxy({ openrouter: { responses: [{ failWith: { status: 429 } }] } });
    try {
      const res = await streamChat(proxy, { model: 'gpt-x', messages: HELLO, stream: true });
      assert.equal(res.status, 200);
      assert.equal(res.complete, true);
      assert.equal(res.headers['x-tollwise-provider'], 'openai');
      assert.equal(res.headers['x-tollwise-attempts'], '2');
      // Only the stream of the provider that served the request reaches the client.
      assert.equal(proxy.openrouter.streams.length, 0);
      assert.ok(res.text.endsWith('data: [DONE]\n\n'));
      const result = await proxy.result(0);
      assert.equal(result.outcome, 'complete');
      assert.equal(result.provider, 'openai');
      assert.deepEqual(
        result.attempts.map((attempt) => [attempt.provider, attempt.outcome, attempt.status]),
        [
          ['openrouter', 'rate_limit', 429],
          ['openai', 'ok', 200],
        ],
      );
    } finally {
      await proxy.close();
    }
  });
});

describe('POST /v1/chat/completions streaming from other provider behaviours', () => {
  /** A provider that answers every chat request with `sse` as an event stream. */
  async function withRawProvider(sse: string, run: (proxy: Proxy) => Promise<void>): Promise<void> {
    const fake = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        res.end(sse);
      });
    });
    const port = (await listen(fake, '127.0.0.1', 0)).port;
    const proxy = await startProxy({ openaiBaseUrl: `http://127.0.0.1:${port}/v1` });
    try {
      await run(proxy);
    } finally {
      await proxy.close();
      await stopServer(fake, 100);
    }
  }

  const request = { model: 'unlisted-model', messages: HELLO, stream: true };

  test('a provider that reports no usage: the stream is relayed intact and usage is null', async () => {
    const sse = 'data: {"choices":[{"index":0,"delta":{"content":"hi"}}],"usage":null}\n\ndata: [DONE]\n\n';
    await withRawProvider(sse, async (proxy) => {
      const res = await streamChat(proxy, request);
      assert.equal(res.text, sse);
      const result = await proxy.result(0);
      assert.equal(result.outcome, 'complete');
      assert.equal(result.usage, null);
    });
  });

  test('usage on a chunk that also carries choices is read, and that chunk is not removed', async () => {
    const sse =
      'data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}\r\n\r\n' +
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],' +
      '"usage":{"prompt_tokens":7,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":4}}}\r\n\r\n' +
      'data: [DONE]\r\n\r\n';
    await withRawProvider(sse, async (proxy) => {
      const res = await streamChat(proxy, request);
      assert.equal(res.text, sse);
      assert.deepEqual((await proxy.result(0)).usage, { input: 7, cachedInput: 4, output: 2 });
    });
  });

  test('an event larger than the scanner cap is relayed byte for byte, and the usage after it is still read', async () => {
    const big = `data: {"choices":[{"index":0,"delta":{"content":"${'x'.repeat(600 * 1024)}"}}]}\n\n`;
    const usage = 'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\n';
    await withRawProvider(`${big}${usage}data: [DONE]\n\n`, async (proxy) => {
      const res = await streamChat(proxy, request);
      assert.equal(res.text, `${big}data: [DONE]\n\n`);
      assert.deepEqual((await proxy.result(0)).usage, { input: 3, cachedInput: null, output: 1 });
    });
  });
});
