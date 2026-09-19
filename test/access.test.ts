// The local access key (TOLLWISE_ACCESS_KEY): checked on every request but GET or HEAD /healthz and /dashboard, credential
// headers stripped before any handler, never logged; and no network-exposed bind without it.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage, Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ConfigError } from '../src/config/errors.ts';
import { createLogger, type LogSink } from '../src/log/logger.ts';
import { clearSecretValues } from '../src/log/redact.ts';
import {
  ACCESS_DENIED_MESSAGE,
  CLIENT_CREDENTIAL_HEADERS,
  createAccessGuard,
  stripClientCredentials,
} from '../src/server/access.ts';
import { sendJson } from '../src/server/respond.ts';
import { ROUTES, type Route } from '../src/server/router.ts';
import { baseUrl, createTollwiseServer, listen, stopServer } from '../src/server/server.ts';
import { type SignalSource, startTollwise } from '../src/server/start.ts';
import { freePort, send, type TestResponse } from './fixtures/http-client.ts';

// Fake keys with no known key shape, so pattern redaction cannot hide them: a log line free of them proves
// they were never logged at all.
const ACCESS_KEY = `fakeLocal${'Kq8'.repeat(8)}`; // tollwise-allow-secret
// Same length as ACCESS_KEY, differing only in the last character.
const SAME_LENGTH_WRONG = `${ACCESS_KEY.slice(0, -1)}X`; // tollwise-allow-secret
const SHORT_WRONG = `fakeWrong${'Zt6'.repeat(3)}`; // tollwise-allow-secret
const CLIENT_KEY = `fakeClient${'Rn5'.repeat(8)}`; // tollwise-allow-secret

const here = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.join(here, '..', 'src', 'cli.ts');

interface CapturedLog extends LogSink {
  readonly lines: string[];
}

