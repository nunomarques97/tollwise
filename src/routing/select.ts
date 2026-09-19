// Chooses where a chat request may go. Given what the request needs (see inspect.ts), the catalog,
// the providers that are configured, their current health and the routing configuration, select()
// returns an ordered list of candidates, or the decision to pass the request through unchanged, or
// to fail with a message that says why. Pure and synchronous: no I/O, no clock, no randomness, no
// logging. The same input always gives the same output.
//
// The one promise this module keeps above every other: routing never silently downgrades what the
// caller asked for. A candidate is always the requested model itself (the same canonical_model,
// served by any configured provider) or a model the user explicitly declared interchangeable in an
// equivalence group, and it always has every capability the request uses, room in its context
// window for the input plus the output, and a max output at least as large as the one requested.
//
// A provider that speaks the other wire format (OpenAI Chat Completions or Anthropic Messages) is a
// candidate only when the request can be translated to its format without losing anything: select()
// asks SelectInput.untranslatable for the features a translation would not preserve, and excludes the
// entry as untranslatable:<code> when there is any.

import type { Catalog, ModelEntry } from '../catalog/schema.ts';
import type { Config, NoCandidateMode, ProviderId, RoutingPolicy } from '../config/schema.ts';
import type { HealthMonitorSnapshot } from '../health/monitor.ts';
import type { WireFormat } from '../providers/types.ts';
import type { UntranslatableCode } from '../translate/codes.ts';
import type { Inspection, RequestNeeds } from './inspect.ts';

/**
 * Output tokens assumed for a request that does not set a maximum (`max_tokens` /
 * `max_completion_tokens`), capped at the candidate's own `max_output`. Used for two things only:
 * the cost estimate that ranks candidates (cheapest, balanced) and the room a candidate must leave
 * in its context window after the input (context_too_small). Chat answers are usually well under
 * this; it is an assumption for ranking and never a figure shown as a cost.
 */
export const DEFAULT_EXPECTED_OUTPUT_TOKENS = 1_024;

/**
 * Weight of price in the balanced score; latency gets the rest (1 - this). See balancedScore().
 */
export const BALANCED_COST_WEIGHT = 0.5;

/** Capabilities a request can need, in the order they are checked and reported. */
export const CAPABILITIES = ['tools', 'json_mode', 'vision', 'streaming'] as const;
export type Capability = (typeof CAPABILITIES)[number];

/**
 * Why a catalog entry that was considered is not a candidate. Stable codes: they appear in routing
 * traces, response headers and analytics, so they never change meaning once published.
 * - `provider_not_configured`: the provider is disabled, has no key set, or has no adapter.
 * - `provider_not_requested`: the request named another provider (overrides.provider).
 * - `untranslatable:<code>`: the provider speaks the other wire format, and translating the request to
 *   it would not preserve a feature the request uses; `<code>` is the first one reported (see
 *   UNTRANSLATABLE_FEATURES in src/translate/codes.ts).
 * - `missing_capability:<name>`: the model lacks a capability the request uses.
 * - `max_output_too_small`: the request asks for more output tokens than the model can produce.
 * - `context_too_small`: estimated input + output does not fit the model's context window.
 * - `provider_down`: the health monitor sees the provider as down (unknown is not down).
 */
export type ExclusionReason =
  | 'provider_not_configured'
  | 'provider_not_requested'
  | `untranslatable:${UntranslatableCode}`
  | `missing_capability:${Capability}`
  | 'max_output_too_small'
  | 'context_too_small'
  | 'provider_down';

/**
 * The routing settings select() reads; `Config['routing']` satisfies it. `equivalence_presets` names
 * the groups of `equivalence_groups` that came from a preset; left out, every group counts as written
 * by hand.
 */
export type RoutingSettings = Pick<Config['routing'], 'policy' | 'on_no_candidate' | 'pinned' | 'equivalence_groups'> &
  Partial<Pick<Config['routing'], 'equivalence_presets'>>;

/** The providers that can be called right now; a ProviderRegistry satisfies it. */
export interface ConfiguredProviders {
  readonly enabled: readonly { readonly id: ProviderId; readonly wireFormat?: WireFormat }[];
}

/** Per-request overrides, e.g. from request headers. */
export interface SelectOverrides {
  /** Replaces the configured policy for this request. */
  readonly policy?: RoutingPolicy | undefined;
  /** Restricts routing to this provider, and names the provider a passthrough goes to. */
  readonly provider?: ProviderId | undefined;
}

