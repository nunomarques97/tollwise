#!/usr/bin/env node
// `npm run demo`: runs Tollwise, in this same process, against five local mock providers (one per
// provider id in catalog/models.yaml) and sends a seeded, reproducible mix of realistic traffic --
// both request formats, streaming and non-streaming, tool calls, JSON mode, vision, a free local
// provider, and scripted provider failures that show routing fall back to another candidate --
// until Ctrl+C or --count requests. No account, no real API key and no network call is
// ever made; the fake provider keys below live only in a local environment object, never in
// process.env (see credentialValues() / registerSecretValues() in src/server/start.ts for the same
// pattern in production start-up).
//
// examples/demo.yaml describes the demo configuration (routing policy, analytics.path and one
// equivalence preset); this script always overrides providers.<id>.base_url with the mock servers'
// actual OS-assigned ports before validating it (see the file's own header comment).
//
// Model substitution: the demo turns on the small-fast equivalence preset (docs/equivalence-presets.md)
// with `routing.equivalence_presets: [small-fast]` in examples/demo.yaml. The cheapest policy then
// serves the gpt-5.6-luna and claude-haiku-4.5 scenarios with deepseek-v4.1-flash, so the demo traffic
// includes substituted requests: each one reports `substituted=true` on its line below (from the
// x-tollwise-substituted header) and is marked "Substituted" in the dashboard. Every other scenario
// asks for a model outside the preset and is only ever switched between providers of that model.
//
// Usage: npm run demo -- [--count N] [--seed S]
//
// Undocumented overrides, for test/demo.test.ts only: --port P (0 for an ephemeral port),
// --analytics-path PATH (a temp file instead of data/demo.db), --quiet (suppress the per-request line).

import { readFileSync } from 'node:fs';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { type EventStore, openSqliteEventStore } from '../src/analytics/store.ts';
import { loadCatalog } from '../src/catalog/index.ts';
import type { Catalog } from '../src/catalog/schema.ts';
import { ConfigSchema, type ProviderId } from '../src/config/schema.ts';
import { createHealthMonitor, type HealthMonitor } from '../src/health/monitor.ts';
import { createLogger } from '../src/log/logger.ts';
import { registerSecretValues } from '../src/log/redact.ts';
import { buildRegistry } from '../src/providers/registry.ts';
import { onRequestOutcome } from '../src/proxy/outcome.ts';
import { baseUrl, createTollwiseServer, listen, stopServer } from '../src/server/server.ts';
import { type MockProvider, startMockProvider } from '../test/fixtures/mock-provider.ts';

const USAGE = `Usage: npm run demo -- [--count N] [--seed S]

Runs Tollwise against five local mock providers (one per provider id in catalog/models.yaml) with a
seeded, reproducible mix of realistic traffic: both request formats, streaming and non-streaming,
tool calls, JSON mode, vision, a free local provider, and scripted provider failures that show
routing fall back to another candidate. No account, no real API key and no network call
is ever made.

Options:
  --count N     Stop after N requests. Default: run until Ctrl+C (SIGINT or SIGTERM).
  --seed S      Seed for the deterministic, reproducible request mix. Default: 1.
  --help, -h    Show this help and exit.
`;

/** Delay between requests when --count is not given (Ctrl+C mode), so the traffic stays readable. */
const SEND_INTERVAL_MS = 250;

// ---------------------------------------------------------------- argument parsing

interface DemoArgs {
  readonly count: number | undefined;
  readonly seed: string;
  readonly port: number | undefined;
  readonly analyticsPath: string | undefined;
  readonly quiet: boolean;
}

function parseArgs(args: readonly string[]): DemoArgs | { exit: number } {
  let count: number | undefined;
  let seed = '1';
  let port: number | undefined;
  let analyticsPath: string | undefined;
  let quiet = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      return { exit: 0 };
    }
    if (arg === '--count' || arg === '-n') {
      index += 1;
      const raw = args[index];
      const value = raw === undefined ? Number.NaN : Number(raw);
      if (!Number.isInteger(value) || value < 1) {
        console.error('tollwise demo: --count needs a positive whole number');
        return { exit: 2 };
      }
      count = value;
      continue;
    }
    if (arg === '--seed' || arg === '-s') {
      index += 1;
      const value = args[index];
      if (value === undefined || value === '') {
        console.error('tollwise demo: --seed needs a value');
        return { exit: 2 };
      }
      seed = value;
      continue;
    }
    if (arg === '--port') {
      index += 1;
      const raw = args[index];
      const value = raw === undefined ? Number.NaN : Number(raw);
      if (!Number.isInteger(value) || value < 0 || value > 65535) {
        console.error('tollwise demo: --port needs a whole number between 0 and 65535');
        return { exit: 2 };
      }
      port = value;
      continue;
    }
    if (arg === '--analytics-path') {
      index += 1;
      const value = args[index];
      if (value === undefined || value === '') {
        console.error('tollwise demo: --analytics-path needs a value');
        return { exit: 2 };
      }
      analyticsPath = value;
      continue;
    }
    if (arg === '--quiet') {
      quiet = true;
      continue;
    }
    console.error(`tollwise demo: unknown option "${arg}"\n`);
    console.error(USAGE);
    return { exit: 2 };
  }
  return { count, seed, port, analyticsPath, quiet };
}

