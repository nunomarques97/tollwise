// The whole Tollwise route table, in one place.
//
// A route is a set of methods plus a path matched either exactly or as a prefix. A prefix matches the path
// itself and everything below it on a segment boundary: `/v1/images` matches `/v1/images` and
// `/v1/images/generations`, never `/v1/imagesfoo`. Paths are compared as sent, without the query string,
// case-sensitively and without decoding. Routes are tried in order; the first whose path matches decides.
// A route that exists for another method answers 405 with an Allow header; no route at all answers 404.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { EventStore } from '../analytics/store.ts';
import type { Catalog } from '../catalog/schema.ts';
import type { Environment } from '../config/load.ts';
import type { Config } from '../config/schema.ts';
import type { HealthMonitor, HealthMonitorSnapshot } from '../health/monitor.ts';
import type { Logger } from '../log/logger.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import { handleChatCompletions, handleMessages } from '../proxy/chat.ts';
import type { ProxyRequestResult } from '../proxy/forward.ts';
import { handleModels } from '../proxy/models.ts';
import {
  BREAKDOWN_PATH,
  EVENTS_PATH,
  handleBreakdown,
  handleEvents,
  handleRequests,
  handleSummary,
  handleTimeseries,
  REQUESTS_PATH,
  SUMMARY_PATH,
  TIMESERIES_PATH,
} from './api.ts';
import { DASHBOARD_PATH, handleDashboard } from './dashboard.ts';
import type { EventStreamHub } from './events.ts';
import { type ErrorWriter, sendAnthropicError, sendError, sendJson } from './respond.ts';

/**
 * What the proxy routes need to forward a request: the loaded configuration, the catalog, the providers
 * that can be called and the environment their keys are read from at call time. Given all together or
 * not at all; without it the proxy routes answer 503.
 */
export interface ProxySettings {
  readonly config: Config;
  readonly catalog: Catalog;
  readonly registry: ProviderRegistry;
  /** Where adapters read provider keys from, at call time. Never logged. */
  readonly env: Environment;
  /** Called once per request sent to a provider, when its response is over (metadata only). */
  readonly onRequestResult?: (result: ProxyRequestResult) => void;
}

export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';

export interface RouteContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  /** Request path without query string. */
  readonly path: string;
  /** Largest request body accepted, in bytes (`server.max_body_size`). */
  readonly maxBodyBytes: number;
  readonly logger: Logger;
  /** Provider health monitor (src/health/monitor.ts); undefined when Tollwise runs with none wired in. */
  readonly healthMonitor?: HealthMonitor;
  /** Configuration, catalog, providers and environment for the proxy routes; undefined when none is wired in. */
  readonly proxy?: ProxySettings;
  /** The local event store the metrics routes read; undefined when analytics is off. */
  readonly analytics?: EventStore;
  /** The live event streams of GET /api/events. */
  readonly events: EventStreamHub;
  /** Folder the dashboard's static files are served from; undefined means dist/dashboard (./dashboard.ts). */
  readonly dashboardRoot?: string;
}

export type RouteHandler = (context: RouteContext) => void | Promise<void>;

export interface Route {
  /** Accepted methods; `any` accepts every method. A route accepting GET also answers HEAD. */
  readonly methods: readonly HttpMethod[] | 'any';
  readonly path: string;
  readonly match: 'exact' | 'prefix';
  readonly handler: RouteHandler;
}

export type RouteResult =
  | { readonly kind: 'found'; readonly route: Route }
  | { readonly kind: 'method_not_allowed'; readonly allow: readonly string[] }
  | { readonly kind: 'not_found' };

// ---------------------------------------------------------------- handlers

/** GET /healthz: liveness only. It answers as soon as the server accepts connections. */
function handleHealthz({ res }: RouteContext): void {
  sendJson(res, 200, { status: 'ok' });
}

/**
 * Reduces one monitor snapshot to the JSON shape GET /api/health answers with: an object keyed by
 * provider id, never a URL, header or raw provider error string -- only the normalised error kind.
 */
export function formatHealthSnapshot(snapshot: HealthMonitorSnapshot): Record<string, unknown> {
  const providers: Record<string, unknown> = {};
  for (const provider of snapshot.providers) {
    providers[provider.id] = {
      state: provider.state,
      p50_ms: provider.p50,
      p95_ms: provider.p95,
      last_checked: provider.lastCheckedAt === null ? null : new Date(provider.lastCheckedAt).toISOString(),
      samples: provider.sampleCount,
      last_error_kind: provider.lastErrorKind,
    };
  }
  return { providers };
}

/**
 * GET /api/health: the provider health monitor's current snapshot, per provider. A provider excluded
 * from the registry (disabled, no adapter or missing key) is never monitored and so never appears here.
 */
function handleHealth({ res, healthMonitor }: RouteContext): void {
  const snapshot = healthMonitor?.snapshot() ?? { providers: [] };
  sendJson(res, 200, formatHealthSnapshot(snapshot));
}

