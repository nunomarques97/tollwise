// Local analytics storage: one row per RequestOutcome, in a SQLite file on this machine.
//
// EventStore is the storage interface the rest of Tollwise depends on; SqliteEventStore is the one
// implementation, on Node's built-in node:sqlite (DatabaseSync). Every node:sqlite call in the product
// lives in this module, so the storage engine can be replaced in one place.
//
// What is stored: request metadata only -- when the request happened, the model and provider asked
// for and the ones used, the capabilities the request needed, the routing policy and decision, the
// routing trace (already redacted when the outcome was built), token counts with where they came from
// (reported by the provider or estimated), cost, baseline and savings with their price dates, latency
// and the final status; since schema 2, also what routing chose from (the candidates with their catalog
// prices and the excluded entries with their reason codes) and the catalog prices of the model used and
// the model requested, each with its verified date and the catalog's public pricing page (source_url);
// since schema 3, whether the request was served by another model than the one it asked for and, when
// it was, the model ids of that substitution and the name of the equivalence group that allowed it.
// There is no column for a prompt, a response, a header or any other URL, and nothing here ever adds
// one: RequestOutcome does not carry them in the first place, and the JSON columns are written field by
// field, so nothing else an object might carry is stored.
//
// When rows are written: record() only queues the outcome and returns. The queue is written on a
// later turn of the event loop (setImmediate), in one transaction per batch. Outcomes are emitted once
// the response has been ended, so the synchronous SQLite write never sits between a provider's answer
// and the client, and a busy server writes many outcomes per transaction.
//
// Failures: a write that fails never reaches the request it describes, or the process. The rows of
// that batch are dropped and a warning is logged with the error class and SQLite result code only
// (never an error message, which could quote a value), at most once a minute with the number of rows
// dropped since the previous warning. A database that cannot be opened is reported at startup by
// AnalyticsStoreError, with what to do about it.
//
// Schema changes: MIGRATIONS is an ordered list of versioned steps. Each one runs once, in its own
// transaction, and is recorded in the schema_migrations table; opening a database applies the steps
// it has not seen yet. A database written by a newer Tollwise (a version above the last step known
// here) is refused rather than modified. Rows are never deleted by Tollwise.
//
// The ExperimentalWarning: Node prints "ExperimentalWarning: SQLite is an experimental feature" on
// stderr the first time node:sqlite is loaded. loadSqlite() loads the module through
// process.getBuiltinModule() with process.emitWarning wrapped for that single synchronous call,
// dropping only an ExperimentalWarning whose message starts with "SQLite"; every other warning passes
// through untouched, and the wrapper is removed before loadSqlite() returns. Node's --no-warnings flag
// is not used, because it would hide every other warning too.

import { closeSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync, SQLInputValue, SQLOutputValue, StatementSync } from 'node:sqlite';
import type { ProviderId, RoutingPolicy } from '../config/schema.ts';
import type { Logger } from '../log/logger.ts';
import type { CostOrigin } from '../pricing/cost.ts';
import type { WireFormat } from '../providers/types.ts';
import type { AttemptRecord, ModelSubstitution } from '../proxy/forward.ts';
import type {
  OutcomeDecision,
  OutcomePrice,
  OutcomePrices,
  OutcomeSelection,
  OutcomeStatus,
  RequestOutcome,
} from '../proxy/outcome.ts';
import type { ExclusionReason } from '../routing/select.ts';

// ---------------------------------------------------------------- the interface

/** Which stored events to read: a half-open time range [since, until), oldest first. */
export interface EventQuery {
  /** Earliest timestamp included. Default: no lower bound. */
  readonly since?: Date;
  /** First timestamp excluded. Default: no upper bound. */
  readonly until?: Date;
  /** Most events returned. Default: no limit. */
  readonly limit?: number;
}

/**
 * A position in the newest-first order of stored events: the timestamp of an event plus the
 * store's own insertion sequence number, which breaks ties between events that share a
 * millisecond. Opaque to callers: pass back exactly what a previous page returned.
 */
export interface EventCursor {
  readonly timestampMs: number;
  readonly sequence: number;
}

/** The substitution of an outcome stored before schema 3, which did not record one either way. */
export const NOT_RECORDED = 'not_recorded';

