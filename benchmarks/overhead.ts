#!/usr/bin/env node
// Proxy overhead benchmark: how much latency and memory Tollwise itself adds over the provider it
// forwards to (see docs/benchmarks.md for the method and the published numbers). Never part of
// `npm test` or `npm run check`; run by hand with `npm run bench:overhead`. Uses only a mocked
// provider and a fake, non-key-shaped credential (CLAUDE.md rule 5); every server binds to
// 127.0.0.1 only and its analytics database lives under a temporary directory, never /data.
//
// Method:
//   1. Start test/fixtures/mock-provider.ts with zero injected latency (latencyMs: 0,
//      firstByteDelayMs: 0): its own response time is the floor everything else is measured against.
//   2. Spawn the real `node src/cli.ts start` a few times, each against a config pointed at the mock
//      provider, timing wall-clock from spawn() to the first 200 from GET /healthz. Median of these
//      runs is the startup number.
//   3. Spawn one more such process and keep it running. After it settles idle (no request sent yet),
//      read its own resident set size from the OS -- the idle memory number.
//   4. Send the exact same JSON payload (a POST /v1/chat/completions body) straight to the mock
//      provider and through that running Tollwise, with autocannon, non-streaming: p50/p99 latency
//      overhead is Tollwise's numbers minus the mock's own.
//   5. Send the same payload with stream: true, direct and through Tollwise, timing time-to-first-byte
//      by hand (autocannon does not expose per-request TTFB for an open SSE response): p50
//      time-to-first-byte overhead is the same subtraction.
//
// Writes benchmarks/results/overhead-<UTC date>.json: every raw number above, the machine (CPU
// model, core count, RAM, OS -- never a host or user name), the Node version, the Tollwise git commit
// and the exact command that produced the file.

import assert from 'node:assert/strict';
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import autocannon, { type Result as AutocannonResult } from 'autocannon';
import { stringify as toYaml } from 'yaml';
import { freePort } from '../test/fixtures/http-client.ts';
import { startMockProvider } from '../test/fixtures/mock-provider.ts';

// ---------------------------------------------------------------- fixed parameters

/** Repeated spawns timed for the startup number; the reported figure is their median. */
const STARTUP_RUNS = 5;
/** Wall-clock budget for one spawn to answer GET /healthz 200; well above the published startup target. */
const STARTUP_TIMEOUT_MS = 10_000;
/** Settle time after "ready" and before reading resident memory or sending any load. */
const IDLE_SETTLE_MS = 500;
/** autocannon load per non-streaming run. */
const LOAD_CONNECTIONS = 10;
const LOAD_DURATION_S = 8;
/** Sequential request pairs timed by hand for the streaming first-byte number. */
const TTFB_SAMPLES = 30;

/** Tollwise's published performance targets (see docs/benchmarks.md), reproduced here so a miss is visible next to the number. */
const TARGETS = {
  overhead_p50_ms: 5,
  overhead_p99_ms: 20,
  streaming_first_byte_overhead_p50_ms: 10,
  startup_ms: 2000,
  idle_memory_mb: 150,
} as const;

/** Name of the environment variable that carries the fake provider key (never a real one, never OPENAI_API_KEY). */
const PROVIDER_KEY_ENV = 'TOLLWISE_BENCH_PROVIDER_KEY';
/** Not shaped like any real provider key (see src/log/patterns.ts): plain text, nothing for guard-keys to flag. */
const FAKE_PROVIDER_KEY = 'tollwise-benchmark-fixture-key-not-real';

/** A catalog model this repository's shipped catalog/models.yaml lists under provider "openai", with streaming. */
const BENCH_MODEL = 'gpt-5.6-luna';
const BENCH_MESSAGES = [{ role: 'user', content: 'Reply with one short sentence about the weather today.' }];

// ---------------------------------------------------------------- small helpers

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return Number.NaN;
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[mid] ?? 0);
}

function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

interface WriteConfigOptions {
  readonly port: number;
  readonly mockUrl: string;
  readonly dbPath: string;
}

