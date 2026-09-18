// Single source of truth for key-shaped content patterns.
//
// Imported by:
//   - scripts/key-rules.mjs (used by the pre-commit hook scripts/guard-keys.mjs and its `--all` scan), which
//     only calls `pattern.test(line)`;
//   - src/log/redact.ts, which masks every match before anything is logged or stored.
//
// Add or change a provider key shape HERE and both the commit guard and runtime redaction pick it up.
// This file must stay plain, erasable TypeScript with no imports so that `node scripts/guard-keys.mjs`
// runs it directly through Node's native type stripping, before `npm install`.
//
// A pattern may declare a named capture group `value`: redaction then masks only that group and keeps
// the surrounding context (for example the `Bearer ` scheme or the `api_key=` name). Patterns without
// it are masked as a whole. The group does not change what `test()` matches.
//
// `pattern` is tuned for the commit guard: it must not trip on prose or code that merely talks about
// credentials ("a Bearer token", "the key=value format"). `extent`, when present, is what redaction uses
// instead and is deliberately wider: in a log line, over-masking is harmless and a leak is not.
//
// Every expression here must run in linear time on any input, because the guard scans whole files and
// redaction runs on every log line: separators use bounded quantifiers, adjacent quantified parts never
// accept the same characters, and each open-ended run is a single character class that cannot backtrack
// into its neighbour. test/redact.test.ts times each pattern on adversarial inputs of 500 KB or more.

export interface KeyPattern {
  /** Human-readable label used in guard-keys messages. */
  readonly name: string;
  /** Non-global pattern; callers that need global matching derive their own copy. */
  readonly pattern: RegExp;
  /**
   * Optional wider pattern used only by redaction, for shapes whose detectable marker is shorter than the
   * sensitive text (a PEM header line versus the whole key block) or whose guard form is kept narrow to
   * avoid false positives in source files. It must match everything `pattern` matches.
   */
  readonly extent?: RegExp;
}

// Separator between a quoted or unquoted header name and its value: `name: v`, `"name": "v"`, and the same
// with JSON escaping (`\"name\":\"v\"`). A quoted name requires a quoted value, so that JSON literals such
// as `"api-key":null` in an already serialized log line are never rewritten into invalid JSON. Backslashes
// are only accepted right before a quote: a lone backslash after the colon is the start of a JSON escape
// (`authorization:\nnext` once serialized) and must never be split from the letter that follows it.
const HEADER_NAMES = String.raw`\b(?:x-api-key|api-key|proxy-authorization|authorization)`;
const HEADER_SEPARATOR = String.raw`(?:\\{0,3}["'][ \t]{0,16}:[ \t]{0,16}\\{0,3}["']|[ \t]{0,16}:[ \t]{0,16}(?:\\{0,3}["'])?)`;
// Redaction also accepts `name = value` (config dumps) with a space before the `=`; the guard does not, so
// source code such as `authorization = request.headers.authorization` never trips it. `name=value` with no
// space is a query parameter and is left to that rule, which stops at `&`.
const HEADER_SEPARATOR_WIDE = String.raw`(?:\\{0,3}["'][ \t]{0,16}:[ \t]{0,16}\\{0,3}["']|(?:[ \t]{0,16}:|[ \t]{1,16}=)[ \t]{0,16}(?:\\{0,3}["'])?)`;
// A quote in plain text (no backslash) or inside JSON encoded one to three times (1, 3 or 7 backslashes;
// 5 is accepted too). An even run is an escaped backslash followed by a real quote, which is never part of
// a value. Wherever this is used, the backslash run can only start at a fixed position, so it never matches
// from the middle of a run.
const VALUE_QUOTE = String.raw`(?:\\(?:\\\\){0,3})?["']`;
// `Authorization: Bearer "<value>"`: the scheme and the opening quote are kept, the quoted value is masked.
// Only known schemes, so an unquoted opaque value before a quote is never kept in clear. When the quoted
// value is not maskable (already `[REDACTED]`, or empty), the header rule does not match at all rather
// than fall back to masking the scheme, so redacting a line twice changes nothing.
const QUOTED_SCHEME = String.raw`(?:(?:bearer|basic|token|digest|negotiate)[ \t]{1,8}${VALUE_QUOTE})`;
// Characters that end a free-text value: whitespace (for the first character only), quotes, backslashes
// and the structural characters of JSON, lists and markup. Brackets are among them, so `[REDACTED]` is
// never masked again when an already redacted line goes through redaction once more. None of them can
// start a JSON escape, so masking a value never leaves a dangling backslash in a serialized line.
const VALUE_STOP = String.raw`"'\x60\\<>{}\[\](),;`;
// A header value never starts with a colon either: in a serialized line, a quote followed by a colon is
// the end of an object key (`"authorization: \\":"v"`), and masking from there would break the JSON.
const HEADER_VALUE_START = String.raw`[^\s:${VALUE_STOP}]`;

// Characters that end a query value or a URL userinfo part in redaction. RFC 3986 sub-delims
// (! $ & ' ( ) * + , ; =) are legal unencoded in both and are deliberately NOT here: a password such as
// `ab(cd` must be masked whole. What remains cannot occur unencoded in a URL component, or would break a
// serialized JSON line (quote, backslash), or would re-mask `[REDACTED]` (brackets).
const URL_PART_STOP = String.raw`"\x60\\<>{}\[\]`;

