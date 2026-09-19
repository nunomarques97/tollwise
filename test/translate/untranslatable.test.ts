import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import type { WireFormat } from '../../src/providers/types.ts';
import {
  RESPONSE_PROBLEMS,
  TranslationError,
  translateAnthropicRequestToOpenAI,
  translateOpenAIRequestToAnthropic,
  UNTRANSLATABLE_CODES,
  UNTRANSLATABLE_FEATURES,
  type UntranslatableCode,
  untranslatable,
} from '../../src/translate/index.ts';

const openaiBase = { model: 'gpt-test', max_tokens: 100, messages: [{ role: 'user', content: 'Hello' }] };
const anthropicBase = { model: 'claude-test', max_tokens: 100, messages: [{ role: 'user', content: 'Hello' }] };
const openaiTool = { type: 'function', function: { name: 'f', parameters: { type: 'object' } } };
const anthropicTool = { name: 'f', input_schema: { type: 'object' } };

interface Case {
  readonly name: string;
  readonly target: WireFormat;
  readonly request: unknown;
  readonly codes: readonly UntranslatableCode[];
  /** The anthropic-beta header the request came with (Anthropic requests only). */
  readonly anthropicBeta?: string;
}

/** An OpenAI request (target Anthropic): the base with `extra` merged in. */
const fromOpenAI = (name: string, extra: Record<string, unknown>, codes: UntranslatableCode[]): Case => ({
  name,
  target: 'anthropic',
  request: { ...openaiBase, ...extra },
  codes,
});

/** An Anthropic request (target OpenAI): the base with `extra` merged in. */
const fromAnthropic = (name: string, extra: Record<string, unknown>, codes: UntranslatableCode[]): Case => ({
  name,
  target: 'openai',
  request: { ...anthropicBase, ...extra },
  codes,
});

const openaiUser = (content: unknown) => ({ messages: [{ role: 'user', content }] });
const anthropicUser = (content: unknown) => ({ messages: [{ role: 'user', content }] });

