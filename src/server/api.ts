// The read-only metrics API the dashboard reads: GET /api/metrics/summary, /api/metrics/timeseries,
// /api/metrics/breakdown, /api/requests and the live stream GET /api/events (./events.ts).
//
// Every number comes from src/analytics/metrics.ts over the local event store; nothing here computes
// a metric of its own. Query strings are validated strictly: a parameter a route does not accept, a
// parameter given twice or a value outside its fixed set is answered 400 with a fixed message that
// never repeats what the client sent. The access key and the request guard apply to these routes like
// to every other one (see ./server.ts); the key is only ever read from a header, never from the query.

import {
  type BreakdownDimension,
  breakdown,
  MAX_RECENT_LIMIT,
  MAX_TIMESERIES_BUCKETS,
  type MetricsOptions,
  MetricsQueryError,
  type MetricsRange,
  recent,
  summary,
  type TimeseriesBucketSize,
  timeseries,
} from '../analytics/metrics.ts';
import type { EventStore } from '../analytics/store.ts';
import { sendError, sendJson } from './respond.ts';
import type { RouteContext } from './router.ts';

export const SUMMARY_PATH = '/api/metrics/summary';
export const TIMESERIES_PATH = '/api/metrics/timeseries';
export const BREAKDOWN_PATH = '/api/metrics/breakdown';
export const REQUESTS_PATH = '/api/requests';
export const EVENTS_PATH = '/api/events';

const RANGES: readonly MetricsRange[] = ['1h', '24h', '7d', '30d'];
const BUCKETS: readonly TimeseriesBucketSize[] = ['1m', '5m', '1h', '1d'];
const DIMENSIONS: readonly BreakdownDimension[] = ['provider', 'model'];

/** The range a metrics route reads when the query names none. */
export const DEFAULT_RANGE: MetricsRange = '24h';
/** The bucket a timeseries uses when the query names none: about 24 to 170 buckets per range. */
export const DEFAULT_BUCKET: Readonly<Record<MetricsRange, TimeseriesBucketSize>> = {
  '1h': '1m',
  '24h': '1h',
  '7d': '1h',
  '30d': '1d',
};
/** How the breakdown groups when the query names no dimension. */
export const DEFAULT_DIMENSION: BreakdownDimension = 'provider';

// Fixed messages: none of them contains anything from the request.
export const INVALID_RANGE_MESSAGE = `Invalid range. Use one of: ${RANGES.join(', ')}.`;
export const INVALID_BUCKET_MESSAGE = `Invalid bucket. Use one of: ${BUCKETS.join(', ')}.`;
export const BUCKET_TOO_FINE_MESSAGE =
  `This bucket is too fine for this range: a timeseries returns at most ${MAX_TIMESERIES_BUCKETS} buckets. ` +
  'Use a wider bucket or a shorter range.';
export const INVALID_DIMENSION_MESSAGE = `Invalid by. Use one of: ${DIMENSIONS.join(', ')}.`;
export const INVALID_LIMIT_MESSAGE = `Invalid limit. Use a whole number from 1 to ${MAX_RECENT_LIMIT}.`;
export const INVALID_CURSOR_MESSAGE = 'Invalid before. Pass back a nextCursor exactly as /api/requests returned it.';
export const ANALYTICS_DISABLED_MESSAGE =
  'Analytics is off (analytics.enabled is false in the configuration), so no metrics are recorded. ' +
  'Turn it on and restart Tollwise to see metrics.';

/** The fixed 400 message for a query parameter a route does not accept, or one given more than once. */
export function unexpectedParameterMessage(path: string, accepted: readonly string[]): string {
  const list = accepted.length === 0 ? 'no query parameters' : `only ${accepted.join(', ')}, each at most once`;
  return `Unknown or repeated query parameter. ${path} accepts ${list}.`;
}

/** A request whose query cannot be served; answered 400 with its message. */
class QueryError extends Error {
  override name = 'QueryError';
}

/** The raw query string of a request target, without `?` or fragment; '' when there is none. */
export function requestQuery(target: string | undefined): string {
  if (target === undefined) return '';
  if (target.startsWith('/')) {
    const start = target.indexOf('?');
    if (start === -1) return '';
    const end = target.indexOf('#', start);
    return target.slice(start + 1, end === -1 ? undefined : end);
  }
  try {
    return new URL(target).search.slice(1);
  } catch {
    return '';
  }
}

/**
 * The query parameters of `target`, when every name is in `accepted` and none repeats; otherwise a
 * QueryError. An empty query (or a bare `?`) has no parameters.
 */
export function parseQuery(target: string | undefined, path: string, accepted: readonly string[]): Map<string, string> {
  const params = new Map<string, string>();
  for (const [name, value] of new URLSearchParams(requestQuery(target))) {
    if (!accepted.includes(name) || params.has(name)) {
      throw new QueryError(unexpectedParameterMessage(path, accepted));
    }
    params.set(name, value);
  }
  return params;
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T, message: string): T {
  if (value === undefined) return fallback;
  if (!(allowed as readonly string[]).includes(value)) throw new QueryError(message);
  return value as T;
}

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d{0,2}$/.test(value)) throw new QueryError(INVALID_LIMIT_MESSAGE);
  const limit = Number(value);
  if (limit > MAX_RECENT_LIMIT) throw new QueryError(INVALID_LIMIT_MESSAGE);
  return limit;
}

