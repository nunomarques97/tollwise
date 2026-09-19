// Per-request cost headers (x-tollwise-cost-*) and the RequestOutcome event, across both wire
// formats and translation between them, streaming and not, served, passed through, fallen back,
// failed, cut short and refused, reported and estimated usage, and a listener that throws.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import { openSqliteEventStore } from '../src/analytics/store.ts';
import type { Catalog, ModelEntry } from '../src/catalog/schema.ts';
import { type Config, type ConfigInput, ConfigSchema, type ProviderId } from '../src/config/schema.ts';
import { createLogger } from '../src/log/logger.ts';
import { estimateInput } from '../src/pricing/estimate.ts';
import { buildRegistry } from '../src/providers/registry.ts';
import { MAX_USAGE_BODY_BYTES } from '../src/proxy/forward.ts';
import {
  clearRequestOutcomeListeners,
  onRequestOutcome,
  REQUEST_OUTCOME_KEYS,
  type RequestOutcome,
} from '../src/proxy/outcome.ts';
import { expectedOutputTokens } from '../src/routing/select.ts';
import { baseUrl, createTollwiseServer, listen, stopServer } from '../src/server/server.ts';
import { FAKE_KEYS } from './fixtures/fake-keys.ts';
import { send, type TestResponse } from './fixtures/http-client.ts';
import { type MockProvider, type StartMockProviderOptions, startMockProvider } from './fixtures/mock-provider.ts';

// Fake credentials with no known key shape; none of them is a real key.
const FAKE_OPENAI_KEY = `fakeOpenai${'Oa1'.repeat(6)}`;
const FAKE_OPENROUTER_KEY = `fakeRouter${'Or2'.repeat(6)}`;
const FAKE_ANTHROPIC_KEY = `fakeClaude${'An4'.repeat(6)}`;
const ENV = {
  OPENAI_API_KEY: FAKE_OPENAI_KEY,
  OPENROUTER_API_KEY: FAKE_OPENROUTER_KEY,
  ANTHROPIC_API_KEY: FAKE_ANTHROPIC_KEY,
};

const CAPS = { tools: true, json_mode: true, vision: true, streaming: true };
const VERIFIED_ON = '2026-09-01';

function entry(
  provider: ProviderId,
  model: string,
  canonical: string,
  input: number,
  output: number,
  capabilities: ModelEntry['capabilities'] = CAPS,
): ModelEntry {
  return {
    provider,
    model,
    canonical_model: canonical,
    price: { input, output, cached_input: null },
    context_window: 128_000,
    max_output: 16_000,
    capabilities,
    source_url: 'https://example.com/pricing',
    verified_on: VERIFIED_ON,
  };
}

/**
 * - gpt-x: openai (dearer, the only entry named exactly "gpt-x", so it is the savings baseline) and
 *   openrouter (cheaper, named "openai/gpt-x"): a routed request goes to openrouter.
 * - claude-x: anthropic only, so its own price is both the used and the baseline one (savings 0).
 * - gpt-y: requested only by its canonical id, which is not any entry's own model id, so
 *   selectBaselineEntry() finds no entry named exactly "gpt-y": cost is known, baseline is not.
 * - claude-z: anthropic (dearer, the baseline) and openrouter (cheaper): an Anthropic-format request
 *   is translated to the OpenAI format and served by openrouter.
 * - oa-z: openai (dearer, the baseline) and anthropic (cheaper): an OpenAI-format request is
 *   translated to the Anthropic format and served by anthropic.
 * - plain-x: openai only, without tool support: a request with tools has no capable provider.
 */
const CATALOG: Catalog = {
  models: [
    entry('openai', 'gpt-x', 'gpt-x', 10, 50),
    entry('openrouter', 'openai/gpt-x', 'gpt-x', 2, 8),
    entry('anthropic', 'claude-x', 'claude-x', 1, 5),
    entry('openai', 'openai-gpt-y-v1', 'gpt-y', 10, 50),
    entry('openrouter', 'openrouter-gpt-y-v1', 'gpt-y', 2, 8),
    entry('anthropic', 'claude-z', 'claude-z', 10, 50),
    entry('openrouter', 'anthropic/claude-z', 'claude-z', 2, 8),
    entry('openai', 'oa-z', 'oa-z', 10, 50),
    entry('anthropic', 'anthropic-oa-z', 'oa-z', 1, 5),
    entry('openai', 'plain-x', 'plain-x', 1, 1, { ...CAPS, tools: false }),
  ],
};

const JSON_TYPE = { 'content-type': 'application/json' } as const;
const MESSAGES_HEADERS = { ...JSON_TYPE, 'anthropic-version': '2023-06-01' } as const;
const HELLO = [{ role: 'user', content: 'Say hello.' }];
const NEEDS_NOTHING = { tools: false, json_mode: false, vision: false, streaming: false };

interface Proxy {
  readonly url: string;
  readonly openai: MockProvider;
  readonly openrouter: MockProvider;
  readonly anthropic: MockProvider;
  close(): Promise<void>;
}

interface ProxyOptions {
  readonly routing?: ConfigInput['routing'];
  readonly mocks?: Partial<Record<'openai' | 'openrouter' | 'anthropic', StartMockProviderOptions>>;
}

async function startProxy(options: ProxyOptions = {}): Promise<Proxy> {
  const openai = await startMockProvider(options.mocks?.openai ?? {});
  const openrouter = await startMockProvider(options.mocks?.openrouter ?? {});
  const anthropic = await startMockProvider(options.mocks?.anthropic ?? {});
  const config: Config = ConfigSchema.parse({
    providers: {
      openai: { base_url: `${openai.url}/v1` },
      openrouter: { base_url: `${openrouter.url}/v1` },
      anthropic: { base_url: anthropic.url },
      deepseek: { enabled: false },
      ollama: { enabled: false },
    },
    routing: options.routing ?? {},
  } satisfies ConfigInput);
  const server: Server = createTollwiseServer({
    maxBodyBytes: 64 * 1024,
    logger: createLogger({ sink: { write: () => true } }),
    proxy: { config, catalog: CATALOG, registry: buildRegistry(config, ENV), env: ENV },
  });
  const address = await listen(server, '127.0.0.1', 0);
  return {
    url: baseUrl('127.0.0.1', address.port),
    openai,
    openrouter,
    anthropic,
    async close() {
      await stopServer(server, 100);
      await Promise.all([openai.close(), openrouter.close(), anthropic.close()]);
    },
  };
}

