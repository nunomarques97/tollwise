# Benchmarks

Tollwise's own latency and memory numbers, measured on a real, local run, and its modeled cost
savings, computed from public list prices; each with the method that produced it and the exact
command to reproduce it.

## Proxy overhead (`npm run bench:overhead`)

`benchmarks/overhead.ts` measures how much latency and memory Tollwise itself adds over the
provider it forwards to, using a provider with no latency of its own so any difference is Tollwise's.
It never runs as part of `npm test` or `npm run check`; run it by hand.

### Method

1. Start the shared mock provider (`test/fixtures/mock-provider.ts`) with zero injected latency
   (`latencyMs: 0`, `firstByteDelayMs: 0`). Its own response time is the floor everything else is
   measured against.
2. **Startup**: spawn the real `node src/cli.ts start`, unmodified, against a configuration file
   pointing its one enabled provider at the mock, and time wall-clock from `spawn()` to the first
   `200` from `GET /healthz`. Repeated 5 times; the reported figure is the median. The first spawn
   of a run is usually much slower (a cold start, most likely because files are not yet in the
   operating system's cache); it is kept in the raw data, and the median keeps it from dominating the reported figure.
3. **Idle memory**: spawn one more such process and leave it idle for 500 ms after it answers ready,
   then read its own resident set size from the operating system (`Get-Process ... WorkingSet64` on
   Windows, `ps -o rss=` elsewhere) -- never `process.memoryUsage()` of the benchmark script's own
   process, which also carries the load-testing tool and would overstate the number.
4. **Non-streaming overhead**: send the exact same `POST /v1/chat/completions` JSON body, with
   [autocannon](https://github.com/mcollina/autocannon) (10 connections, 8 seconds), straight to the
   mock provider and through the running Tollwise. The reported overhead is Tollwise's p50/p99 latency
   minus the mock's own. Two limits of this number: autocannon records latency in whole milliseconds,
   so both figures are accurate to about ±1 ms; and with 10 concurrent connections each latency
   includes time a request spends queued behind the others, so the overhead is measured under that
   load, not for one request in isolation.
5. **Streaming first-byte overhead**: send the same body with `stream: true`, direct and through
   Tollwise, 30 times each, timing by hand from the start of the request to the first chunk read from
   the response body (autocannon does not expose per-request time-to-first-byte for an open SSE
   response). The reported overhead is the median of one population minus the median of the other.

Every server involved binds to `127.0.0.1` only. The one provider key used is a fixed placeholder
string with no real-key shape, read from an environment variable created only for this run; the
analytics database Tollwise writes to lives under a temporary directory for the duration of the run
and is deleted afterwards, never under `/data/`.

### Reproduce

```
npm run bench:overhead
```

Requires nothing beyond what `npm ci` already installs; makes no network call outside `127.0.0.1` and
no call to a paid provider. Writes `benchmarks/results/overhead-<UTC date>.json`: every raw number,
the machine (CPU model, core count, RAM, OS -- never a host or user name), the Node version, the
Tollwise git commit and this exact command. `tollwise_dirty` is `true` when the working tree had
uncommitted changes at the time of the run; the commit alone then does not fully identify the code
that was measured.

### Results

Measured 2026-09-19 on an Intel(R) Core(TM) i5-14400F (16 logical cores), 31.8 GB RAM, Windows_NT
10.0.26200 (win32/x64), Node v24.14.0, commit `9dddada7d1fbbe5d7fac7421d09a0aba73c4b4f9`. Raw data:
[`benchmarks/results/overhead-2026-09-19.json`](../benchmarks/results/overhead-2026-09-19.json).
That file records `tollwise_dirty: true`: the only uncommitted changes at the time were the benchmark
itself and its tooling configuration. `src/`, `test/` and `scripts/` were identical to that commit, so
the code measured is exactly the commit's code. In the startup runs (2538, 396, 408, 410 and 402 ms),
the first spawn is the cold start described in the method.

| Metric | Target | Measured | Result |
|---|---|---|---|
| Non-streaming overhead, p50 | ≤ 5 ms | 2 ms | met |
| Non-streaming overhead, p99 | ≤ 20 ms | 5 ms | met |
| Streaming first-byte overhead, p50 | ≤ 10 ms | 1.19 ms | met |
| Startup (spawn to `/healthz` 200), median of 5 | ≤ 2000 ms | 408.06 ms | met |
| Idle resident memory | ≤ 150 MB | 140.7 MB | met |

Every target was met on this run. A future run that misses one is published exactly as measured, in
the same table, with the miss named rather than rounded away or dropped; the script also exits
with a non-zero code and names every missed target.

These are proxy-only numbers against a zero-latency mock: they say nothing about the time a real
provider itself takes to answer, only what Tollwise adds on top of it. Re-run the command above after
any change to the request/response hot path (routing, translation, cost accounting) to catch a
regression before it reaches a release.


## Savings (modeled)

**These numbers are modeled, not measured.** They are computed from the public list prices in
[`catalog/models.yaml`](../catalog/models.yaml), never from a real provider bill: no real provider
is ever called. `benchmarks/savings.ts` replays fixed, seeded workloads of chat requests through a
real, in-process Tollwise (`createTollwiseServer`, the same code that serves production traffic)
against two mock HTTP servers the script starts itself, one shaped like the OpenAI Chat Completions
API and one like the Anthropic Messages API. The token counts come from a documented approximation
and the provider latencies are assumptions, so these figures cannot tell you how much you would save
on your own traffic; only your own requests, against your own provider bills, can. What they do show,
reproducibly, is what Tollwise's routing and cost accounting (`src/routing/select.ts`,
`src/pricing/cost.ts`) compute for a written-down mix of requests at dated public prices.

**By default Tollwise only switches providers.** With the default configuration a request is only
ever moved to another provider serving the same model. Serving it with a different, cheaper model of
the same class is **opt-in**: it happens only inside the [equivalence presets](equivalence-presets.md)
or groups your configuration turns on, and every substitution is visible in the `x-tollwise-*`
response headers, the routing trace and the dashboard. Substituted models do not give identical
answers; Tollwise measures no answer quality.

### Results

Run on 2026-09-25 with catalog prices verified on 2026-09-19. Raw data:
[`benchmarks/results/savings-2026-09-25.json`](../benchmarks/results/savings-2026-09-25.json), which
also records the Node version and the git commit of the run.

| Scenario | Workload | Policy | Total cost | Total baseline | Total savings | Savings | Substituted requests |
|---|---|---|---|---|---|---|---|
| default | mixed | cheapest | $0.199247 | $0.199487 | $0.000240 | 0.12% | 0 |
| default | mixed | fastest | $0.199247 | $0.199487 | $0.000240 | 0.12% | 0 |
| default | mixed | balanced | $0.199247 | $0.199487 | $0.000240 | 0.12% | 0 |
| realistic-default | realistic | cheapest | $0.273664 | $0.273849 | $0.000185 | 0.07% | 0 |
| realistic-default | realistic | fastest | $0.273664 | $0.273849 | $0.000185 | 0.07% | 0 |
| realistic-default | realistic | balanced | $0.273664 | $0.273849 | $0.000185 | 0.07% | 0 |
| presets-on | realistic | cheapest | $0.043280 | $0.273849 | $0.230569 | 84.2% | 87 |
| presets-on | realistic | fastest | $0.239448 | $0.274299 | $0.034851 | 12.71% | 60 |
| presets-on | realistic | balanced | $0.050510 | $0.273849 | $0.223339 | 81.56% | 63 |

- **default**: the mixed workload with the default configuration, so provider switching only.
- **realistic-default**: the realistic workload with the same default configuration, the control for
  the rows below it.
- **presets-on**: the realistic workload with `routing.equivalence_presets: [frontier, small-fast]`.

"Total baseline" is the sum, over every request whose requested model has a catalog price, of what
that request would have cost on the model it asked for. An unpriced baseline is `unknown`, never a
silent $0, and is left out of both totals; none occurred (`unknown_baseline: 0` on every run of the
raw JSON).

**With the presets on, `cheapest` routing saves 84.2% of the modeled baseline of the realistic
workload; with the default configuration the same workload saves 0.07%.** Almost every model this
workload names costs the same on its own provider and on the OpenRouter mirror of the same model, so
provider switching alone finds little: the default-configuration savings come only from
`deepseek-v4-pro` requests, whose OpenRouter mirror is priced lower than DeepSeek's direct price. The
presets let routing serve a request with the cheapest model of its class that has every capability
the request uses.

Substituted requests per served model, read from each answer's `x-tollwise-substituted`,
`x-tollwise-provider`, `x-tollwise-model` and `x-tollwise-equivalence-group` headers (the benchmark
fails if they disagree with the request outcome the proxy recorded):

- `cheapest`, 87 in all: 61 served by `deepseek-flash` on `deepseek` (group `small-fast`); 24 by `deepseek/deepseek-v4-pro-0813` on `openrouter` (group `frontier`); 2 by `claude-opus-5` on `anthropic` (group `frontier`).
- `fastest`, 60 in all: 42 served by `claude-haiku-4-5-20251001` on `anthropic` (group `small-fast`); 18 by `claude-opus-5` on `anthropic` (group `frontier`).
- `balanced`, 63 in all: 37 served by `gpt-5.6-luna` on `openai` (group `small-fast`); 24 by `deepseek/deepseek-v4-pro-0813` on `openrouter` (group `frontier`); 2 by `claude-opus-5` on `anthropic` (group `frontier`).

How each policy uses the presets:

- `cheapest` sends small-fast requests to `deepseek-flash` and frontier requests to the OpenRouter
  mirror of `deepseek-v4-pro`. Frontier vision requests cannot go there (`deepseek-v4-pro` has no
  vision): the ones naming `gpt-6-astra` are served by the cheaper `claude-opus-5`, and the ones
  naming `claude-opus-5` stay on it.
- `balanced` weighs price against the assumed latency: it makes the same frontier substitutions, but
  serves small-fast requests with `gpt-5.6-luna` on OpenAI, which is faster than DeepSeek under the
  assumed latencies and only slightly more expensive.
- `fastest` sends every request to Anthropic, the fastest provider under the assumed latencies. It
  still saves money here because `claude-opus-5` is cheaper than `gpt-6-astra`, but it also serves
  `gpt-5.6-luna` and `deepseek-flash` requests with the more expensive `claude-haiku-4-5-20251001`:
  it buys speed, not savings. Its baseline is slightly higher than that of the other runs because
  the JSON-mode requests reach the Anthropic format there, and the translation carries JSON mode in a
  forced tool (name, description and schema) that the mock provider counts as input; the baseline
  prices the usage each request reported.

The mixed-workload rows equal the earlier default result
([`benchmarks/results/savings-2026-09-19.json`](../benchmarks/results/savings-2026-09-19.json)).
All three policies land on the same cost there for different reasons: `cheapest` moves the
`deepseek-v4-pro` requests to OpenRouter, while `fastest` and `balanced` move every DeepSeek request
there, since OpenRouter is faster than DeepSeek under the assumed latencies and costs the same or
less.

### Method

1. **Workloads.** A seeded pseudo-random generator (`mulberry32`, seed `424242`) builds both
   workloads; the same seed always builds the same requests.
   - **Mixed** (the default scenario): 54 requests, 6 for each of 9 archetypes. Both wire formats are
     covered (30 OpenAI Chat Completions requests, 24 Anthropic Messages requests), as are four
     request kinds (plain text, a tool call, JSON mode, vision) and three input sizes (a short
     question; a medium prompt padded with 2 to 3 paragraphs of filler text; a long-context summary
     padded with 8 to 11). The seed picks which catalog model each request names and how much filler
     it gets.
   - **Realistic** (the control and presets-on scenarios): 100 requests built from exact counts per
     archetype and model class (`REALISTIC_SEGMENTS` in `benchmarks/savings.ts`), so every share
     below holds exactly. These are illustrative assumptions, not a survey of real traffic:
     - 70% of requests name a small-fast model and 30% a frontier model;
     - 60% use the OpenAI Chat Completions format and 40% the Anthropic Messages format;
     - 58% plain text (38 short questions, 20 long-context summaries), 20% tool calls, 10% JSON mode
       (OpenAI format only) and 12% vision;
     - 38% small, 42% medium and 20% large inputs;
     - an OpenAI-format request names an OpenAI model 3 times out of 4 and a DeepSeek model otherwise
       (the seeded pick); a frontier vision request names `gpt-6-astra`, since `deepseek-v4-pro` has
       no vision; an Anthropic-format request names `claude-opus-5` (frontier) or
       `claude-haiku-4-5-20251001` (small-fast).

     The raw JSON holds these assumptions, the segments and the realized counts per format, kind,
     size and requested model.
2. **Usage.** Each mock provider reports a `usage` object computed from the request it received.
   Input tokens are the characters of every text the model reads (system prompt, message text, tool
   name, description and parameter schema) divided by 4 and rounded up, plus a fixed 85 tokens per
   image. Output tokens are the request's own `max_completion_tokens` / `max_tokens`. The count is
   taken on the content only, never on the JSON envelope, so a request reports the same usage whether
   it reaches its own provider untranslated or another provider after an Anthropic-to-OpenAI
   translation (the test suite checks this). Tollwise's own cost accounting prices this usage; the
   script never computes a cost itself, it only adds up the `RequestOutcome` each request produced.
3. **Scenarios and policies.** Each scenario is replayed once per routing policy (`cheapest`,
   `fastest`, `balanced`), each run on a fresh Tollwise with the same seed, the same mock providers
   and the same assumed latencies. The default scenario is rerun in every benchmark run, next to the
   realistic ones.
4. **Latency (assumed).** `fastest` and `balanced` rank providers on their median latency, and no real
   provider is called here to measure one. Each run's health monitor holds exactly one assumed sample
   per provider: `anthropic` 700 ms, `openai` 900 ms, `openrouter` 1100 ms, `deepseek` 1400 ms. The
   proxy still records a latency sample after every call, but against a loopback mock that sample is
   about 0 ms and says nothing about a real provider, so the benchmark drops it. The raw JSON shows
   each provider's median after the last request of each run (`latency_p50_ms_after_run`), unchanged.
   These are illustrative assumptions, not a measurement; see "Proxy overhead" above for Tollwise's
   real, measured numbers.
5. **Substitution counts.** Every answer's `x-tollwise-*` headers are read. The substituted requests
   per served provider, model and group come from those headers, and the run fails if a header
   disagrees with the `RequestOutcome` the proxy recorded for the same request.

### Reproduce

```
npm run bench:savings
```

Needs nothing beyond what `npm ci` installs. Every request stays on `127.0.0.1`, and the one provider
key configured is a fixed placeholder that is not shaped like any real credential. Writes a new
`benchmarks/results/savings-<UTC date>.json` (with a `-2`, `-3` ... suffix when that name is taken;
an existing results file is never overwritten) with the seed, the exact command, the catalog's
`verified_on` dates, the presets turned on and the models they add, the workload assumptions, and for
every run its totals, switch counts, substitution counts and a count per "requested provider -> used
provider" route. Repeated runs produce identical numbers. To check that without writing anything:

```
node benchmarks/savings.ts --verify-latest
```

It replays every scenario and exits 0 only when every number equals the newest
`benchmarks/results/savings-*.json`. Re-run the benchmark after any change to routing, cost
accounting, the presets or the catalog; a change to the prices in `catalog/models.yaml` moves these
numbers with no code change at all.
