// The dashboard's reads of the Tollwise API: the summary, the newest request, and the live event stream.
// Every call is same-origin and carries the access key in a header only (./access.ts). `fetch` is passed
// in, so the Node test runner drives these functions against stand-in responses.

import { apiHeaders } from './access.ts';
import type { UsdAmount } from './format.ts';
import type { RangeId } from './ranges.ts';
import { createEventStreamParser, type StreamEvent } from './sse.ts';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** GET /api/metrics/summary, as the dashboard reads it. Money amounts are decimal strings or 'unknown'. */
export interface Summary {
  readonly range: RangeId;
  readonly requests: number;
  readonly errors: number;
  readonly spend_usd: string;
  readonly unpriced_requests: number;
  readonly baseline_usd: string;
  readonly savings_usd: string;
  readonly savings_percent: number | null;
  readonly unknown_savings_requests: number;
  readonly origin: { readonly reported: number; readonly estimated: number };
  readonly prices_verified_on: { readonly oldest: string; readonly newest: string } | null;
  /** Requests in the range served by another model inside an equivalence group (rows stored before this was recorded are not counted). */
  readonly substituted_requests: number;
}

/** The outcome of an API read. */
export type ApiResult<T> =
  | { readonly kind: 'ok'; readonly value: T }
  /** 401: no key, or the key was refused. */
  | { readonly kind: 'unauthorized' }
  /** Tollwise answered with an error; `message` is its own fixed error text when it sent one. */
  | { readonly kind: 'error'; readonly status: number; readonly message: string | undefined }
  /** Tollwise could not be reached, or answered with something that is not what the dashboard expects. */
  | { readonly kind: 'offline' };

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);
const isAmount = (value: unknown): value is string =>
  typeof value === 'string' && (value === 'unknown' || /^-?\d+(?:\.\d{1,6})?$/.test(value));
const isDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);

/** The summary in `body` when it has the expected shape; undefined otherwise. */
export function parseSummary(body: unknown): Summary | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const value = body as Record<string, unknown>;
  const origin = value.origin as Record<string, unknown> | null | undefined;
  const dates = value.prices_verified_on as Record<string, unknown> | null | undefined;
  const percent = value.savings_percent;
  const valid =
    typeof value.range === 'string' &&
    isCount(value.requests) &&
    isCount(value.errors) &&
    isAmount(value.spend_usd) &&
    isCount(value.unpriced_requests) &&
    isAmount(value.baseline_usd) &&
    isAmount(value.savings_usd) &&
    (percent === null || (typeof percent === 'number' && Number.isFinite(percent))) &&
    isCount(value.unknown_savings_requests) &&
    isCount(value.substituted_requests) &&
    typeof origin === 'object' &&
    origin !== null &&
    isCount(origin.reported) &&
    isCount(origin.estimated) &&
    (dates === null ||
      (typeof dates === 'object' && dates !== undefined && isDate(dates.oldest) && isDate(dates.newest)));
  return valid ? (body as Summary) : undefined;
}

// ---------------------------------------------------------------- timeseries and breakdown (Savings view)

export type TimeseriesBucketSize = '1m' | '5m' | '1h' | '1d';

/** GET /api/metrics/timeseries's shape for one bucket. Money amounts are decimal strings or 'unknown'. */
export interface TimeseriesBucket {
  readonly bucket_start: string;
  readonly requests: number;
  readonly errors: number;
  readonly spend_usd: string;
  readonly unpriced_requests: number;
  readonly savings_usd: string;
  readonly unknown_savings_requests: number;
}

export interface TimeseriesResponse {
  readonly range: RangeId;
  readonly bucket: TimeseriesBucketSize;
  readonly buckets: readonly TimeseriesBucket[];
}

