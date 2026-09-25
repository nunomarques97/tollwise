// Checks that what README.md and the docs pages claim is backed by the repository itself:
//
// - every relative link in README.md and docs/*.md resolves to an existing file, and a `#fragment`
//   to a heading (or explicit id) of the target page;
// - every page shipped in the public edition links only to files the public edition also ships;
// - every cited benchmarks/results file exists, and README cites the newest one of each kind;
// - every savings or overhead number in a README paragraph equals a value recorded in the results
//   file that paragraph cites, and the headline puts the modeled presets-on figure next to the default;
// - every `npm run <script>` (and `npm start` / `npm test`) named in README exists in package.json;
// - every figure in marketing/*.md equals a value of the results file its section cites, every
//   docs/images reference and repository link there exists, and each launch post leads with the
//   modeled presets-on savings while stating the default and the opt-in substitution rules;
// - marketing/release-checklist.md walks the release in order, and every npm script, script file and
//   flag it runs exists (the export's flags as its --help lists them).

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS_DIR = 'benchmarks/results';
const RESULTS_FILE = /benchmarks\/results\/[A-Za-z0-9._-]+\.json/g;

/** README.md plus every docs/*.md page, as repository-relative paths. */
function pages(): string[] {
  const docs = readdirSync(path.join(root, 'docs'))
    .filter((name) => name.endsWith('.md'))
    .map((name) => `docs/${name}`);
  return ['README.md', ...docs];
}

function read(relPath: string): string {
  return readFileSync(path.join(root, relPath), 'utf8');
}

/** `markdown` with fenced code blocks (and, unless kept, inline code spans) blanked out, line count preserved. */
function prose(markdown: string, keepInlineCode = false): string {
  let inBlock = false;
  return markdown
    .split(/\r?\n/)
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inBlock = !inBlock;
        return '';
      }
      if (inBlock) return '';
      return keepInlineCode ? line.replace(/`/g, '') : line.replace(/`[^`]*`/g, '``');
    })
    .join('\n');
}

/** The target of every Markdown link and image, and every HTML `href`/`src`, in the prose of `markdown`. */
function linkTargets(markdown: string): string[] {
  const text = prose(markdown);
  const markdownLinks = [...text.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)].map((m) => m[1] ?? '');
  const htmlLinks = [...text.matchAll(/\b(?:href|src)="([^"]+)"/g)].map((m) => m[1] ?? '');
  return [...markdownLinks, ...htmlLinks];
}

function isExternal(target: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(target);
}

