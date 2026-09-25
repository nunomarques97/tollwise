# X thread

Six posts, posted by the maintainer as one thread in the order of
[`launch-day-checklist.md`](launch-day-checklist.md). Each post fits in 280 characters, counting a
link as 23, as X does. Copy the text from the code blocks; attach the named image where one is
listed. If the repository is published under a URL other than
`https://github.com/nunomarques97/tollwise`, replace it first.

## Post 1

```text
Tollwise: an open-source proxy for the OpenAI and Anthropic SDKs that runs on your machine. Change only the base URL; each request goes to the cheapest provider with every capability it uses, and every answer's headers carry its cost and savings.

https://github.com/nunomarques97/tollwise
```

Attach: `docs/images/overview-1440-dark.png`

## Post 2

```text
Modeled savings on a realistic 100-request workload, cheapest policy, public list prices:

84.2% with the opt-in frontier and small-fast presets on
0.07% with the default config

Results: https://github.com/nunomarques97/tollwise/blob/main/benchmarks/results/savings-2026-09-25.json
Method: https://github.com/nunomarques97/tollwise/blob/main/docs/benchmarks.md#savings-modeled
```

## Post 3

```text
Why the gap: by default Tollwise only switches between providers of the model you asked for, and most models cost about the same everywhere.

Serving a request with a cheaper model of the same class is opt-in, only inside equivalence groups you turn on:
https://github.com/nunomarques97/tollwise/blob/main/docs/equivalence-presets.md
```

## Post 4

```text
A substitution is never silent. The answer carries x-tollwise-substituted, -requested-model, -model and -equivalence-group headers, and the routing trace and dashboard show both models and the group.

Substituted models do not give identical answers: test your own prompts first.
```

Attach: `docs/images/drawer-substitution-1440-dark.png`

## Post 5

```text
No silent downgrade: a request that uses tools, JSON mode, vision or a long context only goes to a model that has all of it. When none does, Tollwise fails clearly or passes the request unchanged to the model you asked for, as you configure.
```

## Post 6

```text
Local-first: your own keys from env vars, no account, no telemetry, request metadata (never prompts) in a local SQLite file.

Pre-release, runs from source on Node.js 24. `npm run demo` shows the dashboard with local stand-in providers, no key needed.

https://github.com/nunomarques97/tollwise
```
