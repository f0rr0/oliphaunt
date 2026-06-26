# Example and Release Validation Tasks

This document tracks the broader validation work for examples, local registry
installs, package production, SDK parity, dead-code cleanup, and script tooling.
Keep the list ordered by dependency: prove the install/runtime shape first, then
review production pipelines, then normalize implementation details.

## Priority 0: Current Acceptance Gates

- [x] Confirm generated Cargo crates stay under the crates.io 10 MiB limit.
- [x] Confirm WASIX example smoke tests install `oliphaunt-wasix-tools` from the local registry and exercise the split tools path with `pg_dump`.
- [x] Confirm native and WASIX examples resolve local published runtime, tools, and extension crates with locked installs.
- [x] Add direct `psql` execution coverage when the WASIX SDK exposes a public tool runner for it.
- [x] Run GUI-level e2e for Electron and Tauri examples, or document the exact missing host capabilities if a full GUI run is blocked.
- [ ] Fix the CI/release metadata gaps found by the package-surface audit, then verify CI and release workflows produce exactly the package surfaces expected for each registry.

## Priority 1: Example App Validation

- [x] Inventory every example app, its package managers, local-registry dependencies, and runtime/tool/extension paths.
- [x] Ensure each native example uses `oliphaunt-tools-*` from the local registry when it exercises standalone tools.
- [x] Ensure each WASIX example uses `oliphaunt-wasix-tools` from the local registry and does not rely on path-only tool assets.
- [x] Add example-app smoke commands that model the desired developer experience and can run on Linux CI.
- [x] Check frontend build/test flows for the Electron, Electron WASIX, Tauri, Tauri WASIX, and WASIX vanilla examples.

## Priority 2: CI and Release Shape

- [ ] Map CI producer jobs to release package consumers for Cargo, npm, Maven, SwiftPM, and GitHub release assets.
- [ ] Verify package naming is symmetric across native and WASIX, with `wasix` special-cased rather than `native`.
- [x] Verify native runtime payloads contain `postgres`, `initdb`, `pg_ctl`; native tools payloads contain `pg_dump`, `psql`.
- [x] Verify WASIX runtime payloads contain `postgres`, `initdb`; WASIX tools payloads contain `pg_dump`, `psql`, not `pg_ctl`.
- [ ] Verify extension packages and runtime tools are published and installed from registries idiomatically.
- [x] Make extension Maven registry surfaces explicit in extension metadata instead of silently appending them in release tooling.
- [x] Remove or generate duplicated release target lists in workflow downloads, node-direct package dirs, artifact target checks, and release policy checks.
- [x] Decide whether existing-tag release probes should become a uniform idempotency gate or be removed.
- [x] Keep release-derived files synchronized after the split tool package changes.

## Priority 3: SDK Consistency

- [ ] Compare SDK install paths and artifact resolution across Rust, JS, React Native, Kotlin, and Swift.
- [ ] Ensure SDKs exercise the same control flows for runtime setup, extension selection, artifact validation, and tool access.
- [x] Add Android split/local runtime validation so selected extensions must exist in the copied runtime tree before manifests are published.
- [ ] Align or explicitly document Deno native runtime/tools/extension resolution versus Node and Bun.
- [ ] Port stronger exact-extension artifact validation into the Android Gradle resolver.
- [ ] Pass mobile `sharedPreloadLibraries` through to startup arguments consistently.
- [ ] Add an explicit WASIX split-tools preflight path before first `pg_dump` or `psql` call.
- [ ] Identify feature gaps where one SDK exposes a runtime/tool/extension capability differently from the others.
- [ ] Add or update parity checks where a documented invariant is not machine-checked.
- [x] Decide and document whether JS Deno native flows should support packaged native tools and extensions, or fail clearly when those features are requested.
- [x] Harden Rust native runtime cache validation so split client tools are validated when a flow expects `pg_dump` or `psql`.

## Priority 4: Cleanup and Tooling

- [ ] Run targeted dead-code detection for Rust, TypeScript/JavaScript, shell, and release scripts.
- [ ] Remove confirmed dead code only after proving no CI/release/example path still references it.
- [ ] Inventory Python and Rust helper scripts and decide which should move to Bun.
- [ ] Convert non-critical scripts to Bun incrementally, preserving current CI behavior after each conversion.
- [ ] Keep Rust tools where compilation is idiomatic or the code is part of the Rust product/toolchain surface.
- [ ] Validate Linux CI lanes locally after script conversions.
- [ ] Validate local release dry-run lanes with local registry publishing after script conversions.

## Current Notes

