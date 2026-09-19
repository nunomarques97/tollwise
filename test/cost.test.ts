import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Catalog, ModelEntry } from '../src/catalog/schema.ts';
import type { ProviderId } from '../src/config/schema.ts';
import { type CostUsage, computeCost, formatUsd, selectBaselineEntry } from '../src/pricing/cost.ts';

const ALL_CAPS = { tools: true, json_mode: true, vision: true, streaming: true };

function entry(
  provider: ProviderId,
  model: string,
  price: { input: number; output: number; cached_input?: number | null },
  extra: Partial<Pick<ModelEntry, 'canonical_model' | 'verified_on'>> = {},
): ModelEntry {
  return {
    provider,
    model,
    canonical_model: extra.canonical_model ?? model,
    price: { input: price.input, output: price.output, cached_input: price.cached_input ?? null },
    context_window: 128_000,
    max_output: 16_000,
    capabilities: ALL_CAPS,
    source_url: 'https://example.com/pricing',
    verified_on: extra.verified_on ?? '2026-09-01',
  };
}

function usage(fields: Partial<CostUsage>): CostUsage {
  return { input: 0, cached_input: 0, output: 0, ...fields };
}

describe('computeCost — known prices', () => {
  test('input and output priced against the used entry, savings against the baseline', () => {
    const usedEntry = entry('openai', 'gpt-a', { input: 2, output: 8 });
    const baselineEntry = entry('anthropic', 'claude-x', { input: 3, output: 15 });
    const result = computeCost({
      usage: usage({ input: 1_000, output: 500 }),
      origin: 'reported',
      usedEntry,
      baselineEntry,
    });

    // used: 1000 * 2 + 500 * 8 = 6000 micro-dollars = $0.006000
    assert.equal(result.cost_usd, '0.006000');
    // baseline: 1000 * 3 + 500 * 15 = 10500 micro-dollars = $0.010500
    assert.equal(result.baseline_usd, '0.010500');
    // savings: 10500 - 6000 = 4500 micro-dollars = $0.004500
    assert.equal(result.savings_usd, '0.004500');
    assert.equal(result.origin, 'reported');
    assert.equal(result.used_price_verified_on, '2026-09-01');
    assert.equal(result.baseline_price_verified_on, '2026-09-01');
  });
});

describe('computeCost — cached input', () => {
  test('cache-hit tokens are priced at cached_input, not input', () => {
    const usedEntry = entry('anthropic', 'claude-x', { input: 5, output: 10, cached_input: 1 });
    const result = computeCost({
      usage: usage({ input: 2_000, cached_input: 1_500, output: 100 }),
      origin: 'reported',
      usedEntry,
      baselineEntry: undefined,
    });

    // uncached input: 500 * 5 = 2500; cached: 1500 * 1 = 1500; output: 100 * 10 = 1000; total 5000
    assert.equal(result.cost_usd, '0.005000');
  });

  test('falls back to the input price when the entry has no cached_input price', () => {
    const usedEntry = entry('anthropic', 'claude-x', { input: 5, output: 10, cached_input: null });
    const result = computeCost({
      usage: usage({ input: 2_000, cached_input: 1_500, output: 100 }),
      origin: 'reported',
      usedEntry,
      baselineEntry: undefined,
    });

    // every input token (cached or not) at 5: 2000 * 5 = 10000; output: 100 * 10 = 1000; total 11000
    assert.equal(result.cost_usd, '0.011000');
  });
});

describe('computeCost — cached input against a baseline', () => {
  test('cached tokens are priced at the cached rate of their own entry', () => {
    const usedEntry = entry('openai', 'gpt-a', { input: 2, output: 8, cached_input: 0.5 });
    const baselineEntry = entry('anthropic', 'claude-x', { input: 3, output: 15, cached_input: 0.3 });
    const result = computeCost({
      usage: usage({ input: 10_000, cached_input: 8_000, output: 1_000 }),
      origin: 'reported',
      usedEntry,
      baselineEntry,
    });

    // used: 2000*2 + 8000*0.5 + 1000*8 = 4000 + 4000 + 8000 = 16000
    assert.equal(result.cost_usd, '0.016000');
    // baseline: 2000*3 + 8000*0.3 + 1000*15 = 6000 + 2400 + 15000 = 23400
    assert.equal(result.baseline_usd, '0.023400');
    // savings: 23400 - 16000 = 7400
    assert.equal(result.savings_usd, '0.007400');
  });

  test('a baseline without a cached price bills its cached tokens at its input price', () => {
    const usedEntry = entry('openai', 'gpt-a', { input: 2, output: 8, cached_input: 0.5 });
    const baselineEntry = entry('anthropic', 'claude-x', { input: 3, output: 15, cached_input: null });
    const result = computeCost({
      usage: usage({ input: 10_000, cached_input: 8_000, output: 1_000 }),
      origin: 'estimated',
      usedEntry,
      baselineEntry,
    });

    // used: 16000 as above; baseline: 10000*3 + 1000*15 = 45000; savings: 29000
    assert.equal(result.cost_usd, '0.016000');
    assert.equal(result.baseline_usd, '0.045000');
    assert.equal(result.savings_usd, '0.029000');
    assert.equal(result.origin, 'estimated');
  });
});

