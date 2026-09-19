import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { countTokens } from 'gpt-tokenizer';
import {
  ANTHROPIC_CHARS_PER_TOKEN,
  estimateInput,
  TOKENIZER_CHUNK_CHARS,
  TOKENIZER_SAMPLE_CHARS,
} from '../src/pricing/estimate.ts';

describe('estimateInput — OpenAI format', () => {
  test('counts a plain-text message with gpt-tokenizer', () => {
    const body = { model: 'gpt-6-astra', messages: [{ role: 'user', content: 'Hello, world!' }] };
    const estimate = estimateInput('openai', body);
    assert.equal(estimate.origin, 'estimated');
    assert.equal(estimate.tokens, countTokens('Hello, world!'));
  });

  test('mixed content: text parts are counted, image parts contribute no text', () => {
    const textOnly = {
      model: 'gpt-6-astra',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Describe this picture.' }] }],
    };
    const withImage = {
      model: 'gpt-6-astra',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this picture.' },
            { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } },
          ],
        },
      ],
    };
    assert.equal(estimateInput('openai', withImage).tokens, estimateInput('openai', textOnly).tokens);
  });

  test('images across message history do not change the text-based estimate', () => {
    const body = {
      model: 'gpt-6-astra',
      messages: [
        { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }] },
        { role: 'assistant', content: 'I see an image.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'And this one?' },
            { type: 'image_url', image_url: { url: 'https://example.com/b.png' } },
          ],
        },
      ],
    };
    const textOnly = {
      model: 'gpt-6-astra',
      messages: [
        { role: 'assistant', content: 'I see an image.' },
        { role: 'user', content: [{ type: 'text', text: 'And this one?' }] },
      ],
    };
    assert.equal(estimateInput('openai', body).tokens, estimateInput('openai', textOnly).tokens);
  });

  test('empty messages estimate to zero tokens', () => {
    const estimate = estimateInput('openai', { model: 'gpt-6-astra', messages: [] });
    assert.equal(estimate.tokens, 0);
  });

  test('a large text sample is counted proportionally, not truncated', () => {
    const shortText = 'The quick brown fox jumps over the lazy dog. ';
    const longText = shortText.repeat(500);
    const shortEstimate = estimateInput('openai', {
      model: 'gpt-6-astra',
      messages: [{ role: 'user', content: shortText }],
    });
    const longEstimate = estimateInput('openai', {
      model: 'gpt-6-astra',
      messages: [{ role: 'user', content: longText }],
    });
    assert.ok(
      longEstimate.tokens > shortEstimate.tokens * 100,
      'a 500x longer text must produce meaningfully more tokens',
    );
    // 22,500 characters: above the sampling threshold, so the count is extrapolated from samples.
    const exact = countTokens(longText);
    assert.ok(Math.abs(longEstimate.tokens - exact) <= exact * 0.02, `${longEstimate.tokens} vs ${exact}`);
  });

  test('text up to the sampling threshold is counted exactly, even when cut into pieces', () => {
    const sentence = 'Routing picks the cheapest provider that supports every requested capability.\n';
    const text = sentence.repeat(Math.floor(TOKENIZER_SAMPLE_CHARS / sentence.length));
    assert.ok(text.length > TOKENIZER_CHUNK_CHARS * 10 && text.length <= TOKENIZER_SAMPLE_CHARS);
    const estimate = estimateInput('openai', { model: 'gpt-6-astra', messages: [{ role: 'user', content: text }] });
    assert.equal(estimate.tokens, countTokens(text));
  });

  test('a sampled estimate of large mixed text stays within 5% of the full count', () => {
    const block =
      'Summarise the attached log and list every error.\n' +
      'const total = items.reduce((sum, item) => sum + item.price * item.quantity, 0);\n' +
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg\n' +
      'Die Anfrage wird an den günstigsten Anbieter weitergeleitet. 请求会被路由到最便宜的提供商。\n';
    const text = block.repeat(Math.ceil(200_000 / block.length));
    const estimate = estimateInput('openai', { model: 'gpt-6-astra', messages: [{ role: 'user', content: text }] });
    const exact = countTokens(text);
    assert.ok(Math.abs(estimate.tokens - exact) <= exact * 0.05, `${estimate.tokens} vs ${exact}`);
  });

  test('special-token strings in user text are counted as plain text, never thrown on', () => {
    const body = { model: 'gpt-6-astra', messages: [{ role: 'user', content: 'What does <|endoftext|> mean?' }] };
    // 11 with o200k_base: the marker is split into ordinary pieces, not one special token.
    assert.deepEqual(estimateInput('openai', body), { tokens: 11, origin: 'estimated' });
  });

  test('every special-token string gpt-tokenizer knows is accepted in message text', () => {
    const text = '<|im_start|>system<|im_end|> <|endofprompt|> <|fim_prefix|> <|fim_middle|> <|fim_suffix|>';
    const body = { model: 'gpt-6-astra', messages: [{ role: 'user', content: [{ type: 'text', text }] }] };
    const estimate = estimateInput('openai', body);
    assert.ok(estimate.tokens > 10);
  });

  test('assistant tool call arguments contribute to the estimate', () => {
    const withoutCall = { model: 'gpt-6-astra', messages: [{ role: 'assistant', content: null }] };
    const withCall = {
      model: 'gpt-6-astra',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Lisbon"}' } },
          ],
        },
      ],
    };
    assert.equal(estimateInput('openai', withoutCall).tokens, 0);
    assert.equal(estimateInput('openai', withCall).tokens, countTokens('{"city":"Lisbon"}'));
  });

  test('tool definitions contribute to the estimate', () => {
    const withoutTools = { model: 'gpt-6-astra', messages: [{ role: 'user', content: 'hi' }] };
    const withTools = {
      model: 'gpt-6-astra',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Gets the current weather for a city',
            parameters: { type: 'object' },
          },
        },
      ],
    };
    assert.ok(estimateInput('openai', withTools).tokens > estimateInput('openai', withoutTools).tokens);
  });
});

