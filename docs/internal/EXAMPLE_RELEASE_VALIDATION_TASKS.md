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
- [x] Check CI/release workflows produce exactly the current package surfaces
  declared by release metadata, without duplicated target lists or hidden
  registry package synthesis.
- [x] Derive WASIX runtime/tools Cargo package expectations from the canonical
  WASIX artifact package graph in release rendering, staged-artifact validation,
  and example lockfile validation.
- [ ] Check Rust, JS, WASIX Rust, React Native, Kotlin, and Swift SDKs use
  consistent runtime setup, extension selection, artifact validation, and tool
  access semantics where the platforms overlap.
- [x] Align React Native package-size reports with Kotlin and Swift by carrying
  `runtimeFeatures` through the native spec, Android bridge, iOS bridge, and JS
  normalization.
- [x] Fix mobile explicit `runtimeDirectory` extension validation so Kotlin,
  Swift, and React Native reject selected extensions unless release-shaped
  runtime resources prove extension files, static registry readiness, and
  shared preload metadata.
- [ ] Add or adjust machine checks for any invariant currently enforced only by
  convention or docs.
- [x] Harden TypeScript Node/Bun/Deno runtime cache publication so
  package-managed runtime/tool/extension materialization publishes through a
  temp/marker or equivalent atomic protocol instead of rebuilding cache roots
  in place.
- [x] Add Swift and Kotlin negative tests for unsupported mobile
  `runtimeFeatures`, and update maintainer docs so the shared runtime-resource
  manifest field list includes `runtimeFeatures`.

### P2: Cleanup and Tooling Migration

- [ ] Run targeted dead-code detection for Rust, TypeScript/JavaScript, shell,
  Python, and release helpers.
- [ ] Remove only confirmed dead code with reference evidence.
- [ ] Inventory remaining Python and Rust helper scripts; move nonessential
  scripts to Bun where that improves local developer experience without making
  critical product code less idiomatic.
- [x] Fix or refresh the measured `oliphaunt-js` coverage lane; the current
  focused asset resolver and JSR entrypoint tests keep the lane above the 80%
  global threshold and produce the structured coverage summary.
- [ ] Re-run Linux CI-like and release/local-registry lanes after each tooling
  migration batch.

### Current Fresh Evidence

- 2026-06-26: `git status --short --branch` was clean on
  `f0rr0/reduce-oliphaunt-icu-crate-size` at commit `895ed8d` before the fresh
  example e2e run.
- 2026-06-26: The `oliphaunt-js` coverage lane was refreshed after adding
  focused Node asset resolver coverage for split native tools, ICU package
  metadata, extension payload materialization, and the JSR entrypoint.
  `tools/coverage/run-product oliphaunt-js` passed with 17 tests and the
  structured summary now reports 81.65% line coverage against the 80% gate.
  Follow-up checks passed: `tools/coverage/check-product oliphaunt-js`,
  `tools/coverage/summarize --allow-missing --products-json '["oliphaunt-js"]'`,
  `bash tools/policy/check-coverage.sh oliphaunt-js`, and
  `tools/dev/bun.sh tools/coverage/coverage.mjs check-tools`.
- 2026-06-26: Tightened TypeScript Node/Bun exact-extension package
  materialization to validate release-shaped extension payloads before copying
  them into the runtime cache. Generated JS/React Native extension metadata now
  exposes noncanonical SQL file prefixes/names, and the Node resolver requires
  selected extension control files, SQL install files, declared data files, and
  native module files across split payload packages. Fresh checks passed:
  `python3 src/extensions/tools/check-extension-model.py --write`,
  `python3 src/extensions/tools/check-extension-model.py --check`,
  `pnpm --dir src/sdks/js test`, `pnpm --dir src/sdks/js typecheck`,
  `bash src/sdks/js/tools/check-sdk.sh check-static`,
  `pnpm --dir src/sdks/react-native test`,
  `pnpm --dir src/sdks/react-native typecheck`,
  `bash tools/policy/check-sdk-parity.sh`,
  `bash tools/policy/check-sdk-mobile-extension-surface.sh`,
  `python3 tools/release/check_consumer_shape.py`,
  `python3 tools/release/check_release_metadata.py`,
  `python3 tools/release/check_artifact_targets.py`,
  `bash tools/policy/check-tooling-stack.sh`,
  `tools/dev/bun.sh tools/policy/check-test-strategy.mjs`,
  `tools/coverage/run-product oliphaunt-js`,
  `tools/coverage/check-product oliphaunt-js`,
  `tools/coverage/summarize --allow-missing --products-json '["oliphaunt-js"]'`,
  `bash tools/policy/check-coverage.sh oliphaunt-js`, and `git diff --check`.
  The coverage summary reported 81.61% line coverage against the 80% gate.
