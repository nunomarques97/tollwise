// Redaction of credentials before anything is logged or stored.
//
// - redactHeaders(): masks every header whose name looks sensitive (authorization, x-api-key, cookie, ...)
//   and runs the remaining values through redactText().
// - redactText(): masks key-shaped substrings. The shapes come from src/log/patterns.ts, the single source
//   of truth shared with the pre-commit guard (scripts/guard-keys.mjs). It also masks, literally, every
//   credential value registered at runtime with registerSecretValues(), which covers keys with no known
//   prefix. Those values live only in this module's memory: they are never written to patterns.ts (so the
//   guard never sees them), never serialized, logged or returned by any function.
// - redactDeep(): walks nested data and returns a JSON-safe copy with sensitive fields and key-shaped
//   strings masked. The input is never mutated.

import { KEY_PATTERNS } from './patterns.ts';

/** The replacement written in place of any masked value. */
export const REDACTED = '[REDACTED]';

/**
 * Header or field names that always carry credentials, matched case-insensitively anywhere in the name.
 * Covers authorization, proxy-authorization, x-api-key, api-key, x-goog-api-key, cookie, set-cookie,
 * x-auth-token, client_secret, password and similar.
 */
const SENSITIVE_NAME = /key|auth|secret|token|passw|cookie|credential/i;

/** True when a header or field with this name must have its value masked regardless of content. */
export function isSensitiveName(name: string): boolean {
  return SENSITIVE_NAME.test(name);
}

interface CompiledPattern {
  readonly regex: RegExp;
  readonly hasValueGroup: boolean;
}

