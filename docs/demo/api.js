// The dashboard's reads of the Tollwise API: the summary, the newest request, and the live event stream.
// Every call is same-origin and carries the access key in a header only (./access.ts). `fetch` is passed
// in, so the Node test runner drives these functions against stand-in responses.
import { apiHeaders } from './access.js';
import { createEventStreamParser } from './sse.js';
const isCount = (value) => typeof value === 'number' && Number.isSafeInteger(value);
const isAmount = (value) => typeof value === 'string' && (value === 'unknown' || /^-?\d+(?:\.\d{1,6})?$/.test(value));
const isDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
/** The summary in `body` when it has the expected shape; undefined otherwise. */
export function parseSummary(body) {
    if (typeof body !== 'object' || body === null)
        return undefined;
    const value = body;
    const origin = value.origin;
    const dates = value.prices_verified_on;
    const percent = value.savings_percent;
    const valid = typeof value.range === 'string' &&
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
    return valid ? body : undefined;
}
function parseTimeseriesBucket(value) {
    if (typeof value !== 'object' || value === null)
        return undefined;
    const bucket = value;
    const valid = typeof bucket.bucket_start === 'string' &&
        isCount(bucket.requests) &&
        isCount(bucket.errors) &&
        isAmount(bucket.spend_usd) &&
        isCount(bucket.unpriced_requests) &&
        isAmount(bucket.savings_usd) &&
        isCount(bucket.unknown_savings_requests);
    return valid ? bucket : undefined;
}
export function parseTimeseries(body) {
    if (typeof body !== 'object' || body === null)
        return undefined;
    const value = body;
    if (typeof value.range !== 'string' || typeof value.bucket !== 'string' || !Array.isArray(value.buckets)) {
        return undefined;
    }
    const buckets = [];
    for (const raw of value.buckets) {
        const parsed = parseTimeseriesBucket(raw);
        if (parsed === undefined)
            return undefined;
        buckets.push(parsed);
    }
    return { range: value.range, bucket: value.bucket, buckets };
}
export function fetchTimeseries(fetchFn, range, bucket, key) {
    return getJson(fetchFn, `/api/metrics/timeseries?range=${range}&bucket=${bucket}`, key, parseTimeseries);
}
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);
function parseBreakdownGroup(value) {
    if (typeof value !== 'object' || value === null)
        return undefined;
    const group = value;
    const valid = typeof group.key === 'string' &&
        isCount(group.requests) &&
        isAmount(group.spend_usd) &&
        isCount(group.unpriced_requests) &&
        isFiniteNumber(group.latency_p50_ms) &&
        isFiniteNumber(group.latency_p95_ms);
    return valid ? group : undefined;
}
export function parseBreakdown(body) {
    if (typeof body !== 'object' || body === null)
        return undefined;
    const value = body;
    if (typeof value.range !== 'string' ||
        typeof value.by !== 'string' ||
        !Array.isArray(value.groups) ||
        !isCount(value.unrouted_requests)) {
        return undefined;
    }
    const groups = [];
    for (const raw of value.groups) {
        const parsed = parseBreakdownGroup(raw);
        if (parsed === undefined)
            return undefined;
        groups.push(parsed);
    }
    return {
        range: value.range,
        by: value.by,
        groups,
        unrouted_requests: value.unrouted_requests,
    };
}
export function fetchBreakdown(fetchFn, range, by, key) {
    return getJson(fetchFn, `/api/metrics/breakdown?range=${range}&by=${by}`, key, parseBreakdown);
}
const OUTCOME_STATUSES = [
    'complete',
    'provider_error',
    'interrupted',
    'client_aborted',
    'translation_failed',
    'refused',
];
const WIRE_FORMATS = ['openai', 'anthropic'];
const ROUTING_POLICIES = ['cheapest', 'fastest', 'balanced', 'pinned'];
const OUTCOME_DECISIONS = ['routed', 'passthrough', 'fail'];
const COST_ORIGINS = ['reported', 'estimated'];
const ATTEMPT_OUTCOMES = [
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
function isOneOf(value, allowed) {
    return typeof value === 'string' && allowed.includes(value);
}
function parseAttempt(value) {
    if (typeof value !== 'object' || value === null)
        return undefined;
    const attempt = value;
    const valid = typeof attempt.provider === 'string' &&
        typeof attempt.model === 'string' &&
        isOneOf(attempt.outcome, ATTEMPT_OUTCOMES) &&
        (attempt.status === null || isFiniteNumber(attempt.status)) &&
        isFiniteNumber(attempt.duration_ms);
    return valid ? attempt : undefined;
}
function parseAttempts(value) {
    if (!Array.isArray(value))
        return undefined;
    const attempts = [];
    for (const raw of value) {
        const parsed = parseAttempt(raw);
        if (parsed === undefined)
            return undefined;
        attempts.push(parsed);
    }
    return attempts;
}
function parseNeeds(value) {
    if (typeof value !== 'object' || value === null)
        return undefined;
    const needs = value;
    const valid = typeof needs.tools === 'boolean' &&
        typeof needs.json_mode === 'boolean' &&
        typeof needs.vision === 'boolean' &&
        typeof needs.streaming === 'boolean';
    return valid ? needs : undefined;
}
function parseRoute(value) {
    if (typeof value !== 'object' || value === null)
        return undefined;
    const route = value;
    const valid = isOneOf(route.format, WIRE_FORMATS) &&
        typeof route.requestedModel === 'string' &&
        typeof route.requestedProvider === 'string' &&
        (route.usedModel === null || typeof route.usedModel === 'string') &&
        (route.usedProvider === null || typeof route.usedProvider === 'string') &&
        isOneOf(route.policy, ROUTING_POLICIES) &&
        isOneOf(route.decision, OUTCOME_DECISIONS);
    return valid ? route : undefined;
}
function parseUsage(value) {
    if (value === null)
        return null;
    if (typeof value !== 'object')
        return undefined;
    const usage = value;
    const valid = isCount(usage.input) && isCount(usage.output);
    return valid ? usage : undefined;
}
function parsePrice(value) {
    if (value === null)
        return null;
    if (typeof value !== 'object')
        return undefined;
    const price = value;
    const valid = isFiniteNumber(price.input) &&
        isFiniteNumber(price.output) &&
        isDate(price.verified_on) &&
        typeof price.source_url === 'string' &&
        price.source_url !== '';
    return valid ? price : undefined;
}
function parsePrices(value) {
    if (value === null)
        return null;
    if (typeof value !== 'object')
        return undefined;
    const prices = value;
    const used = parsePrice(prices.used);
    const requested = parsePrice(prices.requested);
    return used === undefined || requested === undefined ? undefined : { used, requested };
}
function parseCandidate(value) {
    if (typeof value !== 'object' || value === null)
        return undefined;
    const candidate = value;
    const valid = typeof candidate.provider === 'string' &&
        typeof candidate.model === 'string' &&
        (candidate.input === null || isFiniteNumber(candidate.input)) &&
        (candidate.output === null || isFiniteNumber(candidate.output));
    return valid ? candidate : undefined;
}
function parseExclusion(value) {
    if (typeof value !== 'object' || value === null)
        return undefined;
    const exclusion = value;
    const valid = typeof exclusion.provider === 'string' &&
        typeof exclusion.model === 'string' &&
        typeof exclusion.reason === 'string';
    return valid ? exclusion : undefined;
}
function parseSelection(value) {
    if (value === null)
        return null;
    if (typeof value !== 'object')
        return undefined;
    const selection = value;
    if (!isCount(selection.considered) || !Array.isArray(selection.candidates) || !Array.isArray(selection.excluded)) {
        return undefined;
    }
    const candidates = [];
    for (const raw of selection.candidates) {
        const parsed = parseCandidate(raw);
        if (parsed === undefined)
            return undefined;
        candidates.push(parsed);
    }
    const excluded = [];
    for (const raw of selection.excluded) {
        const parsed = parseExclusion(raw);
        if (parsed === undefined)
            return undefined;
        excluded.push(parsed);
    }
    return { considered: selection.considered, candidates, excluded };
}
/**
 * `substituted` and `substitution` together: `substituted` is true (with the substitution), false (the
 * requested model served, or nothing was called), or null for a row stored before substitutions were
 * recorded. Undefined when the pair is malformed or contradicts itself.
 */
export function parseSubstitution(substituted, substitution) {
    if (substituted === false || substituted === null) {
        return substitution === null ? { substituted, substitution: null } : undefined;
    }
    if (substituted !== true || typeof substitution !== 'object' || substitution === null)
        return undefined;
    const value = substitution;
    if (typeof value.requested_model !== 'string' ||
        typeof value.served_model !== 'string' ||
        typeof value.group !== 'string') {
        return undefined;
    }
    return {
        substituted: true,
        substitution: { requested_model: value.requested_model, served_model: value.served_model, group: value.group },
    };
}
export function parseRecentEntry(value) {
    if (typeof value !== 'object' || value === null)
        return undefined;
    const entry = value;
    const route = parseRoute(entry.route);
    const trace = parseAttempts(entry.trace);
    const needs = parseNeeds(entry.needs);
    const usage = parseUsage(entry.usage);
    const price = parsePrices(entry.price);
    const selection = parseSelection(entry.selection);
    const substitution = parseSubstitution(entry.substituted, entry.substitution);
    const costUsd = entry.cost_usd === null || isAmount(entry.cost_usd) ? entry.cost_usd : undefined;
    const savingsUsd = entry.savings_usd === null || isAmount(entry.savings_usd) ? entry.savings_usd : undefined;
    const baselineUsd = entry.baseline_usd === null || isAmount(entry.baseline_usd) ? entry.baseline_usd : undefined;
    const valid = typeof entry.requestId === 'string' &&
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
    if (!valid)
        return undefined;
    return {
        requestId: entry.requestId,
        timestamp: entry.timestamp,
        status: entry.status,
        route,
        cost_usd: costUsd,
        savings_usd: savingsUsd,
        trace,
        latency_ms: entry.latency_ms,
        first_byte_ms: entry.first_byte_ms,
        origin: entry.origin,
        baseline_usd: baselineUsd,
        usage,
        needs,
        price,
        selection,
        substituted: substitution.substituted,
        substitution: substitution.substitution,
    };
}
export function parseRecentPage(body) {
    if (typeof body !== 'object' || body === null)
        return undefined;
    const value = body;
    if (!Array.isArray(value.entries) || (value.nextCursor !== null && typeof value.nextCursor !== 'string')) {
        return undefined;
    }
    const entries = [];
    for (const raw of value.entries) {
        const parsed = parseRecentEntry(raw);
        if (parsed === undefined)
            return undefined;
        entries.push(parsed);
    }
    return { entries, nextCursor: value.nextCursor };
}
/** The entry of a `request` live event (the same shape as a page entry; the caller checks `event.event`). */
export function parseRecentEvent(data) {
    try {
        return parseRecentEntry(JSON.parse(data));
    }
    catch {
        return undefined;
    }
}
export function fetchRequests(fetchFn, key, options = {}) {
    const params = new URLSearchParams();
    if (options.limit !== undefined)
        params.set('limit', String(options.limit));
    if (options.before !== undefined)
        params.set('before', options.before);
    const query = params.toString();
    return getJson(fetchFn, `/api/requests${query === '' ? '' : `?${query}`}`, key, parseRecentPage);
}
const HEALTH_STATES = ['up', 'down', 'unknown'];
const HEALTH_ERROR_KINDS = [
    'rate_limit',
    'overloaded',
    'server',
    'timeout',
    'connection',
    'auth',
    'bad_request',
    'unknown',
];
function parseHealthProvider(value) {
    if (typeof value !== 'object' || value === null)
        return undefined;
    const provider = value;
    const valid = isOneOf(provider.state, HEALTH_STATES) &&
        (provider.p50_ms === null || isFiniteNumber(provider.p50_ms)) &&
        (provider.p95_ms === null || isFiniteNumber(provider.p95_ms)) &&
        (provider.last_checked === null || typeof provider.last_checked === 'string') &&
        isCount(provider.samples) &&
        (provider.last_error_kind === null || isOneOf(provider.last_error_kind, HEALTH_ERROR_KINDS));
    return valid ? provider : undefined;
}
export function parseHealth(body) {
    if (typeof body !== 'object' || body === null)
        return undefined;
    const value = body;
    if (typeof value.providers !== 'object' || value.providers === null || Array.isArray(value.providers)) {
        return undefined;
    }
    const providers = new Map();
    for (const [id, raw] of Object.entries(value.providers)) {
        const parsed = parseHealthProvider(raw);
        if (parsed === undefined)
            return undefined;
        providers.set(id, parsed);
    }
    return { providers };
}
export function fetchHealth(fetchFn, key) {
    return getJson(fetchFn, '/api/health', key, parseHealth);
}
/** The `error.message` of a Tollwise error body, if it has one. */
function errorMessage(body) {
    const error = body?.error;
    return typeof error?.message === 'string' && error.message !== '' ? error.message : undefined;
}
async function readJson(response) {
    try {
        return await response.json();
    }
    catch {
        return undefined;
    }
}
async function getJson(fetchFn, path, key, parse) {
    let response;
    try {
        response = await fetchFn(path, { headers: apiHeaders(key), cache: 'no-store', credentials: 'omit' });
    }
    catch {
        return { kind: 'offline' };
    }
    if (response.status === 401)
        return { kind: 'unauthorized' };
    const body = await readJson(response);
    if (!response.ok)
        return { kind: 'error', status: response.status, message: errorMessage(body) };
    const value = parse(body);
    return value === undefined ? { kind: 'offline' } : { kind: 'ok', value };
}
export function fetchSummary(fetchFn, range, key) {
    return getJson(fetchFn, `/api/metrics/summary?range=${range}`, key, parseSummary);
}
/** The time of the newest recorded request, or null when there is none yet. */
export function fetchLastRequestTime(fetchFn, key) {
    return getJson(fetchFn, '/api/requests?limit=1', key, (body) => {
        const entries = body?.entries;
        if (!Array.isArray(entries))
            return undefined;
        if (entries.length === 0)
            return null;
        return requestTime(entries[0]) ?? undefined;
    });
}
/** The time of a request entry (an entry of /api/requests or the data of a `request` event). */
export function requestTime(entry) {
    const timestamp = entry?.timestamp;
    if (typeof timestamp !== 'string')
        return undefined;
    const time = new Date(timestamp);
    return Number.isNaN(time.getTime()) ? undefined : time;
}
/**
 * Reads GET /api/events with fetch streaming until it ends, handing each event to `handlers`, and
 * resolves with why it ended. Never rejects.
 */
export async function readEventStream(fetchFn, key, signal, handlers) {
    let response;
    try {
        response = await fetchFn('/api/events', {
            headers: apiHeaders(key, 'text/event-stream'),
            cache: 'no-store',
            credentials: 'omit',
            signal,
        });
    }
    catch {
        return signal.aborted ? { kind: 'aborted' } : { kind: 'dropped' };
    }
    if (response.status === 401)
        return { kind: 'unauthorized' };
    if (!response.ok || response.body === null) {
        await response.body?.cancel().catch(() => { });
        return { kind: 'dropped' };
    }
    handlers.onOpen();
    const parser = createEventStreamParser();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done)
                break;
            for (const event of parser.push(decoder.decode(value, { stream: true })))
                handlers.onEvent(event);
        }
    }
    catch {
        // A network error or an abort mid-stream: reported below.
    }
    finally {
        reader.releaseLock();
    }
    return signal.aborted ? { kind: 'aborted' } : { kind: 'dropped' };
}