export interface SelectInput {
  readonly inspection: Pick<Inspection, 'format' | 'requestedModel' | 'needs' | 'estimatedInput' | 'maxOutput'>;
  readonly catalog: Catalog;
  readonly registry: ConfiguredProviders;
  readonly health: HealthMonitorSnapshot;
  readonly routing: RoutingSettings;
  readonly overrides?: SelectOverrides | undefined;
  /**
   * What a translation of this request to `target` (the other wire format) would not preserve, as
   * untranslatable() in src/translate reports it; must be pure. Called at most once per format, only for
   * an entry whose provider's stated wire format differs from the request's. Undefined: no entry is
   * excluded for its format (for callers that only rank, without sending anything).
   */
  readonly untranslatable?: ((target: WireFormat) => readonly UntranslatableCode[]) | undefined;
}

export interface ModelRef {
  readonly provider: ProviderId;
  readonly model: string;
}

export interface ExcludedEntry extends ModelRef {
  /** The first failed check, in the order listed on ExclusionReason. */
  readonly reason: ExclusionReason;
}

/**
 * Why a candidate serves another model than the one requested: the equivalence group that allowed it,
 * and whether that group is a built-in preset (`routing.equivalence_presets`) or one written by hand
 * (`routing.equivalence_groups`).
 */
export interface CandidateSubstitution {
  readonly group: string;
  readonly source: 'preset' | 'custom';
}

export interface RoutedCandidate extends ModelRef {
  readonly entry: ModelEntry;
  /**
   * Null when the candidate serves the requested model itself (the same canonical model, on any
   * provider); otherwise the equivalence group that made another model a candidate.
   */
  readonly substitution: CandidateSubstitution | null;
  /** Estimated cost in USD used for ranking (see estimateCost); never the cost reported to the user. */
  readonly estimatedCost: number;
  /** The provider's recent median latency in milliseconds; null when not measured yet. */
  readonly p50: number | null;
}

export interface PassthroughTarget extends ModelRef {
  /** The catalog entry for exactly this provider and model, or null when the catalog has none. */
  readonly entry: ModelEntry | null;
  /** Always null: a passthrough sends the requested model unchanged. */
  readonly substitution: null;
}

export interface SelectionTrace {
  readonly requested: {
    readonly model: string;
    readonly format: WireFormat;
    /** The canonical model the requested id resolved to; null when it is not in the catalog. */
    readonly canonicalModel: string | null;
    /** Name of the equivalence group the requested model belongs to; null when none. */
    readonly group: string | null;
    /** The provider named by overrides.provider; null when none. */
    readonly provider: ProviderId | null;
  };
  /** The policy that was asked for (override first, then configuration). */
  readonly policy: RoutingPolicy;
  /** The pinned target when the policy is pinned and one is configured, and whether it could be used. */
  readonly pinned: (ModelRef & { readonly eligible: boolean }) | null;
  /** Every catalog entry that was examined, in catalog order. */
  readonly considered: readonly ModelRef[];
  readonly excluded: readonly ExcludedEntry[];
}

/** Why there is no routed candidate. */
export type NoCandidateCause = 'not_in_catalog' | 'no_candidate';

export type Selection =
  | { readonly decision: 'routed'; readonly candidates: readonly RoutedCandidate[]; readonly trace: SelectionTrace }
  | {
      readonly decision: 'passthrough';
      readonly cause: NoCandidateCause;
      /** Exactly one target: the requested model, unchanged, on the chosen provider. */
      readonly candidates: readonly [PassthroughTarget];
      readonly trace: SelectionTrace;
    }
  | {
      readonly decision: 'fail';
      readonly cause: NoCandidateCause;
      readonly candidates: readonly [];
      /** A readable reason naming what is missing, safe to return to the caller. */
      readonly message: string;
      readonly trace: SelectionTrace;
    };

/** The provider that natively speaks a wire format: where a passthrough goes when no provider is named. */
export function nativeProvider(format: WireFormat): ProviderId {
  return format === 'anthropic' ? 'anthropic' : 'openai';
}

