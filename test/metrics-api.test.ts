// The metrics HTTP API (/api/metrics/*, /api/requests) and the live event stream (/api/events), over a
// real Tollwise server, a real SqliteEventStore and a mock provider. Rows are seeded relative to the
// real clock, because the routes read windows ending now.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { type ClientRequest, createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { DEFAULT_RECENT_LIMIT, MAX_RECENT_LIMIT } from '../src/analytics/metrics.ts';
import { openSqliteEventStore, type SqliteEventStore } from '../src/analytics/store.ts';
import type { Catalog, ModelEntry } from '../src/catalog/schema.ts';
import { type Config, type ConfigInput, ConfigSchema } from '../src/config/schema.ts';
import type { HealthMonitor } from '../src/health/monitor.ts';
import { createLogger } from '../src/log/logger.ts';
import { buildRegistry } from '../src/providers/registry.ts';
import { onRequestOutcome, type RequestOutcome, type RequestOutcomeListener } from '../src/proxy/outcome.ts';
import { ACCESS_DENIED_MESSAGE } from '../src/server/access.ts';
import {
  ANALYTICS_DISABLED_MESSAGE,
  BUCKET_TOO_FINE_MESSAGE,
  INVALID_BUCKET_MESSAGE,
  INVALID_CURSOR_MESSAGE,
  INVALID_DIMENSION_MESSAGE,
  INVALID_LIMIT_MESSAGE,
  INVALID_RANGE_MESSAGE,
  unexpectedParameterMessage,
} from '../src/server/api.ts';
import {
  createEventStreamHub,
  DEFAULT_HEALTH_INTERVAL_MS,
  DEFAULT_MAX_EVENT_STREAMS,
  type EventStreamOptions,
  STREAM_LIMIT_MESSAGE,
  STREAMS_CLOSED_MESSAGE,
} from '../src/server/events.ts';
import { MISDIRECTED_MESSAGE, ORIGIN_REFUSED_MESSAGE } from '../src/server/guard.ts';
import { baseUrl, createTollwiseServer, listen, type ServerOptions, stopServer } from '../src/server/server.ts';
import { send, type TestResponse } from './fixtures/http-client.ts';
import { type MockProvider, startMockProvider } from './fixtures/mock-provider.ts';

// Fake credentials with no known key shape; none of them is a real key.
const FAKE_ACCESS_KEY = `fakeAccess${'Mk3'.repeat(8)}`;
const FAKE_OPENAI_KEY = `fakeOpenai${'Mo5'.repeat(6)}`;
const ENV = { OPENAI_API_KEY: FAKE_OPENAI_KEY };

const JSON_TYPE = { 'content-type': 'application/json' } as const;

const workRoot = mkdtempSync(path.join(tmpdir(), 'tollwise-metrics-api-test-'));
after(() => rmSync(workRoot, { recursive: true, force: true }));

let storeCounter = 0;
function openStore(): SqliteEventStore {
  storeCounter += 1;
  return openSqliteEventStore({ file: path.join(workRoot, `case-${storeCounter}.db`), logger: quietLogger() });
}

function quietLogger() {
  return createLogger({ level: 'error', sink: { write: () => true }, env: {} });
}

