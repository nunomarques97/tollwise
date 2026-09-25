// Checks that docs/configuration.md documents every field of the configuration schema and every
// environment variable the config loader reads, and that docs/api.md documents every error code the
// server answers with, so the docs and the code can never silently drift apart.
//
// The schema is walked generically through zod's internal `_zod.def`, the same technique
// src/config/load.ts's allowedFieldsAt() uses to build its own field paths for error messages: no
// field list is hand-maintained here. A leaf is a scalar/enum/union field, or a list whose items are
// not themselves an object (e.g. server.allowed_hosts); an object is walked into with a dotted path
// segment, and a list of objects is walked into with a trailing "[]" segment (e.g.
// routing.equivalence_groups[].name). The resulting dotted paths are asserted, one by one, to appear
// in docs/configuration.md as inline code (`like.this`), so a path that is only a prefix of another
// documented path does not count as documented.
//
// Error codes: the codes are collected from the source of src/server and src/proxy (every literal
// code passed to an error writer, and every `code:` of a refusal object) and compared with a fixed
// list, so a new code fails this test until it is added here and to docs/api.md.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { z } from 'zod';
import { ACCESS_KEY_ENV, CONFIG_ENV, HOST_ENV, LOG_LEVEL_ENV, PORT_ENV } from '../src/config/load.ts';
import { ConfigSchema } from '../src/config/schema.ts';
import { PROVIDER_ERROR_KINDS } from '../src/providers/types.ts';
import { RETRYABLE_ERROR_KINDS } from '../src/proxy/forward.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const docPath = path.join(here, '..', 'docs', 'configuration.md');
const doc = readFileSync(docPath, 'utf8');
const apiDoc = readFileSync(path.join(here, '..', 'docs', 'api.md'), 'utf8');
const srcRoot = path.join(here, '..', 'src');

type AnySchema = z.core.$ZodType;

/** Unwraps default/prefault/optional/pipe wrappers to the schema they wrap, like allowedFieldsAt() does. */
function unwrap(schema: AnySchema): AnySchema {
  let node = schema;
  for (let guard = 0; guard < 10; guard += 1) {
    const def = node._zod.def as { type: string; innerType?: AnySchema; in?: AnySchema };
    if (def.innerType !== undefined) node = def.innerType;
    else if (def.type === 'pipe' && def.in !== undefined) node = def.in;
    else break;
  }
  return node;
}

/**
 * Every leaf field path reachable from `schema`, dotted, with "[]" marking a list-of-objects element.
 * An object is always walked into; a list is walked into only when its element is itself an object
 * (otherwise the list field itself is the leaf, e.g. "server.allowed_hosts").
 */
function collectFieldPaths(schema: AnySchema, prefix: string): string[] {
  const node = unwrap(schema);
  const def = node._zod.def as { type: string; shape?: Record<string, AnySchema>; element?: AnySchema };

  if (def.type === 'object' && def.shape !== undefined) {
    return Object.entries(def.shape).flatMap(([key, child]) =>
      collectFieldPaths(child, prefix === '' ? key : `${prefix}.${key}`),
    );
  }
  if (def.type === 'array' && def.element !== undefined) {
    const elementDef = unwrap(def.element)._zod.def as { type: string; shape?: Record<string, AnySchema> };
    if (elementDef.type === 'object' && elementDef.shape !== undefined) {
      return collectFieldPaths(def.element, `${prefix}[]`);
    }
  }
  return [prefix];
}

test('every configuration schema field is documented in docs/configuration.md', () => {
  const paths = collectFieldPaths(ConfigSchema, '');
  // Sanity check on the walker itself: catches a change to the schema's shape (a field added, removed,
  // or nested differently) that would otherwise make this test silently check fewer paths than it should.
  assert.ok(paths.length >= 30, `expected at least 30 field paths, found ${paths.length}: ${paths.join(', ')}`);

  const missing = paths.filter((fieldPath) => !doc.includes(`\`${fieldPath}\``));
  assert.deepEqual(missing, [], `docs/configuration.md is missing these configuration fields: ${missing.join(', ')}`);
});

