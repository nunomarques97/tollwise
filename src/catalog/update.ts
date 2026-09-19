// `tollwise catalog update`: compares the "openrouter" entries in catalog/models.yaml against the
// OpenRouter public models list and, with --write, applies the changed fields in place.
//
// This module only ever talks to the network when explicitly invoked by this command: the proxy's
// hot path never calls it, and nothing here runs at startup. The upstream response is treated as
// untrusted input: it is size-bounded, time-bounded, validated field by field with zod before any
// of it is trusted, and never printed verbatim -- no request or response headers are ever logged.
// Every string that reaches the terminal and did not come from this module's own literals (model
// ids, the source URL, the catalog path, error messages from lower layers) goes through
// toTerminalText, so a hostile list cannot inject escape sequences or forge report lines.
//
// Prices: OpenRouter publishes "pricing" as USD-per-token decimal strings (e.g. "0.0000025" for
// completion). The catalog stores USD per 1,000,000 tokens (see catalog/models.yaml's header
// comment), so every mapped price is `Number(text) * 1_000_000`. That multiplication can leave
// floating-point noise (e.g. 25.799999999999997 instead of 25.8), which would make the "no
// change" comparison flap on prices that have not actually moved. Every mapped price is therefore
// rounded to PRICE_DECIMALS (6) decimal places -- one more than the finest-grained price already
// checked into catalog/models.yaml (0.018396) -- before it is compared or written.

import { randomBytes } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isMap, isSeq, parseDocument } from 'yaml';
import { z } from 'zod';
import { defaultCatalogPath, loadCatalogFile, parseCatalogText } from './index.ts';
import type { Catalog, ModelEntry } from './schema.ts';

export const DEFAULT_SOURCE_URL = 'https://openrouter.ai/api/v1/models';

/** Largest upstream response accepted, bytes. The real list is a few MB; this bounds a hostile or broken one. */
export const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

/** How long to wait for the upstream response before giving up. */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** Decimal places kept in a mapped USD-per-1,000,000-tokens price; see the file header for why. */
const PRICE_DECIMALS = 6;

/**
 * A plain upstream model id: printable ASCII letters, digits and the separators OpenRouter uses
 * (e.g. "anthropic/claude-sonnet-4.5", "meta-llama/llama-3.1-8b-instruct:free"). Anything else --
 * control characters, spaces, non-ASCII look-alikes -- is ignored rather than printed or matched.
 */
export const UPSTREAM_ID_PATTERN = /^[A-Za-z0-9._:/@+~-]{1,200}$/;

/** Most upstream entries accepted; the real list has a few hundred. */
const MAX_UPSTREAM_MODELS = 100_000;

/** At most this many skipped entry positions are named in the report. */
const MAX_SKIPPED_NAMED = 10;

/**
 * True for a character that can drive a terminal or change how a line reads: C0 and C1 control
 * characters (ESC, BEL, CR, LF, ...), DEL, and the Unicode bidirectional formatting characters.
 */
function isUnsafeTerminalChar(code: number): boolean {
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/**
 * Makes a string safe to print: every control or bidi-formatting character is replaced by its
 * visible `\uXXXX` escape, so it can neither drive the terminal nor start a new line. With
 * `keepNewlines`, LF is kept (for multi-line messages this program composes itself).
 */
export function toTerminalText(text: string, options: { readonly keepNewlines?: boolean } = {}): string {
  const keepNewlines = options.keepNewlines === true;
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const safe = !isUnsafeTerminalChar(code) || (keepNewlines && code === 0x0a);
    out += safe ? char : `\\u${code.toString(16).padStart(4, '0')}`;
  }
  return out;
}

/** A URL as it may be shown to a person: any user:password part removed, then made terminal-safe. */
export function displayUrl(text: string): string {
  try {
    const url = new URL(text);
    url.username = '';
    url.password = '';
    return toTerminalText(url.href);
  } catch {
    return toTerminalText(text);
  }
}