- 2026-06-26: Added Swift and Kotlin negative coverage for unsupported
  `runtimeFeatures` in shared runtime-resource manifests, kept positive
  package-size report coverage for `runtimeFeatures=icu`, and updated maintainer
  manifest field docs plus SDK parity policy checks. Fresh checks passed:
  `bash tools/policy/check-sdk-parity.sh`,
  `bash tools/policy/check-sdk-mobile-extension-surface.sh`,
  `ANDROID_HOME=$PWD/target/android-sdk ANDROID_SDK_ROOT=$PWD/target/android-sdk bash src/sdks/kotlin/tools/check-sdk.sh check-static`,
  `ANDROID_HOME=$PWD/target/android-sdk ANDROID_SDK_ROOT=$PWD/target/android-sdk bash src/sdks/kotlin/tools/check-sdk.sh test-unit`,
  `python3 tools/release/check_release_metadata.py`,
  `python3 tools/release/check_consumer_shape.py --products-json
  '["oliphaunt-swift","oliphaunt-kotlin","oliphaunt-react-native"]'`, and
  `git diff --check`. Swift executable validation could not run in this Linux
  container because the `swift` command is not installed.
- 2026-06-26: Current-state example e2e re-run passed against the staged local
  registries from commit `895ed8d`: `examples/tools/run-electron-driver-smoke.sh
  examples/electron`, `examples/tools/run-electron-driver-smoke.sh
  examples/electron-wasix`, `examples/tools/run-tauri-webdriver-smoke.sh
  examples/tauri`, and `examples/tools/run-tauri-webdriver-smoke.sh
  examples/tauri-wasix`.
  Native Electron verified `@oliphaunt/ts`,
  `@oliphaunt/liboliphaunt-linux-x64-gnu`,
  `@oliphaunt/tools-linux-x64-gnu`, and `@oliphaunt/extension-hstore` from
  installed `node_modules`; WASIX Electron and Tauri exercised
  `preflight_tools`, `pg_dump --schema-only`, and noninteractive `psql SELECT
  1` through the split `oliphaunt-wasix-tools` registry packages.
- 2026-06-26: `bash examples/tools/check-examples.sh` passed, and
  `bash src/bindings/wasix-rust/tools/check-examples.sh` passed with its copied
  workspace locked Cargo check plus frontend build. The nested WASIX SQLx
  profiler also passed through `examples/tools/with-local-registries.sh cargo
  run --manifest-path
  src/bindings/wasix-rust/examples/tauri-sqlx-vanilla/src-tauri/Cargo.toml
  --locked --bin profile_queries -- --fresh --rows 10 --json-out
  target/oliphaunt-wasix-rust/examples/tauri-sqlx-vanilla/profile-e2e-2026-06-26.json`;
  the generated report included startup phase `validate split WASIX tools`.
- 2026-06-26: Tightened fresh parity checks for runtime-resource metadata and
  split WASIX example deps. Kotlin Android, React Native Android, and the React
  Native Expo runtime-resource helper now emit or assert `runtimeFeatures=` in
  generated manifests; the nested WASIX SQLx example policy now requires the
  root runtime AOT crate alongside `oliphaunt-wasix-tools` and tools-AOT crates;
  and the nested tool smoke can no longer skip `preflight_tools`, `dump_sql`, or
  `psql` on non-TCP endpoints.
