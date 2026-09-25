// The static demo of the dashboard (scripts/build-demo-site.ts, served from docs/demo): a fresh build
// succeeds and equals the committed site, its page carries the demo banner, both links and a policy that
// forbids every connection, its data source answers every read the dashboard makes from the snapshot with
// the network unusable, and no built file holds a credential-shaped value or an absolute filesystem path.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  BANNER_LEAD,
  BANNER_TEXT,
  BENCHMARK_METHOD_URL,
  demoCsp,
  demoIndexHtml,
  QUICK_START_URL,
  unsafeOutputReason,
} from '../scripts/build-demo-site.ts';
// @ts-expect-error -- plain JavaScript module without type declarations
import { ALLOW_MARKER, findKeyHits } from '../scripts/key-rules.mjs';
import {
  type ApiResult,
  fetchBreakdown,
  fetchHealth,
  fetchLastRequestTime,
  fetchRequests,
  fetchSummary,
  fetchTimeseries,
} from '../src/dashboard/api.ts';
import { bucketForRange } from '../src/dashboard/charts/timeseries-model.ts';
import { DEMO_DEFAULT_RANGE, snapshotSource } from '../src/dashboard/demo/snapshot-source.ts';
import { RANGES } from '../src/dashboard/ranges.ts';
import { DASHBOARD_CSP } from '../src/server/dashboard.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const committedSite = path.join(repoRoot, 'docs', 'demo');
const snapshotJson: unknown = JSON.parse(readFileSync(path.join(repoRoot, 'demo', 'snapshot.json'), 'utf8'));

const scratch = mkdtempSync(path.join(tmpdir(), 'tollwise-demo-site-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** Every file below `dir`, as sorted `/`-separated paths relative to it. */
function listFiles(dir: string, prefix = ''): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...listFiles(path.join(dir, entry.name), relative));
    else files.push(relative);
  }
  return files.sort();
}

/** Runs the build script the way `npm run build:demo-site` does, into `outDir`. */
function runBuild(outDir: string): { status: number | null; output: string } {
  const run = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'build-demo-site.ts'), outDir], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

const built = path.join(scratch, 'site');
const build = runBuild(built);

describe('the build', () => {
  test('exits 0 and produces exactly the committed docs/demo/', () => {
    assert.equal(build.status, 0, build.output);
    const builtFiles = listFiles(built);
    assert.deepEqual(builtFiles, listFiles(committedSite), 'docs/demo/ is stale: run `npm run build:demo-site`');
    for (const file of builtFiles) {
      assert.ok(
        readFileSync(path.join(built, file)).equals(readFileSync(path.join(committedSite, file))),
        `docs/demo/${file} is stale: run \`npm run build:demo-site\``,
      );
    }
  });

  test('ships the demo entry and the snapshot module, and not the live entry', () => {
    const files = listFiles(built);
    for (const file of ['index.html', 'style.css', 'theme-init.js', 'shell.js', 'demo/entry.js', 'demo/snapshot.js']) {
      assert.ok(files.includes(file), `missing ${file}`);
    }
    assert.ok(!files.includes('main.js'), 'the live entry must not be in the demo site');
    assert.ok(!files.some((file) => file.endsWith('.ts')), 'no TypeScript source in the site');
  });

  test('empties a previous build of its own, and refuses folders that are not one', () => {
    const rebuilt = path.join(scratch, 'rebuilt');
    assert.equal(runBuild(rebuilt).status, 0);
    writeFileSync(path.join(rebuilt, 'leftover.js'), '// stale\n');
    assert.equal(runBuild(rebuilt).status, 0);
    assert.ok(!listFiles(rebuilt).includes('leftover.js'), 'a rebuild must empty its own output folder');

    const foreign = path.join(scratch, 'foreign');
    mkdirSync(foreign);
    writeFileSync(path.join(foreign, 'notes.txt'), 'keep me\n');
    const refused = runBuild(foreign);
    assert.equal(refused.status, 1);
    assert.match(refused.output, /refusing to build/);
    assert.equal(readFileSync(path.join(foreign, 'notes.txt'), 'utf8'), 'keep me\n');

    assert.match(unsafeOutputReason(repoRoot) ?? '', /repository/);
    assert.match(unsafeOutputReason(path.join(repoRoot, 'src')) ?? '', /repository|sources/);
    assert.match(unsafeOutputReason(path.join(repoRoot, 'src', 'dashboard', 'out')) ?? '', /sources/);
    assert.match(unsafeOutputReason(path.join(repoRoot, 'demo')) ?? '', /snapshot/);
    assert.equal(unsafeOutputReason(committedSite), undefined);
  });

  test('leaves the live dashboard build without snapshot data', () => {
    const live = path.join(scratch, 'live');
    const run = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'build-dashboard.ts'), live], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    const files = listFiles(live);
    assert.ok(files.includes('main.js'));
    assert.ok(!files.includes('demo/snapshot.js'), 'the live build must not hold the snapshot');
    const recordedAt = (snapshotJson as { meta: { recorded_at: string } }).meta.recorded_at;
    for (const file of files) {
      const text = readFileSync(path.join(live, file), 'utf8');
      assert.ok(
        !text.includes(recordedAt) && !text.includes('/api/metrics/summary?range=30d"'),
        `${file} holds snapshot data`,
      );
    }
    assert.match(readFileSync(path.join(live, 'index.html'), 'utf8'), /src="\/dashboard\/main\.js"/);
  });
});

