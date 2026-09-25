#!/usr/bin/env node
// Modeled savings benchmark: a fixed, seeded workload of chat requests, replayed through a real
// in-process Tollwise against mock providers, priced with the dated entries of catalog/models.yaml.
// Never part of `npm test` or `npm run check`; run by hand with `npm run bench:savings`. Makes no
// paid provider call and no network call outside 127.0.0.1: the mock providers are plain node:http
// servers started by this script, and the one provider key configured is a fixed, non-key-shaped
// placeholder read from a variable this script sets itself, never a real credential.
//
// These numbers are MODELED, not measured: no real provider is called, so they can never be an
// answer to "how much would I actually save". What they do show, honestly and reproducibly, is what
// Tollwise's own routing and cost accounting compute for a fixed, documented mix of requests, priced
// against catalog/models.yaml's dated public prices (see docs/benchmarks.md's "Savings (modeled)"
// section).
//
// Method:
//   1. generateWorkload() builds the mixed workload: REQUESTS_PER_ARCHETYPE requests for each entry
//      in ARCHETYPES (both wire formats; short/medium/long sizes; plain text, tool calls, JSON mode and vision), using a
//      seeded PRNG (mulberry32, WORKLOAD_SEED) only to pick which catalog model each request names and
//      how much filler text pads a "medium"/"large" one -- the same seed always produces the same
//      workload, so the benchmark is reproducible byte for byte.
//   2. Two mock provider servers are started: one OpenAI-shaped (shared by the openai, deepseek and
//      openrouter provider slots, all of which speak that wire format) and one Anthropic-shaped. Each
//      reports a `usage` object computed from the request it received, counted in a way that does not
//      depend on the wire format (see contentSize()): input tokens are the characters of every text
//      the model reads (system prompt, message text, tool names, descriptions and parameter schemas)
//      divided by 4, plus a fixed IMAGE_INPUT_TOKENS per image; output tokens are the request's own
//      max_completion_tokens/max_tokens field. So one workload request reports the same usage whether
//      it reaches its own provider untranslated or another provider after an Anthropic-to-OpenAI
//      translation, and its baseline cost is the same under every policy. This usage is what
//      Tollwise's own cost accounting (src/pricing/cost.ts, via src/proxy/outcome.ts) prices -- this
//      script never computes a cost number itself.
//   3. Each SCENARIOS entry pairs a workload with a configuration and is replayed once per routing
//      policy (cheapest, fastest, balanced):
//        - "default": the mixed workload above under the default configuration (no equivalence group,
//          no preset -- only a provider switch for the same canonical model can happen);
//        - "realistic-default": the realistic workload (generateRealisticWorkload(), same seed; every
//          share and size written down in REALISTIC_SEGMENTS) under the same default configuration,
//          the control that shows what provider switching alone does on that traffic;
//        - "presets-on": the realistic workload with the opt-in presets frontier and small-fast turned
//          on (routing.equivalence_presets), so routing may substitute another model of the same class.
//      Every run starts a fresh, real createTollwiseServer() (src/server/server.ts) and sends every
//      request to it in turn over HTTP, through the exact same request-handling code path production
//      traffic uses. Every answer's x-tollwise-* headers are read: the substituted requests per served
//      model come from x-tollwise-substituted/-model/-provider/-equivalence-group, and the run fails
//      when they disagree with the RequestOutcome the proxy reported for the same request.
//   4. "fastest" and "balanced" rank on each provider's median latency, and no real provider is called
//      here to measure one. Each run therefore uses a health monitor whose latency samples are fixed
//      at ASSUMED_PROVIDER_LATENCY_MS (see withFixedLatency()): the proxy still reports a sample after
//      every call, but that sample is a loopback round trip to a mock (about 0 ms) that says nothing
//      about a real provider, so it is dropped. Every routing decision of every run therefore ranks on
//      the assumed latencies, and the run's final p50 per provider is written to the results file as
//      proof. These are labelled assumptions, not measurements -- never to be confused with
//      benchmarks/overhead.ts's real, measured proxy overhead numbers.
//   5. Every request's RequestOutcome (src/proxy/outcome.ts) is captured through onRequestOutcome(),
//      the same listener interface Tollwise's own analytics store uses, so the cost, baseline and
//      savings numbers reported here are exactly what a real run would have stored, never
//      recomputed by this script.
//
// Writes a new benchmarks/results/savings-<UTC date>.json (savings-<UTC date>-2.json and so on when
// that name is taken; an existing results file is never overwritten): every raw number above, the
// seed, the command, the catalog's verified_on dates, the presets turned on, the workload assumptions,
// the Node version and the Tollwise git commit. `--verify-latest` reruns every scenario without writing
// anything and exits 0 only when every number equals the newest savings results file.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findEntry, loadCatalog } from '../src/catalog/index.ts';
import type { Catalog } from '../src/catalog/schema.ts';
import type { Config, ProviderId, RoutingPolicy } from '../src/config/schema.ts';
import { ConfigSchema } from '../src/config/schema.ts';
import { createHealthMonitor, type HealthMonitor } from '../src/health/monitor.ts';
import { createLogger } from '../src/log/logger.ts';
import { formatUsd } from '../src/pricing/cost.ts';
import { buildRegistry, type ProviderRegistry } from '../src/providers/registry.ts';
import { onRequestOutcome, type RequestOutcome } from '../src/proxy/outcome.ts';
import { EQUIVALENCE_PRESETS_VERSION, presetGroups } from '../src/routing/presets.ts';
import { baseUrl, createTollwiseServer, listen, stopServer } from '../src/server/server.ts';

// ---------------------------------------------------------------- seeded PRNG

/**
 * mulberry32: a small, fast, seeded PRNG (public-domain algorithm). Deterministic: the same seed
 * always yields the same sequence, which is the only property this benchmark needs from it.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Picks a uniformly random element of `values` using `rng`. Throws on an empty array (a bug, never expected input). */
function pick<T>(values: readonly T[], rng: () => number): T {
  const value = values[Math.floor(rng() * values.length)];
  if (value === undefined) throw new RangeError('pick() called with an empty array');
  return value;
}

// ---------------------------------------------------------------- the workload

/** Seed for the whole workload: fixed so the benchmark is reproducible. */
export const WORKLOAD_SEED = 424242;
/** Requests generated per entry of ARCHETYPES. */
export const REQUESTS_PER_ARCHETYPE = 6;

type WireFormat = 'openai' | 'anthropic';
type SizeClass = 'small' | 'medium' | 'large';
type NeedsLabel = 'none' | 'tools' | 'json_mode' | 'vision';

interface Archetype {
  readonly name: string;
  readonly format: WireFormat;
  readonly size: SizeClass;
  readonly needsLabel: NeedsLabel;
  /** Catalog model ids this archetype may request; must all carry the capability needsLabel implies. */
  readonly models: readonly string[];
  buildBody(model: string, filler: string): Record<string, unknown>;
}

