// Loads the Tollwise configuration.
//
// Sources, each overriding the previous one:
//   1. built-in defaults (src/config/schema.ts);
//   2. a YAML file: the `--config` path, else TOLLWISE_CONFIG, else ./tollwise.yaml when present.
//      No file at all is valid (zero configuration);
//   3. environment variables: TOLLWISE_HOST, TOLLWISE_PORT, TOLLWISE_LOG_LEVEL.
// TOLLWISE_ACCESS_KEY is read from the environment only and is never part of the returned configuration.
//
// Every problem found is collected and thrown together as a ConfigError, one line per problem with
// the file path, line:column and a fix hint.

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  type Document,
  isAlias,
  isMap,
  isScalar,
  isSeq,
  LineCounter,
  parseDocument,
  visit,
  type YAMLError,
  type Node as YamlNode,
} from 'yaml';
import type { z } from 'zod';
import { LOG_LEVELS, parseLogLevel } from '../log/logger.ts';
import { KEY_PATTERNS } from '../log/patterns.ts';
import { ConfigError, type ConfigProblem } from './errors.ts';
import { escapeControlChars, isLoopbackHost } from './network.ts';
import { type Config, ConfigSchema, ENV_NAME, ServerSchema } from './schema.ts';

export const CONFIG_ENV = 'TOLLWISE_CONFIG';
export const HOST_ENV = 'TOLLWISE_HOST';
export const PORT_ENV = 'TOLLWISE_PORT';
export const ACCESS_KEY_ENV = 'TOLLWISE_ACCESS_KEY';
export const LOG_LEVEL_ENV = 'TOLLWISE_LOG_LEVEL';
export const DEFAULT_CONFIG_FILE = 'tollwise.yaml';

/** Shortest accepted TOLLWISE_ACCESS_KEY. */
export const MIN_ACCESS_KEY_LENGTH = 16;
/** Largest configuration file read, in bytes. */
export const MAX_CONFIG_FILE_BYTES = 1024 * 1024;
/** Most problems listed individually; the rest are counted in one summary line. */
export const MAX_REPORTED_PROBLEMS = 50;

export type Environment = Readonly<Record<string, string | undefined>>;

export interface LoadOptions {
  /** Path given with `--config`; takes precedence over TOLLWISE_CONFIG. */
  readonly configPath?: string | undefined;
  /** Environment to read from. Default: process.env. */
  readonly env?: Environment;
  /** Directory where ./tollwise.yaml is looked for and relative paths resolve. Default: process.cwd(). */
  readonly cwd?: string;
}

export interface LoadedConfig {
  readonly config: Config;
  /** The configuration file used, as the user wrote its path; null when running on defaults. */
  readonly file: string | null;
  /** How the file was chosen. */
  readonly fileOrigin: 'flag' | 'env' | 'default' | 'none';
  /** Names of the environment variables that overrode a configuration value. */
  readonly envOverrides: readonly string[];
  /** Whether TOLLWISE_ACCESS_KEY is set. The value itself is only available through readAccessKey(). */
  readonly accessKeySet: boolean;
}

/** Reads TOLLWISE_ACCESS_KEY; undefined when unset or empty. Never log the returned value. */
export function readAccessKey(env: Environment = process.env): string | undefined {
  const value = env[ACCESS_KEY_ENV];
  return value === undefined || value.trim() === '' ? undefined : value;
}

/** True when the key a provider needs is present in the environment. */
export function isEnvSet(env: Environment, name: string | null): boolean {
  if (name === null) return false;
  const value = env[name];
  return value !== undefined && value.trim() !== '';
}

/** Returns the name of the key shape `text` matches, if any. */
export function detectKeyShape(text: string): string | undefined {
  return KEY_PATTERNS.find(({ pattern }) => pattern.test(text))?.name;
}

type PathSegment = string | number;

interface ParsedFile {
  readonly display: string;
  readonly doc: Document.Parsed;
  readonly lines: LineCounter;
  readonly raw: unknown;
}

/**
 * Loads and validates the configuration. Throws ConfigError listing every problem when it cannot be used.
 */
