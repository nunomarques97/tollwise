import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  CatalogError,
  defaultCatalogPath,
  findEntry,
  groupByCanonical,
  listByCanonical,
  loadCatalogFile,
  parseCatalog,
  parseCatalogText,
} from '../src/catalog/index.ts';

const VALID_ENTRY = {
  provider: 'openai',
  model: 'gpt-6-astra',
  canonical_model: 'gpt-6-astra',
  price: { input: 10, output: 50, cached_input: 1 },
  context_window: 1_050_000,
  max_output: 128_000,
  capabilities: { tools: true, json_mode: true, vision: true, streaming: true },
  source_url: 'https://developers.openai.com/api/docs/models/gpt-6-astra',
  verified_on: '2026-09-19',
};

/** Deep-clones VALID_ENTRY, optionally overriding a top-level or price field. */
function entry(overrides: Record<string, unknown> = {}, priceOverrides: Record<string, unknown> = {}) {
  return {
    ...structuredClone(VALID_ENTRY),
    ...overrides,
    price: { ...structuredClone(VALID_ENTRY.price), ...priceOverrides },
  };
}

function expectRejected(models: unknown[]): CatalogError {
  try {
    parseCatalog({ models }, 'test.yaml');
  } catch (error) {
    assert.ok(error instanceof CatalogError, `expected CatalogError, got ${String(error)}`);
    return error;
  }
  assert.fail('expected the catalog to be rejected');
}

