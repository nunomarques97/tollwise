import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Catalog, ModelEntry } from '../src/catalog/schema.ts';
import type { ProviderId } from '../src/config/schema.ts';
import type { HealthMonitorSnapshot, ProviderHealthState } from '../src/health/monitor.ts';
import type { RequestNeeds } from '../src/routing/inspect.ts';
import {
  BALANCED_COST_WEIGHT,
  balancedScore,
  CAPABILITIES,
  DEFAULT_EXPECTED_OUTPUT_TOKENS,
  estimateCost,
  type RoutingSettings,
  type SelectInput,
  type Selection,
  select,
} from '../src/routing/select.ts';

const ALL_CAPS = { tools: true, json_mode: true, vision: true, streaming: true };
const NO_NEEDS: RequestNeeds = { tools: false, json_mode: false, vision: false, streaming: false };

function entry(
  provider: ProviderId,
  model: string,
  canonical: string,
  input: number,
  output: number,
  extra: Partial<Pick<ModelEntry, 'context_window' | 'max_output' | 'capabilities'>> = {},
): ModelEntry {
  return {
    provider,
    model,
    canonical_model: canonical,
    price: { input, output, cached_input: null },
    context_window: extra.context_window ?? 128_000,
    max_output: extra.max_output ?? 16_000,
    capabilities: extra.capabilities ?? ALL_CAPS,
    source_url: 'https://example.com/pricing',
    verified_on: '2026-09-01',
  };
}

const catalog: Catalog = {
  models: [
    entry('openai', 'gpt-a', 'gpt-a', 2, 8),
    entry('openrouter', 'openai/gpt-a', 'gpt-a', 1.5, 6, { capabilities: { ...ALL_CAPS, vision: false } }),
    entry('deepseek', 'ds-small', 'ds-small', 0.2, 0.4, { context_window: 64_000, max_output: 8_000 }),
    entry('anthropic', 'claude-x', 'claude-x', 3, 15),
    entry('openrouter', 'anthropic/claude-x', 'claude-x', 3, 15),
    entry('ollama', 'llama', 'llama', 0, 0, {
      context_window: 8_192,
      max_output: 8_192,
      capabilities: { ...ALL_CAPS, tools: false },
    }),
  ],
};

const ALL_PROVIDERS: ProviderId[] = ['anthropic', 'openai', 'deepseek', 'openrouter', 'ollama'];

function registry(ids: ProviderId[] = ALL_PROVIDERS) {
  return { enabled: ids.map((id) => ({ id })) };
}

function health(
  states: Partial<Record<ProviderId, { state?: ProviderHealthState; p50?: number | null }>> = {},
): HealthMonitorSnapshot {
  return {
    providers: ALL_PROVIDERS.map((id) => ({
      id,
      state: states[id]?.state ?? 'unknown',
      lastErrorKind: null,
      lastCheckedAt: null,
      p50: states[id]?.p50 ?? null,
      p95: null,
      sampleCount: 0,
    })),
  };
}

function routing(extra: Partial<RoutingSettings> = {}): RoutingSettings {
  return { policy: 'cheapest', on_no_candidate: 'passthrough', equivalence_groups: [], ...extra };
}

interface RequestOptions {
  model?: string;
  format?: 'openai' | 'anthropic';
  needs?: Partial<RequestNeeds>;
  input?: number;
  maxOutput?: number | null;
}

function input(request: RequestOptions = {}, rest: Partial<Omit<SelectInput, 'inspection'>> = {}): SelectInput {
  return {
    inspection: {
      format: request.format ?? 'openai',
      requestedModel: request.model ?? 'gpt-a',
      needs: { ...NO_NEEDS, ...request.needs },
      estimatedInput: { tokens: request.input ?? 1_000, origin: 'estimated' },
      maxOutput: request.maxOutput ?? null,
    },
    catalog,
    registry: registry(),
    health: health(),
    routing: routing(),
    ...rest,
  };
}

function refs(selection: Selection): string[] {
  return selection.candidates.map((c) => `${c.provider}/${c.model}`);
}

function routed(selection: Selection) {
  assert.equal(selection.decision, 'routed');
  if (selection.decision !== 'routed') throw new Error('unreachable');
  return selection;
}