function captureLog(): CapturedLog {
  const lines: string[] = [];
  return {
    lines,
    write(chunk: string) {
      lines.push(chunk);
      return true;
    },
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

/** What a route handler still sees of the client's credential headers, in every form Node exposes them. */
function visibleCredentials(req: IncomingMessage): Record<string, unknown> {
  const names = [...CLIENT_CREDENTIAL_HEADERS];
  return {
    headers: names.filter((name) => req.headers[name] !== undefined),
    raw: req.rawHeaders.filter(
      (_, index) => index % 2 === 0 && names.includes(req.rawHeaders[index]?.toLowerCase() ?? ''),
    ),
    distinct: names.filter((name) => req.headersDistinct[name] !== undefined),
  };
}

const NO_CREDENTIALS = { headers: [], raw: [], distinct: [] };

const echoRoute: Route = {
  methods: 'any',
  path: '/test/echo-credentials',
  match: 'exact',
  handler: ({ req, res }) => {
    sendJson(res, 200, visibleCredentials(req));
  },
};

async function startServer(accessKey: string | undefined, log: CapturedLog): Promise<{ server: Server; url: string }> {
  const server = createTollwiseServer({
    maxBodyBytes: 1024,
    logger: createLogger({ level: 'debug', sink: log }),
    routes: [...ROUTES, echoRoute],
    accessKey,
  });
  const address = await listen(server, '127.0.0.1', 0);
  return { server, url: baseUrl('127.0.0.1', address.port) };
}

function assertDenied(res: TestResponse, ...notEchoed: string[]): void {
  assert.equal(res.status, 401);
  assert.equal(res.headers['www-authenticate'], 'Bearer realm="tollwise"');
  assert.deepEqual(res.json, {
    error: { message: ACCESS_DENIED_MESSAGE, type: 'invalid_request_error', param: null, code: 'invalid_api_key' },
  });
  for (const value of notEchoed) assert.ok(!res.text.includes(value), 'the 401 echoes nothing from the request');
}

describe('with TOLLWISE_ACCESS_KEY set', () => {
  const log = captureLog();
  let server: Server;
  let url: string;

  before(async () => {
    ({ server, url } = await startServer(ACCESS_KEY, log));
  });
  after(async () => {
    await stopServer(server, 100);
  });

  test('a request without any key is refused with 401', async () => {
    assertDenied(await send(url, '/test/echo-credentials'));
  });

  test('a wrong key is refused with 401, in either header', async () => {
    assert.notEqual(SHORT_WRONG.length, ACCESS_KEY.length);
    assertDenied(
      await send(url, '/test/echo-credentials', { headers: { authorization: `Bearer ${SHORT_WRONG}` } }),
      SHORT_WRONG,
    );
    assertDenied(await send(url, '/test/echo-credentials', { headers: { 'x-api-key': SHORT_WRONG } }), SHORT_WRONG);
  });

  test('a wrong key of the same length is refused with 401', async () => {
    assert.equal(SAME_LENGTH_WRONG.length, ACCESS_KEY.length);
    assert.notEqual(SAME_LENGTH_WRONG, ACCESS_KEY);
    assertDenied(
      await send(url, '/test/echo-credentials', { headers: { authorization: `Bearer ${SAME_LENGTH_WRONG}` } }),
      SAME_LENGTH_WRONG,
    );
    assertDenied(
      await send(url, '/test/echo-credentials', { headers: { 'x-api-key': SAME_LENGTH_WRONG } }),
      SAME_LENGTH_WRONG,
    );
  });

  test('the key without the Bearer scheme, or with extra text, is refused', async () => {
    for (const authorization of [ACCESS_KEY, `Basic ${ACCESS_KEY}`, `Bearer ${ACCESS_KEY} extra`, 'Bearer ']) {
      assertDenied(await send(url, '/test/echo-credentials', { headers: { authorization } }), ACCESS_KEY);
    }
    assertDenied(await send(url, '/test/echo-credentials', { headers: { 'x-api-key': `${ACCESS_KEY}x` } }));
  });

  test('the key is accepted as Authorization: Bearer, and the handler never sees the header', async () => {
    const res = await send(url, '/test/echo-credentials', { headers: { authorization: `Bearer ${ACCESS_KEY}` } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, NO_CREDENTIALS);
    const lower = await send(url, '/test/echo-credentials', { headers: { authorization: `bearer ${ACCESS_KEY}` } });
    assert.equal(lower.status, 200);
  });

  test('the key is accepted as x-api-key, and every credential header is stripped', async () => {
    const res = await send(url, '/test/echo-credentials', {
      headers: { 'X-Api-Key': ACCESS_KEY, 'api-key': CLIENT_KEY, 'x-goog-api-key': CLIENT_KEY },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, NO_CREDENTIALS);
  });

  test('GET /healthz needs no key', async () => {
    const res = await send(url, '/healthz');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { status: 'ok' });
  });

  test('HEAD /healthz needs no key', async () => {
    const res = await send(url, '/healthz', { method: 'HEAD' });
    assert.equal(res.status, 200);
  });

  test('POST /healthz still needs the key', async () => {
    // Content-Type: application/json so the request guard lets it through to the access check.
    const jsonPost = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' };
    assertDenied(await send(url, '/healthz', jsonPost));
    const res = await send(url, '/healthz', { ...jsonPost, headers: { ...jsonPost.headers, 'x-api-key': ACCESS_KEY } });
    assert.equal(res.status, 405);
    assert.equal(res.headers.allow, 'GET, HEAD');
  });

  test('every other path needs the key, known or not, before its body is read', async () => {
    assertDenied(await send(url, '/api/health'));
    assertDenied(await send(url, '/v1/nothing-here'));
    assertDenied(await send(url, '/healthz/extra'));
    assertDenied(
      await send(url, '/v1/embeddings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'x'.repeat(4096),
      }),
    );
    assert.equal((await send(url, '/v1/nothing-here', { headers: { 'x-api-key': ACCESS_KEY } })).status, 404);
  });

  test('the captured logs contain no key, accepted or refused', async () => {
    await send(url, '/test/echo-credentials', { headers: { authorization: `Bearer ${ACCESS_KEY}` } });
    await send(url, '/test/echo-credentials', { headers: { 'x-api-key': SAME_LENGTH_WRONG } });
    await settle();
    const output = log.lines.join('');
    assert.match(output, /"status":401/);
    assert.match(output, /"status":200/);
    for (const value of [ACCESS_KEY, SAME_LENGTH_WRONG, SHORT_WRONG, CLIENT_KEY]) {
      assert.ok(!output.includes(value), 'a key value reached the log');
    }
    assert.ok(!/authorization|x-api-key/i.test(output), 'no credential header name reached the log');
  });
});

describe('without TOLLWISE_ACCESS_KEY on a loopback bind', () => {
  const log = captureLog();
  let server: Server;
  let url: string;

  before(async () => {
    ({ server, url } = await startServer(undefined, log));
  });
  after(async () => {
    await stopServer(server, 100);
  });

  test('any client credential header is accepted, ignored and stripped', async () => {
    for (const headers of [
      { authorization: `Bearer ${CLIENT_KEY}` },
      { 'x-api-key': CLIENT_KEY },
      { authorization: 'Basic anything' },
      {},
    ]) {
      const res = await send(url, '/test/echo-credentials', { headers });
      assert.equal(res.status, 200);
      assert.deepEqual(res.json, NO_CREDENTIALS);
    }
    assert.equal((await send(url, '/api/health', { headers: { 'x-api-key': CLIENT_KEY } })).status, 200);
    await settle();
    assert.ok(!log.lines.join('').includes(CLIENT_KEY));
  });
});

describe('access guard', () => {
  function fakeRequest(headers: Record<string, string>, method = 'GET'): IncomingMessage {
    return { headers, method } as unknown as IncomingMessage;
  }

  test('without a key it is disabled and allows everything', () => {
    const guard = createAccessGuard(undefined);
    assert.equal(guard.enabled, false);
    assert.equal(guard.allows(fakeRequest({}), '/v1/chat/completions'), true);
  });

  test('with a key it allows only the key, and GET or HEAD /healthz', () => {
    const guard = createAccessGuard(ACCESS_KEY);
    assert.equal(guard.enabled, true);
    assert.equal(guard.allows(fakeRequest({}, 'GET'), '/healthz'), true);
    assert.equal(guard.allows(fakeRequest({}, 'HEAD'), '/healthz'), true);
    assert.equal(guard.allows(fakeRequest({}, 'POST'), '/healthz'), false);
    assert.equal(guard.allows(fakeRequest({}), '/v1/chat/completions'), false);
    assert.equal(guard.allows(fakeRequest({ 'x-api-key': ACCESS_KEY }), '/v1/chat/completions'), true);
    assert.equal(guard.allows(fakeRequest({ 'x-api-key': `${ACCESS_KEY}, ${ACCESS_KEY}` }), '/v1/messages'), false);
    assert.equal(guard.allows(fakeRequest({ authorization: `Bearer ${ACCESS_KEY}` }), '/v1/messages'), true);
  });

  test('stripClientCredentials removes the headers from headers and rawHeaders, keeping the rest', () => {
    const req = {
      headers: { authorization: 'Bearer x', 'x-api-key': 'y', 'content-type': 'application/json' },
      rawHeaders: ['Authorization', 'Bearer x', 'Content-Type', 'application/json', 'X-API-KEY', 'y'],
    } as unknown as IncomingMessage;
    stripClientCredentials(req);
    assert.deepEqual(req.headers, { 'content-type': 'application/json' });
    assert.deepEqual(req.rawHeaders, ['Content-Type', 'application/json']);
  });
});

describe('binding a non-loopback host without TOLLWISE_ACCESS_KEY', () => {
  const workDir = mkdtempSync(path.join(tmpdir(), 'tollwise-access-'));
  after(() => {
    rmSync(workDir, { recursive: true, force: true });
    clearSecretValues();
  });

  test('startTollwise refuses before listening, naming the fix', async () => {
    const port = await freePort();
    const error = await startTollwise({
      env: { TOLLWISE_HOST: '0.0.0.0', TOLLWISE_PORT: String(port) },
      cwd: workDir,
      logSink: captureLog(),
      signals: new EventEmitter() as SignalSource,
    }).then(
      () => assert.fail('start must refuse'),
      (reason: unknown) => reason,
    );
    assert.ok(error instanceof ConfigError);
    assert.match(
      error.lines().join('\n'),
      /environment TOLLWISE_HOST: server\.host: "0\.0\.0\.0" accepts connections from other machines, but TOLLWISE_ACCESS_KEY is not set\. Fix: set TOLLWISE_ACCESS_KEY .*or bind to 127\.0\.0\.1/,
    );
    // Nothing was bound: the port is still free.
    const server = createTollwiseServer({ maxBodyBytes: 1024, logger: createLogger({ sink: captureLog() }) });
    await listen(server, '127.0.0.1', port);
    await stopServer(server, 100);
  });

  test('tollwise start exits 1 with the message on stderr', () => {
    const env: Record<string, string> = {};
    for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) {
      const value = process.env[name];
      if (value !== undefined) env[name] = value;
    }
    const result = spawnSync(process.execPath, [cliPath, 'start'], {
      cwd: workDir,
      env: { ...env, TOLLWISE_HOST: '0.0.0.0' },
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /^tollwise: the configuration is not valid \(1 problem\):/);
    assert.match(result.stderr, /TOLLWISE_ACCESS_KEY is not set\. Fix: set TOLLWISE_ACCESS_KEY/);
  });
});