export function loadConfig(options: LoadOptions = {}): LoadedConfig {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const problems: ConfigProblem[] = [];

  const chosen = chooseFile(options.configPath, env, cwd);
  let parsed: ParsedFile | undefined;
  if (chosen !== undefined) {
    parsed = readConfigFile(chosen.display, path.resolve(cwd, chosen.display), problems);
  }

  let config: Config | undefined;
  if (parsed !== undefined) {
    problems.push(...findLiteralKeys(parsed));
    const keyFields = new Set(problems.map((problem) => problem.field));
    const result = ConfigSchema.safeParse(parsed.raw ?? {});
    if (result.success) {
      config = result.data;
    } else {
      for (const issue of result.error.issues) {
        for (const problem of issueToProblems(issue, parsed)) {
          if (!keyFields.has(problem.field)) problems.push(problem);
        }
      }
    }
  } else if (chosen === undefined) {
    config = ConfigSchema.parse({});
  }

  const overrides = readEnvOverrides(env, problems);
  const accessKeySet = checkAccessKey(env, problems);

  let effective: Config | undefined;
  if (config !== undefined) {
    effective = {
      ...config,
      server: {
        ...config.server,
        ...(overrides.host !== undefined ? { host: overrides.host } : {}),
        ...(overrides.port !== undefined ? { port: overrides.port } : {}),
      },
      logging: { ...config.logging, ...(overrides.level !== undefined ? { level: overrides.level } : {}) },
    };
  }
  const fileHost = rawAt(parsed?.raw, ['server', 'host']);
  // When the file is invalid elsewhere, still check a well-formed host so the exposure problem is not hidden.
  const validFileHost = ServerSchema.shape.host.safeParse(fileHost);
  const host = effective?.server.host ?? overrides.host ?? (validFileHost.success ? validFileHost.data : undefined);
  if (host !== undefined) checkExposure(host, overrides, accessKeySet, parsed, problems);
  if (effective === undefined || problems.length > 0) throw new ConfigError(capProblems(sortProblems(problems)));

  return {
    config: effective,
    file: chosen?.display ?? null,
    fileOrigin: chosen?.origin ?? 'none',
    envOverrides: overrides.names,
    accessKeySet,
  };
}

// ---------------------------------------------------------------- file selection and parsing

function chooseFile(
  flagPath: string | undefined,
  env: Environment,
  cwd: string,
): { display: string; origin: 'flag' | 'env' | 'default' } | undefined {
  if (flagPath !== undefined) return { display: flagPath, origin: 'flag' };
  const fromEnv = env[CONFIG_ENV];
  if (fromEnv !== undefined && fromEnv.trim() !== '') return { display: fromEnv, origin: 'env' };
  try {
    if (statSync(path.join(cwd, DEFAULT_CONFIG_FILE)).isFile())
      return { display: DEFAULT_CONFIG_FILE, origin: 'default' };
  } catch {
    // No ./tollwise.yaml: zero configuration.
  }
  return undefined;
}

function readConfigFile(display: string, absolute: string, problems: ConfigProblem[]): ParsedFile | undefined {
  const fail = (message: string, hint: string): undefined => {
    problems.push({ source: display, field: '', message, hint });
    return undefined;
  };

  let text: string;
  try {
    const stats = statSync(absolute);
    if (stats.isDirectory())
      return fail('is a directory, not a file', 'point --config or TOLLWISE_CONFIG at a .yaml file');
    if (stats.size > MAX_CONFIG_FILE_BYTES) {
      return fail(`is ${stats.size} bytes, larger than the 1 MiB limit`, 'check that this is the right file');
    }
    text = readFileSync(absolute, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return fail(
        'configuration file not found',
        'check the path, or remove --config / TOLLWISE_CONFIG to run with the built-in defaults',
      );
    }
    return fail(`cannot read the file (${code ?? 'unknown error'})`, 'check that the file exists and is readable');
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines, prettyErrors: false, uniqueKeys: true });
  if (doc.errors.length > 0) {
    for (const error of doc.errors) problems.push(yamlErrorToProblem(error, display, lines));
    return undefined;
  }

  const tagProblems = findUnsupportedTags(doc, display, lines);
  if (tagProblems.length > 0) {
    problems.push(...tagProblems);
    return undefined;
  }

  let raw: unknown;
  try {
    raw = doc.toJS({ maxAliasCount: 100 });
  } catch (error) {
    return fail(
      `cannot be read as YAML (${(error as Error).message})`,
      'simplify the file; aliases may not expand too much',
    );
  }
  if (raw !== null && raw !== undefined && (typeof raw !== 'object' || Array.isArray(raw))) {
    const at = position(doc.contents, lines);
    problems.push({
      source: display,
      ...at,
      field: '',
      message: 'the file must contain a mapping of sections (server, providers, routing, analytics, logging)',
      hint: 'start the file with a section name such as "server:"; see tollwise.example.yaml',
    });
    return undefined;
  }
  return { display, doc, lines, raw };
}

