#!/usr/bin/env node
// Opt-in end-to-end check: the official `openai` and `@anthropic-ai/sdk` packages, unmodified, run
// against a real local Ollama through an in-process Tollwise. Never part of `npm test` or
// `npm run check`; run by hand with `npm run e2e:ollama`. Makes no paid provider call (see
// CLAUDE.md rule 5): only the local Ollama provider is ever configured.
//
// What it does:
//   1. Confirms Ollama answers on 127.0.0.1:11434 and reads its already-downloaded models from
//      GET /api/tags. Never pulls a model; exits with a clear message when none are downloaded.
//   2. Picks the smallest listed model, or TOLLWISE_E2E_MODEL when it names one that is listed.
//   3. Starts Tollwise in-process with only the ollama provider enabled, on an ephemeral
//      127.0.0.1 port, behind a random access key generated here and never printed.
//   4. Sends one non-streaming and one streaming request through the official `openai` SDK (same
//      wire format as Ollama, no translation), and the same through the official
//      `@anthropic-ai/sdk` (Ollama only speaks the OpenAI format, so this forces the cross-format
//      translation path), each asserting a non-empty answer and the `x-tollwise-*` response
//      headers.
//   5. Writes a JSON record to benchmarks/results/e2e-ollama-<UTC date>.json.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { loadCatalog } from '../src/catalog/index.ts';
import { ConfigSchema } from '../src/config/schema.ts';
import { createLogger } from '../src/log/logger.ts';
import { buildRegistry } from '../src/providers/registry.ts';
import { baseUrl, createTollwiseServer, listen, stopServer } from '../src/server/server.ts';

const OLLAMA_URL = 'http://127.0.0.1:11434';
const MODEL_ENV = 'TOLLWISE_E2E_MODEL';
// First load of a model on this machine can take tens of seconds; the client waits generously.
const REQUEST_TIMEOUT_MS = 180_000;
const MAX_TOKENS = 48;

const PROMPT = [{ role: 'user' as const, content: 'Reply with exactly one short sentence saying hello.' }];

interface OllamaModel {
  readonly name: string;
  readonly size: number;
}

interface CaseResult {
  readonly case: string;
  readonly pass: boolean;
  readonly duration_ms: number;
  readonly error?: string;
}

function fail(message: string): never {
  console.error(`e2e-ollama: ${message}`);
  process.exit(1);
}

async function fetchOllamaModels(): Promise<OllamaModel[]> {
  let response: Response;
  try {
    response = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(5000) });
  } catch (error) {
    fail(
      `Ollama does not answer on ${OLLAMA_URL} (${error instanceof Error ? error.message : String(error)}). ` +
        'Start it first (e.g. `ollama serve`) and try again.',
    );
  }
  if (!response.ok) fail(`Ollama answered ${response.status} on GET /api/tags.`);
  const body = (await response.json()) as { models?: { name: string; size: number }[] };
  return (body.models ?? []).map((entry) => ({ name: entry.name, size: entry.size }));
}

