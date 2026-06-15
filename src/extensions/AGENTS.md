# Extensions Agent Guide

## Scope

This directory owns exact SQL extension catalog metadata, source pins, recipes,
generated SDK metadata, support/evidence tables, mobile static registry data,
and native/WASIX/package artifact staging.

Use `.agents/skills/extension-artifact/SKILL.md` for extension catalog,
generated metadata, release artifact, target, or evidence work.

## Boundaries

- Extension IDs are internal snake_case identifiers. SQL extension names are
  exact PostgreSQL extension names and may include underscores or hyphens.
  Do not invent aliases, packs, grouped selectors, or fuzzy names.
- Contrib metadata lives under `contrib/`; external extension pins and recipes
  live under `external/<name>/`.
- Generated SDK metadata under `generated/` must agree across Rust, Swift,
  Kotlin, TypeScript, React Native, WASIX, docs, and mobile static registry
  outputs.
- Exact-extension artifact products need `release.toml`, release-please config,
  generated catalog/build-plan entries, target compatibility, and evidence.
- Do not commit built extension artifacts. Native, WASIX, and package outputs
  belong under ignored `target/extensions/**` and `target/extension-artifacts/**`.

## Commands

```sh
moon run extensions:check
moon run extension-model:check
moon run extension-artifacts-native:check
moon run extension-artifacts-native:release-check
moon run extension-artifacts-wasix:check
moon run extension-packages:assemble-release
python3 src/extensions/tools/check-extension-model.py --check
tools/release/release.py check
```

Artifact builder targets are CI-oriented and may be expensive. Run static model
checks before native/WASIX artifact build paths.

## Validation Pattern

- For catalog or generated metadata changes, run
  `moon run extension-model:check`.
- For source pins or build inputs, run `moon run extensions:check` and inspect
  source digest implications.
- For native artifact changes, run `moon run extension-artifacts-native:check`
  before release artifact checks.
- For WASIX artifact changes, run `moon run extension-artifacts-wasix:check`
  before release artifact builders.
- For package/release changes, run `tools/release/release.py check` and, when
  staged artifacts exist, the relevant extension package assembly or release
  validation command.

## Edit Checklist

- Update generated SDK/docs/mobile/WASIX metadata together; never leave a new
  extension visible in one SDK but absent in another without explicit policy.
- Keep extension dependency expansion exact, including selected-extension
  dependencies, shared preload libraries, runtime share data files, and native
  module stems.
- Keep mobile release readiness honest. Mobile static registry claims must
  match generated registry source and artifact support.
- Keep evidence current when support status changes.
