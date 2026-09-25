# Configuration

Tollwise runs on built-in defaults and needs no configuration file at all. Every field described
here is optional; an empty file, or no file, is a valid configuration. To change anything, copy the
annotated example and edit the copy:

```
cp tollwise.example.yaml tollwise.yaml
```

Check a configuration at any time, without starting the proxy:

```
node src/cli.ts config check
node src/cli.ts config check --config path/to/file.yaml
```

It prints `OK: configuration is valid.` followed by the effective, fully-defaulted configuration, or
every problem found (file, line, column and a fix hint for each), and exits `1` when the
configuration is invalid. API keys are never printed, only whether each one is set.

## How a configuration is built

Three layers, each overriding the previous one:

1. **Built-in defaults** (`src/config/schema.ts`) — used for every field a file or the environment
   does not set.
2. **A YAML file**, chosen in this order: the `--config` path, else the `TOLLWISE_CONFIG`
   environment variable, else `./tollwise.yaml` when it exists. No file at all is valid.
3. **A handful of environment variables** (below), which override the file for the few settings
   that make sense to change per-environment without editing a file.

`TOLLWISE_ACCESS_KEY` is read from the environment only; it is never part of the file and never
appears in the effective configuration Tollwise prints or logs.

The file is validated strictly: an unknown field, wrong type, or out-of-range value is refused with
a message naming the exact field, its position in the file, and a hint — the configuration never
partially applies. A value that looks like a literal API key or credential (in a value, or as the
name of an `api_key_env` field) is refused everywhere in the file, because keys must come from
environment variables only (see [Provider keys are never in the file](#provider-keys-are-never-in-the-file)
below).

## `server`

Where Tollwise listens, and which requests it accepts.

| Field | Type | Default | Notes |
|---|---|---|---|
| `server.host` | host name or IP address | `127.0.0.1` | The address to listen on. A loopback address (`localhost`, any `127.x.x.x` address, or `::1`) only accepts connections from this machine. Any other value (including `0.0.0.0` and `::`) also requires `TOLLWISE_ACCESS_KEY` to be set to at least 16 characters, or Tollwise refuses to start (see [Exposing Tollwise on a network](#exposing-tollwise-on-a-network)). |
| `server.port` | integer, 1–65535 | `8484` | The port to listen on. |
| `server.max_body_size` | a whole number of bytes, or a size string with unit `b`, `kb`/`kib`, `mb`/`mib` or `gb`/`gib`, such as `20mb`, `512kb`, `1gb` (1 KB = 1024 bytes) | `20mb` | Largest request body accepted; a larger one is answered `413`. Allowed range: 1 KB to 512 MiB. |
| `server.allowed_hosts` | list of host names or IP addresses | `[]` | Extra names or addresses clients may use in their `Host` header to reach Tollwise, in addition to `127.0.0.1`, `localhost`, `[::1]` and the configured `server.host` (when it is not a wildcard address). Anything else in `Host` is refused with `421`, which blocks DNS-rebinding attacks from a web page. Write bare names or addresses, no scheme or port, for example `my-machine.local` or `192.168.1.20`; a wildcard address (`0.0.0.0`, `::`) is refused, since no client can use it. |

`server.allowed_hosts` matters only when Tollwise is reachable from another machine: see
[Exposing Tollwise on a network](#exposing-tollwise-on-a-network).

## `providers`

Five fixed provider ids: `anthropic`, `openai`, `deepseek`, `openrouter`, `ollama`. Each has the
same three fields:

| Field | Type | Notes |
|---|---|---|
| `providers.<id>.enabled` | boolean, default `true` | A provider is actually used only when it is enabled **and** its key's environment variable is set, or its `api_key_env` is `null` (as for `ollama` by default). |
| `providers.<id>.base_url` | URL (`http://` or `https://`, no embedded `user:password@`) | Overrides the provider's API address, for example to go through your own gateway. |
| `providers.<id>.api_key_env` | environment variable name (letters, digits and `_`, not starting with a digit), or `null` | The **name** of the environment variable Tollwise reads this provider's key from at call time — never a key value, and never `TOLLWISE_ACCESS_KEY`. `null` means the provider is called with no credential: that is `ollama`'s default, and it is accepted for any provider, so set it only for a server that really needs no key. |

Defaults:

| Provider | `base_url` default | `api_key_env` default |
|---|---|---|
| `anthropic` | `https://api.anthropic.com` | `ANTHROPIC_API_KEY` |
| `openai` | `https://api.openai.com/v1` | `OPENAI_API_KEY` |
| `deepseek` | `https://api.deepseek.com` | `DEEPSEEK_API_KEY` |
| `openrouter` | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` |
| `ollama` | `http://127.0.0.1:11434` | `null` (no key needed) |

A provider whose `api_key_env` is set (not `null`) must use `https://`, or a `base_url` that points
at this machine (`localhost`, any `127.x.x.x` address, or `[::1]`); plain `http://` to any other host is refused, so a key
is never sent unencrypted across a network. A keyless server on your own network (for example a
second Ollama instance) works over plain `http://` by setting `api_key_env: null`.

### Provider keys are never in the file

Tollwise is BYOK (bring your own key): a provider names the environment variable that holds its
key, and Tollwise reads the key from that variable when it makes a call. The configuration file
itself is checked for anything that looks like a literal key or credential — in a plain value, or in
an `api_key_env` field that was typed with an actual key instead of a variable name — and refuses to
load if it finds one, naming the exact location. This also applies to `TOLLWISE_ACCESS_KEY`: that
variable protects Tollwise itself and cannot be named as a provider's `api_key_env`.

## `routing`

How Tollwise decides where a request goes. See [`docs/routing.md`](routing.md) for the full
behaviour; this page lists only the configuration fields.

| Field | Type | Default | Notes |
|---|---|---|---|
| `routing.policy` | `cheapest` \| `fastest` \| `balanced` \| `pinned` | `cheapest` | The routing policy; overridable per request with the `x-tollwise-policy` header. |
| `routing.on_no_candidate` | `passthrough` \| `fail` | `passthrough` | What happens when no configured provider satisfies the request's capabilities. |
| `routing.pinned` | object (see below), optional | unset | Required when `policy` is `pinned` (a configuration error without it) and for a request that sends `x-tollwise-policy: pinned` (answered `400` without it); ignored otherwise. |
| `routing.pinned.provider` | one of `anthropic`, `openai`, `deepseek`, `openrouter`, `ollama` | — | The provider `pinned` targets. |
| `routing.pinned.model` | non-empty string | — | The model id `pinned` targets, exactly as that provider names it. |
| `routing.equivalence_groups` | list of groups (see below) | `[]` | Opts specific models into being treated as interchangeable by routing (see [`docs/routing.md`](routing.md#equivalence-groups)). |
| `routing.equivalence_groups[].name` | non-empty string, unique among groups | — | The group's name (for readability only; not sent to a provider). |
| `routing.equivalence_groups[].models` | list of at least 2 model ids | — | The models in the group. A model may belong to at most one group; listing it in two is a configuration error. |
| `routing.equivalence_presets` | list of preset names: `frontier`, `small-fast` | `[]` | Turns on built-in equivalence groups, one per model class, with one line, e.g. `equivalence_presets: [small-fast]`. Off by default. Each preset follows the same rules as a written group: its models may not appear in any other group, and its name may not be reused by one. See [`docs/equivalence-presets.md`](equivalence-presets.md). |
| `routing.retries` | integer, 0–5 | `1` | Extra attempts on the next eligible candidate after a retryable provider error or timeout. |
| `routing.timeouts` | object (see below) | see below | Per-attempt time limits. |
| `routing.timeouts.connect_ms` | integer, 100–120,000 | `5000` | Time allowed to open a connection to a provider. |
| `routing.timeouts.first_byte_ms` | integer, 100–3,600,000 | `120000` | Time allowed until the provider's first response byte. Must not exceed `total_ms`. |
| `routing.timeouts.total_ms` | integer, 100–3,600,000 | `600000` | Longest a single attempt may take end to end, streaming included. |

## `analytics`

Local request-metadata storage; see [`docs/privacy.md`](privacy.md) for exactly what is (and is
never) stored.

| Field | Type | Default | Notes |
|---|---|---|---|
| `analytics.enabled` | boolean | `true` | `false` turns storage off entirely; no database file is created. |
| `analytics.store_prompts` | boolean | `false` | Storing prompts and answers is not available in this release: `true` is refused as a configuration error. |
| `analytics.path` | file path | `data/analytics.db` | The SQLite file, relative to the directory Tollwise is started from unless given as an absolute path. Its parent folder is created if missing. |

## `logging`

| Field | Type | Default | Notes |
|---|---|---|---|
| `logging.level` | `error` \| `warn` \| `info` \| `debug` | `info` | Logs are JSON, one object per line, to stderr. Keys, `Authorization`, `x-api-key` and similar headers, and request/response bodies are never logged, whatever the level. |

## Environment variables

| Variable | Effect |
|---|---|
| `TOLLWISE_CONFIG` | Path to the configuration file to load, when `--config` is not given. |
| `TOLLWISE_HOST` | Overrides `server.host`. |
| `TOLLWISE_PORT` | Overrides `server.port`; must be a whole number from 1 to 65535. |
| `TOLLWISE_LOG_LEVEL` | Overrides `logging.level`; must be one of `error`, `warn`, `info`, `debug`. |
| `TOLLWISE_ACCESS_KEY` | The local access key clients must send once set (see [Require an access key](#require-an-access-key)). Read from the environment only — never part of the file, never printed, never logged. Must be at least 16 characters with no whitespace. |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `OPENROUTER_API_KEY` | The default `api_key_env` variable names for the matching provider (each provider's `api_key_env` can be changed to point at a different variable name). |

## Require an access key

When `TOLLWISE_ACCESS_KEY` is set, every request except `GET`/`HEAD` on `/healthz` and on the
dashboard's static files (`/dashboard`, which hold no data) must send that value as
`Authorization: Bearer <key>` (what the OpenAI SDK sends) or `x-api-key: <key>` (what the Anthropic
SDK sends). A request without it is answered `401`.

Set it to a random value before starting. In a POSIX shell:

```
export TOLLWISE_ACCESS_KEY="$(node -e "console.log(require('node:crypto').randomBytes(24).toString('hex'))")"
node src/cli.ts start
```

In PowerShell:

```
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$bytes = [byte[]]::new(24)
$rng.GetBytes($bytes)
$env:TOLLWISE_ACCESS_KEY = -join ($bytes | ForEach-Object { $_.ToString('x2') })
node src/cli.ts start
```

The ready line then reads `"access":"key required"`:

```
{"time":"2026-09-24T19:02:46.675Z","level":"info","msg":"Tollwise is ready on http://127.0.0.1:8484","url":"http://127.0.0.1:8484","access":"key required","analytics":"<repository root>\\data\\analytics.db"}
```

From another terminal with the same `TOLLWISE_ACCESS_KEY` set:

```
$ curl -s -H "Authorization: Bearer $TOLLWISE_ACCESS_KEY" http://127.0.0.1:8484/api/health
{"providers":{"ollama":{"state":"up","p50_ms":21,"p95_ms":21,"last_checked":"2026-09-24T19:02:46.692Z","samples":1,"last_error_kind":null}}}
```

A request without the key gets a `401`:

```
$ curl -s http://127.0.0.1:8484/api/health
{"error":{"message":"Missing or invalid Tollwise access key. Send the value of TOLLWISE_ACCESS_KEY as \"Authorization: Bearer <key>\" or \"x-api-key: <key>\" (the api_key of your OpenAI or Anthropic SDK).","type":"invalid_request_error","param":null,"code":"invalid_api_key"}}
```

The [dashboard](dashboard.md#with-an-access-key) asks for the key in a form and keeps it only for
the browser tab.

## Exposing Tollwise on a network

Binding `server.host` (or `TOLLWISE_HOST`) to anything other than a loopback address (`localhost`,
any `127.x.x.x` address, or `::1`) makes Tollwise
reachable from other machines, which would spend your provider keys if anyone else can reach it.
Tollwise refuses to start unless `TOLLWISE_ACCESS_KEY` is also set (at least 16 characters). Clients
on other machines reach Tollwise by a name or address the request guard does not know by default, so
list it in `server.allowed_hosts` (for example `192.168.1.20` or `my-machine.local`); a specific
`server.host` address is accepted automatically, but `0.0.0.0` is a wildcard and Tollwise prints a
startup reminder to list the real addresses clients will use.

## Field reference

Every field of the configuration schema, in dotted-path form, for quick lookup or scripting
(`[]` marks a list element's own fields). This table is checked against the code by an automated
test (`test/configuration-doc.test.ts`), so it can never drift from what `src/config/schema.ts`
actually accepts.

`server.host`, `server.port`, `server.max_body_size`, `server.allowed_hosts`,
`providers.anthropic.enabled`, `providers.anthropic.base_url`, `providers.anthropic.api_key_env`,
`providers.openai.enabled`, `providers.openai.base_url`, `providers.openai.api_key_env`,
`providers.deepseek.enabled`, `providers.deepseek.base_url`, `providers.deepseek.api_key_env`,
`providers.openrouter.enabled`, `providers.openrouter.base_url`, `providers.openrouter.api_key_env`,
`providers.ollama.enabled`, `providers.ollama.base_url`, `providers.ollama.api_key_env`,
`routing.policy`, `routing.on_no_candidate`, `routing.pinned.provider`, `routing.pinned.model`,
`routing.equivalence_groups[].name`, `routing.equivalence_groups[].models`,
`routing.equivalence_presets`, `routing.retries`,
`routing.timeouts.connect_ms`, `routing.timeouts.first_byte_ms`, `routing.timeouts.total_ms`,
`analytics.enabled`, `analytics.store_prompts`, `analytics.path`, `logging.level`.