/** GitHub's anchor for a heading: lower case, punctuation dropped, spaces turned into hyphens. */
function slug(heading: string): string {
  return heading
    .replace(/`/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .replace(/ /g, '-');
}

/** Every anchor a page offers: one per heading (with GitHub's -1, -2 suffixes for repeats) plus explicit ids. */
function anchorsOf(markdown: string): Set<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  let inBlock = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) inBlock = !inBlock;
    if (inBlock) continue;
    const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      const base = slug(heading[1] ?? '');
      const count = seen.get(base) ?? 0;
      anchors.add(count === 0 ? base : `${base}-${count}`);
      seen.set(base, count + 1);
    }
    for (const match of line.matchAll(/\b(?:id|name)="([^"]+)"/g)) anchors.add(match[1] ?? '');
  }
  return anchors;
}

/** The repository-relative path and fragment a relative link from `page` points at. */
function resolveLink(page: string, target: string): { file: string; fragment: string | null } {
  const hash = target.indexOf('#');
  const filePart = hash === -1 ? target : target.slice(0, hash);
  const fragment = hash === -1 ? null : decodeURIComponent(target.slice(hash + 1));
  const file =
    filePart === ''
      ? page
      : path.posix.normalize(path.posix.join(path.posix.dirname(page), decodeURIComponent(filePart)));
  return { file: file.replace(/\/$/, ''), fragment };
}

/** Every repository file under `relPath` (the path itself when it is a file). */
function filesUnder(relPath: string): string[] {
  const full = path.join(root, relPath);
  if (!statSync(full).isDirectory()) return [relPath];
  return readdirSync(full, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'));
}

/** Paragraphs of README prose (blank-line separated), with link targets removed so their digits do not count. */
function paragraphs(markdown: string): { text: string; cited: string[] }[] {
  return prose(markdown, true)
    .split(/\n\s*\n/)
    .map((block) => ({
      text: block.replace(/\]\([^)]*\)/g, ']'),
      cited: [...new Set(block.match(RESULTS_FILE) ?? [])],
    }));
}

/** Every numeric leaf of a parsed JSON value (numbers, and strings that are plain decimal numbers). */
function numericLeaves(value: unknown, out: Set<number> = new Set()): Set<number> {
  if (typeof value === 'number') out.add(value);
  else if (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value)) out.add(Number(value));
  else if (Array.isArray(value)) for (const item of value) numericLeaves(item, out);
  else if (value !== null && typeof value === 'object')
    for (const item of Object.values(value)) numericLeaves(item, out);
  return out;
}

function loadJson(relPath: string): unknown {
  return JSON.parse(read(relPath));
}

interface SavingsRun {
  policy: string;
  savings_percent: number | null;
}

interface SavingsResults {
  scenarios: { id: string; config: { equivalence_presets: string[] }; runs: SavingsRun[] }[];
}

function savingsPercent(results: SavingsResults, scenarioId: string, policy: string): number {
  const scenario = results.scenarios.find((s) => s.id === scenarioId);
  assert.ok(scenario, `the savings results have no "${scenarioId}" scenario`);
  const run = scenario.runs.find((r) => r.policy === policy);
  assert.ok(run && typeof run.savings_percent === 'number', `"${scenarioId}" has no ${policy} savings figure`);
  return run.savings_percent;
}

/** The newest results file of one kind, by the UTC date (and -N suffix) in its name. */
function newestResults(kind: string): string | null {
  const pattern = new RegExp(`^${kind}-(\\d{4}-\\d{2}-\\d{2})(?:-(\\d+))?\\.json$`);
  let newest: { name: string; key: string } | null = null;
  for (const name of readdirSync(path.join(root, RESULTS_DIR))) {
    const match = pattern.exec(name);
    if (!match) continue;
    const key = `${match[1]}-${(match[2] ?? '1').padStart(6, '0')}`;
    if (newest === null || key > newest.key) newest = { name, key };
  }
  return newest === null ? null : `${RESULTS_DIR}/${newest.name}`;
}

const readme = read('README.md');

const exportScript = path.join(root, 'scripts', 'export-public.mjs');
const allowListFile = path.join(root, 'scripts', 'public-edition.json');
/** The private repository has the export tooling; the public edition it builds does not. */
const privateTree = existsSync(exportScript) && existsSync(allowListFile);

/** Whether a repository-relative file is exported to the public edition (private tree only). */
async function publicEditionFilter(): Promise<(file: string) => boolean> {
  const { HARD_EXCLUDES, matchesAny, loadAllowList } = await import(pathToFileURL(exportScript).href);
  const allowList: string[] = loadAllowList(allowListFile);
  return (file) => matchesAny(file, allowList) && !matchesAny(file, HARD_EXCLUDES, true);
}

describe('links in README.md and docs/*.md', () => {
  test('every relative link resolves to an existing file and heading', () => {
    let checked = 0;
    for (const page of pages()) {
      const markdown = read(page);
      for (const target of linkTargets(markdown)) {
        if (isExternal(target)) continue;
        const { file, fragment } = resolveLink(page, target);
        assert.ok(existsSync(path.join(root, file)), `${page} links to ${target}, but ${file} does not exist`);
        if (fragment !== null && file.endsWith('.md')) {
          const anchors = anchorsOf(file === page ? markdown : read(file));
          assert.ok(anchors.has(fragment), `${page} links to ${target}, but ${file} has no heading #${fragment}`);
        }
        checked += 1;
      }
    }
    assert.ok(checked > 50, `sanity: expected many relative links, found ${checked}`);
  });

  test('the link checker catches a missing file and a missing heading', () => {
    const page = 'README.md';
    const [missingFile] = linkTargets('See [this](docs/no-such-page.md).');
    assert.equal(existsSync(path.join(root, resolveLink(page, missingFile ?? '').file)), false);
    const [missingHeading] = linkTargets('See [that](docs/routing.md#no-such-heading).');
    const { file, fragment } = resolveLink(page, missingHeading ?? '');
    assert.equal(anchorsOf(read(file)).has(fragment ?? ''), false);
    assert.deepEqual(linkTargets('```\n[x](nowhere.md)\n```\nand `[y](nowhere.md)`'), []);
    assert.equal(slug('Proxy overhead (`npm run bench:overhead`)'), 'proxy-overhead-npm-run-benchoverhead');
  });

  test('every public page links only to files the public edition ships', {
    skip: privateTree ? false : 'the export tooling is not part of this tree',
  }, async () => {
    const isPublic = await publicEditionFilter();
    for (const page of pages()) {
      if (!isPublic(page)) continue;
      for (const target of linkTargets(read(page))) {
        if (isExternal(target)) continue;
        const { file } = resolveLink(page, target);
        if (!existsSync(path.join(root, file))) continue; // reported by the resolution test
        assert.ok(
          filesUnder(file).some(isPublic),
          `${page} is public but links to ${target}, which scripts/public-edition.json does not export`,
        );
      }
    }
  });
});