// ---------------------------------------------------------------- deterministic pseudo-randomness

/** mulberry32: a small, fast, seeded PRNG (public-domain algorithm), so --seed reproduces a run exactly. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Turns an arbitrary --seed string into a 32-bit integer (FNV-1a). */
function hashSeed(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------- the request mix

const PROMPTS: readonly string[] = [
  'Give me a one-sentence status update for the demo dashboard.',
  'Summarize in one short sentence why local-first LLM routing saves money.',
  'What is 2 + 2? Answer in one short sentence.',
  'Write a two-word greeting for a terminal demo.',
  'Explain streaming responses in one short sentence.',
];

function pickPrompt(rng: () => number): string {
  const index = Math.floor(rng() * PROMPTS.length);
  return PROMPTS[index] ?? (PROMPTS[0] as string);
}

function userText(content: string): { role: 'user'; content: string } {
  return { role: 'user', content };
}

/** A 1x1 transparent PNG, used only as vision content; not a credential. */
const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

// Tollwise has no access key configured for the demo, so these are never checked; sent only so the
// requests look like real SDK traffic.
const OPENAI_HEADERS = { 'content-type': 'application/json', authorization: 'Bearer demo-not-checked' }; // tollwise-allow-secret
const ANTHROPIC_HEADERS = {
  'content-type': 'application/json',
  'x-api-key': 'demo-not-checked', // tollwise-allow-secret
  'anthropic-version': '2023-06-01',
};

interface DemoRequest {
  readonly path: '/v1/chat/completions' | '/v1/messages';
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

interface Scenario {
  readonly name: string;
  build(rng: () => number): DemoRequest;
}

/**
 * The demo's fixed set of scenarios, cycled in a seeded shuffle (see shuffledScenarioOrder()). Every
 * one of these hits catalog/models.yaml's five providers, both wire formats, streaming and not,
 * tools, JSON mode and vision at least once. Every "*-opus-fallback" scenario asks for
 * FAILING_ANTHROPIC_MODEL, which the anthropic provider fails on every call (see
 * startAnthropicFaultInjector()), so each of them falls back to the same model served through
 * openrouter (attempts=2); no other scenario asks for that model.
 */
const SCENARIOS: readonly Scenario[] = [
  {
    // gpt-5.6-luna is in the small-fast preset the demo turns on (examples/demo.yaml), so the
    // cheapest policy may substitute deepseek-v4.1-flash, a cheaper model of another vendor.
    name: 'openai-plain-cheapest-group',
    build: (rng) => ({
      path: '/v1/chat/completions',
      headers: OPENAI_HEADERS,
      body: { model: 'gpt-5.6-luna', messages: [userText(pickPrompt(rng))] },
    }),
  },
  {
    name: 'openai-stream-deepseek',
    build: (rng) => ({
      path: '/v1/chat/completions',
      headers: OPENAI_HEADERS,
      body: { model: 'deepseek-flash', messages: [userText(pickPrompt(rng))], stream: true },
    }),
  },
  {
    name: 'anthropic-plain-haiku',
    build: (rng) => ({
      path: '/v1/messages',
      headers: ANTHROPIC_HEADERS,
      body: { model: 'claude-haiku-4-5-20251001', max_tokens: 200, messages: [userText(pickPrompt(rng))] },
    }),
  },
  {
    name: 'anthropic-stream-opus-fallback',
    build: (rng) => ({
      path: '/v1/messages',
      headers: ANTHROPIC_HEADERS,
      body: { model: 'claude-opus-5', max_tokens: 200, messages: [userText(pickPrompt(rng))], stream: true },
    }),
  },
  {
    name: 'openai-tools',
    build: () => ({
      path: '/v1/chat/completions',
      headers: OPENAI_HEADERS,
      body: {
        model: 'gpt-6-astra',
        messages: [userText('What is the weather in Lisbon?')],
        tools: [
          {
            type: 'function',
            function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } },
          },
        ],
      },
    }),
  },
  {
    name: 'anthropic-tools-stream-opus-fallback',
    build: () => ({
      path: '/v1/messages',
      headers: ANTHROPIC_HEADERS,
      body: {
        model: 'claude-opus-5',
        max_tokens: 200,
        messages: [userText('Search the docs for "routing policy".')],
        tools: [{ name: 'search_docs', input_schema: { type: 'object', properties: { q: { type: 'string' } } } }],
        stream: true,
      },
    }),
  },
  {
    name: 'openai-json-mode',
    build: () => ({
      path: '/v1/chat/completions',
      headers: OPENAI_HEADERS,
      body: {
        model: 'deepseek-v4-pro',
        messages: [userText('Return a small JSON object describing this demo.')],
        response_format: { type: 'json_object' },
      },
    }),
  },
  {
    name: 'openai-vision',
    build: () => ({
      path: '/v1/chat/completions',
      headers: OPENAI_HEADERS,
      body: {
        model: 'gpt-5.6-luna',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What is in this image?' },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${TINY_PNG_BASE64}` } },
            ],
          },
        ],
      },
    }),
  },
  {
    name: 'anthropic-vision-opus-fallback',
    build: () => ({
      path: '/v1/messages',
      headers: ANTHROPIC_HEADERS,
      body: {
        model: 'claude-opus-5',
        max_tokens: 200,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What is in this image?' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: TINY_PNG_BASE64 } },
            ],
          },
        ],
      },
    }),
  },
  {
    name: 'openai-local-ollama',
    build: (rng) => ({
      path: '/v1/chat/completions',
      headers: OPENAI_HEADERS,
      body: { model: 'llama3.1:8b', messages: [userText(pickPrompt(rng))] },
    }),
  },
];