describe('the page', () => {
  const html = readFileSync(path.join(built, 'index.html'), 'utf8');

  test('carries the permanent banner with both links, first in the main block', () => {
    assert.ok(html.includes(`<strong>${BANNER_LEAD}</strong>`));
    assert.ok(html.includes(BANNER_TEXT));
    assert.match(BANNER_TEXT, /sample data from a modeled workload, not a live service/i);
    assert.ok(html.includes(`href="${BENCHMARK_METHOD_URL}"`));
    assert.ok(html.includes(`href="${QUICK_START_URL}"`));
    assert.equal(
      BENCHMARK_METHOD_URL,
      'https://github.com/nunomarques97/tollwise/blob/main/docs/benchmarks.md#savings-modeled',
    );
    assert.equal(QUICK_START_URL, 'https://github.com/nunomarques97/tollwise#quick-start');
    assert.match(html, /<main id="content" tabindex="-1">\s*<div class="banner is-demo" role="note"/);
    const banner = /<div class="banner is-demo"[\s\S]*?<\/div>/.exec(html)?.[0] ?? '';
    assert.doesNotMatch(banner, /<button/, 'the banner cannot be dismissed');
  });

  test("forbids every connection and otherwise keeps the dashboard's policy", () => {
    const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html)?.[1];
    assert.ok(csp !== undefined, 'no Content-Security-Policy meta');
    assert.equal(csp, demoCsp());
    const directives = csp.split('; ');
    assert.ok(directives.includes("connect-src 'none'"));
    for (const directive of DASHBOARD_CSP.split('; ')) {
      if (directive.startsWith('connect-src ') || directive.startsWith('frame-ancestors ')) continue;
      assert.ok(directives.includes(directive), `missing ${directive}`);
    }
  });

  test('uses only relative asset paths, the demo entry, the demo status and a demo noscript text', () => {
    assert.doesNotMatch(html, /(?:src|href)="\//);
    assert.match(html, /<script type="module" src="demo\/entry\.js"><\/script>/);
    assert.ok(html.includes('<tw-live-status data-state="demo">'));
    assert.match(html, /<p class="noscript">This static demo of the Tollwise dashboard needs JavaScript[^<]*<\/p>/);
  });

  test('is built from the live page and fails loudly when that page changes shape', () => {
    const live = readFileSync(path.join(repoRoot, 'src', 'dashboard', 'index.html'), 'utf8');
    assert.equal(demoIndexHtml(live), html);
    assert.throws(
      () => demoIndexHtml(live.replace('src="/dashboard/main.js"', 'src="/dashboard/app.js"')),
      /exactly one/,
    );
  });
});

