// Builds the static demo of the dashboard into docs/demo: a self-contained site that GitHub Pages (or any
// static file server) can serve under any sub-path, with no server, no API and no network access at run
// time. It is the real dashboard: src/dashboard/**/*.ts compiled with tsconfig.dashboard.json, the same
// stylesheet, and the live page's index.html with its asset paths made relative. Only two things differ:
// the entry module is demo/entry.js, which runs the shell on the recorded snapshot instead of the live API,
// and the page carries the static-demo banner and a Content-Security-Policy that forbids every connection.
// The snapshot (demo/snapshot.json, recorded by `npm run demo:snapshot`) is embedded as the script module
// demo/snapshot.js, so nothing is fetched.
//
// Usage: node scripts/build-demo-site.ts [output folder]   (default: docs/demo)
// The output folder is emptied first. It is refused when it holds the repository, the dashboard sources or
// the snapshot, lies inside the sources, or holds files that are not a previous build of this script.

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DASHBOARD_CSP } from '../src/server/dashboard.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = path.join(repoRoot, 'src', 'dashboard');
const tsconfig = path.join(repoRoot, 'tsconfig.dashboard.json');
export const SNAPSHOT_PATH = path.join(repoRoot, 'demo', 'snapshot.json');
export const DEFAULT_OUTPUT = path.join(repoRoot, 'docs', 'demo');

/** Where the banner's links point: the method behind the modeled figures, and how to run Tollwise. */
export const BENCHMARK_METHOD_URL =
  'https://github.com/nunomarques97/tollwise/blob/main/docs/benchmarks.md#savings-modeled';
export const QUICK_START_URL = 'https://github.com/nunomarques97/tollwise#quick-start';

/** The banner's lead-in and sentence (DESIGN.md §15). */
export const BANNER_LEAD = 'Static demo.';
export const BANNER_TEXT = 'Sample data from a modeled workload, not a live service.';

/** Marks a page written by this script, so a rebuild only ever empties a folder it built itself. */
export const GENERATOR_META = '<meta name="generator" content="Tollwise static demo build">';

/** The compiled live entry: the demo page never loads it, so it is left out of the site. */
const LIVE_ENTRY = 'main.js';

/**
 * The dashboard's Content-Security-Policy with every connection forbidden. `frame-ancestors` is left out
 * because a browser ignores it in a <meta> policy; everything else is kept as the live dashboard sends it.
 */
export function demoCsp(): string {
  const directives = DASHBOARD_CSP.split('; ');
  if (!directives.includes("connect-src 'self'")) throw new Error("DASHBOARD_CSP has no connect-src 'self'.");
  return directives
    .filter((directive) => !directive.startsWith('frame-ancestors '))
    .map((directive) => (directive.startsWith('connect-src ') ? "connect-src 'none'" : directive))
    .join('; ');
}

function replaceOnce(html: string, from: string, to: string): string {
  const at = html.indexOf(from);
  if (at === -1 || html.indexOf(from, at + 1) !== -1) {
    throw new Error(`src/dashboard/index.html must contain exactly one ${JSON.stringify(from)}.`);
  }
  return html.slice(0, at) + to + html.slice(at + from.length);
}

const BANNER = `<div class="banner is-demo" role="note" aria-label="About this demo">
        <strong>${BANNER_LEAD}</strong>
        <span>${BANNER_TEXT} <a href="${BENCHMARK_METHOD_URL}">How the savings are modeled</a><span class="banner-sep" aria-hidden="true"> · </span><a href="${QUICK_START_URL}">Run Tollwise yourself</a></span>
      </div>`;