test('every environment variable the config loader reads is documented in docs/configuration.md', () => {
  const envVars = [CONFIG_ENV, HOST_ENV, PORT_ENV, ACCESS_KEY_ENV, LOG_LEVEL_ENV];
  assert.deepEqual(
    envVars,
    ['TOLLWISE_CONFIG', 'TOLLWISE_HOST', 'TOLLWISE_PORT', 'TOLLWISE_ACCESS_KEY', 'TOLLWISE_LOG_LEVEL'],
    'the set of environment variables the loader reads changed; update this test and docs/configuration.md',
  );

  const missing = envVars.filter((name) => !doc.includes(`\`${name}\``));
  assert.deepEqual(missing, [], `docs/configuration.md is missing these environment variables: ${missing.join(', ')}`);
});

/**
 * Every error code written by the server and proxy source: the literal code argument of each
 * sendError(...) call, and the literal value(s) of each `code:` property of a refusal object (a
 * property at the start of a line, or right after `status: NNN,` or `type: '...',`; a log field such as `{ code: ... }`
 * is neither). In a conditional value, a literal compared with `===` is a condition, not a code.
 */
function errorCodesInSource(): Set<string> {
  const codes = new Set<string>();
  for (const dir of ['server', 'proxy']) {
    for (const name of readdirSync(path.join(srcRoot, dir))) {
      if (!name.endsWith('.ts')) continue;
      const text = readFileSync(path.join(srcRoot, dir, name), 'utf8');
      for (const match of text.matchAll(/sendError\(\s*[\w.]+,\s*[\w.]+,\s*'[a-z_]+',\s*'([a-z_]+)'/g)) {
        codes.add(match[1] ?? '');
      }
      for (const match of text.matchAll(/(?:^[ \t]+|status: \d{3}, |type: '[a-z_]+', )code:\s*([^,\n}]+)/gm)) {
        const value = (match[1] ?? '').replace(/===\s*'[a-z_]+'/g, '');
        for (const literal of value.matchAll(/'([a-z_]+)'/g)) codes.add(literal[1] ?? '');
      }
    }
  }
  return codes;
}

test('every error code the server answers with is documented in docs/api.md', () => {
  // provider_<kind> is built from the provider error kind: only the kinds that are not retried reach
  // the client this way (a retryable one moves on to the next candidate, then all_providers_failed).
  const providerCodes = PROVIDER_ERROR_KINDS.filter((kind) => !RETRYABLE_ERROR_KINDS.has(kind)).map(
    (kind) => `provider_${kind}`,
  );
  assert.deepEqual(providerCodes, ['provider_auth', 'provider_bad_request', 'provider_unknown']);

  const expected = [
    'all_providers_failed',
    'analytics_disabled',
    'dashboard_not_built',
    'format_not_supported',
    'internal_error',
    'invalid_api_key',
    'invalid_json',
    'invalid_provider',
    'invalid_query_parameter',
    'invalid_request',
    'invalid_routing_policy',
    'method_not_allowed',
    'misdirected_request',
    'missing_anthropic_version',
    'model_not_found',
    'model_not_in_catalog',
    'no_capable_provider',
    'not_found',
    'origin_not_allowed',
    'preflight_not_supported',
    'provider_not_configured',
    'proxy_not_configured',
    'request_too_large',
    'response_not_translatable',
    'shutting_down',
    'too_many_event_streams',
    'unsupported_endpoint',
    'unsupported_media_type',
  ];
  assert.deepEqual(
    [...errorCodesInSource()].sort(),
    expected,
    'the set of error codes in src/server and src/proxy changed; update this test and docs/api.md',
  );

  // A code counts as documented when it is a whole word of an inline-code span (`not_found`, or
  // `503 analytics_disabled`), so `not_found` is not satisfied by `not_found_error` alone.
  const documented = new Set([...apiDoc.matchAll(/`([^`\n]+)`/g)].flatMap((span) => (span[1] ?? '').split(/\s+/)));
  const missing = [...expected, ...providerCodes].filter((code) => !documented.has(code));
  assert.deepEqual(missing, [], `docs/api.md is missing these error codes: ${missing.join(', ')}`);
});
