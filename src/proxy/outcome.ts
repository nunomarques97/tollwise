// The request outcome event: one RequestOutcome is built and emitted for every chat request that
// reached routing selection (both wire formats, streaming or not): served, fallen back, cut short,
// failed at the provider, or refused because no provider could take it. It carries only the metadata
// an owner auditing spend, savings or routing needs -- never a prompt, a response, a header or a URL
// (the one URL it carries is the catalog's public pricing page behind a price, see below).
// REQUEST_OUTCOME_KEYS below is the exhaustive field list a test checks a real event against.
//
// Which requests emit no outcome: those refused before routing selection ran, because the request
// itself could not be read -- no provider configuration loaded (503), a missing or invalid required
// header, a body that is not JSON or not a valid request (400), or an invalid x-tollwise-policy or
// x-tollwise-provider override (400). None of them has a requested model, needs or policy to report.
// A request refused after selection (no provider satisfies the requested capabilities, the model is not
// in the catalog in fail mode, or the only possible provider is not configured or cannot take the
// request translated) does emit one: decision "fail", status "refused", no used model or provider,
// zero attempts, an empty trace and no usage or cost.
//
// Usage and cost: the provider's own reported usage is always the source of truth. When a request
// completed but the provider reported no usage at all, resolveUsageAndCost() falls back to the
// pre-call input estimate (src/pricing/estimate.ts, via routing's already-computed Inspection) and
// the routing default output size, both labelled "estimated" so nothing here is ever mistaken for a
// real count. A request that never completed gets no invented usage or cost. Cost, baseline and
// savings come unchanged from src/pricing/cost.ts's computeCost(); a usage shape computeCost rejects
// (an internal inconsistency, never expected from real input) yields a null cost rather than a
// crashed request.
//
// Selection and prices: `selection` records what routing chose from (how many catalog entries it
// examined, the candidates in the policy's ranking order with their catalog prices, and every entry it
// ruled out with its reason code), and `price` copies the catalog price of the model used and of the
// model requested, with the date each was verified and the page it came from. Both are taken from the
// select() result and the catalog as they were when the request was routed, so a stored outcome never
// changes when the catalog is updated later. They hold only provider ids, model ids, reason codes,
// numbers, ISO dates and the catalog's source_url -- never anything from a request or response body,
// a header, a key, a provider's error text or any other URL.
//
// Substitution: `substitution` is null when the request was served by (or last failed on) the model it
// asked for, on any provider, and for a refused request; otherwise it is { requested_model,
// served_model, group }: the model asked for, the model sent instead, and the name of the equivalence
// group, turned on in the configuration, that allowed it. Each trace attempt carries the same field for
// the model that attempt sent, so a request that fell back from a substitute to the requested model (or
// the other way round) shows both.
//
// Free text: the only strings in an outcome that come from the client are model ids (the requested
// model, the model sent to the provider, each attempt's model in the trace, the model ids in the
// selection, where a passthrough target is the requested model, and both model ids of a substitution).
// A client may paste anything there, a key included, so buildRequestOutcome() masks all of them with the
// log redactor before an outcome exists; every outcome emitted is built by it. A group name comes from
// the configuration, not the client, and is kept as written.
//
// Listener registry: plain module state, the same pattern src/log/redact.ts uses for registered
// secret values. Registration returns a function that removes the listener (tests keep listeners
// scoped to themselves this way); clearRequestOutcomeListeners() resets everything at once. A
// listener that throws, or an async listener whose promise rejects, is contained here so it can
// never break the request whose outcome it reports or crash the process -- every other listener
// still runs. Listeners are called synchronously, in the request's own turn: a listener with slow
// work to do (persisting, for example) must hand it off rather than do it inline.

import type { ModelEntry } from '../catalog/schema.ts';
import type { ProviderId, RoutingPolicy } from '../config/schema.ts';
import { redactText } from '../log/redact.ts';
import { type ComputeCostResult, type CostOrigin, computeCost } from '../pricing/cost.ts';
import type { WireFormat } from '../providers/types.ts';
import type { RequestNeeds } from '../routing/inspect.ts';
import { type ExclusionReason, expectedOutputTokens, type Selection } from '../routing/select.ts';
import type { AttemptRecord, ModelSubstitution, ReportedUsage } from './forward.ts';