/** One paragraph of filler prose repeated to pad a "medium"/"large" request to a larger input size. */
const FILLER_PARAGRAPH =
  'Tollwise inspects the capabilities a request actually needs, tool calls, JSON mode, vision and ' +
  'streaming, before ranking any candidate provider, so a routed answer never silently drops a feature ' +
  'the caller asked for.';

function fillerText(paragraphs: number): string {
  return new Array(paragraphs).fill(FILLER_PARAGRAPH).join('\n');
}

/** Filler paragraphs per size class, both bounds included; the seed picks a count in the range. */
export const FILLER_PARAGRAPHS: Readonly<Record<SizeClass, { readonly min: number; readonly max: number }>> = {
  small: { min: 0, max: 0 },
  medium: { min: 2, max: 3 },
  large: { min: 8, max: 11 },
};

/** How many filler paragraphs a size class gets, with a little seeded jitter for "medium" and "large". */
function sizeJitter(size: SizeClass, rng: () => number): number {
  const { min, max } = FILLER_PARAGRAPHS[size];
  if (min === max) return min;
  return min + Math.floor(rng() * (max - min + 1));
}

const WEATHER_TOOL_OPENAI = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Returns the current weather for a city.',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  },
};

const WEATHER_TOOL_ANTHROPIC = {
  name: 'get_weather',
  description: 'Returns the current weather for a city.',
  input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
};

const FIXTURE_IMAGE_URL = 'https://example.com/fixtures/chart.png';

/** OpenAI-format models: gpt-6-astra and gpt-5.6-luna (openai), deepseek-v4-pro and deepseek-flash (deepseek). */
const OPENAI_MODELS = ['gpt-6-astra', 'gpt-5.6-luna', 'deepseek-v4-pro', 'deepseek-flash'] as const;
/** Same pool, minus deepseek-v4-pro: its catalog entry has capabilities.vision: false. */
const OPENAI_VISION_MODELS = ['gpt-6-astra', 'gpt-5.6-luna', 'deepseek-flash'] as const;
/**
 * Anthropic-format models: both catalog entries carry every capability this workload exercises.
 * These are the literal ids a real caller sends, not the catalog's canonical_model grouping id
 * (claude-haiku-4-5-20251001's canonical_model is "claude-haiku-4.5", but no client ever sends
 * that alias as a model id).
 */
const ANTHROPIC_MODELS = ['claude-opus-5', 'claude-haiku-4-5-20251001'] as const;

export const ARCHETYPES: readonly Archetype[] = [
  {
    name: 'openai-short-qa',
    format: 'openai',
    size: 'small',
    needsLabel: 'none',
    models: OPENAI_MODELS,
    buildBody: (model) => ({
      model,
      messages: [{ role: 'user', content: 'In one short sentence, what year did Apollo 11 land on the Moon?' }],
      max_completion_tokens: 64,
    }),
  },
  {
    name: 'openai-long-context-summary',
    format: 'openai',
    size: 'large',
    needsLabel: 'none',
    models: OPENAI_MODELS,
    buildBody: (model, filler) => ({
      model,
      messages: [
        { role: 'system', content: 'You summarize long documents in three sentences.' },
        { role: 'user', content: `${filler}\n\nSummarize the document above in three sentences.` },
      ],
      max_completion_tokens: 400,
    }),
  },
  {
    name: 'openai-tool-call',
    format: 'openai',
    size: 'medium',
    needsLabel: 'tools',
    models: OPENAI_MODELS,
    buildBody: (model, filler) => ({
      model,
      messages: [{ role: 'user', content: `${filler}\n\nWhat is the current weather in Lisbon, Portugal?` }],
      tools: [WEATHER_TOOL_OPENAI],
      max_completion_tokens: 96,
    }),
  },
  {
    name: 'openai-json-mode',
    format: 'openai',
    size: 'medium',
    needsLabel: 'json_mode',
    models: OPENAI_MODELS,
    buildBody: (model, filler) => ({
      model,
      messages: [
        {
          role: 'user',
          content: `${filler}\n\nExtract the name and age from: "Maria is 34 years old." Reply as JSON.`,
        },
      ],
      response_format: { type: 'json_object' },
      max_completion_tokens: 200,
    }),
  },
  {
    name: 'openai-vision',
    format: 'openai',
    size: 'medium',
    needsLabel: 'vision',
    models: OPENAI_VISION_MODELS,
    buildBody: (model, filler) => ({
      model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: `${filler}\n\nDescribe what is shown in this image in two sentences.` },
            { type: 'image_url', image_url: { url: FIXTURE_IMAGE_URL } },
          ],
        },
      ],
      max_completion_tokens: 180,
    }),
  },
  {
    name: 'anthropic-short-qa',
    format: 'anthropic',
    size: 'small',
    needsLabel: 'none',
    models: ANTHROPIC_MODELS,
    buildBody: (model) => ({
      model,
      messages: [{ role: 'user', content: 'In one short sentence, what year did Apollo 11 land on the Moon?' }],
      max_tokens: 64,
    }),
  },
  {
    name: 'anthropic-long-context-summary',
    format: 'anthropic',
    size: 'large',
    needsLabel: 'none',
    models: ANTHROPIC_MODELS,
    buildBody: (model, filler) => ({
      model,
      system: 'You summarize long documents in three sentences.',
      messages: [{ role: 'user', content: `${filler}\n\nSummarize the document above in three sentences.` }],
      max_tokens: 400,
    }),
  },
  {
    name: 'anthropic-tool-call',
    format: 'anthropic',
    size: 'medium',
    needsLabel: 'tools',
    models: ANTHROPIC_MODELS,
    buildBody: (model, filler) => ({
      model,
      messages: [{ role: 'user', content: `${filler}\n\nWhat is the current weather in Lisbon, Portugal?` }],
      tools: [WEATHER_TOOL_ANTHROPIC],
      max_tokens: 96,
    }),
  },
  {
    name: 'anthropic-vision',
    format: 'anthropic',
    size: 'medium',
    needsLabel: 'vision',
    models: ANTHROPIC_MODELS,
    buildBody: (model, filler) => ({
      model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: `${filler}\n\nDescribe what is shown in this image in two sentences.` },
            { type: 'image', source: { type: 'url', url: FIXTURE_IMAGE_URL } },
          ],
        },
      ],
      max_tokens: 180,
    }),
  },
] as const;

export interface WorkloadRequest {
  readonly id: number;
  readonly archetype: string;
  readonly format: WireFormat;
  readonly needsLabel: NeedsLabel;
  readonly size: SizeClass;
  readonly requestedModel: string;
  readonly body: Record<string, unknown>;
}

/** Builds the fixed, seeded workload: REQUESTS_PER_ARCHETYPE requests per ARCHETYPES entry, in order. */
export function generateWorkload(seed: number): WorkloadRequest[] {
  const rng = mulberry32(seed);
  const requests: WorkloadRequest[] = [];
  let id = 0;
  for (const archetype of ARCHETYPES) {
    for (let i = 0; i < REQUESTS_PER_ARCHETYPE; i += 1) {
      const model = pick(archetype.models, rng);
      const filler = fillerText(sizeJitter(archetype.size, rng));
      requests.push({
        id,
        archetype: archetype.name,
        format: archetype.format,
        needsLabel: archetype.needsLabel,
        size: archetype.size,
        requestedModel: model,
        body: archetype.buildBody(model, filler),
      });
      id += 1;
    }
  }
  return requests;
}