describe('select — candidates', () => {
  test('the same canonical model on every configured provider, cheapest first', () => {
    const result = routed(select(input()));
    assert.deepEqual(refs(result), ['openrouter/openai/gpt-a', 'openai/gpt-a']);
    assert.deepEqual(result.trace.considered, [
      { provider: 'openai', model: 'gpt-a' },
      { provider: 'openrouter', model: 'openai/gpt-a' },
    ]);
    assert.equal(result.trace.requested.canonicalModel, 'gpt-a');
    assert.equal(result.trace.requested.group, null);
  });

  test('a cheaper different model is never considered without an equivalence group', () => {
    const result = routed(select(input()));
    assert.ok(result.candidates.every((c) => c.entry.canonical_model === 'gpt-a'));
    assert.ok(!result.trace.considered.some((c) => c.model === 'ds-small'));
  });

  test('a provider-specific model id resolves to its canonical model', () => {
    const result = routed(select(input({ model: 'anthropic/claude-x', format: 'openai' })));
    assert.equal(result.trace.requested.canonicalModel, 'claude-x');
    // Equal price: the exact model id that was requested wins the tie.
    assert.deepEqual(refs(result), ['openrouter/anthropic/claude-x', 'anthropic/claude-x']);
  });

  test('a canonical id that no provider uses as its own model id still resolves', () => {
    const custom: Catalog = { models: [entry('openrouter', 'vendor/m-1', 'm-1', 1, 1)] };
    const result = routed(select(input({ model: 'm-1' }, { catalog: custom })));
    assert.deepEqual(refs(result), ['openrouter/vendor/m-1']);
  });

  test('an explicit equivalence group lets a different model in, listed by canonical id', () => {
    const groups = [{ name: 'small', models: ['gpt-a', 'ds-small'] }];
    const result = routed(select(input({}, { routing: routing({ equivalence_groups: groups }) })));
    assert.deepEqual(refs(result), ['deepseek/ds-small', 'openrouter/openai/gpt-a', 'openai/gpt-a']);
    assert.equal(result.trace.requested.group, 'small');
  });

  test('an equivalence group member listed by provider model id adds only that entry', () => {
    const groups = [{ name: 'claude-via-router', models: ['gpt-a', 'anthropic/claude-x'] }];
    const result = routed(select(input({}, { routing: routing({ equivalence_groups: groups }) })));
    assert.deepEqual(refs(result), ['openrouter/openai/gpt-a', 'openai/gpt-a', 'openrouter/anthropic/claude-x']);
  });

  test('a group that does not contain the requested model changes nothing', () => {
    const groups = [{ name: 'other', models: ['claude-x', 'ds-small'] }];
    const result = routed(select(input({}, { routing: routing({ equivalence_groups: groups }) })));
    assert.deepEqual(refs(result), ['openrouter/openai/gpt-a', 'openai/gpt-a']);
    assert.equal(result.trace.requested.group, null);
  });

  test('the same input always gives the same output and is not mutated', () => {
    const request = input({ needs: { tools: true } });
    const snapshot = JSON.stringify(request);
    assert.deepEqual(select(request), select(request));
    assert.equal(JSON.stringify(request), snapshot);
  });
});

