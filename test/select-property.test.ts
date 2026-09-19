// Property tests for the routing never-downgrade promise. Each run generates random catalogs,
// provider sets, health snapshots, routing settings and requests from one seed, and checks the
// invariants select() must keep for every one of them. The seed is printed as a test diagnostic;
// to replay a failing run, set TOLLWISE_SELECT_SEED to that number:
//
//   TOLLWISE_SELECT_SEED=123456 node --test test/select-property.test.ts

import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { test } from 'node:test';
import { loadCatalog } from '../src/catalog/index.ts';
import type { Catalog, ModelEntry } from '../src/catalog/schema.ts';
import {
  PROVIDER_IDS,
  type ProviderId,
  ROUTING_POLICIES,
  type RoutingPolicy,
  RoutingSchema,
} from '../src/config/schema.ts';
import type { HealthMonitorSnapshot } from '../src/health/monitor.ts';
import type { RequestNeeds } from '../src/routing/inspect.ts';
import { EQUIVALENCE_PRESETS, PRESET_NAMES } from '../src/routing/presets.ts';
import {
  CAPABILITIES,
  expectedOutputTokens,
  nativeProvider,
  type RoutingSettings,
  type SelectInput,
  type Selection,
  select,
} from '../src/routing/select.ts';

const CASES = 2_000;

