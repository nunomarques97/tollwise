import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { Agent, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import { type AddressInfo, connect } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import { loadConfig } from '../src/config/load.ts';
import { DEFAULT_HOST, DEFAULT_PORT, type ProviderId } from '../src/config/schema.ts';
import { createHealthMonitor } from '../src/health/monitor.ts';
import { createLogger, type LogSink } from '../src/log/logger.ts';
import { clearSecretValues } from '../src/log/redact.ts';
import { mapProviderError } from '../src/providers/errors.ts';
import type { ProviderAdapter } from '../src/providers/types.ts';
import { readBody } from '../src/server/body.ts';
import { sendJson } from '../src/server/respond.ts';
import { matchRoute, ROUTES, type Route, requestPath } from '../src/server/router.ts';
import { baseUrl, createTollwiseServer, listen, stopServer } from '../src/server/server.ts';
import { credentialValues, type SignalSource, startTollwise } from '../src/server/start.ts';
import { freePort, send } from './fixtures/http-client.ts';
import { type MockProvider, startMockProvider } from './fixtures/mock-provider.ts';

// Fake credentials with no known key shape, so only path stripping and the runtime registry can hide them.
const FAKE_QUERY_KEY = `fakeQuery${'Qz7'.repeat(8)}`;
const FAKE_HEADER_KEY = `fakeHeader${'Hx4'.repeat(8)}`;
const FAKE_PROVIDER_KEY = `fakeProvider${'Pv2'.repeat(8)}`;
const FAKE_ACCESS_KEY = `fakeAccess${'Ak9'.repeat(8)}`;

const JSON_TYPE = { 'content-type': 'application/json' } as const;

interface CapturedLog extends LogSink {
  readonly lines: string[];
  records(): Record<string, unknown>[];
}

function captureLog(): CapturedLog {
  const lines: string[] = [];
  return {
    lines,
    write(chunk: string) {
      lines.push(chunk);
      return true;
    },
    records() {
      return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    },
  };
}

/** Waits until the request log line for the latest response has been written (it is written on 'close'). */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

function assertOpenAiError(json: unknown, code: string): string {
  const body = json as { error?: { message?: unknown; type?: unknown; param?: unknown; code?: unknown } };
  assert.ok(body.error !== undefined, 'error object present');
  assert.equal(typeof body.error.message, 'string');
  assert.equal(typeof body.error.type, 'string');
  assert.equal(body.error.param, null);
  assert.equal(body.error.code, code);
  return body.error.message as string;
}

describe('router', () => {
  test('GET /healthz matches, and HEAD is accepted with it', () => {
    assert.equal(matchRoute('GET', '/healthz').kind, 'found');
    assert.equal(matchRoute('HEAD', '/healthz').kind, 'found');
  });

  test('another method on a known path is a 405 with the allowed methods', () => {
    assert.deepEqual(matchRoute('POST', '/healthz'), { kind: 'method_not_allowed', allow: ['GET', 'HEAD'] });
  });

  test('prefix routes match on a segment boundary only', () => {
    assert.equal(matchRoute('POST', '/v1/images').kind, 'found');
    assert.equal(matchRoute('POST', '/v1/images/generations').kind, 'found');
    assert.equal(matchRoute('POST', '/v1/imagesfoo').kind, 'not_found');
    assert.equal(matchRoute('GET', '/healthz/extra').kind, 'not_found');
    assert.equal(matchRoute('GET', '/unknown').kind, 'not_found');
  });

  test('requestPath drops the query string, the fragment and any absolute-form host', () => {
    assert.equal(requestPath(`/healthz?api_key=${FAKE_QUERY_KEY}`), '/healthz'); // tollwise-allow-secret
    assert.equal(requestPath('/a/b#frag?x=1'), '/a/b');
    assert.equal(requestPath('http://user:pw@example.test/v1/x?y=1'), '/v1/x');
    assert.equal(requestPath('*'), '[invalid]');
    assert.equal(requestPath(''), '/');
  });
});

describe('server', () => {
  const log = captureLog();
  const maxBodyBytes = 1024;
  const routes: Route[] = [
    ...ROUTES,
    {
      methods: ['POST'],
      path: '/test/read-body',
      match: 'exact',
      handler: async ({ req, res, maxBodyBytes: limit }) => {
        const body = await readBody(req, limit);
        sendJson(res, 200, { bytes: body.length });
      },
    },
  ];
  let server: Server;
  let url: string;

  before(async () => {
    server = createTollwiseServer({ maxBodyBytes, logger: createLogger({ level: 'debug', sink: log }), routes });
    const address = await listen(server, '127.0.0.1', 0);
    url = baseUrl('127.0.0.1', address.port);
  });
  after(async () => {
    await stopServer(server, 100);
  });
  afterEach(() => {
    log.lines.length = 0;
  });

  test('GET /healthz returns liveness JSON', async () => {
    const res = await send(url, '/healthz');
    assert.equal(res.status, 200);
    assert.match(String(res.headers['content-type']), /^application\/json/);
    assert.deepEqual(res.json, { status: 'ok' });
  });

  test('an unknown route returns a JSON 404', async () => {
    const res = await send(url, '/v1/nothing-here');
    assert.equal(res.status, 404);
    assert.match(String(res.headers['content-type']), /^application\/json/);
    assertOpenAiError(res.json, 'not_found');
  });

  test('a wrong method returns a JSON 405 with an Allow header', async () => {
    const res = await send(url, '/healthz', { method: 'DELETE' });
    assert.equal(res.status, 405);
    assert.equal(res.headers.allow, 'GET, HEAD');
    assertOpenAiError(res.json, 'method_not_allowed');
  });

  const outOfScope: [string, string, string][] = [
    ['POST', '/v1/responses', '/v1/responses'],
    ['POST', '/v1/embeddings', '/v1/embeddings'],
    ['POST', '/v1/images/generations', '/v1/images'],
    ['POST', '/v1/audio/transcriptions', '/v1/audio'],
    ['POST', '/v1/batches', '/v1/batches'],
    ['GET', '/v1/assistants', '/v1/assistants'],
    ['POST', '/v1/assistants/asst_1', '/v1/assistants'],
  ];
  for (const [method, target, endpoint] of outOfScope) {
    test(`${method} ${target} returns 501 with an OpenAI-shaped "not supported" error`, async () => {
      // GET carries no body: node:http would send it unframed, which is a malformed second request.
      const body = method === 'GET' ? {} : { headers: { 'content-type': 'application/json' }, body: '{}' };
      const res = await send(url, target, { method, ...body });
      assert.equal(res.status, 501);
      const message = assertOpenAiError(res.json, 'unsupported_endpoint');
      assert.equal((res.json as { error: { type: string } }).error.type, 'invalid_request_error');
      assert.match(message, new RegExp(`^The ${endpoint} endpoint is not supported by Tollwise\\.`));
    });
  }

  test('a Content-Length above the limit gets 413 before the rest of the body is sent', async () => {
    const address = server.address() as AddressInfo;
    const declared = 50 * 1024 * 1024;
    const req = httpRequest({
      host: '127.0.0.1',
      port: address.port,
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json', 'content-length': String(declared) },
    });
    req.on('error', () => {
      // The server closes the connection while the upload is unfinished; that is the point.
    });
    req.write('x'.repeat(100));
    const [res] = (await once(req, 'response')) as [IncomingMessage];
    const chunks: Buffer[] = [];
    for await (const chunk of res) chunks.push(chunk as Buffer);
    req.destroy();

    assert.equal(res.statusCode, 413);
    assert.equal(res.headers.connection, 'close');
    const message = assertOpenAiError(JSON.parse(Buffer.concat(chunks).toString('utf8')), 'request_too_large');
    assert.match(message, /1024-byte limit/);
    assert.match(message, /server\.max_body_size/);
  });

  test('a chunked body that crosses the limit gets 413 as soon as it does', async () => {
    const address = server.address() as AddressInfo;
    const req = httpRequest({
      host: '127.0.0.1',
      port: address.port,
      method: 'POST',
      path: '/test/read-body',
      headers: JSON_TYPE,
    });
    req.on('error', () => {});
    req.write('a'.repeat(700));
    req.write('b'.repeat(700));
    const [res] = (await once(req, 'response')) as [IncomingMessage];
    res.resume();
    req.destroy();
    assert.equal(res.statusCode, 413);
    assert.equal(res.headers['transfer-encoding'], undefined);
  });

  // Regression: an early answer to a request whose multi-MB body is still uploading must reach the client.
  // Destroying the socket with unread incoming data resets the connection and the client saw ECONNRESET.
  const bigBody = Buffer.alloc(4 * 1024 * 1024, 0x78);

  test('fetch gets the 413 for a full multi-MB body above the limit', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: bigBody,
      });
      assert.equal(res.status, 413);
      assert.equal(res.headers.get('connection'), 'close');
      const message = assertOpenAiError(await res.json(), 'request_too_large');
      assert.match(message, /1024-byte limit/);
    }
  });

  test('a body within the limit is read whole', async () => {
    const res = await send(url, '/test/read-body', { method: 'POST', headers: JSON_TYPE, body: 'c'.repeat(1000) });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { bytes: 1000 });
  });

  test('the request log line has method, path without query, status and duration only', async () => {
    await send(url, `/healthz?api_key=${FAKE_QUERY_KEY}&x=1`, {
      headers: { authorization: `Bearer ${FAKE_HEADER_KEY}`, 'x-api-key': FAKE_HEADER_KEY },
    });
    await settle();
    const records = log.records().filter((record) => record.msg === 'request');
    assert.equal(records.length, 1);
    const record = records[0] as Record<string, unknown>;
    assert.deepEqual(Object.keys(record).sort(), ['duration_ms', 'level', 'method', 'msg', 'path', 'status', 'time']);
    assert.equal(record.method, 'GET');
    assert.equal(record.path, '/healthz');
    assert.equal(record.status, 200);
    assert.equal(typeof record.duration_ms, 'number');

    const output = log.lines.join('');
    assert.ok(!output.includes(FAKE_QUERY_KEY), 'query value is not logged');
    assert.ok(!output.includes(FAKE_HEADER_KEY), 'header values are not logged');
    assert.ok(!output.includes('api_key'), 'the query string is not logged at all');
    assert.ok(!/authorization|x-api-key/i.test(output), 'header names are not logged');
  });

  test('a malformed request is answered 400 and logs only the parser code', async () => {
    const address = server.address() as AddressInfo;
    const socket = connect({ host: '127.0.0.1', port: address.port });
    await once(socket, 'connect');
    socket.write(`GARBAGE ${FAKE_HEADER_KEY}\r\n\r\n`);
    let reply = '';
    for await (const chunk of socket) reply += String(chunk);
    assert.match(reply, /^HTTP\/1\.1 400 Bad Request/);
    await settle();
    const output = log.lines.join('');
    assert.ok(!output.includes(FAKE_HEADER_KEY));
    assert.match(output, /malformed request rejected/);
  });
});

