// Metrics queries over the local event store (src/analytics/store.ts): the numbers the dashboard
// shows, computed from RequestOutcome rows already on disk. Every function here takes an EventStore
// and reads through its public interface only (readEvents() and readRecentEvents()); nothing in this module touches SQL or
// node:sqlite directly, so it works unchanged against any EventStore implementation.
//
// Money: every USD amount an EventStore row carries (cost_usd, baseline_usd, savings_usd) is a
// fixed-decimal string produced by src/pricing/cost.ts's formatUsd(). Summing them as JavaScript
// numbers would reintroduce the rounding error that module exists to avoid, so every sum here first
// parses each amount back to an integer number of micro-dollars (parseUsdMicros()), adds those
// integers, and renders the total once at the end.
//
// A missing price is never counted as $0. Every event falls in exactly one of three pricing
// classes (see pricingOf()):
//   - priced: it carries a cost. Its cost counts towards spend. Its baseline and savings count only
//     when the requested model has a catalog price; otherwise the event is left out of those sums
//     and counted in unknown_savings_requests.
//   - unpriced: it was served (status 'complete') or the provider reported usage for it, but it has
//     no cost -- typically because the model it was sent to has no catalog price. It is left out of
//     spend, baseline and savings alike, and counted in both unpriced_requests and
//     unknown_savings_requests.
//   - unbilled: it was never served and nothing reported usage for it (refused, or failed before any
//     usage was known). No provider is known to have charged for it, so it adds nothing to any sum.
// Every aggregate reports those counts next to its totals, and a total is the literal string
// 'unknown' rather than "0.000000" when nothing at all could be summed while events were left out,
// so a dashboard can tell "no requests" from "no known price" from "zero spend or savings".
// A stored amount that is not a well-formed decimal with at most 6 places is treated as missing
// (the event becomes unpriced, or its savings unknown) rather than failing the whole query.

import type { RoutingPolicy } from '../config/schema.ts';
import { percentile } from '../health/monitor.ts';
import { type CostAmount, type CostOrigin, formatUsd, MICROS_PER_DOLLAR } from '../pricing/cost.ts';
import type { WireFormat } from '../providers/types.ts';
import type { AttemptRecord, ModelSubstitution } from '../proxy/forward.ts';
import type { OutcomeDecision, OutcomePrices, OutcomeSelection, OutcomeStatus } from '../proxy/outcome.ts';
import type { RequestNeeds } from '../routing/inspect.ts';
import { type EventCursor, type EventStore, NOT_RECORDED, type StoredRequestOutcome } from './store.ts';

/** A metrics query the caller got wrong: an invalid cursor, or a range and bucket pair that is too fine. */
export class MetricsQueryError extends Error {
  override name = 'MetricsQueryError';
}

// ---------------------------------------------------------------- money helpers

const USD_DECIMALS = 6;

/** Parses a decimal USD string (at most 6 places, as formatUsd() writes) to whole micro-dollars; null if malformed. */
function parseUsdMicros(amount: string): number | null {
  const match = /^(-?)(\d+)(?:\.(\d{1,6}))?$/.exec(amount);
  if (match === null) return null;
  const whole = Number(match[2]);
  const fraction = Number((match[3] ?? '').padEnd(USD_DECIMALS, '0'));
  const micros = whole * MICROS_PER_DOLLAR + fraction;
  if (!Number.isSafeInteger(micros)) return null;
  return match[1] === '-' ? -micros : micros;
}

type Pricing =
  | { readonly kind: 'unbilled' }
  | { readonly kind: 'unpriced' }
  | {
      readonly kind: 'priced';
      readonly costMicros: number;
      /** Both null when the requested model has no catalog price (or a stored amount is malformed). */
      readonly baselineMicros: number | null;
      readonly savingsMicros: number | null;
    };