const CASES: readonly Case[] = [
  // --- OpenAI -> Anthropic ---
  { name: 'openai: not an object', target: 'anthropic', request: 'hello', codes: ['malformed_request'] },
  fromOpenAI('openai: no messages array', { messages: 'hi' }, ['malformed_request']),
  fromOpenAI('openai: unknown role', { messages: [{ role: 'narrator', content: 'x' }] }, ['malformed_request']),
  fromOpenAI('openai: stream not a boolean', { stream: 'yes' }, ['malformed_request']),
  fromOpenAI('openai: unknown top-level field', { web_search_options: {} }, ['unknown_field']),
  fromOpenAI('openai: unknown message field', { messages: [{ role: 'user', content: 'x', reasoning_content: 'y' }] }, [
    'unknown_field',
  ]),
  fromOpenAI('openai: unknown content part', openaiUser([{ type: 'video_url', video_url: {} }]), [
    'unknown_content_type',
  ]),
  fromOpenAI(
    'openai: trailing assistant message',
    {
      messages: [
        { role: 'user', content: 'x' },
        { role: 'assistant', content: 'Sure, ' },
      ],
    },
    ['assistant_prefill'],
  ),
  fromOpenAI('openai: message name', { messages: [{ role: 'user', content: 'x', name: 'alice' }] }, ['message_name']),
  fromOpenAI(
    'openai: system message mid-conversation',
    {
      messages: [
        { role: 'user', content: 'x' },
        { role: 'system', content: 'Change of rules.' },
        { role: 'user', content: 'y' },
      ],
    },
    ['system_message_position'],
  ),
  {
    name: 'openai: no output budget',
    target: 'anthropic',
    request: { model: 'gpt-test', messages: [{ role: 'user', content: 'x' }] },
    codes: ['max_tokens_missing'],
  },
  fromOpenAI('openai: temperature above 1', { temperature: 1.5 }, ['temperature_out_of_range']),
  fromOpenAI('openai: temperature above 2 is malformed', { temperature: 3 }, ['malformed_request']),
  fromOpenAI(
    'openai: BMP image',
    openaiUser([{ type: 'image_url', image_url: { url: 'data:image/bmp;base64,Qk0=' } }]),
    ['image_media_type'],
  ),
  fromOpenAI(
    'openai: image detail low',
    openaiUser([{ type: 'image_url', image_url: { url: 'https://example.com/a.png', detail: 'low' } }]),
    ['openai_image_detail'],
  ),
  fromOpenAI('openai: n=2', { n: 2 }, ['openai_n']),
  fromOpenAI('openai: logprobs', { logprobs: true, top_logprobs: 3 }, ['openai_logprobs']),
  fromOpenAI('openai: logit_bias', { logit_bias: { '50256': -100 } }, ['openai_logit_bias']),
  fromOpenAI('openai: presence penalty', { presence_penalty: 0.5 }, ['openai_penalties']),
  fromOpenAI('openai: frequency penalty', { frequency_penalty: -0.5 }, ['openai_penalties']),
  fromOpenAI('openai: seed', { seed: 7 }, ['openai_seed']),
  fromOpenAI('openai: legacy functions', { functions: [{ name: 'f', parameters: {} }], function_call: 'auto' }, [
    'openai_legacy_functions',
  ]),
  fromOpenAI(
    'openai: function role',
    {
      messages: [
        { role: 'user', content: 'x' },
        { role: 'function', name: 'f', content: '1' },
      ],
    },
    ['message_name', 'openai_legacy_functions'],
  ),
  fromOpenAI(
    'openai: audio input',
    openaiUser([{ type: 'input_audio', input_audio: { data: 'AAAA', format: 'wav' } }]),
    ['openai_audio'],
  ),
  fromOpenAI('openai: audio output', { modalities: ['text', 'audio'], audio: { voice: 'alloy', format: 'mp3' } }, [
    'openai_audio',
  ]),
  fromOpenAI('openai: file part', openaiUser([{ type: 'file', file: { file_id: 'file-1' } }]), ['openai_file_input']),
  fromOpenAI('openai: store', { store: true }, ['openai_store']),
  fromOpenAI('openai: metadata tags', { metadata: { team: 'search' } }, ['openai_store']),
  fromOpenAI('openai: prediction', { prediction: { type: 'content', content: 'x' } }, ['openai_prediction']),
  fromOpenAI('openai: reasoning_effort', { reasoning_effort: 'high' }, ['openai_reasoning_effort']),
  fromOpenAI('openai: service tier flex', { service_tier: 'flex' }, ['openai_service_tier']),
  fromOpenAI('openai: custom tool', { tools: [{ type: 'custom', custom: { name: 'grammar' } }] }, [
    'openai_custom_tool',
  ]),
  fromOpenAI(
    'openai: allowed_tools choice',
    { tools: [openaiTool], tool_choice: { type: 'allowed_tools', allowed_tools: { mode: 'auto', tools: [] } } },
    ['openai_custom_tool'],
  ),
  fromOpenAI(
    'openai: json_schema',
    { response_format: { type: 'json_schema', json_schema: { name: 'x', schema: {}, strict: true } } },
    ['json_schema'],
  ),
  fromOpenAI('openai: JSON mode with tools', { response_format: { type: 'json_object' }, tools: [openaiTool] }, [
    'json_mode_with_tools',
  ]),
  fromOpenAI(
    'openai: strict tool',
    { tools: [{ type: 'function', function: { name: 'f', parameters: {}, strict: true } }] },
    ['tool_strict'],
  ),
  fromOpenAI(
    'openai: tool call arguments not JSON',
    {
      messages: [
        { role: 'user', content: 'x' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: 'nope' } }],
        },
        { role: 'tool', tool_call_id: 'c', content: 'r' },
      ],
    },
    ['tool_arguments_not_json'],
  ),
  fromOpenAI(
    'openai: assistant refusal in history',
    {
      messages: [
        { role: 'user', content: 'x' },
        { role: 'assistant', content: null, refusal: 'No.' },
        { role: 'user', content: 'y' },
      ],
    },
    ['assistant_refusal'],
  ),

  // --- Anthropic -> OpenAI ---
  { name: 'anthropic: not an object', target: 'openai', request: null, codes: ['malformed_request'] },
  fromAnthropic('anthropic: missing max_tokens', { max_tokens: undefined }, ['malformed_request']),
  fromAnthropic('anthropic: stream not a boolean', { stream: 1 }, ['malformed_request']),
  {
    ...fromAnthropic('anthropic: anthropic-beta header', {}, ['anthropic_beta']),
    anthropicBeta: 'some-beta-2026-01-01',
  },
  fromAnthropic('anthropic: unknown top-level field', { response_format: { type: 'json_object' } }, ['unknown_field']),
  fromAnthropic(
    'anthropic: unknown block',
    anthropicUser([{ type: 'search_result', source: 's', title: 't', content: [] }]),
    ['unknown_content_type'],
  ),
  fromAnthropic(
    'anthropic: prefill',
    {
      messages: [
        { role: 'user', content: 'x' },
        { role: 'assistant', content: '{' },
      ],
    },
    ['assistant_prefill'],
  ),
  fromAnthropic(
    'anthropic: cache_control on system',
    { system: [{ type: 'text', text: 's', cache_control: { type: 'ephemeral' } }] },
    ['anthropic_cache_control'],
  ),
  fromAnthropic(
    'anthropic: cache_control on a tool',
    { tools: [{ ...anthropicTool, cache_control: { type: 'ephemeral' } }] },
    ['anthropic_cache_control'],
  ),
  fromAnthropic('anthropic: thinking', { thinking: { type: 'enabled', budget_tokens: 2048 } }, ['anthropic_thinking']),
  fromAnthropic(
    'anthropic: thinking block in history',
    {
      messages: [
        { role: 'user', content: 'x' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'hm', signature: 'sig' },
            { type: 'text', text: 'ok' },
          ],
        },
        { role: 'user', content: 'y' },
      ],
    },
    ['anthropic_thinking'],
  ),
  fromAnthropic('anthropic: top_k', { top_k: 40 }, ['anthropic_top_k']),
  fromAnthropic(
    'anthropic: document',
    anthropicUser([{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBE' } }]),
    ['anthropic_document'],
  ),
  fromAnthropic(
    'anthropic: file image source',
    anthropicUser([{ type: 'image', source: { type: 'file', file_id: 'file_1' } }]),
    ['anthropic_file_source'],
  ),
  fromAnthropic(
    'anthropic: citations in history',
    {
      messages: [
        { role: 'user', content: 'x' },
        { role: 'assistant', content: [{ type: 'text', text: 'ok', citations: [{ type: 'char_location' }] }] },
        { role: 'user', content: 'y' },
      ],
    },
    ['anthropic_citations'],
  ),
  fromAnthropic('anthropic: server tool', { tools: [{ type: 'web_search_20250305', name: 'web_search' }] }, [
    'anthropic_server_tool',
  ]),
  fromAnthropic('anthropic: MCP servers', { mcp_servers: [{ type: 'url', url: 'https://example.com', name: 'x' }] }, [
    'anthropic_server_tool',
  ]),
  fromAnthropic('anthropic: service tier', { service_tier: 'standard_only' }, ['anthropic_service_tier']),
  fromAnthropic(
    'anthropic: tool_result error',
    {
      tools: [anthropicTool],
      messages: [
        { role: 'user', content: 'x' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'f', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'boom', is_error: true }] },
      ],
    },
    ['tool_result_error'],
  ),
  fromAnthropic(
    'anthropic: image inside tool_result',
    {
      tools: [anthropicTool],
      messages: [
        { role: 'user', content: 'x' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'f', input: {} }] },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't1',
              content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } }],
            },
          ],
        },
      ],
    },
    ['tool_result_image'],
  ),
  fromAnthropic(
    'anthropic: text after tool_use',
    {
      tools: [anthropicTool],
      messages: [
        { role: 'user', content: 'x' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 't1', name: 'f', input: {} },
            { type: 'text', text: 'after' },
          ],
        },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'r' }] },
      ],
    },
    ['assistant_text_after_tool_use'],
  ),
  fromAnthropic('anthropic: five stop sequences', { stop_sequences: ['a', 'b', 'c', 'd', 'e'] }, [
    'too_many_stop_sequences',
  ]),
  fromAnthropic('anthropic: strict tool', { tools: [{ ...anthropicTool, strict: true }] }, ['tool_strict']),
  fromAnthropic(
    'anthropic: text before tool_result is malformed',
    anthropicUser([
      { type: 'text', text: 'x' },
      { type: 'tool_result', tool_use_id: 't1', content: 'r' },
    ]),
    ['malformed_request'],
  ),
];

