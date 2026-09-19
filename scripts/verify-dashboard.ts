#!/usr/bin/env node
// `npm run verify:dashboard`: starts the demo setup (scripts/demo.ts) against local mock providers,
// waits until it has sent real live traffic, then opens every dashboard view -- Overview, Routing,
// Savings, Providers -- at 1440x900 and 390x844, in dark and light, saves a screenshot of each, and
// runs an axe-core accessibility scan (WCAG 2.2 AA tags) on each. It does the same for the request
// drawer opened on a request another model served (the demo turns on an equivalence preset, so its
// traffic always includes such model substitutions; DESIGN.md §13.3.3/§13.4). Every combination is scanned and
// every violation is collected and printed; the run then exits 1 if there was at least one violation
// or a failed keyboard check. It also exits 1 if the demo never produces the traffic the views need
// to render their live state. See docs/accessibility.md for the written keyboard-walkthrough
// checklist and its result (focus order, visible focus, no traps, skip link) that this script cannot
// fully automate.
//
// Uses Playwright driving the already-installed system Chrome and @axe-core/playwright
// (`AxeBuilder`), tagged wcag2a/wcag2aa/wcag22aa. No account, no network call other than to
// the local demo it starts, no real API key.
//
// Usage: npm run verify:dashboard -- [--out DIR]
//   --out DIR   Where screenshots are written. Default: .tmp-dashboard/ (already git-ignored).
//               The directory is created if needed and never emptied: only the script's own
//               <view>-<width>-<theme>.png and drawer-substitution-<width>-<theme>.png files in it
//               are replaced; anything else is left alone.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AxeBuilder } from '@axe-core/playwright';
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright';

const USAGE = `Usage: npm run verify:dashboard -- [--out DIR]

Starts the demo setup, opens every dashboard view at 1440x900 and 390x844, in dark and light, saves
a screenshot of each, and runs an axe-core accessibility scan (WCAG 2.2 AA). Does the same for the
request drawer of a substituted request. Scans every combination, reports every violation found,
then exits 1 if there was any.

Options:
  --out DIR     Where screenshots are written. Default: .tmp-dashboard/
                Only this script's own <view>-<width>-<theme>.png and
                drawer-substitution-<width>-<theme>.png files in DIR are replaced; nothing
                else in DIR is touched.
  --help, -h    Show this help and exit.
`;

// This file is type-checked under the Node tsconfig (no "dom" lib -- see tsconfig.json's exclude of
// src/dashboard, which keeps browser globals out of the server-side program on purpose), but the
// functions below run inside the browser page, passed to Playwright's page.evaluate()/
// waitForFunction() as real functions (never as source strings: passing a string takes a different,
// slower internal path that a strict Content-Security-Policy like this dashboard's can block).
// These few ambient declarations describe only the handful of DOM members those functions read.
declare const document: {
  readonly documentElement: { readonly dataset: { readonly script?: string } };
  querySelectorAll(selector: string): { readonly length: number };
  querySelector(selector: string): BrowserElement | null;
  getElementById(id: string): BrowserElement | null;
  readonly activeElement: BrowserElement | null;
  readonly body: BrowserElement;
};
declare const window: {
  getComputedStyle(element: BrowserElement): { readonly outlineStyle: string; readonly outlineWidth: string };
};
interface BrowserElement {
  readonly tagName: string;
  readonly id: string;
  readonly textContent: string | null;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  querySelectorAll(selector: string): { readonly length: number };
  querySelector(selector: string): BrowserElement | null;
  closest(selector: string): BrowserElement | null;
  focus(): void;
  blur(): void;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..');
const demoScriptPath = path.join(repoRoot, 'scripts', 'demo.ts');

/** The dashboard's own four views (DESIGN.md §5, §12-14), in tab order. */
const VIEWS: readonly { readonly id: string; readonly label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'routing', label: 'Routing' },
  { id: 'savings', label: 'Savings' },
  { id: 'providers', label: 'Providers' },
];

const VIEWPORTS: readonly { readonly width: number; readonly height: number }[] = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
];

const THEMES: readonly ('dark' | 'light')[] = ['dark', 'light'];

