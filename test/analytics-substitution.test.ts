// The model substitution in the analytics store and the local API: schema 3 stores, for every request,
// whether another model than the requested one served it and, when it did, the two model ids and the
// equivalence group; rows stored before schema 3 read back as "not recorded". GET /api/requests, the
// `request` events of GET /api/events and GET /api/metrics/summary expose it, from stored data only.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { type RecentEntry, summary, toRecentEntry } from '../src/analytics/metrics.ts';
import {
  loadSqlite,
  NOT_RECORDED,
  openSqliteEventStore,
  SCHEMA_VERSION,
  type SqliteEventStore,
} from '../src/analytics/store.ts';
import type { Catalog, ModelEntry } from '../src/catalog/schema.ts';
import { type Config, type ConfigInput, ConfigSchema, type ProviderId } from '../src/config/schema.ts';
import { createLogger } from '../src/log/logger.ts';
import { buildRegistry } from '../src/providers/registry.ts';
import type { ModelSubstitution } from '../src/proxy/forward.ts';
import {
  buildRequestOutcome,
  onRequestOutcome,
  type RequestOutcome,
  type RequestOutcomeListener,
} from '../src/proxy/outcome.ts';
import { baseUrl, createTollwiseServer, listen, type ServerOptions, stopServer } from '../src/server/server.ts';
import { FAKE_KEYS } from './fixtures/fake-keys.ts';
import { send } from './fixtures/http-client.ts';
import { startMockProvider } from './fixtures/mock-provider.ts';

// Fake credentials with no known key shape; none of them is a real key.
const ENV = {
  OPENAI_API_KEY: `fakeOpenai${'Sb1'.repeat(6)}`,
  DEEPSEEK_API_KEY: `fakeDeep${'Sb2'.repeat(6)}`,
};

const workRoot = mkdtempSync(path.join(tmpdir(), 'tollwise-substitution-store-test-'));
after(() => rmSync(workRoot, { recursive: true, force: true }));

let caseCounter = 0;
function caseFile(): string {
  caseCounter += 1;
  const dir = path.join(workRoot, `case-${caseCounter}`);
  mkdirSync(dir);
  return path.join(dir, 'analytics.db');
}

function quietLogger() {
  return createLogger({ level: 'error', sink: { write: () => true }, env: {} });
}

function openStore(file: string = caseFile()): SqliteEventStore {
  return openSqliteEventStore({ file, logger: quietLogger() });
}

/** A second, independent connection to a database file, as another program would open it. */
function inspect(file: string) {
  const { DatabaseSync } = loadSqlite();
  return new DatabaseSync(file);
}

const FRONTIER: ModelSubstitution = {
  requested_model: 'gpt-6-astra',
  served_model: 'deepseek-v4-pro',
  group: 'frontier',
};

/** A request served by the model it asked for, `minutesAgo` minutes before now. */
function sameModel(requestId: string, minutesAgo = 5, overrides: Partial<RequestOutcome> = {}): RequestOutcome {
  return {
    timestamp: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    requestId,
    format: 'openai',
    requestedModel: 'gpt-6-astra',
    requestedProvider: 'openai',
    usedModel: 'openai/gpt-6-astra',
    usedProvider: 'openrouter',
    needs: { tools: false, json_mode: false, vision: false, streaming: false },
    policy: 'cheapest',
    decision: 'routed',
    attempts: 1,
    trace: [
      {
        provider: 'openrouter',
        model: 'openai/gpt-6-astra',
        outcome: 'ok',
        status: 200,
        duration_ms: 40,
        substitution: null,
      },
    ],
    usage: { input: 100, cached_input: 0, output: 50, origin: 'reported' },
    cost: {
      cost_usd: '0.000600',
      baseline_usd: '0.003000',
      savings_usd: '0.002400',
      origin: 'reported',
      used_price_verified_on: '2026-09-01',
      baseline_price_verified_on: '2026-09-01',
    },
    latencyMs: 60,
    firstByteMs: null,
    status: 'complete',
    selection: { considered: 2, candidates: [], excluded: [] },
    price: { used: null, requested: null },
    substitution: null,
    ...overrides,
  };
}

