// Preloaded with `node --import` into a Tollwise child process by test/start.test.ts: reports on stderr
// every outbound connection or datagram the process starts, so a test can prove it contacts nothing it
// was not configured to contact. TCP and TLS clients (node:http, node:https, fetch) all go through
// net.Socket.prototype.connect; UDP goes through dgram.Socket.prototype.send. Never import this file
// into a test process itself: loading it patches that process.

import dgram from 'node:dgram';
import net from 'node:net';

/** Start of every line this recorder writes; test/start.test.ts repeats it rather than importing it. */
const MARKER = 'outbound-recorder:';

function describeTarget(args: readonly unknown[]): string {
  // net.connect() passes its normalised [options, callback] pair as one array argument.
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (typeof first !== 'object' || first === null) return String(first);
  const target = first as { host?: unknown; port?: unknown; path?: unknown };
  return target.path == null ? `${String(target.host)}:${String(target.port)}` : String(target.path);
}

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function recordConnect(this: net.Socket, ...args: unknown[]) {
  process.stderr.write(`${MARKER} connect ${describeTarget(args)}\n`);
  return (connect as (...a: unknown[]) => net.Socket).apply(this, args);
} as typeof connect;

const send = dgram.Socket.prototype.send;
dgram.Socket.prototype.send = function recordSend(this: dgram.Socket, ...args: unknown[]) {
  process.stderr.write(`${MARKER} datagram\n`);
  return (send as (...a: unknown[]) => void).apply(this, args);
} as typeof send;

process.stderr.write(`${MARKER} loaded\n`);
