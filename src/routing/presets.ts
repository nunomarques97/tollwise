// Built-in equivalence-group presets: ready-made groups of models of the same class, from different
// vendors, that a user can turn on with one line (`routing.equivalence_presets`) instead of writing
// `routing.equivalence_groups` by hand. They are off by default: without that line Tollwise only ever
// switches the provider serving the exact model requested.
//
// A preset is a list of catalog canonical ids. Turning it on expands it into one ordinary
// equivalence group with the preset's name (see src/config/schema.ts), so routing treats it exactly
// like a group the user wrote, with the same guarantees: a substitute is chosen only when it has every
// capability the request uses, room in its context window and a large enough max output. A preset
// also lists every provider's own id for its members, so the config schema can refuse a written group
// that names a member by such an id: the model would otherwise be in two groups at once.
//
// Membership is a curation decision, reviewed like a catalog price. The reasons and limits below are
// statements about the linked public model pages and about catalog/models.yaml, never quality scores:
// Tollwise measures no answer quality, and substituted models do not give identical answers. Any
// change to a preset's members bumps EQUIVALENCE_PRESETS_VERSION and is listed in CHANGELOG.md.
// docs/equivalence-presets.md renders these definitions for users; test/equivalence-presets.test.ts
// keeps both in step with each other and with the catalog.

/** Version of the preset definitions; bumped whenever a preset gains, loses or renames a member. */
export const EQUIVALENCE_PRESETS_VERSION = 1;

export interface PresetSource {
  /** What the link documents, e.g. "Anthropic models overview". */
  readonly title: string;
  readonly url: string;
}

/** One provider's own model id (catalog/models.yaml `model`) for a preset member. */
export interface PresetAlias {
  readonly id: string;
  /** The member it resolves to (its catalog `canonical_model`). */
  readonly canonical: string;
}

export interface EquivalencePreset {
  /** The name used in `routing.equivalence_presets`; also the name of the group it expands into. */
  readonly name: string;
  /** One-line description of the model class. */
  readonly summary: string;
  /** Catalog canonical ids (catalog/models.yaml `canonical_model`). */
  readonly models: readonly string[];
  /**
   * Every provider's own model id in the catalog for a member, where it differs from the canonical
   * id. Kept equal to catalog/models.yaml by test/equivalence-presets.test.ts.
   */
  readonly aliases: readonly PresetAlias[];
  /** Why these models are grouped, stated only in terms the sources below and the catalog support. */
  readonly rationale: string;
  /** Public pages the rationale and the catalog figures for the members come from. */
  readonly sources: readonly PresetSource[];
  /** What differs between the members and what routing does (or cannot do) about it. */
  readonly limits: readonly string[];
}

const ANTHROPIC_MODELS: PresetSource = {
  title: 'Anthropic models overview',
  url: 'https://platform.claude.com/docs/en/models/overview',
};
const DEEPSEEK_PRICING: PresetSource = {
  title: 'DeepSeek models and pricing',
  url: 'https://api-docs.deepseek.com/quick_start/pricing/',
};

const DIFFERENT_ANSWERS =
  'Answers, tone, refusals and tool-call style differ between vendors: Tollwise measures no answer quality, so test your own prompts before turning the preset on.';
const FORMAT_LIMIT =
  'The members are served by providers of both API formats; a request using a feature the other format cannot carry (for example an OpenAI json_schema response format, see docs/compatibility.md) is never sent to a provider of the other format.';

export const EQUIVALENCE_PRESETS: readonly EquivalencePreset[] = [
  {
    name: 'frontier',
    summary: 'The higher-priced general chat model of each vendor in the catalog.',
    models: ['claude-opus-5', 'gpt-6-astra', 'deepseek-v4-pro-0813'],
    aliases: [
      { id: 'deepseek-v4-pro', canonical: 'deepseek-v4-pro-0813' },
      { id: 'anthropic/claude-opus-5', canonical: 'claude-opus-5' },
      { id: 'openai/gpt-6-astra', canonical: 'gpt-6-astra' },
      { id: 'deepseek/deepseek-v4-pro-0813', canonical: 'deepseek-v4-pro-0813' },
    ],
    rationale:
      'Each member is the higher-priced of the two general chat models its vendor has in the catalog, ' +
      'and each supports tools, JSON output and streaming, with a context window of about one million tokens ' +
      'and a max output of at least 128,000 tokens, as published on the linked pages.',
    sources: [
      ANTHROPIC_MODELS,
      { title: 'OpenAI gpt-6-astra model page', url: 'https://developers.openai.com/api/docs/models/gpt-6-astra' },
      DEEPSEEK_PRICING,
    ],
    limits: [
      'deepseek-v4-pro-0813 has no vision: a request with an image is never routed to it and stays on the other members.',
      'Max output differs: 128,000 tokens for claude-opus-5 and gpt-6-astra, more for deepseek-v4-pro-0813; a request asking for more than a member can produce never goes to it.',
      FORMAT_LIMIT,
      DIFFERENT_ANSWERS,
    ],
  },
  {
    name: 'small-fast',
    summary: 'The lower-priced general chat model of each vendor in the catalog.',
    models: ['claude-haiku-4.5', 'gpt-5.6-luna', 'deepseek-v4.1-flash'],
    aliases: [
      { id: 'claude-haiku-4-5-20251001', canonical: 'claude-haiku-4.5' },
      { id: 'deepseek-flash', canonical: 'deepseek-v4.1-flash' },
      { id: 'anthropic/claude-haiku-4.5', canonical: 'claude-haiku-4.5' },
      { id: 'openai/gpt-5.6-luna', canonical: 'gpt-5.6-luna' },
      { id: 'deepseek/deepseek-v4.1-flash', canonical: 'deepseek-v4.1-flash' },
    ],
    rationale:
      'Each member is the lower-priced of the two general chat models its vendor has in the catalog, ' +
      'and each supports tools, JSON output, images and streaming, as published on the linked pages.',
    sources: [
      ANTHROPIC_MODELS,
      { title: 'OpenAI gpt-5.6-luna model page', url: 'https://developers.openai.com/api/docs/models/gpt-5.6-luna' },
      DEEPSEEK_PRICING,
    ],
    limits: [
      'claude-haiku-4.5 has a 200,000-token context window and a 64,000-token max output, far below the other members: a request that does not fit never goes to it.',
      FORMAT_LIMIT,
      DIFFERENT_ANSWERS,
    ],
  },
];

/** Every preset name, in definition order. */
export const PRESET_NAMES: readonly string[] = EQUIVALENCE_PRESETS.map((preset) => preset.name);

/** The preset called `name`, or undefined. */
export function findPreset(name: string): EquivalencePreset | undefined {
  return EQUIVALENCE_PRESETS.find((preset) => preset.name === name);
}

/**
 * Every id that names a member of `preset`, each mapped to the member it resolves to: the canonical
 * ids themselves and every provider's own id for them.
 */
export function presetMemberIds(preset: EquivalencePreset): ReadonlyMap<string, string> {
  return new Map([
    ...preset.models.map((model) => [model, model] as const),
    ...preset.aliases.map((alias) => [alias.id, alias.canonical] as const),
  ]);
}

/**
 * The equivalence groups the named presets expand into, in the order given: one group per preset,
 * named like it, listing its canonical ids. Unknown names are skipped (the config schema rejects
 * them before this is called).
 */
export function presetGroups(names: readonly string[]): { name: string; models: string[] }[] {
  return names.flatMap((name) => {
    const preset = findPreset(name);
    return preset === undefined ? [] : [{ name: preset.name, models: [...preset.models] }];
  });
}