function parseTimeseriesBucket(value: unknown): TimeseriesBucket | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const bucket = value as Record<string, unknown>;
  const valid =
    typeof bucket.bucket_start === 'string' &&
    isCount(bucket.requests) &&
    isCount(bucket.errors) &&
    isAmount(bucket.spend_usd) &&
    isCount(bucket.unpriced_requests) &&
    isAmount(bucket.savings_usd) &&
    isCount(bucket.unknown_savings_requests);
  return valid ? (bucket as unknown as TimeseriesBucket) : undefined;
}

export function parseTimeseries(body: unknown): TimeseriesResponse | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const value = body as Record<string, unknown>;
  if (typeof value.range !== 'string' || typeof value.bucket !== 'string' || !Array.isArray(value.buckets)) {
    return undefined;
  }
  const buckets: TimeseriesBucket[] = [];
  for (const raw of value.buckets) {
    const parsed = parseTimeseriesBucket(raw);
    if (parsed === undefined) return undefined;
    buckets.push(parsed);
  }
  return { range: value.range as RangeId, bucket: value.bucket as TimeseriesBucketSize, buckets };
}

export function fetchTimeseries(
  fetchFn: FetchLike,
  range: RangeId,
  bucket: TimeseriesBucketSize,
  key: string | undefined,
): Promise<ApiResult<TimeseriesResponse>> {
  return getJson(fetchFn, `/api/metrics/timeseries?range=${range}&bucket=${bucket}`, key, parseTimeseries);
}

export type BreakdownDimension = 'provider' | 'model';

/** GET /api/metrics/breakdown's shape for one group (a provider id or a model id). */
export interface BreakdownGroup {
  readonly key: string;
  readonly requests: number;
  readonly spend_usd: string;
  readonly unpriced_requests: number;
  readonly latency_p50_ms: number;
  readonly latency_p95_ms: number;
}

export interface BreakdownResponse {
  readonly range: RangeId;
  readonly by: BreakdownDimension;
  readonly groups: readonly BreakdownGroup[];
  readonly unrouted_requests: number;
}

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function parseBreakdownGroup(value: unknown): BreakdownGroup | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const group = value as Record<string, unknown>;
  const valid =
    typeof group.key === 'string' &&
    isCount(group.requests) &&
    isAmount(group.spend_usd) &&
    isCount(group.unpriced_requests) &&
    isFiniteNumber(group.latency_p50_ms) &&
    isFiniteNumber(group.latency_p95_ms);
  return valid ? (group as unknown as BreakdownGroup) : undefined;
}

export function parseBreakdown(body: unknown): BreakdownResponse | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const value = body as Record<string, unknown>;
  if (
    typeof value.range !== 'string' ||
    typeof value.by !== 'string' ||
    !Array.isArray(value.groups) ||
    !isCount(value.unrouted_requests)
  ) {
    return undefined;
  }
  const groups: BreakdownGroup[] = [];
  for (const raw of value.groups) {
    const parsed = parseBreakdownGroup(raw);
    if (parsed === undefined) return undefined;
    groups.push(parsed);
  }
  return {
    range: value.range as RangeId,
    by: value.by as BreakdownDimension,
    groups,
    unrouted_requests: value.unrouted_requests,
  };
}

export function fetchBreakdown(
  fetchFn: FetchLike,
  range: RangeId,
  by: BreakdownDimension,
  key: string | undefined,
): Promise<ApiResult<BreakdownResponse>> {
  return getJson(fetchFn, `/api/metrics/breakdown?range=${range}&by=${by}`, key, parseBreakdown);
}

// ---------------------------------------------------------------- recent requests (Routing view)

export type WireFormat = 'openai' | 'anthropic';
export type RoutingPolicy = 'cheapest' | 'fastest' | 'balanced' | 'pinned';
export type CostOrigin = 'reported' | 'estimated';
export type OutcomeDecision = 'routed' | 'passthrough' | 'fail';
export type OutcomeStatus =
  | 'complete'
  | 'provider_error'
  | 'interrupted'
  | 'client_aborted'
  | 'translation_failed'
  | 'refused';
