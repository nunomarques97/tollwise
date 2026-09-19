// The Tollwise HTTP server, on node:http with the route table from ./router.ts.
//
// Safe defaults:
// - the caller chooses the address; the configuration defaults to 127.0.0.1:8484 (loopback only);
// - every request first passes the request guard (./guard.ts): a Host naming this server, no foreign
//   Origin, no OPTIONS, JSON on POST. A refused request is answered 421, 403 or 415 before the access
//   key is checked and before routing, before its body is read;
// - every early answer (401, 403, 413, 415, 421, 404, 405, 501) closes the connection, and a request
//   pipelined behind it on that connection is never dispatched;
// - when an access key is configured, every request but GET or HEAD /healthz and the dashboard's static
//   files (GET or HEAD /dashboard and below) must carry it (./access.ts); a request without it is answered
//   401 before routing, before its body is read;
// - the client's credential headers (Authorization, x-api-key, ...) are removed from every request before
//   any route handler runs, so they can never be forwarded to a provider;
// - a request whose Content-Length is above the body limit is answered 413 before anything is read. The
//   rest of the body is dropped, never buffered, within fixed byte and time bounds, then the connection is
//   closed; the same bounded drop follows any other early answer (404, 405, 501) to a request with a body;
// - one log line per request through src/log: method, path without query string, status and duration.
//   Headers and bodies are never logged;
// - GET /api/events streams stay open until the client leaves; stopServer() ends them first, so a
//   stop never waits on them (./events.ts caps how many are open at once);
// - a handler error becomes a generic 500; only the error's class name and code are logged;
// - every error is written in the shape the caller's SDK reads: Anthropic on /v1/messages and below it,
//   OpenAI everywhere else (errorWriterFor in ./router.ts);
// - malformed requests are answered 400 (431 for oversized headers) and the socket is closed, logging
//   only the parser's error code, never the raw bytes.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type { EventStore } from '../analytics/store.ts';
import type { HealthMonitor } from '../health/monitor.ts';
import type { Logger } from '../log/logger.ts';
import { ACCESS_DENIED_MESSAGE, type AccessGuard, createAccessGuard, stripClientCredentials } from './access.ts';
import {
  DEFAULT_DISCARD_LIMITS,
  type DiscardLimits,
  exceedsDeclaredLimit,
  PayloadTooLargeError,
  setDiscardLimits,
} from './body.ts';
import { createEventStreamHub, type EventStreamHub, type EventStreamOptions } from './events.ts';
import { createRequestGuard, type RequestGuard } from './guard.ts';
import { isConnectionClosing } from './respond.ts';
import { errorWriterFor, matchRoute, type ProxySettings, ROUTES, type Route, requestPath } from './router.ts';

export interface ServerOptions {
  /** Largest request body accepted, in bytes. */
  readonly maxBodyBytes: number;
  readonly logger: Logger;
  /** Route table; the default is the one in ./router.ts. */
  readonly routes?: readonly Route[];
  /** Bounds on dropping an unread body after an early answer; the default is DEFAULT_DISCARD_LIMITS. */
  readonly discardLimits?: DiscardLimits;
  /** Backs GET /api/health; undefined answers it with an empty snapshot. */
  readonly healthMonitor?: HealthMonitor;
  /**
   * The local access key (TOLLWISE_ACCESS_KEY). When set, every request but GET or HEAD /healthz and the
   * dashboard's static files must carry it; undefined serves every request and ignores any credential
   * header. Never log it.
   */
  readonly accessKey?: string | undefined;
  /** Extra host names or addresses accepted in Host and Origin (server.allowed_hosts). */
  readonly allowedHosts?: readonly string[];
  /** The configured listening host (server.host); accepted in Host and Origin unless it is a wildcard. */
  readonly listenHost?: string;
  /** Backs the proxy routes (/v1/chat/completions, /v1/messages); undefined answers them 503. */
  readonly proxy?: ProxySettings;
  /** Backs the metrics routes (/api/metrics/*, /api/requests); undefined answers them 503. */
  readonly analytics?: EventStore;
  /** Limits and timing of the GET /api/events streams; the defaults are in ./events.ts. */
  readonly eventStream?: EventStreamOptions;
  /** Folder the dashboard's static files are served from; the default is dist/dashboard (./dashboard.ts). */
  readonly dashboardRoot?: string;
}

interface ServerState extends ServerOptions {
  readonly access: AccessGuard;
  readonly guard: RequestGuard;
  readonly events: EventStreamHub;
}

/** The event streams of each server, so stopServer() can end them. */
const eventHubs = new WeakMap<Server, EventStreamHub>();

function tooLargeMessage(limitBytes: number): string {
  return (
    `The request body is larger than the ${limitBytes}-byte limit. ` +
    'Raise server.max_body_size in the configuration to accept larger requests.'
  );
}

function errorFields(error: unknown): { error: string; code?: string } {
  const name = error instanceof Error ? error.name : typeof error;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? { error: name, code } : { error: name };
}

