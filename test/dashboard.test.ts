// Static serving of the dashboard at /dashboard: strict path resolution (only files inside the build
// folder), fixed Content-Types, security headers, the access-key exemption limited to GET and HEAD on
// /dashboard, the request guard still applied, 503 when the build is missing, and the build script itself.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createLogger, type LogSink } from '../src/log/logger.ts';
import { ACCESS_DENIED_MESSAGE, createAccessGuard, isAccessExempt } from '../src/server/access.ts';
import {
  DASHBOARD_CSP,
  DASHBOARD_NOT_BUILT_MESSAGE,
  DASHBOARD_NOT_FOUND_MESSAGE,
  dashboardFileSegments,
  isDashboardPath,
} from '../src/server/dashboard.ts';
import { MISDIRECTED_MESSAGE, ORIGIN_REFUSED_MESSAGE, PREFLIGHT_REFUSED_MESSAGE } from '../src/server/guard.ts';
import { baseUrl, createTollwiseServer, listen, stopServer } from '../src/server/server.ts';
import { send, type TestResponse } from './fixtures/http-client.ts';

// A fake access key with no known key shape.
const ACCESS_KEY = `fakeDashAccess${'Dq4'.repeat(6)}`; // tollwise-allow-secret

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..');

const EXPECTED_CSP =
  "default-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; " +
  "form-action 'self'; frame-ancestors 'none'";

// Text that exists only in files outside the build folder: an answer containing it leaked that file.
const OUTSIDE_MARKER = 'outside-the-build-folder';

function silentLogger() {
  const sink: LogSink = { write: () => true };
  return createLogger({ sink });
}

/**
 * A scratch folder holding a fake build (`build/`) and, next to it, files a request must never reach:
 * `outside.html` in the parent, `build-sibling/leak.html` (a folder whose name starts like the build
 * folder's) and `outside/leak.html`.
 */
