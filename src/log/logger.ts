// Structured logger: one JSON object per line on stderr.
//
// Every log line goes through redaction (src/log/redact.ts): the message, every field name and value at
// any depth, and finally the serialized line itself. The API does not accept raw request or response
// bodies: body-like field names are rejected by the types and replaced at runtime, binary data and
// class instances (streams, Request/Response, IncomingMessage, Buffer) are never serialized, and long
// strings are truncated. A record that cannot be serialized, or whose final redaction would not be valid
// JSON, is replaced by a fixed "log line dropped" line that echoes none of its input.

import { REDACTED, type RedactedValue, redactDeep, redactText } from './redact.ts';

export const LOG_LEVELS = ['error', 'warn', 'info', 'debug'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Environment variable that selects the minimum level written. */
export const LOG_LEVEL_ENV = 'TOLLWISE_LOG_LEVEL';
export const DEFAULT_LOG_LEVEL: LogLevel = 'info';

/** Longest string value written; anything longer is truncated after redaction. */
export const MAX_FIELD_LENGTH = 2048;

/** Written in place of a field that would carry a raw request or response body. */
export const BODY_REFUSED = '[refused: request/response bodies are never logged]';

/** Written instead of a line that could not be serialized as valid, redacted JSON. It never contains any input. */
export const DROPPED_LINE = '{"level":"error","msg":"log line dropped"}\n';

const SEVERITY: Readonly<Record<LogLevel, number>> = { error: 0, warn: 1, info: 2, debug: 3 };

/**
 * Field names that carry request or response content. Matching at runtime ignores case, `_` and `-`,
 * so `Body`, `request_body` and `response-body` are refused too.
 */
const BODY_FIELD_NAMES = [
  'body',
  'rawBody',
  'requestBody',
  'responseBody',
  'reqBody',
  'resBody',
  'payload',
  'messages',
  'prompt',
  'completion',
  'choices',
  'content',
] as const;

type CamelToSnake<S extends string> = S extends `${infer Head}${infer Tail}`
  ? Head extends Lowercase<Head>
    ? `${Head}${CamelToSnake<Tail>}`
    : `_${Lowercase<Head>}${CamelToSnake<Tail>}`
  : S;

/** Field names the logger refuses, in the spellings the type system can catch. */
export type BodyFieldName =
  | (typeof BODY_FIELD_NAMES)[number]
  | CamelToSnake<(typeof BODY_FIELD_NAMES)[number]>
  | Capitalize<(typeof BODY_FIELD_NAMES)[number]>;

const BODY_FIELD_SET: ReadonlySet<string> = new Set(BODY_FIELD_NAMES.map(normalizeFieldName));

function normalizeFieldName(name: string): string {
  return name.toLowerCase().replace(/[_-]/g, '');
}

/** True when a field with this name would carry a raw request or response body. */
export function isBodyFieldName(name: string): boolean {
  return BODY_FIELD_SET.has(normalizeFieldName(name));
}

/**
 * Values a log field may hold: primitives, Error, Date, arrays and plain objects of the same.
 * Buffers, streams, Request/Response and other class instances do not type-check.
 */
export type LogValue =
  | string
  | number
  | boolean
  | bigint
  | null
  | undefined
  | Error
  | Date
  | readonly LogValue[]
  | LogFields;

/** Structured fields of one log line. Body-like names are a type error at any depth. */
export type LogFields = { readonly [name: string]: LogValue } & { readonly [K in BodyFieldName]?: never };

export interface LogSink {
  write(chunk: string): unknown;
}

export interface LoggerOptions {
  /** Minimum level. When omitted, read from TOLLWISE_LOG_LEVEL in `env`, else `info`. */
  readonly level?: LogLevel;
  /** Where lines go. Default: process.stderr. */
  readonly sink?: LogSink;
  /** Environment to read TOLLWISE_LOG_LEVEL from. Default: process.env. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Clock, for tests. */
  readonly now?: () => Date;
  /** Fields added to every line of this logger. */
  readonly bindings?: LogFields;
}

export interface Logger {
  readonly level: LogLevel;
  isLevelEnabled(level: LogLevel): boolean;
  error(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  debug(msg: string, fields?: LogFields): void;
  /** A logger that adds `bindings` to every line, sharing level and sink. */
  child(bindings: LogFields): Logger;
}

/** Parses a level name (case-insensitive, surrounding spaces ignored); undefined when not a known level. */
export function parseLogLevel(value: string | undefined): LogLevel | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  return (LOG_LEVELS as readonly string[]).includes(normalized) ? (normalized as LogLevel) : undefined;
}

const RESERVED_FIELDS: ReadonlySet<string> = new Set(['time', 'level', 'msg']);

function sanitizeFields(fields: object | undefined): { [name: string]: RedactedValue } {
  if (fields === undefined || fields === null || typeof fields !== 'object' || Array.isArray(fields)) return {};
  const redacted = redactDeep(fields, {
    replaceField: (name: string) => (isBodyFieldName(name) ? BODY_REFUSED : undefined),
    maxStringLength: MAX_FIELD_LENGTH,
  });
  if (redacted === null || typeof redacted !== 'object' || Array.isArray(redacted)) {
    return { fields: typeof redacted === 'string' ? redacted : REDACTED };
  }
  return redacted;
}

interface LoggerState {
  readonly level: LogLevel;
  readonly sink: LogSink;
  readonly now: () => Date;
}

function buildLogger(state: LoggerState, bindings: { [name: string]: RedactedValue }): Logger {
  const threshold = SEVERITY[state.level];
  const enabled = (level: LogLevel): boolean => SEVERITY[level] <= threshold;

  const write = (level: LogLevel, msg: unknown, fields: object | undefined): void => {
    if (!enabled(level)) return;
    let line: string;
    try {
      const record: Record<string, RedactedValue> = {
        time: state.now().toISOString(),
        level,
        msg: redactDeep(typeof msg === 'string' ? msg : String(msg), { maxStringLength: MAX_FIELD_LENGTH }) ?? '',
      };
      for (const source of [bindings, sanitizeFields(fields)]) {
        for (const [name, value] of Object.entries(source)) {
          const key = RESERVED_FIELDS.has(name) ? `field_${name}` : name;
          Object.defineProperty(record, key, { value, enumerable: true, writable: true, configurable: true });
        }
      }
      // Defence in depth: the serialized line is redacted once more before it leaves the process.
      const serialized = JSON.stringify(record);
      const redacted = redactText(serialized);
      // The record was already redacted field by field, so this pass rarely changes anything. When it
      // does, the result must still be one JSON object: a line that no longer parses is dropped rather
      // than written half-masked or unmasked.
      if (redacted !== serialized) JSON.parse(redacted);
      line = `${redacted}\n`;
    } catch {
      // Something in the record could not be serialized (a throwing getter, for example), or the final
      // redaction pass could not keep the line valid JSON. The line is replaced by a fixed one that echoes
      // nothing from the input, so the loss is visible but safe.
      line = DROPPED_LINE;
    }
    try {
      state.sink.write(line);
    } catch {
      // Logging must never break the request path.
    }
  };

  return {
    level: state.level,
    isLevelEnabled: enabled,
    error: (msg, fields) => write('error', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    debug: (msg, fields) => write('debug', msg, fields),
    child: (childBindings) => buildLogger(state, { ...bindings, ...sanitizeFields(childBindings) }),
  };
}

/** Creates a logger. See LoggerOptions for defaults. */
export function createLogger(options: LoggerOptions = {}): Logger {
  const env = options.env ?? process.env;
  const rawLevel = env[LOG_LEVEL_ENV];
  const envLevel = parseLogLevel(rawLevel);
  const level = options.level ?? envLevel ?? DEFAULT_LOG_LEVEL;
  const logger = buildLogger(
    { level, sink: options.sink ?? process.stderr, now: options.now ?? (() => new Date()) },
    sanitizeFields(options.bindings),
  );
  if (options.level === undefined && rawLevel !== undefined && rawLevel.trim() !== '' && envLevel === undefined) {
    // The invalid value itself is not echoed: environment values may hold anything.
    logger.warn(`Ignoring invalid ${LOG_LEVEL_ENV}; using "${level}"`, { allowed: [...LOG_LEVELS] });
  }
  return logger;
}

let defaultLogger: Logger | undefined;

/** The process-wide logger (stderr, level from TOLLWISE_LOG_LEVEL), created on first use. */
export function getLogger(): Logger {
  defaultLogger ??= createLogger();
  return defaultLogger;
}
