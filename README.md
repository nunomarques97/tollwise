# Tollwise

**A local proxy for the OpenAI and Anthropic SDKs that sends each request to the cheapest provider able to serve it, and shows what you saved.**

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![Node.js >= 24](https://img.shields.io/badge/node-%3E%3D24-brightgreen)](package.json)

Your code keeps using the official `openai` or `@anthropic-ai/sdk` package; you change only its base URL. Tollwise works out what each request actually needs (tools, JSON mode, vision, streaming, context length), picks the cheapest, fastest or most balanced provider that has all of it, translates between the two API formats when that loses nothing, and reports the cost and savings of every request in its response headers and a local dashboard. It runs on your machine with your own keys: no account, no telemetry.

![Tollwise dashboard overview: money saved, spend and baseline over the last hour, and how many requests a substituted model served](docs/images/overview-1440-dark.png)

**Modeled savings: 84.2% with the `frontier` and `small-fast` [equivalence presets](docs/equivalence-presets.md) on, 0.07% with the default configuration**, on the same realistic workload with the `cheapest` policy, at public list prices ([raw results](benchmarks/results/savings-2026-09-25.json), [method](docs/benchmarks.md#savings-modeled)). By default Tollwise only switches between providers of the model you asked for; serving a request with a different, cheaper model of the same class is opt-in and shows in every answer's headers. [Details below](#savings-and-performance).

**[Try the static demo](https://nunomarques97.github.io/tollwise/demo/)** of the dashboard in your browser, with nothing to install. It is not a live service: it shows sample data from the modeled workload with the `frontier` and `small-fast` presets on, so its 30-day view shows the benchmark's 84.2% saved ([raw results](benchmarks/results/savings-2026-09-25.json)). The default configuration only switches between providers of the model you asked for. [How the demo was recorded](docs/demo-site.md).

**Status: pre-release.** There is no published package yet; Tollwise runs from source.

## Quick start

Requires Node.js 24 or later (`node --version`). Run every command after `cd tollwise` from the repository root.

```
git clone https://github.com/nunomarques97/tollwise.git
cd tollwise
npm ci
```

Set the key of a provider you already use (here OpenAI, in a POSIX shell; in PowerShell: `$env:OPENAI_API_KEY = "sk-..."`) and start Tollwise:

```
export OPENAI_API_KEY="sk-..."
npm start
```

It listens on `http://127.0.0.1:8484`. From another terminal, point the official SDK at it by changing only `baseURL`; with the same `OPENAI_API_KEY` set, the rest of your code stays the same:

```js
// npm install openai
import OpenAI from "openai";

const client = new OpenAI({ baseURL: "http://127.0.0.1:8484/v1" });

const response = await client.chat.completions.create({
  model: "gpt-5.6-luna",
  messages: [{ role: "user", content: "Say hello in one short sentence." }],
});

console.log(response.choices[0].message.content);
```

The Anthropic SDK works the same way, even with only an OpenAI key configured: Tollwise translates the request to the format of a provider it can use. The real provider key stays in Tollwise's environment; the SDK's `apiKey` is checked only when you set `TOLLWISE_ACCESS_KEY` ([how](docs/configuration.md#require-an-access-key)).

```js
// npm install @anthropic-ai/sdk
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  baseURL: "http://127.0.0.1:8484",
  apiKey: "not-checked", // Tollwise checks it only when TOLLWISE_ACCESS_KEY is set
});

const message = await client.messages.create({
  model: "gpt-5.6-luna",
  max_tokens: 100,
  messages: [{ role: "user", content: "Say hello in one short sentence." }],
});

console.log(message.content[0].text);
```

Or with `curl`; every answer says where it went and what it cost:

```
$ curl -s -D - -X POST http://127.0.0.1:8484/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"gpt-5.6-luna","max_tokens":100,"messages":[{"role":"user","content":"Say hello in one short sentence."}]}'

HTTP/1.1 200 OK
content-type: application/json
x-tollwise-request-id: af64db22-656f-43d1-8cad-5a2cf0441356
x-tollwise-provider: openai
x-tollwise-model: gpt-5.6-luna
x-tollwise-policy: cheapest
x-tollwise-routed: true
x-tollwise-attempts: 1
x-tollwise-translated: true
x-tollwise-requested-model: gpt-5.6-luna
x-tollwise-substituted: false
x-tollwise-cost-usd: 0.000008
x-tollwise-savings-usd: 0.000000
x-tollwise-cost-origin: reported
x-tollwise-price-verified-on: 2026-09-19

{"id":"chatcmpl-mock-1","type":"message","role":"assistant","model":"gpt-5.6-luna","content":[{"type":"text","text":"Mock response from the mock provider."}],"stop_reason":"end_turn","stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":5,"cache_creation_input_tokens":null,"cache_read_input_tokens":null}}

```

Then open the dashboard at `http://127.0.0.1:8484/dashboard`.

**No provider key yet?** `npm run demo` starts five local stand-in providers and a Tollwise with the `small-fast` preset on at `http://127.0.0.1:8487`, sends a mix of requests and keeps the dashboard at `http://127.0.0.1:8487/dashboard` live until Ctrl+C. No account, key or network call is needed; see [`docs/demo.md`](docs/demo.md).

**Just looking?** The [static demo](https://nunomarques97.github.io/tollwise/demo/) is the same dashboard with sample data from the modeled presets-on workload, 84.2% saved over 30 days ([raw results](benchmarks/results/savings-2026-09-25.json)); the default configuration only switches between providers of the model you asked for. To send that workload through a Tollwise on your machine, run `npm run demo -- --workload presets-on`: it replays the benchmark's 100 requests with the `frontier` and `small-fast` presets and the `cheapest` policy, then keeps the dashboard at `http://127.0.0.1:8487/dashboard` up until Ctrl+C. [`docs/demo-site.md`](docs/demo-site.md) says how the static demo is recorded and built.

<details>
<summary>How the output above was produced</summary>

The commands were run as shown against a Tollwise started with `npm start`, with `TOLLWISE_CONFIG` naming a configuration file that enables one provider, `openai`, whose `base_url` pointed at `test/fixtures/mock-provider.ts` (the local HTTP stand-in the automated tests use) instead of `https://api.openai.com`, and a fake `OPENAI_API_KEY`. The answer's text, "Mock response from the mock provider.", says so itself; the costs are real catalog prices applied to the stand-in's token counts. The response headers are abridged: the standard `date`, `content-length`, `Connection` and `Keep-Alive` lines are left out. `npm ci` also prints a deprecation warning and three moderate advisories for `uuid`, which reaches the tree only through `autocannon`, a development dependency of the [overhead benchmark](docs/benchmarks.md); Tollwise's runtime dependencies are `gpt-tokenizer`, `yaml` and `zod` (`npm ls --omit=dev`).

</details>

## How routing works

1. **Needs:** Tollwise reads which capabilities the request uses: tools, JSON mode, vision, streaming, context length and output size.
2. **Candidates:** every enabled, healthy provider serving the requested model with all of them, including one that speaks the other API format when translating loses nothing (and, only when you turn on an equivalence group, other models of that group).
3. **Policy:** `cheapest` (default), `fastest`, `balanced` or `pinned` picks one; the `x-tollwise-policy` request header overrides it per request.
4. **Fallback:** on a connection failure, timeout, rate limit or server error, the next candidate is tried, up to `routing.retries`.
5. **No silent downgrade:** when no candidate has everything the request needs, Tollwise fails clearly or passes the request unchanged to the model you asked for (`routing.on_no_candidate`).

[`docs/routing.md`](docs/routing.md) has the full rules and [`docs/compatibility.md`](docs/compatibility.md) every translation limit.

## Configuration

Tollwise runs on built-in defaults. To change anything, copy the example file, edit the copy and check it:

```
cp tollwise.example.yaml tollwise.yaml
node src/cli.ts config check
```

**API keys never go in the file.** Each provider names the environment variable holding its key (`api_key_env`, for example `ANTHROPIC_API_KEY`), and a key-shaped value typed into the file is rejected. A provider is used when it is enabled and its key is set; a local Ollama needs none. Built in: Anthropic, OpenAI, DeepSeek, OpenRouter and Ollama.

- [`docs/configuration.md`](docs/configuration.md): every field and environment variable, the access key, exposing Tollwise on a network.
- [`docs/api.md`](docs/api.md): every route, header and error, including the local `/api/*` metrics endpoints.
- [`docs/dashboard.md`](docs/dashboard.md): the dashboard views and the access-key form.
- [`docs/catalog.md`](docs/catalog.md): the pricing and capability catalog and how to update it.

## Save more with equivalence presets

Turn on model substitution for one class of models with one line in `tollwise.yaml` (a copy of the example file already has it under `routing:`, set to `[]`):

```yaml
routing:
  equivalence_presets: [small-fast]
```

With keys for at least two of the preset's vendors set, a request for one member (say `gpt-5.6-luna`) may then be served by a cheaper member that has every capability it uses (say DeepSeek's `deepseek-flash`). It is never silent. The answer carries `x-tollwise-substituted: true`, `x-tollwise-requested-model`, `x-tollwise-model` and `x-tollwise-equivalence-group`; the routing trace and the dashboard mark the request with both models and the group:

```
x-tollwise-provider: deepseek
x-tollwise-model: deepseek-flash
x-tollwise-requested-model: gpt-5.6-luna
x-tollwise-substituted: true
x-tollwise-equivalence-group: small-fast
x-tollwise-cost-usd: 0.000005
x-tollwise-savings-usd: 0.000003
```

Substituted models do not give identical answers, and Tollwise measures no answer quality: test your own prompts first. [`docs/equivalence-presets.md`](docs/equivalence-presets.md) lists the presets (`frontier`, `small-fast`), their members and how to write your own groups.

## Why Tollwise

Tollwise is deliberately small: one local process for your own machine. Compared with other tools in this space, as described in their own documentation (checked 2026-09-25):

- **[LiteLLM](https://github.com/BerriAI/litellm)** is an open-source AI gateway and Python SDK for 100+ LLM providers in the OpenAI format, with virtual keys, spend tracking, guardrails and load balancing. Its proxy's virtual keys [need a Postgres database](https://docs.litellm.ai/docs/proxy/virtual_keys). Choose it for breadth and team features. Tollwise supports five providers, needs no database server and keeps its history in a local SQLite file.
- **[OpenRouter](https://openrouter.ai/docs/quickstart)** is a hosted API: one endpoint for hundreds of models, which by default [load-balances each model across its providers, prioritizing price](https://openrouter.ai/docs/features/provider-routing). Tollwise runs on your machine, calls providers with your own keys, and can use OpenRouter as one of them.
- **[Portkey AI Gateway](https://github.com/Portkey-AI/gateway)** is an open-source gateway with retries, fallbacks, load balancing, conditional routing and guardrails; its README lists logging, tracing and observability as available on Portkey's hosted app. Tollwise's request history and dashboard run locally and are included.

What Tollwise adds on top: routing on the capabilities each request actually uses, never a silent downgrade, the cost and savings of every request in its response headers with the date the price was verified, and model substitution only inside groups you turn on, always visible.

## Savings and performance

**Savings are modeled, not measured on real bills.** `npm run bench:savings` replays fixed, seeded workloads through a real, in-process Tollwise against local stand-in providers, priced with `catalog/models.yaml`. On the realistic workload with the `cheapest` policy, the default configuration saves 0.07% of the baseline (only provider switches for the same model), and the `frontier` and `small-fast` presets on save 84.2% ([raw results](benchmarks/results/savings-2026-09-25.json), [method and every policy](docs/benchmarks.md#savings-modeled)). Your own savings depend on your traffic and the providers you enable.

**Measured proxy overhead** against a zero-latency local stand-in, 2026-09-19: non-streaming p50 2 ms and p99 5 ms, streaming first byte p50 1.19 ms, startup 408.06 ms (median of 5), idle memory 140.7 MB ([raw results](benchmarks/results/overhead-2026-09-19.json), [method and hardware](docs/benchmarks.md#proxy-overhead-npm-run-benchoverhead)). This is what Tollwise adds on top of a provider, not how long a provider takes to answer.

**End-to-end with a local model:** on 2026-09-19, the official `openai` and `@anthropic-ai/sdk` packages, unmodified, passed all four cases (non-streaming and streaming, the Anthropic ones translated) through Tollwise against a local Ollama `llama3.2:latest` ([record](benchmarks/results/e2e-ollama-2026-09-19.json); `npm run e2e:ollama`, see [`benchmarks/README.md`](benchmarks/README.md)). Tollwise has not been tested against the real OpenAI or Anthropic APIs.

## Privacy

- **No telemetry, no phone-home.** Tollwise contacts only the providers you enable (requests and health checks) and, when you run `catalog update`, the public catalog source.
- **Keys from the environment only.** Provider keys and the access key are never written to a file, printed or logged; they are redacted from every log line.
- **Metadata only.** Each request's model, provider, routing trace, token counts, cost and latency are stored in `data/analytics.db` on your machine; prompts and answers never are. Turn it off with `analytics.enabled: false`.
- **Loopback by default.** It binds to `127.0.0.1`, refuses requests from other web origins, and refuses to listen on a network address without an access key.

See [`docs/privacy.md`](docs/privacy.md) for exactly what is stored, how to delete it, and every network call Tollwise makes.

## Limitations

- **Two endpoints:** `POST /v1/chat/completions` and `POST /v1/messages`, streaming included. `/v1/responses`, `/v1/embeddings`, `/v1/images`, `/v1/audio`, `/v1/batches` and `/v1/assistants` answer `501`.
- **Five providers:** Anthropic, OpenAI, DeepSeek, OpenRouter and Ollama, priced from the dated entries of `catalog/models.yaml`.
- **Streamed answers carry no cost headers**, because their usage is known only at the end; their cost is recorded in the request history and the dashboard.
- **No retention setting:** the request history is kept until you delete it, and storing prompts is not available.
- **Pre-release:** no published package; run from source with Node.js 24 or later.

[`docs/compatibility.md`](docs/compatibility.md) documents every behaviour difference.

## Contributing

Bug reports, feature requests and pull requests are welcome. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the ground rules (run `npm run check` before a pull request), [`SECURITY.md`](SECURITY.md) to report a vulnerability privately, [`CHANGELOG.md`](CHANGELOG.md) and [`ROADMAP.md`](ROADMAP.md). This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).

## License

[Apache License 2.0](LICENSE).