const QUERY_NAME_LIST = String.raw`(?:api[_-]?key|access_token|token|secret|password|auth|key)=`;
// Guard: the name stands alone. Redaction: the name may also end a longer identifier after `_` or `-`
// (`client_secret=`, `refresh_token=`, `OPENAI_API_KEY=`), but never after a letter or digit (`monkey=`);
// it also accepts `authorization=`, the one header name whose query form no other name covers.
const QUERY_NAMES = String.raw`\b${QUERY_NAME_LIST}`;
const QUERY_NAMES_WIDE = String.raw`(?<![A-Za-z0-9])(?:${QUERY_NAME_LIST}|authorization=)`;

const ASSIGNMENT_NAME_LIST = String.raw`(api[_-]?key|secret|token|password|passwd|auth)\b`;
const ASSIGNMENT_TAIL = String.raw`\\{0,3}["']?\s{0,16}[:=]\s{0,16}\\{0,3}["']`;

export const KEY_PATTERNS: readonly KeyPattern[] = [
  { name: 'Anthropic API key', pattern: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'OpenAI API key', pattern: /sk-(proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/ },
  { name: 'OpenRouter API key', pattern: /sk-or-(v1-)?[A-Za-z0-9]{32,}/ },
  { name: 'Google API key', pattern: /AIza[0-9A-Za-z_-]{35}/ },
  { name: 'AWS access key', pattern: /(AKIA|ASIA)[0-9A-Z]{16}/ },
  { name: 'GitHub token', pattern: /(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{50,}/ },
  { name: 'Slack token', pattern: /xox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'Hugging Face token', pattern: /hf_[A-Za-z0-9]{30,}/ },
  { name: 'Groq API key', pattern: /gsk_[A-Za-z0-9]{40,}/ },
  {
    name: 'Private key block',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    extent: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/,
  },
  {
    // `x-api-key: <value>`, `Authorization: Bearer <value>` in free text (curl -v output, raw HTTP dumps,
    // error messages). Runs before the Bearer rule so the scheme and the credential are masked together.
    // Guard: one opaque run of 16+ characters, after an optional auth scheme. Redaction: everything up to
    // the end of the line or the next quote or structural character; a quoted value after a known scheme
    // (`Bearer "<value>"`) is masked inside its quotes.
    name: 'Credential header line',
    pattern: new RegExp(
      String.raw`${HEADER_NAMES}${HEADER_SEPARATOR}(?:(?:bearer|basic|token|digest)[ \t]{1,8})?(?<value>[A-Za-z0-9._~+/=-]{16,})`,
      'i',
    ),
    extent: new RegExp(
      String.raw`${HEADER_NAMES}${HEADER_SEPARATOR_WIDE}(?:${QUOTED_SCHEME}|(?!${QUOTED_SCHEME}))(?<value>${HEADER_VALUE_START}[^\r\n${VALUE_STOP}]*)`,
      'i',
    ),
  },
  {
    // RFC 6750 / RFC 7617 credentials in any letter case. The guard also asks for one digit, `+`, `/` or `=`
    // among the first 1024 characters, which every realistic credential has and a hyphenated English
    // compound after the word "basic" does not; redaction drops that requirement and also accepts a quoted
    // value (`Bearer "<value>"`), keeping the quotes.
    name: 'Bearer or Basic credential',
    pattern: /\b(?:bearer|basic)[ \t]{1,8}(?=[A-Za-z._~-]{0,1024}[0-9+/=])(?<value>[A-Za-z0-9._~+/-]{16,}=*)/i,
    extent: new RegExp(String.raw`\b(?:bearer|basic)[ \t]{1,8}${VALUE_QUOTE}?(?<value>[A-Za-z0-9._~+/-]{16,}=*)`, 'i'),
  },
  {
    // Unquoted `name=value` in query strings, form bodies and environment dumps; only the value is masked.
    // The guard needs a value of 8+ URL characters so prose such as "the key=value format" passes;
    // redaction masks any value, including prefixed names (`client_secret=`, `OPENAI_API_KEY=`).
    name: 'Credential query parameter',
    pattern: new RegExp(`${QUERY_NAMES}(?<value>[A-Za-z0-9._~%+/=-]{8,})`, 'i'),
    extent: new RegExp(String.raw`${QUERY_NAMES_WIDE}(?<value>[^\s&#${URL_PART_STOP}]+)`, 'i'),
  },
  {
    // `scheme://user:<pw>@host` becomes `scheme://[REDACTED]@host`. The guard needs a password of 8+
    // characters (documentation placeholders such as user:pw stay allowed); redaction masks any userinfo,
    // with or without a password, since a bare user part can itself be a credential. Redaction runs to the
    // last `@` before the host, so an unencoded `@` or sub-delim in the password never leaves a tail in clear.
    name: 'URL userinfo',
    pattern: /:\/\/(?<value>[A-Za-z0-9._~%!$&'()*+,;=-]+:[A-Za-z0-9._~%!$&'()*+,;=:-]{8,})@/,
    extent: new RegExp(String.raw`:\/\/(?<value>[^\s/?#${URL_PART_STOP}]+)@`),
  },
  {
    // `api_key = "..."`, `"apiKey": "..."`, including JSON escaped once more inside a string (`\"apiKey\":\"...\"`).
    // The guard needs a value of 24+ characters; redaction masks 8+ and prefixed names (`"client_secret": "..."`).
    name: 'Secret assignment',
    pattern: new RegExp(
      String.raw`\b${ASSIGNMENT_NAME_LIST}${ASSIGNMENT_TAIL}(?<value>[A-Za-z0-9_+/=.-]{24,})\\{0,3}["']`,
      'i',
    ),
    extent: new RegExp(
      String.raw`(?<![A-Za-z0-9])${ASSIGNMENT_NAME_LIST}${ASSIGNMENT_TAIL}(?<value>[A-Za-z0-9_+/=.-]{8,})\\{0,3}["']`,
      'i',
    ),
  },
];
