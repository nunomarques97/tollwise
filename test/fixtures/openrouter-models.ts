// A trimmed OpenRouter /api/v1/models response used by test/catalog-update.test.ts.
//
// This is NOT a literal recording of a live call: tests never make real network calls, so there is
// nothing to record from. It is built by hand from the shape OpenRouter documents and publishes
// for this endpoint (an object with a top-level "data" array, each item carrying "id",
// "context_length", "pricing" as per-token USD decimal strings, "architecture.input_modalities",
// "top_provider.max_completion_tokens" and "supported_parameters") and trimmed to exactly the
// four models the tests need. Field names and shapes match the documented format; the reported
// values themselves are made up for the test.

export interface OpenRouterFixtureModel {
  readonly id: string;
  readonly context_length: number;
  readonly pricing: {
    readonly prompt: string;
    readonly completion: string;
    readonly input_cache_read?: string;
  };
  readonly architecture?: { readonly input_modalities: readonly string[] };
  readonly top_provider: { readonly context_length: number | null; readonly max_completion_tokens: number | null };
  readonly supported_parameters?: readonly string[];
}

/** Matches test/fixtures/catalog-update.yaml's "unchanged/model-a" entry exactly: no diff expected. */
const UNCHANGED_MODEL: OpenRouterFixtureModel = {
  id: 'unchanged/model-a',
  context_length: 100_000,
  pricing: { prompt: '0.000001', completion: '0.000002', input_cache_read: '0.0000005' },
  architecture: { input_modalities: ['text'] },
  top_provider: { context_length: 100_000, max_completion_tokens: 50_000 },
  supported_parameters: ['tools', 'response_format'],
};

/** Prices moved down from the catalog's "changed/model-b" entry: expect a price diff, nothing else. */
const CHANGED_PRICE_MODEL: OpenRouterFixtureModel = {
  id: 'changed/model-b',
  context_length: 200_000,
  pricing: { prompt: '0.000004', completion: '0.000009' },
  architecture: { input_modalities: ['text', 'image'] },
  top_provider: { context_length: 200_000, max_completion_tokens: 100_000 },
  supported_parameters: [],
};

/** Not present in the test catalog at all: expect it to show up as "added". */
const NEW_MODEL: OpenRouterFixtureModel = {
  id: 'new/model-c',
  context_length: 50_000,
  pricing: { prompt: '0.0000001', completion: '0.0000002' },
  architecture: { input_modalities: ['text'] },
  top_provider: { context_length: 50_000, max_completion_tokens: null },
  supported_parameters: ['tools'],
};

/**
 * Matches test/fixtures/catalog-update.yaml's "sparse/model-e" on every field it states, and
 * states little: no max_completion_tokens, no cache price, no supported_parameters, no
 * architecture. The curated catalog values for those fields must survive untouched.
 */
const SPARSE_MODEL: OpenRouterFixtureModel = {
  id: 'sparse/model-e',
  context_length: 32_000,
  pricing: { prompt: '0.0000003', completion: '0.0000006' },
  top_provider: { context_length: null, max_completion_tokens: null },
};

// test/fixtures/catalog-update.yaml also has a "gone/model-d" openrouter entry that is
// deliberately absent here, so tests can check it is reported as "removed".

export const OPENROUTER_MODELS_FIXTURE = {
  data: [UNCHANGED_MODEL, CHANGED_PRICE_MODEL, NEW_MODEL, SPARSE_MODEL],
};
