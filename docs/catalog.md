# Pricing and capability catalog

`catalog/models.yaml` records, for each model a provider serves, the price, context window and
capabilities that routing and cost accounting use. Each entry includes its source and the date it
was last verified; that date is what `x-tollwise-price-verified-on` and the dashboard report next to
every amount.

## Update it

To compare the catalog with the public OpenRouter models list:

```
node src/cli.ts catalog update
```

Without `--write`, nothing on disk changes: the command only prints a diff of changed, added and
removed entries. Add `--write` to apply the changed fields in place. Entries are never added or
removed automatically, because choosing them is a curation decision. By default the command fetches
one public, read-only endpoint (`https://openrouter.ai/api/v1/models`), which needs no key.

Real output from a run against a small local stand-in for the upstream list, so that no request left
the local machine. The stand-in lists two models: one catalog model with a changed input price, and
one model the catalog does not have.

```
$ node src/cli.ts catalog update --source-url http://127.0.0.1:8799
Comparing catalog/models.yaml (openrouter entries) against http://127.0.0.1:8799/

Changed (1):
  openrouter/anthropic/claude-haiku-4.5
    price.input: 1 -> 1.2

Added upstream, not yet in the catalog (1, not written automatically):
  openrouter/anthropic/claude-sonnet-4.5

No longer in the upstream list (5, not deleted automatically):
  openrouter/anthropic/claude-opus-5
  openrouter/openai/gpt-6-astra
  openrouter/openai/gpt-5.6-luna
  openrouter/deepseek/deepseek-v4-pro-0813
  openrouter/deepseek/deepseek-v4.1-flash

Unchanged: 0 entries.

Run again with --write to apply the changed fields above.
```

The five "no longer in the upstream list" lines are there only because the stand-in list is small.
They do not reflect a real catalog change.
