import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { createLogger, DROPPED_LINE, type Logger, type LogValue } from '../src/log/logger.ts';
import { KEY_PATTERNS } from '../src/log/patterns.ts';
import * as redactModule from '../src/log/redact.ts';
import {
  clearSecretValues,
  MIN_SECRET_VALUE_LENGTH,
  REDACTED,
  redactDeep,
  redactText,
  registerSecretValues,
} from '../src/log/redact.ts';
import { ADVERSARIAL_INPUTS, MIN_ADVERSARIAL_LENGTH } from './fixtures/adversarial-inputs.ts';

// Opaque, prefix-less fake credentials built at runtime; none of them is real.
const OPAQUE = 'Zq8LmR3v'.repeat(4);
const OPAQUE_LETTERS_AND_DIGITS = 'k7Tn'.repeat(6);

function patternNamed(name: string): (typeof KEY_PATTERNS)[number] {
  const found = KEY_PATTERNS.find((entry) => entry.name === name);
  assert.ok(found, `no pattern named "${name}"`);
  return found;
}

interface Capture {
  readonly logger: Logger;
  readonly raw: () => string;
  readonly lines: () => Record<string, unknown>[];
}

function capture(): Capture {
  const chunks: string[] = [];
  const logger = createLogger({
    env: {},
    level: 'debug',
    sink: { write: (chunk) => chunks.push(chunk) },
    now: () => new Date('2026-09-18T12:00:00.000Z'),
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

/**
 * Checks one free-text case three ways: redactText() directly, a nested (non-sensitive) log field, and an
 * Error message logged as a field. `expected` is what redactText() must return for `text`.
 */
function assertMaskedEverywhere(text: string, expected: string, secret: string): void {
  assert.equal(redactText(text), expected, `free text: ${expected}`);
  assert.equal(redactText(expected), expected, `redacting twice changes nothing: ${expected}`);

  const { logger, raw, lines } = capture();
  logger.info('nested', { upstream: { attempts: [{ detail: text }] } });
  logger.error('failed', { err: new Error(`provider call failed: ${text}`) });
  logger.info(text);
  const output = raw();
  assert.ok(!output.includes(secret), `log output leaked the secret of: ${expected}`);
  const [nested, failed, message] = lines();
  assert.deepEqual(nested?.upstream, { attempts: [{ detail: expected }] });
  assert.equal((failed?.err as { message?: string } | undefined)?.message, `provider call failed: ${expected}`);
  assert.equal(message?.msg, expected);

  const deep = redactDeep({ outer: { cause: new Error(text) } }) as { outer: { cause: { message: string } } };
  assert.equal(deep.outer.cause.message, expected);
}

// ---------------------------------------------------------------- (a) Bearer and Basic

describe('Bearer and Basic credentials, in any letter case', () => {
  for (const scheme of ['Bearer', 'bearer', 'BEARER', 'bEaReR', 'Basic', 'basic', 'BASIC']) {
    test(`${scheme} <credential> is masked and the scheme is kept`, () => {
      assertMaskedEverywhere(
        `retrying with ${scheme} ${OPAQUE} after 401`,
        `retrying with ${scheme} ${REDACTED} after 401`,
        OPAQUE,
      );
    });
  }

  test('a base64 Basic credential with padding is masked whole', () => {
    const basic = Buffer.from(`alice:${OPAQUE_LETTERS_AND_DIGITS}x`).toString('base64');
    assert.match(basic, /=$/);
    assertMaskedEverywhere(`sent basic ${basic}`, `sent basic ${REDACTED}`, basic.replace(/=+$/, ''));
  });
});

// ---------------------------------------------------------------- (b) unquoted key=value

describe('unquoted credential parameters in query strings and form bodies', () => {
  const names = [
    'api_key',
    'api-key',
    'apikey',
    'API_KEY',
    'ApiKey',
    'key',
    'KEY',
    'access_token',
    'Access_Token',
    'token',
    'secret',
    'Secret',
    'password',
    'PASSWORD',
    'auth',
  ];
  for (const name of names) {
    test(`${name}=<value> in a query string masks only the value`, () => {
      assertMaskedEverywhere(
        `GET https://api.example.com/v1/models?${name}=${OPAQUE}&limit=5 -> 401`,
        `GET https://api.example.com/v1/models?${name}=${REDACTED}&limit=5 -> 401`,
        OPAQUE,
      );
    });
  }

  test('a form body keeps every other field', () => {
    assertMaskedEverywhere(
      `grant_type=client_credentials&password=${OPAQUE}&scope=models.read`,
      `grant_type=client_credentials&password=${REDACTED}&scope=models.read`,
      OPAQUE,
    );
  });

  test('a percent-encoded value is masked whole', () => {
    const encoded = encodeURIComponent(`${OPAQUE}/+=`);
    assertMaskedEverywhere(`?key=${encoded}#top`, `?key=${REDACTED}#top`, OPAQUE);
  });

  for (const name of ['client_secret', 'refresh_token', 'OPENAI_API_KEY', 'x-api-key', 'id_token', 'authorization']) {
    test(`a prefixed name ${name}=<value> is masked too`, () => {
      assertMaskedEverywhere(`env ${name}=${OPAQUE} next=1`, `env ${name}=${REDACTED} next=1`, OPAQUE);
      assertMaskedEverywhere(`?a=1&${name}=${OPAQUE}&b=2`, `?a=1&${name}=${REDACTED}&b=2`, OPAQUE);
    });
  }

  test('a value with RFC 3986 sub-delims is masked whole', () => {
    for (const c of ["'", '(', ')', ',', ';', '!', '$', '*', '+', '=']) {
      const value = `${OPAQUE.slice(0, 6)}${c}${OPAQUE.slice(6)}`;
      assertMaskedEverywhere(`?password=${value}&x=1`, `?password=${REDACTED}&x=1`, OPAQUE.slice(6));
    }
  });

  test('names that only contain a credential word are left alone', () => {
    const plain = 'max_tokens=256 monkey=banana keys=3 OPENAI_API_KEY_ENV=OPENAI_API_KEY';
    assert.equal(redactText(plain), plain);
  });
});

// ---------------------------------------------------------------- (c) header lines

describe('credential header lines in free text', () => {
  const cases: readonly (readonly [string, string, string])[] = [
    [`x-api-key: ${OPAQUE}`, `x-api-key: ${REDACTED}`, OPAQUE],
    [`X-Api-Key:${OPAQUE}`, `X-Api-Key:${REDACTED}`, OPAQUE],
    [`api-key   :  ${OPAQUE}`, `api-key   :  ${REDACTED}`, OPAQUE],
    [`Authorization: Bearer ${OPAQUE}`, `Authorization: ${REDACTED}`, OPAQUE],
    [`authorization: Basic ${OPAQUE_LETTERS_AND_DIGITS}`, `authorization: ${REDACTED}`, OPAQUE_LETTERS_AND_DIGITS],
    ['Proxy-Authorization: Basic dXNlcjpwYXNz', `Proxy-Authorization: ${REDACTED}`, 'dXNlcjpwYXNz'],
    ['x-api-key: short', `x-api-key: ${REDACTED}`, 'short'],
  ];
  for (const [text, expected, secret] of cases) {
    test(`${expected} (the whole header value is masked, whatever its length)`, () => {
      assertMaskedEverywhere(
        `> POST /v1/messages HTTP/1.1\r\n> ${text}\r\n> accept: */*`,
        `> POST /v1/messages HTTP/1.1\r\n> ${expected}\r\n> accept: */*`,
        secret,
      );
    });
  }

  test('a header value with spaces is masked up to the end of the line', () => {
    assert.equal(
      redactText(`PROXY-AUTHORIZATION: Negotiate ${OPAQUE} extra\nnext line`),
      `PROXY-AUTHORIZATION: ${REDACTED}\nnext line`,
    );
  });

  test('quoted and JSON-escaped header names are masked, JSON literals are never rewritten', () => {
    assert.equal(redactText(`{"x-api-key": "${OPAQUE}"}`), `{"x-api-key": "${REDACTED}"}`);
    assert.equal(redactText(`{\\"authorization\\":\\"Bearer ${OPAQUE}\\"}`), `{\\"authorization\\":\\"${REDACTED}\\"}`);
    for (const literal of [
      '{"api-key":null}',
      '{"x-api-key":42}',
      '{"authorization":true}',
      '{"api-key":["[REDACTED]"]}',
    ]) {
      assert.equal(redactText(literal), literal);
    }
  });

  test('a quoted value after the scheme is masked inside its quotes', () => {
    assertMaskedEverywhere(`authorization: Bearer "${OPAQUE}"`, `authorization: Bearer "${REDACTED}"`, OPAQUE);
    assertMaskedEverywhere(`Authorization: basic '${OPAQUE}'`, `Authorization: basic '${REDACTED}'`, OPAQUE);
    assertMaskedEverywhere(`retry with Bearer "${OPAQUE}"`, `retry with Bearer "${REDACTED}"`, OPAQUE);
    assertMaskedEverywhere(`retry with 'Bearer "${OPAQUE}"'`, `retry with 'Bearer "${REDACTED}"'`, OPAQUE);
    // The same text escaped once and twice inside JSON strings.
    const once = JSON.stringify(`authorization: Bearer "${OPAQUE}"`);
    assertMaskedEverywhere(once, once.replace(OPAQUE, REDACTED), OPAQUE);
    const twice = JSON.stringify(once);
    assertMaskedEverywhere(twice, twice.replace(OPAQUE, REDACTED), OPAQUE);
    const bearerOnly = JSON.stringify(JSON.stringify(`Bearer "${OPAQUE}"`));
    assertMaskedEverywhere(bearerOnly, bearerOnly.replace(OPAQUE, REDACTED), OPAQUE);
  });

  test('a header name followed by a spaced = is masked like a colon', () => {
    assertMaskedEverywhere(`authorization = ${OPAQUE}`, `authorization = ${REDACTED}`, OPAQUE);
    assertMaskedEverywhere(`X-API-KEY =${OPAQUE}\nnext`, `X-API-KEY =${REDACTED}\nnext`, OPAQUE);
  });

  test('a header line logged in a message keeps the line valid JSON', () => {
    const { logger, raw, lines } = capture();
    logger.warn(`upstream said: x-api-key: ${OPAQUE}, retrying`, { note: `authorization: Bearer ${OPAQUE}` });
    assert.ok(!raw().includes(OPAQUE));
    assert.equal(lines()[0]?.msg, `upstream said: x-api-key: ${REDACTED}, retrying`);
    assert.equal(lines()[0]?.note, `authorization: ${REDACTED}`);
  });
});

// ---------------------------------------------------------------- (d) URL userinfo

describe('URL userinfo', () => {
  const cases: readonly (readonly [string, string])[] = [
    [`https://user:${OPAQUE}@api.example.com/v1`, `https://${REDACTED}@api.example.com/v1`],
    [`postgres://admin:${OPAQUE}@db.internal:5432/app`, `postgres://${REDACTED}@db.internal:5432/app`],
    [`http://${OPAQUE}@proxy.local:8080`, `http://${REDACTED}@proxy.local:8080`],
    [`HTTPS://me:p%40ss${OPAQUE}@host`, `HTTPS://${REDACTED}@host`],
  ];
  for (const [text, expected] of cases) {
    test(`${expected}`, () => {
      assertMaskedEverywhere(`fetch ${text} failed`, `fetch ${expected} failed`, OPAQUE);
    });
  }

  // RFC 3986 sub-delims are legal unencoded in userinfo, and URL.href keeps most of them as they are. An
  // unencoded `@` in free text must not leave the rest of the password in clear either.
  const USERINFO_CHARACTERS = ['(', ')', ',', "'", ';', '!', '$', '&', '*', '+', '=', ':', '~', '%21', '@'];
  for (const c of USERINFO_CHARACTERS) {
    test(`a password containing ${c} is masked whole in free text, URL.href and a logged field`, () => {
      const head = OPAQUE.slice(0, 6);
      const tail = OPAQUE.slice(6);
      const url = `https://user:${head}${c}${tail}@proxy.local/v1`;
      const expected = `https://${REDACTED}@proxy.local/v1`;

      assertMaskedEverywhere(`fetch ${url} failed`, `fetch ${expected} failed`, tail);

      const href = new URL(url).href;
      assert.ok(href.includes(tail), `URL.href keeps the password: ${href}`);
      assert.equal(redactText(href), expected);

      const { logger, raw, lines } = capture();
      logger.info('upstream', { url: href, raw: url, nested: { target: [href] } });
      logger.info(`proxying through ${href}`);
      assert.ok(!raw().includes(tail), `log output leaked: ${raw()}`);
      assert.ok(!raw().includes(`${head}${c}`), `log output leaked the start: ${raw()}`);
      const [fields, message] = lines();
      assert.equal(fields?.url, expected);
      assert.equal(fields?.raw, expected);
      assert.deepEqual(fields?.nested, { target: [expected] });
      assert.equal(message?.msg, `proxying through ${expected}`);
    });
  }

  test('the commit guard also catches a password with sub-delims', () => {
    const { pattern } = patternNamed('URL userinfo');
    for (const c of ['(', ')', ',', "'", ';']) {
      assert.ok(pattern.test(`https://user:${OPAQUE.slice(0, 6)}${c}${OPAQUE.slice(6)}@host`), c);
    }
  });

  test('URLs without userinfo are unchanged', () => {
    const plain = 'https://api.example.com/v1/models?limit=5 and git@github.com:org/repo.git and a@b.c';
    assert.equal(redactText(plain), plain);
  });
});

// ---------------------------------------------------------------- double-encoded JSON

describe('secret assignments in JSON encoded twice', () => {
  test('an escaped apiKey inside a JSON string is masked', () => {
    const once = JSON.stringify({ apiKey: OPAQUE, model: 'gpt-4o-mini' });
    const twice = JSON.stringify(once);
    assert.ok(twice.includes('\\"apiKey\\":\\"'), 'the fixture really is double-encoded');
    assert.equal(redactText(twice), twice.replace(OPAQUE, REDACTED));
    assert.equal(redactText(JSON.stringify(twice)).includes(OPAQUE), false, 'three levels of encoding too');
  });

  test('prefixed names and values shorter than the guard minimum are masked', () => {
    const short = OPAQUE.slice(0, 12);
    for (const name of ['client_secret', 'refresh_token', 'OPENAI_API_KEY', 'apiKey']) {
      const once = JSON.stringify({ [name]: short, model: 'gpt-4o-mini' });
      assertMaskedEverywhere(once, once.replace(short, REDACTED), short);
      const twice = JSON.stringify(once);
      assertMaskedEverywhere(twice, twice.replace(short, REDACTED), short);
    }
  });

  test('a double-encoded body in a nested field and in an Error message is masked', () => {
    const twice = JSON.stringify(JSON.stringify({ error: { password: OPAQUE } }));
    assertMaskedEverywhere(twice, twice.replace(OPAQUE, REDACTED), OPAQUE);
  });
});

// ---------------------------------------------------------------- (e) registered values

describe('credential values registered at runtime', () => {
  // Shaped like no known provider key and never next to a credential name: only the registry can catch it.
  // Built at runtime, like every value in fixtures/fake-keys.ts, so no source line holds it verbatim.
  const PREFIXLESS = ['Tm4Q', 'x9Wv', '2Lp7', 'Rk3Z', 's8Yb', '5Nd'].join('');

  afterEach(() => clearSecretValues());

  test('without registration the prefix-less value is not recognised (the registry does the work)', () => {
    const text = `https://api.example.com/v1/chat?session=${PREFIXLESS}`;
    assert.equal(redactText(text), text);
  });

  test('a registered value is masked in a URL, a header line and an error body', () => {
    registerSecretValues([PREFIXLESS]);
    assertMaskedEverywhere(
      `https://api.example.com/v1/chat?session=${PREFIXLESS}&stream=true`,
      `https://api.example.com/v1/chat?session=${REDACTED}&stream=true`,
      PREFIXLESS,
    );
    assertMaskedEverywhere(`X-Upstream-Credential: ${PREFIXLESS}`, `X-Upstream-Credential: ${REDACTED}`, PREFIXLESS);
    const body = JSON.stringify({ error: { message: `Invalid credential '${PREFIXLESS}' for this model` } });
    assertMaskedEverywhere(`401 ${body}`, `401 ${body.replace(PREFIXLESS, REDACTED)}`, PREFIXLESS);
  });

  test('a registered value is masked in its URL-encoded and JSON-escaped forms', () => {
    const withSymbols = `${PREFIXLESS}/+"q`;
    registerSecretValues([withSymbols]);
    assert.equal(redactText(`?x=${encodeURIComponent(withSymbols)}&y=1`), `?x=${REDACTED}&y=1`);
    assert.equal(redactText(JSON.stringify({ v: withSymbols })), `{"v":"${REDACTED}"}`);
  });

  test('the longest registered value wins when one contains another', () => {
    registerSecretValues([PREFIXLESS.slice(0, 10), PREFIXLESS]);
    assert.equal(redactText(`a ${PREFIXLESS} b ${PREFIXLESS.slice(0, 10)} c`), `a ${REDACTED} b ${REDACTED} c`);
  });

  test(`values shorter than ${MIN_SECRET_VALUE_LENGTH} characters and empty values are ignored`, () => {
    registerSecretValues(['', 'model', 'gpt-4o', 'openai1']);
    const plain = 'model gpt-4o routed to openai1';
    assert.equal(redactText(plain), plain);
    registerSecretValues(['12345678']);
    assert.equal(redactText('id 12345678'), `id ${REDACTED}`);
  });

  test('clearSecretValues forgets every value', () => {
    registerSecretValues([PREFIXLESS]);
    clearSecretValues();
    assert.equal(redactText(PREFIXLESS), PREFIXLESS);
  });

  test('the registry is never exported or serialized', () => {
    registerSecretValues([PREFIXLESS]);
    for (const [name, value] of Object.entries(redactModule)) {
      if (typeof value === 'function') {
        assert.ok(!String(value).includes(PREFIXLESS), `${name} source`);
        continue;
      }
      assert.ok(!JSON.stringify(value ?? null).includes(PREFIXLESS), `export ${name}`);
    }
    const { logger, raw } = capture();
    logger.info('config loaded', { providers: ['openai'], registered: 1 });
    logger.info(`key ${PREFIXLESS}`);
    assert.ok(!raw().includes(PREFIXLESS));
  });
});

// ---------------------------------------------------------------- (f) dropped log lines

describe('a record that cannot be serialized', () => {
  test('a throwing getter produces exactly the fixed dropped line and echoes no input', () => {
    const chunks: string[] = [];
    const logger = createLogger({ env: {}, sink: { write: (chunk) => chunks.push(chunk) } });
    const hostile = {
      get detail(): LogValue {
        throw new Error(`getter failed with ${OPAQUE}`);
      },
    };
    logger.error(`message mentioning ${OPAQUE}`, { visible: 'field value', nested: hostile as unknown as LogValue });
    assert.deepEqual(chunks, [DROPPED_LINE]);
    assert.equal(DROPPED_LINE, '{"level":"error","msg":"log line dropped"}\n');

    logger.info('next line', { n: 1 });
    assert.equal(chunks.length, 2);
    assert.equal((JSON.parse(chunks[1] ?? '{}') as { msg?: string }).msg, 'next line');
  });

  test('a sink that throws on the dropped line still never throws into the caller', () => {
    const logger = createLogger({
      env: {},
      sink: {
        write: () => {
          throw new Error('disk full');
        },
      },
    });
    const hostile = {
      get detail(): LogValue {
        throw new Error('getter failed');
      },
    };
    assert.doesNotThrow(() => logger.error('x', { nested: hostile as unknown as LogValue }));
  });
});

// ---------------------------------------------------------------- JSON-lines contract

describe('every log line stays valid JSON whatever the redaction masks', () => {
  const BACKSLASH = String.fromCharCode(92);

  afterEach(() => clearSecretValues());

  /** Logs each text as a message, a field value and a field name; every line must parse, none may leak. */
  function assertValidLines(texts: readonly string[], secret?: string): Record<string, unknown>[] {
    const { logger, raw } = capture();
    for (const text of texts) {
      logger.info(text);
      logger.info('field value', { detail: text });
      logger.info('field name', { [text]: 'v' });
    }
    const written = raw().split('\n').slice(0, -1);
    assert.equal(written.length, texts.length * 3);
    for (const line of written) {
      assert.doesNotThrow(() => JSON.parse(line), `not valid JSON: ${line}`);
      if (secret !== undefined) assert.ok(!line.includes(secret), `leaked in: ${line}`);
    }
    return written.map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  test('a control character right after a header colon never leaves a dangling backslash', () => {
    const lines = assertValidLines([
      'authorization:\nfoo',
      'authorization:\nfoo bar',
      'x-api-key: \tabc',
      'Authorization: \nabc',
      'api-key:\r\nnext',
      `proxy-authorization:\tBearer ${OPAQUE}`,
      `x-api-key:\t${OPAQUE}`,
    ]);
    assert.equal(lines[0]?.msg, 'authorization:\nfoo', 'a value on the next line is not a header value');
    assert.equal(lines[6]?.msg, 'x-api-key: \tabc'.replace('abc', REDACTED));
    assert.equal(lines[15]?.msg, `proxy-authorization:\t${REDACTED}`);
    assert.equal(lines[18]?.msg, `x-api-key:\t${REDACTED}`);
  });

  test('a backslash or a quote next to a header colon never breaks an object key', () => {
    assertValidLines([
      `x-api-key:${BACKSLASH}`,
      `x-api-key: ${BACKSLASH}`,
      `authorization:${BACKSLASH}`,
      'authorization": ',
      `authorization${BACKSLASH}": `,
      `api-key:${BACKSLASH}${BACKSLASH}"`,
    ]);
  });

  test('Bearer and Basic, query parameters and URL userinfo next to escapes stay valid JSON', () => {
    assertValidLines([
      `Bearer\t${OPAQUE}`,
      `bearer \n${OPAQUE}`,
      `BASIC ${OPAQUE}\n`,
      `\tBearer ${OPAQUE}\r\n`,
      `?api_key=${OPAQUE}\n&x=1`,
      `\token=${OPAQUE}`,
      `password=${BACKSLASH}n${OPAQUE}`,
      `key=\t${OPAQUE}`,
      `https://user:${OPAQUE}@host\n`,
      `https://a${BACKSLASH}b:${OPAQUE}@host`,
      `https://\nuser:${OPAQUE}@host`,
    ]);
    // The same texts with the credential on the same line are masked, not only kept valid.
    assertValidLines(
      [`Bearer ${OPAQUE}\n`, `?api_key=${OPAQUE}\n&x=1`, `\token=${OPAQUE}`, `https://user:${OPAQUE}@host\n`],
      OPAQUE,
    );
  });

  test('quoted schemes, spaced =, prefixed names and sub-delims next to escapes stay valid JSON', () => {
    assertValidLines([
      'authorization: Bearer "',
      'authorization: Bearer ""',
      `authorization: Bearer ${BACKSLASH}"`,
      `authorization: Bearer ${BACKSLASH}${BACKSLASH}"${OPAQUE}`,
      `Bearer "${BACKSLASH}n${OPAQUE}"`,
      `authorization =${BACKSLASH}`,
      'authorization = \nnext',
      `x-api-key = "${BACKSLASH}t"`,
      `client_secret=${BACKSLASH}"${OPAQUE}`,
      `refresh_token="${OPAQUE}${BACKSLASH}`,
      `https://u:a(b'c,d;e${BACKSLASH}@host`,
      `https://u:a(b"c@host`,
      `https://u:a(b\n@host`,
      `https://u:${OPAQUE}@@@host`,
    ]);
    assertValidLines(
      [
        `authorization: Bearer "${OPAQUE}"\n`,
        `Bearer '${OPAQUE}'\t`,
        `authorization = ${OPAQUE}\r\n`,
        `client_secret=${OPAQUE}\n`,
        `https://u:(${OPAQUE}),;'@host\n`,
        `{"client_secret":"${OPAQUE}"}`,
      ],
      OPAQUE,
    );
  });

  test('a registered value that starts right after an escape is masked with its backslash', () => {
    registerSecretValues([`n${OPAQUE}`]);
    assert.equal(redactText(`x\\n${OPAQUE} y`), `x${REDACTED} y`, 'escape letter plus value');
    assert.equal(redactText(`C:${BACKSLASH}keys${BACKSLASH}n${OPAQUE}`), `C:${BACKSLASH}keys${REDACTED}`);
    assert.equal(
      redactText(`a${BACKSLASH}${BACKSLASH}n${OPAQUE}`),
      `a${BACKSLASH}${BACKSLASH}${REDACTED}`,
      'an escaped backslash is kept',
    );
    const lines = assertValidLines([`x\n${OPAQUE}`, `x${BACKSLASH}n${OPAQUE}`], OPAQUE);
    // Serialized, a newline before the rest of the value reads exactly like the value: over-masked, never broken.
    assert.equal(lines[0]?.msg, `x${REDACTED}`);
    assert.equal(lines[3]?.msg, `x${REDACTED}`);
  });

  test('a final pass that would break the line drops it instead', () => {
    // A registered value ending in a quote matches the closing quote of a JSON string in the serialized
    // line, where the per-field pass never saw it. The line is dropped, never written invalid or unmasked.
    registerSecretValues([`${OPAQUE}"`]);
    const chunks: string[] = [];
    const logger = createLogger({ env: {}, sink: { write: (chunk) => chunks.push(chunk) } });
    logger.info('ok', { detail: OPAQUE });
    assert.deepEqual(chunks, [DROPPED_LINE]);
  });

  test('a registered value keeps masking in linear time on a long run of backslashes', () => {
    const value = BACKSLASH.repeat(8);
    registerSecretValues([value]);
    const input = BACKSLASH.repeat(512 * 1024 + 1);
    assert.ok(!redactText(input).includes(value));
    const elapsed = bestTime(() => redactText(input));
    assert.ok(elapsed < BUDGET_MS, `took ${elapsed.toFixed(2)} ms`);
  });
});

// ---------------------------------------------------------------- guard false positives

describe('the commit guard patterns ignore prose about credentials', () => {
  // Source lines that interpolate variables, written without template literals so the linter accepts them.
  const interpolate = (name: string): string => `$${'{'}${name}}`;
  const prose = [
    'Query strings use the key=value format.',
    'Send a Bearer token in the Authorization header.',
    'HTTP Basic authentication is not supported.',
    'Basic capability-matching comes first; bearer credentials-based auth later.',
    'Set the Authorization: header to your key.',
    'x-api-key: <your key>',
    'Example: `x-api-key: $ANTHROPIC_API_KEY`',
    `headers: { 'x-api-key': FAKE_KEY, authorization: \`Bearer ${interpolate('key')}\` }`,
    'The URL https://user:pw@example.com is rejected, and so is https://user:hunter2@example.com.',
    `const url = \`https://${interpolate('user')}:${interpolate('password')}@${interpolate('host')}\`;`,
    'Put password=<value> in the form body.',
    'Pass api_key=... on the command line',
    'max_tokens=4096, monkey=banana',
    'const authorization = request.headers.authorization;',
    'Set client_secret=<value> and OPENAI_API_KEY=<value> in your shell.',
    'Pass a quoted "Bearer <value>" string.',
  ];
  for (const line of prose) {
    test(line, () => {
      for (const { name, pattern } of KEY_PATTERNS) assert.equal(pattern.test(line), false, `${name} tripped`);
    });
  }

  test('the same patterns still catch real-looking values in source lines', () => {
    const lines = [
      `curl -H "x-api-key: ${OPAQUE}" https://api.example.com`,
      `Authorization: bearer ${OPAQUE}`,
      `https://api.example.com/v1?key=${OPAQUE}`,
      `postgres://app:${OPAQUE}@db:5432/app`,
      ['password', 'changeme'].join('='),
    ];
    for (const line of lines)
      assert.ok(
        KEY_PATTERNS.some(({ pattern }) => pattern.test(line)),
        line,
      );
  });
});

// ---------------------------------------------------------------- ReDoS

// The budget proves the absence of super-linear backtracking, not raw speed. Every adversarial input is
// 500 KB or more: a linear pass over it takes a few milliseconds (about 30 ms at most, measured alone),
// while even a merely quadratic pattern needs about 1.3e11 steps on it, over a minute on the same
// machine (/a*c/ on 32 K characters already takes about 300 ms, and the cost grows fourfold per
// doubling). A 500 ms budget therefore still fails a catastrophic pattern by two orders of magnitude or
// more, and leaves room for the full suite running test files in parallel on a loaded machine, which is
// what pushed linear passes of about 30 ms over the previous 50 ms budget.
const BUDGET_MS = 500;
const RUNS = 5;

/** Best of RUNS timings, so one garbage-collection pause or scheduling delay does not decide the result. */
function bestTime(run: () => void): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < RUNS; i++) {
    const start = performance.now();
    run();
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

describe(`every new pattern runs in under ${BUDGET_MS} ms on adversarial inputs of ${MIN_ADVERSARIAL_LENGTH / 1024} KB or more`, () => {
  for (const [name, inputs] of Object.entries(ADVERSARIAL_INPUTS)) {
    const { pattern, extent } = patternNamed(name);
    const global = new RegExp((extent ?? pattern).source, `${(extent ?? pattern).flags}g`);
    for (const [label, input] of inputs) {
      test(`${name}: ${label}`, (t) => {
        assert.ok(input.length >= MIN_ADVERSARIAL_LENGTH, `input is only ${input.length} characters`);
        const guardMs = bestTime(() => pattern.test(input));
        const redactMs = bestTime(() => input.replace(global, REDACTED));
        const fullMs = bestTime(() => redactText(input));
        t.diagnostic(
          `${name} | ${label} | ${input.length} chars | guard ${guardMs.toFixed(2)} ms | redaction ${redactMs.toFixed(2)} ms | redactText ${fullMs.toFixed(2)} ms`,
        );
        assert.ok(guardMs < BUDGET_MS, `guard pattern took ${guardMs.toFixed(1)} ms`);
        assert.ok(redactMs < BUDGET_MS, `redaction pattern took ${redactMs.toFixed(1)} ms`);
        assert.ok(fullMs < BUDGET_MS, `redactText took ${fullMs.toFixed(1)} ms`);
      });
    }
  }
});
