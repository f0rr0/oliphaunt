# Tooling Decisions

Oliphaunt is a polyglot product monorepo. Tooling has to make product work
predictable without hiding ecosystem-native behavior.

## Roles

- Moon is the product/task graph, affectedness engine, local cache, and CI task
  executor.
- release-please manifest mode owns release PRs, versions, changelogs, and
  product-scoped tags.
- Product-local `release.toml` files own package metadata release-please does
  not model: owner, kind, publish targets, registry packages, release
  artifacts, compatibility-version files, and derived version files.
- Product-local `targets/*.toml` files own platform artifact metadata.
- Product-native build tools own product behavior: Cargo, SwiftPM/Xcode,
  Gradle, npm/JSR, Expo, React Native Codegen, and PostgreSQL build scripts.
- `tools/release/release.py` owns protected publish operations, registry
  checks, checksums, attestations, and GitHub release asset verification.

Do not add a second source graph, release graph, or root alias layer over Moon.
Do not add a repo-wide tool because it is popular in one language ecosystem.

## Moon

Install Moon through proto from `.prototools` and run `moon` directly:

```sh
moon query projects
moon query tasks
moon query affected --upstream none --downstream deep
moon run :check
moon run :test
moon run :coverage
moon query affected --upstream none --downstream deep
```

Moon task names carry stable intent:

- `check`: static, typecheck, lint, codegen, or build-only validation.
- `test`: product-native unit or contract tests.
- `package`: package-shape checks and publish dry-runs.
- `smoke`: one runtime happy path.
- `regression`: broader SQL, protocol, extension, lifecycle, or runtime
  regressions.
- `bench`: benchmark plan/report validation.
- `bench-run`: measured benchmark execution.
- `coverage`: measured product-native line coverage.

Every task must declare explicit inputs. Tasks with deterministic output that
other tasks consume must declare outputs. Use Moon tags for CI lanes and ad-hoc
selection; do not create root script aliases for new lanes.

Moon dependency scopes are meaningful:

- `production` and `peer` are release-affecting compatibility edges.
- `build` is for tests, fixtures, generated metadata, package-shape checks, and
  other non-release coupling.

## pnpm

pnpm is not the global build orchestrator. Its repo-level role is:

- install JavaScript-family workspace dependencies from `pnpm-lock.yaml`;
- provide JavaScript package-manager commands for docs, TypeScript, and React
  Native packages;
- expose the root command card that delegates to Moon.

Cargo, Gradle, SwiftPM, Xcode, npm/JSR publish, Expo, and PostgreSQL build
scripts stay product-owned and are invoked through Moon tasks where repository
or CI orchestration is needed. `node_modules/` directories are normal ignored
local install state; they must never be tracked.

## Scripts

Use shell for setup, process orchestration, platform packaging glue, and thin
CI wrappers. Policy code that parses repository files and asserts invariants
should live under `tools/policy/assertions/assert-*.mjs` and run with Bun. Keep
`check-*` scripts as Moon/CI entrypoints when they aggregate checks or wrap
ecosystem-native tools.

## CI

GitHub Actions owns runners, credentials, artifact upload, and platform matrix
fan-out. Moon owns which tasks are affected and how tasks depend on each other.

CI flow:

1. The affected job uses Moon queries to select stable job names from task tags
   named `ci-<job>` and to emit the exact Moon task targets for each job.
2. Product jobs call `.github/scripts/run-planned-moon-job.sh <job>`.
3. The planned-job wrapper reads the affected job target map, then delegates to
   `.github/scripts/run-moon-targets.sh`, which runs
   `moon run` with the selected targets. This is for planned artifact targets
   whose producer jobs may be selected by release-product implications rather
   than by direct file affectedness.
4. GitHub matrix fans out only target dimensions such as OS, CPU, ABI, native
   runtime target, broker target, Node direct target, WASIX AOT target, Android
   emulator, and iOS simulator.

Affected check/test lanes should use `.github/scripts/run-moon-ci.sh` so Moon
keeps CI affectedness, `runInCI`, and task relation semantics in one place.

