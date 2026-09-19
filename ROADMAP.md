# Roadmap

This page describes what Tollwise does today and the directions being weighed for what comes
after. It is not a schedule and not a promise: nothing below has a date, and an idea in
[Ideas under consideration](#ideas-under-consideration) may change shape or never ship. For what
has already shipped, see [`CHANGELOG.md`](CHANGELOG.md); for the exact, tested behavior of what
exists today, see the [README](README.md) and the docs it links to.

## What 0.1.0 does

Tollwise is a local proxy you point the OpenAI or Anthropic SDK at instead of the provider's own
API, by changing only `baseURL`. Today it:

- Accepts `POST /v1/chat/completions` (OpenAI) and `POST /v1/messages` (Anthropic), streaming
  (SSE) included, and lists every model it can serve at `GET /v1/models`.
- Works out the capabilities a request actually needs (tools, JSON mode, vision, context length,
  streaming) and routes it to the cheapest, fastest, balanced or pinned candidate provider that
  has all of them, never silently serving a different model or dropping a capability the request
  used. See [`docs/routing.md`](docs/routing.md).
- Can serve a request through a provider that speaks the other wire format, translating it both
  ways, when that translation would not drop anything the request uses. See
  [`docs/compatibility.md`](docs/compatibility.md).
- By default, switches only between providers for the exact model requested. Routing between
  *different* models is available only inside an explicit equivalence group you opt into in the
  configuration — it is never on by default, and every substitution shows in the response headers
  and the routing trace.
- Reports the cost and savings of each served, non-streamed request in response headers, and
  keeps a local history of request metadata — never prompts or answers — in a SQLite file on your
  machine, readable through a read-only metrics API and a local dashboard.
- Monitors the health and latency of every configured provider (`GET /api/health`) and updates
  the pricing and capability catalog from a public source, printing a diff you review before
  anything is written to disk (`tollwise catalog update`).
- Runs from a YAML configuration file plus environment variables, with provider keys read only
  from the environment, an optional access key, and request checks that block cross-site and
  DNS-rebinding requests from spending your provider keys.

The README has the exact commands and transcripts; anything not listed above or documented as
supported in [`docs/compatibility.md`](docs/compatibility.md) is not implemented yet.

## Ideas under consideration

Directions being weighed for after 0.1.0, in no particular order and with no date attached:

- Support for more of the OpenAI and Anthropic surface — for example the OpenAI Responses API and
  embeddings endpoints — which Tollwise currently answers with `501 unsupported_endpoint`.
- More providers in the catalog, and an easier path for adding one.
- An opt-in way to store prompts and answers locally for people who want a full local log, kept
  off by default and separate from the request metadata Tollwise already records.
- A command to prune or cap the local request history, instead of deleting the database file by
  hand.
- Easier presets for equivalence groups, so opting a class of models into cross-model routing
  takes less manual configuration.

## Giving input

Feature requests, questions about an idea above, and bug reports all go through
[GitHub issues](https://github.com/nunomarques97/tollwise/issues). See
[`CONTRIBUTING.md`](CONTRIBUTING.md) for how to propose a change yourself.
