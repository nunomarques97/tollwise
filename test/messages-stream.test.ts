import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import { after, afterEach, before, describe, test } from 'node:test';
import type { Catalog, ModelEntry } from '../src/catalog/schema.ts';
import { type Config, type ConfigInput, ConfigSchema } from '../src/config/schema.ts';
import { createLogger, type LogSink } from '../src/log/logger.ts';
import { buildRegistry } from '../src/providers/registry.ts';
import { watchAnthropicStream } from '../src/proxy/anthropic.ts';
import type { ProxyRequestResult } from '../src/proxy/forward.ts';
import { baseUrl, createTollwiseServer, listen, stopServer } from '../src/server/server.ts';
import { type MockProvider, type StartMockProviderOptions, startMockProvider } from './fixtures/mock-provider.ts';

// Fake credentials with no known key shape; none of them is a real key.
const FAKE_ANTHROPIC_KEY = `fakeClaude${'An4'.repeat(6)}`;
const ENV = { ANTHROPIC_API_KEY: FAKE_ANTHROPIC_KEY };

const CAPS = { tools: true, json_mode: true, vision: true, streaming: true };

function entry(model: string, input: number, output: number): ModelEntry {
  return {
    provider: 'anthropic',
    model,
    canonical_model: 'claude-x',
    price: { input, output, cached_input: null },
    context_window: 200_000,
    max_output: 16_000,
    capabilities: CAPS,
    source_url: 'https://example.com/pricing',
    verified_on: '2026-09-01',
  };
}

/** claude-x: the dated id (dearer) and the alias (cheaper), both on Anthropic. */
const CATALOG: Catalog = { models: [entry('claude-x-20260901', 3, 15), entry('claude-x', 1, 5)] };

const HELLO = [{ role: 'user', content: 'Say hello.' }];
const LONG_TEXT = Array.from({ length: 40 }, (_, index) => `word${index}`).join(' ');

/** The usage the mock provider reports: 10 input tokens in message_start, 5 output tokens in message_delta. */
const MOCK_USAGE = { input: 10, cachedInput: null, output: 5 };

interface Proxy {
  readonly url: string;
  readonly anthropic: MockProvider;
  readonly log: string[];
  readonly results: ProxyRequestResult[];
  /** Resolves with the result of the n-th proxied request (0-based) once it is reported. */
  result(index: number): Promise<ProxyRequestResult>;
  close(): Promise<void>;
}

interface ProxyOptions {
  readonly anthropic?: StartMockProviderOptions;
  /** Base URL for anthropic instead of its mock. */
  readonly anthropicBaseUrl?: string;
}

async function startProxy(options: ProxyOptions = {}): Promise<Proxy> {
  const anthropic = await startMockProvider(options.anthropic ?? {});
  const config: Config = ConfigSchema.parse({
    providers: {
      anthropic: { base_url: options.anthropicBaseUrl ?? anthropic.url },
      openai: { enabled: false },
      openrouter: { enabled: false },
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
    anthropic,
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
      await anthropic.close();
    },
  };
}

interface StreamedResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly text: string;
  /** True when the response body ended normally (not cut). */
  readonly complete: boolean;
  /** Milliseconds from sending the request to the response head. */
  readonly headersMs: number;
  /** performance.now() when the first body byte arrived. */
  readonly firstByteAt: number | null;
}

interface StreamOptions {
  /** Destroy the request once this many body bytes have arrived. */
  readonly abortAfterBytes?: number;
}

