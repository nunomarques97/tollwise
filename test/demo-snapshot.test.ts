// demo/snapshot.json, the recorded data of the static dashboard demo (scripts/record-demo-snapshot.ts):
// its 30-day totals equal the newest savings benchmark's presets-on / cheapest run, it answers every
// path the dashboard issues, its timestamp schedule covers every range, it carries nothing sensitive,
// and --verify catches a snapshot that no longer matches a new recording.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { REALISTIC_SEGMENTS } from '../benchmarks/savings.ts';
import { presetsOnRequests } from '../scripts/demo.ts';
// @ts-expect-error -- plain JavaScript module without type declarations
import { findKeyHits } from '../scripts/key-rules.mjs';
import {
  BENCHMARK_SCENARIO,
  benchmarkRun,
  buildSchedule,
  coverageProblems,
  fixedPaths,
  RANGES,
  REQUESTS_PAGE_SIZE,
  requestsPath,
  SCHEDULE_TIERS,
  snapshotDifferences,
} from '../scripts/record-demo-snapshot.ts';
import { loadCatalog } from '../src/catalog/index.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..');
const scriptPath = path.join(repoRoot, 'scripts', 'record-demo-snapshot.ts');
const snapshotText = readFileSync(path.join(repoRoot, 'demo', 'snapshot.json'), 'utf8');

interface Snapshot {
  readonly meta: Record<string, unknown> & { recorded_at: string };
  readonly responses: Record<string, Record<string, unknown>>;
}

const snapshot = JSON.parse(snapshotText) as Snapshot;
const workDir = mkdtempSync(path.join(tmpdir(), 'tollwise-demo-snapshot-test-'));
after(() => rmSync(workDir, { recursive: true, force: true }));

function answer(apiPath: string): Record<string, unknown> {
  const body = snapshot.responses[apiPath];
  assert.ok(body !== undefined, `the snapshot has no answer for ${apiPath}`);
  return body;
}

test('the 30-day summary equals the newest benchmark presets-on / cheapest run', () => {
  const { file, run } = benchmarkRun();
  const month = answer('/api/metrics/summary?range=30d');
  assert.equal(month.requests, run.requests);
  assert.equal(month.spend_usd, run.total_cost_usd);
  assert.equal(month.baseline_usd, run.total_baseline_usd);
  assert.equal(month.savings_usd, run.total_savings_usd);
  assert.equal(month.savings_percent, run.savings_percent);
  assert.equal(month.substituted_requests, run.substituted_requests);
  assert.deepEqual(snapshot.meta.benchmark, { results_file: file, scenario: BENCHMARK_SCENARIO, policy: 'cheapest' });
});

test('the meta block records how the snapshot was generated', () => {
  const meta = snapshot.meta;
  assert.equal(meta.command, 'npm run demo:snapshot');
  assert.equal(meta.script, 'node scripts/record-demo-snapshot.ts');
  assert.equal(meta.verify_command, 'node scripts/record-demo-snapshot.ts --verify');
  assert.equal(meta.workload, 'presets-on');
  assert.equal(meta.seed, 424242);
  assert.deepEqual(meta.equivalence_presets, ['frontier', 'small-fast']);
  assert.equal(meta.policy, 'cheapest');
  assert.equal(meta.requests, presetsOnRequests().length);
  const verifiedOn = [...new Set(loadCatalog().models.map((entry) => entry.verified_on))].sort();
  assert.deepEqual((meta.catalog as { verified_on: unknown }).verified_on, verifiedOn);
  assert.ok(!Number.isNaN(Date.parse(meta.recorded_at)));
  const schedule = meta.timestamp_schedule as { seed: unknown; tiers: unknown[]; description: unknown };
  assert.equal(typeof schedule.seed, 'number');
  assert.equal(schedule.tiers.length, SCHEDULE_TIERS.length);
  assert.equal(typeof schedule.description, 'string');
  const volatile = meta.volatile_fields as { meta: string[]; response_keys: string[] };
  assert.deepEqual(volatile.meta, ['recorded_at']);
  assert.ok(volatile.response_keys.includes('requestId'));
  assert.ok(volatile.response_keys.includes('latency_ms'));
});

test('the snapshot answers every path the dashboard issues, every page of requests included', () => {
  for (const apiPath of fixedPaths()) answer(apiPath);
  for (const range of RANGES) {
    // Both chart widths of every range (bucketForRange()), so re-bucketing across 720 px works offline.
    assert.ok(fixedPaths().some((entry) => entry.startsWith(`/api/metrics/timeseries?range=${range}&`)));
  }
  let cursor: string | undefined;
  const seen = new Set<string>();
  let pages = 0;
  do {
    const page = answer(requestsPath(REQUESTS_PAGE_SIZE, cursor)) as {
      entries: { requestId: string }[];
      nextCursor: string | null;
    };
    for (const entry of page.entries) seen.add(entry.requestId);
    cursor = page.nextCursor ?? undefined;
    pages += 1;
  } while (cursor !== undefined);
  assert.equal(seen.size, presetsOnRequests().length, 'the pages hold every request exactly once');
  assert.equal(
    Object.keys(snapshot.responses).length,
    fixedPaths().length + pages,
    'no answer the dashboard never asks for',
  );
});

