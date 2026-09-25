# Product Hunt listing

Submitted by the maintainer on the day [`launch-day-checklist.md`](launch-day-checklist.md) gives,
from their own maker account. Read Product Hunt's current launch guidelines, linked from its
submission form, first; the form also shows the current length limits. The tagline below is kept within 60
characters and the description within 260. Never ask for upvotes. If the repository is published
under a URL other than `https://github.com/nunomarques97/tollwise`, replace it first.

## Name

```text
Tollwise
```

## Links

- Website and source: `https://github.com/nunomarques97/tollwise`
- Pricing: free, open source (Apache-2.0)
- Suggested topics: Developer Tools, Open Source, Artificial Intelligence

## Tagline

```text
Route LLM API calls to the cheapest provider that fits
```

## Description

```text
Local, open-source proxy for the OpenAI and Anthropic SDKs: change the base URL and each request goes to the cheapest provider with every capability it uses. Cost and savings in every response and a local dashboard. Your own keys, no telemetry.
```

## First comment

```text
Hi, I'm the maker of Tollwise.

Tollwise is a proxy that runs on your own machine. Apps keep the official OpenAI or Anthropic SDK and change only the base URL. For each request it reads what it actually uses (tools, JSON mode, vision, streaming, context length), sends it to the cheapest, fastest or most balanced provider that has all of it, and never downgrades silently. Every answer's headers say which provider and model served it, what it cost and what it saved, and the local dashboard keeps the history. Built in: Anthropic, OpenAI, DeepSeek, OpenRouter and Ollama.

About the savings: in a modeled benchmark (public list prices, local stand-in providers, not real bills), a realistic 100-request workload with the cheapest policy saves 84.2% with the opt-in frontier and small-fast equivalence presets on, and 0.07% with the default configuration.
Raw results: https://github.com/nunomarques97/tollwise/blob/main/benchmarks/results/savings-2026-09-25.json
Method: https://github.com/nunomarques97/tollwise/blob/main/docs/benchmarks.md#savings-modeled

By default Tollwise only switches between providers of the model you asked for. Serving a request with a different, cheaper model of the same class is opt-in: it happens only inside the equivalence groups you turn on, and every substitution shows in the x-tollwise-* response headers, the routing trace and the dashboard. Substituted models do not give identical answers, so test your own prompts first: https://github.com/nunomarques97/tollwise/blob/main/docs/equivalence-presets.md

It is pre-release and runs from source with Node.js 24. `npm run demo` shows the dashboard with local stand-in providers and needs no key. Questions and feedback are very welcome.
```

## Gallery

Upload in this order. Every image is a screenshot of the dashboard of `npm run demo`, whose providers
are local stand-ins, so the figures in them are demo data, not real spend. The form may crop or
scale them; check the preview before scheduling.

1. `docs/images/overview-1440-dark.png`: the overview, with money saved, spend and baseline over the
   last hour, and how many requests a substituted model served.
2. `docs/images/drawer-substitution-1440-dark.png`: one substituted request in the routing trace,
   with the requested model, the served model, the equivalence group and the cost of each.
3. `docs/images/savings-1440-dark.png`: savings and spend over time, by provider and by model.
4. `docs/images/routing-1440-dark.png`: every recorded request with the provider and model that
   served it and the policy that chose them.
5. `docs/images/providers-1440-light.png`: provider health and latency, in the light theme.