/** Answers 501 for an OpenAI API family that Tollwise does not proxy. */
function notSupported(endpoint: string): RouteHandler {
  const message =
    `The ${endpoint} endpoint is not supported by Tollwise. Tollwise routes chat requests only; ` +
    'call the provider directly for this endpoint.';
  return ({ res }) => {
    // An early answer: the body is never read, so the connection closes after it.
    sendError(res, 501, 'invalid_request_error', 'unsupported_endpoint', message, { close: true });
  };
}

// ---------------------------------------------------------------- the table

/** The Anthropic Messages endpoint. */
export const MESSAGES_PATH = '/v1/messages';

export const ROUTES: readonly Route[] = [
  { methods: ['GET'], path: '/healthz', match: 'exact', handler: handleHealthz },
  { methods: ['GET'], path: '/api/health', match: 'exact', handler: handleHealth },

  // The read-only metrics API and live event stream the dashboard reads (./api.ts).
  { methods: ['GET'], path: SUMMARY_PATH, match: 'exact', handler: handleSummary },
  { methods: ['GET'], path: TIMESERIES_PATH, match: 'exact', handler: handleTimeseries },
  { methods: ['GET'], path: BREAKDOWN_PATH, match: 'exact', handler: handleBreakdown },
  { methods: ['GET'], path: REQUESTS_PATH, match: 'exact', handler: handleRequests },
  { methods: ['GET'], path: EVENTS_PATH, match: 'exact', handler: handleEvents },

  // The dashboard's static files (./dashboard.ts): no data, so served without the access key.
  { methods: ['GET'], path: DASHBOARD_PATH, match: 'prefix', handler: handleDashboard },

  // The proxy: OpenAI Chat Completions and Anthropic Messages, routed to the provider chosen for each request.
  { methods: ['POST'], path: '/v1/chat/completions', match: 'exact', handler: handleChatCompletions },
  { methods: ['POST'], path: MESSAGES_PATH, match: 'exact', handler: handleMessages },

  // The models Tollwise can serve, in OpenAI or Anthropic shape; never calls a provider.
  { methods: ['GET'], path: '/v1/models', match: 'prefix', handler: handleModels },

  // OpenAI API families outside the supported scope: a clear 501 instead of a 404.
  { methods: 'any', path: '/v1/responses', match: 'prefix', handler: notSupported('/v1/responses') },
  { methods: 'any', path: '/v1/embeddings', match: 'prefix', handler: notSupported('/v1/embeddings') },
  { methods: 'any', path: '/v1/images', match: 'prefix', handler: notSupported('/v1/images') },
  { methods: 'any', path: '/v1/audio', match: 'prefix', handler: notSupported('/v1/audio') },
  { methods: 'any', path: '/v1/batches', match: 'prefix', handler: notSupported('/v1/batches') },
  { methods: 'any', path: '/v1/assistants', match: 'prefix', handler: notSupported('/v1/assistants') },
];

// ---------------------------------------------------------------- matching

/**
 * How errors on a path are written: in the Anthropic shape on the Anthropic Messages endpoint and below
 * it (what the Anthropic SDKs call), in the OpenAI shape everywhere else. Applies to the server's own
 * early answers too (401, 403, 404, 405, 413, 415, 421, 500).
 */
export function errorWriterFor(path: string): ErrorWriter {
  return path === MESSAGES_PATH || path.startsWith(`${MESSAGES_PATH}/`) ? sendAnthropicError : sendError;
}

function pathMatches(route: Route, path: string): boolean {
  if (route.match === 'exact') return path === route.path;
  return path === route.path || path.startsWith(`${route.path}/`);
}

function allowedMethods(route: Route): readonly string[] {
  if (route.methods === 'any') return [];
  return route.methods.includes('GET') && !route.methods.includes('HEAD') ? [...route.methods, 'HEAD'] : route.methods;
}

/** Finds the route for `method` and `path` (the path without its query string). */
export function matchRoute(method: string, path: string, routes: readonly Route[] = ROUTES): RouteResult {
  for (const route of routes) {
    if (!pathMatches(route, path)) continue;
    if (route.methods === 'any') return { kind: 'found', route };
    const allow = allowedMethods(route);
    if (allow.includes(method)) return { kind: 'found', route };
    return { kind: 'method_not_allowed', allow };
  }
  return { kind: 'not_found' };
}

/**
 * The path of a request target, without query string or fragment. Origin-form targets (`/path?query`) are
 * cut at the first `?` or `#`; absolute-form targets (`http://host/path`) keep only their path, never the
 * host or any user:password. Anything else (`*`, unparseable text) becomes the fixed marker `[invalid]`.
 */
export function requestPath(target: string | undefined): string {
  if (target === undefined || target === '') return '/';
  if (target.startsWith('/')) {
    const end = target.search(/[?#]/);
    return end === -1 ? target : target.slice(0, end);
  }
  if (/^https?:\/\//i.test(target)) {
    try {
      return new URL(target).pathname;
    } catch {
      return '[invalid]';
    }
  }
  return '[invalid]';
}