// ---------------------------------------------------------------- the realistic workload

/**
 * Model class of a realistic-workload request: "frontier" names the higher-priced general chat model
 * of a vendor, "small-fast" the lower-priced one -- the same split as the presets of the same names
 * (src/routing/presets.ts), so every request of this workload is a member of exactly one preset.
 */
export type ModelClass = 'frontier' | 'small-fast';

/** A catalog model id a request may name, with its relative weight in the seeded pick. */
export interface WeightedModel {
  readonly model: string;
  readonly weight: number;
}

/**
 * Which model a realistic request names, by wire format and model class. Assumption: an app on the
 * OpenAI format names an OpenAI model three times out of four and a DeepSeek model otherwise; an app
 * on the Anthropic format names an Anthropic model. deepseek-v4-pro has no vision, so a frontier
 * vision request on the OpenAI format always names gpt-6-astra (REALISTIC_VISION_OVERRIDES).
 */
export const REALISTIC_MODELS: Readonly<Record<WireFormat, Readonly<Record<ModelClass, readonly WeightedModel[]>>>> = {
  openai: {
    frontier: [
      { model: 'gpt-6-astra', weight: 3 },
      { model: 'deepseek-v4-pro', weight: 1 },
    ],
    'small-fast': [
      { model: 'gpt-5.6-luna', weight: 3 },
      { model: 'deepseek-flash', weight: 1 },
    ],
  },
  anthropic: {
    frontier: [{ model: 'claude-opus-5', weight: 1 }],
    'small-fast': [{ model: 'claude-haiku-4-5-20251001', weight: 1 }],
  },
};

/** Frontier vision requests on the OpenAI format: deepseek-v4-pro cannot read images, so gpt-6-astra only. */
const REALISTIC_VISION_OVERRIDES: Readonly<Record<ModelClass, readonly WeightedModel[]>> = {
  frontier: [{ model: 'gpt-6-astra', weight: 1 }],
  'small-fast': REALISTIC_MODELS.openai['small-fast'],
};

/** One slice of the realistic workload: `count` requests shaped like `archetype`, naming a `modelClass` model. */
export interface RealisticSegment {
  /** An ARCHETYPES name: fixes the wire format, the request kind and the input size. */
  readonly archetype: string;
  readonly modelClass: ModelClass;
  readonly count: number;
}

/**
 * The realistic workload, 100 requests, as exact counts rather than random draws, so every share is
 * written down here and holds exactly. Assumptions (illustrative, not a survey of real traffic):
 *   - 70% of requests name a small-fast model and 30% a frontier model: apps send most of their
 *     volume to the cheaper model of a vendor and keep the expensive one for harder prompts;
 *   - 60% use the OpenAI Chat Completions format and 40% the Anthropic Messages format;
 *   - by kind: 58% plain text (38 short questions and 20 long-context summaries), 20% tool calls,
 *     10% JSON mode (OpenAI format only; the Anthropic Messages API has no JSON-mode switch) and
 *     12% vision;
 *   - by input size: 38% small, 42% medium and 20% large, as the archetypes define them.
 * The seed then only picks, per request, which vendor's model it names (REALISTIC_MODELS) and how
 * much filler a medium or large request gets, exactly as for the mixed workload.
 */
export const REALISTIC_SEGMENTS: readonly RealisticSegment[] = [
  { archetype: 'openai-short-qa', modelClass: 'small-fast', count: 16 },
  { archetype: 'openai-long-context-summary', modelClass: 'small-fast', count: 6 },
  { archetype: 'openai-tool-call', modelClass: 'small-fast', count: 8 },
  { archetype: 'openai-json-mode', modelClass: 'small-fast', count: 8 },
  { archetype: 'openai-vision', modelClass: 'small-fast', count: 4 },
  { archetype: 'openai-short-qa', modelClass: 'frontier', count: 6 },
  { archetype: 'openai-long-context-summary', modelClass: 'frontier', count: 4 },
  { archetype: 'openai-tool-call', modelClass: 'frontier', count: 4 },
  { archetype: 'openai-json-mode', modelClass: 'frontier', count: 2 },
  { archetype: 'openai-vision', modelClass: 'frontier', count: 2 },
  { archetype: 'anthropic-short-qa', modelClass: 'small-fast', count: 12 },
  { archetype: 'anthropic-long-context-summary', modelClass: 'small-fast', count: 6 },
  { archetype: 'anthropic-tool-call', modelClass: 'small-fast', count: 6 },
  { archetype: 'anthropic-vision', modelClass: 'small-fast', count: 4 },
  { archetype: 'anthropic-short-qa', modelClass: 'frontier', count: 4 },
  { archetype: 'anthropic-long-context-summary', modelClass: 'frontier', count: 4 },
  { archetype: 'anthropic-tool-call', modelClass: 'frontier', count: 2 },
  { archetype: 'anthropic-vision', modelClass: 'frontier', count: 2 },
];

/** REALISTIC_SEGMENTS and REALISTIC_MODELS in words, written to the results file next to them. */
export const REALISTIC_ASSUMPTIONS: readonly string[] = [
  '70% of requests name a small-fast model and 30% a frontier model',
  '60% use the OpenAI Chat Completions format and 40% the Anthropic Messages format',
  '58% plain text (38 short questions, 20 long-context summaries), 20% tool calls, 10% JSON mode ' +
    '(OpenAI format only), 12% vision',
  '38% small, 42% medium and 20% large inputs, as the archetypes define them',
  'an OpenAI-format request names an OpenAI model 3 times out of 4 and a DeepSeek model otherwise ' +
    '(seeded pick); a frontier vision request names gpt-6-astra, since deepseek-v4-pro has no vision',
  'an Anthropic-format request names claude-opus-5 (frontier) or claude-haiku-4-5-20251001 (small-fast)',
];

/** Picks one entry of `models` with probability proportional to its weight, using `rng`. */
function pickWeighted(models: readonly WeightedModel[], rng: () => number): string {
  const total = models.reduce((sum, entry) => sum + entry.weight, 0);
  let point = rng() * total;
  for (const entry of models) {
    point -= entry.weight;
    if (point < 0) return entry.model;
  }
  const last = models.at(-1);
  if (last === undefined) throw new RangeError('pickWeighted() called with an empty array');
  return last.model;
}

function archetypeNamed(name: string): Archetype {
  const archetype = ARCHETYPES.find((entry) => entry.name === name);
  if (archetype === undefined) throw new RangeError(`unknown archetype "${name}"`);
  return archetype;
}

export interface RealisticRequest extends WorkloadRequest {
  readonly modelClass: ModelClass;
}