/** A full RequestOutcome `minutesAgo` minutes before now, overridden per test. */
function outcome(requestId: string, minutesAgo: number, overrides: Partial<RequestOutcome> = {}): RequestOutcome {
  return {
    timestamp: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    requestId,
    format: 'openai',
    requestedModel: 'gpt-x',
    requestedProvider: 'openai',
    usedModel: 'gpt-x',
    usedProvider: 'openai',
    needs: { tools: false, json_mode: false, vision: false, streaming: false },
    policy: 'cheapest',
    decision: 'routed',
    attempts: 1,
    trace: [{ provider: 'openai', model: 'gpt-x', outcome: 'ok', status: 200, duration_ms: 100, substitution: null }],
    usage: { input: 100, cached_input: 0, output: 50, origin: 'reported' },
    cost: {
      cost_usd: '0.001000',
      baseline_usd: '0.003000',
      savings_usd: '0.002000',
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

/** Three events in the last hour (two providers, one error) and one two days ago. */
const SEED: readonly RequestOutcome[] = [
  outcome('r1', 50),
  outcome('r2', 30, {
    usedProvider: 'openrouter',
    usedModel: 'openai/gpt-x',
    latencyMs: 300,
    cost: {
      cost_usd: '0.000500',
      baseline_usd: '0.003000',
      savings_usd: '0.002500',
      origin: 'reported',
      used_price_verified_on: '2026-09-01',
      baseline_price_verified_on: '2026-09-01',
    },
  }),
  outcome('r3', 10, { status: 'provider_error', usage: null, cost: null }),
  outcome('old', 2 * 24 * 60),
];

interface Running {
  readonly url: string;
  readonly server: Server;
  stop(): Promise<void>;
}

async function startServer(options: Partial<ServerOptions> = {}): Promise<Running> {
  const server = createTollwiseServer({ maxBodyBytes: 64 * 1024, logger: quietLogger(), ...options });
  const address = await listen(server, '127.0.0.1', 0);
  return { url: baseUrl('127.0.0.1', address.port), server, stop: () => stopServer(server, 1000) };
}

async function seededServer(options: Partial<ServerOptions> = {}): Promise<Running & { store: SqliteEventStore }> {
  const store = openStore();
  for (const row of SEED) store.record(row);
  await store.flush();
  const running = await startServer({ analytics: store, ...options });
  return {
    ...running,
    store,
    async stop() {
      await running.stop();
      await store.close();
    },
  };
}

function errorOf(response: TestResponse): { message: string; type: string; code: string } {
  return (response.json as { error: { message: string; type: string; code: string } }).error;
}

function assertNoCors(response: { headers: IncomingMessage['headers'] }): void {
  for (const name of Object.keys(response.headers)) {
    assert.ok(!name.startsWith('access-control-'), `no CORS header (${name})`);
  }
}

// ---------------------------------------------------------------- event stream client

interface SseEvent {
  readonly event: string;
  readonly data: unknown;
}

interface SseClient {
  readonly status: number;
  readonly headers: IncomingMessage['headers'];
  readonly events: SseEvent[];
  /** The raw body text received so far. */
  text(): string;
  /** Resolves with the first event (already received or not) that matches. */
  waitFor(predicate: (event: SseEvent) => boolean, timeoutMs?: number): Promise<SseEvent>;
  /** Resolves once the server has ended the response. */
  readonly ended: Promise<void>;
  /** Hangs up from the client side. */
  close(): void;
  readonly request: ClientRequest;
}

function openStream(url: string, headers: Record<string, string> = {}): Promise<SseClient> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: target.hostname, port: target.port, path: '/api/events', method: 'GET', headers },
      (res) => {
        let received = '';
        let pending = '';
        const events: SseEvent[] = [];
        const waiters: { predicate: (event: SseEvent) => boolean; resolve: (event: SseEvent) => void }[] = [];
        let resolveEnded: () => void = () => {};
        const ended = new Promise<void>((done) => {
          resolveEnded = done;
        });
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          received += chunk;
          pending += chunk;
          for (let boundary = pending.indexOf('\n\n'); boundary !== -1; boundary = pending.indexOf('\n\n')) {
            const block = pending.slice(0, boundary);
            pending = pending.slice(boundary + 2);
            const lines = block.split('\n');
            const name = lines.find((line) => line.startsWith('event: '))?.slice(7) ?? 'message';
            const data = lines.find((line) => line.startsWith('data: '))?.slice(6);
            const event = { event: name, data: data === undefined ? undefined : JSON.parse(data) };
            events.push(event);
            for (const waiter of [...waiters]) {
              if (waiter.predicate(event)) {
                waiters.splice(waiters.indexOf(waiter), 1);
                waiter.resolve(event);
              }
            }
          }
        });
        res.on('end', () => resolveEnded());
        res.on('close', () => resolveEnded());
        res.on('error', () => resolveEnded());
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          events,
          text: () => received,
          waitFor(predicate, timeoutMs = 5000) {
            const found = events.find(predicate);
            if (found !== undefined) return Promise.resolve(found);
            return new Promise((done, fail) => {
              const timer = setTimeout(() => fail(new Error('no matching event in time')), timeoutMs);
              waiters.push({
                predicate,
                resolve: (event) => {
                  clearTimeout(timer);
                  done(event);
                },
              });
            });
          },
          ended,
          close: () => request.destroy(),
          request,
        });
      },
    );
    request.on('error', (error: NodeJS.ErrnoException) => {
      // A hang-up this test asked for is not an error.
      if (error.code !== 'ECONNRESET') reject(error);
    });
    request.end();
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await delay(10);
  }
}

/** How many referenced timers the process holds (setTimeout/setInterval). */
function activeTimers(): number {
  return process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;
}

/** An outcome source for the hub that tests control, counting live subscriptions. */
function controlledSource(): {
  subscribe: NonNullable<EventStreamOptions['subscribe']>;
  emit(outcome: RequestOutcome): void;
  readonly listeners: number;
} {
  const listeners = new Set<RequestOutcomeListener>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(value) {
      for (const listener of listeners) listener(value);
    },
    get listeners() {
      return listeners.size;
    },
  };
}

// ---------------------------------------------------------------- metrics routes