/** The result of one provider call, as it appears in a request's trace and in a candidate's result. */
export type AttemptOutcome =
  | 'ok'
  | 'client_aborted'
  | 'rate_limit'
  | 'overloaded'
  | 'server'
  | 'timeout'
  | 'connection'
  | 'auth'
  | 'bad_request'
  | 'unknown';

const OUTCOME_STATUSES: readonly OutcomeStatus[] = [
  'complete',
  'provider_error',
  'interrupted',
  'client_aborted',
  'translation_failed',
  'refused',
];
const WIRE_FORMATS: readonly WireFormat[] = ['openai', 'anthropic'];
const ROUTING_POLICIES: readonly RoutingPolicy[] = ['cheapest', 'fastest', 'balanced', 'pinned'];
const OUTCOME_DECISIONS: readonly OutcomeDecision[] = ['routed', 'passthrough', 'fail'];
const COST_ORIGINS: readonly CostOrigin[] = ['reported', 'estimated'];
const ATTEMPT_OUTCOMES: readonly AttemptOutcome[] = [
  'ok',
  'client_aborted',
  'rate_limit',
  'overloaded',
  'server',
  'timeout',
  'connection',
  'auth',
  'bad_request',
  'unknown',
];

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

/** One provider call in a request's routing trace (see the Attempts and route-strip sections, DESIGN.md §13.4). */
export interface AttemptRecord {
  readonly provider: string;
  readonly model: string;
  readonly outcome: AttemptOutcome;
  readonly status: number | null;
  readonly duration_ms: number;
}

function parseAttempt(value: unknown): AttemptRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const attempt = value as Record<string, unknown>;
  const valid =
    typeof attempt.provider === 'string' &&
    typeof attempt.model === 'string' &&
    isOneOf(attempt.outcome, ATTEMPT_OUTCOMES) &&
    (attempt.status === null || isFiniteNumber(attempt.status)) &&
    isFiniteNumber(attempt.duration_ms);
  return valid ? (attempt as unknown as AttemptRecord) : undefined;
}

function parseAttempts(value: unknown): readonly AttemptRecord[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const attempts: AttemptRecord[] = [];
  for (const raw of value) {
    const parsed = parseAttempt(raw);
    if (parsed === undefined) return undefined;
    attempts.push(parsed);
  }
  return attempts;
}

/** The capabilities a request used (DESIGN.md §13.2 `needs`). */
export interface RequestNeeds {
  readonly tools: boolean;
  readonly json_mode: boolean;
  readonly vision: boolean;
  readonly streaming: boolean;
}

function parseNeeds(value: unknown): RequestNeeds | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const needs = value as Record<string, unknown>;
  const valid =
    typeof needs.tools === 'boolean' &&
    typeof needs.json_mode === 'boolean' &&
    typeof needs.vision === 'boolean' &&
    typeof needs.streaming === 'boolean';
  return valid ? (needs as unknown as RequestNeeds) : undefined;
}

/** Where a request was routed and why -- the fields the table and drawer read (DESIGN.md §13.2). */
export interface RecentRoute {
  readonly format: WireFormat;
  readonly requestedModel: string;
  readonly requestedProvider: string;
  readonly usedModel: string | null;
  readonly usedProvider: string | null;
  readonly policy: RoutingPolicy;
  readonly decision: OutcomeDecision;
}

function parseRoute(value: unknown): RecentRoute | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const route = value as Record<string, unknown>;
  const valid =
    isOneOf(route.format, WIRE_FORMATS) &&
    typeof route.requestedModel === 'string' &&
    typeof route.requestedProvider === 'string' &&
    (route.usedModel === null || typeof route.usedModel === 'string') &&
    (route.usedProvider === null || typeof route.usedProvider === 'string') &&
    isOneOf(route.policy, ROUTING_POLICIES) &&
    isOneOf(route.decision, OUTCOME_DECISIONS);
  return valid ? (route as unknown as RecentRoute) : undefined;
}

/** Token counts of a request, without their origin (see `RecentEntry.origin`). */
export interface RecentUsage {
  readonly input: number;
  readonly output: number;
}

