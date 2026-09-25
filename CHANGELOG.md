# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - Unreleased

### Added

- Drop-in request routing for `POST /v1/chat/completions` (OpenAI) and `POST /v1/messages` (Anthropic), streaming (SSE) included.
- `GET /v1/models`, listing the models Tollwise can serve with the configured providers, in OpenAI or Anthropic shape; it never calls a provider.
- Capability-aware routing: candidates are built from every configured, healthy provider that has the requested model (or an explicit equivalence group) with every capability the request needs, selected by a `cheapest` (default), `fastest`, `balanced` or `pinned` policy, with configurable retries and an `on_no_candidate` outcome (`fail` or `passthrough`) that never silently downgrades a request.
- Equivalence presets (version 1): built-in, opt-in equivalence groups per model class (`frontier`, `small-fast`), turned on with one line, `routing.equivalence_presets`, and documented in `docs/equivalence-presets.md`. Off by default.
- Cross-format translation: a request can be served by a provider that speaks the other wire format when translating it would not drop anything the request uses, marked with `x-tollwise-translated`.
- Per-request cost and savings reported in response headers on served, non-streamed answers, with the cost origin (`reported` from provider usage, or `estimated`) and the catalog price's `verified_on` date.
- Local request history: the metadata of each routed request (never its prompt or answer) stored in a SQLite file on the user's machine, with retention left to the user.
- Read-only metrics API over that local history: `/api/metrics/summary`, `/api/metrics/timeseries`, `/api/metrics/breakdown`, `/api/requests`, and a live `/api/events` stream.
- A local web dashboard at `/dashboard`, read from that history: spend and savings over a chosen time range, spend by provider and by model, updated live as requests arrive.
- Provider health and latency monitoring, exposed at `GET /api/health`, and a liveness check at `GET /healthz`.
- A versioned pricing and capability catalog (`catalog/models.yaml`), with a `catalog update` command that fetches a public, read-only source and prints a diff before writing anything.
- Zero-config startup with a YAML configuration file and environment variable overrides, human-readable validation errors, and provider keys read only from environment variables.
- Optional access key (`TOLLWISE_ACCESS_KEY`) and request checks (`Host` allow-list, `Origin` checks, refused CORS preflights) that block DNS rebinding and cross-site requests from spending a user's provider keys.
- `tollwise` CLI: `start`, `config check`, `catalog update`.
- `npm run demo`: runs Tollwise against local mock providers with reproducible sample traffic, so the routing and the dashboard can be tried without an account or a real API key.
- `npm run demo -- --workload presets-on`: replays the savings benchmark's realistic workload with the `frontier` and `small-fast` presets and the `cheapest` policy, so the dashboard shows the modeled presets-on savings.
- A static demo of the dashboard in `docs/demo/`, built by `npm run build:demo-site` from the dashboard's own sources and a snapshot recorded from that workload (`npm run demo:snapshot`), servable by GitHub Pages with no server and no network access; see `docs/demo-site.md`.
- Documentation: configuration reference, routing behavior, API compatibility and endpoints, privacy, and measured benchmarks.
- Reproducible benchmarks for proxy overhead and for cost savings, both with the method and results written down.