/**
 * A RequestOutcome as read back from the store. It differs in one field only: `substitution` is
 * NOT_RECORDED for a row stored before schema 3, when whether the model was substituted was not kept.
 * A RequestOutcome is a StoredRequestOutcome, so code reading both takes this type.
 */
export interface StoredRequestOutcome extends Omit<RequestOutcome, 'substitution'> {
  readonly substitution: ModelSubstitution | null | typeof NOT_RECORDED;
}

/** One page of stored events, newest first. */
export interface RecentEventsQuery {
  /** Most events returned; a positive integer. */
  readonly limit: number;
  /** Only events strictly older than this position (a previous page's nextCursor). Default: the newest. */
  readonly before?: EventCursor;
}

export interface RecentEventsPage {
  /** Newest first. */
  readonly events: StoredRequestOutcome[];
  /** The position of the last event on this page; null when no older event exists. */
  readonly nextCursor: EventCursor | null;
}

/**
 * Where request outcomes are kept. Implementations must never let a storage failure reach the caller
 * of record(): it is called from the request path.
 */
export interface EventStore {
  /** Queues one outcome for storage and returns at once. Never throws. Ignored once the store is closed. */
  record(outcome: RequestOutcome): void;
  /** Writes every queued outcome now. Never rejects: a failed write is reported like any other. */
  flush(): Promise<void>;
  /** The stored outcomes in the query's time range, oldest first (queued outcomes are written first). */
  readEvents(query?: EventQuery): Promise<StoredRequestOutcome[]>;
  /**
   * The stored outcomes newest first, one page at a time. Events sharing a timestamp are ordered by
   * insertion, so paging through nextCursor returns every event exactly once.
   */
  readRecentEvents(query: RecentEventsQuery): Promise<RecentEventsPage>;
  /** Writes what is still queued, then releases the storage. Safe to call more than once. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------- node:sqlite, loaded quietly

type SqliteModule = typeof import('node:sqlite');

let sqliteModule: SqliteModule | undefined;

function isSqliteExperimentalWarning(warning: unknown, typeOrOptions: unknown): boolean {
  let type: unknown =
    typeof typeOrOptions === 'string' ? typeOrOptions : (typeOrOptions as { type?: unknown } | null | undefined)?.type;
  let message: unknown = warning;
  if (warning instanceof Error) {
    type ??= warning.name;
    message = warning.message;
  }
  return type === 'ExperimentalWarning' && typeof message === 'string' && message.startsWith('SQLite');
}

/**
 * node:sqlite, loaded without Node's one-time "SQLite is an experimental feature" warning on stderr.
 * Only that warning is dropped, only while the module loads (see the module comment).
 */
export function loadSqlite(): SqliteModule {
  if (sqliteModule !== undefined) return sqliteModule;
  const original = process.emitWarning;
  const filtered = function (this: unknown, warning: unknown, ...rest: unknown[]): void {
    if (isSqliteExperimentalWarning(warning, rest[0])) return;
    Reflect.apply(original, process, [warning, ...rest]);
  };
  process.emitWarning = filtered as typeof process.emitWarning;
  try {
    sqliteModule = process.getBuiltinModule('node:sqlite');
  } finally {
    process.emitWarning = original;
  }
  return sqliteModule;
}

// ---------------------------------------------------------------- schema

/** The table holding one row per request outcome. */
export const EVENTS_TABLE = 'request_events';
/** The table recording which schema versions have been applied. */
export const MIGRATIONS_TABLE = 'schema_migrations';

interface Migration {
  readonly version: number;
  readonly sql: string;
}

/**
 * Every schema version, in order. Never edit a step that has shipped: add a new one. Money amounts
 * are decimal text, exactly as computed, so no rounding happens on the way in; NULL stands for
 * "unknown" (an unpriced baseline, for example).
 */
const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE ${EVENTS_TABLE} (
        id INTEGER PRIMARY KEY,
        timestamp_ms INTEGER NOT NULL,
        request_id TEXT NOT NULL,
        format TEXT NOT NULL,
        requested_model TEXT NOT NULL,
        requested_provider TEXT NOT NULL,
        used_model TEXT,
        used_provider TEXT,
        needs_tools INTEGER NOT NULL,
        needs_json_mode INTEGER NOT NULL,
        needs_vision INTEGER NOT NULL,
        needs_streaming INTEGER NOT NULL,
        policy TEXT NOT NULL,
        decision TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        routing_trace TEXT NOT NULL,
        input_tokens INTEGER,
        cached_input_tokens INTEGER,
        output_tokens INTEGER,
        usage_origin TEXT,
        cost_usd TEXT,
        baseline_usd TEXT,
        savings_usd TEXT,
        cost_origin TEXT,
        used_price_verified_on TEXT,
        baseline_price_verified_on TEXT,
        latency_ms INTEGER NOT NULL,
        first_byte_ms INTEGER,
        status TEXT NOT NULL
      ) STRICT;
      CREATE INDEX ${EVENTS_TABLE}_timestamp ON ${EVENTS_TABLE} (timestamp_ms);
      CREATE INDEX ${EVENTS_TABLE}_provider_timestamp ON ${EVENTS_TABLE} (used_provider, timestamp_ms);
      CREATE INDEX ${EVENTS_TABLE}_model_timestamp ON ${EVENTS_TABLE} (used_model, timestamp_ms);
    `,
  },
  {
    // The routing selection and the catalog price snapshot, as JSON text. NULL on rows written before
    // this step: those read back with selection and price null.
    version: 2,
    sql: `
      ALTER TABLE ${EVENTS_TABLE} ADD COLUMN selection TEXT;
      ALTER TABLE ${EVENTS_TABLE} ADD COLUMN price TEXT;
    `,
  },
  {
    // The model substitution: substituted is 1 when another model than the requested one served (or
    // last failed) the request, 0 when the requested model did; the three substitution_* columns hold
    // its model ids and group name when it is 1, and are NULL otherwise. Every column is NULL on rows
    // written before this step: those read back with substitution NOT_RECORDED.
    version: 3,
    sql: `
      ALTER TABLE ${EVENTS_TABLE} ADD COLUMN substituted INTEGER;
      ALTER TABLE ${EVENTS_TABLE} ADD COLUMN substitution_requested_model TEXT;
      ALTER TABLE ${EVENTS_TABLE} ADD COLUMN substitution_served_model TEXT;
      ALTER TABLE ${EVENTS_TABLE} ADD COLUMN substitution_group TEXT;
    `,
  },
];

/** The schema version this build of Tollwise writes. */
export const SCHEMA_VERSION = MIGRATIONS.reduce((latest, step) => Math.max(latest, step.version), 0);

/** The columns written for each outcome, in insert order (every column but the row id). */
const INSERT_COLUMNS = [
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
] as const;

type InsertColumn = (typeof INSERT_COLUMNS)[number];
type Row = Record<InsertColumn, SQLInputValue>;

const UNKNOWN = 'unknown';

function unknownToNull(value: string): string | null {
  return value === UNKNOWN ? null : value;
}

/**
 * The routing trace as stored: exactly the AttemptRecord fields but the attempt's model substitution,
 * which is not stored (the request's own substitution is, in its columns), and nothing else an object
 * might carry.
 */
function traceText(trace: readonly AttemptRecord[]): string {
  return JSON.stringify(
    trace.map((attempt) => ({
      provider: attempt.provider,
      model: attempt.model,
      outcome: attempt.outcome,
      status: attempt.status,
      duration_ms: attempt.duration_ms,
    })),
  );
}

/** The selection as stored: exactly the OutcomeSelection fields, nothing else an object might carry. */
function selectionText(selection: OutcomeSelection | null): string | null {
  if (selection === null) return null;
  return JSON.stringify({
    considered: selection.considered,
    candidates: selection.candidates.map((candidate) => ({
      provider: candidate.provider,
      model: candidate.model,
      input: candidate.input,
      output: candidate.output,
    })),
    excluded: selection.excluded.map((entry) => ({
      provider: entry.provider,
      model: entry.model,
      reason: entry.reason,
    })),
  });
}

function priceFields(price: OutcomePrice | null): OutcomePrice | null {
  if (price === null) return null;
  return { input: price.input, output: price.output, verified_on: price.verified_on, source_url: price.source_url };
}

/** The prices as stored: exactly the OutcomePrices fields, nothing else an object might carry. */
function priceText(price: OutcomePrices | null): string | null {
  if (price === null) return null;
  return JSON.stringify({ used: priceFields(price.used), requested: priceFields(price.requested) });
}

function toRow(outcome: RequestOutcome): Row {
  const parsed = Date.parse(outcome.timestamp);
  const { usage, cost, substitution } = outcome;
  return {
    timestamp_ms: Number.isFinite(parsed) ? parsed : Date.now(),
    request_id: outcome.requestId,
    format: outcome.format,
    requested_model: outcome.requestedModel,
    requested_provider: outcome.requestedProvider,
    used_model: outcome.usedModel,
    used_provider: outcome.usedProvider,
    needs_tools: outcome.needs.tools ? 1 : 0,
    needs_json_mode: outcome.needs.json_mode ? 1 : 0,
    needs_vision: outcome.needs.vision ? 1 : 0,
    needs_streaming: outcome.needs.streaming ? 1 : 0,
    policy: outcome.policy,
    decision: outcome.decision,
    attempts: outcome.attempts,
    routing_trace: traceText(outcome.trace),
    input_tokens: usage?.input ?? null,
    cached_input_tokens: usage?.cached_input ?? null,
    output_tokens: usage?.output ?? null,
    usage_origin: usage?.origin ?? null,
    cost_usd: cost?.cost_usd ?? null,
    baseline_usd: cost === null ? null : unknownToNull(cost.baseline_usd),
    savings_usd: cost === null ? null : unknownToNull(cost.savings_usd),
    cost_origin: cost?.origin ?? null,
    used_price_verified_on: cost?.used_price_verified_on ?? null,
    baseline_price_verified_on: cost === null ? null : unknownToNull(cost.baseline_price_verified_on),
    latency_ms: outcome.latencyMs,
    first_byte_ms: outcome.firstByteMs,
    status: outcome.status,
    selection: selectionText(outcome.selection),
    price: priceText(outcome.price),
    // Only the two model ids (already masked, see buildRequestOutcome) and the group name are stored.
    substituted: substitution === null ? 0 : 1,
    substitution_requested_model: substitution?.requested_model ?? null,
    substitution_served_model: substitution?.served_model ?? null,
    substitution_group: substitution?.group ?? null,
  };
}

type StoredRow = Record<string, SQLOutputValue>;

function text(value: SQLOutputValue | undefined): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

function nullableText(value: SQLOutputValue | undefined): string | null {
  return value === null || value === undefined ? null : text(value);
}

function count(value: SQLOutputValue | undefined): number {
  return typeof value === 'number' ? value : Number(value ?? 0);
}

/** The stored trace; an attempt's model substitution is not stored, so every attempt reads back with it null. */
function readTrace(value: SQLOutputValue | undefined): AttemptRecord[] {
  try {
    const parsed: unknown = JSON.parse(text(value));
    return Array.isArray(parsed)
      ? (parsed as Omit<AttemptRecord, 'substitution'>[]).map((attempt) => ({ ...attempt, substitution: null }))
      : [];
  } catch {
    return [];
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A stored JSON column parsed to an object; null when the column is NULL or not a JSON object. */
function readJsonObject(value: SQLOutputValue | undefined): Record<string, unknown> | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function list(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function readSelection(value: SQLOutputValue | undefined): OutcomeSelection | null {
  const stored = readJsonObject(value);
  if (stored === null) return null;
  return {
    considered: typeof stored.considered === 'number' ? stored.considered : 0,
    candidates: list(stored.candidates).map((candidate) => ({
      provider: String(candidate.provider) as ProviderId,
      model: String(candidate.model),
      input: nullableNumber(candidate.input),
      output: nullableNumber(candidate.output),
    })),
    excluded: list(stored.excluded).map((entry) => ({
      provider: String(entry.provider) as ProviderId,
      model: String(entry.model),
      reason: String(entry.reason) as ExclusionReason,
    })),
  };
}

function readPriceFields(value: unknown): OutcomePrice | null {
  if (!isObject(value)) return null;
  return {
    input: typeof value.input === 'number' ? value.input : 0,
    output: typeof value.output === 'number' ? value.output : 0,
    verified_on: String(value.verified_on),
    source_url: String(value.source_url),
  };
}

function readPrice(value: SQLOutputValue | undefined): OutcomePrices | null {
  const stored = readJsonObject(value);
  if (stored === null) return null;
  return { used: readPriceFields(stored.used), requested: readPriceFields(stored.requested) };
}

function readSubstitution(row: StoredRow): ModelSubstitution | null | typeof NOT_RECORDED {
  if (row.substituted === null || row.substituted === undefined) return NOT_RECORDED;
  if (row.substituted !== 1) return null;
  return {
    requested_model: text(row.substitution_requested_model),
    served_model: text(row.substitution_served_model),
    group: text(row.substitution_group),
  };
}

function fromRow(row: StoredRow): StoredRequestOutcome {
  const usageOrigin = nullableText(row.usage_origin);
  const costUsd = nullableText(row.cost_usd);
  return {
    timestamp: new Date(count(row.timestamp_ms)).toISOString(),
    requestId: text(row.request_id),
    format: text(row.format) as WireFormat,
    requestedModel: text(row.requested_model),
    requestedProvider: text(row.requested_provider) as ProviderId,
    usedModel: nullableText(row.used_model),
    usedProvider: nullableText(row.used_provider) as ProviderId | null,
    needs: {
      tools: row.needs_tools === 1,
      json_mode: row.needs_json_mode === 1,
      vision: row.needs_vision === 1,
      streaming: row.needs_streaming === 1,
    },
    policy: text(row.policy) as RoutingPolicy,
    decision: text(row.decision) as OutcomeDecision,
    attempts: count(row.attempts),
    trace: readTrace(row.routing_trace),
    usage:
      usageOrigin === null
        ? null
        : {
            input: count(row.input_tokens),
            cached_input: count(row.cached_input_tokens),
            output: count(row.output_tokens),
            origin: usageOrigin as CostOrigin,
          },
    cost:
      costUsd === null
        ? null
        : {
            cost_usd: costUsd as `${number}`,
            baseline_usd: (nullableText(row.baseline_usd) ?? UNKNOWN) as `${number}` | 'unknown',
            savings_usd: (nullableText(row.savings_usd) ?? UNKNOWN) as `${number}` | 'unknown',
            origin: text(row.cost_origin) as CostOrigin,
            used_price_verified_on: text(row.used_price_verified_on),
            baseline_price_verified_on: nullableText(row.baseline_price_verified_on) ?? UNKNOWN,
          },
    latencyMs: count(row.latency_ms),
    firstByteMs: row.first_byte_ms === null || row.first_byte_ms === undefined ? null : count(row.first_byte_ms),
    status: text(row.status) as OutcomeStatus,
    selection: readSelection(row.selection),
    price: readPrice(row.price),
    substitution: readSubstitution(row),
  };
}

// ---------------------------------------------------------------- errors

/** The database cannot be opened or brought to the current schema. The message says what to do. */
export class AnalyticsStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalyticsStoreError';
  }
}

/** SQLite primary result codes this module explains in words. */
const SQLITE_BUSY = 5;
const SQLITE_READONLY = 8;
const SQLITE_IOERR = 10;
const SQLITE_CORRUPT = 11;
const SQLITE_FULL = 13;
const SQLITE_CANTOPEN = 14;
const SQLITE_NOTADB = 26;
const SQLITE_PERM = 3;

/** The SQLite primary result code carried by a node:sqlite error, if any. */
function sqliteCode(error: unknown): number | undefined {
  const errcode = (error as { errcode?: unknown } | null)?.errcode;
  return typeof errcode === 'number' ? errcode & 0xff : undefined;
}

/** The error's class name only: never its message, which may quote a value. */
function errorClass(error: unknown): string {
  if (error instanceof Error) return error.name;
  return typeof error;
}

function openFailureReason(error: unknown): string {
  const fsCode = (error as { code?: unknown } | null)?.code;
  if (fsCode === 'EACCES' || fsCode === 'EPERM') return 'permission denied';
  if (fsCode === 'ENOTDIR' || fsCode === 'EEXIST') return 'a part of the path is a file, not a folder';
  if (fsCode === 'EISDIR') return 'the path is a folder, not a file';
  switch (sqliteCode(error)) {
    case SQLITE_NOTADB:
    case SQLITE_CORRUPT:
      return 'the file exists but is not a readable SQLite database';
    case SQLITE_CANTOPEN:
      return 'the file cannot be opened (the path may be a folder, or the folder may not be writable)';
    case SQLITE_READONLY:
    case SQLITE_PERM:
      return 'the file is read-only';
    case SQLITE_BUSY:
      return 'the database is locked by another program';
    case SQLITE_FULL:
      return 'the disk is full';
    case SQLITE_IOERR:
      return 'a disk read or write failed';
    default: {
      const code = sqliteCode(error) ?? (typeof fsCode === 'string' ? fsCode : undefined);
      return `unexpected ${errorClass(error)}${code === undefined ? '' : ` (${code})`}`;
    }
  }
}

const OPEN_FIX = 'Fix: set analytics.path to a file in a folder you can write to, or set analytics.enabled to false';

// ---------------------------------------------------------------- opening and migrating

function applyMigrations(db: DatabaseSync, file: string): void {
  db.exec(`CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`);
  const row = db.prepare(`SELECT MAX(version) AS version FROM ${MIGRATIONS_TABLE}`).get();
  const current = typeof row?.version === 'number' ? row.version : 0;
  if (current > SCHEMA_VERSION) {
    throw new AnalyticsStoreError(
      `cannot open the analytics database at ${file}: it was written by a newer version of Tollwise (schema ${current}; this version understands up to ${SCHEMA_VERSION}). ` +
        'Fix: upgrade Tollwise, or set analytics.path to another file.',
    );
  }
  const record = db.prepare(`INSERT INTO ${MIGRATIONS_TABLE} (version, applied_at) VALUES (?, ?)`);
  for (const step of MIGRATIONS) {
    if (step.version <= current) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(step.sql);
      record.run(step.version, new Date().toISOString());
      db.exec('COMMIT');
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  }
}

/** Creates the folder (owner-only when Tollwise creates it) and an empty owner-only file when missing. */
function prepareFile(file: string): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    closeSync(openSync(file, 'wx', 0o600));
  } catch (error) {
    // Already there: SQLite opens it as it is. Anything else is reported by the open that follows.
    if ((error as { code?: unknown }).code !== 'EEXIST') throw error;
  }
}

export interface OpenSqliteEventStoreOptions {
  /** The database file, absolute or relative to the current directory. Its folder is created if missing. */
  readonly file: string;
  /** Where a failed write is reported (error class and result code only). */
  readonly logger: Logger;
}

/** Opens (or creates) the analytics database and brings it to the current schema. Throws AnalyticsStoreError. */
export function openSqliteEventStore(options: OpenSqliteEventStoreOptions): SqliteEventStore {
  const file = path.resolve(options.file);
  let db: DatabaseSync | undefined;
  try {
    prepareFile(file);
    const { DatabaseSync } = loadSqlite();
    db = new DatabaseSync(file, { timeout: 1000 });
    // Write-ahead logging: readers never block the writer; NORMAL sync is durable across a crash of
    // Tollwise (a power loss can lose only the last moments of metadata, never corrupt the file).
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    applyMigrations(db, file);
    return new SqliteEventStore(db, options.logger);
  } catch (error) {
    try {
      db?.close();
    } catch {
      // Closing is best effort here: the open failure below is the one to report.
    }
    if (error instanceof AnalyticsStoreError) throw error;
    throw new AnalyticsStoreError(
      `cannot open the analytics database at ${file}: ${openFailureReason(error)}. ${OPEN_FIX}.`,
    );
  }
}

// ---------------------------------------------------------------- the SQLite store

/** Shortest time between two "analytics write failed" warnings. */
export const WRITE_FAILURE_WARNING_INTERVAL_MS = 60_000;

export class SqliteEventStore implements EventStore {
  readonly #db: DatabaseSync;
  readonly #logger: Logger;
  readonly #insert: StatementSync;
  #pending: RequestOutcome[] = [];
  #scheduled: NodeJS.Immediate | undefined;
  #closed = false;
  #lastWarningAt = Number.NEGATIVE_INFINITY;
  #droppedSinceWarning = 0;

  /** Use openSqliteEventStore(): it creates the file and applies the migrations first. */
  constructor(db: DatabaseSync, logger: Logger) {
    this.#db = db;
    this.#logger = logger;
    this.#insert = db.prepare(
      `INSERT INTO ${EVENTS_TABLE} (${INSERT_COLUMNS.join(', ')}) VALUES (${INSERT_COLUMNS.map((name) => `:${name}`).join(', ')})`,
    );
  }

  record(outcome: RequestOutcome): void {
    if (this.#closed) return;
    this.#pending.push(outcome);
    this.#scheduled ??= setImmediate(() => {
      this.#scheduled = undefined;
      this.#writePending();
    });
  }

  async flush(): Promise<void> {
    this.#writePending();
  }

  async readEvents(query: EventQuery = {}): Promise<StoredRequestOutcome[]> {
    this.#writePending();
    if (this.#closed) return [];
    const since = query.since?.getTime() ?? Number.MIN_SAFE_INTEGER;
    const until = query.until?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const limit = query.limit ?? -1;
    const rows = this.#db
      .prepare(
        `SELECT ${INSERT_COLUMNS.join(', ')} FROM ${EVENTS_TABLE} ` +
          'WHERE timestamp_ms >= ? AND timestamp_ms < ? ORDER BY timestamp_ms, id LIMIT ?',
      )
      .all(since, until, limit);
    return rows.map((row) => fromRow(row));
  }

  async readRecentEvents(query: RecentEventsQuery): Promise<RecentEventsPage> {
    this.#writePending();
    if (this.#closed) return { events: [], nextCursor: null };
    if (!Number.isSafeInteger(query.limit) || query.limit < 1) {
      throw new RangeError(`readRecentEvents expects a positive integer limit, got ${String(query.limit)}`);
    }
    const before = query.before ?? { timestampMs: Number.MAX_SAFE_INTEGER, sequence: Number.MAX_SAFE_INTEGER };
    // One row more than the page, only to learn whether anything older exists.
    const rows = this.#db
      .prepare(
        `SELECT id, ${INSERT_COLUMNS.join(', ')} FROM ${EVENTS_TABLE} ` +
          'WHERE timestamp_ms < ? OR (timestamp_ms = ? AND id < ?) ' +
          'ORDER BY timestamp_ms DESC, id DESC LIMIT ?',
      )
      .all(before.timestampMs, before.timestampMs, before.sequence, query.limit + 1);
    const pageRows = rows.slice(0, query.limit);
    const last = pageRows[pageRows.length - 1];
    const nextCursor =
      rows.length > query.limit && last !== undefined
        ? { timestampMs: count(last.timestamp_ms), sequence: count(last.id) }
        : null;
    return { events: pageRows.map((row) => fromRow(row)), nextCursor };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#writePending();
    this.#closed = true;
    if (this.#scheduled !== undefined) clearImmediate(this.#scheduled);
    this.#scheduled = undefined;
    try {
      this.#db.close();
    } catch (error) {
      this.#logger.warn('analytics database did not close cleanly', { error: errorClass(error) });
    }
  }

  /** Writes the queue in one transaction. Never throws: it runs outside any request. */
  #writePending(): void {
    if (this.#closed || this.#pending.length === 0) return;
    const batch = this.#pending;
    this.#pending = [];
    let failed = 0;
    let firstError: unknown;
    try {
      this.#db.exec('BEGIN');
      for (const outcome of batch) {
        try {
          this.#insert.run(toRow(outcome));
        } catch (error) {
          failed += 1;
          firstError ??= error;
        }
      }
      this.#db.exec('COMMIT');
    } catch (error) {
      failed = batch.length;
      firstError = error;
      try {
        if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
      } catch {
        // Nothing more can be done for this batch; the warning below reports it.
      }
    }
    if (failed > 0) this.#reportFailure(firstError, failed);
  }

  #reportFailure(error: unknown, dropped: number): void {
    this.#droppedSinceWarning += dropped;
    const now = Date.now();
    if (now - this.#lastWarningAt < WRITE_FAILURE_WARNING_INTERVAL_MS) return;
    this.#lastWarningAt = now;
    const code = sqliteCode(error);
    try {
      this.#logger.warn('analytics write failed; request metadata was not stored', {
        error: errorClass(error),
        ...(code === undefined ? {} : { sqliteCode: code }),
        dropped: this.#droppedSinceWarning,
      });
    } catch {
      // The logger never throws; this only keeps the no-throw promise of #writePending().
    }
    this.#droppedSinceWarning = 0;
  }
}
