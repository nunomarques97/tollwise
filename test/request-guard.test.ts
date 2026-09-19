import assert from 'node:assert/strict';
import { once } from 'node:events';
import { connect } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { ConfigSchema } from '../src/config/schema.ts';
import { createLogger, type LogSink } from '../src/log/logger.ts';
import {
  isJsonContentType,
  JSON_REQUIRED_MESSAGE,
  MISDIRECTED_MESSAGE,
  ORIGIN_REFUSED_MESSAGE,
  PREFLIGHT_REFUSED_MESSAGE,
  parseHostHeader,
} from '../src/server/guard.ts';
import { sendJson } from '../src/server/respond.ts';
import { ROUTES, type Route } from '../src/server/router.ts';
import { baseUrl, createTollwiseServer, listen, stopServer } from '../src/server/server.ts';
import { wildcardHostNotice } from '../src/server/start.ts';
import { send, type TestResponse } from './fixtures/http-client.ts';

const JSON_TYPE = 'application/json';
// A fake access key with no known key shape.
const ACCESS_KEY = `fakeGuardAccess${'Gk3'.repeat(6)}`;

function silentLogger() {
  const sink: LogSink = { write: () => true };
  return createLogger({ sink });
}

/** A test server whose extra routes count how often a handler really ran. */
function countingServer(options: { accessKey?: string; allowedHosts?: string[]; listenHost?: string } = {}) {
  const calls = { count: 0 };
  const routes: Route[] = [
    ...ROUTES,
    {
      methods: ['GET', 'POST'],
      path: '/test/count',
      match: 'exact',
      handler: ({ res }) => {
        calls.count += 1;
        sendJson(res, 200, { count: calls.count });
      },
    },
  ];
  const server = createTollwiseServer({ maxBodyBytes: 64 * 1024, logger: silentLogger(), routes, ...options });
  return { server, calls };
}

function assertError(res: TestResponse, status: number, code: string, message: string): void {
  assert.equal(res.status, status);
  assert.deepEqual(res.json, { error: { message, type: 'invalid_request_error', param: null, code } });
  assert.equal(res.headers.connection, 'close');
}

function assertNoCorsHeaders(res: TestResponse): void {
  const cors = Object.keys(res.headers).filter((name) => name.startsWith('access-control-'));
  assert.deepEqual(cors, [], 'no Access-Control-* header is ever sent');
}

/** Writes raw bytes on a fresh connection and reads until the server closes it. */
async function rawExchange(port: number, bytes: string): Promise<string> {
  const socket = connect({ host: '127.0.0.1', port });
  socket.on('error', () => {});
  await once(socket, 'connect');
  socket.write(bytes);
  let reply = '';
  for await (const chunk of socket) reply += String(chunk);
  return reply;
}

function statusLines(reply: string): string[] {
  return reply.match(/HTTP\/1\.1 \d{3}[^\r\n]*/g) ?? [];
}

describe('guard helpers', () => {
  test('parseHostHeader reads names, IPv4, bracketed IPv6 and the port', () => {
    assert.deepEqual(parseHostHeader('127.0.0.1:8484'), { host: '127.0.0.1', port: 8484 });
    assert.deepEqual(parseHostHeader('LocalHost:8484'), { host: 'localhost', port: 8484 });
    assert.deepEqual(parseHostHeader('[::1]:8484'), { host: '::1', port: 8484 });
    assert.deepEqual(parseHostHeader('localhost'), { host: 'localhost', port: 80 });
    assert.equal(parseHostHeader('::1:8484'), undefined);
    assert.equal(parseHostHeader('[evil.example]:8484'), undefined);
    assert.equal(parseHostHeader('user@localhost:8484'), undefined);
    assert.equal(parseHostHeader('localhost:99999'), undefined);
    assert.equal(parseHostHeader(''), undefined);
  });

  test('isJsonContentType accepts application/json with parameters, in any case, and nothing else', () => {
    assert.equal(isJsonContentType('application/json'), true);
    assert.equal(isJsonContentType('Application/JSON; charset=utf-8'), true);
    assert.equal(isJsonContentType(' application/json ;charset=UTF-8'), true);
    assert.equal(isJsonContentType('text/plain'), false);
    assert.equal(isJsonContentType('application/x-www-form-urlencoded'), false);
    assert.equal(isJsonContentType('multipart/form-data; boundary=x'), false);
    assert.equal(isJsonContentType('application/jsonx'), false);
    assert.equal(isJsonContentType(undefined), false);
  });
});

