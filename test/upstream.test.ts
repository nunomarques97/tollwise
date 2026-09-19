import assert from 'node:assert/strict';
import type { IncomingHttpHeaders } from 'node:http';
import net from 'node:net';
import { after, describe, test } from 'node:test';
import type { Environment } from '../src/config/load.ts';
import type { ProviderId } from '../src/config/schema.ts';
import { createLogger, type Logger } from '../src/log/logger.ts';
import { AnthropicAdapter } from '../src/providers/anthropic.ts';
import { OpenAiCompatibleAdapter } from '../src/providers/openai-compatible.ts';
import type { ProviderAdapter } from '../src/providers/types.ts';
import {
  callUpstream,
  type UpstreamCompletion,
  type UpstreamRequest,
  type UpstreamResult,
  type UpstreamTimeouts,
} from '../src/proxy/upstream.ts';
import { FAKE_KEYS } from './fixtures/fake-keys.ts';
import { type MockProvider, type StartMockProviderOptions, startMockProvider } from './fixtures/mock-provider.ts';

function fakeKey(name: string): string {
  const sample = FAKE_KEYS[name];
  assert.ok(sample, `missing fake key sample ${name}`);
  return sample.text;
}

const OPENAI_KEY = fakeKey('OpenAI API key');
const ANTHROPIC_KEY = fakeKey('Anthropic API key');
/** A different fake key, standing for the credential a client sends to the proxy. */
const CLIENT_KEY = fakeKey('OpenRouter API key');

const ENV: Environment = { OPENAI_API_KEY: OPENAI_KEY, ANTHROPIC_API_KEY: ANTHROPIC_KEY };

const GENEROUS: UpstreamTimeouts = { connect_ms: 5_000, first_byte_ms: 5_000, total_ms: 10_000 };

const CHAT_BODY = JSON.stringify({ model: 'mock-openai-fast', messages: [{ role: 'user', content: 'Hi' }] });
const STREAM_BODY = JSON.stringify({
  model: 'mock-openai-fast',
  stream: true,
  messages: [{ role: 'user', content: 'Hi' }],
});
const ANTHROPIC_BODY = JSON.stringify({
  model: 'mock-anthropic-fast',
  max_tokens: 16,
  messages: [{ role: 'user', content: 'Hi' }],
});

/** Every header a hostile or careless client could send; only the allow-listed ones may leave. */
const CLIENT_HEADERS: IncomingHttpHeaders = {
  host: '127.0.0.1:8787',
  'content-type': 'application/json',
  'content-length': '9999',
  accept: 'application/json',
  'user-agent': 'OpenAI/JS 6.0.0',
  authorization: `Bearer ${CLIENT_KEY}`,
  'x-api-key': CLIENT_KEY,
  'api-key': CLIENT_KEY,
  'proxy-authorization': `Bearer ${CLIENT_KEY}`,
  cookie: 'session=abc123',
  'x-tollwise-policy': 'fastest',
  'x-tollwise-access-key': CLIENT_KEY,
  connection: 'keep-alive, x-custom',
  'keep-alive': 'timeout=5',
  te: 'trailers',
  trailer: 'x-checksum',
  upgrade: 'websocket',
  'transfer-encoding': 'chunked',
  'accept-encoding': 'gzip, deflate, br',
  'x-forwarded-for': '10.0.0.1',
  forwarded: 'for=10.0.0.1',
  origin: 'http://localhost:3000',
  'anthropic-version': '2024-01-01',
  'anthropic-beta': 'tools-2024-04-04',
  'openai-organization': 'org-mock',
};

const mocks: MockProvider[] = [];
const servers: net.Server[] = [];