describe('benchmark results cited by README.md and docs/*.md', () => {
  test('every cited results file exists', () => {
    let cited = 0;
    for (const page of pages()) {
      for (const file of read(page).match(RESULTS_FILE) ?? []) {
        assert.ok(existsSync(path.join(root, file)), `${page} cites ${file}, which does not exist`);
        cited += 1;
      }
    }
    assert.ok(cited > 0, 'sanity: at least one results file is cited');
  });

  test('README cites the newest savings and overhead results', () => {
    for (const kind of ['savings', 'overhead']) {
      const newest = newestResults(kind);
      assert.ok(newest, `no ${kind} results file exists`);
      const cited = new Set((readme.match(RESULTS_FILE) ?? []).filter((file) => file.includes(`/${kind}-`)));
      assert.deepEqual([...cited], [newest], `README should cite exactly the newest ${kind} results, ${newest}`);
    }
  });
});

describe('numbers in README.md', () => {
  const citing = paragraphs(readme).filter((p) => p.cited.length > 0);

  test('every savings and overhead number equals a value in the results file its paragraph cites', () => {
    let checked = 0;
    for (const { text, cited } of citing) {
      const recorded = new Set<number>();
      const dates = new Set<string>();
      for (const file of cited) {
        const json = loadJson(file) as { date?: string };
        for (const value of numericLeaves(json)) recorded.add(value);
        if (typeof json.date === 'string') dates.add(json.date.slice(0, 10));
      }
      const excerpt = text.replace(/\s+/g, ' ').slice(0, 80);
      for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*(%|ms\b|MB\b)/g)) {
        const value = Number(match[1]);
        assert.ok(recorded.has(value), `"${match[0]}" in "${excerpt}..." is not recorded in ${cited.join(', ')}`);
        checked += 1;
      }
      for (const match of text.matchAll(/median of (\d+)/g)) {
        assert.ok(recorded.has(Number(match[1])), `"${match[0]}" is not recorded in ${cited.join(', ')}`);
      }
      for (const match of text.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)) {
        assert.ok(
          dates.has(match[0]),
          `the date ${match[0]} in "${excerpt}..." is not the date of ${cited.join(', ')}`,
        );
      }
    }
    assert.ok(checked >= 8, `sanity: expected the savings and overhead figures, checked ${checked}`);
  });

  test('the overhead figures are the recorded ones, each in its place', () => {
    const file = newestResults('overhead');
    assert.ok(file);
    const results = (loadJson(file) as { results: Record<string, Record<string, unknown>> }).results;
    const paragraph = citing.find((p) => p.cited.includes(file));
    assert.ok(paragraph, `no README paragraph cites ${file}`);
    const text = paragraph.text.replace(/\s+/g, ' ');
    const nonStreaming = results.non_streaming as { overhead_p50_ms: number; overhead_p99_ms: number };
    const streaming = results.streaming_first_byte as { overhead_p50_ms: number };
    const startup = results.startup as { median_ms: number };
    const memory = results.idle_memory as { rss_mb: number };
    assert.ok(text.includes(`p50 ${nonStreaming.overhead_p50_ms} ms`), 'non-streaming overhead p50');
    assert.ok(text.includes(`p99 ${nonStreaming.overhead_p99_ms} ms`), 'non-streaming overhead p99');
    assert.ok(text.includes(`first byte p50 ${streaming.overhead_p50_ms} ms`), 'streaming first-byte overhead');
    assert.ok(text.includes(`startup ${startup.median_ms} ms`), 'startup median');
    assert.ok(text.includes(`idle memory ${memory.rss_mb} MB`), 'idle memory');
  });

  test('the savings headline puts the modeled presets-on figure next to the default and says substitution is opt-in', () => {
    const file = newestResults('savings');
    assert.ok(file);
    const results = loadJson(file) as SavingsResults;
    const presetsOn = results.scenarios.find((s) => s.id === 'presets-on');
    assert.ok(presetsOn && presetsOn.config.equivalence_presets.length > 0, 'the presets-on scenario enables presets');
    const withPresets = savingsPercent(results, 'presets-on', 'cheapest');
    const byDefault = savingsPercent(results, 'realistic-default', 'cheapest');

    const [headline] = citing.filter((p) => p.cited.includes(file));
    assert.ok(headline, `no README paragraph cites ${file}`);
    const text = headline.text.replace(/\s+/g, ' ');
    assert.match(text, /modeled savings/i, 'the headline says the savings are modeled');
    assert.ok(text.includes(`${withPresets}%`), `the headline shows the presets-on figure, ${withPresets}%`);
    assert.ok(text.includes(`${byDefault}%`), `the headline shows the default figure, ${byDefault}%`);
    assert.ok(text.indexOf(`${withPresets}%`) < text.indexOf(`${byDefault}%`), 'the presets-on figure leads');
    for (const preset of presetsOn.config.equivalence_presets) {
      assert.ok(text.includes(preset), `the headline names the ${preset} preset`);
    }
    assert.match(text, /by default tollwise only switches between providers of the model you asked for/i);
    assert.match(text, /opt-in/);
    assert.ok(headline.cited.includes(file), 'the headline links the raw results');
    assert.match(readme, /\]\(docs\/benchmarks\.md#savings-modeled\)/, 'README links the savings method');
  });

  test('the Ollama end-to-end line matches its record', () => {
    const file = newestResults('e2e-ollama');
    assert.ok(file, 'no e2e-ollama record exists');
    const record = loadJson(file) as { model: string; cases: { pass: boolean }[] };
    const paragraph = citing.find((p) => p.cited.includes(file));
    assert.ok(paragraph, `README does not cite ${file}`);
    assert.ok(paragraph.text.includes(record.model), `the line names the recorded model, ${record.model}`);
    assert.ok(
      record.cases.every((c) => c.pass),
      'README claims every case passed',
    );
    assert.match(
      paragraph.text,
      new RegExp(`all ${['zero', 'one', 'two', 'three', 'four', 'five'][record.cases.length]} cases`),
    );
  });
});