Mobile CI target fan-out is derived from published
`liboliphaunt-native` artifact metadata. Android jobs use targets whose
`targets/*.toml` surfaces include `react-native-android`; iOS jobs use targets
whose surfaces include `react-native-ios`. Do not hardcode mobile ABI target
lists in CI planners.

Keep workflow names and job names product-oriented. Put implementation details
in step names.

## Moon Cache Policy

Moon is allowed to cache task results when inputs, dependency task outputs,
toolchain-sensitive files, environment variables, and outputs represent the
work. It does not know about simulator/device state, installed apps, local
ports, Docker daemon state, code-signing identities, registry state, or copied
runtime artifacts unless those are modeled as inputs.

Cache deterministic static checks, package-shape checks, generated freshness,
docs builds, unit tests, and coverage reports when they declare inputs and
outputs.

Use `cache: local` for developer smoke tasks that are useful to replay when
local source inputs have not changed.

Force live execution for CI/mobile/device proof with `MOON_CACHE=off`; those
lanes prove the current runner, simulator/device, signing environment, app
artifact, and runtime artifact.

Cache benchmark plan checks, never measured benchmark runs. `bench` validates
matrix and report shape; `bench-run` measures current hardware and runtime
state.

Use `runInCI: skip` for expensive dependency-only tasks that must stay valid in
CI action graphs but must not run as broad CI work. Use `runInCI: false` only
for tasks CI must never invoke.

## Release Tooling

Release-please is the release identity owner. It supports the monorepo
component model well enough for product versions, changelogs, release PRs, and
tags without forcing non-JavaScript products into fake `package.json` files.

What release-please does not own:

- platform binary builds;
- extension artifact builds;
- checksums and attestations;
- registry credential checks;
- package-native publish commands;
- verifying already-published GitHub release assets.

Those stay in `tools/release/release.py` and product-native release tasks.

Do not reintroduce release-plz, git-cliff product changelog ownership, a central
release graph, or broad clean-registry reinstall gates as routine CI policy.

## Debugging

Use Moon's graph and cache diagnostics before adding scripts:

```sh
moon project-graph
moon action-graph oliphaunt-react-native:package-artifacts
moon hash <hash>
moon run <target> --cache off --log trace
```

If a task is slow, first check whether its inputs are too broad, outputs are
missing, dependency scopes are wrong, or CI is proving runner state that cannot
be safely cached.

Graph policy fixtures are split by contract:

- `tools/graph/synthetic/affected.toml` checks Moon owner/downstream behavior.
- `tools/graph/synthetic/release.toml` checks release product selection.
- `tools/graph/synthetic/coverage.toml` checks coverage routing.

Do not add mixed synthetic cases that assert unrelated contracts in one table.

## Tool Ownership

Keep implementation code split by responsibility instead of growing large
catch-all scripts:

- `tools/xtask/src/template_runner.rs`
- `tools/xtask/src/asset_checks.rs`
- `tools/xtask/src/asset_manifest.rs`
- `tools/xtask/src/asset_io.rs`
- `tools/xtask/src/asset_pipeline.rs`
- `tools/xtask/src/fs_utils.rs`
- `tools/xtask/src/postgres_guard.rs`
- `tools/xtask/src/source_spine.rs`
- `tools/perf/runner/src/benchmarks.rs`
- `tools/perf/runner/src/diagnostics.rs`
- `tools/perf/runner/src/legacy_wasix.rs`
- `tools/perf/runner/src/native_liboliphaunt.rs`
- `tools/perf/runner/src/native_postgres.rs`
- `tools/perf/runner/src/prepared_updates.rs`
- `tools/perf/runner/src/report.rs`
- `tools/perf/runner/src/shared.rs`
- `tools/perf/runner/src/sqlite.rs`
- `src/sdks/rust/src/runtime_resources/extension_artifact.rs`
- `src/sdks/rust/src/runtime_resources/extension_index.rs`
- `src/sdks/rust/src/runtime_resources/manifest.rs`
- `src/sdks/rust/src/runtime_resources/package.rs`
- `src/sdks/rust/src/runtime_resources/static_registry.rs`
- `src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/base/template_clone.rs`
- `src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/postgres_mod/stdio.rs`
- `src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/postgres_mod/wasix_fs.rs`
- `tools/policy/check-sdk-mobile-extension-surface.sh`
