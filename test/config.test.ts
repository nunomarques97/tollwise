import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ConfigError, formatProblem } from '../src/config/errors.ts';
import { type Environment, type LoadedConfig, loadConfig, MAX_REPORTED_PROBLEMS } from '../src/config/load.ts';
import { hasControlChars, isLoopbackHost } from '../src/config/network.ts';
import { type Config, isCleartextRemoteUrl, parseSize } from '../src/config/schema.ts';
import { PRESET_NAMES } from '../src/routing/presets.ts';
import { FAKE_KEYS } from './fixtures/fake-keys.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..');
const cliPath = path.join(repoRoot, 'src', 'cli.ts');
const examplePath = path.join(repoRoot, 'tollwise.example.yaml');

const workRoot = mkdtempSync(path.join(os.tmpdir(), 'tollwise-config-test-'));
after(() => rmSync(workRoot, { recursive: true, force: true }));

let dirCounter = 0;
/** A fresh, empty working directory, optionally with files in it. */
function workDir(files: Readonly<Record<string, string>> = {}): string {
  dirCounter += 1;
  const dir = path.join(workRoot, `case-${dirCounter}`);
  mkdirSync(dir);
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dir, name), content);
  return dir;
}

function load(text: string | undefined, env: Environment = {}): LoadedConfig {
  const cwd = workDir(text === undefined ? {} : { 'cfg.yaml': text });
  return loadConfig({ cwd, env, ...(text === undefined ? {} : { configPath: 'cfg.yaml' }) });
}

/** Loads and expects failure; returns the formatted problem lines. */
function loadErrors(text: string | undefined, env: Environment = {}): string[] {
  try {
    load(text, env);
  } catch (error) {
    assert.ok(error instanceof ConfigError, `expected ConfigError, got ${String(error)}`);
    return error.lines();
  }
  assert.fail('expected the configuration to be rejected');
}

const DEFAULTS: Config = {
  server: { host: '127.0.0.1', port: 8484, max_body_size: 20 * 1024 * 1024, allowed_hosts: [] },
  providers: {
    anthropic: { enabled: true, base_url: 'https://api.anthropic.com', api_key_env: 'ANTHROPIC_API_KEY' },
    openai: { enabled: true, base_url: 'https://api.openai.com/v1', api_key_env: 'OPENAI_API_KEY' },
    deepseek: { enabled: true, base_url: 'https://api.deepseek.com', api_key_env: 'DEEPSEEK_API_KEY' },
    openrouter: { enabled: true, base_url: 'https://openrouter.ai/api/v1', api_key_env: 'OPENROUTER_API_KEY' },
    ollama: { enabled: true, base_url: 'http://127.0.0.1:11434', api_key_env: null },
  },
  routing: {
    policy: 'cheapest',
    on_no_candidate: 'passthrough',
    equivalence_groups: [],
    equivalence_presets: [],
    retries: 1,
    timeouts: { connect_ms: 5000, first_byte_ms: 120000, total_ms: 600000 },
  },
  analytics: { enabled: true, store_prompts: false, path: 'data/analytics.db' },
  logging: { level: 'info' },
};

describe('zero configuration', () => {
  test('no file at all yields the documented defaults', () => {
    const loaded = loadConfig({ cwd: workDir(), env: {} });
    assert.deepEqual(loaded.config, DEFAULTS);
    assert.equal(loaded.file, null);
    assert.equal(loaded.fileOrigin, 'none');
    assert.deepEqual(loaded.envOverrides, []);
    assert.equal(loaded.accessKeySet, false);
  });

  test('an empty file and a comments-only file are valid and equal the defaults', () => {
    assert.deepEqual(load('').config, DEFAULTS);
    assert.deepEqual(load('# nothing configured yet\n').config, DEFAULTS);
  });

  test('the example file is valid and matches the defaults it documents', () => {
    const loaded = loadConfig({ cwd: repoRoot, env: {}, configPath: examplePath });
    assert.deepEqual(loaded.config, DEFAULTS);
  });
});