/** Which pricing class an event is in; see the module comment. */
function pricingOf(event: StoredRequestOutcome): Pricing {
  if (event.cost === null) {
    return event.usage !== null || event.status === 'complete' ? { kind: 'unpriced' } : { kind: 'unbilled' };
  }
  const costMicros = parseUsdMicros(event.cost.cost_usd);
  if (costMicros === null) return { kind: 'unpriced' };
  const baselineMicros = event.cost.baseline_usd === 'unknown' ? null : parseUsdMicros(event.cost.baseline_usd);
  const savingsMicros = event.cost.savings_usd === 'unknown' ? null : parseUsdMicros(event.cost.savings_usd);
  if (baselineMicros === null || savingsMicros === null) {
    return { kind: 'priced', costMicros, baselineMicros: null, savingsMicros: null };
  }
  return { kind: 'priced', costMicros, baselineMicros, savingsMicros };
}

/** Running money totals for a set of events, with the counts of what was left out. */
class MoneyTotals {
  pricedRequests = 0;
  unpricedRequests = 0;
  knownBaselineRequests = 0;
  unknownSavingsRequests = 0;
  spendMicros = 0;
  baselineMicros = 0;
  savingsMicros = 0;

  add(event: StoredRequestOutcome): void {
    const pricing = pricingOf(event);
    if (pricing.kind === 'unbilled') return;
    if (pricing.kind === 'unpriced') {
      this.unpricedRequests += 1;
      this.unknownSavingsRequests += 1;
      return;
    }
    this.pricedRequests += 1;
    this.spendMicros += pricing.costMicros;
    if (pricing.baselineMicros === null || pricing.savingsMicros === null) {
      this.unknownSavingsRequests += 1;
      return;
    }
    this.knownBaselineRequests += 1;
    this.baselineMicros += pricing.baselineMicros;
    this.savingsMicros += pricing.savingsMicros;
  }

  /** The priced spend; 'unknown' when events were served but none of them could be priced. */
  spend(): CostAmount {
    return this.pricedRequests === 0 && this.unpricedRequests > 0 ? 'unknown' : formatUsd(this.spendMicros);
  }

  /** The known baseline; 'unknown' when events were left out and none had a known baseline. */
  baseline(): CostAmount {
    return this.knownBaselineRequests === 0 && this.unknownSavingsRequests > 0
      ? 'unknown'
      : formatUsd(this.baselineMicros);
  }

  /** The known savings; 'unknown' under the same condition as baseline(). */
  savings(): CostAmount {
    return this.knownBaselineRequests === 0 && this.unknownSavingsRequests > 0
      ? 'unknown'
      : formatUsd(this.savingsMicros);
  }

  savingsPercent(): number | null {
    if (this.knownBaselineRequests === 0 || this.baselineMicros === 0) return null;
    return Math.round((this.savingsMicros / this.baselineMicros) * 10_000) / 100;
  }
}

// ---------------------------------------------------------------- time ranges

/** The fixed set of ranges every metrics query accepts, measured back from `now`. */
export type MetricsRange = '1h' | '24h' | '7d' | '30d';

const RANGE_MS: Record<MetricsRange, number> = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

export interface MetricsOptions {
  /** The current time. Default: Date.now(). Tests pass a fixed clock for a deterministic window. */
  readonly now?: () => Date;
}

function currentTime(options: MetricsOptions): Date {
  return options.now === undefined ? new Date() : options.now();
}

function rangeWindow(range: MetricsRange, until: Date): { readonly since: Date; readonly until: Date } {
  return { since: new Date(until.getTime() - RANGE_MS[range]), until };
}

// ---------------------------------------------------------------- summary

/** How many events in the window carried each kind of usage; events with no usage at all are in neither. */
export interface OriginSplit {
  readonly reported: number;
  readonly estimated: number;
}

