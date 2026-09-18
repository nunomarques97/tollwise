import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { KEY_PATTERNS } from '../src/log/patterns.ts';
import { isSensitiveName, REDACTED, redactDeep, redactHeaders, redactText } from '../src/log/redact.ts';
import { FAKE_DEEPSEEK_KEY, FAKE_KEYS, type FakeKeySample } from './fixtures/fake-keys.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

function sampleFor(name: string): FakeKeySample {
  const sample = FAKE_KEYS[name];
  assert.ok(sample, `no fake sample for pattern "${name}": add one to test/fixtures/fake-keys.ts`);
  return sample;
}

const ALL_SAMPLES: readonly FakeKeySample[] = KEY_PATTERNS.map(({ name }) => sampleFor(name));

// ---------------------------------------------------------------- one source of truth

test('every shared pattern has a fake sample that the commit guard pattern itself detects', () => {
  for (const { name, pattern } of KEY_PATTERNS) {
    assert.ok(pattern.test(sampleFor(name).text), `${name}: sample must match the guard pattern`);
    assert.equal(pattern.global, false, `${name}: shared patterns stay non-global for guard-keys test()`);
  }
});

test('scripts/guard-keys.mjs takes its content patterns from src/log/patterns.ts and defines none of its own', () => {
  const guard = readFileSync(path.join(here, '..', 'scripts', 'guard-keys.mjs'), 'utf8');
  const rules = readFileSync(path.join(here, '..', 'scripts', 'key-rules.mjs'), 'utf8');
  assert.match(guard, /from '\.\/key-rules\.mjs';/);
  assert.match(rules, /import \{ KEY_PATTERNS \} from '\.\.\/src\/log\/patterns\.ts';/);
  assert.match(rules, /export const RULES = KEY_PATTERNS\.map\(/);
  for (const source of [guard, rules]) assert.doesNotMatch(source, /sk-ant-|AKIA|gsk_|PRIVATE KEY/);
});

// ---------------------------------------------------------------- redactText

test('redactText masks a fake key of every provider shape in free text', () => {
  for (const { name } of KEY_PATTERNS) {
    const sample = sampleFor(name);
    const out = redactText(`before ${sample.text} after`);
    assert.equal(out, `before ${sample.redacted} after`, name);
    assert.ok(!out.includes(sample.secretPart), `${name}: secret part leaked`);
  }
});

test('redactText masks a DeepSeek-style key through the OpenAI pattern', () => {
  assert.equal(redactText(`key=${FAKE_DEEPSEEK_KEY};`), `key=${REDACTED};`);
});

test('redactText masks several keys in one string, including repeats of the same shape', () => {
  const anthropic = sampleFor('Anthropic API key').text;
  const groq = sampleFor('Groq API key').text;
  const out = redactText(`a=${anthropic} b=${groq} c=${anthropic}`);
  assert.equal(out, `a=${REDACTED} b=${REDACTED} c=${REDACTED}`);
});

test('redactText masks a whole PEM key block, not only its header line', () => {
  const pem = sampleFor('Private key block');
  const unterminated = `-----BEGIN PRIVATE ${'KEY'}-----\n${pem.secretPart}`;
  assert.equal(redactText(`x ${pem.text} y`), `x ${REDACTED} y`);
  assert.equal(redactText(unterminated), REDACTED);
});

test('redactText leaves ordinary text alone and is stable across calls', () => {
  const plain = 'POST /v1/chat/completions model=gpt-4o-mini status=200 sk-short';
  assert.equal(redactText(plain), plain);
  const text = sampleFor('OpenAI API key').text;
  assert.equal(redactText(text), REDACTED);
  assert.equal(redactText(text), REDACTED);
});

// ---------------------------------------------------------------- redactHeaders

const LISTED_HEADERS = ['authorization', 'x-api-key', 'api-key', 'proxy-authorization', 'cookie'] as const;
const PLAIN_VALUE = 'not-key-shaped-but-still-private';

test('redactHeaders masks every listed header, whatever its case and value', () => {
  for (const name of LISTED_HEADERS) {
    for (const variant of [name, name.toUpperCase(), name.replace(/(^|-)([a-z])/g, (m) => m.toUpperCase())]) {
      assert.deepEqual(redactHeaders({ [variant]: PLAIN_VALUE }), { [name]: REDACTED }, variant);
    }
  }
});

test('redactHeaders masks any header whose name contains key, auth or secret', () => {
  const headers = {
    'x-goog-api-key': PLAIN_VALUE,
    'anthropic-api-key': PLAIN_VALUE,
    'X-Custom-Auth': PLAIN_VALUE,
    'x-authentication': PLAIN_VALUE,
    'X-Client-Secret': PLAIN_VALUE,
    'x-webhook-SECRET-value': PLAIN_VALUE,
    'set-cookie': ['a=1', 'b=2'],
  };
  assert.deepEqual(redactHeaders(headers), {
    'x-goog-api-key': REDACTED,
    'anthropic-api-key': REDACTED,
    'x-custom-auth': REDACTED,
    'x-authentication': REDACTED,
    'x-client-secret': REDACTED,
    'x-webhook-secret-value': REDACTED,
    'set-cookie': [REDACTED, REDACTED],
  });
});

test('redactHeaders keeps ordinary headers and masks key shapes inside them', () => {
  const openai = sampleFor('OpenAI API key').text;
  const input = { 'content-type': 'application/json', 'content-length': 42, 'x-note': `forwarded ${openai}` };
  const snapshot = structuredClone(input);
  assert.deepEqual(redactHeaders(input), {
    'content-type': 'application/json',
    'content-length': '42',
    'x-note': `forwarded ${REDACTED}`,
  });
  assert.deepEqual(input, snapshot, 'input must not be mutated');
});

test('redactHeaders accepts fetch Headers and [name, value] pairs', () => {
  const fetchHeaders = new Headers({ Authorization: `Bearer ${sampleFor('Bearer or Basic credential').secretPart}` });
  fetchHeaders.set('Accept', 'text/event-stream');
  assert.deepEqual(redactHeaders(fetchHeaders), { accept: 'text/event-stream', authorization: REDACTED });

  const pairs: [string, string][] = [
    ['X-Api-Key', PLAIN_VALUE],
    ['Accept', 'a'],
    ['accept', 'b'],
  ];
  assert.deepEqual(redactHeaders(pairs), { 'x-api-key': REDACTED, accept: ['a', 'b'] });
});

test('redactHeaders skips undefined values', () => {
  assert.deepEqual(redactHeaders({ authorization: undefined, accept: '*/*' }), { accept: '*/*' });
});

// ---------------------------------------------------------------- redactDeep

test('redactDeep masks fake keys of every provider shape in nested objects and arrays', () => {
  const nested = {
    level1: {
      list: ALL_SAMPLES.map((sample) => ({ note: `value: ${sample.text}` })),
      deeper: { deepest: [[ALL_SAMPLES.map((sample) => sample.text).join(' | ')]] },
    },
  };
  const out = JSON.stringify(redactDeep(nested));
  for (const sample of ALL_SAMPLES) assert.ok(!out.includes(sample.secretPart), `leaked: ${sample.redacted}`);
  const list = (redactDeep(nested) as { level1: { list: { note: string }[] } }).level1.list;
  assert.deepEqual(
    list.map((item) => item.note),
    ALL_SAMPLES.map((sample) => `value: ${sample.redacted}`),
  );
});

test('redactDeep masks every string under a sensitive field name and keeps numbers', () => {
  const input = {
    apiKey: PLAIN_VALUE,
    auth: { user: 'alice', pass: PLAIN_VALUE, retries: 2 },
    credentials: [PLAIN_VALUE, 7],
    tokens: { input: 12, output: 34 },
    max_tokens: 256,
    provider: 'openai',
  };
  assert.deepEqual(redactDeep(input), {
    apiKey: REDACTED,
    auth: { user: REDACTED, pass: REDACTED, retries: 2 },
    credentials: [REDACTED, 7],
    tokens: { input: 12, output: 34 },
    max_tokens: 256,
    provider: 'openai',
  });
});

test('redactDeep serializes errors with redacted message, stack and cause', () => {
  const key = sampleFor('Anthropic API key');
  const error = new Error(`upstream rejected ${key.text}`, { cause: new Error(`cause ${key.text}`) });
  const out = redactDeep({ err: error }) as { err: { name: string; message: string; cause: { message: string } } };
  assert.equal(out.err.name, 'Error');
  assert.equal(out.err.message, `upstream rejected ${REDACTED}`);
  assert.equal(out.err.cause.message, `cause ${REDACTED}`);
  assert.ok(!JSON.stringify(out).includes(key.secretPart));
});

test('redactDeep never decodes binary data or walks class instances', () => {
  const key = sampleFor('Groq API key').text;
  class Carrier {
    readonly hidden = key;
  }
  const out = redactDeep({
    buffer: Buffer.from(key),
    bytes: new TextEncoder().encode(key),
    carrier: new Carrier(),
    map: new Map([['k', key]]),
    when: new Date('2026-01-02T03:04:05.000Z'),
    big: 10n,
  });
  assert.deepEqual(out, {
    buffer: `[binary: ${key.length} bytes]`,
    bytes: `[binary: ${key.length} bytes]`,
    carrier: '[Carrier]',
    map: '[Map]',
    when: '2026-01-02T03:04:05.000Z',
    big: '10',
  });
});

test('redactDeep handles cycles, depth limits and a __proto__ field without mutating the input', () => {
  const cyclic: Record<string, unknown> = { name: 'root' };
  cyclic.self = cyclic;
  assert.deepEqual(redactDeep(cyclic), { name: 'root', self: '[Circular]' });

  assert.deepEqual(redactDeep({ a: { b: { c: 1 } } }, { maxDepth: 2 }), { a: { b: '[MaxDepth]' } });

  const tricky = JSON.parse('{"__proto__": {"polluted": true}}') as object;
  const out = redactDeep(tricky) as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
  assert.deepEqual(Object.keys(out), ['__proto__']);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test('isSensitiveName matches key, auth and secret case-insensitively', () => {
  for (const name of ['x-api-key', 'Authorization', 'CLIENT_SECRET', 'monkey', 'author']) {
    assert.equal(isSensitiveName(name), true, name);
  }
  for (const name of ['content-type', 'model', 'status', 'latency_ms'])
    assert.equal(isSensitiveName(name), false, name);
});