/** Explicit tags that only restate a plain YAML type; every other tag (!!binary, !!set, !custom...) is refused. */
const PLAIN_TAGS: ReadonlySet<string> = new Set(
  ['str', 'int', 'float', 'bool', 'null', 'map', 'seq'].map((name) => `tag:yaml.org,2002:${name}`),
);

function findUnsupportedTags(doc: Document.Parsed, source: string, lines: LineCounter): ConfigProblem[] {
  const found: ConfigProblem[] = [];
  visit(doc, {
    Node(_key, node) {
      if (node.tag === undefined || PLAIN_TAGS.has(node.tag)) return;
      found.push({
        source,
        ...position(node, lines),
        field: '',
        message: `YAML tag "${node.tag.replace(/^tag:yaml\.org,2002:/, '!!')}" is not supported`,
        hint: 'remove the tag and write a plain value (text, number, true/false, list or mapping)',
      });
    },
  });
  return found;
}

function yamlErrorToProblem(error: YAMLError, source: string, lines: LineCounter): ConfigProblem {
  const pos = lines.linePos(error.pos[0]);
  const hints: Partial<Record<string, string>> = {
    DUPLICATE_KEY: 'keep only one of the repeated fields',
    TAB_AS_INDENT: 'indent with spaces, not tabs',
    BAD_INDENT: 'align fields of the same section with the same number of spaces',
    MULTIPLE_DOCS: 'keep a single YAML document (remove the extra "---")',
  };
  return {
    source,
    line: pos.line,
    col: pos.col,
    field: '',
    message: `invalid YAML: ${error.message.split('\n')[0] ?? error.code}`,
    hint: hints[error.code] ?? 'fix the YAML syntax at this position (check indentation, colons and quotes)',
  };
}

function position(node: unknown, lines: LineCounter): { line?: number; col?: number } {
  const range = (node as { range?: [number, number, number] } | null | undefined)?.range;
  if (range === undefined) return {};
  const pos = lines.linePos(range[0]);
  return { line: pos.line, col: pos.col };
}

// ---------------------------------------------------------------- literal keys

const KEY_HINT =
  'never write a key in the configuration; export it as an environment variable (for example OPENAI_API_KEY) and put that variable NAME in api_key_env';

function findLiteralKeys(file: ParsedFile): ConfigProblem[] {
  const found: ConfigProblem[] = [];
  const check = (node: YamlNode | null | undefined, fieldPath: PathSegment[]): void => {
    if (!isScalar(node) || typeof node.value !== 'string') return;
    const shape = detectKeyShape(node.value);
    const looksLikeKeyInEnvField =
      shape === undefined &&
      fieldPath.at(-1) === 'api_key_env' &&
      !ENV_NAME.test(node.value) &&
      node.value.trim().length >= 20;
    if (shape === undefined && !looksLikeKeyInEnvField) return;
    found.push({
      source: file.display,
      ...position(node, file.lines),
      field: formatPath(fieldPath),
      message: 'this value looks like a literal API key or other credential',
      hint: KEY_HINT,
    });
  };
  const walk = (node: unknown, fieldPath: PathSegment[]): void => {
    if (isAlias(node)) return;
    if (isMap(node)) {
      for (const pair of node.items) {
        const key = pair.key as YamlNode | null;
        const name = isScalar(key) ? String(key.value) : '?';
        check(key, [...fieldPath, name]);
        walk(pair.value, [...fieldPath, name]);
      }
    } else if (isSeq(node)) {
      node.items.forEach((item, index) => {
        walk(item, [...fieldPath, index]);
      });
    } else {
      check(node as YamlNode, fieldPath);
    }
  };
  walk(file.doc.contents, []);
  return found;
}

// ---------------------------------------------------------------- zod issues to problems

