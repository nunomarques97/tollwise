// The request guard: checks every request before the access key and before routing.
//
// Tollwise holds the user's provider keys, so a request it forwards spends the user's money. A web page
// open in the user's browser can send requests to any address, 127.0.0.1 included; the guard refuses
// the ones a browser can be tricked into sending:
//
// - Host allow-list (DNS rebinding): the Host header must name this server -- 127.0.0.1, localhost,
//   [::1], the configured non-wildcard server.host or a name in server.allowed_hosts -- with the port the
//   request arrived on. A page on a rebound domain (evil.example resolving to 127.0.0.1) sends its own
//   name as Host and is answered 421.
// - Origin check (cross-site requests): a request carrying an Origin header must come from
//   http://<allowed host>:<port>; any other origin, `null` included, is answered 403. SDKs and curl send
//   no Origin and pass. No Access-Control-Allow-* header is ever sent and OPTIONS (CORS preflight) is
//   refused, so browsers never get permission to read a cross-origin answer.
// - JSON only on POST: a POST must be `Content-Type: application/json` (parameters such as charset
//   allowed), else 415. HTML forms and "simple" cross-origin fetches cannot send that type without a
//   preflight, which is refused.
//
// Every refusal is a fixed message: nothing the client sent is echoed back.

import type { IncomingMessage } from 'node:http';
import { isIPv6 } from 'node:net';
import { isWildcardAddress } from '../config/network.ts';

export const LOOPBACK_HOST_NAMES: readonly string[] = ['127.0.0.1', 'localhost', '::1'];

export const MISDIRECTED_MESSAGE =
  "The request's Host header does not name this Tollwise server. Tollwise answers only requests addressed " +
  'to 127.0.0.1, localhost or [::1] on its own port, or to a host listed in server.allowed_hosts.';

export const ORIGIN_REFUSED_MESSAGE =
  'Requests from web pages on other origins are refused: Tollwise does not support cross-origin browser requests.';

export const PREFLIGHT_REFUSED_MESSAGE =
  'Tollwise does not answer OPTIONS requests, CORS preflights included: cross-origin browser requests are not supported.';

export const JSON_REQUIRED_MESSAGE = 'POST requests must be sent with Content-Type: application/json.';

/** Why a request is refused, and the answer it gets. */
export interface GuardRefusal {
  readonly status: 403 | 415 | 421;
  readonly code: 'misdirected_request' | 'origin_not_allowed' | 'preflight_not_supported' | 'unsupported_media_type';
  readonly message: string;
}

const MISDIRECTED: GuardRefusal = { status: 421, code: 'misdirected_request', message: MISDIRECTED_MESSAGE };
const ORIGIN_REFUSED: GuardRefusal = { status: 403, code: 'origin_not_allowed', message: ORIGIN_REFUSED_MESSAGE };
const PREFLIGHT_REFUSED: GuardRefusal = {
  status: 403,
  code: 'preflight_not_supported',
  message: PREFLIGHT_REFUSED_MESSAGE,
};
const JSON_REQUIRED: GuardRefusal = { status: 415, code: 'unsupported_media_type', message: JSON_REQUIRED_MESSAGE };

/** Lower-case, without IPv6 brackets: the form host names are compared in. */
export function normaliseHostName(host: string): string {
  return host
    .trim()
    .replace(/^\[(.*)\]$/, '$1')
    .toLowerCase();
}

/**
 * Splits a Host header value (`name`, `name:port`, `[v6]`, `[v6]:port`) into its host name and port.
 * A missing port is the http default, 80. Returns undefined for anything else.
 */
export function parseHostHeader(value: string): { host: string; port: number } | undefined {
  const match = /^(\[[0-9A-Fa-f:.]+\]|[^\s[\]:/@]+)(?::(\d{1,5}))?$/.exec(value);
  if (match === null) return undefined;
  const host = normaliseHostName(match[1] ?? '');
  if (match[1]?.startsWith('[') === true && !isIPv6(host)) return undefined;
  const port = match[2] === undefined ? 80 : Number(match[2]);
  if (host === '' || port < 1 || port > 65535) return undefined;
  return { host, port };
}

/** True when `value` is `application/json`, with or without parameters, in any letter case. */
export function isJsonContentType(value: string | undefined): boolean {
  if (value === undefined) return false;
  const mediaType = value.split(';', 1)[0] ?? '';
  return mediaType.trim().toLowerCase() === 'application/json';
}

export interface RequestGuardOptions {
  /** Extra host names or addresses clients may use (server.allowed_hosts). */
  readonly allowedHosts?: readonly string[];
  /** The configured listening host (server.host); allowed as a Host too unless it is a wildcard. */
  readonly listenHost?: string;
}

/** Decides whether a request may go any further. */
export interface RequestGuard {
  /** The host names accepted in Host and Origin, normalised (lower-case, no brackets). */
  readonly allowedHosts: ReadonlySet<string>;
  /** Undefined when the request may continue; otherwise the refusal to answer with. */
  check(req: IncomingMessage): GuardRefusal | undefined;
}

export function createRequestGuard(options: RequestGuardOptions = {}): RequestGuard {
  const allowed = new Set(LOOPBACK_HOST_NAMES);
  for (const host of options.allowedHosts ?? []) allowed.add(normaliseHostName(host));
  if (options.listenHost !== undefined && !isWildcardAddress(options.listenHost)) {
    allowed.add(normaliseHostName(options.listenHost));
  }

  const hostAllowed = (value: string | undefined, port: number | undefined): boolean => {
    if (value === undefined || port === undefined) return false;
    const parsed = parseHostHeader(value);
    return parsed !== undefined && parsed.port === port && allowed.has(parsed.host);
  };

  const originAllowed = (value: string, port: number): boolean => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    // Only the exact serialisation a browser sends: scheme, host and port, nothing else. `null` fails here.
    if (url.protocol !== 'http:' || url.origin !== value) return false;
    const originPort = url.port === '' ? 80 : Number(url.port);
    return originPort === port && allowed.has(normaliseHostName(url.hostname));
  };

  return {
    allowedHosts: allowed,
    check(req) {
      // The port this connection reached, i.e. the bound port.
      const port = req.socket.localPort;
      const host = req.headers.host;
      if (!hostAllowed(host, port)) return MISDIRECTED;
      // An absolute-form target (`GET http://name/path`) names a host too; it must be allowed as well.
      const target = req.url ?? '';
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {
        let authority: string;
        try {
          authority = new URL(target).host;
        } catch {
          return MISDIRECTED;
        }
        if (!hostAllowed(authority, port)) return MISDIRECTED;
      }

      const origin = req.headers.origin;
      if (origin !== undefined && (port === undefined || !originAllowed(origin, port))) return ORIGIN_REFUSED;

      const method = req.method ?? 'GET';
      if (method === 'OPTIONS') return PREFLIGHT_REFUSED;
      if (method === 'POST' && !isJsonContentType(req.headers['content-type'])) return JSON_REQUIRED;
      return undefined;
    },
  };
}
