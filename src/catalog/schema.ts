// The Tollwise pricing and capability catalog schema. One zod schema is both the runtime
// validator of `catalog/models.yaml` and the TypeScript type used everywhere downstream
// (`ModelEntry`, `Catalog`).
//
// Every entry names its own provider and model id (exactly as that provider names it), a
// `canonical_model` id used to group the same underlying model across providers (for example
// OpenAI's own `gpt-6-astra` and OpenRouter's `openai/gpt-6-astra`), and carries provenance:
// where the numbers came from (`source_url`) and when they were read there (`verified_on`).
// A price with no provenance, or a negative price, is rejected — see index.ts for how a whole
// file's worth of problems is reported.

import { z } from 'zod';
import { PROVIDER_IDS } from '../config/schema.ts';

export { PROVIDER_IDS };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A price in USD per 1,000,000 tokens. Zero is valid (a free local model); negative is not. */
const priceSchema = z.number().nonnegative({ error: 'must not be negative' });

export const CapabilitiesSchema = z.strictObject({
  tools: z.boolean(),
  json_mode: z.boolean(),
  vision: z.boolean(),
  streaming: z.boolean(),
});

export const PriceSchema = z.strictObject({
  input: priceSchema,
  output: priceSchema,
  /** Price for a cache hit on input tokens; null when the provider has no prompt-caching discount. */
  cached_input: priceSchema.nullable(),
});

const sourceUrlSchema = z
  .string()
  .min(1, { error: 'is required' })
  .superRefine((value, ctx) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      ctx.addIssue({ code: 'custom', message: `"${value}" is not a valid URL` });
      return;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      ctx.addIssue({ code: 'custom', message: `unsupported URL scheme "${url.protocol}"` });
    }
  });

const verifiedOnSchema = z
  .string()
  .min(1, { error: 'is required' })
  .regex(ISO_DATE, { error: 'must be an ISO date (YYYY-MM-DD)' })
  .refine(isCalendarDate, { error: 'is not a real calendar date' });

/**
 * True when `value` (already shaped YYYY-MM-DD) names a day that exists. `Date.parse` alone is
 * not enough: it rolls an overflowing day over (2026-02-30 becomes 2026-03-02) instead of
 * failing, so the parsed date is formatted back and must match the input exactly.
 */
function isCalendarDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export const ModelEntrySchema = z.strictObject({
  provider: z.enum(PROVIDER_IDS),
  /** The model id exactly as this provider names it (what a request must send to reach it). */
  model: z.string().trim().min(1),
  /** Groups the same underlying model across providers, e.g. direct vs. via OpenRouter. */
  canonical_model: z.string().trim().min(1),
  price: PriceSchema,
  context_window: z.int().positive(),
  max_output: z.int().positive(),
  capabilities: CapabilitiesSchema,
  /** The public page the price, context window and max output were copied from. */
  source_url: sourceUrlSchema,
  /**
   * The date those numbers were confirmed on source_url: the UTC calendar date of the check
   * (ISO format, YYYY-MM-DD), not a local date or a timestamp. UTC because it is reproducible and
   * time-zone independent -- the same check gives the same verified_on regardless of where or
   * when in the day it ran.
   */
  verified_on: verifiedOnSchema,
});

export type ModelEntry = z.output<typeof ModelEntrySchema>;
export type ModelEntryInput = z.input<typeof ModelEntrySchema>;

export const CatalogSchema = z
  .strictObject({
    models: z.array(ModelEntrySchema).min(1, { error: 'the catalog must list at least one model' }),
  })
  .superRefine((value, ctx) => {
    const seen = new Map<string, number>();
    value.models.forEach((entry, index) => {
      const key = `${entry.provider}/${entry.model}`;
      const firstIndex = seen.get(key);
      if (firstIndex !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['models', index, 'model'],
          message: `duplicate entry for provider "${entry.provider}" model "${entry.model}" (already listed at models[${firstIndex}])`,
        });
      } else {
        seen.set(key, index);
      }
    });
  });

export type Catalog = z.output<typeof CatalogSchema>;
export type CatalogInput = z.input<typeof CatalogSchema>;
