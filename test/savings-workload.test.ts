// benchmarks/savings.ts: the seeded PRNG, the mixed and realistic workloads it generates, the
// format-independent usage its mock providers report, the fixed-latency health monitor, the aggregation
// math, the substitution counts read from the x-tollwise-* headers, the results file names, and one full
// replay of every scenario through a real in-process Tollwise against the benchmark's own loopback mock
// providers (no real provider, no credential, no network beyond 127.0.0.1).

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  ARCHETYPES,
  ASSUMED_PROVIDER_LATENCY_MS,
  buildHealthMonitor,
  comparableRecord,
  contentSize,
  countBy,
  countSubstitutions,
  DEFAULT_CONFIG,
  generateRealisticWorkload,
  generateWorkload,
  IMAGE_INPUT_TOKENS,
  latencyP50,
  type MockServer,
  mockInputTokens,
  mulberry32,
  newestResultsName,
  nextResultsName,
  PRESETS_ON_CONFIG,
  parseUsdMicros,
  REALISTIC_SEGMENTS,
  REQUESTS_PER_ARCHETYPE,
  readSubstitutionHeaders,
  recordDifferences,
  runScenarios,
  type ScenarioResult,
  type SubstitutionHeaders,
  startSavingsMock,
  summarizeRun,
  WORKLOAD_SEED,
} from '../benchmarks/savings.ts';
import { loadCatalog } from '../src/catalog/index.ts';
import type { Catalog, ModelEntry } from '../src/catalog/schema.ts';
import { ConfigSchema, type ProviderId, type RoutingPolicy } from '../src/config/schema.ts';
import { formatUsd } from '../src/pricing/cost.ts';
import { buildRegistry } from '../src/providers/registry.ts';
import type { RequestOutcome } from '../src/proxy/outcome.ts';
import { translateAnthropicRequestToOpenAI } from '../src/translate/anthropic-to-openai.ts';

// ---------------------------------------------------------------- mulberry32

describe('mulberry32', () => {
  test('is deterministic: the same seed produces the same sequence', () => {
    const a = mulberry32(1234);
    const b = mulberry32(1234);
    const sequenceA = Array.from({ length: 10 }, () => a());
    const sequenceB = Array.from({ length: 10 }, () => b());
    assert.deepEqual(sequenceA, sequenceB);
  });

  test('different seeds produce different sequences', () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    assert.notEqual(a(), b());
  });

  test('every value is within [0, 1)', () => {
    const rng = mulberry32(WORKLOAD_SEED);
    for (let i = 0; i < 200; i += 1) {
      const value = rng();
      assert.ok(value >= 0 && value < 1, `expected ${value} to be within [0, 1)`);
    }
  });
});

// ---------------------------------------------------------------- generateWorkload

describe('generateWorkload', () => {
  test('is reproducible: the same seed always builds the same workload', () => {
    const first = generateWorkload(WORKLOAD_SEED);
    const second = generateWorkload(WORKLOAD_SEED);
    assert.deepEqual(first, second);
  });

  test('a different seed builds a different workload', () => {
    const first = generateWorkload(WORKLOAD_SEED);
    const second = generateWorkload(WORKLOAD_SEED + 1);
    assert.notDeepEqual(first, second);
  });

  test('builds exactly REQUESTS_PER_ARCHETYPE requests per archetype, in archetype order', () => {
    const requests = generateWorkload(WORKLOAD_SEED);
    assert.equal(requests.length, ARCHETYPES.length * REQUESTS_PER_ARCHETYPE);
    for (const [index, archetype] of ARCHETYPES.entries()) {
      const slice = requests.slice(index * REQUESTS_PER_ARCHETYPE, (index + 1) * REQUESTS_PER_ARCHETYPE);
      assert.equal(slice.length, REQUESTS_PER_ARCHETYPE);
      for (const request of slice) {
        assert.equal(request.archetype, archetype.name);
        assert.equal(request.format, archetype.format);
        assert.equal(request.needsLabel, archetype.needsLabel);
        assert.ok(
          archetype.models.includes(request.requestedModel),
          `expected "${request.requestedModel}" to be one of ${archetype.models.join(', ')} for archetype "${archetype.name}"`,
        );
      }
    }
  });

  test('covers both wire formats and every request has a JSON-serializable body naming its requested model', () => {
    const requests = generateWorkload(WORKLOAD_SEED);
    assert.ok(requests.some((request) => request.format === 'openai'));
    assert.ok(requests.some((request) => request.format === 'anthropic'));
    for (const request of requests) {
      assert.equal(request.body.model, request.requestedModel);
      // Anthropic requires max_tokens on every request; every archetype sets one or the other.
      const hasMaxOutput =
        typeof request.body.max_completion_tokens === 'number' || typeof request.body.max_tokens === 'number';
      assert.ok(hasMaxOutput, `expected a max output field on a "${request.archetype}" request`);
    }
  });

  test('ids are unique and assigned in generation order', () => {
    const requests = generateWorkload(WORKLOAD_SEED);
    const ids = requests.map((request) => request.id);
    assert.deepEqual(
      ids,
      [...ids].sort((a, b) => a - b),
    );
    assert.equal(new Set(ids).size, ids.length);
  });
});

