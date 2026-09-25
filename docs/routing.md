# How routing works

For every `POST /v1/chat/completions` or `POST /v1/messages` request, Tollwise works out what the
request actually needs, builds the list of providers that can serve it without dropping anything,
picks one by the configured policy, and falls back to the next eligible one on a retryable failure.
It never silently sends a downgraded version of what was asked for. This page describes that
behaviour in full; [`docs/compatibility.md`](compatibility.md) covers the endpoint shapes and
cross-format translation in detail, and [`docs/configuration.md`](configuration.md#routing) lists
every `routing.*` configuration field.

## 1. What the request needs

Tollwise reads the request body just enough to route it, without altering it: the model it asks for,
whether it streams, and four capabilities — `tools`, `json_mode`, `vision`, `streaming` — inferred
from the body (tool definitions or an active `tool_choice`, a JSON `response_format`, an image
content part or block, `"stream": true`). It also estimates the input token count (for ranking by
price) and reads the requested output budget (`max_tokens` / `max_completion_tokens`).

## 2. Building the candidate list

A candidate is always either the exact model requested (served by any configured provider) or a
model the configuration explicitly declared interchangeable in an [equivalence
group](#equivalence-groups) — routing never substitutes a different model on its own. For each
catalog entry that could match, Tollwise checks, in this order, and excludes the entry with the
first reason that applies:

| Exclusion reason | Meaning |
|---|---|
| `provider_not_configured` | The provider is disabled, has no key set, or has no adapter. |
| `provider_not_requested` | The request's `x-tollwise-provider` header names a different provider. |
| `untranslatable:<code>` | The provider speaks the other wire format, and translating this request to it would drop a feature the request uses (see [Cross-format routing](compatibility.md#cross-format-routing); `<code>` is the first untranslatable feature found). |
| `missing_capability:<name>` | The model's catalog entry lacks a capability the request needs (`tools`, `json_mode`, `vision`, `streaming`). |
| `max_output_too_small` | The request asks for more output tokens than the model can produce. |
| `context_too_small` | Estimated input tokens plus the expected output do not fit the model's context window. |
| `provider_down` | The health monitor currently sees the provider as down (a provider not checked yet is never treated as down). |

The exclusion reasons reach you in two places. Every recorded request keeps them in its `selection`
field (`GET /api/requests`, `GET /api/events` and the analytics database; see
[`docs/api.md`](api.md)), and the dashboard's routing drawer shows them. When
`routing.on_no_candidate` is `fail`, the `422 no_capable_provider` message also names every excluded
provider/model pair, grouped by reason (see [No eligible candidate](#5-no-eligible-candidate)).

A provider that speaks the *other* API format than the request (for example an Anthropic-format
request candidate for an OpenAI-only provider) is only ever a candidate when translating the request
to that format would lose nothing; see [`docs/compatibility.md`](compatibility.md#translation-differences)
for the exact list of untranslatable features.

## 3. Picking one: the policy

`routing.policy` (default `cheapest`), overridable for a single request with the `x-tollwise-policy`
header:

- **`cheapest`** — lowest estimated price. Estimated price = input tokens × input price + output
  tokens × output price, where output tokens is the request's `max_tokens` (or
  `max_completion_tokens`), or 1024 capped at the model's own maximum output when the request sets
  none. This is an estimate used only for ranking; the cost reported after the call always comes
  from the provider's own usage numbers when available.
- **`fastest`** — lowest recent median latency (`p50`, from the health monitor's rolling window).
  Providers with no measured latency yet are ranked after every measured one.
- **`balanced`** — lowest score of `0.5 × (price / highest price among candidates) + 0.5 ×
  (latency / highest latency among candidates)`; a candidate with no latency measured yet is scored
  as the slowest. Ties are broken by price.
- **`pinned`** — tries `routing.pinned` (a fixed provider and model) first, but only when it is
  eligible: the exact requested model (or in its equivalence group) with every needed capability, on
  a configured, non-excluded provider. When the pinned target is not eligible, ranking falls back to
  `cheapest` among the remaining candidates. Choosing `policy: pinned` in the configuration or
  `x-tollwise-policy: pinned` on a request without `routing.pinned` configured is refused as an
  error.

Every policy breaks ties the same way after its own primary ordering: cheaper first, then the
requested model id itself, then the same canonical model, then any equivalence-group member, then
catalog order.

## 4. Fallback on failure

Tollwise tries the top-ranked candidate, then, on a retryable failure, the next one, up to
`routing.retries` extra attempts (default 1, so 2 attempts total by default; 0–5 configurable). A
failure is retried only when it happens **before** the provider's response head arrives: no
connection, a timeout (`routing.timeouts`, or HTTP 408), HTTP 429, or any 5xx status (503 and 529
count as overloaded; 504 and 524 as timeouts). A provider that refuses the credentials (401, 402,
403) or rejects the request itself (any other 4xx, such as 400, 404 or 422) is answered to the
client immediately, with that status, as `provider_auth` or `provider_bad_request`, because the
caller has to fix it and another provider would very likely refuse it the same way. Once a provider's 2xx response head
has arrived, the response is committed: it is relayed to the client as-is and never retried
elsewhere, even if its body later fails or is cut short. When every attempt fails, the client gets
`502 all_providers_failed`, naming each provider tried, its error kind and HTTP status.

## 5. No eligible candidate

When the candidate list ends up empty, `routing.on_no_candidate` decides what happens (default
`passthrough`):

- **`passthrough`** — the request goes unrouted to the originally requested model, at the provider
  named by `x-tollwise-provider`, or, when none is named, the provider that natively speaks the
  endpoint's format (`openai` for `/v1/chat/completions`, `anthropic` for `/v1/messages`). If that
  passthrough provider is not configured, or speaks the other format and the request cannot be
  translated to it, the request is refused instead (`422 provider_not_configured` or
  `422 format_not_supported`).
- **`fail`** — the request is refused immediately with `422 no_capable_provider` (or
  `422 model_not_in_catalog` when the requested model is not in the catalog at all), naming every
  candidate that was ruled out and why. Nothing is sent to a provider.

Routing never silently serves a different model or drops a capability the request used instead of
one of these two explicit outcomes.

## Equivalence groups

By default Tollwise only switches the **provider** serving the exact model requested (for example
the same model directly, or through OpenRouter); it never substitutes one model for another on its
own. An equivalence group is an explicit opt-in: it lets routing also choose between *different*
models the operator has declared interchangeable for their use.

```yaml
routing:
  equivalence_groups:
    - name: small-fast
      models:
        - gpt-5.6-luna
        - claude-haiku-4.5
        - deepseek-v4.1-flash
    - name: frontier
      models:
        - gpt-6-astra
        - claude-opus-5
```

Rules:

- A model is listed by its catalog canonical id (every provider serving it joins the group) or by
  one provider's own model id (only that provider's entry joins). An id that matches no catalog
  entry adds nothing; `GET /v1/models` lists the canonical ids Tollwise can serve.
- A group applies to a request when the requested model id, or the canonical model it resolves to,
  is listed in it.
- A model may belong to at most one group; listing it in two groups is a configuration error.
- Group names must be unique.
- A group needs at least two models.
- Opt in only for models whose answers are good enough for the use case: Tollwise has no quality
  metric of its own and will route purely on price, speed or the `balanced` score among group
  members.

Ready-made groups per model class, `frontier` and `small-fast`, can be turned on with one line,
`routing.equivalence_presets: [small-fast]`, instead of being written by hand. A preset that is on
becomes an ordinary group named like it and follows every rule above. See
[`docs/equivalence-presets.md`](equivalence-presets.md) for each preset's models, why they are
grouped and their known limits.

## Per-request headers

| Header | Direction | Effect |
|---|---|---|
| `x-tollwise-policy` | request | Overrides `routing.policy` for this request only: `cheapest`, `fastest`, `balanced` or `pinned`. `pinned` without `routing.pinned` configured, or any other value, is `400 invalid_routing_policy`. |
| `x-tollwise-provider` | request | Restricts routing to this provider (every other candidate is excluded with `provider_not_requested`), or names the provider a passthrough is sent to. One of `anthropic`, `openai`, `deepseek`, `openrouter`, `ollama`; any other value is `400 invalid_provider`. |
| `x-tollwise-request-id` | response | A new id for this request; also sent with every error Tollwise answers for it. |
| `x-tollwise-provider` | response | The provider that served the request (the last one tried, on a failure). |
| `x-tollwise-model` | response | The model id actually sent to that provider (percent-encoded if it is not printable ASCII). |
| `x-tollwise-policy` | response | The routing policy that was applied. |
| `x-tollwise-routed` | response | `true` when routing actively chose the target, `false` for a passthrough. |
| `x-tollwise-attempts` | response | How many providers were called for this request, this one included. |
| `x-tollwise-translated` | response | `true` when the provider spoke the other API format and the request and its answer were translated, `false` otherwise. |
| `x-tollwise-requested-model` | response | The model id the request asked for (percent-encoded if it is not printable ASCII). Also on a `422` refusal. |
| `x-tollwise-substituted` | response | `true` when that provider was sent another model than the one requested, allowed by an [equivalence group](#equivalence-groups); `false` for the requested model on any provider, a passthrough and a `422` refusal. |
| `x-tollwise-equivalence-group` | response | Only when `x-tollwise-substituted` is `true`: the name of the group that allowed the substitution (a preset's name for a preset), percent-encoded if it is not printable ASCII. |
| `x-tollwise-cost-usd`, `x-tollwise-savings-usd`, `x-tollwise-cost-origin`, `x-tollwise-price-verified-on` | response | Cost of the request, on a served non-streamed answer only; see [`docs/api.md`](api.md#cost-headers). |

## Trace

Every provider call made for a request is recorded in its trace, in order; a request refused
before any provider was called has an empty trace. The trace is exposed in three places, all
reading the same underlying data:

- **`GET /api/requests`** and **`GET /api/events`** (`request` events): each entry's `trace` field
  lists every provider tried, in order, with its outcome (`ok`, `client_aborted`, or the provider
  error kind), HTTP status (`null` when there was none) and duration in milliseconds. Its `route`
  field carries the requested and used model/provider, the policy and the decision
  (`routed` / `passthrough` / `fail`), and its `reason` field is a one-line, human-readable summary
  derived only from those stored fields.
- **The local analytics database** (`docs/privacy.md`) stores the same trace, as metadata only.
- **Response headers**, once a target has been chosen, per [Per-request headers](#per-request-headers)
  above.

None of these ever carries a URL, a request header or a body: a trace entry is `{ provider, model,
outcome, status, duration_ms }` only, and the model id is masked the same way a log line would be if
it happened to contain something key-shaped.

Inside the proxy, and in the log line written for a request that needed more than one attempt, each
trace entry also has a `substitution` field: `null` when that attempt sent the requested model (on any
provider), otherwise `{ requested_model, served_model, group }`, the model asked for, the model sent
instead and the name of the [equivalence group](#equivalence-groups) that allowed it. Its model ids are
masked like the entry's `model`; the group name comes from the configuration and is kept as written.
The request's outcome carries the same field for the attempt that served it (or failed last). Only that
request-level substitution is stored in the analytics database (see [`docs/privacy.md`](privacy.md)), and
each entry of `GET /api/requests` and `GET /api/events` reports it as `substituted` and `substitution`
(see [`docs/api.md`](api.md#model-substitution)); the `trace` entries there do not have the field. The
response headers above report it for every answer.