/** Builds the realistic workload: REALISTIC_SEGMENTS in order, each request's model and filler seeded. */
export function generateRealisticWorkload(seed: number): RealisticRequest[] {
  const rng = mulberry32(seed);
  const requests: RealisticRequest[] = [];
  let id = 0;
  for (const segment of REALISTIC_SEGMENTS) {
    const archetype = archetypeNamed(segment.archetype);
    const pool =
      archetype.format === 'openai' && archetype.needsLabel === 'vision'
        ? REALISTIC_VISION_OVERRIDES[segment.modelClass]
        : REALISTIC_MODELS[archetype.format][segment.modelClass];
    for (let i = 0; i < segment.count; i += 1) {
      const model = pickWeighted(pool, rng);
      const filler = fillerText(sizeJitter(archetype.size, rng));
      requests.push({
        id,
        archetype: archetype.name,
        format: archetype.format,
        needsLabel: archetype.needsLabel,
        size: archetype.size,
        modelClass: segment.modelClass,
        requestedModel: model,
        body: archetype.buildBody(model, filler),
      });
      id += 1;
    }
  }
  return requests;
}

/** How many requests of `requests` fall in each value of `keyOf`, keys sorted: the realized shares. */
export function countBy<T>(requests: readonly T[], keyOf: (request: T) => string): Record<string, number> {
  const counts = new Map<string, number>();
  for (const request of requests) {
    const key = keyOf(request);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

// ---------------------------------------------------------------- mock providers

/** Env var name (never OPENAI_API_KEY/ANTHROPIC_API_KEY/...) the mock providers' fixture key is read from. */
const FAKE_KEY_ENV = 'TOLLWISE_BENCH_SAVINGS_KEY';
/** Not shaped like any real provider key (see src/log/patterns.ts): plain text, nothing for guard-keys to flag. */
const FAKE_KEY = 'tollwise-benchmark-fixture-key-not-real';

export interface MockServer {
  readonly url: string;
  close(): Promise<void>;
}

/** Characters-per-token heuristic documented in src/pricing/estimate.ts, reused here for the mock's usage. */
const CHARS_PER_TOKEN = 4;
/** Fixed input tokens the mocks report for each image part, whatever its wire shape. */
export const IMAGE_INPUT_TOKENS = 85;

export interface ContentSize {
  /** Characters of every text the model reads: system prompt, message text, tool names/descriptions/schemas. */
  readonly chars: number;
  /** Image parts, counted once each whether shaped as OpenAI `image_url` or Anthropic `image`. */
  readonly images: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Text length of a `system` field or a message `content`: a plain string or an array of content parts. */
function contentPartsSize(content: unknown): ContentSize {
  if (typeof content === 'string') return { chars: content.length, images: 0 };
  let chars = 0;
  let images = 0;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (!isRecord(part)) continue;
      if (typeof part.text === 'string') chars += part.text.length;
      if (part.type === 'image' || part.type === 'image_url') images += 1;
    }
  }
  return { chars, images };
}

/** Name, description and parameter schema of one tool, in either wire shape. */
function toolChars(tool: unknown): number {
  if (!isRecord(tool)) return 0;
  const definition = isRecord(tool.function) ? tool.function : tool;
  const schema = definition.parameters ?? definition.input_schema;
  let chars = 0;
  if (typeof definition.name === 'string') chars += definition.name.length;
  if (typeof definition.description === 'string') chars += definition.description.length;
  if (schema !== undefined) chars += JSON.stringify(schema).length;
  return chars;
}

/**
 * The size of what a model reads in `body`, measured on content only, never on the JSON envelope, so
 * an Anthropic Messages request and its OpenAI Chat Completions translation have the same size: a
 * top-level `system` and a `role: "system"` message count the same text, `{type: "text"}` parts count
 * their `text`, and a tool counts its name, description and schema whatever its wrapper.
 */
export function contentSize(body: Record<string, unknown>): ContentSize {
  let chars = 0;
  let images = 0;
  const add = (size: ContentSize): void => {
    chars += size.chars;
    images += size.images;
  };
  if (body.system !== undefined) add(contentPartsSize(body.system));
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (isRecord(message)) add(contentPartsSize(message.content));
    }
  }
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) chars += toolChars(tool);
  }
  return { chars, images };
}

/** Input tokens a mock reports for `body`: content characters / CHARS_PER_TOKEN plus IMAGE_INPUT_TOKENS per image. */
export function mockInputTokens(body: Record<string, unknown>): number {
  const size = contentSize(body);
  return Math.max(1, Math.ceil(size.chars / CHARS_PER_TOKEN)) + size.images * IMAGE_INPUT_TOKENS;
}

/** Output tokens a mock reports: the request's own max_completion_tokens/max_tokens (128 when absent). */
export function requestedOutputTokens(body: Record<string, unknown>): number {
  const raw = body.max_completion_tokens ?? body.max_tokens;
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 128;
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('error', reject);
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        const parsed: unknown = text.length === 0 ? {} : JSON.parse(text);
        resolve(typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {});
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

function openAiMockBody(model: string, inputTokens: number, outputTokens: number): unknown {
  return {
    id: 'chatcmpl-savings-bench',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'Mock answer for the savings benchmark.' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens },
  };
}

function anthropicMockBody(model: string, inputTokens: number, outputTokens: number): unknown {
  return {
    id: 'msg-savings-bench',
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: 'Mock answer for the savings benchmark.' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

/**
 * Starts one mock provider server: it answers every POST with a response shaped for `shape`, whose
 * `usage` is computed from the request body it actually received (see mockInputTokens/requestedOutputTokens
 * above), so cost varies with the request's own size the same way a real provider's bill would.
 */
export function startSavingsMock(shape: WireFormat): Promise<MockServer> {
  const server = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found', type: 'invalid_request_error' } }));
      return;
    }
    readJsonBody(req)
      .then((body) => {
        const inputTokens = mockInputTokens(body);
        const outputTokens = requestedOutputTokens(body);
        const model = typeof body.model === 'string' ? body.model : 'mock-model';
        const payload =
          shape === 'openai'
            ? openAiMockBody(model, inputTokens, outputTokens)
            : anthropicMockBody(model, inputTokens, outputTokens);
        const text = JSON.stringify(payload);
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(text).toString(),
        });
        res.end(text);
      })
      .catch(() => {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'bad request', type: 'invalid_request_error' } }));
      });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('savings mock provider failed to bind to a loopback TCP port'));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

// ---------------------------------------------------------------- routing configuration

export const POLICIES: readonly RoutingPolicy[] = ['cheapest', 'fastest', 'balanced'];

export interface ConfigVariant {
  readonly label: 'default' | 'presets-on';
  readonly description: string;
  /** Names written to routing.equivalence_presets; the config schema expands each into its group. */
  readonly equivalencePresets: readonly string[];
}

export const DEFAULT_CONFIG: ConfigVariant = {
  label: 'default',
  description:
    'no equivalence group and no preset: only a provider switch for the same catalog canonical model can happen',
  equivalencePresets: [],
};

export const PRESETS_ON_CONFIG: ConfigVariant = {
  label: 'presets-on',
  description:
    'routing.equivalence_presets: [frontier, small-fast]: a request may be served by another model of its class',
  equivalencePresets: ['frontier', 'small-fast'],
};