describe('select — exclusions, one per reason', () => {
  for (const capability of CAPABILITIES) {
    test(`missing_capability:${capability}`, () => {
      const custom: Catalog = {
        models: [
          entry('openai', 'gpt-a', 'gpt-a', 2, 8),
          entry('openrouter', 'openai/gpt-a', 'gpt-a', 1, 1, { capabilities: { ...ALL_CAPS, [capability]: false } }),
        ],
      };
      const result = routed(select(input({ needs: { [capability]: true } }, { catalog: custom })));
      assert.deepEqual(refs(result), ['openai/gpt-a']);
      assert.deepEqual(result.trace.excluded, [
        { provider: 'openrouter', model: 'openai/gpt-a', reason: `missing_capability:${capability}` },
      ]);
    });
  }

  test('context_too_small when estimated input + max output exceeds the context window', () => {
    const custom: Catalog = {
      models: [
        entry('openai', 'gpt-a', 'gpt-a', 2, 8, { context_window: 200_000 }),
        entry('openrouter', 'openai/gpt-a', 'gpt-a', 1, 1, { context_window: 128_000 }),
      ],
    };
    const tooBig = routed(select(input({ input: 126_001, maxOutput: 2_000 }, { catalog: custom })));
    assert.deepEqual(tooBig.trace.excluded, [
      { provider: 'openrouter', model: 'openai/gpt-a', reason: 'context_too_small' },
    ]);
    const exactFit = routed(select(input({ input: 126_000, maxOutput: 2_000 }, { catalog: custom })));
    assert.deepEqual(refs(exactFit), ['openrouter/openai/gpt-a', 'openai/gpt-a']);
  });

  test('context_too_small reserves the default output when max tokens is absent', () => {
    const custom: Catalog = { models: [entry('openai', 'gpt-a', 'gpt-a', 2, 8, { context_window: 10_000 })] };
    const fits = select(input({ input: 10_000 - DEFAULT_EXPECTED_OUTPUT_TOKENS }, { catalog: custom }));
    assert.equal(fits.decision, 'routed');
    const over = select(input({ input: 10_001 - DEFAULT_EXPECTED_OUTPUT_TOKENS }, { catalog: custom }));
    assert.equal(over.decision, 'passthrough');
    assert.deepEqual(over.trace.excluded, [{ provider: 'openai', model: 'gpt-a', reason: 'context_too_small' }]);
  });

  test('max_output_too_small when the request asks for more output than the model gives', () => {
    const custom: Catalog = {
      models: [
        entry('openai', 'gpt-a', 'gpt-a', 2, 8, { max_output: 32_000 }),
        entry('openrouter', 'openai/gpt-a', 'gpt-a', 1, 1, { max_output: 16_000 }),
      ],
    };
    const result = routed(select(input({ maxOutput: 16_001 }, { catalog: custom })));
    assert.deepEqual(refs(result), ['openai/gpt-a']);
    assert.deepEqual(result.trace.excluded, [
      { provider: 'openrouter', model: 'openai/gpt-a', reason: 'max_output_too_small' },
    ]);
  });

  test('provider_down excludes a provider seen as down; unknown and up are kept', () => {
    const down = routed(select(input({}, { health: health({ openrouter: { state: 'down' } }) })));
    assert.deepEqual(refs(down), ['openai/gpt-a']);
    assert.deepEqual(down.trace.excluded, [{ provider: 'openrouter', model: 'openai/gpt-a', reason: 'provider_down' }]);

    const unknown = routed(select(input({}, { health: health({ openrouter: { state: 'unknown' } }) })));
    assert.deepEqual(refs(unknown), ['openrouter/openai/gpt-a', 'openai/gpt-a']);

    const missingFromSnapshot = routed(select(input({}, { health: { providers: [] } })));
    assert.equal(missingFromSnapshot.candidates.length, 2);
  });

  test('provider_not_configured excludes providers that are not enabled', () => {
    const result = routed(select(input({}, { registry: registry(['openai', 'anthropic']) })));
    assert.deepEqual(refs(result), ['openai/gpt-a']);
    assert.deepEqual(result.trace.excluded, [
      { provider: 'openrouter', model: 'openai/gpt-a', reason: 'provider_not_configured' },
    ]);
  });

  test('provider_not_requested when the request names a provider', () => {
    const result = routed(select({ ...input(), overrides: { provider: 'openai' } }));
    assert.deepEqual(refs(result), ['openai/gpt-a']);
    assert.deepEqual(result.trace.excluded, [
      { provider: 'openrouter', model: 'openai/gpt-a', reason: 'provider_not_requested' },
    ]);
    assert.equal(result.trace.requested.provider, 'openai');
  });

  test('an intrinsic model limit is reported before a provider being down', () => {
    const result = select(input({ needs: { vision: true } }, { health: health({ openrouter: { state: 'down' } }) }));
    assert.deepEqual(
      result.trace.excluded.find((e) => e.provider === 'openrouter'),
      { provider: 'openrouter', model: 'openai/gpt-a', reason: 'missing_capability:vision' },
    );
  });
});

