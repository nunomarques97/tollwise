// Builds the dashboard into dist/dashboard: compiles src/dashboard/**/*.ts with tsconfig.dashboard.json and
// copies the page and its stylesheets (*.html, *.css) next to the compiled scripts. The output folder is
// emptied first, so a file removed from src/dashboard is never served again.
//
// Usage: node scripts/build-dashboard.ts [output folder]   (default: dist/dashboard)
// Runs on `npm install` and `npm ci` through the `prepare` script. Plain Node APIs only, so it behaves the
// same on Windows, macOS and Linux.

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = path.join(repoRoot, 'src', 'dashboard');
const tsconfig = path.join(repoRoot, 'tsconfig.dashboard.json');
const outDir = path.resolve(process.argv[2] ?? path.join(repoRoot, 'dist', 'dashboard'));

/** Files copied as they are; everything else in src/dashboard is either compiled or left out. */
const COPIED_EXTENSIONS: ReadonlySet<string> = new Set(['.html', '.css']);

function fail(message: string): never {
  console.error(`build:dashboard: ${message}`);
  process.exit(1);
}

/** True when `child` is `parent` or lies below it. */
function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

// The output folder is deleted before every build: refuse one that holds the sources or lies inside them.
if (isWithin(outDir, sourceDir) || isWithin(sourceDir, outDir)) {
  fail(`refusing to build into ${outDir}: choose a folder of its own.`);
}

// The TypeScript compiler of this package, run with this Node: no shell and no PATH lookup involved.
const require = createRequire(import.meta.url);
const tsc = path.join(path.dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const compiled = spawnSync(process.execPath, [tsc, '-p', tsconfig, '--outDir', outDir], {
  cwd: repoRoot,
  stdio: 'inherit',
});
if (compiled.error !== undefined) fail(`could not run the TypeScript compiler (${compiled.error.message}).`);
if (compiled.status !== 0) fail('the TypeScript compiler reported errors (see above).');

cpSync(sourceDir, outDir, {
  recursive: true,
  filter: (source) => statSync(source).isDirectory() || COPIED_EXTENSIONS.has(path.extname(source)),
});

if (!existsSync(path.join(outDir, 'index.html'))) fail('src/dashboard/index.html is missing.');
console.log(`build:dashboard: dashboard built in ${path.relative(repoRoot, outDir).replaceAll(path.sep, '/')}`);
