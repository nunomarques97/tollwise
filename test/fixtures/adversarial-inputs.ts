// Inputs built to make a backtracking regular expression engine work as hard as possible on the
// free-text credential patterns of src/log/patterns.ts: long runs that almost match, repeated prefixes
// with no value, separators with nothing after them, values that never reach their terminator.
// Every input is at least MIN_ADVERSARIAL_LENGTH characters long.

export const MIN_ADVERSARIAL_LENGTH = 500 * 1024;

function fill(unit: string, tail = ''): string {
  return unit.repeat(Math.ceil((MIN_ADVERSARIAL_LENGTH - tail.length) / unit.length) + 1) + tail;
}

const BS = '\\';

/** Adversarial inputs, keyed by the KEY_PATTERNS name they target. */
export const ADVERSARIAL_INPUTS: Readonly<Record<string, readonly (readonly [string, string])[]>> = {
  'Credential header line': [
    ['repeated names with a colon and no value', fill('x-api-key:')],
    ['name followed by spaces only', `authorization${' '.repeat(MIN_ADVERSARIAL_LENGTH)}`],
    ['name, colon, then only spaces and tabs', `x-api-key:${' \t'.repeat(MIN_ADVERSARIAL_LENGTH / 2)}`],
    ['one value that never ends', `x-api-key: ${'a'.repeat(MIN_ADVERSARIAL_LENGTH)}`],
    ['repeated schemes with short values', fill('Authorization: Bearer abc ')],
    ['escaped quotes with no value', fill(`${BS}"api-key${BS}${BS}${BS}":${BS}${BS}${BS}"`)],
    ['quoted name without a quoted value', fill('"proxy-authorization": 0, ')],
    ['spaced = with no value', fill('authorization = ')],
    ['quoted schemes with nothing to mask', fill('authorization: Bearer "')],
    ['escaped quoted schemes with even backslash runs', fill(`x-api-key:basic ${BS.repeat(8)}"`)],
  ],
  'Bearer or Basic credential': [
    ['repeated schemes', fill('bearer ')],
    ['scheme followed by spaces only', `Basic${' '.repeat(MIN_ADVERSARIAL_LENGTH)}`],
    ['long letters-only value (no digit)', `basic ${'a'.repeat(MIN_ADVERSARIAL_LENGTH)}`],
    ['values one character too short', fill('BEARER abcdefghijklmno ')],
    ['quoted schemes with no value', fill('bearer "')],
    ['backslash runs that never reach a quote', fill(`Basic ${BS.repeat(9)}`)],
    [
      'letters then padding with no end',
      `bearer ${'a'.repeat(MIN_ADVERSARIAL_LENGTH / 2)}${'='.repeat(MIN_ADVERSARIAL_LENGTH / 2)}`,
    ],
  ],
  'Credential query parameter': [
    ['repeated names with no value', fill('key=')],
    ['values one character too short', fill('api_key=abcdefg&')],
    ['one value that never ends', `token=${'%'.repeat(MIN_ADVERSARIAL_LENGTH)}`],
    ['names chained with no value', fill(['access_token', 'token', 'secret', ''].join('='))],
    ['prefixed names with no value', fill('client_secret=')],
    ['one sub-delim value that never ends', `refresh_token=${"(),;'!*".repeat(MIN_ADVERSARIAL_LENGTH / 7 + 1)}`],
  ],
  'URL userinfo': [
    ['repeated scheme separators', fill('://')],
    ['user part with no @', `https://${'a'.repeat(MIN_ADVERSARIAL_LENGTH)}`],
    ['password part with no @', `https://a:${'b'.repeat(MIN_ADVERSARIAL_LENGTH)}`],
    ['colons with no @', `x://a${':'.repeat(MIN_ADVERSARIAL_LENGTH)}`],
    ['alternating letters and colons with no @', `x://${'a:'.repeat(MIN_ADVERSARIAL_LENGTH / 2)}`],
    ['repeated separators inside one user part', fill('a://b:c')],
    ['many URLs, none with userinfo', fill('https://a:b/')],
    ['at signs with no host after the last one', `x://${'a@'.repeat(MIN_ADVERSARIAL_LENGTH / 2)}`],
    ['sub-delims with no @', `x://u:${"(),;'".repeat(MIN_ADVERSARIAL_LENGTH / 5 + 1)}`],
    ['repeated schemes with an @ each', fill('://a@')],
  ],
  'Secret assignment': [
    ['escaped assignments with no value', fill(`${BS}"apiKey${BS}":${BS}"`)],
    ['one value that never closes', `password="${'a'.repeat(MIN_ADVERSARIAL_LENGTH)}`],
    ['prefixed names with a value one character too short', fill('client_secret":"abcdefg')],
    [
      'spaces around the separator',
      `secret${' '.repeat(MIN_ADVERSARIAL_LENGTH / 2)}=${' '.repeat(MIN_ADVERSARIAL_LENGTH / 2)}`,
    ],
  ],
};