- 2026-06-26: React Native Android static-extension smoke now uses a per-run
  link-evidence path so CMake cannot reuse an old configure result after the
  harness deletes evidence. Fresh checks passed:
  `ANDROID_HOME=$PWD/target/android-sdk ANDROID_SDK_ROOT=$PWD/target/android-sdk
  OLIPHAUNT_SDK_CHECK_SCRATCH=$(mktemp -d /tmp/oliphaunt-rn-check.XXXXXX) bash
  src/sdks/react-native/tools/check-sdk.sh build-android-bridge`.
- 2026-06-26: Split root/tools package-shape checks passed with
  `python3 tools/release/check_release_metadata.py`,
  `python3 tools/release/check_consumer_shape.py`,
  `bash tools/policy/check-native-boundaries.sh`, and
  `bun tools/policy/check-wasix-release-dependency-invariants.mjs`. Local crate
  payload inspection found native root crates carrying only `initdb`, `pg_ctl`,
  and `postgres`; native `oliphaunt-tools-*` carrying `pg_dump` and `psql`;
  WASIX root carrying only `initdb` plus runtime/template payloads; and
  `oliphaunt-wasix-tools` carrying `pg_dump.wasix.wasm` and `psql.wasix.wasm`.
- 2026-06-26: Native root/tools npm descriptor checks now read
  `publishConfig.executableFiles` directly. Root package descriptors must list
  only `initdb`, `pg_ctl`, and `postgres`; split `@oliphaunt/tools-*`
  descriptors must list only `pg_dump` and `psql`, including Windows `.exe`
  variants. Fresh check passed: `python3 tools/release/check_consumer_shape.py`.
- 2026-06-26: Rechecked the split tools model against current local-registry
  artifacts. Native `liboliphaunt-0.1.0-linux-x64-gnu.tar.gz` contains
  `runtime/bin/initdb`, `runtime/bin/pg_ctl`, and `runtime/bin/postgres`;
  native `oliphaunt-tools-0.1.0-linux-x64-gnu.tar.gz` contains only
  `runtime/bin/pg_dump` and `runtime/bin/psql`; `liboliphaunt-wasix-portable`
  contains `payload/bin/initdb.wasix.wasm` and no split tools; and
  `oliphaunt-wasix-tools` contains `payload/bin/pg_dump.wasix.wasm` and
  `payload/bin/psql.wasix.wasm`, with no `pg_ctl`. A sweep of 286 local
  registry crate files found every crate at or below the 10 MiB limit.
- 2026-06-26: Tightened the current WASIX split-tools release guards after
  commit `88cffc7`; `check_consumer_shape.py` now asserts exact WASIX root
  runtime archive, tools payload, forbidden root tool, and tools-AOT payload
  constants. Fresh package generation and payload inspection found native
  root/tool and WASIX root/tool crates below the 10 MiB crate limit with
  `pg_dump` and `psql` only in the split tools packages.
- 2026-06-26: TypeScript extension selection now validates requested extension
  IDs against the generated extension catalog before startup argument
  construction, and Node/Bun extension package materialization uses only
  generated package-materialization dependencies. Fresh checks passed:
  `pnpm --dir src/sdks/js test`, `pnpm --dir src/sdks/js typecheck`,
  `bash src/sdks/js/tools/check-sdk.sh check-static`,
  `python3 tools/release/check_consumer_shape.py`,
  `python3 tools/release/check_release_metadata.py`,
  `bash tools/policy/check-sdk-parity.sh`, and `git diff --check`.
- 2026-06-26: React Native JS extension selection now rejects unknown
  generated-catalog extension IDs before crossing the TurboModule bridge,
  matching the TypeScript preflight behavior while Kotlin and Swift continue to
  validate exact mobile runtime resources. The React Native scratch package
  check now generates a package-scoped pnpm lockfile instead of copying the
  monorepo lockfile, so unpublished local-registry example dependencies do not
  break SDK static checks. Fresh checks passed:
  `pnpm --dir src/sdks/react-native test`,
  `pnpm --dir src/sdks/react-native typecheck`,
  `bash src/sdks/react-native/tools/check-sdk.sh check-static`,
  `python3 tools/release/check_release_metadata.py`,
  `python3 tools/release/check_consumer_shape.py`,
  `bash tools/policy/check-sdk-parity.sh`,
  `bash tools/policy/check-tooling-stack.sh`, and `git diff --check`.