/** mulberry32: a small, well-known 32-bit PRNG; deterministic for a given seed. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function readSeed(): number {
  const fromEnv = process.env.TOLLWISE_SELECT_SEED;
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    const seed = Number(fromEnv);
    assert.ok(Number.isSafeInteger(seed) && seed >= 0, `TOLLWISE_SELECT_SEED must be a non-negative integer`);
    return seed;
  }
  return randomInt(0, 2 ** 31);
}

class Gen {
  readonly next: () => number;
  constructor(seed: number) {
    this.next = prng(seed);
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    const item = items[Math.floor(this.next() * items.length)];
    if (item === undefined) throw new Error('pick from an empty list');
    return item;
  }
  subset<T>(items: readonly T[], p: number): T[] {
    return items.filter(() => this.chance(p));
  }
}

const CANONICALS = ['m-alpha', 'm-beta', 'm-gamma', 'm-delta', 'm-epsilon'];

function randomCatalog(gen: Gen): Catalog {
  const models: ModelEntry[] = [];
  const canonicals = gen.subset(CANONICALS, 0.6);
  if (canonicals.length === 0) canonicals.push(gen.pick(CANONICALS));
  for (const canonical of canonicals) {
    for (const provider of PROVIDER_IDS) {
      if (!gen.chance(0.55)) continue;
      // A provider names the model its own way: bare, vendor-prefixed, or with a local tag.
      const model = gen.pick([canonical, `vendor/${canonical}`, `${canonical}:latest`]);
      if (models.some((e) => e.provider === provider && e.model === model)) continue;
      const context = gen.pick([4_096, 8_192, 32_000, 128_000, 200_000, 1_000_000]);
      models.push({
        provider,
        model,
        canonical_model: canonical,
        price: {
          input: gen.chance(0.15) ? 0 : gen.int(1, 5_000) / 100,
          output: gen.chance(0.15) ? 0 : gen.int(1, 20_000) / 100,
          cached_input: null,
        },
        context_window: context,
        max_output: gen.int(256, context),
        capabilities: {
          tools: gen.chance(0.7),
          json_mode: gen.chance(0.7),
          vision: gen.chance(0.5),
          streaming: gen.chance(0.85),
        },
        source_url: 'https://example.com/pricing',
        verified_on: '2026-09-01',
      });
    }
  }
  if (models.length === 0) {
    models.push({
      provider: gen.pick(PROVIDER_IDS),
      model: canonicals[0] ?? 'm-alpha',
      canonical_model: canonicals[0] ?? 'm-alpha',
      price: { input: 1, output: 1, cached_input: null },
      context_window: 128_000,
      max_output: 16_000,
      capabilities: { tools: true, json_mode: true, vision: true, streaming: true },
      source_url: 'https://example.com/pricing',
      verified_on: '2026-09-01',
    });
  }
  return { models };
}

function randomHealth(gen: Gen): HealthMonitorSnapshot {
  return {
    providers: gen.subset(PROVIDER_IDS, 0.9).map((id) => ({
      id,
      state: gen.pick(['unknown', 'up', 'up', 'down'] as const),
      lastErrorKind: null,
      lastCheckedAt: null,
      p50: gen.chance(0.3) ? null : gen.int(0, 3_000),
      p95: null,
      sampleCount: 0,
    })),
  };
}

function randomRouting(gen: Gen, catalog: Catalog): RoutingSettings {
  const groups: { name: string; models: string[] }[] = [];
  if (gen.chance(0.5)) {
    // Disjoint groups of canonical ids or provider model ids, as the config schema requires.
    const pool = [...CANONICALS, ...catalog.models.map((e) => e.model)].filter((v, i, all) => all.indexOf(v) === i);
    const shuffled = pool.sort(() => gen.next() - 0.5);
    let index = 0;
    for (let g = 0; g < gen.int(1, 2); g++) {
      const size = gen.int(2, 3);
      const models = shuffled.slice(index, index + size);
      index += size;
      if (models.length >= 2) groups.push({ name: `group-${g}`, models });
    }
  }
  const policy = gen.pick(ROUTING_POLICIES);
  const pinnedEntry = gen.pick(catalog.models);
  const pinned = gen.chance(0.8) ? { provider: pinnedEntry.provider, model: pinnedEntry.model } : undefined;
  return {
    policy,
    on_no_candidate: gen.pick(['passthrough', 'fail'] as const),
    pinned,
    equivalence_groups: groups,
  };
}

function randomInput(gen: Gen): SelectInput {
  const catalog = randomCatalog(gen);
  const known = gen.pick(catalog.models);
  const requestedModel = gen.chance(0.1) ? 'not-a-listed-model' : gen.chance(0.2) ? known.canonical_model : known.model;
  const needs: RequestNeeds = {
    tools: gen.chance(0.3),
    json_mode: gen.chance(0.3),
    vision: gen.chance(0.25),
    streaming: gen.chance(0.5),
  };
  const policyOverride: RoutingPolicy | undefined = gen.chance(0.2) ? gen.pick(ROUTING_POLICIES) : undefined;
  const providerOverride: ProviderId | undefined = gen.chance(0.15) ? gen.pick(PROVIDER_IDS) : undefined;
  return {
    inspection: {
      format: gen.pick(['openai', 'anthropic'] as const),
      requestedModel,
      needs,
      estimatedInput: { tokens: gen.pick([0, gen.int(1, 2_000), gen.int(2_000, 250_000)]), origin: 'estimated' },
      maxOutput: gen.chance(0.4) ? null : gen.int(1, 150_000),
    },
    catalog,
    registry: { enabled: gen.subset(PROVIDER_IDS, 0.7).map((id) => ({ id })) },
    health: randomHealth(gen),
    routing: randomRouting(gen, catalog),
    overrides: { policy: policyOverride, provider: providerOverride },
  };
}

/** The explicit group that contains the requested model (by its own id or its canonical id), if any. */
function requestedGroup(input: SelectInput, canonical: string): Set<string> | null {
  const group = input.routing.equivalence_groups.find(
    (g) => g.models.includes(input.inspection.requestedModel) || g.models.includes(canonical),
  );
  return group === undefined ? null : new Set(group.models);
}

/** Independent statement of "this entry can serve this request without a downgrade". */
function servesWithoutDowngrade(input: SelectInput, entry: ModelEntry): boolean {
  const { needs, maxOutput, estimatedInput } = input.inspection;
  const enabled = input.registry.enabled.some((p) => p.id === entry.provider);
  const down = input.health.providers.some((p) => p.id === entry.provider && p.state === 'down');
  const provider = input.overrides?.provider;
  const capable = CAPABILITIES.every((c) => !needs[c] || entry.capabilities[c]);
  const outputFits = maxOutput === null || maxOutput <= entry.max_output;
  const contextFits = estimatedInput.tokens + expectedOutputTokens(maxOutput, entry) <= entry.context_window;
  return (
    enabled && !down && (provider === undefined || provider === entry.provider) && capable && outputFits && contextFits
  );
}

