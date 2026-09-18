// scripts/guard-keys.mjs, run as a real child process in temp git repositories (never the real one):
// --all scans the working tree (tracked files as they are on disk plus untracked, non-ignored files),
// staged mode scans the index, binary skips are listed, a text file holding a NUL fails, and --all
// outside a repository fails instead of reporting an empty scan.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FAKE_KEYS } from './fixtures/fake-keys.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const GUARD = path.join(here, '..', 'scripts', 'guard-keys.mjs');

const workRoot = mkdtempSync(path.join(os.tmpdir(), 'tollwise-guard-keys-test-'));
after(() => rmSync(workRoot, { recursive: true, force: true }));

// Git (in the tests and in the script) sees an empty global config, no system config and no user-level
// ignore file, so neither the identity nor the ignore rules of the machine running the tests apply.
const isolation = path.join(workRoot, 'isolation');
mkdirSync(isolation);
const EMPTY_GLOBAL = path.join(isolation, 'empty.gitconfig');
writeFileSync(EMPTY_GLOBAL, '');
const ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: EMPTY_GLOBAL,
  GIT_CONFIG_NOSYSTEM: '1',
  XDG_CONFIG_HOME: isolation,
  // Git never looks above the work root, so the "outside a repository" case holds wherever the temp dir is.
  GIT_CEILING_DIRECTORIES: workRoot,
};

/** A key-shaped line with no allow marker: the guard must report it. */
const LEAK = `const upstream = '${FAKE_KEYS['Groq API key']?.text}';\n`;
/** The same value on a line that ends with the allow marker: a deliberate fixture. */
const ALLOWED = `const upstream = '${FAKE_KEYS['Groq API key']?.text}'; // tollwise-allow-secret\n`;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48]);

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

function put(dir: string, rel: string, content: string | Buffer): void {
  const file = path.join(dir, ...rel.split('/'));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

let caseCounter = 0;
/** A fresh git repository holding `files`, all committed. */
function repo(files: Record<string, string | Buffer> = { 'README.md': '# Fixture\n' }): string {
  caseCounter += 1;
  const dir = path.join(workRoot, `case-${caseCounter}`);
  mkdirSync(dir);
  for (const [rel, content] of Object.entries(files)) put(dir, rel, content);
  git(dir, 'init', '--quiet');
  git(dir, 'add', '-A');
  git(dir, 'commit', '--quiet', '-m', 'Fixture');
  return dir;
}

function guard(cwd: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [GUARD, ...args], { cwd, env: ENV, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('scripts/guard-keys.mjs --all (working tree)', () => {
  test('reports an uncommitted key in a tracked file, which a scan of HEAD would miss', () => {
    const dir = repo({ 'src/config.ts': 'export const port = 8080;\n' });
    put(dir, 'src/config.ts', `export const port = 8080;\n${LEAK}`);

    const r = guard(dir, '--all');

    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, /src\/config\.ts:2: looks like a Groq API key/);
    assert.ok(!r.stderr.includes(FAKE_KEYS['Groq API key']?.text ?? '-'), 'the key value itself is never printed');
  });

  test('reports a key in an untracked file that is not ignored', () => {
    const dir = repo();
    put(dir, 'notes/scratch.md', `# Notes\n\n${LEAK}`);

    const r = guard(dir, '--all');

    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, /notes\/scratch\.md:3: looks like a Groq API key/);
  });

  test('reports an untracked, non-ignored file with a forbidden name', () => {
    const dir = repo();
    put(dir, 'deploy/server.pem', 'placeholder\n');

    const r = guard(dir, '--all');

    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, /deploy\/server\.pem: file type\/name that must never be committed/);
  });

  test('does not scan git-ignored files', () => {
    const dir = repo({ '.gitignore': 'local/\n*.local.yaml\n', 'README.md': '# Fixture\n' });
    put(dir, 'local/keys.ts', LEAK);
    put(dir, 'providers.local.yaml', LEAK);

    const r = guard(dir, '--all');

    assert.equal(r.status, 0, r.stderr);
    assert.match(
      r.stdout,
      /guard-keys: 2 working-tree file\(s\) scanned, 0 binary file\(s\) skipped, no secrets found\./,
    );
    assert.doesNotMatch(r.stdout + r.stderr, /local/);
  });

  test('lists every file skipped as binary by path, with a count', () => {
    const dir = repo({ 'README.md': '# Fixture\n', 'docs/images/overview.png': PNG });
    put(dir, 'docs/images/new-shot.png', PNG); // untracked, not ignored

    const r = guard(dir, '--all');

    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /guard-keys: 2 binary file\(s\) skipped \(NUL byte, not scanned\):/);
    assert.match(r.stdout, /^ {2}docs\/images\/new-shot\.png$/m);
    assert.match(r.stdout, /^ {2}docs\/images\/overview\.png$/m);
    assert.match(r.stdout, /1 working-tree file\(s\) scanned, 2 binary file\(s\) skipped, no secrets found/);
  });

  test('fails on a file with a text extension that holds a NUL byte, even with a key hidden after it', () => {
    const dir = repo({ 'scripts/tool.mjs': 'export const ok = true;\n' });
    put(dir, 'scripts/tool.mjs', Buffer.concat([Buffer.from('const bad = /[\0-\x1f]/;\n'), Buffer.from(LEAK)]));

    const r = guard(dir, '--all');

    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, /scripts\/tool\.mjs: holds a NUL byte, so it cannot be scanned as text/);
    assert.match(r.stderr, /escapes \(e\.g\. \\u0000\)/);
    assert.doesNotMatch(r.stdout, /tool\.mjs/, 'it is not listed as a skipped binary');
  });

  test('respects the allow marker', () => {
    const dir = repo({ 'test/fixture.ts': ALLOWED });
    put(dir, 'test/untracked-fixture.ts', ALLOWED);

    const r = guard(dir, '--all');

    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /2 working-tree file\(s\) scanned/);
  });

  test('lists a tracked file deleted from the working tree instead of counting it as scanned', () => {
    const dir = repo({ 'README.md': '# Fixture\n', 'old.ts': 'export {};\n' });
    rmSync(path.join(dir, 'old.ts'));

    const r = guard(dir, '--all');

    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /1 path\(s\) with no file content to scan:\n {2}old\.ts \(deleted in the working tree\)/);
    assert.match(r.stdout, /1 working-tree file\(s\) scanned/);
  });

  test('scans the whole repository when run from a subfolder', () => {
    const dir = repo({ 'README.md': '# Fixture\n', 'src/index.ts': 'export {};\n' });
    put(dir, 'docs/leak.md', LEAK);

    const r = guard(path.join(dir, 'src'), '--all');

    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, /docs\/leak\.md:1: looks like a Groq API key/);
  });

  test('exits non-zero with a clear message outside a git repository', () => {
    const dir = path.join(workRoot, 'not-a-repository');
    put(dir, 'leak.ts', LEAK);

    for (const args of [['--all'], []]) {
      const r = guard(dir, ...args);
      assert.notEqual(r.status, 0, `must fail with ${args.join(' ') || 'no flag'}`);
      assert.match(r.stderr, /is not inside a git working tree, so there is nothing it can scan/);
      assert.doesNotMatch(r.stdout, /file\(s\) scanned/);
    }
  });
});