describe('estimateInput — Anthropic format', () => {
  test('uses the documented ~4 characters per token heuristic', () => {
    const text = 'a'.repeat(400);
    const estimate = estimateInput('anthropic', { model: 'claude-opus', messages: [{ role: 'user', content: text }] });
    assert.equal(estimate.origin, 'estimated');
    assert.equal(estimate.tokens, Math.ceil(text.length / ANTHROPIC_CHARS_PER_TOKEN));
  });

  test('system prompt text is included in the estimate', () => {
    const withoutSystem = { model: 'claude-opus', messages: [{ role: 'user', content: 'hi' }] };
    const withSystem = {
      model: 'claude-opus',
      system: 'You are a careful, concise assistant.',
      messages: [{ role: 'user', content: 'hi' }],
    };
    assert.ok(estimateInput('anthropic', withSystem).tokens > estimateInput('anthropic', withoutSystem).tokens);
  });

  test('mixed content: text blocks counted, image blocks contribute no text', () => {
    const textOnly = {
      model: 'claude-opus',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'What is this?' }] }],
    };
    const withImage = {
      model: 'claude-opus',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is this?' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
          ],
        },
      ],
    };
    assert.equal(estimateInput('anthropic', withImage).tokens, estimateInput('anthropic', textOnly).tokens);
  });

  test('images across message history do not change the text-based estimate', () => {
    const body = {
      model: 'claude-opus',
      messages: [
        { role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } }] },
        { role: 'assistant', content: 'Noted.' },
      ],
    };
    const textOnly = { model: 'claude-opus', messages: [{ role: 'assistant', content: 'Noted.' }] };
    assert.equal(estimateInput('anthropic', body).tokens, estimateInput('anthropic', textOnly).tokens);
  });

  test('special-token strings are plain characters for the heuristic', () => {
    const text = 'What does <|endoftext|> mean?';
    const estimate = estimateInput('anthropic', { model: 'claude-opus', messages: [{ role: 'user', content: text }] });
    assert.equal(estimate.tokens, 8);
  });

  test('text inside tool_result blocks is counted, as a string or as text blocks', () => {
    const body = {
      model: 'claude-opus',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: 'a'.repeat(40) },
            {
              type: 'tool_result',
              tool_use_id: 'toolu_2',
              content: [
                { type: 'text', text: 'b'.repeat(40) },
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
              ],
            },
          ],
        },
      ],
    };
    // 40 + newline + 40 characters = 81 -> ceil(81 / 4) = 21.
    assert.equal(estimateInput('anthropic', body).tokens, 21);
  });

  test('empty messages estimate to zero tokens', () => {
    const estimate = estimateInput('anthropic', { model: 'claude-opus', messages: [] });
    assert.equal(estimate.tokens, 0);
  });

  test('a large text sample scales with length', () => {
    const shortText = 'a'.repeat(40);
    const longText = 'a'.repeat(40_000);
    const shortEstimate = estimateInput('anthropic', {
      model: 'claude-opus',
      messages: [{ role: 'user', content: shortText }],
    });
    const longEstimate = estimateInput('anthropic', {
      model: 'claude-opus',
      messages: [{ role: 'user', content: longText }],
    });
    assert.equal(longEstimate.tokens, longText.length / ANTHROPIC_CHARS_PER_TOKEN);
    assert.ok(longEstimate.tokens > shortEstimate.tokens * 900);
  });
});