/**
 * How the request was routed: "routed" when routing chose the target, "passthrough" when it went
 * unchanged to the requested model, "fail" when it was refused without calling any provider.
 */
export type OutcomeDecision = 'routed' | 'passthrough' | 'fail';

/**
 * How the whole request ended. The first five mirror the outcomes of a request sent to a provider
 * (see ProxyRequestResult in ./forward.ts); "refused" is a request no provider was called for.
 */
export type OutcomeStatus =
  | 'complete'
  | 'provider_error'
  | 'interrupted'
  | 'client_aborted'
  | 'translation_failed'
  | 'refused';

/** Token counts for one request, with where they came from. */
export interface RequestOutcomeUsage {
  readonly input: number;
  readonly cached_input: number;
  readonly output: number;
  readonly origin: CostOrigin;
}

/** A candidate routing could send the request to, with its catalog price in USD per 1M tokens. */
export interface OutcomeCandidate {
  readonly provider: ProviderId;
  readonly model: string;
  /** Catalog input price; null when the pair has no catalog entry (a passthrough to an unlisted model). */
  readonly input: number | null;
  /** Catalog output price; null when the pair has no catalog entry. */
  readonly output: number | null;
}

/** A catalog entry routing examined and ruled out, with the stable reason code of src/routing/select.ts. */
export interface OutcomeExclusion {
  readonly provider: ProviderId;
  readonly model: string;
  readonly reason: ExclusionReason;
}

/** What routing chose from when the request was routed. */
export interface OutcomeSelection {
  /** How many catalog entries routing examined. */
  readonly considered: number;
  /**
   * The candidates in the policy's ranking order: every one, including those never tried. A
   * passthrough has its single target; a request routing refused has none.
   */
  readonly candidates: readonly OutcomeCandidate[];
  /** Every examined entry that was ruled out, in catalog order. */
  readonly excluded: readonly OutcomeExclusion[];
}

/** A catalog price as it was when the request was routed: USD per 1M tokens, and its provenance. */
export interface OutcomePrice {
  readonly input: number;
  readonly output: number;
  /** The ISO date the catalog price was verified on its source page. */
  readonly verified_on: string;
  /** The public pricing page the catalog price was copied from. */
  readonly source_url: string;
}

/** The catalog prices behind a request's cost and savings, each null when the catalog has none. */
export interface OutcomePrices {
  /** The entry of the provider and model that served (or last failed) the request; null when refused. */
  readonly used: OutcomePrice | null;
  /** The entry the savings baseline is measured against (see selectBaselineEntry in src/pricing/cost.ts). */
  readonly requested: OutcomePrice | null;
}

/**
 * What happened to one request: metadata only, never a prompt, a response body, a header or a URL.
 * Exactly one is emitted per request that reached routing selection, whether it was served, fell
 * back, was cut short, failed at the provider or was refused (see the module comment).
 */
export interface RequestOutcome {
  readonly timestamp: string;
  readonly requestId: string;
  readonly format: WireFormat;
  readonly requestedModel: string;
  readonly requestedProvider: ProviderId;
  /** The model id sent to the provider that served (or last failed) the request; null when refused. */
  readonly usedModel: string | null;
  /** The provider that served (or last failed) the request; null when refused. */
  readonly usedProvider: ProviderId | null;
  readonly needs: RequestNeeds;
  readonly policy: RoutingPolicy;
  readonly decision: OutcomeDecision;
  /** How many providers were called for this request; 0 when it was refused. */
  readonly attempts: number;
  /** The routing trace: every attempt, in order, already redacted (see AttemptRecord). */
  readonly trace: readonly AttemptRecord[];
  readonly usage: RequestOutcomeUsage | null;
  readonly cost: ComputeCostResult | null;
  /** Milliseconds from the request arriving to the response ending. */
  readonly latencyMs: number;
  /**
   * For a streamed response: milliseconds from the request arriving to the provider's response head
   * arriving, which is when the response is committed and its head is sent to the client (before the
   * first body chunk). Null for a non-streamed response, a failure, or a refusal.
   */
  readonly firstByteMs: number | null;
  readonly status: OutcomeStatus;
  /** What routing chose from. Null only for an outcome stored before this field existed. */
  readonly selection: OutcomeSelection | null;
  /** The catalog prices at routing time. Null only for an outcome stored before this field existed. */
  readonly price: OutcomePrices | null;
  /**
   * The model substitution of the attempt that served (or last failed) the request; null when that
   * attempt sent the requested model, and for a refused request (see the module comment).
   */
  readonly substitution: ModelSubstitution | null;
}

