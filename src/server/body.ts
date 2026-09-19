// Reading request bodies under the configured size limit (`server.max_body_size`).
//
// A body is refused as soon as it is known to be too large: before reading anything when Content-Length
// already says so, or at the first chunk that crosses the limit for a chunked body. Reading then stops;
// the chunks received so far are dropped and the rest of the body is never buffered.

import type { IncomingMessage } from 'node:http';

/** Thrown when a request body is larger than the configured limit. The server answers 413. */
export class PayloadTooLargeError extends Error {
  readonly limitBytes: number;

  constructor(limitBytes: number) {
    super(`request body is larger than the ${limitBytes}-byte limit`);
    this.name = 'PayloadTooLargeError';
    this.limitBytes = limitBytes;
  }
}

/** The declared Content-Length, or undefined when the request does not declare one. */
export function declaredLength(req: IncomingMessage): number | undefined {
  const value = req.headers['content-length'];
  if (value === undefined) return undefined;
  const length = Number(value);
  return Number.isSafeInteger(length) && length >= 0 ? length : undefined;
}

/** True when the request declares a Content-Length above `limitBytes`. */
export function exceedsDeclaredLimit(req: IncomingMessage, limitBytes: number): boolean {
  const length = declaredLength(req);
  return length !== undefined && length > limitBytes;
}

/**
 * Reads the whole request body, refusing it with PayloadTooLargeError once it passes `limitBytes`.
 * Rejects with the stream error when the client aborts.
 */
export function readBody(req: IncomingMessage, limitBytes: number): Promise<Buffer> {
  if (exceedsDeclaredLimit(req, limitBytes)) return Promise.reject(new PayloadTooLargeError(limitBytes));
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;

    const cleanup = (): void => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('close', onClose);
    };
    const onData = (chunk: Buffer): void => {
      received += chunk.length;
      if (received > limitBytes) {
        cleanup();
        req.pause();
        chunks.length = 0;
        reject(new PayloadTooLargeError(limitBytes));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      cleanup();
      resolve(Buffer.concat(chunks, received));
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onClose = (): void => {
      // Only reached when the stream closed before 'end': onEnd removes this listener.
      cleanup();
      reject(new Error('the client closed the connection before the request body was complete'));
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('close', onClose);
  });
}

/** Bounds on reading and discarding the unread rest of a request body after an early response. */
export interface DiscardLimits {
  /** Bytes discarded before the connection is closed instead of kept for another request. */
  readonly maxBytes: number;
  /** Time spent discarding before the connection is closed. */
  readonly maxMs: number;
  /** After Tollwise closes its side, how long it keeps reading and dropping bytes before cutting the socket. */
  readonly lingerMs: number;
}

export const DEFAULT_DISCARD_LIMITS: DiscardLimits = { maxBytes: 8 * 1024 * 1024, maxMs: 10_000, lingerMs: 2_000 };

const discardLimitsByRequest = new WeakMap<IncomingMessage, DiscardLimits>();

/** Sets the discard limits for one request (the server does this from its options). */
export function setDiscardLimits(req: IncomingMessage, limits: DiscardLimits): void {
  discardLimitsByRequest.set(req, limits);
}

/** True when the request announced a body (Content-Length above 0, or chunked) that has not been read to the end. */
export function hasUnreadBody(req: IncomingMessage): boolean {
  const length = req.headers['content-length'];
  const announced = (length !== undefined && length !== '0') || req.headers['transfer-encoding'] !== undefined;
  return announced && !req.readableEnded;
}

/**
 * Takes over closing the connection of a request whose body is still unread when Tollwise answers early
 * (413, 404, 501, ...). Call it right after `res.end()` of a response sent with `Connection: close`.
 *
 * Why: with `Connection: close`, Node destroys the socket as soon as the response is flushed. The client is
 * usually still uploading, and destroying a socket with unread incoming data makes the kernel send a reset
 * that wipes out the response before the client reads it (fetch reports ECONNRESET instead of the status).
 * So the socket's sending side is only half-closed after the response, and the rest of the body is read and
 * dropped, never kept. Once the body has ended the socket is destroyed. When the body goes past `maxBytes`
 * or takes longer than `maxMs`, dropping continues for `lingerMs` more (so the client can read the answer),
 * then the socket is destroyed whatever the client does.
 */
export function discardBody(req: IncomingMessage): void {
  const socket = req.socket;
  const limits = discardLimitsByRequest.get(req) ?? DEFAULT_DISCARD_LIMITS;

  // Node calls destroySoon() once a `Connection: close` response is flushed; make it a half-close only.
  const withDestroySoon = socket as typeof socket & { destroySoon?: () => void };
  if (typeof withDestroySoon.destroySoon === 'function') withDestroySoon.destroySoon = () => socket.end();

  const timers: NodeJS.Timeout[] = [];
  const later = (ms: number, run: () => void): void => {
    const timer = setTimeout(run, ms);
    timer.unref();
    timers.push(timer);
  };
  const closeWhenSent = (): void => {
    socket.end();
    if (socket.writableFinished) socket.destroy();
    else socket.once('finish', () => socket.destroy());
  };
  let lingering = false;
  const linger = (): void => {
    if (lingering) return;
    lingering = true;
    socket.end();
    later(limits.lingerMs, () => socket.destroy());
  };
  let discarded = 0;
  const onData = (chunk: Buffer): void => {
    discarded += chunk.length;
    if (discarded > limits.maxBytes) linger();
  };

  socket.once('close', () => {
    for (const timer of timers) clearTimeout(timer);
    req.off('data', onData);
  });
  if (req.readableEnded) {
    closeWhenSent();
    return;
  }
  later(limits.maxMs, linger);
  req.on('data', onData);
  req.once('end', closeWhenSent);
  req.resume();
}