/** Writes a minimal tollwise.yaml: one provider (openai) pointed at the mock, everything else off. */
function writeConfig(configPath: string, options: WriteConfigOptions): void {
  const config = {
    server: { host: '127.0.0.1', port: options.port },
    providers: {
      openai: { base_url: `${options.mockUrl}/v1`, api_key_env: PROVIDER_KEY_ENV },
      anthropic: { enabled: false },
      deepseek: { enabled: false },
      openrouter: { enabled: false },
      ollama: { enabled: false },
    },
    routing: { policy: 'cheapest' },
    analytics: { enabled: true, store_prompts: false, path: options.dbPath },
    logging: { level: 'info' },
  };
  writeFileSync(configPath, toYaml(config), 'utf8');
}

/** process.env for a spawned Tollwise: the shell's own env, minus anything that would redirect it
 *  away from the config this script wrote, plus the one fake provider key it needs. */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.TOLLWISE_HOST;
  delete env.TOLLWISE_PORT;
  delete env.TOLLWISE_ACCESS_KEY;
  delete env.TOLLWISE_CONFIG;
  delete env.TOLLWISE_LOG_LEVEL;
  env[PROVIDER_KEY_ENV] = FAKE_PROVIDER_KEY;
  return env;
}

function spawnTollwise(cliEntry: string, repoRoot: string, configPath: string, logFd: number): ChildProcess {
  return spawn(process.execPath, [cliEntry, 'start', '--config', configPath], {
    cwd: repoRoot,
    env: childEnv(),
    stdio: ['ignore', logFd, logFd],
  });
}

/** Polls GET /healthz until it answers 200 with { status: "ok" }, or throws after timeoutMs. */
async function waitForHealthz(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(500) });
      if (response.status === 200) {
        const body = (await response.json()) as { status?: string };
        if (body.status === 'ok') return;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(10);
  }
  throw new Error(
    `Tollwise did not answer 200 on GET ${baseUrl}/healthz within ${timeoutMs} ms` +
      (lastError !== undefined ? ` (last error: ${String(lastError)})` : ''),
  );
}

function stopChild(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 3000);
    timer.unref();
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

/** The spawned process's own resident set size, read from the OS (never process.memoryUsage() of
 *  this benchmark script's own process, which also carries autocannon and would overstate it). */
function readRssBytes(pid: number): number {
  if (os.platform() === 'win32') {
    const output = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).WorkingSet64`],
      { encoding: 'utf8' },
    );
    return Number(output.trim());
  }
  const output = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' });
  return Number(output.trim()) * 1024;
}

/** Time from the start of one POST to the first chunk of its response body. */
async function measureFirstByteMs(url: string, body: string): Promise<number> {
  const startedAt = performance.now();
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  assert.equal(response.status, 200, `expected 200 from POST ${url}, got ${response.status}`);
  const reader = response.body?.getReader();
  assert.ok(reader, `expected a readable response body from POST ${url}`);
  await reader.read();
  const firstByteAt = performance.now();
  reader.cancel().catch(() => {});
  return firstByteAt - startedAt;
}

async function measureFirstByteSamples(url: string, body: string, samples: number): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < samples; i += 1) out.push(await measureFirstByteMs(url, body));
  return out;
}

function runLoad(url: string, body: string): Promise<AutocannonResult> {
  return autocannon({
    url,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    connections: LOAD_CONNECTIONS,
    duration: LOAD_DURATION_S,
  });
}

function assertClean(result: AutocannonResult, label: string): void {
  assert.equal(result.errors, 0, `${label}: ${result.errors} connection error(s) during the load test`);
  assert.equal(result.non2xx, 0, `${label}: ${result.non2xx} non-2xx response(s) during the load test`);
}

function gitCommit(repoRoot: string): { commit: string; dirty: boolean } {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' });
  return { commit, dirty: status.trim().length > 0 };
}

function machineInfo(): { cpu: string; cpu_cores: number; ram_gb: number; os: string } {
  const cpus = os.cpus();
  return {
    cpu: cpus[0]?.model ?? 'unknown',
    cpu_cores: cpus.length,
    ram_gb: round(os.totalmem() / 1024 ** 3, 1),
    os: `${os.type()} ${os.release()} (${os.platform()}/${os.arch()})`,
  };
}

// ---------------------------------------------------------------- steps

interface StepContext {
  readonly repoRoot: string;
  readonly cliEntry: string;
  readonly tempDir: string;
  readonly mockUrl: string;
}

async function measureStartupRuns(ctx: StepContext): Promise<number[]> {
  const samples: number[] = [];
  for (let i = 0; i < STARTUP_RUNS; i += 1) {
    const port = await freePort();
    const dbPath = path.join(ctx.tempDir, `startup-${i}.db`);
    const configPath = path.join(ctx.tempDir, `startup-${i}.yaml`);
    writeConfig(configPath, { port, mockUrl: ctx.mockUrl, dbPath });
    const logFd = openSync(path.join(ctx.tempDir, `startup-${i}.log`), 'a');
    const startedAt = performance.now();
    const child = spawnTollwise(ctx.cliEntry, ctx.repoRoot, configPath, logFd);
    try {
      await waitForHealthz(`http://127.0.0.1:${port}`, STARTUP_TIMEOUT_MS);
      samples.push(performance.now() - startedAt);
    } finally {
      await stopChild(child);
      closeSync(logFd);
    }
    console.log(`overhead: startup run ${i + 1}/${STARTUP_RUNS}: ${round(samples[i] ?? 0)} ms`);
  }
  return samples;
}