/** The exact field names of RequestOutcome, in the order above; a test checks a real event against this. */
export const REQUEST_OUTCOME_KEYS: readonly (keyof RequestOutcome)[] = [
  'timestamp',
  'requestId',
  'format',
  'requestedModel',
  'requestedProvider',
  'usedModel',
  'usedProvider',
  'needs',
  'policy',
  'decision',
  'attempts',
  'trace',
  'usage',
  'cost',
  'latencyMs',
  'firstByteMs',
  'status',
  'selection',
  'price',
  'substitution',
];

// ---------------------------------------------------------------- response headers

/** The x-tollwise-* headers a non-streamed answer carries once its cost is known. */
export const COST_HEADERS = {
  costUsd: 'x-tollwise-cost-usd',
  savingsUsd: 'x-tollwise-savings-usd',
  costOrigin: 'x-tollwise-cost-origin',
  priceVerifiedOn: 'x-tollwise-price-verified-on',
} as const;

/** The value of a cost header whose number is not known. */
export const UNKNOWN = 'unknown';

/**
 * The response headers reporting the cost of a served, non-streamed answer. When no cost is known
 * (the model/provider pair has no catalog price), the headers are still sent, as "unknown", so a
 * client can tell an unpriced answer from a server that sends no cost headers at all; the origin
 * then says where the usage came from, or "unknown" when there is none either.
 */
export function costResponseHeaders(resolved: UsageAndCost): Record<string, string> {
  const { usage, cost } = resolved;
  if (cost === null) {
    return {
      [COST_HEADERS.costUsd]: UNKNOWN,
      [COST_HEADERS.savingsUsd]: UNKNOWN,
      [COST_HEADERS.costOrigin]: usage?.origin ?? UNKNOWN,
      [COST_HEADERS.priceVerifiedOn]: UNKNOWN,
    };
  }
  return {
    [COST_HEADERS.costUsd]: cost.cost_usd,
    [COST_HEADERS.savingsUsd]: cost.savings_usd,
    [COST_HEADERS.costOrigin]: cost.origin,
    [COST_HEADERS.priceVerifiedOn]: cost.used_price_verified_on,
  };
}

// ---------------------------------------------------------------- selection and prices

/**
 * The selection part of an outcome, from the select() result the request was routed with: the count
 * of examined entries, every candidate in ranking order with its catalog price, and the exclusions
 * with their reason codes unchanged. Only these fields are copied, nothing else the result carries.
 */
export function outcomeSelection(selection: Selection): OutcomeSelection {
  return {
    considered: selection.trace.considered.length,
    candidates: selection.candidates.map((candidate) => ({
      provider: candidate.provider,
      model: candidate.model,
      input: candidate.entry?.price.input ?? null,
      output: candidate.entry?.price.output ?? null,
    })),
    excluded: selection.trace.excluded.map((entry) => ({
      provider: entry.provider,
      model: entry.model,
      reason: entry.reason,
    })),
  };
}

/** A catalog entry's price and provenance, copied at routing time; null when there is no entry. */
export function outcomePrice(entry: ModelEntry | null | undefined): OutcomePrice | null {
  if (entry == null) return null;
  return {
    input: entry.price.input,
    output: entry.price.output,
    verified_on: entry.verified_on,
    source_url: entry.source_url,
  };
}

// ---------------------------------------------------------------- building an outcome

/** `substitution` with both model ids masked by redactText(); null stays null. */
export function maskSubstitution(substitution: ModelSubstitution | null): ModelSubstitution | null {
  if (substitution === null) return null;
  return {
    requested_model: redactText(substitution.requested_model),
    served_model: redactText(substitution.served_model),
    group: substitution.group,
  };
}

/**
 * The one way an outcome is made: `fields` as given, with every client-supplied model id (requested,
 * used, each trace attempt's, each one in the selection and both of a substitution) masked by
 * redactText() in case a key was pasted into it. Masking an already-masked value changes nothing, so a
 * trace masked earlier comes out the same.
 */
