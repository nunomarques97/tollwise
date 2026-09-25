// Checks the "Savings (modeled)" section of docs/benchmarks.md against the results file it cites:
// the file is the newest benchmarks/results/savings-*.json, the table equals every run of every
// scenario, the substitution counts equal the ones read from the x-tollwise-* headers, and every other
// number in the section is a value recorded in that file. The section also has to say plainly that the
// figures are modeled and that substitution is opt-in, and link the results file and the presets page.

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { newestResultsName } from '../benchmarks/savings.ts';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

interface SubstitutionCount {
  served_provider: string;
  served_model: string;
  equivalence_group: string;
  requests: number;
}

interface Run {
  policy: string;
  total_cost_usd: string;
  total_baseline_usd: string;
  total_savings_usd: string;
  savings_percent: number | null;
  substituted_requests: number;
  substitutions: SubstitutionCount[];
}

interface ScenarioRecord {
  id: string;
  label: string;
  workload: string;
  config: { equivalence_presets: string[] };
  runs: Run[];
}

interface SavingsRecord {
  date: string;
  label: string;
  catalog: { verified_on: string[] };
  scenarios: ScenarioRecord[];
}

/** The "## Savings (modeled)" section of `markdown`, up to the next level-2 heading. */
function savingsSection(markdown: string): string {
  const start = markdown.indexOf('\n## Savings (modeled)\n');
  assert.notEqual(start, -1, 'docs/benchmarks.md has no "## Savings (modeled)" section');
  const rest = markdown.slice(start + 1);
  const next = rest.indexOf('\n## ', 1);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

/** The section's prose: no fenced block, inline code span, link target or ordered-list marker. */
function prose(section: string): string {
  return section
    .replace(/^```[\s\S]*?^```/gm, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/\]\([^)\s]*\)/g, '] ')
    .replace(/^\s*\d+\.\s/gm, ' ');
}

/** Every decimal number written in `text`, as numbers (signs and units dropped). */
function numbersIn(text: string): number[] {
  return (text.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
}

/** Every number `value` records: numeric fields, numbers written inside strings, and array lengths. */
function recordedNumbers(value: unknown, into = new Set<number>()): Set<number> {
  if (typeof value === 'number') into.add(Math.abs(value));
  else if (typeof value === 'string') for (const found of numbersIn(value)) into.add(found);
  else if (Array.isArray(value)) {
    into.add(value.length);
    for (const item of value) recordedNumbers(item, into);
  } else if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) recordedNumbers(item, into);
  }
  return into;
}

/** Numbers of `section`'s prose that `record` does not hold. */
function unrecordedNumbers(section: string, record: unknown): number[] {
  const recorded = recordedNumbers(record);
  return numbersIn(prose(section)).filter((found) => !recorded.has(found));
}

/** "$0.000240" or "-$0.000400", as the table writes a formatUsd() amount. */
function usd(amount: string): string {
  return amount.startsWith('-') ? `-$${amount.slice(1)}` : `$${amount}`;
}

/** The cells of every body row of the first table in `section` that has a "Scenario" header. */
function tableRows(section: string): string[][] {
  const lines = section.split('\n');
  const header = lines.findIndex((line) => line.startsWith('| Scenario |'));
  assert.notEqual(header, -1, 'the savings section has no results table');
  const rows: string[][] = [];
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith('|')) break;
    rows.push(
      line
        .slice(1, -1)
        .split('|')
        .map((cell) => cell.trim()),
    );
  }
  return rows;
}

