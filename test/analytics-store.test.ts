// The local analytics store: schema and migrations, what a row holds (and never holds), reads by time
// range, writes deferred off the request's turn, write failures contained, the disabled mode, the
// prompt-storage refusal, the `tollwise start` wiring, and a quiet startup.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  AnalyticsStoreError,
  loadSqlite,
  NOT_RECORDED,
  openSqliteEventStore,
  SCHEMA_VERSION,
  type SqliteEventStore,
} from '../src/analytics/store.ts';
import { ConfigError } from '../src/config/errors.ts';
import { loadConfig } from '../src/config/load.ts';
import { createLogger, type LogSink } from '../src/log/logger.ts';
import { clearSecretValues } from '../src/log/redact.ts';
import type { RequestOutcome } from '../src/proxy/outcome.ts';
import { type SignalSource, StartError, startTollwise } from '../src/server/start.ts';
import { freePort, send } from './fixtures/http-client.ts';
import { startMockProvider } from './fixtures/mock-provider.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const storeModule = pathToFileURL(path.join(here, '..', 'src', 'analytics', 'store.ts')).href;

// Fake credentials with no known key shape; none of them is a real key.
const FAKE_DEEPSEEK_KEY = `fakeDeep${'Ds3'.repeat(6)}`;
const FAKE_OPENROUTER_KEY = `fakeRouter${'Or2'.repeat(6)}`;

const workRoot = mkdtempSync(path.join(tmpdir(), 'tollwise-analytics-test-'));
after(() => rmSync(workRoot, { recursive: true, force: true }));

let dirCounter = 0;
function workDir(): string {
  dirCounter += 1;
  const dir = path.join(workRoot, `case-${dirCounter}`);
  mkdirSync(dir);
  return dir;
}

interface CapturedLog extends LogSink {
  readonly lines: string[];
  records(): Record<string, unknown>[];
}

