#!/usr/bin/env node
// `npm run demo:snapshot`: records demo/snapshot.json, the data the static demo of the dashboard shows
// in place of the live metrics API. It runs `npm run demo -- --workload presets-on` in this same
// process (startDemoSession() in scripts/demo.ts: local mock providers on 127.0.0.1, fake keys only,
// analytics in a temporary SQLite file that is deleted afterwards, never data/), then asks the real
// Tollwise API for every path and query the dashboard issues and writes each answer, unchanged,
// under that path.
//
// Timestamps: a live run would stamp all 100 requests within a few seconds, so every range would show
// the same data and every chart a single bar. The recorder instead stamps each request's stored
// outcome with a time on a fixed, seeded schedule within the 30 days before the recording time (see
// SCHEDULE_TIERS and buildSchedule()), and pins the metrics API's clock to that recording time. The
// requests themselves, their routing and their cost are exactly those of the live demo.
//
// `--verify` re-records with the committed recording time, without writing, and exits 0 only when
// every value equals demo/snapshot.json except the volatile ones listed in its meta block.
//
// Usage: node scripts/record-demo-snapshot.ts [--verify] [--snapshot PATH]

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mulberry32, newestResultsName, PRESETS_ON_CONFIG, WORKLOAD_SEED } from '../benchmarks/savings.ts';
import { openSqliteEventStore } from '../src/analytics/store.ts';
import { loadCatalog } from '../src/catalog/index.ts';
import { bucketForRange } from '../src/dashboard/charts/timeseries-model.ts';
import type { RangeId } from '../src/dashboard/ranges.ts';
import type { RequestOutcome } from '../src/proxy/outcome.ts';
import { PRESETS_ON_POLICY, presetsOnRequests, sendWorkloadRequest, startDemoSession } from './demo.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..');

export const SNAPSHOT_FILE = 'demo/snapshot.json';
export const RECORD_COMMAND = 'npm run demo:snapshot';
export const SCRIPT_COMMAND = 'node scripts/record-demo-snapshot.ts';
export const VERIFY_COMMAND = 'node scripts/record-demo-snapshot.ts --verify';
/** The demo workload the snapshot is recorded from (`npm run demo -- --workload presets-on`). */
export const SNAPSHOT_WORKLOAD = 'presets-on';
/** The savings benchmark's scenario and policy whose totals the snapshot's 30-day summary equals. */
export const BENCHMARK_SCENARIO = 'presets-on';

/** The ranges and dimensions the dashboard offers (src/dashboard/ranges.ts, main.ts). */
export const RANGES: readonly RangeId[] = ['1h', '24h', '7d', '30d'];
const DIMENSIONS = ['provider', 'model'] as const;
/** GET /api/requests page size the dashboard uses (REQUESTS_PAGE_SIZE in src/dashboard/main.ts). */
export const REQUESTS_PAGE_SIZE = 50;

// ---------------------------------------------------------------- the timestamp schedule

/** Seed of the timestamp schedule (mulberry32, the same generator as the benchmark workload). */
export const SCHEDULE_SEED = 20260925;

const MINUTE_S = 60;
const HOUR_S = 60 * MINUTE_S;
const DAY_S = 24 * HOUR_S;

/**
 * Where the requests fall, as seconds before the recording time. Each tier gets `count` offsets drawn
 * uniformly from [from, to) at whole-second resolution. The tiers nest into the dashboard's ranges,
 * so 1h holds 4 requests, 24h 14, 7d 40 and 30d all 100.
 */
export const SCHEDULE_TIERS: readonly {
  readonly range: RangeId;
  readonly count: number;
  readonly from: number;
  readonly to: number;
}[] = [
  { range: '1h', count: 4, from: MINUTE_S, to: 55 * MINUTE_S },
  { range: '24h', count: 10, from: HOUR_S, to: 23 * HOUR_S },
  { range: '7d', count: 26, from: DAY_S, to: 6.5 * DAY_S },
  { range: '30d', count: 60, from: 7 * DAY_S, to: 29.5 * DAY_S },
];

