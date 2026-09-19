// Metrics queries over a real SqliteEventStore: summary, timeseries, breakdown, recent. Rows are
// seeded directly (record() + flush()), never through the HTTP server, so every window boundary,
// unknown-baseline row and pagination cursor is exact and reproducible.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import {
  breakdown,
  DEFAULT_RECENT_LIMIT,
  MAX_RECENT_LIMIT,
  MAX_TIMESERIES_BUCKETS,
  MetricsQueryError,
  recent,
  summary,
  timeseries,
  toRecentEntry,
} from '../src/analytics/metrics.ts';
import { openSqliteEventStore, type SqliteEventStore } from '../src/analytics/store.ts';
import { createLogger } from '../src/log/logger.ts';
import type { OutcomePrices, OutcomeSelection, RequestOutcome } from '../src/proxy/outcome.ts';

const workRoot = mkdtempSync(path.join(tmpdir(), 'tollwise-metrics-test-'));
test.after(() => rmSync(workRoot, { recursive: true, force: true }));

let dirCounter = 0;
function openStore(): SqliteEventStore {
  dirCounter += 1;
  const file = path.join(workRoot, `case-${dirCounter}.db`);
  const logger = createLogger({ level: 'error', sink: { write: () => true }, env: {} });
  return openSqliteEventStore({ file, logger });
}

/** A full RequestOutcome with sensible defaults, overridden per test. */
function outcome(overrides: Partial<RequestOutcome> & Pick<RequestOutcome, 'timestamp' | 'requestId'>): RequestOutcome {
  return {
    format: 'openai',
    requestedModel: 'gpt-a',
    requestedProvider: 'openai',
    usedModel: 'gpt-a',
    usedProvider: 'openai',
    needs: { tools: false, json_mode: false, vision: false, streaming: false },
    policy: 'cheapest',
    decision: 'routed',
    attempts: 1,
    trace: [{ provider: 'openai', model: 'gpt-a', outcome: 'ok', status: 200, duration_ms: 100, substitution: null }],
    usage: { input: 100, cached_input: 0, output: 50, origin: 'reported' },
    cost: {
      cost_usd: '0.000100',
      baseline_usd: '0.000100',
      savings_usd: '0.000000',
      origin: 'reported',
      used_price_verified_on: '2026-09-01',
      baseline_price_verified_on: '2026-09-01',
    },
    latencyMs: 100,
    firstByteMs: null,
    status: 'complete',
    selection: null,
    price: null,
    substitution: null,
    ...overrides,
  };
}

async function seed(store: SqliteEventStore, rows: readonly RequestOutcome[]): Promise<void> {
  for (const row of rows) store.record(row);
  await store.flush();
}