export interface Summary {
  /** Every event in the window, served or not. */
  readonly requests: number;
  /** Events whose status is not 'complete' (provider errors, interruptions, aborts, refusals). */
  readonly errors: number;
  /**
   * Sum of what every priced event cost. A lower bound when unpriced_requests > 0; 'unknown' when
   * events were served but none could be priced.
   */
  readonly spend_usd: CostAmount;
  /** Served events with no price (the model they were sent to has no catalog price): not in spend_usd. */
  readonly unpriced_requests: number;
  /** Sum of the baseline cost of events whose requested model has a catalog price; 'unknown' when none do. */
  readonly baseline_usd: CostAmount;
  /** Sum of the savings of the same events as baseline_usd; 'unknown' under the same condition. */
  readonly savings_usd: CostAmount;
  /** savings_usd as a percentage of baseline_usd, rounded to 2 decimals; null when baseline_usd is 'unknown' or 0. */
  readonly savings_percent: number | null;
  /** Events left out of baseline_usd/savings_usd: unknown baseline price, or unpriced (see unpriced_requests). */
  readonly unknown_savings_requests: number;
  readonly origin: OriginSplit;
  /**
   * The oldest and newest catalog verified_on dates (YYYY-MM-DD) of the prices behind spend_usd,
   * baseline_usd and savings_usd: the served model's price of every priced event and, when known, the
   * requested model's price. null when no event in the window was priced.
   */
  readonly prices_verified_on: PriceDates | null;
  /**
   * Events served (or last failed) by another model than the one requested, which only an equivalence
   * group turned on in the configuration allows. Rows stored before substitutions were recorded are
   * not counted.
   */
  readonly substituted_requests: number;
}

/** A span of catalog verified_on dates, both ends inclusive; equal when every price was checked the same day. */
export interface PriceDates {
  readonly oldest: string;
  readonly newest: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Collects the oldest and newest well-formed ISO dates it is given; anything else is ignored. */
class DateSpan {
  private oldest: string | undefined;
  private newest: string | undefined;

  add(date: string): void {
    if (!ISO_DATE.test(date)) return;
    // ISO calendar dates of the same length sort as strings in date order.
    if (this.oldest === undefined || date < this.oldest) this.oldest = date;
    if (this.newest === undefined || date > this.newest) this.newest = date;
  }

