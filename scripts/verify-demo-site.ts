#!/usr/bin/env node
// `npm run verify:demo-site`: serves the built static demo (docs/demo/) from a local static file server
// under a sub-path, the way GitHub Pages serves it (/tollwise/demo/), and drives the installed Chrome
// through Playwright. For every view -- Overview, Routing, Savings, Providers -- and for the request
// drawer opened on a substituted request, at 1440x900 and 390x844, in dark and light, it saves a viewport
// screenshot and runs an axe-core scan (wcag2a, wcag2aa, wcag22aa); it also saves a full-page Overview.
// In every combination it checks that the demo banner and its two links are visible, that the status
// reads "Static demo", and that there is no horizontal page scroll at 390. It walks all four time ranges,
// pages the routing table with "Load older" until no cursor remains, and opens and closes the drawer by
// keyboard, checking that focus returns to the row that opened it.
//
// The static demo must never touch the network. Every request any page makes is recorded: a fetch, XHR,
// event-stream or WebSocket request fails the run, and so does any request that leaves the local origin
// (it is also aborted, so the check itself never reaches the internet). A separate page, loaded without
// bypassing its Content-Security-Policy as a real visitor would, checks that the policy blocks a connection.
//
// Exits 1 on any accessibility violation or failed check, 0 otherwise. No account, no key, no network.
//
// Usage: npm run verify:demo-site -- [--out DIR]
//   --out DIR   Where screenshots are written. Default: .tmp-demo-site/ (git-ignored). The directory is
//               created if needed and never emptied: only this script's own screenshot files are replaced.

import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AxeBuilder } from '@axe-core/playwright';
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright';
import { RANGES, savedHeading } from '../src/dashboard/ranges.ts';

const USAGE = `Usage: npm run verify:demo-site -- [--out DIR]

Serves the built static demo (docs/demo/) locally under /tollwise/demo/, opens every dashboard view and
the request drawer at 1440x900 and 390x844, in dark and light, saves a screenshot of each and runs an
axe-core accessibility scan (WCAG 2.2 AA). Checks the demo banner, the "Static demo" status, horizontal
scroll, every time range, paging and the drawer's keyboard behaviour, and fails on any network request.
Exits 1 if anything fails.

Options:
  --out DIR     Where screenshots are written. Default: .tmp-demo-site/
                Only this script's own screenshot files in DIR are replaced; nothing else is touched.
  --help, -h    Show this help and exit.
`;

// Type-checked under the Node tsconfig (no "dom" lib), but the functions below run inside the page,
// passed to page.evaluate()/waitForFunction() as real functions. These ambient declarations describe
// only the DOM members those functions read.
declare const document: {
  readonly documentElement: {
    readonly dataset: { readonly script?: string };
    readonly scrollWidth: number;
    readonly clientWidth: number;
  };
  querySelector(selector: string): BrowserElement | null;
  getElementById(id: string): BrowserElement | null;
  createElement(tag: 'img'): BrowserImage;
  readonly body: { append(node: BrowserImage): void };
  addEventListener(type: string, listener: (event: { violatedDirective: string; blockedURI: string }) => void): void;
  readonly activeElement: BrowserElement | null;
};
declare const window: { tollwiseCspViolations?: string[] };
declare const location: { readonly origin: string };
declare function fetch(input: string): Promise<unknown>;
interface BrowserImage {
  src: string;
  onload: (() => void) | null;
  onerror: (() => void) | null;
}
interface BrowserElement {
  readonly id: string;
  readonly textContent: string | null;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  querySelectorAll(selector: string): { readonly length: number };
  closest(selector: string): BrowserElement | null;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..');
const SITE_DIR = path.join(repoRoot, 'docs', 'demo');
const SNAPSHOT_PATH = path.join(repoRoot, 'demo', 'snapshot.json');

/** The sub-path the site is served under: the path GitHub Pages gives docs/demo/ of this repository. */
export const BASE_PATH = '/tollwise/demo/';

/** The dashboard's four views (DESIGN.md §5), in tab order. */
export const VIEWS: readonly { readonly id: string; readonly label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'routing', label: 'Routing' },
  { id: 'savings', label: 'Savings' },
  { id: 'providers', label: 'Providers' },
];