describe('the demo data source', () => {
  const blocked: string[] = [];
  const saved = new Map<string, unknown>();
  const NETWORK = ['fetch', 'EventSource', 'XMLHttpRequest', 'WebSocket'] as const;

  beforeEach(() => {
    const globals = globalThis as Record<string, unknown>;
    for (const name of NETWORK) {
      saved.set(name, globals[name]);
      globals[name] = () => {
        blocked.push(name);
        throw new Error(`${name} must not be used by the static demo`);
      };
    }
  });
  afterEach(() => {
    const globals = globalThis as Record<string, unknown>;
    for (const name of NETWORK) globals[name] = saved.get(name);
    assert.deepEqual(blocked, [], 'the demo data source touched the network');
  });

  function ok<T>(result: ApiResult<T>, what: string): T {
    assert.equal(result.kind, 'ok', `${what}: ${JSON.stringify(result)}`);
    return (result as { readonly value: T }).value;
  }

  test('answers every read the dashboard makes, for every range and every page, without the network', async () => {
    const source = snapshotSource(snapshotJson);
    assert.equal(source.kind, 'snapshot');
    const read = source.read;

    ok(await fetchHealth(read, undefined), 'health');
    ok(await fetchLastRequestTime(read, undefined), 'last request');
    for (const { id: range } of RANGES) {
      ok(await fetchSummary(read, range, undefined), `summary ${range}`);
      ok(await fetchBreakdown(read, range, 'provider', undefined), `providers ${range}`);
      ok(await fetchBreakdown(read, range, 'model', undefined), `models ${range}`);
      for (const narrow of [false, true]) {
        const bucket = bucketForRange(range, narrow);
        ok(await fetchTimeseries(read, range, bucket, undefined), `timeseries ${range} ${bucket}`);
      }
    }

    let page = ok(await fetchRequests(read, undefined, { limit: 50 }), 'requests');
    const seen = [...page.entries];
    for (let pages = 1; page.nextCursor !== null; pages += 1) {
      assert.ok(pages < 100, 'the recorded pages never end');
      page = ok(await fetchRequests(read, undefined, { limit: 50, before: page.nextCursor }), `page ${pages + 1}`);
      seen.push(...page.entries);
    }
    const summary = ok(await fetchSummary(read, '30d', undefined), 'summary 30d');
    assert.equal(seen.length, summary.requests, 'the pages hold every request of the 30-day range');
    assert.ok(
      seen.some((entry) => entry.substitution !== null),
      'the pages include a substituted request for the drawer',
    );
  });

  test('opens on 30 days and shows the recording date, not a clock', () => {
    const source = snapshotSource(snapshotJson);
    assert.ok(source.kind === 'snapshot');
    assert.equal(source.defaultRange, '30d');
    assert.equal(DEMO_DEFAULT_RANGE, '30d');
    const recordedAt = (snapshotJson as { meta: { recorded_at: string } }).meta.recorded_at;
    assert.equal(source.asOf, `Recorded ${recordedAt.slice(0, 10)}`);
  });

  test('answers a path the snapshot does not hold with a 404, without the network', async () => {
    const { read } = snapshotSource(snapshotJson);
    for (const missing of ['/api/events', '/api/requests?limit=50&before=0-0', '/api/metrics/summary?range=90d']) {
      const response = await read(missing);
      assert.equal(response.status, 404, missing);
      assert.equal(((await response.json()) as { error: { code: string } }).error.code, 'not_found');
    }
    const result = await fetchSummary(read, '1h', undefined);
    assert.equal(result.kind, 'ok');
  });

  test('refuses a snapshot without its recording time or with a non-API key', () => {
    assert.throws(() => snapshotSource({ responses: {} }), /meta/);
    assert.throws(() => snapshotSource({ meta: { recorded_at: 'soon' }, responses: {} }), /recorded_at/);
    assert.throws(
      () => snapshotSource({ meta: { recorded_at: '2026-09-25T00:00:00Z' }, responses: { 'https://x.test/': {} } }),
      /\/api\//,
    );
  });
});

describe('the built files', () => {
  const home = homedir();
  const ABSOLUTE_PATH = /(?<![A-Za-z0-9])[A-Za-z]:[\\/](?![\\/])|file:\/\/|\/(?:Users|home|root)\/[^\s"'`]/;

  test('hold no credential-shaped value and no absolute filesystem path', () => {
    for (const file of listFiles(built)) {
      const text = readFileSync(path.join(built, file), 'utf8');
      assert.deepEqual(findKeyHits(text), [], `${file} holds a credential-shaped value`);
      assert.ok(!text.includes(ALLOW_MARKER), `${file} holds an allow-listed fake key`);
      assert.doesNotMatch(text, ABSOLUTE_PATH, `${file} holds an absolute filesystem path`);
      for (const local of [repoRoot, repoRoot.replaceAll('\\', '/'), scratch, home]) {
        assert.ok(!text.includes(local), `${file} names a local folder`);
      }
    }
  });

  test('the path check itself catches the shapes it looks for', () => {
    const absolute = ['C:\\Users\\x', 'D:/work/site', 'file:///tmp/a', '/home/dev/app', '/Users/dev/app']; // tollwise-allow-deny(local-path)
    for (const sample of absolute) {
      assert.match(sample, ABSOLUTE_PATH, sample);
    }
    for (const sample of ['https://github.com/nunomarques97/tollwise', 'data:image/svg+xml', 'demo/entry.js']) {
      assert.doesNotMatch(sample, ABSOLUTE_PATH, sample);
    }
  });
});