function checkInvariants(input: SelectInput, result: Selection): void {
  const requested = input.inspection.requestedModel;
  const canonical = result.trace.requested.canonicalModel;

  // The canonical model really is the requested one: some entry is named that way and maps to it.
  if (canonical !== null) {
    assert.ok(
      input.catalog.models.some(
        (e) => e.canonical_model === canonical && (e.model === requested || e.canonical_model === requested),
      ),
      `canonical ${canonical} does not belong to requested ${requested}`,
    );
  }

  if (result.decision === 'routed') {
    assert.ok(canonical !== null, 'a routed request has a known canonical model');
    assert.ok(result.candidates.length > 0);
    const group = requestedGroup(input, canonical);
    const seen = new Set<string>();
    for (const candidate of result.candidates) {
      const { entry } = candidate;
      assert.ok(input.catalog.models.includes(entry), 'candidate comes from the catalog');
      assert.equal(candidate.provider, entry.provider);
      assert.equal(candidate.model, entry.model);
      const key = `${entry.provider}/${entry.model}`;
      assert.ok(!seen.has(key), `duplicate candidate ${key}`);
      seen.add(key);

      // Same model, or a member of the explicit group that contains the requested model.
      const sameModel = entry.canonical_model === canonical;
      const inGroup = group !== null && (group.has(entry.canonical_model) || group.has(entry.model));
      assert.ok(sameModel || inGroup, `${key} is neither ${canonical} nor in its equivalence group`);

      // Every needed capability.
      for (const capability of CAPABILITIES) {
        if (input.inspection.needs[capability]) {
          assert.ok(entry.capabilities[capability], `${key} lacks ${capability}`);
        }
      }
      // Fits the context and the output budget.
      const { maxOutput, estimatedInput } = input.inspection;
      if (maxOutput !== null) assert.ok(maxOutput <= entry.max_output, `${key} max output too small`);
      assert.ok(
        estimatedInput.tokens + expectedOutputTokens(maxOutput, entry) <= entry.context_window,
        `${key} context too small`,
      );
      // Configured, not down, and on the requested provider when one is named.
      assert.ok(
        input.registry.enabled.some((p) => p.id === entry.provider),
        `${key} provider not configured`,
      );
      assert.ok(
        !input.health.providers.some((p) => p.id === entry.provider && p.state === 'down'),
        `${key} provider is down`,
      );
      if (input.overrides?.provider !== undefined) assert.equal(entry.provider, input.overrides.provider);
    }

    // Complete: every entry of the candidate pool that could serve the request is a candidate.
    const pool = input.catalog.models.filter(
      (e) =>
        e.canonical_model === canonical || (group !== null && (group.has(e.canonical_model) || group.has(e.model))),
    );
    const expected = pool.filter((e) => servesWithoutDowngrade(input, e)).map((e) => `${e.provider}/${e.model}`);
    assert.deepEqual([...seen].sort(), expected.sort(), 'candidates are exactly the eligible entries');

    // Ordering per policy.
    const policy = input.overrides?.policy ?? input.routing.policy;
    assert.equal(result.trace.policy, policy);
    const costs = result.candidates.map((c) => c.estimatedCost);
    if (policy === 'cheapest') {
      for (let i = 1; i < costs.length; i++) assert.ok((costs[i - 1] ?? 0) <= (costs[i] ?? 0), 'cheapest order');
    }
    if (policy === 'fastest') {
      const latencies = result.candidates.map((c) => c.p50);
      const firstUnknown = latencies.indexOf(null);
      if (firstUnknown !== -1)
        assert.ok(
          latencies.slice(firstUnknown).every((p) => p === null),
          'unknown last',
        );
      const known = latencies.filter((p): p is number => p !== null);
      for (let i = 1; i < known.length; i++) assert.ok((known[i - 1] ?? 0) <= (known[i] ?? 0), 'fastest order');
    }
    if (policy === 'pinned' && result.trace.pinned?.eligible === true) {
      assert.equal(result.candidates[0]?.provider, result.trace.pinned.provider);
      assert.equal(result.candidates[0]?.model, result.trace.pinned.model);
    }
    return;
  }

  // Not routed: no entry could serve the request without a downgrade.
  if (canonical !== null) {
    const group = requestedGroup(input, canonical);
    const pool = input.catalog.models.filter(
      (e) =>
        e.canonical_model === canonical || (group !== null && (group.has(e.canonical_model) || group.has(e.model))),
    );
    assert.ok(!pool.some((e) => servesWithoutDowngrade(input, e)), 'an eligible entry was left out');
  }

  if (result.decision === 'passthrough') {
    assert.equal(result.candidates.length, 1);
    const [target] = result.candidates;
    assert.equal(target.model, requested, 'passthrough never changes the model');
    assert.equal(target.provider, input.overrides?.provider ?? nativeProvider(input.inspection.format));
    assert.equal(input.routing.on_no_candidate, 'passthrough');
    return;
  }

  assert.equal(result.decision, 'fail');
  assert.equal(input.routing.on_no_candidate, 'fail');
  assert.equal(result.candidates.length, 0);
  assert.ok(result.message.length > 0);
  for (const excluded of result.trace.excluded) {
    if (excluded.reason.startsWith('missing_capability:')) {
      const capability = excluded.reason.slice('missing_capability:'.length);
      assert.ok(result.message.includes(`missing capability: ${capability}`), 'fail message names the capability');
    }
  }
}