// ---------------------------------------------------------------- parseUsdMicros

describe('parseUsdMicros', () => {
  test('round-trips with formatUsd for positive, negative and zero amounts', () => {
    for (const micros of [0, 1, 6000, 150_000, -150_000, 1_000_000, 999]) {
      assert.equal(parseUsdMicros(formatUsd(micros)), micros);
    }
  });

  test('reads known fixed-decimal strings to the exact micro-dollar', () => {
    assert.equal(parseUsdMicros('0.006000'), 6000);
    assert.equal(parseUsdMicros('-0.018552'), -18552);
    assert.equal(parseUsdMicros('1.500000'), 1_500_000);
    assert.equal(parseUsdMicros('0.000000'), 0);
  });
});

// ---------------------------------------------------------------- summarizeRun

const ALL_CAPS = { tools: true, json_mode: true, vision: true, streaming: true };

function entry(provider: ProviderId, model: string, canonical: string, input: number, output: number): ModelEntry {
  return {
    provider,
    model,
    canonical_model: canonical,
    price: { input, output, cached_input: null },
    context_window: 128_000,
    max_output: 16_000,
    capabilities: ALL_CAPS,
    source_url: 'https://example.com/pricing',
    verified_on: '2026-09-19',
  };
}

const FAKE_CATALOG: Catalog = {
  models: [
    entry('openai', 'model-a', 'model-a', 2, 8),
    entry('openrouter', 'openai/model-a', 'model-a', 2, 8),
    entry('deepseek', 'model-cheap', 'model-cheap', 0.5, 1),
    entry('anthropic', 'model-b', 'model-b', 5, 20),
  ],
};

interface FakeOutcomeFields {
  readonly requestedModel: string;
  readonly requestedProvider: ProviderId;
  readonly usedModel: string | null;
  readonly usedProvider: ProviderId | null;
  readonly costUsd: string;
  readonly baselineUsd: string | 'unknown';
}

function fakeOutcome(fields: FakeOutcomeFields): RequestOutcome {
  return {
    timestamp: '2026-09-19T00:00:00.000Z',
    requestId: 'req-1',
    format: 'openai',
    requestedModel: fields.requestedModel,
    requestedProvider: fields.requestedProvider,
    usedModel: fields.usedModel,
    usedProvider: fields.usedProvider,
    needs: { tools: false, json_mode: false, vision: false, streaming: false },
    policy: 'cheapest' as RoutingPolicy,
    decision: fields.usedProvider === null ? 'fail' : 'routed',
    attempts: fields.usedProvider === null ? 0 : 1,
    trace: [],
    usage: { input: 100, cached_input: 0, output: 50, origin: 'reported' },
    cost: {
      cost_usd: fields.costUsd as `${number}`,
      baseline_usd: fields.baselineUsd as `${number}` | 'unknown',
      savings_usd:
        fields.baselineUsd === 'unknown'
          ? 'unknown'
          : (formatUsd(parseUsdMicros(fields.baselineUsd) - parseUsdMicros(fields.costUsd)) as `${number}`),
      origin: 'reported',
      used_price_verified_on: '2026-09-19',
      baseline_price_verified_on: fields.baselineUsd === 'unknown' ? 'unknown' : '2026-09-19',
    },
    latencyMs: 10,
    firstByteMs: null,
    status: fields.usedProvider === null ? 'refused' : 'complete',
    selection: null,
    price: null,
    substitution: null,
  };
}

