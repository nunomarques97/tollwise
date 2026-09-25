# Equivalence presets

By default Tollwise only switches the **provider** serving the exact model a request asks for (for
example the model directly from its vendor, or the same model through OpenRouter). It never answers
with a different model on its own.

**Model substitution** is the opt-in alternative: inside an equivalence group you turn on, routing
may serve a request with another model of the group when it is cheaper or faster by the configured
policy. An equivalence preset is a ready-made group, one per model class, that you turn on with one
line instead of writing the group yourself. No preset is on unless your configuration names it.

Substitution never lowers what the request needs. A substitute is chosen only when it has every
capability the request uses (tools, JSON mode, vision, streaming), room in its context window for
the input plus the requested output, and a max output at least as large as the one requested,
exactly as for any other candidate (see [`docs/routing.md`](routing.md#2-building-the-candidate-list)).
Substituted models do not give identical answers: Tollwise measures no answer quality, so test your
own prompts before turning a preset on.

## Turn a preset on

Add one line under `routing` in your configuration file (see
[`docs/configuration.md`](configuration.md)):

```yaml
routing:
  equivalence_presets: [small-fast]
```

Turn on only `frontier`:

```yaml
routing:
  equivalence_presets: [frontier]
```

Or both:

```yaml
routing:
  equivalence_presets: [frontier, small-fast]
```

Check the result without starting the proxy. `node src/cli.ts config check` prints each preset that
is on with the models it adds, apart from the groups written by hand. Real output for the first
example above (routing section only):

```
routing:
  policy: cheapest
  on_no_candidate: passthrough
  equivalence_groups: []
  equivalence_presets:
    - name: small-fast
      models:
        - claude-haiku-4.5
        - gpt-5.6-luna
        - deepseek-v4.1-flash
  retries: 1
  timeouts:
    connect_ms: 5000
    first_byte_ms: 120000
    total_ms: 600000
```

A preset applies to a request when the model it asks for is a member, by its canonical id (such as
`claude-haiku-4.5`) or by one provider's own id for it (such as `claude-haiku-4-5-20251001`). A
request for any other model keeps the default: provider switching only.

## The presets

Preset definitions are versioned (currently version 1); a change to a preset's members is listed in
[`CHANGELOG.md`](../CHANGELOG.md). Each member is a canonical id from `catalog/models.yaml`, so
every provider in the catalog that serves it joins the group. The figures in the tables come from
the catalog; where providers of one model publish different limits, the table shows the smallest.
Every source link below is the page the catalog entry was verified against.

### `frontier`

The higher-priced general chat model of each vendor in the catalog.

```yaml
routing:
  equivalence_presets: [frontier]
```

| Model | Providers in the catalog | Context window (tokens) | Max output (tokens) | Tools | JSON mode | Vision | Streaming |
|---|---|---|---|---|---|---|---|
| `claude-opus-5` | anthropic, openrouter | 1,000,000 | 128,000 | yes | yes | yes | yes |
| `gpt-6-astra` | openai, openrouter | 1,050,000 | 128,000 | yes | yes | yes | yes |
| `deepseek-v4-pro-0813` | deepseek, openrouter | 1,000,000 | 384,000 | yes | yes | no | yes |

**Why they are grouped.** Each member is the higher-priced of the two general chat models its vendor has in the catalog, and each supports tools, JSON output and streaming, with a context window of about one million tokens and a max output of at least 128,000 tokens, as published on the linked pages.

Sources: [Anthropic models overview](https://platform.claude.com/docs/en/models/overview),
[OpenAI gpt-6-astra model page](https://developers.openai.com/api/docs/models/gpt-6-astra),
[DeepSeek models and pricing](https://api-docs.deepseek.com/quick_start/pricing/).

**Known limits.**

- deepseek-v4-pro-0813 has no vision: a request with an image is never routed to it and stays on the other members.
- Max output differs: 128,000 tokens for claude-opus-5 and gpt-6-astra, more for deepseek-v4-pro-0813; a request asking for more than a member can produce never goes to it.
- The members are served by providers of both API formats; a request using a feature the other format cannot carry (for example an OpenAI json_schema response format, see docs/compatibility.md) is never sent to a provider of the other format.
- Answers, tone, refusals and tool-call style differ between vendors: Tollwise measures no answer quality, so test your own prompts before turning the preset on.

### `small-fast`

The lower-priced general chat model of each vendor in the catalog.

```yaml
routing:
  equivalence_presets: [small-fast]
```

| Model | Providers in the catalog | Context window (tokens) | Max output (tokens) | Tools | JSON mode | Vision | Streaming |
|---|---|---|---|---|---|---|---|
| `claude-haiku-4.5` | anthropic, openrouter | 200,000 | 64,000 | yes | yes | yes | yes |
| `gpt-5.6-luna` | openai, openrouter | 1,050,000 | 128,000 | yes | yes | yes | yes |
| `deepseek-v4.1-flash` | deepseek, openrouter | 1,000,000 | 384,000 | yes | yes | yes | yes |

**Why they are grouped.** Each member is the lower-priced of the two general chat models its vendor has in the catalog, and each supports tools, JSON output, images and streaming, as published on the linked pages.

Sources: [Anthropic models overview](https://platform.claude.com/docs/en/models/overview),
[OpenAI gpt-5.6-luna model page](https://developers.openai.com/api/docs/models/gpt-5.6-luna),
[DeepSeek models and pricing](https://api-docs.deepseek.com/quick_start/pricing/).

**Known limits.**

- claude-haiku-4.5 has a 200,000-token context window and a 64,000-token max output, far below the other members: a request that does not fit never goes to it.
- The members are served by providers of both API formats; a request using a feature the other format cannot carry (for example an OpenAI json_schema response format, see docs/compatibility.md) is never sent to a provider of the other format.
- Answers, tone, refusals and tool-call style differ between vendors: Tollwise measures no answer quality, so test your own prompts before turning the preset on.

### Why there is no preset for local models

The local models in the catalog (served by Ollama) already cost nothing per token, so substituting
between them saves no money, and they differ widely in size, context window and capabilities. Write
your own group if you want routing to choose between them.

## Rules

A preset that is on is expanded into an ordinary equivalence group named like the preset, so it
follows the same rules as a group written by hand (see
[`docs/routing.md`](routing.md#equivalence-groups)). Each of these is a configuration error, reported
with its file, line and a fix hint:

- a name in `equivalence_presets` that is not a preset (the hint lists the valid names);
- the same preset listed twice;
- a preset whose name is also the name of a group in `equivalence_groups`;
- a model that a preset lists and that is also in another group, written by hand or from another
  preset. A model may belong to one group only. This covers a group written by hand that names the
  model by one provider's own id: `claude-haiku-4-5-20251001` or `anthropic/claude-haiku-4.5` in
  `equivalence_groups` next to `small-fast` is an error, like `claude-haiku-4.5` itself.

## Write your own group

When no preset fits, list the models you consider interchangeable under
`routing.equivalence_groups`, by catalog canonical id (every provider serving it joins) or by one
provider's own model id (only that provider's entry joins):

```yaml
routing:
  equivalence_groups:
    - name: local-small
      models:
        - llama3.1-8b
        - qwen2.5-7b
```

Written groups and presets can be on together, as long as no model is in both. See
[`docs/routing.md`](routing.md#equivalence-groups) for every rule.

## How a substitution shows

A substitution is never silent. Today it shows in these places:

- **Response headers.** Every answer of `/v1/chat/completions` and `/v1/messages` sent to a
  provider, streamed or not, a provider's error included, and every `422` refusal carries
  `x-tollwise-requested-model` (the model your request asked for) and `x-tollwise-substituted: true`
  or `false`. When it is `true`,
  `x-tollwise-equivalence-group` names the group that allowed it (the preset's name for a preset),
  `x-tollwise-model` is the model id actually sent and `x-tollwise-provider` the provider that
  served it (see [`docs/routing.md`](routing.md#per-request-headers)). A switch to another provider
  of the same model, a passthrough and a `422` refusal say `false`.
- **The routing trace.** Each trace entry logged for a request that needed more than one attempt
  has a `substitution` field: `null`, or `{ requested_model, served_model, group }` for an attempt
  sent another model (see [`docs/routing.md`](routing.md#trace)).
- **The local API.** Each entry of `GET /api/requests` and of the `request` events of
  `GET /api/events` has `substituted` (`true`, `false`, or `null` for a request stored before this
  was recorded) and `substitution`: `{ requested_model, served_model, group }` when it is `true`,
  else `null`. `GET /api/metrics/summary` counts the window's substituted requests in
  `substituted_requests` (see [`docs/api.md`](api.md#model-substitution)). The analytics database
  stores these two model ids and the group name with each request, nothing more (see
  [`docs/privacy.md`](privacy.md)).
- **The dashboard.** The requests table shows the requested model next to the provider and model
  that served it, and the trace drawer starts its route with the requested model and prices the
  request on both the served and the requested model.