function formatPath(fieldPath: readonly PathSegment[]): string {
  let out = '';
  for (const segment of fieldPath) {
    out += typeof segment === 'number' ? `[${segment}]` : out === '' ? segment : `.${segment}`;
  }
  return out;
}

function toSegments(zodPath: readonly PropertyKey[]): PathSegment[] {
  return zodPath.map((segment) => (typeof segment === 'number' ? segment : String(segment)));
}

/** The deepest node that exists along `fieldPath`. */
function nodeAt(doc: Document.Parsed, fieldPath: readonly PathSegment[]): unknown {
  for (let length = fieldPath.length; length > 0; length -= 1) {
    const node = doc.getIn(fieldPath.slice(0, length), true);
    if (node !== undefined) return node;
  }
  return doc.contents;
}

function rawAt(raw: unknown, fieldPath: readonly PathSegment[]): unknown {
  let current = raw;
  for (const segment of fieldPath) {
    if (current === null || typeof current !== 'object') return undefined;
    if (!Object.hasOwn(current, segment)) return undefined;
    current = (current as Record<PathSegment, unknown>)[segment];
  }
  return current;
}

function describeValue(value: unknown): string {
  if (value === undefined) return 'nothing';
  if (value === null) return 'an empty value';
  if (typeof value === 'string') {
    return `text "${escapeControlChars(value.length > 60 ? `${value.slice(0, 60)}...` : value)}"`;
  }
  if (typeof value === 'number') return Number.isInteger(value) ? `the number ${value}` : `the decimal ${value}`;
  if (typeof value === 'boolean') return `${value}`;
  if (Array.isArray(value)) return 'a list';
  return 'a mapping';
}

const EXPECTED: Readonly<Record<string, { noun: string; hint: string }>> = {
  int: { noun: 'a whole number', hint: 'write a whole number without quotes, e.g. 8484' },
  // Every numeric field is a whole number; zod reports `number` when the value is not numeric at all.
  number: { noun: 'a whole number', hint: 'write a whole number without quotes, e.g. 8484' },
  string: { noun: 'text', hint: 'write a text value; quote it if it contains ":" or "#"' },
  boolean: { noun: 'true or false', hint: 'write true or false without quotes' },
  object: { noun: 'a mapping of fields', hint: 'put the fields on the following lines, indented under this key' },
  array: { noun: 'a list', hint: 'write one "- item" per line, indented under this key' },
};

function closest(word: string, options: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const option of options) {
    const distance = editDistance(word.toLowerCase(), option.toLowerCase());
    if (distance < bestDistance) {
      best = option;
      bestDistance = distance;
    }
  }
  return bestDistance <= Math.max(2, Math.floor(word.length / 3)) ? best : undefined;
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost);
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

type AnySchema = z.core.$ZodType;

/** The field names allowed by the object schema at `fieldPath`, or [] when it is not an object. */
export function allowedFieldsAt(fieldPath: readonly PathSegment[]): string[] {
  let schema: AnySchema | undefined = ConfigSchema;
  const unwrap = (current: AnySchema | undefined): AnySchema | undefined => {
    let node = current;
    for (let guard = 0; node !== undefined && guard < 10; guard += 1) {
      const def = node._zod.def as { type: string; innerType?: AnySchema; in?: AnySchema };
      if (def.innerType !== undefined) node = def.innerType;
      else if (def.type === 'pipe' && def.in !== undefined) node = def.in;
      else break;
    }
    return node;
  };
  for (const segment of fieldPath) {
    schema = unwrap(schema);
    const def = schema?._zod.def as { type?: string; shape?: Record<string, AnySchema>; element?: AnySchema };
    if (def?.type === 'object' && typeof segment === 'string') schema = def.shape?.[segment];
    else if (def?.type === 'array') schema = def.element;
    else return [];
  }
  const def = unwrap(schema)?._zod.def as { type?: string; shape?: Record<string, AnySchema> } | undefined;
  return def?.type === 'object' && def.shape !== undefined ? Object.keys(def.shape) : [];
}