test('every npm script README names exists in package.json', () => {
  const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts;
  const named = [
    ...[...readme.matchAll(/\bnpm run ([A-Za-z0-9:._-]+)/g)].map((m) => m[1] ?? ''),
    ...[...readme.matchAll(/\bnode --run ([A-Za-z0-9:._-]+)/g)].map((m) => m[1] ?? ''),
    ...[...readme.matchAll(/\bnpm (start|test)\b/g)].map((m) => m[1] ?? ''),
  ];
  assert.ok(named.length > 0, 'sanity: README names npm scripts');
  for (const name of named)
    assert.ok(name in scripts, `README runs "npm run ${name}", which package.json does not define`);
});

// ---------------------------------------------------------------- marketing/*.md

const REPO_URL = 'https://github.com/nunomarques97/tollwise';
const MARKETING_DIR = 'marketing';
/** The launch posts: each one must carry the whole savings story on its own. */
const LAUNCH_PIECES = ['reddit.md', 'x-thread.md', 'show-hn.md', 'product-hunt.md'];
const LAUNCH_ASSETS = [...LAUNCH_PIECES, 'launch-day-checklist.md'];
const URL_PATTERN = /https?:\/\/[^\s<>)\]`"]+/g;
const IMAGE_REFERENCE = /docs\/images\/[A-Za-z0-9._-]+/g;

function marketingPages(): string[] {
  return readdirSync(path.join(root, MARKETING_DIR))
    .filter((name) => name.endsWith('.md'))
    .map((name) => `${MARKETING_DIR}/${name}`);
}

/** The text under each heading, down to the next heading of any level (the lines before the first one included). */
function sections(markdown: string): { heading: string; level: number; text: string }[] {
  const out = [{ heading: '', level: 0, text: '' }];
  let inBlock = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) inBlock = !inBlock;
    const heading = inBlock ? null : /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading) out.push({ heading: heading[2] ?? '', level: (heading[1] ?? '').length, text: '' });
    else {
      const current = out[out.length - 1];
      if (current) current.text += `${line}\n`;
    }
  }
  return out;
}

/** The content of every fenced code block in `markdown`: the text to copy into a post. */
function fencedBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/^```[\w-]*\r?\n([\s\S]*?)^```\s*$/gm)].map((m) => (m[1] ?? '').trimEnd());
}

/** Every figure a text states outside its URLs: percentages, durations, sizes, dollar amounts and request counts. */
function figures(text: string): { raw: string; value: number }[] {
  const plain = text.replace(URL_PATTERN, ' ');
  const patterns = [
    /(?<![\w.])(\d+(?:\.\d+)?)\s*(?:%|ms\b|MB\b)/g,
    /\$(\d+(?:\.\d+)?)/g,
    /(?<![\w.])(\d+(?:\.\d+)?)[ -]requests?\b/g,
  ];
  return patterns.flatMap((pattern) => [...plain.matchAll(pattern)].map((m) => ({ raw: m[0], value: Number(m[1]) })));
}

/** The percentages a text states outside its URLs, in order. */
function percentages(text: string): number[] {
  return [...text.replace(URL_PATTERN, ' ').matchAll(/(?<![\w.])(\d+(?:\.\d+)?)\s*%/g)].map((m) => Number(m[1]));
}

/** Each launch piece: one per subreddit in reddit.md (its `## r/...` section), the whole file otherwise. */
function launchPieces(): { name: string; text: string }[] {
  const pieces: { name: string; text: string }[] = [];
  for (const file of LAUNCH_PIECES) {
    const page = `${MARKETING_DIR}/${file}`;
    const markdown = read(page);
    if (file !== 'reddit.md') {
      pieces.push({ name: page, text: markdown });
      continue;
    }
    let current: { name: string; text: string } | null = null;
    for (const section of sections(markdown)) {
      if (section.level === 2) {
        current = /^r\/\w+$/.test(section.heading) ? { name: `${page} ${section.heading}`, text: '' } : null;
        if (current) pieces.push(current);
      } else if (section.level === 1) current = null;
      if (current)
        current.text += `${section.level > 2 ? `${'#'.repeat(section.level)} ${section.heading}\n` : ''}${section.text}`;
    }
  }
  return pieces;
}