/** The screenshot name prefix of the request drawer opened on a substituted request. */
const SUBSTITUTION_DRAWER_ID = 'drawer-substitution';

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag22aa'];

/** The file name of one screenshot. These are the only files the script ever writes or removes. */
export function screenshotName(viewId: string, width: number, theme: 'dark' | 'light'): string {
  return `${viewId}-${width}-${theme}.png`;
}

/**
 * Every screenshot file name one run writes: one per view, viewport and theme, then one per viewport
 * and theme of the drawer of a substituted request.
 */
export function screenshotNames(): string[] {
  const names: string[] = [];
  for (const view of [...VIEWS, { id: SUBSTITUTION_DRAWER_ID }]) {
    for (const viewport of VIEWPORTS) {
      for (const theme of THEMES) names.push(screenshotName(view.id, viewport.width, theme));
    }
  }
  return names;
}

/**
 * Makes `out` ready for a run without ever emptying it: creates it (and its parents) when missing,
 * then removes only the screenshot files a previous run of this script left there, by their exact
 * names, so a stale image can never pass for a fresh one. Any other file or folder in `out` is left
 * untouched, so pointing --out at an existing directory by mistake cannot destroy anything else.
 * Throws when `out` exists and is not a directory. Returns the file names it removed.
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

/** How much of the demo child's output an error message carries: enough to diagnose, never a flood. */
const MAX_CHILD_OUTPUT_IN_ERROR = 2_000;

/** The last `max` characters of `text`, marked as truncated when anything was cut. */
export function tailForError(text: string, max = MAX_CHILD_OUTPUT_IN_ERROR): string {
  if (text.length <= max) return text;
  return `[... ${text.length - max} earlier character(s) omitted]\n${text.slice(-max)}`;
}

/** Per-request demo lines look like "[  1] scenario-name -> 200 provider=... attempts=1". */
const REQUEST_LINE = /^\[\s*\d+]/;
/** How many demo requests to wait for before opening the dashboard, so every scenario has run. */
const MIN_REQUESTS = 15;
const DEMO_READY_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------- argument parsing

interface Args {
  readonly out: string;
}

function parseArgs(argv: readonly string[]): Args | { exit: number } {
  let out = path.join(repoRoot, '.tmp-dashboard');
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      return { exit: 0 };
    }
    if (arg === '--out') {
      index += 1;
      const value = argv[index];
      if (value === undefined || value === '') {
        console.error('verify-dashboard: --out needs a value');
        return { exit: 2 };
      }
      out = path.resolve(value);
      continue;
    }
    console.error(`verify-dashboard: unknown option "${arg}"\n`);
    console.error(USAGE);
    return { exit: 2 };
  }
  return { out };
}

// ---------------------------------------------------------------- the demo child process

interface Demo {
  readonly baseUrl: string;
  stop(): Promise<void>;
}

/** Only what Node needs to run the demo child: no inherited provider keys or TOLLWISE_* settings. */
function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/**
 * Starts `scripts/demo.ts` on an ephemeral port against a temporary analytics file, and waits both for
 * its "proxy ready" line and for at least MIN_REQUESTS of its per-request lines, so every scenario
 * (both wire formats, streaming, tools, JSON mode, vision, a fallback) has produced at least one
 * request before the dashboard is opened.
 */
async function startDemo(dbFile: string): Promise<Demo> {
  const child = spawn(
    process.execPath,
    [demoScriptPath, '--seed', 'verify-dashboard', '--port', '0', '--analytics-path', dbFile],
    { cwd: repoRoot, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let stdout = '';
  let stderr = '';
  let requestCount = 0;
  let baseUrl: string | undefined;
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk;
    for (const line of chunk.split(/\r?\n/)) {
      if (REQUEST_LINE.test(line)) requestCount += 1;
      const match = /tollwise demo: proxy ready at (\S+)/.exec(line);
      if (match) baseUrl = match[1];
    }
  });
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const exitedEarly = new Promise<never>((_, reject) => {
    child.once('exit', (code, signal) => {
      reject(
        new Error(
          `demo exited early (code ${code}, signal ${signal}); stdout:\n${tailForError(stdout)}\nstderr:\n${tailForError(stderr)}`,
        ),
      );
    });
    child.once('error', reject);
  });

  const ready = (async (): Promise<string> => {
    const deadline = Date.now() + DEMO_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (baseUrl !== undefined && requestCount >= MIN_REQUESTS) return baseUrl;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(
      `timed out waiting for the demo to reach ${MIN_REQUESTS} requests ` +
        `(saw ${requestCount}, ready=${baseUrl !== undefined}); stdout:\n${tailForError(stdout)}\nstderr:\n${tailForError(stderr)}`,
    );
  })();

  const url = await Promise.race([ready, exitedEarly]);

  return {
    baseUrl: url,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        child.once('exit', () => resolve());
        child.kill(process.platform === 'win32' ? undefined : 'SIGTERM');
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }, 3_000);
      }),
  };
}