  result(): PriceDates | null {
    return this.oldest === undefined || this.newest === undefined ? null : { oldest: this.oldest, newest: this.newest };
  }
}

/** Whether another model than the requested one served the event; null for a row that did not record it. */
function substitutedOf(event: StoredRequestOutcome): boolean | null {
  return event.substitution === NOT_RECORDED ? null : event.substitution !== null;
}

/** Aggregates every EventStore row in `range` (ending at `options.now`, default the real clock). */
export async function summary(store: EventStore, range: MetricsRange, options: MetricsOptions = {}): Promise<Summary> {
  const { since, until } = rangeWindow(range, currentTime(options));
  const events = await store.readEvents({ since, until });

  const money = new MoneyTotals();
  const priceDates = new DateSpan();
  let errors = 0;
  let reported = 0;
  let estimated = 0;
  let substituted = 0;

  for (const event of events) {
    if (event.status !== 'complete') errors += 1;
    if (substitutedOf(event) === true) substituted += 1;
    if (event.usage !== null) {
      if (event.usage.origin === 'reported') reported += 1;
      else estimated += 1;
    }
    money.add(event);
    const pricing = pricingOf(event);
    if (pricing.kind === 'priced' && event.cost !== null) {
      priceDates.add(event.cost.used_price_verified_on);
      if (pricing.baselineMicros !== null) priceDates.add(event.cost.baseline_price_verified_on);
    }
  }

  return {
    requests: events.length,
    errors,
    spend_usd: money.spend(),
    unpriced_requests: money.unpricedRequests,
    baseline_usd: money.baseline(),
    savings_usd: money.savings(),
    savings_percent: money.savingsPercent(),
    unknown_savings_requests: money.unknownSavingsRequests,
    origin: { reported, estimated },
    prices_verified_on: priceDates.result(),
    substituted_requests: substituted,
  };
}

// ---------------------------------------------------------------- timeseries

/** The bucket widths a timeseries can be grouped into. */
export type TimeseriesBucketSize = '1m' | '5m' | '1h' | '1d';

const BUCKET_MS: Record<TimeseriesBucketSize, number> = {
  '1m': 60 * 1000,
  '5m': 5 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
};

/**
 * The most buckets one timeseries returns. Enough for every range at a sensible width (24h by the
 * minute is 1,440); a finer pair, such as 30d by the minute, is refused with a MetricsQueryError.
 */
export const MAX_TIMESERIES_BUCKETS = 1500;

export interface TimeseriesBucket {
  /** The bucket's start (UTC, aligned to the Unix epoch: '1d' buckets are UTC days). */
  readonly bucket_start: string;
  readonly requests: number;
  readonly errors: number;
  /** Same rule as Summary.spend_usd, for this bucket. */
  readonly spend_usd: CostAmount;
  readonly unpriced_requests: number;
  /** Same rule as Summary.savings_usd, for this bucket. */
  readonly savings_usd: CostAmount;
  readonly unknown_savings_requests: number;
}

/**
 * Aggregates `range` into fixed-width buckets of `bucket` size, oldest first. Buckets are aligned
 * to the Unix epoch in UTC, so the first one may start before the range does.
 */
export async function timeseries(
  store: EventStore,
  range: MetricsRange,
  bucket: TimeseriesBucketSize,
  options: MetricsOptions = {},
): Promise<TimeseriesBucket[]> {
  const { since, until } = rangeWindow(range, currentTime(options));
  const bucketMs = BUCKET_MS[bucket];
  const firstBucketStart = Math.floor(since.getTime() / bucketMs) * bucketMs;
  const bucketCount = Math.max(1, Math.ceil((until.getTime() - firstBucketStart) / bucketMs));
  if (bucketCount > MAX_TIMESERIES_BUCKETS) {
    throw new MetricsQueryError(
      `a ${range} range in ${bucket} buckets would return ${bucketCount} buckets; the most is ${MAX_TIMESERIES_BUCKETS}`,
    );
  }

  const events = await store.readEvents({ since, until });
  const buckets = Array.from({ length: bucketCount }, () => ({ requests: 0, errors: 0, money: new MoneyTotals() }));

  for (const event of events) {
    const target = buckets[Math.floor((Date.parse(event.timestamp) - firstBucketStart) / bucketMs)];
    if (target === undefined) continue; // Defensive: readEvents() already filtered to [since, until).
    target.requests += 1;
    if (event.status !== 'complete') target.errors += 1;
    target.money.add(event);
  }

  return buckets.map((acc, index) => ({
    bucket_start: new Date(firstBucketStart + index * bucketMs).toISOString(),
    requests: acc.requests,
    errors: acc.errors,
    spend_usd: acc.money.spend(),
    unpriced_requests: acc.money.unpricedRequests,
    savings_usd: acc.money.savings(),
    unknown_savings_requests: acc.money.unknownSavingsRequests,
  }));
}

// ---------------------------------------------------------------- breakdown

/**
 * Which field an event is grouped by: the provider or the model id that actually served it. Grouping
 * by model uses the model id alone, so one model id served by two providers is a single group.
 */
export type BreakdownDimension = 'provider' | 'model';

export interface BreakdownGroup {
  /** The provider id or model id this group is for. */
  readonly key: string;
  readonly requests: number;
  /** Same rule as Summary.spend_usd, for this group. */
  readonly spend_usd: CostAmount;
  readonly unpriced_requests: number;
  readonly latency_p50_ms: number;
  readonly latency_p95_ms: number;
}

export interface BreakdownResult {
  /** One entry per distinct value of `by`: known spend descending, groups with 'unknown' spend last. */
  readonly groups: readonly BreakdownGroup[];
  /** Events with no served provider/model (refused before or during routing) -- never a fabricated group. */
  readonly unrouted_requests: number;
}

/** Groups every served event in `range` by provider or model, with spend and latency percentiles. */
export async function breakdown(
  store: EventStore,
  range: MetricsRange,
  by: BreakdownDimension,
  options: MetricsOptions = {},
): Promise<BreakdownResult> {
  const { since, until } = rangeWindow(range, currentTime(options));
  const events = await store.readEvents({ since, until });

  const groups = new Map<string, { requests: number; money: MoneyTotals; latencies: number[] }>();
  let unrouted = 0;

  for (const event of events) {
    const key = by === 'provider' ? event.usedProvider : event.usedModel;
    if (key === null) {
      unrouted += 1;
      continue;
    }
    let group = groups.get(key);
    if (group === undefined) {
      group = { requests: 0, money: new MoneyTotals(), latencies: [] };
      groups.set(key, group);
    }
    group.requests += 1;
    group.money.add(event);
    group.latencies.push(event.latencyMs);
  }

  const ranked = [...groups.entries()].map(([key, group]) => {
    const sorted = [...group.latencies].sort((a, b) => a - b);
    const spend = group.money.spend();
    const entry: BreakdownGroup = {
      key,
      requests: group.requests,
      spend_usd: spend,
      unpriced_requests: group.money.unpricedRequests,
      latency_p50_ms: percentile(sorted, 50),
      latency_p95_ms: percentile(sorted, 95),
    };
    return { sortMicros: spend === 'unknown' ? Number.NEGATIVE_INFINITY : group.money.spendMicros, entry };
  });
  ranked.sort((a, b) => {
    if (a.sortMicros !== b.sortMicros) return a.sortMicros < b.sortMicros ? 1 : -1;
    return a.entry.key.localeCompare(b.entry.key);
  });

  return { groups: ranked.map((ranking) => ranking.entry), unrouted_requests: unrouted };
}

// ---------------------------------------------------------------- recent

/** The largest `limit` recent() accepts; a larger request is silently clamped to this. */
export const MAX_RECENT_LIMIT = 200;
/** recent()'s limit when the caller does not name one (or names something that is not a number). */
export const DEFAULT_RECENT_LIMIT = 50;

export interface RecentQuery {
  /**
   * At most this many events. Default: DEFAULT_RECENT_LIMIT. A fraction is truncated, the result
   * clamped to [1, MAX_RECENT_LIMIT]; NaN or an infinite value falls back to the default.
   */
  readonly limit?: number;
  /** Only events older than this cursor: a previous page's nextCursor, passed back unchanged. */
  readonly before?: string;
}

/** Where a recent event was routed and why -- the fields recent() needs, not the whole RequestOutcome. */
export interface RecentRoute {
  readonly format: WireFormat;
  readonly requestedModel: string;
  readonly requestedProvider: string;
  readonly usedModel: string | null;
  readonly usedProvider: string | null;
  readonly policy: RoutingPolicy;
  readonly decision: OutcomeDecision;
}

/** The token counts recent() exposes: RequestOutcomeUsage without its origin (see RecentEntry.origin). */
export interface RecentUsage {
  readonly input: number;
  readonly output: number;
}

/** One routing trace attempt as the local API returns it. */
export type RecentAttempt = Omit<AttemptRecord, 'substitution'>;

export interface RecentEntry {
  readonly requestId: string;
  readonly timestamp: string;
  readonly status: OutcomeStatus;
  readonly route: RecentRoute;
  /** A one-line, human-readable account of the routing decision, derived only from stored fields. */
  readonly reason: string;
  /** null when the event has no price (refused before any provider call, or its model has no catalog price). */
  readonly cost_usd: CostAmount | null;
  readonly savings_usd: CostAmount | null;
  /**
   * Each attempt without its model substitution, which is not stored (the request's own substitution
   * is, see `substitution` below): a live event and the stored row of the same request read alike.
   */
  readonly trace: readonly RecentAttempt[];
  /** Milliseconds from the request arriving to the response ending. */
  readonly latency_ms: number;
  /** Milliseconds to a streamed response's first byte; null for a non-streamed, failed or refused request. */
  readonly first_byte_ms: number | null;
  /**
   * Where the usage behind the cost came from: the cost's own origin, else the usage's when there is
   * no cost, else null (no usage was ever known, e.g. a refused request).
   */
  readonly origin: CostOrigin | null;
  /** What the requested model would have cost at its catalog price; 'unknown' when not known; null when there is no cost at all. */
  readonly baseline_usd: CostAmount | null;
  /** Token counts, without their origin (see `origin` above); null when no usage was ever known. */
  readonly usage: RecentUsage | null;
  readonly needs: RequestNeeds;
  /** The catalog prices at routing time, unchanged from the stored outcome; see OutcomePrices. */
  readonly price: OutcomePrices | null;
  /** What routing chose from, unchanged from the stored outcome; null for a row stored before schema 2. */
  readonly selection: OutcomeSelection | null;
  /**
   * True when another model than the requested one served (or last failed) the request, false when
   * the requested model did (on any provider, or the request was refused); null for a row stored
   * before substitutions were recorded.
   */
  readonly substituted: boolean | null;
  /** The substitution when `substituted` is true: the model asked for, the model sent and the group; else null. */
  readonly substitution: ModelSubstitution | null;
}

export interface RecentPage {
  /** Newest first. */
  readonly entries: readonly RecentEntry[];
  /**
   * An opaque cursor: pass it as the next call's `before` to keep paging backwards. null once
   * nothing older exists. Events that share a millisecond are ordered by when they were stored, so
   * paging never skips or repeats one.
   */
  readonly nextCursor: string | null;
}

function encodeCursor(cursor: EventCursor): string {
  return `${cursor.timestampMs}-${cursor.sequence}`;
}

function decodeCursor(cursor: string): EventCursor {
  const match = /^(\d{1,16})-(\d{1,16})$/.exec(cursor);
  const timestampMs = Number(match?.[1]);
  const sequence = Number(match?.[2]);
  if (match === null || !Number.isSafeInteger(timestampMs) || !Number.isSafeInteger(sequence)) {
    throw new MetricsQueryError('invalid cursor: pass back a nextCursor exactly as recent() returned it');
  }
  return { timestampMs, sequence };
}

function recentLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_RECENT_LIMIT;
  return Math.min(Math.max(1, Math.trunc(limit)), MAX_RECENT_LIMIT);
}