describe('summary()', () => {
  test('sums spend and known-baseline savings, excludes unknown baseline from the totals but counts it', async () => {
    const store = openStore();
    try {
      await seed(store, [
        outcome({
          timestamp: '2026-09-19T10:00:00.000Z',
          requestId: 'e1',
          usage: { input: 100, cached_input: 0, output: 50, origin: 'reported' },
          cost: {
            cost_usd: '0.001000',
            baseline_usd: '0.002000',
            savings_usd: '0.001000',
            origin: 'reported',
            used_price_verified_on: '2026-09-01',
            baseline_price_verified_on: '2026-09-01',
          },
        }),
        outcome({
          timestamp: '2026-09-19T11:00:00.000Z',
          requestId: 'e2',
          usage: { input: 10, cached_input: 0, output: 4, origin: 'estimated' },
          cost: {
            cost_usd: '0.000500',
            baseline_usd: 'unknown',
            savings_usd: 'unknown',
            origin: 'estimated',
            used_price_verified_on: '2026-09-19',
            baseline_price_verified_on: 'unknown',
          },
        }),
        outcome({
          timestamp: '2026-09-19T09:00:00.000Z',
          requestId: 'e3',
          decision: 'fail',
          usedModel: null,
          usedProvider: null,
          attempts: 0,
          trace: [],
          usage: null,
          cost: null,
          latencyMs: 3,
          status: 'refused',
        }),
        // Outside the 24 h window ending at now: must not be counted.
        outcome({
          timestamp: '2026-09-17T09:00:00.000Z',
          requestId: 'e4-outside-window',
          cost: {
            cost_usd: '0.009000',
            baseline_usd: '0.009000',
            savings_usd: '0.000000',
            origin: 'reported',
            used_price_verified_on: '2026-09-01',
            baseline_price_verified_on: '2026-09-01',
          },
        }),
      ]);

      const now = () => new Date('2026-09-19T12:00:00.000Z');
      const result = await summary(store, '24h', { now });

      assert.equal(result.requests, 3);
      assert.equal(result.errors, 1);
      assert.equal(result.spend_usd, '0.001500');
      assert.equal(result.baseline_usd, '0.002000');
      assert.equal(result.savings_usd, '0.001000');
      assert.equal(result.savings_percent, 50);
      assert.equal(result.unknown_savings_requests, 1);
      assert.deepEqual(result.origin, { reported: 1, estimated: 1 });
      // e1's prices were checked on 2026-09-01, e2's served price on 2026-09-19; e4 is outside the window.
      assert.deepEqual(result.prices_verified_on, { oldest: '2026-09-01', newest: '2026-09-19' });
    } finally {
      await store.close();
    }
  });

  test('every priced event with an unknown baseline: totals are the string "unknown", never 0', async () => {
    const store = openStore();
    try {
      await seed(store, [
        outcome({
          timestamp: '2026-09-19T10:00:00.000Z',
          requestId: 'u1',
          cost: {
            cost_usd: '0.000300',
            baseline_usd: 'unknown',
            savings_usd: 'unknown',
            origin: 'estimated',
            used_price_verified_on: '2026-09-19',
            baseline_price_verified_on: 'unknown',
          },
        }),
        outcome({
          timestamp: '2026-09-19T10:30:00.000Z',
          requestId: 'u2',
          cost: {
            cost_usd: '0.000200',
            baseline_usd: 'unknown',
            savings_usd: 'unknown',
            origin: 'estimated',
            used_price_verified_on: '2026-09-19',
            baseline_price_verified_on: 'unknown',
          },
        }),
      ]);

      const result = await summary(store, '1h', { now: () => new Date('2026-09-19T11:00:00.000Z') });
      assert.equal(result.requests, 2);
      assert.equal(result.spend_usd, '0.000500');
      assert.equal(result.baseline_usd, 'unknown');
      assert.equal(result.savings_usd, 'unknown');
      assert.equal(result.savings_percent, null);
      assert.equal(result.unknown_savings_requests, 2);
      // Only the served models' prices exist; the unknown baseline prices add no date.
      assert.deepEqual(result.prices_verified_on, { oldest: '2026-09-19', newest: '2026-09-19' });
    } finally {
      await store.close();
    }
  });

  test('prices_verified_on spans the served and requested price dates of priced events only', async () => {
    const store = openStore();
    try {
      await seed(store, [
        outcome({
          timestamp: '2026-09-19T10:00:00.000Z',
          requestId: 'd1',
          cost: {
            cost_usd: '0.000100',
            baseline_usd: '0.000300',
            savings_usd: '0.000200',
            origin: 'reported',
            used_price_verified_on: '2026-09-10',
            baseline_price_verified_on: '2026-08-30',
          },
        }),
        // Unpriced: served, but its model has no catalog price. It carries no price date.
        outcome({ timestamp: '2026-09-19T10:10:00.000Z', requestId: 'd2', cost: null }),
        // A malformed stored date is ignored rather than shown.
        outcome({
          timestamp: '2026-09-19T10:20:00.000Z',
          requestId: 'd3',
          cost: {
            cost_usd: '0.000100',
            baseline_usd: '0.000100',
            savings_usd: '0.000000',
            origin: 'reported',
            used_price_verified_on: 'yesterday',
            baseline_price_verified_on: '2026-09-12',
          },
        }),
      ]);
      const result = await summary(store, '1h', { now: () => new Date('2026-09-19T10:30:00.000Z') });
      assert.deepEqual(result.prices_verified_on, { oldest: '2026-08-30', newest: '2026-09-12' });
    } finally {
      await store.close();
    }
  });

  test('prices_verified_on is null when no event in the window was priced', async () => {
    const store = openStore();
    try {
      await seed(store, [
        outcome({ timestamp: '2026-09-19T10:00:00.000Z', requestId: 'n1', cost: null }),
        outcome({
          timestamp: '2026-09-19T10:05:00.000Z',
          requestId: 'n2',
          status: 'refused',
          decision: 'fail',
          usedModel: null,
          usedProvider: null,
          attempts: 0,
          trace: [],
          usage: null,
          cost: null,
        }),
      ]);
      const result = await summary(store, '1h', { now: () => new Date('2026-09-19T10:30:00.000Z') });
      assert.equal(result.requests, 2);
      assert.equal(result.prices_verified_on, null);
      const empty = await summary(store, '1h', { now: () => new Date('2026-09-20T10:30:00.000Z') });
      assert.equal(empty.requests, 0);
      assert.equal(empty.prices_verified_on, null);
    } finally {
      await store.close();
    }
  });
});

