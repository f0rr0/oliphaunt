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
- [ ] Verify CI and release workflows produce exactly the package surfaces expected for each registry.

## Priority 1: Example App Validation

- [x] Inventory every example app, its package managers, local-registry dependencies, and runtime/tool/extension paths.
- [ ] Ensure each native example uses `oliphaunt-tools-*` from the local registry when it exercises standalone tools.
- [x] Ensure each WASIX example uses `oliphaunt-wasix-tools` from the local registry and does not rely on path-only tool assets.
- [x] Add example-app smoke commands that model the desired developer experience and can run on Linux CI.
- [x] Check frontend build/test flows for the Electron, Electron WASIX, Tauri, Tauri WASIX, and WASIX vanilla examples.

## Priority 2: CI and Release Shape

- [ ] Map CI producer jobs to release package consumers for Cargo, npm, Maven, SwiftPM, and GitHub release assets.
- [ ] Verify package naming is symmetric across native and WASIX, with `wasix` special-cased rather than `native`.
- [x] Verify native runtime payloads contain `postgres`, `initdb`, `pg_ctl`; native tools payloads contain `pg_dump`, `psql`.
- [x] Verify WASIX runtime payloads contain `postgres`, `initdb`; WASIX tools payloads contain `pg_dump`, `psql`, not `pg_ctl`.
- [ ] Verify extension packages and runtime tools are published and installed from registries idiomatically.
- [ ] Identify duplicated release metadata or package target matrices that can be safely collapsed.
- [x] Keep release-derived files synchronized after the split tool package changes.

## Priority 3: SDK Consistency

- [ ] Compare SDK install paths and artifact resolution across Rust, JS, React Native, Kotlin, and Swift.
- [ ] Ensure SDKs exercise the same control flows for runtime setup, extension selection, artifact validation, and tool access.
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
- `examples/tools/run-tauri-webdriver-smoke.sh examples/tauri` and `examples/tools/run-tauri-webdriver-smoke.sh examples/tauri-wasix` now provide repeatable Linux GUI smoke coverage using `tauri-driver`, `WebKitWebDriver`, and `xvfb-run`.
- `examples/tools/run-electron-driver-smoke.sh examples/electron` and `examples/tools/run-electron-driver-smoke.sh examples/electron-wasix` now provide repeatable Linux GUI smoke coverage using the packaged Electron binary, an IPC test-driver hook, and `xvfb-run` when present.
- `tools/release/sync_release_pr.py --check`, `check_release_metadata.py`, `check_consumer_shape.py`, `check_artifact_targets.py`, and the full `tools/release/release.py check` pass after refreshing the WASIX asset input fingerprint and extension evidence digests.
- Subagent CI/release audit mapped the split native runtime/tools crates and WASIX runtime/tools/AOT/tools-AOT crates to their release generation and publication paths. Remaining CI work is to validate Linux workflow lanes locally rather than relying only on static release checks.
- Subagent SDK audit flagged Deno native asset resolution, ICU behavior, mobile static-extension readiness, and Rust native split-tool validation as the next parity risks to resolve or explicitly document.
- Local workflow tooling is available: `act` is installed at v0.2.89, which matches the latest upstream release published on 2026-06-01, Docker is available, and `act -l` parses the CI, Release, and mobile E2E workflow graph. Full Linux lane execution is still pending.
- JS Deno direct mode now resolves packaged ICU for explicit-library installs when running inside Deno, and rejects package-managed extension requests without an explicit prepared `runtimeDirectory`. Node and Bun remain the registry-managed extension materialization paths.
- Rust native runtime cache validation already requires both split client tools, with `runtime_validation_requires_split_tools` covering a missing `pg_dump` cache entry.