function summarizeReason(event: StoredRequestOutcome): string {
  if (event.decision === 'fail') return 'refused: no configured provider could satisfy the requested capabilities';
  if (event.decision === 'passthrough') return 'no eligible candidate; passed through to the requested model';
  const failedAttempts = event.trace.filter((attempt) => attempt.outcome !== 'ok');
  if (failedAttempts.length === 0) return `routed by the ${event.policy} policy`;
  const failures = failedAttempts
    .map(
      (attempt) =>
        `${attempt.provider} ${attempt.model} (${attempt.outcome}${attempt.status === null ? '' : `, HTTP ${attempt.status}`})`,
    )
    .join(', ');
  return `routed by the ${event.policy} policy after ${failures} failed`;
}

/**
 * One event in the shape recent() returns it: where it was routed and why, its price and its trace.
 * Also the shape a newly recorded outcome is pushed in on the live event stream, so both read alike.
 */
export function toRecentEntry(event: StoredRequestOutcome): RecentEntry {
  return {
    requestId: event.requestId,
    timestamp: event.timestamp,
    status: event.status,
    route: {
      format: event.format,
      requestedModel: event.requestedModel,
      requestedProvider: event.requestedProvider,
      usedModel: event.usedModel,
      usedProvider: event.usedProvider,
      policy: event.policy,
      decision: event.decision,
    },
    reason: summarizeReason(event),
    cost_usd: event.cost?.cost_usd ?? null,
    savings_usd: event.cost?.savings_usd ?? null,
    trace: event.trace.map(({ provider, model, outcome, status, duration_ms }) => ({
      provider,
      model,
      outcome,
      status,
      duration_ms,
    })),
    latency_ms: event.latencyMs,
    first_byte_ms: event.firstByteMs,
    origin: event.cost?.origin ?? event.usage?.origin ?? null,
    baseline_usd: event.cost?.baseline_usd ?? null,
    usage: event.usage === null ? null : { input: event.usage.input, output: event.usage.output },
    needs: event.needs,
    price: event.price,
    selection: event.selection,
    substituted: substitutedOf(event),
    substitution:
      event.substitution === NOT_RECORDED || event.substitution === null
        ? null
        : {
            requested_model: event.substitution.requested_model,
            served_model: event.substitution.served_model,
            group: event.substitution.group,
          },
  };
}

/**
 * The most recent events, newest first, paged backwards through `before`. No time range: the
 * dashboard's request log reads the newest events whatever their age. Throws MetricsQueryError for
 * a malformed cursor.
 */
export async function recent(store: EventStore, query: RecentQuery = {}): Promise<RecentPage> {
  const limit = recentLimit(query.limit);
  const before = query.before === undefined ? undefined : decodeCursor(query.before);
  const page = await store.readRecentEvents({ limit, ...(before === undefined ? {} : { before }) });

  const entries = page.events.map(toRecentEntry);

  return { entries, nextCursor: page.nextCursor === null ? null : encodeCursor(page.nextCursor) };
}