describe('estimateInput — bounded work on pathological input', () => {
  // Without chunking and sampling, the tokenizer is quadratic on a long run with no whitespace:
  // 80,000 identical characters took about 9 seconds. Each case below finishes in a few
  // milliseconds; the limit is generous so a slow CI machine does not make the test flaky.
  const LIMIT_MS = 1_000;

  function timed(content: string): { tokens: number; ms: number } {
    const start = performance.now();
    const { tokens } = estimateInput('openai', { model: 'gpt-6-astra', messages: [{ role: 'user', content }] });
    return { tokens, ms: performance.now() - start };
  }

  function pseudoRandom(length: number, alphabet: string): string {
    const chars = [...alphabet];
    const out: string[] = [];
    let seed = 42;
    for (let i = 0; i < length; i++) {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      out.push(chars[seed % chars.length] ?? '');
    }
    return out.join('');
  }

  const cases: Array<[string, () => string]> = [
    ['200,000 identical characters', () => 'x'.repeat(200_000)],
    ['2,000,000 identical characters', () => 'x'.repeat(2_000_000)],
    ['a 500,000-character run of one punctuation mark', () => '='.repeat(500_000)],
    ['a 1,000,000-character run of spaces', () => ' '.repeat(1_000_000)],
    ['a 1,000,000-character run of newlines', () => '\n'.repeat(1_000_000)],
    ['a single 500,000-character word of random letters and digits', () => pseudoRandom(500_000, 'abcdefXYZ0123+/')],
    ['500,000 random CJK characters', () => pseudoRandom(500_000, '的一是不了人我在有他这中大来上国')],
    ['250,000 emoji', () => '\u{1F600}'.repeat(250_000)],
  ];

  for (const [name, make] of cases) {
    test(`${name} is estimated in bounded time`, () => {
      const content = make();
      const { tokens, ms } = timed(content);
      assert.ok(tokens > 0);
      assert.ok(ms < LIMIT_MS, `took ${ms.toFixed(0)} ms`);
    });
  }

  test('the estimate of a long repeated run still scales with its length', () => {
    const small = timed('x'.repeat(200_000)).tokens;
    const large = timed('x'.repeat(2_000_000)).tokens;
    assert.ok(Math.abs(large - small * 10) <= small * 0.05, `${large} vs 10 x ${small}`);
  });

  test('a surrogate pair is never split at a piece boundary', () => {
    // The leading "a" puts every emoji at an odd offset, so a cut at a multiple of the piece size
    // would land between the two halves of a pair and change the count.
    const content = `a${'\u{1F600}'.repeat(1_000)}`;
    assert.ok(content.length <= TOKENIZER_SAMPLE_CHARS);
    assert.equal(timed(content).tokens, countTokens(content));
  });
});
