# Contributing

## Local Checks

Run the same gates as CI before opening a PR:

```sh
pnpm doctor
pnpm fmt:check
pnpm check
pnpm test
pnpm release-check
tools/release/release.py publish-dry-run
```

The runtime smoke starts embedded Postgres and is intentionally slower than unit tests.

Install local hooks with:

```sh
tools/dev/bun.sh tools/dev/install-hooks.mjs
```

Hooks stay deliberately smaller than CI: pre-commit handles file hygiene and
formatting, while commit-msg validates Conventional Commit messages. Run
`pnpm check`, `pnpm test`, and `pnpm release-check` before release-sensitive
PRs. CI remains the source of truth for generated AOT runtime matrices,
packaging, Tauri, frontend, feature combinations, public API compatibility, and
supply-chain checks.

In GitHub branch protection, require the aggregate `Required checks` status and
the `release-intent` job before merging. Local hooks are convenience checks and
can be skipped; CI is authoritative.

## Assets

Bundled runtime assets must stay aligned with product-local runtime metadata
under `src/runtimes/` and extension metadata under `src/extensions/`. If a
runtime or extension artifact target changes, update the owning product
metadata and run the affected Moon checks.

## Releases

Releases are manual and must be dispatched from `main` through the GitHub
Actions `Release` workflow. release-please manifest mode owns version bumps,
changelog updates, release PRs, and tags. Product-local release metadata owns
publish targets and artifact shape; Moon dependency scopes provide release
coupling. See `docs/maintainers/release.md` for release intent, trusted
publishing, and manual workflow details.