describe('computeCost — invalid usage', () => {
  const usedEntry = entry('openai', 'gpt-a', { input: 10, output: 20, cached_input: 1 });
  const baselineEntry = entry('anthropic', 'claude-x', { input: 3, output: 15 });

  function priced(fields: Partial<CostUsage>) {
    return () => computeCost({ usage: usage(fields), origin: 'reported', usedEntry, baselineEntry });
  }

  test('rejects cached_input greater than input', () => {
    assert.throws(priced({ input: 100, cached_input: 1_000 }), {
      name: 'RangeError',
      message: /cached_input \(1000\) must not exceed usage\.input \(100\)/,
    });
  });

  for (const field of ['input', 'cached_input', 'output'] as const) {
    test(`rejects a negative ${field}`, () => {
      const fields: Partial<CostUsage> = { input: 10, [field]: -5 };
      assert.throws(priced(fields), {
        name: 'RangeError',
        message: new RegExp(`^usage[.]${field} must be a non-negative integer`),
      });
    });

    test(`rejects NaN ${field}`, () => {
      const fields: Partial<CostUsage> = { input: 10, [field]: Number.NaN };
      assert.throws(priced(fields), {
        name: 'RangeError',
        message: new RegExp(`^usage[.]${field} must be a non-negative integer`),
      });
    });

    test(`rejects a non-integer ${field}`, () => {
      const fields: Partial<CostUsage> = { input: 10, [field]: 2.5 };
      assert.throws(priced(fields), {
        name: 'RangeError',
        message: new RegExp(`^usage[.]${field} must be a non-negative integer`),
      });
    });

    test(`rejects an infinite ${field}`, () => {
      const fields: Partial<CostUsage> = { input: 10, [field]: Number.POSITIVE_INFINITY };
      assert.throws(priced(fields), {
        name: 'RangeError',
        message: new RegExp(`^usage[.]${field} must be a non-negative integer`),
      });
    });
  }

  test('accepts cached_input equal to input', () => {
    // all 100 input tokens cached at 1, output 0: 100 micro-dollars
    assert.equal(priced({ input: 100, cached_input: 100 })().cost_usd, '0.000100');
  });

  test('accepts all-zero usage as a real zero cost', () => {
    const result = priced({})();
    assert.equal(result.cost_usd, '0.000000');
    assert.equal(result.savings_usd, '0.000000');
  });
});

describe('computeCost — rounding', () => {
  test('rounds each tier to the nearest micro-dollar', () => {
    const cheap = entry('openai', 'mini', { input: 0.075, output: 0.3 });
    // input: 1 * 0.075 = 0.075 -> 0; output: 7 * 0.3 = 2.1 -> 2
    const result = computeCost({
      usage: usage({ input: 1, output: 7 }),
      origin: 'reported',
      usedEntry: cheap,
      baselineEntry: undefined,
    });
    assert.equal(result.cost_usd, '0.000002');
  });
});

describe('computeCost — negative savings', () => {
  test('a savings that is actually a loss is reported as a negative number, not hidden', () => {
    const usedEntry = entry('openrouter', 'expensive-model', { input: 10, output: 20 });
    const baselineEntry = entry('openai', 'cheap-model', { input: 1, output: 2 });
    const result = computeCost({
      usage: usage({ input: 1_000, output: 500 }),
      origin: 'reported',
      usedEntry,
      baselineEntry,
    });

    // used: 1000*10 + 500*20 = 20000; baseline: 1000*1 + 500*2 = 2000; savings: 2000 - 20000 = -18000
    assert.equal(result.cost_usd, '0.020000');
    assert.equal(result.baseline_usd, '0.002000');
    assert.equal(result.savings_usd, '-0.018000');
  });
});

describe('computeCost — unknown baseline', () => {
  test('baseline_usd and savings_usd are the string "unknown", never 0', () => {
    const usedEntry = entry('openai', 'gpt-a', { input: 2, output: 8 });
    const result = computeCost({
      usage: usage({ input: 1_000, output: 500 }),
      origin: 'reported',
      usedEntry,
      baselineEntry: undefined,
    });

    assert.equal(result.baseline_usd, 'unknown');
    assert.equal(result.savings_usd, 'unknown');
    assert.equal(result.baseline_price_verified_on, 'unknown');
    // the used cost is still a real, computed number
    assert.equal(result.cost_usd, '0.006000');
    assert.notEqual(result.cost_usd, 'unknown');
  });
});