describe('GET /api/metrics/summary', () => {
  test('defaults to the last 24 hours and returns the summary of the events in it', async () => {
    const running = await seededServer();
    try {
      const response = await send(running.url, '/api/metrics/summary');
      assert.equal(response.status, 200);
      assert.match(String(response.headers['content-type']), /^application\/json/);
      assert.equal(response.headers['cache-control'], 'no-store');
      assertNoCors(response);
      assert.deepEqual(response.json, {
        range: '24h',
        requests: 3,
        errors: 1,
        spend_usd: '0.001500',
        unpriced_requests: 0,
        baseline_usd: '0.006000',
        savings_usd: '0.004500',
        savings_percent: 75,
        unknown_savings_requests: 0,
        origin: { reported: 2, estimated: 0 },
        prices_verified_on: { oldest: '2026-09-01', newest: '2026-09-01' },
        substituted_requests: 0,
      });
    } finally {
      await running.stop();
    }
  });

  test('range=7d includes the event from two days ago', async () => {
    const running = await seededServer();
    try {
      const response = await send(running.url, '/api/metrics/summary?range=7d');
      assert.equal(response.status, 200);
      const body = response.json as { range: string; requests: number; spend_usd: string };
      assert.equal(body.range, '7d');
      assert.equal(body.requests, 4);
      assert.equal(body.spend_usd, '0.002500');
    } finally {
      await running.stop();
    }
  });
});

describe('GET /api/metrics/timeseries', () => {
  test('range=1h&bucket=5m returns 12 or 13 five-minute buckets that add up to the summary', async () => {
    const running = await seededServer();
    try {
      const response = await send(running.url, '/api/metrics/timeseries?range=1h&bucket=5m');
      assert.equal(response.status, 200);
      assertNoCors(response);
      const body = response.json as {
        range: string;
        bucket: string;
        buckets: { bucket_start: string; requests: number; errors: number; spend_usd: string }[];
      };
      assert.equal(body.range, '1h');
      assert.equal(body.bucket, '5m');
      assert.ok(body.buckets.length === 12 || body.buckets.length === 13, `bucket count ${body.buckets.length}`);
      assert.deepEqual(Object.keys(body.buckets[0] ?? {}), [
        'bucket_start',
        'requests',
        'errors',
        'spend_usd',
        'unpriced_requests',
        'savings_usd',
        'unknown_savings_requests',
      ]);
      for (const bucket of body.buckets) assert.equal(Date.parse(bucket.bucket_start) % (5 * 60_000), 0);
      assert.equal(
        body.buckets.reduce((sum, bucket) => sum + bucket.requests, 0),
        3,
      );
      assert.equal(
        body.buckets.reduce((sum, bucket) => sum + bucket.errors, 0),
        1,
      );
    } finally {
      await running.stop();
    }
  });

  test('without a bucket, 24h is grouped by the hour and 30d by the day', async () => {
    const running = await seededServer();
    try {
      const day = (await send(running.url, '/api/metrics/timeseries')).json as { bucket: string; buckets: unknown[] };
      assert.equal(day.bucket, '1h');
      assert.ok(day.buckets.length === 24 || day.buckets.length === 25);
      const month = (await send(running.url, '/api/metrics/timeseries?range=30d')).json as {
        bucket: string;
        buckets: unknown[];
      };
      assert.equal(month.bucket, '1d');
      assert.ok(month.buckets.length === 30 || month.buckets.length === 31);
    } finally {
      await running.stop();
    }
  });
});

describe('GET /api/metrics/breakdown', () => {
  test('by=provider groups by the provider that served, known spend first', async () => {
    const running = await seededServer();
    try {
      const response = await send(running.url, '/api/metrics/breakdown?range=1h&by=provider');
      assert.equal(response.status, 200);
      assert.deepEqual(response.json, {
        range: '1h',
        by: 'provider',
        groups: [
          {
            key: 'openai',
            requests: 2,
            spend_usd: '0.001000',
            unpriced_requests: 0,
            latency_p50_ms: 100,
            latency_p95_ms: 100,
          },
          {
            key: 'openrouter',
            requests: 1,
            spend_usd: '0.000500',
            unpriced_requests: 0,
            latency_p50_ms: 300,
            latency_p95_ms: 300,
          },
        ],
        unrouted_requests: 0,
      });
    } finally {
      await running.stop();
    }
  });

  test('defaults to by=provider over 24h; by=model groups by the model that served', async () => {
    const running = await seededServer();
    try {
      const byDefault = (await send(running.url, '/api/metrics/breakdown')).json as { range: string; by: string };
      assert.equal(byDefault.range, '24h');
      assert.equal(byDefault.by, 'provider');
      const byModel = (await send(running.url, '/api/metrics/breakdown?by=model')).json as {
        groups: { key: string; requests: number }[];
      };
      assert.deepEqual(
        byModel.groups.map((group) => [group.key, group.requests]),
        [
          ['gpt-x', 2],
          ['openai/gpt-x', 1],
        ],
      );
    } finally {
      await running.stop();
    }
  });
});

