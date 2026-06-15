# Release Tools Agent Guide

## Scope

This directory owns protected release validation and publishing helpers:
release plans, package-shape checks, registry checks, staged artifact checks,
checksums, attestations, GitHub release asset verification, and product metadata
adapters.

Use `.agents/skills/release-readiness/SKILL.md` for release planning,
release-sensitive changes, artifact/registry validation, or publish dry-runs.

## Boundaries

- Release identity belongs to `release-please-config.json`,
  `.release-please-manifest.json`, product-scoped tags, and product-local
  `release.toml`.
- Moon owns path/project/dependency selection. Do not add a central release
  graph or parallel product source map.
- Product-local `targets/*.toml` files own artifact target matrices. Do not
  hardcode target lists in release scripts or workflows.
- Publishing is protected and manual through `.github/workflows/release.yml`
  from `main` in `f0rr0/oliphaunt`. Do not run publish steps locally unless the
  user explicitly asks and credentials/environment are intentional.
- Do not edit versions or changelogs directly for feature/fix work.

## Commands

```sh
tools/release/release.py plan
tools/release/release.py check
tools/release/release.py check-registries
tools/release/release.py consumer-shape --format markdown
tools/release/release.py publish-dry-run
tools/release/release.py verify-release
moon run release-tools:check
moon run repo:release-check
```

Use `--products-json` and `--head-ref` when reproducing selected release
workflow steps. Prefer dry-run and verification commands outside the protected
workflow.

## Validation Pattern

- For release metadata changes, run `tools/release/release.py check`.
- For impact analysis, run `tools/release/release.py plan` and inspect selected
  products before changing release metadata.
- For package shape, run `tools/release/release.py consumer-shape --format markdown`.
- For registry identity/state, run `tools/release/release.py check-registries`
  with the same product selection used by the workflow when possible.
- For publish changes, inspect `.github/workflows/release.yml` and the exact
  `release.py publish --product ... --step ...` path.

## Edit Checklist

- Keep release-please packages, Moon release-product metadata, product-local
  `release.toml`, and product paths in sync.
- Keep staged artifact expectations under `target/sdk-artifacts`,
  `target/liboliphaunt/release-assets`, `target/oliphaunt-wasix/release-assets`,
  `target/extension-artifacts`, and native helper release asset roots explicit.
- Preserve provenance requirements: checksums, attestations, target metadata,
  package-size evidence when applicable, and `verify-release`.
- If adding a new release product, update release-please config, Moon project
  metadata, product-local release metadata, artifact targets when applicable,
  release checks, and CI artifact download/publish steps together.