describe('timeseries()', () => {
  test('buckets requests, errors, spend and savings into fixed, epoch-aligned windows', async () => {
    const store = openStore();
    try {
      await seed(store, [
        outcome({
          timestamp: '2026-09-19T01:07:00.000Z',
          requestId: 't1',
          cost: {
            cost_usd: '0.000100',
            baseline_usd: '0.000150',
            savings_usd: '0.000050',
            origin: 'reported',
            used_price_verified_on: '2026-09-01',
            baseline_price_verified_on: '2026-09-01',
          },
        }),
        outcome({
          timestamp: '2026-09-19T01:07:30.000Z',
          requestId: 't2',
          status: 'provider_error',
          usedModel: null,
          usedProvider: null,
          usage: null,
          cost: null,
        }),
        outcome({
          timestamp: '2026-09-19T01:42:00.000Z',
          requestId: 't3',
          cost: {
            cost_usd: '0.000200',
            baseline_usd: 'unknown',
            savings_usd: 'unknown',
            origin: 'estimated',
            used_price_verified_on: '2026-09-19',
            baseline_price_verified_on: 'unknown',
          },
        }),
      ]);

      const buckets = await timeseries(store, '1h', '5m', { now: () => new Date('2026-09-19T02:00:00.000Z') });
      assert.equal(buckets.length, 12);

      const bucket0105 = buckets.find((b) => b.bucket_start === '2026-09-19T01:05:00.000Z');
      assert.ok(bucket0105);
      assert.equal(bucket0105?.requests, 2);
      assert.equal(bucket0105?.errors, 1);
      assert.equal(bucket0105?.spend_usd, '0.000100');
      assert.equal(bucket0105?.savings_usd, '0.000050');
      assert.equal(bucket0105?.unknown_savings_requests, 0);

      const bucket0140 = buckets.find((b) => b.bucket_start === '2026-09-19T01:40:00.000Z');
      assert.ok(bucket0140);
      assert.equal(bucket0140?.requests, 1);
      assert.equal(bucket0140?.spend_usd, '0.000200');
      assert.equal(bucket0140?.savings_usd, 'unknown');
      assert.equal(bucket0140?.unknown_savings_requests, 1);

      const emptyBucket = buckets.find((b) => b.bucket_start === '2026-09-19T01:20:00.000Z');
      assert.deepEqual(emptyBucket, {
        bucket_start: '2026-09-19T01:20:00.000Z',
        requests: 0,
        errors: 0,
        spend_usd: '0.000000',
        unpriced_requests: 0,
        savings_usd: '0.000000',
        unknown_savings_requests: 0,
      });
    } finally {
      await store.close();
    }
  });
});

describe('breakdown()', () => {
  test('groups by provider with spend and correct latency percentiles, leaving refused requests unrouted', async () => {
    const store = openStore();
    try {
      await seed(store, [
        outcome({
          timestamp: '2026-09-19T10:00:00.000Z',
          requestId: 'b1',
          usedProvider: 'openrouter',
          usedModel: 'model-a',
          latencyMs: 100,
          cost: {
            cost_usd: '0.002000',
            baseline_usd: '0.002000',
            savings_usd: '0.000000',
            origin: 'reported',
            used_price_verified_on: '2026-09-01',
            baseline_price_verified_on: '2026-09-01',
          },
        }),
        outcome({
          timestamp: '2026-09-19T10:05:00.000Z',
          requestId: 'b2',
          usedProvider: 'openrouter',
          usedModel: 'model-a',
          latencyMs: 300,
          cost: {
            cost_usd: '0.001000',
            baseline_usd: '0.001000',
            savings_usd: '0.000000',
            origin: 'reported',
            used_price_verified_on: '2026-09-01',
            baseline_price_verified_on: '2026-09-01',
          },
        }),
        outcome({
          timestamp: '2026-09-19T10:10:00.000Z',
          requestId: 'b3',
          usedProvider: 'deepseek',
          usedModel: 'model-b',
          latencyMs: 50,
          cost: {
            cost_usd: '0.005000',
            baseline_usd: '0.005000',
            savings_usd: '0.000000',
            origin: 'reported',
            used_price_verified_on: '2026-09-01',
            baseline_price_verified_on: '2026-09-01',
          },
        }),
        outcome({
          timestamp: '2026-09-19T10:15:00.000Z',
          requestId: 'b4-refused',
          decision: 'fail',
          usedModel: null,
          usedProvider: null,
          attempts: 0,
          trace: [],
          usage: null,
          cost: null,
          latencyMs: 2,
          status: 'refused',
        }),
      ]);

      const result = await breakdown(store, '24h', 'provider', { now: () => new Date('2026-09-19T12:00:00.000Z') });
      assert.equal(result.unrouted_requests, 1);
      assert.deepEqual(
        result.groups.map((g) => g.key),
        ['deepseek', 'openrouter'],
      );
      const deepseek = result.groups[0];
      assert.equal(deepseek?.requests, 1);
      assert.equal(deepseek?.spend_usd, '0.005000');
      assert.equal(deepseek?.latency_p50_ms, 50);
      assert.equal(deepseek?.latency_p95_ms, 50);
      const openrouter = result.groups[1];
      assert.equal(openrouter?.requests, 2);
      assert.equal(openrouter?.spend_usd, '0.003000');
      assert.equal(openrouter?.latency_p50_ms, 100);
      assert.equal(openrouter?.latency_p95_ms, 300);

      const byModel = await breakdown(store, '24h', 'model', { now: () => new Date('2026-09-19T12:00:00.000Z') });
      assert.deepEqual(byModel.groups.map((g) => g.key).sort(), ['model-a', 'model-b']);
    } finally {
      await store.close();
    }
  });
});