async function fetchOllamaVersion(): Promise<string> {
  try {
    const response = await fetch(`${OLLAMA_URL}/api/version`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return 'unknown';
    const body = (await response.json()) as { version?: string };
    return body.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function pickModel(models: readonly OllamaModel[]): string {
  if (models.length === 0) {
    fail(
      'Ollama has no models downloaded (GET /api/tags is empty). Pull one by hand first, e.g. ' +
        '`ollama pull llama3.2`; this script never pulls a model itself.',
    );
  }
  const override = process.env[MODEL_ENV]?.trim();
  if (override !== undefined && override !== '') {
    const found = models.find((model) => model.name === override);
    if (found === undefined) {
      fail(
        `${MODEL_ENV}="${override}" is not listed by GET /api/tags. Listed models: ` +
          `${models.map((model) => model.name).join(', ')}.`,
      );
    }
    return found.name;
  }
  const [smallest] = [...models].sort((a, b) => a.size - b.size);
  if (smallest === undefined) fail('unreachable: models is non-empty here');
  return smallest.name;
}

function readSdkVersions(): { openai: string; anthropic: string } {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const raw = readFileSync(path.join(here, '..', 'package.json'), 'utf8');
  const parsed = JSON.parse(raw) as { devDependencies?: Record<string, string> };
  return {
    openai: parsed.devDependencies?.openai ?? 'unknown',
    anthropic: parsed.devDependencies?.['@anthropic-ai/sdk'] ?? 'unknown',
  };
}

interface RunningTollwise {
  readonly url: string;
  readonly accessKey: string;
  close(): Promise<void>;
}

/** Starts Tollwise in-process with only the ollama provider enabled, on an ephemeral loopback port. */
async function startTollwiseForOllama(): Promise<RunningTollwise> {
  const accessKey = randomBytes(24).toString('hex');
  const config = ConfigSchema.parse({
    providers: {
      ollama: { base_url: OLLAMA_URL },
      openai: { enabled: false },
      anthropic: { enabled: false },
      deepseek: { enabled: false },
      openrouter: { enabled: false },
    },
    routing: {},
  });
  const env = {};
  const registry = buildRegistry(config, env);
  const catalog = loadCatalog();
  const logger = createLogger({ level: 'warn', sink: process.stderr });
  const server = createTollwiseServer({
    maxBodyBytes: 1024 * 1024,
    logger,
    accessKey,
    proxy: { config, catalog, registry, env },
  });
  const address = await listen(server, '127.0.0.1', 0);
  return {
    url: baseUrl('127.0.0.1', address.port),
    accessKey,
    close: () => stopServer(server, 2000),
  };
}

async function runCase(name: string, fn: () => Promise<void>): Promise<CaseResult> {
  const started = performance.now();
  try {
    await fn();
    return { case: name, pass: true, duration_ms: Math.round(performance.now() - started) };
  } catch (error) {
    return {
      case: name,
      pass: false,
      duration_ms: Math.round(performance.now() - started),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ---------------------------------------------------------------- the four SDK cases

async function caseOpenAiNonStreaming(client: OpenAI, model: string): Promise<void> {
  const { data, response } = await client.chat.completions
    .create({ model, max_completion_tokens: MAX_TOKENS, messages: PROMPT })
    .withResponse();
  const content = data.choices[0]?.message.content ?? '';
  assert.ok(content.trim().length > 0, 'expected a non-empty answer');
  assert.equal(response.headers.get('x-tollwise-provider'), 'ollama');
  assert.equal(response.headers.get('x-tollwise-translated'), 'false');
  assert.ok(response.headers.get('x-tollwise-request-id'), 'expected an x-tollwise-request-id header');
}

async function caseOpenAiStreaming(client: OpenAI, model: string): Promise<void> {
  const { data: stream, response } = await client.chat.completions
    .create({ model, max_completion_tokens: MAX_TOKENS, messages: PROMPT, stream: true })
    .withResponse();
  assert.equal(response.headers.get('x-tollwise-provider'), 'ollama');
  assert.equal(response.headers.get('x-tollwise-translated'), 'false');
  let content = '';
  for await (const chunk of stream) content += chunk.choices[0]?.delta.content ?? '';
  assert.ok(content.trim().length > 0, 'expected a non-empty streamed answer');
}

async function caseAnthropicNonStreaming(client: Anthropic, model: string): Promise<void> {
  const { data, response } = await client.messages
    .create({ model, max_tokens: MAX_TOKENS, messages: PROMPT })
    .withResponse();
  const block = data.content[0];
  const text = block?.type === 'text' ? block.text : '';
  assert.ok(text.trim().length > 0, 'expected a non-empty answer');
  assert.equal(response.headers.get('x-tollwise-provider'), 'ollama');
  assert.equal(response.headers.get('x-tollwise-translated'), 'true');
  assert.ok(response.headers.get('x-tollwise-request-id'), 'expected an x-tollwise-request-id header');
}

async function caseAnthropicStreaming(client: Anthropic, model: string): Promise<void> {
  const stream = client.messages.stream({ model, max_tokens: MAX_TOKENS, messages: PROMPT });
  const { response } = await stream.withResponse();
  assert.equal(response.headers.get('x-tollwise-provider'), 'ollama');
  assert.equal(response.headers.get('x-tollwise-translated'), 'true');
  const final = await stream.finalMessage();
  const block = final.content[0];
  const text = block?.type === 'text' ? block.text : '';
  assert.ok(text.trim().length > 0, 'expected a non-empty streamed answer');
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  console.log(`e2e-ollama: checking Ollama at ${OLLAMA_URL} ...`);
  const models = await fetchOllamaModels();
  const model = pickModel(models);
  const ollamaVersion = await fetchOllamaVersion();
  console.log(`e2e-ollama: using model "${model}" (Ollama ${ollamaVersion}); ${models.length} model(s) listed.`);

  const tollwise = await startTollwiseForOllama();
  const results: CaseResult[] = [];
  try {
    const openaiClient = new OpenAI({
      baseURL: `${tollwise.url}/v1`,
      apiKey: tollwise.accessKey,
      timeout: REQUEST_TIMEOUT_MS,
      maxRetries: 0,
      defaultHeaders: { 'x-tollwise-provider': 'ollama' },
    });
    const anthropicClient = new Anthropic({
      baseURL: tollwise.url,
      apiKey: tollwise.accessKey,
      timeout: REQUEST_TIMEOUT_MS,
      maxRetries: 0,
      defaultHeaders: { 'x-tollwise-provider': 'ollama' },
    });

    console.log('e2e-ollama: running openai SDK, non-streaming ...');
    results.push(await runCase('openai-sdk non-streaming', () => caseOpenAiNonStreaming(openaiClient, model)));
    console.log('e2e-ollama: running openai SDK, streaming ...');
    results.push(await runCase('openai-sdk streaming', () => caseOpenAiStreaming(openaiClient, model)));
    console.log('e2e-ollama: running @anthropic-ai/sdk, non-streaming (cross-format) ...');
    results.push(
      await runCase('anthropic-sdk non-streaming (cross-format)', () =>
        caseAnthropicNonStreaming(anthropicClient, model),
      ),
    );
    console.log('e2e-ollama: running @anthropic-ai/sdk, streaming (cross-format) ...');
    results.push(
      await runCase('anthropic-sdk streaming (cross-format)', () => caseAnthropicStreaming(anthropicClient, model)),
    );
  } finally {
    await tollwise.close();
  }

  const sdkVersions = readSdkVersions();
  const nowIso = new Date().toISOString();
  const record = {
    date: nowIso,
    model,
    ollama_version: ollamaVersion,
    node_version: process.version,
    sdk_versions: { openai: sdkVersions.openai, '@anthropic-ai/sdk': sdkVersions.anthropic },
    cases: results,
  };

  const here = path.dirname(fileURLToPath(import.meta.url));
  const outDir = path.join(here, '..', 'benchmarks', 'results');
  mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `e2e-ollama-${nowIso.slice(0, 10)}.json`);
  writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');

  console.log('');
  for (const result of results) {
    const suffix = result.error !== undefined ? ` -- ${result.error}` : '';
    console.log(`${result.pass ? 'PASS' : 'FAIL'}  ${result.case}  (${result.duration_ms} ms)${suffix}`);
  }
  console.log('');
  console.log(`e2e-ollama: wrote ${path.relative(process.cwd(), outPath)}`);

  const failed = results.filter((result) => !result.pass);
  if (failed.length > 0) {
    console.error(`e2e-ollama: ${failed.length} of ${results.length} case(s) failed.`);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(
    `e2e-ollama: unexpected failure: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
  process.exitCode = 1;
});
