// One outbound call to a provider, on node:http / node:https.
//
// What leaves the machine is decided here, so the rules are strict:
// - Only an allow-list of client headers is forwarded (content type, accept, user agent and, to a provider
//   that speaks the Anthropic format, the anthropic-version / anthropic-beta headers). Everything else the
//   client sent is dropped: its own credentials (Authorization, x-api-key, cookies), x-tollwise-* routing
//   headers, hop-by-hop and proxy headers. The credentials sent are the adapter's, built from the
//   environment at call time.
// - Three timeouts apply (routing.timeouts): connect_ms from the start of the call until the connection
//   (TCP, plus TLS for https) is ready; first_byte_ms from that moment until the response headers arrive;
//   total_ms from the start of the call until the response body has been read to its end.
// - When the caller's signal aborts (the client went away), the upstream request is destroyed at once, so
//   the provider sees the connection close and stops generating.
// - A log line carries at most the provider id, the HTTP status, the error kind and the duration. The URL,
//   headers and bodies are never logged.

import http, { type ClientRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import https from 'node:https';
import type { Socket } from 'node:net';
import { performance } from 'node:perf_hooks';
import { StringDecoder } from 'node:string_decoder';
import type { Environment } from '../config/load.ts';
import type { Config } from '../config/schema.ts';
import { getLogger, type Logger } from '../log/logger.ts';
import { MAX_ERROR_BODY_BYTES } from '../providers/health.ts';
import type { ProviderAdapter, ProviderError, ProviderFailure } from '../providers/types.ts';

export type UpstreamTimeouts = Config['routing']['timeouts'];

/** Client request headers that may be forwarded to any provider. Names are lower case. */
export const FORWARDED_CLIENT_HEADERS: readonly string[] = ['content-type', 'accept', 'user-agent'];

/** Client request headers forwarded only to a provider that speaks the Anthropic format. */
export const FORWARDED_ANTHROPIC_HEADERS: readonly string[] = ['anthropic-version', 'anthropic-beta'];

/**
 * Response headers never handed back to the caller: hop-by-hop headers describe the connection to the
 * provider, not the response, and cookies set by a provider (or the CDN in front of it) are not meant for
 * the client of the proxy.
 */
export const DROPPED_RESPONSE_HEADERS: readonly string[] = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'set-cookie',
];

/** A header value that can be written on the wire: visible ASCII, spaces, tabs and obs-text only. */
const VALID_HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;

export interface UpstreamRequest {
  readonly adapter: ProviderAdapter;
  /** Where the adapter reads its key from, at call time. */
  readonly env: Environment;
  /** Path on the provider, appended to its base URL (e.g. adapter.chatPath). */
  readonly path: string;
  /** Default: POST. */
  readonly method?: 'POST' | 'GET';
  /** The request body as it must be sent (already translated, if needed). */
  readonly body?: string | Uint8Array;
  /** The headers of the incoming client request; only the allow-listed ones are forwarded. */
  readonly clientHeaders: IncomingHttpHeaders;
  readonly timeouts: UpstreamTimeouts;
  /** Aborts the upstream call (e.g. when the client disconnects). */
  readonly signal?: AbortSignal;
  /** Default: the process-wide logger. */
  readonly logger?: Logger;
}

/** How the response body ended; resolved once, never rejected. */
export type UpstreamCompletion =
  | { readonly type: 'complete'; readonly durationMs: number }
  | { readonly type: 'error'; readonly error: ProviderError; readonly durationMs: number }
  | { readonly type: 'aborted'; readonly durationMs: number };

export type UpstreamResult =
  | {
      readonly type: 'response';
      /** A 2xx status. Any other status is returned as an error. */
      readonly status: number;
      /** Response headers without hop-by-hop headers and cookies (see DROPPED_RESPONSE_HEADERS). */
      readonly headers: Readonly<Record<string, string | string[]>>;
      /**
       * The response body as raw bytes. The caller must read it to its end or destroy it. When total_ms
       * passes, the connection fails or the signal aborts, the stream is destroyed with an
       * UpstreamBodyError; `completion` says which. A caller that destroys the body itself before its end
       * gets `completion` of type `error` with the `connection` kind: the call did not complete.
       */
      readonly body: IncomingMessage;
      readonly completion: Promise<UpstreamCompletion>;
    }
  | { readonly type: 'error'; readonly error: ProviderError }
  | { readonly type: 'aborted' };

/** The error a response body stream is destroyed with when it cannot be read to its end. */
export class UpstreamBodyError extends Error {
  /** Why the body stopped; null when the caller aborted. */
  readonly failure: ProviderError | null;