- The active branch contains the split native/WASIX tools package work and the example GUI smoke coverage.
- Local-registry WASIX smoke coverage proves `pg_dump` through the SDK `dump_sql` path and `psql` through `PsqlOptions::command("SELECT 1")`.
- Local-registry Cargo payload inspection confirmed `liboliphaunt-native-linux-x64-gnu-part-*` contains `initdb`, `pg_ctl`, and `postgres` only under `runtime/bin`, while `oliphaunt-tools-linux-x64-gnu-part-*` contains only `pg_dump` and `psql` there.
- Local registry publication was refreshed with explicit native runtime/tools,
  broker, WASIX runtime/tools/AOT, extension, JS SDK, and node-direct artifact
  roots. The npm install surface now includes `@oliphaunt/tools-linux-x64-gnu`
  from Verdaccio, and its payload contains only `pg_dump` and `psql`.
- Frontend builds passed through `examples/tools/with-local-registries.sh` for
  `examples/electron`, `examples/electron-wasix`, `examples/tauri`,
  `examples/tauri-wasix`, and
  `src/bindings/wasix-rust/examples/tauri-sqlx-vanilla`.
- Rust-side example checks passed through `examples/tools/with-local-registries.sh`
  for native Tauri, Tauri WASIX, Electron WASIX, and the nested WASIX SQLx
  Tauri example. The nested check needed a harness fix so local-registry runs
  use `pnpm install --no-frozen-lockfile` when the wrapper disables lockfile
  reads, while normal CI keeps `--frozen-lockfile`.
- `examples/tools/run-tauri-webdriver-smoke.sh examples/tauri` and `examples/tools/run-tauri-webdriver-smoke.sh examples/tauri-wasix` now provide repeatable Linux GUI smoke coverage using `tauri-driver`, `WebKitWebDriver`, and `xvfb-run`.
- `examples/tools/run-electron-driver-smoke.sh examples/electron` and `examples/tools/run-electron-driver-smoke.sh examples/electron-wasix` now provide repeatable Linux GUI smoke coverage using the packaged Electron binary, an IPC test-driver hook, and `xvfb-run` when present.
- `tools/release/sync_release_pr.py --check`, `check_release_metadata.py`, `check_consumer_shape.py`, `check_artifact_targets.py`, and the full `tools/release/release.py check` pass after refreshing the WASIX asset input fingerprint and extension evidence digests.
- Extension Maven publication is now explicit in each exact-extension
  `release.toml`: the metadata lists `maven-central` and the two Android Maven
  package coordinates derived from the extension target graph. The old hidden
  release-tool synthesis path was removed, and release metadata plus consumer
  shape checks now enforce the explicit package surface.
- Release workflow helper downloads, node-direct optional npm package downloads,
  the local-registry download preset, node-direct package directory validation,
  artifact-target checks, and release policy checks now derive native/helper
  target artifact names from `artifact_targets` instead of restating the
  platform list.
- Dead existing-tag release workflow probes were removed. Idempotent rerun
  behavior stays in the publish handlers that actually own registry/GitHub
  publication, such as matching GitHub asset checksum skips and already-published
  crates/npm checks.
- TypeScript optional runtime package validation and release PR sync now derive
  broker, native runtime, native tools, and node-direct optional packages from
  `artifact_targets`, instead of maintaining a separate package/version map in
  each checker.
- Consumer-shape registry package checks for `liboliphaunt-native` and
  `oliphaunt-broker` now derive platform target membership and npm package
  names from `artifact_targets`, with only registry naming conventions kept in
  the checker.
- Subagent CI/release audit found these remaining next fixes: collapse remaining
  literal workflow/policy checks back to generated package contracts.
- Android split/local runtime packaging now validates selected extension
  control and versioned SQL files in the copied runtime tree before generated
  manifests can declare those extensions. The public Android Gradle resolver
  applies the same check after Maven exact-extension runtime artifacts are
  merged.
- Subagent SDK audit found these next fixes: align or explicitly document Deno
  native runtime/tools/extension resolution, port stronger exact-extension
  validation into the Android Gradle resolver, pass mobile shared preload
  libraries into startup args, and add an explicit WASIX tools preflight.
- Local workflow tooling is available: `act` is installed at v0.2.89, which
  matches the latest upstream release published on 2026-06-01, Docker is
  available, `act -l` parses the CI, Release, and mobile E2E workflow graph,
  and the CI `release-intent` job dry-run selects successfully with
  `ghcr.io/catthehacker/ubuntu:act-latest`. Full Linux lane execution should
  run from a committed disposable worktree because `actions/checkout` validates
  committed HEAD rather than uncommitted local edits.
- JS Deno direct mode now resolves packaged ICU for explicit-library installs when running inside Deno, and rejects package-managed extension requests without an explicit prepared `runtimeDirectory`. Node and Bun remain the registry-managed extension materialization paths.
- Rust native runtime cache validation already requires both split client tools, with `runtime_validation_requires_split_tools` covering a missing `pg_dump` cache entry.