describe('GET /api/health', () => {
  /** A minimal OpenAI-shaped adapter pointed at a mock provider, as in test/health-monitor.test.ts. */
  function testAdapter(id: ProviderId, url: string): ProviderAdapter {
    return {
      id,
      wireFormat: 'openai',
      baseUrl: url,
      chatPath: '/v1/chat/completions',
      healthRequest: { method: 'GET', path: '/v1/models' },
      isConfigured: () => true,
      authHeaders: () => ({}),
      url: (path: string) => `${url}${path}`,
      mapError: mapProviderError,
    };
  }

  const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

  let up: MockProvider;
  let down: MockProvider;
  let server: Server;
  let url: string;

  before(async () => {
    up = await startMockProvider({});
    down = await startMockProvider({ failWith: { status: 500, message: 'boom' } });
    // openai is checked and healthy; anthropic is checked and failing; deepseek is monitored but never
    // checked (still 'unknown'); openrouter is not passed in at all (as an unconfigured provider would
    // be excluded from the registry, so it never reaches the monitor).
    const monitor = createHealthMonitor({
      adapters: [testAdapter('openai', up.url), testAdapter('anthropic', down.url), testAdapter('deepseek', up.url)],
      env: {},
      logger: createLogger({ sink: captureLog() }),
    });
    await monitor.checkNow('openai');
    await monitor.checkNow('anthropic');

    server = createTollwiseServer({
      maxBodyBytes: 1024,
      logger: createLogger({ sink: captureLog() }),
      healthMonitor: monitor,
    });
    const address = await listen(server, '127.0.0.1', 0);
    url = baseUrl('127.0.0.1', address.port);
  });
  after(async () => {
    await stopServer(server, 100);
    await Promise.all([up.close(), down.close()]);
  });

  test('reports up for a healthy mock provider, with a latency sample and an ISO timestamp', async () => {
    const res = await send(url, '/api/health');
    assert.equal(res.status, 200);
    assert.match(String(res.headers['content-type']), /^application\/json/);
    const openai = (res.json as { providers: Record<string, Record<string, unknown>> }).providers.openai;
    assert.equal(openai?.state, 'up');
    assert.equal(typeof openai?.p50_ms, 'number');
    assert.equal(typeof openai?.p95_ms, 'number');
    assert.equal(openai?.samples, 1);
    assert.equal(openai?.last_error_kind, null);
    assert.match(String(openai?.last_checked), ISO_8601);
  });

  test('reports down for a failing mock provider, with the mapped error kind', async () => {
    const res = await send(url, '/api/health');
    const anthropic = (res.json as { providers: Record<string, Record<string, unknown>> }).providers.anthropic;
    assert.equal(anthropic?.state, 'down');
    assert.equal(anthropic?.last_error_kind, 'server');
    assert.match(String(anthropic?.last_checked), ISO_8601);
  });

  test('a monitored provider not yet checked reports unknown, with no latency yet', async () => {
    const res = await send(url, '/api/health');
    const providers = (res.json as { providers: Record<string, Record<string, unknown>> }).providers;
    assert.deepEqual(providers.deepseek, {
      state: 'unknown',
      p50_ms: null,
      p95_ms: null,
      last_checked: null,
      samples: 0,
      last_error_kind: null,
    });
  });

  test('a provider never passed to the monitor (unconfigured) is absent, not just unknown', async () => {
    const res = await send(url, '/api/health');
    const providers = (res.json as { providers: Record<string, Record<string, unknown>> }).providers;
    assert.equal(Object.hasOwn(providers, 'openrouter'), false);
    assert.equal(Object.hasOwn(providers, 'ollama'), false);
  });

  test('with no health monitor wired in, the endpoint answers an empty snapshot', async () => {
    const bareServer = createTollwiseServer({ maxBodyBytes: 1024, logger: createLogger({ sink: captureLog() }) });
    const address = await listen(bareServer, '127.0.0.1', 0);
    try {
      const res = await send(baseUrl('127.0.0.1', address.port), '/api/health');
      assert.equal(res.status, 200);
      assert.deepEqual(res.json, { providers: {} });
    } finally {
      await stopServer(bareServer, 100);
    }
  });
});

