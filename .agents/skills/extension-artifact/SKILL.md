---
name: extension-artifact
description: Exact SQL extension workflow for Oliphaunt extension catalog metadata, contrib/external source pins, recipes, generated SDK/docs/mobile/WASIX metadata, native and WASIX extension artifacts, mobile static registry, release products, and evidence tables. Use when adding, promoting, packaging, or changing extension support.
---

# Extension Artifact

## Workflow

1. Identify the extension class:
   - PostgreSQL contrib: `src/extensions/contrib/`
   - external source-pinned extension: `src/extensions/external/<name>/`
   - generated catalog or SDK metadata: `src/extensions/generated/`
   - artifact build/package path: `src/extensions/artifacts/`
2. Preserve exact names:
   - internal extension IDs are snake_case;
   - SQL extension names are exact PostgreSQL names;
   - release products use `oliphaunt-extension-*`.
3. Update metadata across catalog, generated SDK/docs/mobile/WASIX outputs,
   release metadata, and evidence together.
4. Run static model checks before artifact build paths.

## Commands

```sh
moon run extensions:check
moon run extension-model:check
moon run extension-artifacts-native:check
moon run extension-artifacts-wasix:check
python3 src/extensions/tools/check-extension-model.py --check
tools/release/release.py check
```

Use artifact builders only when native/WASIX release assets are required:

```sh
moon run extension-artifacts-native:release-check
moon run extension-packages:assemble-release
```

## Metadata Checklist

- `src/extensions/catalog/extensions.promoted.toml`
- `src/extensions/catalog/extensions.smoke.toml`
- `src/extensions/contrib/postgres18.toml`
- `src/extensions/external/<name>/source.toml`
- `src/extensions/external/<name>/recipe.toml` when external build logic exists
- `src/extensions/generated/extensions.catalog.json`
- `src/extensions/generated/extensions.build-plan.json`
- `src/extensions/generated/sdk/*.json`
- `src/extensions/generated/docs/*.json`
- `src/extensions/generated/mobile/*`
- `src/extensions/generated/wasix/extensions.json`
- affected SDK generated source files
- affected product `release.toml`
- `release-please-config.json` for new release products

## Decision Rules

- Do not add aliases, bundles, or extension packs.
- Do not mark an extension mobile-release-ready unless native artifacts,
  generated static registry metadata, package checks, and platform evidence
  agree.
- Keep dependency expansion exact for selected extensions, shared preload
  libraries, runtime share data files, and native module stems.
- Treat generated metadata as policy output: regenerate intentionally and review
  the diff.

## Evidence To Report

Report exact SQL extension names, generated files changed, artifact targets
affected, release products affected, support/evidence changes, and checks run.