/** Output tokens reserved for `entry`: the requested maximum, else the default capped at the model's own. */
export function expectedOutputTokens(maxOutput: number | null, entry: ModelEntry): number {
  return maxOutput ?? Math.min(DEFAULT_EXPECTED_OUTPUT_TOKENS, entry.max_output);
}

/**
 * Estimated cost of one request on `entry`, in USD:
 *   (estimatedInput x price.input + expectedOutput x price.output) / 1,000,000
 * where prices are USD per million tokens and expectedOutput is expectedOutputTokens(). Used only
 * to rank candidates; the cost shown to users comes from the usage the provider reports.
 */
export function estimateCost(estimatedInput: number, maxOutput: number | null, entry: ModelEntry): number {
  const output = expectedOutputTokens(maxOutput, entry);
  return (estimatedInput * entry.price.input + output * entry.price.output) / 1_000_000;
}

/**
 * The balanced score of a candidate, lower is better:
 *   BALANCED_COST_WEIGHT x (cost / highest cost among candidates)
 *   + (1 - BALANCED_COST_WEIGHT) x (p50 / highest known p50 among candidates)
 * Each term is between 0 and 1, so price and latency count equally whatever their units. A term
 * whose highest value is 0 (every candidate free, or every latency 0) counts as 0. A candidate with
 * no latency measured yet gets the latency term 1, the same as the slowest measured one, so an
 * unmeasured provider never beats a measured one on speed. Ties go to the cheaper candidate.
 */
export function balancedScore(cost: number, p50: number | null, maxCost: number, maxP50: number): number {
  const costTerm = maxCost > 0 ? cost / maxCost : 0;
  const latencyTerm = p50 === null ? 1 : maxP50 > 0 ? p50 / maxP50 : 0;
  return BALANCED_COST_WEIGHT * costTerm + (1 - BALANCED_COST_WEIGHT) * latencyTerm;
}

/**
 * The canonical model a requested id stands for, or null when the catalog does not know it. An id
 * is matched first as a provider's own model id (on the overridden provider, then the format's native
 * provider, then any provider in catalog order), then as a canonical id.
 */
export function resolveCanonical(
  catalog: Catalog,
  requestedModel: string,
  format: WireFormat,
  provider: ProviderId | null,
): string | null {
  const byModel = catalog.models.filter((entry) => entry.model === requestedModel);
  const preferred =
    (provider === null ? undefined : byModel.find((entry) => entry.provider === provider)) ??
    byModel.find((entry) => entry.provider === nativeProvider(format)) ??
    byModel[0];
  if (preferred !== undefined) {
    return preferred.canonical_model;
  }
  return catalog.models.some((entry) => entry.canonical_model === requestedModel) ? requestedModel : null;
}

