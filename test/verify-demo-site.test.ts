// scripts/verify-demo-site.ts: the parts that need no browser. Preparing the --out directory must never
// destroy anything the script did not write itself; the static server must only ever serve the site's
// own files under the sub-path; and the request classification must flag every connection the page's
// code makes and every request that leaves the local origin.

import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import {
  BASE_PATH,
  forbiddenRequestReason,
  parseArgs,
  prepareOutputDir,
  resolveSitePath,
  screenshotName,
  screenshotNames,
  startStaticServer,
} from '../scripts/verify-demo-site.ts';

const workDir = mkdtempSync(path.join(tmpdir(), 'tollwise-verify-demo-site-'));
after(() => {
  rmSync(workDir, { recursive: true, force: true });
});

const LOCAL = 'http://127.0.0.1:53211';

test('the site is served under the GitHub Pages sub-path of the repository', () => {
  assert.equal(BASE_PATH, '/tollwise/demo/');
});

test('screenshotNames lists the view, drawer and full-page overview files per width and theme, and nothing else', () => {
  const names = screenshotNames();
  assert.equal(names.length, 24);
  assert.equal(new Set(names).size, 24);
  assert.equal(screenshotName('overview', 1440, 'dark'), 'demo-overview-1440-dark.png');
  for (const expected of [
    'demo-overview-1440-dark.png',
    'demo-routing-390-light.png',
    'demo-savings-1440-light.png',
    'demo-providers-390-dark.png',
    'demo-drawer-substitution-390-dark.png',
    'demo-overview-full-1440-light.png',
  ]) {
    assert.ok(names.includes(expected), expected);
  }
  for (const name of names) {
    assert.match(
      name,
      /^demo-(overview|routing|savings|providers|drawer-substitution|overview-full)-(1440|390)-(dark|light)\.png$/,
    );
  }
});

test('prepareOutputDir leaves unrelated files and folders in an existing --out directory untouched', () => {
  const out = path.join(workDir, 'existing');
  mkdirSync(path.join(out, 'nested'), { recursive: true });
  writeFileSync(path.join(out, 'notes.md'), 'keep me\n');
  // A screenshot of verify:dashboard, which shares no names with this script.
  writeFileSync(path.join(out, 'overview-1440-dark.png'), 'another script\n');
  writeFileSync(path.join(out, 'demo-overview-1440-dark.png.bak'), 'similar name, still not ours\n');
  writeFileSync(path.join(out, 'nested', 'demo-overview-1440-dark.png'), 'same name, other folder\n');
  mkdirSync(path.join(out, 'demo-routing-390-light.png'));
  writeFileSync(path.join(out, 'demo-routing-390-light.png', 'inside.txt'), 'a folder with a screenshot name\n');
  // Two stale screenshots from an earlier run: the only things it may remove.
  writeFileSync(path.join(out, 'demo-overview-1440-dark.png'), 'stale\n');
  writeFileSync(path.join(out, 'demo-drawer-substitution-390-light.png'), 'stale\n');

  const removed = prepareOutputDir(out);

  assert.deepEqual(removed.sort(), ['demo-drawer-substitution-390-light.png', 'demo-overview-1440-dark.png']);
  assert.equal(readFileSync(path.join(out, 'notes.md'), 'utf8'), 'keep me\n');
  assert.equal(readFileSync(path.join(out, 'overview-1440-dark.png'), 'utf8'), 'another script\n');
  assert.equal(
    readFileSync(path.join(out, 'nested', 'demo-overview-1440-dark.png'), 'utf8'),
    'same name, other folder\n',
  );
  assert.equal(
    readFileSync(path.join(out, 'demo-routing-390-light.png', 'inside.txt'), 'utf8'),
    'a folder with a screenshot name\n',
  );
  assert.deepEqual(readdirSync(out).sort(), [
    'demo-overview-1440-dark.png.bak',
    'demo-routing-390-light.png',
    'nested',
    'notes.md',
    'overview-1440-dark.png',
  ]);
});

