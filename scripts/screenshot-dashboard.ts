#!/usr/bin/env node
// Screenshots of the dashboard at 1440 and 390 px wide, in the light and dark themes, for visual review.
// Drives the Chrome already installed on this machine through Playwright (channel "chrome"; no browser
// download). Loopback only.
//
// Usage: node scripts/screenshot-dashboard.ts [--url URL] [--out DIR] [--states list]
//
//   --url      A running Tollwise with traffic, e.g. `npm run demo` (default http://127.0.0.1:8487).
//              Used for the "live" state.
//   --out      Output folder (default docs/design/screens).
//   --states   Comma-separated subset of: live, routing, routing-drawer, providers, empty, error, paused,
//              locked, refused (default: all).
//
// "live", "routing", "routing-drawer" and "providers" use --url: the overview, the Routing view, the
// Routing view with a drawer open (the newest request that fell back after a failure, else the newest
// request), and the Providers view.
// Every other state runs its own short-lived Tollwise on an ephemeral loopback port:
//   empty    a fresh analytics database with no request;
//   error    analytics off, so the metrics API answers 503;
//   paused   the analytics database of `npm run demo` (data/demo.db), then the server stops mid-view;
//   locked   an access key is set and the page has none: the access-key form;
//   refused  the same, after a wrong key was submitted.
// The access key of those servers is random, made up for the run, and never printed or written anywhere.
// The script also checks that the right key opens the dashboard and that the key was sent in a header
// only (never in a URL), and fails otherwise.

import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, chromium, type Page } from 'playwright';
import { type EventStore, openSqliteEventStore } from '../src/analytics/store.ts';
import { createLogger } from '../src/log/logger.ts';
import { baseUrl, createTollwiseServer, listen, stopServer } from '../src/server/server.ts';

const STATES = [
  'live',
  'routing',
  'routing-drawer',
  'providers',
  'empty',
  'error',
  'paused',
  'locked',
  'refused',
] as const;
type State = (typeof STATES)[number];
const THEMES = ['dark', 'light'] as const;
const WIDTHS = [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
] as const;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(args: readonly string[]): { url: string; out: string; states: State[] } {
  let url = 'http://127.0.0.1:8487';
  let out = path.join(repoRoot, 'docs', 'design', 'screens');
  let states: State[] = [...STATES];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    if (value === undefined) throw new Error(`${arg} needs a value`);
    if (arg === '--url') url = value;
    else if (arg === '--out') out = path.resolve(value);
    else if (arg === '--states') {
      states = value.split(',').map((state) => {
        if (!(STATES as readonly string[]).includes(state)) throw new Error(`unknown state ${state}`);
        return state as State;
      });
    } else throw new Error(`unknown option ${arg}`);
    index += 1;
  }
  const host = new URL(url).hostname;
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]') throw new Error('--url must be a loopback URL');
  return { url: url.replace(/\/+$/, ''), out, states };
}

interface Running {
  readonly url: string;
  stop(): Promise<void>;
}

async function startTollwise(options: { analytics?: EventStore; accessKey?: string }): Promise<Running> {
  const logger = createLogger({ level: 'error', sink: { write: () => true }, env: {} });
  const server: Server = createTollwiseServer({ maxBodyBytes: 64 * 1024, logger, ...options });
  const address = await listen(server, '127.0.0.1', 0);
  return {
    url: baseUrl('127.0.0.1', address.port),
    stop: async () => {
      await stopServer(server, 1000);
      await options.analytics?.close();
    },
  };
}

async function openPage(browser: Browser, theme: string, size: { width: number; height: number }): Promise<Page> {
  const context = await browser.newContext({
    viewport: size,
    colorScheme: theme === 'dark' ? 'dark' : 'light',
    deviceScaleFactor: 1,
    isMobile: size.width < 720,
    hasTouch: size.width < 720,
  });
  return context.newPage();
}

async function waitForOverview(page: Page, live: boolean): Promise<void> {
  await page.waitForSelector('tw-savings-block[aria-labelledby], .banner.is-error', { timeout: 15_000 });
  if (live) await page.waitForSelector('tw-live-status[data-state="live"]', { timeout: 15_000 });
  // Runs in the page, where the DOM exists; a string because this script is type-checked for Node.
  await page.waitForFunction("!document.querySelector('#as-of')?.textContent?.startsWith('Loading')");
  await page.waitForTimeout(800);
}

/** File name stem of a state: the overview states keep the `dashboard-` prefix, the other views their own. */
function fileStem(state: State): string {
  if (state === 'routing') return 'routing-live';
  if (state === 'routing-drawer') return 'routing-drawer-live';
  if (state === 'providers') return 'providers-live';
  return `dashboard-${state}`;
}

async function shoot(page: Page, file: string, fullPage = true): Promise<void> {
  // Park the pointer outside the page, so no hover state shows.
  await page.mouse.move(0, 0);
  await page.screenshot({ path: file, fullPage });
  console.log(path.relative(repoRoot, file).replaceAll(path.sep, '/'));
}

