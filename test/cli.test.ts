import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.join(here, '..', 'src', 'cli.ts');
const packageJsonPath = path.join(here, '..', 'package.json');

function runCli(args: readonly string[]) {
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' });
}

test('--version prints the package version and exits 0', () => {
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version: string };
  const result = runCli(['--version']);

  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), pkg.version);
});

test('--help prints usage and exits 0', () => {
  const result = runCli(['--help']);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: tollwise/);
  assert.match(result.stdout, /--version/);
});

test('an unknown command exits 1 with a clear message', () => {
  const result = runCli(['frobnicate']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown command "frobnicate"/);
});
