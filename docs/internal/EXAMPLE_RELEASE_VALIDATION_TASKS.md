# Example and Release Validation Tasks

This document tracks the broader validation work for examples, local registry
installs, package production, SDK parity, dead-code cleanup, and script tooling.
Keep the list ordered by dependency: prove the install/runtime shape first, then
review production pipelines, then normalize implementation details.

## Active Continuation Queue: 2026-06-26

This section is the current working queue for the resumed validation goal. Older
checked items below are historical evidence; do not treat the goal as complete
until the current-state gates here are checked with fresh local evidence.

### P0: Re-prove Example Local-Registry Install Paths

- [x] Rebuild or refresh local Cargo and npm registries from current release
  fixture/artifact generation paths, including native runtime crates, native
  `oliphaunt-tools-*` crates, WASIX runtime/tools/AOT crates, broker crates,
  extension crates, and JS packages.
- [x] Verify native Tauri installs `liboliphaunt-native-linux-x64-gnu`,
  `oliphaunt-tools-linux-x64-gnu`, and selected extension crates from
  `registry = "oliphaunt-local"` with no path dependency fallback.
- [x] Verify native Electron installs `@oliphaunt/ts`, native runtime/tools npm
  packages, and extension npm packages from the local Verdaccio registry.
- [x] Verify Tauri WASIX, Electron WASIX, and the nested WASIX SQLx Tauri
  example install `oliphaunt-wasix-tools` plus tools-AOT crates from
  `registry = "oliphaunt-local"`.
- [x] Exercise runtime code paths in each example: native `pg_dump`, WASIX
  `preflight_tools`, WASIX `dump_sql("--schema-only")`, and WASIX noninteractive
  `psql SELECT 1`.
- [x] Run GUI/e2e smoke for native Electron, WASIX Electron, native Tauri, and
  WASIX Tauri on Linux, or record the exact missing host capability.

### P1: CI, Release, and SDK Consistency Audit

- [x] Use subagent reviews for independent codebase audits:
  examples/local-registry flows, CI/release package production, and SDK runtime
  resolution parity.
- [ ] Check CI/release workflows produce exactly the current package surfaces
  declared by release metadata, without duplicated target lists or hidden
  registry package synthesis.
- [x] Derive WASIX runtime/tools Cargo package expectations from the canonical
  WASIX artifact package graph in release rendering, staged-artifact validation,
  and example lockfile validation.
- [ ] Check Rust, JS, WASIX Rust, React Native, Kotlin, and Swift SDKs use
  consistent runtime setup, extension selection, artifact validation, and tool
  access semantics where the platforms overlap.
- [ ] Add or adjust machine checks for any invariant currently enforced only by
  convention or docs.

### P2: Cleanup and Tooling Migration

- [ ] Run targeted dead-code detection for Rust, TypeScript/JavaScript, shell,
  Python, and release helpers.
- [ ] Remove only confirmed dead code with reference evidence.
- [ ] Inventory remaining Python and Rust helper scripts; move nonessential
  scripts to Bun where that improves local developer experience without making
  critical product code less idiomatic.
- [ ] Re-run Linux CI-like and release/local-registry lanes after each tooling
  migration batch.

### Current Fresh Evidence

- 2026-06-26: `git status --short --branch` was clean on
  `f0rr0/reduce-oliphaunt-icu-crate-size` after pushing commit `a20f25f`.
- 2026-06-26: Web research confirmed `nektos/act` remains the primary local
  GitHub Actions runner; use it selectively for Linux workflow smoke because
  complex hosted-runner parity is limited. Pair it with static workflow checks
  such as existing `actionlint`/`zizmor`-style validation instead of treating
  local workflow emulation as full release proof.
- 2026-06-26: Refreshed local Cargo and Verdaccio registries from explicit
  current artifact roots. Cargo resolved `oliphaunt-tools-linux-x64-gnu`,
  `oliphaunt-wasix-tools`, host tools-AOT crates, selected extension crates,
  and runtime crates from `oliphaunt-local`; npm resolved `@oliphaunt/ts` and
  `@oliphaunt/tools-linux-x64-gnu` from Verdaccio at `0.1.0`.
- 2026-06-26: `cargo check --locked` passed through
  `examples/tools/with-local-registries.sh` for native Tauri, Tauri WASIX,
  Electron WASIX sidecar, and the nested WASIX SQLx Tauri example after
  regenerating example lockfiles against the refreshed local Cargo registry.