function parseUsage(value: unknown): RecentUsage | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'object') return undefined;
  const usage = value as Record<string, unknown>;
  const valid = isCount(usage.input) && isCount(usage.output);
  return valid ? (usage as unknown as RecentUsage) : undefined;
}

/** A catalog price as it was when a request was routed (DESIGN.md §13.2 `price.used` / `price.requested`). */
export interface OutcomePrice {
  readonly input: number;
  readonly output: number;
  readonly verified_on: string;
  readonly source_url: string;
}

function parsePrice(value: unknown): OutcomePrice | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'object') return undefined;
  const price = value as Record<string, unknown>;
  const valid =
    isFiniteNumber(price.input) &&
    isFiniteNumber(price.output) &&
    isDate(price.verified_on) &&
    typeof price.source_url === 'string' &&
    price.source_url !== '';
  return valid ? (price as unknown as OutcomePrice) : undefined;
}

/** The catalog prices behind a request's cost and savings, each null when the catalog has none. */
export interface OutcomePrices {
  readonly used: OutcomePrice | null;
  readonly requested: OutcomePrice | null;
}

function parsePrices(value: unknown): OutcomePrices | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'object') return undefined;
  const prices = value as Record<string, unknown>;
  const used = parsePrice(prices.used);
  const requested = parsePrice(prices.requested);
  return used === undefined || requested === undefined ? undefined : { used, requested };
}

/** A candidate routing ranked, with its catalog price in USD per 1M tokens (null: no catalog entry). */
export interface OutcomeCandidate {
  readonly provider: string;
  readonly model: string;
  readonly input: number | null;
  readonly output: number | null;
}

function parseCandidate(value: unknown): OutcomeCandidate | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  const valid =
    typeof candidate.provider === 'string' &&
    typeof candidate.model === 'string' &&
    (candidate.input === null || isFiniteNumber(candidate.input)) &&
    (candidate.output === null || isFiniteNumber(candidate.output));
  return valid ? (candidate as unknown as OutcomeCandidate) : undefined;
}

/** A catalog entry routing examined and ruled out, with the stable reason code of DESIGN.md §13.4. */
export interface OutcomeExclusion {
  readonly provider: string;
  readonly model: string;
  readonly reason: string;
}

function parseExclusion(value: unknown): OutcomeExclusion | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const exclusion = value as Record<string, unknown>;
  const valid =
    typeof exclusion.provider === 'string' &&
    typeof exclusion.model === 'string' &&
    typeof exclusion.reason === 'string';
  return valid ? (exclusion as unknown as OutcomeExclusion) : undefined;
}

/** What routing chose from when a request was routed (DESIGN.md §13.2 `selection`; null for an older record). */
export interface OutcomeSelection {
  readonly considered: number;
  readonly candidates: readonly OutcomeCandidate[];
  readonly excluded: readonly OutcomeExclusion[];
}

function parseSelection(value: unknown): OutcomeSelection | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'object') return undefined;
  const selection = value as Record<string, unknown>;
  if (!isCount(selection.considered) || !Array.isArray(selection.candidates) || !Array.isArray(selection.excluded)) {
    return undefined;
  }
  const candidates: OutcomeCandidate[] = [];
  for (const raw of selection.candidates) {
    const parsed = parseCandidate(raw);
    if (parsed === undefined) return undefined;
    candidates.push(parsed);
  }
  const excluded: OutcomeExclusion[] = [];
  for (const raw of selection.excluded) {
    const parsed = parseExclusion(raw);
    if (parsed === undefined) return undefined;
    excluded.push(parsed);
  }
  return { considered: selection.considered, candidates, excluded };
}

/** The model a request asked for, the model sent instead and the equivalence group that allowed it. */
export interface ModelSubstitution {
  readonly requested_model: string;
  readonly served_model: string;
  readonly group: string;
}