describe('GET /api/requests', () => {
  test('returns the newest events first and pages backwards with nextCursor', async () => {
    const running = await seededServer();
    try {
      const first = await send(running.url, '/api/requests?limit=2');
      assert.equal(first.status, 200);
      assertNoCors(first);
      const page = first.json as {
        entries: { requestId: string; status: string; reason: string; cost_usd: string | null; route: unknown }[];
        nextCursor: string | null;
      };
      assert.deepEqual(
        page.entries.map((entry) => entry.requestId),
        ['r3', 'r2'],
      );
      assert.deepEqual(Object.keys(page.entries[0] ?? {}), [
        'requestId',
        'timestamp',
        'status',
        'route',
        'reason',
        'cost_usd',
        'savings_usd',
        'trace',
        'latency_ms',
        'first_byte_ms',
        'origin',
        'baseline_usd',
        'usage',
        'needs',
        'price',
        'selection',
        'substituted',
        'substitution',
      ]);
      assert.equal(page.entries[1]?.reason, 'routed by the cheapest policy');
      assert.equal(page.entries[0]?.cost_usd, null);
      assert.equal(typeof page.nextCursor, 'string');

      // r3 (provider_error, no usage recorded): every new field that needs a price or usage is null.
      const errored = page.entries[0] as unknown as {
        latency_ms: number;
        first_byte_ms: number | null;
        origin: string | null;
        baseline_usd: string | null;
        usage: unknown;
        needs: unknown;
        price: unknown;
        selection: unknown;
      };
      assert.equal(errored.latency_ms, 100);
      assert.equal(errored.first_byte_ms, null);
      assert.equal(errored.origin, null);
      assert.equal(errored.baseline_usd, null);
      assert.equal(errored.usage, null);
      assert.deepEqual(errored.needs, { tools: false, json_mode: false, vision: false, streaming: false });
      assert.equal(errored.price, null);
      assert.equal(errored.selection, null);

      // r2 (routed to openrouter, reported usage and a known baseline): the same fields are populated.
      const routed = page.entries[1] as unknown as {
        latency_ms: number;
        first_byte_ms: number | null;
        origin: string | null;
        baseline_usd: string | null;
        usage: { input: number; output: number };
      };
      assert.equal(routed.latency_ms, 300);
      assert.equal(routed.first_byte_ms, null);
      assert.equal(routed.origin, 'reported');
      assert.equal(routed.baseline_usd, '0.003000');
      assert.deepEqual(routed.usage, { input: 100, output: 50 });

      const second = await send(running.url, `/api/requests?limit=2&before=${page.nextCursor}`);
      const rest = second.json as { entries: { requestId: string }[]; nextCursor: string | null };
      assert.deepEqual(
        rest.entries.map((entry) => entry.requestId),
        ['r1', 'old'],
      );
    } finally {
      await running.stop();
    }
  });

  test(`without a limit returns up to ${DEFAULT_RECENT_LIMIT} events and accepts limit=${MAX_RECENT_LIMIT}`, async () => {
    const running = await seededServer();
    try {
      const all = (await send(running.url, '/api/requests')).json as { entries: unknown[]; nextCursor: unknown };
      assert.equal(all.entries.length, 4);
      assert.equal(all.nextCursor, null);
      assert.equal((await send(running.url, `/api/requests?limit=${MAX_RECENT_LIMIT}`)).status, 200);
    } finally {
      await running.stop();
    }
  });
});