- 2026-06-26: `src/bindings/wasix-rust/tools/check-examples.sh` passed,
  including its copied-workspace locked Cargo check and frontend build.
- 2026-06-26: all four GUI smokes passed:
  `examples/tools/run-electron-driver-smoke.sh examples/electron`,
  `examples/tools/run-electron-driver-smoke.sh examples/electron-wasix`,
  `examples/tools/run-tauri-webdriver-smoke.sh examples/tauri`, and
  `examples/tools/run-tauri-webdriver-smoke.sh examples/tauri-wasix`.
- 2026-06-26: local Cargo crate audit found no `.crate` over 10 MiB; the
  largest published local crate was
  `oliphaunt-extension-postgis-wasix-aot-aarch64-unknown-linux-gnu-part-001`
  at 9.74 MiB. Native runtime release assets contain `postgres`, `initdb`, and
  `pg_ctl`; native tools release assets contain `pg_dump` and `psql`; WASIX
  tools contain `pg_dump.wasix.wasm` and `psql.wasix.wasm`.
- 2026-06-26: subagent audits found three current guard gaps. The example
  lockfile sync checker now covers native Tauri, Tauri WASIX, Electron WASIX,
  and nested WASIX SQLx lockfiles, and validates local-registry checksums when
  a staged Cargo index is available. Native Electron GUI smoke now asserts
  `@oliphaunt/ts`, `@oliphaunt/liboliphaunt-linux-x64-gnu`,
  `@oliphaunt/tools-linux-x64-gnu`, and `@oliphaunt/extension-hstore` resolve
  from installed `node_modules` at `0.1.0`. Default local registry discovery no
  longer scans stale-prone canonical WASIX build outputs unless they are passed
  explicitly with `--artifact-root`.
- 2026-06-26: CI/release audit noted WASIX tool crates are generated and
  published from validated WASIX runtime/AOT release assets, but they are not
  separate GitHub release assets modeled in `artifact_targets.py` the way native
  `oliphaunt-tools-*` archives are. Treat that as a pending release-asset graph
  design task rather than adding target rows before producers emit real WASIX
  tools archives.
- 2026-06-26: WASIX Cargo package expectations are now derived from a single
  package graph: `release.py` renders and validates the release `Cargo.toml`
  from `public_cargo_package_names()`, staged SDK validation derives root and
  tools AOT dependencies from the WASIX artifact packager helper, and
  `sync-example-lockfiles.mjs` derives WASIX runtime/tools package names and AOT
  triples from the `oliphaunt-wasix` manifest instead of maintaining a separate
  hard-coded list.

## Priority 0: Current Acceptance Gates

- [x] Confirm generated Cargo crates stay under the crates.io 10 MiB limit.
- [x] Confirm WASIX example smoke tests install `oliphaunt-wasix-tools` from the local registry and exercise the split tools path with `pg_dump` and `psql`.
- [x] Confirm native and WASIX examples resolve local published runtime, tools, and extension crates with locked installs.
- [x] Add direct `psql` execution coverage when the WASIX SDK exposes a public tool runner for it.
- [x] Run GUI-level e2e for Electron and Tauri examples, or document the exact missing host capabilities if a full GUI run is blocked.
- [x] Fix the CI/release metadata gaps found by the package-surface audit, then verify CI and release workflows produce exactly the package surfaces expected for each registry.

## Priority 1: Example App Validation

- [x] Inventory every example app, its package managers, local-registry dependencies, and runtime/tool/extension paths.
- [x] Ensure each native example uses `oliphaunt-tools-*` from the local registry when it exercises standalone tools.
- [x] Ensure each WASIX example uses `oliphaunt-wasix-tools` from the local registry and does not rely on path-only tool assets.
- [x] Add example-app smoke commands that model the desired developer experience and can run on Linux CI.
- [x] Check frontend build/test flows for the Electron, Electron WASIX, Tauri, Tauri WASIX, and WASIX vanilla examples.

## Priority 2: CI and Release Shape