/** Routes one request. See the module comment for the guarantees. */
export function select(input: SelectInput): Selection {
  const { inspection, catalog, registry, health, routing } = input;
  const overrides = input.overrides ?? {};
  const requestedModel = inspection.requestedModel;
  const providerOverride = overrides.provider ?? null;
  const policy = overrides.policy ?? routing.policy;

  const canonical = resolveCanonical(catalog, requestedModel, inspection.format, providerOverride);
  const group =
    canonical === null
      ? undefined
      : routing.equivalence_groups.find(
          (candidate) => candidate.models.includes(requestedModel) || candidate.models.includes(canonical),
        );
  const groupModels = new Set(group?.models ?? []);
  const substitution: CandidateSubstitution | null =
    group === undefined
      ? null
      : { group: group.name, source: routing.equivalence_presets?.includes(group.name) ? 'preset' : 'custom' };

  const pool =
    canonical === null
      ? []
      : catalog.models.filter(
          (entry) =>
            entry.canonical_model === canonical ||
            groupModels.has(entry.canonical_model) ||
            groupModels.has(entry.model),
        );

  const enabled = new Set(registry.enabled.map((provider) => provider.id));
  const formatById = new Map(registry.enabled.map((provider) => [provider.id, provider.wireFormat] as const));
  const lossByFormat = new Map<WireFormat, UntranslatableCode | null>();
  const translationLoss = (provider: ProviderId): UntranslatableCode | null => {
    const format = formatById.get(provider);
    if (input.untranslatable === undefined || format === undefined || format === inspection.format) return null;
    if (!lossByFormat.has(format)) lossByFormat.set(format, input.untranslatable(format)[0] ?? null);
    return lossByFormat.get(format) ?? null;
  };
  const healthById = new Map(health.providers.map((provider) => [provider.id, provider] as const));
  const inputTokens = inspection.estimatedInput.tokens;

  const excluded: ExcludedEntry[] = [];
  const eligible: RoutedCandidate[] = [];
  for (const entry of pool) {
    const reason = exclusionReason(entry, {
      enabled,
      providerOverride,
      translationLoss: translationLoss(entry.provider),
      needs: inspection.needs,
      inputTokens,
      maxOutput: inspection.maxOutput,
      down: healthById.get(entry.provider)?.state === 'down',
    });
    if (reason !== null) {
      excluded.push({ provider: entry.provider, model: entry.model, reason });
      continue;
    }
    eligible.push({
      provider: entry.provider,
      model: entry.model,
      entry,
      // The pool holds the requested canonical model and, only through the group, other models.
      substitution: entry.canonical_model === canonical ? null : substitution,
      estimatedCost: estimateCost(inputTokens, inspection.maxOutput, entry),
      p50: healthById.get(entry.provider)?.p50 ?? null,
    });
  }

  const pinnedTarget = policy === 'pinned' ? (routing.pinned ?? null) : null;
  const pinned =
    pinnedTarget === null
      ? null
      : {
          provider: pinnedTarget.provider,
          model: pinnedTarget.model,
          eligible: eligible.some((c) => c.provider === pinnedTarget.provider && c.model === pinnedTarget.model),
        };

  const trace: SelectionTrace = {
    requested: {
      model: requestedModel,
      format: inspection.format,
      canonicalModel: canonical,
      group: group?.name ?? null,
      provider: providerOverride,
    },
    policy,
    pinned,
    considered: pool.map((entry) => ({ provider: entry.provider, model: entry.model })),
    excluded,
  };

  if (eligible.length > 0) {
    const rank = (candidate: RoutedCandidate): number =>
      candidate.model === requestedModel ? 0 : candidate.entry.canonical_model === canonical ? 1 : 2;
    return { decision: 'routed', candidates: order(eligible, policy, pinned, rank), trace };
  }

  const cause: NoCandidateCause = canonical === null ? 'not_in_catalog' : 'no_candidate';
  return noCandidate(routing.on_no_candidate, cause, input, trace);
}

interface CheckContext {
  readonly enabled: ReadonlySet<ProviderId>;
  readonly providerOverride: ProviderId | null;
  /** The first feature a translation to the provider's format would lose; null when none is needed or lost. */
  readonly translationLoss: UntranslatableCode | null;
  readonly needs: RequestNeeds;
  readonly inputTokens: number;
  readonly maxOutput: number | null;
  readonly down: boolean;
}

/** The first check `entry` fails, or null when it can serve the request. */
function exclusionReason(entry: ModelEntry, context: CheckContext): ExclusionReason | null {
  if (!context.enabled.has(entry.provider)) {
    return 'provider_not_configured';
  }
  if (context.providerOverride !== null && entry.provider !== context.providerOverride) {
    return 'provider_not_requested';
  }
  if (context.translationLoss !== null) {
    return `untranslatable:${context.translationLoss}`;
  }
  for (const capability of CAPABILITIES) {
    if (context.needs[capability] && !entry.capabilities[capability]) {
      return `missing_capability:${capability}`;
    }
  }
  if (context.maxOutput !== null && context.maxOutput > entry.max_output) {
    return 'max_output_too_small';
  }
  if (context.inputTokens + expectedOutputTokens(context.maxOutput, entry) > entry.context_window) {
    return 'context_too_small';
  }
  if (context.down) {
    return 'provider_down';
  }
  return null;
}

/**
 * Orders eligible candidates by policy. Every policy breaks ties the same way: cheaper first, then
 * the requested model id itself, then the same canonical model, then equivalence-group members, then
 * catalog order (the sort is stable).
 * - cheapest: estimated cost ascending.
 * - fastest: p50 ascending; candidates without a measured latency come after every measured one.
 * - balanced: balancedScore() ascending.
 * - pinned: the pinned target first when it is eligible, then the rest in cheapest order as
 *   fallbacks. When the target is not eligible (another model, a missing capability, a provider
 *   down or not configured) it is never used, and the order is cheapest.
 */