/** The length of one post as X counts it: every link is 23 characters, whatever its length. */
function xLength(post: string): number {
  return [...post.replace(URL_PATTERN, 'x'.repeat(23))].length;
}

/** The single fenced block under the heading `heading` of `page`. */
function blockUnder(page: string, heading: string): string {
  const section = sections(read(page)).find((s) => s.heading === heading);
  assert.ok(section, `${page} has no "${heading}" section`);
  const blocks = fencedBlocks(section.text);
  assert.equal(blocks.length, 1, `the "${heading}" section of ${page} holds exactly one code block`);
  return blocks[0] ?? '';
}

describe('marketing/*.md', () => {
  test('every launch asset exists', () => {
    for (const file of LAUNCH_ASSETS) {
      assert.ok(existsSync(path.join(root, MARKETING_DIR, file)), `${MARKETING_DIR}/${file} is missing`);
    }
  });

  test('every figure cites an existing results file in its section and equals a value recorded there', () => {
    let checked = 0;
    for (const page of marketingPages()) {
      for (const section of sections(read(page))) {
        const stated = figures(section.text);
        if (stated.length === 0) continue;
        const where = `${page}${section.heading ? ` ("${section.heading}")` : ''}`;
        const cited = [...new Set(section.text.match(RESULTS_FILE) ?? [])];
        assert.ok(cited.length > 0, `${where} states ${stated.map((f) => f.raw).join(', ')} but cites no results file`);
        const recorded = new Set<number>();
        const dates = new Set<string>();
        for (const file of cited) {
          assert.ok(existsSync(path.join(root, file)), `${where} cites ${file}, which does not exist`);
          const json = loadJson(file) as { date?: string };
          for (const value of numericLeaves(json)) recorded.add(value);
          if (typeof json.date === 'string') dates.add(json.date.slice(0, 10));
        }
        for (const figure of stated) {
          assert.ok(recorded.has(figure.value), `"${figure.raw}" in ${where} is not recorded in ${cited.join(', ')}`);
          checked += 1;
        }
        for (const match of section.text.replace(URL_PATTERN, ' ').matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)) {
          assert.ok(dates.has(match[0]), `the date ${match[0]} in ${where} is not the date of ${cited.join(', ')}`);
        }
      }
    }
    assert.ok(
      checked >= 2 * LAUNCH_PIECES.length,
      `sanity: expected the savings figures of every piece, checked ${checked}`,
    );
  });

  test('the figure checker finds every kind of figure and skips versions, file names and links', () => {
    assert.deepEqual(
      figures('Saves 84.2% on 100 requests, $0.5 less, p50 2 ms (https://example.com/99%)').map((f) => f.value),
      [84.2, 2, 0.5, 100],
    );
    assert.deepEqual(figures('Node.js 24, Apache-2.0, docs/images/overview-1440-dark.png, 12:01 a.m.'), []);
    assert.deepEqual(percentages('84.2% then 0.07%'), [84.2, 0.07]);
  });

  test('every savings figure comes from the newest savings results', () => {
    const newest = newestResults('savings');
    assert.ok(newest);
    for (const page of marketingPages()) {
      for (const file of read(page).match(RESULTS_FILE) ?? []) {
        if (file.includes('/savings-')) assert.equal(file, newest, `${page} cites ${file}; the newest is ${newest}`);
      }
    }
  });

  test('every docs/images reference exists', () => {
    let checked = 0;
    for (const page of marketingPages()) {
      for (const image of read(page).match(IMAGE_REFERENCE) ?? []) {
        assert.ok(existsSync(path.join(root, image)), `${page} names ${image}, which does not exist`);
        checked += 1;
      }
    }
    assert.ok(checked >= 3, `sanity: the posts and the gallery name screenshots, found ${checked}`);
    assert.deepEqual('see docs/images/no-such.png'.match(IMAGE_REFERENCE), ['docs/images/no-such.png']);
  });

  test('every repository link and relative link resolves to an existing file and heading', async () => {
    const isPublic = privateTree ? await publicEditionFilter() : null;
    const repoLink = new RegExp(`^${REPO_URL.replace(/\./g, '\\.')}(?:/(?:blob|tree)/main/([^#?]+))?(?:#(.+))?$`);
    let checked = 0;
    for (const page of marketingPages()) {
      const markdown = read(page);
      const targets: { file: string; fragment: string | null }[] = [];
      for (const url of markdown.match(URL_PATTERN) ?? []) {
        if (!url.startsWith(REPO_URL)) continue;
        const match = repoLink.exec(url);
        assert.ok(match, `${page} links to ${url}, which is not a file of the default branch`);
        targets.push({ file: match[1] ?? 'README.md', fragment: match[2] ?? null });
      }
      for (const target of linkTargets(markdown)) {
        if (!isExternal(target)) targets.push(resolveLink(page, target));
      }
      for (const { file, fragment } of targets) {
        assert.ok(existsSync(path.join(root, file)), `${page} links to ${file}, which does not exist`);
        if (fragment !== null && file.endsWith('.md')) {
          assert.ok(
            anchorsOf(read(file)).has(fragment),
            `${page} links to ${file}#${fragment}, which has no such heading`,
          );
        }
        if (isPublic) {
          assert.ok(
            filesUnder(file).some(isPublic),
            `${page} links to ${file}, which the public edition does not ship`,
          );
        }
        checked += 1;
      }
    }
    assert.ok(checked >= 10, `sanity: expected many repository links, found ${checked}`);
  });

  test('every launch piece leads with the modeled presets-on savings and states the default and the opt-in rules', () => {
    const newest = newestResults('savings');
    assert.ok(newest);
    const results = loadJson(newest) as SavingsResults;
    const presets = results.scenarios.find((s) => s.id === 'presets-on')?.config.equivalence_presets ?? [];
    assert.ok(presets.length > 0, 'the presets-on scenario enables presets');
    const withPresets = savingsPercent(results, 'presets-on', 'cheapest');
    const byDefault = savingsPercent(results, 'realistic-default', 'cheapest');

    const pieces = launchPieces();
    const subreddits = pieces.filter((p) => p.name.startsWith(`${MARKETING_DIR}/reddit.md `));
    assert.ok(subreddits.length >= 2, `reddit.md targets at least two subreddits, found ${subreddits.length}`);
    for (const { name, text } of pieces) {
      const flat = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ');
      assert.equal(percentages(text)[0], withPresets, `${name} leads with the presets-on figure, ${withPresets}%`);
      assert.ok(percentages(text).includes(byDefault), `${name} shows the default figure, ${byDefault}%`);
      assert.match(flat, /modeled/i, `${name} says the savings are modeled`);
      assert.ok(text.includes(newest), `${name} links the raw results, ${newest}`);
      assert.ok(text.includes('docs/benchmarks.md#savings-modeled'), `${name} links the savings method`);
      assert.ok(text.includes('docs/equivalence-presets.md'), `${name} links the equivalence presets`);
      for (const preset of presets) assert.ok(text.includes(preset), `${name} names the ${preset} preset`);
      assert.match(flat, /only switches between providers of the model you asked for/i, `${name} states the default`);
      assert.match(flat, /opt-in/, `${name} says substitution is opt-in`);
      assert.match(flat, /groups you turn on/, `${name} says substitution happens only inside groups you enable`);
      for (const place of [/headers/, /routing trace/, /dashboard/]) {
        assert.match(flat, place, `${name} says where a substitution shows`);
      }
      assert.match(flat, /Substituted models do not give identical answers/, `${name} says answers differ`);
    }
  });

  test('reddit.md gives each subreddit its rules link, a rules summary, a check-the-rules note and a post', () => {
    const markdown = read(`${MARKETING_DIR}/reddit.md`);
    const pieces = launchPieces().filter((p) => p.name.startsWith(`${MARKETING_DIR}/reddit.md `));
    for (const piece of pieces) {
      const subreddit = piece.name.split(' ').pop() ?? '';
      assert.ok(
        piece.text.includes(`https://www.reddit.com/${subreddit}/about/rules/`),
        `${piece.name} links the subreddit's rules`,
      );
      assert.match(piece.text, /^### Self-promotion rules \(summary\)$/m, `${piece.name} summarises the rules`);
      assert.match(piece.text, /Check the current rules/, `${piece.name} asks to check the current rules`);
      assert.match(piece.text, /^Title: .+/m, `${piece.name} has a title`);
      assert.ok(fencedBlocks(piece.text).length >= 2, `${piece.name} has a title and a body to copy`);
    }
    for (const subreddit of ['r/LocalLLaMA', 'r/selfhosted']) {
      assert.ok(markdown.includes(`\n## ${subreddit}\n`), `reddit.md has a post for ${subreddit}`);
    }
  });

  test('x-thread.md is 5 to 8 numbered posts of at most 280 characters each', () => {
    const page = `${MARKETING_DIR}/x-thread.md`;
    const posts = sections(read(page)).filter((s) => /^Post \d+$/.test(s.heading));
    assert.ok(posts.length >= 5 && posts.length <= 8, `the thread has ${posts.length} posts`);
    posts.forEach((post, i) => {
      assert.equal(post.heading, `Post ${i + 1}`, 'the posts are numbered in order');
      const text = blockUnder(page, post.heading);
      assert.ok(xLength(text) <= 280, `${post.heading} is ${xLength(text)} characters as X counts them`);
    });
    assert.equal(xLength(`see ${REPO_URL}/blob/main/docs/benchmarks.md#savings-modeled`), 4 + 23);
  });

  test('show-hn.md has a guideline-shaped title and a first comment', () => {
    const page = `${MARKETING_DIR}/show-hn.md`;
    const title = blockUnder(page, 'Title');
    assert.match(title, /^Show HN: \S/);
    assert.ok(title.length <= 80, `the title is ${title.length} characters, over HN's 80`);
    assert.doesNotMatch(title, /!|\b(?:best|fastest|revolutionary|excited)\b/i, 'no superlatives in the title');
    assert.ok(blockUnder(page, 'First comment').length > 500, 'the first comment explains the project');
    assert.ok(read(page).includes('https://news.ycombinator.com/showhn.html'), 'links the Show HN guidelines');
  });

  test('product-hunt.md has a tagline, description, first comment and a gallery of screenshots', () => {
    const page = `${MARKETING_DIR}/product-hunt.md`;
    const tagline = blockUnder(page, 'Tagline');
    assert.ok(tagline.length > 0 && tagline.length <= 60, `the tagline is ${tagline.length} characters`);
    const description = blockUnder(page, 'Description');
    assert.ok(
      description.length > 0 && description.length <= 260,
      `the description is ${description.length} characters`,
    );
    assert.ok(blockUnder(page, 'First comment').length > 300, 'the first comment explains the project');
    const gallery = sections(read(page)).find((s) => s.heading === 'Gallery');
    assert.ok(gallery, 'the listing has a gallery');
    assert.ok((gallery.text.match(IMAGE_REFERENCE) ?? []).length >= 3, 'the gallery lists at least three images');
  });

  test('no untrue or unverifiable claim', () => {
    const forbidden: [RegExp, string][] = [
      [/tested (?:against|with|on) (?:the )?real/i, 'a claim of testing against the real APIs'],
      [/\b\d[\d,.]*\s*k?\+?\s*(?:users|stars|downloads|customers|companies|teams|installs)\b/i, 'a usage count'],
      [/\u2b50|\u2605|\bstars? on GitHub\b/i, 'a star count'],
      [/\b(?:loved|trusted|used) by\b/i, 'an endorsement'],
      [/^\s*>\s*["\u201c]/m, 'a quoted testimonial'],
      [
        /\bno (?:quality loss|loss (?:of|in) quality)\b|without (?:losing|any loss of) quality|same quality/i,
        'a quality claim',
      ],
    ];
    const sameAnswers = /\b(?:identical|same|equivalent)\s+(?:answers?|responses?|outputs?|results?)\b/i;
    for (const page of marketingPages()) {
      const text = read(page);
      for (const [pattern, what] of forbidden) {
        const match = pattern.exec(text);
        assert.equal(match, null, `${page} makes ${what}: "${match?.[0]}"`);
      }
      for (const sentence of text.split(/(?<=[.!?:])\s+|\n\s*\n/)) {
        if (sameAnswers.test(sentence)) {
          assert.match(sentence, /\bnot\b|n't\b|\bnever\b/, `${page} claims identical answers: "${sentence.trim()}"`);
        }
      }
    }
  });
});

// ---------------------------------------------------------------- marketing/release-checklist.md

const RELEASE_CHECKLIST = `${MARKETING_DIR}/release-checklist.md`;

/** Every command line of the checklist's fenced blocks, with the leading prompt indentation removed. */
function checklistCommands(): string[] {
  return fencedBlocks(read(RELEASE_CHECKLIST))
    .flatMap((block) => block.split(/\r?\n/))
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** The `--flag` names of a command line (values such as URLs are skipped). */
function flagsOf(command: string): string[] {
  return command.split(/\s+/).filter((word) => /^--?[a-z][\w-]*$/.test(word));
}

describe('marketing/release-checklist.md', () => {
  test('walks the release in order, from the export to the announcement', () => {
    assert.ok(existsSync(path.join(root, RELEASE_CHECKLIST)), `${RELEASE_CHECKLIST} is missing`);
    const headings = sections(read(RELEASE_CHECKLIST))
      .filter((s) => s.level === 2)
      .map((s) => s.heading);
    const steps = [
      /export/i,
      /create the public repository by hand/i,
      /push/i,
      /private vulnerability reporting/i,
      /CI/,
      /tag v0\.1\.0.*release/i,
      /npm publish/i,
      /announce/i,
    ];
    let from = 0;
    for (const step of steps) {
      const at = headings.findIndex((heading, i) => i >= from && step.test(heading));
      assert.ok(at !== -1, `no step matching ${step} after "${headings[from - 1] ?? 'the start'}"`);
      from = at + 1;
    }
    headings.forEach((heading, i) => {
      assert.ok(heading.startsWith(`${i + 1}. `), `"${heading}" is step ${i + 1}`);
    });

    const flat = read(RELEASE_CHECKLIST).replace(/\s+/g, ' ');
    assert.match(flat, /The maintainer does every step by hand/, 'says who runs it, in neutral wording');
    assert.doesNotMatch(flat, /\bSponsor\b|\bI\b|\bwe\b/, 'neutral wording: no named or first-person owner');
    assert.match(flat, /--repo-url/, 'says how to export under a renamed repository');
    assert.match(flat, /remove `"private": true`/, 'says to remove "private": true before an npm publish');
    assert.match(flat, /`CHANGELOG\.md`/, 'writes the release from the changelog');
    assert.ok(flat.includes('[`launch-day-checklist.md`](launch-day-checklist.md)'), 'posts in launch-day order');
  });

  test('the release it tags is the version in package.json and CHANGELOG.md', () => {
    const version = (loadJson('package.json') as { version: string }).version;
    assert.ok(read(RELEASE_CHECKLIST).includes(`git tag -a v${version} `), `tags v${version}`);
    const heading = `## [${version}]`;
    assert.ok(
      read('CHANGELOG.md')
        .split(/\r?\n/)
        .some((line) => line.startsWith(heading)),
      `CHANGELOG.md has ${heading}`,
    );
  });

  test('every npm script it names exists in package.json', () => {
    const scripts = (loadJson('package.json') as { scripts: Record<string, string> }).scripts;
    const text = read(RELEASE_CHECKLIST);
    const named = [
      ...[...text.matchAll(/\bnpm run ([A-Za-z0-9:._-]+)/g)].map((m) => m[1] ?? ''),
      ...[...text.matchAll(/\bnode --run ([A-Za-z0-9:._-]+)/g)].map((m) => m[1] ?? ''),
      ...[...text.matchAll(/\bnpm (start|test)\b/g)].map((m) => m[1] ?? ''),
    ];
    assert.ok(named.includes('check'), 'sanity: the checklist runs npm run check');
    for (const name of named) {
      assert.ok(name in scripts, `${RELEASE_CHECKLIST} runs "npm run ${name}", which package.json does not define`);
    }
  });

  test('every node script it runs exists and accepts the flags it passes', () => {
    const commands = checklistCommands().filter((line) => /^node scripts\//.test(line));
    const scriptsRun = new Set(commands.map((line) => line.split(/\s+/)[1] ?? ''));
    assert.ok(scriptsRun.has('scripts/export-public.mjs'), 'sanity: the checklist runs the export');
    assert.ok(scriptsRun.has('scripts/guard-keys.mjs'), 'sanity: the checklist runs the key scan');
    // The export writes .public-export/ and the key scan runs there, so its path is the exported one.
    const exportOnly = new Set(['scripts/export-public.mjs']);
    for (const script of scriptsRun) {
      if (exportOnly.has(script) && !privateTree) continue; // the public edition does not ship the export
      assert.ok(existsSync(path.join(root, script)), `${RELEASE_CHECKLIST} runs ${script}, which does not exist`);
    }
    if (privateTree) {
      const exportHelp = execFileSync(process.execPath, [exportScript, '--help'], { encoding: 'utf8' });
      const accepted = new Set(exportHelp.match(/(?<![\w-])--?[a-z][\w-]*/g) ?? []);
      assert.ok(accepted.has('--repo-url') && accepted.has('--verify'), 'sanity: the export help lists its flags');
      for (const line of commands.filter((l) => l.startsWith('node scripts/export-public.mjs'))) {
        for (const flag of flagsOf(line)) {
          assert.ok(accepted.has(flag), `"${line}" passes ${flag}, which the export's --help does not list`);
        }
      }
    }
    for (const line of commands.filter((l) => !l.startsWith('node scripts/export-public.mjs'))) {
      const source = read(line.split(/\s+/)[1] ?? '');
      for (const flag of flagsOf(line)) {
        assert.ok(source.includes(`'${flag}'`), `"${line}" passes ${flag}, which the script does not read`);
      }
    }
  });

  test('no command in it force-pushes or publishes a package', () => {
    for (const line of checklistCommands()) {
      assert.doesNotMatch(line, /\bnpm publish\b|--force\b|\s-f\b|--no-verify\b/, `"${line}" must not be run`);
    }
    assert.deepEqual(flagsOf('node scripts/export-public.mjs --repo-url https://github.com/owner/repo'), [
      '--repo-url',
    ]);
  });
});
