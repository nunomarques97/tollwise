# Reddit posts

One post per subreddit, each written for that community. The maintainer posts them by hand, from an
account that already takes part in the subreddit, one subreddit per day in the order of
[`launch-day-checklist.md`](launch-day-checklist.md). Nothing in this folder is posted
automatically.

The rule summaries below are a starting point, not the rules: moderators change them. **Read each
subreddit's current rules (and any pinned post about self-promotion) before posting**, and skip or
rewrite a post that would break them. Copy the title and body from the code blocks; the body is
Reddit Markdown. If the repository is published under a URL other than
`https://github.com/nunomarques97/tollwise`, replace it in every link first.

## r/LocalLLaMA

### Self-promotion rules (summary)

- Rules: <https://www.reddit.com/r/LocalLLaMA/about/rules/>
- The subreddit is about running and using models locally. Posts about your own project are
  tolerated when they are relevant to that and come from someone who also takes part in the
  community; a pure advertisement, or the same project posted again and again, is removed.
- Say plainly that you wrote the project. Lead with what is useful locally (Ollama as a provider,
  everything on your own machine), not with the paid APIs.
- Check the current rules for any limit on how often you may post about your own project and for a
  required flair.

### Post

```text
Title: I wrote a local proxy that routes OpenAI/Anthropic SDK calls across providers, including Ollama, and shows what each request cost
```

```markdown
I wrote Tollwise, an open-source (Apache-2.0) proxy that runs on your own machine. Your code keeps using the official `openai` or `@anthropic-ai/sdk` package with only the base URL changed. For each request Tollwise works out which capabilities it actually uses (tools, JSON mode, vision, streaming, context length) and sends it to the cheapest, fastest or most balanced provider that has all of them, translating between the two API formats when that loses nothing. Ollama is one of the five built-in providers, next to Anthropic, OpenAI, DeepSeek and OpenRouter, so an Anthropic-SDK app can talk to a local model through it.

Everything stays local: your own keys from environment variables, no account, no telemetry, and the request history (metadata only, never prompts or answers) in a SQLite file on your machine with a local dashboard.

**Savings, and what they depend on.** In a modeled benchmark (public list prices, local stand-in providers, not real bills), a realistic 100-request workload with the `cheapest` policy saves 84.2% with the opt-in `frontier` and `small-fast` equivalence presets on, and 0.07% with the default configuration ([raw results](https://github.com/nunomarques97/tollwise/blob/main/benchmarks/results/savings-2026-09-25.json), [method](https://github.com/nunomarques97/tollwise/blob/main/docs/benchmarks.md#savings-modeled)). By default Tollwise only switches between providers of the model you asked for. Serving a request with a different, cheaper model of the same class is opt-in: it happens only inside the [equivalence groups](https://github.com/nunomarques97/tollwise/blob/main/docs/equivalence-presets.md) you turn on, and every substitution shows in the `x-tollwise-*` response headers, the routing trace and the dashboard. Substituted models do not give identical answers, so test your own prompts first. There is no preset for local models: they already cost nothing per token.

**How it was checked.** The test suite runs against local stand-in providers, and an end-to-end run passed the official SDKs through Tollwise to a local Ollama `llama3.2` model. It has not been run against the paid OpenAI or Anthropic APIs yet.

It is pre-release and runs from source with Node.js 24; `npm run demo` shows the dashboard with local stand-in providers and no key at all.

Repo: https://github.com/nunomarques97/tollwise

I would like to hear which local setups you would route between and what is missing for them.
```

## r/selfhosted

### Self-promotion rules (summary)

- Rules: <https://www.reddit.com/r/selfhosted/about/rules/>
- The subreddit is about software you run yourself instead of a hosted service. A post about your own
  project should be about something self-hostable, say that you are its author, and link its source.
- Check the current rules for whether new-project posts are limited to a particular day, thread or
  flair, and for any required disclosure about how the project was built.

### Post

```text
Title: Tollwise: a self-hosted, local-first proxy between your apps and the OpenAI/Anthropic APIs, with a local cost dashboard (Apache-2.0)
```