describe('file selection', () => {
  test('./tollwise.yaml is used when present', () => {
    const cwd = workDir({ 'tollwise.yaml': 'server:\n  port: 9000\n' });
    const loaded = loadConfig({ cwd, env: {} });
    assert.equal(loaded.file, 'tollwise.yaml');
    assert.equal(loaded.fileOrigin, 'default');
    assert.equal(loaded.config.server.port, 9000);
  });

  test('TOLLWISE_CONFIG wins over ./tollwise.yaml, and --config wins over both', () => {
    const cwd = workDir({
      'tollwise.yaml': 'server:\n  port: 9000\n',
      'from-env.yaml': 'server:\n  port: 9001\n',
      'from-flag.yaml': 'server:\n  port: 9002\n',
    });
    const viaEnv = loadConfig({ cwd, env: { TOLLWISE_CONFIG: 'from-env.yaml' } });
    assert.equal(viaEnv.config.server.port, 9001);
    assert.equal(viaEnv.fileOrigin, 'env');
    const viaFlag = loadConfig({ cwd, env: { TOLLWISE_CONFIG: 'from-env.yaml' }, configPath: 'from-flag.yaml' });
    assert.equal(viaFlag.config.server.port, 9002);
    assert.equal(viaFlag.fileOrigin, 'flag');
  });

  test('a missing explicit file is an error, not a silent fallback to defaults', () => {
    const cwd = workDir();
    assert.throws(
      () => loadConfig({ cwd, env: {}, configPath: 'missing.yaml' }),
      (error: unknown) =>
        error instanceof ConfigError &&
        error.lines()[0] ===
          'missing.yaml: configuration file not found. Fix: check the path, or remove --config / TOLLWISE_CONFIG to run with the built-in defaults.',
    );
    assert.throws(() => loadConfig({ cwd, env: { TOLLWISE_CONFIG: 'gone.yaml' } }), ConfigError);
  });
});

describe('valid file', () => {
  test('values from the file replace the defaults and the rest stay default', () => {
    const loaded = load(
      [
        'server:',
        '  port: 9100',
        '  max_body_size: 512kb',
        'providers:',
        '  openai:',
        '    base_url: https://gateway.example.com/v1',
        '    api_key_env: MY_OPENAI_KEY',
        '  deepseek:',
        '    enabled: false',
        'routing:',
        '  policy: pinned',
        '  on_no_candidate: fail',
        '  pinned:',
        '    provider: anthropic',
        '    model: claude-sonnet-4-5',
        '  equivalence_groups:',
        '    - name: small',
        '      models: [gpt-5-mini, claude-haiku-4-5]',
        '  retries: 0',
        '  timeouts:',
        '    total_ms: 30000',
        '    first_byte_ms: 10000',
        'analytics:',
        '  store_prompts: false',
        '  path: /var/lib/tollwise/analytics.db',
        'logging:',
        '  level: debug',
        '',
      ].join('\n'),
    );
    assert.deepEqual(loaded.config, {
      server: { host: '127.0.0.1', port: 9100, max_body_size: 512 * 1024, allowed_hosts: [] },
      providers: {
        ...DEFAULTS.providers,
        openai: { enabled: true, base_url: 'https://gateway.example.com/v1', api_key_env: 'MY_OPENAI_KEY' },
        deepseek: { ...DEFAULTS.providers.deepseek, enabled: false },
      },
      routing: {
        policy: 'pinned',
        on_no_candidate: 'fail',
        pinned: { provider: 'anthropic', model: 'claude-sonnet-4-5' },
        equivalence_groups: [{ name: 'small', models: ['gpt-5-mini', 'claude-haiku-4-5'] }],
        equivalence_presets: [],
        retries: 0,
        timeouts: { connect_ms: 5000, first_byte_ms: 10000, total_ms: 30000 },
      },
      analytics: { enabled: true, store_prompts: false, path: '/var/lib/tollwise/analytics.db' },
      logging: { level: 'debug' },
    });
  });

  test('turned-on presets expand into equivalence groups after the written ones', () => {
    const { routing } = load(
      'routing:\n  equivalence_groups:\n    - name: mine\n      models: [m1, m2]\n  equivalence_presets: [small-fast]\n',
    ).config;
    assert.deepEqual(routing.equivalence_presets, ['small-fast']);
    assert.deepEqual(routing.equivalence_groups, [
      { name: 'mine', models: ['m1', 'm2'] },
      { name: 'small-fast', models: ['claude-haiku-4.5', 'gpt-5.6-luna', 'deepseek-v4.1-flash'] },
    ]);
  });

  test('max_body_size accepts bytes and unit sizes', () => {
    assert.equal(parseSize('20mb'), 20 * 1024 * 1024);
    assert.equal(parseSize('512 KiB'), 512 * 1024);
    assert.equal(parseSize('1GB'), 1024 ** 3);
    assert.equal(parseSize('4096'), 4096);
    assert.equal(parseSize('lots'), undefined);
    assert.equal(load('server:\n  max_body_size: 2048\n').config.server.max_body_size, 2048);
  });
});