- [x] Map CI producer jobs to release package consumers for Cargo, npm, Maven, SwiftPM, and GitHub release assets.
- [x] Verify package naming is symmetric across native and WASIX, with `wasix` special-cased rather than `native`.
- [x] Verify native runtime payloads contain `postgres`, `initdb`, `pg_ctl`; native tools payloads contain `pg_dump`, `psql`.
- [x] Verify WASIX runtime payloads contain `postgres`, `initdb`; WASIX tools payloads contain `pg_dump`, `psql`, not `pg_ctl`.
- [x] Verify extension packages and runtime tools are published and installed from registries idiomatically.
- [x] Derive or validate native Maven runtime package manifests and Kotlin Maven existing-version probes from release metadata.
- [x] Add a publish-target coverage check that every declared registry/release target has release publication handling and a Release workflow invocation.
- [x] Derive or policy-check the WASIX runtime/tools AOT Cargo package maps from the public WASIX package graph.
- [x] Make extension Maven registry surfaces explicit in extension metadata instead of silently appending them in release tooling.
- [x] Remove or generate duplicated release target lists in workflow downloads, node-direct package dirs, artifact target checks, and release policy checks.
- [x] Decide whether existing-tag release probes should become a uniform idempotency gate or be removed.
- [x] Keep release-derived files synchronized after the split tool package changes.

## Priority 3: SDK Consistency

- [ ] Compare SDK install paths and artifact resolution across Rust, JS, React Native, Kotlin, and Swift.
- [ ] Ensure SDKs exercise the same control flows for runtime setup, extension selection, artifact validation, and tool access.
- [x] Add Android split/local runtime validation so selected extensions must exist in the copied runtime tree before manifests are published.
- [x] Align or explicitly document Deno native runtime/tools/extension resolution versus Node and Bun.
- [x] Port stronger exact-extension artifact validation into the Android Gradle resolver.
- [x] Pass mobile `sharedPreloadLibraries` through to startup arguments consistently.
- [x] Add an explicit WASIX split-tools preflight path before first `pg_dump` or `psql` call.
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
- Local-registry WASIX smoke coverage proves `pg_dump` through the SDK
  `dump_sql` path and `psql` through `PsqlOptions::command("SELECT 1")`.
  Example policy now requires `preflight_tools()`, `dump_sql`, and `psql` calls
  in every WASIX example that validates the split tools package.
- Local-registry Cargo payload inspection confirmed `liboliphaunt-native-linux-x64-gnu-part-*` contains `initdb`, `pg_ctl`, and `postgres` only under `runtime/bin`, while `oliphaunt-tools-linux-x64-gnu-part-*` contains only `pg_dump` and `psql` there.
- The small liboliphaunt release fixture now includes all five native desktop
  PostgreSQL binaries so fixture Cargo packaging exercises the split:
  `liboliphaunt-native-*` keeps `initdb`, `pg_ctl`, and `postgres`, while
  `oliphaunt-tools-*` keeps `pg_dump` and `psql`. Consumer-shape checks enforce
  the same generator contract.
- Release dry-run validation now inspects the nested WASIX runtime archive for
  `postgres` and `initdb`, and rejects `pg_ctl`, `pg_dump`, or `psql` there.
- Local registry publication was refreshed with explicit native runtime/tools,
  broker, WASIX runtime/tools/AOT, extension, JS SDK, and node-direct artifact
  roots. The npm install surface now includes `@oliphaunt/tools-linux-x64-gnu`
  from Verdaccio, and its payload contains only `pg_dump` and `psql`.
- The local npm registry publisher now includes the declared `@oliphaunt/icu`
  sidecar package when staging native liboliphaunt packages from release assets.
  `tools/release/check_release_metadata.py` rejects future `include_icu=False`
  drift in that path. A focused local npm publish verified
  `@oliphaunt/icu`, `@oliphaunt/liboliphaunt-linux-x64-gnu`,
  `@oliphaunt/tools-linux-x64-gnu`, and `@oliphaunt/ts` at version `0.1.0`
  from Verdaccio.
- The public WASIX release assets were regenerated from current generated
  assets; the portable runtime archive now provides both split tool payloads
  (`bin/pg_dump.wasix.wasm` and `bin/psql.wasix.wasm`) for the
  `oliphaunt-wasix-tools` package builder, while the root runtime manifest keeps
  tools out of the normal runtime payload.
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
- On 2026-06-26, all four GUI smoke commands passed against the refreshed local
  registries: native Electron, WASIX Electron, native Tauri, and WASIX Tauri.
  Native Tauri compiled `oliphaunt-tools-linux-x64-gnu` plus split runtime and
  extension crates from `oliphaunt-local`; WASIX Tauri exercised the split
  WASIX runtime/tools/AOT and selected extension package graph through
  WebDriver.