/** A seeded Fisher-Yates shuffle of SCENARIOS, so the mix order is reproducible but not always the same. */
function shuffledScenarioOrder(rng: () => number): readonly Scenario[] {
  const order = [...SCENARIOS];
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const a = order[i] as Scenario;
    const b = order[j] as Scenario;
    order[i] = b;
    order[j] = a;
  }
  return order;
}

async function sendOne(
  tollwiseUrl: string,
  scenario: Scenario,
  rng: () => number,
  index: number,
  quiet: boolean,
): Promise<void> {
  const request = scenario.build(rng);
  const response = await fetch(`${tollwiseUrl}${request.path}`, {
    method: 'POST',
    headers: request.headers,
    body: JSON.stringify(request.body),
  });
  // Drains the body whether it is a single JSON object or an SSE stream, so the connection settles
  // cleanly before the next request; the demo only needs the response headers below.
  await response.text().catch(() => undefined);
  if (quiet) return;
  const provider = response.headers.get('x-tollwise-provider') ?? 'none';
  const model = response.headers.get('x-tollwise-model') ?? 'none';
  const routed = response.headers.get('x-tollwise-routed') ?? 'false';
  const attempts = response.headers.get('x-tollwise-attempts') ?? '0';
  const substituted = response.headers.get('x-tollwise-substituted') ?? 'false';
  const savings = response.headers.get('x-tollwise-savings-usd');
  const suffix = savings === null ? '' : ` savings=$${savings}`;
  console.log(
    `[${String(index + 1).padStart(3, ' ')}] ${scenario.name.padEnd(36, ' ')} -> ${response.status} ` +
      `provider=${provider} model=${model} routed=${routed} substituted=${substituted} ` +
      `attempts=${attempts}${suffix}`,
  );
}

// ---------------------------------------------------------------- mock providers

/**
 * The model the anthropic provider fails for, on every call. The cheapest policy puts the anthropic
 * candidate first for it (same price as openrouter's, earlier in catalog order), so every request for
 * it fails there with a retryable error and is answered by openrouter instead.
 */
const FAILING_ANTHROPIC_MODEL = 'claude-opus-5';

/** Retryable Anthropic-shaped errors, used in turn: a rate limit, then a server error, and so on. */
const INJECTED_FAILURES: readonly { readonly status: number; readonly type: string; readonly message: string }[] = [
  { status: 429, type: 'rate_limit_error', message: 'demo: simulated rate limit, showing fallback' },
  { status: 500, type: 'api_error', message: 'demo: simulated provider error, showing fallback' },
];