test('prepareOutputDir creates a missing --out directory, parents included', () => {
  const out = path.join(workDir, 'missing', 'a', 'b');
  assert.deepEqual(prepareOutputDir(out), []);
  assert.deepEqual(readdirSync(out), []);
});

test('prepareOutputDir refuses an --out path that is a file, and leaves the file as it was', () => {
  const file = path.join(workDir, 'a-file.txt');
  writeFileSync(file, 'content\n');
  assert.throws(() => prepareOutputDir(file), /--out must be a directory/);
  assert.equal(readFileSync(file, 'utf8'), 'content\n');
});

test('parseArgs defaults to .tmp-demo-site/, resolves --out and rejects a missing value or an unknown option', () => {
  const quiet = <T>(run: () => T): T => {
    const { log, error } = console;
    console.log = () => {};
    console.error = () => {};
    try {
      return run();
    } finally {
      console.log = log;
      console.error = error;
    }
  };
  const defaults = parseArgs([]);
  assert.ok('out' in defaults);
  assert.equal(path.basename(defaults.out), '.tmp-demo-site');
  const custom = parseArgs(['--out', 'shots']);
  assert.ok('out' in custom);
  assert.equal(custom.out, path.resolve('shots'));
  assert.deepEqual(
    quiet(() => parseArgs(['--out'])),
    { exit: 2 },
  );
  assert.deepEqual(
    quiet(() => parseArgs(['--out', '--help'])),
    { exit: 2 },
  );
  assert.deepEqual(
    quiet(() => parseArgs(['--verbose'])),
    { exit: 2 },
  );
  assert.deepEqual(
    quiet(() => parseArgs(['--help'])),
    { exit: 0 },
  );
});

test('forbiddenRequestReason flags every fetch, XHR, event stream and WebSocket, even to the local origin', () => {
  for (const resourceType of ['fetch', 'xhr', 'eventsource', 'websocket']) {
    assert.equal(
      forbiddenRequestReason({ url: `${LOCAL}/tollwise/demo/snapshot.json`, resourceType }, LOCAL),
      `a ${resourceType} request`,
    );
  }
  assert.equal(
    forbiddenRequestReason({ url: 'ws://127.0.0.1:53211/events', resourceType: 'websocket' }, LOCAL),
    'a websocket request',
  );
});

test('forbiddenRequestReason flags any request that leaves the local origin, whatever its type', () => {
  for (const url of [
    'https://github.com/nunomarques97/tollwise',
    'https://fonts.googleapis.com/css2?family=Inter',
    'http://127.0.0.1:53212/tollwise/demo/style.css', // same host, another port
    'http://localhost:53211/tollwise/demo/style.css', // same port, another host name
    'https://127.0.0.1:53211/tollwise/demo/style.css', // another scheme
  ]) {
    for (const resourceType of ['document', 'script', 'stylesheet', 'image', 'font', 'other']) {
      assert.equal(
        forbiddenRequestReason({ url, resourceType }, LOCAL),
        'a request that leaves the local origin',
        `${resourceType} ${url}`,
      );
    }
  }
  assert.equal(
    forbiddenRequestReason({ url: 'not a url', resourceType: 'script' }, LOCAL),
    'a request to an unparsable URL',
  );
});

test('forbiddenRequestReason allows the page loading its own files and data: URLs', () => {
  for (const [url, resourceType] of [
    [`${LOCAL}/tollwise/demo/`, 'document'],
    [`${LOCAL}/tollwise/demo/demo/entry.js`, 'script'],
    [`${LOCAL}/tollwise/demo/style.css`, 'stylesheet'],
    ['data:image/svg+xml,%3Csvg%3E%3C/svg%3E', 'image'],
  ] as const) {
    assert.equal(forbiddenRequestReason({ url, resourceType }, LOCAL), undefined, url);
  }
});

// ---------------------------------------------------------------- the static file server

const site = path.join(workDir, 'site');
mkdirSync(path.join(site, 'demo'), { recursive: true });
writeFileSync(path.join(site, 'index.html'), '<!doctype html><title>demo</title>\n');
writeFileSync(path.join(site, 'demo', 'entry.js'), 'export {};\n');
writeFileSync(path.join(site, 'notes.txt'), 'unknown type\n');
writeFileSync(path.join(workDir, 'outside.js'), 'outside the site\n');