// ---------------------------------------------------------------- dashboard readiness

/**
 * Waits until the page's script has run and the given view's own aria-busy has cleared. Scoped to
 * that view's container, not the whole document: the other three views' components each call their
 * own showLoading() as soon as they connect (DESIGN.md §6.8), whether or not their view is the one
 * currently shown, so they would otherwise never clear and this would wait forever.
 */
async function waitForDashboardReady(page: Page, viewId: string): Promise<void> {
  await page.waitForFunction(() => document.documentElement.dataset.script === 'loaded', null, { timeout: 15_000 });
  await page.waitForFunction(
    (id) => (document.getElementById(id)?.querySelectorAll('[aria-busy="true"]').length ?? 0) === 0,
    viewId,
    { timeout: 15_000 },
  );
  // One signature-moment animation (200 ms) and one live-refresh batching window can still be settling.
  await page.waitForTimeout(400);
}

// ---------------------------------------------------------------- visual + accessibility pass

interface ViolationRecord {
  readonly view: string;
  readonly width: number;
  readonly theme: string;
  readonly id: string;
  readonly impact: string | null | undefined;
  readonly description: string;
  readonly help: string;
  readonly helpUrl: string;
  readonly targets: readonly string[];
}

async function checkOne(
  browser: Browser,
  baseUrl: string,
  outDir: string,
  view: { readonly id: string },
  viewport: { readonly width: number; readonly height: number },
  theme: 'dark' | 'light',
): Promise<{ readonly screenshot: string; readonly violations: ViolationRecord[] }> {
  // bypassCSP: only this automation script's own evaluate()/waitForFunction() calls need it (the
  // dashboard's own strict CSP, default-src 'self', is unaffected -- it is never relaxed for a real
  // visitor, and axe-core itself is still injected and read through the same mechanism).
  const context: BrowserContext = await browser.newContext({ viewport, colorScheme: theme, bypassCSP: true });
  const page: Page = await context.newPage();
  try {
    await page.goto(`${baseUrl}/dashboard#view=${view.id}&range=1h`);
    await waitForDashboardReady(page, view.id);

    const screenshot = path.join(outDir, screenshotName(view.id, viewport.width, theme));
    await page.screenshot({ path: screenshot, fullPage: true });

    const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    const violations: ViolationRecord[] = results.violations.map((violation) => ({
      view: view.id,
      width: viewport.width,
      theme,
      id: violation.id,
      impact: violation.impact,
      description: violation.description,
      help: violation.help,
      helpUrl: violation.helpUrl,
      targets: violation.nodes.map((node) => node.target.join(' ')),
    }));
    return { screenshot, violations };
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------- drawer of a substituted request

/** The Time button of the first loaded row (table) or item (390 px list) marked "Substituted". */
const SUBSTITUTED_ROW_BUTTON = 'tw-requests-table :is(tr, li):has(.sub-chip) .time-button';

/**
 * Opens the Routing view, then the drawer of the first request another model served, scrolls its
 * "Model substitution" section into view, saves a screenshot and runs the axe scan with it open.
 * Fails when no loaded row is marked "Substituted" or the drawer does not name the served model and
 * the equivalence group, so a demo that stops producing substitutions cannot pass unnoticed.
 */
async function checkSubstitutionDrawer(
  browser: Browser,
  baseUrl: string,
  outDir: string,
  viewport: { readonly width: number; readonly height: number },
  theme: 'dark' | 'light',
): Promise<{ readonly screenshot: string; readonly violations: ViolationRecord[] }> {
  const context: BrowserContext = await browser.newContext({ viewport, colorScheme: theme, bypassCSP: true });
  const page: Page = await context.newPage();
  try {
    await page.goto(`${baseUrl}/dashboard#view=routing&range=1h`);
    await waitForDashboardReady(page, 'routing');

    const opener = page.locator(SUBSTITUTED_ROW_BUTTON).first();
    if ((await opener.count()) === 0) {
      throw new Error('no request row is marked "Substituted" (the demo produced no model substitution?)');
    }
    await opener.click();
    await page.waitForFunction(isDrawerOpen, null, { timeout: 5_000 });

    const section = page.locator('tw-request-drawer section', { hasText: 'Model substitution' });
    const text = (await section.textContent()) ?? '';
    for (const expected of ['Requested model', 'Served model', 'Equivalence group']) {
      if (!text.includes(expected)) {
        throw new Error(`the drawer's "Model substitution" section lacks "${expected}": ${JSON.stringify(text)}`);
      }
    }
    await section.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);

    const screenshot = path.join(outDir, screenshotName(SUBSTITUTION_DRAWER_ID, viewport.width, theme));
    await page.screenshot({ path: screenshot });

    const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    const violations: ViolationRecord[] = results.violations.map((violation) => ({
      view: SUBSTITUTION_DRAWER_ID,
      width: viewport.width,
      theme,
      id: violation.id,
      impact: violation.impact,
      description: violation.description,
      help: violation.help,
      helpUrl: violation.helpUrl,
      targets: violation.nodes.map((node) => node.target.join(' ')),
    }));
    return { screenshot, violations };
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------- keyboard walkthrough

interface FocusStep {
  readonly index: number;
  readonly description: string;
  readonly visibleFocus: boolean;
}

interface KeyboardWalkthroughResult {
  readonly firstStopIsSkipLink: boolean;
  readonly skipLinkJumpsToContent: boolean;
  readonly steps: readonly FocusStep[];
  readonly noStuckFocus: boolean;
  readonly allVisibleFocus: boolean;
}

function blurActiveElement(): void {
  document.activeElement?.blur();
}

function activeElementId(): string {
  return document.activeElement?.id ?? '';
}

function describeActiveElement(): { description: string; visibleFocus: boolean } {
  const el = document.activeElement;
  if (el === null || el === document.body) return { description: '(none)', visibleFocus: false };
  const style = window.getComputedStyle(el);
  const visibleFocus = style.outlineStyle !== 'none' && style.outlineWidth !== '0px';
  const name = el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 40) ?? '';
  const description = `<${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}> "${name}"`;
  return { description, visibleFocus };
}

/**
 * Automates the part of the keyboard walkthrough a script can check for real: the skip link is the
 * first stop and it moves focus to <main>, focus never gets stuck on one element while tabbing
 * through the header/tabs/range, and every stop shows a visible focus outline. Reading order/labels
 * with a screen reader stay a manual check (docs/accessibility.md records that separately).
 */
async function runKeyboardWalkthrough(browser: Browser, baseUrl: string): Promise<KeyboardWalkthroughResult> {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: 'light',
    bypassCSP: true,
  });
  const page = await context.newPage();
  try {
    await page.goto(`${baseUrl}/dashboard#view=overview&range=1h`);
    await waitForDashboardReady(page, 'overview');
    await page.evaluate(blurActiveElement);

    const describeAndCheckFocus = () => page.evaluate(describeActiveElement);

    const steps: FocusStep[] = [];
    let stuck = false;
    const maxSteps = 10;
    for (let i = 0; i < maxSteps; i += 1) {
      await page.keyboard.press('Tab');
      const { description, visibleFocus } = await describeAndCheckFocus();
      const previous = steps[steps.length - 1];
      // "(none)" means focus left the page (the Overview view has nothing left to tab to after the
      // range selector, DESIGN.md §10): that is the expected end of this walkthrough, not a stuck
      // focus, and there is no outline to check on a target that does not exist.
      if (description === '(none)') {
        steps.push({ index: i + 1, description, visibleFocus });
        break;
      }
      if (previous !== undefined && previous.description === description) stuck = true;
      steps.push({ index: i + 1, description, visibleFocus });
    }

    const firstStopIsSkipLink = steps[0]?.description.includes('Skip to content') ?? false;
    const realSteps = steps.filter((step) => step.description !== '(none)');

    // Re-focus the skip link and activate it with the keyboard; it should move focus to <main>.
    await page.evaluate(blurActiveElement);
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    const afterActivate = await page.evaluate(activeElementId);
    const skipLinkJumpsToContent = afterActivate === 'content';

    return {
      firstStopIsSkipLink,
      skipLinkJumpsToContent,
      steps,
      noStuckFocus: !stuck,
      allVisibleFocus: realSteps.length > 0 && realSteps.every((step) => step.visibleFocus),
    };
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------- request drawer: the one real trap

interface DrawerTrapResult {
  readonly opened: boolean;
  readonly stayedInsideWhileTabbing: boolean;
  readonly escapeClosed: boolean;
  readonly focusReturnedToOpener: boolean;
}

function focusFirstTimeButtonRequestId(): string | null {
  const button = document.querySelector('.time-button[tabindex="0"]');
  if (button === null) return null;
  button.focus();
  return button.getAttribute('data-request-id');
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

/**
 * The dashboard's only modal is the request drawer (DESIGN.md §13.4/§13.7): opening it is meant to
 * trap Tab inside it (the header and main content go `inert`), Escape closes it, and focus returns to
 * the row that opened it. This is the one place "no keyboard traps" needs a real check rather than a
 * plain walk of the page: an *unintentional* trap elsewhere would show up as `noStuckFocus: false` in
 * runKeyboardWalkthrough, but the *intentional* one here has to behave exactly like this to be safe.
 */
async function checkRequestDrawerFocusTrap(browser: Browser, baseUrl: string): Promise<DrawerTrapResult> {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: 'light',
    bypassCSP: true,
  });
  const page = await context.newPage();
  try {
    await page.goto(`${baseUrl}/dashboard#view=routing&range=1h`);
    await waitForDashboardReady(page, 'routing');

    const openerId = await page.evaluate(focusFirstTimeButtonRequestId);
    if (openerId === null) {
      throw new Error('the routing table has no request row to open (the demo produced no requests?)');
    }
    await page.keyboard.press('Enter');
    await page.waitForFunction(isDrawerOpen, null, { timeout: 5_000 });

    let stayedInsideWhileTabbing = true;
    for (let i = 0; i < 10; i += 1) {
      await page.keyboard.press('Tab');
      if (!(await page.evaluate(activeElementIsInsideDrawer))) stayedInsideWhileTabbing = false;
    }

    await page.keyboard.press('Escape');
    let escapeClosed = true;
    try {
      await page.waitForFunction(isDrawerClosed, null, { timeout: 5_000 });
    } catch {
      escapeClosed = false;
    }
    const returnedId = await page.evaluate(activeElementRequestId);

    return {
      opened: true,
      stayedInsideWhileTabbing,
      escapeClosed,
      focusReturnedToOpener: escapeClosed && returnedId === openerId,
    };
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if ('exit' in parsed) {
    process.exitCode = parsed.exit;
    return;
  }
  const { out } = parsed;

  prepareOutputDir(out);

  const dbFile = path.join(tmpdir(), `tollwise-verify-dashboard-${process.pid}.db`);
  if (existsSync(dbFile)) rmSync(dbFile, { force: true });

  console.log('verify-dashboard: starting the demo setup ...');
  const demo = await startDemo(dbFile);
  console.log(`verify-dashboard: demo ready at ${demo.baseUrl}, traffic flowing`);

  let browser: Browser | undefined;
  const allViolations: ViolationRecord[] = [];
  const screenshots: string[] = [];
  let keyboard: KeyboardWalkthroughResult | undefined;
  let drawerTrap: DrawerTrapResult | undefined;

  try {
    browser = await chromium.launch({ channel: 'chrome' });

    for (const view of VIEWS) {
      for (const viewport of VIEWPORTS) {
        for (const theme of THEMES) {
          const { screenshot, violations } = await checkOne(browser, demo.baseUrl, out, view, viewport, theme);
          screenshots.push(screenshot);
          allViolations.push(...violations);
          console.log(
            `verify-dashboard: ${view.id.padEnd(10, ' ')} ${String(viewport.width).padStart(4, ' ')}x${theme.padEnd(5, ' ')} ` +
              `-> ${violations.length} violation(s); ${screenshot}`,
          );
        }
      }
    }

    for (const viewport of VIEWPORTS) {
      for (const theme of THEMES) {
        const { screenshot, violations } = await checkSubstitutionDrawer(browser, demo.baseUrl, out, viewport, theme);
        screenshots.push(screenshot);
        allViolations.push(...violations);
        console.log(
          `verify-dashboard: ${SUBSTITUTION_DRAWER_ID} ${String(viewport.width).padStart(4, ' ')}x${theme.padEnd(5, ' ')} ` +
            `-> ${violations.length} violation(s); ${screenshot}`,
        );
      }
    }

    console.log('verify-dashboard: running the keyboard walkthrough ...');
    keyboard = await runKeyboardWalkthrough(browser, demo.baseUrl);
    drawerTrap = await checkRequestDrawerFocusTrap(browser, demo.baseUrl);
  } finally {
    await browser?.close();
    await demo.stop();
    rmSync(dbFile, { force: true });
  }

  console.log('');
  console.log(`verify-dashboard: ${screenshots.length} screenshot(s) written to ${out}`);
  for (const screenshot of screenshots) console.log(`  ${screenshot}`);

  console.log('');
  if (allViolations.length === 0) {
    console.log('verify-dashboard: accessibility scan (wcag2a, wcag2aa, wcag22aa): 0 violations');
  } else {
    console.log(`verify-dashboard: accessibility scan: ${allViolations.length} violation(s) found`);
    console.log(JSON.stringify(allViolations, null, 2));
  }

  console.log('');
  console.log('verify-dashboard: keyboard walkthrough');
  console.log(`  first Tab stop is the skip link: ${keyboard.firstStopIsSkipLink}`);
  console.log(`  activating the skip link moves focus to <main>: ${keyboard.skipLinkJumpsToContent}`);
  console.log(`  no stuck focus across ${keyboard.steps.length} Tab presses: ${keyboard.noStuckFocus}`);
  console.log(`  every stop shows a visible focus outline: ${keyboard.allVisibleFocus}`);
  for (const step of keyboard.steps) {
    console.log(`    ${step.index}. ${step.description} (visible focus: ${step.visibleFocus})`);
  }

  console.log('');
  console.log('verify-dashboard: request drawer focus trap (DESIGN.md §13.4/§13.7)');
  console.log(`  drawer opened on Enter: ${drawerTrap.opened}`);
  console.log(`  Tab stayed inside the drawer for 10 presses: ${drawerTrap.stayedInsideWhileTabbing}`);
  console.log(`  Escape closed it: ${drawerTrap.escapeClosed}`);
  console.log(`  focus returned to the row that opened it: ${drawerTrap.focusReturnedToOpener}`);

  const keyboardPassed =
    keyboard.firstStopIsSkipLink &&
    keyboard.skipLinkJumpsToContent &&
    keyboard.noStuckFocus &&
    keyboard.allVisibleFocus;
  const drawerPassed =
    drawerTrap.opened &&
    drawerTrap.stayedInsideWhileTabbing &&
    drawerTrap.escapeClosed &&
    drawerTrap.focusReturnedToOpener;

  if (allViolations.length > 0 || !keyboardPassed || !drawerPassed) {
    console.log('');
    console.log('verify-dashboard: FAILED');
    process.exitCode = 1;
    return;
  }
  console.log('');
  console.log('verify-dashboard: PASSED');
}

// Run only when started as a script, so the tests can import the helpers above without a browser.
const samePath = (a: string, b: string): boolean =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const invokedAs = process.argv[1] === undefined ? '' : path.resolve(process.argv[1]);
if (samePath(invokedAs, fileURLToPath(import.meta.url))) {
  main().catch((error: unknown) => {
    console.error(`verify-dashboard: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    process.exitCode = 1;
  });
}