describe('recent()', () => {
  test('newest first, with route, a derived reason and the full trace', async () => {
    const store = openStore();
    try {
      await seed(store, [
        outcome({
          timestamp: '2026-09-19T10:00:00.000Z',
          requestId: 'r1-routed-clean',
          policy: 'cheapest',
          trace: [
            { provider: 'openai', model: 'gpt-a', outcome: 'ok', status: 200, duration_ms: 80, substitution: null },
          ],
        }),
        outcome({
          timestamp: '2026-09-19T10:05:00.000Z',
          requestId: 'r2-routed-after-failure',
          policy: 'fastest',
          attempts: 2,
          trace: [
            {
              provider: 'deepseek',
              model: 'deepseek-v4',
              outcome: 'timeout',
              status: null,
              duration_ms: 5000,
              substitution: null,
            },
            { provider: 'openai', model: 'gpt-a', outcome: 'ok', status: 200, duration_ms: 90, substitution: null },
          ],
        }),
        outcome({
          timestamp: '2026-09-19T10:10:00.000Z',
          requestId: 'r3-passthrough',
          decision: 'passthrough',
        }),
        outcome({
          timestamp: '2026-09-19T10:15:00.000Z',
          requestId: 'r4-refused',
          decision: 'fail',
          usedModel: null,
          usedProvider: null,
          attempts: 0,
          trace: [],
          usage: null,
          cost: null,
          latencyMs: 3,
          status: 'refused',
        }),
      ]);

      const page = await recent(store, { limit: 10 });
      assert.deepEqual(
        page.entries.map((e) => e.requestId),
        ['r4-refused', 'r3-passthrough', 'r2-routed-after-failure', 'r1-routed-clean'],
      );
      assert.equal(page.nextCursor, null);

      const clean = page.entries[3];
      assert.equal(clean?.reason, 'routed by the cheapest policy');
      assert.deepEqual(clean?.route, {
        format: 'openai',
        requestedModel: 'gpt-a',
        requestedProvider: 'openai',
        usedModel: 'gpt-a',
        usedProvider: 'openai',
        policy: 'cheapest',
        decision: 'routed',
      });

      const afterFailure = page.entries[2];
      assert.equal(afterFailure?.reason, 'routed by the fastest policy after deepseek deepseek-v4 (timeout) failed');

      const passthrough = page.entries[1];
      assert.equal(passthrough?.reason, 'no eligible candidate; passed through to the requested model');

      const refused = page.entries[0];
      assert.equal(refused?.reason, 'refused: no configured provider could satisfy the requested capabilities');
      assert.equal(refused?.cost_usd, null);
      assert.equal(refused?.savings_usd, null);
    } finally {
      await store.close();
    }
  });

  test('pages backwards through before, and clamps the limit to [1, MAX_RECENT_LIMIT]', async () => {
    const store = openStore();
    try {
      const rows: RequestOutcome[] = [];
      for (let i = 0; i < 5; i += 1) {
        rows.push(
          outcome({
            timestamp: new Date(Date.UTC(2026, 8, 19, 10, i)).toISOString(),
            requestId: `p${i}`,
          }),
        );
      }
      await seed(store, rows);

      const page1 = await recent(store, { limit: 2 });
      assert.deepEqual(
        page1.entries.map((e) => e.requestId),
        ['p4', 'p3'],
      );
      assert.ok(page1.nextCursor);

      const page2 = await recent(store, { limit: 2, before: page1.nextCursor ?? undefined });
      assert.deepEqual(
        page2.entries.map((e) => e.requestId),
        ['p2', 'p1'],
      );
      assert.ok(page2.nextCursor);

      const page3 = await recent(store, { limit: 2, before: page2.nextCursor ?? undefined });
      assert.deepEqual(
        page3.entries.map((e) => e.requestId),
        ['p0'],
      );
      assert.equal(page3.nextCursor, null);

      const manyRows: RequestOutcome[] = [];
      for (let i = 0; i < MAX_RECENT_LIMIT + 5; i += 1) {
        manyRows.push(
          outcome({
            timestamp: new Date(Date.UTC(2026, 8, 20, 0, 0, 0, i)).toISOString(),
            requestId: `many-${i}`,
          }),
        );
      }
      const bigStore = openStore();
      try {
        await seed(bigStore, manyRows);
        const clampedHigh = await recent(bigStore, { limit: 100_000 });
        assert.equal(clampedHigh.entries.length, MAX_RECENT_LIMIT);
        const clampedLow = await recent(bigStore, { limit: 0 });
        assert.equal(clampedLow.entries.length, 1);
        const defaulted = await recent(bigStore, {});
        assert.equal(defaulted.entries.length, DEFAULT_RECENT_LIMIT);
      } finally {
        await bigStore.close();
      }
    } finally {
      await store.close();
    }
  });
});

