import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  BODY_REFUSED,
  createLogger,
  isBodyFieldName,
  type Logger,
  type LoggerOptions,
  MAX_FIELD_LENGTH,
  parseLogLevel,
} from '../src/log/logger.ts';
import { KEY_PATTERNS } from '../src/log/patterns.ts';
import { REDACTED, redactHeaders } from '../src/log/redact.ts';
import { FAKE_DEEPSEEK_KEY, FAKE_KEYS, type FakeKeySample } from './fixtures/fake-keys.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXED_TIME = new Date('2026-09-18T12:00:00.000Z');

const ALL_SAMPLES: readonly FakeKeySample[] = KEY_PATTERNS.map(({ name }) => {
  const sample = FAKE_KEYS[name];
  assert.ok(sample, `no fake sample for pattern "${name}"`);
  return sample;
});

interface Capture {
  readonly logger: Logger;
  readonly raw: () => string;
  readonly lines: () => Record<string, unknown>[];
}

function capture(options: Omit<LoggerOptions, 'sink' | 'now'> = {}): Capture {
  const chunks: string[] = [];
  const logger = createLogger({
    env: {},
    ...options,
    sink: { write: (chunk) => chunks.push(chunk) },
    now: () => FIXED_TIME,
  });
  const raw = (): string => chunks.join('');
  return {
    logger,
    raw,
    lines: () =>
      raw()
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

function assertNoSecrets(output: string): void {
  for (const sample of ALL_SAMPLES) {
    assert.ok(!output.includes(sample.secretPart), `log output leaked a fake key (${sample.redacted})`);
  }
  assert.ok(!output.includes(FAKE_DEEPSEEK_KEY), 'log output leaked the DeepSeek-style fake key');
}

// ---------------------------------------------------------------- format

test('writes one JSON object per line with time, level, msg and fields', () => {
  const { logger, raw, lines } = capture();
  logger.info('request routed', { provider: 'openai', status: 200, cached: false });
  logger.error('upstream failed', { attempt: 2 });

  assert.equal(raw().split('\n').length, 3, 'two lines, each ending with a newline');
  assert.deepEqual(lines(), [
    {
      time: '2026-09-18T12:00:00.000Z',
      level: 'info',
      msg: 'request routed',
      provider: 'openai',
      status: 200,
      cached: false,
    },
    { time: '2026-09-18T12:00:00.000Z', level: 'error', msg: 'upstream failed', attempt: 2 },
  ]);
});

test('a multi-line message still produces exactly one line', () => {
  const { logger, raw } = capture();
  logger.info('first\nsecond\r\nthird');
  assert.equal(raw().split('\n').length, 2);
});

test('fields cannot overwrite time, level or msg', () => {
  const { logger, lines } = capture();
  logger.info('real', { time: 'fake', level: 'debug', msg: 'spoofed' });
  assert.deepEqual(lines(), [
    {
      time: '2026-09-18T12:00:00.000Z',
      level: 'info',
      msg: 'real',
      field_time: 'fake',
      field_level: 'debug',
      field_msg: 'spoofed',
    },
  ]);
});

test('child loggers add their bindings to every line', () => {
  const { logger, lines } = capture();
  const child = logger.child({ requestId: 'req-1' });
  child.info('one', { step: 1 });
  child.child({ provider: 'anthropic' }).warn('two');
  assert.deepEqual(lines(), [
    { time: '2026-09-18T12:00:00.000Z', level: 'info', msg: 'one', requestId: 'req-1', step: 1 },
    { time: '2026-09-18T12:00:00.000Z', level: 'warn', msg: 'two', requestId: 'req-1', provider: 'anthropic' },
  ]);
});

// ---------------------------------------------------------------- levels

function emitAll(logger: Logger): void {
  logger.error('e');
  logger.warn('w');
  logger.info('i');
  logger.debug('d');
}

test('default level is info: debug lines are dropped', () => {
  const { logger, lines } = capture();
  emitAll(logger);
  assert.equal(logger.level, 'info');
  assert.deepEqual(
    lines().map((line) => line.msg),
    ['e', 'w', 'i'],
  );
});

test('TOLLWISE_LOG_LEVEL selects the minimum level', () => {
  const expected: Record<string, string[]> = {
    error: ['e'],
    warn: ['e', 'w'],
    info: ['e', 'w', 'i'],
    debug: ['e', 'w', 'i', 'd'],
    ' DEBUG ': ['e', 'w', 'i', 'd'],
  };
  for (const [value, messages] of Object.entries(expected)) {
    const { logger, lines } = capture({ env: { TOLLWISE_LOG_LEVEL: value } });
    emitAll(logger);
    assert.deepEqual(
      lines().map((line) => line.msg),
      messages,
      `TOLLWISE_LOG_LEVEL=${value}`,
    );
  }
});

test('an explicit level option wins over the environment', () => {
  const { logger } = capture({ level: 'error', env: { TOLLWISE_LOG_LEVEL: 'debug' } });
  assert.equal(logger.level, 'error');
  assert.equal(logger.isLevelEnabled('warn'), false);
  assert.equal(logger.isLevelEnabled('error'), true);
});

test('an invalid TOLLWISE_LOG_LEVEL falls back to info with one warning that does not echo the value', () => {
  const bogus = `verbose ${FAKE_KEYS['Anthropic API key']?.text ?? ''}`;
  const { logger, raw, lines } = capture({ env: { TOLLWISE_LOG_LEVEL: bogus } });
  assert.equal(logger.level, 'info');
  assert.deepEqual(lines(), [
    {
      time: '2026-09-18T12:00:00.000Z',
      level: 'warn',
      msg: 'Ignoring invalid TOLLWISE_LOG_LEVEL; using "info"',
      allowed: ['error', 'warn', 'info', 'debug'],
    },
  ]);
  assert.ok(!raw().includes('verbose'));
});

test('parseLogLevel accepts only the four levels', () => {
  assert.equal(parseLogLevel('WARN'), 'warn');
  assert.equal(parseLogLevel('trace'), undefined);
  assert.equal(parseLogLevel(''), undefined);
  assert.equal(parseLogLevel(undefined), undefined);
});

test('writes to stderr by default and nothing to stdout', () => {
  const script = [
    `import { createLogger } from ${JSON.stringify(pathToFileURL(path.join(here, '..', 'src', 'log', 'logger.ts')).href)};`,
    'const log = createLogger();',
    "log.debug('hidden');",
    "log.warn('visible', { n: 1 });",
  ].join('\n');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, TOLLWISE_LOG_LEVEL: 'warn' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  const lines = result.stderr.split('\n').filter((line) => line.startsWith('{'));
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
  assert.equal(record.level, 'warn');
  assert.equal(record.msg, 'visible');
  assert.equal(record.n, 1);
});

// ---------------------------------------------------------------- redaction

test('log output never contains a fake key, wherever it is passed', () => {
  const { logger, raw, lines } = capture({ level: 'debug' });
  const everyKey = ALL_SAMPLES.map((sample) => sample.text).join(' ');
  const first = ALL_SAMPLES[0]?.text ?? '';

  logger.error(`message with ${everyKey} ${FAKE_DEEPSEEK_KEY}`);
  logger.warn('nested fields', {
    note: everyKey,
    route: { provider: 'openrouter', upstream: { detail: [everyKey, { deep: FAKE_DEEPSEEK_KEY }] } },
  });
  logger.info('headers', {
    headers: {
      authorization: `Bearer ${first}`,
      'x-api-key': first,
      'api-key': first,
      'proxy-authorization': first,
      cookie: `session=${first}`,
    },
  });
  logger.info('pre-redacted headers', { headers: redactHeaders(new Headers({ 'x-api-key': first })) });
  logger.debug('error', { err: new Error(`provider said: invalid key ${everyKey}`) });
  logger.info('sensitive names', { apiKey: first, clientSecret: first, [`k_${first}`]: 'value in a key-shaped name' });
  logger.child({ upstreamKey: first, tag: everyKey }).info('child bindings');

  const output = raw();
  assertNoSecrets(output);
  assert.equal(lines().length, 7, 'every line is valid JSON');
  assert.ok(output.includes(REDACTED));
});

test('sensitive header fields are masked by name even when the value is not key-shaped', () => {
  const { logger, lines } = capture();
  logger.info('inbound', {
    headers: {
      authorization: 'Basic dXNlcjpwYXNz',
      'x-api-key': 'short',
      'api-key': 'short',
      'proxy-authorization': 'short',
      cookie: 'a=b',
      accept: 'application/json',
    },
  });
  assert.deepEqual(lines()[0]?.headers, {
    authorization: REDACTED,
    'x-api-key': REDACTED,
    'api-key': REDACTED,
    'proxy-authorization': REDACTED,
    cookie: REDACTED,
    accept: 'application/json',
  });
});

// ---------------------------------------------------------------- no raw bodies

test('body-like fields are rejected by the types and refused at runtime, at any depth', () => {
  const { logger, raw, lines } = capture();
  const secretPrompt = 'user prompt that must never reach a log';

  // @ts-expect-error raw bodies are not loggable fields
  logger.info('top level', { body: secretPrompt });
  // @ts-expect-error raw bodies are not loggable fields
  logger.info('snake case', { request_body: secretPrompt });
  // @ts-expect-error raw bodies are not loggable fields
  logger.info('nested', { upstream: { messages: [{ role: 'user', content: secretPrompt }] } });
  logger.info('other spellings', { 'Response-Body': secretPrompt, RAWBODY: secretPrompt });

  assert.ok(!raw().includes(secretPrompt));
  assert.deepEqual(
    lines().map(({ time: _time, level: _level, msg: _msg, ...fields }) => fields),
    [
      { body: BODY_REFUSED },
      { request_body: BODY_REFUSED },
      { upstream: { messages: BODY_REFUSED } },
      { 'Response-Body': BODY_REFUSED, RAWBODY: BODY_REFUSED },
    ],
  );
});

test('buffers, streams and Request/Response objects are rejected by the types and never serialized', async () => {
  const { logger, raw, lines } = capture();
  const secretPrompt = 'raw payload bytes that must never reach a log';
  const { Readable } = await import('node:stream');

  // @ts-expect-error Buffer is not a loggable value
  logger.info('buffer', { data: Buffer.from(secretPrompt) });
  // @ts-expect-error streams are not loggable values
  logger.info('stream', { data: Readable.from([secretPrompt]) });
  // @ts-expect-error Request is not a loggable value
  logger.info('request', { data: new Request('http://127.0.0.1/', { method: 'POST', body: secretPrompt }) });
  // @ts-expect-error Response is not a loggable value
  logger.info('response', { data: new Response(secretPrompt) });

  assert.ok(!raw().includes(secretPrompt));
  assert.deepEqual(
    lines().map((line) => line.data),
    [`[binary: ${Buffer.byteLength(secretPrompt)} bytes]`, '[Readable]', '[Request]', '[Response]'],
  );
});

test('isBodyFieldName ignores case, underscores and dashes', () => {
  for (const name of ['body', 'Body', 'raw_body', 'requestBody', 'response-body', 'MESSAGES', 'prompt', 'content']) {
    assert.equal(isBodyFieldName(name), true, name);
  }
  for (const name of ['bodyBytes', 'status', 'model', 'contentType']) assert.equal(isBodyFieldName(name), false, name);
});

test('long strings are truncated after redaction', () => {
  const { logger, lines } = capture();
  logger.info('x'.repeat(MAX_FIELD_LENGTH + 500), { detail: 'y'.repeat(MAX_FIELD_LENGTH + 10) });
  const [line] = lines();
  assert.equal(line?.msg, `${'x'.repeat(MAX_FIELD_LENGTH)}...[truncated 500 chars]`);
  assert.equal(line?.detail, `${'y'.repeat(MAX_FIELD_LENGTH)}...[truncated 10 chars]`);
});

test('a failing sink never throws into the caller', () => {
  const logger = createLogger({
    env: {},
    sink: {
      write: () => {
        throw new Error('disk full');
      },
    },
  });
  assert.doesNotThrow(() => logger.error('still fine'));
});
