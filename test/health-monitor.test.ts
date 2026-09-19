import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Environment } from '../src/config/load.ts';
import type { ProviderId } from '../src/config/schema.ts';
import { createHealthMonitor, type HealthChecker, percentile } from '../src/health/monitor.ts';
import { createLogger } from '../src/log/logger.ts';
import { mapProviderError } from '../src/providers/errors.ts';
import type { ProviderAdapter } from '../src/providers/types.ts';
import { type MockProvider, type StartMockProviderOptions, startMockProvider } from './fixtures/mock-provider.ts';

const env: Environment = {};

/**
 * A minimal OpenAI-shaped adapter whose target URL lives in a mutable box, so a "recovery" test can
 * repoint the same adapter id at a different mock server between two checks without rebuilding it.
 */
function testAdapter(id: ProviderId, urlBox: { url: string }, configured = true): ProviderAdapter {
  return {
    id,
    wireFormat: 'openai',
    get baseUrl() {
      return urlBox.url;
    },
    chatPath: '/v1/chat/completions',
    healthRequest: { method: 'GET', path: '/v1/models' },
    isConfigured: () => configured,
    authHeaders: () => ({}),
    url: (path: string) => `${urlBox.url}${path}`,
    mapError: mapProviderError,
  };
}

async function withMock<T>(opts: StartMockProviderOptions, run: (mock: MockProvider) => Promise<T>): Promise<T> {
  const mock = await startMockProvider(opts);
  try {
    return await run(mock);
  } finally {
    await mock.close();
  }
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// --------------------------------------------------------------------------------
// Core state transitions, against the real mock provider
// --------------------------------------------------------------------------------

test('a healthy provider is reported up, with a latency sample', async () => {
  await withMock({}, async (mock) => {
    const adapter = testAdapter('openai', { url: mock.url });
    const monitor = createHealthMonitor({ adapters: [adapter], env });
    await monitor.checkNow('openai');
    const snap = monitor.snapshot().providers.find((p) => p.id === 'openai');
    assert.equal(snap?.state, 'up');
    assert.equal(snap?.lastErrorKind, null);
    assert.equal(snap?.sampleCount, 1);
    assert.notEqual(snap?.lastCheckedAt, null);
    assert.equal(mock.requests.length, 1);
    assert.equal(mock.requests[0]?.path, '/v1/models');
  });
});

test('a provider answering 500 is reported down, with the mapped error kind', async () => {
  await withMock({ failWith: { status: 500, message: 'boom' } }, async (mock) => {
    const adapter = testAdapter('openai', { url: mock.url });
    const monitor = createHealthMonitor({ adapters: [adapter], env });
    await monitor.checkNow('openai');
    const snap = monitor.snapshot().providers[0];
    assert.equal(snap?.state, 'down');
    assert.equal(snap?.lastErrorKind, 'server');
    assert.equal(snap?.sampleCount, 1, 'a real HTTP answer still carries a latency sample');
  });
});

test('a provider that never answers times out and is reported down, with no latency sample', async () => {
  await withMock({ hang: true }, async (mock) => {
    const adapter = testAdapter('openai', { url: mock.url });
    const monitor = createHealthMonitor({ adapters: [adapter], env, timeoutMs: 150 });
    await monitor.checkNow('openai');
    const snap = monitor.snapshot().providers[0];
    assert.equal(snap?.state, 'down');
    assert.equal(snap?.lastErrorKind, 'timeout');
    assert.equal(snap?.sampleCount, 0, 'a timeout carries no real latency to sample');
  });
});

test('a provider recovers from down to up on the next check', async () => {
  await withMock({ failWith: { status: 503, message: 'busy' } }, async (down) => {
    await withMock({}, async (up) => {
      const urlBox = { url: down.url };
      const adapter = testAdapter('openai', urlBox);
      const monitor = createHealthMonitor({ adapters: [adapter], env });

      await monitor.checkNow('openai');
      const downSnap = monitor.snapshot().providers[0];
      assert.equal(downSnap?.state, 'down');
      assert.equal(downSnap?.lastErrorKind, 'overloaded');

      urlBox.url = up.url;
      await monitor.checkNow('openai');
      const upSnap = monitor.snapshot().providers[0];
      assert.equal(upSnap?.state, 'up');
      assert.equal(upSnap?.lastErrorKind, null, 'the error kind is cleared on recovery');
    });
  });
});

test('two concurrent checkNow calls for the same provider make only one request', async () => {
  await withMock({ latencyMs: 150 }, async (mock) => {
    const adapter = testAdapter('openai', { url: mock.url });
    const monitor = createHealthMonitor({ adapters: [adapter], env });
    await Promise.all([monitor.checkNow('openai'), monitor.checkNow('openai')]);
    assert.equal(mock.requests.length, 1, 'the second call is skipped while one is already in flight');
    assert.equal(monitor.snapshot().providers[0]?.state, 'up');
  });
});

test('a provider without a key is never requested', async () => {
  await withMock({}, async (mock) => {
    const adapter = testAdapter('openai', { url: mock.url }, false);
    const monitor = createHealthMonitor({ adapters: [adapter], env });
    await monitor.checkNow('openai');
    assert.equal(mock.requests.length, 0);
    const snap = monitor.snapshot().providers[0];
    assert.equal(snap?.state, 'down');
    assert.equal(snap?.lastErrorKind, 'auth');
  });
});

test('checkNow on an unmonitored provider id is a no-op', async () => {
  const monitor = createHealthMonitor({ adapters: [], env });
  await monitor.checkNow('openai');
  assert.deepEqual(monitor.snapshot().providers, []);
});

// --------------------------------------------------------------------------------
// Percentile math, on known samples
// --------------------------------------------------------------------------------

test('percentile() is a nearest-rank computation over the sorted window', () => {
  const sorted = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  assert.equal(percentile(sorted, 50), 50);
  assert.equal(percentile(sorted, 95), 100);
  assert.equal(percentile([42], 50), 42);
  assert.equal(percentile([42], 95), 42);
});

test('snapshot p50/p95 reflect samples recorded through recordLatency, not just active checks', () => {
  const adapter = testAdapter('openai', { url: 'http://127.0.0.1:1' });
  const monitor = createHealthMonitor({ adapters: [adapter], env, windowSize: 10 });
  for (const ms of [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]) monitor.recordLatency('openai', ms);
  const snap = monitor.snapshot().providers[0];
  assert.equal(snap?.sampleCount, 10);
  assert.equal(snap?.p50, 50);
  assert.equal(snap?.p95, 100);
  assert.equal(snap?.state, 'unknown', 'recordLatency never changes state');
});

test('the sample window drops the oldest reading once it is full', () => {
  const adapter = testAdapter('openai', { url: 'http://127.0.0.1:1' });
  const monitor = createHealthMonitor({ adapters: [adapter], env, windowSize: 3 });
  for (const ms of [1, 2, 3, 100]) monitor.recordLatency('openai', ms);
  const snap = monitor.snapshot().providers[0];
  assert.equal(snap?.sampleCount, 3);
  assert.equal(snap?.p50, 3, 'the sample "1" fell out of the window');
});

// --------------------------------------------------------------------------------
// Periodic scheduling, with node:test mock timers so the suite never waits real seconds
// --------------------------------------------------------------------------------

test('start() checks immediately, then reschedules on intervalMs + jitter, and stop() cancels it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const stubCheck: HealthChecker = async () => {
    calls += 1;
    return { ok: true, status: 200 };
  };
  const adapter = testAdapter('openai', { url: 'http://127.0.0.1:1' });
  const monitor = createHealthMonitor({
    adapters: [adapter],
    env,
    intervalMs: 1000,
    jitterMs: 100,
    random: () => 0.5, // jitter = floor(0.5 * 100) = 50
    checkProviderHealth: stubCheck,
  });

  monitor.start();
  assert.equal(calls, 1, 'start() checks every monitored provider immediately');
  await flushMicrotasks();

  t.mock.timers.tick(1049);
  await flushMicrotasks();
  assert.equal(calls, 1, 'no recheck before intervalMs + jitter has elapsed');

  t.mock.timers.tick(1);
  await flushMicrotasks();
  assert.equal(calls, 2, 'rechecks once intervalMs + jitter has elapsed');

  monitor.stop();
  await flushMicrotasks();
  t.mock.timers.tick(10_000);
  await flushMicrotasks();
  assert.equal(calls, 2, 'stop() cancels the next scheduled check');
});