describe('query validation', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['/api/metrics/summary?range=2h', INVALID_RANGE_MESSAGE],
    ['/api/metrics/summary?range=24H', INVALID_RANGE_MESSAGE],
    ['/api/metrics/summary?range=', INVALID_RANGE_MESSAGE],
    ['/api/metrics/summary?range=%3Cscript%3Ealert(1)%3C%2Fscript%3E', INVALID_RANGE_MESSAGE],
    ['/api/metrics/summary?range=1h&range=24h', unexpectedParameterMessage('/api/metrics/summary', ['range'])],
    ['/api/metrics/summary?key=abc', unexpectedParameterMessage('/api/metrics/summary', ['range'])],
    ['/api/metrics/timeseries?bucket=2m', INVALID_BUCKET_MESSAGE],
    ['/api/metrics/timeseries?range=30d&bucket=1m', BUCKET_TOO_FINE_MESSAGE],
    ['/api/metrics/timeseries?range=7d&bucket=5m', BUCKET_TOO_FINE_MESSAGE],
    ['/api/metrics/timeseries?by=model', unexpectedParameterMessage('/api/metrics/timeseries', ['range', 'bucket'])],
    ['/api/metrics/breakdown?by=region', INVALID_DIMENSION_MESSAGE],
    ['/api/metrics/breakdown?by=Provider', INVALID_DIMENSION_MESSAGE],
    ['/api/metrics/breakdown?range=1y', INVALID_RANGE_MESSAGE],
    ['/api/requests?limit=0', INVALID_LIMIT_MESSAGE],
    ['/api/requests?limit=201', INVALID_LIMIT_MESSAGE],
    ['/api/requests?limit=1.5', INVALID_LIMIT_MESSAGE],
    ['/api/requests?limit=-1', INVALID_LIMIT_MESSAGE],
    ['/api/requests?limit=abc', INVALID_LIMIT_MESSAGE],
    ['/api/requests?limit=010', INVALID_LIMIT_MESSAGE],
    ['/api/requests?before=xyz', INVALID_CURSOR_MESSAGE],
    ['/api/requests?before=12345678901234567-1', INVALID_CURSOR_MESSAGE],
    ['/api/requests?before=9999999999999999-1', INVALID_CURSOR_MESSAGE],
    ['/api/requests?range=24h', unexpectedParameterMessage('/api/requests', ['limit', 'before'])],
    ['/api/events?since=0', unexpectedParameterMessage('/api/events', [])],
  ];

  for (const [target, message] of cases) {
    test(`${target} is a 400 with a fixed message`, async () => {
      const running = await seededServer();
      try {
        const response = await send(running.url, target);
        assert.equal(response.status, 400);
        assertNoCors(response);
        assert.deepEqual(errorOf(response), {
          message,
          type: 'invalid_request_error',
          param: null,
          code: 'invalid_query_parameter',
        } as unknown as ReturnType<typeof errorOf>);
        assert.ok(!response.text.includes('script'), 'nothing from the query is echoed');
      } finally {
        await running.stop();
      }
    });
  }

  test('the fixed messages never name a value the client could have sent', () => {
    assert.equal(
      unexpectedParameterMessage('/api/events', []),
      'Unknown or repeated query parameter. /api/events accepts no query parameters.',
    );
    assert.equal(INVALID_RANGE_MESSAGE, 'Invalid range. Use one of: 1h, 24h, 7d, 30d.');
  });
});

describe('analytics off', () => {
  test('the metrics routes answer 503, and a bad query is still a 400', async () => {
    const running = await startServer();
    try {
      for (const target of [
        '/api/metrics/summary',
        '/api/metrics/timeseries',
        '/api/metrics/breakdown',
        '/api/requests',
      ]) {
        const response = await send(running.url, target);
        assert.equal(response.status, 503, target);
        assert.equal(errorOf(response).message, ANALYTICS_DISABLED_MESSAGE);
        assert.equal(errorOf(response).code, 'analytics_disabled');
      }
      assert.equal((await send(running.url, '/api/metrics/summary?range=2h')).status, 400);
      assert.equal((await send(running.url, '/api/metrics/timeseries?range=30d&bucket=1m')).status, 400);
      assert.equal((await send(running.url, '/api/requests?before=xyz')).status, 400);
    } finally {
      await running.stop();
    }
  });
});

