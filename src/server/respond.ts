// JSON responses written by Tollwise itself (never a relayed provider response).
//
// Errors use the OpenAI error shape, `{ "error": { "message", "type", "param", "code" } }`, which the official
// OpenAI SDK turns into a readable exception, except on the Anthropic Messages endpoint (/v1/messages),
// where they use the Anthropic shape, `{ "type": "error", "error": { "type", "message" } }`, which the
// Anthropic SDK reads (see errorWriterFor in ./router.ts). Every response carries `Cache-Control: no-store`
// and `X-Content-Type-Options: nosniff`. When the request still has an unread body (an early 413, 404, 501, ...),
// the connection is closed after the response, once the rest of that body has been read and dropped under
// fixed byte and time bounds (see discardBody in ./body.ts). Nothing of it is kept.
//
// A response sent with `Connection: close` also marks its connection as closing: a request pipelined
// behind it on the same connection is never dispatched (see isConnectionClosing).

import type { ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { discardBody, hasUnreadBody } from './body.ts';

export type ErrorType =
  | 'invalid_request_error'
  | 'not_found_error'
  | 'authentication_error'
  | 'permission_error'
  | 'rate_limit_error'
  | 'server_error';

export interface ErrorBody {
  readonly error: {
    readonly message: string;
    readonly type: ErrorType;
    readonly param: null;
    readonly code: string;
  };
}

export interface SendOptions {
  /** Extra response headers. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Close the connection after this response, whatever the request body state. */
  readonly close?: boolean;
}

const closingConnections = new WeakSet<Socket>();

/** Marks a connection as closing: no further request on it is dispatched. */
export function markConnectionClosing(socket: Socket): void {
  closingConnections.add(socket);
}

/** True once a response on this connection was sent with `Connection: close`. */
export function isConnectionClosing(socket: Socket): boolean {
  return closingConnections.has(socket);
}

/** Writes `body` as JSON with `status`. Does nothing when the response was already started. */
export function sendJson(res: ServerResponse, status: number, body: unknown, options: SendOptions = {}): void {
  if (res.headersSent || res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(payload));
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  for (const [name, value] of Object.entries(options.headers ?? {})) res.setHeader(name, value);
  const unreadBody = hasUnreadBody(res.req);
  if (options.close === true || unreadBody) {
    res.setHeader('Connection', 'close');
    markConnectionClosing(res.req.socket);
  }
  res.end(payload);
  // The rest of an unread body is dropped (never kept) before the connection closes; see discardBody.
  if (unreadBody) discardBody(res.req);
}

/** Builds an OpenAI-shaped error body. */
export function errorBody(message: string, type: ErrorType, code: string): ErrorBody {
  return { error: { message, type, param: null, code } };
}

/** Writes one error response in an API format's error shape; sendError and sendAnthropicError are two. */
export type ErrorWriter = (
  res: ServerResponse,
  status: number,
  type: ErrorType,
  code: string,
  message: string,
  options?: SendOptions,
) => void;

/** Writes an OpenAI-shaped error response. */
export function sendError(
  res: ServerResponse,
  status: number,
  type: ErrorType,
  code: string,
  message: string,
  options: SendOptions = {},
): void {
  sendJson(res, status, errorBody(message, type, code), options);
}

// ---------------------------------------------------------------- Anthropic shape

/** The error types of the Anthropic Messages API. */
export type AnthropicErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'billing_error'
  | 'permission_error'
  | 'not_found_error'
  | 'request_too_large'
  | 'rate_limit_error'
  | 'api_error'
  | 'timeout_error'
  | 'overloaded_error';

export interface AnthropicErrorBody {
  readonly type: 'error';
  readonly error: { readonly type: AnthropicErrorType; readonly message: string };
}

/** The Anthropic error type the Anthropic API itself uses for a status. */
const ANTHROPIC_TYPE_BY_STATUS: Readonly<Record<number, AnthropicErrorType>> = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  402: 'billing_error',
  403: 'permission_error',
  404: 'not_found_error',
  413: 'request_too_large',
  429: 'rate_limit_error',
  500: 'api_error',
  504: 'timeout_error',
  529: 'overloaded_error',
};

/**
 * The Anthropic error type for an answer: the one Anthropic uses for the status when there is one, else
 * the Anthropic equivalent of `type` (server_error becomes api_error).
 */
export function anthropicErrorType(status: number, type: ErrorType): AnthropicErrorType {
  return ANTHROPIC_TYPE_BY_STATUS[status] ?? (type === 'server_error' ? 'api_error' : type);
}

/** Builds an Anthropic-shaped error body. */
export function anthropicErrorBody(status: number, type: ErrorType, message: string): AnthropicErrorBody {
  return { type: 'error', error: { type: anthropicErrorType(status, type), message } };
}

/**
 * Writes an Anthropic-shaped error response, `{ "type": "error", "error": { "type", "message" } }`, which
 * the official Anthropic SDK turns into a readable exception. Takes the same arguments as sendError; the
 * code has no place in the Anthropic shape and is not sent (the message says the same in words).
 */
export function sendAnthropicError(
  res: ServerResponse,
  status: number,
  type: ErrorType,
  _code: string,
  message: string,
  options: SendOptions = {},
): void {
  sendJson(res, status, anthropicErrorBody(status, type, message), options);
}