describe('schema validation', () => {
  test('a well-formed catalog is accepted', () => {
    const catalog = parseCatalog({ models: [entry()] });
    assert.equal(catalog.models.length, 1);
    assert.equal(catalog.models[0]?.model, 'gpt-6-astra');
  });

  test('cached_input may be null (no prompt-caching discount)', () => {
    const catalog = parseCatalog({ models: [entry({}, { cached_input: null })] });
    assert.equal(catalog.models[0]?.price.cached_input, null);
  });

  test('an empty catalog is rejected', () => {
    const error = expectRejected([]);
    assert.equal(error.problems.length, 1);
    assert.match(error.lines()[0] ?? '', /at least one model/);
  });

  test('a missing source_url is rejected, naming the entry and field', () => {
    const bad = entry() as Record<string, unknown>;
    delete bad.source_url;
    const error = expectRejected([bad]);
    assert.equal(error.problems.length, 1);
    assert.equal(error.problems[0]?.field, 'source_url');
    assert.match(error.problems[0]?.entry ?? '', /^models\[0\] \(openai\/gpt-6-astra\)$/);
    assert.match(error.lines()[0] ?? '', /^test\.yaml: models\[0\] \(openai\/gpt-6-astra\): source_url: /);
  });

  test('an empty source_url is rejected', () => {
    const error = expectRejected([entry({ source_url: '' })]);
    assert.match(error.lines()[0] ?? '', /source_url: is required/);
  });

  test('a source_url that is not a valid http(s) URL is rejected', () => {
    const error = expectRejected([entry({ source_url: 'not a url' })]);
    assert.match(error.lines()[0] ?? '', /source_url: .*not a valid URL/);
  });

  test('a missing verified_on is rejected, naming the entry and field', () => {
    const bad = entry() as Record<string, unknown>;
    delete bad.verified_on;
    const error = expectRejected([bad]);
    assert.equal(error.problems[0]?.field, 'verified_on');
    assert.match(error.lines()[0] ?? '', /^test\.yaml: models\[0\] \(openai\/gpt-6-astra\): verified_on: /);
  });

  test('a verified_on that is not an ISO date is rejected', () => {
    const error = expectRejected([entry({ verified_on: '19 Sep 2026' })]);
    assert.match(error.lines()[0] ?? '', /verified_on: must be an ISO date/);
  });

  test('a verified_on that is not a real calendar date is rejected', () => {
    const error = expectRejected([entry({ verified_on: '2026-13-40' })]);
    assert.match(error.lines()[0] ?? '', /verified_on: is not a real calendar date/);
  });

  for (const day of ['2026-02-30', '2026-04-31', '2025-02-29']) {
    test(`a verified_on whose day does not exist in that month (${day}) is rejected`, () => {
      const error = expectRejected([entry({ verified_on: day })]);
      assert.match(error.lines()[0] ?? '', /verified_on: is not a real calendar date/);
    });
  }

  test('a verified_on on a leap day of a leap year is accepted', () => {
    const catalog = parseCatalog({ models: [entry({ verified_on: '2028-02-29' })] }, 'test.yaml');
    assert.equal(catalog.models[0]?.verified_on, '2028-02-29');
  });

  test('duplicate provider+model entries are rejected', () => {
    const error = expectRejected([entry(), entry({ canonical_model: 'gpt-6-astra-again' })]);
    assert.equal(error.problems.length, 1);
    assert.match(error.problems[0]?.entry ?? '', /^models\[1\]/);
    assert.match(
      error.lines()[0] ?? '',
      /duplicate entry for provider "openai" model "gpt-6-astra" \(already listed at models\[0\]\)/,
    );
  });

  test('the same model id under a different provider is not a duplicate', () => {
    const catalog = parseCatalog({ models: [entry(), entry({ provider: 'openrouter' })] });
    assert.equal(catalog.models.length, 2);
  });

  for (const field of ['input', 'output', 'cached_input'] as const) {
    test(`a negative ${field} price is rejected`, () => {
      const error = expectRejected([entry({}, { [field]: -1 })]);
      assert.equal(error.problems[0]?.field, `price.${field}`);
      assert.match(error.lines()[0] ?? '', /must not be negative/);
    });
  }

  test('a zero price is accepted (a free local model)', () => {
    const catalog = parseCatalog({ models: [entry({}, { input: 0, output: 0, cached_input: 0 })] });
    assert.equal(catalog.models[0]?.price.input, 0);
  });

  test('an unknown provider is rejected', () => {
    const error = expectRejected([entry({ provider: 'made-up' })]);
    assert.equal(error.problems[0]?.field, 'provider');
  });

  test('a non-positive context_window or max_output is rejected', () => {
    assert.equal(expectRejected([entry({ context_window: 0 })]).problems[0]?.field, 'context_window');
    assert.equal(expectRejected([entry({ max_output: -100 })]).problems[0]?.field, 'max_output');
  });

  test('an unknown field on an entry is rejected', () => {
    const error = expectRejected([entry({ made_up_field: true })]);
    assert.equal(error.problems[0]?.field, 'made_up_field');
    assert.match(error.lines()[0] ?? '', /unknown field "made_up_field"/);
  });

  test('invalid YAML text is reported without a stack trace leaking through', () => {
    try {
      parseCatalogText('models:\n  - provider: [\n', 'bad.yaml');
    } catch (error) {
      assert.ok(error instanceof CatalogError);
      assert.match(error.lines()[0] ?? '', /^bad\.yaml: catalog: invalid YAML:/);
      return;
    }
    assert.fail('expected invalid YAML to be rejected');
  });
});

describe('lookup and canonical grouping', () => {
  const catalog = parseCatalog({
    models: [
      entry(),
      entry({ provider: 'openrouter', model: 'openai/gpt-6-astra' }),
      entry({ model: 'gpt-5.6-luna', canonical_model: 'gpt-5.6-luna' }),
    ],
  });

  test('findEntry looks up by exact provider and model id', () => {
    assert.equal(findEntry(catalog, 'openai', 'gpt-6-astra')?.canonical_model, 'gpt-6-astra');
    assert.equal(findEntry(catalog, 'openrouter', 'openai/gpt-6-astra')?.provider, 'openrouter');
    assert.equal(findEntry(catalog, 'anthropic', 'gpt-6-astra'), undefined);
    assert.equal(findEntry(catalog, 'openai', 'no-such-model'), undefined);
  });

  test('listByCanonical returns every provider offering the same canonical model', () => {
    const offers = listByCanonical(catalog, 'gpt-6-astra');
    assert.equal(offers.length, 2);
    assert.deepEqual(
      offers.map((e) => e.provider),
      ['openai', 'openrouter'],
    );
    assert.equal(listByCanonical(catalog, 'no-such-canonical').length, 0);
  });

  test('groupByCanonical groups every entry by canonical model id', () => {
    const groups = groupByCanonical(catalog);
    assert.equal(groups.size, 2);
    assert.equal(groups.get('gpt-6-astra')?.length, 2);
    assert.equal(groups.get('gpt-5.6-luna')?.length, 1);
  });
});