describe('access key and request guard', () => {
  const targets = [
    '/api/metrics/summary',
    '/api/metrics/timeseries',
    '/api/metrics/breakdown',
    '/api/requests',
    '/api/events',
  ];

  test('every route needs the access key in a header; a key in the query string is not accepted', async () => {
    const running = await seededServer({ accessKey: FAKE_ACCESS_KEY });
    try {
      for (const target of targets) {
        const refused = await send(running.url, target);
        assert.equal(refused.status, 401, target);
        assert.equal(errorOf(refused).message, ACCESS_DENIED_MESSAGE);
        assertNoCors(refused);
        const inQuery = await send(running.url, `${target}?key=${FAKE_ACCESS_KEY}`);
        assert.equal(inQuery.status, 401, `${target} with the key in the query`);
      }
      for (const target of targets.filter((target) => target !== '/api/events')) {
        const bearer = await send(running.url, target, { headers: { authorization: `Bearer ${FAKE_ACCESS_KEY}` } });
        assert.equal(bearer.status, 200, target);
        const apiKey = await send(running.url, target, { headers: { 'x-api-key': FAKE_ACCESS_KEY } });
        assert.equal(apiKey.status, 200, target);
      }
      const stream = await openStream(running.url, { authorization: `Bearer ${FAKE_ACCESS_KEY}` });
      assert.equal(stream.status, 200);
      stream.close();
    } finally {
      await running.stop();
    }
  });

  test('a foreign Host is 421 and a foreign Origin is 403, before the access key', async () => {
    const running = await seededServer({ accessKey: FAKE_ACCESS_KEY });
    try {
      const port = new URL(running.url).port;
      const key = { authorization: `Bearer ${FAKE_ACCESS_KEY}` };
      for (const target of targets) {
        const rebound = await send(running.url, target, { headers: { ...key, host: `evil.example:${port}` } });
        assert.equal(rebound.status, 421, target);
        assert.equal(errorOf(rebound).message, MISDIRECTED_MESSAGE);
        const foreign = await send(running.url, target, { headers: { ...key, origin: 'http://evil.example' } });
        assert.equal(foreign.status, 403, target);
        assert.equal(errorOf(foreign).message, ORIGIN_REFUSED_MESSAGE);
        assertNoCors(foreign);
      }
      // The dashboard itself, served from this origin, may read them.
      const sameOrigin = await send(running.url, '/api/metrics/summary', {
        headers: { ...key, origin: `http://127.0.0.1:${port}` },
      });
      assert.equal(sameOrigin.status, 200);
      assertNoCors(sameOrigin);
    } finally {
      await running.stop();
    }
  });

  test('the routes are GET only (HEAD derived): POST is a 405', async () => {
    const running = await seededServer();
    try {
      for (const target of targets) {
        const response = await send(running.url, target, { method: 'POST', headers: JSON_TYPE, body: '{}' });
        assert.equal(response.status, 405, target);
        assert.equal(response.headers.allow, 'GET, HEAD');
      }
    } finally {
      await running.stop();
    }
  });
});

// ---------------------------------------------------------------- the live event stream

function entry(model: string, input: number, output: number): ModelEntry {
  return {
    provider: 'openai',
    model,
    canonical_model: model,
    price: { input, output, cached_input: null },
    context_window: 128_000,
    max_output: 16_000,
    capabilities: { tools: true, json_mode: true, vision: true, streaming: true },
    source_url: 'https://example.com/pricing',
    verified_on: '2026-09-01',
  };
}

async function proxyServer(options: Partial<ServerOptions> = {}): Promise<Running & { provider: MockProvider }> {
  const provider = await startMockProvider();
  const config: Config = ConfigSchema.parse({
    providers: {
      openai: { base_url: `${provider.url}/v1` },
      openrouter: { enabled: false },
      anthropic: { enabled: false },
      deepseek: { enabled: false },
      ollama: { enabled: false },
    },
  } satisfies ConfigInput);
  const catalog: Catalog = { models: [entry('gpt-x', 10, 50)] };
  const running = await startServer({
    proxy: { config, catalog, registry: buildRegistry(config, ENV), env: ENV },
    ...options,
  });
  return {
    ...running,
    provider,
    async stop() {
      await running.stop();
      await provider.close();
    },
  };
}