export const VIEWPORTS: readonly { readonly width: number; readonly height: number }[] = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
];

export const THEMES: readonly ('dark' | 'light')[] = ['dark', 'light'];

/** Screenshot name prefixes besides the four views. */
const DRAWER_ID = 'drawer-substitution';
const OVERVIEW_FULL_ID = 'overview-full';

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag22aa'];

const BANNER_LINKS: readonly { readonly name: string; readonly href: string }[] = [
  {
    name: 'How the savings are modeled',
    href: 'https://github.com/nunomarques97/tollwise/blob/main/docs/benchmarks.md#savings-modeled',
  },
  { name: 'Run Tollwise yourself', href: 'https://github.com/nunomarques97/tollwise#quick-start' },
];

// ---------------------------------------------------------------- output folder

/** The file name of one screenshot. */
export function screenshotName(id: string, width: number, theme: 'dark' | 'light'): string {
  return `demo-${id}-${width}-${theme}.png`;
}

/** Every screenshot file one run writes: the views, the drawer and the full-page Overview, per width and theme. */
export function screenshotNames(): string[] {
  const names: string[] = [];
  for (const id of [...VIEWS.map((view) => view.id), DRAWER_ID, OVERVIEW_FULL_ID]) {
    for (const viewport of VIEWPORTS) {
      for (const theme of THEMES) names.push(screenshotName(id, viewport.width, theme));
    }
  }
  return names;
}

/**
 * Makes `out` ready for a run without ever emptying it: creates it when missing, then removes only the
 * screenshot files a previous run left there, by their exact names, so a stale image cannot pass for a
 * fresh one. Throws when `out` exists and is not a directory. Returns the names it removed.
 */
export function prepareOutputDir(out: string): string[] {
  if (existsSync(out) && !statSync(out).isDirectory()) {
    throw new Error(`--out must be a directory, but ${out} is not one`);
  }
  mkdirSync(out, { recursive: true });
  const removed: string[] = [];
  for (const name of screenshotNames()) {
    const file = path.join(out, name);
    if (existsSync(file) && statSync(file).isFile()) {
      rmSync(file);
      removed.push(name);
    }
  }
  return removed;
}

export function parseArgs(argv: readonly string[]): { readonly out: string } | { readonly exit: number } {
  let out = path.join(repoRoot, '.tmp-demo-site');
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      return { exit: 0 };
    }
    if (arg === '--out') {
      index += 1;
      const value = argv[index];
      if (value === undefined || value === '' || value.startsWith('--')) {
        console.error('verify-demo-site: --out needs a value');
        return { exit: 2 };
      }
      out = path.resolve(value);
      continue;
    }
    console.error(`verify-demo-site: unknown option "${arg}"\n`);
    console.error(USAGE);
    return { exit: 2 };
  }
  return { out };
}

// ---------------------------------------------------------------- the static file server

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

/** True when `child` is `parent` or lies below it. */
function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export type SiteTarget =
  | { readonly kind: 'file'; readonly file: string; readonly contentType: string }
  | { readonly kind: 'redirect'; readonly location: string }
  | { readonly kind: 'not-found' };

/**
 * What the server answers for `requestPath` (the path and query of a request): a file below `siteRoot`
 * served under `basePath`, a redirect from the base path without its trailing slash, or not found. Only
 * regular files with a known type, inside the site after resolving symbolic links, are ever served: an
 * encoded "..", a backslash, a NUL byte or a link out of the folder is not found.
 */