describe('computeCost — free local model', () => {
  test('a price of 0 is a real 0, not "unknown"', () => {
    const usedEntry = entry('ollama', 'llama', { input: 0, output: 0 });
    const baselineEntry = entry('openai', 'gpt-a', { input: 2, output: 8 });
    const result = computeCost({
      usage: usage({ input: 1_000, cached_input: 200, output: 500 }),
      origin: 'reported',
      usedEntry,
      baselineEntry,
    });

    assert.equal(result.cost_usd, '0.000000');
    assert.notEqual(result.cost_usd, 'unknown');
    // baseline: 1000*2 + 500*8 = 6000; savings: 6000 - 0 = 6000
    assert.equal(result.baseline_usd, '0.006000');
    assert.equal(result.savings_usd, '0.006000');
  });
});

describe('computeCost — origin', () => {
  test('passes reported through unchanged', () => {
    const usedEntry = entry('openai', 'gpt-a', { input: 2, output: 8 });
    const result = computeCost({
      usage: usage({ input: 100, output: 50 }),
      origin: 'reported',
      usedEntry,
      baselineEntry: undefined,
    });
    assert.equal(result.origin, 'reported');
  });

  test('passes estimated through unchanged', () => {
    const usedEntry = entry('openai', 'gpt-a', { input: 2, output: 8 });
    const result = computeCost({
      usage: usage({ input: 100, output: 50 }),
      origin: 'estimated',
      usedEntry,
      baselineEntry: undefined,
    });
    assert.equal(result.origin, 'estimated');
  });
});

describe('formatUsd', () => {
  test('renders a whole-dollar amount with six fixed decimals', () => {
    assert.equal(formatUsd(1_000_000), '1.000000');
  });

  test('renders a negative amount with a leading minus and no double sign', () => {
    assert.equal(formatUsd(-500_000), '-0.500000');
  });

  test('renders zero without a sign', () => {
    assert.equal(formatUsd(0), '0.000000');
  });

  test('pads a sub-cent amount to six decimals', () => {
    assert.equal(formatUsd(1), '0.000001');
  });

  test('rejects a non-integer amount instead of rendering garbage', () => {
    assert.throws(() => formatUsd(0.5), RangeError);
    assert.throws(() => formatUsd(Number.NaN), RangeError);
  });
});

describe('selectBaselineEntry', () => {
  const catalog: Catalog = {
    models: [
      entry('openrouter', 'gpt-a', { input: 2, output: 8 }, { canonical_model: 'gpt-a' }),
      entry('openai', 'gpt-a', { input: 2.5, output: 9 }, { canonical_model: 'gpt-a' }),
      entry('anthropic', 'claude-x', { input: 3, output: 15 }, { canonical_model: 'claude-x' }),
    ],
  };

  test('prefers the native provider of the request format when several entries name the same model id', () => {
    const found = selectBaselineEntry(catalog, 'gpt-a', 'openai');
    assert.equal(found?.provider, 'openai');
  });

  test('falls back to catalog order when no entry belongs to the native provider', () => {
    const found = selectBaselineEntry(catalog, 'gpt-a', 'anthropic');
    assert.equal(found?.provider, 'openrouter');
  });

  test('matches the exact requested model id', () => {
    const found = selectBaselineEntry(catalog, 'claude-x', 'anthropic');
    assert.equal(found?.model, 'claude-x');
    assert.equal(found?.provider, 'anthropic');

    const noMatch = selectBaselineEntry(catalog, 'unknown-model-id', 'openai');
    assert.equal(noMatch, undefined);
  });

  test('never matches on canonical_model alone', () => {
    const aliased: Catalog = {
      models: [
        entry('openrouter', 'vendor/sonnet-x', { input: 3, output: 15 }, { canonical_model: 'sonnet-x' }),
        entry('openai', 'gpt-a', { input: 2, output: 8 }, { canonical_model: 'sonnet-x' }),
      ],
    };
    // "sonnet-x" is only a canonical_model here; no entry's own model id is "sonnet-x".
    assert.equal(selectBaselineEntry(aliased, 'sonnet-x', 'anthropic'), undefined);
    assert.equal(selectBaselineEntry(aliased, 'sonnet-x', 'openai'), undefined);
    // The entry's own model id still matches.
    assert.equal(selectBaselineEntry(aliased, 'vendor/sonnet-x', 'anthropic')?.provider, 'openrouter');
  });
});