  constructor(failure: ProviderError | null) {
    super(failure === null ? 'upstream response aborted' : `upstream response failed: ${failure.kind}`);
    this.name = 'UpstreamBodyError';
    this.failure = failure;
  }
}

function headerText(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  const text = Array.isArray(value) ? value.join(', ') : value;
  return VALID_HEADER_VALUE.test(text) ? text : undefined;
}

/**
 * The exact headers sent to the provider, apart from `host` and `connection`, which Node sets.
 * Client headers come first and the adapter's authentication headers override them.
 */
export function buildOutboundHeaders(
  adapter: ProviderAdapter,
  env: Environment,
  clientHeaders: IncomingHttpHeaders,
  body: Uint8Array | undefined,
): Record<string, string> {
  const allowed = new Set(FORWARDED_CLIENT_HEADERS);
  if (adapter.wireFormat === 'anthropic') for (const name of FORWARDED_ANTHROPIC_HEADERS) allowed.add(name);

  const headers: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(clientHeaders)) {
    const name = rawName.toLowerCase();
    if (!allowed.has(name)) continue;
    const value = headerText(rawValue);
    if (value !== undefined) headers[name] = value;
  }
  if (body !== undefined && headers['content-type'] === undefined) headers['content-type'] = 'application/json';
  // Node does not decompress responses; asking for the identity encoding keeps the body passthrough simple.
  headers['accept-encoding'] = 'identity';
  if (body !== undefined) headers['content-length'] = String(body.byteLength);
  // Last, so a client can never replace the provider credentials or the adapter's protocol headers.
  Object.assign(headers, adapter.authHeaders(env));
  return headers;
}

function responseHeaders(headers: IncomingHttpHeaders): Record<string, string | string[]> {
  const dropped = new Set(DROPPED_RESPONSE_HEADERS);
  const result: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || dropped.has(name)) continue;
    result[name] = value;
  }
  return result;
}

function elapsed(started: number): number {
  return Math.round(performance.now() - started);
}

/**
 * Sends one request to a provider. Resolves (never rejects) with the response, a ProviderError, or
 * `aborted` when the caller's signal fired before the response headers arrived.
 */