function makeFixture(): { base: string; root: string } {
  const base = mkdtempSync(path.join(tmpdir(), 'tollwise-dashboard-'));
  const root = path.join(base, 'build');
  mkdirSync(path.join(root, 'views'), { recursive: true });
  writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>Tollwise dashboard</title>');
  writeFileSync(path.join(root, 'main.js'), 'export const ready = true;\n');
  writeFileSync(path.join(root, 'style.css'), 'body { margin: 0; }\n');
  writeFileSync(path.join(root, 'views', 'chart.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  writeFileSync(path.join(root, 'notes.txt'), 'not a served type');
  writeFileSync(path.join(root, '.hidden.html'), 'hidden');
  writeFileSync(path.join(base, 'outside.html'), OUTSIDE_MARKER);
  mkdirSync(path.join(base, 'build-sibling'));
  writeFileSync(path.join(base, 'build-sibling', 'leak.html'), OUTSIDE_MARKER);
  mkdirSync(path.join(base, 'outside'));
  writeFileSync(path.join(base, 'outside', 'leak.html'), OUTSIDE_MARKER);
  return { base, root };
}

async function startServer(options: { dashboardRoot: string; accessKey?: string }): Promise<{
  server: Server;
  url: string;
  port: number;
}> {
  const server = createTollwiseServer({ maxBodyBytes: 64 * 1024, logger: silentLogger(), ...options });
  const address = await listen(server, '127.0.0.1', 0);
  return { server, url: baseUrl('127.0.0.1', address.port), port: address.port };
}

interface RawResponse {
  readonly status: number;
  readonly head: string;
  readonly body: string;
}

/** Sends a request target exactly as written, with no client-side normalisation, and reads the answer. */
async function rawGet(port: number, target: string, extraHeaders = ''): Promise<RawResponse> {
  const socket = connect({ host: '127.0.0.1', port });
  socket.on('error', () => {});
  await once(socket, 'connect');
  socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${extraHeaders}Connection: close\r\n\r\n`);
  let reply = '';
  for await (const chunk of socket) reply += String(chunk);
  const split = reply.indexOf('\r\n\r\n');
  const head = split === -1 ? reply : reply.slice(0, split);
  const body = split === -1 ? '' : reply.slice(split + 4);
  return { status: Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1] ?? 0), head, body };
}

function assertSecurityHeaders(res: TestResponse): void {
  assert.equal(res.headers['content-security-policy'], EXPECTED_CSP);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['referrer-policy'], 'no-referrer');
  assert.equal(res.headers['x-frame-options'], 'DENY');
}

/** Creates a symbolic link or, for a folder on Windows, a junction; false when the OS does not allow it. */
function tryLink(target: string, linkPath: string, type: 'file' | 'dir'): boolean {
  try {
    symlinkSync(target, linkPath, type === 'dir' && process.platform === 'win32' ? 'junction' : type);
    return true;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS') return false;
    throw error;
  }
}

describe('dashboard path resolution (pure)', () => {
  test('/dashboard and /dashboard/ name the page; other names map to their segments', () => {
    assert.deepEqual(dashboardFileSegments('/dashboard'), ['index.html']);
    assert.deepEqual(dashboardFileSegments('/dashboard/'), ['index.html']);
    assert.deepEqual(dashboardFileSegments('/dashboard/main.js'), ['main.js']);
    assert.deepEqual(dashboardFileSegments('/dashboard/views/chart.svg'), ['views', 'chart.svg']);
    assert.deepEqual(dashboardFileSegments('/dashboard/app-shell_v2.min.css'), ['app-shell_v2.min.css']);
    assert.deepEqual(dashboardFileSegments('/dashboard/%6Dain.js'), ['main.js']);
  });

  test('refuses traversal, encodings, separators, NUL, absolute paths and odd names', () => {
    const refused = [
      '/dashboard/..',
      '/dashboard/../outside.html',
      '/dashboard/%2e%2e/outside.html',
      '/dashboard/%2E%2E%2Foutside.html',
      '/dashboard/..%2foutside.html',
      '/dashboard/..%5coutside.html',
      '/dashboard/..\\outside.html',
      '/dashboard/%252e%252e/outside.html',
      '/dashboard/%252e%252e%252foutside.html',
      '/dashboard/index.html%00.css',
      '/dashboard/%00',
      '/dashboard/%2Fetc%2Fhosts.html',
      '/dashboard//etc/hosts.html',
      '/dashboard/C:%5Coutside.html',
      '/dashboard/C:/outside.html',
      '/dashboard/%5C%5Cserver%5Cshare%5Cx.html',
      '/dashboard/./index.html',
      '/dashboard/views/../index.html',
      '/dashboard/.hidden.html',
      '/dashboard/index.html.',
      '/dashboard/index.html::$DATA',
      '/dashboard/INDEX~1.HTM',
      '/dashboard/con.html',
      '/dashboard/NUL.js',
      '/dashboard/views/com1.css',
      '/dashboard/%ZZ.html',
      '/dashboard/%E0%A4%A.html',
      '/dashboard/notes.txt',
      '/dashboard/views',
      '/dashboard/views/',
      '/dashboard/index',
    ];
    for (const requestPath of refused) {
      assert.equal(dashboardFileSegments(requestPath), undefined, requestPath);
    }
  });

  test('isDashboardPath matches /dashboard on a segment boundary only', () => {
    assert.equal(isDashboardPath('/dashboard'), true);
    assert.equal(isDashboardPath('/dashboard/x.js'), true);
    assert.equal(isDashboardPath('/dashboardx'), false);
    assert.equal(isDashboardPath('/Dashboard'), false);
    assert.equal(isDashboardPath('/api/dashboard'), false);
  });

  test('the CSP is the exact policy, with no unsafe-inline or unsafe-eval', () => {
    assert.equal(DASHBOARD_CSP, EXPECTED_CSP);
    assert.doesNotMatch(DASHBOARD_CSP, /unsafe/);
  });
});

describe('dashboard static files', () => {
  let fixture: { base: string; root: string };
  let server: Server;
  let url: string;
  let port: number;

  before(async () => {
    fixture = makeFixture();
    ({ server, url, port } = await startServer({ dashboardRoot: fixture.root }));
  });

  after(async () => {
    await stopServer(server, 1000);
    rmSync(fixture.base, { recursive: true, force: true });
  });

  test('GET /dashboard and /dashboard/ serve the page as HTML with the security headers', async () => {
    for (const target of ['/dashboard', '/dashboard/', '/dashboard/index.html', '/dashboard/?view=spend']) {
      const res = await send(url, target);
      assert.equal(res.status, 200, target);
      assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
      assert.equal(res.text, '<!doctype html><title>Tollwise dashboard</title>');
      assertSecurityHeaders(res);
    }
  });

  test('each served extension gets its fixed Content-Type', async () => {
    const js = await send(url, '/dashboard/main.js');
    assert.equal(js.status, 200);
    assert.equal(js.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.equal(js.text, 'export const ready = true;\n');
    assertSecurityHeaders(js);

    const css = await send(url, '/dashboard/style.css');
    assert.equal(css.headers['content-type'], 'text/css; charset=utf-8');
    assert.equal(css.headers['content-length'], String('body { margin: 0; }\n'.length));

    const svg = await send(url, '/dashboard/views/chart.svg');
    assert.equal(svg.status, 200);
    assert.equal(svg.headers['content-type'], 'image/svg+xml');
  });

  test('HEAD sends the headers of GET and no body', async () => {
    const res = await send(url, '/dashboard/main.js', { method: 'HEAD' });
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.equal(res.headers['content-length'], String('export const ready = true;\n'.length));
    assert.equal(res.text, '');
    assertSecurityHeaders(res);
  });

  test('a missing file, a directory or an unserved type is a 404 with the security headers', async () => {
    for (const target of ['/dashboard/missing.js', '/dashboard/views', '/dashboard/views/', '/dashboard/notes.txt']) {
      const res = await send(url, target);
      assert.equal(res.status, 404, target);
      assert.deepEqual(res.json, {
        error: { message: DASHBOARD_NOT_FOUND_MESSAGE, type: 'not_found_error', param: null, code: 'not_found' },
      });
      assertSecurityHeaders(res);
    }
  });

  test('traversal attempts sent on the wire are all 404 and never reveal a file outside the build', async () => {
    const attempts = [
      '/dashboard/../outside.html',
      '/dashboard/%2e%2e/outside.html',
      '/dashboard/%2E%2E/outside.html',
      '/dashboard/.%2e/outside.html',
      '/dashboard/%2e%2e%2foutside.html',
      '/dashboard/..%2Foutside.html',
      '/dashboard/..%5coutside.html',
      '/dashboard/..\\outside.html',
      '/dashboard/%252e%252e%252foutside.html',
      '/dashboard/%252e%252e/outside.html',
      '/dashboard/..%252foutside.html',
      '/dashboard/outside.html%00.css',
      '/dashboard/index.html%00',
      '/dashboard/../build-sibling/leak.html',
      '/dashboard/%2e%2e%2fbuild-sibling%2fleak.html',
      '/dashboard/%2e%2e%5coutside%5cleak.html',
      `/dashboard/${encodeURIComponent(path.join(fixture.base, 'outside.html'))}`,
      `/dashboard/${encodeURIComponent(path.join(fixture.base, 'outside.html').replaceAll('\\', '/'))}`,
      '/dashboard//outside.html',
      '/dashboard/.hidden.html',
      '/dashboard/index.html::$DATA',
    ];
    for (const target of attempts) {
      const res = await rawGet(port, target);
      assert.equal(res.status, 404, target);
      assert.doesNotMatch(res.body, new RegExp(OUTSIDE_MARKER), target);
      assert.doesNotMatch(res.body, /hidden/, target);
    }
  });

  test('an absolute-form target is resolved by the URL rules, never to a file outside the build', async () => {
    const res = await rawGet(port, `http://127.0.0.1:${port}/dashboard/%2e%2e/outside.html`);
    // The URL parser removes the dot segment: the path becomes /outside.html, which is not a Tollwise route.
    assert.equal(res.status, 404);
    assert.doesNotMatch(res.body, new RegExp(OUTSIDE_MARKER));
  });

  test('a symbolic link or junction to a folder outside the build is a 404', async (t) => {
    if (!tryLink(path.join(fixture.base, 'outside'), path.join(fixture.root, 'linked'), 'dir')) {
      t.skip('this system does not allow creating a folder link here');
      return;
    }
    const res = await rawGet(port, '/dashboard/linked/leak.html');
    assert.equal(res.status, 404);
    assert.doesNotMatch(res.body, new RegExp(OUTSIDE_MARKER));
  });

  test('a symbolic link to a folder that only starts like the build folder is a 404', async (t) => {
    if (!tryLink(path.join(fixture.base, 'build-sibling'), path.join(fixture.root, 'sibling'), 'dir')) {
      t.skip('this system does not allow creating a folder link here');
      return;
    }
    const res = await rawGet(port, '/dashboard/sibling/leak.html');
    assert.equal(res.status, 404);
    assert.doesNotMatch(res.body, new RegExp(OUTSIDE_MARKER));
  });

  test('a file symbolic link leaving the build is a 404; one staying inside is served', async (t) => {
    if (!tryLink(path.join(fixture.base, 'outside.html'), path.join(fixture.root, 'escape.html'), 'file')) {
      t.skip('creating file symbolic links needs Developer Mode or elevated rights on this Windows system');
      return;
    }
    const escaped = await rawGet(port, '/dashboard/escape.html');
    assert.equal(escaped.status, 404);
    assert.doesNotMatch(escaped.body, new RegExp(OUTSIDE_MARKER));

    assert.ok(tryLink(path.join(fixture.root, 'index.html'), path.join(fixture.root, 'alias.html'), 'file'));
    const inside = await send(url, '/dashboard/alias.html');
    assert.equal(inside.status, 200);
    assert.equal(inside.text, '<!doctype html><title>Tollwise dashboard</title>');
  });

  test('POST, PUT and DELETE on /dashboard are 405 with GET, HEAD allowed', async () => {
    const post = await send(url, '/dashboard', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(post.status, 405);
    assert.equal(post.headers.allow, 'GET, HEAD');
    for (const method of ['PUT', 'DELETE']) {
      const res = await send(url, '/dashboard/main.js', { method });
      assert.equal(res.status, 405, method);
      assert.equal(res.headers.allow, 'GET, HEAD');
    }
  });
});