export function resolveSitePath(siteRoot: string, basePath: string, requestPath: string): SiteTarget {
  const pathname = requestPath.split(/[?#]/, 1)[0] ?? '';
  if (`${pathname}/` === basePath) return { kind: 'redirect', location: basePath };
  if (!pathname.startsWith(basePath)) return { kind: 'not-found' };
  let relative: string;
  try {
    relative = decodeURIComponent(pathname.slice(basePath.length));
  } catch {
    return { kind: 'not-found' };
  }
  if (relative.includes('\0') || relative.includes('\\')) return { kind: 'not-found' };
  if (relative === '' || relative.endsWith('/')) relative += 'index.html';
  const segments = relative.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return { kind: 'not-found' };
  const root = path.resolve(siteRoot);
  const file = path.resolve(root, ...segments);
  if (!isWithin(root, file) || !existsSync(file)) return { kind: 'not-found' };
  let real: string;
  try {
    real = realpathSync(file);
    if (!isWithin(realpathSync(root), real) || !statSync(real).isFile()) return { kind: 'not-found' };
  } catch {
    return { kind: 'not-found' };
  }
  const contentType = CONTENT_TYPES[path.extname(real).toLowerCase()];
  if (contentType === undefined) return { kind: 'not-found' };
  return { kind: 'file', file: real, contentType };
}

export interface StaticServer {
  /** The server's origin, e.g. "http://127.0.0.1:53211". */
  readonly origin: string;
  /** Every request it received, as "<status> <method> <path>". */
  readonly log: readonly string[];
  close(): Promise<void>;
}

/** Serves `siteRoot` under `basePath` on 127.0.0.1, on an ephemeral port. GET and HEAD only. */
export async function startStaticServer(siteRoot: string, basePath: string): Promise<StaticServer> {
  const log: string[] = [];
  const answer = (request: IncomingMessage, response: ServerResponse): void => {
    const method = request.method ?? '';
    const url = request.url ?? '';
    const send = (status: number, headers: Record<string, string>, body?: Buffer | string): void => {
      log.push(`${status} ${method} ${url}`);
      response.writeHead(status, { 'cache-control': 'no-store', ...headers });
      response.end(method === 'HEAD' ? undefined : body);
    };
    if (method !== 'GET' && method !== 'HEAD') {
      send(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' }, 'Method not allowed\n');
      return;
    }
    const target = resolveSitePath(siteRoot, basePath, url);
    if (target.kind === 'redirect') {
      send(301, { location: target.location });
    } else if (target.kind === 'not-found') {
      send(404, { 'content-type': 'text/plain; charset=utf-8' }, 'Not found\n');
    } else {
      send(200, { 'content-type': target.contentType }, readFileSync(target.file));
    }
  };
  const server = createServer(answer);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    log,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// ---------------------------------------------------------------- request classification

/** Resource types that are a connection made by the page's own code rather than loading the page. */
const CONNECTION_TYPES = new Set(['fetch', 'xhr', 'eventsource', 'websocket']);

/**
 * Why a request the page made breaks the static demo's promise of no network access at run time, or
 * undefined when it is only the page loading its own files. Any fetch, XHR, event stream or WebSocket
 * fails, even to the local origin; so does any request that leaves `localOrigin`. `data:` URLs never
 * reach the network and are allowed for the document's own resources.
 */
export function forbiddenRequestReason(
  request: { readonly url: string; readonly resourceType: string },
  localOrigin: string,
): string | undefined {
  if (CONNECTION_TYPES.has(request.resourceType)) return `a ${request.resourceType} request`;
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return 'a request to an unparsable URL';
  }
  if (url.protocol === 'data:') return undefined;
  if (url.origin !== localOrigin) return 'a request that leaves the local origin';
  return undefined;
}

// ---------------------------------------------------------------- page helpers (run in the browser)

function scriptLoaded(): boolean {
  return document.documentElement.dataset.script === 'loaded';
}

function viewSettled(id: string): boolean {
  const view = document.getElementById(id);
  const asOf = document.getElementById('as-of')?.textContent ?? '';
  return (
    view !== null &&
    !view.hasAttribute('hidden') &&
    view.querySelectorAll('[aria-busy="true"]').length === 0 &&
    asOf.startsWith('Recorded ')
  );
}

function horizontalOverflow(): number {
  return document.documentElement.scrollWidth - document.documentElement.clientWidth;
}

function isDrawerOpen(): boolean {
  const drawer = document.querySelector('tw-request-drawer');
  return drawer !== null && !drawer.hasAttribute('hidden');
}

function isDrawerClosed(): boolean {
  const drawer = document.querySelector('tw-request-drawer');
  return drawer === null || drawer.hasAttribute('hidden');
}

function activeElementIsInsideDrawer(): boolean {
  return document.activeElement?.closest('tw-request-drawer') !== null;
}

function activeElementRequestId(): string | null {
  return document.activeElement?.getAttribute('data-request-id') ?? null;
}

function activeElementLabel(): string | null {
  return document.activeElement?.getAttribute('aria-label') ?? null;
}

function errorBannerText(): string | null {
  return document.querySelector('#banners [data-kind="error"]')?.textContent ?? null;
}

function watchCspViolations(): void {
  window.tollwiseCspViolations = [];
  document.addEventListener('securitypolicyviolation', (event) => {
    window.tollwiseCspViolations?.push(`${event.violatedDirective} ${event.blockedURI}`);
  });
}

function cspViolations(): string[] {
  return window.tollwiseCspViolations ?? [];
}

async function probeConnection(): Promise<string> {
  try {
    await fetch(`${location.origin}/tollwise-demo-connection-probe`);
    return 'connected';
  } catch {
    return 'blocked';
  }
}

/** Adds an image from another origin (a reserved .invalid name); true when it failed to load. */
async function probeOutside(): Promise<string> {
  const image = document.createElement('img');
  const loaded = new Promise<string>((resolve) => {
    image.onload = () => resolve('loaded');
    image.onerror = () => resolve('blocked');
  });
  image.src = 'https://tollwise-demo-probe.invalid/pixel.png';
  document.body.append(image);
  return loaded;
}

// ---------------------------------------------------------------- the run

interface ViolationRecord {
  readonly where: string;
  readonly id: string;
  readonly impact: string | null | undefined;
  readonly help: string;
  readonly helpUrl: string;
  readonly targets: readonly string[];
}

class Run {
  readonly screenshots: string[] = [];
  readonly violations: ViolationRecord[] = [];
  readonly failures: string[] = [];
  readonly passes: string[] = [];
  readonly networkFailures: string[] = [];

  readonly browser: Browser;
  readonly origin: string;
  readonly out: string;

  constructor(browser: Browser, origin: string, out: string) {
    this.browser = browser;
    this.origin = origin;
    this.out = out;
  }

  get siteUrl(): string {
    return `${this.origin}${BASE_PATH}`;
  }

  check(condition: boolean, description: string): boolean {
    if (condition) this.passes.push(description);
    else this.failures.push(description);
    return condition;
  }

  /**
   * A browser context that records every request its pages make, and aborts any that would leave the
   * local origin. `bypassCSP` lets the axe scan and this script's own evaluate() calls run; it also means
   * a connection attempt is not stopped by the page's policy, so it is seen here as a request.
   */
  async context(
    label: string,
    viewport: { readonly width: number; readonly height: number },
    theme: 'dark' | 'light',
    bypassCSP = true,
    sink: string[] = this.networkFailures,
  ): Promise<BrowserContext> {
    const context = await this.browser.newContext({ viewport, colorScheme: theme, bypassCSP, serviceWorkers: 'block' });
    await context.route('**/*', async (route) => {
      const url = route.request().url();
      let sameOrigin = false;
      try {
        sameOrigin = new URL(url).origin === this.origin;
      } catch {}
      if (sameOrigin) await route.continue();
      else await route.abort('blockedbyclient');
    });
    context.on('request', (request) => {
      const reason = forbiddenRequestReason({ url: request.url(), resourceType: request.resourceType() }, this.origin);
      if (reason !== undefined) sink.push(`${label}: ${reason}: ${request.url()}`);
    });
    context.on('page', (page) => {
      page.on('websocket', (socket) => sink.push(`${label}: a websocket connection: ${socket.url()}`));
    });
    return context;
  }

  async open(context: BrowserContext, viewId: string, range?: string): Promise<Page> {
    const page = await context.newPage();
    await page.goto(`${this.siteUrl}#view=${viewId}${range === undefined ? '' : `&range=${range}`}`);
    await page.waitForFunction(scriptLoaded, null, { timeout: 15_000 });
    await this.settle(page, viewId);
    return page;
  }

  async settle(page: Page, viewId: string): Promise<void> {
    await page.waitForFunction(viewSettled, viewId, { timeout: 15_000 });
    // One signature-moment animation (200 ms) can still be running.
    await page.waitForTimeout(400);
  }

  async scan(page: Page, where: string): Promise<number> {
    const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    for (const violation of results.violations) {
      this.violations.push({
        where,
        id: violation.id,
        impact: violation.impact,
        help: violation.help,
        helpUrl: violation.helpUrl,
        targets: violation.nodes.map((node) => node.target.join(' ')),
      });
    }
    return results.violations.length;
  }

  async shoot(page: Page, id: string, width: number, theme: 'dark' | 'light', fullPage = false): Promise<void> {
    const file = path.join(this.out, screenshotName(id, width, theme));
    await page.screenshot({ path: file, fullPage });
    this.screenshots.push(file);
  }

  /** The banner, its two links, the status and (at 390) the absence of horizontal scroll. */
  async checkChrome(page: Page, where: string, width: number): Promise<void> {
    const banner = page.locator('main > .banner.is-demo');
    this.check(await banner.isVisible(), `${where}: the demo banner is visible`);
    const bannerText = (await banner.textContent()) ?? '';
    this.check(
      bannerText.includes('Static demo.') &&
        bannerText.includes('Sample data from a modeled workload, not a live service.'),
      `${where}: the banner says it is a static demo with sample data from a modeled workload`,
    );
    for (const link of BANNER_LINKS) {
      const anchor = banner.getByRole('link', { name: link.name, exact: true });
      const visible = (await anchor.count()) === 1 && (await anchor.isVisible());
      const href = visible ? await anchor.getAttribute('href') : null;
      this.check(
        visible && href === link.href,
        `${where}: the banner link "${link.name}" is visible and points to ${link.href}`,
      );
    }
    const status = ((await page.locator('tw-live-status').textContent()) ?? '').trim();
    this.check(status === 'Static demo', `${where}: the status reads "Static demo" (read "${status}")`);
    this.check((await page.evaluate(errorBannerText)) === null, `${where}: no error banner`);
    if (width <= 390) {
      const overflow = await page.evaluate(horizontalOverflow);
      this.check(overflow <= 0, `${where}: no horizontal page scroll (overflow ${overflow}px)`);
    }
  }

  async views(viewport: { readonly width: number; readonly height: number }, theme: 'dark' | 'light'): Promise<void> {
    for (const view of VIEWS) {
      const where = `${view.id} ${viewport.width} ${theme}`;
      const context = await this.context(where, viewport, theme);
      try {
        const page = await this.open(context, view.id);
        await this.checkChrome(page, where, viewport.width);
        await this.shoot(page, view.id, viewport.width, theme);
        if (view.id === 'overview') await this.shoot(page, OVERVIEW_FULL_ID, viewport.width, theme, true);
        const found = await this.scan(page, where);
        console.log(`verify-demo-site: ${where.padEnd(22, ' ')} -> ${found} violation(s)`);
      } finally {
        await context.close();
      }
    }
  }

  /**
   * Opens the drawer of a substituted request by keyboard (focus its Time button, Enter), checks its
   * "Model substitution" section, screenshots and scans it, keeps Tab inside it, closes it with Escape
   * and checks focus went back to the button that opened it.
   */
  async drawer(viewport: { readonly width: number; readonly height: number }, theme: 'dark' | 'light'): Promise<void> {
    const where = `${DRAWER_ID} ${viewport.width} ${theme}`;
    const context = await this.context(where, viewport, theme);
    try {
      const page = await this.open(context, 'routing');
      const opener = page.locator('tw-requests-table :is(tr, li):has(.sub-chip) .time-button').first();
      if (!this.check((await opener.count()) === 1, `${where}: a loaded row is marked "Substituted"`)) return;
      const openerId = await opener.getAttribute('data-request-id');
      await opener.focus();
      await page.keyboard.press('Enter');
      await page.waitForFunction(isDrawerOpen, null, { timeout: 5_000 });
      await this.checkChrome(page, where, viewport.width);

      const section = page.locator('tw-request-drawer section', { hasText: 'Model substitution' });
      const text = (await section.textContent()) ?? '';
      this.check(
        ['Requested model', 'Served model', 'Equivalence group'].every((expected) => text.includes(expected)),
        `${where}: the drawer's "Model substitution" section names the requested and served model and the group`,
      );
      await section.scrollIntoViewIfNeeded();
      await page.waitForTimeout(250);
      await this.shoot(page, DRAWER_ID, viewport.width, theme);
      const found = await this.scan(page, where);
      console.log(`verify-demo-site: ${where.padEnd(22, ' ')} -> ${found} violation(s)`);

      let inside = true;
      for (let i = 0; i < 10; i += 1) {
        await page.keyboard.press('Tab');
        if (!(await page.evaluate(activeElementIsInsideDrawer))) inside = false;
      }
      this.check(inside, `${where}: Tab stays inside the open drawer`);
      await page.keyboard.press('Escape');
      await page.waitForFunction(isDrawerClosed, null, { timeout: 5_000 }).catch(() => undefined);
      this.check(await page.evaluate(isDrawerClosed), `${where}: Escape closes the drawer`);
      this.check(
        (await page.evaluate(activeElementRequestId)) === openerId,
        `${where}: focus returns to the row that opened the drawer`,
      );
    } finally {
      await context.close();
    }
  }

  /** Opens the drawer by keyboard, reaches its Close button with Tab and activates it with Enter. */
  async drawerCloseButton(): Promise<void> {
    const where = 'drawer close button 1440 light';
    const context = await this.context(where, { width: 1440, height: 900 }, 'light');
    try {
      const page = await this.open(context, 'routing');
      const opener = page.locator('tw-requests-table .time-button[tabindex="0"]');
      const openerId = await opener.getAttribute('data-request-id');
      await opener.focus();
      await page.keyboard.press('Enter');
      await page.waitForFunction(isDrawerOpen, null, { timeout: 5_000 });
      let onClose = (await page.evaluate(activeElementLabel)) === 'Close request details';
      for (let i = 0; i < 20 && !onClose; i += 1) {
        await page.keyboard.press('Tab');
        onClose = (await page.evaluate(activeElementLabel)) === 'Close request details';
      }
      if (!this.check(onClose, `${where}: Tab reaches the drawer's Close button`)) return;
      await page.keyboard.press('Enter');
      await page.waitForFunction(isDrawerClosed, null, { timeout: 5_000 }).catch(() => undefined);
      this.check(await page.evaluate(isDrawerClosed), `${where}: Enter on Close closes the drawer`);
      this.check(
        (await page.evaluate(activeElementRequestId)) === openerId,
        `${where}: focus returns to the row that opened the drawer`,
      );
    } finally {
      await context.close();
    }
  }

  /** Selects every range in turn and checks each one's state, fragment and content. */
  async ranges(viewId: string, viewport: { readonly width: number; readonly height: number }): Promise<void> {
    const where = `ranges ${viewId} ${viewport.width}`;
    const context = await this.context(where, viewport, 'dark');
    try {
      const page = await this.open(context, viewId);
      const opening = await page.locator('tw-range-selector button[aria-pressed="true"]').textContent();
      this.check(opening === '30 days', `${where}: the demo opens on 30 days (opened on "${opening}")`);
      for (const range of [...RANGES, RANGES[0]].filter((option) => option !== undefined)) {
        await page.locator('tw-range-selector').getByRole('button', { name: range.label, exact: true }).click();
        await this.settle(page, viewId);
        const pressed = await page.locator('tw-range-selector button[aria-pressed="true"]').textContent();
        const hash = await page.evaluate(() => (globalThis as unknown as { location: { hash: string } }).location.hash);
        let shows = true;
        if (viewId === 'overview') {
          shows = ((await page.locator('#overview').textContent()) ?? '').includes(savedHeading(range.id));
        } else if (viewId === 'savings') {
          shows = (await page.locator('tw-savings-chart svg').count()) > 0;
        }
        this.check(
          pressed === range.label && new URLSearchParams(hash.slice(1)).get('range') === range.id && shows,
          `${where}: range ${range.id} is selected, kept in the fragment and rendered`,
        );
        this.check(
          (await page.evaluate(errorBannerText)) === null,
          `${where}: range ${range.id} shows no error banner`,
        );
      }
    } finally {
      await context.close();
    }
  }

  /** Pages the routing list with "Load older" until no cursor remains; every recorded request is shown. */
  async paging(viewport: { readonly width: number; readonly height: number }, expected: number): Promise<void> {
    const where = `load older ${viewport.width}`;
    const context = await this.context(where, viewport, 'light');
    try {
      const page = await this.open(context, 'routing');
      const button = page.getByRole('button', { name: 'Load 50 older requests' });
      let clicks = 0;
      while ((await button.isVisible()) && clicks < 20) {
        await button.click();
        clicks += 1;
        await page.waitForFunction(
          () => document.querySelector('tw-requests-table .pill-button[aria-disabled="true"]') === null,
          null,
          { timeout: 5_000 },
        );
        await page.waitForTimeout(100);
      }
      const end = page.locator('tw-requests-table .pager-end');
      this.check(clicks > 0, `${where}: the first page offers "Load 50 older requests"`);
      this.check(await end.isVisible(), `${where}: after ${clicks} page(s) the list says every request is shown`);
      this.check(!(await page.locator('tw-requests-table .pager-error').isVisible()), `${where}: no paging error`);
      const count = (await page.locator('tw-requests-table .pager-count').textContent()) ?? '';
      this.check(
        count === `Showing ${expected} of the newest requests`,
        `${where}: all ${expected} recorded requests are listed (read "${count}")`,
      );
      if (viewport.width <= 390) {
        const overflow = await page.evaluate(horizontalOverflow);
        this.check(
          overflow <= 0,
          `${where}: no horizontal page scroll with every page loaded (overflow ${overflow}px)`,
        );
      }
    } finally {
      await context.close();
    }
  }

  /**
   * Proves the request recorder works: in a page whose policy is bypassed, a fetch to the page's own
   * origin and a request to another origin must both be recorded as forbidden (into a list of their
   * own, so they do not fail the run), and the one to another origin must be aborted.
   */
  async recorderSelfCheck(): Promise<void> {
    const where = 'request recorder self-check';
    const caught: string[] = [];
    const context = await this.context(where, { width: 1440, height: 900 }, 'dark', true, caught);
    try {
      const page = await this.open(context, 'overview');
      this.check(caught.length === 0, `${where}: loading the page records nothing forbidden`);
      await page.evaluate(probeConnection);
      this.check(
        caught.some((line) => line.includes('a fetch request') && line.includes('connection-probe')),
        `${where}: a fetch to the local origin is caught`,
      );
      const outside = await page.evaluate(probeOutside);
      this.check(
        outside === 'blocked' && caught.some((line) => line.includes('leaves the local origin')),
        `${where}: a request to another origin is caught and aborted`,
      );
    } finally {
      await context.close();
    }
  }

  /**
   * As a real visitor, without bypassing the page's policy: the page renders under its own CSP with no
   * violation, and the policy blocks a connection even to the page's own origin.
   */
  async policy(): Promise<void> {
    const where = 'content security policy';
    const context = await this.context(where, { width: 1440, height: 900 }, 'dark', false);
    try {
      await context.addInitScript(watchCspViolations);
      const page = await this.open(context, 'overview');
      this.check(
        (await page.evaluate(cspViolations)).length === 0,
        `${where}: the page loads with no policy violation`,
      );
      this.check(
        (await page.evaluate(probeConnection)) === 'blocked',
        `${where}: a connection from the page is blocked`,
      );
      const violations = await page.evaluate(cspViolations);
      this.check(
        violations.some((violation) => violation.startsWith('connect-src')),
        `${where}: the block comes from connect-src (${violations.join('; ') || 'no violation reported'})`,
      );
    } finally {
      await context.close();
    }
  }
}

/** How many requests the snapshot's 30-day range holds: what the routing list shows once fully paged. */
function recordedRequestCount(): number {
  const snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as {
    responses: Record<string, { requests?: unknown }>;
  };
  const requests = snapshot.responses['/api/metrics/summary?range=30d']?.requests;
  if (typeof requests !== 'number') throw new Error('demo/snapshot.json has no 30-day summary');
  return requests;
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if ('exit' in parsed) {
    process.exitCode = parsed.exit;
    return;
  }
  const { out } = parsed;
  if (!existsSync(path.join(SITE_DIR, 'index.html'))) {
    throw new Error('docs/demo/index.html is missing: run `npm run build:demo-site` first');
  }
  prepareOutputDir(out);
  const expectedRequests = recordedRequestCount();

  const server = await startStaticServer(SITE_DIR, BASE_PATH);
  console.log(`verify-demo-site: serving docs/demo/ at ${server.origin}${BASE_PATH}`);
  let browser: Browser | undefined;
  let run: Run | undefined;
  try {
    browser = await chromium.launch({ channel: 'chrome' });
    run = new Run(browser, server.origin, out);
    for (const viewport of VIEWPORTS) {
      for (const theme of THEMES) {
        await run.views(viewport, theme);
        await run.drawer(viewport, theme);
      }
    }
    console.log('verify-demo-site: time ranges, paging, drawer keyboard and policy ...');
    await run.ranges('overview', { width: 1440, height: 900 });
    await run.ranges('savings', { width: 1440, height: 900 });
    await run.ranges('savings', { width: 390, height: 844 });
    await run.paging({ width: 1440, height: 900 }, expectedRequests);
    await run.paging({ width: 390, height: 844 }, expectedRequests);
    await run.drawerCloseButton();
    await run.policy();
    await run.recorderSelfCheck();
  } finally {
    await browser?.close();
    await server.close();
  }

  const missing = server.log.filter((line) => !line.startsWith('200 ') && !line.includes('connection-probe'));
  const failures = [...run.failures];
  if (missing.length > 0) failures.push(`the server answered requests with an error: ${missing.join(', ')}`);

  console.log('');
  console.log(`verify-demo-site: ${run.screenshots.length} screenshot(s) written to ${out}`);
  for (const screenshot of run.screenshots) console.log(`  ${screenshot}`);

  console.log('');
  if (run.violations.length === 0) {
    console.log('verify-demo-site: accessibility scan (wcag2a, wcag2aa, wcag22aa): 0 violations');
  } else {
    console.log(`verify-demo-site: accessibility scan: ${run.violations.length} violation(s) found`);
    console.log(JSON.stringify(run.violations, null, 2));
  }

  console.log('');
  if (run.networkFailures.length === 0) {
    console.log(
      'verify-demo-site: network: no fetch, XHR, event stream or WebSocket, and nothing left the local origin',
    );
  } else {
    console.log(`verify-demo-site: network: ${run.networkFailures.length} forbidden request(s)`);
    for (const failure of run.networkFailures) console.log(`  ${failure}`);
  }

  console.log('');
  console.log(`verify-demo-site: ${run.passes.length} check(s) passed, ${failures.length} failed`);
  // The per-view checks repeat in all 24 combinations; the interaction and policy checks are listed.
  const combination = /^(?:overview|routing|savings|providers|drawer-substitution) \d+ (?:dark|light):/;
  for (const pass of run.passes) if (!combination.test(pass)) console.log(`  ok: ${pass}`);
  for (const failure of failures) console.log(`  FAILED: ${failure}`);

  if (run.violations.length > 0 || run.networkFailures.length > 0 || failures.length > 0) {
    console.log('');
    console.log('verify-demo-site: FAILED');
    process.exitCode = 1;
    return;
  }
  console.log('');
  console.log('verify-demo-site: PASSED');
}

// Run only when started as a script, so the tests can import the helpers above without a browser.
const samePath = (a: string, b: string): boolean =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const invokedAs = process.argv[1] === undefined ? '' : path.resolve(process.argv[1]);
if (samePath(invokedAs, fileURLToPath(import.meta.url))) {
  main().catch((error: unknown) => {
    console.error(`verify-demo-site: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    process.exitCode = 1;
  });
}