export const SCHEDULE_DESCRIPTION =
  `Seeded with mulberry32(${SCHEDULE_SEED}). First, each tier draws its count of offsets in seconds, ` +
  'uniformly in [from, to) and floored to a whole second, tier by tier in the order listed. Then a ' +
  'Fisher-Yates shuffle of the workload request indices with the same generator assigns the i-th ' +
  'offset to the i-th shuffled request. Each request is stored at the recording time minus its ' +
  'offset, so the order in time is not grouped by workload segment. The metrics API measures every ' +
  'range back from the recording time.';

/** The offset in seconds before the recording time of each workload request, by request index. */
export function buildSchedule(requestCount: number, seed = SCHEDULE_SEED): number[] {
  const total = SCHEDULE_TIERS.reduce((sum, tier) => sum + tier.count, 0);
  if (total !== requestCount) {
    throw new RangeError(`the schedule has ${total} slots for ${requestCount} requests`);
  }
  const rng = mulberry32(seed);
  const offsets: number[] = [];
  for (const tier of SCHEDULE_TIERS) {
    for (let i = 0; i < tier.count; i += 1) offsets.push(Math.floor(tier.from + rng() * (tier.to - tier.from)));
  }
  const order = Array.from({ length: requestCount }, (_, index) => index);
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j] as number, order[i] as number];
  }
  const byRequest = new Array<number>(requestCount);
  order.forEach((request, slot) => {
    byRequest[request] = offsets[slot] as number;
  });
  return byRequest;
}

// ---------------------------------------------------------------- the paths the dashboard issues

/** GET /api/requests with the dashboard's query, built the way fetchRequests() in src/dashboard/api.ts builds it. */
export function requestsPath(limit: number, before?: string): string {
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  if (before !== undefined) params.set('before', before);
  return `/api/requests?${params.toString()}`;
}

/** Every path the dashboard issues except the older pages of GET /api/requests, which follow the cursors. */
export function fixedPaths(): string[] {
  const paths = ['/api/health', requestsPath(1)];
  for (const range of RANGES) {
    paths.push(`/api/metrics/summary?range=${range}`);
    for (const by of DIMENSIONS) paths.push(`/api/metrics/breakdown?range=${range}&by=${by}`);
    const buckets = new Set([bucketForRange(range, false), bucketForRange(range, true)]);
    for (const bucket of buckets) paths.push(`/api/metrics/timeseries?range=${range}&bucket=${bucket}`);
  }
  return paths;
}

// ---------------------------------------------------------------- volatile values

/**
 * Keys whose values change from one recording to the next, anywhere in a response body: request ids,
 * measured latencies and health check times, and what is computed from them. Plus meta.recorded_at.
 * --verify ignores exactly these.
 */
export const VOLATILE_RESPONSE_KEYS: readonly string[] = [
  // GET /api/requests entries: a random id per request, and measured durations.
  'requestId',
  'latency_ms',
  'first_byte_ms',
  'duration_ms',
  // GET /api/metrics/breakdown groups: percentiles of those measured durations.
  'latency_p50_ms',
  'latency_p95_ms',
  // GET /api/health providers: measured latency percentiles and the time of the last check.
  'p50_ms',
  'p95_ms',
  'last_checked',
];
export const VOLATILE_META_KEYS: readonly string[] = ['recorded_at'];

/** The first `limit` differences between two snapshots, ignoring the volatile values. */
export function snapshotDifferences(expected: unknown, actual: unknown, limit = 20): string[] {
  const differences: string[] = [];
  const visit = (a: unknown, b: unknown, where: string, volatileKeys: ReadonlySet<string>): void => {
    if (differences.length >= limit) return;
    if (
      typeof a === 'object' &&
      a !== null &&
      typeof b === 'object' &&
      b !== null &&
      Array.isArray(a) === Array.isArray(b)
    ) {
      const ra = a as Record<string, unknown>;
      const rb = b as Record<string, unknown>;
      const keys = [...new Set([...Object.keys(ra), ...Object.keys(rb)])];
      for (const key of keys) {
        if (volatileKeys.has(key)) continue;
        const next = Array.isArray(a) ? `${where}[${key}]` : `${where}${where === '' ? '' : '.'}${JSON.stringify(key)}`;
        if (!(key in ra)) differences.push(`${next}: missing from the committed snapshot`);
        else if (!(key in rb)) differences.push(`${next}: missing from the new recording`);
        else visit(ra[key], rb[key], next, volatileKeys);
        if (differences.length >= limit) return;
      }
      return;
    }
    if (!Object.is(a, b)) differences.push(`${where}: committed ${short(a)}, recorded ${short(b)}`);
  };
  const recordA = expected as Record<string, unknown> | null;
  const recordB = actual as Record<string, unknown> | null;
  visit(recordA?.meta, recordB?.meta, '"meta"', new Set(VOLATILE_META_KEYS));
  visit(recordA?.responses, recordB?.responses, '"responses"', new Set(VOLATILE_RESPONSE_KEYS));
  return differences;
}