describe('toRecentEntry()', () => {
  const sampleSelection: OutcomeSelection = {
    considered: 2,
    candidates: [
      { provider: 'openai', model: 'gpt-a', input: 5, output: 25 },
      { provider: 'deepseek', model: 'deepseek-v4', input: 1, output: 2 },
    ],
    excluded: [{ provider: 'ollama', model: 'llama3.2:latest', reason: 'missing_capability:tools' }],
  };
  const samplePrice: OutcomePrices = {
    used: { input: 5, output: 25, verified_on: '2026-09-01', source_url: 'https://example.com/openai-pricing' },
    requested: { input: 5, output: 25, verified_on: '2026-09-01', source_url: 'https://example.com/openai-pricing' },
  };

  test('routed: carries latency, first-byte, reported origin, baseline, usage, needs, price and selection', () => {
    const event = outcome({
      timestamp: '2026-09-19T10:00:00.000Z',
      requestId: 'n1-routed',
      latencyMs: 240,
      firstByteMs: 42,
      needs: { tools: true, json_mode: false, vision: false, streaming: true },
      selection: sampleSelection,
      price: samplePrice,
    });
    const entry = toRecentEntry(event);
    assert.equal(entry.latency_ms, 240);
    assert.equal(entry.first_byte_ms, 42);
    assert.equal(entry.origin, 'reported');
    assert.equal(entry.baseline_usd, '0.000100');
    assert.deepEqual(entry.usage, { input: 100, output: 50 });
    assert.deepEqual(entry.needs, { tools: true, json_mode: false, vision: false, streaming: true });
    assert.deepEqual(entry.price, samplePrice);
    assert.deepEqual(entry.selection, sampleSelection);
  });

  test('fallback (after a failed attempt): a null cost falls the origin back to the usage origin, and baseline is null', () => {
    const event = outcome({
      timestamp: '2026-09-19T10:05:00.000Z',
      requestId: 'n2-fallback',
      policy: 'fastest',
      attempts: 2,
      trace: [
        {
          provider: 'deepseek',
          model: 'deepseek-v4',
          outcome: 'timeout',
          status: null,
          duration_ms: 5000,
          substitution: null,
        },
        { provider: 'openai', model: 'gpt-a', outcome: 'ok', status: 200, duration_ms: 90, substitution: null },
      ],
      usage: { input: 40, cached_input: 0, output: 10, origin: 'estimated' },
      cost: null,
      firstByteMs: null,
    });
    const entry = toRecentEntry(event);
    assert.equal(entry.origin, 'estimated');
    assert.equal(entry.baseline_usd, null);
    assert.deepEqual(entry.usage, { input: 40, output: 10 });
    assert.equal(entry.first_byte_ms, null);
  });

  test('passthrough: an unlisted target has no usage, cost, baseline or origin, but keeps selection and price shells', () => {
    const passthroughSelection: OutcomeSelection = {
      considered: 1,
      candidates: [{ provider: 'openai', model: 'unlisted', input: null, output: null }],
      excluded: [],
    };
    const passthroughPrice: OutcomePrices = { used: null, requested: null };
    const event = outcome({
      timestamp: '2026-09-19T10:10:00.000Z',
      requestId: 'n3-passthrough',
      decision: 'passthrough',
      requestedModel: 'unlisted',
      usedModel: 'unlisted',
      usage: null,
      cost: null,
      selection: passthroughSelection,
      price: passthroughPrice,
    });
    const entry = toRecentEntry(event);
    assert.equal(entry.origin, null);
    assert.equal(entry.baseline_usd, null);
    assert.equal(entry.usage, null);
    assert.deepEqual(entry.selection, passthroughSelection);
    assert.deepEqual(entry.price, passthroughPrice);
  });

  test('refused: no attempt was made, so latency and needs are the only non-null fields besides selection/price', () => {
    const refusedSelection: OutcomeSelection = { considered: 3, candidates: [], excluded: [] };
    const refusedPrice: OutcomePrices = {
      used: null,
      requested: { input: 5, output: 25, verified_on: '2026-09-01', source_url: 'https://example.com/openai-pricing' },
    };
    const event = outcome({
      timestamp: '2026-09-19T10:15:00.000Z',
      requestId: 'n4-refused',
      decision: 'fail',
      usedModel: null,
      usedProvider: null,
      attempts: 0,
      trace: [],
      usage: null,
      cost: null,
      latencyMs: 3,
      firstByteMs: null,
      status: 'refused',
      selection: refusedSelection,
      price: refusedPrice,
    });
    const entry = toRecentEntry(event);
    assert.equal(entry.latency_ms, 3);
    assert.equal(entry.first_byte_ms, null);
    assert.equal(entry.origin, null);
    assert.equal(entry.baseline_usd, null);
    assert.equal(entry.usage, null);
    assert.deepEqual(entry.needs, event.needs);
    assert.deepEqual(entry.selection, refusedSelection);
    assert.deepEqual(entry.price, refusedPrice);
  });

  test('a substituted request reads like its stored row: the substitution is on the entry, not on its trace', () => {
    const substitution = { requested_model: 'gpt-a', served_model: 'deepseek-v4', group: 'frontier' };
    const event = outcome({
      timestamp: '2026-09-19T10:17:00.000Z',
      requestId: 'n4b-substituted',
      usedProvider: 'deepseek',
      usedModel: 'deepseek-v4',
      trace: [
        { provider: 'deepseek', model: 'deepseek-v4', outcome: 'ok', status: 200, duration_ms: 70, substitution },
      ],
      substitution,
    });
    const entry = toRecentEntry(event);
    assert.deepEqual(entry.trace, [
      { provider: 'deepseek', model: 'deepseek-v4', outcome: 'ok', status: 200, duration_ms: 70 },
    ]);
    assert.equal(entry.substituted, true);
    assert.deepEqual(entry.substitution, substitution);
  });

  test('a row stored before schema 2 reads selection and price as null, without losing any other field', () => {
    const event = outcome({
      timestamp: '2026-09-19T10:20:00.000Z',
      requestId: 'n5-pre-schema-2',
      selection: null,
      price: null,
    });
    const entry = toRecentEntry(event);
    assert.equal(entry.selection, null);
    assert.equal(entry.price, null);
    assert.equal(entry.latency_ms, event.latencyMs);
    assert.equal(entry.origin, 'reported');
    assert.equal(entry.baseline_usd, '0.000100');
    assert.deepEqual(entry.usage, { input: 100, output: 50 });
  });
});

