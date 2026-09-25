# Release checklist

The steps that turn the working repository into the public `v0.1.0` release. The maintainer does
every step by hand, in this order; no script creates a repository, pushes, tags or publishes
anything. Run the commands from the top level of the working repository, with Node.js 24 or later
and Git on the path.

## 1. Prepare the working repository

1. **Date the release.** In `CHANGELOG.md`, replace `Unreleased` in the `[0.1.0]` heading with
   today's date in the form `YYYY-MM-DD`.
2. **Run the full check** and fix anything it reports:

   ```sh
   npm run check
   ```

3. **Commit everything.** The export reads the last commit only: uncommitted changes are never
   exported, and the export lists any allow-listed file that has them.

## 2. Choose the public URL

The public repository's URL is `https://github.com/nunomarques97/tollwise` unless it is passed to the
export with `--repo-url`. If the working repository already holds that name on GitHub, do one of the
following before going on:

- rename the working repository in its GitHub settings, so the public one can take the name; or
- publish under another name, pass that URL to the export with `--repo-url` (step 3), and replace
  `https://github.com/nunomarques97/tollwise` with it in every file of the `marketing/` folder.

## 3. Run the export

Without a new URL:

```sh
node scripts/export-public.mjs
```

With a new URL (it must have the form `https://github.com/owner/repo`):

```sh
node scripts/export-public.mjs --repo-url https://github.com/owner/repo
```

The export writes the public edition to `.public-export/` (git-ignored): only the allow-listed files of
the last commit, as a new git repository on branch `main` with the curated history of
`scripts/public-history.json`. It verifies every commit (type check and leak scans on each one,
`npm ci` and `npm run check` on the last one), adds no remote and pushes nothing. It must end with
`built and verified`. If it says it `built the file tree only`, the history manifest is missing:
stop and add it before going on. To check an existing export again without rebuilding it:

```sh
node scripts/export-public.mjs --verify .public-export
```

Add `--repo-url` with the same URL to that command when the export used one. Then scan the exported
files for keys once more:

```sh
cd .public-export
node scripts/guard-keys.mjs --all
```

## 4. Create the public repository by hand

On GitHub, create a new repository with the name chosen in step 2:

- visibility **Public**;
- **empty**: no README, no `.gitignore`, no license (the export has its own);
- no template.

## 5. Push the export

From `.public-export/`, with the URL of step 2:

```sh
git remote add origin https://github.com/nunomarques97/tollwise
git push -u origin main
```

## 6. Enable private vulnerability reporting

`SECURITY.md` tells reporters to use GitHub's private vulnerability reporting. In the public
repository, open **Settings**, then the security settings section, and enable **Private
vulnerability reporting**. Check that the **Security** tab now offers **Report a vulnerability**.

## 7. Confirm that CI runs

The CI workflow runs only on a public repository, so the push of step 5 is its first run. Open the
**Actions** tab and wait until the `check` job has passed on Linux, macOS and Windows. If it failed,
do not tag: fix the cause in the working repository, delete the new public repository in its
settings (it holds nothing but the export yet), and start again from step 1.

## 8. Tag v0.1.0 and write the release

From `.public-export/`:

```sh
git tag -a v0.1.0 -m "Tollwise 0.1.0"
git push origin v0.1.0
```

On GitHub, open **Releases**, then **Draft a new release**, choose the tag `v0.1.0`, title it
`Tollwise 0.1.0`, and paste the `[0.1.0]` section of `CHANGELOG.md` as its description. Publish it.

## 9. Before any npm publish

The exported `package.json` keeps `"private": true`, so an accidental `npm publish` fails. The
`v0.1.0` release does not publish to npm: Tollwise runs from source. Publishing a package is a
separate decision; only then remove `"private": true` from `package.json` in the working
repository, commit, and run this checklist again from step 1.

## 10. Announce

Post in the order and at the times of [`launch-day-checklist.md`](launch-day-checklist.md), starting
with its "Before launch day" steps.