/** Thrown for anything that stops the update before a diff can be computed, or before a write. */
export class UpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpdateError';
  }
}

// ---------------------------------------------------------------- upstream shape (untrusted input)

/**
 * The only decimal-number shapes OpenRouter's pricing strings take: an optional sign, one or more
 * digits, an optional fractional part, an optional exponent. Checked before any Number()
 * conversion, so strings Number() also accepts but that are not a plain decimal -- "" and " "
 * (both convert to 0), hex ("0x10"), "Infinity", "NaN" -- are rejected by shape, never coerced.
 */
const PRICE_STRING_PATTERN = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;

const numericPriceString = z
  .string()
  .refine(
    (value) => PRICE_STRING_PATTERN.test(value) && Number.isFinite(Number(value)),
    'is not a numeric price string',
  );

const UpstreamPricingSchema = z.object({
  prompt: numericPriceString,
  completion: numericPriceString,
  input_cache_read: numericPriceString.optional(),
});

const UpstreamArchitectureSchema = z
  .object({
    modality: z.string().max(256).optional(),
    input_modalities: z.array(z.string().max(64)).max(32).optional(),
  })
  .optional();

const UpstreamTopProviderSchema = z
  .object({
    context_length: z.number().nullable().optional(),
    max_completion_tokens: z.number().nullable().optional(),
  })
  .optional();

const UpstreamModelSchema = z.object({
  id: z.string().regex(UPSTREAM_ID_PATTERN),
  context_length: z.number().nullable().optional(),
  pricing: UpstreamPricingSchema,
  architecture: UpstreamArchitectureSchema,
  top_provider: UpstreamTopProviderSchema,
  supported_parameters: z.array(z.string().max(128)).max(256).optional(),
});

// Entries are validated one by one (see parseUpstreamList), so one entry with an unusable id can
// be skipped without discarding the whole list.
const UpstreamModelsResponseSchema = z.object({
  data: z.array(z.unknown()).max(MAX_UPSTREAM_MODELS),
});

type UpstreamModel = z.output<typeof UpstreamModelSchema>;

// ---------------------------------------------------------------- mapping

/**
 * What the upstream list says about one model, in the catalog's units. A field is `undefined`
 * when the upstream entry does not carry a usable value for it: such a field is never compared
 * and never written, so the command can only ever copy what upstream actually states -- it never
 * fills a gap with a guess. `capabilities.streaming` is absent altogether because the public list
 * has no per-model field for it; the curated catalog value is always kept.
 */
export interface MappedFields {
  readonly price: {
    readonly input: number | undefined;
    readonly output: number | undefined;
    readonly cached_input: number | undefined;
  };
  readonly capabilities: {
    readonly tools: boolean | undefined;
    readonly json_mode: boolean | undefined;
    readonly vision: boolean | undefined;
  };
  readonly context_window: number | undefined;
  readonly max_output: number | undefined;
}

function roundPrice(value: number): number {
  const factor = 10 ** PRICE_DECIMALS;
  return Math.round(value * factor) / factor;
}

/**
 * A per-token USD price string (OpenRouter's format) to USD per 1,000,000 tokens (the catalog's
 * format). A negative value is OpenRouter's marker for a price it cannot state in advance (its
 * routers use "-1"), so it maps to `undefined`, not to a price.
 */
function tokenPriceToPerMillion(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const perToken = Number(text);
  if (perToken < 0) return undefined;
  return roundPrice(perToken * 1_000_000);
}

