// Loads and queries the Tollwise pricing and capability catalog (catalog/models.yaml).
//
// The catalog is a small, hand-maintained data file (unlike tollwise.yaml it is not user-edited
// at run time), so the loader validates it once, at startup, and throws a CatalogError listing
// every problem found, each naming the file, the entry and the field.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import type { z } from 'zod';
import type { ProviderId } from '../config/schema.ts';
import { CatalogError, type CatalogProblem } from './errors.ts';
import { type Catalog, CatalogSchema, type ModelEntry } from './schema.ts';

export type { CatalogProblem } from './errors.ts';
export { CatalogError } from './errors.ts';
export { type Catalog, CatalogSchema, type ModelEntry } from './schema.ts';

/** Path to the shipped catalog file, resolved relative to this module so it works from any cwd. */
export function defaultCatalogPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, '..', '..', 'catalog', 'models.yaml');
}

type PathSegment = string | number;

function toSegments(zodPath: readonly PropertyKey[]): PathSegment[] {
  return zodPath.map((segment) => (typeof segment === 'number' ? segment : String(segment)));
}

/** The deepest value that exists along `fieldPath` in the raw, not-yet-validated data. */
function rawAt(raw: unknown, fieldPath: readonly PathSegment[]): unknown {
  let current = raw;
  for (const segment of fieldPath) {
    if (current === null || typeof current !== 'object') return undefined;
    if (!Object.hasOwn(current, segment)) return undefined;
    current = (current as Record<PathSegment, unknown>)[segment];
  }
  return current;
}

/** Labels an entry as `models[<index>]`, adding `(provider/model)` when those fields are readable. */
function describeEntry(raw: unknown, index: number): string {
  const entry = rawAt(raw, ['models', index]);
  const provider = typeof (entry as { provider?: unknown } | undefined)?.provider === 'string';
  const model = typeof (entry as { model?: unknown } | undefined)?.model === 'string';
  if (provider && model) {
    const e = entry as { provider: string; model: string };
    return `models[${index}] (${e.provider}/${e.model})`;
  }
  return `models[${index}]`;
}

function issueToProblem(issue: z.core.$ZodIssue, raw: unknown, source: string): CatalogProblem {
  const fieldPath = toSegments(issue.path);
  if (fieldPath[0] === 'models' && typeof fieldPath[1] === 'number') {
    const index = fieldPath[1];
    const field = issue.code === 'unrecognized_keys' ? issue.keys.join(', ') : fieldPath.slice(2).join('.');
    const message =
      issue.code === 'unrecognized_keys'
        ? `unknown field${issue.keys.length === 1 ? '' : 's'} ${issue.keys.map((k) => `"${k}"`).join(', ')}`
        : issue.message;
    return { source, entry: describeEntry(raw, index), field, message };
  }
  return { source, entry: fieldPath.length > 0 ? fieldPath.join('.') : 'catalog', field: '', message: issue.message };
}

/** Parses and validates already-loaded catalog data. `source` is only used to label problems. */
export function parseCatalog(raw: unknown, source = 'catalog'): Catalog {
  const result = CatalogSchema.safeParse(raw);
  if (!result.success) {
    throw new CatalogError(result.error.issues.map((issue) => issueToProblem(issue, raw, source)));
  }
  return result.data;
}

/** Parses catalog YAML text. `source` is only used to label problems (typically the file path). */
export function parseCatalogText(text: string, source = 'catalog'): Catalog {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw new CatalogError([
      { source, entry: 'catalog', field: '', message: `invalid YAML: ${(error as Error).message.split('\n')[0]}` },
    ]);
  }
  return parseCatalog(raw, source);
}

/** Reads and validates the catalog file at `filePath`. */
export function loadCatalogFile(filePath: string): Catalog {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new CatalogError([
      { source: filePath, entry: 'catalog', field: '', message: `cannot read the file (${code ?? 'unknown error'})` },
    ]);
  }
  return parseCatalogText(text, filePath);
}

let cached: Catalog | undefined;

/**
 * Loads the catalog once and reuses it on later calls with no argument. Passing an explicit
 * `filePath` (tests, tooling) always reads and validates that file, bypassing the cache.
 */
export function loadCatalog(filePath?: string): Catalog {
  if (filePath !== undefined) return loadCatalogFile(filePath);
  if (cached === undefined) cached = loadCatalogFile(defaultCatalogPath());
  return cached;
}

/** Clears the memoized default catalog. Only needed by tests that reload it with different content. */
export function resetCatalogCache(): void {
  cached = undefined;
}

/** The entry for an exact provider + model id, or undefined when the catalog has none. */
export function findEntry(catalog: Catalog, provider: ProviderId, model: string): ModelEntry | undefined {
  return catalog.models.find((entry) => entry.provider === provider && entry.model === model);
}

/** Every entry sharing a canonical model id, in catalog order. */
export function listByCanonical(catalog: Catalog, canonicalModel: string): ModelEntry[] {
  return catalog.models.filter((entry) => entry.canonical_model === canonicalModel);
}

/** All entries grouped by canonical model id, preserving first-seen order of both groups and entries. */
export function groupByCanonical(catalog: Catalog): Map<string, ModelEntry[]> {
  const groups = new Map<string, ModelEntry[]>();
  for (const entry of catalog.models) {
    const group = groups.get(entry.canonical_model);
    if (group === undefined) groups.set(entry.canonical_model, [entry]);
    else group.push(entry);
  }
  return groups;
}