interface FaultInjector {
  readonly url: string;
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.once('end', () => resolve(Buffer.concat(chunks)));
    req.once('error', reject);
  });
}

function requestedModel(body: Buffer): string | undefined {
  try {
    const parsed = JSON.parse(body.toString('utf8')) as { model?: unknown } | null;
    return typeof parsed?.model === 'string' ? parsed.model : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A loopback HTTP front for the anthropic mock. A POST /v1/messages for FAILING_ANTHROPIC_MODEL is
 * answered with the next of INJECTED_FAILURES; everything else (other models, GET /v1/models health
 * checks) is passed through to the mock unchanged, streaming included. Keying the failure on the
 * requested model, not on call order, makes every fallback scenario fall back, whatever the seed.
 */
async function startAnthropicFaultInjector(target: MockProvider): Promise<FaultInjector> {
  const targetUrl = new URL(target.url);
  let failures = 0;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await readBody(req);
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (req.method === 'POST' && pathname === '/v1/messages' && requestedModel(body) === FAILING_ANTHROPIC_MODEL) {
      const failure = INJECTED_FAILURES[failures % INJECTED_FAILURES.length] as (typeof INJECTED_FAILURES)[number];
      failures += 1;
      res.writeHead(failure.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: failure.type, message: failure.message } }));
      return;
    }
    const upstream = httpRequest(
      {
        host: targetUrl.hostname,
        port: targetUrl.port,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, host: targetUrl.host, 'content-length': String(body.length) },
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.once('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end();
    });
    upstream.end(body);
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('the demo fault injector failed to bind to a loopback TCP port');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

interface DemoMocks {
  readonly anthropic: MockProvider;
  /** The loopback front Tollwise's anthropic base_url points at; see startAnthropicFaultInjector(). */
  readonly anthropicFront: FaultInjector;
  readonly openai: MockProvider;
  readonly deepseek: MockProvider;
  readonly openrouter: MockProvider;
  readonly ollama: MockProvider;
}

function modelsFor(catalog: Catalog, provider: ProviderId): string[] {
  return catalog.models.filter((entry) => entry.provider === provider).map((entry) => entry.model);
}

/** Starts one mock per provider id, with GET /v1/models lists that match catalog/models.yaml. */
async function startMockProviders(catalog: Catalog): Promise<DemoMocks> {
  const [anthropic, openai, deepseek, openrouter, ollama] = await Promise.all([
    startMockProvider({ models: { anthropic: modelsFor(catalog, 'anthropic') } }),
    startMockProvider({ models: { openai: modelsFor(catalog, 'openai') } }),
    startMockProvider({ models: { openai: modelsFor(catalog, 'deepseek') } }),
    startMockProvider({ models: { openai: modelsFor(catalog, 'openrouter') } }),
    startMockProvider({ models: { openai: modelsFor(catalog, 'ollama') } }),
  ]);
  const anthropicFront = await startAnthropicFaultInjector(anthropic);
  return { anthropic, anthropicFront, openai, deepseek, openrouter, ollama };
}

// ---------------------------------------------------------------- configuration

/** Fake provider keys, set only in this local environment object -- never in process.env. */
const DEMO_ENV: Readonly<Record<string, string>> = {
  OPENAI_API_KEY: 'tollwise-demo-openai-fake-key', // tollwise-allow-secret
  ANTHROPIC_API_KEY: 'tollwise-demo-anthropic-fake-key', // tollwise-allow-secret
  DEEPSEEK_API_KEY: 'tollwise-demo-deepseek-fake-key', // tollwise-allow-secret
  OPENROUTER_API_KEY: 'tollwise-demo-openrouter-fake-key', // tollwise-allow-secret
};

function providerOverride(rawProviders: Record<string, unknown>, id: string, baseUrl: string): Record<string, unknown> {
  return { ...(rawProviders[id] as Record<string, unknown> | undefined), base_url: baseUrl };
}