- On 2026-06-26, the nested WASIX SQLx Tauri profiler was switched to TCP
  startup so its headless local-registry run executes the split WASIX tools
  smoke (`preflight_tools`, `pg_dump --schema-only`, and noninteractive
  `psql SELECT 1`) on Linux instead of returning early on the Unix-socket path.
  The local-registry profiler command passed with `--fresh --rows 10`, and the
  generated report included a `validate split WASIX tools` startup phase.
- On 2026-06-26 after the Bun lockfile-sync conversion, the four GUI smoke
  commands passed again against the staged local Cargo and Verdaccio registries:
  `examples/tools/run-electron-driver-smoke.sh examples/electron`,
  `examples/tools/run-electron-driver-smoke.sh examples/electron-wasix`,
  `examples/tools/run-tauri-webdriver-smoke.sh examples/tauri`, and
  `examples/tools/run-tauri-webdriver-smoke.sh examples/tauri-wasix`. The
  product-local WASIX SQLx example check also passed and compiled
  `oliphaunt-wasix-tools` plus
  `oliphaunt-wasix-tools-aot-x86_64-unknown-linux-gnu` from
  `registry oliphaunt-local`.
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
- The local-registry `local-publish` preset now derives aggregate native/WASIX
  runtime artifact names, WASIX portable runtime artifacts, WASIX exact-extension
  target artifacts, exact-extension package artifacts, WASIX AOT runtime
  artifacts, helper artifacts, node-direct npm artifacts, and SDK package
  artifacts from release metadata helpers. The preset currently resolves 35
  unique CI artifacts for local publish staging and rejects duplicates.
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
- WASIX Cargo artifact package-family checks now derive the portable runtime,
  tools, ICU, root AOT, and tools-AOT crate names from
  `package_liboliphaunt_wasix_cargo_artifacts.public_cargo_package_names()`.
  The same packager helper also drives the WASIX AOT target-cfg dependency maps
  and `tools` feature dependency expectations used by release metadata,
  consumer-shape, and release publication checks.
- WASIX runtime, tools, root-AOT, and tools-AOT source crates keep
  `publish = false` as a source-tree guard, but their descriptions now match the
  public registry artifact role and the release Cargo artifact packager removes
  `publish = false` from staged manifests before publishing. Release metadata
  and dependency-invariant checks cover the full root/tools package family, so
  `oliphaunt-wasix-tools` and tools-AOT crates remain registry-publishable while
  `oliphaunt-wasix` installs them through optional dependencies.
- SDK CI package artifact names now derive from release products marked
  `kind = "sdk"`. The release workflow and local registry publisher use
  `release.py ci-artifacts --family sdk-package` instead of repeating
  per-product artifact names, and the WASIX Rust binding is normalized to the
  same SDK release kind.
- WASIX Rust SDK crate packaging now uses a Bun helper that derives the release
  artifact dependency pins from `liboliphaunt-wasix` `registry_packages`,
  removes local Cargo paths, writes a deterministic `.crate`, and enforces the
  crates.io 10 MiB package limit. Focused validation passed with
  `tools/policy/check-crate-package.sh --package oliphaunt-wasix` reporting the
  SDK crate at 0.16 MiB, and
  `tools/release/build-sdk-ci-artifacts.sh oliphaunt-wasix-rust` staged the same
  crate through the SDK artifact path.
- Release checksum manifest generation now uses Bun instead of Python for the
  broker and node-direct release asset paths. The helper preserves deterministic
  basename-sorted SHA-256 output, streams large archive hashing, and is called
  directly from `release.py`, broker packaging, and node-direct packaging.
- The same Bun checksum helper now emits strict `./asset` manifest paths, fails
  closed when no payload assets match, and is reused by the aggregate
  liboliphaunt release asset packager instead of an inline Python checksum
  heredoc. `check-tooling-stack.sh` rejects drift back to the inline Python
  checksum path. A direct aggregate packager run reached release asset
  validation but could not pass with the local cached Android asset because that
  generated artifact is stale and still contains unstripped ELF debug sections.
- Release publish-environment validation now uses Bun instead of Python. The
  helper scans product `release.toml` metadata directly, validates selected
  product ids, and preserves the trusted-publishing, GitHub, Maven, and
  forbidden-token checks.
- The Release workflow now calls the Bun publish-environment helper directly;
  release metadata checks reject the retired Python helper path in the workflow
  and require `release.py publish` dry-runs to use the same Bun helper.