export type WorkloadName = 'mixed' | 'realistic';

export interface Scenario {
  readonly id: 'default' | 'realistic-default' | 'presets-on';
  readonly description: string;
  readonly workload: WorkloadName;
  readonly config: ConfigVariant;
}

export const SCENARIOS: readonly Scenario[] = [
  {
    id: 'default',
    description: 'the mixed workload under the default configuration: provider switching only',
    workload: 'mixed',
    config: DEFAULT_CONFIG,
  },
  {
    id: 'realistic-default',
    description: 'the realistic workload under the default configuration: provider switching only (control)',
    workload: 'realistic',
    config: DEFAULT_CONFIG,
  },
  {
    id: 'presets-on',
    description: 'the realistic workload with the frontier and small-fast presets turned on',
    workload: 'realistic',
    config: PRESETS_ON_CONFIG,
  },
];

/** The requests of `workload`, both built from `seed`. */
export function workloadRequests(workload: WorkloadName, seed: number): WorkloadRequest[] {
  return workload === 'mixed' ? generateWorkload(seed) : generateRealisticWorkload(seed);
}

/**
 * Assumed per-provider latency (milliseconds): the only latency samples the health monitor holds
 * during a run (see withFixedLatency()), so "fastest" and "balanced" rank on exactly these numbers.
 * Labelled assumptions used only to exercise the routing feature -- never a measurement; see
 * benchmarks/overhead.ts for Tollwise's real, measured proxy overhead.
 */
export const ASSUMED_PROVIDER_LATENCY_MS: Readonly<Record<ProviderId, number>> = {
  anthropic: 700,
  openai: 900,
  openrouter: 1100,
  deepseek: 1400,
  ollama: 0,
};

export interface MockUrls {
  readonly openai: string;
  readonly anthropic: string;
}

function buildConfig(policy: RoutingPolicy, variant: ConfigVariant, mocks: MockUrls): Config {
  return ConfigSchema.parse({
    providers: {
      openai: { base_url: mocks.openai, api_key_env: FAKE_KEY_ENV },
      deepseek: { base_url: mocks.openai, api_key_env: FAKE_KEY_ENV },
      openrouter: { base_url: mocks.openai, api_key_env: FAKE_KEY_ENV },
      anthropic: { base_url: mocks.anthropic, api_key_env: FAKE_KEY_ENV },
      ollama: { enabled: false },
    },
    routing: {
      policy,
      on_no_candidate: 'fail',
      equivalence_presets: [...variant.equivalencePresets],
    },
    analytics: { enabled: false },
  });
}

/**
 * Wraps `monitor` so its latency samples stay fixed: recordLatency() becomes a no-op, every other
 * method is the real one. The proxy records a sample after every provider call, but against a
 * loopback mock that sample is about 0 ms and would replace the assumed latency after the first call,
 * so "fastest" would end up ranking on mock round trips instead of the documented assumption.
 */
export function withFixedLatency(monitor: HealthMonitor): HealthMonitor {
  return {
    start: () => monitor.start(),
    stop: () => monitor.stop(),
    checkNow: (id) => monitor.checkNow(id),
    recordLatency: () => undefined,
    snapshot: () => monitor.snapshot(),
  };
}

/** A health monitor for `registry` whose only latency sample per provider is ASSUMED_PROVIDER_LATENCY_MS. */
export function buildHealthMonitor(registry: ProviderRegistry): HealthMonitor {
  const monitor = createHealthMonitor({ adapters: registry.enabled, env: {} });
  for (const id of Object.keys(ASSUMED_PROVIDER_LATENCY_MS) as ProviderId[]) {
    monitor.recordLatency(id, ASSUMED_PROVIDER_LATENCY_MS[id]);
  }
  return withFixedLatency(monitor);
}

/** Each monitored provider's p50 in `monitor`, keyed by provider id. */
export function latencyP50(monitor: HealthMonitor): Record<string, number | null> {
  const p50: Record<string, number | null> = {};
  for (const provider of monitor.snapshot().providers) p50[provider.id] = provider.p50;
  return p50;
}

// ---------------------------------------------------------------- sending the workload

function endpointFor(url: string, format: WireFormat): string {
  return format === 'anthropic' ? `${url}/v1/messages` : `${url}/v1/chat/completions`;
}

/** What an answer's x-tollwise-* headers say about model substitution. */
export interface SubstitutionHeaders {
  readonly requestedModel: string;
  readonly substituted: boolean;
  /** The provider and model that served the request; null when the request was refused before any call. */
  readonly servedProvider: string | null;
  readonly servedModel: string | null;
  /** The group that allowed the substitution; null when substituted is false. */
  readonly equivalenceGroup: string | null;
}

/**
 * Reads the substitution headers of one answer. Throws when x-tollwise-substituted or
 * x-tollwise-requested-model is missing or malformed: every chat answer carries them, so a missing one
 * is a Tollwise defect the benchmark must not paper over.
 */
export function readSubstitutionHeaders(headers: Headers): SubstitutionHeaders {
  const substituted = headers.get('x-tollwise-substituted');
  const requestedModel = headers.get('x-tollwise-requested-model');
  if (substituted !== 'true' && substituted !== 'false') {
    throw new Error(`savings: x-tollwise-substituted is ${JSON.stringify(substituted)}, expected "true" or "false"`);
  }
  if (requestedModel === null) throw new Error('savings: x-tollwise-requested-model is missing');
  const equivalenceGroup = headers.get('x-tollwise-equivalence-group');
  if (substituted === 'true' && equivalenceGroup === null) {
    throw new Error('savings: x-tollwise-substituted is true but x-tollwise-equivalence-group is missing');
  }
  return {
    requestedModel: decodeURIComponent(requestedModel),
    substituted: substituted === 'true',
    servedProvider: headers.get('x-tollwise-provider'),
    servedModel: headers.has('x-tollwise-model') ? decodeURIComponent(headers.get('x-tollwise-model') ?? '') : null,
    equivalenceGroup: substituted === 'true' && equivalenceGroup !== null ? decodeURIComponent(equivalenceGroup) : null,
  };
}

async function sendOne(url: string, request: WorkloadRequest): Promise<SubstitutionHeaders> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (request.format === 'anthropic') headers['anthropic-version'] = '2023-06-01';
  const response = await fetch(endpointFor(url, request.format), {
    method: 'POST',
    headers,
    body: JSON.stringify(request.body),
  });
  // Drained regardless of status: a routing failure surfaces in the request's RequestOutcome
  // (decision "fail"), not as a thrown error here.
  await response.text();
  return readSubstitutionHeaders(response.headers);
}