function issueToProblems(issue: z.core.$ZodIssue, file: ParsedFile): ConfigProblem[] {
  const fieldPath = toSegments(issue.path);
  const field = formatPath(fieldPath);
  const base = { source: file.display };
  const located = (node: unknown) => ({ ...base, ...position(node, file.lines) });
  const value = rawAt(file.raw, fieldPath);

  switch (issue.code) {
    case 'unrecognized_keys': {
      const allowed = allowedFieldsAt(fieldPath);
      const parent = file.doc.getIn(fieldPath, true) ?? (fieldPath.length === 0 ? file.doc.contents : undefined);
      return issue.keys.map((key) => {
        const pair = isMap(parent)
          ? parent.items.find((item) => isScalar(item.key) && String(item.key.value) === key)
          : undefined;
        const guess = closest(key, allowed);
        const where = field === '' ? 'at the top level' : `in ${field}`;
        return {
          ...located(pair?.key ?? parent),
          field: formatPath([...fieldPath, key]),
          message: `unknown field "${key}" ${where}`,
          hint:
            (guess !== undefined ? `did you mean "${guess}"? ` : 'remove it or check the spelling; ') +
            `allowed fields: ${allowed.join(', ')}`,
        };
      });
    }
    case 'invalid_type': {
      const expected = EXPECTED[issue.expected] ?? { noun: issue.expected, hint: 'correct the value' };
      if (value === undefined) {
        return [{ ...located(nodeAt(file.doc, fieldPath)), field, message: 'is required', hint: expected.hint }];
      }
      return [
        {
          ...located(nodeAt(file.doc, fieldPath)),
          field,
          message: `expected ${expected.noun}, got ${describeValue(value)}`,
          hint: expected.hint,
        },
      ];
    }
    case 'invalid_value': {
      const values = issue.values.map(String);
      const guess = typeof value === 'string' ? closest(value, values) : undefined;
      return [
        {
          ...located(nodeAt(file.doc, fieldPath)),
          field,
          message: `${describeValue(value)} is not allowed; expected one of: ${values.join(', ')}`,
          hint: guess !== undefined ? `did you mean "${guess}"?` : `use one of: ${values.join(', ')}`,
        },
      ];
    }
    case 'too_small':
    case 'too_big': {
      const small = issue.code === 'too_small';
      const limit = small ? issue.minimum : issue.maximum;
      let message: string;
      let hint: string;
      if (issue.origin === 'string') {
        message = 'must not be empty';
        hint = 'write a value or remove the field to use the default';
      } else if (issue.origin === 'array') {
        message = `needs ${small ? 'at least' : 'at most'} ${limit} items`;
        hint = small ? `list at least ${limit} items` : `list at most ${limit} items`;
      } else {
        message = `${describeValue(value)} is too ${small ? 'small' : 'large'}; the ${small ? 'minimum' : 'maximum'} is ${limit}`;
        hint = `use a value ${small ? 'of at least' : 'of at most'} ${limit}`;
      }
      return [{ ...located(nodeAt(file.doc, fieldPath)), field, message, hint }];
    }
    case 'invalid_format': {
      const isEnvName = fieldPath.at(-1) === 'api_key_env';
      return [
        {
          ...located(nodeAt(file.doc, fieldPath)),
          field,
          message: isEnvName
            ? `${describeValue(value)} is not an environment variable name`
            : `${describeValue(value)} has the wrong format`,
          hint: isEnvName
            ? 'write the NAME of the variable that holds the key (letters, digits and _), e.g. OPENAI_API_KEY'
            : 'correct the value',
        },
      ];
    }
    case 'invalid_union': {
      const isSize = fieldPath.at(-1) === 'max_body_size';
      return [
        {
          ...located(nodeAt(file.doc, fieldPath)),
          field,
          message: `${describeValue(value)} is not ${isSize ? 'a size' : 'an accepted value'}`,
          hint: isSize ? 'use a number of bytes or a size such as 20mb, 512kb or 1gb' : 'correct the value',
        },
      ];
    }
    case 'custom': {
      const hint = typeof issue.params?.hint === 'string' ? issue.params.hint : 'correct the value';
      return [{ ...located(nodeAt(file.doc, fieldPath)), field, message: issue.message, hint }];
    }
    default:
      return [{ ...located(nodeAt(file.doc, fieldPath)), field, message: issue.message, hint: 'correct the value' }];
  }
}

// ---------------------------------------------------------------- environment

interface EnvOverrides {
  host?: string;
  port?: number;
  level?: Config['logging']['level'];
  readonly names: string[];
}