describe('human-readable errors', () => {
  test('an unknown field is reported with its line, column and a spelling hint', () => {
    const lines = loadErrors('server:\n  prot: 9000\n');
    assert.deepEqual(lines, [
      'cfg.yaml:2:3: server.prot: unknown field "prot" in server. Fix: did you mean "port"? allowed fields: host, port, max_body_size, allowed_hosts.',
    ]);
  });

  test('an unknown top-level section and an unknown provider are reported', () => {
    const lines = loadErrors('routng:\n  policy: fastest\nproviders:\n  opnai: {}\n');
    assert.deepEqual(lines, [
      'cfg.yaml:1:1: routng: unknown field "routng" at the top level. Fix: did you mean "routing"? allowed fields: server, providers, routing, analytics, logging.',
      'cfg.yaml:4:3: providers.opnai: unknown field "opnai" in providers. Fix: did you mean "openai"? allowed fields: anthropic, openai, deepseek, openrouter, ollama.',
    ]);
  });

  test('a wrong type is reported with the line number of the value', () => {
    const lines = loadErrors('# comment\nserver:\n  port: http\nanalytics:\n  enabled: "yes"\n');
    assert.deepEqual(lines, [
      'cfg.yaml:3:9: server.port: expected a whole number, got text "http". Fix: write a whole number without quotes, e.g. 8484.',
      'cfg.yaml:5:12: analytics.enabled: expected true or false, got text "yes". Fix: write true or false without quotes.',
    ]);
  });

  test('out-of-range numbers and bad enum values give the allowed range or values', () => {
    const lines = loadErrors('server:\n  port: 70000\nrouting:\n  policy: cheepest\n');
    assert.deepEqual(lines, [
      'cfg.yaml:2:9: server.port: the number 70000 is too large; the maximum is 65535. Fix: use a value of at most 65535.',
      'cfg.yaml:4:11: routing.policy: text "cheepest" is not allowed; expected one of: cheapest, fastest, balanced, pinned. Fix: did you mean "cheapest"?',
    ]);
  });

  test('invalid YAML syntax is reported at its position', () => {
    const lines = loadErrors('server:\n  port: 1\n  port: 2\n');
    assert.equal(lines.length, 1);
    assert.match(
      lines[0] ?? '',
      /^cfg\.yaml:3:3: invalid YAML: .*unique.*\. Fix: keep only one of the repeated fields\.$/,
    );
  });

  test('a file that is not a mapping is rejected', () => {
    assert.match(loadErrors('- a\n- b\n')[0] ?? '', /^cfg\.yaml:1:1: the file must contain a mapping of sections/);
  });

  test('routing cross-field rules are enforced', () => {
    const lines = loadErrors(
      [
        'routing:',
        '  policy: pinned',
        '  equivalence_groups:',
        '    - name: a',
        '      models: [m1, m2]',
        '    - name: b',
        '      models: [m2, m3]',
        '  timeouts:',
        '    first_byte_ms: 5000',
        '    total_ms: 1000',
        '',
      ].join('\n'),
    );
    assert.deepEqual(lines, [
      'cfg.yaml:2:11: routing.policy: policy is "pinned" but no pinned target is set. Fix: add routing.pinned with a provider and a model, or choose another policy.',
      'cfg.yaml:7:16: routing.equivalence_groups[1].models[0]: model "m2" is already in group "a". Fix: a model may belong to one equivalence group only; merge the groups or remove it.',
      'cfg.yaml:9:20: routing.timeouts.first_byte_ms: first_byte_ms (5000) is larger than total_ms (1000). Fix: make first_byte_ms smaller than or equal to total_ms.',
    ]);
  });

  test('an unknown equivalence preset is an error whose hint lists every valid name', () => {
    const lines = loadErrors('routing:\n  equivalence_presets: [frontier, small-fats]\n');
    assert.deepEqual(lines, [
      `cfg.yaml:2:35: routing.equivalence_presets[1]: unknown equivalence preset "small-fats". Fix: use one of: ${PRESET_NAMES.join(', ')}.`,
    ]);
  });

  test('a preset listed twice, or named like a written group, is an error', () => {
    const lines = loadErrors(
      [
        'routing:',
        '  equivalence_groups:',
        '    - name: frontier',
        '      models: [m1, m2]',
        '  equivalence_presets: [frontier, frontier]',
        '',
      ].join('\n'),
    );
    assert.deepEqual(lines, [
      'cfg.yaml:5:25: routing.equivalence_presets[0]: preset "frontier" has the same name as a group in equivalence_groups. Fix: rename that group, or remove it and keep the preset.',
      'cfg.yaml:5:35: routing.equivalence_presets[1]: preset "frontier" is listed twice. Fix: list each preset once.',
    ]);
  });

  test('a model in a written group and in a turned-on preset is an error', () => {
    const lines = loadErrors(
      [
        'routing:',
        '  equivalence_groups:',
        '    - name: mine',
        '      models: [gpt-5.6-luna, m2]',
        '  equivalence_presets: [small-fast]',
        '',
      ].join('\n'),
    );
    assert.deepEqual(lines, [
      'cfg.yaml:5:25: routing.equivalence_presets[0]: preset "small-fast" includes model "gpt-5.6-luna", which is already in group "mine". Fix: a model may belong to one equivalence group only; remove it from that group, or turn off one of the presets.',
    ]);
  });

  test("a written group naming a preset member by a provider's own id is an error", () => {
    const lines = loadErrors(
      [
        'routing:',
        '  equivalence_groups:',
        '    - name: mine',
        '      models: [claude-haiku-4-5-20251001, m2]',
        '    - name: routed',
        '      models: [anthropic/claude-opus-5, m3]',
        '  equivalence_presets: [small-fast, frontier]',
        '',
      ].join('\n'),
    );
    assert.deepEqual(lines, [
      'cfg.yaml:7:25: routing.equivalence_presets[0]: preset "small-fast" includes model "claude-haiku-4.5", which group "mine" already lists by its provider id "claude-haiku-4-5-20251001". Fix: a model may belong to one equivalence group only; remove it from that group, or turn off one of the presets.',
      'cfg.yaml:7:37: routing.equivalence_presets[1]: preset "frontier" includes model "claude-opus-5", which group "routed" already lists by its provider id "anthropic/claude-opus-5". Fix: a model may belong to one equivalence group only; remove it from that group, or turn off one of the presets.',
    ]);
  });

  test('every problem is on exactly one line', () => {
    const text = formatProblem({ source: 'f.yaml', line: 1, col: 2, field: 'a', message: 'two\nlines', hint: 'x\ny' });
    assert.equal(text, 'f.yaml:1:2: a: two lines. Fix: x y.');
  });
});