interface LoadChild {
  readonly child: ChildProcess;
  readonly url: string;
  readonly logFd: number;
}

async function startLoadChild(ctx: StepContext): Promise<LoadChild> {
  const port = await freePort();
  const dbPath = path.join(ctx.tempDir, 'load.db');
  const configPath = path.join(ctx.tempDir, 'load.yaml');
  writeConfig(configPath, { port, mockUrl: ctx.mockUrl, dbPath });
  const logFd = openSync(path.join(ctx.tempDir, 'load.log'), 'a');
  const child = spawnTollwise(ctx.cliEntry, ctx.repoRoot, configPath, logFd);
  const url = `http://127.0.0.1:${port}`;
  await waitForHealthz(url, STARTUP_TIMEOUT_MS);
  return { child, url, logFd };
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.join(here, '..');
  const cliEntry = path.join(repoRoot, 'src', 'cli.ts');
  const resultsDir = path.join(repoRoot, 'benchmarks', 'results');
  mkdirSync(resultsDir, { recursive: true });
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'tollwise-bench-'));

  console.log('overhead: starting the zero-latency mock provider ...');
  const mock = await startMockProvider({ latencyMs: 0, firstByteDelayMs: 0 });
  const ctx: StepContext = { repoRoot, cliEntry, tempDir, mockUrl: mock.url };

  try {
    console.log(`overhead: measuring startup time (${STARTUP_RUNS} spawns) ...`);
    const startupSamplesMs = await measureStartupRuns(ctx);

    console.log('overhead: starting Tollwise for the load and memory measurements ...');
    const load = await startLoadChild(ctx);
    try {
      await delay(IDLE_SETTLE_MS);
      const idleRssBytes = readRssBytes(load.child.pid ?? -1);
      console.log(`overhead: idle RSS ${round(idleRssBytes / 1024 ** 2, 1)} MB`);

      const payloadNonStream = JSON.stringify({ model: BENCH_MODEL, messages: BENCH_MESSAGES, stream: false });
      const payloadStream = JSON.stringify({ model: BENCH_MODEL, messages: BENCH_MESSAGES, stream: true });

      console.log('overhead: non-streaming load, direct to the mock provider ...');
      const directNonStream = await runLoad(`${mock.url}/v1/chat/completions`, payloadNonStream);
      assertClean(directNonStream, 'direct non-streaming');

      console.log('overhead: non-streaming load, through Tollwise ...');
      const tollwiseNonStream = await runLoad(`${load.url}/v1/chat/completions`, payloadNonStream);
      assertClean(tollwiseNonStream, 'Tollwise non-streaming');

      console.log(`overhead: streaming first byte, direct to the mock provider (${TTFB_SAMPLES} samples) ...`);
      const directTtfb = await measureFirstByteSamples(`${mock.url}/v1/chat/completions`, payloadStream, TTFB_SAMPLES);

      console.log(`overhead: streaming first byte, through Tollwise (${TTFB_SAMPLES} samples) ...`);
      const tollwiseTtfb = await measureFirstByteSamples(
        `${load.url}/v1/chat/completions`,
        payloadStream,
        TTFB_SAMPLES,
      );

      const { commit, dirty } = gitCommit(repoRoot);
      const nowIso = new Date().toISOString();

      const overheadP50 = round(tollwiseNonStream.latency.p50 - directNonStream.latency.p50);
      const overheadP99 = round(tollwiseNonStream.latency.p99 - directNonStream.latency.p99);
      const directTtfbP50 = round(median(directTtfb));
      const tollwiseTtfbP50 = round(median(tollwiseTtfb));
      const ttfbOverheadP50 = round(tollwiseTtfbP50 - directTtfbP50);
      const startupMedianMs = round(median(startupSamplesMs));
      const idleMemoryMb = round(idleRssBytes / 1024 ** 2, 1);

      const record = {
        date: nowIso,
        command: 'npm run bench:overhead',
        node_version: process.version,
        tollwise_commit: commit,
        tollwise_dirty: dirty,
        machine: machineInfo(),
        method: {
          mock_provider: 'test/fixtures/mock-provider.ts, latencyMs: 0, firstByteDelayMs: 0',
          non_streaming_load: { connections: LOAD_CONNECTIONS, duration_s: LOAD_DURATION_S, tool: 'autocannon@8.0.0' },
          streaming_first_byte: { samples: TTFB_SAMPLES, tool: 'hand-timed fetch(), first reader.read()' },
          startup: {
            runs: STARTUP_RUNS,
            measured: 'spawn() of `node src/cli.ts start` to the first 200 from GET /healthz',
          },
          idle_memory: `resident set size of the spawned process, read from the OS ${IDLE_SETTLE_MS} ms after "ready", before any request`,
          model: BENCH_MODEL,
          endpoint: 'POST /v1/chat/completions',
        },
        targets: TARGETS,
        results: {
          non_streaming: {
            direct: { p50_ms: round(directNonStream.latency.p50), p99_ms: round(directNonStream.latency.p99) },
            tollwise: { p50_ms: round(tollwiseNonStream.latency.p50), p99_ms: round(tollwiseNonStream.latency.p99) },
            overhead_p50_ms: overheadP50,
            overhead_p99_ms: overheadP99,
          },
          streaming_first_byte: {
            direct_p50_ms: directTtfbP50,
            tollwise_p50_ms: tollwiseTtfbP50,
            overhead_p50_ms: ttfbOverheadP50,
          },
          startup: { runs_ms: startupSamplesMs.map((value) => round(value)), median_ms: startupMedianMs },
          idle_memory: { rss_mb: idleMemoryMb },
        },
        pass: {
          overhead_p50: overheadP50 <= TARGETS.overhead_p50_ms,
          overhead_p99: overheadP99 <= TARGETS.overhead_p99_ms,
          streaming_first_byte_p50: ttfbOverheadP50 <= TARGETS.streaming_first_byte_overhead_p50_ms,
          startup: startupMedianMs <= TARGETS.startup_ms,
          idle_memory: idleMemoryMb <= TARGETS.idle_memory_mb,
        },
      };

      const outPath = path.join(resultsDir, `overhead-${nowIso.slice(0, 10)}.json`);
      writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');

      console.log('');
      const line = (label: string, value: string, target: string, pass: boolean) =>
        console.log(`${pass ? 'PASS' : 'FAIL'}  ${label.padEnd(32)} ${value.padStart(10)}  (target ${target})`);
      line(
        'non-streaming overhead p50',
        `${overheadP50} ms`,
        `<= ${TARGETS.overhead_p50_ms} ms`,
        record.pass.overhead_p50,
      );
      line(
        'non-streaming overhead p99',
        `${overheadP99} ms`,
        `<= ${TARGETS.overhead_p99_ms} ms`,
        record.pass.overhead_p99,
      );
      line(
        'streaming first-byte overhead p50',
        `${ttfbOverheadP50} ms`,
        `<= ${TARGETS.streaming_first_byte_overhead_p50_ms} ms`,
        record.pass.streaming_first_byte_p50,
      );
      line('startup (median)', `${startupMedianMs} ms`, `<= ${TARGETS.startup_ms} ms`, record.pass.startup);
      line('idle resident memory', `${idleMemoryMb} MB`, `<= ${TARGETS.idle_memory_mb} MB`, record.pass.idle_memory);
      console.log('');
      console.log(`overhead: wrote ${path.relative(repoRoot, outPath)}`);

      const failed = Object.entries(record.pass).filter(([, passed]) => !passed);
      if (failed.length > 0) {
        console.error(`overhead: ${failed.length} of 5 target(s) missed: ${failed.map(([name]) => name).join(', ')}.`);
        process.exitCode = 1;
      }
    } finally {
      await stopChild(load.child);
      closeSync(load.logFd);
    }
  } finally {
    await mock.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(`overhead: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exitCode = 1;
});
