# API reference

Every route Tollwise answers: the drop-in `/v1/*` proxy endpoints and the local `/api/*` read-only
endpoints the dashboard uses, plus the static dashboard. For the exact request/response bodies of
the proxy endpoints, streaming, tool calls, JSON mode, vision, and everything about cross-format
translation, see [`docs/compatibility.md`](compatibility.md); for routing behaviour,
[`docs/routing.md`](routing.md). This page is the map of every path, its headers, and every error
Tollwise answers with: status, code and shape.

## Error shapes

Every error answer is written by Tollwise, in one of two shapes chosen by path. A provider's error
is never relayed as the provider sent it: it becomes one of the `provider_*` or
`all_providers_failed` errors below, in the client's own API format. A `provider_*` message quotes
the provider's own error message when it sent one, with credentials masked; `all_providers_failed`
names only each provider, error kind and HTTP status.

- **OpenAI shape**, everywhere except `/v1/messages` and paths under it:
  ```json
  {
    "error": { "message": "...", "type": "invalid_request_error", "param": null, "code": "..." }
  }
  ```
  `type` is one of `invalid_request_error`, `not_found_error`, `authentication_error`,
  `permission_error`, `rate_limit_error`, `server_error`.
- **Anthropic shape**, on `POST /v1/messages` and `/v1/messages/*`:
  ```json
  { "type": "error", "error": { "type": "invalid_request_error", "message": "..." } }
  ```
  The Anthropic `error.type` is mapped from the HTTP status the way the real Anthropic API does
  (`400` → `invalid_request_error`, `401` → `authentication_error`, `402` → `billing_error`,
  `403` → `permission_error`, `404` → `not_found_error`, `413` → `request_too_large`, `429` →
  `rate_limit_error`, `500` → `api_error`, `504` → `timeout_error`, `529` → `overloaded_error`).
  Any other status keeps the error's OpenAI `type`, except that `server_error` becomes `api_error`
  (so `502` and `503` are `api_error`, and `415`, `421` and `422` are `invalid_request_error`).
  There is no `code` field in this shape, so the same information is in the message.

The codes in the tables below are the OpenAI-shape `error.code` values.