function chat(proxy: Proxy, body: Record<string, unknown>): Promise<TestResponse> {
  return send(proxy.url, '/v1/chat/completions', { method: 'POST', headers: JSON_TYPE, body: JSON.stringify(body) });
}

function messages(proxy: Proxy, body: Record<string, unknown>): Promise<TestResponse> {
  return send(proxy.url, '/v1/messages', { method: 'POST', headers: MESSAGES_HEADERS, body: JSON.stringify(body) });
}

interface StreamedResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  /** True when the response body ended normally, false when it was cut. */
  readonly complete: boolean;
}

/** POSTs a streamed chat request and reads the response to its end, normal or cut. */
function streamChat(proxy: Proxy, body: Record<string, unknown>): Promise<StreamedResponse> {
  const url = new URL(proxy.url);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: url.hostname,
        port: url.port,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: { ...JSON_TYPE, connection: 'close' },
      },
      (res) => {
        let settled = false;
        const finish = (complete: boolean): void => {
          if (settled) return;
          settled = true;
          resolve({ status: res.statusCode ?? 0, headers: res.headers, complete });
        };
        res.resume();
        res.on('end', () => finish(true));
        res.on('aborted', () => finish(false));
        res.on('error', () => finish(false));
        res.on('close', () => finish(res.complete));
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

/** Registers a listener for exactly one test, capturing every RequestOutcome emitted while it runs. */
function captureOutcomes(): { readonly outcomes: RequestOutcome[]; stop(): void } {
  const outcomes: RequestOutcome[] = [];
  const stop = onRequestOutcome((outcome) => outcomes.push(outcome));
  return { outcomes, stop };
}

async function waitFor(check: () => boolean, message: string): Promise<void> {
  const deadline = performance.now() + 2000;
  while (!check()) {
    if (performance.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Waits for the first outcome, then a little longer, and checks that it is the only one emitted. */
async function onlyOutcome(outcomes: readonly RequestOutcome[]): Promise<RequestOutcome> {
  await waitFor(() => outcomes.length >= 1, 'no outcome emitted');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(outcomes.length, 1, 'exactly one outcome per request');
  return outcomes[0] as RequestOutcome;
}

const COST_HEADER_NAMES = [
  'x-tollwise-cost-usd',
  'x-tollwise-savings-usd',
  'x-tollwise-cost-origin',
  'x-tollwise-price-verified-on',
] as const;

function assertNoCostHeaders(res: { readonly headers: IncomingHttpHeaders }): void {
  for (const header of COST_HEADER_NAMES) assert.equal(res.headers[header], undefined, `${header} must not be set`);
}

describe('cost headers and the request outcome event', () => {
  let proxy: Proxy;
  before(async () => {
    proxy = await startProxy();
  });
  after(async () => {
    await proxy.close();
  });
  afterEach(() => {
    clearRequestOutcomeListeners();
  });

  test('RequestOutcome carries exactly its documented fields: no prompt, response, header or URL', async () => {
    const capture = captureOutcomes();
    try {
      const res = await chat(proxy, { model: 'gpt-x', messages: HELLO });
      assert.equal(res.status, 200);
      await waitFor(() => capture.outcomes.length === 1, 'no outcome emitted');
      const [outcome] = capture.outcomes;
      assert.ok(outcome !== undefined);
      assert.deepEqual(Object.keys(outcome).sort(), [...REQUEST_OUTCOME_KEYS].sort());
      // gpt-x served by another provider of the same model: no substitution, here or in the trace.
      assert.equal(outcome.substitution, null);
      assert.deepEqual(
        outcome.trace.map((attempt) => attempt.substitution),
        [null],
      );
      // The message content, any header name and the mock's URL never appear anywhere in the event.
      const serialised = JSON.stringify(outcome);
      for (const forbidden of ['Say hello', 'authorization', proxy.openrouter.url, 'x-tollwise']) {
        assert.ok(!serialised.includes(forbidden), `outcome must not contain ${forbidden}`);
      }
    } finally {
      capture.stop();
    }
  });

  test('a non-streamed OpenAI-format request routed to a cheaper provider: headers and outcome agree on the cost', async () => {
    const capture = captureOutcomes();
    try {
      const res = await chat(proxy, { model: 'gpt-x', messages: HELLO });
      assert.equal(res.status, 200);
      assert.equal(res.headers['x-tollwise-provider'], 'openrouter');
      // Mock usage: prompt_tokens 10, completion_tokens 5. Used (openrouter, 2/8): 10*2+5*8=60.
      // Baseline (openai, the only entry named exactly "gpt-x", 10/50): 10*10+5*50=350. Savings 290.
      assert.equal(res.headers['x-tollwise-cost-usd'], '0.000060');
      assert.equal(res.headers['x-tollwise-savings-usd'], '0.000290');
      assert.equal(res.headers['x-tollwise-cost-origin'], 'reported');
      assert.equal(res.headers['x-tollwise-price-verified-on'], VERIFIED_ON);

      await waitFor(() => capture.outcomes.length === 1, 'no outcome emitted');
      const [outcome] = capture.outcomes as [RequestOutcome];
      assert.equal(outcome.requestId, res.headers['x-tollwise-request-id']);
      assert.equal(outcome.format, 'openai');
      assert.equal(outcome.requestedModel, 'gpt-x');
      assert.equal(outcome.requestedProvider, 'openai');
      assert.equal(outcome.usedModel, 'openai/gpt-x');
      assert.equal(outcome.usedProvider, 'openrouter');
      assert.deepEqual(outcome.needs, NEEDS_NOTHING);
      assert.equal(outcome.policy, 'cheapest');
      assert.equal(outcome.decision, 'routed');
      assert.equal(outcome.attempts, 1);
      assert.equal(outcome.trace.length, 1);
      assert.deepEqual(outcome.usage, { input: 10, cached_input: 0, output: 5, origin: 'reported' });
      assert.ok(outcome.cost !== null);
      assert.equal(outcome.cost.cost_usd, '0.000060');
      assert.equal(outcome.cost.savings_usd, '0.000290');
      assert.equal(outcome.cost.origin, 'reported');
      assert.equal(outcome.status, 'complete');
      assert.equal(outcome.firstByteMs, null);
      assert.ok(Number.isInteger(outcome.latencyMs) && outcome.latencyMs >= 0);
      assert.match(outcome.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    } finally {
      capture.stop();
    }
  });

  test('a non-streamed Anthropic-format request served by its only entry: cost equals baseline, savings zero', async () => {
    const capture = captureOutcomes();
    try {
      const res = await messages(proxy, { model: 'claude-x', max_tokens: 64, messages: HELLO });
      assert.equal(res.status, 200);
      // Mock usage: input_tokens 10, output_tokens 5, priced at 1/5: 10*1+5*5=35.
      assert.equal(res.headers['x-tollwise-cost-usd'], '0.000035');
      assert.equal(res.headers['x-tollwise-savings-usd'], '0.000000');
      assert.equal(res.headers['x-tollwise-cost-origin'], 'reported');
      assert.equal(res.headers['x-tollwise-price-verified-on'], VERIFIED_ON);

      await waitFor(() => capture.outcomes.length === 1, 'no outcome emitted');
      const [outcome] = capture.outcomes as [RequestOutcome];
      assert.equal(outcome.format, 'anthropic');
      assert.equal(outcome.requestedProvider, 'anthropic');
      assert.equal(outcome.usedProvider, 'anthropic');
      assert.deepEqual(outcome.usage, { input: 10, cached_input: 0, output: 5, origin: 'reported' });
      assert.ok(outcome.cost !== null);
      assert.equal(outcome.cost.cost_usd, '0.000035');
      assert.equal(outcome.cost.savings_usd, '0.000000');
    } finally {
      capture.stop();
    }
  });

  test('a streamed response carries no cost header; the outcome carries the numbers instead', async () => {
    const capture = captureOutcomes();
    try {
      const res = await chat(proxy, { model: 'gpt-x', messages: HELLO, stream: true });
      assert.equal(res.status, 200);
      assert.match(String(res.headers['content-type']), /^text\/event-stream/);
      for (const header of ['x-tollwise-cost-usd', 'x-tollwise-savings-usd', 'x-tollwise-cost-origin']) {
        assert.equal(res.headers[header], undefined, `${header} must not be set on a streamed response`);
      }

      await waitFor(() => capture.outcomes.length === 1, 'no outcome emitted');
      const [outcome] = capture.outcomes as [RequestOutcome];
      assert.equal(outcome.status, 'complete');
      assert.ok(outcome.firstByteMs !== null && Number.isInteger(outcome.firstByteMs) && outcome.firstByteMs >= 0);
      assert.deepEqual(outcome.usage, { input: 10, cached_input: 0, output: 5, origin: 'reported' });
      assert.ok(outcome.cost !== null);
      assert.equal(outcome.cost.cost_usd, '0.000060');
    } finally {
      capture.stop();
    }
  });

  test('a streamed Anthropic response also reports its usage and cost only on the outcome', async () => {
    const capture = captureOutcomes();
    try {
      const res = await messages(proxy, { model: 'claude-x', max_tokens: 64, messages: HELLO, stream: true });
      assert.equal(res.status, 200);
      assert.equal(res.headers['x-tollwise-cost-usd'], undefined);

      await waitFor(() => capture.outcomes.length === 1, 'no outcome emitted');
      const [outcome] = capture.outcomes as [RequestOutcome];
      assert.ok(outcome.firstByteMs !== null && outcome.firstByteMs >= 0);
      assert.deepEqual(outcome.usage, { input: 10, cached_input: 0, output: 5, origin: 'reported' });
    } finally {
      capture.stop();
    }
  });

  test('a passthrough to a model with no catalog price reports usage but no cost, and "unknown" cost headers', async () => {
    const capture = captureOutcomes();
    try {
      const res = await chat(proxy, { model: 'unlisted-model', messages: HELLO });
      assert.equal(res.status, 200);
      assert.equal(res.headers['x-tollwise-routed'], 'false');
      assert.equal(res.headers['x-tollwise-cost-usd'], 'unknown');
      assert.equal(res.headers['x-tollwise-savings-usd'], 'unknown');
      // The usage itself is known (the provider reported it); only its price is not.
      assert.equal(res.headers['x-tollwise-cost-origin'], 'reported');
      assert.equal(res.headers['x-tollwise-price-verified-on'], 'unknown');

      await waitFor(() => capture.outcomes.length === 1, 'no outcome emitted');
      const [outcome] = capture.outcomes as [RequestOutcome];
      assert.equal(outcome.decision, 'passthrough');
      assert.equal(outcome.requestedProvider, 'openai');
      // The mock still reports usage; there is simply no price for this model/provider pair.
      assert.deepEqual(outcome.usage, { input: 10, cached_input: 0, output: 5, origin: 'reported' });
      assert.equal(outcome.cost, null);
    } finally {
      capture.stop();
    }
  });

  test('a known cost with an unknown baseline reports savings as "unknown", never 0', async () => {
    const capture = captureOutcomes();
    try {
      // "gpt-y" is a canonical id, not any entry's own model id: selectBaselineEntry() finds nothing
      // named exactly "gpt-y", even though routing itself finds real, priced candidates for it.
      const res = await chat(proxy, { model: 'gpt-y', messages: HELLO });
      assert.equal(res.status, 200);
      assert.equal(res.headers['x-tollwise-provider'], 'openrouter');
      assert.equal(res.headers['x-tollwise-cost-usd'], '0.000060');
      assert.equal(res.headers['x-tollwise-savings-usd'], 'unknown');
      assert.equal(res.headers['x-tollwise-cost-origin'], 'reported');
      assert.equal(res.headers['x-tollwise-price-verified-on'], VERIFIED_ON);

      await waitFor(() => capture.outcomes.length === 1, 'no outcome emitted');
      const [outcome] = capture.outcomes as [RequestOutcome];
      assert.equal(outcome.requestedProvider, 'openai');
      assert.ok(outcome.cost !== null);
      assert.equal(outcome.cost.cost_usd, '0.000060');
      assert.equal(outcome.cost.baseline_usd, 'unknown');
      assert.equal(outcome.cost.savings_usd, 'unknown');
      assert.notEqual(outcome.cost.savings_usd, 0);
    } finally {
      capture.stop();
    }
  });

  test('a translated non-streamed Anthropic-format request carries the cost headers of the provider that served it', async () => {
    const capture = captureOutcomes();
    try {
      const res = await messages(proxy, { model: 'claude-z', max_tokens: 64, messages: HELLO });
      assert.equal(res.status, 200);
      assert.equal(res.headers['x-tollwise-translated'], 'true');
      assert.equal(res.headers['x-tollwise-provider'], 'openrouter');
      // Mock OpenAI usage: 10 in, 5 out. Used (openrouter, 2/8): 60. Baseline (anthropic, 10/50): 350.
      assert.equal(res.headers['x-tollwise-cost-usd'], '0.000060');
      assert.equal(res.headers['x-tollwise-savings-usd'], '0.000290');
      assert.equal(res.headers['x-tollwise-cost-origin'], 'reported');
      assert.equal(res.headers['x-tollwise-price-verified-on'], VERIFIED_ON);
      assert.equal((res.json as { type: string }).type, 'message');

      const outcome = await onlyOutcome(capture.outcomes);
      assert.equal(outcome.format, 'anthropic');
      assert.equal(outcome.requestedModel, 'claude-z');
      assert.equal(outcome.requestedProvider, 'anthropic');
      assert.equal(outcome.usedModel, 'anthropic/claude-z');
      assert.equal(outcome.usedProvider, 'openrouter');
      assert.equal(outcome.decision, 'routed');
      assert.equal(outcome.status, 'complete');
      assert.deepEqual(outcome.usage, { input: 10, cached_input: 0, output: 5, origin: 'reported' });
      assert.equal(outcome.cost?.cost_usd, '0.000060');
      assert.equal(outcome.cost?.savings_usd, '0.000290');
    } finally {
      capture.stop();
    }
  });

  test('a translated non-streamed OpenAI-format request carries the cost headers of the provider that served it', async () => {
    const capture = captureOutcomes();
    try {
      const res = await chat(proxy, { model: 'oa-z', max_tokens: 64, messages: HELLO });
      assert.equal(res.status, 200);
      assert.equal(res.headers['x-tollwise-translated'], 'true');
      assert.equal(res.headers['x-tollwise-provider'], 'anthropic');
      // Mock Anthropic usage: 10 in, 5 out. Used (anthropic, 1/5): 35. Baseline (openai, 10/50): 350.
      assert.equal(res.headers['x-tollwise-cost-usd'], '0.000035');
      assert.equal(res.headers['x-tollwise-savings-usd'], '0.000315');
      assert.equal(res.headers['x-tollwise-cost-origin'], 'reported');
      assert.equal(res.headers['x-tollwise-price-verified-on'], VERIFIED_ON);
      assert.equal((res.json as { object: string }).object, 'chat.completion');

      const outcome = await onlyOutcome(capture.outcomes);
      assert.equal(outcome.format, 'openai');
      assert.equal(outcome.requestedProvider, 'openai');
      assert.equal(outcome.usedModel, 'anthropic-oa-z');
      assert.equal(outcome.usedProvider, 'anthropic');
      assert.equal(outcome.status, 'complete');
      assert.equal(outcome.cost?.cost_usd, '0.000035');
      assert.equal(outcome.cost?.savings_usd, '0.000315');
    } finally {
      capture.stop();
    }
  });

  test('a listener that throws never breaks the request, and every other listener still runs', async () => {
    const seen: RequestOutcome[] = [];
    const stopThrowing = onRequestOutcome(() => {
      throw new Error('a broken analytics listener');
    });
    const stopOther = onRequestOutcome((outcome) => seen.push(outcome));
    try {
      const res = await chat(proxy, { model: 'gpt-x', messages: HELLO });
      assert.equal(res.status, 200);
      await waitFor(() => seen.length === 1, 'the other listener never ran');
      assert.equal(seen[0]?.status, 'complete');
    } finally {
      stopThrowing();
      stopOther();
    }
  });

  test('an async listener whose promise rejects causes no unhandled rejection, and the next request is still served', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    let calls = 0;
    const stopRejecting = onRequestOutcome(async () => {
      calls += 1;
      throw new Error('a broken async analytics listener');
    });
    const capture = captureOutcomes();
    try {
      const first = await chat(proxy, { model: 'gpt-x', messages: HELLO });
      assert.equal(first.status, 200);
      await waitFor(() => capture.outcomes.length === 1, 'no outcome emitted for the first request');
      // Let the rejected promise settle and any unhandled-rejection report fire.
      await new Promise((resolve) => setTimeout(resolve, 50));

      const second = await chat(proxy, { model: 'gpt-x', messages: HELLO });
      assert.equal(second.status, 200);
      assert.equal(second.headers['x-tollwise-cost-usd'], '0.000060');
      await waitFor(() => capture.outcomes.length === 2, 'no outcome emitted for the second request');
      await new Promise((resolve) => setTimeout(resolve, 50));

      assert.equal(calls, 2, 'the async listener ran for both requests');
      assert.deepEqual(unhandled, []);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      stopRejecting();
      capture.stop();
    }
  });

  test('a key pasted into the model field never reaches any string in the outcome', async () => {
    // Not in the catalog, so the default passthrough sends it unchanged to the format's own provider:
    // it is the requested model, the used model and the trace attempt's model all at once.
    const pastedKey = FAKE_KEYS['OpenAI API key']?.text;
    assert.ok(pastedKey !== undefined);
    const capture = captureOutcomes();
    try {
      const res = await chat(proxy, { model: pastedKey, messages: HELLO });
      assert.equal(res.status, 200);

      const outcome = await onlyOutcome(capture.outcomes);
      assert.equal(outcome.decision, 'passthrough');
      assert.equal(outcome.usedProvider, 'openai');
      assert.equal(outcome.requestedModel, '[REDACTED]');
      assert.equal(outcome.usedModel, '[REDACTED]');
      assert.deepEqual(
        outcome.trace.map((attempt) => attempt.model),
        ['[REDACTED]'],
      );
      const strings: string[] = [];
      const collect = (value: unknown): void => {
        if (typeof value === 'string') strings.push(value);
        else if (Array.isArray(value)) for (const item of value) collect(item);
        else if (typeof value === 'object' && value !== null) for (const item of Object.values(value)) collect(item);
      };
      collect(outcome);
      assert.ok(strings.length > 0);
      for (const text of strings) assert.ok(!text.includes(pastedKey), 'no string field carries the pasted key');
      assert.ok(!JSON.stringify(outcome).includes(pastedKey));
    } finally {
      capture.stop();
    }
  });

  test('a key pasted into the model of a refused request is masked in the outcome too', async () => {
    const pastedKey = FAKE_KEYS['Anthropic API key']?.text;
    assert.ok(pastedKey !== undefined);
    const refusing = await startProxy({ routing: { on_no_candidate: 'fail' } });
    const capture = captureOutcomes();
    try {
      const res = await messages(refusing, { model: pastedKey, max_tokens: 64, messages: HELLO });
      assert.equal(res.status, 422);
      const outcome = await onlyOutcome(capture.outcomes);
      assert.equal(outcome.status, 'refused');
      assert.equal(outcome.requestedModel, '[REDACTED]');
      assert.equal(outcome.usedModel, null);
      assert.ok(!JSON.stringify(outcome).includes(pastedKey));
    } finally {
      capture.stop();
      await refusing.close();
    }
  });
});

/** A valid completion, with usage, larger than the body Tollwise holds back to read its usage. */
const BIG_PAYLOAD = JSON.stringify({
  id: 'chatcmpl-big',
  object: 'chat.completion',
  choices: [
    { index: 0, message: { role: 'assistant', content: 'x'.repeat(MAX_USAGE_BODY_BYTES + 1) }, finish_reason: 'stop' },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

describe('cost headers when a provider reports no usage, or a body too large to hold', () => {
  let fake: Server;
  let proxy: Server;
  let proxyUrl: string;

  before(async () => {
    fake = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const { model } = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model: string };
        if (model === 'cut-model') {
          // Head and part of a small JSON body, then the connection dies: the proxy is still holding it.
          res.writeHead(200, { 'content-type': 'application/json', 'content-length': 4096 });
          res.write('{"id":"chatcmpl-cut","object":"chat.completion","choices":[');
          setTimeout(() => res.destroy(), 20);
          return;
        }
        if (model === 'big-model') {
          res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(BIG_PAYLOAD) });
          res.end(BIG_PAYLOAD);
          return;
        }
        const payload = JSON.stringify({
          id: 'chatcmpl-no-usage',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        });
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
        res.end(payload);
      });
    });
    const port = (await listen(fake, '127.0.0.1', 0)).port;
    const catalog: Catalog = {
      models: [
        entry('openai', 'no-usage-model', 'no-usage-model', 4, 16),
        entry('openai', 'big-model', 'big-model', 4, 16),
        entry('openai', 'cut-model', 'cut-model', 4, 16),
      ],
    };
    const config: Config = ConfigSchema.parse({
      providers: {
        openai: { base_url: `http://127.0.0.1:${port}` },
        openrouter: { enabled: false },
        anthropic: { enabled: false },
        deepseek: { enabled: false },
        ollama: { enabled: false },
      },
    } satisfies ConfigInput);
    proxy = createTollwiseServer({
      maxBodyBytes: 64 * 1024,
      logger: createLogger({ sink: { write: () => true } }),
      proxy: { config, catalog, registry: buildRegistry(config, ENV), env: ENV },
    });
    proxyUrl = baseUrl('127.0.0.1', (await listen(proxy, '127.0.0.1', 0)).port);
  });
  after(async () => {
    await stopServer(proxy, 100);
    await stopServer(fake, 100);
  });
  afterEach(() => {
    clearRequestOutcomeListeners();
  });

  test('usage and cost fall back to the pre-call estimate, labelled "estimated"', async () => {
    const capture = captureOutcomes();
    const body = { model: 'no-usage-model', messages: HELLO };
    try {
      const res = await send(proxyUrl, '/v1/chat/completions', {
        method: 'POST',
        headers: JSON_TYPE,
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers['x-tollwise-cost-origin'], 'estimated');
      assert.notEqual(res.headers['x-tollwise-cost-usd'], undefined);
      assert.notEqual(res.headers['x-tollwise-cost-usd'], 'unknown');

      await waitFor(() => capture.outcomes.length === 1, 'no outcome emitted');
      const [outcome] = capture.outcomes as [RequestOutcome];
      const expectedInput = estimateInput('openai', body).tokens;
      const expectedOutput = expectedOutputTokens(null, entry('openai', 'no-usage-model', 'no-usage-model', 4, 16));
      assert.deepEqual(outcome.usage, {
        input: expectedInput,
        cached_input: 0,
        output: expectedOutput,
        origin: 'estimated',
      });
      assert.ok(outcome.cost !== null);
      assert.equal(outcome.cost.origin, 'estimated');
    } finally {
      capture.stop();
    }
  });

  test('a body larger than the hold limit is forwarded whole as it arrives, without cost headers', async () => {
    const capture = captureOutcomes();
    try {
      const res = await send(proxyUrl, '/v1/chat/completions', {
        method: 'POST',
        headers: JSON_TYPE,
        body: JSON.stringify({ model: 'big-model', messages: HELLO }),
      });
      assert.equal(res.status, 200);
      assert.equal(res.text, BIG_PAYLOAD, 'every byte reaches the client unchanged');
      assertNoCostHeaders(res);

      const outcome = await onlyOutcome(capture.outcomes);
      assert.equal(outcome.status, 'complete');
      // The usage report sits past the hold limit and is not read: the outcome falls back to the
      // pre-call estimate, labelled as such, rather than claiming a reported count.
      assert.equal(outcome.usage?.origin, 'estimated');
      assert.equal(outcome.cost?.origin, 'estimated');
    } finally {
      capture.stop();
    }
  });

  test('a non-streamed answer cut while still held back closes the connection: one interrupted outcome, no cost', async () => {
    const capture = captureOutcomes();
    try {
      // Nothing was sent to the client yet, so it gets no response at all rather than a partial one.
      await assert.rejects(
        send(proxyUrl, '/v1/chat/completions', {
          method: 'POST',
          headers: JSON_TYPE,
          body: JSON.stringify({ model: 'cut-model', messages: HELLO }),
        }),
        (error: NodeJS.ErrnoException) => error.code === 'ECONNRESET' || /socket hang up/.test(error.message),
      );

      const outcome = await onlyOutcome(capture.outcomes);
      assert.equal(outcome.status, 'interrupted');
      assert.equal(outcome.decision, 'routed');
      assert.equal(outcome.usedProvider, 'openai');
      assert.equal(outcome.usedModel, 'cut-model');
      assert.equal(outcome.attempts, 1);
      assert.equal(outcome.firstByteMs, null, 'a non-streamed response has no first-byte time');
      // Unfinished: nothing is estimated or billed for it.
      assert.equal(outcome.usage, null);
      assert.equal(outcome.cost, null);
    } finally {
      capture.stop();
    }
  });
});

describe('the request outcome event on failure paths', () => {
  afterEach(() => {
    clearRequestOutcomeListeners();
  });

  test('a retried provider error falls back: one outcome, two attempts in the trace', async () => {
    const proxy = await startProxy({ mocks: { openrouter: { failWith: { status: 500 } } } });
    const capture = captureOutcomes();
    try {
      const res = await chat(proxy, { model: 'gpt-x', messages: HELLO });
      assert.equal(res.status, 200);
      assert.equal(res.headers['x-tollwise-provider'], 'openai');
      assert.equal(res.headers['x-tollwise-attempts'], '2');
      // openrouter answers 500, a retried server error. Served by openai (10/50) on 10 in, 5 out: 350, which is also the baseline, so no savings.
      assert.equal(res.headers['x-tollwise-cost-usd'], '0.000350');
      assert.equal(res.headers['x-tollwise-savings-usd'], '0.000000');

      const outcome = await onlyOutcome(capture.outcomes);
      assert.equal(outcome.status, 'complete');
      assert.equal(outcome.decision, 'routed');
      assert.equal(outcome.usedProvider, 'openai');
      assert.equal(outcome.usedModel, 'gpt-x');
      assert.equal(outcome.attempts, 2);
      assert.deepEqual(
        outcome.trace.map((attempt) => [attempt.provider, attempt.model, attempt.outcome, attempt.status]),
        [
          ['openrouter', 'openai/gpt-x', 'server', 500],
          ['openai', 'gpt-x', 'ok', 200],
        ],
      );
      assert.deepEqual(outcome.usage, { input: 10, cached_input: 0, output: 5, origin: 'reported' });
      assert.equal(outcome.cost?.cost_usd, '0.000350');
    } finally {
      capture.stop();
      await proxy.close();
    }
  });

  test('every attempt failing is a 502 with one provider_error outcome and no usage or cost', async () => {
    const proxy = await startProxy({
      mocks: { openrouter: { failWith: { status: 500 } }, openai: { failWith: { status: 529 } } },
    });
    const capture = captureOutcomes();
    try {
      const res = await chat(proxy, { model: 'gpt-x', messages: HELLO });
      assert.equal(res.status, 502);
      assert.equal((res.json as { error: { code: string } }).error.code, 'all_providers_failed');
      assertNoCostHeaders(res);

      const outcome = await onlyOutcome(capture.outcomes);
      assert.equal(outcome.status, 'provider_error');
      assert.equal(outcome.decision, 'routed');
      assert.equal(outcome.usedProvider, 'openai', 'the last provider tried');
      assert.equal(outcome.attempts, 2);
      assert.deepEqual(
        outcome.trace.map((attempt) => [attempt.provider, attempt.outcome, attempt.status]),
        [
          ['openrouter', 'server', 500],
          ['openai', 'overloaded', 529],
        ],
      );
      assert.equal(outcome.usage, null);
      assert.equal(outcome.cost, null);
      assert.equal(outcome.firstByteMs, null);
    } finally {
      capture.stop();
      await proxy.close();
    }
  });

  test('a provider error that is not retried keeps its status: one outcome, one attempt, no cost', async () => {
    const proxy = await startProxy({ mocks: { openrouter: { failWith: { status: 400 } } } });
    const capture = captureOutcomes();
    try {
      const res = await chat(proxy, { model: 'gpt-x', messages: HELLO });
      assert.equal(res.status, 400);
      assertNoCostHeaders(res);
      assert.equal(proxy.openai.requests.length, 0, 'never retried elsewhere');

      const outcome = await onlyOutcome(capture.outcomes);
      assert.equal(outcome.status, 'provider_error');
      assert.equal(outcome.usedProvider, 'openrouter');
      assert.equal(outcome.attempts, 1);
      assert.deepEqual(
        outcome.trace.map((attempt) => [attempt.provider, attempt.outcome, attempt.status]),
        [['openrouter', 'bad_request', 400]],
      );
      assert.equal(outcome.usage, null);
      assert.equal(outcome.cost, null);
    } finally {
      capture.stop();
      await proxy.close();
    }
  });

  test('a stream cut short by the provider is one interrupted outcome with a first-byte time and no cost', async () => {
    const proxy = await startProxy({ mocks: { openrouter: { dropMidStream: true } } });
    const capture = captureOutcomes();
    try {
      const res = await streamChat(proxy, { model: 'gpt-x', messages: HELLO, stream: true });
      assert.equal(res.status, 200);
      assert.equal(res.complete, false, 'the client sees the stream end early');
      assertNoCostHeaders(res);

      const outcome = await onlyOutcome(capture.outcomes);
      assert.equal(outcome.status, 'interrupted');
      assert.equal(outcome.usedProvider, 'openrouter');
      assert.equal(outcome.attempts, 1);
      assert.ok(outcome.firstByteMs !== null && outcome.firstByteMs >= 0);
      assert.ok(outcome.latencyMs >= outcome.firstByteMs);
      // Cut before the provider reported any usage: nothing is estimated for an unfinished answer.
      assert.equal(outcome.usage, null);
      assert.equal(outcome.cost, null);
    } finally {
      capture.stop();
      await proxy.close();
    }
  });

  test('a request no provider can serve with the capabilities it needs is refused: one "fail" outcome', async () => {
    const proxy = await startProxy({ routing: { on_no_candidate: 'fail' } });
    const capture = captureOutcomes();
    try {
      const tools = [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }];
      const res = await chat(proxy, { model: 'plain-x', messages: HELLO, tools });
      assert.equal(res.status, 422);
      assert.equal((res.json as { error: { code: string } }).error.code, 'no_capable_provider');
      assertNoCostHeaders(res);
      for (const mock of [proxy.openai, proxy.openrouter, proxy.anthropic]) assert.equal(mock.requests.length, 0);

      const outcome = await onlyOutcome(capture.outcomes);
      assert.deepEqual(Object.keys(outcome).sort(), [...REQUEST_OUTCOME_KEYS].sort());
      assert.equal(outcome.requestId, res.headers['x-tollwise-request-id']);
      assert.equal(outcome.format, 'openai');
      assert.equal(outcome.requestedModel, 'plain-x');
      assert.equal(outcome.requestedProvider, 'openai');
      assert.equal(outcome.usedModel, null);
      assert.equal(outcome.usedProvider, null);
      assert.deepEqual(outcome.needs, { ...NEEDS_NOTHING, tools: true });
      assert.equal(outcome.policy, 'cheapest');
      assert.equal(outcome.decision, 'fail');
      assert.equal(outcome.attempts, 0);
      assert.deepEqual(outcome.trace, []);
      assert.equal(outcome.usage, null);
      assert.equal(outcome.cost, null);
      assert.equal(outcome.firstByteMs, null);
      assert.equal(outcome.status, 'refused');
      assert.ok(Number.isInteger(outcome.latencyMs) && outcome.latencyMs >= 0);
    } finally {
      capture.stop();
      await proxy.close();
    }
  });

  test('a model not in the catalog, in fail mode, is refused with one "fail" outcome in the Anthropic format too', async () => {
    const proxy = await startProxy({ routing: { on_no_candidate: 'fail' } });
    const capture = captureOutcomes();
    try {
      const res = await messages(proxy, { model: 'unlisted-claude', max_tokens: 64, messages: HELLO });
      assert.equal(res.status, 422);
      const outcome = await onlyOutcome(capture.outcomes);
      assert.equal(outcome.format, 'anthropic');
      assert.equal(outcome.requestedModel, 'unlisted-claude');
      assert.equal(outcome.requestedProvider, 'anthropic');
      assert.equal(outcome.decision, 'fail');
      assert.equal(outcome.status, 'refused');
      assert.equal(outcome.attempts, 0);
    } finally {
      capture.stop();
      await proxy.close();
    }
  });

  test('a request refused before routing (invalid JSON) emits no outcome', async () => {
    const proxy = await startProxy();
    const capture = captureOutcomes();
    try {
      const res = await send(proxy.url, '/v1/chat/completions', { method: 'POST', headers: JSON_TYPE, body: '{' });
      assert.equal(res.status, 400);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(capture.outcomes.length, 0);
    } finally {
      capture.stop();
      await proxy.close();
    }
  });
});