/** A positive integer token count, or `undefined` for null, missing, zero or fractional values. */
function positiveCount(value: number | null | undefined): number | undefined {
  return value !== null && value !== undefined && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** The input-side modalities of an architecture.modality string such as "text+image->text". */
function parseModalityString(modality: string | undefined): readonly string[] {
  if (modality === undefined) return [];
  const [input = ''] = modality.split('->');
  return input
    .split('+')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function mapCapabilities(model: UpstreamModel): MappedFields['capabilities'] {
  // No supported_parameters list means upstream says nothing about tools or JSON mode.
  const supported = model.supported_parameters === undefined ? undefined : new Set(model.supported_parameters);
  const architecture = model.architecture;
  const inputModalities =
    architecture?.input_modalities ??
    (architecture?.modality !== undefined ? parseModalityString(architecture.modality) : undefined);
  return {
    tools: supported === undefined ? undefined : supported.has('tools'),
    json_mode:
      supported === undefined ? undefined : supported.has('response_format') || supported.has('structured_outputs'),
    vision: inputModalities === undefined ? undefined : inputModalities.includes('image'),
  };
}

function mapModel(model: UpstreamModel): MappedFields {
  return {
    price: {
      input: tokenPriceToPerMillion(model.pricing.prompt),
      output: tokenPriceToPerMillion(model.pricing.completion),
      // A missing input_cache_read is "not stated", not "no cache discount": the curated value stays.
      cached_input: tokenPriceToPerMillion(model.pricing.input_cache_read),
    },
    capabilities: mapCapabilities(model),
    context_window: positiveCount(model.top_provider?.context_length) ?? positiveCount(model.context_length),
    // Never derived from the context window: a null max_completion_tokens leaves the catalog's value alone.
    max_output: positiveCount(model.top_provider?.max_completion_tokens),
  };
}

export interface UpstreamList {
  readonly models: ReadonlyMap<string, MappedFields>;
  /** Positions in `data` of entries ignored because their id is not a plain model id. */
  readonly skipped: readonly number[];
}

function shapeError(path: readonly PropertyKey[], message: string | undefined): UpdateError {
  const where = path.length > 0 ? ` at "${toTerminalText(path.map(String).join('.'))}"` : '';
  return new UpdateError(
    `the response is not shaped like the OpenRouter models list${where}: ${toTerminalText(message ?? 'invalid shape')}`,
  );
}

/**
 * Parses and validates the upstream JSON, throwing a clear UpdateError on anything unexpected.
 * An entry whose id is a string but not a plain model id (UPSTREAM_ID_PATTERN) is skipped and its
 * position recorded: it is never printed, and it could not name a model a request would send.
 */
export function parseUpstreamList(raw: unknown): UpstreamList {
  const result = UpstreamModelsResponseSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw shapeError(issue?.path ?? [], issue?.message);
  }
  const models = new Map<string, MappedFields>();
  const skipped: number[] = [];
  result.data.data.forEach((entry, index) => {
    const id = typeof entry === 'object' && entry !== null ? (entry as { id?: unknown }).id : undefined;
    if (typeof id === 'string' && !UPSTREAM_ID_PATTERN.test(id)) {
      skipped.push(index);
      return;
    }
    const model = UpstreamModelSchema.safeParse(entry);
    if (!model.success) {
      const issue = model.error.issues[0];
      throw shapeError(['data', index, ...(issue?.path ?? [])], issue?.message);
    }
    models.set(model.data.id, mapModel(model.data));
  });
  return { models, skipped };
}

/** The mapped models of parseUpstreamList, for callers that do not report skipped entries. */
export function parseUpstreamModels(raw: unknown): ReadonlyMap<string, MappedFields> {
  return parseUpstreamList(raw).models;
}

// ---------------------------------------------------------------- diff

export interface FieldChange {
  readonly field: string;
  readonly from: number | boolean | null;
  readonly to: number | boolean | null;
}

export interface ChangedModel {
  readonly model: string;
  readonly changes: readonly FieldChange[];
}

export interface AddedModel {
  readonly model: string;
  readonly mapped: MappedFields;
}

export interface CatalogDiff {
  readonly changed: readonly ChangedModel[];
  readonly added: readonly AddedModel[];
  readonly removed: readonly string[];
  readonly unchangedCount: number;
}

function diffFields(entry: ModelEntry, mapped: MappedFields): FieldChange[] {
  const changes: FieldChange[] = [];
  // `to === undefined` means upstream does not carry the field: skip it, keep the curated value.
  const push = (field: string, from: number | boolean | null, to: number | boolean | undefined): void => {
    if (to !== undefined && from !== to) changes.push({ field, from, to });
  };
  push('price.input', entry.price.input, mapped.price.input);
  push('price.output', entry.price.output, mapped.price.output);
  push('price.cached_input', entry.price.cached_input, mapped.price.cached_input);
  push('capabilities.tools', entry.capabilities.tools, mapped.capabilities.tools);
  push('capabilities.json_mode', entry.capabilities.json_mode, mapped.capabilities.json_mode);
  push('capabilities.vision', entry.capabilities.vision, mapped.capabilities.vision);
  push('context_window', entry.context_window, mapped.context_window);
  push('max_output', entry.max_output, mapped.max_output);
  return changes;
}

/**
 * Compares the catalog's `provider: openrouter` entries against the mapped upstream list, by
 * model id. `added` and `removed` are reported for a person to act on; only `changed` fields are
 * ever written by applyDiff (see below) -- adding or dropping a catalog entry is a curation
 * decision (a canonical_model grouping, a source_url), not something this command decides alone.
 */
export function computeDiff(catalog: Catalog, upstream: ReadonlyMap<string, MappedFields>): CatalogDiff {
  const openRouterEntries = catalog.models.filter((entry) => entry.provider === 'openrouter');

  const changed: ChangedModel[] = [];
  const removed: string[] = [];
  let unchangedCount = 0;

  for (const entry of openRouterEntries) {
    const mapped = upstream.get(entry.model);
    if (mapped === undefined) {
      removed.push(entry.model);
      continue;
    }
    const changes = diffFields(entry, mapped);
    if (changes.length === 0) unchangedCount += 1;
    else changed.push({ model: entry.model, changes });
  }

  const known = new Set(openRouterEntries.map((entry) => entry.model));
  const added: AddedModel[] = [];
  for (const [model, mapped] of upstream) {
    if (!known.has(model)) added.push({ model, mapped });
  }

  return { changed, added, removed, unchangedCount };
}

function formatValue(value: number | boolean | null): string {
  if (value === null) return 'null';
  return String(value);
}

function formatSkipped(skipped: readonly number[]): string {
  const named = skipped
    .slice(0, MAX_SKIPPED_NAMED)
    .map((index) => `data[${index}]`)
    .join(', ');
  const more = skipped.length > MAX_SKIPPED_NAMED ? `, and ${skipped.length - MAX_SKIPPED_NAMED} more` : '';
  const count = skipped.length === 1 ? '1 upstream entry' : `${skipped.length} upstream entries`;
  return `Ignored ${count} whose id is not a plain model id (${named}${more}).`;
}

/**
 * Renders a CatalogDiff as the human-readable report printed by the CLI. Every model id, the URL
 * and the catalog label pass through toTerminalText, whatever their origin.
 */
export function formatDiff(
  diff: CatalogDiff,
  sourceUrl: string,
  catalogLabel = 'catalog/models.yaml',
  skipped: readonly number[] = [],
): string {
  const lines: string[] = [
    `Comparing ${toTerminalText(catalogLabel)} (openrouter entries) against ${displayUrl(sourceUrl)}`,
    '',
  ];
  if (skipped.length > 0) lines.push(formatSkipped(skipped), '');

  if (diff.changed.length === 0 && diff.added.length === 0 && diff.removed.length === 0) {
    lines.push(`No changes: ${diff.unchangedCount} entr${diff.unchangedCount === 1 ? 'y matches' : 'ies match'}.`);
    return lines.join('\n');
  }

  if (diff.changed.length > 0) {
    lines.push(`Changed (${diff.changed.length}):`);
    for (const model of diff.changed) {
      lines.push(`  openrouter/${toTerminalText(model.model)}`);
      for (const change of model.changes) {
        lines.push(`    ${change.field}: ${formatValue(change.from)} -> ${formatValue(change.to)}`);
      }
    }
    lines.push('');
  }

  if (diff.added.length > 0) {
    lines.push(`Added upstream, not yet in the catalog (${diff.added.length}, not written automatically):`);
    for (const model of diff.added) lines.push(`  openrouter/${toTerminalText(model.model)}`);
    lines.push('');
  }

  if (diff.removed.length > 0) {
    lines.push(`No longer in the upstream list (${diff.removed.length}, not deleted automatically):`);
    for (const model of diff.removed) lines.push(`  openrouter/${toTerminalText(model)}`);
    lines.push('');
  }

  lines.push(`Unchanged: ${diff.unchangedCount} entr${diff.unchangedCount === 1 ? 'y' : 'ies'}.`);
  return lines.join('\n');
}

// ---------------------------------------------------------------- applying a diff (yaml Document API)

/**
 * Applies `diff.changed` to `text` (the current contents of catalog/models.yaml), touching only
 * the changed fields plus `verified_on` on the affected entries. Uses the `yaml` package's
 * Document API so every comment, blank line and entry order is preserved untouched.
 */
export function applyDiff(text: string, diff: CatalogDiff, verifiedOn: string): string {
  if (diff.changed.length === 0) return text;

  const doc = parseDocument(text);
  const models = doc.get('models', true);
  if (!isSeq(models)) throw new UpdateError('catalog/models.yaml does not have a top-level "models" list');

  const byModel = new Map(diff.changed.map((change) => [change.model, change] as const));
  for (const item of models.items) {
    if (!isMap(item)) continue;
    if (item.get('provider') !== 'openrouter') continue;
    const modelId = item.get('model');
    const change = typeof modelId === 'string' ? byModel.get(modelId) : undefined;
    if (change === undefined) continue;
    for (const field of change.changes) {
      const path = field.field.split('.');
      if (path.length === 1) item.set(path[0] as string, field.to);
      else item.setIn(path, field.to);
    }
    item.set('verified_on', verifiedOn);
  }

  return String(doc);
}

// ---------------------------------------------------------------- fetching (network, only on demand)

function validateSourceUrl(text: string): void {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new UpdateError(`"${toTerminalText(text)}" is not a valid URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UpdateError(
      `unsupported URL scheme "${toTerminalText(url.protocol)}" (only http and https are accepted)`,
    );
  }
  // fetch refuses such URLs anyway, and its error would print the credentials back.
  if (url.username !== '' || url.password !== '') {
    throw new UpdateError(`the source URL ${displayUrl(text)} must not contain a user name or password`);
  }
}

/** Reads a fetch Response body up to maxBytes, throwing UpdateError if it is exceeded. */
async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new UpdateError(`the response exceeds the ${maxBytes}-byte limit`);
    }
    return text;
  }
  const decoder = new TextDecoder();
  let text = '';
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new UpdateError(`the response exceeds the ${maxBytes}-byte limit`);
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

/**
 * True when `requestedUrl` is https and fetch followed a redirect to a `finalUrl` that is not
 * https -- a plain-http source redirecting to plain http (or a same-scheme redirect chain) is
 * fine, only a downgrade off https is not. `finalUrl` empty means fetch reports no URL (some
 * mocked or opaque responses): treated as no redirect happened, so nothing is refused.
 */
export function isInsecureRedirect(requestedUrl: string, finalUrl: string): boolean {
  return new URL(requestedUrl).protocol === 'https:' && finalUrl !== '' && !finalUrl.startsWith('https:');
}

async function fetchUpstreamJson(sourceUrl: string, timeoutMs: number, maxBytes: number): Promise<unknown> {
  const shown = displayUrl(sourceUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // No headers are sent beyond fetch's own defaults, and none are ever logged; this is a public,
    // unauthenticated, read-only endpoint.
    const response = await fetch(sourceUrl, { signal: controller.signal });
    // fetch follows redirects; never let one quietly downgrade an https source to plain http.
    if (isInsecureRedirect(sourceUrl, response.url)) {
      throw new UpdateError(`fetching ${shown} failed: it redirected to a non-https URL`);
    }
    if (!response.ok) throw new UpdateError(`fetching ${shown} failed: HTTP ${response.status}`);
    const text = await readBounded(response, maxBytes);
    try {
      return JSON.parse(text);
    } catch {
      // The parser's own message quotes the offending response bytes, so it is never shown.
      throw new UpdateError(`the response from ${shown} is not valid JSON`);
    }
  } catch (error) {
    if (error instanceof UpdateError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new UpdateError(`fetching ${shown} timed out after ${timeoutMs} ms`);
    }
    throw new UpdateError(`fetching ${shown} failed: ${toTerminalText((error as Error).message)}`);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- the command

export interface UpdateOptions {
  /** Fetch the list from here instead of DEFAULT_SOURCE_URL. Must be http or https. */
  readonly sourceUrl?: string;
  /** Apply diff.changed to the catalog file; without this, nothing is written. */
  readonly write?: boolean;
  /** Catalog file to read and (with --write) update. Default: the shipped catalog/models.yaml. */
  readonly catalogPath?: string;
  /** Overrides DEFAULT_TIMEOUT_MS; only used by tests. */
  readonly timeoutMs?: number;
  /** Overrides MAX_RESPONSE_BYTES; only used by tests. */
  readonly maxResponseBytes?: number;
}

export interface UpdateResult {
  readonly diff: CatalogDiff;
  /** Positions in the upstream `data` array that were ignored for an unusable id. */
  readonly skipped: readonly number[];
  readonly report: string;
  readonly wrote: boolean;
}

/**
 * Writes `text` to a new, randomly named sibling file and renames it over `filePath`, so an
 * interrupted or failed write can never leave a half-written catalog behind. The temporary file is
 * created exclusively ('wx'): an existing file or symlink at that name is never followed.
 */
function writeAtomically(filePath: string, text: string): void {
  const tempPath = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  let created = false;
  try {
    writeFileSync(tempPath, text, { encoding: 'utf8', flag: 'wx' });
    created = true;
    renameSync(tempPath, filePath);
  } catch (error) {
    if (created) rmSync(tempPath, { force: true });
    throw new UpdateError(`could not write ${toTerminalText(filePath)}: ${toTerminalText((error as Error).message)}`);
  }
}

/**
 * Today's date in the catalog's ISO format (UTC), used as the new verified_on for changed
 * entries. UTC, not local time, so the same run gives the same date wherever it runs -- see the
 * doc comment next to verified_on in schema.ts for why the field itself is a UTC calendar date.
 */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Runs the whole `catalog update` command: fetch, validate, diff, and (with --write) apply.
 * Never writes when there is nothing changed, and always re-validates the written file with the
 * same loader the running proxy uses, so a bad write can never ship silently.
 */
export async function runCatalogUpdate(options: UpdateOptions = {}): Promise<UpdateResult> {
  const sourceUrl = options.sourceUrl ?? DEFAULT_SOURCE_URL;
  validateSourceUrl(sourceUrl);

  const raw = await fetchUpstreamJson(
    sourceUrl,
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    options.maxResponseBytes ?? MAX_RESPONSE_BYTES,
  );
  const { models: upstream, skipped } = parseUpstreamList(raw);

  const catalogPath = options.catalogPath ?? defaultCatalogPath();
  const catalog = loadCatalogFile(catalogPath);
  const diff = computeDiff(catalog, upstream);
  const report = formatDiff(diff, sourceUrl, options.catalogPath ?? 'catalog/models.yaml', skipped);

  let wrote = false;
  if (options.write === true && diff.changed.length > 0) {
    const text = readFileSync(catalogPath, 'utf8');
    const updated = applyDiff(text, diff, todayIso());
    // Re-validate before writing: a write must never leave the catalog in a state the proxy cannot load.
    parseCatalogText(updated, catalogPath);
    writeAtomically(catalogPath, updated);
    wrote = true;
  }

  return { diff, skipped, report, wrote };
}
