# Security

## Your keys

Tollwise is bring-your-own-key. Keys are read from environment variables only: the configuration file names the variable that holds each provider's key (`api_key_env`) and never contains a key itself, and Tollwise refuses a file with a value that looks like one. Tollwise never logs them (they are redacted from every log line), and never sends a provider key anywhere except to the provider it belongs to.

## Network exposure

Tollwise listens on `127.0.0.1` by default, so other machines cannot connect to it. Web pages open in your browser run on this machine, so every request is also checked before it goes any further: the `Host` header must name Tollwise (`127.0.0.1`, `localhost`, `[::1]` with its port, or a host in `server.allowed_hosts`), requests carrying an `Origin` from another site are refused, `OPTIONS` preflights are refused, no CORS header is ever sent, and `POST` requests must be `Content-Type: application/json`. This protects your keys against DNS rebinding and cross-site requests. Listening on any other address requires `TOLLWISE_ACCESS_KEY`.

## Local analytics database

Tollwise stores one row per chat request it routes in a local SQLite file (`data/analytics.db` by default). That row holds metadata only: timestamps, the model and provider requested and used, the capabilities the request needed, the routing policy and decision, the routing trace (each provider tried, its outcome, HTTP status and duration), token counts and cost/savings figures. It never holds prompts, answers, request or response headers, URLs, or keys; `analytics.store_prompts: true` is refused. The database is on your machine only (the default `data/` directory is git-ignored), and Tollwise never sends it anywhere. Turn it off with `analytics.enabled: false`. To erase the history, stop Tollwise, then delete the database file and, if they are still there, its `analytics.db-wal` and `analytics.db-shm` companion files. See [`docs/privacy.md`](docs/privacy.md) for the exhaustive list.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private vulnerability reporting on this repository ("Security" tab → "Report a vulnerability"). You will get an answer as soon as possible.

## For contributors

- A pre-commit hook (`.githooks/pre-commit` → `scripts/guard-keys.mjs`) blocks commits that contain key-shaped values or key files. Enable it with `git config core.hooksPath .githooks` and never bypass it.
- Use fake keys in tests and mark those lines with `tollwise-allow-secret`.