describe('server.allowed_hosts configuration', () => {
  test('defaults to an empty list', () => {
    assert.deepEqual(ConfigSchema.parse({}).server.allowed_hosts, []);
  });

  test('accepts bare host names and addresses, stored lower-case without brackets', () => {
    const config = ConfigSchema.parse({
      server: { allowed_hosts: ['My-Box.Local', '192.168.1.20', '[FE80::1]', 'fd00::2'] },
    });
    assert.deepEqual(config.server.allowed_hosts, ['my-box.local', '192.168.1.20', 'fe80::1', 'fd00::2']);
  });

  test('refuses a scheme, a port, a path, spaces and wildcard addresses', () => {
    for (const entry of [
      'http://my-box.local',
      'my-box.local:8484',
      'my-box.local/v1',
      'my box',
      '0.0.0.0',
      '::',
      '*',
    ]) {
      const result = ConfigSchema.safeParse({ server: { allowed_hosts: [entry] } });
      assert.equal(result.success, false, `"${entry}" must be refused`);
    }
  });

  test('the startup notice for a wildcard address says to list the names clients use', () => {
    const notice = wildcardHostNotice('0.0.0.0', []);
    assert.ok(notice !== undefined);
    assert.match(notice, /every network interface \(0\.0\.0\.0\)/);
    assert.match(notice, /none are listed yet/);
    assert.match(notice, /List in server\.allowed_hosts the host names or IP addresses other machines use/);
    assert.match(wildcardHostNotice('::', ['my-box.local']) ?? '', /listed now: my-box\.local/);
    assert.equal(wildcardHostNotice('127.0.0.1', []), undefined);
    assert.equal(wildcardHostNotice('192.168.1.20', []), undefined);
  });
});