test('every range holds a request and a substituted request, and 30d the whole workload', () => {
  assert.deepEqual(coverageProblems(snapshot as unknown as Record<string, unknown>, presetsOnRequests().length), []);
  const recordedAt = Date.parse(snapshot.meta.recorded_at);
  const monthAgo = recordedAt - 30 * 24 * 3600 * 1000;
  for (const [apiPath, body] of Object.entries(snapshot.responses)) {
    if (!apiPath.startsWith('/api/requests?limit=50')) continue;
    for (const entry of body.entries as { timestamp: string }[]) {
      const at = Date.parse(entry.timestamp);
      assert.ok(at > monthAgo && at < recordedAt, `${entry.timestamp} is not within the 30 days before the recording`);
    }
  }
});

test('the timestamp schedule is seeded, fills each tier and is not grouped by workload segment', () => {
  const requests = presetsOnRequests();
  const offsets = buildSchedule(requests.length);
  assert.deepEqual(offsets, buildSchedule(requests.length), 'the same seed gives the same schedule');
  for (const tier of SCHEDULE_TIERS) {
    const inTier = offsets.filter((offset) => offset >= tier.from && offset < tier.to);
    assert.equal(inTier.length, tier.count, `tier ${tier.range}`);
  }
  // The segment of each request, in time order: a grouped schedule would change segment only 17 times.
  const segmentOf: number[] = [];
  REALISTIC_SEGMENTS.forEach((segment, index) => {
    for (let i = 0; i < segment.count; i += 1) segmentOf.push(index);
  });
  const inTimeOrder = offsets
    .map((offset, index) => ({ offset, segment: segmentOf[index] }))
    .sort((a, b) => a.offset - b.offset);
  let changes = 0;
  for (let i = 1; i < inTimeOrder.length; i += 1) {
    if (inTimeOrder[i]?.segment !== inTimeOrder[i - 1]?.segment) changes += 1;
  }
  assert.ok(changes > 60, `only ${changes} segment changes in time order`);
});

test('the snapshot holds no credential-shaped value, absolute path, prompt text or process wording', () => {
  assert.deepEqual(findKeyHits(JSON.stringify(snapshot, null, 2)), []);
  assert.doesNotMatch(snapshotText, /[A-Za-z]:\\\\|\/Users\/|\/home\/|file:\/\/|127\.0\.0\.1|localhost/);
  assert.doesNotMatch(snapshotText, /\b(forja|sponsor|checkpoint|transcript|agent)\b/i); // tollwise-allow-deny(forja,checkpoint)
  assert.doesNotMatch(snapshotText, /fake-key|Mock answer|tollwise-demo-/);
  const promptTexts = new Set<string>();
  const collect = (value: unknown): void => {
    if (typeof value === 'string' && value.length >= 12) promptTexts.add(value.slice(0, 40));
    else if (Array.isArray(value)) value.forEach(collect);
    else if (typeof value === 'object' && value !== null) {
      for (const [key, inner] of Object.entries(value)) if (key !== 'model') collect(inner);
    }
  };
  for (const request of presetsOnRequests()) collect(request.body.messages ?? request.body.system);
  assert.ok(promptTexts.size > 0);
  for (const text of promptTexts) assert.ok(!snapshotText.includes(text), `prompt text in the snapshot: ${text}`);
});

test('snapshotDifferences names a changed value and ignores the volatile ones', () => {
  const copy = JSON.parse(snapshotText) as Snapshot;
  copy.meta.recorded_at = '2000-01-01T00:00:00.000Z';
  const firstPage = copy.responses[requestsPath(REQUESTS_PAGE_SIZE)] as { entries: Record<string, unknown>[] };
  (firstPage.entries[0] as Record<string, unknown>).requestId = 'another-id';
  (firstPage.entries[0] as Record<string, unknown>).latency_ms = 12345;
  assert.deepEqual(snapshotDifferences(snapshot, copy), []);

  (copy.responses['/api/metrics/summary?range=7d'] as Record<string, unknown>).spend_usd = '9.999999';
  copy.meta.policy = 'fastest';
  const differences = snapshotDifferences(snapshot, copy);
  assert.equal(differences.length, 2);
  assert.match(differences[0] as string, /"meta"\."policy": committed "cheapest", recorded "fastest"/);
  assert.match(differences[1] as string, /summary\?range=7d"\."spend_usd"/);
});

test('--verify exits non-zero and names the first differences when the snapshot does not match', async () => {
  const tampered = JSON.parse(snapshotText) as Snapshot;
  (tampered.responses['/api/metrics/summary?range=30d'] as Record<string, unknown>).savings_percent = 99.9;
  const file = path.join(workDir, 'tampered.json');
  writeFileSync(file, JSON.stringify(tampered), 'utf8');

  const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [scriptPath, '--verify', '--snapshot', file], {
      cwd: repoRoot,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('exit', (code) => resolve({ code, stderr }));
  });
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /summary\?range=30d"\."savings_percent": committed 99\.9, recorded 84\.2/);
  assert.equal(readFileSync(file, 'utf8'), JSON.stringify(tampered), '--verify never writes');
});