/** A request served by a model with no catalog price: usage is known, cost is not. */
function unpricedOutcome(
  overrides: Partial<RequestOutcome> & Pick<RequestOutcome, 'timestamp' | 'requestId'>,
): RequestOutcome {
  return outcome({
    requestedModel: 'unlisted',
    usedModel: 'unlisted',
    decision: 'passthrough',
    trace: [
      { provider: 'openai', model: 'unlisted', outcome: 'ok', status: 200, duration_ms: 100, substitution: null },
    ],
    usage: { input: 120, cached_input: 0, output: 30, origin: 'reported' },
    cost: null,
    ...overrides,
  });
}

describe('served requests with no price', () => {
  const now = () => new Date('2026-09-19T12:00:00.000Z');

  test('summary: only unpriced requests make spend, baseline and savings "unknown", and every one is counted', async () => {
    const store = openStore();
    try {
      await seed(store, [
        unpricedOutcome({ timestamp: '2026-09-19T11:00:00.000Z', requestId: 'n1' }),
        unpricedOutcome({ timestamp: '2026-09-19T11:01:00.000Z', requestId: 'n2' }),
        // Completed with neither reported usage nor a catalog entry to estimate from: still served, still unpriced.
        unpricedOutcome({ timestamp: '2026-09-19T11:02:00.000Z', requestId: 'n3', usage: null }),
      ]);

      const result = await summary(store, '1h', { now });
      assert.deepEqual(result, {
        requests: 3,
        errors: 0,
        spend_usd: 'unknown',
        unpriced_requests: 3,
        baseline_usd: 'unknown',
        savings_usd: 'unknown',
        savings_percent: null,
        unknown_savings_requests: 3,
        origin: { reported: 2, estimated: 0 },
        prices_verified_on: null,
        substituted_requests: 0,
      });
    } finally {
      await store.close();
    }
  });

  test('summary: priced and unpriced mixed, spend sums the priced rows and reports the unpriced count', async () => {
    const store = openStore();
    try {
      await seed(store, [
        outcome({
          timestamp: '2026-09-19T11:00:00.000Z',
          requestId: 'm1',
          cost: {
            cost_usd: '0.000400',
            baseline_usd: '0.001000',
            savings_usd: '0.000600',
            origin: 'reported',
            used_price_verified_on: '2026-09-01',
            baseline_price_verified_on: '2026-09-01',
          },
        }),
        outcome({
          timestamp: '2026-09-19T11:10:00.000Z',
          requestId: 'm2-unknown-baseline',
          cost: {
            cost_usd: '0.000100',
            baseline_usd: 'unknown',
            savings_usd: 'unknown',
            origin: 'reported',
            used_price_verified_on: '2026-09-01',
            baseline_price_verified_on: 'unknown',
          },
        }),
        unpricedOutcome({ timestamp: '2026-09-19T11:20:00.000Z', requestId: 'm3-unpriced' }),
        // Interrupted before any usage was known: unbilled, in no money count.
        outcome({
          timestamp: '2026-09-19T11:30:00.000Z',
          requestId: 'm4-interrupted',
          usage: null,
          cost: null,
          status: 'interrupted',
        }),
      ]);

      const result = await summary(store, '1h', { now });
      assert.equal(result.requests, 4);
      assert.equal(result.errors, 1);
      assert.equal(result.spend_usd, '0.000500');
      assert.equal(result.unpriced_requests, 1);
      assert.equal(result.baseline_usd, '0.001000');
      assert.equal(result.savings_usd, '0.000600');
      assert.equal(result.savings_percent, 60);
      assert.equal(result.unknown_savings_requests, 2);
    } finally {
      await store.close();
    }
  });

  test('timeseries: a bucket of unpriced requests reports spend "unknown" and its count, never 0', async () => {
    const store = openStore();
    try {
      await seed(store, [
        unpricedOutcome({ timestamp: '2026-09-19T11:05:00.000Z', requestId: 's1' }),
        unpricedOutcome({ timestamp: '2026-09-19T11:06:00.000Z', requestId: 's2' }),
        outcome({ timestamp: '2026-09-19T11:40:00.000Z', requestId: 's3' }),
        unpricedOutcome({ timestamp: '2026-09-19T11:41:00.000Z', requestId: 's4' }),
      ]);

      const buckets = await timeseries(store, '1h', '5m', { now });
      assert.deepEqual(
        buckets.find((b) => b.bucket_start === '2026-09-19T11:05:00.000Z'),
        {
          bucket_start: '2026-09-19T11:05:00.000Z',
          requests: 2,
          errors: 0,
          spend_usd: 'unknown',
          unpriced_requests: 2,
          savings_usd: 'unknown',
          unknown_savings_requests: 2,
        },
      );
      assert.deepEqual(
        buckets.find((b) => b.bucket_start === '2026-09-19T11:40:00.000Z'),
        {
          bucket_start: '2026-09-19T11:40:00.000Z',
          requests: 2,
          errors: 0,
          spend_usd: '0.000100',
          unpriced_requests: 1,
          savings_usd: '0.000000',
          unknown_savings_requests: 1,
        },
      );
    } finally {
      await store.close();
    }
  });

  test('breakdown: a group of unpriced requests has spend "unknown", its count, and sorts after known spend', async () => {
    const store = openStore();
    try {
      await seed(store, [
        unpricedOutcome({ timestamp: '2026-09-19T11:00:00.000Z', requestId: 'g1', usedProvider: 'openai' }),
        unpricedOutcome({ timestamp: '2026-09-19T11:01:00.000Z', requestId: 'g2', usedProvider: 'openai' }),
        unpricedOutcome({ timestamp: '2026-09-19T11:02:00.000Z', requestId: 'g3', usedProvider: 'openai' }),
        outcome({
          timestamp: '2026-09-19T11:03:00.000Z',
          requestId: 'g4',
          usedProvider: 'deepseek',
          usedModel: 'cheap',
        }),
        unpricedOutcome({
          timestamp: '2026-09-19T11:04:00.000Z',
          requestId: 'g5',
          usedProvider: 'deepseek',
          usedModel: 'cheap-unlisted',
        }),
      ]);

      const byModel = await breakdown(store, '1h', 'model', { now });
      assert.deepEqual(
        byModel.groups.map((g) => [g.key, g.requests, g.spend_usd, g.unpriced_requests]),
        [
          ['cheap', 1, '0.000100', 0],
          ['cheap-unlisted', 1, 'unknown', 1],
          ['unlisted', 3, 'unknown', 3],
        ],
      );

      const byProvider = await breakdown(store, '1h', 'provider', { now });
      assert.deepEqual(
        byProvider.groups.map((g) => [g.key, g.requests, g.spend_usd, g.unpriced_requests]),
        [
          ['deepseek', 2, '0.000100', 1],
          ['openai', 3, 'unknown', 3],
        ],
      );
    } finally {
      await store.close();
    }
  });

  test('a stored amount that is not a 6-place decimal leaves that row unpriced instead of failing the query', async () => {
    const store = openStore();
    try {
      await seed(store, [
        outcome({ timestamp: '2026-09-19T11:00:00.000Z', requestId: 'f1' }),
        outcome({
          timestamp: '2026-09-19T11:01:00.000Z',
          requestId: 'f2-seven-places',
          cost: {
            cost_usd: '0.0000144',
            baseline_usd: '0.000200',
            savings_usd: '0.000100',
            origin: 'reported',
            used_price_verified_on: '2026-09-01',
            baseline_price_verified_on: '2026-09-01',
          },
        }),
      ]);

      const result = await summary(store, '1h', { now });
      assert.equal(result.requests, 2);
      assert.equal(result.spend_usd, '0.000100');
      assert.equal(result.unpriced_requests, 1);
      assert.equal(result.baseline_usd, '0.000100');
      assert.equal(result.unknown_savings_requests, 1);
    } finally {
      await store.close();
    }
  });

  test('an empty window is zero spend and zero savings, not "unknown": nothing was left out', async () => {
    const store = openStore();
    try {
      const result = await summary(store, '1h', { now });
      assert.equal(result.requests, 0);
      assert.equal(result.spend_usd, '0.000000');
      assert.equal(result.savings_usd, '0.000000');
      assert.equal(result.savings_percent, null);
      assert.equal(result.unpriced_requests, 0);
      assert.equal(result.unknown_savings_requests, 0);
    } finally {
      await store.close();
    }
  });
});