export function callUpstream(request: UpstreamRequest): Promise<UpstreamResult> {
  const { adapter, env, timeouts, signal } = request;
  const logger = request.logger ?? getLogger();
  const provider = adapter.id;
  const started = performance.now();

  if (signal?.aborted) {
    logger.debug('upstream call aborted', { provider, durationMs: 0 });
    return Promise.resolve({ type: 'aborted' });
  }

  const body = typeof request.body === 'string' ? Buffer.from(request.body, 'utf8') : request.body;
  let headers: Record<string, string>;
  let url: URL;
  try {
    headers = buildOutboundHeaders(adapter, env, request.clientHeaders, body);
  } catch (error) {
    // The adapter explains what is missing (the variable name, never its value).
    const message = error instanceof Error ? error.message : 'credentials unavailable';
    const failure: ProviderError = { kind: 'auth', status: null, message };
    logger.warn('upstream call failed', { provider, errorKind: failure.kind, durationMs: 0 });
    return Promise.resolve({ type: 'error', error: failure });
  }
  try {
    url = new URL(adapter.url(request.path));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported protocol');
  } catch {
    const failure = adapter.mapError('connection');
    logger.warn('upstream call failed', { provider, errorKind: failure.kind, durationMs: 0 });
    return Promise.resolve({ type: 'error', error: failure });
  }
  const secure = url.protocol === 'https:';

  return new Promise<UpstreamResult>((resolve) => {
    let settled = false;
    let bodyFinished = false;
    let status = 0;
    let response: IncomingMessage | undefined;
    let resolveCompletion: (completion: UpstreamCompletion) => void = () => undefined;
    const timers = new Set<NodeJS.Timeout>();

    const startTimer = (ms: number, onTimeout: () => void): NodeJS.Timeout => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        onTimeout();
      }, ms);
      timers.add(timer);
      return timer;
    };
    const stopTimer = (timer: NodeJS.Timeout | undefined): void => {
      if (timer === undefined) return;
      clearTimeout(timer);
      timers.delete(timer);
    };
    const cleanup = (): void => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      signal?.removeEventListener('abort', onAbort);
    };

    /** Ends the call before a response was handed to the caller. */
    const settle = (result: UpstreamResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      req.destroy();
      if (result.type === 'error') {
        const fields = { provider, errorKind: result.error.kind, durationMs: elapsed(started) };
        logger.warn('upstream call failed', result.error.status === null ? fields : { ...fields, status });
      } else if (result.type === 'aborted') {
        logger.debug('upstream call aborted', { provider, durationMs: elapsed(started) });
      }
      resolve(result);
    };
    const fail = (failure: ProviderFailure, errorBody?: string): void => {
      settle({ type: 'error', error: adapter.mapError(failure, errorBody) });
    };

    /** Ends the body of a response already handed to the caller. */
    const finishBody = (completion: UpstreamCompletion): void => {
      if (bodyFinished) return;
      bodyFinished = true;
      cleanup();
      if (completion.type === 'complete') {
        logger.debug('upstream response complete', { provider, status, durationMs: completion.durationMs });
      } else if (completion.type === 'error') {
        logger.warn('upstream response failed', {
          provider,
          status,
          errorKind: completion.error.kind,
          durationMs: completion.durationMs,
        });
        response?.destroy(new UpstreamBodyError(completion.error));
      } else {
        logger.debug('upstream response aborted', { provider, status, durationMs: completion.durationMs });
        response?.destroy(new UpstreamBodyError(null));
      }
      // A body read to its end leaves the connection to the agent for reuse; any other end closes it.
      if (completion.type !== 'complete') req.destroy();
      resolveCompletion(completion);
    };
    const failBody = (failure: 'timeout' | 'connection'): void => {
      if (response === undefined) return;
      finishBody({ type: 'error', error: adapter.mapError(failure), durationMs: elapsed(started) });
    };

    function onAbort(): void {
      if (!settled) settle({ type: 'aborted' });
      else finishBody({ type: 'aborted', durationMs: elapsed(started) });
    }

    const transport = secure ? https : http;
    const req: ClientRequest = transport.request(url, { method: request.method ?? 'POST', headers });

    let connectTimer: NodeJS.Timeout | undefined = startTimer(timeouts.connect_ms, () => fail('timeout'));
    let firstByteTimer: NodeJS.Timeout | undefined;
    startTimer(timeouts.total_ms, () => {
      if (!settled) fail('timeout');
      else if (response !== undefined) failBody('timeout');
    });

    const onConnected = (): void => {
      if (settled || connectTimer === undefined) return;
      stopTimer(connectTimer);
      connectTimer = undefined;
      firstByteTimer = startTimer(timeouts.first_byte_ms, () => fail('timeout'));
    };
    req.once('socket', (socket: Socket) => {
      if (req.reusedSocket || (!secure && !socket.connecting)) onConnected();
      else socket.once(secure ? 'secureConnect' : 'connect', onConnected);
    });

    req.on('error', () => {
      // The error text is dropped: it can repeat the host name or the URL.
      if (!settled) fail('connection');
      // settle() destroys the request, which makes it emit 'error' (socket hang up) after a timeout or an
      // abort; that is not a connection failure. Only a body already handed out can still fail here.
      else if (response !== undefined) failBody('connection');
    });

    req.once('response', (res: IncomingMessage) => {
      if (settled) {
        res.destroy();
        return;
      }
      stopTimer(firstByteTimer);
      stopTimer(connectTimer);
      status = res.statusCode ?? 0;

      if (status < 200 || status > 299) {
        // Read a capped part of the error body for the message, still under total_ms and the signal.
        const chunks: Buffer[] = [];
        let size = 0;
        const done = (): void => {
          if (settled) return;
          // StringDecoder.write keeps back a UTF-8 character cut by the cap instead of mangling it.
          fail(status, new StringDecoder('utf8').write(Buffer.concat(chunks).subarray(0, MAX_ERROR_BODY_BYTES)));
        };
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
          size += chunk.byteLength;
          if (size >= MAX_ERROR_BODY_BYTES) done();
        });
        res.on('end', done);
        res.on('error', done);
        res.on('close', done);
        return;
      }

      settled = true;
      response = res;
      // The caller consumes the body through its own listeners (pipeline, async iteration); this one only
      // keeps a destroyed body from surfacing as an unhandled 'error' event.
      res.on('error', () => undefined);
      res.once('end', () => finishBody({ type: 'complete', durationMs: elapsed(started) }));
      res.once('close', () => {
        if (!res.readableEnded) failBody('connection');
      });
      const completion = new Promise<UpstreamCompletion>((resolveIt) => {
        resolveCompletion = resolveIt;
      });
      logger.debug('upstream response', { provider, status, durationMs: elapsed(started) });
      resolve({ type: 'response', status, headers: responseHeaders(res.headers), body: res, completion });
    });

    signal?.addEventListener('abort', onAbort, { once: true });
    req.end(body);
  });
}
