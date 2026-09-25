// Checks that every JSON value shown as command output in README.md and the user docs pages is valid
// JSON, as the real output is. A transcript line that was shortened or edited by hand (for example a
// Windows path whose backslashes lost their JSON escaping) would otherwise read as real output while
// being something Tollwise can never print.
//
// A line counts as JSON output when it sits inside a fenced code block and, after an optional SSE
// `data: ` prefix, starts with `{` or `[` and ends with `}` or `]`.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** README.md plus every docs/*.md page. */
function pages(): string[] {
  const docs = readdirSync(path.join(root, 'docs'))
    .filter((name) => name.endsWith('.md'))
    .map((name) => `docs/${name}`);
  return ['README.md', ...docs];
}

/** `{ line, text }` for every JSON-looking line inside a fenced code block of `markdown`. */
function jsonOutputLines(markdown: string): { line: number; text: string }[] {
  const found: { line: number; text: string }[] = [];
  let inBlock = false;
  markdown.split(/\r?\n/).forEach((raw, index) => {
    if (/^\s*```/.test(raw)) {
      inBlock = !inBlock;
      return;
    }
    if (!inBlock) return;
    const text = raw.trim().replace(/^data: /, '');
    if (/^[{[].*[}\]]$/.test(text)) found.push({ line: index + 1, text });
  });
  return found;
}

test('jsonOutputLines finds JSON lines in code blocks only, SSE data lines included', () => {
  const sample = ['{"outside":true}', '```', '{"a":1}', 'data: {"b":2}', '$ curl -s x', '```', '[1]'].join('\n');
  assert.deepEqual(jsonOutputLines(sample), [
    { line: 3, text: '{"a":1}' },
    { line: 4, text: '{"b":2}' },
  ]);
});

test('every JSON line shown as output in README.md and docs/*.md parses as JSON', () => {
  const problems: string[] = [];
  let checked = 0;
  for (const page of pages()) {
    for (const { line, text } of jsonOutputLines(readFileSync(path.join(root, page), 'utf8'))) {
      checked += 1;
      try {
        JSON.parse(text);
      } catch (error) {
        problems.push(`${page}:${line}: ${(error as Error).message}`);
      }
    }
  }
  assert.ok(checked > 0, 'sanity: the README shows JSON output');
  assert.deepEqual(problems, []);
});
