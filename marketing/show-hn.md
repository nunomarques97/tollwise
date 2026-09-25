# Show HN

Posted by the maintainer, in the order of [`launch-day-checklist.md`](launch-day-checklist.md),
once the repository is public so anyone can try it. Read the current
[Show HN guidelines](https://news.ycombinator.com/showhn.html) and
[site guidelines](https://news.ycombinator.com/newsguidelines.html) before posting. The points this
post follows:

- A Show HN is something people can run and try now. Tollwise runs from source, and `npm run demo`
  works with no provider key, so no sign-up stands in the way.
- The title starts with "Show HN:", says plainly what the project is, and stays within 80
  characters, with no superlatives, no exclamation marks and no "we are excited".
- The submission links the repository; the first comment, posted right after, says who made it, why,
  how it works, what is not done yet, and what feedback would help.
- Never ask anyone to upvote, and never ask friends to comment. Stay available to answer questions.

HN comments are plain text: URLs are linked automatically, and there is no Markdown. If the
repository is published under a URL other than `https://github.com/nunomarques97/tollwise`,
replace it first.

## Title

```text
Show HN: Tollwise – a local proxy that routes OpenAI/Anthropic SDK calls by cost
```

URL: `https://github.com/nunomarques97/tollwise`

## First comment

```text
I wrote Tollwise because I wanted to know what each LLM API call cost, and whether another provider could serve it for less, without changing application code.

It is a proxy that runs on your machine. Apps keep the official openai or @anthropic-ai/sdk package and change only the base URL. For each request Tollwise reads what it actually uses (tools, JSON mode, vision, streaming, context length and output size), builds the list of enabled, healthy providers that have all of it, and picks one by policy: cheapest, fastest, balanced or pinned. It translates between the two API formats when nothing is lost, retries the next candidate on a failure, and never downgrades silently: when no candidate fits, it fails clearly or passes the request unchanged to the model you asked for. Every answer carries x-tollwise-* headers with the provider, model, cost, savings and the date the price was verified, and a local dashboard shows the history. Keys come from environment variables only; there is no account and no telemetry, and the history (metadata, never prompts) is a local SQLite file. Built in: Anthropic, OpenAI, DeepSeek, OpenRouter and Ollama.

On savings, the honest version: with the default configuration Tollwise only switches between providers of the model you asked for, and most models cost about the same everywhere. In a modeled benchmark (public list prices, local stand-in providers, not real bills), a realistic 100-request workload with the cheapest policy saves 84.2% with the opt-in frontier and small-fast equivalence presets on, and 0.07% with the default configuration:

https://github.com/nunomarques97/tollwise/blob/main/benchmarks/results/savings-2026-09-25.json
Method: https://github.com/nunomarques97/tollwise/blob/main/docs/benchmarks.md#savings-modeled

The presets let a request be served by a cheaper model of the same class. That is opt-in, only inside groups you turn on, and always visible in the response headers, the routing trace and the dashboard. Substituted models do not give identical answers, and Tollwise measures no answer quality, so it is a trade-off you choose per model class: https://github.com/nunomarques97/tollwise/blob/main/docs/equivalence-presets.md

What is not there yet: it is pre-release and runs from source with Node.js 24, only /v1/chat/completions, /v1/messages and /v1/models are served (/v1/embeddings, /v1/responses and the other endpoints answer 501), and streamed answers carry no cost headers (their cost is in the history). The test suite runs against local stand-in providers plus an end-to-end run with a local Ollama model; it has not been run against the paid OpenAI or Anthropic APIs yet.

`npm run demo` starts it with local stand-in providers and the dashboard, no key needed. I would especially like to hear which equivalence groups would make sense for your workloads, and where the routing rules surprise you.
```