describe('timeseries() bucket cap', () => {
  test('refuses a range and bucket pair finer than MAX_TIMESERIES_BUCKETS, accepts 24h by the minute', async () => {
    const store = openStore();
    try {
      const now = () => new Date('2026-09-19T12:00:00.000Z');
      await assert.rejects(timeseries(store, '30d', '1m', { now }), MetricsQueryError);
      const byMinute = await timeseries(store, '24h', '1m', { now });
      assert.equal(byMinute.length, 1440);
      assert.ok(byMinute.length <= MAX_TIMESERIES_BUCKETS);
    } finally {
      await store.close();
    }
  });
});

describe('recent() cursor', () => {
  test('events sharing one millisecond across page boundaries are each returned exactly once', async () => {
    const store = openStore();
    try {
      const rows: RequestOutcome[] = [outcome({ timestamp: '2026-09-19T09:59:59.999Z', requestId: 'older' })];
      for (let i = 0; i < 5; i += 1) {
        rows.push(outcome({ timestamp: '2026-09-19T10:00:00.000Z', requestId: `same-ms-${i}` }));
      }
      rows.push(outcome({ timestamp: '2026-09-19T10:00:00.001Z', requestId: 'newer' }));
      await seed(store, rows);

      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await recent(store, { limit: 2, ...(cursor === undefined ? {} : { before: cursor }) });
        seen.push(...page.entries.map((e) => e.requestId));
        cursor = page.nextCursor ?? undefined;
        pages += 1;
      } while (cursor !== undefined && pages < 10);

      assert.deepEqual(seen, ['newer', 'same-ms-4', 'same-ms-3', 'same-ms-2', 'same-ms-1', 'same-ms-0', 'older']);
      assert.equal(pages, 4);
    } finally {
      await store.close();
    }
  });

  test('a full last page has no next cursor, so there is never an empty trailing page', async () => {
    const store = openStore();
    try {
      await seed(store, [
        outcome({ timestamp: '2026-09-19T10:00:00.000Z', requestId: 'a' }),
        outcome({ timestamp: '2026-09-19T10:01:00.000Z', requestId: 'b' }),
      ]);
      const page = await recent(store, { limit: 2 });
      assert.deepEqual(
        page.entries.map((e) => e.requestId),
        ['b', 'a'],
      );
      assert.equal(page.nextCursor, null);
    } finally {
      await store.close();
    }
  });

  test('rejects a malformed cursor with MetricsQueryError', async () => {
    const store = openStore();
    try {
      for (const bad of ['', 'abc', '2026-09-19T10:00:00.000Z', '1-2-3', '-1-2', '99999999999999999-1']) {
        await assert.rejects(recent(store, { before: bad }), MetricsQueryError, `cursor ${JSON.stringify(bad)}`);
      }
    } finally {
      await store.close();
    }
  });

  test('a fractional limit is truncated and a non-finite one falls back to the default', async () => {
    const store = openStore();
    try {
      const rows: RequestOutcome[] = [];
      for (let i = 0; i < DEFAULT_RECENT_LIMIT + 5; i += 1) {
        rows.push(outcome({ timestamp: new Date(Date.UTC(2026, 8, 19, 10, 0, i)).toISOString(), requestId: `l${i}` }));
      }
      await seed(store, rows);
      assert.equal((await recent(store, { limit: 2.5 })).entries.length, 2);
      assert.equal((await recent(store, { limit: 0.4 })).entries.length, 1);
      assert.equal((await recent(store, { limit: Number.NaN })).entries.length, DEFAULT_RECENT_LIMIT);
      assert.equal((await recent(store, { limit: Number.POSITIVE_INFINITY })).entries.length, DEFAULT_RECENT_LIMIT);
    } finally {
      await store.close();
    }
  });
});