test('resolveSitePath serves the site files under the base path and redirects the bare base path', () => {
  assert.deepEqual(resolveSitePath(site, BASE_PATH, '/tollwise/demo'), { kind: 'redirect', location: BASE_PATH });
  const index = resolveSitePath(site, BASE_PATH, '/tollwise/demo/?theme=dark#routing');
  assert.equal(index.kind, 'file');
  assert.ok(index.kind === 'file' && index.file.endsWith('index.html'));
  assert.equal(index.kind === 'file' && index.contentType, 'text/html; charset=utf-8');
  const script = resolveSitePath(site, BASE_PATH, '/tollwise/demo/demo/entry.js');
  assert.equal(script.kind === 'file' && script.contentType, 'text/javascript; charset=utf-8');
});

test('resolveSitePath never serves anything outside the site or of an unknown type', () => {
  for (const requestPath of [
    '/',
    '/index.html',
    '/tollwise/index.html',
    '/tollwise/demo/../outside.js',
    '/tollwise/demo/%2e%2e/outside.js',
    '/tollwise/demo/demo/%2e%2e%2f%2e%2e%2foutside.js',
    '/tollwise/demo/..%5coutside.js',
    '/tollwise/demo/demo%5c..%5c..%5coutside.js',
    '/tollwise/demo/index.html%00.js',
    '/tollwise/demo//index.html',
    '/tollwise/demo/./index.html',
    '/tollwise/demo/%E0%A4%A',
    '/tollwise/demo/notes.txt',
    '/tollwise/demo/missing.js',
    '/tollwise/demo/demo', // a folder without a trailing slash
  ]) {
    assert.deepEqual(resolveSitePath(site, BASE_PATH, requestPath), { kind: 'not-found' }, requestPath);
  }
});

test('resolveSitePath does not follow a symbolic link out of the site', (t) => {
  const link = path.join(site, 'linked.js');
  try {
    symlinkSync(path.join(workDir, 'outside.js'), link, 'file');
  } catch {
    t.skip('this system does not allow creating a symbolic link');
    return;
  }
  assert.deepEqual(resolveSitePath(site, BASE_PATH, '/tollwise/demo/linked.js'), { kind: 'not-found' });
  rmSync(link);
});

function get(
  origin: string,
  requestPath: string,
  method = 'GET',
): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${origin}${requestPath}`, { method }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('startStaticServer listens on 127.0.0.1 on an ephemeral port, answers GET and HEAD only, and logs every request', async () => {
  const server = await startStaticServer(site, BASE_PATH);
  try {
    assert.match(server.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.notEqual(server.origin, 'http://127.0.0.1:0');

    const page = await get(server.origin, '/tollwise/demo/');
    assert.equal(page.status, 200);
    assert.equal(page.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(page.headers['cache-control'], 'no-store');
    assert.equal(page.body, '<!doctype html><title>demo</title>\n');

    const redirect = await get(server.origin, '/tollwise/demo');
    assert.equal(redirect.status, 301);
    assert.equal(redirect.headers.location, BASE_PATH);

    assert.equal((await get(server.origin, '/tollwise/demo/demo/%2e%2e%2f%2e%2e%2foutside.js')).status, 404);
    const head = await get(server.origin, '/tollwise/demo/demo/entry.js', 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
    const post = await get(server.origin, '/tollwise/demo/', 'POST');
    assert.equal(post.status, 405);
    assert.equal(post.headers.allow, 'GET, HEAD');

    assert.deepEqual(server.log, [
      '200 GET /tollwise/demo/',
      '301 GET /tollwise/demo',
      '404 GET /tollwise/demo/demo/%2e%2e%2f%2e%2e%2foutside.js',
      '200 HEAD /tollwise/demo/demo/entry.js',
      '405 POST /tollwise/demo/',
    ]);
  } finally {
    await server.close();
  }
  assert.equal(existsSync(site), true);
});
