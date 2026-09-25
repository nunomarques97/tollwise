# Privacy

Tollwise is local-first and private by default: it keeps a local record of what it routed so you
can see your spend and savings, and nothing more. This page states exactly what that record
contains, where it lives, how to remove it, and what Tollwise sends over the network at all.

## No telemetry

Tollwise never phones home. It contacts a network address only for one of these, and never any
other:

- **Provider calls.** Only the providers you enable, and only when you actually send a chat request
  that routes to them, or during a health check (below). Never your prompts or answers to anyone
  else, and never anything to Tollwise's own developers or any third-party analytics service —
  there is none.
- **Provider health checks.** About once a minute, one request for the models list (which costs
  nothing) to each enabled provider whose key is set, or that needs none such as Ollama, to know
  whether it is currently reachable (the result is shown by `GET /api/health`). No request content
  is involved, and a provider whose key is not set is never contacted.
- **The pricing catalog source**, only when you explicitly run `node src/cli.ts catalog update`: one
  public, read-only endpoint (`https://openrouter.ai/api/v1/models` by default, or the URL you
  pass with `--source-url`), which needs no key. Nothing is written to disk unless you add `--write`.

No other outbound connection exists in Tollwise. Running it requires no account, no license check,
and no external service.

## What is stored, and where

While Tollwise runs, it stores one row per chat request that reaches routing — served, fallen back,
failed, cut short, or refused because no provider could take it — in a local SQLite file
(`analytics.path`, default `data/analytics.db`, relative to the directory you start Tollwise from
unless given as an absolute path; the folder is created if missing). The startup log line names the
full path, or says `off`. A request rejected before routing, because it could not be read at all (a
body that is not valid JSON or not a valid request, a missing required header, an invalid
`x-tollwise-policy` or `x-tollwise-provider` value, or no provider configuration loaded), is not
stored.

**What is stored — metadata only.** This is every column of the `request_events` table:

- when the request happened (`timestamp_ms`), and how long it took (`latency_ms`; `first_byte_ms`,
  the time to the provider's response head, for a stream);
- the request id (`request_id`): a random UUID Tollwise generates for each request, the same value
  it returns in the `x-tollwise-request-id` response header — never an id taken from your client;
- the API format the request used (`format`: `openai` or `anthropic`);
- the model and provider requested, and the model and provider actually used (`null`/`null` when
  the request was refused before any provider was tried);
- which capabilities the request needed (tools, JSON mode, vision, streaming);
- the routing policy and decision (`routed` / `passthrough` / `fail`);
- how many providers were called (`attempts`; `0` for a refused request);
- the routing trace: every provider attempted, in order, with the model sent to it, its outcome,
  HTTP status and duration — never a URL, a header or a body;
- token counts (input, cached input, output), and whether they came from the provider's own report
  or Tollwise's pre-call estimate;
- cost, baseline cost and savings in USD, and the catalog date each price was last verified;
- what routing chose from (`selection`): how many catalog entries it examined, the candidate
  providers and models in the order the policy ranked them with their catalog prices, and each
  entry it ruled out with its reason code (for example `missing_capability:vision`);
- the catalog prices behind the cost and savings (`price`): for the model used and the model
  requested, the input and output price per million tokens, the date it was verified and the
  catalog's public pricing page it was copied from (`source_url`), as they were when the request
  was routed, so a later catalog update never changes a stored row;
- whether the request was served by another model than the one it asked for, which only an
  [equivalence group](routing.md#equivalence-groups) turned on in the configuration allows
  (`substituted`: `1` or `0`; empty on rows stored before this was recorded) and, when it was, the
  model requested, the model sent instead and the name of the group that allowed it
  (`substitution_requested_model`, `substitution_served_model`, `substitution_group`) — two model
  ids and a group name from your configuration, nothing else;
- the final status (`complete`, `provider_error`, `interrupted`, `client_aborted`,
  `translation_failed`, or `refused`).

The only other table, `schema_migrations`, records which database schema versions have been applied
and when; it holds nothing about your requests.

**What is never stored, under any setting:** prompts, answers, request or response headers, request
or response bodies beyond the usage numbers above, provider error messages, URLs (other than the
catalog's public pricing page for a stored price), and API keys or the access key. Any model
id that happens to look like it carries a credential is masked before it is ever stored. There is no
column for any of these in the database schema, so there is nothing to opt out of beyond turning
storage off entirely.

`analytics.store_prompts: true` is refused as a configuration error: storing prompts and answers is
not available in this release, and Tollwise will not start with that setting on rather than silently
ignore it.

A row is written only after the response has been sent to you, so storage is never on the critical
path between a provider's answer and your client. Rows are queued and written in batches, one
transaction per batch. If a write fails, the request itself is unaffected, but the rows of that
batch are dropped, not retried; Tollwise logs a warning with the error class, the SQLite result code
and the number of rows dropped only (never an error message, which could quote a value), at most
once a minute.

## Who can read it

The database is a plain, unencrypted SQLite file on your machine, openable with any SQLite tool.
When Tollwise creates the file (and its folder), it creates them readable and writable by your user
account only on Linux and macOS (file mode `0600`, folder `0700`); on Windows the file inherits the
folder's permissions. An existing file or folder keeps the permissions it already has.

Nothing in Tollwise sends its contents anywhere; the only way its content leaves this machine is
you copying the file, or a program you run reading it directly, or reading it through the local
`/api/metrics/*`, `/api/requests` and `/api/events` endpoints described in
[`docs/api.md`](api.md#api--local-read-only) — themselves local-only unless you deliberately expose
Tollwise on a network (see [`docs/configuration.md`](configuration.md#exposing-tollwise-on-a-network)),
and protected by `TOLLWISE_ACCESS_KEY` like every other route once you set one.

## Turning it off

Set `analytics.enabled: false` (see [`docs/configuration.md`](configuration.md#analytics)). No
database file is created at all, and `/api/metrics/*` and `/api/requests` answer
`503 analytics_disabled`, since there is nothing to read. The live `/api/events` stream still sends
a `request` event as each request ends, held in memory only for as long as it takes to send it to
the clients connected to that stream; nothing is written to disk.

## Deleting it

Nothing is ever deleted automatically — Tollwise never rotates or prunes old rows. To clear the
history:

1. Stop Tollwise.
2. Delete the database file (`analytics.path`, default `data/analytics.db`).

While Tollwise is running, SQLite keeps two companion files next to the database
(`analytics.db-wal`, `analytics.db-shm`); a clean stop removes them. If Tollwise was not stopped
cleanly, delete those two files as well as the main one. From the repository root, with the
default path, in a POSIX shell:

```
rm -f data/analytics.db data/analytics.db-wal data/analytics.db-shm
```

In PowerShell:

```
PS> Remove-Item data/analytics.db, data/analytics.db-wal, data/analytics.db-shm -ErrorAction SilentlyContinue
```

A new, empty file is created the next time Tollwise starts. `data/demo.db` is the separate history
of `npm run demo`.

## Logs

Tollwise writes its log to standard error only, never to a file of its own. At the default `info`
level, each request produces one line with its method, its path (without the query string), the
HTTP status and the duration, plus `aborted: true` when the connection closed before the response
was finished. Routing, fallback and provider events add the Tollwise request id,
provider ids, model ids (masked like everything else), error kinds, HTTP statuses and durations; the
startup line names the address Tollwise listens on and the analytics database path. Request and response headers and bodies, keys and
the access key are never logged at any level. Where standard error ends up (a terminal, a service
manager's journal, a file you redirect it to) is up to how you run Tollwise.

## Provider keys

Provider keys and `TOLLWISE_ACCESS_KEY` are read from environment variables only. They are never
written into the configuration file (a value that looks like one is refused when loading the file),
never printed by `node src/cli.ts config check` (which only reports whether each is set), never
logged, and `Authorization`/`x-api-key`/other credential headers a client sends are stripped from
the request before it reaches any logging or forwarding code path.