/**
 * `substituted` and `substitution` together: `substituted` is true (with the substitution), false (the
 * requested model served, or nothing was called), or null for a row stored before substitutions were
 * recorded. Undefined when the pair is malformed or contradicts itself.
 */
export function parseSubstitution(
  substituted: unknown,
  substitution: unknown,
): { readonly substituted: boolean | null; readonly substitution: ModelSubstitution | null } | undefined {
  if (substituted === false || substituted === null) {
    return substitution === null ? { substituted, substitution: null } : undefined;
  }
  if (substituted !== true || typeof substitution !== 'object' || substitution === null) return undefined;
  const value = substitution as Record<string, unknown>;
  if (
    typeof value.requested_model !== 'string' ||
    typeof value.served_model !== 'string' ||
    typeof value.group !== 'string'
  ) {
    return undefined;
  }
  return {
    substituted: true,
    substitution: { requested_model: value.requested_model, served_model: value.served_model, group: value.group },
  };
}

/** One entry of GET /api/requests, or of a `request` live event: where a request went and why (DESIGN.md §13.2). */
export interface RecentEntry {
  readonly requestId: string;
  readonly timestamp: string;
  readonly status: OutcomeStatus;
  readonly route: RecentRoute;
  readonly cost_usd: UsdAmount | null;
  readonly savings_usd: UsdAmount | null;
  readonly trace: readonly AttemptRecord[];
  readonly latency_ms: number;
  readonly first_byte_ms: number | null;
  readonly origin: CostOrigin | null;
  readonly baseline_usd: UsdAmount | null;
  readonly usage: RecentUsage | null;
  readonly needs: RequestNeeds;
  readonly price: OutcomePrices | null;
  readonly selection: OutcomeSelection | null;
  /** True when another model served the request (or failed last); false when the requested one did; null when not recorded. */
  readonly substituted: boolean | null;
  /** The substitution when `substituted` is true; null otherwise. */
  readonly substitution: ModelSubstitution | null;
}

export function parseRecentEntry(value: unknown): RecentEntry | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const entry = value as Record<string, unknown>;
  const route = parseRoute(entry.route);
  const trace = parseAttempts(entry.trace);
  const needs = parseNeeds(entry.needs);
  const usage = parseUsage(entry.usage);
  const price = parsePrices(entry.price);
  const selection = parseSelection(entry.selection);
  const substitution = parseSubstitution(entry.substituted, entry.substitution);
  const costUsd =
    entry.cost_usd === null || isAmount(entry.cost_usd) ? (entry.cost_usd as UsdAmount | null) : undefined;
  const savingsUsd =
    entry.savings_usd === null || isAmount(entry.savings_usd) ? (entry.savings_usd as UsdAmount | null) : undefined;
  const baselineUsd =
    entry.baseline_usd === null || isAmount(entry.baseline_usd) ? (entry.baseline_usd as UsdAmount | null) : undefined;
  const valid =
    typeof entry.requestId === 'string' &&
    typeof entry.timestamp === 'string' &&
    isOneOf(entry.status, OUTCOME_STATUSES) &&
    route !== undefined &&
    costUsd !== undefined &&
    savingsUsd !== undefined &&
    trace !== undefined &&
    isFiniteNumber(entry.latency_ms) &&
    (entry.first_byte_ms === null || isFiniteNumber(entry.first_byte_ms)) &&
    (entry.origin === null || isOneOf(entry.origin, COST_ORIGINS)) &&
    baselineUsd !== undefined &&
    usage !== undefined &&
    needs !== undefined &&
    price !== undefined &&
    selection !== undefined &&
    substitution !== undefined;
  if (!valid) return undefined;
  return {
    requestId: entry.requestId as string,
    timestamp: entry.timestamp as string,
    status: entry.status as OutcomeStatus,
    route,
    cost_usd: costUsd,
    savings_usd: savingsUsd,
    trace,
    latency_ms: entry.latency_ms as number,
    first_byte_ms: entry.first_byte_ms as number | null,
    origin: entry.origin as CostOrigin | null,
    baseline_usd: baselineUsd,
    usage,
    needs,
    price,
    selection,
    substituted: substitution.substituted,
    substitution: substitution.substitution,
  };
}