describe('the routing selection and catalog prices on the request outcome', () => {
  afterEach(() => {
    clearRequestOutcomeListeners();
  });

  const SOURCE_URL = 'https://example.com/pricing';
  const price = (input: number, output: number) => ({
    input,
    output,
    verified_on: VERIFIED_ON,
    source_url: SOURCE_URL,
  });
  const TOOLS = [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }];

  test('routed with one attempt: every candidate in ranking order with its price, and both catalog prices', async () => {
    const proxy = await startProxy();
    const capture = captureOutcomes();
    try {
      const res = await chat(proxy, { model: 'gpt-x', messages: HELLO });
      assert.equal(res.status, 200);
      const outcome = await onlyOutcome(capture.outcomes);
      assert.equal(outcome.decision, 'routed');
      assert.equal(outcome.attempts, 1);
      assert.deepEqual(outcome.selection, {
        considered: 2,
        candidates: [
          { provider: 'openrouter', model: 'openai/gpt-x', input: 2, output: 8 },
          { provider: 'openai', model: 'gpt-x', input: 10, output: 50 },
        ],
        excluded: [],
      });
      assert.deepEqual(outcome.price, { used: price(2, 8), requested: price(10, 50) });
    } finally {
      capture.stop();
      await proxy.close();
    }
  });

  test('routed after a failed attempt: the price used is the one of the provider that served', async () => {
    const proxy = await startProxy({ mocks: { openrouter: { failWith: { status: 500 } } } });
    const capture = captureOutcomes();
    try {
      const res = await chat(proxy, { model: 'gpt-x', messages: HELLO });
      assert.equal(res.status, 200);
      const outcome = await onlyOutcome(capture.outcomes);
      assert.equal(outcome.attempts, 2);
      assert.equal(outcome.usedProvider, 'openai');
      assert.deepEqual(outcome.selection, {
        considered: 2,
        candidates: [
          { provider: 'openrouter', model: 'openai/gpt-x', input: 2, output: 8 },
          { provider: 'openai', model: 'gpt-x', input: 10, output: 50 },
        ],
        excluded: [],
      });
      assert.deepEqual(outcome.price, { used: price(10, 50), requested: price(10, 50) });
    } finally {
      capture.stop();
      await proxy.close();
    }
  });

  test('every attempt failing: the price used is the one of the last provider tried', async () => {
    const proxy = await startProxy({
      mocks: { openrouter: { failWith: { status: 500 } }, openai: { failWith: { status: 529 } } },
    });
    const capture = captureOutcomes();
    try {
      const res = await chat(proxy, { model: 'gpt-x', messages: HELLO });
      assert.equal(res.status, 502);
      const outcome = await onlyOutcome(capture.outcomes);
      assert.equal(outcome.status, 'provider_error');
      assert.deepEqual(outcome.price, { used: price(10, 50), requested: price(10, 50) });
    } finally {
      capture.stop();
      await proxy.close();
    }
  });

  test('passthrough to a catalog entry: its single target with its price, and the exclusion that caused it', async () => {
    const proxy = await startProxy();
    const capture = captureOutcomes();
    try {
      const res = await chat(proxy, { model: 'plain-x', messages: HELLO, tools: TOOLS });
      assert.equal(res.status, 200);
      const outcome = await onlyOutcome(capture.outcomes);
      assert.equal(outcome.decision, 'passthrough');
      assert.deepEqual(outcome.selection, {
        considered: 1,
        candidates: [{ provider: 'openai', model: 'plain-x', input: 1, output: 1 }],
        excluded: [{ provider: 'openai', model: 'plain-x', reason: 'missing_capability:tools' }],
      });
      assert.deepEqual(outcome.price, { used: price(1, 1), requested: price(1, 1) });
    } finally {
      capture.stop();
      await proxy.close();
    }
  });

  test('passthrough of a model with no catalog entry: a target with null prices, and no catalog price at all', async () => {
    const proxy = await startProxy();
    const capture = captureOutcomes();
    try {
      const res = await chat(proxy, { model: 'unlisted-model', messages: HELLO });
      assert.equal(res.status, 200);
      const outcome = await onlyOutcome(capture.outcomes);
      assert.equal(outcome.decision, 'passthrough');
      assert.deepEqual(outcome.selection, {
        considered: 0,
        candidates: [{ provider: 'openai', model: 'unlisted-model', input: null, output: null }],
        excluded: [],
      });
      assert.deepEqual(outcome.price, { used: null, requested: null });
    } finally {
      capture.stop();
      await proxy.close();
    }
  });

  test('passthrough after every entry was excluded: each exclusion with its reason, the target unpriced', async () => {
    const proxy = await startProxy();
    const capture = captureOutcomes();
    try {
      const res = await send(proxy.url, '/v1/chat/completions', {
        method: 'POST',
        headers: { ...JSON_TYPE, 'x-tollwise-provider': 'anthropic' },
        body: JSON.stringify({ model: 'gpt-x', max_tokens: 64, messages: HELLO }),
      });
      assert.equal(res.status, 200);
      const outcome = await onlyOutcome(capture.outcomes);
      assert.equal(outcome.decision, 'passthrough');
      assert.equal(outcome.usedProvider, 'anthropic');
      assert.deepEqual(outcome.selection, {
        considered: 2,
        candidates: [{ provider: 'anthropic', model: 'gpt-x', input: null, output: null }],
        excluded: [
          { provider: 'openai', model: 'gpt-x', reason: 'provider_not_requested' },
          { provider: 'openrouter', model: 'openai/gpt-x', reason: 'provider_not_requested' },
        ],
      });
      assert.deepEqual(outcome.price, { used: null, requested: price(10, 50) });
    } finally {
      capture.stop();
      await proxy.close();
    }
  });

  test('a refused request: no candidates, its exclusions, no price used, the requested price kept', async () => {
    const proxy = await startProxy({ routing: { on_no_candidate: 'fail' } });
    const capture = captureOutcomes();
    try {
      const res = await chat(proxy, { model: 'plain-x', messages: HELLO, tools: TOOLS });
      assert.equal(res.status, 422);
      const outcome = await onlyOutcome(capture.outcomes);
      assert.equal(outcome.status, 'refused');
      assert.deepEqual(outcome.selection, {
        considered: 1,
        candidates: [],
        excluded: [{ provider: 'openai', model: 'plain-x', reason: 'missing_capability:tools' }],
      });
      assert.deepEqual(outcome.price, { used: null, requested: price(1, 1) });
    } finally {
      capture.stop();
      await proxy.close();
    }
  });

  test('a key pasted into the model is masked in the selection too', async () => {
    const pastedKey = FAKE_KEYS['OpenAI API key']?.text;
    assert.ok(pastedKey !== undefined);
    const proxy = await startProxy();
    const capture = captureOutcomes();
    try {
      const res = await chat(proxy, { model: pastedKey, messages: HELLO });
      assert.equal(res.status, 200);
      const outcome = await onlyOutcome(capture.outcomes);
      assert.deepEqual(outcome.selection, {
        considered: 0,
        candidates: [{ provider: 'openai', model: '[REDACTED]', input: null, output: null }],
        excluded: [],
      });
    } finally {
      capture.stop();
      await proxy.close();
    }
  });

  test('a stored outcome keeps the catalog as it was when the request was routed', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tollwise-outcome-test-'));
    const store = openSqliteEventStore({
      file: path.join(dir, 'analytics.db'),
      logger: createLogger({ sink: { write: () => true }, env: {} }),
    });
    const proxy = await startProxy();
    const stopRecording = onRequestOutcome((outcome) => store.record(outcome));
    const capture = captureOutcomes();
    const openrouterEntry = CATALOG.models[1] as { price: ModelEntry['price'] };
    const originalPrice = openrouterEntry.price;
    try {
      const res = await chat(proxy, { model: 'gpt-x', messages: HELLO });
      assert.equal(res.status, 200);
      const outcome = await onlyOutcome(capture.outcomes);
      // A later catalog change must not alter what was stored for an earlier request.
      openrouterEntry.price = { input: 99, output: 99, cached_input: null };
      const [stored] = await store.readEvents();
      assert.deepEqual(stored, outcome);
      assert.deepEqual(stored?.price?.used, price(2, 8));
      const serialised = JSON.stringify(stored);
      for (const forbidden of ['Say hello', 'authorization', proxy.openrouter.url, FAKE_OPENROUTER_KEY]) {
        assert.ok(!serialised.includes(forbidden), 'the stored outcome carries no prompt, header, provider URL or key');
      }
    } finally {
      openrouterEntry.price = originalPrice;
      stopRecording();
      capture.stop();
      await proxy.close();
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