Every error response carries `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.
Answers to `POST /v1/chat/completions` and `POST /v1/messages` also carry an `x-tollwise-request-id`
header: every successful answer, and every error in the [proxy error table](#v1--the-proxy) except
`413`. The [request checks](#request-checks-every-path), a `413` and a `500` are answered before or
outside the forwarding flow and carry no id.

## `/v1` — the proxy

| Route | Methods | Notes |
|---|---|---|
| `POST /v1/chat/completions` | POST | OpenAI Chat Completions. Streaming (SSE) supported. |
| `POST /v1/messages` | POST | Anthropic Messages. Streaming (SSE) supported. Requires a non-empty `anthropic-version` header, or `400 missing_anthropic_version` before the body is even read. |
| `GET /v1/models`, `GET /v1/models/{id}` | GET, HEAD | Every model Tollwise can serve (a catalog model backed by at least one enabled provider whose key is set, or that needs none), deduplicated by canonical id and sorted. Never calls a provider. OpenAI list shape by default, Anthropic shape when the request carries an `anthropic-version` header. `GET /v1/models/{id}` answers `404` for an id Tollwise cannot serve (OpenAI shape: code `model_not_found`, type `invalid_request_error`; Anthropic shape: `not_found_error`). Both answer `503` (OpenAI shape: code `proxy_not_configured`; Anthropic shape: `api_error`) when no provider configuration is loaded, which does not happen in a normal run. |
| `/v1/responses`, `/v1/embeddings`, `/v1/images`, `/v1/audio`, `/v1/batches`, `/v1/assistants` (and anything nested under them) | any | `501 unsupported_endpoint`, naming the endpoint. Out of scope: Tollwise routes chat requests only. |

Both proxy endpoints go through the same forwarding flow, so the same request-level errors apply to
each, written in that endpoint's own shape:

| Status | Code | When |
|---|---|---|
| `503` | `proxy_not_configured` | Tollwise has no provider configuration loaded (should not happen in a normal run). |
| `400` | `missing_anthropic_version` | `POST /v1/messages` only: the `anthropic-version` header is missing or empty. Checked before the body is read. |
| `400` | `invalid_json` | The body is not valid JSON. |
| `400` | `invalid_request` | The body is valid JSON but not a usable request (not an object, or no usable `model` field). |
| `400` | `invalid_routing_policy` | `x-tollwise-policy` is not one of `cheapest`, `fastest`, `balanced`, `pinned`, or asks for `pinned` with no `routing.pinned` configured. |
| `400` | `invalid_provider` | `x-tollwise-provider` is not one of the five provider ids. |
| `422` | `model_not_in_catalog` | The requested model is not in the pricing catalog at all, and `routing.on_no_candidate` is `fail`. |
| `422` | `no_capable_provider` | No configured provider satisfies the request's capabilities, and `routing.on_no_candidate` is `fail`. |
| `422` | `provider_not_configured` | No candidate satisfies the request, and the passthrough provider (named or implied) is disabled or has no key set. |
| `422` | `format_not_supported` | No candidate satisfies the request, and the passthrough provider speaks the other API format but the request cannot be translated to it; names the untranslatable feature codes. |
| the provider's own status (`502` when it gave none, or one outside 400–599) | `provider_auth`, `provider_bad_request`, `provider_unknown` | A provider failed with an error that is not retried: it refused the credentials with `401`, `402` or `403` (`provider_auth`; type `permission_error` for a `403`, else `authentication_error`), rejected the request itself with any other `4xx` except `408` and `429` (`provider_bad_request`, type `invalid_request_error`), or failed in a way Tollwise does not recognise (`provider_unknown`, type `server_error`). Answered at once, without trying another provider, because the caller has to fix it. |
| `502` | `all_providers_failed` | Every attempt (the top candidate plus up to `routing.retries` fallbacks) failed with a retryable error (connection failure, timeout, rate limit, server error, overloaded) before answering; the message lists each provider, error kind and HTTP status. |
| `502` | `response_not_translatable` | A provider's answer could not be represented in the client's API format; names the translation problem codes. |
| `413` | `request_too_large` | The body is larger than `server.max_body_size` (see [Request checks](#request-checks-every-path)). |

A `422` refusal also carries `x-tollwise-policy`, `x-tollwise-routed: false`, `x-tollwise-requested-model`
and `x-tollwise-substituted: false`. The `provider_*`,
`all_providers_failed` and `response_not_translatable` errors carry the full set of
[headers Tollwise adds](#headers-tollwise-adds-to-a-proxied-answer), naming the provider that failed
(the last one tried).

### Headers Tollwise reads

| Header | Effect |
|---|---|
| `x-tollwise-policy` | Per-request routing policy override (see [`docs/routing.md`](routing.md#per-request-headers)). |
| `x-tollwise-provider` | Restricts routing to one provider, or names the passthrough target. |
| `anthropic-version` | Required on `POST /v1/messages`; on `GET /v1/models`, its mere presence (not its value) selects the Anthropic response shape. |
| `anthropic-beta` | Forwarded to a native Anthropic provider; a request that sets it is never translated to OpenAI format (a beta feature has no OpenAI equivalent). |

### Headers Tollwise adds to a proxied answer

| Header | Meaning |
|---|---|
| `x-tollwise-request-id` | A new id for this request; also sent with every error Tollwise answers for it. |
| `x-tollwise-provider` | The provider that served the request (the last one tried, on a failure). |
| `x-tollwise-model` | The model id sent to that provider (percent-encoded if not printable ASCII). |
| `x-tollwise-policy` | The routing policy that was applied. |
| `x-tollwise-routed` | `true` when routing chose the target, `false` for a passthrough. |
| `x-tollwise-attempts` | How many providers were called for this request, this one included. |
| `x-tollwise-translated` | `true` when the request and its answer were translated to/from the other API format. |
| `x-tollwise-requested-model` | The model id the request asked for (percent-encoded if not printable ASCII). |
| `x-tollwise-substituted` | `true` when that provider was sent another model than the one requested, which only an [equivalence group](routing.md#equivalence-groups) turned on in the configuration allows; `false` otherwise, including a provider switch of the same model and a passthrough. |
| `x-tollwise-equivalence-group` | Only when `x-tollwise-substituted` is `true`: the name of the group that allowed it (a preset's name for a [preset](equivalence-presets.md)), percent-encoded if not printable ASCII. |

Any `x-tollwise-*` header a provider's own response happens to send back is dropped before the
answer reaches the client: only the ones Tollwise itself sets are ever present.

### Cost headers

A served, **non-streamed** answer also carries, once its cost is known (the answer is held back
until it has been read in full, up to 1 MiB — a larger one is forwarded as it arrives, without these
headers):

| Header | Meaning |
|---|---|
| `x-tollwise-cost-usd` | Cost of this request in USD; `"unknown"` when the model/provider pair has no catalog price. |
| `x-tollwise-savings-usd` | Cost saved versus the baseline: the same token counts priced on the catalog entry of exactly the model id requested, from the provider that natively speaks the request's API format when it lists that id, otherwise from the first catalog entry that does. Negative when the served route cost more. `"unknown"` when no catalog entry names the requested model. |
| `x-tollwise-cost-origin` | `"reported"` when the cost is built from the provider's own usage numbers, `"estimated"` when the provider reported none and Tollwise's pre-call estimate was used instead, `"unknown"` alongside an unknown cost with no usage at all. |
| `x-tollwise-price-verified-on` | The catalog date (UTC, `YYYY-MM-DD`) the price behind `x-tollwise-cost-usd` was last verified; `"unknown"` alongside an unknown cost. |

A streamed answer never carries these: its head leaves before its usage is known. Its cost is still
recorded in the analytics database and the trace, computed once the stream ends.

## `/api` — local, read-only

Once `TOLLWISE_ACCESS_KEY` is set, every `/api/*` route needs the access key like any other route.
Only `GET`/`HEAD /healthz` and the dashboard's static files are exempt. None of these routes ever
calls a provider or spends anything. Every route that answers `GET` also answers `HEAD`.

| Route | Method | Notes |
|---|---|---|
| `GET /healthz` | GET, HEAD | Liveness only: `{"status":"ok"}` as soon as the server accepts connections. No access key needed. |
| `GET /api/health` | GET, HEAD | Per-provider state (`up`/`down`/`unknown`), `p50_ms`, `p95_ms`, `last_checked` (ISO timestamp or `null`), `samples`, `last_error_kind`, keyed by provider id. Only enabled providers whose key is set, or that need none (such as `ollama`), are monitored and listed; a provider not checked yet is `unknown`, never treated as down. |
| `GET /api/metrics/summary` | GET, HEAD | `range`: `1h`, `24h` (default), `7d`, `30d`. Aggregate requests, errors, spend, baseline, savings and their `unknown` handling over the window; see [Metrics amounts](#metrics-amounts) below. `substituted_requests` counts the requests of the window served (or last failed) by another model than the one requested; see [Model substitution](#model-substitution). |
| `GET /api/metrics/timeseries` | GET, HEAD | `range`; `bucket`: `1m`, `5m`, `1h`, `1d` (a sensible default per range). Same aggregate per fixed-width, UTC-aligned bucket. At most 1,500 buckets per answer; a combination that would exceed it is `400`. |
| `GET /api/metrics/breakdown` | GET, HEAD | `range`; `by`: `provider` (default) or `model`. Same aggregate grouped by the field that actually served the request, spend descending. |
| `GET /api/requests` | GET, HEAD | `limit` (1–200, default 50); `before` (a previous page's `nextCursor`, for backwards paging). The most recent request outcomes, newest first, each with its route, reason, cost, savings, trace, latency (`latency_ms`, `first_byte_ms`), usage and its `origin`, `baseline_usd`, the request's `needs`, the catalog `price` used and requested, the routing `selection` (`null` for a row stored before it was recorded), and `substituted` and `substitution`; see [Model substitution](#model-substitution). |
| `GET /api/events` | GET, HEAD | Live `text/event-stream`: a `health` event on connect and every 5 s, and a `request` event per request outcome as it ends (same shape as one `/api/requests` entry). Takes no query parameters. At most 16 streams open at once; a stalled reader is cut off past 1 MiB buffered. `HEAD` returns the stream's headers and no stream. Send the access key as a header — a browser's `EventSource` cannot, so read with `fetch`. |
| `GET /dashboard`, `/dashboard/*` | GET, HEAD | The dashboard's static build output. Served without the access key (these files carry no data; everything shown comes from the routes above, which still need it). |

Every `/api/metrics/*`, `/api/requests` and `/api/events` route validates its query strictly: an
unrecognized parameter, a repeated one, or a value outside the fixed set is answered `400`, with a
fixed message that never repeats what was sent. When `analytics.enabled` is `false`, the
`/api/metrics/*` and `/api/requests` routes answer `503 analytics_disabled` (after checking the
query) — there is no store to read. `/api/events` still works with analytics off: its live `request`
events come straight from requests as they end and are never read from, or written to, the
database.

Errors of the `/api/*` and `/dashboard` routes (OpenAI shape):

| Status | Code | When |
|---|---|---|
| `400` | `invalid_query_parameter` | `/api/metrics/*`, `/api/requests`, `/api/events`: an unknown or repeated query parameter, a value outside its fixed set, a `limit` outside 1–200, a `before` that is not a `nextCursor` Tollwise returned, or a timeseries `bucket` that would give more than 1,500 buckets for the `range`. |
| `503` | `analytics_disabled` | `/api/metrics/*`, `/api/requests`: `analytics.enabled` is `false`. |
| `503` | `too_many_event_streams` | `/api/events`: 16 streams are already open. Carries a `Retry-After` header. |
| `503` | `shutting_down` | `/api/events`: Tollwise is stopping and opens no new stream. |
| `503` | `dashboard_not_built` | `/dashboard`: the dashboard's build output (`dist/dashboard`) is missing; build it with `npm run build:dashboard`. |
| `404` | `not_found` | `/dashboard/*`: no such dashboard file. The message never names the path that was asked for. |

Dashboard answers, errors included, also carry a `Content-Security-Policy` that allows only
same-origin scripts, styles, fonts and connections (images may also be `data:` URLs) and no
framing, plus `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` and
`Cross-Origin-Resource-Policy: same-origin`.

### Model substitution

Each entry of `GET /api/requests`, and each `request` event of `GET /api/events` (the same shape),
says whether the request was served by another model than the one it asked for, which only an
[equivalence group](routing.md#equivalence-groups) turned on in the configuration allows:

| Field | Value |
|---|---|
| `substituted` | `true` when another model served the request (or failed last), `false` when the requested model did (on any provider) or the request was refused before any provider call, `null` for a row stored before Tollwise recorded substitutions. |
| `substitution` | When `substituted` is `true`, `{ "requested_model", "served_model", "group" }`: the model asked for, the model sent instead and the name of the group that allowed it (a [preset](equivalence-presets.md)'s name for a preset). `null` otherwise. |

```json
"substituted": true,
"substitution": { "requested_model": "gpt-6-astra", "served_model": "deepseek-v4-pro", "group": "frontier" }
```

Both fields are computed only from what the analytics database stores for the request, so a live
event and the stored entry of the same request read alike. The entries of an entry's `trace` do not
carry a `substitution` field: only the substitution of the attempt that served the request (or
failed last) is stored. `GET /api/metrics/summary` adds `substituted_requests`, the number of
requests in the window with `substituted: true`; rows with `null` are not counted.

### Metrics amounts

Every money amount is a decimal string (never a float), computed from what each request actually
cost or would have cost. Three rules apply everywhere they appear:

- A total is the literal string `"unknown"`, not `"0.000000"`, when requests happened in the window
  but none of them could be priced — never a fabricated zero.
- `unpriced_requests` counts served requests whose model has no catalog price (left out of spend).
  `unknown_savings_requests` additionally counts requests whose *baseline* price (the model id
  requested; see `x-tollwise-savings-usd` above) is unknown, even when the request itself was priced.
  `unrouted_requests` (breakdown only) counts stored requests that were refused at routing (no
  provider could take them), which have no served provider or model to group by.
- `prices_verified_on` (summary only) gives the oldest and newest catalog `verified_on` dates behind
  the amounts in that window; `null` when nothing in the window was priced.

Every amount is modeled from the catalog's list prices (USD per million tokens for uncached input,
cached input and output) and the request's token counts; it is not read from a provider bill. Three
things a bill can contain are not modeled: tokens written to a prompt cache are priced at the input
rate (the catalog has no cache-write price, and Anthropic charges more for a cache write), and
tiered or long-context prices and batch discounts are ignored. The price of each request is copied
when it is routed, so a later catalog update never changes a stored amount.

## Request checks (every path)

Every request goes through these checks, in this order, before any route handles it. The guard
checks (`421`, `403`, `415`) protect against a web page spending your keys without consent. Each
check answers in the error shape of the path (Anthropic shape on `/v1/messages`) with a fixed
message that never repeats what was sent, and closes the connection.

| Status | Code | When |
|---|---|---|
| `421` | `misdirected_request` | The `Host` header (or the host of an absolute-form request target) does not name this server (`127.0.0.1`, `localhost`, `[::1]`, the configured `server.host` unless it is a wildcard address, or an entry of `server.allowed_hosts`) on the port the request arrived on — blocks DNS rebinding. |
| `403` | `origin_not_allowed` | The request carries an `Origin` header other than `http://<allowed host>:<port>` (`null` and `https://` origins included). SDKs and `curl` send no `Origin` and are unaffected. |
| `403` | `preflight_not_supported` | The request is `OPTIONS` (a CORS preflight). No CORS header is ever sent, so a browser can never get permission to read a cross-origin answer. |
| `415` | `unsupported_media_type` | A `POST` request's `Content-Type` is not `application/json` (parameters such as `charset` are allowed). |
| `401` | `invalid_api_key` | `TOLLWISE_ACCESS_KEY` is set and the request carries no valid `Authorization: Bearer <key>` or `x-api-key: <key>`. Carries `WWW-Authenticate: Bearer realm="tollwise"`. Not checked for `GET`/`HEAD` on `/healthz` and `/dashboard`. |
| `413` | `request_too_large` | The declared `Content-Length` is larger than `server.max_body_size`. A body that turns out to be larger while it is read (for example a chunked upload) gets the same answer, if nothing has been sent yet. |
| `404` | `not_found` | No route matches the path. |
| `405` | `method_not_allowed` | The path exists but not for this method; the answer carries an `Allow` header. |
| `500` | `internal_error` | Tollwise hit an unexpected internal error while handling the request (logged with the method, the path and the error's class and code only, never a message or a body). If the answer had already started, the connection is closed instead. |

A request that is not valid HTTP at all never reaches these checks: it gets a bare
`400 Bad Request` (or `431 Request Header Fields Too Large` when its headers are too large) with an
empty body, and the connection is closed.

Whatever the outcome of these checks, and whether or not an access key is configured, the client's
credential headers (`Authorization`, `x-api-key`, `api-key`, `x-goog-api-key`,
`Proxy-Authorization`) are removed from the request here, so they are never logged or forwarded to
a provider.

See [`docs/configuration.md`](configuration.md#exposing-tollwise-on-a-network) for when
`server.allowed_hosts` needs an entry, and [`docs/privacy.md`](privacy.md) for what never leaves
this machine in the first place.
