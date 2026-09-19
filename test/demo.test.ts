// npm run demo (scripts/demo.ts) as a real child process: a bounded run records the expected number of
// analytics rows and exits 0; Ctrl+C (SIGINT) during an unbounded run shuts the mocks and Tollwise down
// cleanly. Every run here uses an ephemeral port (--port 0) and a temp analytics file (--analytics-path),
// so this test never touches data/demo.db or a fixed port.

import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const demoPath = path.join(here, '..', 'scripts', 'demo.ts');
const bridgePath = path.join(here, 'fixtures', 'demo-signal-bridge.ts');
const isWindows = process.platform === 'win32';

const workDir = mkdtempSync(path.join(tmpdir(), 'tollwise-demo-'));
const children = new Set<ChildProcess>();
after(() => {
  for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
  rmSync(workDir, { recursive: true, force: true });
});

/** Only what Node needs to run: no inherited provider keys or TOLLWISE_* settings. */
function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

function countRows(file: string): number {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM request_events').get() as { n: number } | undefined;
    return row?.n ?? 0;
  } finally {
    db.close();
  }
}

interface Exit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

function waitForExit(child: ChildProcess): Promise<Exit> {
  return new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

test('npm run demo -- --count 20 exits 0 and records 20 rows in the analytics store', async () => {
  const dbFile = path.join(workDir, 'count-20.db');
  const child = spawn(
    process.execPath,
    [demoPath, '--count', '20', '--seed', 'demo-test-seed', '--port', '0', '--analytics-path', dbFile, '--quiet'],
    { cwd: workDir, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  children.add(child);

  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const exit = await waitForExit(child);
  assert.equal(exit.code, 0, `expected exit 0; stdout:\n${stdout}\nstderr:\n${stderr}`);
  assert.equal(exit.signal, null);
  assert.equal(countRows(dbFile), 20, 'expected exactly one analytics row per sent request');
});

/** Runs the demo to completion (not --quiet) and resolves with its stdout; rejects on a non-zero exit. */
function runDemo(seed: string, count: number, dbFile: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [demoPath, '--count', String(count), '--seed', seed, '--port', '0', '--analytics-path', dbFile],
      { cwd: workDir, env: childEnv(), stdio: ['ignore', 'pipe', 'ignore'] },
    );
    children.add(child);
    let stdout = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.once('exit', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`exited with ${code}; stdout:\n${stdout}`));
    });
  });
}

interface RequestLine {
  readonly scenario: string;
  readonly status: string;
  readonly provider: string;
  readonly attempts: number;
  /** The whole line after the request number, so two runs can be compared field by field. */
  readonly text: string;
}

/** Parses the demo's per-request lines: "[  1] <scenario> -> <status> provider=... attempts=N ...". */
function requestLines(stdout: string): RequestLine[] {
  return stdout
    .split(/\r?\n/)
    .filter((line) => /^\[\s*\d+]/.test(line))
    .map((line) => {
      const text = line.replace(/^\[\s*\d+]\s*/, '');
      const match = /^(\S+)\s+-> (\d+) provider=(\S+) .*attempts=(\d+)/.exec(text);
      assert.ok(match, `unexpected request line: ${line}`);
      return {
        scenario: match[1] as string,
        status: match[2] as string,
        provider: match[3] as string,
        attempts: Number(match[4]),
        text,
      };
    });
}

test('two runs with the same --seed send the same requests with the same routing outcome', async () => {
  const [first, second] = await Promise.all([
    runDemo('repeatable', 12, path.join(workDir, 'repeat-a.db')),
    runDemo('repeatable', 12, path.join(workDir, 'repeat-b.db')),
  ]);
  const firstLines = requestLines(first).map((line) => line.text);
  const secondLines = requestLines(second).map((line) => line.text);
  assert.equal(firstLines.length, 12);
  // Scenario, status, serving provider and model, routed flag, attempts and savings all match.
  assert.deepEqual(secondLines, firstLines);
});

for (const seed of ['1', 'fallback-check']) {
  test(`every "-fallback" scenario really falls back to another provider (seed ${seed})`, async () => {
    const dbFile = path.join(workDir, `fallback-${seed}.db`);
    // The ten scenarios are a shuffled cycle, so 20 requests send each fallback scenario twice.
    const lines = requestLines(await runDemo(seed, 20, dbFile));
    assert.equal(lines.length, 20);

    const fallbackLines = lines.filter((line) => line.scenario.endsWith('-fallback'));
    assert.equal(fallbackLines.length, 6, 'expected three fallback scenarios, each sent twice');
    for (const line of fallbackLines) {
      assert.equal(line.status, '200', line.text);
      assert.equal(line.attempts, 2, `expected a failed first attempt and a fallback: ${line.text}`);
      assert.equal(line.provider, 'openrouter', line.text);
    }
    for (const line of lines.filter((entry) => !entry.scenario.endsWith('-fallback'))) {
      assert.equal(line.attempts, 1, `only fallback scenarios should retry: ${line.text}`);
    }

    // The analytics rows record the same thing: every claude-opus-5 request took two attempts.
    const db = new DatabaseSync(dbFile, { readOnly: true });
    try {
      const rows = db
        .prepare("SELECT attempts, used_provider FROM request_events WHERE requested_model = 'claude-opus-5'")
        .all() as { attempts: number; used_provider: string }[];
      assert.equal(rows.length, 6);
      for (const row of rows) assert.deepEqual({ ...row }, { attempts: 2, used_provider: 'openrouter' });
    } finally {
      db.close();
    }
  });
}

test('Ctrl+C (SIGINT) during an unbounded run shuts the mocks and Tollwise down cleanly', async () => {
  const dbFile = path.join(workDir, 'sigint.db');
  const entry = isWindows ? bridgePath : demoPath;
  const child = spawn(
    process.execPath,
    [entry, '--seed', 'sigint', '--port', '0', '--analytics-path', dbFile, '--quiet'],
    {
      cwd: workDir,
      env: childEnv(),
      stdio: isWindows ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
    },
  );
  children.add(child);

  let stdout = '';
  child.stdout?.setEncoding('utf8');
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ready line within 10 s; stdout:\n${stdout}`)), 10_000);
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.includes('tollwise demo: proxy ready at')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  await ready;
  // Let a few requests go through (SEND_INTERVAL_MS in scripts/demo.ts) before interrupting.
  await new Promise((resolve) => setTimeout(resolve, 600));

  if (isWindows) child.send('SIGINT');
  else child.kill('SIGINT');

  const exit = await waitForExit(child);
  assert.equal(exit.code, 0, `expected a clean exit on SIGINT; stdout:\n${stdout}`);
  assert.ok(stdout.includes('stopped cleanly'), `expected the clean-shutdown line; stdout:\n${stdout}`);
  assert.ok(countRows(dbFile) > 0, 'expected at least one request to have been recorded before the interrupt');
});