describe('request guard on a running server', () => {
  const { server, calls } = countingServer();
  let port: number;
  let url: string;

  before(async () => {
    port = (await listen(server, '127.0.0.1', 0)).port;
    url = baseUrl('127.0.0.1', port);
  });
  after(async () => {
    await stopServer(server, 100);
  });

  // ------------------------------------------------------------ Host allow-list

  test('GET /healthz with a good Host still works', async () => {
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `LOCALHOST:${port}`, `[::1]:${port}`]) {
      const res = await send(url, '/healthz', { headers: { host } });
      assert.equal(res.status, 200, host);
      assert.deepEqual(res.json, { status: 'ok' });
    }
  });

  test('an IPv6 connection to [::1] with its own Host is served', async (t) => {
    const v6 = countingServer();
    let v6Port: number;
    try {
      v6Port = (await listen(v6.server, '::1', 0)).port;
    } catch {
      t.skip('IPv6 loopback is not available on this machine');
      return;
    }
    try {
      const res = await send(baseUrl('::1', v6Port), '/healthz');
      assert.equal(res.status, 200);
      const wrongPort = await send(baseUrl('::1', v6Port), '/healthz', { headers: { host: `[::1]:${v6Port + 1}` } });
      assertError(wrongPort, 421, 'misdirected_request', MISDIRECTED_MESSAGE);
    } finally {
      await stopServer(v6.server, 100);
    }
  });

  test('a loopback Host with the wrong port is answered 421', async () => {
    const res = await send(url, '/healthz', { headers: { host: `127.0.0.1:${port === 65535 ? 1 : port + 1}` } });
    assertError(res, 421, 'misdirected_request', MISDIRECTED_MESSAGE);
    // Without a port the Host means port 80, which is not the bound port either.
    assertError(
      await send(url, '/healthz', { headers: { host: 'localhost' } }),
      421,
      'misdirected_request',
      MISDIRECTED_MESSAGE,
    );
  });

  test('a rebinding-style Host (evil.example) is answered 421 and never echoed back', async () => {
    for (const path of ['/healthz', '/api/health', '/test/count']) {
      const res = await send(url, path, { headers: { host: `evil.example:${port}` } });
      assertError(res, 421, 'misdirected_request', MISDIRECTED_MESSAGE);
      assert.ok(!res.text.includes('evil'), 'the Host value is not in the answer');
    }
    const post = await send(url, '/test/count', {
      method: 'POST',
      headers: { host: `evil.example:${port}`, 'content-type': JSON_TYPE },
      body: '{}',
    });
    assertError(post, 421, 'misdirected_request', MISDIRECTED_MESSAGE);
    // Names that only look like loopback are refused too.
    for (const host of [
      `localhost.:${port}`,
      `127.0.0.1.evil.example:${port}`,
      `127.0.0.2:${port}`,
      `0.0.0.0:${port}`,
    ]) {
      assert.equal((await send(url, '/healthz', { headers: { host } })).status, 421, host);
    }
    assert.equal(calls.count, 0, 'no handler ran');
  });

  test('a request without a Host header is answered 421', async () => {
    const http11 = await rawExchange(port, 'GET /healthz HTTP/1.1\r\n\r\n');
    assert.match(http11, /^HTTP\/1\.1 421 /);
    assert.match(http11, /"code":"misdirected_request"/);
    const http10 = await rawExchange(port, 'GET /healthz HTTP/1.0\r\n\r\n');
    assert.match(http10, /^HTTP\/1\.1 421 /);
  });

  test('an absolute-form target naming another host is answered 421', async () => {
    const reply = await rawExchange(
      port,
      `GET http://evil.example:${port}/healthz HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`,
    );
    assert.match(reply, /^HTTP\/1\.1 421 /);
    const good = await rawExchange(
      port,
      `GET http://127.0.0.1:${port}/healthz HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
    );
    assert.match(good, /^HTTP\/1\.1 200 /);
  });

  // ------------------------------------------------------------ Origin

  test('requests without Origin (SDKs, curl) pass; a same-server Origin passes', async () => {
    assert.equal((await send(url, '/healthz')).status, 200);
    for (const origin of [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`]) {
      const res = await send(url, '/healthz', { headers: { origin } });
      assert.equal(res.status, 200, origin);
      assertNoCorsHeaders(res);
    }
  });

  test('a foreign Origin is answered 403 with a fixed message and no CORS header', async () => {
    const origins = [
      'http://evil.example',
      `http://evil.example:${port}`,
      'null',
      `https://127.0.0.1:${port}`,
      `http://localhost:${port === 65535 ? 1 : port + 1}`,
      `http://127.0.0.1:${port}/path`,
      'not a url',
    ];
    for (const origin of origins) {
      const res = await send(url, '/healthz', { headers: { origin } });
      assertError(res, 403, 'origin_not_allowed', ORIGIN_REFUSED_MESSAGE);
      assertNoCorsHeaders(res);
      assert.ok(!res.text.includes('evil'), 'the Origin value is not in the answer');
    }
    const post = await send(url, '/test/count', {
      method: 'POST',
      headers: { origin: 'null', 'content-type': JSON_TYPE },
      body: '{}',
    });
    assertError(post, 403, 'origin_not_allowed', ORIGIN_REFUSED_MESSAGE);
    assert.equal(calls.count, 0, 'no handler ran');
  });

  test('OPTIONS preflights are refused, with or without Origin, and grant nothing', async () => {
    const preflight = await send(url, '/v1/chat/completions', {
      method: 'OPTIONS',
      headers: {
        origin: `http://127.0.0.1:${port}`,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type, authorization',
      },
    });
    assertError(preflight, 403, 'preflight_not_supported', PREFLIGHT_REFUSED_MESSAGE);
    assertNoCorsHeaders(preflight);
    const foreign = await send(url, '/v1/chat/completions', {
      method: 'OPTIONS',
      headers: { origin: 'http://evil.example', 'access-control-request-method': 'POST' },
    });
    assert.equal(foreign.status, 403);
    assertNoCorsHeaders(foreign);
    const bare = await send(url, '/test/count', { method: 'OPTIONS' });
    assertError(bare, 403, 'preflight_not_supported', PREFLIGHT_REFUSED_MESSAGE);
  });

  // ------------------------------------------------------------ Content-Type

  test('a text/plain POST is answered 415, as is a POST without Content-Type or with a form type', async () => {
    for (const headers of [
      { 'content-type': 'text/plain' },
      { 'content-type': 'text/plain;charset=UTF-8' },
      { 'content-type': 'application/x-www-form-urlencoded' },
      { 'content-type': 'multipart/form-data; boundary=x' },
      {},
    ]) {
      const res = await send(url, '/test/count', { method: 'POST', headers, body: '{"model":"x"}' });
      assertError(res, 415, 'unsupported_media_type', JSON_REQUIRED_MESSAGE);
    }
    assert.equal(calls.count, 0, 'no handler ran');
  });

  test('a JSON POST passes, parameters and letter case notwithstanding', async () => {
    const before = calls.count;
    for (const type of ['application/json', 'Application/JSON; charset=utf-8']) {
      const res = await send(url, '/test/count', { method: 'POST', headers: { 'content-type': type }, body: '{}' });
      assert.equal(res.status, 200, type);
    }
    assert.equal(calls.count, before + 2);
  });

  // ------------------------------------------------------------ pipelining after an early answer

  /** Sends `first` and a pipelined GET /test/count in one write; returns the reply and the handler calls. */
  async function pipelined(first: string): Promise<{ reply: string; ran: number }> {
    const before = calls.count;
    const second = `GET /test/count HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`;
    const reply = await rawExchange(port, first + second);
    return { reply, ran: calls.count - before };
  }

  test('a pipelined request behind an early answer never reaches a handler', async () => {
    const good = `127.0.0.1:${port}`;
    const cases: [string, string][] = [
      ['421', `GET /healthz HTTP/1.1\r\nHost: evil.example:${port}\r\n\r\n`],
      ['403', `GET /healthz HTTP/1.1\r\nHost: ${good}\r\nOrigin: null\r\n\r\n`],
      ['403', `OPTIONS /test/count HTTP/1.1\r\nHost: ${good}\r\n\r\n`],
      ['415', `POST /test/count HTTP/1.1\r\nHost: ${good}\r\nContent-Type: text/plain\r\nContent-Length: 2\r\n\r\n{}`],
      [
        '413',
        `POST /test/count HTTP/1.1\r\nHost: ${good}\r\nContent-Type: ${JSON_TYPE}\r\nContent-Length: 999999\r\n\r\n`,
      ],
      ['404', `GET /nothing-here HTTP/1.1\r\nHost: ${good}\r\n\r\n`],
      [
        '404',
        `POST /nothing-here HTTP/1.1\r\nHost: ${good}\r\nContent-Type: ${JSON_TYPE}\r\nContent-Length: 2\r\n\r\n{}`,
      ],
      ['405', `DELETE /healthz HTTP/1.1\r\nHost: ${good}\r\n\r\n`],
      [
        '501',
        `POST /v1/embeddings HTTP/1.1\r\nHost: ${good}\r\nContent-Type: ${JSON_TYPE}\r\nContent-Length: 2\r\n\r\n{}`,
      ],
      ['501', `GET /v1/assistants HTTP/1.1\r\nHost: ${good}\r\n\r\n`],
    ];
    for (const [status, first] of cases) {
      // The 413 request never sends its body: the pipelined request stands where the body would be.
      const { reply, ran } = await pipelined(first);
      assert.equal(ran, 0, `the pipelined request ran a handler after a ${status}`);
      assert.deepEqual(
        statusLines(reply).map((line) => line.slice(9, 12)),
        [status],
        `exactly one answer, the ${status}`,
      );
      assert.match(reply, /\r\nConnection: close\r\n/);
    }
  });

  test('control: two good pipelined requests are both served', async () => {
    const before = calls.count;
    const good = `127.0.0.1:${port}`;
    const reply = await rawExchange(
      port,
      `GET /healthz HTTP/1.1\r\nHost: ${good}\r\n\r\n` +
        `GET /test/count HTTP/1.1\r\nHost: ${good}\r\nConnection: close\r\n\r\n`,
    );
    assert.deepEqual(
      statusLines(reply).map((line) => line.slice(9, 12)),
      ['200', '200'],
    );
    assert.equal(calls.count, before + 1);
  });
});