describe('literal keys are rejected', () => {
  const samples = ['Anthropic API key', 'OpenAI API key', 'OpenRouter API key', 'Google API key', 'Groq API key'];
  for (const name of samples) {
    test(`${name} written as api_key_env`, () => {
      const key = FAKE_KEYS[name]?.text ?? assert.fail(`no fake sample for ${name}`);
      const lines = loadErrors(`providers:\n  openai:\n    api_key_env: ${key}\n`);
      assert.deepEqual(lines, [
        `cfg.yaml:3:18: providers.openai.api_key_env: this value looks like a literal API key or other credential. Fix: never write a key in the configuration; export it as an environment variable (for example OPENAI_API_KEY) and put that variable NAME in api_key_env.`,
      ]);
      assert.ok(!lines.join('\n').includes(key), 'the key must never be echoed back');
    });
  }

  test('a key in any other field, even an unknown one, is rejected without echoing it', () => {
    const key = FAKE_KEYS['Anthropic API key']?.text ?? '';
    const lines = loadErrors(`providers:\n  anthropic:\n    api_key: ${key}\nanalytics:\n  path: ${key}\n`);
    assert.equal(lines.length, 2);
    assert.match(lines[0] ?? '', /^cfg\.yaml:3:14: providers\.anthropic\.api_key: this value looks like a literal/);
    assert.match(lines[1] ?? '', /^cfg\.yaml:5:9: analytics\.path: this value looks like a literal/);
    assert.ok(!lines.join('\n').includes(key));
  });

  test('a long value that is not a variable name is treated as a key in api_key_env', () => {
    const lines = loadErrors(`providers:\n  deepseek:\n    api_key_env: ${'ab12'.repeat(8)}-x\n`);
    assert.match(
      lines[0] ?? '',
      /api_key_env: this value looks like a literal API key or other credential\. Fix: never write a key/,
    );
  });

  test('credentials inside base_url are rejected', () => {
    const lines = loadErrors('providers:\n  openai:\n    base_url: https://user:pw@example.com/v1\n');
    assert.deepEqual(lines, [
      'cfg.yaml:3:15: providers.openai.base_url: the URL contains credentials (user:password@). Fix: remove them from the URL; put the key in an environment variable and name it in api_key_env.',
    ]);
  });
});

