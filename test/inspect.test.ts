import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { InspectionError, inspect } from '../src/routing/inspect.ts';

describe('inspect — invalid bodies', () => {
  test('a body that is not an object throws InspectionError', () => {
    assert.throws(() => inspect('openai', 'not an object'), InspectionError);
    assert.throws(() => inspect('openai', 42), InspectionError);
    assert.throws(() => inspect('openai', null), InspectionError);
    assert.throws(() => inspect('openai', ['array', 'not', 'object']), InspectionError);
  });

  test('a body with no model field throws InspectionError', () => {
    assert.throws(() => inspect('openai', { messages: [] }), InspectionError);
    assert.throws(() => inspect('openai', { model: '', messages: [] }), InspectionError);
    assert.throws(() => inspect('openai', { model: '   ', messages: [] }), InspectionError);
    assert.throws(() => inspect('openai', { model: 42, messages: [] }), InspectionError);
  });

  test('the error message is clear', () => {
    try {
      inspect('anthropic', 'nope');
      assert.fail('expected inspect to throw');
    } catch (error) {
      assert.ok(error instanceof InspectionError);
      assert.match(error.message, /JSON object/);
    }
  });
});

describe('inspect — OpenAI format, one case per capability', () => {
  const base = { model: 'gpt-6-astra', messages: [{ role: 'user', content: 'hi' }] };

  test('no capabilities requested', () => {
    const result = inspect('openai', base);
    assert.equal(result.format, 'openai');
    assert.equal(result.requestedModel, 'gpt-6-astra');
    assert.equal(result.stream, false);
    assert.deepEqual(result.needs, { tools: false, json_mode: false, vision: false, streaming: false });
    assert.equal(result.maxOutput, null);
    assert.deepEqual(result.unknownFields, []);
  });

  test('tools: a non-empty tools array', () => {
    const result = inspect('openai', {
      ...base,
      tools: [{ type: 'function', function: { name: 'f', parameters: {} } }],
    });
    assert.equal(result.needs.tools, true);
  });

  test('tools: legacy functions array', () => {
    const result = inspect('openai', { ...base, functions: [{ name: 'f', parameters: {} }] });
    assert.equal(result.needs.tools, true);
  });

  test('tools: tool_choice forcing a specific tool even with an empty tools array', () => {
    const result = inspect('openai', {
      ...base,
      tools: [],
      tool_choice: { type: 'function', function: { name: 'f' } },
    });
    assert.equal(result.needs.tools, true);
  });

  test('tools: tool_choice "none" does not require tools', () => {
    const result = inspect('openai', { ...base, tool_choice: 'none' });
    assert.equal(result.needs.tools, false);
  });

  test('json_mode: response_format json_object', () => {
    const result = inspect('openai', { ...base, response_format: { type: 'json_object' } });
    assert.equal(result.needs.json_mode, true);
  });

  test('json_mode: response_format json_schema', () => {
    const result = inspect('openai', { ...base, response_format: { type: 'json_schema', json_schema: { name: 'x' } } });
    assert.equal(result.needs.json_mode, true);
  });

  test('json_mode: response_format text is not json mode', () => {
    const result = inspect('openai', { ...base, response_format: { type: 'text' } });
    assert.equal(result.needs.json_mode, false);
  });

  test('vision: an image_url content part', () => {
    const result = inspect('openai', {
      model: 'gpt-6-astra',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is this?' },
            { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
          ],
        },
      ],
    });
    assert.equal(result.needs.vision, true);
  });

  test('vision: images earlier in the conversation are still detected', () => {
    const result = inspect('openai', {
      model: 'gpt-6-astra',
      messages: [
        { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }] },
        { role: 'assistant', content: 'I see a cat.' },
        { role: 'user', content: 'Thanks.' },
      ],
    });
    assert.equal(result.needs.vision, true);
  });

  test('streaming: stream true', () => {
    const result = inspect('openai', { ...base, stream: true });
    assert.equal(result.needs.streaming, true);
    assert.equal(result.stream, true);
  });

  test('mixed content: text and image parts in the same message, tools and json mode together', () => {
    const result = inspect('openai', {
      model: 'gpt-6-astra',
      stream: true,
      response_format: { type: 'json_object' },
      tools: [{ type: 'function', function: { name: 'f', parameters: {} } }],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this and return JSON.' },
            { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
          ],
        },
      ],
    });
    assert.deepEqual(result.needs, { tools: true, json_mode: true, vision: true, streaming: true });
  });

  test('empty messages array', () => {
    const result = inspect('openai', { model: 'gpt-6-astra', messages: [] });
    assert.deepEqual(result.needs, { tools: false, json_mode: false, vision: false, streaming: false });
    assert.equal(result.estimatedInput.tokens, 0);
  });

  test('maxOutput: max_completion_tokens is preferred over max_tokens', () => {
    const result = inspect('openai', { ...base, max_tokens: 10, max_completion_tokens: 500 });
    assert.equal(result.maxOutput, 500);
  });

  test('maxOutput: falls back to max_tokens when max_completion_tokens is absent', () => {
    const result = inspect('openai', { ...base, max_tokens: 256 });
    assert.equal(result.maxOutput, 256);
  });

  test('maxOutput: absent or non-positive values read as null', () => {
    assert.equal(inspect('openai', base).maxOutput, null);
    assert.equal(inspect('openai', { ...base, max_tokens: 0 }).maxOutput, null);
    assert.equal(inspect('openai', { ...base, max_tokens: -5 }).maxOutput, null);
    assert.equal(inspect('openai', { ...base, max_tokens: 'lots' }).maxOutput, null);
  });

  test('unknownFields lists fields this inspector does not recognise', () => {
    const result = inspect('openai', { ...base, foo: 1, bar: 'baz' });
    assert.deepEqual(result.unknownFields, ['foo', 'bar']);
  });

  test('unknownFields is empty for a fully recognised body', () => {
    const result = inspect('openai', { ...base, temperature: 0.5, top_p: 1, stream: false });
    assert.deepEqual(result.unknownFields, []);
  });

  test('a message containing special-token strings is inspected, not rejected', () => {
    const result = inspect('openai', {
      model: 'gpt-6-astra',
      messages: [{ role: 'user', content: 'What does <|endoftext|> mean? And <|im_start|>?' }],
    });
    assert.equal(result.requestedModel, 'gpt-6-astra');
    assert.ok(result.estimatedInput.tokens > 0);
  });

  test('a large text sample is estimated, not truncated', () => {
    const longText = 'The quick brown fox jumps over the lazy dog. '.repeat(1000);
    const result = inspect('openai', { model: 'gpt-6-astra', messages: [{ role: 'user', content: longText }] });
    assert.ok(result.estimatedInput.tokens > 5000);
    assert.equal(result.estimatedInput.origin, 'estimated');
  });
});