- Product release-tag verification now uses Bun instead of Python. The helper
  reads release-please product config, resolves the product's current version,
  and verifies the product-scoped tag points at the release commit.
- Release-please manifest-mode validation now uses Bun instead of Python. The
  helper derives release products from Moon, validates release-please packages
  and manifest paths, and checks product versions, changelogs, and extra files.
- Deterministic release directory archiving now uses Bun instead of Python for
  tar.gz and zip payloads. Native, mobile, broker, and Windows package scripts
  now call the Bun helper while preserving fixed timestamps, modes, and sorted
  entries.
- WASIX example Cargo lockfile synchronization now uses Bun instead of Python,
  keeping the nested Tauri SQLx example aligned with local internal WASIX crate
  versions without invoking Cargo when only source-tree versions changed.
- The CI affected-plan wrapper `.github/scripts/plan-affected.py` was removed;
  the workflow now invokes `python3 tools/graph/ci_plan.py` directly, keeping
  the shared planner as the single Python entrypoint for CI job selection.
- The extension runtime contract checker now uses Bun instead of Python. The
  Moon project is modeled as JavaScript tooling, and `check-tooling-stack.sh`
  rejects reintroducing `check-contract.py` or rewiring the task away from the
  Bun checker.
- The extension tree checker now uses Bun instead of Python. Extension Moon
  checks reference `check-extension-tree.mjs`, and `check-tooling-stack.sh`
  rejects the retired Python checker or task references to it.
- The Moon cache witness helper now uses Bun instead of Python. The converted
  `tools/graph/cache-witness.mjs` preserves the two-step output-cache
  assertion and resolves `MOON_BIN` or the local proto Moon shim for reliable
  local runs.
- GitHub workflow/action inline Python heredocs were removed from the release
  PR sync path and Deno fallback installer. Release PR number extraction now
  uses `bun .github/scripts/resolve-release-please-pr.mjs`, and the Deno
  fallback installer extracts the downloaded archive with `unzip`.
- `tools/policy/check-crate-package.sh` now derives the default publishable
  Cargo package set through `bun tools/policy/list-publishable-cargo-packages.mjs`
  instead of an inline Python `cargo metadata` parser, while keeping
  `oliphaunt-wasix` on the release-shaped package helper path.
- `.github/scripts/download-build-artifacts.sh` now merges duplicate release
  checksum manifests through `bun .github/scripts/merge-checksum-manifest.mjs`
  instead of an inline Python parser, preserving sorted output and conflicting
  checksum rejection.
- `tools/policy/check-coverage.sh` now delegates structured
  `coverage/baseline.toml` validation to
  `bun tools/policy/check-coverage-baseline.mjs`, removing another inline
  Python TOML parser from policy checks.
- `tools/policy/check-dependency-invariants.sh` now validates WASIX release
  artifact crate versions and path dependencies through
  `bun tools/policy/check-wasix-release-dependency-invariants.mjs`; the shell
  wrapper still owns the Cargo dependency-tree compiler/runtime exclusion gates.
- The pinned Bun and Deno developer launchers now use `unzip` for release
  archive extraction instead of inline Python. `check-tooling-stack.sh` rejects
  reintroducing Python in `tools/dev/bun.sh` or `tools/dev/deno.sh`, while the
  launchers keep using official pinned release archives from `.prototools`.
- The local maintainer tool bootstrap now also uses `unzip` instead of inline
  Python for cargo-binstall zip archives, with `check-tooling-stack.sh`
  rejecting Python reintroduction in `tools/dev/bootstrap-tools.sh`.
- Node direct addon packaging now uses the shared Bun
  `tools/release/archive_dir.mjs` helper for release asset tar/zip creation and
  shell `tar` for npm package membership checks, removing inline Python from
  that packaging script while keeping the existing release validators intact.
- The remaining tracked Python files are now an explicit policy inventory in
  `tools/policy/python-entrypoints.allowlist`, checked by
  `bun tools/policy/check-python-entrypoints.mjs` from `check-tooling-stack.sh`.
  That inventory currently contains release orchestration/package validators,
  graph/coverage helpers, extension model checks, and runtime lock helpers. New
  Python files must either be intentionally allowlisted or ported to Bun. The
  per-Python-script migration decisions remain open.
