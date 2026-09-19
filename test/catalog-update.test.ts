import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadCatalogFile, parseCatalogText } from '../src/catalog/index.ts';
import {
  applyDiff,
  computeDiff,
  displayUrl,
  formatDiff,
  isInsecureRedirect,
  parseUpstreamList,
  parseUpstreamModels,
  runCatalogUpdate,
  toTerminalText,
  UPSTREAM_ID_PATTERN,
  UpdateError,
} from '../src/catalog/update.ts';
import { OPENROUTER_MODELS_FIXTURE } from './fixtures/openrouter-models.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..');
const cliPath = path.join(repoRoot, 'src', 'cli.ts');
const fixtureCatalogPath = path.join(here, 'fixtures', 'catalog-update.yaml');
const fixtureCatalogText = readFileSync(fixtureCatalogPath, 'utf8');

const workRoot = mkdtempSync(path.join(os.tmpdir(), 'tollwise-catalog-update-test-'));
after(() => rmSync(workRoot, { recursive: true, force: true }));

let dirCounter = 0;
/** A private, writable copy of the fixture catalog file, one per test. */
function tempCatalog(text: string = fixtureCatalogText): string {
  dirCounter += 1;
  const dir = path.join(workRoot, `case-${dirCounter}`);
  mkdirSync(dir);
  const dest = path.join(dir, 'models.yaml');
  writeFileSync(dest, text, 'utf8');
  return dest;
}

/** A minimal catalog with only the "unchanged" openrouter entry -- used to exercise the true no-op case. */
const ONLY_UNCHANGED_CATALOG = `models:
  - provider: openrouter
    model: unchanged/model-a
    canonical_model: model-a
    price:
      input: 1
      output: 2
      cached_input: 0.5
    context_window: 100000
    max_output: 50000
    capabilities:
      tools: true
      json_mode: true
      vision: false
      streaming: true
    source_url: https://openrouter.ai/unchanged/model-a
    verified_on: "2026-01-01"
`;

interface FixtureServer {
  readonly url: string;
  close(): Promise<void>;
}