/** Analytics is off: there is no store to read. */
class AnalyticsDisabled extends Error {
  override name = 'AnalyticsDisabled';
}

/** Stands in for the store when analytics is off: every read fails with AnalyticsDisabled. */
const DISABLED_STORE: EventStore = {
  record() {},
  flush: () => Promise.resolve(),
  readEvents: () => Promise.reject(new AnalyticsDisabled()),
  readRecentEvents: () => Promise.reject(new AnalyticsDisabled()),
  close: () => Promise.resolve(),
};

/**
 * Answers with what `serve` returns for the event store: 400 for a QueryError, 503 when analytics is
 * off. With analytics off, `serve` runs against a store whose every read fails, so its query is still
 * validated first and a bad one is a 400 either way. Anything else propagates to the server, which
 * answers a generic 500.
 */
async function withStore(context: RouteContext, serve: (store: EventStore) => Promise<unknown>): Promise<void> {
  const { res, analytics } = context;
  try {
    sendJson(res, 200, await serve(analytics ?? DISABLED_STORE));
  } catch (error) {
    if (error instanceof QueryError) {
      sendError(res, 400, 'invalid_request_error', 'invalid_query_parameter', error.message);
      return;
    }
    if (error instanceof AnalyticsDisabled) {
      sendError(res, 503, 'server_error', 'analytics_disabled', ANALYTICS_DISABLED_MESSAGE);
      return;
    }
    throw error;
  }
}

/** The clock a metrics query measures its range back from: the server's metricsClock, else the real one. */
function metricsOptions(context: RouteContext): MetricsOptions {
  return context.metricsClock === undefined ? {} : { now: context.metricsClock };
}

/** GET /api/metrics/summary?range= */
export function handleSummary(context: RouteContext): Promise<void> {
  return withStore(context, async (store) => {
    const params = parseQuery(context.req.url, SUMMARY_PATH, ['range']);
    const range = oneOf(params.get('range'), RANGES, DEFAULT_RANGE, INVALID_RANGE_MESSAGE);
    return { range, ...(await summary(store, range, metricsOptions(context))) };
  });
}

/** GET /api/metrics/timeseries?range=&bucket= */
export function handleTimeseries(context: RouteContext): Promise<void> {
  return withStore(context, async (store) => {
    const params = parseQuery(context.req.url, TIMESERIES_PATH, ['range', 'bucket']);
    const range = oneOf(params.get('range'), RANGES, DEFAULT_RANGE, INVALID_RANGE_MESSAGE);
    const bucket = oneOf(params.get('bucket'), BUCKETS, DEFAULT_BUCKET[range], INVALID_BUCKET_MESSAGE);
    try {
      return { range, bucket, buckets: await timeseries(store, range, bucket, metricsOptions(context)) };
    } catch (error) {
      if (error instanceof MetricsQueryError) throw new QueryError(BUCKET_TOO_FINE_MESSAGE);
      throw error;
    }
  });
}

/** GET /api/metrics/breakdown?range=&by= */
export function handleBreakdown(context: RouteContext): Promise<void> {
  return withStore(context, async (store) => {
    const params = parseQuery(context.req.url, BREAKDOWN_PATH, ['range', 'by']);
    const range = oneOf(params.get('range'), RANGES, DEFAULT_RANGE, INVALID_RANGE_MESSAGE);
    const by = oneOf(params.get('by'), DIMENSIONS, DEFAULT_DIMENSION, INVALID_DIMENSION_MESSAGE);
    return { range, by, ...(await breakdown(store, range, by, metricsOptions(context))) };
  });
}

/** GET /api/requests?limit=&before= */
export function handleRequests(context: RouteContext): Promise<void> {
  return withStore(context, async (store) => {
    const params = parseQuery(context.req.url, REQUESTS_PATH, ['limit', 'before']);
    const limit = parseLimit(params.get('limit'));
    const before = params.get('before');
    if (before !== undefined && !/^\d{1,16}-\d{1,16}$/.test(before)) throw new QueryError(INVALID_CURSOR_MESSAGE);
    try {
      return await recent(store, {
        ...(limit === undefined ? {} : { limit }),
        ...(before === undefined ? {} : { before }),
      });
    } catch (error) {
      if (error instanceof MetricsQueryError) throw new QueryError(INVALID_CURSOR_MESSAGE);
      throw error;
    }
  });
}

/** GET /api/events: the live event stream (./events.ts). Takes no query parameters. */
export function handleEvents(context: RouteContext): void {
  const { req, res } = context;
  try {
    parseQuery(req.url, EVENTS_PATH, []);
  } catch (error) {
    if (!(error instanceof QueryError)) throw error;
    sendError(res, 400, 'invalid_request_error', 'invalid_query_parameter', error.message);
    return;
  }
  context.events.open(req, res);
}
