// Checks the built-in equivalence presets (src/routing/presets.ts) against the catalog, the config
// schema and their user-facing page (docs/equivalence-presets.md), and that without them routing
// keeps its default: provider switching for the exact model requested, never another model.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../src/catalog/index.ts';
import type { ModelEntry } from '../src/catalog/schema.ts';
import { loadConfig } from '../src/config/load.ts';
import { PROVIDER_IDS, RoutingSchema } from '../src/config/schema.ts';
import {
  EQUIVALENCE_PRESETS,
  EQUIVALENCE_PRESETS_VERSION,
  findPreset,
  PRESET_NAMES,
  presetGroups,
  presetMemberIds,
} from '../src/routing/presets.ts';
import { CAPABILITIES, type SelectInput, select } from '../src/routing/select.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..');
const catalog = loadCatalog();
const readDoc = (name: string): string => readFileSync(path.join(repoRoot, 'docs', name), 'utf8');
/** The page with runs of whitespace collapsed, so wrapped prose still matches a one-line string. */
const presetsDoc = readDoc('equivalence-presets.md').replace(/\s+/g, ' ');

const workRoot = mkdtempSync(path.join(os.tmpdir(), 'tollwise-presets-test-'));
after(() => rmSync(workRoot, { recursive: true, force: true }));

function entriesOf(canonical: string): ModelEntry[] {
  return catalog.models.filter((entry) => entry.canonical_model === canonical);
}

const formatInt = (value: number): string => value.toLocaleString('en-US');