/** A local, loopback-only HTTP server standing in for the OpenRouter models endpoint. No network. */
function startFixtureServer(rawBody: string, status = 200): Promise<FixtureServer> {
  return new Promise((resolve) => {
    const server: Server = createServer((_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(rawBody);
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/models`,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

async function withServer<T>(rawBody: string, run: (url: string) => Promise<T>): Promise<T> {
  const server = await startFixtureServer(rawBody);
  try {
    return await run(server.url);
  } finally {
    await server.close();
  }
}

// --------------------------------------------------------------------------------
// Mapping upstream data
// --------------------------------------------------------------------------------

describe('parseUpstreamModels', () => {
  test('maps per-token USD price strings to USD per 1,000,000 tokens', () => {
    const mapped = parseUpstreamModels(OPENROUTER_MODELS_FIXTURE);
    const model = mapped.get('unchanged/model-a');
    assert.ok(model);
    assert.equal(model.price.input, 1);
    assert.equal(model.price.output, 2);
    assert.equal(model.price.cached_input, 0.5);
  });

  test('leaves cached_input unstated when the upstream entry has no input_cache_read field', () => {
    const mapped = parseUpstreamModels(OPENROUTER_MODELS_FIXTURE);
    assert.equal(mapped.get('changed/model-b')?.price.cached_input, undefined);
  });

  test('treats a negative upstream price (a dynamic-price router) as unstated, not as a price', () => {
    const mapped = parseUpstreamModels({
      data: [{ id: 'router/auto', context_length: 1000, pricing: { prompt: '-1', completion: '-1' } }],
    });
    assert.deepEqual(mapped.get('router/auto')?.price, {
      input: undefined,
      output: undefined,
      cached_input: undefined,
    });
  });

  test('maps capabilities from supported_parameters and architecture.input_modalities', () => {
    const mapped = parseUpstreamModels(OPENROUTER_MODELS_FIXTURE);
    const a = mapped.get('unchanged/model-a');
    assert.deepEqual(a?.capabilities, { tools: true, json_mode: true, vision: false });
    const b = mapped.get('changed/model-b');
    assert.deepEqual(b?.capabilities, { tools: false, json_mode: false, vision: true });
  });

  test('never maps streaming: the public list has no per-model field for it', () => {
    const mapped = parseUpstreamModels(OPENROUTER_MODELS_FIXTURE);
    assert.ok(!Object.hasOwn(mapped.get('unchanged/model-a')?.capabilities ?? {}, 'streaming'));
  });

  test('a null max_completion_tokens leaves max_output unstated instead of copying the context window', () => {
    const mapped = parseUpstreamModels(OPENROUTER_MODELS_FIXTURE);
    const c = mapped.get('new/model-c');
    assert.equal(c?.context_window, 50_000);
    assert.equal(c?.max_output, undefined);
  });

  test('an entry without supported_parameters or architecture states no capabilities', () => {
    const mapped = parseUpstreamModels(OPENROUTER_MODELS_FIXTURE);
    assert.deepEqual(mapped.get('sparse/model-e')?.capabilities, {
      tools: undefined,
      json_mode: undefined,
      vision: undefined,
    });
  });

  test('falls back to the model context_length when top_provider.context_length is null', () => {
    const mapped = parseUpstreamModels(OPENROUTER_MODELS_FIXTURE);
    assert.equal(mapped.get('sparse/model-e')?.context_window, 32_000);
  });

  test('a model with no usable context length does not abort the whole list', () => {
    const mapped = parseUpstreamModels({
      data: [
        { id: 'no/context', context_length: null, pricing: { prompt: '0.000001', completion: '0.000002' } },
        { id: 'fine/model', context_length: 8000, pricing: { prompt: '0.000001', completion: '0.000002' } },
      ],
    });
    assert.equal(mapped.get('no/context')?.context_window, undefined);
    assert.equal(mapped.get('fine/model')?.context_window, 8000);
  });

  test('rejects a response missing the top-level "data" array, with a clear message', () => {
    assert.throws(
      () => parseUpstreamModels({ models: [] }),
      (error: unknown) =>
        error instanceof UpdateError && /not shaped like the OpenRouter models list/.test(error.message),
    );
  });

  test('rejects a model entry with a non-numeric price string', () => {
    assert.throws(
      () =>
        parseUpstreamModels({
          data: [{ id: 'x', context_length: 1000, pricing: { prompt: 'free', completion: '0' } }],
        }),
      (error: unknown) => error instanceof UpdateError && /numeric price string/.test(error.message),
    );
  });
});

// --------------------------------------------------------------------------------
// numericPriceString: strict decimal shape, checked before any Number() conversion
// --------------------------------------------------------------------------------

describe('numericPriceString shape validation', () => {
  const NOT_A_DECIMAL = ['', ' ', '0x10'] as const;
  const FIELDS = ['prompt', 'completion'] as const;

  for (const badValue of NOT_A_DECIMAL) {
    for (const field of FIELDS) {
      test(`rejects ${JSON.stringify(badValue)} as pricing.${field}, naming the field without echoing the raw value`, () => {
        const pricing =
          field === 'prompt'
            ? { prompt: badValue, completion: '0.000001' }
            : { prompt: '0.000001', completion: badValue };
        assert.throws(
          () => parseUpstreamModels({ data: [{ id: 'x/y', context_length: 1000, pricing }] }),
          (error: unknown) => {
            if (!(error instanceof UpdateError)) return false;
            assert.match(
              error.message,
              new RegExp(`at "data\\.0\\.pricing\\.${field}": is not a numeric price string`),
            );
            // Number("") and Number(" ") are both 0 and Number("0x10") is 16: a check that only
            // called Number.isFinite would accept all three. The message is the fixed zod
            // refine() message, "is not a numeric price string", and must never quote the
            // rejected value itself.
            assert.equal(
              error.message,
              `the response is not shaped like the OpenRouter models list at "data.0.pricing.${field}": is not a numeric price string`,
            );
            return true;
          },
        );
      });
    }
  }

  test('"1,5" (a comma decimal separator) is still rejected', () => {
    assert.throws(
      () =>
        parseUpstreamModels({
          data: [{ id: 'x/y', context_length: 1000, pricing: { prompt: '1,5', completion: '0' } }],
        }),
      (error: unknown) => error instanceof UpdateError && /is not a numeric price string/.test(error.message),
    );
  });

  test('"Infinity" and "NaN" are still rejected', () => {
    for (const value of ['Infinity', 'NaN']) {
      assert.throws(
        () =>
          parseUpstreamModels({
            data: [{ id: 'x/y', context_length: 1000, pricing: { prompt: value, completion: '0' } }],
          }),
        (error: unknown) => error instanceof UpdateError && /is not a numeric price string/.test(error.message),
      );
    }
  });

  test('"-1", OpenRouter\'s dynamic-price marker, still passes the shape check and maps to "unstated"', () => {
    const mapped = parseUpstreamModels({
      data: [{ id: 'router/auto2', context_length: 1000, pricing: { prompt: '-1', completion: '-1' } }],
    });
    assert.deepEqual(mapped.get('router/auto2')?.price, {
      input: undefined,
      output: undefined,
      cached_input: undefined,
    });
  });

  test('ordinary decimal and exponent shapes still pass the shape check', () => {
    const mapped = parseUpstreamModels({
      data: [{ id: 'plain/model', context_length: 1000, pricing: { prompt: '0.000001', completion: '2.5e-6' } }],
    });
    assert.equal(mapped.get('plain/model')?.price.input, 1);
    assert.equal(mapped.get('plain/model')?.price.output, 2.5);
  });
});

// --------------------------------------------------------------------------------
// Diffing against the catalog
// --------------------------------------------------------------------------------

describe('computeDiff', () => {
  const catalog = loadCatalogFile(fixtureCatalogPath);
  const upstream = parseUpstreamModels(OPENROUTER_MODELS_FIXTURE);
  const diff = computeDiff(catalog, upstream);

  test('a model matching the fixture exactly counts as unchanged, not as a change', () => {
    assert.equal(diff.unchangedCount, 2);
    assert.ok(!diff.changed.some((c) => c.model === 'unchanged/model-a'));
  });

  test('fields upstream does not state are never diffed: curated max_output, cache price and capabilities stay', () => {
    // sparse/model-e: upstream has null max_completion_tokens, no input_cache_read, no
    // supported_parameters and no architecture; the catalog has streaming: false.
    assert.ok(!diff.changed.some((c) => c.model === 'sparse/model-e'));
  });

  test('a null upstream max_completion_tokens is not a change, whatever the context window', () => {
    const catalog = parseCatalogText(ONLY_UNCHANGED_CATALOG, 'test.yaml');
    const upstream = parseUpstreamModels({
      data: [
        {
          id: 'unchanged/model-a',
          context_length: 100_000,
          pricing: { prompt: '0.000001', completion: '0.000002', input_cache_read: '0.0000005' },
          top_provider: { context_length: 100_000, max_completion_tokens: null },
          supported_parameters: ['tools', 'response_format'],
          architecture: { input_modalities: ['text'] },
        },
      ],
    });
    assert.deepEqual(computeDiff(catalog, upstream).changed, []);
  });

  test('a model with a different price is reported with the exact field changes', () => {
    const changed = diff.changed.find((c) => c.model === 'changed/model-b');
    assert.ok(changed);
    assert.deepEqual(
      [...changed.changes].sort((a, b) => a.field.localeCompare(b.field)),
      [
        { field: 'price.input', from: 5, to: 4 },
        { field: 'price.output', from: 10, to: 9 },
      ],
    );
  });

  test('a model only present upstream is reported as added, not written automatically', () => {
    assert.ok(diff.added.some((a) => a.model === 'new/model-c'));
  });

  test('a catalog entry no longer offered upstream is reported as removed', () => {
    assert.deepEqual(diff.removed, ['gone/model-d']);
  });

  test('non-openrouter entries are never touched by the diff', () => {
    const mentioned = [...diff.changed.map((c) => c.model), ...diff.added.map((a) => a.model), ...diff.removed];
    assert.ok(!mentioned.includes('gpt-6-astra'));
  });
});

describe('formatDiff', () => {
  test('renders a human-readable report naming the changed fields and old/new values', () => {
    const catalog = loadCatalogFile(fixtureCatalogPath);
    const upstream = parseUpstreamModels(OPENROUTER_MODELS_FIXTURE);
    const report = formatDiff(computeDiff(catalog, upstream), 'https://openrouter.ai/api/v1/models');

    assert.match(report, /openrouter\/changed\/model-b/);
    assert.match(report, /price\.input: 5 -> 4/);
    assert.match(report, /price\.output: 10 -> 9/);
    assert.match(report, /new\/model-c/);
    assert.match(report, /gone\/model-d/);
    assert.match(report, /Unchanged: 2/);
    assert.doesNotMatch(report, /max_output/);
    assert.doesNotMatch(report, /streaming/);
  });

  test('a catalog matching upstream exactly reports no changes', () => {
    const catalog = parseCatalogText(ONLY_UNCHANGED_CATALOG, 'test.yaml');
    const upstream = new Map(
      [...parseUpstreamModels(OPENROUTER_MODELS_FIXTURE)].filter(([id]) => id === 'unchanged/model-a'),
    );
    const report = formatDiff(computeDiff(catalog, upstream), 'https://openrouter.ai/api/v1/models');
    assert.match(report, /No changes: 1 entry matches\./);
  });
});

// --------------------------------------------------------------------------------
// Applying a diff with the yaml Document API
// --------------------------------------------------------------------------------

describe('applyDiff', () => {
  test('updates only the changed fields plus verified_on, preserving comments and order', () => {
    const catalog = loadCatalogFile(fixtureCatalogPath);
    const upstream = parseUpstreamModels(OPENROUTER_MODELS_FIXTURE);
    const diff = computeDiff(catalog, upstream);
    const updatedText = applyDiff(fixtureCatalogText, diff, '2026-09-19');

    // Comments and the file's own structure survive.
    assert.match(updatedText, /# A direct \(non-openrouter\) entry: catalog update must never touch it\./);
    assert.match(updatedText, /# Not in the upstream fixture: expect it reported as "removed"/);

    // Re-validates with the same loader the running proxy uses.
    const updated = parseCatalogText(updatedText, 'models.yaml');

    const changedEntry = updated.models.find((m) => m.provider === 'openrouter' && m.model === 'changed/model-b');
    assert.equal(changedEntry?.price.input, 4);
    assert.equal(changedEntry?.price.output, 9);
    assert.equal(changedEntry?.price.cached_input, null);
    assert.equal(changedEntry?.verified_on, '2026-09-19');

    // Untouched entries keep their original verified_on and values.
    const unchangedEntry = updated.models.find((m) => m.provider === 'openrouter' && m.model === 'unchanged/model-a');
    assert.equal(unchangedEntry?.verified_on, '2026-01-01');
    const sparseEntry = updated.models.find((m) => m.provider === 'openrouter' && m.model === 'sparse/model-e');
    assert.equal(sparseEntry?.max_output, 8000);
    assert.equal(sparseEntry?.price.cached_input, 0.1);
    assert.equal(sparseEntry?.capabilities.streaming, false);
    assert.equal(sparseEntry?.verified_on, '2026-01-01');
    const goneEntry = updated.models.find((m) => m.provider === 'openrouter' && m.model === 'gone/model-d');
    assert.equal(goneEntry?.verified_on, '2026-01-01');
    const directEntry = updated.models.find((m) => m.provider === 'openai');
    assert.equal(directEntry?.verified_on, '2026-01-01');
    assert.equal(directEntry?.price.input, 10);

    // Entry order is unchanged.
    assert.deepEqual(
      updated.models.map((m) => `${m.provider}/${m.model}`),
      catalog.models.map((m) => `${m.provider}/${m.model}`),
    );
  });

  test('returns the text unchanged when there is nothing to change', () => {
    const diff = { changed: [], added: [], removed: [], unchangedCount: 4 };
    assert.equal(applyDiff(fixtureCatalogText, diff, '2026-09-19'), fixtureCatalogText);
  });
});

// --------------------------------------------------------------------------------
// The end-to-end command: fetch (local server only) + diff + optional write
// --------------------------------------------------------------------------------

describe('runCatalogUpdate', () => {
  test('without --write, nothing on disk changes even when there are differences', async () => {
    await withServer(JSON.stringify(OPENROUTER_MODELS_FIXTURE), async (url) => {
      const catalogPath = tempCatalog();
      const result = await runCatalogUpdate({ sourceUrl: url, catalogPath });
      assert.equal(result.wrote, false);
      assert.ok(result.diff.changed.length > 0);
      assert.equal(readFileSync(catalogPath, 'utf8'), fixtureCatalogText);
    });
  });

  test('--write is a no-op when nothing changed', async () => {
    const onlyUnchangedFixture = JSON.stringify({
      data: [...OPENROUTER_MODELS_FIXTURE.data.filter((m) => m.id === 'unchanged/model-a')],
    });
    await withServer(onlyUnchangedFixture, async (url) => {
      const catalogPath = tempCatalog(ONLY_UNCHANGED_CATALOG);
      const result = await runCatalogUpdate({ sourceUrl: url, catalogPath, write: true });
      assert.equal(result.wrote, false);
      assert.equal(readFileSync(catalogPath, 'utf8'), ONLY_UNCHANGED_CATALOG);
    });
  });

  test('--write updates the changed fields and the result re-validates with the catalog loader', async () => {
    await withServer(JSON.stringify(OPENROUTER_MODELS_FIXTURE), async (url) => {
      const catalogPath = tempCatalog();
      const result = await runCatalogUpdate({ sourceUrl: url, catalogPath, write: true });
      assert.equal(result.wrote, true);

      const reloaded = loadCatalogFile(catalogPath);
      const changedEntry = reloaded.models.find((m) => m.provider === 'openrouter' && m.model === 'changed/model-b');
      assert.equal(changedEntry?.price.input, 4);
      assert.equal(changedEntry?.price.output, 9);
      assert.equal(changedEntry?.verified_on, new Date().toISOString().slice(0, 10));
      // Upstream states nothing about these: the curated values survive the write.
      assert.equal(changedEntry?.max_output, 100_000);
      const sparseEntry = reloaded.models.find((m) => m.provider === 'openrouter' && m.model === 'sparse/model-e');
      assert.equal(sparseEntry?.max_output, 8000);
      assert.equal(sparseEntry?.capabilities.streaming, false);
      // No temporary file is left next to the catalog.
      assert.deepEqual(readdirSync(path.dirname(catalogPath)), ['models.yaml']);
    });
  });

  test('a malformed upstream answer gives a clear error and writes nothing', async () => {
    await withServer(JSON.stringify({ models: 'not-the-right-shape' }), async (url) => {
      const catalogPath = tempCatalog();
      await assert.rejects(
        runCatalogUpdate({ sourceUrl: url, catalogPath, write: true }),
        (error: unknown) =>
          error instanceof UpdateError && /not shaped like the OpenRouter models list/.test(error.message),
      );
      assert.equal(readFileSync(catalogPath, 'utf8'), fixtureCatalogText);
    });
  });

  test('a non-JSON upstream answer gives a clear error and writes nothing', async () => {
    await withServer('<html>not json</html>', async (url) => {
      const catalogPath = tempCatalog();
      await assert.rejects(
        runCatalogUpdate({ sourceUrl: url, catalogPath, write: true }),
        (error: unknown) => error instanceof UpdateError && /not valid JSON/.test(error.message),
      );
      assert.equal(readFileSync(catalogPath, 'utf8'), fixtureCatalogText);
    });
  });

  test('an HTTP error status from the source is reported clearly', async () => {
    const server = await startFixtureServer('server error', 500);
    try {
      const catalogPath = tempCatalog();
      await assert.rejects(
        runCatalogUpdate({ sourceUrl: server.url, catalogPath }),
        (error: unknown) => error instanceof UpdateError && /HTTP 500/.test(error.message),
      );
    } finally {
      await server.close();
    }
  });

  test('rejects a non-http(s) source URL before making any request', async () => {
    const catalogPath = tempCatalog();
    await assert.rejects(
      runCatalogUpdate({ sourceUrl: 'ftp://example.com/models', catalogPath }),
      (error: unknown) => error instanceof UpdateError && /unsupported URL scheme "ftp:"/.test(error.message),
    );
  });

  test('bounds the size of the upstream response', async () => {
    await withServer(JSON.stringify(OPENROUTER_MODELS_FIXTURE), async (url) => {
      const catalogPath = tempCatalog();
      await assert.rejects(
        runCatalogUpdate({ sourceUrl: url, catalogPath, maxResponseBytes: 16 }),
        (error: unknown) => error instanceof UpdateError && /exceeds the 16-byte limit/.test(error.message),
      );
    });
  });
});

// --------------------------------------------------------------------------------
// isInsecureRedirect: the pure decision behind the https-to-http redirect refusal.
//
// An https test server would need a certificate/key file, and *.key/*.pem are git-ignored, so
// the redirect decision is exercised here as a pure function and, below, with a stubbed fetch --
// neither needs a real TLS server or the network.
// --------------------------------------------------------------------------------

describe('isInsecureRedirect', () => {
  test('an https source redirected to a non-https URL is insecure', () => {
    assert.equal(isInsecureRedirect('https://example.com/models', 'http://example.com/models'), true);
  });

  test('an https source redirected to another https URL is allowed', () => {
    assert.equal(isInsecureRedirect('https://example.com/models', 'https://mirror.example.com/models'), false);
  });

  test('a plain http source redirected to http is allowed (an existing recorded default)', () => {
    assert.equal(isInsecureRedirect('http://example.com/models', 'http://example.com/models'), false);
  });

  test('an empty final URL (no redirect reported) is allowed', () => {
    assert.equal(isInsecureRedirect('https://example.com/models', ''), false);
  });
});

// --------------------------------------------------------------------------------
// The redirect guard wired into fetchUpstreamJson, via runCatalogUpdate: a stubbed global fetch
// stands in for a redirecting https server, so no certificate and no network are needed.
// --------------------------------------------------------------------------------

describe('runCatalogUpdate: refuses an https source redirected to a non-https URL', () => {
  test('fails with the redirect UpdateError and writes nothing', async (t) => {
    const originalFetch = globalThis.fetch;
    t.after(() => {
      globalThis.fetch = originalFetch;
    });
    const requestedUrl = 'https://example.com/models';
    const fakeResponse = {
      url: 'http://example.com/models',
      ok: true,
      body: undefined,
      text: () => Promise.resolve(JSON.stringify(OPENROUTER_MODELS_FIXTURE)),
    } as unknown as Response;
    globalThis.fetch = (() => Promise.resolve(fakeResponse)) as typeof fetch;

    const catalogPath = tempCatalog();
    await assert.rejects(
      runCatalogUpdate({ sourceUrl: requestedUrl, catalogPath, write: true }),
      (error: unknown) =>
        error instanceof UpdateError &&
        error.message === `fetching ${requestedUrl} failed: it redirected to a non-https URL`,
    );
    assert.equal(readFileSync(catalogPath, 'utf8'), fixtureCatalogText);
  });
});

// --------------------------------------------------------------------------------
// CLI wiring (src/cli.ts "catalog update")
// --------------------------------------------------------------------------------

function runCli(args: readonly string[]) {
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' });
}

interface CliResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs the CLI as a child process without blocking this process's event loop, so the fixture
 * server started by the same test can answer the child's request (spawnSync would deadlock).
 */
function runCliAsync(args: readonly string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('tollwise catalog update (CLI)', () => {
  test('--help prints usage and exits 0', () => {
    const result = runCli(['catalog', 'update', '--help']);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Usage: tollwise catalog update/);
  });

  test('an unknown catalog command exits 2', () => {
    const result = runCli(['catalog', 'frobnicate']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown catalog command "frobnicate"/);
  });

  test('an unknown option exits 2', () => {
    const result = runCli(['catalog', 'update', '--bogus']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown option "--bogus"/);
  });

  test('--catalog without a path is a usage error, exit 2', () => {
    const result = runCli(['catalog', 'update', '--catalog']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--catalog needs a path/);
  });

  test('--source-url given twice is a usage error, exit 2', () => {
    const result = runCli(['catalog', 'update', '--source-url', 'http://a', '--source-url', 'http://b']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--source-url given more than once/);
  });

  test('an unsupported URL scheme exits 1 with a clear message, without --write', () => {
    const result = runCli(['catalog', 'update', '--source-url', 'ftp://example.com/models']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unsupported URL scheme "ftp:"/);
  });

  test('end to end without --write: prints the diff and the --write hint, exits 0, changes nothing', async () => {
    await withServer(JSON.stringify(OPENROUTER_MODELS_FIXTURE), async (url) => {
      const catalogPath = tempCatalog();
      const result = await runCliAsync(['catalog', 'update', '--source-url', url, '--catalog', catalogPath]);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /openrouter\/changed\/model-b/);
      assert.match(result.stdout, /price\.input: 5 -> 4/);
      assert.match(result.stdout, /price\.output: 10 -> 9/);
      assert.match(result.stdout, /new\/model-c/);
      assert.match(result.stdout, /gone\/model-d/);
      assert.match(result.stdout, /Run again with --write to apply the changed fields above\./);
      assert.equal(result.stderr, '');
      assert.equal(readFileSync(catalogPath, 'utf8'), fixtureCatalogText);
    });
  });

  test('end to end with --write: updates the file, which re-validates, and says so', async () => {
    await withServer(JSON.stringify(OPENROUTER_MODELS_FIXTURE), async (url) => {
      const catalogPath = tempCatalog();
      const result = await runCliAsync(['catalog', 'update', '--write', '--source-url', url, '--catalog', catalogPath]);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /Wrote 1 changed model to /);
      const reloaded = loadCatalogFile(catalogPath);
      const changedEntry = reloaded.models.find((m) => m.provider === 'openrouter' && m.model === 'changed/model-b');
      assert.equal(changedEntry?.price.input, 4);
      assert.equal(changedEntry?.price.output, 9);
      assert.match(readFileSync(catalogPath, 'utf8'), /# A direct \(non-openrouter\) entry/);
    });
  });

  test('end to end with a malformed upstream answer: exits 1 with a clear message, writes nothing', async () => {
    await withServer(JSON.stringify({ models: 'not-the-right-shape' }), async (url) => {
      const catalogPath = tempCatalog();
      const result = await runCliAsync(['catalog', 'update', '--write', '--source-url', url, '--catalog', catalogPath]);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /not shaped like the OpenRouter models list/);
      assert.equal(readFileSync(catalogPath, 'utf8'), fixtureCatalogText);
    });
  });

  test('end to end with an invalid catalog file: exits 1 naming the problem, no stack trace', async () => {
    await withServer(JSON.stringify(OPENROUTER_MODELS_FIXTURE), async (url) => {
      const broken = fixtureCatalogText.replace('input: 5', 'input: -5');
      const catalogPath = tempCatalog(broken);
      const result = await runCliAsync(['catalog', 'update', '--source-url', url, '--catalog', catalogPath]);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /Invalid catalog/);
      assert.match(result.stderr, /price\.input/);
      assert.doesNotMatch(result.stderr, /\n\s+at /);
      assert.equal(readFileSync(catalogPath, 'utf8'), broken);
    });
  });
});

describe('tollwise catalog update --write: strict price-string validation (CLI)', () => {
  const NOT_A_DECIMAL = ['', ' ', '0x10'] as const;
  const FIELDS = ['prompt', 'completion'] as const;

  for (const badValue of NOT_A_DECIMAL) {
    for (const field of FIELDS) {
      test(`--write exits non-zero for pricing.${field} = ${JSON.stringify(badValue)}, naming the field, catalog untouched`, async () => {
        const pricing =
          field === 'prompt'
            ? { prompt: badValue, completion: '0.000001' }
            : { prompt: '0.000001', completion: badValue };
        const body = JSON.stringify({
          data: [{ id: 'x/y', context_length: 1000, pricing }],
        });
        const catalogPath = tempCatalog();
        const result = await withServer(body, (url) =>
          runCliAsync(['catalog', 'update', '--write', '--source-url', url, '--catalog', catalogPath]),
        );
        assert.notEqual(result.code, 0);
        assert.equal(result.stdout, '');
        assert.equal(
          result.stderr,
          `tollwise: the response is not shaped like the OpenRouter models list at "data.0.pricing.${field}": is not a numeric price string\n`,
        );
        assertTerminalSafe(result.stderr);
        // The catalog file is byte-identical to what it was before the run.
        assert.equal(readFileSync(catalogPath, 'utf8'), fixtureCatalogText);
      });
    }
  }

  test('"-1" still behaves as before with --write: the CLI treats it as unstated, not as an error', async () => {
    const body = JSON.stringify({
      data: [{ id: 'unchanged/model-a', context_length: 100_000, pricing: { prompt: '-1', completion: '-1' } }],
    });
    const catalogPath = tempCatalog();
    const result = await withServer(body, (url) =>
      runCliAsync(['catalog', 'update', '--write', '--source-url', url, '--catalog', catalogPath]),
    );
    assert.equal(result.code, 0, result.stderr);
    // Only fields upstream actually states are compared: a "-1" price never becomes a diff.
    assert.doesNotMatch(result.stdout, /price\.input|price\.output/);
    assert.equal(readFileSync(catalogPath, 'utf8'), fixtureCatalogText);
  });
});

// --------------------------------------------------------------------------------
// Untrusted upstream text never reaches the terminal raw
// --------------------------------------------------------------------------------

// Built from code points so this file itself carries no raw control characters.
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const C1_CSI = String.fromCharCode(0x9b);
const RTL_OVERRIDE = String.fromCharCode(0x202e);

/** The visible escape toTerminalText prints for a code point, e.g. backslash, "u", "001b". */
function shown(code: number): string {
  return `\\u${code.toString(16).padStart(4, '0')}`;
}

/** An id carrying a clear-screen, an OSC window-title write, colour codes and a CRLF that forges a line. */
const HOSTILE_ID = `evil/${ESC}[2J${ESC}]0;pwned${BEL}${ESC}[31mRED\r\nFAKE line`;

/** Fails if the output holds a raw control character (C0 except LF, DEL, C1) -- ESC and CR included. */
function assertTerminalSafe(output: string): void {
  const raw = [...output].find((char) => {
    const code = char.codePointAt(0) ?? 0;
    return (code <= 0x1f && code !== 0x0a) || (code >= 0x7f && code <= 0x9f);
  });
  assert.equal(raw, undefined, `raw control character in: ${JSON.stringify(output)}`);
}

describe('terminal safety', () => {
  test('toTerminalText escapes ESC, BEL, CR, LF, C1 and bidi overrides into visible text', () => {
    assert.equal(
      toTerminalText(`a${ESC}[31mb${BEL}c\r\nd${C1_CSI}e${RTL_OVERRIDE}f`),
      `a${shown(0x1b)}[31mb${shown(0x07)}c${shown(0x0d)}${shown(0x0a)}d${shown(0x9b)}e${shown(0x202e)}f`,
    );
  });

  test('toTerminalText with keepNewlines keeps LF only', () => {
    assert.equal(toTerminalText(`one\r\ntwo${ESC}`, { keepNewlines: true }), `one${shown(0x0d)}\ntwo${shown(0x1b)}`);
  });

  test('displayUrl drops user:password from a URL', () => {
    assert.equal(displayUrl('https://user:pass@example.com/models'), 'https://example.com/models');
  });

  test('a source URL carrying a user name or password is refused without printing them', async () => {
    await assert.rejects(
      () => runCatalogUpdate({ sourceUrl: 'https://user:hunter2@example.com/models', catalogPath: tempCatalog() }),
      (error: unknown) =>
        error instanceof UpdateError &&
        error.message === 'the source URL https://example.com/models must not contain a user name or password',
    );
  });

  test('the id pattern accepts real-shaped ids and rejects control characters and spaces', () => {
    for (const id of ['anthropic/claude-sonnet-4.5', 'meta-llama/llama-3.1-8b-instruct:free', '~openai/gpt-latest']) {
      assert.match(id, UPSTREAM_ID_PATTERN);
    }
    const nonAscii = `caf${String.fromCharCode(0xe9)}/model`;
    for (const id of [HOSTILE_ID, 'a b', '', 'x'.repeat(201), nonAscii]) {
      assert.doesNotMatch(id, UPSTREAM_ID_PATTERN);
    }
  });

  test('an entry with a hostile id is skipped and its position recorded; the others are kept', () => {
    const list = parseUpstreamList({
      data: [
        ...OPENROUTER_MODELS_FIXTURE.data,
        { id: HOSTILE_ID, context_length: 1000, pricing: { prompt: '0', completion: '0' } },
      ],
    });
    assert.deepEqual(list.skipped, [OPENROUTER_MODELS_FIXTURE.data.length]);
    assert.equal(list.models.size, OPENROUTER_MODELS_FIXTURE.data.length);
    assert.equal(
      [...list.models.keys()].some((id) => id.startsWith('evil/')),
      false,
    );
  });

  test('rejects oversized supported_parameters and input_modalities, with a clear message', () => {
    const base = { id: 'x/y', context_length: 1000, pricing: { prompt: '0', completion: '0' } };
    for (const extra of [
      { supported_parameters: Array.from({ length: 257 }, (_, i) => `p${i}`) },
      { supported_parameters: ['p'.repeat(129)] },
      { architecture: { input_modalities: Array.from({ length: 33 }, () => 'text') } },
      { architecture: { input_modalities: ['m'.repeat(65)] } },
    ]) {
      assert.throws(
        () => parseUpstreamModels({ data: [{ ...base, ...extra }] }),
        (error: unknown) =>
          error instanceof UpdateError &&
          /not shaped like the OpenRouter models list at "data\.0\./.test(error.message),
      );
    }
  });

  test('formatDiff escapes control characters in any model id it prints', () => {
    const report = formatDiff(
      { changed: [], added: [], removed: [`local/${ESC}[31mred\r\nFAKE`], unchangedCount: 0 },
      'http://127.0.0.1/models',
    );
    assertTerminalSafe(report);
    assert.ok(report.includes(`  openrouter/local/${shown(0x1b)}[31mred${shown(0x0d)}${shown(0x0a)}FAKE\n`));
  });

  test('CLI: a hostile upstream id prints no escape sequence and forges no line', async () => {
    const body = JSON.stringify({
      data: [
        ...OPENROUTER_MODELS_FIXTURE.data,
        { id: HOSTILE_ID, context_length: 1000, pricing: { prompt: '0', completion: '0' } },
      ],
    });
    const catalogPath = tempCatalog();
    const result = await withServer(body, (url) =>
      runCliAsync(['catalog', 'update', '--source-url', url, '--catalog', catalogPath]),
    );
    assert.equal(result.code, 0, result.stderr);
    assertTerminalSafe(result.stdout);
    assertTerminalSafe(result.stderr);
    assert.equal(result.stderr, '');
    assert.doesNotMatch(result.stdout, /pwned|FAKE line/);
    assert.match(result.stdout, /Ignored 1 upstream entry whose id is not a plain model id \(data\[4\]\)\./);
    // Same report as for the clean list, plus exactly the "Ignored" line and its blank separator.
    const clean = await withServer(JSON.stringify(OPENROUTER_MODELS_FIXTURE), (url) =>
      runCliAsync(['catalog', 'update', '--source-url', url, '--catalog', catalogPath]),
    );
    assert.equal(clean.code, 0, clean.stderr);
    assert.equal(result.stdout.split('\n').length, clean.stdout.split('\n').length + 2);
    assert.equal(readFileSync(catalogPath, 'utf8'), fixtureCatalogText);
  });

  test('CLI: a hostile non-JSON body is not echoed; one clean error line, nothing written', async () => {
    const catalogPath = tempCatalog();
    await withServer(`{"data": [ ${ESC}[31mSECRET\r\nFAKE line${BEL}`, async (url) => {
      const result = await runCliAsync(['catalog', 'update', '--write', '--source-url', url, '--catalog', catalogPath]);
      assert.equal(result.code, 1);
      assertTerminalSafe(result.stdout);
      assertTerminalSafe(result.stderr);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, `tollwise: the response from ${url} is not valid JSON\n`);
    });
    assert.equal(readFileSync(catalogPath, 'utf8'), fixtureCatalogText);
  });

  test('CLI: a hostile value in a malformed entry is not echoed either', async () => {
    const body = JSON.stringify({
      data: [{ id: 'x/y', context_length: 1000, pricing: { prompt: `${ESC}]0;pwned${BEL}`, completion: '0' } }],
    });
    const catalogPath = tempCatalog();
    const result = await withServer(body, (url) =>
      runCliAsync(['catalog', 'update', '--write', '--source-url', url, '--catalog', catalogPath]),
    );
    assert.equal(result.code, 1);
    assertTerminalSafe(result.stderr);
    assert.doesNotMatch(result.stderr, /pwned/);
    assert.equal(result.stderr.split('\n').length, 2);
    assert.match(result.stderr, /at "data\.0\.pricing\.prompt": is not a numeric price string/);
    assert.equal(readFileSync(catalogPath, 'utf8'), fixtureCatalogText);
  });
});