/** A checker whose calls stay pending until the test releases them, one at a time, in order. */
function gatedChecker(): { check: HealthChecker; calls: () => number; releaseNext: () => void } {
  const pending: Array<() => void> = [];
  let calls = 0;
  return {
    check: () => {
      calls += 1;
      return new Promise((resolve) => {
        pending.push(() => resolve({ ok: true, status: 200 }));
      });
    },
    calls: () => calls,
    releaseNext: () => {
      const release = pending.shift();
      if (release === undefined) throw new Error('no pending check to release');
      release();
    },
  };
}

test('stop() then start() while a check is in flight keeps exactly one schedule per provider', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const gate = gatedChecker();
  const adapter = testAdapter('openai', { url: 'http://127.0.0.1:1' });
  const monitor = createHealthMonitor({
    adapters: [adapter],
    env,
    intervalMs: 1000,
    jitterMs: 0,
    checkProviderHealth: gate.check,
  });

  monitor.start();
  assert.equal(gate.calls(), 1);
  monitor.stop();
  monitor.start();
  assert.equal(gate.calls(), 1, 'the restart joins the check in flight instead of overlapping it');

  // stop() already aborted that first check: releasing it now still settles the (joined) promise, but
  // the result is dropped rather than applied, since it belongs to a check stop() cancelled.
  gate.releaseNext();
  await flushMicrotasks();
  assert.equal(monitor.snapshot().providers[0]?.state, 'unknown', 'the aborted check does not apply its result');

  t.mock.timers.tick(1000);
  await flushMicrotasks();
  assert.equal(gate.calls(), 2, 'one rescheduled check after one interval, not two');
  gate.releaseNext();
  await flushMicrotasks();
  assert.equal(monitor.snapshot().providers[0]?.state, 'up', 'the next, non-aborted check applies normally');

  t.mock.timers.tick(1000);
  await flushMicrotasks();
  assert.equal(gate.calls(), 3, 'still a single schedule on the next interval');
  gate.releaseNext();
  await flushMicrotasks();

  monitor.stop();
  t.mock.timers.tick(10_000);
  await flushMicrotasks();
  assert.equal(gate.calls(), 3, 'no timer fires after stop()');
});

