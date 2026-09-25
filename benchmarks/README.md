# Benchmarks

Opt-in measurements and end-to-end checks. None of these run as part of `npm test` or
`npm run check`; run each by hand.

## `npm run bench:overhead`

Measures the latency and memory Tollwise itself adds over a zero-latency mock provider. See the
"Proxy overhead" section of [`docs/benchmarks.md`](../docs/benchmarks.md) for the method and the
published numbers. Writes `benchmarks/results/overhead-<UTC date>.json`.

## `npm run bench:savings`

Replays two fixed, seeded workloads of chat requests through a real in-process Tollwise against two
mock providers, priced with `catalog/models.yaml`, once per routing policy: the default
configuration (provider switching only) and a realistic workload with the opt-in `frontier` and
`small-fast` [equivalence presets](../docs/equivalence-presets.md) turned on. These are **modeled**
savings, never a measurement of real provider bills; see the "Savings (modeled)" section of
[`docs/benchmarks.md`](../docs/benchmarks.md) for the full method and the published numbers. Writes a
new `benchmarks/results/savings-<UTC date>.json` (`savings-<UTC date>-2.json` and so on when that
name is taken; an existing results file is never overwritten).

`node benchmarks/savings.ts --verify-latest` replays every scenario without writing anything and
exits 0 only when every number equals the newest `benchmarks/results/savings-*.json`.

## `npm run e2e:ollama`

Runs the official `openai` and `@anthropic-ai/sdk` packages, unmodified, against a real local
[Ollama](https://ollama.com) instance through an in-process Tollwise, both non-streaming and
streaming, in the OpenAI wire format (no translation) and the Anthropic wire format
(cross-format translation, since Ollama only speaks OpenAI's format).

Requirements:

- Ollama running locally (`ollama serve`), reachable at `127.0.0.1:11434`.
- At least one model already pulled (`ollama pull <model>`). The script never pulls a model
  itself; it picks the smallest one already listed by `GET /api/tags`, or the model named by
  `TOLLWISE_E2E_MODEL` when that model is one of the ones listed.

Run it with:

```
npm run e2e:ollama
```

It writes a JSON record to `benchmarks/results/e2e-ollama-<UTC date>.json`: the model and Ollama
version used, the Node and SDK versions, and a pass/fail with duration for each of the four cases.
No API key of any kind is needed or printed; Tollwise runs with only the local Ollama provider
configured, so this never reaches a paid provider.
