// Server-sent events (SSE) relay: provider stream bytes go to the client as they arrive, while a small
// scanner watches the events go by so the route can read the few it cares about (the usage report).
//
// The scanner never re-serialises anything. Each chunk is split on line feeds once; the lines of the
// current event are kept only as long as the event has not ended, and never beyond maxEventBytes. An
// event (or a single line) larger than that is not buffered and not read: its bytes keep flowing and the
// route simply does not see it. So the work per chunk is proportional to its size, and the memory held
// per stream is bounded, whatever the provider sends.
//
// Two modes:
// - passthrough (default): every chunk is forwarded as is, the moment it arrives, before it is scanned.
//   What the client receives is byte for byte what the provider sent.
// - hold: the bytes of the current event are held until the event ends (its blank line), so the route
//   can drop that one event. Providers write whole events per chunk, so this adds no delay in practice.
//   An event that grows past maxEventBytes is released at once and passed through to its end.
//
// Lines end with LF or CRLF (every supported provider uses one of them). A stream that separates lines
// with a lone CR is still relayed untouched; its events are just not read.

import { once } from 'node:events';
import type { Writable } from 'node:stream';

/** Default cap on the bytes of one event (or one line) the scanner keeps to read it. */
export const DEFAULT_MAX_EVENT_BYTES = 256 * 1024;

const LF = 0x0a;
const CR = 0x0d;
const COLON = 0x3a;
const SPACE = 0x20;

/** One complete event, as the SSE specification builds it from its fields. */
export interface SseEvent {
  /** The `event` field; undefined when the event has none. */
  readonly name: string | undefined;
  /** The `data` fields joined with LF, as raw bytes. */
  readonly data: Buffer;
}

/** What to do with an event: forward it (the default), or drop it (honoured in hold mode only). */
export type SseVerdict = 'forward' | 'drop';

export interface SseScannerOptions {
  /**
   * Called once for each complete event that carries data and fits under maxEventBytes, in stream order.
   * Must be cheap: it runs on the relay path.
   */
  readonly onEvent: (event: SseEvent) => SseVerdict | undefined;
  /** Hold each event's bytes until it ends, so onEvent can drop it. Default: false (pure passthrough). */
  readonly hold?: boolean;
  readonly maxEventBytes?: number;
}

/** Splits an SSE byte stream into events for an observer and decides which bytes go to the client. */
export class SseScanner implements BodyScanner {
  private readonly onEvent: SseScannerOptions['onEvent'];
  private readonly hold: boolean;
  private readonly maxEventBytes: number;

  // The current line: the pieces kept so far and its full length (pieces are dropped once it is too long).
  private lineParts: Buffer[] = [];
  private lineBytes = 0;
  private lineKept = true;

  // The current event's fields.
  private eventName: string | undefined;
  private dataParts: Buffer[] = [];
  private dataBytes = 0;
  private hasData = false;
  private unreadable = false;

  // Hold mode: the bytes of the current event not yet forwarded, or passing through (too large to hold).
  private held: Buffer[] = [];
  private heldBytes = 0;
  private releasing = false;

  constructor(options: SseScannerOptions) {
    this.onEvent = options.onEvent;
    this.hold = options.hold === true;
    this.maxEventBytes = options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES;
  }

  /** Bytes currently kept by the scanner (the current line, the current event's data and held bytes). */
  get bufferedBytes(): number {
    return (this.lineKept ? this.lineBytes : 0) + this.dataBytes + this.heldBytes;
  }

  /** Scans one chunk and appends to `out` the bytes to forward now, in order. */
  scan(chunk: Buffer, out: Buffer[]): void {
    if (!this.hold) out.push(chunk);
    let routedUpTo = 0;
    let at = 0;
    while (at < chunk.length) {
      const lineEnd = chunk.indexOf(LF, at);
      if (lineEnd === -1) {
        this.appendToLine(chunk.subarray(at));
        break;
      }
      this.appendToLine(chunk.subarray(at, lineEnd));
      at = lineEnd + 1;
      if (!this.endLine()) continue;
      // A blank line ends the event.
      if (this.hold) {
        this.route(chunk.subarray(routedUpTo, at), out);
        routedUpTo = at;
      }
      this.endEvent(out);
    }
    if (this.hold && routedUpTo < chunk.length) this.route(chunk.subarray(routedUpTo), out);
  }

  /** Ends the stream: appends to `out` whatever is still held (an unfinished last event, forwarded as is). */
  end(out: Buffer[]): void {
    if (this.heldBytes > 0) out.push(...this.held);
    this.held = [];
    this.heldBytes = 0;
  }

