// Turns a completed request's token usage into a cost and a savings figure. Pure, synchronous, no
// I/O: every number it needs (the catalog entry actually used, the catalog entry the request would
// have used had it gone to its own requested model on that wire format's native provider, and the
// token usage) is handed in by the caller. This module never decides which provider serves a
// request (that is routing/select.ts) and never reads usage off the wire (that is proxy/forward.ts,
// proxy/openai.ts, proxy/anthropic.ts) -- it only prices numbers it is given.
//
// A savings figure is only ever shown next to where its price came from (reported vs. estimated)
// and the date that price was last verified, and a cost is never silently replaced by 0 when the
// baseline is unknown -- see computeCost() below.
//
// Money is kept as an integer number of micro-dollars (1 micro-dollar = $0.000001) and rendered
// with six fixed decimal places. Catalog prices are USD per 1,000,000 tokens, so a price is also
// the number of micro-dollars per token: each token tier (uncached input, cached input, output) is
// priced as tokens * price and rounded once to the nearest whole micro-dollar. From there on every
// amount (costs, baseline, savings) is an integer sum or difference, so no rounding error builds up
// after that point. The only loss is that per-tier rounding: at most half a micro-dollar per tier
// per request (for example, 1 token at $0.075 per 1M tokens renders as 0.000000). Usage counts are
// validated up front (finite, non-negative integers, cached_input <= input), so bad input fails
// with a RangeError instead of producing a wrong amount.

import type { Catalog, ModelEntry } from '../catalog/schema.ts';
import type { WireFormat } from '../providers/types.ts';
import { nativeProvider } from '../routing/select.ts';

/** One micro-dollar is one millionth of a US dollar: the exact unit every amount is summed in. */
export const MICROS_PER_DOLLAR = 1_000_000;

/** Decimal places a rendered USD amount always carries -- the precision of one micro-dollar. */
export const USD_DECIMALS = 6;

/** Where the token counts priced by computeCost() came from. Passed through to the result unchanged. */
export type CostOrigin = 'reported' | 'estimated';

/** Token usage for one request, ready to price. `input` includes `cached_input`, never adds to it. */
export interface CostUsage {
  /** Input (prompt) tokens, cache hits included. */
  readonly input: number;
  /** The part of `input` billed at the entry's cached_input price; 0 when none of it was a cache hit. */
  readonly cached_input: number;
  /** Output (completion) tokens. */
  readonly output: number;
}

export interface ComputeCostInput {
  readonly usage: CostUsage;
  readonly origin: CostOrigin;
  /** The catalog entry the request was actually billed on. */
  readonly usedEntry: ModelEntry;
  /** The catalog entry for the model the request asked for, see selectBaselineEntry(); undefined when unknown. */
  readonly baselineEntry: ModelEntry | undefined;
}

/** A USD amount rendered with USD_DECIMALS fixed decimals, e.g. "0.006000" or "-0.018000". */
export type UsdAmount = `${number}`;

/** A rendered USD amount, or the literal "unknown" when there is no price to compute it from. */
export type CostAmount = UsdAmount | 'unknown';

export interface ComputeCostResult {
  /** What this request actually cost, on usedEntry's price. Never "unknown": usedEntry is always given. */
  readonly cost_usd: UsdAmount;
  /** What the request would have cost on baselineEntry's price; "unknown" when baselineEntry is undefined. */
  readonly baseline_usd: CostAmount;
  /** baseline_usd minus cost_usd; may be negative (usedEntry cost more); "unknown" when baseline_usd is. */
  readonly savings_usd: CostAmount;
  readonly origin: CostOrigin;
  readonly used_price_verified_on: string;
  /** baselineEntry's verified_on; "unknown" when baselineEntry is undefined. */
  readonly baseline_price_verified_on: string;
}

/**
 * The catalog entry a savings figure is measured against: the entry naming exactly the model id the
 * request asked for (never a canonical-model or equivalence-group match -- a savings number compares
 * against what the caller actually typed), preferring the provider that natively speaks the request's
 * wire format (see routing/select.ts's nativeProvider) when more than one provider lists that model
 * id, else the first one in catalog order. Undefined when no entry names that model id at all.
 */
