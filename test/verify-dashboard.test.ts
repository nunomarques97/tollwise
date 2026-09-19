// scripts/verify-dashboard.ts: preparing the --out directory must never destroy anything the script
// did not write itself, and the demo output carried in an error message is bounded.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { prepareOutputDir, screenshotNames, tailForError } from '../scripts/verify-dashboard.ts';

const workDir = mkdtempSync(path.join(tmpdir(), 'tollwise-verify-dashboard-'));
after(() => {
  rmSync(workDir, { recursive: true, force: true });
});

test('screenshotNames lists the 16 view x width x theme files and the 4 substitution drawer files, and nothing else', () => {
  const names = screenshotNames();
  assert.equal(names.length, 20);
  assert.equal(new Set(names).size, 20);
  assert.ok(names.includes('overview-1440-dark.png'));
  assert.ok(names.includes('providers-390-light.png'));
  assert.ok(names.includes('drawer-substitution-390-dark.png'));
  for (const name of names) {
    assert.match(name, /^(overview|routing|savings|providers|drawer-substitution)-(1440|390)-(dark|light)\.png$/);
  }
});

test('prepareOutputDir leaves unrelated files and folders in an existing --out directory untouched', () => {
  const out = path.join(workDir, 'existing');
  mkdirSync(path.join(out, 'nested', 'deeper'), { recursive: true });
  writeFileSync(path.join(out, 'notes.md'), 'keep me\n');
  writeFileSync(path.join(out, 'reference.png'), 'not a screenshot of this script\n');
  writeFileSync(path.join(out, 'overview-1440-dark.png.bak'), 'similar name, still not ours\n');
  writeFileSync(path.join(out, 'nested', 'deeper', 'overview-1440-dark.png'), 'same name, other folder\n');
  mkdirSync(path.join(out, 'routing-390-light.png'));
  writeFileSync(path.join(out, 'routing-390-light.png', 'inside.txt'), 'a folder with a screenshot name\n');
  // Two stale screenshots from an earlier run: the only things it may remove.
  writeFileSync(path.join(out, 'overview-1440-dark.png'), 'stale\n');
  writeFileSync(path.join(out, 'savings-390-light.png'), 'stale\n');

  const removed = prepareOutputDir(out);

  assert.deepEqual(removed.sort(), ['overview-1440-dark.png', 'savings-390-light.png']);
  assert.equal(readFileSync(path.join(out, 'notes.md'), 'utf8'), 'keep me\n');
  assert.equal(readFileSync(path.join(out, 'reference.png'), 'utf8'), 'not a screenshot of this script\n');
  assert.equal(readFileSync(path.join(out, 'overview-1440-dark.png.bak'), 'utf8'), 'similar name, still not ours\n');
  assert.equal(
    readFileSync(path.join(out, 'nested', 'deeper', 'overview-1440-dark.png'), 'utf8'),
    'same name, other folder\n',
  );
  assert.equal(
    readFileSync(path.join(out, 'routing-390-light.png', 'inside.txt'), 'utf8'),
    'a folder with a screenshot name\n',
  );
  assert.equal(existsSync(path.join(out, 'overview-1440-dark.png')), false);
  assert.equal(existsSync(path.join(out, 'savings-390-light.png')), false);
  assert.deepEqual(readdirSync(out).sort(), [
    'nested',
    'notes.md',
    'overview-1440-dark.png.bak',
    'reference.png',
    'routing-390-light.png',
  ]);
});

test('prepareOutputDir creates a missing --out directory, parents included', () => {
  const out = path.join(workDir, 'missing', 'a', 'b');
  assert.deepEqual(prepareOutputDir(out), []);
  assert.deepEqual(readdirSync(out), []);
});

test('prepareOutputDir refuses an --out path that is a file, and leaves the file as it was', () => {
  const file = path.join(workDir, 'a-file.txt');
  writeFileSync(file, 'content\n');
  assert.throws(() => prepareOutputDir(file), /--out must be a directory/);
  assert.equal(readFileSync(file, 'utf8'), 'content\n');
});

test('tailForError keeps short output as is and cuts long output to its last characters', () => {
  assert.equal(tailForError('short output', 100), 'short output');
  const long = `${'a'.repeat(5_000)}THE-END`;
  const cut = tailForError(long, 10);
  assert.equal(cut, '[... 4997 earlier character(s) omitted]\naaaTHE-END');
  assert.ok(tailForError(long).length < 2_100);
});