- 2026-06-26: React Native mobile exact-extension artifact path resolution now
  uses `src/sdks/react-native/tools/mobile-extension-artifact-paths.mjs`
  through the pinned Bun launcher instead of an inline Python heredoc in
  `mobile-extension-runtime.sh`. A fixture check covered the matching runtime
  asset path and optional-missing exit code, and fresh checks passed:
  `bash -n src/sdks/react-native/tools/mobile-extension-runtime.sh
  src/sdks/react-native/tools/expo-android-runner.sh
  src/sdks/react-native/tools/expo-ios-runner.sh`,
  `bash tools/policy/check-tooling-stack.sh`,
  `bash tools/policy/check-sdk-mobile-extension-surface.sh`,
  `bun tools/policy/check-test-strategy.mjs`,
  `bash src/sdks/react-native/tools/check-sdk.sh check-static`,
  `python3 tools/release/check_release_metadata.py`,
  `python3 tools/release/check_consumer_shape.py`, and `git diff --check`.
- 2026-06-26: Final source architecture policy checks now run through
  `tools/policy/check-final-source-architecture.mjs` and the pinned Bun
  launcher instead of the retired Python entrypoint. The Python entrypoint was
  removed from `tools/policy/python-entrypoints.allowlist`, and
  `check-tooling-stack.sh` now rejects stale references to
  the retired checker path.
- 2026-06-26: SwiftPM source-tag publishing now runs through
  `tools/release/publish_swiftpm_source_tag.mjs` and the pinned Bun launcher
  instead of the retired Python entrypoint. The reusable
  `tools/release/product-version.mjs` helper now exports `currentVersion()` for
  release helpers while preserving its CLI. Fresh checks passed:
  `tools/dev/bun.sh tools/release/product-version.mjs version oliphaunt-swift`,
  `tools/dev/bun.sh tools/release/publish_swiftpm_source_tag.mjs --help`,
  `tools/dev/bun.sh tools/release/publish_swiftpm_source_tag.mjs --target
  0.1.0`, `tools/dev/bun.sh tools/policy/check-python-entrypoints.mjs`,
  `bash tools/policy/check-tooling-stack.sh`,
  `python3 tools/release/check_release_metadata.py`,
  `python3 tools/release/check_consumer_shape.py --products-json
  '["oliphaunt-swift"]'`, `python3 tools/release/check_consumer_shape.py`,
  `python3 tools/release/check_artifact_targets.py`, and
  `git diff --cached --check`.
- 2026-06-26: Maven runtime and exact-extension artifact TSV generation now
  runs through `tools/release/build_maven_artifact_manifest.mjs` and the
  pinned Bun launcher instead of the retired Python entrypoint. The Bun port
  derives versions from `product-version.mjs`, release products and published
  targets from Moon release metadata, Maven coordinates and extension SQL names
  from `release.toml`, and exact-extension Android rows from the same default
  target rules plus `targets/artifacts.toml` overrides as the retired Python
  helper. The release PR sync gate also refreshed the WASIX asset input
  fingerprint and extension evidence source digests. Fresh checks passed:
  runtime TSV smoke against `target/tools-split-fixture-assets`, PostGIS
  extension TSV smoke against a two-file Android Maven fixture,
  `tools/dev/bun.sh tools/policy/check-python-entrypoints.mjs`,
  `bash tools/policy/check-tooling-stack.sh`,
  `python3 tools/release/check_release_metadata.py`,
  `python3 tools/release/check_consumer_shape.py --products-json
  '["liboliphaunt-native","oliphaunt-kotlin"]'`,
  `python3 tools/release/check_consumer_shape.py`,
  `python3 tools/release/check_artifact_targets.py`,
  `python3 tools/policy/check-release-policy.py`,
  `python3 tools/release/sync_release_pr.py --check`,
  `tools/release/release.py check`, and `git diff --cached --check`.