/** A request served by a cheaper model of the `frontier` group. */
function substituted(requestId: string, minutesAgo = 5, overrides: Partial<RequestOutcome> = {}): RequestOutcome {
  return sameModel(requestId, minutesAgo, {
    usedModel: FRONTIER.served_model,
    usedProvider: 'deepseek',
    trace: [
      {
        provider: 'deepseek',
        model: FRONTIER.served_model,
        outcome: 'ok',
        status: 200,
        duration_ms: 30,
        substitution: FRONTIER,
      },
    ],
    substitution: FRONTIER,
    ...overrides,
  });
}

/**
 * An outcome as the store reads it back: the request's substitution is stored in its own columns, but a
 * trace attempt's is not, so every attempt reads back with substitution null.
 */
function asStored(event: RequestOutcome): RequestOutcome {
  return { ...event, trace: event.trace.map((attempt) => ({ ...attempt, substitution: null })) };
}

/** Every column of every stored row, as another program reading the file sees them. */
function rawRows(file: string): Record<string, unknown>[] {
  const db = inspect(file);
  try {
    return db.prepare('SELECT * FROM request_events ORDER BY id').all() as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

const SUBSTITUTION_COLUMNS = [
  'substituted',
  'substitution_requested_model',
  'substitution_served_model',
  'substitution_group',
] as const;

function substitutionColumns(row: Record<string, unknown> | undefined): Record<string, unknown> {
  return Object.fromEntries(SUBSTITUTION_COLUMNS.map((name) => [name, row?.[name]]));
}

describe('storing the substitution', () => {
  test('a request served by the requested model is stored with substituted 0 and reads back exactly', async () => {
    const file = caseFile();
    const store = openStore(file);
    const event = sameModel('same-1');
    try {
      store.record(event);
      assert.deepEqual(await store.readEvents(), [event]);
    } finally {
      await store.close();
    }
    assert.deepEqual(substitutionColumns(rawRows(file)[0]), {
      substituted: 0,
      substitution_requested_model: null,
      substitution_served_model: null,
      substitution_group: null,
    });
  });

  test('a substituted request is stored with its two model ids and group and reads back exactly', async () => {
    const file = caseFile();
    const store = openStore(file);
    const event = substituted('sub-1');
    try {
      store.record(event);
      const [stored] = await store.readEvents();
      assert.deepEqual(stored, asStored(event));
      assert.deepEqual(stored?.substitution, FRONTIER);
      const page = await store.readRecentEvents({ limit: 5 });
      assert.deepEqual(page.events, [asStored(event)]);
    } finally {
      await store.close();
    }
    assert.deepEqual(substitutionColumns(rawRows(file)[0]), {
      substituted: 1,
      substitution_requested_model: 'gpt-6-astra',
      substitution_served_model: 'deepseek-v4-pro',
      substitution_group: 'frontier',
    });
  });

  test('only the two model ids and the group are stored: nothing else a substitution object carries', async () => {
    const file = caseFile();
    const store = openStore(file);
    const prompt = 'Tell me the launch codes.';
    const authorization = `Bearer ${'Qm8'.repeat(12)}`;
    const carrying = {
      ...FRONTIER,
      prompt,
      body: { messages: [{ role: 'user', content: prompt }] },
      headers: { authorization, 'x-api-key': authorization },
      key: authorization,
    } as ModelSubstitution;
    try {
      store.record(substituted('sub-extra', 5, { substitution: carrying }));
      const [stored] = await store.readEvents();
      assert.deepEqual(stored?.substitution, FRONTIER);
    } finally {
      await store.close();
    }
    const row = JSON.stringify(rawRows(file));
    for (const value of [prompt, authorization, 'launch codes', 'messages', 'x-api-key', 'headers']) {
      assert.ok(!row.includes(value), `the stored row does not contain ${value}`);
    }
  });

  test('a key pasted into a model id is masked before it is stored', async () => {
    const file = caseFile();
    const store = openStore(file);
    const pasted = FAKE_KEYS['OpenAI API key']?.text ?? '';
    assert.notEqual(pasted, '');
    const event = buildRequestOutcome(
      substituted('sub-pasted', 5, {
        requestedModel: pasted,
        substitution: { requested_model: pasted, served_model: `${pasted}-served`, group: 'frontier' },
      }),
    );
    try {
      store.record(event);
      const [stored] = await store.readEvents();
      assert.equal(stored?.substitution === NOT_RECORDED ? null : stored?.substitution?.group, 'frontier');
    } finally {
      await store.close();
    }
    const [row] = rawRows(file);
    assert.ok(!JSON.stringify(row).includes(pasted));
    assert.match(String(row?.substitution_requested_model), /\[REDACTED\]/);
    assert.match(String(row?.substitution_served_model), /\[REDACTED\]/);
  });
});

describe('a database written before schema 3', () => {
  test('a schema 2 database file migrates to the current schema, keeping its rows as "not recorded"', async () => {
    assert.equal(SCHEMA_VERSION, 3);
    // A frozen copy of the schema 2 table, as a file written by the previous Tollwise holds it.
    const file = caseFile();
    const old = inspect(file);
    const oldTimestamp = Date.now() - 10 * 60_000;
    try {
      old.exec(`
        CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
        CREATE TABLE request_events (
          id INTEGER PRIMARY KEY, timestamp_ms INTEGER NOT NULL, request_id TEXT NOT NULL, format TEXT NOT NULL,
          requested_model TEXT NOT NULL, requested_provider TEXT NOT NULL, used_model TEXT, used_provider TEXT,
          needs_tools INTEGER NOT NULL, needs_json_mode INTEGER NOT NULL, needs_vision INTEGER NOT NULL,
          needs_streaming INTEGER NOT NULL, policy TEXT NOT NULL, decision TEXT NOT NULL, attempts INTEGER NOT NULL,
          routing_trace TEXT NOT NULL, input_tokens INTEGER, cached_input_tokens INTEGER, output_tokens INTEGER,
          usage_origin TEXT, cost_usd TEXT, baseline_usd TEXT, savings_usd TEXT, cost_origin TEXT,
          used_price_verified_on TEXT, baseline_price_verified_on TEXT, latency_ms INTEGER NOT NULL,
          first_byte_ms INTEGER, status TEXT NOT NULL, selection TEXT, price TEXT
        ) STRICT;
        CREATE INDEX request_events_timestamp ON request_events (timestamp_ms);
        CREATE INDEX request_events_provider_timestamp ON request_events (used_provider, timestamp_ms);
        CREATE INDEX request_events_model_timestamp ON request_events (used_model, timestamp_ms);
        INSERT INTO schema_migrations (version, applied_at) VALUES (1, '2026-09-01T00:00:00.000Z');
        INSERT INTO schema_migrations (version, applied_at) VALUES (2, '2026-09-10T00:00:00.000Z');
      `);
      old
        .prepare(
          'INSERT INTO request_events (timestamp_ms, request_id, format, requested_model, requested_provider, ' +
            'used_model, used_provider, needs_tools, needs_json_mode, needs_vision, needs_streaming, policy, ' +
            'decision, attempts, routing_trace, latency_ms, status, selection, price) ' +
            "VALUES (?, 'old-1', 'openai', 'gpt-6-astra', 'openai', 'deepseek-v4-pro', 'deepseek', 0, 0, 0, 0, " +
            "'cheapest', 'routed', 1, ?, 70, 'complete', ?, ?)",
        )
        .run(
          oldTimestamp,
          JSON.stringify([
            { provider: 'deepseek', model: 'deepseek-v4-pro', outcome: 'ok', status: 200, duration_ms: 30 },
          ]),
          JSON.stringify({ considered: 2, candidates: [], excluded: [] }),
          JSON.stringify({ used: null, requested: null }),
        );
    } finally {
      old.close();
    }

    const store = openStore(file);
    try {
      const [migrated] = await store.readEvents();
      assert.equal(migrated?.requestId, 'old-1');
      assert.equal(migrated?.usedModel, 'deepseek-v4-pro');
      assert.equal(migrated?.substitution, NOT_RECORDED);
      assert.deepEqual(migrated?.selection, { considered: 2, candidates: [], excluded: [] });
      assert.equal(migrated?.trace[0]?.substitution, null);
      const entry = toRecentEntry(migrated ?? assert.fail('the old row is kept'));
      assert.equal(entry.substituted, null);
      assert.equal(entry.substitution, null);

      // New rows next to it round-trip exactly.
      const fresh = [sameModel('new-same', 2), substituted('new-sub', 1)];
      for (const event of fresh) store.record(event);
      const events = await store.readEvents();
      assert.deepEqual(events.slice(1), fresh.map(asStored));
      assert.deepEqual((await summary(store, '1h')).substituted_requests, 1);
    } finally {
      await store.close();
    }

    const db = inspect(file);
    try {
      assert.deepEqual(
        db
          .prepare('SELECT version FROM schema_migrations ORDER BY version')
          .all()
          .map((row) => row.version),
        [1, 2, 3],
      );
    } finally {
      db.close();
    }
    assert.deepEqual(substitutionColumns(rawRows(file)[0]), {
      substituted: null,
      substitution_requested_model: null,
      substitution_served_model: null,
      substitution_group: null,
    });
  });
});

describe('toRecentEntry and the summary', () => {
  test('same model: substituted false, substitution null', () => {
    const entry = toRecentEntry(sameModel('same-2'));
    assert.equal(entry.substituted, false);
    assert.equal(entry.substitution, null);
  });

  test('a refused request: substituted false, substitution null', () => {
    const entry = toRecentEntry(
      sameModel('refused', 5, {
        usedModel: null,
        usedProvider: null,
        decision: 'fail',
        attempts: 0,
        trace: [],
        usage: null,
        cost: null,
        status: 'refused',
      }),
    );
    assert.equal(entry.substituted, false);
    assert.equal(entry.substitution, null);
  });

  test('substituted: true and exactly the model ids and group, nothing else the object carries', () => {
    const entry = toRecentEntry(
      substituted('sub-2', 5, { substitution: { ...FRONTIER, extra: 'not for the API' } as ModelSubstitution }),
    );
    assert.equal(entry.substituted, true);
    assert.deepEqual(entry.substitution, FRONTIER);
  });

  test('substituted_requests counts only substituted requests inside the window', async () => {
    const store = openStore();
    try {
      store.record(substituted('in-1', 10));
      store.record(substituted('in-2', 20));
      store.record(sameModel('in-same', 15));
      store.record(substituted('out-of-window', 3 * 60));
      const result = await summary(store, '1h');
      assert.equal(result.requests, 3);
      assert.equal(result.substituted_requests, 2);
      assert.equal((await summary(store, '24h')).substituted_requests, 3);
    } finally {
      await store.close();
    }
  });
});

// ---------------------------------------------------------------- over HTTP

interface Running {
  readonly url: string;
  stop(): Promise<void>;
}

async function startServer(options: Partial<ServerOptions>): Promise<Running> {
  const server = createTollwiseServer({ maxBodyBytes: 64 * 1024, logger: quietLogger(), ...options });
  const address = await listen(server, '127.0.0.1', 0);
  return { url: baseUrl('127.0.0.1', address.port), stop: () => stopServer(server, 1000) };
}

/** Opens GET /api/events and resolves with the data of the first `request` event, then hangs up. */
function firstRequestEvent(url: string, onOpen: () => void): Promise<unknown> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: target.hostname, port: target.port, path: '/api/events', method: 'GET' },
      (res: IncomingMessage) => {
        let pending = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          pending += chunk;
          for (let boundary = pending.indexOf('\n\n'); boundary !== -1; boundary = pending.indexOf('\n\n')) {
            const lines = pending.slice(0, boundary).split('\n');
            pending = pending.slice(boundary + 2);
            if (lines.includes('event: health')) {
              onOpen();
              continue;
            }
            const data = lines.find((line) => line.startsWith('data: '));
            if (lines.includes('event: request') && data !== undefined) {
              resolve(JSON.parse(data.slice(6)));
              req.destroy();
              return;
            }
          }
        });
      },
    );
    req.on('error', (error) => {
      if (!req.destroyed) reject(error);
    });
    req.setTimeout(5000, () => reject(new Error('no request event in time')));
    req.end();
  });
}