describe('summarizeRun', () => {
  test('sums cost, baseline and savings only over requests with a known baseline', () => {
    const outcomes: RequestOutcome[] = [
      // known baseline: cost 0.001600 (model-a, cheapest same price), baseline 0.001600 -> 0 savings
      fakeOutcome({
        requestedModel: 'model-a',
        requestedProvider: 'openai',
        usedModel: 'model-a',
        usedProvider: 'openai',
        costUsd: '0.001600',
        baselineUsd: '0.001600',
      }),
      // unknown baseline: its cost must never be added to total_cost_usd (the regression this test guards).
      fakeOutcome({
        requestedModel: 'model-unpriced',
        requestedProvider: 'openai',
        usedModel: 'model-unpriced',
        usedProvider: 'openai',
        costUsd: '5.000000',
        baselineUsd: 'unknown',
      }),
    ];

    const summary = summarizeRun('cheapest', DEFAULT_CONFIG, outcomes, FAKE_CATALOG);

    assert.equal(summary.requests, 2);
    assert.equal(summary.unknown_baseline, 1);
    assert.equal(summary.unknown_baseline_cost_usd, '5.000000');
    // The $5 unpriced request must not leak into the totals below.
    assert.equal(summary.total_cost_usd, '0.001600');
    assert.equal(summary.total_baseline_usd, '0.001600');
    assert.equal(summary.total_savings_usd, '0.000000');
    assert.equal(summary.savings_percent, 0);
  });

  test('a provider mirror of the same canonical model is a provider_switch, not a model_switch', () => {
    const outcomes: RequestOutcome[] = [
      fakeOutcome({
        requestedModel: 'model-a',
        requestedProvider: 'openai',
        usedModel: 'openai/model-a', // same canonical_model "model-a", served via openrouter
        usedProvider: 'openrouter',
        costUsd: '0.001600',
        baselineUsd: '0.001600',
      }),
    ];

    const summary = summarizeRun('cheapest', DEFAULT_CONFIG, outcomes, FAKE_CATALOG);

    assert.equal(summary.provider_switches, 1);
    assert.equal(summary.model_switches, 0);
  });

  test('a switch to a different canonical model (an equivalence group) is a model_switch', () => {
    const outcomes: RequestOutcome[] = [
      fakeOutcome({
        requestedModel: 'model-a',
        requestedProvider: 'openai',
        usedModel: 'model-cheap', // a different canonical_model entirely
        usedProvider: 'deepseek',
        costUsd: '0.000400',
        baselineUsd: '0.001600',
      }),
    ];

    const summary = summarizeRun('cheapest', PRESETS_ON_CONFIG, outcomes, FAKE_CATALOG);

    assert.equal(summary.provider_switches, 1);
    assert.equal(summary.model_switches, 1);
    assert.equal(summary.total_savings_usd, '0.001200');
  });

  test('a refused request (no provider used) counts toward failed, never toward a switch', () => {
    const outcomes: RequestOutcome[] = [
      fakeOutcome({
        requestedModel: 'model-a',
        requestedProvider: 'openai',
        usedModel: null,
        usedProvider: null,
        costUsd: '0.000000',
        baselineUsd: 'unknown',
      }),
    ];
    const summary = summarizeRun('cheapest', DEFAULT_CONFIG, outcomes, FAKE_CATALOG);
    assert.equal(summary.failed, 1);
    assert.equal(summary.routed, 0);
    assert.equal(summary.provider_switches, 0);
    assert.equal(summary.model_switches, 0);
    assert.deepEqual(summary.routes, { 'openai -> none': 1 });
  });
});

// ---------------------------------------------------------------- mock usage

describe('mock usage is independent of the wire format', () => {
  test('counts system, message text, tool name/description/schema, and a fixed amount per image', () => {
    const body = {
      system: 'abcd',
      messages: [
        { role: 'user', content: 'efgh' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'ijkl' },
            { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
          ],
        },
      ],
      tools: [{ name: 'tool', description: 'desc', input_schema: { type: 'object' } }],
    };
    // 12 text characters, 4 + 4 for the tool name and description, 17 for '{"type":"object"}'.
    assert.deepEqual(contentSize(body), { chars: 37, images: 1 });
    assert.equal(mockInputTokens(body), 10 + IMAGE_INPUT_TOKENS);
  });

  test('every Anthropic-format workload request reports the same input tokens after translation to OpenAI', () => {
    const anthropicRequests = generateWorkload(WORKLOAD_SEED).filter((request) => request.format === 'anthropic');
    assert.equal(anthropicRequests.length, 4 * REQUESTS_PER_ARCHETYPE);
    for (const request of anthropicRequests) {
      const translated = translateAnthropicRequestToOpenAI(request.body) as unknown as Record<string, unknown>;
      assert.equal(
        mockInputTokens(translated),
        mockInputTokens(request.body),
        `request ${request.id} (${request.archetype}) reports different usage once translated`,
      );
    }
  });
});