- 2026-06-26: SwiftPM release manifest rendering now runs through
  `tools/release/render_swiftpm_release_package.mjs` and the pinned Bun
  launcher instead of the retired Python entrypoint. The Bun port preserves
  release-shaped Apple XCFramework validation, checksum resolution, and
  generated `OliphauntICU` resource-tree extraction without adding hidden npm
  archive/plist dependencies. Fresh checks passed:
  `node --check tools/release/render_swiftpm_release_package.mjs`,
  `tools/dev/bun.sh tools/release/render_swiftpm_release_package.mjs --help`,
  release-shaped fixture rendering against
  `target/swiftpm-renderer-bun-smoke/assets`,
  `bash -n src/sdks/swift/tools/check-sdk.sh
  tools/release/build-sdk-ci-artifacts.sh`,
  `python3 tools/release/check_release_metadata.py`,
  `python3 tools/release/check_consumer_shape.py --products-json
  '["oliphaunt-swift"]'`, `tools/dev/bun.sh
  tools/policy/check-python-entrypoints.mjs`, `bash
  tools/policy/check-tooling-stack.sh`,
  `python3 tools/release/check_consumer_shape.py`,
  `python3 tools/release/check_artifact_targets.py`,
  `python3 tools/policy/check-release-policy.py`,
  `python3 tools/release/sync_release_pr.py --check`,
  `tools/release/release.py check`, `bash tools/policy/check-sdk-parity.sh`,
  and `git diff --cached --check`. SwiftPM package-shape itself was not run
  in this Linux batch because `swift` is not installed on the host.
- 2026-06-26: Coverage orchestration now runs through
  `tools/coverage/coverage.mjs` and the pinned Bun launcher while keeping the
  stable wrapper API (`tools/coverage/run-product`, `check-product`, and
  `summarize`). The port preserves the existing lcov, Vitest, Swift JSON, and
  Kover report contracts and removes `tools/coverage/coverage.py` from the
  intentional Python entrypoint inventory.
- 2026-06-26: Rust SDK broker Cargo relay smoke setup now prepares the generated
  publish source through `python3 tools/release/release.py
  prepare-rust-release-source` instead of an inline Python heredoc that imports
  release internals. The release CLI command validates generated Rust SDK
  artifact dependency coverage and prints the staged manifest path. Fresh
  checks passed: `python3 tools/release/release.py prepare-rust-release-source`,
  `bash src/sdks/rust/tools/check-sdk.sh package-shape`,
  `bash tools/policy/check-tooling-stack.sh`,
  `python3 tools/release/check_release_metadata.py`,
  `python3 tools/release/check_consumer_shape.py`, and `git diff --check`.
- 2026-06-26: WASIX third-party extension build metadata reads now use
  `src/runtimes/liboliphaunt/wasix/assets/build/wasix-toml-value.mjs` through
  the pinned Bun launcher instead of inline Python heredocs in
  `wasix_third_party.sh`. Direct probes covered recipe string reads, dependency
  list reads, and the previous missing-list-as-empty behavior; sourced shell
  function probes returned `postgis` and the expected PostGIS dependency list.
  Fresh checks passed: `tools/dev/bun.sh --version`,
  `bash -n src/runtimes/liboliphaunt/wasix/assets/build/wasix_third_party.sh`,
  `bash tools/policy/check-tooling-stack.sh`, and `git diff --check`.
- 2026-06-26: WASIX exact-extension release asset packaging now uses
  `src/extensions/artifacts/wasix/tools/package-release-assets.mjs` through the
  pinned Bun launcher instead of shell-embedded Python/product_metadata calls.
  Product-scoped PostGIS packaging passed through both direct helper and shell
  wrapper paths, and an all-extension smoke staged 39 WASIX exact-extension
  artifacts plus TSV index rows from the generated runtime asset directory.
  Fresh checks passed: `bash -n
  src/extensions/artifacts/wasix/tools/package-release-assets.sh`,
  `bash tools/policy/check-tooling-stack.sh`,
  `python3 tools/release/check_artifact_targets.py`,
  `python3 tools/policy/check-release-policy.py`,
  `python3 tools/release/check_release_metadata.py`,
  `python3 tools/release/check_consumer_shape.py`, and `git diff --check`.