function envValue(env: Environment, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

function readEnvOverrides(env: Environment, problems: ConfigProblem[]): EnvOverrides {
  const overrides: EnvOverrides = { names: [] };

  const host = envValue(env, HOST_ENV);
  if (host !== undefined) {
    const result = ServerSchema.shape.host.safeParse(host);
    if (result.success) {
      overrides.host = result.data;
      overrides.names.push(HOST_ENV);
    } else {
      problems.push({
        source: `environment ${HOST_ENV}`,
        field: 'server.host',
        message: `"${host}" is not a host name or IP address`,
        hint: `set ${HOST_ENV} to an address such as 127.0.0.1, or unset it`,
      });
    }
  }

  const port = envValue(env, PORT_ENV);
  if (port !== undefined) {
    const number = /^\d{1,5}$/.test(port) ? Number(port) : Number.NaN;
    if (Number.isInteger(number) && number >= 1 && number <= 65535) {
      overrides.port = number;
      overrides.names.push(PORT_ENV);
    } else {
      problems.push({
        source: `environment ${PORT_ENV}`,
        field: 'server.port',
        message: `"${port}" is not a port number`,
        hint: `set ${PORT_ENV} to a whole number between 1 and 65535, or unset it`,
      });
    }
  }

  const level = envValue(env, LOG_LEVEL_ENV);
  if (level !== undefined) {
    const parsed = parseLogLevel(level);
    if (parsed !== undefined) {
      overrides.level = parsed;
      overrides.names.push(LOG_LEVEL_ENV);
    } else {
      problems.push({
        source: `environment ${LOG_LEVEL_ENV}`,
        field: 'logging.level',
        message: `"${level}" is not a log level`,
        hint: `set ${LOG_LEVEL_ENV} to one of: ${LOG_LEVELS.join(', ')}, or unset it`,
      });
    }
  }
  return overrides;
}

function checkAccessKey(env: Environment, problems: ConfigProblem[]): boolean {
  const key = readAccessKey(env);
  if (key === undefined) return false;
  if (key.length < MIN_ACCESS_KEY_LENGTH || /\s/.test(key)) {
    problems.push({
      source: `environment ${ACCESS_KEY_ENV}`,
      field: '',
      message: `the access key must be at least ${MIN_ACCESS_KEY_LENGTH} characters with no spaces`,
      hint: `set ${ACCESS_KEY_ENV} to a long random value, e.g. the output of: node -e "console.log(crypto.randomUUID())"`,
    });
  }
  return true;
}

function checkExposure(
  host: string,
  overrides: EnvOverrides,
  accessKeySet: boolean,
  file: ParsedFile | undefined,
  problems: ConfigProblem[],
): void {
  if (accessKeySet || isLoopbackHost(host)) return;
  const fromEnv = overrides.host !== undefined;
  const location =
    fromEnv || file === undefined
      ? { source: `environment ${HOST_ENV}` }
      : { source: file.display, ...position(file.doc.getIn(['server', 'host'], true), file.lines) };
  problems.push({
    ...location,
    field: 'server.host',
    message: `"${host}" accepts connections from other machines, but ${ACCESS_KEY_ENV} is not set`,
    hint: `set ${ACCESS_KEY_ENV} to a long random value (every request must then send it), or bind to 127.0.0.1`,
  });
}

/** Keeps the first MAX_REPORTED_PROBLEMS problems and summarises the rest in one final line. */
function capProblems(problems: readonly ConfigProblem[]): ConfigProblem[] {
  if (problems.length <= MAX_REPORTED_PROBLEMS) return [...problems];
  const shown = problems.slice(0, MAX_REPORTED_PROBLEMS);
  const hidden = problems.length - shown.length;
  return [
    ...shown,
    {
      source: shown.at(-1)?.source ?? 'configuration',
      field: '',
      message: `${hidden} more problem${hidden === 1 ? '' : 's'} not shown`,
      hint: 'fix the problems above and run the check again',
    },
  ];
}

/** File problems first, in file order; environment problems after, in the order found. */
function sortProblems(problems: readonly ConfigProblem[]): ConfigProblem[] {
  const rank = (problem: ConfigProblem): number => (problem.source.startsWith('environment ') ? 1 : 0);
  return [...problems].sort(
    (a, b) => rank(a) - rank(b) || (a.line ?? 0) - (b.line ?? 0) || (a.col ?? 0) - (b.col ?? 0),
  );
}