describe('the shipped catalog file', () => {
  test('validates as-is', () => {
    const catalog = loadCatalogFile(defaultCatalogPath());
    assert.ok(catalog.models.length >= 15, `expected at least 15 seeded entries, got ${catalog.models.length}`);
  });

  test('every entry has a source_url and a verified_on date', () => {
    const catalog = loadCatalogFile(defaultCatalogPath());
    for (const model of catalog.models) {
      assert.ok(model.source_url.startsWith('https://'), `${model.provider}/${model.model} has no https source_url`);
      assert.match(model.verified_on, /^\d{4}-\d{2}-\d{2}$/, `${model.provider}/${model.model} verified_on`);
    }
  });

  test('covers a flagship and a small model for anthropic, openai and deepseek, directly and via openrouter', () => {
    const catalog = loadCatalogFile(defaultCatalogPath());
    const direct = new Set(
      catalog.models.filter((m) => m.provider !== 'openrouter' && m.provider !== 'ollama').map((m) => m.provider),
    );
    assert.deepEqual([...direct].sort(), ['anthropic', 'deepseek', 'openai']);

    const canonicalByDirectProvider = new Map<string, Set<string>>();
    for (const model of catalog.models) {
      if (model.provider === 'openrouter' || model.provider === 'ollama') continue;
      const set = canonicalByDirectProvider.get(model.provider) ?? new Set<string>();
      set.add(model.canonical_model);
      canonicalByDirectProvider.set(model.provider, set);
    }
    for (const [provider, canonicals] of canonicalByDirectProvider) {
      assert.ok(canonicals.size >= 2, `${provider} should seed at least 2 models (flagship + small)`);
      for (const canonical of canonicals) {
        const viaOpenRouter = catalog.models.some(
          (m) => m.provider === 'openrouter' && m.canonical_model === canonical,
        );
        assert.ok(viaOpenRouter, `${canonical} (from ${provider}) has no openrouter equivalent`);
      }
    }
  });

  test('groups each DeepSeek model with its exact OpenRouter version, under a versioned canonical id', () => {
    const catalog = loadCatalogFile(defaultCatalogPath());
    const members = (canonical: string) =>
      listByCanonical(catalog, canonical)
        .map((m) => `${m.provider}/${m.model}`)
        .sort();
    assert.deepEqual(members('deepseek-v4.1-flash'), [
      'deepseek/deepseek-flash',
      'openrouter/deepseek/deepseek-v4.1-flash',
    ]);
    assert.deepEqual(members('deepseek-v4-pro-0813'), [
      'deepseek/deepseek-v4-pro',
      'openrouter/deepseek/deepseek-v4-pro-0813',
    ]);
    // Unversioned family names would also match older releases sold under similar ids.
    assert.deepEqual(members('deepseek-v4-flash'), []);
    assert.deepEqual(members('deepseek-v4-pro'), []);
  });

  test('includes Ollama local models priced at zero', () => {
    const catalog = loadCatalogFile(defaultCatalogPath());
    const ollamaModels = catalog.models.filter((m) => m.provider === 'ollama');
    assert.ok(ollamaModels.length >= 2, 'expected at least a couple of Ollama models');
    for (const model of ollamaModels) {
      assert.equal(model.price.input, 0);
      assert.equal(model.price.output, 0);
      assert.ok(model.source_url.includes('ollama.com'), `${model.model} source_url should point at ollama.com`);
    }
  });
});