- 2026-06-26: GitHub release asset upload tooling now uses
  `tools/release/upload_github_release_assets.mjs` through the pinned Bun
  launcher from `release.py`; the retired Python uploader was removed from the
  intentional Python inventory. Local CLI probes covered missing repository,
  unknown product default-tag resolution, and missing asset rejection before any
  GitHub upload call. Fresh checks passed:
  `bash tools/policy/check-tooling-stack.sh`,
  `python3 tools/policy/check-release-policy.py`,
  `python3 tools/release/check_release_metadata.py`,
  `python3 tools/release/check_consumer_shape.py`, and `git diff --check`.
- 2026-06-26: Native release binary stripping now uses
  `tools/release/strip_native_release_binaries.mjs` from broker, mobile,
  Node-direct, native extension, and runtime-payload optimization packaging
  paths; the retired Python stripper was removed from the intentional Python
  inventory, reducing it to 34 tracked files. A fake-strip smoke covered ELF
  magic-byte classification, configured strip command invocation, changed-file
  counting, empty-directory behavior, and missing-path failure. Fresh checks
  passed: `bash tools/policy/check-tooling-stack.sh`,
  `bash src/runtimes/node-direct/tools/check-package.sh check-static`,
  `tools/dev/bun.sh tools/release/optimize_native_runtime_payload.mjs --help`,
  `python3 tools/release/check_artifact_targets.py`,
  `python3 tools/policy/check-release-policy.py`,
  `python3 tools/release/check_release_metadata.py`,
  `python3 tools/release/check_consumer_shape.py`, and `git diff --check`.
- 2026-06-26: Mobile explicit runtime-directory validation now requires
  release-shaped `oliphaunt/runtime/files` proof before selected extensions are
  accepted on Kotlin Android and Swift native-direct; React Native forwards the
  same `extensions`, `runtimeDirectory`, and `resourceRoot` controls into those
  SDKs. Fresh checks passed:
  `bash tools/policy/check-sdk-mobile-extension-surface.sh`,
  `python3 tools/release/check_release_metadata.py`,
  `python3 tools/release/check_consumer_shape.py`,
  `pnpm --dir src/sdks/react-native test`,
  `pnpm --dir src/sdks/react-native typecheck`,
  `ANDROID_HOME=$PWD/target/android-sdk ANDROID_SDK_ROOT=$PWD/target/android-sdk bash src/sdks/kotlin/tools/check-sdk.sh test-unit`,
  and
  `ANDROID_HOME=$PWD/target/android-sdk ANDROID_SDK_ROOT=$PWD/target/android-sdk bash src/sdks/kotlin/tools/check-sdk.sh check-static`.
  `bash src/sdks/swift/tools/check-sdk.sh test-unit` remains unrun because
  this Linux host does not have `swift` installed.
- 2026-06-26: Current CI/release package-surface gates passed:
  `tools/release/release.py check`, `python3 tools/release/check_artifact_targets.py`,
  and explicit publish-target/workflow audits over `release.toml`,
  `release.py publish_step_target_coverage`, and `.github/workflows/release.yml`.
  The release check covered release policy, release-please config, artifact
  targets, derived release PR sync, release metadata, and ready consumer-shape
  gates across all products.
- 2026-06-26: Release SDK artifact downloads now derive selected SDK products
  from release metadata via `tools/release/release.py ci-products --family
  sdk-package --products-json "$PRODUCTS_JSON"` instead of hard-coded
  per-SDK workflow booleans. `tools/release/check_staged_artifacts.py` also
  derives SDK products from `artifact_targets.sdk_package_products()`. Fresh
  checks passed: direct `ci-products` smoke, `python3
  tools/release/check_artifact_targets.py`, `python3
  tools/release/check_staged_artifacts.py --inspect-present`, `python3
  tools/policy/check-release-policy.py`, and `tools/release/release.py check`.
- 2026-06-26: SDK parity guard passed after regenerating
  `docs/maintainers/sdk-api-surface.md` for React Native
  `PackageSizeReport.runtimeFeatures` and adding WASIX Rust to the
  machine-checked SDK parity registry/docs matrix. `bash
  tools/policy/check-sdk-parity.sh` now asserts WASIX Rust manifest fields,
  Cargo artifact/runtime/tool/extension resolution, the `tools` feature split,
  and the intentional absence of `pg_ctl`.
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
- 2026-06-26: Rust native `OpenConfig::validate()` now resolves selected
  extension dependencies before runtime startup, aligning explicit validation
  with the JS/Kotlin/Swift/React Native open-time extension normalization path.
  The targeted `sdk_config_modes` test covers an extension with a dependency
  (`earthdistance -> cube`), and release metadata checks require the validation
  path to stay wired.