describe('network exposure (non-loopback host needs an access key)', () => {
  const accessKey = 'k'.repeat(32);

  test('a non-loopback host in the file without TOLLWISE_ACCESS_KEY is rejected at its line', () => {
    const lines = loadErrors('server:\n  host: 0.0.0.0\n');
    assert.deepEqual(lines, [
      'cfg.yaml:2:9: server.host: "0.0.0.0" accepts connections from other machines, but TOLLWISE_ACCESS_KEY is not set. Fix: set TOLLWISE_ACCESS_KEY to a long random value (every request must then send it), or bind to 127.0.0.1.',
    ]);
  });

  test('a non-loopback host from TOLLWISE_HOST without an access key is rejected', () => {
    const lines = loadErrors(undefined, { TOLLWISE_HOST: '192.168.1.20' });
    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? '', /^environment TOLLWISE_HOST: server\.host: "192\.168\.1\.20" accepts connections/);
  });

  test('the same host is accepted once TOLLWISE_ACCESS_KEY is set, and the key is not in the config', () => {
    const loaded = load('server:\n  host: 0.0.0.0\n', { TOLLWISE_ACCESS_KEY: accessKey });
    assert.equal(loaded.config.server.host, '0.0.0.0');
    assert.equal(loaded.accessKeySet, true);
    assert.ok(!JSON.stringify(loaded).includes(accessKey));
  });

  test('a too-short access key is rejected', () => {
    const lines = loadErrors(undefined, { TOLLWISE_ACCESS_KEY: 'short' });
    assert.match(lines[0] ?? '', /^environment TOLLWISE_ACCESS_KEY: the access key must be at least 16 characters/);
    assert.ok(!(lines[0] ?? '').includes('"short"'));
  });

  test('loopback addresses need no access key', () => {
    for (const host of ['127.0.0.1', '127.0.0.2', 'localhost', '::1', '[::1]']) {
      assert.equal(isLoopbackHost(host), true, host);
      assert.equal(load(undefined, { TOLLWISE_HOST: host }).config.server.host, host);
    }
    for (const host of ['0.0.0.0', '::', '10.0.0.1', 'example.com', '128.0.0.1']) {
      assert.equal(isLoopbackHost(host), false, host);
    }
  });
});