describe('GET /api/requests, GET /api/events and GET /api/metrics/summary', { timeout: 20_000 }, () => {
  test('a live request event and the stored /api/requests entry of the same request are equal', async () => {
    const store = openStore();
    let emit: RequestOutcomeListener = () => {};
    const subscribe = (listener: RequestOutcomeListener) => {
      emit = listener;
      return () => {
        emit = () => {};
      };
    };
    const running = await startServer({ analytics: store, eventStream: { subscribe } });
    try {
      const event = substituted('live-sub', 1);
      const pushed = await firstRequestEvent(running.url, () => {
        store.record(event);
        emit(event);
      });
      await store.flush();

      const response = await send(running.url, '/api/requests?limit=5');
      assert.equal(response.status, 200);
      const [stored] = (response.json as { entries: RecentEntry[] }).entries;
      assert.deepEqual(pushed, stored);
      assert.deepEqual(stored?.substituted, true);
      assert.deepEqual(stored?.substitution, FRONTIER);
      assert.deepEqual(stored?.trace, [
        { provider: 'deepseek', model: 'deepseek-v4-pro', outcome: 'ok', status: 200, duration_ms: 30 },
      ]);
    } finally {
      await running.stop();
      await store.close();
    }
  });

  test('/api/requests reports true, false and null per row, and the summary counts the substituted ones', async () => {
    const file = caseFile();
    const store = openStore(file);
    store.record(substituted('api-sub', 30));
    store.record(sameModel('api-same', 20));
    store.record(sameModel('api-old', 10));
    await store.close();
    // The newest row stands for one written before schema 3: nothing was recorded about it.
    const db = inspect(file);
    try {
      db.prepare(
        'UPDATE request_events SET substituted = NULL, substitution_requested_model = NULL, ' +
          'substitution_served_model = NULL, substitution_group = NULL WHERE request_id = ?',
      ).run('api-old');
    } finally {
      db.close();
    }

    const reopened = openStore(file);
    const running = await startServer({ analytics: reopened });
    try {
      const response = await send(running.url, '/api/requests');
      assert.equal(response.status, 200);
      const entries = (response.json as { entries: RecentEntry[] }).entries;
      assert.deepEqual(
        entries.map((entry) => [entry.requestId, entry.substituted, entry.substitution]),
        [
          ['api-old', null, null],
          ['api-same', false, null],
          ['api-sub', true, FRONTIER],
        ],
      );
      const summaryResponse = await send(running.url, '/api/metrics/summary?range=1h');
      assert.equal(summaryResponse.status, 200);
      assert.equal((summaryResponse.json as { substituted_requests: number }).substituted_requests, 1);
    } finally {
      await running.stop();
      await reopened.close();
    }
  });

  test('a request served through an equivalence preset shows as substituted in /api/requests', async () => {
    const mocks = { openai: await startMockProvider(), deepseek: await startMockProvider() };
    const config: Config = ConfigSchema.parse({
      providers: {
        openai: { base_url: `${mocks.openai.url}/v1` },
        deepseek: { base_url: `${mocks.deepseek.url}/v1` },
        openrouter: { enabled: false },
        anthropic: { enabled: false },
        ollama: { enabled: false },
      },
      routing: { equivalence_presets: ['frontier'] },
    } satisfies ConfigInput);
    const catalogEntry = (provider: ProviderId, model: string, canonical: string, input: number): ModelEntry => ({
      provider,
      model,
      canonical_model: canonical,
      price: { input, output: input * 4, cached_input: null },
      context_window: 200_000,
      max_output: 16_000,
      capabilities: { tools: true, json_mode: true, vision: true, streaming: true },
      source_url: 'https://example.com/pricing',
      verified_on: '2026-09-01',
    });
    const catalog: Catalog = {
      models: [
        catalogEntry('deepseek', 'deepseek-v4-pro', 'deepseek-v4-pro-0813', 1),
        catalogEntry('openai', 'gpt-6-astra', 'gpt-6-astra', 10),
      ],
    };
    const store = openStore();
    const detach = onRequestOutcome((outcome) => store.record(outcome));
    const running = await startServer({
      analytics: store,
      proxy: { config, catalog, registry: buildRegistry(config, ENV), env: ENV },
    });
    try {
      const answer = await send(running.url, '/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-6-astra', messages: [{ role: 'user', content: 'Say hello.' }] }),
      });
      assert.equal(answer.status, 200);
      assert.equal(answer.headers['x-tollwise-substituted'], 'true');
      await store.flush();
      const response = await send(running.url, '/api/requests');
      const [entry] = (response.json as { entries: RecentEntry[] }).entries;
      assert.equal(entry?.substituted, true);
      assert.deepEqual(entry?.substitution, {
        requested_model: 'gpt-6-astra',
        served_model: entry?.route.usedModel,
        group: 'frontier',
      });
      assert.equal(entry?.route.usedProvider, 'deepseek');
      assert.ok(!JSON.stringify(entry).includes('Say hello.'));
    } finally {
      detach();
      await running.stop();
      await store.close();
      await Promise.all([mocks.openai.close(), mocks.deepseek.close()]);
    }
  });
});