test('a check in flight at stop() is aborted: its result is dropped and it never reschedules', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const gate = gatedChecker();
  const adapter = testAdapter('openai', { url: 'http://127.0.0.1:1' });
  const monitor = createHealthMonitor({
    adapters: [adapter],
    env,
    intervalMs: 1000,
    jitterMs: 0,
    checkProviderHealth: gate.check,
  });

  monitor.start();
  monitor.stop();
  gate.releaseNext();
  await flushMicrotasks();
  const snap = monitor.snapshot().providers[0];
  assert.equal(snap?.state, 'unknown', 'an aborted check does not change state');
  assert.equal(snap?.lastCheckedAt, null, 'an aborted check does not record a check time');
  assert.equal(snap?.sampleCount, 0, 'an aborted check does not record a latency sample');

  t.mock.timers.tick(10_000);
  await flushMicrotasks();
  assert.equal(gate.calls(), 1, 'nothing is checked after stop()');
});

// --------------------------------------------------------------------------------
// Abort on stop(), against the real mock provider
// --------------------------------------------------------------------------------

test('stop() aborts a check in flight against a hanging provider; it settles within 200 ms', async () => {
  await withMock({ hang: true }, async (mock) => {
    const adapter = testAdapter('openai', { url: mock.url });
    // A timeout far longer than the assertion budget below, so only the abort from stop() -- not the
    // request's own timeout -- can make this check settle in time.
    const monitor = createHealthMonitor({ adapters: [adapter], env, timeoutMs: 30_000 });

    const checkPromise = monitor.checkNow('openai');
    await flushMicrotasks(); // let the request actually reach the hanging mock server first

    const startedStop = performance.now();
    monitor.stop();
    await checkPromise;
    const elapsedMs = performance.now() - startedStop;
    assert.ok(elapsedMs < 200, `in-flight check settled in ${elapsedMs.toFixed(1)} ms, expected under 200 ms`);

    const snap = monitor.snapshot().providers[0];
    assert.equal(snap?.state, 'unknown', 'an aborted check does not change state');
    assert.equal(snap?.lastCheckedAt, null, 'an aborted check does not record a check time');
    assert.equal(snap?.sampleCount, 0, 'an aborted check does not record a latency sample');
  });
});

test('a checker that throws marks the provider down as unknown and logs no exception text', async () => {
  const lines: string[] = [];
  const logger = createLogger({ level: 'debug', sink: { write: (chunk) => lines.push(chunk) } });
  const leaky = 'http://127.0.0.1:1/v1/models?probe=leaky-detail';
  const throwingCheck: HealthChecker = async () => {
    throw new Error(`request failed for ${leaky}`);
  };
  const adapter = testAdapter('openai', { url: 'http://127.0.0.1:1' });
  const monitor = createHealthMonitor({ adapters: [adapter], env, logger, checkProviderHealth: throwingCheck });

  await monitor.checkNow('openai');
  const snap = monitor.snapshot().providers[0];
  assert.equal(snap?.state, 'down');
  assert.equal(snap?.lastErrorKind, 'unknown');
  assert.equal(lines.length, 1, 'one transition line');
  const entry = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
  assert.equal(entry.provider, 'openai');
  assert.equal(entry.to, 'down');
  assert.equal(entry.errorKind, 'unknown');
  assert.ok(!lines.join('').includes('leaky-detail'), 'the exception message never reaches the log');
  assert.ok(!lines.join('').includes('127.0.0.1'), 'no URL reaches the log');
});

test('recordLatency ignores NaN, infinite and negative samples', () => {
  const adapter = testAdapter('openai', { url: 'http://127.0.0.1:1' });
  const monitor = createHealthMonitor({ adapters: [adapter], env });
  for (const ms of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -5, 30, 10, 20])
    monitor.recordLatency('openai', ms);
  const snap = monitor.snapshot().providers[0];
  assert.equal(snap?.sampleCount, 3);
  assert.equal(snap?.p50, 20);
  assert.equal(snap?.p95, 30);
});