- 2026-06-26: `oliphaunt-wasix-dump` now declares
  `required-features = ["tools"]`, so Cargo install/build semantics match the
  optional split `oliphaunt-wasix-tools` package instead of installing a binary
  that can only fail at runtime. `check-package.sh` and release metadata checks
  enforce the field.
- 2026-06-26: React Native package-size reports now preserve `runtimeFeatures`
  from Android and iOS native bridges through the JS report type, matching the
  Kotlin and Swift SDK reports. Release metadata checks require the field to
  remain wired across the RN surface.
- 2026-06-26: WASIX Rust `release-check` now runs a product-owned
  `check-release.sh` that depends on release-shaped WASIX AOT artifacts and
  executes `preflight_wasix_tools_loads_split_artifacts` with
  `OLIPHAUNT_WASM_AOT_VERIFY=full`. Normal unit/package checks still compile
  that path without requiring generated runtime assets, while release metadata
  and consumer-shape checks require the strict preflight to stay wired.
- 2026-06-26: SDK parity audit found a remaining mobile P1: explicit
  `runtimeDirectory` paths can bypass release-shaped exact-extension validation
  in Kotlin/Swift and therefore React Native. Fixing it requires a coordinated
  runtime-resource contract change, not a one-line report mapping.
- 2026-06-26: The explicit `runtimeDirectory` mobile P1 is now fixed for
  Kotlin Android and Swift native-direct. Both paths require release-shaped
  runtime resources for selected extensions, validate extension install files
  and static-registry readiness through the manifest path, and return shared
  preload libraries from the proved runtime resources. React Native inherits
  those checks through its Kotlin/Swift SDK delegation.
- 2026-06-26: TypeScript package-managed runtime cache publication now stages
  Node/Bun extension runtime merges, Node/Bun split tool merges, and Deno split
  tool merges under unique `.build-*` roots, writes the manifest as the commit
  marker, and renames the completed tree into place under a per-cache lock.
  JS resolver tests cover leftover cleanup and Deno failed-publish preservation;
  JS static checks and SDK parity checks require the staged publication helpers
  to stay wired.

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
- Broker Cargo artifact packaging now uses
  `tools/release/package_broker_cargo_artifacts.mjs` through pinned Bun from
  release orchestration, local registry publishing, and the Rust SDK
  package-shape relay fixture. The retired Python packager was removed from the
  explicit Python entrypoint inventory, which now contains 33 tracked files.
  On 2026-06-26, focused validation passed with
  `check-tooling-stack.sh`, `check_release_metadata.py`,
  `check_artifact_targets.py`, `check_consumer_shape.py`,
  `check-sdk.sh package-shape`, `check-release-policy.py`, and
  `git diff --cached --check`; the package-shape lane generated and validated
  broker Cargo crates for all four release targets through the Bun path.
- Release asset packagers now use `tools/release/product-version.mjs` for
  version-only release-please reads instead of invoking
  `product_metadata.py version` from shell/PowerShell and the Rust SDK
  package-shape broker fixture. The Bun helper resolves canonical
  release-please version files for raw, Cargo, npm/JSR, and Gradle products.
  On 2026-06-26, it matched the Python helper for all 49 release products, and
  focused validation passed with `check-tooling-stack.sh`,
  `check_release_metadata.py`, `check_artifact_targets.py`,
  `check_consumer_shape.py`, `check-sdk.sh package-shape`, and
  `check-release-policy.py`.
- Moon affectedness discovery now uses `tools/graph/affected.mjs` instead of the
  retired Python helper. The CI planner calls the Bun helper for pull-request
  affected project/task selection, while `graph.py` keeps only local result
  normalization for its own Moon queries. On 2026-06-26, validation passed with
  the direct Bun helper smoke, pull-request-mode `ci_plan.py` smoke,
  `graph.py check`, `check-tooling-stack.sh`, `check-repo-structure.sh`,
  `check_artifact_targets.py`, and `check-release-policy.py`; the intentional
  Python inventory now contains 32 tracked files.
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
- On 2026-06-26, strict local Cargo registry publishing was tightened to fail
  when release-shaped target artifact crates are missing and to reject stale
  legacy unsplit WASIX artifact crates. Non-strict local publishing still prunes
  unavailable target dependency tables, but now also removes matching optional
  `dep:` feature entries so generated source crates remain valid.
