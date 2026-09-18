// Fake, key-shaped values, one per pattern in src/log/patterns.ts. They are built at runtime from
// repeated characters so the source never contains a literal key shape; none of them is a real credential.

export interface FakeKeySample {
  /** Text containing the key shape. */
  readonly text: string;
  /** The part that must never appear after redaction. */
  readonly secretPart: string;
  /** What redactText() must produce for `text`. */
  readonly redacted: string;
}

const anthropic = `sk-ant-api03-${'A1b2'.repeat(20)}`;
const openai = `sk-proj-${'Zx9_'.repeat(12)}`;
const openrouter = `sk-or-v1-${'a1'.repeat(32)}`;
const google = `AIza${'B7'.repeat(17)}c`;
const aws = `AKIA${'ABCDEFGHIJKLMNOP'}`;
const github = `ghp_${'a'.repeat(36)}`;
const slack = `xoxb-${'1234567890'}-abcdef`;
const huggingface = `hf_${'x'.repeat(34)}`;
const groq = `gsk_${'y'.repeat(52)}`;
const pemBody = 'M'.repeat(64);
const bearerValue = 'q7'.repeat(20);
const headerValue = 'h4'.repeat(12);
const queryValue = 'u9'.repeat(12);
const userinfoPassword = 'w3'.repeat(8);
const assignedValue = 'p'.repeat(30);

/** Keyed by the `name` of each entry in KEY_PATTERNS; a new pattern without a sample fails the tests. */
export const FAKE_KEYS: Readonly<Record<string, FakeKeySample>> = {
  'Anthropic API key': { text: anthropic, secretPart: anthropic, redacted: '[REDACTED]' },
  'OpenAI API key': { text: openai, secretPart: openai, redacted: '[REDACTED]' },
  'OpenRouter API key': { text: openrouter, secretPart: openrouter, redacted: '[REDACTED]' },
  'Google API key': { text: google, secretPart: google, redacted: '[REDACTED]' },
  'AWS access key': { text: aws, secretPart: aws, redacted: '[REDACTED]' },
  'GitHub token': { text: github, secretPart: github, redacted: '[REDACTED]' },
  'Slack token': { text: slack, secretPart: slack, redacted: '[REDACTED]' },
  'Hugging Face token': { text: huggingface, secretPart: huggingface, redacted: '[REDACTED]' },
  'Groq API key': { text: groq, secretPart: groq, redacted: '[REDACTED]' },
  'Private key block': {
    text: `-----BEGIN RSA PRIVATE ${'KEY'}-----\n${pemBody}\n-----END RSA PRIVATE ${'KEY'}-----`,
    secretPart: pemBody,
    redacted: '[REDACTED]',
  },
  'Credential header line': {
    text: `x-api-key: ${headerValue}\r\n`,
    secretPart: headerValue,
    redacted: 'x-api-key: [REDACTED]\r\n',
  },
  'Bearer or Basic credential': {
    text: `Bearer ${bearerValue}`,
    secretPart: bearerValue,
    redacted: 'Bearer [REDACTED]',
  },
  'Credential query parameter': {
    text: `api_key=${queryValue}`,
    secretPart: queryValue,
    redacted: 'api_key=[REDACTED]',
  },
  'URL userinfo': {
    text: `https://user:${userinfoPassword}@example.com`,
    secretPart: userinfoPassword,
    redacted: 'https://[REDACTED]@example.com',
  },
  'Secret assignment': {
    text: `password="${assignedValue}"`,
    secretPart: assignedValue,
    redacted: 'password="[REDACTED]"',
  },
};

/** A DeepSeek-style key (`sk-` plus 32 hex characters); it is covered by the OpenAI pattern. */
export const FAKE_DEEPSEEK_KEY = `sk-${'0123456789abcdef'.repeat(2)}`;