describe('provider keys never travel unencrypted', () => {
  test('http:// to a loopback host with a key is accepted (a local server)', () => {
    const loaded = load(
      [
        'providers:',
        '  openai:',
        '    base_url: http://127.0.0.1:8080/v1',
        '  anthropic:',
        '    base_url: http://localhost:9000',
        '  deepseek:',
        '    base_url: http://[::1]:7000',
        '',
      ].join('\n'),
    );
    assert.equal(loaded.config.providers.openai.base_url, 'http://127.0.0.1:8080/v1');
    assert.equal(loaded.config.providers.openai.api_key_env, 'OPENAI_API_KEY');
    assert.equal(loaded.config.providers.anthropic.base_url, 'http://localhost:9000');
    assert.equal(loaded.config.providers.deepseek.base_url, 'http://[::1]:7000');
  });

  test('http:// to a remote host with a key is rejected at the base_url line', () => {
    const lines = loadErrors('providers:\n  openai:\n    base_url: http://api.example.com/v1\n');
    assert.deepEqual(lines, [
      'cfg.yaml:3:15: providers.openai.base_url: plain http:// to a remote host would send the OPENAI_API_KEY key unencrypted. Fix: use https://, or a loopback address (127.0.0.1, localhost) for a local server; for a keyless server on your network set api_key_env: null.',
    ]);
  });

  test('the rule also applies to Ollama once it is given a key variable', () => {
    const lines = loadErrors(
      'providers:\n  ollama:\n    base_url: http://192.168.1.50:11434\n    api_key_env: OLLAMA_KEY\n',
    );
    assert.equal(lines.length, 1);
    assert.match(
      lines[0] ?? '',
      /^cfg\.yaml:3:15: providers\.ollama\.base_url: plain http:\/\/ to a remote host would send the OLLAMA_KEY key/,
    );
  });

  test('http:// to a remote host with api_key_env: null is accepted (a keyless server on the network)', () => {
    const loaded = load('providers:\n  ollama:\n    base_url: http://192.168.1.50:11434\n    api_key_env: null\n');
    assert.equal(loaded.config.providers.ollama.base_url, 'http://192.168.1.50:11434');
    assert.equal(loaded.config.providers.ollama.api_key_env, null);
  });

  test('https:// to a remote host with a key is accepted', () => {
    const loaded = load('providers:\n  openai:\n    base_url: https://gateway.example.com/v1\n');
    assert.equal(loaded.config.providers.openai.base_url, 'https://gateway.example.com/v1');
  });

  test('isCleartextRemoteUrl only flags plain http to another machine', () => {
    for (const url of ['http://api.example.com', 'http://0.0.0.0:80', 'http://10.0.0.1', 'http://localhost.']) {
      assert.equal(isCleartextRemoteUrl(url), true, url);
    }
    for (const url of ['https://api.example.com', 'http://127.0.0.1:1', 'http://LOCALHOST', 'http://[::1]', 'nope']) {
      assert.equal(isCleartextRemoteUrl(url), false, url);
    }
  });

  test('TOLLWISE_ACCESS_KEY cannot be forwarded to a provider', () => {
    const lines = loadErrors('providers:\n  openai:\n    api_key_env: TOLLWISE_ACCESS_KEY\n');
    assert.deepEqual(lines, [
      "cfg.yaml:3:18: providers.openai.api_key_env: TOLLWISE_ACCESS_KEY protects Tollwise itself and must not be sent to a provider. Fix: name the variable that holds this provider's own key, e.g. OPENAI_API_KEY.",
    ]);
  });
});