async function dispatch(req: IncomingMessage, res: ServerResponse, path: string, options: ServerState): Promise<void> {
  // Errors in the shape the client's SDK reads: Anthropic on /v1/messages, OpenAI elsewhere.
  const sendError = errorWriterFor(path);
  const refusal = options.guard.check(req);
  const authorised = refusal === undefined && options.access.allows(req, path);
  // Checked or not, the client's credential never goes further than this point.
  stripClientCredentials(req);
  if (refusal !== undefined) {
    sendError(res, refusal.status, 'invalid_request_error', refusal.code, refusal.message, { close: true });
    return;
  }
  if (!authorised) {
    sendError(res, 401, 'invalid_request_error', 'invalid_api_key', ACCESS_DENIED_MESSAGE, {
      headers: { 'WWW-Authenticate': 'Bearer realm="tollwise"' },
      close: true,
    });
    return;
  }

  if (exceedsDeclaredLimit(req, options.maxBodyBytes)) {
    sendError(res, 413, 'invalid_request_error', 'request_too_large', tooLargeMessage(options.maxBodyBytes), {
      close: true,
    });
    return;
  }

  const method = req.method ?? 'GET';
  const result = matchRoute(method, path, options.routes ?? ROUTES);
  if (result.kind === 'not_found') {
    sendError(res, 404, 'not_found_error', 'not_found', 'Not found: this path is not a Tollwise endpoint.', {
      close: true,
    });
    return;
  }
  if (result.kind === 'method_not_allowed') {
    sendError(
      res,
      405,
      'invalid_request_error',
      'method_not_allowed',
      `Method ${method} is not allowed on this endpoint. Allowed: ${result.allow.join(', ')}.`,
      { headers: { Allow: result.allow.join(', ') }, close: true },
    );
    return;
  }

  try {
    await result.route.handler({
      req,
      res,
      path,
      maxBodyBytes: options.maxBodyBytes,
      logger: options.logger,
      events: options.events,
      ...(options.analytics !== undefined ? { analytics: options.analytics } : {}),
      ...(options.healthMonitor !== undefined ? { healthMonitor: options.healthMonitor } : {}),
      ...(options.proxy !== undefined ? { proxy: options.proxy } : {}),
      ...(options.dashboardRoot !== undefined ? { dashboardRoot: options.dashboardRoot } : {}),
    });
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      if (!res.headersSent) {
        sendError(res, 413, 'invalid_request_error', 'request_too_large', tooLargeMessage(error.limitBytes), {
          close: true,
        });
      } else {
        res.destroy();
      }
      return;
    }
    options.logger.error('request handler failed', { method, path, ...errorFields(error) });
    if (!res.headersSent) {
      sendError(res, 500, 'server_error', 'internal_error', 'Tollwise hit an internal error handling this request.', {
        close: true,
      });
    } else {
      res.destroy();
    }
  }
}

function handleRequest(req: IncomingMessage, res: ServerResponse, options: ServerState): void {
  // A request pipelined behind an early answer on the same connection is never dispatched: the
  // connection closes once that answer is sent, and this request gets no answer at all.
  if (isConnectionClosing(req.socket)) {
    req.resume();
    return;
  }
  const started = performance.now();
  const method = req.method ?? 'GET';
  const path = requestPath(req.url);
  setDiscardLimits(req, options.discardLimits ?? DEFAULT_DISCARD_LIMITS);

  res.once('close', () => {
    const fields = {
      method,
      path,
      status: res.statusCode,
      duration_ms: Math.round((performance.now() - started) * 100) / 100,
      ...(res.writableFinished ? {} : { aborted: true }),
    };
    options.logger.info('request', fields);
  });

  dispatch(req, res, path, options).catch((error: unknown) => {
    // dispatch() handles its own errors; this only guards against a failure while writing the error response.
    options.logger.error('request handler failed', { method, path, ...errorFields(error) });
    res.destroy();
  });
}

function handleClientError(error: Error & { code?: string }, socket: Socket, logger: Logger): void {
  // A client that simply hangs up is not worth a log line.
  if (error.code === 'ECONNRESET' || !socket.writable) {
    socket.destroy();
    return;
  }
  logger.warn('malformed request rejected', { code: error.code ?? 'unknown' });
  const status = error.code === 'HPE_HEADER_OVERFLOW' ? '431 Request Header Fields Too Large' : '400 Bad Request';
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/** Creates the Tollwise HTTP server. It does not listen yet; see listen(). */
export function createTollwiseServer(options: ServerOptions): Server {
  const state: ServerState = {
    ...options,
    access: createAccessGuard(options.accessKey),
    guard: createRequestGuard({
      ...(options.allowedHosts !== undefined ? { allowedHosts: options.allowedHosts } : {}),
      ...(options.listenHost !== undefined ? { listenHost: options.listenHost } : {}),
    }),
    events: createEventStreamHub(options.healthMonitor, options.eventStream),
  };
  // requireHostHeader off: a request without Host reaches the guard and gets its 421, not a bare 400.
  const server = createServer({ requireHostHeader: false }, (req, res) => {
    handleRequest(req, res, state);
  });
  server.on('clientError', (error: Error & { code?: string }, socket: Socket) => {
    handleClientError(error, socket, options.logger);
  });
  eventHubs.set(server, state.events);
  return server;
}

/** Formats the base URL for a bound address; IPv6 hosts are bracketed. */
export function baseUrl(host: string, port: number): string {
  const bare = host.replace(/^\[(.*)\]$/, '$1');
  return `http://${bare.includes(':') ? `[${bare}]` : bare}:${port}`;
}

/** Starts listening on `host:port`; resolves with the bound address, rejects with the listen error. */
export function listen(server: Server, host: string, port: number): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve(server.address() as AddressInfo);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ host: host.replace(/^\[(.*)\]$/, '$1'), port, exclusive: true });
  });
}

/**
 * Stops accepting connections and resolves once every connection has closed. Open event streams end
 * and idle keep-alive connections close at once; requests in flight get `graceMs` to finish before
 * their connections are cut.
 */
export function stopServer(server: Server, graceMs: number): Promise<void> {
  // Streams never finish on their own: ended first, whether or not the server is still listening.
  eventHubs.get(server)?.closeAll();
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    const timer = setTimeout(() => server.closeAllConnections(), graceMs);
    timer.unref();
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
    server.closeIdleConnections();
  });
}