after(async () => {
  await Promise.all(mocks.map((mock) => mock.close()));
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function mock(options: StartMockProviderOptions = {}): Promise<MockProvider> {
  const started = await startMockProvider(options);
  mocks.push(started);
  return started;
}

function openAi(baseUrl: string, apiKeyEnv: string | null = 'OPENAI_API_KEY', id: ProviderId = 'openai') {
  return new OpenAiCompatibleAdapter({
    id,
    settings: { base_url: baseUrl, api_key_env: apiKeyEnv },
    chatPath: '/chat/completions',
    modelsPath: '/models',
  });
}

function anthropic(baseUrl: string): ProviderAdapter {
  return new AnthropicAdapter({ base_url: baseUrl, api_key_env: 'ANTHROPIC_API_KEY' });
}

interface CapturedLog {
  readonly logger: Logger;
  readonly lines: () => Record<string, unknown>[];
  readonly raw: () => string;
}

function captureLog(): CapturedLog {
  let text = '';
  const logger = createLogger({ level: 'debug', sink: { write: (chunk: string) => (text += chunk) } });
  return {
    logger,
    raw: () => text,
    lines: () =>
      text
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

function call(overrides: Partial<UpstreamRequest> & Pick<UpstreamRequest, 'adapter'>): Promise<UpstreamResult> {
  return callUpstream({
    env: ENV,
    path: overrides.adapter.chatPath,
    body: CHAT_BODY,
    clientHeaders: { 'content-type': 'application/json' },
    timeouts: GENEROUS,
    logger: captureLog().logger,
    ...overrides,
  });
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

function expectResponse(result: UpstreamResult): Extract<UpstreamResult, { type: 'response' }> {
  if (result.type !== 'response') assert.fail(`expected a response, got ${JSON.stringify(result)}`);
  return result;
}

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A TCP port with nothing listening on it. */
async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

/** A TCP server that runs `onSocket` for every connection it accepts. */
async function rawServer(onSocket: (socket: net.Socket) => void): Promise<number> {
  const server = net.createServer(onSocket);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  return address.port;
}

describe('callUpstream: successful responses', () => {
  test('returns the status, headers and JSON body of a non-streaming completion', async () => {
    const provider = await mock({ responses: [{ content: 'Hello there' }] });
    const log = captureLog();
    const result = expectResponse(await call({ adapter: openAi(`${provider.url}/v1`), logger: log.logger }));

    assert.equal(result.status, 200);
    assert.equal(result.headers['content-type'], 'application/json');
    assert.equal(result.headers.connection, undefined, 'hop-by-hop headers are not returned');
    const parsed = JSON.parse(await readAll(result.body)) as { choices: { message: { content: string } }[] };
    assert.equal(parsed.choices[0]?.message.content, 'Hello there');
    const completion = await result.completion;
    assert.equal(completion.type, 'complete');

    assert.equal(provider.requests.length, 1);
    assert.equal(provider.requests[0]?.method, 'POST');
    assert.equal(provider.requests[0]?.path, '/v1/chat/completions');
    assert.deepEqual(provider.requests[0]?.body, JSON.parse(CHAT_BODY));
  });

  test('passes SSE bytes through unchanged, ending with the terminal frame', async () => {
    const provider = await mock({ responses: [{ content: 'one two three' }] });
    const result = expectResponse(await call({ adapter: openAi(`${provider.url}/v1`), body: STREAM_BODY }));

    assert.equal(result.headers['content-type'], 'text/event-stream');
    const text = await readAll(result.body);
    const frames = text.split('\n\n').filter((frame) => frame !== '');
    assert.ok(
      frames.every((frame) => frame.startsWith('data: ')),
      'every frame is an SSE data line',
    );
    assert.equal(frames.at(-1), 'data: [DONE]');
    const deltas = frames
      .slice(0, -1)
      .map((frame) => JSON.parse(frame.slice('data: '.length)) as { choices: { delta: { content?: string } }[] })
      .map((chunk) => chunk.choices[0]?.delta.content ?? '')
      .join('');
    assert.equal(deltas, 'one two three');
    assert.equal((await result.completion).type, 'complete');
  });

  test('keeps the connection for reuse after a body read to its end', async () => {
    const provider = await mock();
    const adapter = openAi(`${provider.url}/v1`);
    const first = expectResponse(await call({ adapter }));
    await readAll(first.body);
    await first.completion;
    const second = expectResponse(await call({ adapter }));
    await readAll(second.body);
    assert.equal((await second.completion).type, 'complete');
    assert.equal(provider.requests.length, 2);
    const firstClosed = await Promise.race([
      provider.waitForDisconnect(0).then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
    ]);
    assert.equal(firstClosed, false, 'the connection of the first call is still open');
  });
});

describe('callUpstream: outbound headers', () => {
  test('sends exactly the allow-listed client headers plus the adapter credentials (OpenAI format)', async () => {
    const provider = await mock();
    const url = new URL(provider.url);
    const result = expectResponse(await call({ adapter: openAi(`${provider.url}/v1`), clientHeaders: CLIENT_HEADERS }));
    await readAll(result.body);

    assert.deepEqual(provider.requests[0]?.headers, {
      host: url.host,
      connection: 'keep-alive',
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': 'OpenAI/JS 6.0.0',
      'accept-encoding': 'identity',
      'content-length': String(Buffer.byteLength(CHAT_BODY)),
      authorization: `Bearer ${OPENAI_KEY}`,
    });
  });

  test('sends the Anthropic protocol headers to an Anthropic-format provider, with its own version and key', async () => {
    const provider = await mock();
    const url = new URL(provider.url);
    const result = expectResponse(
      await call({ adapter: anthropic(provider.url), body: ANTHROPIC_BODY, clientHeaders: CLIENT_HEADERS }),
    );
    await readAll(result.body);

    assert.equal(provider.requests[0]?.path, '/v1/messages');
    assert.deepEqual(provider.requests[0]?.headers, {
      host: url.host,
      connection: 'keep-alive',
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': 'OpenAI/JS 6.0.0',
      'accept-encoding': 'identity',
      'content-length': String(Buffer.byteLength(ANTHROPIC_BODY)),
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'tools-2024-04-04',
      'x-api-key': ANTHROPIC_KEY,
    });
  });

  test('never forwards the client credentials to a provider that needs no key', async () => {
    const provider = await mock();
    const result = expectResponse(
      await call({ adapter: openAi(`${provider.url}/v1`, null, 'ollama'), clientHeaders: CLIENT_HEADERS }),
    );
    await readAll(result.body);

    const sent = provider.requests[0]?.headers ?? {};
    assert.equal(sent.authorization, undefined);
    assert.equal(sent['x-api-key'], undefined);
    assert.deepEqual(Object.keys(sent).sort(), [
      'accept',
      'accept-encoding',
      'connection',
      'content-length',
      'content-type',
      'host',
      'user-agent',
    ]);
    assert.ok(!JSON.stringify(sent).includes(CLIENT_KEY), 'the client key never leaves');
  });

  test('defaults the content type to JSON when the client sent none', async () => {
    const provider = await mock();
    const result = expectResponse(await call({ adapter: openAi(`${provider.url}/v1`), clientHeaders: {} }));
    await readAll(result.body);
    assert.equal(provider.requests[0]?.headers['content-type'], 'application/json');
    assert.equal(provider.requests[0]?.headers['user-agent'], undefined);
  });

  test('reports a missing key as an auth error without any network call', async () => {
    const provider = await mock();
    const result = await call({ adapter: openAi(`${provider.url}/v1`), env: {} });
    assert.deepEqual(result, {
      type: 'error',
      error: { kind: 'auth', status: null, message: 'openai: the environment variable OPENAI_API_KEY is not set' },
    });
    assert.equal(provider.requests.length, 0);
  });
});

describe('callUpstream: provider errors', () => {
  test('maps an error status through the adapter, with the message masked', async () => {
    const provider = await mock({
      failWith: { status: 429, message: `Rate limit reached for key ${OPENAI_KEY}`, type: 'rate_limit_error' },
    });
    const result = await call({ adapter: openAi(`${provider.url}/v1`) });
    assert.deepEqual(result, {
      type: 'error',
      error: { kind: 'rate_limit', status: 429, message: 'Rate limit reached for key [REDACTED]' },
    });
  });

  test('maps an Anthropic overloaded status', async () => {
    const provider = await mock({ failWith: { status: 529, message: 'Overloaded' } });
    const result = await call({ adapter: anthropic(provider.url), body: ANTHROPIC_BODY });
    assert.deepEqual(result, { type: 'error', error: { kind: 'overloaded', status: 529, message: 'Overloaded' } });
  });
});

describe('callUpstream: timeouts', () => {
  test('connect_ms: a TLS handshake that never completes is a timeout', async () => {
    const held: net.Socket[] = [];
    const port = await rawServer((socket) => {
      held.push(socket);
      socket.on('error', () => undefined);
    });
    const startedAt = Date.now();
    const result = await call({
      adapter: openAi(`https://127.0.0.1:${port}/v1`),
      timeouts: { connect_ms: 150, first_byte_ms: 5_000, total_ms: 10_000 },
    });
    assert.deepEqual(result, { type: 'error', error: { kind: 'timeout', status: null, message: undefined } });
    assert.ok(Date.now() - startedAt < 2_000, 'gave up at connect_ms, not at a later timeout');
    for (const socket of held) socket.destroy();
  });

  test('first_byte_ms: response headers delayed by latencyMs is a timeout', async () => {
    const provider = await mock({ latencyMs: 1_000 });
    const startedAt = Date.now();
    const result = await call({
      adapter: openAi(`${provider.url}/v1`),
      timeouts: { connect_ms: 5_000, first_byte_ms: 150, total_ms: 10_000 },
    });
    assert.deepEqual(result, { type: 'error', error: { kind: 'timeout', status: null, message: undefined } });
    assert.ok(Date.now() - startedAt < 900, 'gave up at first_byte_ms, before the delayed response');
    await provider.waitForDisconnect(0);
  });

  test('first_byte_ms: a provider that never answers (hang) is a timeout and the connection is closed', async () => {
    const provider = await mock({ hang: true });
    const result = await call({
      adapter: openAi(`${provider.url}/v1`),
      timeouts: { connect_ms: 5_000, first_byte_ms: 150, total_ms: 10_000 },
    });
    assert.deepEqual(result, { type: 'error', error: { kind: 'timeout', status: null, message: undefined } });
    await provider.waitForDisconnect(0);
  });

  test('total_ms: a stream whose first chunk is delayed (firstByteDelayMs) is cut off as a timeout', async () => {
    const provider = await mock({ firstByteDelayMs: 1_000 });
    const log = captureLog();
    const result = expectResponse(
      await call({
        adapter: openAi(`${provider.url}/v1`),
        body: STREAM_BODY,
        timeouts: { connect_ms: 5_000, first_byte_ms: 150, total_ms: 250 },
        logger: log.logger,
      }),
    );
    assert.equal(result.status, 200, 'the headers arrived in time');
    await assert.rejects(readAll(result.body), {
      name: 'UpstreamBodyError',
      message: 'upstream response failed: timeout',
    });
    const completion = await result.completion;
    assert.equal(completion.type, 'error');
    assert.deepEqual((completion as Extract<UpstreamCompletion, { type: 'error' }>).error, {
      kind: 'timeout',
      status: null,
      message: undefined,
    });
    await provider.waitForDisconnect(0);
    const failed = log.lines().find((line) => line.msg === 'upstream response failed');
    assert.equal(failed?.errorKind, 'timeout');
  });

  test('total_ms also bounds a slow response when first_byte_ms equals it', async () => {
    const provider = await mock({ latencyMs: 1_000 });
    const result = await call({
      adapter: openAi(`${provider.url}/v1`),
      timeouts: { connect_ms: 5_000, first_byte_ms: 200, total_ms: 200 },
    });
    assert.deepEqual(result, { type: 'error', error: { kind: 'timeout', status: null, message: undefined } });
  });
});

describe('callUpstream: connection failures', () => {
  test('a refused connection is a connection error', async () => {
    const port = await closedPort();
    const result = await call({ adapter: openAi(`http://127.0.0.1:${port}/v1`) });
    assert.deepEqual(result, { type: 'error', error: { kind: 'connection', status: null, message: undefined } });
  });

  test('a connection reset before any answer is a connection error', async () => {
    const port = await rawServer((socket) => {
      socket.on('error', () => undefined);
      socket.once('data', () => socket.resetAndDestroy());
    });
    const result = await call({ adapter: openAi(`http://127.0.0.1:${port}/v1`) });
    assert.deepEqual(result, { type: 'error', error: { kind: 'connection', status: null, message: undefined } });
  });

  test('a stream dropped mid-way ends the body with a connection error', async () => {
    const provider = await mock({ dropMidStream: true });
    const result = expectResponse(await call({ adapter: openAi(`${provider.url}/v1`), body: STREAM_BODY }));
    await assert.rejects(readAll(result.body));
    const completion = await result.completion;
    assert.equal(completion.type, 'error');
    assert.equal((completion as Extract<UpstreamCompletion, { type: 'error' }>).error.kind, 'connection');
  });
});

describe('callUpstream: caller abort', () => {
  test('aborting before the response closes the upstream connection', async () => {
    const provider = await mock({ hang: true });
    const controller = new AbortController();
    const pending = call({ adapter: openAi(`${provider.url}/v1`), signal: controller.signal });
    await waitFor(() => provider.requests.length === 1, 'the provider to receive the request');
    controller.abort();
    assert.deepEqual(await pending, { type: 'aborted' });
    await provider.waitForDisconnect(0);
  });

  test('aborting mid-stream destroys the body and closes the upstream connection', async () => {
    const provider = await mock({ firstByteDelayMs: 5_000 });
    const controller = new AbortController();
    const result = expectResponse(
      await call({ adapter: openAi(`${provider.url}/v1`), body: STREAM_BODY, signal: controller.signal }),
    );
    controller.abort();
    await assert.rejects(readAll(result.body), { name: 'UpstreamBodyError', message: 'upstream response aborted' });
    assert.equal((await result.completion).type, 'aborted');
    await provider.waitForDisconnect(0);
  });

  test('an already aborted signal sends nothing', async () => {
    const provider = await mock();
    const result = await call({ adapter: openAi(`${provider.url}/v1`), signal: AbortSignal.abort() });
    assert.deepEqual(result, { type: 'aborted' });
    assert.equal(provider.requests.length, 0);
  });
});

/** Lets any late event of a destroyed request (e.g. its 'error') run, so a stray log line would show up. */
function settleEvents(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50));
}

function summary(log: CapturedLog): { msg: unknown; level: unknown; errorKind: unknown }[] {
  return log.lines().map((line) => ({ msg: line.msg, level: line.level, errorKind: line.errorKind }));
}

describe('callUpstream: logging', () => {
  test('a connect timeout logs one timeout line and nothing else', async () => {
    const held: net.Socket[] = [];
    const port = await rawServer((socket) => {
      held.push(socket);
      socket.on('error', () => undefined);
    });
    const log = captureLog();
    await call({
      adapter: openAi(`https://127.0.0.1:${port}/v1`),
      timeouts: { connect_ms: 150, first_byte_ms: 5_000, total_ms: 10_000 },
      logger: log.logger,
    });
    await settleEvents();
    for (const socket of held) socket.destroy();
    assert.deepEqual(summary(log), [{ msg: 'upstream call failed', level: 'warn', errorKind: 'timeout' }]);
  });

  test('a first-byte timeout (hang) logs one timeout line and no connection failure', async () => {
    const provider = await mock({ hang: true });
    const log = captureLog();
    await call({
      adapter: openAi(`${provider.url}/v1`),
      timeouts: { connect_ms: 5_000, first_byte_ms: 100, total_ms: 10_000 },
      logger: log.logger,
    });
    await provider.waitForDisconnect(0);
    await settleEvents();
    assert.deepEqual(summary(log), [{ msg: 'upstream call failed', level: 'warn', errorKind: 'timeout' }]);
  });

  test('a total timeout before the headers logs one timeout line and no connection failure', async () => {
    const provider = await mock({ latencyMs: 1_000 });
    const log = captureLog();
    await call({
      adapter: openAi(`${provider.url}/v1`),
      timeouts: { connect_ms: 5_000, first_byte_ms: 200, total_ms: 200 },
      logger: log.logger,
    });
    await provider.waitForDisconnect(0);
    await settleEvents();
    assert.deepEqual(summary(log), [{ msg: 'upstream call failed', level: 'warn', errorKind: 'timeout' }]);
  });

  test('a total timeout mid-stream logs the response, then one timeout failure', async () => {
    const provider = await mock({ firstByteDelayMs: 1_000 });
    const log = captureLog();
    const result = expectResponse(
      await call({
        adapter: openAi(`${provider.url}/v1`),
        body: STREAM_BODY,
        timeouts: { connect_ms: 5_000, first_byte_ms: 150, total_ms: 250 },
        logger: log.logger,
      }),
    );
    await assert.rejects(readAll(result.body));
    await result.completion;
    await provider.waitForDisconnect(0);
    await settleEvents();
    assert.deepEqual(summary(log), [
      { msg: 'upstream response', level: 'debug', errorKind: undefined },
      { msg: 'upstream response failed', level: 'warn', errorKind: 'timeout' },
    ]);
  });

  test('a refused connection logs one connection line', async () => {
    const port = await closedPort();
    const log = captureLog();
    await call({ adapter: openAi(`http://127.0.0.1:${port}/v1`), logger: log.logger });
    await settleEvents();
    assert.deepEqual(summary(log), [{ msg: 'upstream call failed', level: 'warn', errorKind: 'connection' }]);
  });

  test('a client abort before the response logs one debug line and no failure', async () => {
    const provider = await mock({ hang: true });
    const log = captureLog();
    const controller = new AbortController();
    const pending = call({ adapter: openAi(`${provider.url}/v1`), signal: controller.signal, logger: log.logger });
    await waitFor(() => provider.requests.length === 1, 'the provider to receive the request');
    controller.abort();
    await pending;
    await provider.waitForDisconnect(0);
    await settleEvents();
    assert.deepEqual(summary(log), [{ msg: 'upstream call aborted', level: 'debug', errorKind: undefined }]);
  });

  test('a client abort mid-stream logs the response, then one abort line and no failure', async () => {
    const provider = await mock({ firstByteDelayMs: 5_000 });
    const log = captureLog();
    const controller = new AbortController();
    const result = expectResponse(
      await call({
        adapter: openAi(`${provider.url}/v1`),
        body: STREAM_BODY,
        signal: controller.signal,
        logger: log.logger,
      }),
    );
    controller.abort();
    await assert.rejects(readAll(result.body));
    await result.completion;
    await provider.waitForDisconnect(0);
    await settleEvents();
    assert.deepEqual(summary(log), [
      { msg: 'upstream response', level: 'debug', errorKind: undefined },
      { msg: 'upstream response aborted', level: 'debug', errorKind: undefined },
    ]);
  });

  test('logs only provider id, status, error kind and duration; never the URL, query, headers or bodies', async () => {
    const provider = await mock({ failWith: { status: 500, message: 'upstream exploded' } });
    const log = captureLog();
    const ok = await mock({ responses: [{ content: 'secret-looking answer text' }] });

    await call({
      adapter: openAi(`${provider.url}/v1`),
      path: '/chat/completions?api-version=2024&trace=abc',
      clientHeaders: CLIENT_HEADERS,
      logger: log.logger,
    });
    const success = expectResponse(
      await call({ adapter: openAi(`${ok.url}/v1`), clientHeaders: CLIENT_HEADERS, logger: log.logger }),
    );
    await readAll(success.body);
    await success.completion;

    const lines = log.lines();
    assert.deepEqual(
      lines.map((line) => line.msg),
      ['upstream call failed', 'upstream response', 'upstream response complete'],
    );
    const allowed = new Set(['time', 'level', 'msg', 'provider', 'status', 'errorKind', 'durationMs']);
    for (const line of lines) {
      for (const field of Object.keys(line)) assert.ok(allowed.has(field), `unexpected log field ${field}`);
      assert.equal(line.provider, 'openai');
      assert.equal(typeof line.durationMs, 'number');
    }
    assert.equal(lines[0]?.status, 500);
    assert.equal(lines[0]?.errorKind, 'server');
    assert.equal(lines[2]?.status, 200);

    const raw = log.raw();
    for (const forbidden of [
      '127.0.0.1',
      'api-version',
      'trace=abc',
      '/chat/completions',
      'upstream exploded',
      'secret-looking answer text',
      'Hi',
      OPENAI_KEY,
      CLIENT_KEY,
      'OpenAI/JS',
    ]) {
      assert.ok(!raw.includes(forbidden), `the log must not contain ${forbidden}`);
    }
  });
});