- Rust SDK release-shaped fixture generation now uses Bun instead of Python.
  `tools/test/create-liboliphaunt-release-fixture.mjs` and
  `tools/test/create-broker-release-fixture.mjs` stage the same fixture
  layouts and call the shared deterministic `tools/release/archive_dir.mjs`
  helper for tar.gz/zip output. The retired Python fixture generators and
  shared Python utility were removed from the Python inventory.
- Broker and Node direct release asset validation now uses Bun. The validators
  share archive/checksum parsing through `tools/release/release-asset-validation.mjs`
  and derive published target membership from Moon release metadata through
  `tools/release/release-artifact-targets.mjs`, keeping the helper/runtime
  release checks on the same target graph as CI and publication.
- The shared fixture test-matrix checker now uses Bun instead of Python.
  `src/shared/contracts/tools/check-test-matrix.mjs` preserves the matrix-only
  and fixture-manifest validation modes, the shared contracts/fixtures Moon
  projects are modeled as JavaScript tooling, and the Python entrypoint
  inventory no longer allows the retired checker path.
- Release PR product-version coverage now uses Bun instead of Python.
  `tools/release/check_release_pr_coverage.mjs` keeps release-please manifest
  diffs tied to `tools/release/release.py plan --format json`, and the release
  check command invokes the Bun checker directly.
- Native-boundary policy now uses Bun instead of inline Python. The stable
  `tools/policy/check-native-boundaries.sh` entrypoint delegates to
  `tools/policy/check-native-boundaries.mjs`, and `check-tooling-stack.sh`
  rejects reintroducing the inline Python block.
- Runtime WASIX asset-mode preflight now uses Bun instead of inline Python while
  keeping the shared `tools/runtime/preflight.sh` shell entrypoint POSIX-sh
  source-compatible for SDK checks. `check-tooling-stack.sh` rejects
  reintroducing the inline Python manifest parser there.
- Rust SDK Cargo artifact relay smoke setup now expands generated
  `packages.json` metadata into `[patch.crates-io]` entries with
  `src/sdks/rust/tools/cargo-artifact-patches.mjs` instead of an inline Python
  JSON parser. The broader release-source staging call still goes through
  `release.py` until that release graph is ported as a whole.
- SDK CI artifact staging now resolves Rust `.crate` filenames with
  `tools/release/cargo-crate-filename.mjs` instead of an inline Python TOML
  parser. The unused inline workspace-exclusion Python helper was removed, and
  `check-tooling-stack.sh` rejects drift back to either path.
- Rust helper inventory is currently limited to `tools/xtask` and
  `tools/perf/runner`. Both remain Rust-owned for now: `xtask` owns WASIX asset
  parsing, archive/hash work, AOT/template feature-gated paths, and release
  workspace assembly; `tools/perf/runner` links the Rust SDK/runtime code and
  database clients for benchmark controls. Future Bun migration should target
  individual release/policy orchestration scripts first, not these Rust crates
  wholesale.
- CI/release producer-to-consumer audit found no P0/P1 mapping gaps across
  Cargo, npm, Maven, SwiftPM, or GitHub release assets. Existing
  `release.py check`, artifact-target, release-metadata, consumer-shape, and
  registry-publication checks cover the package surfaces. The local-registry
  aggregate artifact-name preset was replaced with derived release metadata
  helpers after the audit.
- Native runtime Maven publication now derives runtime asset filenames from
  `artifact_targets` instead of a static `RUNTIME_MAVEN_ARTIFACTS` table, and
  release metadata rejects reintroducing that duplicate Maven package-surface
  mapping.
- Exact-extension package naming is now policy-checked: native/mobile extension
  registry packages stay target-suffixed without a `native` qualifier, while
  generated WASIX extension crates use `oliphaunt-extension-*-wasix` and
  `oliphaunt-extension-*-wasix-aot-*`.
- Android split/local runtime packaging now validates selected extension
  control and versioned SQL files in the copied runtime tree before generated
  manifests can declare those extensions. The public Android Gradle resolver
  applies the same check after Maven exact-extension runtime artifacts are
  merged, and release metadata plus consumer-shape checks now enforce that
  resolver behavior.
- React Native Android split/local runtime packaging now has the same selected
  extension control/SQL validation as Kotlin Android, with the mobile extension
  surface policy checking that the guard remains in place before manifests are
  published.
- On 2026-06-26,
  `examples/tools/with-local-registries.sh bash src/sdks/react-native/tools/check-sdk.sh build-android-bridge`
  passed using the checked-in Gradle wrapper. The lane exercised the positive
  split/prebuilt runtime resource paths and the negative selected-extension
  missing-SQL diagnostics.