/** The demo page: the live dashboard's index.html with relative paths, the demo entry, CSP and banner. */
export function demoIndexHtml(liveHtml: string): string {
  let html = liveHtml;
  html = replaceOnce(
    html,
    '<meta charset="utf-8">',
    `<meta charset="utf-8">\n    <meta http-equiv="Content-Security-Policy" content="${demoCsp()}">\n    ${GENERATOR_META}`,
  );
  html = replaceOnce(
    html,
    '<title>Tollwise dashboard</title>',
    '<title>Tollwise dashboard: static demo</title>\n    <meta name="description" content="A static demo of the Tollwise dashboard, showing sample data from a modeled workload.">',
  );
  html = replaceOnce(html, 'src="/dashboard/theme-init.js"', 'src="theme-init.js"');
  html = replaceOnce(html, 'href="/dashboard/style.css"', 'href="style.css"');
  html = replaceOnce(html, 'src="/dashboard/main.js"', 'src="demo/entry.js"');
  html = replaceOnce(html, '<tw-live-status data-state="connecting">', '<tw-live-status data-state="demo">');
  html = replaceOnce(html, '<main id="content" tabindex="-1">', `<main id="content" tabindex="-1">\n      ${BANNER}`);
  html = html.replace(
    /<p class="noscript">[\s\S]*?<\/p>/,
    '<p class="noscript">This static demo of the Tollwise dashboard needs JavaScript to show its sample data.</p>',
  );
  if (!html.includes('This static demo of the Tollwise dashboard needs JavaScript')) {
    throw new Error('src/dashboard/index.html has no <p class="noscript"> text to replace.');
  }
  if (/(?:src|href)="\//.test(html)) throw new Error('The demo page still has an absolute asset path.');
  return html;
}

/** The snapshot as the script module demo/entry.js imports. */
export function snapshotModule(snapshotJson: string): string {
  const snapshot: unknown = JSON.parse(snapshotJson);
  return (
    '// Generated by scripts/build-demo-site.ts from demo/snapshot.json (`npm run demo:snapshot`). Do not edit.\n' +
    `export default ${JSON.stringify(snapshot, null, 2)};\n`
  );
}

/** True when `child` is `parent` or lies below it. */
function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Why `outDir` must not be emptied and built into, or undefined when it is safe. */
export function unsafeOutputReason(outDir: string): string | undefined {
  if (isWithin(outDir, repoRoot)) return 'it holds the repository';
  if (isWithin(outDir, sourceDir) || isWithin(sourceDir, outDir))
    return 'it holds the dashboard sources or lies inside them';
  if (isWithin(outDir, SNAPSHOT_PATH)) return 'it holds the demo snapshot';
  if (!existsSync(outDir)) return undefined;
  if (!statSync(outDir).isDirectory()) return 'it is not a folder';
  if (readdirSync(outDir).length === 0) return undefined;
  const page = path.join(outDir, 'index.html');
  const builtHere = existsSync(page) && statSync(page).isFile() && readFileSync(page, 'utf8').includes(GENERATOR_META);
  return builtHere ? undefined : 'it holds files that are not a previous build of the static demo';
}

/** Builds the static demo into `outDir`; throws with the reason when it cannot. */
export function buildDemoSite(outDir: string): void {
  const reason = unsafeOutputReason(outDir);
  if (reason !== undefined) throw new Error(`refusing to build into ${outDir}: ${reason}. Choose a folder of its own.`);
  const liveHtml = readFileSync(path.join(sourceDir, 'index.html'), 'utf8');
  const page = demoIndexHtml(liveHtml);
  const snapshot = snapshotModule(readFileSync(SNAPSHOT_PATH, 'utf8'));

  // The TypeScript compiler of this package, run with this Node: no shell and no PATH lookup involved.
  const require = createRequire(import.meta.url);
  const tsc = path.join(path.dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const compiled = spawnSync(process.execPath, [tsc, '-p', tsconfig, '--outDir', outDir], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  if (compiled.error !== undefined)
    throw new Error(`could not run the TypeScript compiler (${compiled.error.message}).`);
  if (compiled.status !== 0) throw new Error('the TypeScript compiler reported errors (see above).');

  rmSync(path.join(outDir, LIVE_ENTRY));
  cpSync(path.join(sourceDir, 'style.css'), path.join(outDir, 'style.css'));
  writeFileSync(path.join(outDir, 'index.html'), page);
  writeFileSync(path.join(outDir, 'demo', 'snapshot.js'), snapshot);
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && path.resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  const outDir = path.resolve(process.argv[2] ?? DEFAULT_OUTPUT);
  try {
    buildDemoSite(outDir);
    const shown = isWithin(repoRoot, outDir) ? path.relative(repoRoot, outDir).replaceAll(path.sep, '/') : outDir;
    console.log(`build:demo-site: static demo built in ${shown}`);
  } catch (error) {
    console.error(`build:demo-site: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
