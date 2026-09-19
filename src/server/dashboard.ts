// Static serving of the dashboard: GET and HEAD /dashboard and /dashboard/<file>, from the build output in
// dist/dashboard (`npm run build:dashboard`, which runs on `npm install` too).
//
// The request path is external input, so it is resolved strictly and only ever to a file inside the build
// folder:
// - the part after /dashboard/ is percent-decoded exactly once; malformed encoding is refused;
// - every decoded segment must be a plain file or folder name: letters, digits, `.`, `_` and `-`, not
//   starting or ending with `.`. That refuses `..`, `.`, empty segments (`//`), backslashes, NUL, `%`
//   (a second level of encoding), `:` (drive letters, alternate data streams), `~` (short names) and
//   hidden files; Windows device names (CON, NUL, COM1, ...) are refused too;
// - the file must have one of the extensions in DASHBOARD_CONTENT_TYPES, which fixes its Content-Type;
// - the real path of the file (symbolic links and junctions resolved) must lie inside the real path of the
//   build folder, and be a regular file. Anything else is a 404 that names nothing the client sent.
//
// Every answer, errors included, carries a Content-Security-Policy that allows only same-origin scripts,
// styles, fonts and connections (no inline script or style), same-origin or data: images, and no framing,
// plus X-Content-Type-Options: nosniff and Referrer-Policy: no-referrer.
//
// These files carry no data, so they are served without the access key (see ./access.ts); everything the
// dashboard shows comes from /api/*, which still needs it. The request guard (./guard.ts) applies here as
// on every other path.

import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discardBody, hasUnreadBody } from './body.ts';
import { markConnectionClosing, sendError } from './respond.ts';
import type { RouteContext } from './router.ts';

/** The path the dashboard is served under. */
export const DASHBOARD_PATH = '/dashboard';

/** The build output of `npm run build:dashboard`: dist/dashboard at the root of the package. */
export const DEFAULT_DASHBOARD_ROOT = fileURLToPath(new URL('../../dist/dashboard/', import.meta.url));

/** The page served for /dashboard and /dashboard/. */
export const DASHBOARD_INDEX = 'index.html';

/** The only files served, by extension, and the Content-Type each is served with. */
export const DASHBOARD_CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** The Content-Security-Policy of every dashboard answer. */
export const DASHBOARD_CSP = [
  "default-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** Headers sent with every dashboard answer, errors included. */
export const DASHBOARD_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': DASHBOARD_CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

export const DASHBOARD_NOT_FOUND_MESSAGE = 'Not found: this path is not a dashboard file.';

export const DASHBOARD_NOT_BUILT_MESSAGE =
  'The dashboard is not built. Run "npm run build:dashboard" in the Tollwise folder, then reload this page.';

/** A plain file or folder name: no dot at either end, no separator, no escape, nothing else. */
const SAFE_SEGMENT = /^[A-Za-z0-9_-](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?$/;

/** Windows device names, which name a device instead of a file whatever the folder or extension. */
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i;

/** True for /dashboard and every path below it, on a segment boundary. */
export function isDashboardPath(requestPath: string): boolean {
  return requestPath === DASHBOARD_PATH || requestPath.startsWith(`${DASHBOARD_PATH}/`);
}

/**
 * The relative file path a dashboard request path names, as a list of safe segments, or undefined when
 * the path is not one Tollwise will ever serve. Pure: it never touches the file system.
 */
export function dashboardFileSegments(requestPath: string): readonly string[] | undefined {
  if (!isDashboardPath(requestPath)) return undefined;
  const rest = requestPath.slice(DASHBOARD_PATH.length);
  if (rest === '' || rest === '/') return [DASHBOARD_INDEX];
  let decoded: string;
  try {
    decoded = decodeURIComponent(rest.slice(1));
  } catch {
    return undefined;
  }
  const segments = decoded.split('/');
  for (const segment of segments) {
    if (!SAFE_SEGMENT.test(segment) || WINDOWS_DEVICE_NAME.test(segment)) return undefined;
  }
  const extension = path.extname(segments[segments.length - 1] ?? '');
  if (!Object.hasOwn(DASHBOARD_CONTENT_TYPES, extension)) return undefined;
  return segments;
}

/** True when `candidate` lies strictly below `root`. Both must be absolute, resolved paths. */
function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function errorCode(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code;
}

type Resolution =
  | { readonly kind: 'file'; readonly file: string; readonly contentType: string }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'not_built' };

/** Resolves a dashboard request path to a file inside the real path of `root`. */
export async function resolveDashboardFile(root: string, requestPath: string): Promise<Resolution> {
  let realRoot: string;
  try {
    realRoot = await realpath(root);
    // A build folder without its page is an unfinished build.
    if (!(await stat(path.join(realRoot, DASHBOARD_INDEX))).isFile()) return { kind: 'not_built' };
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') return { kind: 'not_built' };
    throw error;
  }

  const segments = dashboardFileSegments(requestPath);
  if (segments === undefined) return { kind: 'not_found' };
  const contentType = DASHBOARD_CONTENT_TYPES[path.extname(segments[segments.length - 1] ?? '')];
  if (contentType === undefined) return { kind: 'not_found' };

  let file: string;
  try {
    // Symbolic links and junctions are followed here, then the result must still be inside the root.
    file = await realpath(path.join(realRoot, ...segments));
    if (!isInside(realRoot, file) || !(await stat(file)).isFile()) return { kind: 'not_found' };
  } catch {
    return { kind: 'not_found' };
  }
  return { kind: 'file', file, contentType };
}

/** GET and HEAD /dashboard and /dashboard/*: one file of the dashboard build, or a 404 or 503. */
export async function handleDashboard({ req, res, path: requestPath, dashboardRoot }: RouteContext): Promise<void> {
  const resolution = await resolveDashboardFile(dashboardRoot ?? DEFAULT_DASHBOARD_ROOT, requestPath);
  if (resolution.kind === 'not_built') {
    sendError(res, 503, 'server_error', 'dashboard_not_built', DASHBOARD_NOT_BUILT_MESSAGE, {
      headers: DASHBOARD_SECURITY_HEADERS,
    });
    return;
  }
  if (resolution.kind === 'not_found') {
    sendError(res, 404, 'not_found_error', 'not_found', DASHBOARD_NOT_FOUND_MESSAGE, {
      headers: DASHBOARD_SECURITY_HEADERS,
      close: true,
    });
    return;
  }

  let body: Buffer;
  try {
    body = await readFile(resolution.file);
  } catch {
    // Removed between the check and the read (a rebuild in progress).
    sendError(res, 404, 'not_found_error', 'not_found', DASHBOARD_NOT_FOUND_MESSAGE, {
      headers: DASHBOARD_SECURITY_HEADERS,
      close: true,
    });
    return;
  }
  if (res.headersSent || res.writableEnded) return;
  res.statusCode = 200;
  res.setHeader('Content-Type', resolution.contentType);
  res.setHeader('Content-Length', body.length);
  res.setHeader('Cache-Control', 'no-cache');
  for (const [name, value] of Object.entries(DASHBOARD_SECURITY_HEADERS)) res.setHeader(name, value);
  // A request that sent a body anyway: its connection closes, and the body is dropped within fixed bounds.
  const unreadBody = hasUnreadBody(req);
  if (unreadBody) {
    res.setHeader('Connection', 'close');
    markConnectionClosing(req.socket);
  }
  // Node sends no body for HEAD, only the headers GET would get.
  res.end(body);
  if (unreadBody) discardBody(req);
}