export function selectBaselineEntry(
  catalog: Catalog,
  requestedModel: string,
  format: WireFormat,
): ModelEntry | undefined {
  const named = catalog.models.filter((entry) => entry.model === requestedModel);
  if (named.length === 0) return undefined;
  return named.find((entry) => entry.provider === nativeProvider(format)) ?? named[0];
}

/**
 * The cost of one token tier in whole micro-dollars. A price in USD per 1M tokens is exactly the
 * number of micro-dollars per token, so this is tokens * price rounded to the nearest micro-dollar.
 */
function tierMicros(tokens: number, pricePerMillionUsd: number): number {
  return Math.round(tokens * pricePerMillionUsd);
}

function assertTokenCount(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`usage.${name} must be a non-negative integer, got ${String(value)}`);
  }
}

/** Throws a RangeError unless every count is a non-negative integer and cached_input <= input. */
export function validateUsage(usage: CostUsage): void {
  assertTokenCount('input', usage.input);
  assertTokenCount('cached_input', usage.cached_input);
  assertTokenCount('output', usage.output);
  if (usage.cached_input > usage.input) {
    throw new RangeError(
      `usage.cached_input (${usage.cached_input}) must not exceed usage.input (${usage.input}): input includes cached tokens`,
    );
  }
}

/** The total cost of `usage` on `entry`'s price, in whole micro-dollars. */
function entryCostMicros(entry: ModelEntry, usage: CostUsage): number {
  const cachedTokens = usage.cached_input;
  const uncachedInputTokens = usage.input - cachedTokens;
  const cachedRate = entry.price.cached_input ?? entry.price.input;
  return (
    tierMicros(uncachedInputTokens, entry.price.input) +
    tierMicros(cachedTokens, cachedRate) +
    tierMicros(usage.output, entry.price.output)
  );
}

/** Renders an integer number of micro-dollars as a fixed-decimal USD string, e.g. -150000 -> "-0.150000". */
export function formatUsd(micros: number): UsdAmount {
  if (!Number.isSafeInteger(micros)) {
    throw new RangeError(`formatUsd expects an integer number of micro-dollars, got ${String(micros)}`);
  }
  const sign = micros < 0 ? '-' : '';
  const abs = Math.abs(micros);
  const whole = Math.trunc(abs / MICROS_PER_DOLLAR);
  const fraction = abs % MICROS_PER_DOLLAR;
  return `${sign}${whole}.${String(fraction).padStart(USD_DECIMALS, '0')}` as UsdAmount;
}

/**
 * Prices one completed request. cost_usd is always a real amount (usedEntry is required and price 0
 * is a real, free price -- it is never confused with "unknown"). baseline_usd, savings_usd and
 * baseline_price_verified_on are the string "unknown" -- never 0 -- when baselineEntry is undefined,
 * so a missing baseline price can never be mistaken for a $0 saving or a $0 cost. savings_usd is
 * baseline_usd minus cost_usd and may be negative: a switch that cost more than the requested model
 * would have is never hidden. Throws a RangeError when usage is invalid (see validateUsage()).
 */
export function computeCost(input: ComputeCostInput): ComputeCostResult {
  const { usage, origin, usedEntry, baselineEntry } = input;
  validateUsage(usage);
  const costMicros = entryCostMicros(usedEntry, usage);
  const cost_usd = formatUsd(costMicros);
  const used_price_verified_on = usedEntry.verified_on;

  if (baselineEntry === undefined) {
    return {
      cost_usd,
      baseline_usd: 'unknown',
      savings_usd: 'unknown',
      origin,
      used_price_verified_on,
      baseline_price_verified_on: 'unknown',
    };
  }

  const baselineMicros = entryCostMicros(baselineEntry, usage);
  return {
    cost_usd,
    baseline_usd: formatUsd(baselineMicros),
    savings_usd: formatUsd(baselineMicros - costMicros),
    origin,
    used_price_verified_on,
    baseline_price_verified_on: baselineEntry.verified_on,
  };
}