/** POSTs a Messages request and reads the streamed response. */
function streamMessages(proxy: Proxy, body: unknown, options: StreamOptions = {}): Promise<StreamedResponse> {
  const url = new URL(proxy.url);
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const req = httpRequest(
      {
        host: url.hostname,
        port: url.port,
        path: '/v1/messages',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', connection: 'close' },
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

function request(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { model: 'claude-x', max_tokens: 256, messages: HELLO, stream: true, ...extra };
}

function warnOrErrorLines(log: readonly string[]): string[] {
  return log.filter((line) => /"level":"(warn|error)"/.test(line));
}

/** Feeds events to a fresh watcher and returns the usage it read. */
function watchEvents(events: readonly { name?: string; data: unknown }[]) {
  const watch = watchAnthropicStream();
  for (const event of events) {
    const data = Buffer.from(typeof event.data === 'string' ? event.data : JSON.stringify(event.data));
    assert.equal(watch.onEvent({ name: event.name, data }), 'forward');
  }
  return { hold: watch.hold, usage: watch.usage() };
}

// ---------------------------------------------------------------- the watcher

describe('watchAnthropicStream', () => {
  const start = (usage: unknown) => ({
    name: 'message_start',
    data: { type: 'message_start', message: { id: 'msg_1', type: 'message', usage } },
  });
  const delta = (usage: unknown) => ({
    name: 'message_delta',
    data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage },
  });

  test('reads input from message_start and output from message_delta, and never holds an event', () => {
    const watched = watchEvents([
      start({ input_tokens: 25, output_tokens: 1 }),
      { name: 'content_block_delta', data: { type: 'content_block_delta', delta: { text: 'hi' } } },
      delta({ output_tokens: 15 }),
      { name: 'message_stop', data: { type: 'message_stop' } },
    ]);
    assert.equal(watched.hold, false);
    assert.deepEqual(watched.usage, { input: 25, cachedInput: null, output: 15 });
  });

  test('counts cache reads and writes from message_start as input', () => {
    const watched = watchEvents([
      start({ input_tokens: 4, cache_read_input_tokens: 100, cache_creation_input_tokens: 30, output_tokens: 1 }),
      delta({ output_tokens: 9 }),
    ]);
    assert.deepEqual(watched.usage, { input: 134, cachedInput: 100, output: 9 });
  });

  test('cumulative input counts in message_delta replace those of message_start', () => {
    const watched = watchEvents([
      start({ input_tokens: 4, output_tokens: 1 }),
      delta({ input_tokens: 6, cache_read_input_tokens: 50, output_tokens: 12 }),
    ]);
    assert.deepEqual(watched.usage, { input: 56, cachedInput: 50, output: 12 });
  });

  test('the last message_delta wins', () => {
    const watched = watchEvents([
      start({ input_tokens: 4, output_tokens: 1 }),
      delta({ output_tokens: 3 }),
      delta({ output_tokens: 8 }),
    ]);
    assert.deepEqual(watched.usage, { input: 4, cachedInput: null, output: 8 });
  });

  test('events without a name are recognised by their type', () => {
    const watched = watchEvents([
      { data: { type: 'message_start', message: { usage: { input_tokens: 7, output_tokens: 0 } } } },
      { data: { type: 'message_delta', usage: { output_tokens: 2 } } },
    ]);
    assert.deepEqual(watched.usage, { input: 7, cachedInput: null, output: 2 });
  });

  test('a stream cut before message_delta reports the counts read so far', () => {
    assert.deepEqual(watchEvents([start({ input_tokens: 10, output_tokens: 1 })]).usage, {
      input: 10,
      cachedInput: null,
      output: 1,
    });
  });

  test('is null without a usable message_start, and ignores malformed or mistyped events', () => {
    assert.equal(watchEvents([]).usage, null);
    assert.equal(watchEvents([delta({ output_tokens: 5 })]).usage, null);
    assert.equal(watchEvents([start({ output_tokens: 5 })]).usage, null);
    assert.equal(watchEvents([start({ input_tokens: -1, output_tokens: 5 })]).usage, null);
    assert.equal(watchEvents([{ name: 'message_start', data: '{"type":"message_start",' }]).usage, null);
    // The event name says message_start but the payload is another type: not read.
    assert.equal(
      watchEvents([
        { name: 'message_start', data: { type: 'ping', message: { usage: { input_tokens: 1, output_tokens: 1 } } } },
      ]).usage,
      null,
    );
    // A content event that merely mentions the words is never read as usage.
    const quoted = watchEvents([
      start({ input_tokens: 3, output_tokens: 0 }),
      {
        name: 'content_block_delta',
        data: { type: 'content_block_delta', delta: { text: '"message_delta" usage output_tokens 999' } },
      },
    ]);
    assert.deepEqual(quoted.usage, { input: 3, cachedInput: null, output: 0 });
    // A non-count value in message_delta keeps the previous count.
    const bad = watchEvents([start({ input_tokens: 3, output_tokens: 1 }), delta({ output_tokens: '9' })]);
    assert.deepEqual(bad.usage, { input: 3, cachedInput: null, output: 1 });
  });
});

// ---------------------------------------------------------------- the route

describe('POST /v1/messages with stream: true', () => {
  let proxy: Proxy;
  before(async () => {
    proxy = await startProxy();
  });
  after(async () => {
    await proxy.close();
  });
  afterEach(() => {
    proxy.anthropic.requests.length = 0;
    proxy.results.length = 0;
    proxy.log.length = 0;
  });

  test('the client receives the provider stream byte for byte, and its usage is reported', async () => {
    const streamsBefore = proxy.anthropic.streams.length;
    const res = await streamMessages(proxy, request());

    assert.equal(res.status, 200);
    assert.ok(res.complete);
    assert.match(String(res.headers['content-type']), /^text\/event-stream/);
    assert.equal(res.headers['x-tollwise-provider'], 'anthropic');
    assert.equal(res.headers['x-tollwise-model'], 'claude-x');
    assert.equal(res.headers['x-tollwise-routed'], 'true');
    assert.match(String(res.headers['x-tollwise-request-id']), /^[0-9a-f-]{36}$/);

    const upstream = proxy.anthropic.streams[streamsBefore];
    assert.ok(upstream !== undefined);
    assert.equal(res.text, upstream.text);
    assert.match(res.text, /^event: message_start\n/);
    assert.match(res.text, /event: message_delta\n/);
    assert.ok(res.text.endsWith('event: message_stop\ndata: {"type":"message_stop"}\n\n'));
    // Nothing is added to the request for a stream: the body goes out as the client sent it.
    const sent = proxy.anthropic.requests.find((recorded) => recorded.method === 'POST')?.body;
    assert.deepEqual(sent, request());

    const result = await proxy.result(0);
    assert.equal(result.outcome, 'complete');
    assert.equal(result.stream, true);
    assert.equal(result.status, 200);
    assert.equal(result.provider, 'anthropic');
    assert.deepEqual(result.usage, MOCK_USAGE);
    assert.equal(result.requestId, res.headers['x-tollwise-request-id']);
  });

  test('a tool-use stream is relayed byte for byte, and its usage is reported', async () => {
    const tools = [{ name: 'get_weather', description: 'Weather', input_schema: { type: 'object' } }];
    const streamsBefore = proxy.anthropic.streams.length;
    const res = await streamMessages(proxy, request({ tools }));
    assert.equal(res.status, 200);
    assert.equal(res.text, proxy.anthropic.streams[streamsBefore]?.text);
    assert.deepEqual((await proxy.result(0)).usage, MOCK_USAGE);
  });

  test('the stream logs nothing of its content, headers or keys', async () => {
    await streamMessages(proxy, request({ messages: [{ role: 'user', content: 'private words' }] }));
    await proxy.result(0);
    const output = proxy.log.join('');
    for (const forbidden of ['private words', 'Mock response', FAKE_ANTHROPIC_KEY, 'x-api-key', 'message_start']) {
      assert.ok(!output.includes(forbidden), `log must not contain ${forbidden}`);
    }
    assert.deepEqual(warnOrErrorLines(proxy.log), []);
  });
});

describe('POST /v1/messages streaming timing', () => {
  const FIRST_BYTE_DELAY_MS = 200;
  const CHUNK_DELAY_MS = 100;
  let proxy: Proxy;
  before(async () => {
    proxy = await startProxy({ anthropic: { firstByteDelayMs: FIRST_BYTE_DELAY_MS, chunkDelayMs: CHUNK_DELAY_MS } });
  });
  after(async () => {
    await proxy.close();
  });

  test('headers leave at once and the first event is not held back', async (t) => {
    const res = await streamMessages(proxy, request());
    assert.equal(res.status, 200);
    assert.ok(res.complete);
    const upstream = proxy.anthropic.streams[0];
    assert.ok(upstream?.firstFrameAt !== null && upstream?.firstFrameAt !== undefined);
    assert.ok(res.firstByteAt !== null);
    assert.ok(res.headersMs < FIRST_BYTE_DELAY_MS / 2, `head after ${res.headersMs.toFixed(1)} ms`);
    const added = res.firstByteAt - upstream.firstFrameAt;
    t.diagnostic(`first byte: provider frame flushed -> client received in ${added.toFixed(2)} ms`);
    assert.ok(added < CHUNK_DELAY_MS / 2, `first event arrived ${added.toFixed(1)} ms after the provider sent it`);
    assert.deepEqual((await proxy.result(0)).usage, MOCK_USAGE);
  });
});

describe('POST /v1/messages streaming failures', () => {
  test('a client that goes away mid-stream aborts the provider call, with no false failure logged', async () => {
    const proxy = await startProxy({ anthropic: { chunkDelayMs: 100, responses: [{ content: LONG_TEXT }] } });
    try {
      const res = await streamMessages(proxy, request(), { abortAfterBytes: 1 });
      assert.equal(res.complete, false);
      const aborted = performance.now();
      await proxy.anthropic.waitForDisconnect(0);
      const closedIn = performance.now() - aborted;
      // The whole stream would take about 2 s (over 20 frames, 100 ms apart).
      assert.ok(closedIn < 500, `provider connection closed ${closedIn.toFixed(0)} ms after the client left`);
      assert.ok(!(proxy.anthropic.streams[0]?.text ?? '').includes('message_stop'), 'the provider never finished');

      const result = await proxy.result(0);
      assert.equal(result.outcome, 'client_aborted');
      assert.equal(result.status, 200);
      // The client left after message_start: the input counts it carried are reported, no final output.
      assert.deepEqual(result.usage, { input: 10, cachedInput: null, output: 0 });
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.deepEqual(warnOrErrorLines(proxy.log), []);
      assert.ok(proxy.log.some((line) => line.includes('upstream response aborted')));
    } finally {
      await proxy.close();
    }
  });

  test('a provider stream that drops mid-way is cut for the client too, without a made-up message_stop', async () => {
    const proxy = await startProxy({ anthropic: { dropMidStream: true } });
    try {
      const res = await streamMessages(proxy, request());
      assert.equal(res.status, 200);
      assert.equal(res.complete, false, 'the client sees the body end early');
      const upstream = proxy.anthropic.streams[0];
      assert.ok(upstream !== undefined);
      // Everything the provider sent before the drop reached the client, and nothing more.
      assert.equal(res.text, upstream.text);
      assert.match(res.text, /^event: message_start\n/);
      assert.ok(!res.text.includes('message_stop'));

      const result = await proxy.result(0);
      assert.equal(result.outcome, 'interrupted');
      assert.equal(result.status, 200);
      // Only message_start arrived: its counts are what the provider reported before the drop.
      assert.deepEqual(result.usage, { input: 10, cachedInput: null, output: 0 });
    } finally {
      await proxy.close();
    }
  });

  test('an overloaded provider before the stream starts falls back to the next candidate, which streams', async () => {
    const proxy = await startProxy({ anthropic: { responses: [{ failWith: { status: 529 } }] } });
    try {
      const res = await streamMessages(proxy, request());
      assert.equal(res.status, 200);
      assert.equal(res.complete, true);
      assert.equal(res.headers['x-tollwise-model'], 'claude-x-20260901');
      assert.equal(res.headers['x-tollwise-attempts'], '2');
      assert.equal(res.text, proxy.anthropic.streams[0]?.text);
      const result = await proxy.result(0);
      assert.equal(result.outcome, 'complete');
      assert.deepEqual(result.usage, MOCK_USAGE);
      assert.deepEqual(
        result.attempts.map((attempt) => [attempt.model, attempt.outcome, attempt.status]),
        [
          ['claude-x', 'overloaded', 529],
          ['claude-x-20260901', 'ok', 200],
        ],
      );
    } finally {
      await proxy.close();
    }
  });

  test('when every candidate fails before the stream starts, the answer is a 502 Anthropic error', async () => {
    const proxy = await startProxy({
      anthropic: { responses: [{ failWith: { status: 529 } }, { failWith: { status: 503 } }] },
    });
    try {
      const res = await streamMessages(proxy, request());
      assert.equal(res.status, 502);
      assert.equal(res.headers['x-tollwise-provider'], 'anthropic');
      assert.equal(res.headers['x-tollwise-attempts'], '2');
      const body = JSON.parse(res.text) as { type: string; error: { type: string; message: string } };
      assert.equal(body.type, 'error');
      assert.equal(body.error.type, 'api_error');
      assert.equal(
        body.error.message,
        'Tollwise tried 2 providers and every attempt failed: anthropic model claude-x (overloaded, HTTP 529), ' +
          'anthropic model claude-x-20260901 (overloaded, HTTP 503).',
      );
      const result = await proxy.result(0);
      assert.equal(result.outcome, 'provider_error');
      assert.equal(result.status, 502);
      assert.equal(result.usage, null);
    } finally {
      await proxy.close();
    }
  });
});

describe('POST /v1/messages streaming from other provider behaviours', () => {
  /** A provider that answers every Messages request with `sse` as an event stream. */
  async function withRawProvider(sse: string, run: (proxy: Proxy) => Promise<void>): Promise<void> {
    const fake = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        res.end(sse);
      });
    });
    const port = (await listen(fake, '127.0.0.1', 0)).port;
    const proxy = await startProxy({ anthropicBaseUrl: `http://127.0.0.1:${port}` });
    try {
      await run(proxy);
    } finally {
      await proxy.close();
      await stopServer(fake, 100);
    }
  }

  test('CRLF lines, a ping, cache counts and cumulative message_delta input: relayed intact, usage read', async () => {
    const sse =
      'event: message_start\r\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message",' +
      '"usage":{"input_tokens":4,"cache_creation_input_tokens":20,"cache_read_input_tokens":0,"output_tokens":1}}}\r\n\r\n' +
      'event: ping\r\ndata: {"type": "ping"}\r\n\r\n' +
      'event: content_block_delta\r\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\r\n\r\n' +
      'event: message_delta\r\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},' +
      '"usage":{"input_tokens":4,"cache_creation_input_tokens":20,"cache_read_input_tokens":0,"output_tokens":6}}\r\n\r\n' +
      'event: message_stop\r\ndata: {"type":"message_stop"}\r\n\r\n';
    await withRawProvider(sse, async (proxy) => {
      const res = await streamMessages(proxy, request());
      assert.equal(res.text, sse);
      const result = await proxy.result(0);
      assert.equal(result.outcome, 'complete');
      assert.deepEqual(result.usage, { input: 24, cachedInput: 0, output: 6 });
    });
  });

  test('a mid-stream error event is relayed unchanged, and the usage read before it is kept', async () => {
    const sse =
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":9,"output_tokens":1}}}\n\n' +
      'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n';
    await withRawProvider(sse, async (proxy) => {
      const res = await streamMessages(proxy, request());
      assert.equal(res.text, sse);
      assert.deepEqual((await proxy.result(0)).usage, { input: 9, cachedInput: null, output: 1 });
    });
  });

  test('a stream without usage events is relayed intact and usage is null', async () => {
    const sse = 'event: content_block_delta\ndata: {"type":"content_block_delta"}\n\nevent: message_stop\ndata: {}\n\n';
    await withRawProvider(sse, async (proxy) => {
      const res = await streamMessages(proxy, request());
      assert.equal(res.text, sse);
      assert.equal((await proxy.result(0)).usage, null);
    });
  });

  test('an event larger than the scanner cap is relayed byte for byte, and the usage after it is still read', async () => {
    const begin =
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3,"output_tokens":0}}}\n\n';
    const big = `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"${'x'.repeat(600 * 1024)}"}}\n\n`;
    const end = 'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":700}}\n\n';
    const sse = `${begin}${big}${end}event: message_stop\ndata: {"type":"message_stop"}\n\n`;
    await withRawProvider(sse, async (proxy) => {
      const res = await streamMessages(proxy, request());
      assert.equal(res.text, sse);
      assert.deepEqual((await proxy.result(0)).usage, { input: 3, cachedInput: null, output: 700 });
    });
  });
});