describe('preset definitions', () => {
  test('there are at least two presets, each fully described', () => {
    assert.ok(EQUIVALENCE_PRESETS.length >= 2);
    assert.ok(Number.isInteger(EQUIVALENCE_PRESETS_VERSION) && EQUIVALENCE_PRESETS_VERSION >= 1);
    assert.deepEqual(
      PRESET_NAMES,
      EQUIVALENCE_PRESETS.map((preset) => preset.name),
    );
    assert.equal(new Set(PRESET_NAMES).size, PRESET_NAMES.length, 'preset names are unique');
    for (const preset of EQUIVALENCE_PRESETS) {
      assert.match(preset.name, /^[a-z][a-z0-9-]*$/, `${preset.name}: a plain, lower-case name`);
      assert.ok(preset.summary.length > 0 && preset.rationale.length > 0, `${preset.name}: summary and rationale`);
      assert.ok(preset.models.length >= 2, `${preset.name}: a group needs at least two models`);
      assert.equal(new Set(preset.models).size, preset.models.length, `${preset.name}: no repeated model`);
      assert.ok(preset.sources.length > 0, `${preset.name}: at least one source`);
      assert.ok(preset.limits.length > 0, `${preset.name}: at least one known limit`);
      assert.equal(findPreset(preset.name), preset);
    }
    assert.equal(findPreset('no-such-preset'), undefined);
  });

  test('every member is a canonical model in catalog/models.yaml', () => {
    for (const preset of EQUIVALENCE_PRESETS) {
      for (const model of preset.models) {
        assert.ok(entriesOf(model).length > 0, `${preset.name}: ${model} is not a canonical_model in the catalog`);
      }
    }
  });

  test("every provider's own id for a member is a listed alias, and every alias is one", () => {
    for (const preset of EQUIVALENCE_PRESETS) {
      const expected = preset.models
        .flatMap(entriesOf)
        .filter((entry) => entry.model !== entry.canonical_model)
        .map((entry) => `${entry.model} -> ${entry.canonical_model}`)
        .sort();
      const listed = preset.aliases.map((alias) => `${alias.id} -> ${alias.canonical}`).sort();
      assert.deepEqual(listed, expected, `${preset.name}: aliases differ from catalog/models.yaml`);
      const ids = presetMemberIds(preset);
      assert.equal(ids.size, preset.models.length + preset.aliases.length, `${preset.name}: an id is listed twice`);
      for (const entry of preset.models.flatMap(entriesOf)) {
        assert.equal(ids.get(entry.model), entry.canonical_model, `${preset.name}: ${entry.model}`);
      }
    }
  });

  test('members come from different vendors and no model is in two presets', () => {
    const seen = new Map<string, string>();
    for (const preset of EQUIVALENCE_PRESETS) {
      const natives = preset.models.map(
        (model) => entriesOf(model).find((entry) => entry.provider !== 'openrouter')?.provider,
      );
      assert.equal(new Set(natives).size, preset.models.length, `${preset.name}: one model per vendor`);
      for (const model of preset.models) {
        assert.equal(seen.get(model), undefined, `${model} is in ${seen.get(model)} and ${preset.name}`);
        seen.set(model, preset.name);
      }
    }
  });

  test('no preset lists a free local model', () => {
    for (const preset of EQUIVALENCE_PRESETS) {
      for (const model of preset.models) {
        assert.ok(
          entriesOf(model).every((entry) => entry.provider !== 'ollama'),
          `${preset.name}: ${model} is a local model`,
        );
      }
    }
  });

  test('every source is a public https page the catalog itself cites', () => {
    const catalogSources = new Set(catalog.models.map((entry) => entry.source_url));
    for (const preset of EQUIVALENCE_PRESETS) {
      for (const source of preset.sources) {
        assert.equal(new URL(source.url).protocol, 'https:', `${preset.name}: ${source.url}`);
        assert.ok(catalogSources.has(source.url), `${preset.name}: ${source.url} is not a catalog source_url`);
      }
      // Each member's native catalog entry is backed by one of the preset's sources.
      for (const model of preset.models) {
        const native = entriesOf(model).find((entry) => entry.provider !== 'openrouter');
        assert.ok(
          preset.sources.some((source) => source.url === native?.source_url),
          `${preset.name}: no source for ${model}`,
        );
      }
    }
  });

  test('every capability a member lacks, and a much smaller context or output, is a stated limit', () => {
    for (const preset of EQUIVALENCE_PRESETS) {
      const limits = preset.limits.join(' ');
      const minContext = Math.min(...preset.models.flatMap((m) => entriesOf(m).map((e) => e.context_window)));
      const maxContext = Math.max(...preset.models.flatMap((m) => entriesOf(m).map((e) => e.context_window)));
      const outputs = new Set(preset.models.flatMap((m) => entriesOf(m).map((e) => e.max_output)));
      for (const model of preset.models) {
        const entries = entriesOf(model);
        for (const capability of CAPABILITIES) {
          if (entries.some((entry) => !entry.capabilities[capability])) {
            const word = capability === 'json_mode' ? 'JSON' : capability;
            assert.ok(
              preset.limits.some((limit) => limit.includes(model) && limit.includes(word)),
              `${preset.name}: ${model} lacks ${capability} but no limit says so`,
            );
          }
        }
        if (entries.some((entry) => entry.context_window * 2 <= maxContext)) {
          assert.ok(
            preset.limits.some((limit) => limit.includes(model) && limit.includes('context window')),
            `${preset.name}: ${model} has a much smaller context window but no limit says so`,
          );
        }
      }
      assert.ok(minContext > 0);
      if (outputs.size > 1) assert.match(limits, /max output/i, `${preset.name}: max output differs`);
    }
  });
});