describe('dashboard and the access key', () => {
  let fixture: { base: string; root: string };
  let server: Server;
  let url: string;
  let port: number;

  before(async () => {
    fixture = makeFixture();
    ({ server, url, port } = await startServer({ dashboardRoot: fixture.root, accessKey: ACCESS_KEY }));
  });

  after(async () => {
    await stopServer(server, 1000);
    rmSync(fixture.base, { recursive: true, force: true });
  });

  function assertDenied(res: TestResponse | RawResponse, label: string): void {
    assert.equal(res.status, 401, label);
    // A HEAD answer has no body to compare.
    if ('json' in res && res.text !== '') {
      assert.deepEqual(res.json, {
        error: { message: ACCESS_DENIED_MESSAGE, type: 'invalid_request_error', param: null, code: 'invalid_api_key' },
      });
    }
  }

  test('GET and HEAD of the static files need no key', async () => {
    for (const target of ['/dashboard', '/dashboard/', '/dashboard/main.js', '/dashboard/style.css']) {
      assert.equal((await send(url, target)).status, 200, target);
      assert.equal((await send(url, target, { method: 'HEAD' })).status, 200, `HEAD ${target}`);
    }
    // Refusals below /dashboard stay 404, not 401: they reveal nothing either way.
    assert.equal((await send(url, '/dashboard/missing.js')).status, 404);
  });

  test('every /api route still needs the key', async () => {
    for (const target of [
      '/api/health',
      '/api/metrics/summary',
      '/api/metrics/timeseries',
      '/api/metrics/breakdown',
      '/api/requests',
      '/api/events',
    ]) {
      assertDenied(await send(url, target), target);
      assertDenied(await send(url, target, { method: 'HEAD' }), `HEAD ${target}`);
    }
    assert.equal((await send(url, '/api/health', { headers: { 'x-api-key': ACCESS_KEY } })).status, 200);
  });

  test('other methods on /dashboard need the key, then get 405', async () => {
    const post = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' };
    assertDenied(await send(url, '/dashboard', post), 'POST /dashboard');
    assertDenied(await send(url, '/dashboard/main.js', { ...post, method: 'PUT' }), 'PUT /dashboard/main.js');
    assertDenied(await send(url, '/dashboard', { method: 'DELETE' }), 'DELETE /dashboard');
    const withKey = await send(url, '/dashboard', {
      ...post,
      headers: { ...post.headers, authorization: `Bearer ${ACCESS_KEY}` },
    });
    assert.equal(withKey.status, 405);
  });

  test('paths that only look like /dashboard, or climb out of it to /api, are not exempt', async () => {
    assertDenied(await send(url, '/dashboardx'), '/dashboardx');
    assertDenied(await send(url, '/Dashboard'), '/Dashboard');
    assertDenied(await send(url, '/api/dashboard'), '/api/dashboard');
    // Sent as written, these stay under /dashboard: they reach the static handler (404), never the API.
    for (const target of [
      '/dashboard/../api/metrics/summary',
      '/dashboard/%2e%2e/api/health',
      '/dashboard/..%2fapi%2fhealth',
    ]) {
      const res = await rawGet(port, target);
      assert.equal(res.status, 404, target);
      assert.doesNotMatch(res.body, /providers/, target);
    }
    // In absolute form the URL parser resolves the dot segments first: the path is /api/health, key needed.
    const absolute = await rawGet(port, `http://127.0.0.1:${port}/dashboard/%2e%2e/api/health`);
    assert.equal(absolute.status, 401);
  });

  test('isAccessExempt allows only GET and HEAD on /healthz and the dashboard', () => {
    assert.equal(isAccessExempt('GET', '/dashboard'), true);
    assert.equal(isAccessExempt('HEAD', '/dashboard/main.js'), true);
    assert.equal(isAccessExempt('POST', '/dashboard'), false);
    assert.equal(isAccessExempt('OPTIONS', '/dashboard'), false);
    assert.equal(isAccessExempt('GET', '/dashboardx'), false);
    assert.equal(isAccessExempt('GET', '/api/metrics/summary'), false);
    assert.equal(isAccessExempt('GET', '/api/events'), false);
    assert.equal(isAccessExempt('GET', '/healthz'), true);

    const guard = createAccessGuard(ACCESS_KEY);
    const request = (method: string) => ({ method, headers: {} }) as unknown as Parameters<typeof guard.allows>[0];
    assert.equal(guard.allows(request('GET'), '/dashboard/style.css'), true);
    assert.equal(guard.allows(request('PATCH'), '/dashboard/style.css'), false);
    assert.equal(guard.allows(request('GET'), '/api/requests'), false);
  });
});