/** Waits until at least one more outcome has been pushed since `previousLength`, or throws after 2 s. */
async function waitForOutcome(outcomes: readonly RequestOutcome[], previousLength: number): Promise<void> {
  const deadline = Date.now() + 2000;
  while (outcomes.length <= previousLength) {
    if (Date.now() > deadline) {
      throw new Error(
        `savings: timed out waiting for a RequestOutcome (had ${outcomes.length}, expected more than ${previousLength})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export interface RunResult {
  readonly outcomes: readonly RequestOutcome[];
  /** The substitution headers of every answer, in request order (one per outcome). */
  readonly headers: readonly SubstitutionHeaders[];
  /** Each provider's p50 in the health monitor after the last request: the latencies routing ranked on. */
  readonly latencyP50AfterRun: Record<string, number | null>;
}

/** Replays `requests` through a fresh in-process Tollwise configured for `policy` and `variant`. */
export async function runOnce(
  policy: RoutingPolicy,
  variant: ConfigVariant,
  requests: readonly WorkloadRequest[],
  mocks: MockUrls,
): Promise<RunResult> {
  const config = buildConfig(policy, variant, mocks);
  const env = { [FAKE_KEY_ENV]: FAKE_KEY };
  const registry = buildRegistry(config, env);
  const catalog = loadCatalog();
  const healthMonitor = buildHealthMonitor(registry);
  const logger = createLogger({ level: 'error', sink: { write: () => undefined } });
  const server = createTollwiseServer({
    maxBodyBytes: 4 * 1024 * 1024,
    logger,
    healthMonitor,
    proxy: { config, catalog, registry, env },
  });
  const address = await listen(server, '127.0.0.1', 0);
  const url = baseUrl('127.0.0.1', address.port);

  const outcomes: RequestOutcome[] = [];
  const headers: SubstitutionHeaders[] = [];
  const unregister = onRequestOutcome((outcome) => outcomes.push(outcome));
  let latencyP50AfterRun: Record<string, number | null> = {};
  try {
    for (const request of requests) {
      const before = outcomes.length;
      headers.push(await sendOne(url, request));
      await waitForOutcome(outcomes, before);
    }
    latencyP50AfterRun = latencyP50(healthMonitor);
  } finally {
    unregister();
    healthMonitor.stop();
    await stopServer(server, 2000);
  }
  return { outcomes, headers, latencyP50AfterRun };
}

// ---------------------------------------------------------------- aggregation

/** Parses a formatUsd()-shaped string ("-0.006000") back into an integer number of micro-dollars. */
export function parseUsdMicros(text: string): number {
  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const [wholeText, fractionText = ''] = unsigned.split('.');
  const whole = Number(wholeText ?? '0');
  const fraction = Number(fractionText.padEnd(6, '0').slice(0, 6));
  const micros = whole * 1_000_000 + fraction;
  return negative ? -micros : micros;
}

export interface RunSummary {
  readonly policy: RoutingPolicy;
  readonly config: ConfigVariant['label'];
  readonly requests: number;
  readonly routed: number;
  readonly passthrough: number;
  readonly failed: number;
  /** Requests where the provider actually used differs from the one the requested model natively belongs to. */
  readonly provider_switches: number;
  /**
   * Requests where the model actually used belongs to a different catalog canonical_model than the one
   * requested -- only possible through an explicit equivalence group. A plain provider mirror of
   * the same canonical model (e.g. openai/gpt-6-astra served via openrouter's "openai/gpt-6-astra"
   * entry) is a provider_switch, never a model_switch: the two entries share one canonical_model.
   */
  readonly model_switches: number;
  /** Request count per "requested provider -> used provider" pair, keys sorted; "none" when no provider was used. */
  readonly routes: Readonly<Record<string, number>>;
  /** Requests whose requested model has no baseline price (never mixed into the totals below). */
  readonly unknown_baseline: number;
  /** Cost of the unknown_baseline requests, reported separately so it is never read as part of a saving. */
  readonly unknown_baseline_cost_usd: string;
  /** Sum of cost_usd, over priced requests with a known baseline only (an apples-to-apples comparison). */
  readonly total_cost_usd: string;
  readonly total_baseline_usd: string;
  readonly total_savings_usd: string;
  readonly savings_percent: number | null;
}

/** The catalog canonical_model for a provider/model pair, or null when the catalog has no such entry. */
function canonicalOf(catalog: Catalog, provider: ProviderId | null, model: string | null): string | null {
  if (provider === null || model === null) return null;
  return findEntry(catalog, provider, model)?.canonical_model ?? null;
}

export function summarizeRun(
  policy: RoutingPolicy,
  variant: ConfigVariant,
  outcomes: readonly RequestOutcome[],
  catalog: Catalog,
): RunSummary {
  let costMicros = 0;
  let baselineMicros = 0;
  let unknownBaseline = 0;
  let unknownBaselineCostMicros = 0;
  let providerSwitches = 0;
  let modelSwitches = 0;
  let routed = 0;
  let passthrough = 0;
  let failed = 0;
  const routeCounts = new Map<string, number>();

  for (const outcome of outcomes) {
    const route = `${outcome.requestedProvider ?? 'none'} -> ${outcome.usedProvider ?? 'none'}`;
    routeCounts.set(route, (routeCounts.get(route) ?? 0) + 1);
    if (outcome.decision === 'routed') routed += 1;
    else if (outcome.decision === 'passthrough') passthrough += 1;
    else failed += 1;

    if (outcome.usedProvider !== null && outcome.usedProvider !== outcome.requestedProvider) providerSwitches += 1;
    const requestedCanonical = canonicalOf(catalog, outcome.requestedProvider, outcome.requestedModel);
    const usedCanonical = canonicalOf(catalog, outcome.usedProvider, outcome.usedModel);
    if (usedCanonical !== null && requestedCanonical !== null && usedCanonical !== requestedCanonical) {
      modelSwitches += 1;
    }

    if (outcome.cost === null) continue;
    if (outcome.cost.baseline_usd === 'unknown') {
      unknownBaseline += 1;
      unknownBaselineCostMicros += parseUsdMicros(outcome.cost.cost_usd);
      continue;
    }
    // Only requests with a known baseline enter the savings comparison: mixing a priced cost against a
    // set of baselines that excludes it would inflate "cost" relative to "baseline" for no real reason.
    // A missing baseline must never be conflated with a $0 or ignored cost.
    costMicros += parseUsdMicros(outcome.cost.cost_usd);
    baselineMicros += parseUsdMicros(outcome.cost.baseline_usd);
  }

  const savingsMicros = baselineMicros - costMicros;
  const savingsPercent = baselineMicros > 0 ? Math.round((savingsMicros / baselineMicros) * 10_000) / 100 : null;

  return {
    policy,
    config: variant.label,
    requests: outcomes.length,
    routed,
    passthrough,
    failed,
    provider_switches: providerSwitches,
    model_switches: modelSwitches,
    routes: Object.fromEntries([...routeCounts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    unknown_baseline: unknownBaseline,
    unknown_baseline_cost_usd: formatUsd(unknownBaselineCostMicros),
    total_cost_usd: formatUsd(costMicros),
    total_baseline_usd: formatUsd(baselineMicros),
    total_savings_usd: formatUsd(savingsMicros),
    savings_percent: savingsPercent,
  };
}

/** Substituted requests served by one provider/model through one equivalence group. */
export interface SubstitutionCount {
  readonly served_provider: string;
  readonly served_model: string;
  readonly equivalence_group: string;
  readonly requests: number;
}

/**
 * Counts the substituted requests of a run per served provider/model and group, from the answers'
 * x-tollwise-* headers. Throws when a header disagrees with the RequestOutcome the proxy reported for
 * the same request, so a published count is never one the dashboard would contradict.
 */
export function countSubstitutions(
  headers: readonly SubstitutionHeaders[],
  outcomes: readonly RequestOutcome[],
): SubstitutionCount[] {
  if (headers.length !== outcomes.length) {
    throw new Error(`savings: ${headers.length} answers but ${outcomes.length} request outcomes`);
  }
  const counts = new Map<string, SubstitutionCount>();
  headers.forEach((header, index) => {
    const outcome = outcomes[index];
    if (outcome === undefined) return;
    const where = `request ${index} (${header.requestedModel})`;
    if (header.requestedModel !== outcome.requestedModel) {
      throw new Error(`savings: ${where}: x-tollwise-requested-model disagrees with "${outcome.requestedModel}"`);
    }
    const substitution = outcome.substitution;
    if (header.substituted !== (substitution !== null)) {
      throw new Error(`savings: ${where}: x-tollwise-substituted is ${header.substituted}, the outcome disagrees`);
    }
    if (!header.substituted || substitution === null) return;
    if (
      header.servedModel !== substitution.served_model ||
      header.servedProvider !== outcome.usedProvider ||
      header.equivalenceGroup !== substitution.group
    ) {
      throw new Error(`savings: ${where}: the substitution headers disagree with the request outcome`);
    }
    const key = `${header.servedProvider}\u0000${header.servedModel}\u0000${header.equivalenceGroup}`;
    const previous = counts.get(key);
    counts.set(key, {
      served_provider: header.servedProvider ?? '',
      served_model: header.servedModel ?? '',
      equivalence_group: header.equivalenceGroup ?? '',
      requests: (previous?.requests ?? 0) + 1,
    });
  });
  return [...counts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, count]) => count);
}

// ---------------------------------------------------------------- the results record

/** One policy's run of one scenario, as written to the results file. */
export interface ScenarioRun extends RunSummary {
  /** Answers whose x-tollwise-substituted header was "true". */
  readonly substituted_requests: number;
  /** Those substituted answers per served provider/model and group (from the x-tollwise-* headers). */
  readonly substitutions: readonly SubstitutionCount[];
  readonly latency_p50_ms_after_run: Record<string, number | null>;
}

export interface ScenarioResult {
  readonly scenario: Scenario;
  readonly runs: readonly ScenarioRun[];
}

/** Replays every SCENARIOS entry once per policy against `mocks`; every run uses the same seed. */
export async function runScenarios(
  mocks: MockUrls,
  catalog: Catalog,
  log: (line: string) => void,
): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];
  for (const scenario of SCENARIOS) {
    const requests = workloadRequests(scenario.workload, WORKLOAD_SEED);
    const runs: ScenarioRun[] = [];
    for (const policy of POLICIES) {
      log(`savings: running scenario=${scenario.id} policy=${policy} (${requests.length} requests) ...`);
      const { outcomes, headers, latencyP50AfterRun } = await runOnce(policy, scenario.config, requests, mocks);
      const substitutions = countSubstitutions(headers, outcomes);
      runs.push({
        ...summarizeRun(policy, scenario.config, outcomes, catalog),
        substituted_requests: substitutions.reduce((sum, entry) => sum + entry.requests, 0),
        substitutions,
        latency_p50_ms_after_run: latencyP50AfterRun,
      });
    }
    results.push({ scenario, runs });
  }
  return results;
}

/** Realized shares of a workload: requests per format, kind, size and requested model. */
function workloadShares(requests: readonly WorkloadRequest[]): Record<string, Record<string, number>> {
  return {
    format: countBy(requests, (request) => request.format),
    needs: countBy(requests, (request) => request.needsLabel),
    size: countBy(requests, (request) => request.size),
    requested_model: countBy(requests, (request) => request.requestedModel),
  };
}

/** Keys of the results record that describe the machine and the moment, never a benchmark number. */
export const VOLATILE_RECORD_KEYS = ['date', 'node_version', 'tollwise_commit', 'tollwise_dirty'] as const;

export const RUN_COMMAND = 'npm run bench:savings';
export const VERIFY_COMMAND = 'node benchmarks/savings.ts --verify-latest';

/** The results record: every number of every scenario plus the method and workload assumptions behind them. */
export function buildRecord(
  results: readonly ScenarioResult[],
  catalog: Catalog,
  context: { readonly date: string; readonly nodeVersion: string; readonly commit: string; readonly dirty: boolean },
): Record<string, unknown> {
  const realistic = generateRealisticWorkload(WORKLOAD_SEED);
  const mixed = generateWorkload(WORKLOAD_SEED);
  return {
    date: context.date,
    label: 'modeled',
    modeled_note:
      'Every figure is modeled from public list prices in catalog/models.yaml, replayed against mock providers ' +
      'with assumed latencies and approximated token counts; none is a measured provider bill.',
    command: RUN_COMMAND,
    verify_command: VERIFY_COMMAND,
    seed: WORKLOAD_SEED,
    node_version: context.nodeVersion,
    tollwise_commit: context.commit,
    tollwise_dirty: context.dirty,
    catalog: {
      path: 'catalog/models.yaml',
      verified_on: [...new Set(catalog.models.map((entry) => entry.verified_on))].sort(),
    },
    method: {
      mock_providers: 'benchmarks/savings.ts, one OpenAI-shaped (openai/deepseek/openrouter) and one Anthropic-shaped',
      usage_reported_by_mocks:
        `input tokens = ceil(content characters / ${CHARS_PER_TOKEN}) + ` +
        `${IMAGE_INPUT_TOKENS} per image, where content is system text, message text and tool name/description/schema, ` +
        "the same for either wire format; output tokens = the request's own max_completion_tokens/max_tokens",
      chars_per_token: CHARS_PER_TOKEN,
      image_input_tokens: IMAGE_INPUT_TOKENS,
      real_component:
        'a real, in-process createTollwiseServer() handles every request; only the two mock providers are fake',
      assumed_provider_latency_ms: ASSUMED_PROVIDER_LATENCY_MS,
      latency_handling:
        'the health monitor holds only the assumed latencies; samples the proxy records against the loopback mocks are dropped',
      substitution_counts:
        "read from each answer's x-tollwise-substituted, -provider, -model and -equivalence-group headers, " +
        'checked against the request outcome the proxy reported',
    },
    workloads: {
      mixed: {
        request_count: mixed.length,
        requests_per_archetype: REQUESTS_PER_ARCHETYPE,
        archetypes: ARCHETYPES.map((archetype) => ({
          name: archetype.name,
          format: archetype.format,
          size: archetype.size,
          needs: archetype.needsLabel,
          candidate_models: archetype.models,
        })),
        filler_paragraphs: FILLER_PARAGRAPHS,
        shares: workloadShares(mixed),
      },
      realistic: {
        request_count: realistic.length,
        assumptions: REALISTIC_ASSUMPTIONS,
        segments: REALISTIC_SEGMENTS,
        models: REALISTIC_MODELS,
        filler_paragraphs: FILLER_PARAGRAPHS,
        shares: {
          model_class: countBy(realistic, (request) => request.modelClass),
          ...workloadShares(realistic),
        },
      },
    },
    scenarios: results.map(({ scenario, runs }) => ({
      id: scenario.id,
      label: 'modeled',
      description: scenario.description,
      workload: scenario.workload,
      config: {
        label: scenario.config.label,
        description: scenario.config.description,
        equivalence_presets: scenario.config.equivalencePresets,
        equivalence_presets_version: EQUIVALENCE_PRESETS_VERSION,
        enabled_presets: presetGroups(scenario.config.equivalencePresets),
      },
      runs,
    })),
  };
}

// ---------------------------------------------------------------- results files

const RESULTS_FILE_PATTERN = /^savings-(\d{4}-\d{2}-\d{2})(?:-(\d+))?\.json$/;

/** A results file name split into its date and its collision suffix (1 when it has none). */
function parseResultsName(name: string): { date: string; suffix: number } | null {
  const match = RESULTS_FILE_PATTERN.exec(name);
  if (match === null || match[1] === undefined) return null;
  return { date: match[1], suffix: match[2] === undefined ? 1 : Number(match[2]) };
}

/** The newest savings results file among `names` (latest date, then highest suffix), or null. */
export function newestResultsName(names: readonly string[]): string | null {
  let newest: { name: string; date: string; suffix: number } | null = null;
  for (const name of names) {
    const parsed = parseResultsName(name);
    if (parsed === null) continue;
    if (
      newest === null ||
      parsed.date > newest.date ||
      (parsed.date === newest.date && parsed.suffix > newest.suffix)
    ) {
      newest = { name, ...parsed };
    }
  }
  return newest?.name ?? null;
}

/** savings-<date>.json, or the first free savings-<date>-<n>.json (n >= 2) when that name is taken. */
export function nextResultsName(names: readonly string[], date: string): string {
  const taken = new Set(names);
  if (!taken.has(`savings-${date}.json`)) return `savings-${date}.json`;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `savings-${date}-${suffix}.json`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** `record` without VOLATILE_RECORD_KEYS: the part that must be identical on every rerun. */
export function comparableRecord(record: Record<string, unknown>): Record<string, unknown> {
  const volatile: ReadonlySet<string> = new Set(VOLATILE_RECORD_KEYS);
  return Object.fromEntries(Object.entries(record).filter(([key]) => !volatile.has(key)));
}

/** `value` as JSON, cut to 120 characters so a difference report stays readable. */
function shortJson(value: unknown): string {
  const text = JSON.stringify(value) ?? 'undefined';
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

/** JSON paths where `expected` and `actual` differ (at most `limit`), after a JSON round trip of both. */
export function recordDifferences(expected: unknown, actual: unknown, limit = 20): string[] {
  const differences: string[] = [];
  const walk = (left: unknown, right: unknown, at: string): void => {
    if (differences.length >= limit) return;
    if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) {
      if (left !== right) differences.push(`${at}: expected ${shortJson(left)}, got ${shortJson(right)}`);
      return;
    }
    if (Array.isArray(left) !== Array.isArray(right)) {
      differences.push(`${at}: expected ${Array.isArray(left) ? 'an array' : 'an object'}`);
      return;
    }
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])];
    for (const key of keys) {
      walk(leftRecord[key], rightRecord[key], Array.isArray(left) ? `${at}[${key}]` : `${at}.${key}`);
    }
  };
  walk(JSON.parse(JSON.stringify(expected)), JSON.parse(JSON.stringify(actual)), '$');
  return differences;
}

// ---------------------------------------------------------------- main

function gitCommit(repoRoot: string): { commit: string; dirty: boolean } {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' });
  return { commit, dirty: status.trim().length > 0 };
}

const USAGE = `usage: node benchmarks/savings.ts [--verify-latest]

  (no option)       replay every scenario and write a new benchmarks/results/savings-<UTC date>.json
  --verify-latest   replay every scenario without writing; exit 0 only when every number equals
                    the newest benchmarks/results/savings-*.json`;

async function main(args: readonly string[]): Promise<number> {
  if (args.length > 1 || (args.length === 1 && args[0] !== '--verify-latest')) {
    console.error(USAGE);
    return 2;
  }
  const verify = args[0] === '--verify-latest';
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.join(here, '..');
  const resultsDir = path.join(repoRoot, 'benchmarks', 'results');

  let expectedPath: string | null = null;
  if (verify) {
    const newest = existsSync(resultsDir) ? newestResultsName(readdirSync(resultsDir)) : null;
    if (newest === null) {
      console.error('savings: --verify-latest found no benchmarks/results/savings-*.json to compare with');
      return 1;
    }
    expectedPath = path.join(resultsDir, newest);
  }

  console.log('savings: starting the mock providers ...');
  const openAiMock = await startSavingsMock('openai');
  const anthropicMock = await startSavingsMock('anthropic');
  const mocks: MockUrls = { openai: openAiMock.url, anthropic: anthropicMock.url };
  const catalog = loadCatalog();

  let results: ScenarioResult[];
  try {
    results = await runScenarios(mocks, catalog, (line) => console.log(line));
  } finally {
    await openAiMock.close();
    await anthropicMock.close();
  }

  const { commit, dirty } = gitCommit(repoRoot);
  const date = new Date().toISOString();
  const record = buildRecord(results, catalog, { date, nodeVersion: process.version, commit, dirty });

  console.log('');
  for (const { scenario, runs } of results) {
    for (const run of runs) {
      console.log(
        `${scenario.id.padEnd(18)} ${run.policy.padEnd(10)} ` +
          `cost=${run.total_cost_usd} baseline=${run.total_baseline_usd} savings=${run.total_savings_usd} ` +
          `(${run.savings_percent === null ? 'n/a' : `${run.savings_percent}%`}) substituted=${run.substituted_requests}`,
      );
    }
  }
  console.log('');

  if (expectedPath !== null) {
    const expected: unknown = JSON.parse(readFileSync(expectedPath, 'utf8'));
    const expectedRecord = isRecord(expected) ? expected : {};
    const differences = recordDifferences(comparableRecord(expectedRecord), comparableRecord(record));
    const relative = path.relative(repoRoot, expectedPath).split(path.sep).join('/');
    if (differences.length > 0) {
      console.error(`savings: the rerun differs from ${relative}:`);
      for (const difference of differences) console.error(`  ${difference}`);
      return 1;
    }
    console.log(`savings: every number equals ${relative}; nothing written`);
    return 0;
  }

  mkdirSync(resultsDir, { recursive: true });
  const outName = nextResultsName(readdirSync(resultsDir), date.slice(0, 10));
  // "wx" fails instead of overwriting when the name was taken after the directory was listed.
  writeFileSync(path.join(resultsDir, outName), `${JSON.stringify(record, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  console.log(`savings: wrote benchmarks/results/${outName}`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(`savings: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      process.exitCode = 1;
    });
}