describe('inspect — Anthropic format, one case per capability', () => {
  const base = { model: 'claude-opus', max_tokens: 1024, messages: [{ role: 'user', content: 'hi' }] };

  test('no capabilities requested', () => {
    const result = inspect('anthropic', base);
    assert.equal(result.format, 'anthropic');
    assert.equal(result.requestedModel, 'claude-opus');
    assert.deepEqual(result.needs, { tools: false, json_mode: false, vision: false, streaming: false });
    assert.equal(result.maxOutput, 1024);
  });

  test('tools: a non-empty tools array', () => {
    const result = inspect('anthropic', {
      ...base,
      tools: [{ name: 'get_weather', input_schema: { type: 'object' } }],
    });
    assert.equal(result.needs.tools, true);
  });

  test('tools: tool_choice forcing a tool even with an empty tools array', () => {
    const result = inspect('anthropic', { ...base, tools: [], tool_choice: { type: 'tool', name: 'get_weather' } });
    assert.equal(result.needs.tools, true);
  });

  test('tools: tool_choice "none" does not require tools', () => {
    const result = inspect('anthropic', { ...base, tool_choice: { type: 'none' } });
    assert.equal(result.needs.tools, false);
  });

  test('json_mode: response_format json_object is detected defensively', () => {
    const result = inspect('anthropic', { ...base, response_format: { type: 'json_object' } });
    assert.equal(result.needs.json_mode, true);
  });

  test('vision: a base64 image block', () => {
    const result = inspect('anthropic', {
      model: 'claude-opus',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is this?' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
          ],
        },
      ],
    });
    assert.equal(result.needs.vision, true);
  });

  test('vision: a url image block', () => {
    const result = inspect('anthropic', {
      model: 'claude-opus',
      max_tokens: 1024,
      messages: [
        { role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } }] },
      ],
    });
    assert.equal(result.needs.vision, true);
  });

  test('vision: an image block that references an uploaded file', () => {
    const result = inspect('anthropic', {
      model: 'claude-opus',
      max_tokens: 1024,
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'file', file_id: 'file_abc' } }] }],
    });
    assert.equal(result.needs.vision, true);
  });

  test('vision: images earlier in the conversation are still detected', () => {
    const result = inspect('anthropic', {
      model: 'claude-opus',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }],
        },
        { role: 'assistant', content: 'I see a cat.' },
        { role: 'user', content: 'Thanks.' },
      ],
    });
    assert.equal(result.needs.vision, true);
  });

  test('vision: an image returned inside a tool_result block', () => {
    const result = inspect('anthropic', {
      model: 'claude-opus',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }],
            },
          ],
        },
      ],
    });
    assert.equal(result.needs.vision, true);
  });

  test('a message containing special-token strings is inspected, not rejected', () => {
    const result = inspect('anthropic', { ...base, messages: [{ role: 'user', content: '<|endoftext|>' }] });
    assert.equal(result.estimatedInput.tokens, 4);
  });

  test('streaming: stream true', () => {
    const result = inspect('anthropic', { ...base, stream: true });
    assert.equal(result.needs.streaming, true);
    assert.equal(result.stream, true);
  });

  test('mixed content: text and image blocks, tools and streaming together', () => {
    const result = inspect('anthropic', {
      model: 'claude-opus',
      max_tokens: 1024,
      stream: true,
      tools: [{ name: 'get_weather', input_schema: { type: 'object' } }],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this.' },
            { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
          ],
        },
      ],
    });
    assert.deepEqual(result.needs, { tools: true, json_mode: false, vision: true, streaming: true });
  });

  test('empty messages array', () => {
    const result = inspect('anthropic', { model: 'claude-opus', max_tokens: 1024, messages: [] });
    assert.deepEqual(result.needs, { tools: false, json_mode: false, vision: false, streaming: false });
    assert.equal(result.estimatedInput.tokens, 0);
  });

  test('maxOutput: absent or non-positive max_tokens reads as null', () => {
    assert.equal(inspect('anthropic', { model: 'claude-opus', messages: [] }).maxOutput, null);
    assert.equal(inspect('anthropic', { model: 'claude-opus', max_tokens: 0, messages: [] }).maxOutput, null);
    assert.equal(inspect('anthropic', { model: 'claude-opus', max_tokens: -1, messages: [] }).maxOutput, null);
  });

  test('unknownFields lists fields this inspector does not recognise', () => {
    const result = inspect('anthropic', { ...base, anthropic_beta: 'x', extra: true });
    assert.deepEqual(result.unknownFields, ['anthropic_beta', 'extra']);
  });

  test('unknownFields is empty for thinking, service_tier and mcp_servers', () => {
    const result = inspect('anthropic', {
      ...base,
      thinking: { type: 'enabled', budget_tokens: 2048 },
      service_tier: 'auto',
      mcp_servers: [],
    });
    assert.deepEqual(result.unknownFields, []);
  });

  test('response_format sets json_mode and is still reported as unknown', () => {
    const result = inspect('anthropic', { ...base, response_format: { type: 'json_schema' } });
    assert.equal(result.needs.json_mode, true);
    assert.deepEqual(result.unknownFields, ['response_format']);
  });

  test('a large text sample is estimated, not truncated', () => {
    const longText = 'a'.repeat(40_000);
    const result = inspect('anthropic', {
      model: 'claude-opus',
      max_tokens: 1024,
      messages: [{ role: 'user', content: longText }],
    });
    assert.equal(result.estimatedInput.tokens, 10_000);
    assert.equal(result.estimatedInput.origin, 'estimated');
  });
});