/** Substitution bullets: "- `policy`, N in all: X served by `model` on `provider` (group `g`); ...". */
function substitutionBullets(section: string): Map<string, { total: number; counts: SubstitutionCount[] }> {
  const bullets = new Map<string, { total: number; counts: SubstitutionCount[] }>();
  for (const line of section.split('\n')) {
    const head = /^- `([a-z]+)`, (\d+) in all: (.*)$/.exec(line);
    if (head === null || head[1] === undefined || head[2] === undefined || head[3] === undefined) continue;
    const counts = [...head[3].matchAll(/(\d+) (?:served )?by `([^`]+)` on `([^`]+)` \(group `([^`]+)`\)/g)].map(
      (match) => ({
        served_provider: match[3] ?? '',
        served_model: match[2] ?? '',
        equivalence_group: match[4] ?? '',
        requests: Number(match[1]),
      }),
    );
    bullets.set(head[1], { total: Number(head[2]), counts });
  }
  return bullets;
}

function sortCounts(counts: readonly SubstitutionCount[]): SubstitutionCount[] {
  const key = (count: SubstitutionCount): string =>
    `${count.served_provider}\u0000${count.served_model}\u0000${count.equivalence_group}`;
  return [...counts].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

const markdown = readFileSync(path.join(root, 'docs', 'benchmarks.md'), 'utf8');
const section = savingsSection(markdown);
const cited = /\]\(\.\.\/(benchmarks\/results\/savings-[0-9-]+\.json)\)/.exec(
  section.slice(section.indexOf('### Results')),
)?.[1];
const record: SavingsRecord | null =
  cited !== undefined && existsSync(path.join(root, cited))
    ? (JSON.parse(readFileSync(path.join(root, cited), 'utf8')) as SavingsRecord)
    : null;

describe('docs/benchmarks.md "Savings (modeled)"', () => {
  test('cites the newest savings results file, which exists and is labelled modeled', () => {
    assert.ok(cited, 'the Results subsection links no benchmarks/results/savings-*.json');
    assert.ok(record, `${cited} does not exist`);
    const newest = newestResultsName(readdirSync(path.join(root, 'benchmarks', 'results')));
    assert.equal(cited, `benchmarks/results/${newest}`, 'the section must cite the newest results file');
    assert.equal(record.label, 'modeled');
    for (const scenario of record.scenarios) assert.equal(scenario.label, 'modeled', scenario.id);
    assert.deepEqual(
      record.scenarios.map((scenario) => scenario.id),
      ['default', 'realistic-default', 'presets-on'],
    );
  });

  test('states the run date and the catalog verified_on dates of the results file', () => {
    assert.ok(record);
    assert.match(
      section,
      new RegExp(
        `Run on ${record.date.slice(0, 10)} with catalog prices verified on ${record.catalog.verified_on.join(', ')}\\.`,
      ),
    );
  });

  test('the table equals every run of every scenario, in order', () => {
    assert.ok(record);
    const expected = record.scenarios.flatMap((scenario) =>
      scenario.runs.map((run) => [
        scenario.id,
        scenario.workload,
        run.policy,
        usd(run.total_cost_usd),
        usd(run.total_baseline_usd),
        usd(run.total_savings_usd),
        run.savings_percent === null ? 'n/a' : `${run.savings_percent}%`,
        String(run.substituted_requests),
      ]),
    );
    assert.deepEqual(tableRows(section), expected);
  });

  test('the substitution counts equal the ones the results file read from the x-tollwise-* headers', () => {
    assert.ok(record);
    const bullets = substitutionBullets(section);
    const presetsOn = record.scenarios.find((scenario) => scenario.id === 'presets-on');
    assert.ok(presetsOn);
    for (const run of presetsOn.runs) {
      const bullet = bullets.get(run.policy);
      assert.ok(bullet, `no substitution bullet for ${run.policy}`);
      assert.equal(bullet.total, run.substituted_requests, run.policy);
      assert.deepEqual(sortCounts(bullet.counts), sortCounts(run.substitutions), run.policy);
    }
    assert.equal(bullets.size, presetsOn.runs.length, 'a substitution bullet names a policy with no run');
    for (const scenario of record.scenarios.filter((entry) => entry.id !== 'presets-on')) {
      for (const run of scenario.runs) assert.equal(run.substituted_requests, 0, `${scenario.id} ${run.policy}`);
    }
  });

  test('every number in the section is a value recorded in the results file', () => {
    assert.ok(record);
    assert.deepEqual(unrecordedNumbers(section, record), []);
  });

  test('the number check catches a figure the results file does not hold', () => {
    assert.ok(record);
    assert.deepEqual(unrecordedNumbers('## Savings (modeled)\n\nsaves 84.3% on 101 requests\n', record), [84.3, 101]);
  });

  test('says plainly that the figures are modeled and that substitution is opt-in', () => {
    const text = section.replace(/\s+/g, ' ');
    assert.match(text, /\*\*These numbers are modeled, not measured\.\*\*/);
    assert.match(text, /public list prices/);
    assert.match(text, /never from a real provider bill/);
    assert.match(text, /\*\*By default Tollwise only switches providers\.\*\*/);
    assert.match(text, /\*\*opt-in\*\*/);
    assert.match(text, /\]\(equivalence-presets\.md\)/);
    assert.ok(existsSync(path.join(root, 'docs', 'equivalence-presets.md')));
  });
});