describe('GET /api/events', { timeout: 20_000 }, () => {
  test('streams text/event-stream with a health snapshot at once, then every interval', async () => {
    const monitor: HealthMonitor = {
      start() {},
      stop() {},
      checkNow: () => Promise.resolve(),
      recordLatency() {},
      snapshot: () => ({
        providers: [
          { id: 'openai', state: 'up', lastErrorKind: null, lastCheckedAt: 0, p50: 12, p95: 30, sampleCount: 4 },
        ],
      }),
    };
    const running = await startServer({ healthMonitor: monitor, eventStream: { healthIntervalMs: 40 } });
    try {
      const stream = await openStream(running.url);
      assert.equal(stream.status, 200);
      assert.equal(stream.headers['content-type'], 'text/event-stream; charset=utf-8');
      assert.equal(stream.headers['cache-control'], 'no-store');
      assert.equal(stream.headers['x-content-type-options'], 'nosniff');
      assertNoCors(stream);
      const first = await stream.waitFor((event) => event.event === 'health');
      assert.deepEqual(first.data, {
        providers: {
          openai: {
            state: 'up',
            p50_ms: 12,
            p95_ms: 30,
            last_checked: '1970-01-01T00:00:00.000Z',
            samples: 4,
            last_error_kind: null,
          },
        },
      });
      await until(() => stream.events.filter((event) => event.event === 'health').length >= 3);
      assert.match(stream.text(), /^event: health\ndata: \{.*\}\n\n/);
      stream.close();
    } finally {
      await running.stop();
    }
  });

  test(`the health interval defaults to 5 s and at most ${DEFAULT_MAX_EVENT_STREAMS} streams are open`, () => {
    assert.equal(DEFAULT_HEALTH_INTERVAL_MS, 5000);
    assert.equal(DEFAULT_MAX_EVENT_STREAMS, 16);
  });

  test('pushes a request event, in the /api/requests entry shape, after a proxied request', async () => {
    const store = openStore();
    const detachStore = onRequestOutcome((value) => store.record(value));
    const running = await proxyServer({ analytics: store });
    try {
      const stream = await openStream(running.url);
      await stream.waitFor((event) => event.event === 'health');
      const answer = await send(running.url, '/v1/chat/completions', {
        method: 'POST',
        headers: JSON_TYPE,
        body: JSON.stringify({ model: 'gpt-x', messages: [{ role: 'user', content: 'Say hello.' }] }),
      });
      assert.equal(answer.status, 200);
      const pushed = await stream.waitFor((event) => event.event === 'request');
      const data = pushed.data as {
        requestId: string;
        status: string;
        route: { usedProvider: string; usedModel: string; requestedModel: string };
        reason: string;
        cost_usd: string | null;
        latency_ms: number;
        first_byte_ms: number | null;
        origin: string | null;
        baseline_usd: string | null;
        usage: { input: number; output: number } | null;
        needs: { tools: boolean; json_mode: boolean; vision: boolean; streaming: boolean };
        price: {
          used: { input: number; output: number; verified_on: string; source_url: string } | null;
          requested: { input: number; output: number; verified_on: string; source_url: string } | null;
        } | null;
        selection: { considered: number; candidates: unknown[]; excluded: unknown[] } | null;
      };
      assert.equal(data.status, 'complete');
      assert.equal(data.route.requestedModel, 'gpt-x');
      assert.equal(data.route.usedProvider, 'openai');
      assert.equal(data.route.usedModel, 'gpt-x');
      assert.equal(data.reason, 'routed by the cheapest policy');
      assert.equal(typeof data.cost_usd, 'string');
      // A real, non-streamed, served request has all of the fields below populated.
      assert.equal(typeof data.latency_ms, 'number');
      assert.equal(data.first_byte_ms, null);
      assert.equal(data.origin, 'reported');
      assert.equal(typeof data.baseline_usd, 'string');
      assert.deepEqual(data.usage, { input: 10, output: 5 });
      assert.deepEqual(data.needs, { tools: false, json_mode: false, vision: false, streaming: false });
      const catalogPrice = {
        input: 10,
        output: 50,
        verified_on: '2026-09-01',
        source_url: 'https://example.com/pricing',
      };
      assert.deepEqual(data.price?.used, catalogPrice);
      assert.deepEqual(data.price?.requested, catalogPrice);
      assert.equal(data.selection?.considered, 1);
      // Nothing beyond the catalog's own price source URL: no provider URL, header or key anywhere in the stream.
      const text = stream.text();
      assert.ok(!text.includes(running.provider.url), 'the mock provider URL never reaches the stream');
      assert.ok(!/authorization|x-api-key/i.test(text), 'no header name reaches the stream');
      // What was pushed is exactly what /api/requests serves for the same request once it is stored.
      await store.flush();
      const listed = (await send(running.url, '/api/requests?limit=1')).json as { entries: unknown[] };
      assert.deepEqual(listed.entries[0], pushed.data);
      // Neither the provider key nor anything from the prompt reaches the stream.
      assert.ok(!stream.text().includes(FAKE_OPENAI_KEY));
      assert.ok(!stream.text().includes('Say hello'));
      stream.close();
    } finally {
      detachStore();
      await running.stop();
      await store.close();
    }
  });

  test('every open stream gets the event', async () => {
    const running = await proxyServer();
    try {
      const streams = [await openStream(running.url), await openStream(running.url), await openStream(running.url)];
      const answer = await send(running.url, '/v1/chat/completions', {
        method: 'POST',
        headers: JSON_TYPE,
        body: JSON.stringify({ model: 'gpt-x', messages: [{ role: 'user', content: 'Hi.' }] }),
      });
      assert.equal(answer.status, 200);
      const ids = await Promise.all(
        streams.map(async (stream) => {
          const event = await stream.waitFor((candidate) => candidate.event === 'request');
          return (event.data as { requestId: string }).requestId;
        }),
      );
      assert.equal(new Set(ids).size, 1);
      for (const stream of streams) stream.close();
    } finally {
      await running.stop();
    }
  });

  test(`the ${DEFAULT_MAX_EVENT_STREAMS + 1}th concurrent stream is a 503; a slot frees when a client leaves`, async () => {
    const running = await startServer();
    try {
      const streams: SseClient[] = [];
      for (let index = 0; index < DEFAULT_MAX_EVENT_STREAMS; index += 1) {
        const stream = await openStream(running.url);
        assert.equal(stream.status, 200);
        streams.push(stream);
      }
      const refused = await send(running.url, '/api/events');
      assert.equal(refused.status, 503);
      assert.deepEqual(errorOf(refused), {
        message: STREAM_LIMIT_MESSAGE,
        type: 'server_error',
        param: null,
        code: 'too_many_event_streams',
      } as unknown as ReturnType<typeof errorOf>);
      assert.equal(refused.headers['retry-after'], '5');
      assertNoCors(refused);

      streams.pop()?.close();
      let reopened: SseClient | undefined;
      for (let attempt = 0; attempt < 50 && reopened === undefined; attempt += 1) {
        const candidate = await openStream(running.url);
        if (candidate.status === 200) reopened = candidate;
        else await delay(20);
      }
      assert.ok(reopened !== undefined, 'a slot freed once a client left');
      streams.push(reopened);
      for (const stream of streams) stream.close();
    } finally {
      await running.stop();
    }
  });

  test('HEAD answers the stream headers with no body and holds no slot', async () => {
    const running = await startServer();
    try {
      const response = await send(running.url, '/api/events', { method: 'HEAD' });
      assert.equal(response.status, 200);
      assert.equal(response.headers['content-type'], 'text/event-stream; charset=utf-8');
      assert.equal(response.text, '');
    } finally {
      await running.stop();
    }
  });

  test('stopping the server ends every open stream at once, well within the grace period', async () => {
    const running = await startServer();
    const streams = [await openStream(running.url), await openStream(running.url)];
    await Promise.all(streams.map((stream) => stream.waitFor((event) => event.event === 'health')));
    const started = performance.now();
    await stopServer(running.server, 10_000);
    const elapsed = performance.now() - started;
    await Promise.all(streams.map((stream) => stream.ended));
    assert.ok(elapsed < 2000, `stopped in ${Math.round(elapsed)} ms`);
    assert.equal(running.server.listening, false);
  });
});

