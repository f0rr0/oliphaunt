# Contributing

## Local Checks

Install the pinned tools once, then run the local qualification gates before
opening a PR:

```sh
tools/dev/bootstrap-tools.sh
moon run dev-tools:doctor
moon run policy-tools:fmt-check
moon run :check
moon run :test
```

The runtime smoke starts embedded Postgres and is intentionally slower than unit tests.
The protected `publish-dry-run` operation is a release-candidate check: run it
from the GitHub `Release` workflow after the exact release-bump commit has a
successful `Qualified` CI record. It is not a routine source-PR check.

Install local hooks with:

```sh
tools/dev/bun.sh tools/dev/install-hooks.mjs
```

Hooks stay deliberately smaller than CI: pre-commit handles file hygiene and
formatting, while commit-msg validates Conventional Commit messages. Run
`moon run repo:release-check` in addition to the normal checks for a
release-sensitive PR. CI remains the source of truth for generated AOT runtime
matrices, packaging, Tauri, frontend, feature combinations, public API
compatibility, and supply-chain checks.

In GitHub branch protection, require the aggregate `Required` status before
merging; it already includes release intent, checks, tests, builds, and selected
E2E. Require linear history and squash merges, and keep force-push and deletion
disabled. Local hooks are convenience checks and can be skipped; CI is
authoritative.

## Assets

Bundled runtime assets must stay aligned with product-local runtime metadata
under `src/runtimes/` and extension metadata under `src/extensions/`. If a
runtime or extension artifact target changes, update the owning product
metadata and run the affected Moon checks.

## Releases

Releases are manual and must be dispatched from `main` through the GitHub
Actions `Release` workflow. Release Please manifest mode owns version bumps,
changelog updates, and the generated release PR. The protected publish workflow
owns exact-SHA product tags and draft GitHub releases. Product-local release
metadata owns publish targets and artifact shape; Moon dependency scopes
provide release coupling. See `docs/maintainers/release.md` for release intent,
trusted publishing, and workflow details.
