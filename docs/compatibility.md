# API compatibility

Tollwise sits behind the standard `base_url` of the official OpenAI and Anthropic SDKs. This page
lists exactly what it supports, what it does not, how a request can cross from one API format to a
provider that speaks the other, and the headers it adds along the way.

## Supported endpoints

| Endpoint | Format | Streaming | Tools / function calling | JSON mode | Vision |
|---|---|---|---|---|---|
| `POST /v1/chat/completions` | OpenAI Chat Completions | yes (SSE) | yes | yes (`response_format`) | yes (image content parts) |
| `POST /v1/messages` | Anthropic Messages | yes (SSE) | yes | no native field; a client-sent `response_format` is only a routing signal (see [Known limits](#known-limits)) | yes (image content blocks) |
| `GET /v1/models`, `GET /v1/models/{id}` | both | — | — | — | — |

`GET /v1/models` never calls a provider: it lists every model backed by at least one provider that
is enabled and has its key configured (or needs no key, such as a local Ollama), taken from the
local pricing catalog. It answers in the
OpenAI list shape (`{ object: "list", data: [...] }`) by default, or in the Anthropic shape
(`{ data: [...], has_more, first_id, last_id }`) when the request carries an `anthropic-version`
header — the same signal the official Anthropic SDK sends.

Whether a given *model* actually has tools, JSON mode, vision or streaming is a property of that
model's catalog entry, not of the endpoint: a request that needs a capability a model does not have
is never routed to it (see [Routing effects](#routing-effects-of-a-translation-difference) below).

A request whose `Content-Type` is not `application/json`, or whose body is not valid JSON, is
answered `415` or `400` before any provider is contacted.

## Unsupported endpoints

Every other OpenAI API family answers `501` instead of `404`, so a client gets a clear, typed error
instead of "not found":

```json
{
  "error": {
    "message": "The /v1/embeddings endpoint is not supported by Tollwise. Tollwise routes chat requests only; call the provider directly for this endpoint.",
    "type": "invalid_request_error",
    "param": null,
    "code": "unsupported_endpoint"
  }
}
```

This covers `/v1/responses`, `/v1/embeddings`, `/v1/images`, `/v1/audio`, `/v1/batches` and
`/v1/assistants` (and anything nested under them, e.g. `/v1/images/generations`). Call those
providers directly; Tollwise's scope is chat requests only.

## Cross-format routing

A provider does not have to speak the same API format as the endpoint a client called. When the
cheapest, fastest or otherwise best-ranked candidate for a request is a provider that speaks the
*other* format, Tollwise translates the request to that format, sends it, and translates the answer
(streamed or not) back to the format the client called with. The client never sees a difference in
shape; it only sees the model, provider and price Tollwise chose.

This only happens when the translation would be faithful. Before ranking a cross-format provider as
a candidate, Tollwise checks whether translating the request would drop anything the request
actually uses. If it would, that provider is excluded from routing for this request — it is never
silently downgraded, and it is never sent a translated request that lost something.

## Translation differences

The two API formats do not have a one-to-one mapping for every field. The table below lists every
feature a translation cannot carry over faithfully, the direction(s) it applies to, and what
happens to routing when a request uses it. Every one of these is checked *before* a candidate is
picked, not discovered after the fact.

| Code | What it means | Direction |
|---|---|---|
| `malformed_request` | The request is not a valid body for its own format. | both |
| `unknown_field` | A field the translator does not recognise, so it cannot promise to keep it. | both |
| `unknown_content_type` | A content part or block type the translator does not know. | both |
| `assistant_prefill` | The conversation ends with an assistant message. Anthropic continues it (prefill); OpenAI would answer it with a new message. | both |
| `message_name` | The OpenAI message `name` field. Anthropic messages have no participant names. | OpenAI → Anthropic |
| `system_message_position` | A system/developer message after the conversation has started. Anthropic only takes a leading system prompt. | OpenAI → Anthropic |
| `max_tokens_missing` | Neither `max_completion_tokens` nor `max_tokens` was set. Anthropic requires an explicit output budget; OpenAI does not, and Tollwise has no setting for a default one. | OpenAI → Anthropic |
| `temperature_out_of_range` | `temperature` above 1. Anthropic accepts 0–1, OpenAI 0–2. | OpenAI → Anthropic |
| `image_media_type` | An inline image whose format Anthropic does not accept (it takes JPEG, PNG, GIF or WebP only). | OpenAI → Anthropic |
| `openai_image_detail` | An image with `detail: "low"` or `"high"`. Anthropic has no per-image detail setting. | OpenAI → Anthropic |
| `openai_n` | `n` greater than 1. Anthropic always returns exactly one completion. | OpenAI → Anthropic |
| `openai_logprobs` | `logprobs` or `top_logprobs`. Anthropic does not return token log probabilities. | OpenAI → Anthropic |
| `openai_logit_bias` | `logit_bias`. Anthropic has no token biasing. | OpenAI → Anthropic |
| `openai_penalties` | A non-zero `presence_penalty` or `frequency_penalty`. Anthropic has no repetition penalties. | OpenAI → Anthropic |
| `openai_seed` | `seed`. Anthropic has no deterministic sampling seed. | OpenAI → Anthropic |
| `openai_legacy_functions` | The deprecated `functions`/`function_call` fields or the `"function"` role. | OpenAI → Anthropic |
| `openai_audio` | Audio input or output (`input_audio` parts, `audio`, non-text `modalities`). | OpenAI → Anthropic |
| `openai_file_input` | A `"file"` content part. | OpenAI → Anthropic |
| `openai_store` | Stored completions (`store: true`, or non-empty `metadata`). Anthropic stores nothing for later retrieval. | OpenAI → Anthropic |
| `openai_prediction` | Predicted outputs (`prediction`). | OpenAI → Anthropic |
| `openai_reasoning_effort` | `reasoning_effort`. It has no exact Anthropic equivalent. | OpenAI → Anthropic |
| `openai_service_tier` | A `service_tier` other than `"auto"`. | OpenAI → Anthropic |
| `openai_custom_tool` | A tool or `tool_choice` that is not a plain function (custom tools, `allowed_tools`). | OpenAI → Anthropic |
| `json_schema` | `response_format` of type `json_schema`. Schema-constrained output has no faithful Anthropic mapping. | OpenAI → Anthropic |
| `json_mode_with_tools` | `response_format: json_object` used together with `tools`/`tool_choice`. JSON mode is carried by a forced tool call, which the caller's own tools would conflict with. | OpenAI → Anthropic |
| `tool_strict` | A tool with `strict: true` (schema-constrained arguments). | both |
| `tool_arguments_not_json` | A tool call in the conversation history whose arguments are not a JSON object. | both |
| `assistant_refusal` | An assistant refusal in the history. Anthropic messages have no refusal field. | OpenAI → Anthropic |
| `anthropic_cache_control` | `cache_control` (prompt caching). OpenAI caches automatically and takes no cache markers. | Anthropic → OpenAI |
| `anthropic_thinking` | Extended thinking (`thinking`, or `thinking`/`redacted_thinking` blocks in the history). | Anthropic → OpenAI |
| `anthropic_top_k` | `top_k`. OpenAI has no top-k sampling. | Anthropic → OpenAI |
| `anthropic_document` | A document (PDF or text) content block. | Anthropic → OpenAI |
| `anthropic_file_source` | An image that references an uploaded file (`source.type: "file"`). | Anthropic → OpenAI |
| `anthropic_citations` | Citations on a text block. | Anthropic → OpenAI |
| `anthropic_server_tool` | A server tool or connector (web search, code execution, computer use, MCP servers, ...). | Anthropic → OpenAI |
| `anthropic_service_tier` | A `service_tier` other than `"auto"`. | Anthropic → OpenAI |
| `anthropic_beta` | The `anthropic-beta` header. Beta features change API behaviour and have no OpenAI equivalent. | Anthropic → OpenAI |
| `tool_result_error` | A `tool_result` marked `is_error`. OpenAI tool messages cannot flag an error. | Anthropic → OpenAI |
| `tool_result_image` | An image inside a `tool_result`. OpenAI tool messages carry text only. | Anthropic → OpenAI |
| `assistant_text_after_tool_use` | An assistant text block after a `tool_use` block. OpenAI keeps text and tool calls apart, so the order would be lost. | Anthropic → OpenAI |
| `too_many_stop_sequences` | More than 4 stop sequences. OpenAI accepts at most 4. | Anthropic → OpenAI |

### Routing effects of a translation difference

When a request uses one of the features above, every candidate whose provider speaks the other API
format is excluded from routing with the reason `untranslatable:<code>` (the first code found).
Candidates that speak the request's own format, and cross-format candidates when the request uses
none of these features, are ranked as usual. A request is never sent translated when it would lose
something.

If that leaves **no** candidate, the configured `routing.on_no_candidate` decides what happens, with
or without `x-tollwise-provider`:

- **`fail`**: the request is answered `422 no_capable_provider`, naming each entry that was ruled out
  and why (for a translation difference: the untranslatable code). A model that is not in the
  catalog at all is answered `422 model_not_in_catalog` instead. Nothing is sent to a provider.
- **`passthrough`** (the default): the request goes to the originally requested model, not routed,
  at the provider named in `x-tollwise-provider`, or, when no provider is named, at the provider that
  natively speaks the endpoint's format (`openai` for `/v1/chat/completions`, `anthropic` for
  `/v1/messages`). A provider of the endpoint's format gets the request unchanged. Only when that
  provider speaks the *other* format and the request cannot be translated to it is the request
  answered `422 format_not_supported`, naming the codes that block it. A passthrough provider that is
  not configured (disabled, or its key is not set) is answered `422 provider_not_configured`.

### Response translation problems

Even a faithfully-translated request can get back an answer Tollwise cannot represent in the
client's format — for example a response with more than one choice, or a tool call whose recorded
arguments are not valid JSON. These are reported with their own codes (`malformed_response`,
`unsupported_response_content`, `unknown_stop_reason`, `multiple_choices`,
`tool_arguments_not_json`, `incomplete_stream`, `interleaved_tool_calls`). A non-streamed answer that
cannot be translated is never passed on in part: the client gets `502 response_not_translatable`
naming the problem codes instead. A streamed answer that hits one of these mid-stream ends with a
single error event in the client's own format; whatever was already streamed stands.

### Response mapping

A translated answer keeps its meaning, but a few fields cannot keep their exact form, because the
client's format has no place for them. This is what a client receives when its request was served
by a provider of the other format:

- **Stop reason.** OpenAI → Anthropic client: `stop` becomes `end_turn`, `length` becomes
  `max_tokens`, `tool_calls` becomes `tool_use`, `content_filter` becomes `refusal`. OpenAI does not
  say whether a stop sequence matched, so an Anthropic client always gets `end_turn` with
  `stop_sequence: null`, never `stop_sequence`. Anthropic → OpenAI client: `end_turn` and
  `stop_sequence` become `stop` (which sequence matched is not reported; OpenAI has no field for it),
  `max_tokens` and `model_context_window_exceeded` become `length`, `tool_use` becomes `tool_calls`,
  `refusal` becomes `content_filter`.
- **Refusals.** An OpenAI answer's `refusal` text reaches an Anthropic client as an ordinary text
  block after the content; the stop reason is the one the provider gave (usually `end_turn`).
- **Token usage.** For an OpenAI client, `prompt_tokens` counts every input token, cached or not:
  Anthropic's cache reads and cache writes are added in, and cache reads are also reported as
  `prompt_tokens_details.cached_tokens`. Cache writes have no separate OpenAI field. For an Anthropic
  client, `input_tokens` excludes the cached tokens the provider reported, which go to
  `cache_read_input_tokens`; `cache_creation_input_tokens` is `0` when the provider reported cache
  details (OpenAI charges nothing to write its cache) and `null` when it did not.
- **Streamed usage for an Anthropic client.** An OpenAI-format stream reports usage only at its
  end, so the translated `message_start` event carries zero token counts; the real counts arrive in
  `message_delta`, which the official SDK merges into the final message.
- **JSON mode for an OpenAI client.** `response_format: {"type": "json_object"}` is sent to an
  Anthropic-format provider as one forced tool call named `json_response`; the tool call's input
  becomes the message content (streamed as content pieces) and its `tool_use` stop becomes `stop`.
  Any text block the provider writes next to that call is not passed on, since the content must be
  the JSON object alone.
- **Identity fields.** The answer keeps the provider's own message `id` and the served `model`.
  The OpenAI `created` time is when Tollwise received the provider's answer.

## Headers

### Headers Tollwise reads

| Header | Effect |
|---|---|
| `x-tollwise-policy` | Overrides the configured routing policy for this request only. One of `cheapest`, `fastest`, `balanced`, `pinned`. `pinned` is refused with `400` unless a pinned target is configured. Any other value is a `400 invalid_routing_policy`. |
| `x-tollwise-provider` | Restricts routing to this provider, or names the provider a passthrough is sent to. One of `anthropic`, `openai`, `deepseek`, `openrouter`, `ollama`. Any other value is a `400 invalid_provider`. |
| `anthropic-version` (on `POST /v1/messages`, required) | Required, as on the real Anthropic API; a request without it is answered `400` before its body is read. |
| `anthropic-version` (on `GET /v1/models`) | Its presence, not its value, selects the Anthropic response shape. |
| `anthropic-beta` | Forwarded to a native Anthropic provider. A request that sets it is never translated to the other format, because a beta feature has no OpenAI equivalent (`anthropic_beta`). |

### Headers Tollwise adds to every proxied answer

| Header | Meaning |
|---|---|
| `x-tollwise-request-id` | A new id for this request; also sent with every error Tollwise itself answers. |
| `x-tollwise-provider` | The provider that served the request (the last one tried, on a failure). |
| `x-tollwise-model` | The model id sent to that provider (percent-encoded if it is not printable ASCII). |
| `x-tollwise-policy` | The routing policy that was applied. |
| `x-tollwise-routed` | `true` when routing chose the target, `false` for a passthrough. |
| `x-tollwise-attempts` | How many providers were called for this request, this one included. |
| `x-tollwise-translated` | `true` when the provider speaks the other API format and the request and its answer were translated, `false` otherwise. |
| `x-tollwise-requested-model` | The model id the request asked for (percent-encoded if it is not printable ASCII). |
| `x-tollwise-substituted` | `true` when that provider was sent another model than the one requested, allowed by an equivalence group turned on in the configuration (see [`docs/equivalence-presets.md`](equivalence-presets.md)); `false` otherwise. |
| `x-tollwise-equivalence-group` | Only on a substituted answer: the name of the group that allowed it (percent-encoded if it is not printable ASCII). |

Any `x-tollwise-*` header a provider's own response happens to send back is dropped before the
answer reaches the client: only the ones Tollwise itself sets are ever present.

## Known limits

- **Pricing is flat per-token.** The catalog records one input price and one output price (plus an
  optional cached-input price) per model, in USD per million tokens. Tiered pricing (a different
  rate above a volume threshold) and time-of-day pricing are not modelled: routing and cost
  estimates always use the flat rate on file, even for a provider that varies its price by volume or
  time.
- **Cost estimates used for ranking are approximate.** Before a call is made, the input token count
  used to rank candidates by price is an estimate (`gpt-tokenizer` for OpenAI-format requests, a
  characters-per-token heuristic for Anthropic-format ones, since Anthropic publishes no offline
  tokenizer) — never the number shown to a user as an actual cost. Once a call completes, the
  provider's own reported usage is always the source of truth.
- **An OpenAI request with no output budget can never reach an Anthropic-format provider.** Anthropic
  requires `max_tokens`; OpenAI does not require an equivalent field, and Tollwise currently has no
  configuration setting for a default output budget to fill that gap. Such a request is excluded
  from every Anthropic-format candidate with `untranslatable:max_tokens_missing`.
- **Anthropic's Messages API has no `response_format` field, and Tollwise does not add JSON mode to
  it.** A client that sends one anyway to `/v1/messages` (an OpenAI-shaped body) gets three things:
  routing treats the request as needing JSON mode, so only models whose catalog entry lists JSON
  mode are candidates; the field is sent to the Anthropic-format provider unchanged, inside the
  otherwise untouched body, where the provider decides what to do with it; and, because the field is
  not part of the Anthropic format, the request cannot be translated (`unknown_field`), so it never
  reaches an OpenAI-format provider. Tollwise does not strip the field and does not turn it into JSON
  output.
- **A streamed OpenAI-format request always asks the provider for usage.** Token usage is how
  Tollwise computes cost, and an OpenAI-format stream reports it only when
  `stream_options.include_usage` is `true`. When the client did not set it, Tollwise sets it on the
  request it sends (keeping any other `stream_options`) and removes the extra usage-only chunk
  (`"choices": []`) from the stream the client receives. The other chunks reach the client as the
  provider sent them; a provider that follows the OpenAI format adds `"usage": null` to each of them
  when usage is requested, so the client may see that field although it did not ask for usage.
- **A model's capabilities are only as accurate as the pricing catalog.** Whether a specific model
  supports tools, JSON mode, vision or streaming comes from its catalog entry (`catalog/models.yaml`),
  each with its own source and verification date; it is not queried from the provider at request
  time.