// ---------------------------------------------------------------- fixed latency

describe('buildHealthMonitor', () => {
  test('holds the assumed latencies and ignores every sample recorded afterwards', () => {
    const config = ConfigSchema.parse({
      providers: {
        openai: { base_url: 'http://127.0.0.1:9', api_key_env: 'TOLLWISE_BENCH_TEST_KEY' },
        anthropic: { base_url: 'http://127.0.0.1:9', api_key_env: 'TOLLWISE_BENCH_TEST_KEY' },
        ollama: { enabled: false },
      },
      analytics: { enabled: false },
    });
    const registry = buildRegistry(config, { TOLLWISE_BENCH_TEST_KEY: 'placeholder-not-a-credential' });
    const monitor = buildHealthMonitor(registry);
    try {
      for (let i = 0; i < 10; i += 1) {
        monitor.recordLatency('openai', 0);
        monitor.recordLatency('anthropic', 1);
      }
      const p50 = latencyP50(monitor);
      assert.equal(p50.openai, 900);
      assert.equal(p50.anthropic, 700);
    } finally {
      monitor.stop();
    }
  });
});

// ---------------------------------------------------------------- realistic workload

describe('generateRealisticWorkload', () => {
  const requests = generateRealisticWorkload(WORKLOAD_SEED);

  test('holds exactly the documented shares of its 100 requests', () => {
    assert.equal(requests.length, 100);
    assert.equal(
      REALISTIC_SEGMENTS.reduce((sum, segment) => sum + segment.count, 0),
      100,
    );
    assert.deepEqual(
      countBy(requests, (request) => request.modelClass),
      { frontier: 30, 'small-fast': 70 },
    );
    assert.deepEqual(
      countBy(requests, (request) => request.format),
      { anthropic: 40, openai: 60 },
    );
    assert.deepEqual(
      countBy(requests, (request) => request.needsLabel),
      { json_mode: 10, none: 58, tools: 20, vision: 12 },
    );
    assert.deepEqual(
      countBy(requests, (request) => request.size),
      { large: 20, medium: 42, small: 38 },
    );
  });

  test('is deterministic for a seed', () => {
    assert.deepEqual(generateRealisticWorkload(WORKLOAD_SEED), requests);
  });

  test('never names deepseek-v4-pro for a vision request (it has no vision)', () => {
    for (const request of requests) {
      if (request.needsLabel === 'vision') assert.notEqual(request.requestedModel, 'deepseek-v4-pro');
    }
  });
});

// ---------------------------------------------------------------- substitution headers

function answerHeaders(entries: Record<string, string>): Headers {
  return new Headers(entries);
}

function substitutedOutcome(served: { provider: ProviderId; model: string; group: string } | null): RequestOutcome {
  return {
    ...fakeOutcome({
      requestedModel: 'gpt-5.6-luna',
      requestedProvider: 'openai',
      usedModel: served?.model ?? 'gpt-5.6-luna',
      usedProvider: served?.provider ?? 'openai',
      costUsd: '0.000100',
      baselineUsd: '0.000200',
    }),
    substitution:
      served === null ? null : { requested_model: 'gpt-5.6-luna', served_model: served.model, group: served.group },
  };
}