describe('untranslatable — one case per feature', () => {
  for (const c of CASES) {
    test(c.name, () => {
      assert.deepEqual(untranslatable(c.request, c.target, { anthropicBeta: c.anthropicBeta }), c.codes);
    });
  }

  test('every code in the catalogue is exercised by a case above', () => {
    const covered = new Set(CASES.flatMap((c) => c.codes));
    const missing = UNTRANSLATABLE_CODES.filter((code) => !covered.has(code));
    assert.deepEqual(missing, []);
  });

  test('docs/compatibility.md lists every untranslatable and response-problem code', () => {
    const page = readFileSync(new URL('../../docs/compatibility.md', import.meta.url), 'utf8');
    const codes = [...UNTRANSLATABLE_CODES, ...Object.keys(RESPONSE_PROBLEMS)];
    const missing = codes.filter((code) => !page.includes(`\`${code}\``));
    assert.deepEqual(missing, []);
  });

  test('every code has an English description', () => {
    for (const code of UNTRANSLATABLE_CODES) {
      assert.ok(UNTRANSLATABLE_FEATURES[code].length > 10, code);
    }
  });

  test('clean requests report nothing in either direction', () => {
    assert.deepEqual(untranslatable(openaiBase, 'anthropic'), []);
    assert.deepEqual(untranslatable(anthropicBase, 'openai'), []);
  });

  test('an empty anthropic-beta header enables nothing and reports nothing', () => {
    assert.deepEqual(untranslatable(anthropicBase, 'openai', { anthropicBeta: ' ' }), []);
    assert.deepEqual(untranslatable(anthropicBase, 'openai', { anthropicBeta: undefined }), []);
  });

  test('streaming requests are translatable in both directions', () => {
    assert.deepEqual(
      untranslatable({ ...openaiBase, stream: true, stream_options: { include_usage: true } }, 'anthropic'),
      [],
    );
    assert.deepEqual(untranslatable({ ...anthropicBase, stream: true }, 'openai'), []);
  });

  test('defaultMaxTokens clears max_tokens_missing', () => {
    const request = { model: 'gpt-test', messages: [{ role: 'user', content: 'x' }] };
    assert.deepEqual(untranslatable(request, 'anthropic'), ['max_tokens_missing']);
    assert.deepEqual(untranslatable(request, 'anthropic', { defaultMaxTokens: 1024 }), []);
  });

  test('several features are all reported, each once, in the order found', () => {
    const request = { ...openaiBase, stream: true, n: 3, seed: 1, logprobs: true, temperature: 1.8 };
    assert.deepEqual(untranslatable(request, 'anthropic'), [
      'openai_n',
      'openai_logprobs',
      'openai_seed',
      'temperature_out_of_range',
    ]);
  });
});