describe('event stream hub', { timeout: 20_000 }, () => {
  async function hubServer(options: EventStreamOptions) {
    const hub = createEventStreamHub(undefined, options);
    // A bare server that serves the hub on every path, so the hub's own state can be inspected.
    const plain = createServer((req, res) => hub.open(req, res));
    const address = await listen(plain, '127.0.0.1', 0);
    return {
      hub,
      url: baseUrl('127.0.0.1', address.port),
      stop: () =>
        new Promise<void>((resolve) => {
          plain.closeAllConnections();
          plain.close(() => resolve());
        }),
    };
  }

  test('a client hang-up removes its stream, and the last one removes the listener and the timer', async () => {
    const source = controlledSource();
    const timersBefore = activeTimers();
    const running = await hubServer({ subscribe: source.subscribe, healthIntervalMs: 1000 });
    try {
      const first = await openStream(running.url);
      const second = await openStream(running.url);
      assert.equal(running.hub.size, 2);
      assert.equal(source.listeners, 1, 'one listener for all streams');
      assert.equal(activeTimers(), timersBefore + 1, 'one health timer for all streams');

      first.close();
      await until(() => running.hub.size === 1);
      assert.equal(source.listeners, 1);
      assert.equal(activeTimers(), timersBefore + 1);

      second.close();
      await until(() => running.hub.size === 0);
      assert.equal(source.listeners, 0, 'no listener left');
      assert.equal(activeTimers(), timersBefore, 'no timer left');
    } finally {
      await running.stop();
    }
  });

  test('closeAll() ends every stream, releases the listener and the timer, and refuses new streams', async () => {
    const source = controlledSource();
    const timersBefore = activeTimers();
    const running = await hubServer({ subscribe: source.subscribe, healthIntervalMs: 1000 });
    try {
      const streams = [await openStream(running.url), await openStream(running.url)];
      running.hub.closeAll();
      await Promise.all(streams.map((stream) => stream.ended));
      assert.equal(running.hub.size, 0);
      assert.equal(source.listeners, 0);
      assert.equal(activeTimers(), timersBefore);
      const refused = await send(running.url, '/api/events');
      assert.equal(refused.status, 503);
      assert.equal(errorOf(refused).message, STREAMS_CLOSED_MESSAGE);
    } finally {
      await running.stop();
    }
  });

  test('a client that stops reading is cut off instead of buffered for without limit', async () => {
    const source = controlledSource();
    const running = await hubServer({ subscribe: source.subscribe, maxBufferedBytes: 64 * 1024 });
    try {
      const stream = await openStream(running.url);
      // Stop reading: the socket's buffers fill, then the server-side backlog grows past the cap.
      stream.request.socket?.pause();
      const big = outcome('big', 0, { requestedModel: 'm'.repeat(4000) });
      for (let index = 0; index < 5000 && running.hub.size > 0; index += 1) {
        source.emit(big);
        if (index % 100 === 0) await delay(1);
      }
      await until(() => running.hub.size === 0);
      assert.equal(source.listeners, 0);
    } finally {
      await running.stop();
    }
  });
});