export function buildRequestOutcome(fields: RequestOutcome): RequestOutcome {
  const { selection } = fields;
  return {
    ...fields,
    requestedModel: redactText(fields.requestedModel),
    usedModel: fields.usedModel === null ? null : redactText(fields.usedModel),
    trace: fields.trace.map((attempt) => ({
      ...attempt,
      model: redactText(attempt.model),
      substitution: maskSubstitution(attempt.substitution),
    })),
    substitution: maskSubstitution(fields.substitution),
    selection:
      selection === null
        ? null
        : {
            considered: selection.considered,
            candidates: selection.candidates.map((candidate) => ({ ...candidate, model: redactText(candidate.model) })),
            excluded: selection.excluded.map((entry) => ({ ...entry, model: redactText(entry.model) })),
          },
  };
}

// ---------------------------------------------------------------- usage and cost

export interface ResolveUsageAndCostInput {
  /** The usage the provider reported; null when it reported none. */
  readonly reported: ReportedUsage | null;
  /** True only for a fully served response: estimating a failed or cut-short one would invent a cost. */
  readonly complete: boolean;
  /** The pre-call input estimate for this request (src/pricing/estimate.ts), used only when the provider reported nothing. */
  readonly estimatedInputTokens: number;
  readonly maxOutput: number | null;
  /** The catalog entry the request was actually billed on; null/undefined when it is not in the catalog. */
  readonly usedEntry: ModelEntry | null | undefined;
  /** The catalog entry for the requested model, see selectBaselineEntry(); undefined when unknown. */
  readonly baselineEntry: ModelEntry | undefined;
}

export interface UsageAndCost {
  readonly usage: RequestOutcomeUsage | null;
  readonly cost: ComputeCostResult | null;
}

/**
 * Turns what a provider reported (or did not) into the usage and cost shown for one request. The
 * provider's own usage always wins and is labelled "reported"; a completed request whose provider
 * reported none falls back to the pre-call input estimate and the routing default output size,
 * labelled "estimated" so it is never mistaken for a real count. A request that never
 * completed, or whose model/provider pair has no catalog entry, gets no invented number: usage
 * and/or cost stay null rather than a misleading zero. computeCost() rejecting a usage shape it
 * considers internally inconsistent (never expected from real input) yields a null cost, not a
 * crashed request.
 */
export function resolveUsageAndCost(input: ResolveUsageAndCostInput): UsageAndCost {
  const { reported, complete, estimatedInputTokens, maxOutput, usedEntry, baselineEntry } = input;
  let usage: RequestOutcomeUsage | null = null;
  if (reported !== null) {
    usage = {
      input: reported.input,
      cached_input: reported.cachedInput ?? 0,
      output: reported.output,
      origin: 'reported',
    };
  } else if (complete && usedEntry != null) {
    usage = {
      input: estimatedInputTokens,
      cached_input: 0,
      output: expectedOutputTokens(maxOutput, usedEntry),
      origin: 'estimated',
    };
  }
  if (usage === null || usedEntry == null) return { usage, cost: null };
  try {
    const cost = computeCost({
      usage: { input: usage.input, cached_input: usage.cached_input, output: usage.output },
      origin: usage.origin,
      usedEntry,
      baselineEntry,
    });
    return { usage, cost };
  } catch {
    return { usage, cost: null };
  }
}

// ---------------------------------------------------------------- listener registry

/** A listener may be async: a promise it returns is not awaited, and its rejection is contained. */
export type RequestOutcomeListener = (outcome: RequestOutcome) => void;

const listeners = new Set<RequestOutcomeListener>();

/** Registers `listener` to be called for every RequestOutcome emitted from now on. Returns a function that removes it. */
export function onRequestOutcome(listener: RequestOutcomeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Removes every registered listener (tests only; production code only ever adds listeners). */
export function clearRequestOutcomeListeners(): void {
  listeners.clear();
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/**
 * Hands `outcome` to every registered listener, in registration order. A listener that throws, or
 * returns a promise that rejects, never stops the others from running and never propagates: the
 * request this outcome describes is already over, so a broken listener must not take it, or the
 * process (through an unhandled rejection), down.
 */
export function emitRequestOutcome(outcome: RequestOutcome): void {
  for (const listener of listeners) {
    try {
      const returned: unknown = listener(outcome);
      if (isThenable(returned)) {
        Promise.resolve(returned).catch(() => {
          // Deliberately swallowed: see the function comment.
        });
      }
    } catch {
      // Deliberately swallowed: see the function comment.
    }
  }
}