describe('select — policies', () => {
  test('cheapest ranks by estimated cost = input x input price + output x output price', () => {
    const result = routed(select(input({ input: 1_000 })));
    // No max tokens: the default expected output is used for the estimate.
    const openrouter = (1_000 * 1.5 + DEFAULT_EXPECTED_OUTPUT_TOKENS * 6) / 1_000_000;
    const openai = (1_000 * 2 + DEFAULT_EXPECTED_OUTPUT_TOKENS * 8) / 1_000_000;
    assert.deepEqual(
      result.candidates.map((c) => c.estimatedCost),
      [openrouter, openai],
    );
    assert.equal(DEFAULT_EXPECTED_OUTPUT_TOKENS, 1_024);
  });

  test('cheapest uses the requested max tokens when set, and output price can flip the order', () => {
    const custom: Catalog = {
      models: [entry('openai', 'gpt-a', 'gpt-a', 1, 10), entry('openrouter', 'openai/gpt-a', 'gpt-a', 5, 1)],
    };
    // Small output: the input price dominates.
    assert.deepEqual(refs(select(input({ input: 10_000, maxOutput: 100 }, { catalog: custom }))), [
      'openai/gpt-a',
      'openrouter/openai/gpt-a',
    ]);
    // Large output: the output price dominates.
    assert.deepEqual(refs(select(input({ input: 10_000, maxOutput: 10_000 }, { catalog: custom }))), [
      'openrouter/openai/gpt-a',
      'openai/gpt-a',
    ]);
  });

  test('estimateCost caps the default output at the model max output', () => {
    const small = entry('openai', 'gpt-a', 'gpt-a', 0, 1_000_000, { max_output: 100 });
    assert.equal(estimateCost(0, null, small), 100);
    assert.equal(estimateCost(0, 50, small), 50);
  });

  test('fastest ranks by health p50, unmeasured providers after measured ones', () => {
    const snapshot = health({ openai: { p50: 120 }, openrouter: { p50: 450 } });
    const result = routed(select(input({}, { health: snapshot, routing: routing({ policy: 'fastest' }) })));
    assert.deepEqual(refs(result), ['openai/gpt-a', 'openrouter/openai/gpt-a']);

    const onlyOneMeasured = health({ openai: { p50: 9_000 } });
    const unknownLast = routed(select(input({}, { health: onlyOneMeasured, routing: routing({ policy: 'fastest' }) })));
    assert.deepEqual(refs(unknownLast), ['openai/gpt-a', 'openrouter/openai/gpt-a']);

    const noneMeasured = routed(select(input({}, { routing: routing({ policy: 'fastest' }) })));
    assert.deepEqual(refs(noneMeasured), ['openrouter/openai/gpt-a', 'openai/gpt-a'], 'falls back to price');
  });

  test('balancedScore follows the documented formula', () => {
    assert.equal(BALANCED_COST_WEIGHT, 0.5);
    assert.equal(balancedScore(10, 100, 10, 400), 0.5 * 1 + 0.5 * 0.25);
    assert.equal(balancedScore(5, 400, 10, 400), 0.5 * 0.5 + 0.5 * 1);
    assert.equal(balancedScore(5, null, 10, 400), 0.5 * 0.5 + 0.5 * 1, 'unmeasured latency counts as the slowest');
    assert.equal(balancedScore(0, 0, 0, 0), 0, 'all free and instant');
  });

  test('balanced trades price against latency', () => {
    const custom: Catalog = {
      models: [entry('openai', 'gpt-a', 'gpt-a', 10, 10), entry('openrouter', 'openai/gpt-a', 'gpt-a', 5, 5)],
    };
    // openai: 0.5 x 1 + 0.5 x 0.25 = 0.625; openrouter: 0.5 x 0.5 + 0.5 x 1 = 0.75.
    const fastPricey = health({ openai: { p50: 100 }, openrouter: { p50: 400 } });
    const first = routed(
      select(input({}, { catalog: custom, health: fastPricey, routing: routing({ policy: 'balanced' }) })),
    );
    assert.deepEqual(refs(first), ['openai/gpt-a', 'openrouter/openai/gpt-a']);
    // openai: 0.5 x 1 + 0.5 x 0.8 = 0.9; openrouter: 0.5 x 0.5 + 0.5 x 1 = 0.75.
    const closeLatency = health({ openai: { p50: 400 }, openrouter: { p50: 500 } });
    const second = routed(
      select(input({}, { catalog: custom, health: closeLatency, routing: routing({ policy: 'balanced' }) })),
    );
    assert.deepEqual(refs(second), ['openrouter/openai/gpt-a', 'openai/gpt-a']);
  });

  test('pinned puts an eligible pinned target first, the rest follow as cheapest fallbacks', () => {
    const settings = routing({ policy: 'pinned', pinned: { provider: 'openai', model: 'gpt-a' } });
    const result = routed(select(input({}, { routing: settings })));
    assert.deepEqual(refs(result), ['openai/gpt-a', 'openrouter/openai/gpt-a']);
    assert.deepEqual(result.trace.pinned, { provider: 'openai', model: 'gpt-a', eligible: true });
  });

  test('pinned is ignored when the target lacks a needed capability', () => {
    const settings = routing({ policy: 'pinned', pinned: { provider: 'openrouter', model: 'openai/gpt-a' } });
    const result = routed(select(input({ needs: { vision: true } }, { routing: settings })));
    assert.deepEqual(refs(result), ['openai/gpt-a']);
    assert.deepEqual(result.trace.pinned, { provider: 'openrouter', model: 'openai/gpt-a', eligible: false });
  });

  test('pinned never swaps in a different model than the one requested', () => {
    const settings = routing({ policy: 'pinned', pinned: { provider: 'deepseek', model: 'ds-small' } });
    const result = routed(select(input({}, { routing: settings })));
    assert.deepEqual(refs(result), ['openrouter/openai/gpt-a', 'openai/gpt-a']);
    assert.equal(result.trace.pinned?.eligible, false);
  });

  test('a policy override replaces the configured policy for one request', () => {
    const snapshot = health({ openai: { p50: 50 }, openrouter: { p50: 900 } });
    const result = routed(select({ ...input({}, { health: snapshot }), overrides: { policy: 'fastest' } }));
    assert.equal(result.trace.policy, 'fastest');
    assert.deepEqual(refs(result), ['openai/gpt-a', 'openrouter/openai/gpt-a']);
  });
});