/** A page of GET /api/requests: the newest entries, and the cursor to page further back. */
export interface RecentPage {
  readonly entries: readonly RecentEntry[];
  readonly nextCursor: string | null;
}

export function parseRecentPage(body: unknown): RecentPage | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const value = body as Record<string, unknown>;
  if (!Array.isArray(value.entries) || (value.nextCursor !== null && typeof value.nextCursor !== 'string')) {
    return undefined;
  }
  const entries: RecentEntry[] = [];
  for (const raw of value.entries) {
    const parsed = parseRecentEntry(raw);
    if (parsed === undefined) return undefined;
    entries.push(parsed);
  }
  return { entries, nextCursor: value.nextCursor };
}

/** The entry of a `request` live event (the same shape as a page entry; the caller checks `event.event`). */
export function parseRecentEvent(data: string): RecentEntry | undefined {
  try {
    return parseRecentEntry(JSON.parse(data));
  } catch {
    return undefined;
  }
}

export function fetchRequests(
  fetchFn: FetchLike,
  key: string | undefined,
  options: { readonly limit?: number; readonly before?: string } = {},
): Promise<ApiResult<RecentPage>> {
  const params = new URLSearchParams();
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  if (options.before !== undefined) params.set('before', options.before);
  const query = params.toString();
  return getJson(fetchFn, `/api/requests${query === '' ? '' : `?${query}`}`, key, parseRecentPage);
}

// ---------------------------------------------------------------- provider health (Providers view)

export type HealthState = 'up' | 'down' | 'unknown';
/** The normalised kind of a provider's most recent failure (DESIGN.md §14.4); null while up or unknown. */
export type HealthErrorKind =
  | 'rate_limit'
  | 'overloaded'
  | 'server'
  | 'timeout'
  | 'connection'
  | 'auth'
  | 'bad_request'
  | 'unknown';

const HEALTH_STATES: readonly HealthState[] = ['up', 'down', 'unknown'];
const HEALTH_ERROR_KINDS: readonly HealthErrorKind[] = [
  'rate_limit',
  'overloaded',
  'server',
  'timeout',
  'connection',
  'auth',
  'bad_request',
  'unknown',
];

export interface HealthProvider {
  readonly state: HealthState;
  readonly p50_ms: number | null;
  readonly p95_ms: number | null;
  readonly last_checked: string | null;
  readonly samples: number;
  readonly last_error_kind: HealthErrorKind | null;
}

function parseHealthProvider(value: unknown): HealthProvider | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const provider = value as Record<string, unknown>;
  const valid =
    isOneOf(provider.state, HEALTH_STATES) &&
    (provider.p50_ms === null || isFiniteNumber(provider.p50_ms)) &&
    (provider.p95_ms === null || isFiniteNumber(provider.p95_ms)) &&
    (provider.last_checked === null || typeof provider.last_checked === 'string') &&
    isCount(provider.samples) &&
    (provider.last_error_kind === null || isOneOf(provider.last_error_kind, HEALTH_ERROR_KINDS));
  return valid ? (provider as unknown as HealthProvider) : undefined;
}

/** GET /api/health's shape: every configured provider's current state, keyed by provider id, in API order. */
export interface HealthSnapshot {
  readonly providers: ReadonlyMap<string, HealthProvider>;
}

export function parseHealth(body: unknown): HealthSnapshot | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const value = body as Record<string, unknown>;
  if (typeof value.providers !== 'object' || value.providers === null || Array.isArray(value.providers)) {
    return undefined;
  }
  const providers = new Map<string, HealthProvider>();
  for (const [id, raw] of Object.entries(value.providers as Record<string, unknown>)) {
    const parsed = parseHealthProvider(raw);
    if (parsed === undefined) return undefined;
    providers.set(id, parsed);
  }
  return { providers };
}