describe('a request with any untranslatable feature is never translated', () => {
  for (const c of CASES) {
    test(`translate refuses: ${c.name}`, () => {
      const translate = () =>
        c.target === 'anthropic'
          ? translateOpenAIRequestToAnthropic(c.request)
          : translateAnthropicRequestToOpenAI(c.request, { anthropicBeta: c.anthropicBeta });
      assert.throws(translate, (error: unknown) => {
        assert.ok(error instanceof TranslationError);
        assert.equal(error.subject, 'request');
        assert.equal(error.to, c.target);
        assert.deepEqual(error.codes, c.codes);
        assert.match(error.message, new RegExp(c.codes[0] ?? 'never'));
        return true;
      });
    });
  }

  test('the error message names codes only, never request content', () => {
    const secretLooking = 'do-not-echo-this-prompt-text';
    try {
      translateOpenAIRequestToAnthropic({
        ...openaiBase,
        messages: [{ role: 'user', content: secretLooking }],
        seed: 1,
      });
      assert.fail('expected a TranslationError');
    } catch (error) {
      assert.ok(error instanceof TranslationError);
      assert.equal(error.message.includes(secretLooking), false);
      assert.equal(
        error.message,
        'cannot translate the request from the openai format to the anthropic format: openai_seed',
      );
    }
  });
});