describe('configuration', () => {
  test('presets expand into equivalence groups named like them, written groups first', () => {
    assert.deepEqual(presetGroups(['small-fast', 'frontier']), [
      { name: 'small-fast', models: [...(findPreset('small-fast')?.models ?? [])] },
      { name: 'frontier', models: [...(findPreset('frontier')?.models ?? [])] },
    ]);
    const routing = RoutingSchema.parse({
      equivalence_groups: [{ name: 'local', models: ['llama3.1-8b', 'qwen2.5-7b'] }],
      equivalence_presets: [...PRESET_NAMES],
    });
    assert.deepEqual(routing.equivalence_presets, PRESET_NAMES);
    assert.deepEqual(routing.equivalence_groups, [
      { name: 'local', models: ['llama3.1-8b', 'qwen2.5-7b'] },
      ...EQUIVALENCE_PRESETS.map((preset) => ({ name: preset.name, models: [...preset.models] })),
    ]);
  });

  test('every preset can be turned on at once', () => {
    assert.equal(RoutingSchema.safeParse({ equivalence_presets: [...PRESET_NAMES] }).success, true);
  });

  test('an empty configuration keeps the default routing: no group, no preset', () => {
    const { routing } = loadConfig({ cwd: workRoot, env: {} }).config;
    assert.deepEqual(routing.equivalence_groups, []);
    assert.deepEqual(routing.equivalence_presets, []);
    assert.deepEqual(RoutingSchema.parse({}), routing);
  });

  test('with the default routing, every request stays on the exact model requested', () => {
    const { routing } = loadConfig({ cwd: workRoot, env: {} }).config;
    const everyProvider = { enabled: PROVIDER_IDS.map((id) => ({ id })) };
    const requested = new Set(catalog.models.flatMap((entry) => [entry.model, entry.canonical_model]));
    let routed = 0;
    for (const requestedModel of requested) {
      for (const format of ['openai', 'anthropic'] as const) {
        const input: SelectInput = {
          inspection: {
            format,
            requestedModel,
            needs: { tools: false, json_mode: false, vision: false, streaming: false },
            estimatedInput: { tokens: 100, origin: 'estimated' },
            maxOutput: null,
          },
          catalog,
          registry: everyProvider,
          health: { providers: [] },
          routing,
        };
        const result = select(input);
        if (result.decision !== 'routed') continue;
        routed++;
        const canonical = result.trace.requested.canonicalModel;
        for (const candidate of result.candidates) {
          assert.equal(candidate.entry.canonical_model, canonical, `${requestedModel} was offered ${candidate.model}`);
        }
      }
    }
    assert.ok(routed > 0, 'some requests were routed');
  });

  test('with a preset on, a request for a member may be served by another member', () => {
    const routing = RoutingSchema.parse({ equivalence_presets: ['small-fast'] });
    const result = select({
      inspection: {
        format: 'openai',
        requestedModel: 'claude-haiku-4-5-20251001',
        needs: { tools: false, json_mode: false, vision: false, streaming: false },
        estimatedInput: { tokens: 100, origin: 'estimated' },
        maxOutput: null,
      },
      catalog,
      registry: { enabled: PROVIDER_IDS.map((id) => ({ id })) },
      health: { providers: [] },
      routing,
    });
    assert.equal(result.decision, 'routed');
    const served = new Set(result.candidates.map((candidate) => candidate.entry.canonical_model));
    assert.deepEqual([...served].sort(), [...(findPreset('small-fast')?.models ?? [])].sort());
  });
});

describe('docs/equivalence-presets.md', () => {
  test('describes every preset: enable line, models table, rationale, sources and limits', () => {
    for (const preset of EQUIVALENCE_PRESETS) {
      assert.ok(presetsDoc.includes(`### \`${preset.name}\``), `${preset.name}: heading`);
      assert.ok(presetsDoc.includes(`equivalence_presets: [${preset.name}]`), `${preset.name}: one-line enable`);
      assert.ok(presetsDoc.includes(preset.summary), `${preset.name}: summary`);
      assert.ok(presetsDoc.includes(preset.rationale), `${preset.name}: rationale`);
      for (const source of preset.sources) {
        assert.ok(presetsDoc.includes(`[${source.title}](${source.url})`), `${preset.name}: source ${source.url}`);
      }
      for (const limit of preset.limits) assert.ok(presetsDoc.includes(`- ${limit}`), `${preset.name}: limit ${limit}`);
      for (const model of preset.models) {
        const entries = entriesOf(model);
        const providers = [...new Set(entries.map((entry) => entry.provider))].join(', ');
        const context = formatInt(Math.min(...entries.map((entry) => entry.context_window)));
        const output = formatInt(Math.min(...entries.map((entry) => entry.max_output)));
        const flags = CAPABILITIES.map((c) => (entries.every((entry) => entry.capabilities[c]) ? 'yes' : 'no'));
        const row = `| \`${model}\` | ${providers} | ${context} | ${output} | ${flags.join(' | ')} |`;
        assert.ok(presetsDoc.includes(row), `${preset.name}: table row ${row}`);
      }
    }
  });

  test('states that substitution is opt-in and off by default', () => {
    assert.match(presetsDoc, /No preset is on unless your configuration names it\./);
    assert.match(presetsDoc, /By default Tollwise only switches the \*\*provider\*\*/);
  });

  test('docs/configuration.md and docs/routing.md link to it', () => {
    for (const page of ['configuration.md', 'routing.md']) {
      assert.ok(readDoc(page).includes('](equivalence-presets.md)'), `${page} links to equivalence-presets.md`);
    }
  });
});