async function main(): Promise<void> {
  const { url, out, states } = parseArgs(process.argv.slice(2));
  mkdirSync(out, { recursive: true });
  const scratch = mkdtempSync(path.join(tmpdir(), 'tollwise-screens-'));
  const browser = await chromium.launch({ channel: 'chrome' });
  const demoDb = path.join(repoRoot, 'data', 'demo.db');
  const logger = createLogger({ level: 'error', sink: { write: () => true }, env: {} });
  let emptyCount = 0;

  try {
    for (const state of states) {
      for (const theme of THEMES) {
        for (const size of WIDTHS) {
          const file = path.join(out, `${fileStem(state)}-${theme}-${size.width}.png`);
          const page = await openPage(browser, theme, size);
          try {
            if (state === 'live') {
              await page.goto(`${url}/dashboard`);
              await waitForOverview(page, true);
              await shoot(page, file);
              continue;
            }
            if (state === 'routing' || state === 'routing-drawer') {
              await page.goto(`${url}/dashboard#view=routing`);
              await page.waitForSelector('tw-requests-table .time-button', { timeout: 15_000 });
              await page.waitForTimeout(800);
              if (state === 'routing') {
                await shoot(page, file);
                continue;
              }
              // A request that fell back after a failed attempt shows the whole trace: several candidates,
              // a failed and a served attempt. Without one, the newest request.
              const fallback = page.locator('tw-requests-table .request-row:has(.pip.is-failed) .time-button');
              const target =
                (await fallback.count()) > 0
                  ? fallback.first()
                  : page.locator('tw-requests-table .time-button').first();
              await target.focus();
              await page.keyboard.press('Enter');
              await page.waitForSelector('tw-request-drawer .drawer-panel', { timeout: 15_000 });
              await page.waitForTimeout(300);
              // The drawer is fixed to the viewport, so the viewport is the picture.
              await shoot(page, file, false);
              // A second picture with the drawer scrolled to its trace: Candidates, Excluded and Attempts.
              await page.evaluate(
                `(() => {
                  const panel = document.querySelector('tw-request-drawer .drawer-panel');
                  const head = panel.querySelector('.drawer-head');
                  const section = panel.querySelectorAll('.drawer-section')[1];
                  const top = section.getBoundingClientRect().top - panel.getBoundingClientRect().top;
                  panel.scrollTop += top - head.getBoundingClientRect().height - 8;
                })()`,
              );
              await page.waitForTimeout(200);
              await shoot(page, path.join(out, `routing-drawer-trace-live-${theme}-${size.width}.png`), false);
              continue;
            }
            if (state === 'providers') {
              await page.goto(`${url}/dashboard#view=providers`);
              await page.waitForSelector('.providers-list', { timeout: 15_000 });
              await page.waitForTimeout(800);
              await shoot(page, file);
              continue;
            }
            if (state === 'empty') {
              emptyCount += 1;
              const analytics = openSqliteEventStore({ file: path.join(scratch, `empty-${emptyCount}.db`), logger });
              const running = await startTollwise({ analytics });
              try {
                await page.goto(`${running.url}/dashboard`);
                await waitForOverview(page, true);
                await shoot(page, file);
              } finally {
                await running.stop();
              }
              continue;
            }
            if (state === 'error') {
              const running = await startTollwise({});
              try {
                await page.goto(`${running.url}/dashboard`);
                await waitForOverview(page, false);
                await shoot(page, file);
              } finally {
                await running.stop();
              }
              continue;
            }
            if (state === 'paused') {
              const running = await startTollwise({ analytics: openSqliteEventStore({ file: demoDb, logger }) });
              await page.goto(`${running.url}/dashboard`);
              await waitForOverview(page, true);
              await running.stop();
              await page.waitForSelector('.banner.is-warning', { timeout: 15_000 });
              await page.waitForTimeout(300);
              await shoot(page, file);
              continue;
            }
            // locked and refused: an access key is required.
            const accessKey = randomBytes(24).toString('hex');
            const running = await startTollwise({
              analytics: openSqliteEventStore({ file: demoDb, logger }),
              accessKey,
            });
            const requestUrls: string[] = [];
            const keyHeaders: string[] = [];
            page.on('request', (request) => {
              requestUrls.push(request.url());
              const header = request.headers()['x-api-key'];
              if (header !== undefined) keyHeaders.push(request.url());
            });
            try {
              await page.goto(`${running.url}/dashboard`);
              await page.waitForSelector('tw-access-form:not([hidden]) input', { timeout: 15_000 });
              await page.waitForTimeout(300);
              if (state === 'refused') {
                await page.fill('#access-key-input', 'this-is-not-the-key');
                await page.keyboard.press('Enter');
                await page.waitForSelector('#access-key-message:not([hidden])', { timeout: 15_000 });
                await page.waitForTimeout(300);
              }
              await shoot(page, file);

              // The right key opens the dashboard; it travelled in a header and never in a URL.
              await page.fill('#access-key-input', accessKey);
              await page.click('button[type="submit"]');
              await page.waitForSelector('tw-live-status[data-state="live"]', { timeout: 15_000 });
              if (requestUrls.some((requestUrl) => requestUrl.includes(accessKey))) {
                throw new Error('the access key appeared in a request URL');
              }
              if (!keyHeaders.some((requestUrl) => requestUrl.includes('/api/metrics/summary'))) {
                throw new Error('the summary was not requested with the access key header');
              }
              if (page.url().includes(accessKey)) throw new Error('the access key appeared in the page URL');
              const cookies = await page.context().cookies();
              if (cookies.length > 0) throw new Error('the dashboard set a cookie');
              const stored = await page.evaluate<{ session: string | null; local: string[]; title: string }>(
                "({ session: sessionStorage.getItem('tollwise.accessKey'), local: Object.values(localStorage), title: document.title })",
              );
              if (
                stored.session !== accessKey ||
                stored.local.includes(accessKey) ||
                stored.title.includes(accessKey)
              ) {
                throw new Error('the access key is not kept in session storage only');
              }
            } finally {
              await running.stop();
            }
          } finally {
            await page.context().close();
          }
        }
      }
    }
  } finally {
    await browser.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(`screenshot-dashboard: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