```markdown
I wrote Tollwise, an open-source proxy you run on your own machine in front of the LLM APIs you already pay for. Apps keep using the official OpenAI or Anthropic SDK and change only the base URL; Tollwise sends each request to the cheapest provider that has every capability it uses and records its cost.

What it is like to run:

- One Node.js 24 process, no database server: request metadata (model, provider, routing trace, token counts, cost, latency) goes to a local SQLite file, never prompts or answers. Analytics can be turned off.
- Keys come only from environment variables and are never written to a file or a log line. It binds to 127.0.0.1 and refuses to listen on a network address without an access key.
- No telemetry, no phone-home: it contacts only the providers you enable.
- A local dashboard shows spend, savings and why each request went where it did.

**Savings, honestly.** A modeled benchmark (public list prices, local stand-in providers, not real bills) of a realistic 100-request workload with the `cheapest` policy saves 84.2% with the opt-in `frontier` and `small-fast` equivalence presets on, and 0.07% with the default configuration ([raw results](https://github.com/nunomarques97/tollwise/blob/main/benchmarks/results/savings-2026-09-25.json), [method](https://github.com/nunomarques97/tollwise/blob/main/docs/benchmarks.md#savings-modeled)). By default Tollwise only switches between providers of the model you asked for. Serving a request with a different, cheaper model of the same class is opt-in, only inside the [equivalence groups](https://github.com/nunomarques97/tollwise/blob/main/docs/equivalence-presets.md) you turn on, and each substitution shows in the `x-tollwise-*` response headers, the routing trace and the dashboard. Substituted models do not give identical answers.

The test suite runs against local stand-in providers plus one end-to-end run with a local Ollama model; it has not been run against the paid provider APIs yet. Pre-release, runs from source; `npm run demo` starts it with local stand-in providers and no key.

Repo: https://github.com/nunomarques97/tollwise

Feedback on running it as a long-lived service (containers, systemd, reverse proxies) is especially welcome.
```

## r/SideProject

### Self-promotion rules (summary)

- Rules: <https://www.reddit.com/r/SideProject/about/rules/>
- The subreddit exists for sharing side projects, so a post about your own project is the norm. It
  still expects a real description rather than a bare link, and replies to the comments.
- Check the current rules for a required flair and for limits on reposting the same project.

### Post

```text
Title: Tollwise: an open-source proxy that shows what every LLM API call costs and routes it to the cheapest provider able to serve it
```

```markdown
Tollwise is a small open-source (Apache-2.0) proxy I wrote for apps that use the OpenAI or Anthropic SDKs. You point the SDK's base URL at it; it reads what each request needs (tools, JSON mode, vision, streaming, context length), sends it to the cheapest provider that has all of it, and puts the cost and savings of every request in the response headers and a local dashboard.

The number I can back up: in a modeled benchmark (public list prices, local stand-in providers, not real bills), a realistic 100-request workload with the `cheapest` policy saves 84.2% with the opt-in `frontier` and `small-fast` equivalence presets on, and 0.07% with the default configuration ([raw results](https://github.com/nunomarques97/tollwise/blob/main/benchmarks/results/savings-2026-09-25.json), [method](https://github.com/nunomarques97/tollwise/blob/main/docs/benchmarks.md#savings-modeled)).

The gap between those two numbers is the point. By default Tollwise only switches between providers of the model you asked for, and most models cost about the same everywhere. The savings come from serving a request with a cheaper model of the same class, which is opt-in: it happens only inside the [equivalence groups](https://github.com/nunomarques97/tollwise/blob/main/docs/equivalence-presets.md) you turn on, and every substitution shows in the `x-tollwise-*` response headers, the routing trace and the dashboard. Substituted models do not give identical answers, so it is a trade-off you choose per model class.

Runs locally with your own keys, no account and no telemetry. Pre-release: run it from source with Node.js 24, or try `npm run demo`, which needs no key.

Repo: https://github.com/nunomarques97/tollwise
```