describe('select — no candidate', () => {
  test('a model not in the catalog passes through to the native provider of the format', () => {
    const openai = select(input({ model: 'unknown-model', format: 'openai' }));
    assert.equal(openai.decision, 'passthrough');
    assert.deepEqual(openai.candidates, [
      { provider: 'openai', model: 'unknown-model', entry: null, substitution: null },
    ]);
    assert.equal(openai.decision === 'passthrough' && openai.cause, 'not_in_catalog');
    assert.equal(openai.trace.requested.canonicalModel, null);
    assert.deepEqual(openai.trace.considered, []);

    const anthropic = select(input({ model: 'unknown-model', format: 'anthropic' }));
    assert.deepEqual(anthropic.candidates, [
      { provider: 'anthropic', model: 'unknown-model', entry: null, substitution: null },
    ]);
  });

  test('passthrough goes to the provider named by the override', () => {
    const result = select({ ...input({ model: 'unknown-model' }), overrides: { provider: 'deepseek' } });
    assert.deepEqual(result.candidates, [
      { provider: 'deepseek', model: 'unknown-model', entry: null, substitution: null },
    ]);
  });

  test('no eligible candidate passes the requested model through unchanged', () => {
    const result = select(input({ model: 'gpt-a', needs: { vision: true } }, { registry: registry(['openrouter']) }));
    assert.equal(result.decision, 'passthrough');
    assert.equal(result.decision === 'passthrough' && result.cause, 'no_candidate');
    assert.deepEqual(result.candidates, [
      { provider: 'openai', model: 'gpt-a', entry: catalog.models[0], substitution: null },
    ]);
  });

  test('fail mode names the missing capability', () => {
    const result = select(
      input(
        { model: 'gpt-a', needs: { vision: true } },
        { registry: registry(['openrouter']), routing: routing({ on_no_candidate: 'fail' }) },
      ),
    );
    assert.equal(result.decision, 'fail');
    if (result.decision !== 'fail') return;
    assert.deepEqual(result.candidates, []);
    assert.equal(result.cause, 'no_candidate');
    assert.equal(
      result.message,
      'no provider can serve model "gpt-a" for this request: provider not configured (disabled or its key is not set) (openai/gpt-a); missing capability: vision (openrouter/openai/gpt-a)',
    );
  });

  test('fail mode for a model not in the catalog says so', () => {
    const result = select(input({ model: 'unknown-model' }, { routing: routing({ on_no_candidate: 'fail' }) }));
    assert.equal(result.decision, 'fail');
    if (result.decision !== 'fail') return;
    assert.equal(result.cause, 'not_in_catalog');
    assert.match(result.message, /model "unknown-model" is not in the Tollwise catalog/);
  });

  test('tools on a local model without tool support fail with the capability named', () => {
    const result = select(
      input({ model: 'llama', needs: { tools: true } }, { routing: routing({ on_no_candidate: 'fail' }) }),
    );
    assert.equal(result.decision, 'fail');
    if (result.decision !== 'fail') return;
    assert.match(result.message, /missing capability: tools \(ollama\/llama\)/);
  });
});