describe('readSubstitutionHeaders', () => {
  test('reads a substituted answer', () => {
    assert.deepEqual(
      readSubstitutionHeaders(
        answerHeaders({
          'x-tollwise-substituted': 'true',
          'x-tollwise-requested-model': 'gpt-5.6-luna',
          'x-tollwise-provider': 'deepseek',
          'x-tollwise-model': 'deepseek-flash',
          'x-tollwise-equivalence-group': 'small-fast',
        }),
      ),
      {
        requestedModel: 'gpt-5.6-luna',
        substituted: true,
        servedProvider: 'deepseek',
        servedModel: 'deepseek-flash',
        equivalenceGroup: 'small-fast',
      },
    );
  });

  test('throws when a header every chat answer carries is missing or malformed', () => {
    assert.throws(
      () => readSubstitutionHeaders(answerHeaders({ 'x-tollwise-requested-model': 'gpt-5.6-luna' })),
      /x-tollwise-substituted/,
    );
    assert.throws(
      () =>
        readSubstitutionHeaders(
          answerHeaders({ 'x-tollwise-substituted': 'yes', 'x-tollwise-requested-model': 'gpt-5.6-luna' }),
        ),
      /x-tollwise-substituted/,
    );
    assert.throws(
      () => readSubstitutionHeaders(answerHeaders({ 'x-tollwise-substituted': 'false' })),
      /x-tollwise-requested-model/,
    );
    assert.throws(
      () =>
        readSubstitutionHeaders(
          answerHeaders({ 'x-tollwise-substituted': 'true', 'x-tollwise-requested-model': 'gpt-5.6-luna' }),
        ),
      /x-tollwise-equivalence-group/,
    );
  });
});

describe('countSubstitutions', () => {
  const substitutedHeader: SubstitutionHeaders = {
    requestedModel: 'gpt-5.6-luna',
    substituted: true,
    servedProvider: 'deepseek',
    servedModel: 'deepseek-flash',
    equivalenceGroup: 'small-fast',
  };
  const plainHeader: SubstitutionHeaders = {
    requestedModel: 'gpt-5.6-luna',
    substituted: false,
    servedProvider: 'openai',
    servedModel: 'gpt-5.6-luna',
    equivalenceGroup: null,
  };
  const served = { provider: 'deepseek' as const, model: 'deepseek-flash', group: 'small-fast' };

  test('counts substituted answers per served provider, model and group', () => {
    assert.deepEqual(
      countSubstitutions(
        [substitutedHeader, plainHeader, substitutedHeader],
        [substitutedOutcome(served), substitutedOutcome(null), substitutedOutcome(served)],
      ),
      [{ served_provider: 'deepseek', served_model: 'deepseek-flash', equivalence_group: 'small-fast', requests: 2 }],
    );
  });

  test('throws when a header disagrees with the request outcome', () => {
    assert.throws(() => countSubstitutions([substitutedHeader], [substitutedOutcome(null)]), /disagrees/);
    assert.throws(() => countSubstitutions([plainHeader], [substitutedOutcome(served)]), /disagrees/);
    assert.throws(
      () => countSubstitutions([{ ...substitutedHeader, equivalenceGroup: 'frontier' }], [substitutedOutcome(served)]),
      /disagree/,
    );
    assert.throws(() => countSubstitutions([plainHeader], []), /1 answers but 0 request outcomes/);
  });
});

// ---------------------------------------------------------------- results files

describe('results file names', () => {
  test('a new results file never takes an existing name', () => {
    assert.equal(nextResultsName(['savings-2026-09-19.json'], '2026-09-25'), 'savings-2026-09-25.json');
    assert.equal(nextResultsName(['savings-2026-09-19.json'], '2026-09-19'), 'savings-2026-09-19-2.json');
    assert.equal(
      nextResultsName(['savings-2026-09-19.json', 'savings-2026-09-19-2.json'], '2026-09-19'),
      'savings-2026-09-19-3.json',
    );
  });

  test('the newest file is the latest date, then the highest suffix', () => {
    assert.equal(newestResultsName([]), null);
    assert.equal(newestResultsName(['overhead-2026-09-30.json', 'notes.md']), null);
    assert.equal(
      newestResultsName(['savings-2026-09-25.json', 'savings-2026-09-19-3.json', 'overhead-2026-09-30.json']),
      'savings-2026-09-25.json',
    );
    assert.equal(
      newestResultsName(['savings-2026-09-25-2.json', 'savings-2026-09-25.json', 'savings-2026-09-25-10.json']),
      'savings-2026-09-25-10.json',
    );
  });

  test('a rerun compares every number but ignores the date, machine and commit', () => {
    const written = { date: 'a', node_version: 'v1', tollwise_commit: 'x', tollwise_dirty: true, seed: 1, runs: [1] };
    const rerun = { date: 'b', node_version: 'v2', tollwise_commit: 'y', tollwise_dirty: false, seed: 1, runs: [1] };
    assert.deepEqual(recordDifferences(comparableRecord(written), comparableRecord(rerun)), []);
    assert.deepEqual(recordDifferences(comparableRecord(written), comparableRecord({ ...rerun, runs: [2] })), [
      '$.runs[0]: expected 1, got 2',
    ]);
  });
});