function captureLog(): CapturedLog {
  const lines: string[] = [];
  return {
    lines,
    write(chunk: string) {
      lines.push(chunk);
      return true;
    },
    records: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

/** A second, independent connection to a database file, as another program would open it. */
function inspect(file: string) {
  const { DatabaseSync } = loadSqlite();
  return new DatabaseSync(file);
}

function openStore(file: string, log: CapturedLog = captureLog()): SqliteEventStore {
  return openSqliteEventStore({ file, logger: createLogger({ level: 'debug', sink: log, env: {} }) });
}

const SERVED: RequestOutcome = {
  timestamp: '2026-09-19T10:00:00.000Z',
  requestId: '6f1c1f0e-3f7d-4c55-9d1a-0b8f2f4b6a01',
  format: 'openai',
  requestedModel: 'gpt-5.6-luna',
  requestedProvider: 'openai',
  usedModel: 'deepseek/deepseek-v4-pro-0813',
  usedProvider: 'openrouter',
  needs: { tools: true, json_mode: false, vision: false, streaming: true },
  policy: 'cheapest',
  decision: 'routed',
  attempts: 2,
  trace: [
    {
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      outcome: 'timeout',
      status: null,
      duration_ms: 5001,
      substitution: null,
    },
    {
      provider: 'openrouter',
      model: 'deepseek/deepseek-v4-pro-0813',
      outcome: 'ok',
      status: 200,
      duration_ms: 812,
      substitution: null,
    },
  ],
  usage: { input: 1200, cached_input: 200, output: 350, origin: 'reported' },
  cost: {
    cost_usd: '0.00061',
    baseline_usd: '0.00066',
    savings_usd: '0.00005',
    origin: 'reported',
    used_price_verified_on: '2026-09-19',
    baseline_price_verified_on: '2026-09-18',
  },
  latencyMs: 5870,
  firstByteMs: 5840,
  status: 'complete',
  selection: {
    considered: 3,
    candidates: [
      { provider: 'deepseek', model: 'deepseek-v4-pro', input: 0.27, output: 1.1 },
      { provider: 'openrouter', model: 'deepseek/deepseek-v4-pro-0813', input: 0.3, output: 1.2 },
    ],
    excluded: [{ provider: 'openai', model: 'gpt-5.6-luna', reason: 'missing_capability:tools' }],
  },
  price: {
    used: { input: 0.3, output: 1.2, verified_on: '2026-09-19', source_url: 'https://example.com/openrouter-pricing' },
    requested: { input: 0.4, output: 1.3, verified_on: '2026-09-18', source_url: 'https://example.com/openai-pricing' },
  },
  substitution: null,
};

const UNPRICED: RequestOutcome = {
  ...SERVED,
  timestamp: '2026-09-19T11:30:00.000Z',
  requestId: '6f1c1f0e-3f7d-4c55-9d1a-0b8f2f4b6a02',
  requestedModel: 'some-unlisted-model',
  usedModel: 'some-unlisted-model',
  usedProvider: 'openai',
  decision: 'passthrough',
  attempts: 1,
  trace: [
    {
      provider: 'openai',
      model: 'some-unlisted-model',
      outcome: 'ok',
      status: 200,
      duration_ms: 90,
      substitution: null,
    },
  ],
  usage: { input: 10, cached_input: 0, output: 4, origin: 'estimated' },
  cost: {
    cost_usd: '0.0000144',
    baseline_usd: 'unknown',
    savings_usd: 'unknown',
    origin: 'estimated',
    used_price_verified_on: '2026-09-19',
    baseline_price_verified_on: 'unknown',
  },
  firstByteMs: null,
  selection: {
    considered: 0,
    candidates: [{ provider: 'openai', model: 'some-unlisted-model', input: null, output: null }],
    excluded: [],
  },
  price: { used: null, requested: null },
};

const REFUSED: RequestOutcome = {
  timestamp: '2026-09-19T12:00:00.000Z',
  requestId: '6f1c1f0e-3f7d-4c55-9d1a-0b8f2f4b6a03',
  format: 'anthropic',
  requestedModel: 'claude-no-such-model',
  requestedProvider: 'anthropic',
  usedModel: null,
  usedProvider: null,
  needs: { tools: false, json_mode: false, vision: true, streaming: false },
  policy: 'fastest',
  decision: 'fail',
  attempts: 0,
  trace: [],
  usage: null,
  cost: null,
  latencyMs: 3,
  firstByteMs: null,
  status: 'refused',
  selection: { considered: 0, candidates: [], excluded: [] },
  price: { used: null, requested: null },
  substitution: null,
};

describe('schema and migrations', () => {
  test('opening a missing file in a missing folder creates both and applies every migration once', () => {
    const file = path.join(workDir(), 'nested', 'deeper', 'analytics.db');
    const store = openStore(file);
    const db = inspect(file);
    try {
      assert.ok(existsSync(file));
      const versions = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all();
      assert.deepEqual(
        versions.map((row) => row.version),
        [1, 2, 3],
      );
      assert.equal(SCHEMA_VERSION, 3);
    } finally {
      db.close();
    }
    return store.close();
  });

  test('the events table has exactly the metadata columns: no prompt, response, header or URL column', async () => {
    const file = path.join(workDir(), 'analytics.db');
    await openStore(file).close();
    const db = inspect(file);
    try {
      const columns = db
        .prepare('SELECT name FROM pragma_table_info(?) ORDER BY cid')
        .all('request_events')
        .map((row) => row.name);
      assert.deepEqual(columns, [
        'id',
        'timestamp_ms',
        'request_id',
        'format',
        'requested_model',
        'requested_provider',
        'used_model',
        'used_provider',
        'needs_tools',
        'needs_json_mode',
        'needs_vision',
        'needs_streaming',
        'policy',
        'decision',
        'attempts',
        'routing_trace',
        'input_tokens',
        'cached_input_tokens',
        'output_tokens',
        'usage_origin',
        'cost_usd',
        'baseline_usd',
        'savings_usd',
        'cost_origin',
        'used_price_verified_on',
        'baseline_price_verified_on',
        'latency_ms',
        'first_byte_ms',
        'status',
        'selection',
        'price',
        'substituted',
        'substitution_requested_model',
        'substitution_served_model',
        'substitution_group',
      ]);
      for (const name of columns) {
        assert.doesNotMatch(String(name), /prompt|response|message|content|body|header|url|key|auth/i);
      }
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all()
        .map((row) => row.name);
      assert.deepEqual(tables, ['request_events', 'schema_migrations']);
    } finally {
      db.close();
    }
  });

  test('time-range queries are served by an index', async () => {
    const file = path.join(workDir(), 'analytics.db');
    await openStore(file).close();
    const db = inspect(file);
    try {
      const indexes = db
        .prepare('SELECT name FROM pragma_index_list(?) ORDER BY name')
        .all('request_events')
        .map((row) => row.name);
      assert.deepEqual(indexes, [
        'request_events_model_timestamp',
        'request_events_provider_timestamp',
        'request_events_timestamp',
      ]);
      const plan = (sql: string): string =>
        db
          .prepare(`EXPLAIN QUERY PLAN ${sql}`)
          .all()
          .map((row) => String(row.detail))
          .join('\n');
      assert.match(
        plan('SELECT * FROM request_events WHERE timestamp_ms >= 0 AND timestamp_ms < 10'),
        /USING INDEX request_events_timestamp/,
      );
      assert.match(
        plan("SELECT SUM(latency_ms) FROM request_events WHERE used_provider = 'openai' AND timestamp_ms >= 0"),
        /USING (COVERING )?INDEX request_events_provider_timestamp/,
      );
    } finally {
      db.close();
    }
  });

  test('reopening keeps the rows and applies no migration twice', async () => {
    const file = path.join(workDir(), 'analytics.db');
    const first = openStore(file);
    first.record(SERVED);
    await first.close();
    const second = openStore(file);
    assert.deepEqual(await second.readEvents(), [SERVED]);
    await second.close();
    const db = inspect(file);
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()?.n, 3);
    } finally {
      db.close();
    }
  });

  test('a database written by a newer version is refused, not modified', async () => {
    const file = path.join(workDir(), 'analytics.db');
    await openStore(file).close();
    const db = inspect(file);
    db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
      SCHEMA_VERSION + 1,
      '2027-01-01T00:00:00.000Z',
    );
    db.close();
    assert.throws(
      () => openStore(file),
      (error: unknown) =>
        error instanceof AnalyticsStoreError &&
        error.message.includes(file) &&
        /written by a newer version of Tollwise \(schema 4; this version understands up to 3\)/.test(error.message) &&
        /Fix: upgrade Tollwise, or set analytics\.path to another file\./.test(error.message),
    );
  });

  test('a schema 1 database migrates to the current schema keeping its rows, which read back with selection, price and substitution unknown', async () => {
    // A frozen copy of the schema 1 table, as a file written by an earlier Tollwise holds it.
    const file = path.join(workDir(), 'analytics.db');
    const old = inspect(file);
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
          first_byte_ms INTEGER, status TEXT NOT NULL
        ) STRICT;
        CREATE INDEX request_events_timestamp ON request_events (timestamp_ms);
        CREATE INDEX request_events_provider_timestamp ON request_events (used_provider, timestamp_ms);
        CREATE INDEX request_events_model_timestamp ON request_events (used_model, timestamp_ms);
        INSERT INTO schema_migrations (version, applied_at) VALUES (1, '2026-09-01T00:00:00.000Z');
      `);
      old
        .prepare(
          'INSERT INTO request_events (timestamp_ms, request_id, format, requested_model, requested_provider, ' +
            'used_model, used_provider, needs_tools, needs_json_mode, needs_vision, needs_streaming, policy, ' +
            'decision, attempts, routing_trace, input_tokens, cached_input_tokens, output_tokens, usage_origin, ' +
            'cost_usd, baseline_usd, savings_usd, cost_origin, used_price_verified_on, baseline_price_verified_on, ' +
            'latency_ms, first_byte_ms, status) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, 0, 1, ?, ?, 2, ?, 1200, 200, ' +
            "350, 'reported', '0.00061', '0.00066', '0.00005', 'reported', '2026-09-19', '2026-09-18', 5870, 5840, 'complete')",
        )
        .run(
          Date.parse(SERVED.timestamp),
          SERVED.requestId,
          'openai',
          'gpt-5.6-luna',
          'openai',
          'deepseek/deepseek-v4-pro-0813',
          'openrouter',
          'cheapest',
          'routed',
          JSON.stringify(SERVED.trace),
        );
    } finally {
      old.close();
    }

    const store = openStore(file);
    try {
      const migrated = { ...SERVED, selection: null, price: null, substitution: NOT_RECORDED };
      assert.deepEqual(await store.readEvents(), [migrated]);
      store.record(REFUSED);
      assert.deepEqual(await store.readEvents(), [migrated, REFUSED]);
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
      const first = db.prepare('SELECT selection, price FROM request_events WHERE id = 1').get();
      assert.deepEqual({ ...first }, { selection: null, price: null });
    } finally {
      db.close();
    }
  });

  test('a file that is not a SQLite database is refused with what to do', () => {
    const dir = workDir();
    const file = path.join(dir, 'analytics.db');
    writeFileSync(file, 'this is a plain text file, not a database\n'.repeat(200));
    assert.throws(
      () => openStore(file),
      (error: unknown) =>
        error instanceof AnalyticsStoreError &&
        error.message ===
          `cannot open the analytics database at ${file}: the file exists but is not a readable SQLite database. ` +
            'Fix: set analytics.path to a file in a folder you can write to, or set analytics.enabled to false.',
    );
    // Refused, never overwritten.
    assert.equal(readFileSync(file, 'utf8'), 'this is a plain text file, not a database\n'.repeat(200));
  });
});

describe('recording and reading', () => {
  test('outcomes are read back exactly as recorded, oldest first, filtered by time range', async () => {
    const store = openStore(path.join(workDir(), 'analytics.db'));
    try {
      store.record(REFUSED);
      store.record(SERVED);
      store.record(UNPRICED);
      assert.deepEqual(await store.readEvents(), [SERVED, UNPRICED, REFUSED]);
      assert.deepEqual(
        await store.readEvents({
          since: new Date('2026-09-19T11:00:00.000Z'),
          until: new Date('2026-09-19T12:00:00.000Z'),
        }),
        [UNPRICED],
      );
      assert.deepEqual(await store.readEvents({ since: new Date('2026-09-19T12:00:00.000Z') }), [REFUSED]);
      assert.deepEqual(await store.readEvents({ limit: 1 }), [SERVED]);
    } finally {
      await store.close();
    }
  });

  test('a row holds the metadata as plain columns, with NULL for what is unknown', async () => {
    const file = path.join(workDir(), 'analytics.db');
    const store = openStore(file);
    store.record(UNPRICED);
    store.record(REFUSED);
    await store.close();
    const db = inspect(file);
    try {
      const rows = db.prepare('SELECT * FROM request_events ORDER BY id').all();
      assert.deepEqual(
        { ...rows[0] },
        {
          id: 1,
          timestamp_ms: Date.parse('2026-09-19T11:30:00.000Z'),
          request_id: '6f1c1f0e-3f7d-4c55-9d1a-0b8f2f4b6a02',
          format: 'openai',
          requested_model: 'some-unlisted-model',
          requested_provider: 'openai',
          used_model: 'some-unlisted-model',
          used_provider: 'openai',
          needs_tools: 1,
          needs_json_mode: 0,
          needs_vision: 0,
          needs_streaming: 1,
          policy: 'cheapest',
          decision: 'passthrough',
          attempts: 1,
          routing_trace:
            '[{"provider":"openai","model":"some-unlisted-model","outcome":"ok","status":200,"duration_ms":90}]',
          input_tokens: 10,
          cached_input_tokens: 0,
          output_tokens: 4,
          usage_origin: 'estimated',
          cost_usd: '0.0000144',
          baseline_usd: null,
          savings_usd: null,
          cost_origin: 'estimated',
          used_price_verified_on: '2026-09-19',
          baseline_price_verified_on: null,
          latency_ms: 5870,
          first_byte_ms: null,
          status: 'complete',
          selection:
            '{"considered":0,"candidates":[{"provider":"openai","model":"some-unlisted-model","input":null,"output":null}],"excluded":[]}',
          price: '{"used":null,"requested":null}',
          substituted: 0,
          substitution_requested_model: null,
          substitution_served_model: null,
          substitution_group: null,
        },
      );
      assert.equal(rows[1]?.used_provider, null);
      assert.equal(rows[1]?.input_tokens, null);
      assert.equal(rows[1]?.cost_usd, null);
      assert.equal(rows[1]?.routing_trace, '[]');
      assert.equal(rows[1]?.status, 'refused');
    } finally {
      db.close();
    }
  });

  test('only the routing trace fields are stored, even if an attempt object carries more', async () => {
    const file = path.join(workDir(), 'analytics.db');
    const store = openStore(file);
    const extra = { ...SERVED.trace[1], url: 'https://example.com/v1', headers: { authorization: 'x' } };
    store.record({ ...SERVED, trace: [extra as unknown as RequestOutcome['trace'][number]] });
    await store.close();
    const db = inspect(file);
    try {
      assert.equal(
        db.prepare('SELECT routing_trace FROM request_events').get()?.routing_trace,
        '[{"provider":"openrouter","model":"deepseek/deepseek-v4-pro-0813","outcome":"ok","status":200,"duration_ms":812}]',
      );
    } finally {
      db.close();
    }
  });

  test('the selection and prices are stored as JSON and read back exactly as recorded', async () => {
    const file = path.join(workDir(), 'analytics.db');
    const store = openStore(file);
    store.record(SERVED);
    await store.close();
    const db = inspect(file);
    try {
      const row = db.prepare('SELECT selection, price FROM request_events').get();
      assert.deepEqual(JSON.parse(String(row?.selection)), SERVED.selection);
      assert.deepEqual(JSON.parse(String(row?.price)), SERVED.price);
    } finally {
      db.close();
    }
    const reopened = openStore(file);
    try {
      const [stored] = await reopened.readEvents();
      assert.deepEqual(stored?.selection, SERVED.selection);
      assert.deepEqual(stored?.price, SERVED.price);
    } finally {
      await reopened.close();
    }
  });

  test('a stored row holds no header, key, body or other URL, even if the outcome objects carry them', async () => {
    const file = path.join(workDir(), 'analytics.db');
    const store = openStore(file);
    const smuggled = {
      headers: { authorization: 'Bearer smuggled-credential' }, // tollwise-allow-secret
      apiKey: 'smuggled-credential',
      body: '{"messages":[{"role":"user","content":"smuggled prompt"}]}',
      url: 'https://smuggled.example.com/v1',
      error: 'smuggled provider error text',
    };
    const selection = SERVED.selection as NonNullable<RequestOutcome['selection']>;
    const price = SERVED.price as NonNullable<RequestOutcome['price']>;
    const carrying = {
      ...SERVED,
      selection: {
        ...selection,
        ...smuggled,
        candidates: selection.candidates.map((candidate) => ({ ...candidate, ...smuggled })),
        excluded: selection.excluded.map((entry) => ({ ...entry, ...smuggled })),
      },
      price: { ...price, ...smuggled, used: { ...price.used, ...smuggled }, requested: null },
    } as unknown as RequestOutcome;
    store.record(carrying);
    await store.close();
    const db = inspect(file);
    try {
      const row = { ...db.prepare('SELECT * FROM request_events').get() };
      const serialised = JSON.stringify(row);
      assert.ok(!serialised.includes('smuggled'), 'nothing smuggled onto the outcome objects is stored');
      assert.ok(!/authorization|apiKey|"headers"|"body"|"error"/i.test(serialised));
      assert.deepEqual(JSON.parse(String(row.selection)), selection);
      assert.deepEqual(JSON.parse(String(row.price)), { used: price.used, requested: null });
      // The only URLs stored are the catalog source_url values of the prices.
      assert.deepEqual(serialised.match(/https?:\/\/[^"\\]+/g), ['https://example.com/openrouter-pricing']);
    } finally {
      db.close();
    }
  });

  test('record() returns before writing: the row appears on a later turn of the event loop', async () => {
    const file = path.join(workDir(), 'analytics.db');
    const store = openStore(file);
    const db = inspect(file);
    try {
      const rows = () => db.prepare('SELECT COUNT(*) AS n FROM request_events').get()?.n;
      store.record(SERVED);
      store.record(REFUSED);
      assert.equal(rows(), 0);
      await nextTurn();
      assert.equal(rows(), 2);
    } finally {
      db.close();
      await store.close();
    }
  });

  test('close() writes what is queued, is safe to call twice, and later records are ignored', async () => {
    const file = path.join(workDir(), 'analytics.db');
    const store = openStore(file);
    store.record(SERVED);
    await store.close();
    await store.close();
    store.record(REFUSED);
    await nextTurn();
    assert.deepEqual(await store.readEvents(), []);
    const reopened = openStore(file);
    assert.deepEqual(await reopened.readEvents(), [SERVED]);
    await reopened.close();
  });
});

describe('write failures', () => {
  test('a failed write never throws, drops that batch and logs the error class only, once a minute', async () => {
    const file = path.join(workDir(), 'analytics.db');
    const log = captureLog();
    const store = openStore(file, log);
    try {
      // Another program removes the table from under the running store.
      const db = inspect(file);
      db.exec('DROP TABLE request_events');
      db.close();

      assert.doesNotThrow(() => store.record(SERVED));
      await nextTurn();
      assert.deepEqual(
        log.records().map(({ time: _time, ...rest }) => rest),
        [
          {
            level: 'warn',
            msg: 'analytics write failed; request metadata was not stored',
            error: 'Error',
            sqliteCode: 1,
            dropped: 1,
          },
        ],
      );
      // No SQLite message (which names the table or quotes values) and nothing from the outcome.
      const output = log.lines.join('');
      assert.doesNotMatch(output, /no such table|request_events|gpt-5\.6-luna|openrouter/);

      // A second failure within the minute is counted, not logged again.
      store.record(REFUSED);
      await store.flush();
      assert.equal(log.lines.length, 1);
    } finally {
      await store.close();
    }
  });
});

describe('configuration', () => {
  test('analytics.store_prompts: true is refused: prompt storage is not available in this release', () => {
    const dir = workDir();
    writeFileSync(path.join(dir, 'cfg.yaml'), 'analytics:\n  store_prompts: true\n');
    assert.throws(
      () => loadConfig({ cwd: dir, env: {}, configPath: 'cfg.yaml' }),
      (error: unknown) =>
        error instanceof ConfigError &&
        error.lines().length === 1 &&
        error.lines()[0] ===
          'cfg.yaml:2:18: analytics.store_prompts: prompt storage is not available in this release; Tollwise stores request metadata only. Fix: set store_prompts to false or remove the field.',
    );
  });

  test('analytics.store_prompts: false and the default path are accepted', () => {
    const dir = workDir();
    writeFileSync(path.join(dir, 'cfg.yaml'), 'analytics:\n  store_prompts: false\n');
    const loaded = loadConfig({ cwd: dir, env: {}, configPath: 'cfg.yaml' });
    assert.deepEqual(loaded.config.analytics, { enabled: true, store_prompts: false, path: 'data/analytics.db' });
  });
});

// ---------------------------------------------------------------- `tollwise start`

const NO_PROVIDERS =
  'providers:\n' +
  '  anthropic: { enabled: false }\n' +
  '  openai: { enabled: false }\n' +
  '  deepseek: { enabled: false }\n' +
  '  openrouter: { enabled: false }\n' +
  '  ollama: { enabled: false }\n';

async function startIn(dir: string, log: CapturedLog, env: Record<string, string> = {}) {
  return startTollwise({
    env: { TOLLWISE_PORT: String(await freePort()), ...env },
    cwd: dir,
    logSink: log,
    signals: new EventEmitter() as SignalSource,
  });
}

describe('tollwise start', () => {
  test('with analytics.enabled: false no database file or folder is created', async () => {
    const dir = workDir();
    writeFileSync(path.join(dir, 'tollwise.yaml'), `${NO_PROVIDERS}analytics:\n  enabled: false\n`);
    const log = captureLog();
    const running = await startIn(dir, log);
    try {
      const ready = log.records().find((record) => String(record.msg).startsWith('Tollwise is ready'));
      assert.equal(ready?.analytics, 'off');
    } finally {
      await running.stop();
    }
    assert.equal(existsSync(path.join(dir, 'data')), false);
    assert.equal(existsSync(path.join(dir, 'data', 'analytics.db')), false);
  });

  test('a served request is stored once the response has finished, without its prompt, and the file closes on stop', async () => {
    const deepseek = await startMockProvider({});
    const openrouter = await startMockProvider({});
    const dir = workDir();
    const log = captureLog();
    const marker = 'unmistakable-prompt-marker-7d1f';
    try {
      writeFileSync(
        path.join(dir, 'tollwise.yaml'),
        'providers:\n' +
          '  anthropic: { enabled: false }\n' +
          '  openai: { enabled: false }\n' +
          `  deepseek: { base_url: "${deepseek.url}/v1" }\n` +
          `  openrouter: { base_url: "${openrouter.url}/v1" }\n` +
          '  ollama: { enabled: false }\n',
      );
      const running = await startIn(dir, log, {
        DEEPSEEK_API_KEY: FAKE_DEEPSEEK_KEY,
        OPENROUTER_API_KEY: FAKE_OPENROUTER_KEY,
      });
      const file = path.join(dir, 'data', 'analytics.db');
      const ready = log.records().find((record) => String(record.msg).startsWith('Tollwise is ready'));
      assert.equal(ready?.analytics, file);
      const res = await send(running.url, '/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'deepseek-v4-pro', messages: [{ role: 'user', content: marker }] }),
      });
      assert.equal(res.status, 200);
      await running.stop();

      const db = inspect(file);
      let rows: Record<string, unknown>[];
      try {
        rows = db.prepare('SELECT * FROM request_events').all();
      } finally {
        db.close();
      }
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.request_id, res.headers['x-tollwise-request-id']);
      assert.equal(rows[0]?.requested_model, 'deepseek-v4-pro');
      assert.equal(rows[0]?.used_provider, 'openrouter');
      assert.equal(rows[0]?.used_model, 'deepseek/deepseek-v4-pro-0813');
      assert.equal(rows[0]?.status, 'complete');
      assert.equal(rows[0]?.cost_usd, res.headers['x-tollwise-cost-usd']);
      // Neither the prompt, the answer, nor any key is anywhere in the database.
      const bytes = readFileSync(file).toString('latin1');
      assert.ok(!bytes.includes(marker));
      assert.ok(!bytes.includes(FAKE_DEEPSEEK_KEY));
      assert.ok(!bytes.includes(FAKE_OPENROUTER_KEY));
      assert.ok(!bytes.includes('127.0.0.1'));
      // Closed on stop: the folder can be removed at once, on every platform.
      rmSync(path.join(dir, 'data'), { recursive: true });
    } finally {
      await deepseek.close();
      await openrouter.close();
      clearSecretValues();
    }
  });

  test('a failing write never fails the request', async () => {
    const deepseek = await startMockProvider({});
    const openrouter = await startMockProvider({});
    const dir = workDir();
    const log = captureLog();
    try {
      writeFileSync(
        path.join(dir, 'tollwise.yaml'),
        'providers:\n' +
          '  anthropic: { enabled: false }\n' +
          '  openai: { enabled: false }\n' +
          `  deepseek: { base_url: "${deepseek.url}/v1" }\n` +
          `  openrouter: { base_url: "${openrouter.url}/v1" }\n` +
          '  ollama: { enabled: false }\n',
      );
      const running = await startIn(dir, log, {
        DEEPSEEK_API_KEY: FAKE_DEEPSEEK_KEY,
        OPENROUTER_API_KEY: FAKE_OPENROUTER_KEY,
      });
      const db = inspect(path.join(dir, 'data', 'analytics.db'));
      db.exec('DROP TABLE request_events');
      db.close();
      const request = () =>
        send(running.url, '/v1/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'Say hello.' }] }),
        });
      assert.equal((await request()).status, 200);
      assert.equal((await request()).status, 200);
      await running.stop();
      assert.equal(await running.stopped, 0);
      const warnings = log.records().filter((record) => String(record.msg).startsWith('analytics write failed'));
      assert.equal(warnings.length, 1);
      assert.equal(warnings[0]?.error, 'Error');
    } finally {
      await deepseek.close();
      await openrouter.close();
      clearSecretValues();
    }
  });

  test('a database that cannot be opened stops the start with what to do, before listening', async () => {
    const dir = workDir();
    // The configured path is a folder.
    mkdirSync(path.join(dir, 'data', 'analytics.db'), { recursive: true });
    writeFileSync(path.join(dir, 'tollwise.yaml'), NO_PROVIDERS);
    await assert.rejects(
      startIn(dir, captureLog()),
      (error: unknown) =>
        error instanceof StartError &&
        error.message.startsWith(`cannot open the analytics database at ${path.join(dir, 'data', 'analytics.db')}:`) &&
        error.message.endsWith(
          'Fix: set analytics.path to a file in a folder you can write to, or set analytics.enabled to false.',
        ),
    );
  });
});

describe('startup output', () => {
  test('loading node:sqlite prints no ExperimentalWarning, and every other warning still prints', () => {
    const script = [
      `const { loadSqlite } = await import(${JSON.stringify(storeModule)});`,
      'const sqlite = loadSqlite();',
      "new sqlite.DatabaseSync(':memory:').close();",
      "process.emitWarning('an unrelated experimental warning', 'ExperimentalWarning');",
    ].join('\n');
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /SQLite is an experimental feature/);
    assert.match(result.stderr, /ExperimentalWarning: an unrelated experimental warning/);
  });
});
