---
name: release-readiness
description: Release readiness workflow for Oliphaunt product releases, release-please metadata, product-local release.toml files, target matrices, package-shape checks, staged artifacts, registry checks, publish dry-runs, and verify-release. Use for release-sensitive changes or before merging product-surface changes.
---

# Release Readiness

## Workflow

1. Determine whether the change is release-affecting:
   - product source, public API, package metadata, target metadata, runtime
     artifacts, exact-extension artifacts, or SDK-visible generated metadata
     usually is release-affecting;
   - maintainer docs, tests, examples, CI policy, fixtures, and benchmark plans
     are not release-affecting unless they change product-owned package source.
2. Inspect release identity from:
   - `release-please-config.json`
   - `.release-please-manifest.json`
   - affected product `release.toml`
   - affected product `moon.yml`
   - product-local `targets/*.toml` when artifacts are involved
3. Use `tools/release/release.py plan` to reason about product impact.
4. Validate metadata before package/artifact dry-runs.

## Commands

```sh
tools/release/release.py plan
tools/release/release.py check
tools/release/release.py consumer-shape --format markdown
tools/release/release.py check-registries
tools/release/release.py publish-dry-run
tools/release/release.py verify-release
moon run release-tools:check
moon run repo:release-check
```

Use `--products-json` and `--head-ref` to reproduce workflow-selected product
sets. Do not publish locally unless explicitly asked and the protected release
environment is intentional.

## Release Metadata Rules

- Keep release-please components and Moon release-product components identical.
- Keep product-local `release.toml` IDs equal to product IDs.
- Keep artifact targets product-local under `targets/*.toml`.
- Keep package-native publication native: Cargo, npm, JSR, SwiftPM assets,
  Gradle/Vanniktech, and GitHub Releases.
- Do not edit versions or changelogs directly for ordinary feature/fix work.

## Validation Choices

- Metadata-only release change: `release.py check`.
- Product selection concern: `release.py plan`.
- Consumer install/package shape concern: `release.py consumer-shape --format markdown`.
- Registry state concern: `release.py check-registries`.
- Staged artifact concern: run the relevant package/artifact check after CI
  artifacts exist under `target/**`.
- Final post-publish evidence: `release.py verify-release`.

## Evidence To Report

Report selected products, release-affecting rationale, changed metadata files,
staged artifact assumptions, and the exact checks run.