describe('hostile file content', () => {
  test('control characters in a value are rejected and printed escaped, never raw', () => {
    const lines = loadErrors('server:\n  host: "127.0.0.1\\e[31mRED"\n  port: "\\0x"\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0] ?? '', /^cfg\.yaml:2:9: server\.host: contains control characters\./);
    assert.match(lines[1] ?? '', /^cfg\.yaml:3:9: server\.port: expected a whole number, got text "\\u0000x"\./);
    assert.ok(!hasControlChars(lines.join('')), 'no raw control character may reach the output');
  });

  test('non-plain YAML tags such as !!binary are refused with one line each', () => {
    const lines = loadErrors('server:\n  host: !!binary aGVsbG8=\n  port: !!int 9000\n  max_body_size: !custom 20mb\n');
    assert.deepEqual(lines, [
      'cfg.yaml:2:18: YAML tag "!!binary" is not supported. Fix: remove the tag and write a plain value (text, number, true/false, list or mapping).',
      'cfg.yaml:4:26: YAML tag "!custom" is not supported. Fix: remove the tag and write a plain value (text, number, true/false, list or mapping).',
    ]);
  });

  test('a flood of problems is capped with a summary line', () => {
    const fields = Array.from({ length: MAX_REPORTED_PROBLEMS + 7 }, (_, index) => `  extra${index}: 1`);
    const lines = loadErrors(`server:\n${fields.join('\n')}\n`);
    assert.equal(lines.length, MAX_REPORTED_PROBLEMS + 1);
    assert.equal(
      lines.at(-1),
      'cfg.yaml: 7 more problems not shown. Fix: fix the problems above and run the check again.',
    );
  });
});

describe('environment overrides', () => {
  test('TOLLWISE_HOST, TOLLWISE_PORT and TOLLWISE_LOG_LEVEL override the file', () => {
    const loaded = load('server:\n  host: 127.0.0.1\n  port: 9000\nlogging:\n  level: warn\n', {
      TOLLWISE_HOST: 'localhost',
      TOLLWISE_PORT: '9999',
      TOLLWISE_LOG_LEVEL: 'DEBUG',
    });
    assert.equal(loaded.config.server.host, 'localhost');
    assert.equal(loaded.config.server.port, 9999);
    assert.equal(loaded.config.logging.level, 'debug');
    assert.deepEqual(loaded.envOverrides, ['TOLLWISE_HOST', 'TOLLWISE_PORT', 'TOLLWISE_LOG_LEVEL']);
  });

  test('environment overrides apply with no file too, and empty values are ignored', () => {
    const loaded = load(undefined, { TOLLWISE_PORT: '8000', TOLLWISE_HOST: '' });
    assert.equal(loaded.config.server.port, 8000);
    assert.equal(loaded.config.server.host, '127.0.0.1');
    assert.deepEqual(loaded.envOverrides, ['TOLLWISE_PORT']);
  });

  test('invalid environment values are reported one per line', () => {
    const lines = loadErrors(undefined, { TOLLWISE_PORT: '80a', TOLLWISE_LOG_LEVEL: 'loud' });
    assert.deepEqual(lines, [
      'environment TOLLWISE_PORT: server.port: "80a" is not a port number. Fix: set TOLLWISE_PORT to a whole number between 1 and 65535, or unset it.',
      'environment TOLLWISE_LOG_LEVEL: logging.level: "loud" is not a log level. Fix: set TOLLWISE_LOG_LEVEL to one of: error, warn, info, debug, or unset it.',
    ]);
  });
});

describe('tollwise config check (CLI)', () => {
  const openaiKey = FAKE_KEYS['OpenAI API key']?.text ?? '';

  function runCli(args: readonly string[], cwd: string, env: Environment) {
    const cleanEnv: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (value !== undefined && !name.startsWith('TOLLWISE_') && !name.endsWith('_API_KEY')) cleanEnv[name] = value;
    }
    for (const [name, value] of Object.entries(env)) if (value !== undefined) cleanEnv[name] = value;
    return spawnSync(process.execPath, [cliPath, 'config', 'check', ...args], { cwd, env: cleanEnv, encoding: 'utf8' });
  }

  test('prints OK and the effective config, with keys only as set/missing', () => {
    const cwd = workDir();
    const result = runCli(['--config', examplePath], cwd, { OPENAI_API_KEY: openaiKey });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^OK: configuration is valid\.\n/);
    assert.match(result.stdout, /Config file: .*tollwise\.example\.yaml \(from --config\)/);
    assert.match(
      result.stdout,
      /openai:\n {4}enabled: true\n {4}base_url: https:\/\/api\.openai\.com\/v1\n {4}api_key_env: OPENAI_API_KEY\n {4}api_key: set\n/,
    );
    assert.match(
      result.stdout,
      /anthropic:\n(?: {4}.*\n){2} {4}api_key_env: ANTHROPIC_API_KEY\n {4}api_key: missing\n/,
    );
    assert.match(result.stdout, /access_key: missing \(TOLLWISE_ACCESS_KEY\)/);
    assert.ok(!result.stdout.includes(openaiKey), 'the key value must never be printed');
  });

  test('with no file it reports the built-in defaults', () => {
    const result = runCli([], workDir(), {});
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Config file: none found; using built-in defaults/);
    assert.match(result.stdout, /port: 8484/);
  });

  test('prints the turned-on presets with the models each one adds, apart from written groups', () => {
    const cwd = workDir({
      'tollwise.yaml': [
        'routing:',
        '  equivalence_groups:',
        '    - name: mine',
        '      models: [m1, m2]',
        '  equivalence_presets: [frontier, small-fast]',
        '',
      ].join('\n'),
    });
    const result = runCli([], cwd, {});
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      new RegExp(
        [
          '  equivalence_groups:',
          '    - name: mine',
          '      models:',
          '        - m1',
          '        - m2',
          '  equivalence_presets:',
          '    - name: frontier',
          '      models:',
          '        - claude-opus-5',
          '        - gpt-6-astra',
          '        - deepseek-v4-pro-0813',
          '    - name: small-fast',
          '      models:',
          '        - claude-haiku-4.5',
          '        - gpt-5.6-luna',
          '        - deepseek-v4.1-flash',
          '',
        ].join('\n'),
      ),
    );
  });

  test('with no presets turned on it prints an empty preset list', () => {
    const result = runCli([], workDir(), {});
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\n {2}equivalence_groups: \[\]\n {2}equivalence_presets: \[\]\n/);
  });

  test('an invalid file exits 1 with one line per problem on stderr', () => {
    const cwd = workDir({ 'tollwise.yaml': 'server:\n  port: http\n  colour: blue\n' });
    const result = runCli([], cwd, {});
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.deepEqual(result.stderr.trimEnd().split('\n'), [
      'tollwise: the configuration is not valid (2 problems):',
      '  tollwise.yaml:2:9: server.port: expected a whole number, got text "http". Fix: write a whole number without quotes, e.g. 8484.',
      '  tollwise.yaml:3:3: server.colour: unknown field "colour" in server. Fix: remove it or check the spelling; allowed fields: host, port, max_body_size, allowed_hosts.',
    ]);
  });

  test('wrong usage exits 2', () => {
    const cwd = workDir();
    assert.equal(runCli(['--config'], cwd, {}).status, 2);
    assert.equal(runCli(['--verbose'], cwd, {}).status, 2);
  });
});