function order(
  eligible: readonly RoutedCandidate[],
  policy: RoutingPolicy,
  pinned: SelectionTrace['pinned'],
  rank: (candidate: RoutedCandidate) => number,
): RoutedCandidate[] {
  const cheaper = (a: RoutedCandidate, b: RoutedCandidate): number =>
    a.estimatedCost - b.estimatedCost || rank(a) - rank(b);
  const sorted = [...eligible];

  if (policy === 'fastest') {
    sorted.sort((a, b) => {
      if (a.p50 !== null && b.p50 !== null) return a.p50 - b.p50 || cheaper(a, b);
      if (a.p50 !== null) return -1;
      if (b.p50 !== null) return 1;
      return cheaper(a, b);
    });
    return sorted;
  }

  if (policy === 'balanced') {
    const maxCost = Math.max(...sorted.map((c) => c.estimatedCost));
    const maxP50 = Math.max(0, ...sorted.map((c) => c.p50 ?? 0));
    const score = new Map(sorted.map((c) => [c, balancedScore(c.estimatedCost, c.p50, maxCost, maxP50)] as const));
    sorted.sort((a, b) => (score.get(a) ?? 0) - (score.get(b) ?? 0) || cheaper(a, b));
    return sorted;
  }

  sorted.sort(cheaper);
  if (policy === 'pinned' && pinned?.eligible === true) {
    const index = sorted.findIndex((c) => c.provider === pinned.provider && c.model === pinned.model);
    const [target] = sorted.splice(index, 1);
    if (target !== undefined) sorted.unshift(target);
  }
  return sorted;
}

function noCandidate(
  mode: NoCandidateMode,
  cause: NoCandidateCause,
  input: SelectInput,
  trace: SelectionTrace,
): Selection {
  const model = input.inspection.requestedModel;
  if (mode === 'passthrough') {
    const provider = input.overrides?.provider ?? nativeProvider(input.inspection.format);
    const entry = input.catalog.models.find((e) => e.provider === provider && e.model === model) ?? null;
    return { decision: 'passthrough', cause, candidates: [{ provider, model, entry, substitution: null }], trace };
  }
  return { decision: 'fail', cause, candidates: [], message: failureMessage(cause, model, trace), trace };
}

const REASON_TEXT: Readonly<Record<Exclude<ExclusionReason, `untranslatable:${string}`>, string>> = {
  provider_not_configured: 'provider not configured (disabled or its key is not set)',
  provider_not_requested: 'not the requested provider',
  'missing_capability:tools': 'missing capability: tools',
  'missing_capability:json_mode': 'missing capability: json_mode',
  'missing_capability:vision': 'missing capability: vision',
  'missing_capability:streaming': 'missing capability: streaming',
  max_output_too_small: 'max output smaller than the requested max tokens',
  context_too_small: 'context window too small for this request',
  provider_down: 'provider is down',
};

const UNTRANSLATABLE_PREFIX = 'untranslatable:';

/** The readable text of an exclusion reason; an untranslatable one names its feature code. */
function reasonText(reason: ExclusionReason): string {
  if (reason.startsWith(UNTRANSLATABLE_PREFIX)) {
    return `provider speaks another API format, and the request uses a feature that cannot be translated to it: ${reason.slice(UNTRANSLATABLE_PREFIX.length)}`;
  }
  return REASON_TEXT[reason as keyof typeof REASON_TEXT];
}

/**
 * The message returned to the caller when routing fails. It names the model and, per reason, the
 * provider/model pairs it ruled out, e.g.
 *   no provider can serve model "m" for this request: missing capability: vision (openai/m, openrouter/x/m)
 * Apart from the requested model id it carries only catalog names and fixed text, never message
 * content or anything else from the request body.
 */
function failureMessage(cause: NoCandidateCause, model: string, trace: SelectionTrace): string {
  if (cause === 'not_in_catalog') {
    return `model "${model}" is not in the Tollwise catalog, so no provider can be checked for the capabilities this request needs`;
  }
  const byReason = new Map<ExclusionReason, string[]>();
  for (const entry of trace.excluded) {
    const list = byReason.get(entry.reason) ?? [];
    list.push(`${entry.provider}/${entry.model}`);
    byReason.set(entry.reason, list);
  }
  const parts = [...byReason].map(([reason, refs]) => `${reasonText(reason)} (${refs.join(', ')})`);
  return `no provider can serve model "${model}" for this request: ${parts.join('; ')}`;
}