function toGlobal(regex: RegExp): RegExp {
  return new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`);
}

const COMPILED: readonly CompiledPattern[] = KEY_PATTERNS.map(({ pattern, extent }) => {
  const regex = toGlobal(extent ?? pattern);
  return { regex, hasValueGroup: regex.source.includes('(?<value>') };
});

/** Registered values shorter than this are ignored, so an ordinary word can never be masked everywhere. */
export const MIN_SECRET_VALUE_LENGTH = 8;

/**
 * Literal forms to mask, longest first so a value that contains another is masked whole. Module-private:
 * nothing reads it except maskRegisteredValues().
 */
let registeredForms: readonly string[] = [];
const registeredValues = new Set<string>();

/** The value itself plus the forms it takes once URL-encoded or escaped inside a JSON string. */
function literalForms(value: string): string[] {
  const forms = new Set<string>([value, JSON.stringify(value).slice(1, -1)]);
  try {
    forms.add(encodeURIComponent(value));
  } catch {
    // A lone surrogate cannot be URL-encoded; the raw and JSON forms are still masked.
  }
  return [...forms];
}

function rebuildForms(): void {
  const forms = new Set<string>();
  for (const value of registeredValues) for (const form of literalForms(value)) forms.add(form);
  registeredForms = [...forms].sort((a, b) => b.length - a.length);
}

/**
 * Registers credential values (for example the provider keys read from the environment at startup) that
 * redactText() must mask literally wherever they appear, whatever their shape. Values shorter than
 * MIN_SECRET_VALUE_LENGTH characters, empty strings and non-strings are ignored. Registering the same value
 * twice is harmless. The values are kept in memory only and are never serialized, logged or exported.
 */
export function registerSecretValues(values: readonly string[]): void {
  let changed = false;
  for (const value of values) {
    if (typeof value !== 'string' || value.length < MIN_SECRET_VALUE_LENGTH || registeredValues.has(value)) continue;
    registeredValues.add(value);
    changed = true;
  }
  if (changed) rebuildForms();
}

/** Forgets every value registered with registerSecretValues() (configuration reload, tests). */
export function clearSecretValues(): void {
  registeredValues.clear();
  registeredForms = [];
}

const BACKSLASH = 0x5c;

/**
 * Replaces every occurrence of `form` in `text`. An occurrence that starts right after an odd number of
 * backslashes takes the last backslash with it: in a serialized line that backslash opens an escape
 * sequence (`\n`) whose letter is the first character of the match, and masking only from the letter would
 * leave a dangling backslash, which is invalid JSON. In plain text (`C:\keys\<value>`) the value is still
 * masked, only the separator before it goes. Runs in linear time: the backslash run before each candidate
 * is tracked while walking forward, never recounted.
 */
function replaceLiteral(text: string, form: string): string {
  let out = '';
  let copiedUpTo = 0;
  let walked = 0;
  let backslashRun = 0;
  let at = text.indexOf(form);
  while (at !== -1) {
    for (; walked < at; walked++) backslashRun = text.charCodeAt(walked) === BACKSLASH ? backslashRun + 1 : 0;
    const start = backslashRun % 2 === 1 ? at - 1 : at;
    out += `${text.slice(copiedUpTo, start)}${REDACTED}`;
    copiedUpTo = at + form.length;
    // What precedes the next candidate is now the replacement, which ends in `]`, not a backslash.
    walked = copiedUpTo;
    backslashRun = 0;
    at = text.indexOf(form, copiedUpTo);
  }
  return copiedUpTo === 0 ? text : `${out}${text.slice(copiedUpTo)}`;
}

function maskRegisteredValues(text: string): string {
  let result = text;
  for (const form of registeredForms) {
    if (result.includes(form)) result = replaceLiteral(result, form);
  }
  return result;
}

/**
 * Masks every registered credential value and every key-shaped substring in `text` (provider keys, bearer
 * and basic credentials, credential header lines and query parameters, URL userinfo, secret assignments,
 * PEM keys).
 */
export function redactText(text: string): string {
  // Registered values first: a shape rule could otherwise mask only part of one and leave the rest.
  let result = maskRegisteredValues(text);
  for (const { regex, hasValueGroup } of COMPILED) {
    regex.lastIndex = 0;
    if (!regex.test(result)) continue;
    regex.lastIndex = 0;
    result = result.replace(regex, (match: string, ...rest: unknown[]) => {
      if (!hasValueGroup) return REDACTED;
      const groups = rest.at(-1) as Record<string, string | undefined> | undefined;
      const value = groups?.value;
      if (value === undefined) return REDACTED;
      const at = match.lastIndexOf(value);
      return `${match.slice(0, at)}${REDACTED}${match.slice(at + value.length)}`;
    });
  }
  return result;
}

/** Header value shapes accepted from `node:http` (IncomingHttpHeaders, OutgoingHttpHeaders) and fetch. */
export type HeaderValue = string | number | readonly string[] | undefined;
export type HeaderInput = Headers | Readonly<Record<string, HeaderValue>> | Iterable<readonly [string, string]>;

function isHeaders(input: HeaderInput): input is Headers {
  return typeof Headers !== 'undefined' && input instanceof Headers;
}

function isIterableInput(input: HeaderInput): input is Iterable<readonly [string, string]> {
  return typeof (input as Partial<Iterable<unknown>>)[Symbol.iterator] === 'function';
}

function redactHeaderValue(name: string, value: string | number | readonly string[]): string | string[] {
  const sensitive = isSensitiveName(name);
  if (Array.isArray(value)) {
    return value.map((item: string) => (sensitive ? REDACTED : redactText(String(item))));
  }
  return sensitive ? REDACTED : redactText(String(value));
}

/**
 * Returns a copy of `headers` safe to log: names are lower-cased, sensitive headers are replaced by
 * `[REDACTED]`, and every other value has key-shaped substrings masked. Never mutates the input.
 */
export function redactHeaders(headers: HeaderInput): Record<string, string | string[]> {
  const out = new Map<string, string | string[]>();
  const entries: Iterable<readonly [string, HeaderValue]> = isHeaders(headers)
    ? headers.entries()
    : isIterableInput(headers)
      ? headers
      : Object.entries(headers);
  for (const [rawName, value] of entries) {
    if (value === undefined) continue;
    const name = rawName.toLowerCase();
    const redacted = redactHeaderValue(name, value);
    const existing = out.get(name);
    if (existing === undefined) {
      out.set(name, redacted);
    } else {
      out.set(name, [
        ...(Array.isArray(existing) ? existing : [existing]),
        ...(Array.isArray(redacted) ? redacted : [redacted]),
      ]);
    }
  }
  return Object.fromEntries(out);
}

/** A JSON-safe value as produced by redactDeep(). */
export type RedactedValue = string | number | boolean | null | RedactedValue[] | { [name: string]: RedactedValue };

export interface RedactDeepOptions {
  /**
   * Called for every object field name before its value is visited. Returning a string replaces the value
   * with that string without visiting it (used by the logger to refuse raw bodies).
   */
  readonly replaceField?: (name: string) => string | undefined;
  /** Strings longer than this are truncated after redaction. Default: no limit. */
  readonly maxStringLength?: number;
  /** Nesting deeper than this is replaced by a marker. Default: 8. */
  readonly maxDepth?: number;
}

const DEFAULT_MAX_DEPTH = 8;

function limitString(value: string, max: number | undefined): string {
  if (max === undefined || value.length <= max) return value;
  return `${value.slice(0, max)}...[truncated ${value.length - max} chars]`;
}

function isBinary(value: object): boolean {
  return ArrayBuffer.isView(value) || value instanceof ArrayBuffer || value instanceof SharedArrayBuffer;
}

function binaryLength(value: object): number {
  if (ArrayBuffer.isView(value)) return value.byteLength;
  return (value as ArrayBuffer).byteLength;
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** Adds an own, enumerable field even when the name is `__proto__` (plain assignment would set the prototype). */
function setField(target: { [name: string]: RedactedValue }, name: string, value: RedactedValue): void {
  Object.defineProperty(target, name, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * Returns a JSON-safe, redacted copy of `value`:
 * - under a field whose name looks sensitive (see isSensitiveName), every string, symbol and unknown object
 *   at any depth is masked; numbers, booleans and null carry no credential and are kept (`tokens: { input: 5 }`);
 * - every string, including field names, goes through redactText();
 * - Error becomes { name, message, stack, code?, cause? }, Date becomes an ISO string, bigint a string;
 * - binary data (Buffer, typed arrays, ArrayBuffer) becomes "[binary: N bytes]" and is never decoded;
 * - other class instances (streams, sockets, Request/Response, Map, ...) become "[<ClassName>]" and are
 *   never walked, so nothing reaches the output through an object's internals;
 * - circular references and nesting beyond `maxDepth` are replaced by markers.
 */
export function redactDeep(value: unknown, options: RedactDeepOptions = {}): RedactedValue | undefined {
  const seen = new WeakSet<object>();
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;

  const visit = (current: unknown, depth: number, sensitive: boolean): RedactedValue | undefined => {
    switch (typeof current) {
      case 'undefined':
        return undefined;
      case 'string':
        return sensitive ? REDACTED : limitString(redactText(current), options.maxStringLength);
      case 'number':
        return Number.isFinite(current) ? current : String(current);
      case 'boolean':
        return current;
      case 'bigint':
        return sensitive ? REDACTED : current.toString();
      case 'symbol':
        return sensitive ? REDACTED : limitString(redactText(current.toString()), options.maxStringLength);
      case 'function':
        return '[Function]';
    }
    if (current === null) return null;
    const object = current as object;

    if (sensitive && !Array.isArray(object) && !isPlainObject(object)) return REDACTED;
    if (object instanceof Date) return Number.isNaN(object.getTime()) ? 'Invalid Date' : object.toISOString();
    if (isBinary(object)) return `[binary: ${binaryLength(object)} bytes]`;
    if (seen.has(object)) return '[Circular]';
    if (depth >= maxDepth) return '[MaxDepth]';
    seen.add(object);
    try {
      if (object instanceof Error) return visitError(object, depth);
      if (Array.isArray(object)) {
        return object.map((item: unknown) => visit(item, depth + 1, sensitive) ?? null);
      }
      if (!isPlainObject(object)) {
        const name = (object as { constructor?: { name?: unknown } }).constructor?.name;
        return typeof name === 'string' && name.length > 0 ? `[${redactText(name)}]` : '[Object]';
      }
      return visitFields(Object.entries(object), depth, sensitive);
    } finally {
      seen.delete(object);
    }
  };

  const visitFields = (
    entries: Iterable<[string, unknown]>,
    depth: number,
    sensitive: boolean,
  ): { [name: string]: RedactedValue } => {
    const out: { [name: string]: RedactedValue } = {};
    for (const [rawName, fieldValue] of entries) {
      const name = redactText(rawName);
      const replacement = options.replaceField?.(rawName);
      let result: RedactedValue | undefined;
      if (replacement !== undefined) result = replacement;
      else result = visit(fieldValue, depth + 1, sensitive || isSensitiveName(rawName));
      if (result !== undefined) setField(out, name, result);
    }
    return out;
  };

  const visitError = (error: Error, depth: number): { [name: string]: RedactedValue } => {
    const fields: [string, unknown][] = [
      ['name', error.name],
      ['message', error.message],
    ];
    const extra = error as Error & { code?: unknown; cause?: unknown };
    if (extra.code !== undefined) fields.push(['code', extra.code]);
    if (error.stack !== undefined) fields.push(['stack', error.stack]);
    if (extra.cause !== undefined) fields.push(['cause', extra.cause]);
    return visitFields(fields, depth, false);
  };

  return visit(value, 0, false);
}