// ---------------------------------------------------------------- full replay

describe('full replay of every scenario against the loopback mock providers', () => {
  let openAiMock: MockServer | undefined;
  let anthropicMock: MockServer | undefined;
  let results: ScenarioResult[] = [];

  before(async () => {
    openAiMock = await startSavingsMock('openai');
    anthropicMock = await startSavingsMock('anthropic');
    const mocks = { openai: openAiMock.url, anthropic: anthropicMock.url };
    results = await runScenarios(mocks, loadCatalog(), () => undefined);
  });

  after(async () => {
    await openAiMock?.close();
    await anthropicMock?.close();
  });

  function scenario(id: string): ScenarioResult {
    const found = results.find((result) => result.scenario.id === id);
    assert.ok(found, `no scenario "${id}"`);
    return found;
  }

  test('replays every request under every policy of every scenario, with no failure and no unpriced baseline', () => {
    assert.deepEqual(
      results.map((result) => [result.scenario.id, result.runs.map((run) => run.policy)]),
      [
        ['default', ['cheapest', 'fastest', 'balanced']],
        ['realistic-default', ['cheapest', 'fastest', 'balanced']],
        ['presets-on', ['cheapest', 'fastest', 'balanced']],
      ],
    );
    for (const { scenario: entry, runs } of results) {
      for (const run of runs) {
        assert.equal(run.requests, entry.workload === 'mixed' ? 54 : 100);
        assert.equal(run.failed, 0);
        assert.equal(run.unknown_baseline, 0);
      }
    }
  });

  test('without presets nothing is substituted; with them every substitution is a model switch', () => {
    for (const id of ['default', 'realistic-default']) {
      for (const run of scenario(id).runs) {
        assert.equal(run.substituted_requests, 0);
        assert.equal(run.model_switches, 0);
        assert.deepEqual(run.substitutions, []);
      }
    }
    for (const run of scenario('presets-on').runs) {
      assert.ok(run.substituted_requests > 0, run.policy);
      assert.equal(run.model_switches, run.substituted_requests, run.policy);
      for (const count of run.substitutions) {
        assert.ok(['frontier', 'small-fast'].includes(count.equivalence_group), count.equivalence_group);
      }
    }
  });

  test('the baseline of a workload does not depend on the policy when no request is translated to Anthropic', () => {
    const mixed = new Set(scenario('default').runs.map((run) => run.total_baseline_usd));
    assert.equal(mixed.size, 1, `baselines differ: ${[...mixed].join(', ')}`);
    const realistic = new Set(
      [...scenario('realistic-default').runs, ...scenario('presets-on').runs]
        .filter((run) => !Object.keys(run.routes).some((route) => /^(openai|deepseek) -> anthropic$/.test(route)))
        .map((run) => run.total_baseline_usd),
    );
    assert.equal(realistic.size, 1, `baselines differ: ${[...realistic].join(', ')}`);
  });

  test('presets-on cheapest saves more than provider switching alone on the same workload', () => {
    const control = scenario('realistic-default').runs.find((run) => run.policy === 'cheapest');
    const presets = scenario('presets-on').runs.find((run) => run.policy === 'cheapest');
    assert.ok(control && presets);
    assert.ok(parseUsdMicros(presets.total_savings_usd) > parseUsdMicros(control.total_savings_usd));
  });

  test('routing ranks on the assumed latencies for the whole run, never on mock round trips', () => {
    for (const { runs } of results) {
      for (const run of runs) {
        assert.deepEqual(run.latency_p50_ms_after_run, {
          anthropic: ASSUMED_PROVIDER_LATENCY_MS.anthropic,
          openai: ASSUMED_PROVIDER_LATENCY_MS.openai,
          deepseek: ASSUMED_PROVIDER_LATENCY_MS.deepseek,
          openrouter: ASSUMED_PROVIDER_LATENCY_MS.openrouter,
        });
      }
    }
  });

  test('default-config fastest follows the assumed latency order (anthropic < openai < openrouter < deepseek)', () => {
    const fastest = scenario('default').runs.find((run) => run.policy === 'fastest');
    assert.ok(fastest);
    assert.deepEqual(fastest.routes, {
      'anthropic -> anthropic': 24,
      'deepseek -> openrouter': 8,
      'openai -> openai': 22,
    });
  });
});