test(`select keeps the never-downgrade invariants over ${CASES} random catalogs and requests`, (t) => {
  const seed = readSeed();
  t.diagnostic(`seed ${seed} (replay with TOLLWISE_SELECT_SEED=${seed})`);
  const gen = new Gen(seed);
  const outcomes = { routed: 0, passthrough: 0, fail: 0, swappedWithinGroup: 0 };

  for (let i = 0; i < CASES; i++) {
    const input = randomInput(gen);
    const result = select(input);
    try {
      checkInvariants(input, result);
    } catch (error) {
      throw new Error(`case ${i} of seed ${seed} failed: ${(error as Error).message}`, { cause: error });
    }
    outcomes[result.decision]++;
    if (
      result.decision === 'routed' &&
      result.candidates.some((c) => c.entry.canonical_model !== result.trace.requested.canonicalModel)
    ) {
      outcomes.swappedWithinGroup++;
    }
  }

  t.diagnostic(`outcomes ${JSON.stringify(outcomes)}`);
  // The generator must exercise every branch, or the invariants above prove little.
  assert.ok(outcomes.routed >= CASES / 10, `too few routed cases: ${outcomes.routed}`);
  assert.ok(outcomes.passthrough > 0, 'no passthrough case generated');
  assert.ok(outcomes.fail > 0, 'no fail case generated');
  assert.ok(outcomes.swappedWithinGroup > 0, 'no equivalence-group case generated');
});

// The same invariants over the real catalog with every built-in preset turned on, expanded by the
// config schema exactly as `routing.equivalence_presets` is at startup. Each case serves from a random
// subset of the catalog's entries, so a preset member is sometimes missing or on a down provider.
const REAL_CATALOG = loadCatalog();

function randomPresetRouting(gen: Gen, catalog: Catalog): RoutingSettings {
  // A written group of models no preset lists, so presets and a custom group are active together.
  const local = catalog.models.filter((e) => !EQUIVALENCE_PRESETS.some((p) => p.models.includes(e.canonical_model)));
  const custom = gen.subset(local, 0.7).map((e) => gen.pick([e.canonical_model, e.model]));
  const unique = custom.filter((v, i, all) => all.indexOf(v) === i);
  const policy = gen.pick(ROUTING_POLICIES);
  const pinnedEntry = gen.pick(catalog.models);
  const raw = {
    policy,
    on_no_candidate: gen.pick(['passthrough', 'fail'] as const),
    ...(policy === 'pinned' || gen.chance(0.5)
      ? { pinned: { provider: pinnedEntry.provider, model: pinnedEntry.model } }
      : {}),
    equivalence_groups: unique.length >= 2 ? [{ name: 'local', models: unique }] : [],
    equivalence_presets: [...PRESET_NAMES],
  };
  // Naming a preset member in the written group, by its canonical id or by any provider's own id for
  // it, would put that model in two groups: the schema must refuse it, so select() never sees it.
  if (gen.chance(0.2)) {
    const member = gen.pick(REAL_CATALOG.models.filter((e) => presetOf(e.canonical_model) !== undefined));
    const intruder = gen.pick([member.canonical_model, member.model]);
    assert.throws(
      () => RoutingSchema.parse({ ...raw, equivalence_groups: [{ name: 'local', models: [...unique, intruder] }] }),
      (error: unknown) =>
        ((error as { issues?: { message: string }[] }).issues ?? []).some((issue) =>
          issue.message.includes(`includes model "${member.canonical_model}"`),
        ),
      `a written group listing ${intruder} next to preset ${presetOf(member.canonical_model)?.name} was accepted`,
    );
    intrusionsRejected++;
  }
  return RoutingSchema.parse(raw);
}

