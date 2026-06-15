# Oliphaunt Agent Guide

## Purpose

Oliphaunt is a native-first embedded PostgreSQL product workspace. Treat the
repo as a multi-product monorepo, not as a single Rust crate with side projects.

The current product lanes are:

- `liboliphaunt-native`: C ABI and PostgreSQL 18 patch stack for native
  desktop, mobile, and helper runtime assets.
- `oliphaunt-rust`, `oliphaunt-swift`, `oliphaunt-kotlin`,
  `oliphaunt-react-native`, and `oliphaunt-js`: SDKs over the same product
  concepts.
- `liboliphaunt-wasix` and `oliphaunt-wasix-rust`: legacy WASIX runtime and
  Rust binding release lanes. Keep them separate from the native SDK lane.
- `oliphaunt-extension-*`: exact SQL extension artifact products.

## First Moves

- Read the nearest `AGENTS.md` before editing a subdirectory.
- Prefer `rg` and `rg --files` for discovery.
- Verify behavior from source files, Moon task definitions, scripts, workflows,
  manifests, and release metadata. Maintainer docs are useful orientation, but
  they may be in churn.
- Use Moon targets as the contributor command surface. Do not add root package
  scripts, a second task graph, or ad hoc release orchestration.
- Keep generated, build, dependency, and simulator state out of git:
  `target/`, `node_modules/`, `lib/`, `.build/`, `.gradle/`, `.cxx/`,
  `.next/`, `.source/`, `Pods/`, `DerivedData/`, generated Expo `android/`,
  and generated Expo `ios/`.

## Toolchain

Pinned tool versions live in `.prototools`:

- Moon `2.3.2`
- Node `22.22.3`
- pnpm `11.5.0`
- Bun `1.3.14`
- Deno `2.8.1`

Use pnpm to install JavaScript-family dependencies and run package-local
scripts. Use Moon for repository and product orchestration.

## Common Commands

```sh
moon query projects
moon query tasks
moon query affected --upstream none --downstream deep
moon run repo:check
moon run :check
moon run :test
moon run :package
moon run :coverage
tools/release/release.py plan
tools/release/release.py check
```

When Moon is not installed in the shell, install or activate the pinned proto
toolchain instead of replacing Moon with root pnpm aliases.

## Task Semantics

- `check`: static checks, typecheck, lint, codegen, metadata, or build-only
  validation.
- `test`: product-native unit or contract tests.
- `package`: package-shape checks and publish dry-runs.
- `smoke`: one runtime happy path; use `--cache off` when live device,
  simulator, or runtime evidence matters.
- `regression`: broader SQL, protocol, extension, lifecycle, or runtime tests.
- `coverage`: measured product-native line coverage.
- `bench`: benchmark plan/report validation only.
- `bench-run`: measured benchmark execution on current hardware/runtime state.

## Repo Map

- `src/runtimes/liboliphaunt/native/`: native C ABI, PostgreSQL 18 patches,
  build scripts, target metadata, and native smoke harnesses.
- `src/runtimes/liboliphaunt/wasix/`: WASIX runtime source inputs, generated
  asset metadata, AOT carrier crates, and WASIX runtime tasks.
- `src/bindings/wasix-rust/`: Rust API and examples for the WASIX lane.
- `src/sdks/rust/`, `src/sdks/swift/`, `src/sdks/kotlin/`,
  `src/sdks/react-native/`, `src/sdks/js/`: SDK product roots.
- `src/extensions/`: exact SQL extension catalog, source pins, generated SDK
  metadata, evidence, and artifact packaging metadata.
- `src/docs/`: public Fumadocs/Next docs product, generated API references,
  tested snippets, and `llms.txt` outputs.
- `docs/`: architecture, maintainer, and internal source material.
- `tools/`: policy, graph, coverage, dev, performance, xtask, and release
  automation.

## Agent Skills

Use repo-local skills when the task matches their domain:

- `.agents/skills/native-track/SKILL.md`: native C ABI/PostgreSQL/runtime work.
- `.agents/skills/release-readiness/SKILL.md`: release plan, package, registry,
  artifact, and provenance checks.
- `.agents/skills/mobile-smoke/SKILL.md`: React Native Expo dev-client,
  Android/iOS installed-app smoke, and mobile E2E triage.
- `.agents/skills/extension-artifact/SKILL.md`: exact SQL extension catalog,
  generated SDK metadata, and native/WASIX extension artifacts.
- `.agents/skills/docs-product/SKILL.md`: public docs, generated docs metadata,
  tested snippets, API refs, and `llms.txt`.

## Release Boundaries

Release identity belongs to release-please manifest mode and product-scoped
tags. Product-local `release.toml` and `targets/*.toml` own metadata that
release-please does not model. Protected publishing, registry checks,
checksums, attestations, and GitHub release asset verification belong to
`tools/release/release.py` and the Release workflow.

Do not edit package versions or changelogs directly for feature/fix work. Use
release-producing Conventional Commit types for release-affecting changes:
`feat:`, `fix:`, `perf:`, `refactor:`, `revert:`, or `!` for breaking changes.

## Safety Rules

- Do not route native SDK work through `oliphaunt-wasix`.
- Do not make React Native reimplement Swift/Kotlin runtime lifecycle logic;
  React Native native code is adapter glue plus JSI transport.
- Do not commit generated runtime payloads, packaged native libraries, Expo
  generated projects, build output, or dependency directories.
- Do not publish locally. Local work may plan, package-check, dry-run, or verify
  staged artifacts. Actual release publishing is manual, protected, and from
  `main` in `f0rr0/oliphaunt`.
- If a change touches public behavior, update the relevant docs, generated
  metadata, package-shape checks, and release metadata together.