/** Reads examples/demo.yaml and overrides the fields that must reflect this run's actual state. */
function buildDemoConfig(demoConfigPath: string, mocks: DemoMocks, args: DemoArgs) {
  const raw = (parseYaml(readFileSync(demoConfigPath, 'utf8')) ?? {}) as Record<string, unknown>;
  const rawProviders = (raw.providers as Record<string, unknown> | undefined) ?? {};
  const rawAnalytics = (raw.analytics as Record<string, unknown> | undefined) ?? {};
  const rawServer = (raw.server as Record<string, unknown> | undefined) ?? {};

  const merged = {
    ...raw,
    providers: {
      ...rawProviders,
      anthropic: providerOverride(rawProviders, 'anthropic', mocks.anthropicFront.url),
      openai: providerOverride(rawProviders, 'openai', `${mocks.openai.url}/v1`),
      deepseek: providerOverride(rawProviders, 'deepseek', `${mocks.deepseek.url}/v1`),
      openrouter: providerOverride(rawProviders, 'openrouter', `${mocks.openrouter.url}/v1`),
      ollama: providerOverride(rawProviders, 'ollama', mocks.ollama.url),
    },
    analytics: { ...rawAnalytics, ...(args.analyticsPath !== undefined ? { path: args.analyticsPath } : {}) },
    server: { ...rawServer, host: '127.0.0.1' },
  };
  return ConfigSchema.parse(merged);
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if ('exit' in parsed) {
    process.exitCode = parsed.exit;
    return;
  }
  const args = parsed;

  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.join(here, '..');
  const demoConfigPath = path.join(repoRoot, 'examples', 'demo.yaml');

  const catalog = loadCatalog();
  const rng = mulberry32(hashSeed(args.seed));

  registerSecretValues(Object.values(DEMO_ENV));

  if (!args.quiet) console.log('tollwise demo: starting five local mock providers ...');
  const mocks = await startMockProviders(catalog);

  const config = buildDemoConfig(demoConfigPath, mocks, args);
  const logger = createLogger({ level: args.quiet ? 'warn' : config.logging.level, sink: process.stderr });
  const registry = buildRegistry(config, DEMO_ENV);
  const healthMonitor: HealthMonitor = createHealthMonitor({ adapters: registry.enabled, env: DEMO_ENV, logger });

  const analyticsFile = path.resolve(repoRoot, config.analytics.path);
  const analytics: EventStore = openSqliteEventStore({ file: analyticsFile, logger });
  const detachAnalytics = onRequestOutcome((outcome) => analytics.record(outcome));

  const server = createTollwiseServer({
    maxBodyBytes: config.server.max_body_size,
    logger,
    healthMonitor,
    allowedHosts: config.server.allowed_hosts,
    listenHost: config.server.host,
    proxy: { config, catalog, registry, env: DEMO_ENV },
    analytics,
  });

  const closeMocks = () =>
    Promise.all([
      mocks.anthropicFront.close(),
      mocks.anthropic.close(),
      mocks.openai.close(),
      mocks.deepseek.close(),
      mocks.openrouter.close(),
      mocks.ollama.close(),
    ]);

  const listenPort = args.port ?? config.server.port;
  let address: import('node:net').AddressInfo;
  try {
    address = await listen(server, config.server.host, listenPort);
  } catch (error) {
    await closeMocks();
    throw error;
  }
  const tollwiseUrl = baseUrl(config.server.host, address.port);
  healthMonitor.start();

  let closed = false;
  const shutdown = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    healthMonitor.stop();
    detachAnalytics();
    await stopServer(server, 2000);
    await analytics.close();
    await closeMocks();
  };

  let interrupted = false;
  const onSignal = (): void => {
    interrupted = true;
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  console.log(`tollwise demo: proxy ready at ${tollwiseUrl}`);
  console.log(`tollwise demo: dashboard at ${tollwiseUrl}/dashboard`);
  if (!args.quiet) console.log(`tollwise demo: analytics stored at ${analyticsFile}`);
  console.log(
    args.count === undefined
      ? 'tollwise demo: sending traffic until Ctrl+C ...'
      : `tollwise demo: sending ${args.count} request(s) ...`,
  );

  let sent = 0;
  const order = shuffledScenarioOrder(rng);
  try {
    while (!interrupted && (args.count === undefined || sent < args.count)) {
      const scenario = order[sent % order.length] as Scenario;
      await sendOne(tollwiseUrl, scenario, rng, sent, args.quiet);
      sent += 1;
      if (args.count === undefined && !interrupted) await delay(SEND_INTERVAL_MS);
    }
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await shutdown();
  }
  console.log(`tollwise demo: sent ${sent} request(s); stopped cleanly.`);
}

main().catch((error: unknown) => {
  console.error(`tollwise demo: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exitCode = 1;
});