describe('request guard with an access key and allowed hosts', () => {
  const { server, calls } = countingServer({
    accessKey: ACCESS_KEY,
    allowedHosts: ['my-box.local', 'fd00::2'],
    listenHost: '0.0.0.0',
  });
  let port: number;
  let url: string;

  before(async () => {
    // Bound to loopback for the test; the wildcard listenHost only feeds the allow-list, as in production.
    port = (await listen(server, '127.0.0.1', 0)).port;
    url = baseUrl('127.0.0.1', port);
  });
  after(async () => {
    await stopServer(server, 100);
  });

  test('a host listed in server.allowed_hosts is served, in Host and in Origin', async () => {
    for (const host of [`my-box.local:${port}`, `MY-BOX.local:${port}`, `[fd00::2]:${port}`]) {
      assert.equal((await send(url, '/healthz', { headers: { host } })).status, 200, host);
    }
    const res = await send(url, '/healthz', {
      headers: { host: `my-box.local:${port}`, origin: `http://my-box.local:${port}` },
    });
    assert.equal(res.status, 200);
  });

  test('a wildcard listen address is never an accepted Host', async () => {
    assert.equal((await send(url, '/healthz', { headers: { host: `0.0.0.0:${port}` } })).status, 421);
    assert.equal((await send(url, '/healthz', { headers: { host: `other.local:${port}` } })).status, 421);
  });

  test('the guard answers before the access key is checked', async () => {
    const misdirected = await send(url, '/test/count', { headers: { host: `evil.example:${port}` } });
    assertError(misdirected, 421, 'misdirected_request', MISDIRECTED_MESSAGE);
    assert.equal(misdirected.headers['www-authenticate'], undefined);
    const plain = await send(url, '/test/count', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{}',
    });
    assertError(plain, 415, 'unsupported_media_type', JSON_REQUIRED_MESSAGE);
    // A request that passes the guard still needs the key.
    const noKey = await send(url, '/test/count', {
      method: 'POST',
      headers: { 'content-type': JSON_TYPE },
      body: '{}',
    });
    assert.equal(noKey.status, 401);
    assert.equal(noKey.headers.connection, 'close');
    const withKey = await send(url, '/test/count', {
      method: 'POST',
      headers: { 'content-type': JSON_TYPE, authorization: `Bearer ${ACCESS_KEY}` },
      body: '{}',
    });
    assert.equal(withKey.status, 200);
    assert.equal(calls.count, 1);
  });

  test('a pipelined request behind a 401 never reaches a handler', async () => {
    const before = calls.count;
    const good = `127.0.0.1:${port}`;
    const reply = await rawExchange(
      port,
      `GET /test/count HTTP/1.1\r\nHost: ${good}\r\n\r\n` +
        `GET /test/count HTTP/1.1\r\nHost: ${good}\r\nAuthorization: Bearer ${ACCESS_KEY}\r\n\r\n`,
    );
    assert.deepEqual(
      statusLines(reply).map((line) => line.slice(9, 12)),
      ['401'],
    );
    assert.equal(calls.count, before);
  });
});