- On 2026-06-26, local Android validation used `target/android-sdk` with
  Android platform 36, build tools 35/36, CMake 3.22.1, NDK 27.0.12077973,
  command-line tools, and Java 17. Kotlin `test-unit` passed against that SDK.
  The React Native Android bridge local-registry lane also passed after
  aligning Gradle property lookup so both canonical lower-case
  `-Poliphaunt...` properties and the existing capitalized spellings resolve,
  and after enabling packaged runtime mode for the static-extension link
  evidence assertion.
- Swift runtime-resource package-kind rejection now has an executable `@Test`
  annotation, and release metadata plus consumer-shape checks guard against
  regressing it to an unannotated helper.
- Subagent SDK audit found these remaining next fixes: continue the broader SDK
  artifact-resolution comparison, identify any remaining feature gaps across
  SDKs, and add parity checks for invariants that are still documented only in
  prose.
- React Native capability reporting now clears backup/restore support and
  format lists when the New Architecture JSI ArrayBuffer transport is missing.
  TypeScript package metadata path resolution now rejects absolute paths, URLs,
  NUL bytes, and traversal for Node and Deno runtime, ICU, extension, and split
  tools package paths. SDK parity policy now documents the desktop TypeScript
  `throughput` + `safe` default and Node prebuilt optional adapter path, with
  machine checks for those invariants.
- Subagent CI/release audit found these remaining release-surface fixes: remove
  or validate the duplicated native Maven artifact manifest rows, derive Kotlin
  Maven existing-version probes from the declared package set, add coverage
  checks from `publish_targets` to workflow/release handlers, and keep WASIX
  tools-AOT package maps tied to the public WASIX Cargo package graph.
- Native runtime Maven artifact manifest generation now derives its four
  `dev.oliphaunt.runtime:*` coordinates from
  `liboliphaunt-native.registry_packages`; unknown runtime Maven coordinates
  fail manifest generation instead of being silently omitted.
- Kotlin Maven existing-version probes now derive their three Maven Central POM
  URLs from `oliphaunt-kotlin.registry_packages`. The release metadata check
  rejects reintroduced hard-coded Kotlin Maven URLs.
- Release metadata checks now compare every product's declared
  `publish_targets` with `release.py` publish-step target coverage and require
  the Release workflow to invoke each non-extension product step. TypeScript's
  combined npm/JSR step and Swift's combined GitHub/SwiftPM-source-tag step are
  represented explicitly in the coverage map.
- Local workflow tooling is available: `act` is installed at v0.2.89, which
  matches the latest upstream release published on 2026-06-01, Docker is
  available, `act -l` parses the CI, Release, and mobile E2E workflow graph,
  and the CI `release-intent` job dry-run selects successfully with
  `ghcr.io/catthehacker/ubuntu:act-latest`. Full Linux lane execution should
  run from a committed disposable worktree because `actions/checkout` validates
  committed HEAD rather than uncommitted local edits.
- JS Deno direct mode now resolves packaged ICU for explicit-library installs
  when running inside Deno, and rejects package-managed extension requests
  without an explicit prepared `runtimeDirectory`. Node and Bun remain the
  registry-managed extension materialization paths.
- JS Deno package-managed native installs now mirror Node/Bun split runtime
  tool resolution for the core tools package: the resolver validates
  `@oliphaunt/tools-*`, requires `pg_dump` and `psql`, and materializes a
  merged runtime tree from the installed `liboliphaunt` and tools packages.
  Package-managed extension materialization remains explicitly unsupported for
  Deno until it has a real extension resolver/cache path.
- JS Deno nativeServer package-managed startup now uses the same Deno native
  resolver, so server mode gets the merged split-tools runtime and packaged ICU
  sidecar without falling through the Node resolver. Deno server extensions
  keep the explicit prepared-`serverToolDirectory` requirement.
- Release metadata checks now require the Deno package-managed extension
  rejection guard and its unit test, so the documented Deno limitation cannot
  silently drift from Node/Bun behavior.
- Rust native runtime cache validation already requires both split client tools, with `runtime_validation_requires_split_tools` covering a missing `pg_dump` cache entry.
- WASIX Rust now exposes `preflight_wasix_tools` plus
  `OliphauntServer::preflight_tools()`, and each WASIX example calls the server
  preflight before its `pg_dump`/`psql` smoke. Release checks require the
  preflight API to load both split WASM payloads and their target AOT artifacts.