describe('dashboard and the request guard', () => {
  let fixture: { base: string; root: string };
  let server: Server;
  let url: string;
  let port: number;

  before(async () => {
    fixture = makeFixture();
    ({ server, url, port } = await startServer({ dashboardRoot: fixture.root }));
  });

  after(async () => {
    await stopServer(server, 1000);
    rmSync(fixture.base, { recursive: true, force: true });
  });

  test('a Host that does not name this server is refused 421', async () => {
    for (const host of [`evil.example:${port}`, 'evil.example', `127.0.0.1:${port + 1 > 65535 ? 1 : port + 1}`]) {
      const res = await send(url, '/dashboard', { headers: { host } });
      assert.equal(res.status, 421, host);
      assert.deepEqual(res.json, {
        error: {
          message: MISDIRECTED_MESSAGE,
          type: 'invalid_request_error',
          param: null,
          code: 'misdirected_request',
        },
      });
    }
  });

  test('a foreign Origin is refused 403, while the server origin itself is served', async () => {
    for (const origin of ['http://evil.example', 'null', `http://evil.example:${port}`]) {
      const res = await send(url, '/dashboard/main.js', { headers: { origin } });
      assert.equal(res.status, 403, origin);
      assert.deepEqual(res.json, {
        error: {
          message: ORIGIN_REFUSED_MESSAGE,
          type: 'invalid_request_error',
          param: null,
          code: 'origin_not_allowed',
        },
      });
    }
    const own = await send(url, '/dashboard/main.js', { headers: { origin: `http://127.0.0.1:${port}` } });
    assert.equal(own.status, 200);
  });

  test('OPTIONS on /dashboard is refused as a preflight', async () => {
    const res = await send(url, '/dashboard', { method: 'OPTIONS' });
    assert.equal(res.status, 403);
    assert.deepEqual(res.json, {
      error: {
        message: PREFLIGHT_REFUSED_MESSAGE,
        type: 'invalid_request_error',
        param: null,
        code: 'preflight_not_supported',
      },
    });
  });
});