- On 2026-06-26, TypeScript native explicit `runtimeDirectory` handling was
  aligned across Node, Bun, Deno, and nativeBroker. Package-managed Node/Bun
  still materialize exact extension npm packages, but explicit runtime
  overrides now validate selected extension control files, install SQL, data
  files, and native modules before opening or launching. Deno keeps its
  package-managed extension limitation, but explicit prepared runtimes are now
  proven instead of merely accepted by path.
- On 2026-06-26, the split client-tool crate contract was rechecked against the
  implementation: native root/runtime artifacts keep `postgres`, `initdb`, and
  `pg_ctl`, native `oliphaunt-tools-*` artifacts keep only `pg_dump` and
  `psql`, WASIX root/runtime artifacts keep `postgres` plus `initdb`, and
  `oliphaunt-wasix-tools` plus tools-AOT artifacts keep `pg_dump` and `psql`
  with no WASIX `pg_ctl`. The focused shape checks passed:
  `check_consumer_shape.py` for liboliphaunt native/WASIX/Rust,
  `check_artifact_targets.py`, `examples/tools/check-examples.sh`, and
  `cargo test -p oliphaunt-build --locked`.
- On 2026-06-26, the GitHub release attestation verifier moved from Python to
  Bun. The new `verify_github_release_attestations.mjs` preserves the
  asset-backed product set, exact-extension release manifest handling, pinned
  signer workflow/source-ref/runner trust checks, and selected release asset
  presence validation before calling `gh attestation verify`. Base product
  expected-asset parity was checked against the previous Python asset checker,
  and the no-product verify path passed through the pinned Bun launcher. A
  subagent audit identified the next reasonable Python migration candidates as
  the native runtime lock helper, registry publication check cluster, and native
  runtime payload optimizer.
- On 2026-06-26, the shared native runtime test lock moved from Python to Bun.
  `with-native-runtime-lock.mjs` keeps the same command-line shape,
  `OLIPHAUNT_NATIVE_RUNTIME_LOCK_FILE`, and
  `OLIPHAUNT_NATIVE_RUNTIME_LOCK_TIMEOUT_SECONDS` controls while using an
  atomic lock directory plus owner metadata for cross-process serialization and
  stale-owner recovery. Direct smokes covered successful command execution,
  metadata materialization, contention timeout exit `124`, stale lock cleanup,
  invalid timeout handling, and usage errors.
- On 2026-06-26, the public registry publication checker moved from Python to
  Bun. `check_registry_publication.mjs` now owns crates.io, npm, JSR, and Maven
  package/version/identity queries, preserves the existing release CLI modes and
  registry retry environment controls, and provides JSON helper subcommands for
  the still-Python release orchestrators. Representative Python/Bun parity
  checks passed for `oliphaunt-js` npm/JSR and `oliphaunt-rust` crates.io
  report modes before the retired Python entrypoints were removed.
- On 2026-06-26, the product-scoped GitHub release asset checker moved from
  Python to Bun. The new `check_github_release_assets.mjs` reuses the shared
  expected-asset and exact-extension manifest validation from the attestation
  verifier, while `check_release_versions.py` now shells to the Bun checker for
  released dependency asset verification.
- On 2026-06-26, native runtime payload optimization moved from Python to Bun.
  `optimize_native_runtime_payload.mjs` now owns pruning, stripping, and
  validation for root runtime payloads and split `oliphaunt-tools` payloads,
  while Python release orchestrators call the Bun CLI and read the shared
  `native-runtime-payload-policy.json` tool split policy. Direct synthetic
  smokes proved runtime mode keeps only `initdb`, `pg_ctl`, and `postgres`,
  tools mode keeps only `pg_dump` and `psql`, and the modified Python callers
  still compile.
