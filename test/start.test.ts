// `tollwise start` and bare `tollwise` as a real child process: startup time, default bind, logs, signals.

import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { freePort, send } from './fixtures/http-client.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.join(here, '..', 'src', 'cli.ts');
const bridgePath = path.join(here, 'fixtures', 'signal-bridge.ts');
// Not imported: loading the recorder patches the process that loads it (see the fixture).
const outboundRecorderUrl = pathToFileURL(path.join(here, 'fixtures', 'outbound-recorder.ts')).href;
const OUTBOUND_MARKER = 'outbound-recorder:';
const isWindows = process.platform === 'win32';

/** Startup budget from the product's performance targets. */
const STARTUP_BUDGET_MS = 2000;

const FAKE_QUERY_KEY = `fakeQuery${'Ju5'.repeat(8)}`;
const FAKE_PROVIDER_KEY = `fakeProvider${'Wm3'.repeat(8)}`;

// Every provider disabled: these tests exercise startup/shutdown and log redaction, never real
// provider behaviour, so the health monitor this process starts must never reach a real provider API.
const workDir = mkdtempSync(path.join(tmpdir(), 'tollwise-cli-start-'));
writeFileSync(
  path.join(workDir, 'tollwise.yaml'),
  'providers:\n' +
    '  anthropic: { enabled: false }\n' +
    '  openai: { enabled: false }\n' +
    '  deepseek: { enabled: false }\n' +
    '  openrouter: { enabled: false }\n' +
    '  ollama: { enabled: false }\n',
);
const children = new Set<ChildProcess>();
after(() => {
  for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
  rmSync(workDir, { recursive: true, force: true });
});

/** Only what Node needs to run: no inherited provider keys or TOLLWISE_* settings. */
function childEnv(extra: Readonly<Record<string, string>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...extra };
}