const presetOf = (canonical: string) => EQUIVALENCE_PRESETS.find((preset) => preset.models.includes(canonical));
let intrusionsRejected = 0;

function randomPresetInput(gen: Gen): SelectInput {
  const chosen = gen.subset(REAL_CATALOG.models, 0.8);
  const catalog: Catalog = { models: chosen.length > 0 ? chosen : [gen.pick(REAL_CATALOG.models)] };
  const known = gen.pick(catalog.models);
  const requestedModel = gen.chance(0.05)
    ? 'not-a-listed-model'
    : gen.chance(0.4)
      ? known.canonical_model
      : known.model;
  return {
    inspection: {
      format: gen.pick(['openai', 'anthropic'] as const),
      requestedModel,
      needs: {
        tools: gen.chance(0.3),
        json_mode: gen.chance(0.3),
        vision: gen.chance(0.3),
        streaming: gen.chance(0.5),
      },
      estimatedInput: {
        tokens: gen.pick([0, gen.int(1, 2_000), gen.int(2_000, 250_000), gen.int(250_000, 1_100_000)]),
        origin: 'estimated',
      },
      maxOutput: gen.chance(0.4) ? null : gen.pick([gen.int(1, 64_000), gen.int(64_000, 400_000)]),
    },
    catalog,
    registry: { enabled: gen.subset(PROVIDER_IDS, 0.8).map((id) => ({ id })) },
    health: randomHealth(gen),
    routing: randomPresetRouting(gen, catalog),
    overrides: {
      policy: gen.chance(0.2) ? gen.pick(ROUTING_POLICIES) : undefined,
      provider: gen.chance(0.1) ? gen.pick(PROVIDER_IDS) : undefined,
    },
  };
}

test(`with every preset on, select keeps the invariants over ${CASES} random requests on the real catalog`, (t) => {
  const seed = readSeed();
  t.diagnostic(`seed ${seed} (replay with TOLLWISE_SELECT_SEED=${seed})`);
  const gen = new Gen(seed);
  const substitutions = new Map<string, number>(PRESET_NAMES.map((name) => [name, 0]));
  let routed = 0;

  for (let i = 0; i < CASES; i++) {
    const input = randomPresetInput(gen);
    const result = select(input);
    try {
      checkInvariants(input, result);
      if (result.decision !== 'routed') continue;
      routed++;
      // A candidate that is not the requested model belongs to the one preset (or written group)
      // that lists the requested model, never to another preset.
      const canonical = result.trace.requested.canonicalModel ?? '';
      const preset = EQUIVALENCE_PRESETS.find(
        (p) => p.models.includes(canonical) || p.models.includes(input.inspection.requestedModel),
      );
      for (const { entry } of result.candidates) {
        if (entry.canonical_model === canonical) continue;
        const group = requestedGroup(input, canonical);
        assert.ok(group !== null, `${entry.model} substituted without a group`);
        if (preset !== undefined) {
          assert.ok(preset.models.includes(entry.canonical_model), `${entry.model} is not in preset ${preset.name}`);
          substitutions.set(preset.name, (substitutions.get(preset.name) ?? 0) + 1);
        }
      }
    } catch (error) {
      throw new Error(`case ${i} of seed ${seed} failed: ${(error as Error).message}`, { cause: error });
    }
  }

  t.diagnostic(
    `routed ${routed}; substituted candidates per preset ${JSON.stringify(Object.fromEntries(substitutions))}; ` +
      `overlapping written groups rejected ${intrusionsRejected}`,
  );
  assert.ok(intrusionsRejected > 0, 'no overlapping written group generated');
  assert.ok(routed >= CASES / 10, `too few routed cases: ${routed}`);
  for (const [name, count] of substitutions) assert.ok(count > 0, `preset ${name} never produced a substitute`);
});

test('the seeded generator is reproducible', () => {
  const a = new Gen(42);
  const b = new Gen(42);
  const first = select(randomInput(a));
  const second = select(randomInput(b));
  assert.deepEqual(first, second);
});
