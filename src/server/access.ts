// The local access key: when TOLLWISE_ACCESS_KEY is set, every request except GET or HEAD /healthz and GET
// or HEAD on the dashboard's static files (/dashboard and below) must carry it, either as
// `Authorization: Bearer <key>` (what the OpenAI SDKs send) or as `x-api-key: <key>` (what the Anthropic
// SDKs send). Any other method on those paths still needs the key -- and then gets a 405 from the router,
// since those routes only answer GET (and HEAD, which Node derives from it). The dashboard's files carry
// no data: what it shows comes from /api/*, which always needs the key.
//
// - The presented value and the configured key are compared as SHA-256 digests with
//   crypto.timingSafeEqual, so the comparison takes the same time whatever the presented length or content.
// - A refused request gets a fixed 401 body: nothing from the request is echoed back.
// - Whatever the outcome, and whether or not an access key is configured, the client's credential headers
//   are removed from the request before any handler sees it, so they can never be forwarded to a provider.
//   Neither the presented value nor the configured key is ever logged.

import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { isDashboardPath } from './dashboard.ts';

/**
 * Paths whose GET and HEAD requests are answered without the access key: liveness only, it reveals
 * nothing. Any other method on one of these paths still needs the key.
 */
export const ACCESS_EXEMPT_PATHS: ReadonlySet<string> = new Set(['/healthz']);

/** Methods exempt from the access key on an exempt path: read-only, no side effect. */
const ACCESS_EXEMPT_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

/**
 * Request headers that carry a client credential. All are removed before a request reaches a handler;
 * the ones beyond `authorization` and `x-api-key` are credential headers of other SDKs (Azure OpenAI,
 * Google) that must not travel either.
 */
export const CLIENT_CREDENTIAL_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'x-api-key',
  'api-key',
  'x-goog-api-key',
  'proxy-authorization',
]);

/** Message of the 401 answer. Fixed text: it never contains anything the client sent. */
export const ACCESS_DENIED_MESSAGE =
  'Missing or invalid Tollwise access key. Send the value of TOLLWISE_ACCESS_KEY as ' +
  '"Authorization: Bearer <key>" or "x-api-key: <key>" (the api_key of your OpenAI or Anthropic SDK).';

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** The credential values a request presents: the Bearer value of Authorization and x-api-key. */
function presentedValues(req: IncomingMessage): string[] {
  const values: string[] = [];
  const authorization = req.headers.authorization;
  if (typeof authorization === 'string') {
    const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(authorization);
    if (match?.[1] !== undefined) values.push(match[1]);
  }
  const apiKey = req.headers['x-api-key'];
  // A repeated x-api-key header arrives joined with ", " and so never matches: it is refused.
  if (typeof apiKey === 'string') values.push(apiKey.trim());
  return values.filter((value) => value !== '');
}

/**
 * True when a request needs no access key: GET or HEAD on an ACCESS_EXEMPT_PATHS path or on the
 * dashboard's static files (/dashboard and below, on a segment boundary; the path as sent, undecoded).
 */
export function isAccessExempt(method: string, path: string): boolean {
  return ACCESS_EXEMPT_METHODS.has(method) && (ACCESS_EXEMPT_PATHS.has(path) || isDashboardPath(path));
}

/** Decides whether requests carry the configured access key. */
export interface AccessGuard {
  /** True when an access key is configured, i.e. requests are checked at all. */
  readonly enabled: boolean;
  /** True when `path` may be served for this request. Always true when no access key is configured. */
  allows(req: IncomingMessage, path: string): boolean;
}

/**
 * Builds the guard for `accessKey` (the value of TOLLWISE_ACCESS_KEY, already validated by the config
 * loader). Undefined disables the check: every request is served and any credential header is ignored.
 * Only the key's digest is kept.
 */
export function createAccessGuard(accessKey: string | undefined): AccessGuard {
  if (accessKey === undefined || accessKey === '') {
    return { enabled: false, allows: () => true };
  }
  const expected = digest(accessKey);
  return {
    enabled: true,
    allows(req, path) {
      if (isAccessExempt(req.method ?? 'GET', path)) return true;
      let granted = false;
      // Every presented value is compared, even after a match, so timing does not depend on which header matched.
      for (const value of presentedValues(req)) {
        if (timingSafeEqual(digest(value), expected)) granted = true;
      }
      return granted;
    },
  };
}

/**
 * Removes every client credential header from `req`, both from `req.headers` and `req.rawHeaders`, so no
 * later code path (forwarding, logging) can read it.
 */
export function stripClientCredentials(req: IncomingMessage): void {
  // Node builds `headers` and `headersDistinct` lazily from rawHeaders and its original header count, so
  // both are built (and cached) here before rawHeaders shrinks, then cleaned in place.
  const { headers, headersDistinct } = req;
  for (const name of CLIENT_CREDENTIAL_HEADERS) {
    delete headers[name];
    if (headersDistinct !== undefined) delete headersDistinct[name];
  }
  const raw = req.rawHeaders;
  const kept: string[] = [];
  for (let index = 0; index + 1 < raw.length; index += 2) {
    const name = raw[index] ?? '';
    if (!CLIENT_CREDENTIAL_HEADERS.has(name.toLowerCase())) kept.push(name, raw[index + 1] ?? '');
  }
  raw.length = 0;
  raw.push(...kept);
}