describe('scripts/guard-keys.mjs (staged, pre-commit)', () => {
  test('scans the index, not the working tree', () => {
    const dir = repo();
    // Staged with a key, then cleaned on disk only: the commit would still carry the key.
    put(dir, 'src/staged.ts', LEAK);
    git(dir, 'add', 'src/staged.ts');
    put(dir, 'src/staged.ts', 'export {};\n');

    const staged = guard(dir);
    assert.equal(staged.status, 1, staged.stdout);
    assert.match(staged.stderr, /Commit blocked/);
    assert.match(staged.stderr, /src\/staged\.ts:1: looks like a Groq API key/);

    // The reverse: a clean index and a key on disk only, which this commit would not carry.
    git(dir, 'add', 'src/staged.ts');
    put(dir, 'src/staged.ts', LEAK);
    const clean = guard(dir);
    assert.equal(clean.status, 0, clean.stderr);
    assert.match(clean.stdout, /1 staged file\(s\) scanned, 0 binary file\(s\) skipped, no secrets found/);
  });

  test('fails on a staged text file with a NUL byte and lists staged binaries', () => {
    const dir = repo();
    put(dir, 'src/broken.ts', Buffer.from('export const x = "\0";\n'));
    put(dir, 'docs/shot.png', PNG);
    git(dir, 'add', 'src/broken.ts', 'docs/shot.png');

    const r = guard(dir);

    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, /src\/broken\.ts: holds a NUL byte/);
    assert.match(r.stdout, /1 binary file\(s\) skipped \(NUL byte, not scanned\):\n {2}docs\/shot\.png/);
  });
});

test('no file under scripts/ or src/ holds a NUL byte (a guard would have to skip it as binary)', () => {
  const root = path.join(here, '..');
  const offenders: string[] = [];
  for (const top of ['scripts', 'src']) {
    for (const entry of readdirSync(path.join(root, top), { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const file = path.join(entry.parentPath, entry.name);
      if (readFileSync(file).includes(0)) offenders.push(path.relative(root, file));
    }
  }
  assert.deepEqual(offenders, []);
});
