// Key rules shared by the commit guard (scripts/guard-keys.mjs) and any other scanner that must apply
// exactly the same checks. Plain JavaScript with a single import so it runs before `npm install`.
//
// Content patterns (provider keys and generic secret assignments) are not defined here: they live in ONE
// place, shared with the runtime log redaction, in src/log/patterns.ts. Node strips its types natively.
import { KEY_PATTERNS } from '../src/log/patterns.ts';

/** A line ending with this marker holds a fake, key-shaped value on purpose (test fixtures). */
export const ALLOW_MARKER = 'tollwise-allow-secret';

/** File names that must never be committed, even with `git add -f`. Tested against a `/`-separated path. */
export const BAD_NAME =
  /(^|\/)(\.env(\..*)?|.*\.(pem|key|p12|pfx|jks|keystore|ppk)|id_(rsa|ed25519)[^/]*|credentials[^/]*\.json|service-account[^/]*\.json|google-services\.json|\.netrc|\.npmrc|\.pypirc)$/i;

/** Exceptions to BAD_NAME. */
export const NAME_OK = /(^|\/)\.env\.example$/i;

/** `[name, pattern]` pairs, in the order of src/log/patterns.ts. */
export const RULES = KEY_PATTERNS.map(({ name, pattern }) => [name, pattern]);

/** True when a path (any separator) is a file type or name that must never be committed. */
export function isForbiddenFileName(file) {
  const unix = file.replace(/\\/g, '/');
  return BAD_NAME.test(unix) && !NAME_OK.test(unix);
}

/** True when the content holds a NUL byte, the test git itself uses to call a file binary. */
export function isBinary(buf) {
  return buf.includes(0);
}

/**
 * Extensions of files that must always be text. Such a file holding a NUL byte is not skipped as
 * binary: a scanner reports it, because skipping it would hide its whole content from the key scan.
 */
export const TEXT_EXTENSIONS = new Set(
  '.ts .mts .cts .tsx .js .mjs .cjs .jsx .json .md .yaml .yml .sse .css .html .txt .sh .toml .svg'.split(' '),
);

/** True when a path (any separator) has one of TEXT_EXTENSIONS, compared case-insensitively. */
export function hasTextExtension(file) {
  const base = file.replace(/\\/g, '/').split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 && TEXT_EXTENSIONS.has(base.slice(dot).toLowerCase());
}

/**
 * Finds key-shaped content in a text, one hit per line at most (the first rule that matches).
 * Lines carrying ALLOW_MARKER are skipped. Returns `{ line, rule }` with 1-based line numbers.
 */
export function findKeyHits(text) {
  const hits = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.includes(ALLOW_MARKER)) return;
    for (const [name, re] of RULES) {
      if (re.test(line)) {
        hits.push({ line: i + 1, rule: name });
        break;
      }
    }
  });
  return hits;
}