function short(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

// ---------------------------------------------------------------- recording

/** The newest savings benchmark results file and its presets-on / cheapest run. */
export function benchmarkRun(root = repoRoot): { readonly file: string; readonly run: Record<string, unknown> } {
  const dir = path.join(root, 'benchmarks', 'results');
  const name = newestResultsName(readdirSync(dir));
  if (name === null) throw new Error('no benchmarks/results/savings-*.json to match');
  const record = JSON.parse(readFileSync(path.join(dir, name), 'utf8')) as {
    scenarios?: { id?: string; runs?: Record<string, unknown>[] }[];
  };
  const scenario = record.scenarios?.find((entry) => entry.id === BENCHMARK_SCENARIO);
  const run = scenario?.runs?.find((entry) => entry.policy === PRESETS_ON_POLICY);
  if (run === undefined) throw new Error(`${name} has no ${BENCHMARK_SCENARIO} / ${PRESETS_ON_POLICY} run`);
  return { file: `benchmarks/results/${name}`, run };
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (response.status !== 200) throw new Error(`GET ${new URL(url).pathname} answered ${response.status}`);
  return (await response.json()) as unknown;
}

async function waitForOutcome(count: () => number, expected: number): Promise<void> {
  const deadline = Date.now() + 2000;
  while (count() < expected) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for request outcome ${expected}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Records a snapshot as of `recordedAt` (whole seconds). Everything runs on 127.0.0.1. */
export async function recordSnapshot(recordedAt: Date): Promise<Record<string, unknown>> {
  const requests = presetsOnRequests();
  const offsets = buildSchedule(requests.length);
  const nowMs = recordedAt.getTime();
  const workDir = mkdtempSync(path.join(tmpdir(), 'tollwise-demo-snapshot-'));
  const session = await startDemoSession({
    workload: 'presets-on',
    port: 0,
    quiet: true,
    openAnalytics: (_config, logger) => openSqliteEventStore({ file: path.join(workDir, 'demo.db'), logger }),
    stampOutcome: (outcome: RequestOutcome, index: number) => ({
      ...outcome,
      timestamp: new Date(nowMs - (offsets[index] as number) * 1000).toISOString(),
    }),
    metricsClock: () => new Date(nowMs),
  });
  const responses: Record<string, unknown> = {};
  try {
    await session.checkHealthNow();
    for (const [index, request] of requests.entries()) {
      const answer = await sendWorkloadRequest(session.url, request);
      if (answer.status !== 200) throw new Error(`workload request ${index} answered ${answer.status}`);
      await waitForOutcome(session.outcomeCount, index + 1);
    }
    await session.flush();

    for (const apiPath of fixedPaths()) responses[apiPath] = await getJson(`${session.url}${apiPath}`);
    let cursor: string | null | undefined;
    do {
      const apiPath = requestsPath(REQUESTS_PAGE_SIZE, cursor ?? undefined);
      const page = (await getJson(`${session.url}${apiPath}`)) as { nextCursor?: string | null };
      responses[apiPath] = page;
      cursor = page.nextCursor;
    } while (typeof cursor === 'string');
  } finally {
    await session.close();
    rmSync(workDir, { recursive: true, force: true });
  }

  const benchmark = benchmarkRun();
  const catalog = loadCatalog();
  return {
    meta: {
      label: 'modeled',
      note:
        'Sample data from a modeled workload: the savings benchmark realistic workload replayed through Tollwise ' +
        'against local mock providers and priced with catalog/models.yaml. Not a live service and not a measured bill.',
      command: RECORD_COMMAND,
      script: SCRIPT_COMMAND,
      verify_command: VERIFY_COMMAND,
      workload: SNAPSHOT_WORKLOAD,
      benchmark_workload: 'realistic',
      requests: requests.length,
      seed: WORKLOAD_SEED,
      equivalence_presets: [...PRESETS_ON_CONFIG.equivalencePresets],
      policy: PRESETS_ON_POLICY,
      benchmark: { results_file: benchmark.file, scenario: BENCHMARK_SCENARIO, policy: PRESETS_ON_POLICY },
      catalog: {
        path: 'catalog/models.yaml',
        verified_on: [...new Set(catalog.models.map((entry) => entry.verified_on))].sort(),
      },
      recorded_at: recordedAt.toISOString(),
      timestamp_schedule: {
        seed: SCHEDULE_SEED,
        description: SCHEDULE_DESCRIPTION,
        tiers: SCHEDULE_TIERS.map((tier) => ({
          range: tier.range,
          count: tier.count,
          from_seconds_before: tier.from,
          to_seconds_before: tier.to,
        })),
      },
      volatile_fields: {
        meta: [...VOLATILE_META_KEYS],
        response_keys: [...VOLATILE_RESPONSE_KEYS],
      },
    },
    responses,
  };
}

/** Every range must hold at least one request and one substituted request; 30d the whole workload. */
export function coverageProblems(snapshot: Record<string, unknown>, requestCount: number): string[] {
  const responses = snapshot.responses as Record<string, { requests?: number; substituted_requests?: number }>;
  const problems: string[] = [];
  for (const range of RANGES) {
    const summary = responses[`/api/metrics/summary?range=${range}`];
    if ((summary?.requests ?? 0) < 1) problems.push(`${range} holds no request`);
    if ((summary?.substituted_requests ?? 0) < 1) problems.push(`${range} holds no substituted request`);
  }
  const month = responses['/api/metrics/summary?range=30d'];
  if (month?.requests !== requestCount) problems.push(`30d holds ${month?.requests} of ${requestCount} requests`);
  return problems;
}

// ---------------------------------------------------------------- main

const USAGE = `usage: ${SCRIPT_COMMAND} [--verify] [--snapshot PATH]

Records ${SNAPSHOT_FILE} from \`npm run demo -- --workload ${SNAPSHOT_WORKLOAD}\`, run in this process.
  --verify         re-record with the committed recording time and compare, without writing
  --snapshot PATH  the snapshot file to write or verify (default: ${SNAPSHOT_FILE})
`;

export async function main(args: readonly string[]): Promise<number> {
  let verify = false;
  let file = path.join(repoRoot, SNAPSHOT_FILE);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--verify') verify = true;
    else if (arg === '--snapshot' && args[index + 1] !== undefined) {
      index += 1;
      file = path.resolve(args[index] as string);
    } else {
      process.stderr.write(arg === '--help' || arg === '-h' ? '' : `unknown option ${JSON.stringify(arg)}\n`);
      process.stdout.write(USAGE);
      return arg === '--help' || arg === '-h' ? 0 : 2;
    }
  }

  const committed = verify ? (JSON.parse(readFileSync(file, 'utf8')) as { meta?: { recorded_at?: unknown } }) : null;
  const recordedAt = verify
    ? new Date(String(committed?.meta?.recorded_at))
    : new Date(Math.floor(Date.now() / 1000) * 1000);
  if (Number.isNaN(recordedAt.getTime())) {
    process.stderr.write(`${file} has no valid meta.recorded_at\n`);
    return 1;
  }

  const snapshot = await recordSnapshot(recordedAt);
  const problems = coverageProblems(snapshot, presetsOnRequests().length);
  if (problems.length > 0) {
    process.stderr.write(`the timestamp schedule does not cover every range: ${problems.join('; ')}\n`);
    return 1;
  }

  if (verify) {
    const differences = snapshotDifferences(committed, snapshot);
    if (differences.length > 0) {
      process.stderr.write(
        `${path.relative(repoRoot, file)} differs from a new recording (first ${differences.length}):\n` +
          `${differences.map((line) => `  ${line}`).join('\n')}\n` +
          `Re-record it with \`${RECORD_COMMAND}\` if the change is intended.\n`,
      );
      return 1;
    }
    process.stdout.write(`${path.relative(repoRoot, file)} matches a new recording (volatile values ignored).\n`);
    return 0;
  }

  writeFileSync(file, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  process.stdout.write(
    `wrote ${path.relative(repoRoot, file)} (${Object.keys(snapshot.responses as object).length} API answers)\n`,
  );
  return 0;
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && path.resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `record-demo-snapshot: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
