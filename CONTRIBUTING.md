# Contributing to Tollwise

Thanks for considering a contribution. Tollwise is a local-first proxy that people point real API keys at, so a few rules below are not optional — they exist to keep every user's credentials safe.

## Ground rules

- **English only.** Code, comments, identifiers, commit messages, documentation, issues and pull requests are all written in English.
- **No secrets, ever.** Tollwise is bring-your-own-key: provider keys come only from environment variables, never from a committed file. Never put a real key in code, tests, fixtures, docs, logs, screenshots or a commit message. Never log request headers or bodies that may carry a key.
- **$0 to build.** No paid APIs, accounts or services are required to develop or test Tollwise. Tests run against mocked providers and recorded fixtures; a local [Ollama](https://ollama.com) installation may be used for an optional real end-to-end check.

## Before you start

1. Fork the repository and clone your fork.
2. `npm ci` to install the exact dependency versions from the lockfile.
3. Enable the pre-commit hook, which is what actually stops a secret from ever being committed:
   ```
   git config core.hooksPath .githooks
   ```
   It runs `scripts/guard-keys.mjs` on every commit, blocking key-shaped values and files that must never be tracked (`.env`, `*.pem`, `*.key`, credential JSON files, and more). Never bypass it with `--no-verify`.

## Adding tests with fake credentials

Tests need key-shaped values to exercise validation and redaction. Any fake value that looks like a real key must end its line with the marker `tollwise-allow-secret`, so the guard can tell a deliberate fixture from an accidental leak:

```ts
const apiKey = "sk-test-not-a-real-key-000000000000"; // tollwise-allow-secret
```

A fake value without the marker is treated as a real leaked key and blocks the commit.

## Naming source files

Never name a source file with `token`, `secret`, `apikey`, `api_key` or `api-key` in it. This repository's `.gitignore` ignores file names matching those patterns, so such a file would silently never be committed — your change would look fine locally and then be missing entirely once pushed. Use names like `usage`, `counting`, `credentials-store` or `auth` instead.

## Making a change

1. Create a branch off `main`.
2. Keep the change focused: one coherent piece of work per pull request.
3. Add or update tests for any new or changed behavior. A test must assert a real expected value, not just re-derive what the implementation happens to do.
4. Before opening a pull request, run the full check locally and make sure it is green:
   ```
   npm run check
   ```
   This runs lint (Biome), type-checking, the test suite and the secret guard, in that order.
5. Open a pull request using the template. Describe what changed and why; link any related issue.

## Commit messages

Write commit messages the way an attentive maintainer reading `git log` would want them:

- **Imperative mood**: "Add config loader", not "Added" or "Adds".
- **Subject line of 72 characters or less**, no trailing period.
- **One coherent change per commit.** Do not mix an unrelated refactor into a bug fix.
- **An optional body explaining why**, when the reason is not obvious from the subject and the diff — wrap it at roughly 72 characters, separated from the subject by a blank line.
- No tracker noise (ticket IDs, status labels or similar) in the subject or body; link the issue from the pull request instead.
- No emoji.

Example:

```
Route requests by required capabilities

Requests that need tool calls, JSON mode or vision are now matched
only against providers that actually support them, instead of
falling back silently to whatever provider was first in the list.
```

## Reporting a vulnerability

Do not open a public issue for a security problem. See [`SECURITY.md`](SECURITY.md) for how to report it privately.

## License

By contributing, you agree that your contribution is licensed under the project's [Apache License 2.0](LICENSE).