  private appendToLine(piece: Buffer): void {
    if (piece.length === 0) return;
    this.lineBytes += piece.length;
    if (!this.lineKept) return;
    if (this.lineBytes > this.maxEventBytes) {
      // Too long to read: stop keeping it, and the event it belongs to cannot be read either.
      this.lineKept = false;
      this.lineParts = [];
      return;
    }
    this.lineParts.push(piece);
  }

  /** Processes the line just ended; true when it was blank (the end of an event). */
  private endLine(): boolean {
    const kept = this.lineKept;
    const length = this.lineBytes;
    const parts = this.lineParts;
    this.lineParts = [];
    this.lineBytes = 0;
    this.lineKept = true;

    if (!kept) {
      this.unreadable = true;
      return false;
    }
    let line = parts.length === 1 ? (parts[0] as Buffer) : Buffer.concat(parts, length);
    if (line.length > 0 && line[line.length - 1] === CR) line = line.subarray(0, line.length - 1);
    if (line.length === 0) return true;
    if (line[0] === COLON) return false; // a comment

    const colon = line.indexOf(COLON);
    const field = (colon === -1 ? line : line.subarray(0, colon)).toString('latin1');
    let value = colon === -1 ? line.subarray(line.length) : line.subarray(colon + 1);
    if (value[0] === SPACE) value = value.subarray(1);

    if (field === 'data') {
      this.hasData = true;
      if (this.unreadable) return false;
      this.dataBytes += value.length + (this.dataParts.length > 0 ? 1 : 0);
      if (this.dataBytes > this.maxEventBytes) {
        this.unreadable = true;
        this.dataParts = [];
        this.dataBytes = 0;
        return false;
      }
      this.dataParts.push(value);
    } else if (field === 'event') {
      this.eventName = value.toString('utf8');
    }
    return false;
  }

  private endEvent(out: Buffer[]): void {
    let verdict: SseVerdict | undefined;
    if (this.hasData && !this.unreadable) {
      const parts = this.dataParts;
      let data: Buffer;
      if (parts.length === 1) data = parts[0] as Buffer;
      else {
        const joined: Buffer[] = [];
        for (const [index, part] of parts.entries()) {
          if (index > 0) joined.push(Buffer.from('\n'));
          joined.push(part);
        }
        data = Buffer.concat(joined);
      }
      verdict = this.onEvent({ name: this.eventName, data });
    }
    if (this.hold) {
      if (verdict !== 'drop' && this.heldBytes > 0) out.push(...this.held);
      this.held = [];
      this.heldBytes = 0;
      this.releasing = false;
    }
    this.eventName = undefined;
    this.dataParts = [];
    this.dataBytes = 0;
    this.hasData = false;
    this.unreadable = false;
  }

  /** Hold mode: keeps bytes of the current event, or forwards them once the event is too large to hold. */
  private route(bytes: Buffer, out: Buffer[]): void {
    if (bytes.length === 0) return;
    if (this.releasing) {
      out.push(bytes);
      return;
    }
    this.held.push(bytes);
    this.heldBytes += bytes.length;
    if (this.heldBytes > this.maxEventBytes) {
      out.push(...this.held);
      this.held = [];
      this.heldBytes = 0;
      this.releasing = true;
      // An event too large to hold is never dropped, so there is no point in reading it either.
      this.unreadable = true;
      this.dataParts = [];
      this.dataBytes = 0;
    }
  }
}

/** Decides, chunk by chunk, which bytes of a body are forwarded (SseScanner is one). */
export interface BodyScanner {
  /** Appends to `out` the bytes to forward for `chunk`, in order. */
  scan(chunk: Buffer, out: Buffer[]): void;
  /** Appends to `out` whatever is still to forward once the body has ended. */
  end(out: Buffer[]): void;
}

/** Writes `pieces` in order and waits for the destination to drain when it asks to. Empties `pieces`. */
async function writePieces(destination: Writable, pieces: Buffer[], signal: AbortSignal): Promise<void> {
  if (pieces.length === 0) return;
  let flowing = true;
  for (const piece of pieces) flowing = destination.write(piece) && flowing;
  pieces.length = 0;
  if (!flowing) await once(destination, 'drain', { signal });
}

/**
 * Relays a body to `destination` through `scanner`, chunk by chunk as it arrives, with backpressure.
 * Resolves once the source has ended and everything to forward was written; `destination` is not ended.
 * Rejects when the source fails, or when `signal` aborts while waiting for the destination to drain.
 */
export async function relayBody(
  source: AsyncIterable<Buffer>,
  destination: Writable,
  scanner: BodyScanner,
  signal: AbortSignal,
): Promise<void> {
  const pieces: Buffer[] = [];
  for await (const chunk of source) {
    scanner.scan(chunk, pieces);
    await writePieces(destination, pieces, signal);
  }
  scanner.end(pieces);
  await writePieces(destination, pieces, signal);
}