- Local Cargo registry publishing now treats explicit `--artifact-root` values
  as the selected publish set and clears the local Cargo registry cache after
  same-version republishes. This prevents stale unpacked crates from masking the
  current split WASIX tools and extension-AOT package graph during example runs.
- `examples/tools/run-electron-driver-smoke.sh examples/electron-wasix` and
  `examples/tools/run-tauri-webdriver-smoke.sh examples/tauri-wasix` passed
  after the local Cargo registry was refreshed from current artifacts; both
  compiled the selected `hstore`, `pg_trgm`, and `unaccent` WASIX AOT extension
  crates from the local registry and exercised the `pg_dump`/`psql` path.
- Mobile native-direct startup now passes packaged runtime
  `sharedPreloadLibraries` through to `shared_preload_libraries=...` startup
  args in Kotlin Android/React Native Android and Swift/React Native iOS.
  Kotlin static/unit checks, mobile extension policy checks, and release checks
  passed locally; Swift-specific test execution was not run because this Linux
  host does not have a Swift toolchain.
- SDK parity metadata now records each SDK's normal runtime artifact, standalone
  tool, exact-extension, and explicit local override path. The parity policy
  documents the cross-SDK artifact-resolution matrix, and
  `tools/policy/check-sdk-parity.sh` fails if Rust/TypeScript split tools,
  mobile direct-mode no-tools behavior, React Native delegation, explicit local
  override paths, or the Deno explicit-`runtimeDirectory` extension deviation
  drift from that matrix.
- TypeScript broker/server parity is now tighter: Deno `nativeBroker` rejects
  package-managed extensions without an explicit prepared `runtimeDirectory`,
  broker restore passes the resolved native install environment, and
  `nativeServer` preflights both split client tools (`pg_dump` and `psql`) for
  explicit and package-managed tool directories. The JS SDK release-check uses
  pnpm's trusted-lockfile mode for its scratch workspace so local unpublished
  `@oliphaunt/*` packages do not fail npm age checks before package validation.
- `oliphaunt-build` now validates artifact manifest kind/product boundaries and
  required split-tool payloads before staging Cargo-resolved artifacts. Native
  tool artifacts must contain both `pg_dump` and `psql`; WASIX tool artifacts
  must contain `pg_dump` and `psql` payloads and reject `pg_ctl`; WASIX
  tools-AOT similarly requires `pg_dump`/`psql` AOT payloads.
- `oliphaunt-wasix` now validates the package-manager-resolved tools AOT
  manifest again at SDK load time: it must contain exactly `tool:pg_dump` and
  `tool:psql`, with no missing, duplicate, or non-tool artifacts before the
  tools manifest is merged into the runtime AOT namespace.
- On 2026-06-26, the current branch passed the package-surface verification
  gates for the P0 CI/release metadata item: `check_release_metadata.py`,
  `check_consumer_shape.py`, `check_artifact_targets.py`,
  `check-release-policy.py`, `check-workflows.sh`, and
  `check-wasix-release-dependency-invariants.mjs`. Together these prove the
  release metadata, consumer package shapes, workflow wiring, artifact target
  derivation, and WASIX registry dependency graph are aligned with the intended
  Cargo, npm, Maven, SwiftPM, and GitHub release surfaces.
- On 2026-06-26, the example GUI smoke wrappers were tightened to run a
  filtered `pnpm install` through `examples/tools/with-local-registries.sh`
  before building each Electron/Tauri app. The four GUI smokes passed after
  this change (`examples/electron`, `examples/electron-wasix`,
  `examples/tauri`, and `examples/tauri-wasix`), and the nested WASIX SQLx
  profiler passed with a report containing the `validate split WASIX tools`
  startup phase.
- On 2026-06-26, the SDK parity guard was tightened so Swift, Kotlin
  Android/common, and React Native source trees reject accidental standalone
  `pg_dump` or `psql` APIs. This keeps mobile native-direct/delegating SDKs
  aligned with the parity matrix: desktop Rust and TypeScript own split client
  tool package access, while mobile SDKs consume runtime resources only.
- On 2026-06-26, the WASIX Rust product test wrapper was tightened to compile
  the `extensions,tools` feature path for the split-tools preflight test without
  requiring generated runtime assets in the unit lane. The full runtime-smoke
  lane remains responsible for executing `pg_dump` and `psql` once assets are
  available.
