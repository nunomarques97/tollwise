// The live event stream behind GET /api/events: a text/event-stream the dashboard reads with fetch
// streaming (EventSource cannot send the access key header, and the key never goes in a URL).
//
// Two kinds of event, each one `event:` line and one `data:` line holding a single JSON object:
// - `request`: one per request outcome, as soon as it is emitted (src/proxy/outcome.ts), in the same
//   shape as an entry of GET /api/requests (toRecentEntry in src/analytics/metrics.ts). Outcomes carry
//   metadata only and their model ids are already redacted; nothing else from a request is sent.
// - `health`: the provider health snapshot, in the shape of GET /api/health, once when a stream opens
//   and then every healthIntervalMs (5 s by default).
//
// Bounds:
// - at most maxStreams streams at once (16 by default); one more is answered 503 with a fixed message;
// - a client that stops reading is cut off once maxBufferedBytes of events are waiting for it, so a
//   stalled reader never makes the server buffer without limit;
// - the outcome listener and the health timer exist only while at least one stream is open; the last
//   stream to close removes both, so an idle server holds no timer and no listener;
// - a stream ends when the client disconnects, and closeAll() ends every stream at shutdown (and refuses
//   any new one). Each
//   response is sent with `Connection: close`, so ending it also closes its connection.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { toRecentEntry } from '../analytics/metrics.ts';
import type { HealthMonitor } from '../health/monitor.ts';
import { onRequestOutcome, type RequestOutcome, type RequestOutcomeListener } from '../proxy/outcome.ts';
import { markConnectionClosing, sendError } from './respond.ts';
import { formatHealthSnapshot } from './router.ts';

/** Default number of event streams open at once. */
export const DEFAULT_MAX_EVENT_STREAMS = 16;
/** Default delay between two health snapshots on a stream. */
export const DEFAULT_HEALTH_INTERVAL_MS = 5_000;
/** Default amount of unsent event data a stream may hold before its client is cut off. */
export const DEFAULT_MAX_BUFFERED_BYTES = 1024 * 1024;

export const STREAMS_CLOSED_MESSAGE = 'Tollwise is stopping and opens no new event stream.';

export const STREAM_LIMIT_MESSAGE =
  'Too many open event streams. Close another dashboard tab or client reading /api/events, then try again.';

export interface EventStreamOptions {
  /** Most streams open at once. Default DEFAULT_MAX_EVENT_STREAMS (16). */
  readonly maxStreams?: number;
  /** Delay between health snapshots. Default DEFAULT_HEALTH_INTERVAL_MS (5000). */
  readonly healthIntervalMs?: number;
  /** Unsent bytes a stream may hold before it is cut off. Default DEFAULT_MAX_BUFFERED_BYTES (1 MiB). */
  readonly maxBufferedBytes?: number;
  /** Where outcomes come from. Default: onRequestOutcome from src/proxy/outcome.ts. */
  readonly subscribe?: (listener: RequestOutcomeListener) => () => void;
}

export interface EventStreamHub {
  /** Streams open right now. */
  readonly size: number;
  /**
   * Answers `res` with a new stream, or with a 503 when maxStreams are already open. HEAD gets the
   * stream's headers and no stream.
   */
  open(req: IncomingMessage, res: ServerResponse): void;
  /** Ends every open stream, for shutdown. Any stream asked for afterwards is refused with a 503. */
  closeAll(): void;
}

/** Formats one server-sent event. JSON.stringify never emits a raw line break, so `data` is one line. */
export function formatEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function createEventStreamHub(
  healthMonitor: HealthMonitor | undefined,
  options: EventStreamOptions = {},
): EventStreamHub {
  const maxStreams = options.maxStreams ?? DEFAULT_MAX_EVENT_STREAMS;
  const intervalMs = options.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS;
  const maxBuffered = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
  const subscribe = options.subscribe ?? onRequestOutcome;

  const streams = new Set<ServerResponse>();
  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  const healthEvent = (): string =>
    formatEvent('health', formatHealthSnapshot(healthMonitor?.snapshot() ?? { providers: [] }));

  const write = (res: ServerResponse, chunk: string): void => {
    if (res.writableEnded || res.destroyed) return;
    res.write(chunk);
    // A reader that does not keep up is dropped rather than buffered for without limit.
    if (res.writableLength > maxBuffered) res.destroy();
  };

  const broadcast = (chunk: string): void => {
    for (const res of streams) write(res, chunk);
  };

  const onOutcome = (outcome: RequestOutcome): void => {
    broadcast(formatEvent('request', toRecentEntry(outcome)));
  };

  const detach = (res: ServerResponse): void => {
    if (!streams.delete(res)) return;
    if (streams.size > 0) return;
    unsubscribe?.();
    unsubscribe = undefined;
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };

  const attach = (res: ServerResponse): void => {
    streams.add(res);
    if (unsubscribe === undefined) unsubscribe = subscribe(onOutcome);
    if (timer === undefined) {
      // Only ever running while a stream's connection is open, so it keeps nothing alive on its own.
      timer = setInterval(() => broadcast(healthEvent()), intervalMs);
    }
  };

  const writeHead = (res: ServerResponse): void => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      Connection: 'close',
    });
    markConnectionClosing(res.req.socket);
  };

  return {
    get size() {
      return streams.size;
    },
    open(req, res) {
      if (req.method === 'HEAD') {
        writeHead(res);
        res.end();
        return;
      }
      if (closed) {
        sendError(res, 503, 'server_error', 'shutting_down', STREAMS_CLOSED_MESSAGE, { close: true });
        return;
      }
      if (streams.size >= maxStreams) {
        sendError(res, 503, 'server_error', 'too_many_event_streams', STREAM_LIMIT_MESSAGE, {
          headers: { 'Retry-After': String(Math.ceil(intervalMs / 1000)) },
          close: true,
        });
        return;
      }
      writeHead(res);
      attach(res);
      res.on('close', () => detach(res));
      // The first snapshot goes out at once, so a new client has the providers' state without waiting.
      write(res, healthEvent());
    },
    closeAll() {
      closed = true;
      for (const res of [...streams]) {
        detach(res);
        res.end();
      }
    },
  };
}