interface Started {
  readonly child: ChildProcess;
  readonly readyMs: number;
  readonly url: string;
  stderr(): string;
  exit(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/**
 * Spawns the CLI and resolves when it logs its ready line. `viaBridge` runs it through the test launcher that
 * can deliver SIGTERM/SIGINT on Windows (see test/fixtures/signal-bridge.ts).
 */
function startCli(
  args: readonly string[],
  env: Record<string, string>,
  viaBridge = false,
  nodeArgs: readonly string[] = [],
): Promise<Started> {
  const started = performance.now();
  const entry = viaBridge ? bridgePath : cliPath;
  const child = spawn(process.execPath, [...nodeArgs, entry, ...args], {
    cwd: workDir,
    env,
    stdio: viaBridge ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  let stderr = '';
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ready line within 10 s; stderr:\n${stderr}`)), 10_000);
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
      for (const line of stderr.split('\n')) {
        if (!line.startsWith('{')) continue;
        const record = JSON.parse(line) as { msg?: string; url?: string };
        if (record.msg?.startsWith('Tollwise is ready') && typeof record.url === 'string') {
          clearTimeout(timer);
          resolve({
            child,
            readyMs: performance.now() - started,
            url: record.url,
            stderr: () => stderr,
            exit: () => exited,
          });
          return;
        }
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`exited with ${code} before the ready line; stderr:\n${stderr}`));
    });
  });
}

function exitCode(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => child.once('exit', (code) => resolve(code)));
}

/** Delivers a stop signal: a real one on POSIX, through the bridge's IPC channel on Windows. */
function signal(started: Started, name: 'SIGTERM' | 'SIGINT'): void {
  if (isWindows) started.child.send(name);
  else started.child.kill(name);
}

test(`bare "tollwise" starts on 127.0.0.1 and is ready in under ${STARTUP_BUDGET_MS} ms`, async (t) => {
  const port = await freePort();
  // The real entry point, not the test launcher, so the measurement is what a user gets.
  const started = await startCli([], childEnv({ TOLLWISE_PORT: String(port) }));
  t.diagnostic(`spawn-to-ready: ${started.readyMs.toFixed(0)} ms (budget ${STARTUP_BUDGET_MS} ms)`);

  assert.equal(started.url, `http://127.0.0.1:${port}`);
  const res = await send(started.url, '/healthz');
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { status: 'ok' });
  assert.ok(started.readyMs < STARTUP_BUDGET_MS, `ready after ${started.readyMs.toFixed(0)} ms`);

  if (isWindows) {
    // No signal can reach this child's handlers on Windows; the next test covers the clean stop there.
    started.child.kill();
    await started.exit();
  } else {
    signal(started, 'SIGINT');
    assert.deepEqual(await started.exit(), { code: 0, signal: null });
  }
});

test('"tollwise start" exits 0 on SIGTERM and never logs query strings, headers or configured keys', async () => {
  const port = await freePort();
  const started = await startCli(
    ['start'],
    childEnv({ TOLLWISE_PORT: String(port), DEEPSEEK_API_KEY: FAKE_PROVIDER_KEY }),
    isWindows,
  );

  const withQueryKey = `/healthz?api_key=${FAKE_QUERY_KEY}`; // tollwise-allow-secret
  const res = await send(started.url, withQueryKey, {
    headers: { authorization: `Bearer ${FAKE_PROVIDER_KEY}`, 'x-api-key': FAKE_PROVIDER_KEY },
  });
  assert.equal(res.status, 200);
  assert.equal((await send(started.url, `/v1/${FAKE_PROVIDER_KEY}`)).status, 404);
  assert.equal(
    (
      await send(started.url, '/v1/embeddings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
    ).status,
    501,
  );

  signal(started, 'SIGTERM');
  assert.deepEqual(await started.exit(), { code: 0, signal: null });

  const output = started.stderr();
  // Every stderr line is a JSON log record: no runtime warning (node:sqlite's included) is printed.
  assert.doesNotMatch(output, /ExperimentalWarning/);
  const records = output
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const requests = records.filter((record) => record.msg === 'request');
  assert.deepEqual(
    requests.map((record) => [record.method, record.path, record.status]),
    [
      ['GET', '/healthz', 200],
      ['GET', '/v1/[REDACTED]', 404],
      ['POST', '/v1/embeddings', 501],
    ],
  );
  assert.ok(records.some((record) => record.msg === 'Tollwise stopped'));
  assert.ok(!output.includes(FAKE_QUERY_KEY));
  assert.ok(!output.includes(FAKE_PROVIDER_KEY));
  assert.ok(!output.includes('api_key'));
  assert.ok(!/authorization|x-api-key/i.test(output));
});

test('a started server with no provider enabled opens no outbound connection (no telemetry or phone-home)', async () => {
  const port = await freePort();
  const started = await startCli(['start'], childEnv({ TOLLWISE_PORT: String(port) }), false, [
    '--import',
    outboundRecorderUrl,
  ]);
  // The recorder is live in the child: its own marker line would show any connection from here on.
  assert.equal((await send(started.url, '/healthz')).status, 200);
  assert.equal((await send(started.url, '/api/health')).status, 200);
  const chat = await send(started.url, '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.ok(chat.status >= 400, `no provider is enabled, got ${chat.status}`);
  assert.equal((await send(started.url, '/api/metrics/summary')).status, 200);
  // Longer than the start-up work: a delayed update check or report would have fired by now.
  await new Promise((resolve) => setTimeout(resolve, 1500));

  started.child.kill();
  await started.exit();
  const outbound = started
    .stderr()
    .split('\n')
    .filter((line) => line.startsWith(OUTBOUND_MARKER));
  // The recorder was live in the child and saw no connection.
  assert.deepEqual(outbound, [`${OUTBOUND_MARKER} loaded`]);
});

test('"tollwise start" with an invalid port setting exits 1 with the problem', async () => {
  const child = spawn(process.execPath, [cliPath, 'start'], {
    cwd: workDir,
    env: childEnv({ TOLLWISE_PORT: 'not-a-port' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const code = await exitCode(child);
  assert.equal(code, 1);
  assert.match(stderr, /the configuration is not valid/);
  assert.match(stderr, /TOLLWISE_PORT/);
});

test('"tollwise start --help" prints the start usage and exits 0', async () => {
  const child = spawn(process.execPath, [cliPath, 'start', '--help'], { cwd: workDir, env: childEnv({}) });
  children.add(child);
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  const code = await exitCode(child);
  assert.equal(code, 0);
  assert.match(stdout, /Usage: tollwise start/);
  assert.match(stdout, /127\.0\.0\.1:8484/);
});