describe('early answers to requests with multi-MB bodies', () => {
  // A 16 MiB limit, so that multi-MB bodies reach the 404 and 501 routes; the default discard bounds.
  const bigBody = Buffer.alloc(4 * 1024 * 1024, 0x78);
  const hugeBody = Buffer.alloc(24 * 1024 * 1024, 0x78);
  let server: Server;
  let port: number;

  before(async () => {
    server = createTollwiseServer({ maxBodyBytes: 16 * 1024 * 1024, logger: createLogger({ sink: captureLog() }) });
    port = (await listen(server, '127.0.0.1', 0)).port;
  });
  after(async () => {
    await stopServer(server, 100);
  });

  test('fetch gets the 413 for a body above a 16 MiB limit', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: JSON_TYPE,
      body: hugeBody,
    });
    assert.equal(res.status, 413);
    assert.match(assertOpenAiError(await res.json(), 'request_too_large'), /16777216-byte limit/);
  });

  test('http.request with a keep-alive agent gets 413 and 501 answers, then its next request works', async () => {
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    const post = (path: string, body: Buffer): Promise<{ status: number; text: string }> =>
      new Promise((resolve, reject) => {
        const req = httpRequest(
          {
            agent,
            host: '127.0.0.1',
            port,
            method: 'POST',
            path,
            headers: { ...JSON_TYPE, 'content-length': body.length },
          },
          (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => {
              text += chunk;
            });
            res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
            res.on('error', reject);
          },
        );
        req.on('error', reject);
        req.end(body);
      });
    try {
      const tooLarge = await post('/v1/chat/completions', hugeBody);
      assert.equal(tooLarge.status, 413);
      assertOpenAiError(JSON.parse(tooLarge.text), 'request_too_large');
      const unsupported = await post('/v1/audio/transcriptions', bigBody);
      assert.equal(unsupported.status, 501);
      const small = await post('/v1/nothing-here', Buffer.from('{}'));
      assert.equal(small.status, 404);
    } finally {
      agent.destroy();
    }
  });

  for (const target of ['/v1/audio/transcriptions', '/v1/embeddings', '/v1/images/edits']) {
    test(`fetch gets the OpenAI-shaped 501 for a multi-MB POST to ${target}`, async () => {
      const res = await fetch(`http://127.0.0.1:${port}${target}`, {
        method: 'POST',
        headers: JSON_TYPE,
        body: bigBody,
      });
      assert.equal(res.status, 501);
      const message = assertOpenAiError(await res.json(), 'unsupported_endpoint');
      assert.match(message, /is not supported by Tollwise/);
    });
  }

  test('fetch gets the JSON 404 for a multi-MB POST to an unknown path', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/nothing-here`, {
      method: 'POST',
      headers: JSON_TYPE,
      body: bigBody,
    });
    assert.equal(res.status, 404);
    assertOpenAiError(await res.json(), 'not_found');
  });
});

describe('dropping an unread body is bounded', () => {
  const limits = { maxBytes: 64 * 1024, maxMs: 300, lingerMs: 200 };
  let server: Server;
  let port: number;

  before(async () => {
    server = createTollwiseServer({
      maxBodyBytes: 2 * 1024 * 1024,
      logger: createLogger({ sink: captureLog() }),
      discardLimits: limits,
    });
    port = (await listen(server, '127.0.0.1', 0)).port;
  });
  after(async () => {
    await stopServer(server, 100);
  });

  test('a body far past the byte bound still gets its answer', async () => {
    const tooLarge = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: JSON_TYPE,
      body: Buffer.alloc(16 * 1024 * 1024, 0x78),
    });
    assert.equal(tooLarge.status, 413);
    assertOpenAiError(await tooLarge.json(), 'request_too_large');
    const unsupported = await fetch(`http://127.0.0.1:${port}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: JSON_TYPE,
      body: Buffer.alloc(1536 * 1024, 0x78),
    });
    assert.equal(unsupported.status, 501);
    assertOpenAiError(await unsupported.json(), 'unsupported_endpoint');
  });

  /** Resolves once the server holds no connection any more; rejects after `withinMs`. */
  async function serverConnectionsGone(withinMs: number): Promise<void> {
    const deadline = performance.now() + withinMs;
    for (;;) {
      const count = await new Promise<number>((resolve, reject) =>
        server.getConnections((error, n) => (error ? reject(error) : resolve(n))),
      );
      if (count === 0) return;
      if (performance.now() > deadline) throw new Error(`${count} connection(s) still open after ${withinMs} ms`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  // The clients below keep their own side open after the server's FIN (allowHalfOpen), like a client that
  // ignores the answer: only the server's bounds can end these connections.

  test('a client that stops sending its body is cut off after the time bounds', async () => {
    const socket = connect({ host: '127.0.0.1', port, allowHalfOpen: true });
    socket.on('error', () => {});
    await once(socket, 'connect');
    const started = performance.now();
    socket.write(
      `POST /v1/embeddings HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\n` +
        `Content-Length: 1048576\r\n\r\n${'x'.repeat(2048)}`,
    );
    let reply = '';
    socket.on('data', (chunk: Buffer) => {
      reply += chunk.toString('utf8');
    });
    await once(socket, 'end');
    assert.match(reply, /^HTTP\/1\.1 501 /);
    assert.match(reply, /\r\nconnection: close\r\n/i);
    // The answer is followed by FIN at once; the socket itself is cut after maxMs + lingerMs.
    await serverConnectionsGone(limits.maxMs + limits.lingerMs + 1000);
    const cutAfter = performance.now() - started;
    assert.ok(cutAfter >= limits.maxMs + limits.lingerMs - 50, `cut after ${Math.round(cutAfter)} ms, too early`);
    socket.destroy();
  });

  test('a client that keeps uploading forever is cut off', async () => {
    const socket = connect({ host: '127.0.0.1', port, allowHalfOpen: true });
    socket.on('error', () => {});
    await once(socket, 'connect');
    let reply = '';
    socket.on('data', (data: Buffer) => {
      reply += data.toString('utf8');
    });
    socket.write(
      `POST /v1/nothing HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\n` +
        'Transfer-Encoding: chunked\r\n\r\n',
    );
    const chunk = `${(16 * 1024).toString(16)}\r\n${'x'.repeat(16 * 1024)}\r\n`;
    let sent = 0;
    const pump = setInterval(() => {
      if (!socket.writable) return;
      socket.write(chunk);
      sent += chunk.length;
    }, 2);
    try {
      const started = performance.now();
      // Not events.once: the reset the client gets when the server cuts the socket is an 'error' event.
      await new Promise((resolve) => socket.once('close', resolve));
      assert.match(reply, /^HTTP\/1\.1 404 /);
      assert.ok(sent > limits.maxBytes, `the client sent ${sent} bytes`);
      assert.ok(performance.now() - started < limits.maxMs + limits.lingerMs + 1000);
      await serverConnectionsGone(1000);
    } finally {
      clearInterval(pump);
    }
  });
});

describe('startTollwise', () => {
  const workDir = mkdtempSync(path.join(tmpdir(), 'tollwise-start-'));
  after(() => {
    rmSync(workDir, { recursive: true, force: true });
    clearSecretValues();
  });

  test('the configuration defaults to 127.0.0.1:8484', () => {
    const { config } = loadConfig({ env: {}, cwd: workDir });
    assert.equal(config.server.host, '127.0.0.1');
    assert.equal(config.server.port, 8484);
    assert.equal(DEFAULT_HOST, '127.0.0.1');
    assert.equal(DEFAULT_PORT, 8484);
  });

  test('credentialValues collects every provider key variable and TOLLWISE_ACCESS_KEY', () => {
    const { config } = loadConfig({ env: {}, cwd: workDir });
    const values = credentialValues(config, {
      OPENAI_API_KEY: FAKE_PROVIDER_KEY,
      OPENROUTER_API_KEY: ` ${FAKE_PROVIDER_KEY}x `,
      TOLLWISE_ACCESS_KEY: FAKE_ACCESS_KEY,
      UNRELATED: 'not collected at all',
    });
    assert.deepEqual(
      values.sort(),
      [FAKE_ACCESS_KEY, FAKE_PROVIDER_KEY, ` ${FAKE_PROVIDER_KEY}x `, `${FAKE_PROVIDER_KEY}x`].sort(),
    );
  });

  test('binds 127.0.0.1 by default, redacts configured keys in logs and stops on SIGTERM', async () => {
    const port = await freePort();
    const log = captureLog();
    const signals = new EventEmitter();
    // Every provider disabled: OPENAI_API_KEY is set purely to exercise redaction, and the health
    // monitor must never turn that into a real request to the real OpenAI API.
    const noProvidersDir = mkdtempSync(path.join(tmpdir(), 'tollwise-start-no-providers-'));
    writeFileSync(
      path.join(noProvidersDir, 'tollwise.yaml'),
      'providers:\n' +
        '  anthropic: { enabled: false }\n' +
        '  openai: { enabled: false }\n' +
        '  deepseek: { enabled: false }\n' +
        '  openrouter: { enabled: false }\n' +
        '  ollama: { enabled: false }\n',
    );
    const running = await startTollwise({
      env: { TOLLWISE_PORT: String(port), OPENAI_API_KEY: FAKE_PROVIDER_KEY, TOLLWISE_ACCESS_KEY: FAKE_ACCESS_KEY },
      cwd: noProvidersDir,
      logSink: log,
      signals: signals as SignalSource,
    });

    assert.equal(running.address.address, '127.0.0.1');
    assert.equal(running.url, `http://127.0.0.1:${port}`);
    const ready = log
      .records()
      .filter((record) => typeof record.msg === 'string' && record.msg.startsWith('Tollwise is ready'));
    assert.equal(ready.length, 1);
    assert.equal(ready[0]?.url, running.url);

    // A key that shows up in a request path is masked by the runtime registry, whatever its shape.
    // TOLLWISE_ACCESS_KEY is set and this request does not send it, so it is refused.
    const res = await send(running.url, `/v1/${FAKE_PROVIDER_KEY}/${FAKE_ACCESS_KEY}`);
    assert.equal(res.status, 401);
    await settle();
    const output = log.lines.join('');
    assert.ok(!output.includes(FAKE_PROVIDER_KEY));
    assert.ok(!output.includes(FAKE_ACCESS_KEY));
    assert.match(output, /"path":"\/v1\/\[REDACTED\]\/\[REDACTED\]"/);

    signals.emit('SIGTERM');
    assert.equal(await running.stopped, 0);
    assert.equal(signals.listenerCount('SIGTERM'), 0);
    assert.equal(signals.listenerCount('SIGINT'), 0);
    assert.ok(log.records().some((record) => record.msg === 'Tollwise stopped'));
    await assert.rejects(send(running.url, '/healthz'), { code: 'ECONNREFUSED' });
    rmSync(noProvidersDir, { recursive: true, force: true });
  });

  test('a port already in use is a StartError that says what to do', async () => {
    const blocker = createTollwiseServer({ maxBodyBytes: 1024, logger: createLogger({ sink: captureLog() }) });
    const address = await listen(blocker, '127.0.0.1', 0);
    try {
      await assert.rejects(
        startTollwise({
          env: { TOLLWISE_PORT: String(address.port) },
          cwd: workDir,
          logSink: captureLog(),
          signals: new EventEmitter() as SignalSource,
        }),
        { name: 'StartError', message: /already in use.*TOLLWISE_PORT/ },
      );
    } finally {
      await stopServer(blocker, 100);
    }
  });

  test('the health monitor starts after listen and stops its timers on SIGTERM', async () => {
    const mock = await startMockProvider({});
    const monitorDir = mkdtempSync(path.join(tmpdir(), 'tollwise-start-monitor-'));
    let running: Awaited<ReturnType<typeof startTollwise>> | undefined;
    try {
      writeFileSync(
        path.join(monitorDir, 'tollwise.yaml'),
        'providers:\n' +
          '  anthropic: { enabled: false }\n' +
          // The mock only serves /v1/models; openai's adapter appends "/models" to base_url.
          `  openai: { enabled: true, base_url: "${mock.url}/v1", api_key_env: OPENAI_API_KEY }\n` +
          '  deepseek: { enabled: false }\n' +
          '  openrouter: { enabled: false }\n' +
          '  ollama: { enabled: false }\n',
      );
      const port = await freePort();
      const signals = new EventEmitter();
      running = await startTollwise({
        env: { TOLLWISE_PORT: String(port), OPENAI_API_KEY: FAKE_PROVIDER_KEY },
        cwd: monitorDir,
        logSink: captureLog(),
        signals: signals as SignalSource,
      });

      // The monitor's immediate check runs asynchronously right after listen(); poll until it lands.
      const deadline = performance.now() + 2000;
      let openai: Record<string, unknown> | undefined;
      do {
        const res = await send(running.url, '/api/health');
        openai = (res.json as { providers: Record<string, Record<string, unknown>> }).providers.openai;
        if (openai?.state !== 'unknown') break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      } while (performance.now() < deadline);
      assert.equal(openai?.state, 'up', 'the configured provider was checked once Tollwise started listening');
      assert.equal(mock.requests.length, 1);

      signals.emit('SIGTERM');
      assert.equal(await running.stopped, 0);
      await assert.rejects(send(running.url, '/api/health'), { code: 'ECONNREFUSED' });
      running = undefined;
    } finally {
      await running?.stop();
      await mock.close();
      rmSync(monitorDir, { recursive: true, force: true });
    }
  });
});