describe('SqliteEventStore.readRecentEvents()', () => {
  test('orders newest first with insertion order breaking timestamp ties, and rejects a non-integer limit', async () => {
    const store = openStore();
    try {
      await seed(store, [
        outcome({ timestamp: '2026-09-19T10:00:00.000Z', requestId: 'x1' }),
        outcome({ timestamp: '2026-09-19T10:00:00.000Z', requestId: 'x2' }),
        outcome({ timestamp: '2026-09-19T09:00:00.000Z', requestId: 'x0' }),
      ]);
      const first = await store.readRecentEvents({ limit: 1 });
      assert.deepEqual(
        first.events.map((e) => e.requestId),
        ['x2'],
      );
      assert.ok(first.nextCursor);
      assert.equal(first.nextCursor.timestampMs, Date.parse('2026-09-19T10:00:00.000Z'));
      const rest = await store.readRecentEvents({ limit: 5, before: first.nextCursor });
      assert.deepEqual(
        rest.events.map((e) => e.requestId),
        ['x1', 'x0'],
      );
      assert.equal(rest.nextCursor, null);
      await assert.rejects(store.readRecentEvents({ limit: 2.5 }), RangeError);
      await assert.rejects(store.readRecentEvents({ limit: 0 }), RangeError);
    } finally {
      await store.close();
    }
  });
});