describe('dashboard build missing', () => {
  test('no build folder: 503 that says to run npm run build:dashboard, with the security headers', async () => {
    const base = mkdtempSync(path.join(tmpdir(), 'tollwise-dashboard-'));
    const { server, url } = await startServer({ dashboardRoot: path.join(base, 'not-built') });
    try {
      for (const target of ['/dashboard', '/dashboard/main.js', '/dashboard/../outside.html']) {
        const res = await send(url, target);
        assert.equal(res.status, 503, target);
        assert.deepEqual(res.json, {
          error: {
            message: DASHBOARD_NOT_BUILT_MESSAGE,
            type: 'server_error',
            param: null,
            code: 'dashboard_not_built',
          },
        });
        assert.match(DASHBOARD_NOT_BUILT_MESSAGE, /npm run build:dashboard/);
        assertSecurityHeaders(res);
      }
    } finally {
      await stopServer(server, 1000);
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('a build folder without index.html is an unfinished build: 503', async () => {
    const base = mkdtempSync(path.join(tmpdir(), 'tollwise-dashboard-'));
    writeFileSync(path.join(base, 'main.js'), 'export {};\n');
    const { server, url } = await startServer({ dashboardRoot: base });
    try {
      assert.equal((await send(url, '/dashboard/main.js')).status, 503);
    } finally {
      await stopServer(server, 1000);
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('dashboard build script', () => {
  test('package.json builds the dashboard on install and type-checks it', () => {
    const manifest = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    assert.equal(manifest.scripts['build:dashboard'], 'node scripts/build-dashboard.ts');
    assert.equal(manifest.scripts.prepare, 'npm run build:dashboard');
    assert.match(manifest.scripts.typecheck ?? '', /tsc -p tsconfig\.dashboard\.json --noEmit/);
  });

  test('compiles main.ts to plain JavaScript and copies the page and stylesheet', async () => {
    const base = mkdtempSync(path.join(tmpdir(), 'tollwise-dashboard-build-'));
    const outDir = path.join(base, 'out');
    try {
      const built = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'build-dashboard.ts'), outDir], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
      assert.equal(built.status, 0, built.stderr);

      const mainJs = readFileSync(path.join(outDir, 'main.js'), 'utf8');
      assert.match(mainJs, /export function markScriptLoaded\(root\) \{/);
      assert.doesNotMatch(mainJs, /HTMLElement/, 'type annotations are stripped');
      const page = readFileSync(path.join(outDir, 'index.html'), 'utf8');
      assert.match(page, /<title>Tollwise dashboard<\/title>/);
      assert.match(page, /<script type="module" src="\/dashboard\/main\.js"><\/script>/);
      assert.doesNotMatch(page, /<script>|<style|style=/, 'no inline script or style: the CSP forbids them');
      assert.ok(readFileSync(path.join(outDir, 'style.css'), 'utf8').length > 0);

      // The built page and its assets are what /dashboard serves.
      const { server, url } = await startServer({ dashboardRoot: outDir });
      try {
        const res = await send(url, '/dashboard');
        assert.equal(res.status, 200);
        assert.equal(res.text, page);
        assert.equal((await send(url, '/dashboard/main.js')).headers['content-type'], 'text/javascript; charset=utf-8');
        assert.equal((await send(url, '/dashboard/style.css')).status, 200);
        assert.equal((await send(url, '/dashboard/main.ts')).status, 404, 'sources are not copied or served');
      } finally {
        await stopServer(server, 1000);
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('refuses to build into a folder that holds the sources', () => {
    const built = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'build-dashboard.ts'), repoRoot], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    assert.equal(built.status, 1);
    assert.match(built.stderr, /refusing to build into/);
  });
});