export function fetchHealth(fetchFn: FetchLike, key: string | undefined): Promise<ApiResult<HealthSnapshot>> {
  return getJson(fetchFn, '/api/health', key, parseHealth);
}

/** The `error.message` of a Tollwise error body, if it has one. */
function errorMessage(body: unknown): string | undefined {
  const error = (body as { error?: { message?: unknown } } | null)?.error;
  return typeof error?.message === 'string' && error.message !== '' ? error.message : undefined;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

async function getJson<T>(
  fetchFn: FetchLike,
  path: string,
  key: string | undefined,
  parse: (body: unknown) => T | undefined,
): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetchFn(path, { headers: apiHeaders(key), cache: 'no-store', credentials: 'omit' });
  } catch {
    return { kind: 'offline' };
  }
  if (response.status === 401) return { kind: 'unauthorized' };
  const body = await readJson(response);
  if (!response.ok) return { kind: 'error', status: response.status, message: errorMessage(body) };
  const value = parse(body);
  return value === undefined ? { kind: 'offline' } : { kind: 'ok', value };
}

export function fetchSummary(fetchFn: FetchLike, range: RangeId, key: string | undefined): Promise<ApiResult<Summary>> {
  return getJson(fetchFn, `/api/metrics/summary?range=${range}`, key, parseSummary);
}

/** The time of the newest recorded request, or null when there is none yet. */
export function fetchLastRequestTime(fetchFn: FetchLike, key: string | undefined): Promise<ApiResult<Date | null>> {
  return getJson(fetchFn, '/api/requests?limit=1', key, (body) => {
    const entries = (body as { entries?: unknown } | null)?.entries;
    if (!Array.isArray(entries)) return undefined;
    if (entries.length === 0) return null;
    return requestTime(entries[0]) ?? undefined;
  });
}

/** The time of a request entry (an entry of /api/requests or the data of a `request` event). */
export function requestTime(entry: unknown): Date | undefined {
  const timestamp = (entry as { timestamp?: unknown } | null)?.timestamp;
  if (typeof timestamp !== 'string') return undefined;
  const time = new Date(timestamp);
  return Number.isNaN(time.getTime()) ? undefined : time;
}

/** Why an event stream ended. */
export type StreamEnd =
  /** 401: the key is missing or was refused. */
  | { readonly kind: 'unauthorized' }
  /** The stream could not be opened, broke, or was ended by Tollwise: retry later. */
  | { readonly kind: 'dropped' }
  /** The caller aborted it. */
  | { readonly kind: 'aborted' };

export interface StreamHandlers {
  /** Called once the stream is open (a 200 with the event-stream body). */
  onOpen(): void;
  onEvent(event: StreamEvent): void;
}

/**
 * Reads GET /api/events with fetch streaming until it ends, handing each event to `handlers`, and
 * resolves with why it ended. Never rejects.
 */
export async function readEventStream(
  fetchFn: FetchLike,
  key: string | undefined,
  signal: AbortSignal,
  handlers: StreamHandlers,
): Promise<StreamEnd> {
  let response: Response;
  try {
    response = await fetchFn('/api/events', {
      headers: apiHeaders(key, 'text/event-stream'),
      cache: 'no-store',
      credentials: 'omit',
      signal,
    });
  } catch {
    return signal.aborted ? { kind: 'aborted' } : { kind: 'dropped' };
  }
  if (response.status === 401) return { kind: 'unauthorized' };
  if (!response.ok || response.body === null) {
    await response.body?.cancel().catch(() => {});
    return { kind: 'dropped' };
  }

  handlers.onOpen();
  const parser = createEventStreamParser();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const event of parser.push(decoder.decode(value, { stream: true }))) handlers.onEvent(event);
    }
  } catch {
    // A network error or an abort mid-stream: reported below.
  } finally {
    reader.releaseLock();
  }
  return signal.aborted ? { kind: 'aborted' } : { kind: 'dropped' };
}
