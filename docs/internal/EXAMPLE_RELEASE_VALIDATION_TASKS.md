# Example and Release Validation Tasks

This document tracks the broader validation work for examples, local registry
installs, package production, SDK parity, dead-code cleanup, and script tooling.
Keep the list ordered by dependency: prove the install/runtime shape first, then
review production pipelines, then normalize implementation details.

## Active Continuation Queue: 2026-06-27

This section is the current working queue for the resumed validation goal. Older
checked items below are historical evidence; do not treat the goal as complete
until the current-state gates here are checked with fresh local evidence.

### P0: Re-prove Example Local-Registry Install Paths

- [x] Rebuild or refresh local Cargo and npm registries from current release
  fixture/artifact generation paths, including native runtime crates, native
  `oliphaunt-tools` facade plus `oliphaunt-tools-*` payload crates, WASIX
  runtime/tools/AOT crates, broker crates, extension crates, and JS packages.
- [x] Verify native Tauri installs `liboliphaunt-native-linux-x64-gnu`,
  `oliphaunt-tools`, `oliphaunt-tools-linux-x64-gnu`, and selected extension
  crates from `registry = "oliphaunt-local"` with no path dependency fallback.
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
- [x] Check Rust, JS, WASIX Rust, React Native, Kotlin, and Swift SDKs use
  consistent runtime setup, extension selection, artifact validation, and tool
  access semantics where the platforms overlap.
- [x] Align React Native package-size reports with Kotlin and Swift by carrying
  `runtimeFeatures` through the native spec, Android bridge, iOS bridge, and JS
  normalization.
- [x] Fix mobile explicit `runtimeDirectory` extension validation so Kotlin,
  Swift, and React Native reject selected extensions unless release-shaped
  runtime resources prove extension files, static registry readiness, and
  shared preload metadata.
- [x] Add or adjust machine checks for any invariant currently enforced only by
  convention or docs.
- [x] Harden TypeScript Node/Bun/Deno runtime cache publication so
  package-managed runtime/tool/extension materialization publishes through a
  temp/marker or equivalent atomic protocol instead of rebuilding cache roots
  in place.
- [x] Add Swift and Kotlin negative tests for unsupported mobile
  `runtimeFeatures`, and update maintainer docs so the shared runtime-resource
  manifest field list includes `runtimeFeatures`.

### P2: Cleanup and Tooling Migration

- [x] Run targeted dead-code detection for Rust, TypeScript/JavaScript, shell,
  Python, and release helpers.
- [x] Remove only confirmed dead code with reference evidence.
- [x] Inventory remaining Python and Rust helper scripts; move nonessential
  scripts to Bun where that improves local developer experience without making
  critical product code less idiomatic.
- [x] Fix or refresh the measured `oliphaunt-js` coverage lane; the current
  focused asset resolver and JSR entrypoint tests keep the lane above the 80%
  global threshold and produce the structured coverage summary.
- [x] Re-run Linux CI-like and release/local-registry lanes after each tooling
  migration batch.

### Current Fresh Evidence

- 2026-06-28: Added the Bun publish command surface
  `tools/release/release-publish.mjs` for active release workflow
  `publish-dry-run` and `publish` calls. The workflow now invokes publish
  operations through `tools/dev/bun.sh tools/release/release-publish.mjs`, while
  the existing protected `release.py` implementation remains behind that
  entrypoint until publish dispatch is ported. Release metadata and tooling
  guards now reject direct workflow `release.py publish*` calls.
- 2026-06-28: Added Bun command surfaces for the remaining active release
  metadata and consumer-shape validator implementations:
  `tools/release/check-release-metadata.mjs` and
  `tools/release/check-consumer-shape.mjs`. `release-check.mjs` and
  `release-consumer-shape.mjs` now call those entrypoints instead of invoking
  Python implementation files directly, and tooling/release metadata guards now
  reject reintroducing direct active Python calls. The Python implementations
  remain inventoried behind those wrappers until the full release-graph validator
  ports land.
- 2026-06-28: Added the Bun extension-model command surface
  `src/extensions/tools/check-extension-model.mjs` and moved active Moon
  checks, source-input assertions, release PR evidence sync, and maintained
  validation docs off direct `python3 src/extensions/tools/check-extension-model.py`
  invocations. The Python implementation remains explicit behind the wrapper
  until the full generator/validator port lands, and release metadata guards
  now reject direct Python extension-model calls in active automation.
- 2026-06-28: Removed four confirmed-dead Python helpers:
  `cargo_package_args` and `supported_publish_targets` from
  `tools/release/release.py`, `product_string_list` from
  `tools/release/check_consumer_shape.py`, and `format_toml_string_list` from
  `src/extensions/tools/check-extension-model.py`. A repo-wide reference scan
  showed no callers for any of these symbols; `cargo_package_args` was a stale
  twin of the still-used `cargo_publish_args`, and the publish-target helper
  remains only where it is actually used in `check_release_metadata.py`.
- 2026-06-27: Moved the active release metadata check orchestration to the Bun
  entrypoint `tools/release/release-check.mjs`. Moon `release-tools:check`,
  `release-tools:release-check`, and the release workflow now call the Bun
  helper directly, while `tools/release/release.py check` remains only a
  compatibility delegator. The new helper runs release policy,
  release-please config, artifact target, release PR sync/coverage,
  release-metadata, and consumer-shape readiness checks in the same order as
  the previous Python command.
- 2026-06-27: Moved the remaining non-publish release workflow command
  surfaces to Bun helpers: `release-check-registries.mjs`,
  `release-verify.mjs`, and `release-consumer-shape.mjs`. The release workflow
  and Moon consumer-shape task now use those helpers directly; `release.py`
  keeps compatibility delegators for existing local command habits while active
  CI/release orchestration is no longer routed through Python for these gates.
- 2026-06-27: Moved the Rust SDK generated publish-source preparation command
  from `tools/release/release.py prepare-rust-release-source` to the Bun
  entrypoint `tools/release/prepare-rust-release-source.mjs`. The Rust SDK
  broker Cargo relay check now calls the Bun helper directly, and release
  metadata/tooling guards reject reintroducing the removed `release.py`
  command surface. Fresh smoke evidence generated
  `target/release/cargo-package-sources/oliphaunt/Cargo.toml` with per-target
  `liboliphaunt-native-*` and `oliphaunt-broker-*` dependencies plus the
  `oliphaunt-tools` facade, and without copying `crates/oliphaunt-build`.
- 2026-06-27: Added the Bun user-facing local-registry entrypoint
  `tools/release/local-registry-publish.mjs` and moved current example setup
  docs plus the missing-registry helper message off direct
  `python3 tools/release/local_registry_publish.py` commands. The wrapper keeps
  the existing `download`, `status`, and `publish` CLI contract while giving
  examples a stable Bun command surface for the eventual full port. Release
  metadata and tooling guards now reject drifting example setup back to direct
  Python. Fresh smokes passed for `--help`, `status`,
  `download --preset local-publish --dry-run`, strict Cargo dry-run publish,
  and strict npm dry-run publish through the Bun entrypoint.
- 2026-06-27: Ported the local-registry `status` subcommand into
  `tools/release/local-registry-publish.mjs`. The Bun implementation now
  discovers the same default and explicit artifact roots, lists Cargo/npm/Maven
  and Swift artifacts, and reports tool availability without invoking Python;
  at that point, `download` and `publish` still fell back to the Python
  backend. Fresh parity checks diffed Bun `status` output byte-for-byte against
  `tools/release/local_registry_publish.py status` for default roots and
  `--artifact-root target/sdk-artifacts`.
- 2026-06-28: Ported the local-registry `download` subcommand into
  `tools/release/local-registry-publish.mjs`. The Bun implementation now uses
  the shared Bun local-publish artifact metadata, queries GitHub Actions
  artifact metadata through `gh api`, preserves dry-run output, and downloads
  selected artifacts with `gh run download`; only `publish` still falls back to
  the Python backend. Fresh parity checks diffed Bun and Python dry-run output
  for `--preset local-publish` and a single explicit artifact, and a disposable
  real download smoke fetched `oliphaunt-wasix-rust-package-artifacts`.
- 2026-06-28: Ported the low-risk local-registry `publish --surface maven` and
  `publish --surface swift` paths into `tools/release/local-registry-publish.mjs`.
  Explicit Maven/Swift publishes now preserve the Python JSON report shape,
  dry-run messages, strict missing-artifact behavior, `report.json` writes, and
  copy/stage behavior in Bun. Mixed, Cargo, npm, and all-surface publishes still
  fall back to the Python backend until their generation/indexing logic is
  ported with equivalent coverage. Fresh parity checks diffed Bun and Python
  dry-run output byte-for-byte for Maven, Swift, and combined Maven+Swift.
- 2026-06-28: Ported `publish --surface cargo --dry-run` into
  `tools/release/local-registry-publish.mjs`. The Bun implementation preserves
  the Python dry-run report shape, release-asset/source/native-extension staging
  messages, extension manifest discovery, strict no-crate failure, and sorted
  local `.crate` listing. Real Cargo publishing still falls back to Python until
  the source-crate generation and file-backed Cargo index writer are ported.
  Fresh parity checks diffed Bun and Python output byte-for-byte for strict
  Cargo dry-run and combined strict Cargo+Maven+Swift dry-run.
- 2026-06-28: Ported `publish --surface npm --dry-run` into
  `tools/release/local-registry-publish.mjs`. The Bun implementation now owns
  npm tarball identity detection, duplicate tarball preference, dry-run
  extension package staging, Verdaccio URL reporting, and local pnpm-store
  invalidation reporting. Fresh parity checks diffed Bun and Python
  output byte-for-byte for strict npm dry-run and combined strict
  Cargo+npm+Maven+Swift dry-run. Fresh gates passed: `node --check` for the
  Bun entrypoint, Python `py_compile` for the touched metadata guard,
  `check_release_metadata.py`, `check-tooling-stack.sh`,
  `check-policy-tools.sh`, `check-docs.sh`, `check-python-entrypoints.mjs
  --json`, and `tools/release/release.py check`.
- 2026-06-28: Ported the real local-registry npm publish loop for prebuilt
  `.tgz` artifact roots into `tools/release/local-registry-publish.mjs`. Bun
  now owns Verdaccio config/startup, local auth token setup, package existence
  checks, replacement unpublish, publish, `report.json`, and local pnpm-store
  invalidation when no native/extension npm package synthesis is required.
  Fresh smoke published `target/sdk-artifacts/oliphaunt-js/oliphaunt-ts-0.1.0.tgz`
  into a disposable Verdaccio registry on port 4891 and stopped the temporary
  registry process. At that checkpoint, full native runtime/tools and
  exact-extension npm package synthesis still fell back to Python; later entries
  below moved those generators into Bun.
- 2026-06-28: Removed the last Python delegation from the local-registry
  `status` subcommand by adding Bun-native `status --help` output. The regular
  status report was already generated in Bun; metadata and tooling guards now
  reject reintroducing a status-specific Python fallback. Fresh checks diffed
  the Bun and Python status JSON report byte-for-byte and verified the Bun help
  path without invoking Python.
- 2026-06-28: Moved the rest of the local-registry help surface into
  `tools/release/local-registry-publish.mjs`. Top-level `--help`,
  `download --help`, `publish --help`, and `status --help` now return directly
  from Bun, and guards require the helper functions plus the `publish --help`
  pre-publish branch. Later entries below removed the remaining real publish
  generation fallback.
- 2026-06-28: Removed the generic unknown-command Python fallback from
  `tools/release/local-registry-publish.mjs`. Unsupported local-registry
  commands now fail in Bun with exit code 2, and metadata/tooling guards reject
  both catch-all and publish-specific `local_registry_publish.py` dispatch.
- 2026-06-28: Ported the real local-registry Cargo publish loop for explicit
  prebuilt `.crate` artifact roots into `tools/release/local-registry-publish.mjs`.
  Bun now extracts crate metadata, writes the file-backed Cargo git index,
  translates local versus crates.io dependency registry fields, rejects crates
  over the 10 MiB package limit, writes the Cargo config snippet, clears the
  local Cargo cache, and emits `report.json`. Release-asset, source-crate, and
  native-extension Cargo generation now run through the Bun publish path.
- 2026-06-28: Ported local-registry Cargo release-asset and source-crate
  staging into `tools/release/local-registry-publish.mjs`. Bun now stages
  native runtime plus `oliphaunt-tools` release assets together, stages WASIX
  runtime plus `oliphaunt-wasix-tools` artifact crates, packages
  `oliphaunt-build`, `oliphaunt`, `oliphaunt-wasix`, and generated native
  runtime/tools source manifests through the shared
  `tools/release/cargo-source-package.mjs` helper, and prunes unavailable
  non-host target artifact dependencies while failing strict mode if host
  artifacts are missing. Fresh evidence: a strict native+broker Cargo publish
  correctly failed when the WASIX AOT/tools artifact root was absent, and the
  same publish passed after adding the WASIX artifact root, producing a local
  Cargo index with 219 packages from release-shaped native runtime/tools
  assets plus WASIX artifact crates.
- 2026-06-28: Ported local-registry npm release-asset package staging into
  `tools/release/local-registry-publish.mjs`. Bun now stages native
  liboliphaunt runtime packages, split `oliphaunt-tools` packages, native ICU,
  and broker helper packages from release assets, validates runtime/tool payload
  membership through the shared native optimizer policy, prefers generated
  tarballs over stale artifact roots, and keeps npm release-asset staging on
  the same Bun publish path as extension package synthesis.
- 2026-06-28: Ported local-registry native extension npm package synthesis into
  `tools/release/local-registry-publish.mjs`. Bun now generates the
  `@oliphaunt/extension-*` meta package, host target selector, and split
  payload packages from `extension-artifacts.json` plus release manifests,
  recursively splits payload packages below the 10 MiB npm limit, and removes
  npm extension roots from the Python publish fallback. Fresh PostGIS evidence:
  a strict local-registry npm publish generated and published
  `@oliphaunt/extension-postgis`, the Linux x64 target selector, and two
  payload packages at 6.27 MiB and 3.95 MiB; a scratch npm consumer installed
  the meta package from Verdaccio and resolved both payload packages with
  `postgis-3.so`, extension SQL/control files, and PROJ data present.
- 2026-06-28: Ported local-registry native extension Cargo package synthesis into
  `tools/release/local-registry-publish.mjs`. Bun now generates exact native
  extension Cargo crates from `extension-artifacts.json` plus release manifests,
  strips Linux extension modules when `strip` is available, splits payloads into
  7 MiB part crates once a package crosses the 9 MiB split threshold, and uses
  a small aggregator crate to reconstruct payload manifests. The local-registry
  publish command no longer dispatches any surface to Python, and the retired
  `local_registry_publish.py` entrypoint was removed after the remaining
  consumer-shape references moved to the Bun entrypoint.
- 2026-06-27: Ported the WASIX Cargo artifact packager from
  `tools/release/package_liboliphaunt_wasix_cargo_artifacts.py` to the Bun
  entrypoint `tools/release/package_liboliphaunt_wasix_cargo_artifacts.mjs`.
  The generated package graph keeps root runtime crates to core runtime assets,
  publishes `pg_dump` and `psql` through `oliphaunt-wasix-tools` and
  `oliphaunt-wasix-tools-aot-*`, and continues to split only oversized internal
  extension AOT payloads. Fresh smoke packaging from local release assets
  produced 210 WASIX crate files with 0 crates over 10 MiB; the root
  `liboliphaunt-wasix-portable` crate was 9,076,774 bytes, the
  `oliphaunt-wasix-tools` crate was 1,206,842 bytes, and the largest crate was
  the PostGIS WASIX AOT part crate at 10,212,312 bytes. A native linux-x64
  package smoke produced separate runtime part crates and an
  `oliphaunt-tools-linux-x64-gnu` part crate, with 0 crates over 10 MiB. Direct
  payload inspection showed native root packages contain `initdb`, `pg_ctl`,
  and `postgres`, native tools contain `pg_dump` and `psql`, WASIX root contains
  `initdb.wasix.wasm` with no split tool manifest entries, and WASIX tools
  contain `pg_dump.wasix.wasm` and `psql.wasix.wasm`. Fresh checks passed:
  `node --check` and `--help` for both Cargo packagers, Python `py_compile` for
  touched release validators, `check_artifact_targets.py`,
  `check_release_metadata.py`, and focused `check_consumer_shape.py` for
  `liboliphaunt-wasix` and `liboliphaunt-native`.
- 2026-06-27: Ported the shared SDK package artifact builder from
  `tools/release/build-sdk-ci-artifacts.sh` to the Bun entrypoint
  `tools/release/build-sdk-ci-artifacts.mjs`. Moon package-artifact tasks for
  Rust, Swift, Kotlin, TypeScript, React Native, and WASIX Rust now call the
  pinned Bun launcher directly; policy checks still require package-shape
  outputs, staged SDK artifact validation, Kotlin Maven repository staging,
  Swift release-manifest rendering, TypeScript JSR source staging, and WASIX
  Rust registry-shaped crate packaging. Fresh checks passed:
  `tools/dev/bun.sh tools/release/build-sdk-ci-artifacts.mjs --help`,
  `node --check tools/release/build-sdk-ci-artifacts.mjs`,
  `tools/dev/bun.sh tools/release/build-sdk-ci-artifacts.mjs
  oliphaunt-wasix-rust`, `tools/dev/bun.sh
  tools/policy/check-moon-product-graph.mjs`, `tools/dev/bun.sh
  tools/policy/assertions/assert-ci-workflows.mjs`, `bash
  tools/policy/check-sdk-parity.sh`, `bash tools/policy/check-tooling-stack.sh`,
  `python3 -m py_compile tools/release/check_artifact_targets.py
  tools/release/check_release_metadata.py`, `python3
  tools/release/check_artifact_targets.py`, and `python3
  tools/release/check_release_metadata.py`. Follow-up aggregate gates also
  passed: `tools/release/release.py check`, `bash tools/policy/check-docs.sh`,
  `tools/dev/bun.sh tools/policy/check-python-entrypoints.mjs --json`, `git
  diff --check`, and a source-tree scan for stray `__pycache__` or `.pyc`
  files.
- 2026-06-27: Removed the obsolete `release.py ci-products` and
  `release.py ci-artifacts` compatibility commands after the release workflow
  and CI assertions moved to direct Bun `release_graph_query.mjs` calls. The
  release CLI no longer carries the CI artifact-name helper adapters, and
  `check_release_metadata.py` now rejects reintroducing those subcommands.
  Fresh checks passed: `rg` proving no active `release.py ci-*` command surface
  remains outside historical notes, direct Bun `ci-products` and
  `ci-artifact-names` smokes for SDK products, native release assets,
  Node-direct npm packages, and broker release assets, `python3 -m py_compile`
  for touched release helpers, and `check_release_metadata.py`.
- 2026-06-27: Deleted the unused `tools/release/product_metadata.py`
  compatibility module now that executable release consumers query
  `release_graph_query.mjs` directly. `check_release_metadata.py` now fails if
  the compatibility file reappears and keeps the direct Bun graph/query guards
  for product configs, versions, artifact targets, registry packages, expected
  assets, extension metadata, WASIX package names, and local-publish presets.
  The Python tooling inventory dropped from 9 to 8 tracked files. Fresh checks
  passed: `rg` proving no executable `import product_metadata` or
  `product_metadata.*` calls remain, `tools/dev/bun.sh
  tools/policy/check-python-entrypoints.mjs --json`, `python3 -m py_compile`
  for touched Python release/policy helpers, `check_release_metadata.py`, and
  direct Bun `release_graph_query.mjs ci-products --family sdk-package`.
- 2026-06-27: Removed stale `tools/release/product_metadata.py` Moon task
  inputs from Node-direct `check`/`release-assets` and native
  `release-assets` tasks after those paths moved to Bun release graph queries.
  This was the temporary state before the compatibility file was deleted.
  Fresh checks passed: `rg product_metadata.py` over the touched Moon files and
  inventory, `tools/dev/bun.sh tools/policy/check-python-entrypoints.mjs
  --json`, `tools/dev/bun.sh
  tools/policy/check-moon-product-graph.mjs`, and `bash
  tools/policy/check-policy-tools.sh`.
- 2026-06-27: Removed `release.py`'s import of the Python
  `product_metadata.py` compatibility module. The release orchestrator now
  reads product configs, current versions, publish-step target coverage,
  artifact targets, registry package names, expected release assets, CI
  artifact names, SDK package products, extension metadata/targets, and the
  WASIX Cargo artifact contract through cached local wrappers over
  `release_graph_query.mjs`. `check_release_metadata.py` now rejects
  reintroducing the compatibility import in `release.py`, and
  `check-release-policy.py` now requires staged WASIX asset validation to use
  `expected_assets(...)` from the release graph adapter. Fresh checks passed:
  grep proving `release.py` has no `import product_metadata` or
  `product_metadata.*` calls, `python3 -m py_compile` for the touched Python
  helpers, `release.py ci-products --family sdk-package`, `release.py
  ci-artifacts` smokes for `liboliphaunt-native` release assets,
  `oliphaunt-node-direct` npm packages, `oliphaunt-rust` SDK packages, and
  `oliphaunt-broker` release assets, clean adapter failure reporting for an
  invalid npm-package query, `check_release_metadata.py`,
  `check-release-policy.py`, `tools/dev/bun.sh
  tools/policy/check-python-entrypoints.mjs --json`, and full
  `tools/release/release.py check`. The Python entrypoint inventory remained at
  9 entries before the follow-up deletion of `product_metadata.py`.
- 2026-06-27: Removed `check_release_metadata.py`'s import of the Python
  `product_metadata.py` compatibility module. The release metadata checker now
  reads product configs, version files, current versions, artifact targets,
  publish-step target coverage, exact-extension metadata/targets, TypeScript
  optional runtime package versions, and WASIX Cargo artifact contract data
  through cached local wrappers over `release_graph_query.mjs`. The checker
  now self-guards against reintroducing a direct `import product_metadata`, and
  the Python entrypoint inventory rationale now records that this remaining
  Python entrypoint consumes Bun release graph rows rather than the Python
  compatibility API. Fresh checks passed: `python3 -m py_compile` for
  `check_release_metadata.py`, AST smoke proving no `product_metadata` import
  or executable attribute calls remain, direct helper smoke for
  `liboliphaunt-wasix` product/version/WASIX package metadata and native
  artifact targets, `tools/dev/bun.sh
  tools/policy/check-python-entrypoints.mjs --json`, full `python3
  tools/release/check_release_metadata.py`, `bash
  tools/policy/check-policy-tools.sh`, `bash
  tools/policy/check-tooling-stack.sh`, `bash tools/policy/check-docs.sh`, and
  `tools/release/release.py check`.
- 2026-06-27: Removed `package_liboliphaunt_wasix_cargo_artifacts.py`'s
  import of the Python `product_metadata.py` compatibility module. The WASIX
  Cargo artifact packager now reads the portable runtime/tools/ICU/AOT
  contract, bulk WASIX extension package names, and the
  `liboliphaunt-wasix` version through cached Bun
  `release_graph_query.mjs` calls. `check_release_metadata.py`,
  `check_consumer_shape.py`, and the consumer-shape fixture now reject
  reintroducing the Python adapter path and require the Bun
  `wasix-cargo-artifact-contract`, `wasix-extension-package-names`, and
  `product-versions` queries. Fresh checks passed: grep proving the WASIX
  packager no longer imports or calls `product_metadata`, `python3 -m
  py_compile` for touched Python helpers, direct packager module smoke for
  runtime/tools/ICU/AOT package names and split tool lists, Bun
  `wasix-cargo-artifact-contract` and single-extension
  `wasix-extension-package-names` query smokes, focused
  `check_consumer_shape.py --product liboliphaunt-wasix` and
  `--product liboliphaunt-native`, `check_release_metadata.py`, strict local
  Cargo registry dry-run, `bash tools/policy/check-policy-tools.sh`, `bash
  tools/policy/check-tooling-stack.sh`, `bash tools/policy/check-docs.sh`,
  full WASIX Cargo packager smoke into
  `target/oliphaunt-wasix/cargo-artifacts-smoke`, and
  `tools/release/release.py check`. The packager smoke generated zero crates
  over the 10 MiB crates.io cap; the largest crate was
  `oliphaunt-extension-postgis-wasix-aot-aarch64-unknown-linux-gnu-part-001`
  at 10,212,312 bytes, leaving 273,448 bytes of headroom. The split tools
  crates stayed small: `oliphaunt-wasix-tools` was 1,206,842 bytes and the
  largest `oliphaunt-wasix-tools-aot-*` crate was 1,804,340 bytes.
- 2026-06-27: Removed `local_registry_publish.py`'s import of the Python
  `product_metadata.py` compatibility module. The local registry publisher now
  reads the local-publish artifact preset and native runtime/tools release
  asset target names through cached wrappers over `release_graph_query.mjs`.
  `check_release_metadata.py` rejects reintroducing the import and requires the
  local registry publisher to use the shared Bun `local-publish-artifacts` and
  `artifact-targets` queries. Fresh checks passed: `python3 -m py_compile` for
  touched Python helpers, direct module smoke for `local_publish_artifacts`,
  `local_publish_aggregate_artifacts`, and Linux x64 native runtime/tools asset
  name resolution, `tools/release/local_registry_publish.py download --preset
  local-publish --dry-run` against GitHub Actions run `28049923289`,
  `tools/release/local_registry_publish.py publish --surface cargo --strict
  --dry-run`, `tools/release/local_registry_publish.py publish --surface npm
  --strict --dry-run`, `python3 tools/release/check_release_metadata.py`, and a
  grep proving `local_registry_publish.py` no longer imports or calls
  `product_metadata`, `bash tools/policy/check-policy-tools.sh`, `bash
  tools/policy/check-tooling-stack.sh`, `bash tools/policy/check-docs.sh`,
  `tools/release/release.py check`, and `git diff --check`.
  The Python entrypoint inventory still reports 9 entrypoints because this
  slice removes one compatibility import rather than deleting an entrypoint. A
  subagent review was attempted for this slice, but the current session remained
  at the agent thread limit, so the pass used local repository evidence.
- 2026-06-27: Removed `check-extension-model.py`'s import of the Python
  `product_metadata.py` compatibility module. The extension model checker now
  validates exact-extension release metadata shape directly from the canonical
  Bun `release_graph_query.mjs extension-metadata` rows, preserving the
  existing source-identity contract while avoiding the Python adapter. The
  extension model, native extension artifact, and WASIX extension artifact Moon
  check tasks now include `release_graph_query.mjs`,
  `release-artifact-targets.mjs`, and `release-graph.mjs` as cache inputs so
  release metadata changes invalidate the extension checker correctly.
  `check_release_metadata.py` rejects reintroducing the import and guards those
  Moon inputs. Fresh checks passed: `python3 -m py_compile` for touched Python
  helpers, timed `python3 src/extensions/tools/check-extension-model.py
  --check` at 2.39s, `tools/dev/bun.sh
  tools/policy/assertions/assert-source-inputs.mjs extensions`, `python3
  tools/release/check_release_metadata.py`, `bash
  tools/policy/check-policy-tools.sh`, `bash
  tools/policy/check-tooling-stack.sh`, `bash tools/policy/check-docs.sh`,
  `tools/release/release.py check`, `tools/dev/bun.sh
  tools/policy/check-python-entrypoints.mjs --json`, and `git diff --check`.
  The Python entrypoint inventory still reports 9 entrypoints because this
  slice removes one compatibility import rather than deleting an entrypoint. A
  subagent review was attempted for this slice, but the current session remained
  at the agent thread limit, so the pass used local repository evidence.
- 2026-06-27: Removed `check_consumer_shape.py`'s import of the Python
  `product_metadata.py` compatibility module. The consumer-shape checker now
  reads product configs, product versions, artifact targets, extension targets,
  expected assets, TypeScript optional runtime package versions, and the WASIX
  Cargo artifact contract through cached local wrappers over
  `release_graph_query.mjs`. `release_graph_query.mjs
  wasix-extension-package-names` now supports a bulk all-extension mode so the
  exact-extension consumer-shape pass keeps Bun as the package-name authority
  without spawning one process per extension target; the single-product
  `--product/--target` mode remains available. `check_release_metadata.py`
  rejects reintroducing the `product_metadata.py` import in
  `check_consumer_shape.py` and requires the bulk WASIX extension package-name
  query path. Fresh checks passed: bulk and single-product
  `wasix-extension-package-names` query smoke, `python3 -m py_compile` for
  touched Python helpers, timed full `python3
  tools/release/check_consumer_shape.py` at 8.58s, `python3
  tools/release/check_release_metadata.py`, `python3
  tools/release/check_artifact_targets.py`, `python3
  tools/policy/check-release-policy.py`, `bash
  tools/policy/check-policy-tools.sh`, `bash
  tools/policy/check-tooling-stack.sh`, `bash tools/policy/check-docs.sh`,
  `tools/release/release.py check`, `git diff --check`, and
  `tools/dev/bun.sh tools/policy/check-python-entrypoints.mjs --json`. The
  Python entrypoint inventory still reports 9 entrypoints because this slice
  removes one compatibility import rather than deleting an entrypoint. A
  subagent review was attempted for this slice, but the current session remained
  at the agent thread limit, so the pass used local repository evidence.
- 2026-06-27: Re-ran the Linux-local release/local-registry validation batch
  after the latest tooling migrations. Fresh checks passed:
  `tools/release/local_registry_publish.py publish --surface cargo --strict`,
  `tools/release/local_registry_publish.py publish --surface npm --strict`,
  `tools/release/local_registry_publish.py publish --surface maven --strict`,
  `tools/release/local_registry_publish.py publish --surface swift --strict`,
  `tools/release/release.py check`, and
  `act workflow_dispatch -W .github/workflows/ci.yml -j release-intent
  --dryrun -P ubuntu-latest=ghcr.io/catthehacker/ubuntu:act-latest`. Cargo
  strict publish generated/staged 500 local `.crate` files with none over the
  10 MiB crates.io limit; the largest observed local crate was
  10,212,312 bytes. Maven strict publish staged 14 files from
  `oliphaunt-kotlin-sdk-package-artifacts/maven` into
  `target/local-registries/maven`. Swift strict staging found copyable SwiftPM
  artifacts and staged `Oliphaunt-source.zip` plus `OliphauntICU.swift`, while
  recording that the Linux host does not have `swift` installed. `release.py
  check` passed release policy, release-please config, artifact targets,
  release PR derived-file sync, release metadata, and ready consumer-shape
  checks across all products. The `act` release-intent dry run selected and
  completed the PR-shaped Linux job; current upstream `nektos/act` issue
  evidence still shows `actions/upload-artifact@v7` `mime_type` incompatibility,
  so artifact-dependent downstream CI jobs remain not fully provable with local
  `act` on this host.
- 2026-06-27: Removed the final `tools/release/release.py plan` compatibility
  command. Release planning now uses only `tools/dev/bun.sh
  tools/release/release_plan.mjs`; `check_release_metadata.py` rejects
  reintroducing the Python planner command surface in `release.py` or in release
  PR coverage checks. Fresh checks passed: `tools/dev/bun.sh
  tools/release/release_plan.mjs --format json`, `python3 -m py_compile
  tools/release/release.py tools/release/check_release_metadata.py`, `python3
  tools/release/check_release_metadata.py`, `python3
  tools/policy/check-release-policy.py`, `bash tools/policy/check-docs.sh`,
  `tools/release/release.py check`, `tools/dev/bun.sh
  tools/policy/check-python-entrypoints.mjs --json`, `git diff --check`, and a
  source-tree scan for stray `__pycache__` or `.pyc` files. The Python
  entrypoint inventory now reports 8 entries; `release.py` is 3,766 lines and
  152,680 bytes.
- 2026-06-27: Switched `check_release_pr_coverage.mjs` from the Python
  `release.py plan` compatibility wrapper to the Bun
  `tools/release/release_plan.mjs` entrypoint. The release PR coverage checker
  remains a Bun checker end to end: it now reads release-please manifest diffs
  and Moon-selected release products from the same canonical Bun planner used
  by the release workflow and release-intent check. `check_release_metadata.py`
  now rejects
  reintroducing the Python planner wrapper in the release PR coverage checker.
  Fresh checks passed: `tools/dev/bun.sh
  tools/release/check_release_pr_coverage.mjs`, direct parity diff at the time between
  `tools/dev/bun.sh tools/release/release_plan.mjs --base-ref origin/main
  --head-ref HEAD --format json` and the then-existing `tools/release/release.py
  plan --base-ref origin/main --head-ref HEAD --format json`, active-file grep proving
  `check_release_pr_coverage.mjs` no longer calls `release.py`, `python3 -m
  py_compile tools/release/check_release_metadata.py`, `python3
  tools/release/check_release_metadata.py`, `tools/release/release.py check`,
  `bash tools/policy/check-policy-tools.sh`, `bash
  tools/policy/check-tooling-stack.sh`, and `tools/dev/bun.sh
  tools/policy/check-python-entrypoints.mjs --json`. The Python entrypoint
  inventory still reports 9 Python entrypoints; `check_release_metadata.py` is
  now 1,830 lines and 95,010 bytes. A subagent review was attempted for this
  slice, but the current session remained at the agent thread limit, so this
  pass used local repository evidence.
- 2026-06-27: Switched release workflow CI artifact handoffs from the Python
  `release.py ci-products` and `release.py ci-artifacts` compatibility
  commands to direct Bun release graph queries. `release_graph_query.mjs` now
  exposes `ci-products --family sdk-package --format lines` for selected SDK
  release products and supports `ci-artifact-names --family sdk-package
  --format lines` alongside the existing release-asset and npm-package artifact
  families. The release workflow now downloads SDK, native helper, and Node
  direct optional npm artifacts through those Bun queries; workflow assertions
  and release policy reject reintroducing the Python CI artifact handoff in the
  active release workflow. Fresh checks passed: Bun/Python parity diffs for
  selected SDK products, SDK package artifacts, broker release assets, and Node
  direct npm package artifacts; `tools/dev/bun.sh
  tools/release/release_graph_query.mjs ci-products --family sdk-package
  --format json`; `python3 -m py_compile tools/release/check_artifact_targets.py
  tools/release/check_release_metadata.py tools/policy/check-release-policy.py`;
  active-surface grep proving no `release.py ci-*` calls remain outside
  historical notes; `tools/dev/bun.sh
  tools/policy/assertions/assert-ci-workflows.mjs`; `python3
  tools/release/check_artifact_targets.py`; `python3
  tools/release/check_release_metadata.py`; `python3
  tools/policy/check-release-policy.py`; `bash tools/policy/check-workflows.sh`;
  `bash tools/policy/check-policy-tools.sh`; `tools/release/release.py check`;
  `tools/dev/bun.sh tools/policy/check-python-entrypoints.mjs --json`; `bash
  tools/policy/check-tooling-stack.sh`; and `bash tools/policy/check-docs.sh`.
  The Python entrypoint inventory still reports 9 Python entrypoints;
  `check-release-policy.py` is now 1,540 lines and 65,797 bytes,
  `check_artifact_targets.py` is 1,437 lines and 72,427 bytes, and
  `check_release_metadata.py` is 1,823 lines and 94,610 bytes. A subagent
  review was attempted for this slice, but the current session remained at the
  agent thread limit, so this pass used local repository evidence.
- 2026-06-27: Switched active release-planning callers from the Python
  `release.py plan` compatibility wrapper to the Bun
  `tools/release/release_plan.mjs` entrypoint. The release workflow,
  release-intent checker, CI summary action, maintainer release docs, and
  architecture release-model docs now point at the Bun planner. At the time,
  `release.py plan` remained as a compatibility shim that delegated to the same
  script; a later follow-up removed that command. `assert-ci-workflows.mjs` now
  rejects the Python planner wrapper in
  active workflow surfaces and requires the Bun planner command. Fresh checks
  passed: `bash -n .github/scripts/check-release-intent.sh`, `python3 -m
  py_compile tools/policy/check-release-policy.py`, `tools/dev/bun.sh
  tools/release/release_plan.mjs --format json`, then-existing
  `tools/release/release.py plan --format json`, direct JSON parity diff between
  those two planners,
  `tools/dev/bun.sh tools/policy/assertions/assert-ci-workflows.mjs`, `python3
  tools/policy/check-release-policy.py`, `python3
  tools/release/check_release_metadata.py`, `bash tools/policy/check-docs.sh`,
  `bash tools/policy/check-policy-tools.sh`, `bash
  tools/policy/check-workflows.sh`, `tools/release/release.py check`, `bash
  tools/policy/check-tooling-stack.sh`, `tools/dev/bun.sh
  tools/policy/check-python-entrypoints.mjs --json`, active-surface grep for
  the Python planner wrapper, and `git diff --check`. The Python entrypoint
  inventory still reports 9 Python entrypoints; `check-release-policy.py` is
  now 1,534 lines and 65,303 bytes. A subagent review was attempted for this
  slice, but the current session remained at the agent thread limit, so this
  pass used local repository evidence.
- 2026-06-27: Removed stale Python command requirements from
  `package-liboliphaunt-linux-assets.sh` and
  `package-liboliphaunt-mobile-assets.sh`; these release asset packagers now
  declare only the commands they still use after product versioning, native
  stripping, optimization, and archive creation moved to Bun helpers. The
  tooling-stack policy now rejects reintroducing that stale Python requirement
  in those Bun-backed packagers. Fresh checks passed: `bash -n
  tools/release/package-liboliphaunt-linux-assets.sh
  tools/release/package-liboliphaunt-mobile-assets.sh
  tools/policy/check-tooling-stack.sh`, broad `git grep` for the stale
  requirement string, `bash tools/policy/check-tooling-stack.sh`,
  `tools/dev/bun.sh tools/policy/check-python-entrypoints.mjs --json`,
  `python3 tools/release/check_consumer_shape.py`, `python3
  tools/release/check_release_metadata.py`, `bash
  tools/policy/check-policy-tools.sh`, and `git diff --check`. The Python
  entrypoint inventory still reports 9 Python entrypoints.
- 2026-06-27: Removed the direct full release-graph handoff from
  `check_release_metadata.py`. The validator no longer defines a local
  `load_graph()` wrapper, no longer passes a graph object into product config,
  extension metadata, exact-extension registry shape, publish-target coverage,
  or version collection checks, and now relies on the existing Bun-query-backed
  `product_metadata` adapters directly. The release metadata guard also checks
  that neither `check_release_metadata.py` nor `check_artifact_targets.py`
  reintroduce direct full graph calls for the artifact-target path. A subagent
  review was attempted again for this slice, but the current session remained
  at the agent thread limit, so this pass used local repository evidence. Fresh
  checks passed: `python3 -m py_compile
  tools/release/check_release_metadata.py`, `python3
  tools/release/check_release_metadata.py`, `python3
  tools/release/check_artifact_targets.py`, `python3
  tools/release/check_consumer_shape.py`, `tools/release/release.py check`,
  `bash tools/policy/check-tooling-stack.sh`, `bash
  tools/policy/check-policy-tools.sh`, `bash tools/policy/check-docs.sh`,
  `tools/dev/bun.sh tools/policy/check-python-entrypoints.mjs --json`, and
  `tools/release/local_registry_publish.py download --preset local-publish
  --dry-run`. The Python entrypoint inventory still reports 9 Python
  entrypoints; `check_release_metadata.py` is now 1,822 lines and 94,537 bytes.
- 2026-06-27: Removed direct full release-graph reads from
  `check_artifact_targets.py`. `release_graph_query.mjs` now exposes
  `legacy-central-artifact-targets`, which validates and returns the deprecated
  top-level `artifact_targets` rows from the Bun graph, and
  `product_metadata.legacy_central_artifact_target_rows()` adapts that query for
  the Python compatibility layer. `check_artifact_targets.py` now uses
  `product_metadata.raw_artifact_target_tables()` without a graph argument,
  preserves the legacy "no central artifact_targets" guard through the new
  adapter, and no longer calls `product_metadata.load_graph()`. The metadata
  guard now rejects reintroducing direct `product_metadata.load_graph()` calls in
  artifact-target checks. A subagent review was attempted for this slice, but
  the current session was at the agent thread limit, so this pass used local
  repository evidence. Fresh checks passed: `tools/dev/bun.sh
  tools/release/release_graph_query.mjs legacy-central-artifact-targets`,
  Python adapter smoke for
  `product_metadata.legacy_central_artifact_target_rows`, `python3 -m
  py_compile` for touched Python helpers, `python3
  tools/release/check_artifact_targets.py`, `python3
  tools/release/check_release_metadata.py`, `python3
  tools/release/check_consumer_shape.py`, `tools/release/release.py check`,
  `bash tools/policy/check-tooling-stack.sh`, `bash
  tools/policy/check-policy-tools.sh`, `bash tools/policy/check-docs.sh`,
  `tools/dev/bun.sh tools/policy/check-python-entrypoints.mjs --json`,
  `tools/release/local_registry_publish.py download --preset local-publish
  --dry-run`, and `git diff --check`. The Python entrypoint inventory still
  reports 9 Python entrypoints; `check_artifact_targets.py` is now 1,437 lines
  and 72,232 bytes, `check_release_metadata.py` is 1,824 lines and 94,495
  bytes, `product_metadata.py` is 914 lines and 35,400 bytes, and
  `release_graph_query.mjs` is 743 lines and 21,931 bytes.
- 2026-06-27: Moved release policy's Moon project ownership checks onto
  normalized Bun graph rows. `release-graph.mjs` now carries Moon project
  `layer` and exposes `moonProjectRows`, `release_graph_query.mjs
  moon-projects [--project PROJECT]` returns normalized project rows with tags,
  dependency scopes, release metadata, and layer, and
  `check-release-policy.py` now consumes that query plus
  `product_metadata.graph_products` instead of parsing `graph.products` or
  invoking `moon query projects` directly. The check still verifies release
  product tags, Moon release metadata, exact-extension `library` layer, and
  production dependencies on `extension-runtime-contract`, `liboliphaunt-native`,
  and `liboliphaunt-wasix`. `check_release_metadata.py` now rejects
  reintroducing Python-side Moon project traversal in the policy check. Fresh
  checks passed: `tools/dev/bun.sh tools/release/release_graph_query.mjs
  moon-projects --project oliphaunt-extension-unaccent`, `python3 -m
  py_compile` for touched Python helpers, `python3
  tools/policy/check-release-policy.py`, `python3
  tools/release/check_release_metadata.py`, `python3
  tools/release/check_artifact_targets.py`, `python3
  tools/release/check_consumer_shape.py`, `tools/release/release.py check`,
  `bash tools/policy/check-tooling-stack.sh`, `bash
  tools/policy/check-policy-tools.sh`, `bash tools/policy/check-docs.sh`,
  `tools/dev/bun.sh tools/policy/check-python-entrypoints.mjs --json`, and
  `tools/release/local_registry_publish.py download --preset local-publish
  --dry-run`. The Python entrypoint inventory still reports 9 Python
  entrypoints; `check-release-policy.py` is now 1,531 lines and 65,003 bytes,
  `check_release_metadata.py` is 1,817 lines and 94,042 bytes,
  `release_graph_query.mjs` is 726 lines and 21,293 bytes, and
  `release-graph.mjs` is 869 lines and 31,967 bytes.
- 2026-06-27: Moved Moon release metadata reads behind the Bun release graph
  query. `release-graph.mjs` now exposes `moonReleaseMetadataRows`,
  `release_graph_query.mjs moon-release-metadata [--product PRODUCT]` returns
  normalized Moon release metadata rows, and
  `product_metadata.moon_release_metadata` now validates and adapts that query
  instead of walking `load_graph().moon_projects` directly. This keeps
  `check_artifact_targets.py` using the compatibility API while removing one
  more raw graph shape dependency from Python. `check_release_metadata.py` now
  guards against reintroducing Python-side `moon_projects` traversal. Fresh
  checks passed: `tools/dev/bun.sh tools/release/release_graph_query.mjs
  moon-release-metadata --product liboliphaunt-wasix`, Python smoke checks for
  the four runtime products' `component`, `packagePath`, and `artifactTargets`
  presets, `python3 -m py_compile` for touched Python helpers, `python3
  tools/release/check_release_metadata.py`, `python3
  tools/release/check_artifact_targets.py`, `python3
  tools/release/check_consumer_shape.py`, `tools/release/release.py check`,
  `bash tools/policy/check-tooling-stack.sh`, `bash
  tools/policy/check-policy-tools.sh`, `bash tools/policy/check-docs.sh`,
  `tools/dev/bun.sh tools/policy/check-python-entrypoints.mjs --json`, and
  `tools/release/local_registry_publish.py download --preset local-publish
  --dry-run`. The Python entrypoint inventory still reports 9 Python
  entrypoints; `product_metadata.py` is now 910 lines and 35,253 bytes,
  `check_release_metadata.py` is 1,807 lines and 93,465 bytes,
  `release_graph_query.mjs` is 700 lines and 20,535 bytes, and
  `release-graph.mjs` is 846 lines and 31,063 bytes.
- 2026-06-27: Moved basic release product config reads behind the Bun release
  graph query. `release-graph.mjs` now exposes `productConfigRows`,
  `release_graph_query.mjs product-configs [--product PRODUCT]` returns
  normalized product rows, and `product_metadata.graph_products`,
  `product_metadata.product_config`, `product_metadata.product_ids`,
  `version_files`, `derived_version_files`, `changelog_path`, and `tag_prefix`
  now validate and adapt that query instead of inspecting `graph.products`
  directly. The adapter preserves the legacy empty-list default for optional
  `registry_packages`, which keeps products such as `oliphaunt-swift`
  compatible while still validating present values. `check_release_metadata.py`
  now guards against reintroducing Python-side product config parsing. Fresh
  checks passed: `tools/dev/bun.sh tools/release/release_graph_query.mjs
  product-configs --product liboliphaunt-wasix`, Python smoke checks for
  `product_metadata.product_ids`, `package_path`, `tag_prefix`,
  `product_config`, and `version_files`, `python3 -m py_compile` for touched
  Python helpers, `python3 tools/release/check_release_metadata.py`, `python3
  tools/release/check_consumer_shape.py`, `python3
  tools/release/check_artifact_targets.py`, `tools/release/release.py check`,
  `bash tools/policy/check-tooling-stack.sh`, `bash
  tools/policy/check-policy-tools.sh`, `bash tools/policy/check-docs.sh`,
  `tools/dev/bun.sh tools/policy/check-python-entrypoints.mjs --json`, and
  `tools/release/local_registry_publish.py download --preset local-publish
  --dry-run`. The Python entrypoint inventory still reports 9 Python
  entrypoints; `product_metadata.py` is now 890 lines and 34,330 bytes,
  `check_release_metadata.py` is 1,798 lines and 92,888 bytes,
  `release_graph_query.mjs` is 674 lines and 19,731 bytes, and
  `release-graph.mjs` is 822 lines and 30,022 bytes.
- 2026-06-27: Centralized WASIX extension Cargo package naming behind the Bun
  WASIX artifact contract. `release_graph_query.mjs
  wasix-extension-package-names --product PRODUCT [--target TARGET...]` now
  adapts `wasixExtensionPackageName(product)` and
  `wasixExtensionAotPackageName(product, target)` from
  `wasix-cargo-artifact-contract.mjs`; `product_metadata.py` only validates and
  adapts that shared query, and the WASIX Cargo artifact packager now consumes
  `product_metadata.wasix_extension_package_name` and
  `product_metadata.wasix_extension_aot_package_name` instead of carrying local
  duplicate string builders. `check_release_metadata.py` now guards against
  reintroducing Python-side WASIX extension naming. Fresh generated-crate probes
  confirmed the split tool contract: native root runtime parts contain
  `postgres`, `initdb`, and `pg_ctl` with no `pg_dump`/`psql`; native
  `oliphaunt-tools-*` parts contain `pg_dump` and `psql`; the WASIX root archive
  contains `oliphaunt/bin/postgres` and `oliphaunt/bin/initdb` with no
  `pg_ctl`/`pg_dump`/`psql`; `oliphaunt-wasix-tools` contains
  `pg_dump.wasix.wasm` and `psql.wasix.wasm` with no `pg_ctl`; and tools AOT
  crates carry `pg_dump`/`psql` AOT artifacts separately. Strict local Cargo
  publishing generated 675 crate files across `target/local-registries/cargo`
  and `target/local-registries/cargo-generated` with 0 crates over the 10 MiB
  limit; the largest crates are the PostGIS WASIX AOT part crates at about
  9.74 MiB. Fresh checks passed: `tools/dev/bun.sh
  tools/release/release_graph_query.mjs wasix-extension-package-names --product
  oliphaunt-extension-unaccent --target x86_64-unknown-linux-gnu`, Python smoke
  checks for `product_metadata.wasix_extension_package_name` and
  `product_metadata.wasix_extension_aot_package_name`, `python3 -m py_compile`
  for touched Python helpers, `python3 tools/release/check_release_metadata.py`,
  `python3 tools/release/check_consumer_shape.py`, `python3
  tools/release/check_artifact_targets.py`, `tools/release/local_registry_publish.py
  publish --surface cargo --strict`, `tools/release/release.py check`, `bash
  tools/policy/check-tooling-stack.sh`, `bash tools/policy/check-policy-tools.sh`,
  `tools/dev/bun.sh tools/policy/check-python-entrypoints.mjs --json`, and
  `tools/release/local_registry_publish.py download --preset local-publish
  --dry-run`. A subagent review was not used for this slice; local generated
  artifacts and repository guards provided the evidence. The Python entrypoint
  inventory still reports 9 Python entrypoints; `product_metadata.py` is now 854
  lines and 32,583 bytes, `package_liboliphaunt_wasix_cargo_artifacts.py` is
  1,403 lines and 53,890 bytes, `check_release_metadata.py` is 1,788 lines and
  92,240 bytes, and `release_graph_query.mjs` is 648 lines and 18,961 bytes.
- 2026-06-27: Removed the remaining duplicated exact-extension product selector
  comprehensions from Python release validators. `check_artifact_targets.py`,
  `check_consumer_shape.py`, and `check-release-policy.py` now use
  `product_metadata.extension_product_ids()`, which is backed by the Bun
  `extension-metadata` query, while retaining the per-product checks that verify
  each exact-extension config still declares `kind = "exact-extension-artifact"`.
  `check_release_metadata.py` now guards those validator call sites so exact
  extension product discovery stays centralized. A subagent review was attempted
  for this slice, but the current session is still at the agent thread limit, so
  this pass used local repository evidence. Fresh checks passed: Python
  `py_compile` for touched Python helpers, `python3
  tools/release/check_artifact_targets.py`, `python3
  tools/release/check_release_metadata.py`, `python3
  tools/release/check_consumer_shape.py`, `tools/release/release.py check`,
  `python3 src/extensions/tools/check-extension-model.py`, `bash
  tools/policy/check-tooling-stack.sh`, `bash tools/policy/check-policy-tools.sh`,
  `bash tools/policy/check-docs.sh`, and
  `tools/release/local_registry_publish.py download --preset local-publish
  --dry-run`. The Python entrypoint inventory still reports 9 Python entrypoints;
  `check_artifact_targets.py` is now 1,441 lines and 72,452 bytes,
  `check_consumer_shape.py` is 2,274 lines and 97,180 bytes,
  `check-release-policy.py` is 1,541 lines and 65,328 bytes, and
  `check_release_metadata.py` is 1,775 lines and 91,280 bytes.
- 2026-06-27: Moved extension product discovery in the Python compatibility
  layer onto the existing Bun `extension-metadata` query. `product_metadata.extension_product_ids`
  now validates and adapts the structured extension metadata rows instead of
  filtering raw product configs for `kind == "exact-extension-artifact"`.
  `check_release_metadata.py` now rejects reintroducing that Python-side product
  kind filter and asserts the query remains backed by `exactExtensionProducts`.
  Fresh checks passed: `tools/dev/bun.sh tools/release/release_graph_query.mjs
  extension-metadata`, Python smoke checks for `product_metadata.extension_product_ids`,
  `python3 -m py_compile` for touched Python helpers, `python3
  tools/release/check_release_metadata.py`, `python3
  tools/release/check_consumer_shape.py`, `python3
  src/extensions/tools/check-extension-model.py`, `tools/release/release.py
  check`, `bash tools/policy/check-tooling-stack.sh`, `bash
  tools/policy/check-policy-tools.sh`, `bash tools/policy/check-docs.sh`, and
  `tools/release/local_registry_publish.py download --preset local-publish
  --dry-run`. The Python entrypoint inventory still reports 9 Python entrypoints;
  `product_metadata.py` is now 831 lines and 31,107 bytes, while
  `check_release_metadata.py` is 1,769 lines and 90,735 bytes.
- 2026-06-27: Moved registry package-name selection out of the Python
  compatibility layer and into the Bun release graph. `release-artifact-targets.mjs`
  now exposes `registryPackageRows`, `release_graph_query.mjs registry-packages
  --product PRODUCT [--kind KIND]` returns parsed registry package rows, and
  `product_metadata.registry_package_names` now validates and adapts those rows
  for legacy release callers such as `release.py` Cargo/Maven publish helpers.
  The parser preserves Maven coordinates with embedded colons by splitting only
  the leading `kind:` prefix. `check_release_metadata.py` now rejects
  reintroducing Python-side `registry_packages` parsing. A subagent review was
  attempted again for this slice, but the current session is still at the agent
  thread limit, so this pass used local repository evidence. Fresh checks
  passed: `tools/dev/bun.sh tools/release/release_graph_query.mjs
  registry-packages --product liboliphaunt-native --kind crates`,
  `tools/dev/bun.sh tools/release/release_graph_query.mjs registry-packages
  --product oliphaunt-kotlin --kind maven`, Python smoke checks for
  `product_metadata.registry_package_names`, `python3 -m py_compile` for
  touched Python helpers, `python3 tools/release/check_release_metadata.py`,
  `python3 tools/release/check_consumer_shape.py`, `tools/release/release.py
  check`, `bash tools/policy/check-tooling-stack.sh`, `bash
  tools/policy/check-policy-tools.sh`, `bash tools/policy/check-docs.sh`, and
  `tools/release/local_registry_publish.py download --preset local-publish
  --dry-run`. The Python entrypoint inventory still reports 9 Python entrypoints;
  `product_metadata.py` is now 825 lines and 30,733 bytes, while
  `check_release_metadata.py` is 1,767 lines and 90,577 bytes.
- 2026-06-27: Moved expected GitHub release asset-name selection out of the
  Python compatibility layer and into the Bun release graph. `release-artifact-targets.mjs`
  now exposes `expectedAssetRows`, `release_graph_query.mjs expected-assets
  --product PRODUCT --version VERSION` returns structured expected asset rows,
  and `product_metadata.expected_assets` now validates and adapts those rows for
  legacy Python callers such as `release.py`, `check_consumer_shape.py`, and
  `check-release-policy.py`. `check_release_metadata.py` now rejects
  reintroducing the old Python-side `target.asset_name(version)` selector. A
  subagent review was attempted for this slice, but the current session is still
  at the agent thread limit, so this pass used local repository evidence.
  Fresh checks passed: `tools/dev/bun.sh tools/release/release_graph_query.mjs
  expected-assets --product liboliphaunt-wasix --version 0.1.0`,
  `tools/dev/bun.sh tools/release/release_graph_query.mjs expected-assets
  --product oliphaunt-broker --version 0.1.0 --kind broker-helper`, Python
  smoke checks for `product_metadata.expected_assets`, `python3 -m py_compile`
  for touched Python helpers, `python3 tools/release/check_release_metadata.py`,
  `python3 tools/release/check_consumer_shape.py`, `python3
  tools/release/check_artifact_targets.py`, `tools/release/release.py check`,
  `bash tools/policy/check-tooling-stack.sh`, `bash
  tools/policy/check-policy-tools.sh`, `bash tools/policy/check-docs.sh`,
  `tools/release/local_registry_publish.py download --preset local-publish
  --dry-run`, and JSON/diff checks for the new query. The Python entrypoint
  inventory still reports 9 Python entrypoints;
  `product_metadata.py` is now 812 lines and 30,090 bytes, while
  `check_release_metadata.py` is 1,758 lines and 89,961 bytes.
- 2026-06-27: Moved the local-registry CI artifact download preset into the Bun
  release graph. `release-artifact-targets.mjs` now exposes
  `localPublishArtifactRows`, `release_graph_query.mjs local-publish-artifacts
  [--aggregate-only]` returns the shared artifact rows, and
  `product_metadata.py`/`local_registry_publish.py` only validate and adapt
  those rows for legacy Python callers. The preset now reports 6 aggregate
  artifacts and 35 total local-publish artifacts from one graph-backed source.
  A dry-run against the configured GitHub Actions run passed with all 35
  artifacts present, including split native runtime, WASIX runtime/AOT,
  extension package, node-direct, and SDK package artifacts. Fresh checks
  passed: `tools/dev/bun.sh tools/release/release_graph_query.mjs
  local-publish-artifacts`, `tools/dev/bun.sh
  tools/release/release_graph_query.mjs local-publish-artifacts
  --aggregate-only`, Python smoke checks for `ci_local_publish_artifact_names`
  and `local_publish_artifacts`, `python3 -m py_compile` for touched Python
  helpers, `python3 tools/release/check_release_metadata.py`, `python3
  tools/release/check_consumer_shape.py`, `python3
  tools/release/check_artifact_targets.py`, `tools/release/release.py check`,
  `tools/release/local_registry_publish.py download --preset local-publish
  --dry-run`, `tools/release/local_registry_publish.py publish --surface cargo
  --strict`, and `tools/release/local_registry_publish.py publish --surface npm
  --strict`. The Python entrypoint inventory still reports 9 Python entrypoints;
  `local_registry_publish.py` dropped to 3,041 lines and 109,882 bytes while
  `product_metadata.py` remains a compatibility adapter at 780 lines and 28,569
  bytes. A fresh Cargo local-registry sweep covered 836 `.crate` files with
  `over_limit=0`; the largest crates remained split WASIX PostGIS AOT parts at
  10,212,312 bytes, below the 10,485,760-byte crates.io limit.
- 2026-06-27: Clarified the current root/tools split for registry-published
  artifacts and revalidated it from generated packages. The WASIX
  `liboliphaunt-wasix-portable`, `oliphaunt-wasix-tools`, root AOT, and
  tools-AOT manifests in the checkout are source templates, so they intentionally
  keep `publish = false` until release packaging injects payloads and strips the
  guard in the generated registry crates. The release dependency invariant and
  consumer-shape checks now name those as `SOURCE_TEMPLATE_*` manifests instead
  of implying the generated artifacts are private-only. Fresh checks passed:
  `python3 -m py_compile` for touched Python helpers, `python3
  tools/release/check_release_metadata.py`, `python3
  tools/release/check_consumer_shape.py`, `tools/dev/bun.sh
  tools/policy/check-wasix-release-dependency-invariants.mjs`, `python3
  tools/release/check_artifact_targets.py`, `tools/release/release.py check`,
  `bash tools/policy/check-tooling-stack.sh`, `bash
  tools/policy/check-policy-tools.sh`, `tools/dev/bun.sh
  tools/policy/check-python-entrypoints.mjs --json`,
  `tools/release/local_registry_publish.py publish --surface cargo --strict`,
  and `tools/release/local_registry_publish.py publish --surface npm --strict`.
  A fresh Cargo local-registry sweep covered 836 `.crate` files with
  `over_limit=0`; the largest crates were split WASIX PostGIS AOT parts at
  10,212,312 bytes, below the 10,485,760-byte crates.io limit. Generated native
  Cargo and npm package inspection found root runtime payloads carrying only
  `initdb`, `pg_ctl`, and `postgres`, while `oliphaunt-tools`/
  `@oliphaunt/tools-linux-x64-gnu` carried only `pg_dump` and `psql`. WASIX root
  inspection found `bin/initdb.wasix.wasm`, `manifest.json`,
  `oliphaunt.wasix.tar.zst`, and prepopulated template files in the portable
  root payload; the nested runtime archive contained only `oliphaunt/bin/initdb`
  and `oliphaunt/bin/postgres`; and `oliphaunt-wasix-tools` contained only
  `bin/pg_dump.wasix.wasm` and `bin/psql.wasix.wasm`, with no WASIX `pg_ctl`.
- 2026-06-27: Moved SDK package product and CI artifact-name selection out of
  the Python compatibility layer and into the Bun release graph. `release-artifact-targets.mjs`
  now exposes `sdkPackageProducts`, `release_graph_query.mjs sdk-package-products
  [--product PRODUCT]` returns the six SDK package rows, and `product_metadata.py`
  adapts those rows for legacy Python callers instead of scanning
  `config.kind == "sdk"` or special-casing the WASIX Rust artifact name locally.
  `check_release_metadata.py` now rejects reintroducing Python SDK product
  selection or Python-side SDK artifact-name special cases. A subagent review was
  attempted for the next cleanup slice, but the current session had reached the
  agent thread limit, so this pass used local repo evidence instead. Fresh
  checks passed: `tools/dev/bun.sh tools/release/release_graph_query.mjs
  sdk-package-products`, `tools/dev/bun.sh tools/release/release_graph_query.mjs
  sdk-package-products --product oliphaunt-wasix-rust`, Python smoke for
  `sdk_package_products` and `ci_sdk_package_artifact_names`, selector-removal
  `rg` scan, `python3 -m py_compile` for touched Python helpers, `python3
  tools/release/check_release_metadata.py`, `python3
  tools/release/check_artifact_targets.py`, `python3
  tools/release/check_consumer_shape.py`, `tools/release/release.py check`,
  `bash tools/policy/check-tooling-stack.sh`, `bash
  tools/policy/check-policy-tools.sh`, `tools/release/release.py ci-products
  --family sdk-package`, `tools/release/release.py ci-artifacts --product
  oliphaunt-wasix-rust --family sdk-package`,
  `tools/release/local_registry_publish.py publish --surface cargo --strict`,
  and `tools/release/local_registry_publish.py publish --surface npm --strict`.
  The Python entrypoint inventory still reported 9 Python entrypoints, with
  `product_metadata.py` at 759 lines and 26,646 bytes. A fresh Cargo
  local-registry sweep covered 836 `.crate` files with no crate above the 10
  MiB crates.io limit; the largest generated crates were split WASIX PostGIS AOT
  part crates at 10,212,312 bytes, and the hard over-limit query returned no
  crates. The strict npm publish included `@oliphaunt/liboliphaunt-linux-x64-gnu`,
  `@oliphaunt/tools-linux-x64-gnu`, `@oliphaunt/icu`, `@oliphaunt/ts`, broker,
  node-direct, and native extension packages from the local Verdaccio registry.
- 2026-06-27: Centralized TypeScript optional runtime package selection in
  `release-artifact-targets.mjs` so release sync, Python metadata adapters, and
  validation share one artifact-target-backed source for broker, native runtime,
  native tools, and node-direct optional packages. `release_graph_query.mjs
  typescript-optional-runtime-package-versions` now returns 16 package/version
  rows, including the separate `@oliphaunt/tools-*` packages; `sync-release-pr.mjs`
  consumes the shared selector; and `product_metadata.py` only adapts the query
  rows instead of recomputing the selector in Python. `check_release_metadata.py`
  now rejects reintroducing a Python selector or a local sync-release-pr selector
  for this package set. A subagent review was attempted for the next cleanup
  slice, but the current session had reached the agent thread limit, so this
  pass used local repo evidence instead. Fresh checks passed: selector-removal
  `rg` scan, `tools/dev/bun.sh tools/release/release_graph_query.mjs
  typescript-optional-runtime-package-versions`, Python smoke for
  `typescript_optional_runtime_package_versions`, `python3 -m py_compile` for
  touched Python helpers, `tools/dev/bun.sh
  tools/release/sync-release-pr.mjs --check`, `python3
  tools/release/check_release_metadata.py`, `python3
  tools/release/check_consumer_shape.py`, `tools/release/release.py check`,
  `bash tools/policy/check-tooling-stack.sh`, `bash
  tools/policy/check-policy-tools.sh`, `tools/release/local_registry_publish.py
  publish --surface cargo --strict`, and
  `tools/release/local_registry_publish.py publish --surface npm --strict`.
  The Python entrypoint inventory still reported 9 Python entrypoints, with
  `product_metadata.py` at 744 lines and 25,873 bytes. A fresh Cargo
  local-registry sweep covered 836 `.crate` files with no crate above the 10
  MiB crates.io limit; the largest generated crates were split WASIX PostGIS AOT
  part crates at 10,212,312 bytes, and the hard over-limit query returned no
  crates. The strict npm publish included `@oliphaunt/liboliphaunt-linux-x64-gnu`,
  `@oliphaunt/tools-linux-x64-gnu`, `@oliphaunt/icu`, `@oliphaunt/ts`, broker,
  node-direct, and native extension packages from the local Verdaccio registry.
- 2026-06-27: Retired the unused Python compatibility-version metadata adapter
  after a repo reference scan found no callers for
  `_compatibility_version_entries`, `compatibility_version_specs`, or
  `compatibility_version_links` outside their own internal chain. Compatibility
  version sync now stays directly on the Bun release graph:
  `release_graph_query.mjs compatibility-version-entries` remains the query
  surface, and `sync-release-pr.mjs` consumes `compatibilityVersionEntries`
  without Python wrapping. The release-metadata check now rejects reintroducing
  those Python wrappers while still requiring the Bun query and sync-release-pr
  integration. A subagent review was attempted for the next cleanup slice, but
  the current session had reached the agent thread limit, so this pass used
  local repo evidence instead. Fresh checks passed: wrapper-removal `rg` scan,
  `python3 -m py_compile` for touched Python helpers,
  `tools/dev/bun.sh tools/release/release_graph_query.mjs
  compatibility-version-entries --require-source-product`, `python3
  tools/release/check_release_metadata.py`, `python3
  tools/release/check_consumer_shape.py`, `tools/release/release.py check`,
  `bash tools/policy/check-tooling-stack.sh`,
  `tools/dev/bun.sh tools/policy/check-python-entrypoints.mjs --json`,
  `tools/release/local_registry_publish.py publish --surface cargo --strict`,
  and `tools/release/local_registry_publish.py publish --surface npm --strict`.
  The Python entrypoint inventory still reported 9 Python entrypoints, with
  `product_metadata.py` reduced to 746 lines and 25,699 bytes. A fresh Cargo
  local-registry sweep covered 836 `.crate` files with no crate above the 10
  MiB crates.io limit; the largest generated crate remained a split WASIX
  PostGIS AOT part at 10,212,312 bytes.
- 2026-06-27: Removed unused Python version-spec compatibility helpers after a
  repo reference scan found no callers for `parser_for_version_file`,
  `canonical_version_spec`, `product_version_specs`, or
  `release_owned_version_specs` outside their own internal chain. The
  release-metadata check now rejects reintroducing those helpers so current
  product version values stay behind the Bun release graph `product-versions`
  query. A subagent review was attempted for the next cleanup slice, but the
  current session had reached the agent thread limit, so this pass used local
  repo evidence instead. Fresh checks passed: parser-removal `rg` scan,
  `python3 -m py_compile` for touched Python helpers, `python3
  tools/release/check_release_metadata.py`, `python3
  tools/release/check_consumer_shape.py`, `tools/release/release.py check`,
  `bash tools/policy/check-tooling-stack.sh`,
  `tools/dev/bun.sh tools/policy/check-python-entrypoints.mjs --json`,
  `tools/release/local_registry_publish.py publish --surface cargo --strict`,
  and `tools/release/local_registry_publish.py publish --surface npm --strict`.
  The Python entrypoint inventory still reported 9 Python entrypoints, with
  `product_metadata.py` reduced to 793 lines and 27,997 bytes. A fresh Cargo
  local-registry sweep covered 836 `.crate` files with no crate above the 10
  MiB crates.io limit; the largest generated crate remained a split WASIX
  PostGIS AOT part at 10,212,312 bytes.
- 2026-06-27: Tightened the native `pg_dump`/`psql` tools split so root native
  release staging no longer copies those tools and relies on pruning later.
  Linux and macOS release asset packagers now exclude `/bin/pg_dump` and
  `/bin/psql` from the root `liboliphaunt` runtime stage while copying them
  into `oliphaunt-tools`; the Windows packager removes `pg_dump.exe` and
  `psql.exe` from the root stage immediately after staging the tools package.
  Release metadata and consumer-shape checks now require that explicit split
  in addition to the existing Cargo artifact and npm package validation. Fresh
  checks passed: `python3 -m py_compile` for touched Python checks, `python3
  tools/release/check_release_metadata.py`, `python3
  tools/release/check_consumer_shape.py`, synthetic
  `optimize_native_runtime_payload.mjs` root/tools validation including a
  negative root-with-`pg_dump` check, `tools/release/release.py check`, `bash
  tools/policy/check-tooling-stack.sh`, `bash examples/tools/check-examples.sh`,
  `bash tools/policy/check-policy-tools.sh`,
  `tools/release/local_registry_publish.py publish --surface cargo --strict`,
  and `tools/release/local_registry_publish.py publish --surface npm --strict`.
  Generated native Cargo extraction trees contained exactly
  `runtime/bin/initdb`, `runtime/bin/pg_ctl`, and `runtime/bin/postgres` for
  root, and exactly `runtime/bin/pg_dump` plus `runtime/bin/psql` for
  `oliphaunt-tools`. WASIX Cargo payload inspection found root portable payload
  files `bin/initdb.wasix.wasm`, `manifest.json`, and
  `oliphaunt.wasix.tar.zst`; the nested archive contained only
  `oliphaunt/bin/initdb` and `oliphaunt/bin/postgres`; and
  `oliphaunt-wasix-tools` contained exactly `bin/pg_dump.wasix.wasm` and
  `bin/psql.wasix.wasm`. A fresh sweep over 836 local-registry `.crate` files
  found no crate above the 10 MiB crates.io limit; the largest remained the
  split WASIX PostGIS AOT part crates at 10,212,312 bytes.
- 2026-06-27: Moved current product version reads out of the remaining Python
  version-file parser compatibility path and into the Bun release graph query.
  `tools/release/product-version.mjs` now delegates to
  `currentProductVersion`, `tools/release/release_graph_query.mjs` exposes
  `product-versions [--product PRODUCT]`, and
  `tools/release/product_metadata.py` adapts those rows for legacy Python
  callers without local `re`/`tomllib` version parsing. A subagent review was
  attempted for the next cleanup slice, but the current session had reached the
  agent thread limit, so the audit used local repo evidence instead. Fresh
  checks passed: focused `product-version.mjs` and `product-versions` smokes,
  full `product-versions` query count/parity smoke across 49 products, Python
  `product_metadata.read_current_version` smoke for native, WASIX, JS, and Rust
  products, `python3 -m py_compile` for touched Python helpers, parser-removal
  `rg` scan, `python3 tools/release/check_release_metadata.py`, `python3
  tools/release/check_consumer_shape.py`, `tools/dev/bun.sh
  tools/release/check_release_versions.mjs`, `tools/dev/bun.sh
  tools/release/check_github_release_assets.mjs --help`,
  `tools/release/release.py check`, `bash
  tools/policy/check-tooling-stack.sh`, `bash tools/policy/check-docs.sh`,
  `bash examples/tools/check-examples.sh`, `bash
  tools/policy/check-policy-tools.sh`, `tools/dev/bun.sh
  tools/policy/check-python-entrypoints.mjs --json`,
  `tools/release/local_registry_publish.py publish --surface cargo --strict`,
  and `tools/release/local_registry_publish.py publish --surface npm --strict`.
  The Python entrypoint inventory reported `product_metadata.py` at 827 lines,
  and a fresh sweep over 836 local-registry `.crate` files found no crate above
  the 10 MiB crates.io limit; the largest remained the split WASIX PostGIS AOT
  part crates at 10,212,312 bytes.
- 2026-06-27: Moved exact-extension release metadata and source identity
  parsing out of the Python compatibility layer and the duplicate CI artifact
  helpers. `tools/release/release-artifact-targets.mjs` now owns
  `extensionMetadata`, `extensionSourceIdentity`, `extensionSqlName`, and the
  shared graph-backed product version parser; `tools/release/release_graph_query.mjs`
  exposes `extension-metadata [--product PRODUCT]`; and
  `tools/release/product_metadata.py` adapts those query rows for legacy Python
  callers. `tools/release/build-extension-ci-artifacts.mjs` and
  `tools/release/check-staged-artifacts.mjs` now reuse the shared helper instead
  of carrying local extension metadata/source identity implementations. A
  subagent review was attempted for this slice, but the current session had
  reached the agent thread limit, so the audit used local repo evidence instead.
  Fresh checks passed: `tools/dev/bun.sh
  tools/release/release_graph_query.mjs extension-metadata --product
  oliphaunt-extension-unaccent`, full `extension-metadata` query count/parity
  smoke across 39 exact-extension products, Python `product_metadata`
  extension-metadata and source-identity smoke, `python3 -m py_compile` for
  touched Python helpers, `tools/dev/bun.sh
  tools/release/build-extension-ci-artifacts.mjs --help`,
  `tools/dev/bun.sh tools/release/check-staged-artifacts.mjs --help`, scoped
  unaccent extension artifact staging with native Linux x64 plus WASIX payloads,
  `tools/dev/bun.sh tools/release/check-staged-artifacts.mjs --inspect-present
  --require-extension-product oliphaunt-extension-unaccent`, `python3
  tools/release/check_release_metadata.py`, `python3
  tools/release/check_artifact_targets.py`, `python3
  src/extensions/tools/check-extension-model.py --check`, `python3
  tools/release/check_consumer_shape.py`, `tools/release/release.py check`,
  `bash tools/policy/check-policy-tools.sh`,
  `tools/release/local_registry_publish.py publish --surface cargo --strict`,
  and `tools/release/local_registry_publish.py publish --surface npm --strict`.
  The fresh Cargo local-registry sweep covered 836 `.crate` files with no crate
  above the 10 MiB crates.io limit; the largest remained the split WASIX PostGIS
  AOT part crates at 10,212,312 bytes. The strict npm publish also confirmed
  separate `@oliphaunt/liboliphaunt-linux-x64-gnu` and
  `@oliphaunt/tools-linux-x64-gnu` packages.
- 2026-06-27: Moved compatibility-version metadata collection out of the
  Python release compatibility layer and into the canonical Bun release graph.
  `tools/release/release-graph.mjs` now exposes sorted
  `compatibilityVersionEntries`, `tools/release/release_graph_query.mjs`
  exposes `compatibility-version-entries [--require-source-product]`,
  `tools/release/sync-release-pr.mjs` reuses the shared helper, and
  `tools/release/product_metadata.py` only adapts the query rows to the legacy
  tuple API. `tools/release/check_release_metadata.py` now rejects moving
  `compatibility_versions` collection back to Python or reintroducing a separate
  sync-release-pr implementation. A subagent review was attempted for the
  remaining Python migration/dead-code pass, but the current session had reached
  the agent thread limit, so this pass used local repo evidence instead. Strict
  dead-code/reference scans still found no zero-reference helper or source
  candidates. Fresh checks passed: `tools/dev/bun.sh
  tools/release/release_graph_query.mjs compatibility-version-entries`,
  `tools/dev/bun.sh tools/release/release_graph_query.mjs
  compatibility-version-entries --require-source-product`, a Python
  `product_metadata` compatibility-version API smoke, `python3 -m py_compile`
  for touched Python helpers, `python3
  tools/release/check_release_metadata.py`, `python3
  tools/policy/check-release-policy.py`, `tools/dev/bun.sh
  tools/release/sync-release-pr.mjs --check`, `python3
  tools/release/check_artifact_targets.py`, full `python3
  tools/release/check_consumer_shape.py`, `bash
  tools/policy/check-tooling-stack.sh`, `tools/release/release.py check`,
  `tools/release/local_registry_publish.py publish --surface cargo --strict`,
  `tools/release/local_registry_publish.py publish --surface npm --strict`,
  `bash examples/tools/check-examples.sh`, and `bash
  tools/policy/check-policy-tools.sh`. The fresh Cargo local-registry sweep
  covered 836 `.crate` files with no crate above the 10 MiB crates.io limit;
  the largest remained the split WASIX PostGIS AOT part crates at 10,212,312
  bytes.
- 2026-06-27: Removed another WASIX runtime/tools package-graph duplication from
  the remaining Python compatibility layer. The WASIX Cargo artifact packager now
  reads schema, runtime/tools/ICU package names, AOT target package maps, tool
  payload files, forbidden root-runtime tools, and extension AOT target coverage
  from the canonical Bun contract exposed by
  `tools/release/wasix-cargo-artifact-contract.mjs` through
  `product_metadata.py`; the packager keeps only local packaging mechanics such
  as split thresholds and crate generation. Consumer-shape and release metadata
  checks now require those accessors so the literal package/tool matrix cannot be
  reintroduced in the packager. Fresh checks passed: `python3 -m py_compile` for
  touched release helpers, a targeted packager/product-metadata contract import
  parity smoke, `tools/dev/bun.sh tools/release/release_graph_query.mjs
  wasix-cargo-artifact-contract`, `python3
  tools/release/check_release_metadata.py`, focused and full `python3
  tools/release/check_consumer_shape.py`, `python3
  tools/release/check_artifact_targets.py`, `tools/dev/bun.sh
  tools/policy/check-wasix-release-dependency-invariants.mjs`, `bash
  tools/policy/check-tooling-stack.sh`, `bash tools/policy/check-docs.sh`, `bash
  examples/tools/check-examples.sh`, `tools/release/local_registry_publish.py
  publish --surface cargo --strict`, `tools/release/release.py check`, and
  `git diff --check`. A fresh sweep over 836 local-registry `.crate` files found
  no crate above the 10 MiB crates.io limit; the largest crates were the split
  WASIX PostGIS AOT part crates at 10,212,312 bytes, below the 10,485,760 byte
  limit.
- 2026-06-27: Isolated the registry-backed desktop examples from the root pnpm
  workspace so root CI setup no longer resolves unpublished local-registry
  example dependencies before Verdaccio is staged. Each root desktop example now
  has its own one-package `pnpm-workspace.yaml`, keeps package-local
  `pnpm --dir examples/... install` commands, and no longer uses root catalog
  dependencies. Electron and Tauri smoke runners install from the example
  directory; Electron resolves package-managed runtime/tool payloads from
  `@oliphaunt/ts` and builds the WASIX sidecar from a scratch local-registry
  Cargo lock to avoid stale same-version checksum state. Fresh checks passed:
  root `pnpm install --frozen-lockfile`, `examples/tools/with-local-registries.sh
  tools/dev/bun.sh tools/release/sync-example-lockfiles.mjs --check`, `bash
  examples/tools/check-examples.sh`, `bash tools/policy/check-tooling-stack.sh`,
  `bash tools/policy/check-docs.sh`, `bash
  src/bindings/wasix-rust/tools/check-examples.sh`, `bash
  src/bindings/wasix-rust/tools/check-package.sh`,
  `tools/release/check_release_metadata.py`,
  `tools/release/check_consumer_shape.py`, native Electron, WASIX Electron,
  native Tauri, and WASIX Tauri GUI smokes. The strict dead-code scans were also
  re-run after the fix; `tools/dev/bun.sh
  tools/policy/list-helper-reference-candidates.mjs --max-refs 0` and
  `tools/dev/bun.sh tools/policy/list-source-reference-candidates.mjs --max-refs
  0` both found no unreferenced tracked candidates.
- 2026-06-27: Re-ran the complementary strict npm local-registry publication
  after the current Cargo split verification. Fresh check passed:
  `tools/release/local_registry_publish.py publish --surface npm --strict`.
  The run optimized the root native npm payload with `--tool-set runtime` and
  the split tools npm payload with `--tool-set tools`, published/replaced
  `@oliphaunt/liboliphaunt-linux-x64-gnu`,
  `@oliphaunt/tools-linux-x64-gnu`, `@oliphaunt/icu`, `@oliphaunt/ts`, broker,
  node-direct optional packages, and native extension package/payload families
  through Verdaccio. Direct source inspection confirmed the root npm runtime
  package contains only `runtime/bin/initdb`, `runtime/bin/pg_ctl`, and
  `runtime/bin/postgres`, while the split tools package contains only
  `runtime/bin/pg_dump` and `runtime/bin/psql`.
- 2026-06-27: Re-ran Linux-local CI evidence from disposable worktrees at
  `71407e43da72449f880bb9044b7f5449bbf7b53c`. Local prerequisites were
  `act` v0.2.89 and Docker 29.5.3, and `act -l` parsed the CI, Release, and
  mobile E2E workflows. The PR-shaped
  `act pull_request -e /tmp/oliphaunt-act-events/pr71-current.json -W
  .github/workflows/ci.yml -j release-intent
  -P ubuntu-latest=ghcr.io/catthehacker/ubuntu:act-latest` run succeeded.
  The `affected` job reached successful CI planning, emitted the full builder
  job set, and produced `check_count=21`, `policy_count=64`, and
  `test_count=7`; it then failed only in `Upload build plan` because the
  local `act` artifact server rejected `actions/upload-artifact@v7` with
  `unknown field "mime_type"`. Current upstream `nektos/act` issues report
  the same artifact protocol mismatch for `upload-artifact@v7`, so this is a
  local-runner compatibility limit rather than evidence that the GitHub-hosted
  CI upload step is broken.
- 2026-06-27: Refreshed local runner, release/local-registry, and P2 tooling
  evidence after the split runtime/tools package verification. Current web
  research still points to upstream `nektos/act` as the practical local Linux
  GitHub Actions runner because it executes workflow jobs through Docker runner
  images; local checks confirmed `act` v0.2.89, `act -l` parsing for CI,
  Release, and mobile E2E workflows, and a `release-intent` CI dry run with
  `ghcr.io/catthehacker/ubuntu:act-latest`. The full Linux CI lane remains
  open because it should run from a committed disposable worktree, and this
  evidence does not claim macOS, Windows, iOS, or Android device/simulator
  lanes are validated by Linux-local `act`.
- 2026-06-27: Reduced the remaining Python release compatibility layer in
  `tools/release/product_metadata.py`. Version files, changelog paths, tag
  prefixes, derived version files, and extension artifact target rows now read
  from the canonical Bun `release_graph_query.mjs` output instead of carrying a
  second Python `release-please-config.json` parser and a bespoke
  `extension-targets` subprocess path. `tools/dev/bun.sh
  tools/policy/check-python-entrypoints.mjs --json` now reports
  `product_metadata.py` at 987 lines while the remaining tracked Python surface
  stays limited to the nine explicit release/extension-modeling files. Fresh
  checks passed: `python3 -m py_compile` for all remaining Python release and
  policy helpers, `tools/dev/bun.sh tools/release/release_graph_query.mjs
  graph`, a targeted `product_metadata` API smoke, `python3
  tools/release/check_release_metadata.py`, `python3
  tools/release/check_artifact_targets.py`, focused `python3
  tools/release/check_consumer_shape.py --products-json ...`, `python3
  tools/policy/check-release-policy.py`, `bash
  tools/policy/check-tooling-stack.sh`, `tools/release/release.py check`,
  `tools/release/local_registry_publish.py publish --surface cargo --strict`,
  `tools/release/local_registry_publish.py publish --surface npm --strict`,
  `bash tools/policy/check-docs.sh`, and `git diff --check`.
- 2026-06-27: Hardened the helper dead-code scanner so low-reference
  candidates account for path-suffix references as well as full-path and
  basename references. This avoids treating nested helpers as weaker candidates
  when callers use stable suffixes such as `tools/check-fumadocs-source.mjs`.
  Fresh checks passed: `tools/dev/bun.sh
  tools/policy/list-helper-reference-candidates.mjs --help`, `tools/dev/bun.sh
  tools/policy/list-helper-reference-candidates.mjs --max-refs 0`,
  `tools/dev/bun.sh tools/policy/list-helper-reference-candidates.mjs
  --max-refs 1 --json`, and the unknown-argument failure path.
- 2026-06-27: Revalidated the current split tools package surface with strict
  local Cargo publication and release gates. Fresh checks passed:
  `cargo check -p oliphaunt-tools --locked`, `cargo check -p
  oliphaunt-wasix-tools --locked`, `cargo test -p oliphaunt-tools --locked`,
  `python3 tools/release/check_release_metadata.py`, `python3
  tools/release/check_consumer_shape.py`, `tools/dev/bun.sh
  tools/policy/check-wasix-release-dependency-invariants.mjs`, `bash
  tools/policy/check-sdk-parity.sh`, `python3
  tools/release/check_artifact_targets.py`,
  `tools/release/local_registry_publish.py publish --surface cargo --strict`,
  `tools/release/local_registry_publish.py publish --surface npm --strict`,
  `tools/release/release.py check`, and `git diff --check`. A generated crate
  sweep over `target/local-registries` found 836 `.crate` files and no crate
  above the 10 MiB crates.io limit.
- 2026-06-27: Removed duplicate native extension Cargo packaging work from
  local-registry publishing. Default artifact roots can expose the same
  `extension-artifacts.json` rows from both downloaded local-registry artifacts
  and canonical `target/extension-artifacts`; discovery now preserves root
  priority while deduplicating by product/version/sql name. Fresh checks passed:
  `python3 tools/release/check_release_metadata.py`, a targeted
  `package_native_extension_cargo_crates(...)` smoke that found 39 unique
  extension manifests and generated 54 unique native extension crates, and
  `python3 -m py_compile tools/release/local_registry_publish.py
  tools/release/check_release_metadata.py`.
- 2026-06-27: Tightened the remaining Python and Rust helper inventories from
  path-only allowlists into machine-checked migration decision records. Python
  entries now carry a domain, decision, and rationale for the nine remaining
  release/local-registry/WASIX-packager/extension-model tools; Rust helper
  crates carry the same decision shape for `tools/xtask` and
  `tools/perf/runner`. This confirms there are no low-risk wrapper scripts left
  in the tracked Python/Rust helper surface; the next Python reduction is a
  deliberate release-graph, local-registry, WASIX packager, or extension-model
  port. Fresh checks passed: `tools/dev/bun.sh
  tools/policy/check-python-entrypoints.mjs --list`, `tools/dev/bun.sh
  tools/policy/check-python-entrypoints.mjs --json`, `tools/dev/bun.sh
  tools/policy/check-rust-helper-crates.mjs --list`, and `bash
  tools/policy/check-tooling-stack.sh`.
- 2026-06-27: Retired the stale direct
  `tools/release/product_metadata.py version` CLI after confirming real product
  version callers already use the Bun helper `tools/release/product-version.mjs`.
  `product_metadata.py` remains as a Python compatibility module for the
  unported release tools, but direct execution now fails with module-only
  guidance instead of exposing a second version-read path. The Python inventory
  checker now reports a tooling inventory rather than overstating every tracked
  Python module as an entrypoint. Fresh checks passed:
  `tools/dev/bun.sh tools/release/product-version.mjs version
  liboliphaunt-native`, the expected failing `python3
  tools/release/product_metadata.py version liboliphaunt-native` guidance path,
  `python3 -m py_compile tools/release/product_metadata.py`, `tools/dev/bun.sh
  tools/policy/check-python-entrypoints.mjs --list`, `bash
  tools/policy/check-tooling-stack.sh`, `bash
  tools/policy/check-policy-tools.sh`, `bash tools/policy/check-docs.sh`,
  `tools/release/release.py check`,
  `tools/release/local_registry_publish.py publish --surface cargo --strict`,
  `tools/release/local_registry_publish.py publish --surface npm --strict`,
  and `git diff --check`. A generated crate sweep over 836 `.crate` files
  found no crate above the 10 MiB crates.io limit; the largest observed crate
  was 10,212,312 bytes.
- 2026-06-27: Hardened default local-registry publishing for the split
  runtime/tools artifact graph. The publisher now prefers
  `target/local-registry-current`, stages native runtime/tools assets only as a
  complete host-target set, lets strict Cargo prune only non-host target deps,
  and ignores malformed Cargo scratch archives from `target/package/tmp-crate`
  while keeping real artifact roots strict. Fresh checks passed:
  `tools/release/local_registry_publish.py publish --surface cargo --strict`,
  `tools/release/local_registry_publish.py publish --surface npm --strict`,
  `python3 tools/release/check_consumer_shape.py`, `bash
  tools/policy/check-sdk-parity.sh`, `bash tools/policy/check-tooling-stack.sh`,
  `bash tools/policy/check-repo-structure.sh`, `bash
  tools/policy/check-docs.sh`, and `git diff --check`.
- 2026-06-27: Added source-module dead-code candidate scanning to complement
  the helper-entrypoint scanner. Web/tooling research confirmed Knip as the
  full JS/TS unused file/export/dependency option, cargo-machete as the fast
  stable Rust unused-dependency option, and cargo-udeps as nightly-dependent;
  this pass adds repo-native `tools/policy/list-source-reference-candidates.mjs`
  first so routine checks stay Bun-based and do not add another external
  maintainer tool. The scanner reviews non-test Rust SDK/WASIX source plus
  TypeScript/JavaScript SDK source modules by tracked-text references, is
  required by repo structure policy, and runs from `check-tooling-stack.sh` with
  `--max-refs 0`. Fresh checks passed: `tools/dev/bun.sh
  tools/policy/list-source-reference-candidates.mjs --max-refs 0`,
  `tools/dev/bun.sh tools/policy/list-source-reference-candidates.mjs
  --surface typescript --max-refs 1 --json`, `tools/dev/bun.sh
  tools/policy/list-source-reference-candidates.mjs --surface rust --max-refs
  1`, the bad `--surface` negative smoke, `bash
  tools/policy/check-policy-tools.sh`, `bash tools/policy/check-tooling-stack.sh`,
  `bash tools/policy/check-repo-structure.sh`, `bash tools/policy/check-docs.sh`,
  `tools/release/release.py check`, and `git diff --check`.
- 2026-06-27: Ran the low-reference helper scan as part of the P2 cleanup pass.
  `tools/dev/bun.sh tools/policy/list-helper-reference-candidates.mjs
  --max-refs 0` found no unreferenced tracked helper entrypoints, and the
  `--max-refs 1` review showed the flagged CI/release/docs helpers were live
  workflow, docs, or release.py entrypoints except for stale maintained-doc
  references to the retired `tools/release/sync_release_pr.py` path. Updated
  maintainer release docs to the pinned Bun command
  `tools/dev/bun.sh tools/release/sync-release-pr.mjs --check`, and
  `tools/policy/check-docs.sh` now rejects retired Python release-helper paths
  in maintained docs. Fresh checks passed: `tools/dev/bun.sh
  tools/policy/list-helper-reference-candidates.mjs --max-refs 0`, `bash
  tools/policy/check-policy-tools.sh`, `bash tools/policy/check-tooling-stack.sh`,
  `bash tools/policy/check-docs.sh`, `bash tools/policy/check-repo-structure.sh`,
  `tools/release/release.py check`, and `git diff --check`.
- 2026-06-27: Replaced brittle raw-string SDK manifest assertions in
  `tools/policy/check-sdk-parity.sh` with a parsed Bun contract checker. The new
  `tools/policy/check-sdk-manifest.mjs` verifies the exact Rust, WASIX Rust,
  Swift, Kotlin, React Native, and TypeScript SDK registry shape, path
  existence, unique implementation ownership, delegated runtime references,
  unsupported-mode reasons, and TypeScript broker-helper ownership. It is now
  required by `check-sdk-parity.sh`, `check-tooling-stack.sh`, and
  `check-repo-structure.sh`, and the old shell `require_manifest_text` helper
  was removed. Fresh checks passed: `tools/dev/bun.sh
  tools/policy/check-sdk-manifest.mjs`, `tools/dev/bun.sh
  tools/policy/check-sdk-manifest.mjs --list`, `tools/dev/bun.sh
  tools/policy/check-sdk-manifest.mjs --json`, `tools/dev/bun.sh
  tools/policy/check-sdk-manifest.mjs --help`, and the unknown-argument failure
  path.
- 2026-06-27: Made the remaining Python helper inventory machine-readable for
  the Bun migration pass. `tools/policy/check-python-entrypoints.mjs --list`
  now prints line and byte counts per tracked Python tooling file, and `--json`
  emits the same nine-file inventory for future prioritization. The current
  remaining Python surface is all release or extension-modeling code, ranging
  from `tools/release/product_metadata.py` at 1,101 lines to
  `tools/release/release.py` at 3,411 lines; none are low-risk wrapper scripts.
  Fresh checks passed: `tools/dev/bun.sh
  tools/policy/check-python-entrypoints.mjs`, `tools/dev/bun.sh
  tools/policy/check-python-entrypoints.mjs --list`, `tools/dev/bun.sh
  tools/policy/check-python-entrypoints.mjs --json`,
  `tools/dev/bun.sh tools/policy/check-python-entrypoints.mjs --help`, and the
  unknown-argument failure path.
- 2026-06-27: Added repeatable Bun dead-code candidate tooling and removed the
  stale `tools/policy/check-repo.sh` umbrella wrapper. The new
  `tools/policy/list-helper-reference-candidates.mjs` scans live tracked shell,
  Python, and JavaScript helper entrypoints and reports low-reference
  candidates with full-path, path-suffix, and basename reference counts. The
  report is advisory so legitimate human-facing entrypoints do not block CI, while
  `check-repo-structure.sh` rejects the retired wrapper path. Fresh checks
  passed: `tools/dev/bun.sh tools/policy/list-helper-reference-candidates.mjs
  --help`, `tools/dev/bun.sh tools/policy/list-helper-reference-candidates.mjs
  --max-refs 0`, `tools/dev/bun.sh
  tools/policy/list-helper-reference-candidates.mjs --max-refs 1 --json`, the
  unknown-argument failure path, `bash tools/policy/check-policy-tools.sh`,
  `bash tools/policy/check-tooling-stack.sh`, `bash
  tools/policy/check-repo-structure.sh`, `bash tools/policy/check-docs.sh`,
  `tools/policy/check-moon-product-graph.mjs`, and
  `tools/release/release.py check`.
- 2026-06-27: Moved the cross-product example ownership/local-registry policy
  checker from shell logic into `examples/tools/check-examples.mjs` so the
  canonical Moon tasks run through the pinned Bun launcher. The old
  `examples/tools/check-examples.sh` path remains a thin compatibility
  launcher. Fresh checks passed: `tools/dev/bun.sh
  examples/tools/check-examples.mjs`, `bash examples/tools/check-examples.sh`,
  `$HOME/.proto/shims/moon run integration-examples:check`,
  `tools/policy/check-moon-product-graph.mjs`, `bash
  tools/policy/check-tooling-stack.sh`, `bash
  tools/policy/check-policy-tools.sh`, `bash
  tools/policy/check-repo-structure.sh`, and `git diff --check`.
- 2026-06-27: Extended the central policy-tool syntax gate to bundle
  `examples/tools/*.mjs` alongside `.github/scripts`, `tools/policy`, and
  `tools/graph`, so Bun-backed example tooling migrations are checked by the
  same policy lane. Fresh checks passed: `bash
  tools/policy/check-policy-tools.sh`, `bash tools/policy/check-tooling-stack.sh`,
  `bash tools/policy/check-repo-structure.sh`,
  `tools/policy/check-sdk-parity.sh`, `tools/dev/bun.sh
  examples/tools/check-examples.mjs`, `tools/policy/check-moon-product-graph.mjs`,
  `bash tools/policy/check-docs.sh`, `tools/release/release.py check`, and
  `git diff --check`.
- 2026-06-27: Added an explicit Rust helper crate inventory. The new
  `tools/policy/check-rust-helper-crates.mjs` policy check verifies that the
  only tracked Rust helper crates under `tools/` are `tools/perf/runner` and
  `tools/xtask`, rejects stale or unlisted helper crates, and requires each to
  remain unpublished with empty default features so routine policy checks do not
  compile optional runtime-heavy paths. `check-tooling-stack.sh` now runs the
  inventory beside the Python tooling inventory. Fresh checks passed:
  `tools/dev/bun.sh tools/policy/check-rust-helper-crates.mjs`,
  `tools/dev/bun.sh tools/policy/check-rust-helper-crates.mjs --list`,
  `tools/dev/bun.sh tools/policy/check-rust-helper-crates.mjs --help`, an
  unknown-flag negative smoke, `bash tools/policy/check-tooling-stack.sh`,
  `bash tools/policy/check-policy-tools.sh`, `bash
  tools/policy/check-repo-structure.sh`, and `bash tools/policy/check-docs.sh`.
- 2026-06-27: Removed confirmed dead perf tooling entrypoint
  `tools/perf/matrix/run_bench_matrix.sh`. Repository grep showed no active
  docs, CI, Moon, source, or example caller outside policy checks, and the file
  itself only printed a retired-compatibility warning before delegating to
  `tools/perf/matrix/run_native_oliphaunt_matrix.sh`. Repo-structure policy now
  rejects tracking that retired wrapper again, while the peer SDK test-strategy
  check keeps guarding the current performance docs against old benchmark
  labels. Fresh checks passed: `bash tools/policy/check-repo-structure.sh`,
  `tools/policy/check-test-strategy.mjs`, `bash
  tools/policy/check-policy-tools.sh`, `bash tools/policy/check-docs.sh`, a
  stale-reference `git grep`, and `git diff --check`.
- 2026-06-27: Removed six more confirmed dead helper wrappers after a targeted
  shell/JavaScript helper reference sweep and full-path `git grep` found no
  docs, CI, Moon, release, policy, or example callers:
  `src/runtimes/liboliphaunt/native/bin/build-macos-happy-path.sh`,
  `src/runtimes/liboliphaunt/native/bin/run-native-postgres-regression-sql.sh`,
  `src/runtimes/liboliphaunt/wasix/tools/check-asset-input-fingerprint.sh`,
  `tools/perf/bench-react-native-expo-android.sh`,
  `tools/perf/bench-react-native-expo-ios.sh`, and
  `tools/perf/matrix/build_bench_matrix.mjs`. The canonical replacements are
  `build-postgres18-macos.sh`, `cargo run -p xtask -- assets verify-committed`,
  React Native `mobile-drill`, and `run_mobile_footprint_matrix.sh` /
  `summarize_native_oliphaunt_matrix.mjs`. Repo-structure policy now rejects
  tracking those retired helper paths again. Fresh checks passed: stale-reference
  `git grep`, `bash tools/policy/check-repo-structure.sh`, `bash
  tools/policy/check-policy-tools.sh`, `bash tools/policy/check-docs.sh`,
  `bash tools/policy/check-tooling-stack.sh`, `bash
  tools/perf/check-native-perf-harness.sh`,
  `tools/policy/check-moon-product-graph.mjs`, `tools/release/release.py
  check`, and `git diff --check`.
- 2026-06-27: Tightened WASIX Rust split-tools SDK parity. The WASIX package
  check now requires the `tools` feature to select the split
  `oliphaunt-wasix-tools` crate plus all tools-AOT target crates, and requires
  the public `pg_dump`/`psql` module and crate-root exports to stay behind
  `#[cfg(feature = "tools")]`. `tools/policy/check-sdk-parity.sh` now requires
  those package-shape assertions, matching the documented rule that WASIX
  `pg_dump` and `psql` exist only when the split tools feature is selected.
  Fresh checks passed: `bash src/bindings/wasix-rust/tools/check-package.sh`
  and `tools/policy/check-sdk-parity.sh`. Follow-up checks passed:
  `python3 tools/release/check_release_metadata.py`, focused `python3
  tools/release/check_consumer_shape.py --products-json
  '["oliphaunt-wasix-rust"]'`, `cargo check -p oliphaunt-wasix --locked
  --no-default-features --lib`, `bash tools/policy/check-policy-tools.sh`, and
  `bash tools/policy/check-docs.sh`.
- 2026-06-27: Tightened the Python tooling inventory audit.
  `tools/policy/check-python-entrypoints.mjs` now rejects unknown flags and
  makes `--list` print the validated tracked Python tooling files instead of only
  a count, giving the remaining migration pass concrete file-level evidence for
  the current 9 intentional Python scripts. Fresh checks passed:
  `tools/dev/bun.sh
  tools/policy/check-python-entrypoints.mjs`, `tools/dev/bun.sh
  tools/policy/check-python-entrypoints.mjs --list`, `tools/dev/bun.sh
  tools/policy/check-python-entrypoints.mjs --help`, and an unknown-flag
  negative smoke. Follow-up policy checks passed: `bash
  tools/policy/check-tooling-stack.sh` and `bash
  tools/policy/check-policy-tools.sh`.
- 2026-06-27: Added a React Native parity guard for unsupported shared
  runtime-resource `runtimeFeatures`: `client.packageSizeReport()` now has a
  unit test proving the platform SDK rejection is propagated after resource
  config normalization, and `tools/policy/check-sdk-parity.sh` requires that
  regression test alongside the existing Swift and Kotlin negative tests. Fresh
  checks passed: `pnpm --dir src/sdks/react-native test` and
  `pnpm --dir src/sdks/react-native typecheck`, and
  `tools/policy/check-sdk-parity.sh`.
- 2026-06-27: Reduced duplicate Python release graph modeling in
  `tools/release/product_metadata.py`. `load_graph()`, `graph_products()`,
  `product_config()`, product ids, extension product ids, `package_path()`, and
  Moon release metadata lookups now consume the canonical Bun
  `release_graph_query.mjs graph` output instead of rebuilding the product path
  map from Python release-please and Moon parsing. The remaining Python helpers
  still read release-please config only where they validate release-please
  version-file and changelog semantics directly. Fresh checks passed:
  graph-backed helper parity against `tools/dev/bun.sh
  tools/release/release_graph_query.mjs graph`, `python3 -m py_compile` for all
  remaining Python release/policy helpers, `python3
  tools/release/check_artifact_targets.py`, `python3
  tools/release/check_release_metadata.py`, and focused `python3
  tools/release/check_consumer_shape.py --products-json
  '["liboliphaunt-native","liboliphaunt-wasix","oliphaunt-rust","oliphaunt-wasix-rust","oliphaunt-js"]'`.
- 2026-06-27: Removed the duplicate Python runtime/helper artifact target
  model in `tools/release/artifact_targets.py`. Python release callers now use
  `product_metadata.artifact_targets()` compatibility wrappers backed by the
  canonical Bun `release-artifact-targets.mjs` graph through
  `release_graph_query.mjs artifact-targets` and `raw-artifact-targets`.
  Moon inputs for native and Node-direct release tasks now track
  `product_metadata.py` plus the Bun query entrypoint, and the intentional
  Python inventory is down to 9 tracked files after staging. Fresh checks
  passed: `tools/dev/bun.sh tools/release/release_graph_query.mjs
  artifact-targets --product liboliphaunt-native --kind native-runtime
  --published-only`, `tools/dev/bun.sh tools/release/release_graph_query.mjs
  raw-artifact-targets --product liboliphaunt-native`, `python3 -m
  py_compile` for touched Python release/policy callers, `python3
  tools/release/check_artifact_targets.py`, `python3
  tools/release/check_release_metadata.py`, focused `python3
  tools/release/check_consumer_shape.py --products-json
  '["liboliphaunt-native","liboliphaunt-wasix","oliphaunt-broker","oliphaunt-node-direct","oliphaunt-js","oliphaunt-rust"]'`,
  `python3 tools/policy/check-release-policy.py`, and
  `tools/release/release.py check`.
- 2026-06-27: Removed the duplicate Python exact-extension artifact target
  helper. Python release checks now query `tools/release/release_graph_query.mjs
  extension-targets`, which delegates to the canonical Bun
  `release-artifact-targets.mjs` metadata used by CI matrices and staged
  artifact validation. The Bun target rows now preserve the stricter unpublished
  `unsupported_reason` invariant and expose `source_file` for parity with the
  retired helper. Fresh checks passed: `tools/dev/bun.sh
  tools/release/release_graph_query.mjs extension-targets --family native
  --published-only`, `tools/dev/bun.sh tools/release/release_graph_query.mjs
  extension-targets --family wasix --published-only`, `python3 -m py_compile`
  for touched Python release callers, `python3
  tools/release/check_artifact_targets.py`, `python3
  tools/release/check_release_metadata.py`, focused `python3
  tools/release/check_consumer_shape.py --products-json
  '["liboliphaunt-native","liboliphaunt-wasix","oliphaunt-extension-postgis","oliphaunt-rust"]'`,
  and a `local_registry_publish.local_publish_aggregate_artifacts()` smoke.
  Follow-up validation passed: `tools/dev/bun.sh
  tools/policy/check-python-entrypoints.mjs --list`, `python3
  tools/policy/check-release-policy.py`, `bash
  tools/policy/check-tooling-stack.sh`, `bash tools/policy/check-repo-structure.sh`,
  `tools/release/release.py check`, and `git diff --check --cached && git diff
  --check`.
- 2026-06-27: Ported native liboliphaunt Cargo artifact crate packaging from
  Python to Bun as `tools/release/package-liboliphaunt-cargo-artifacts.mjs`.
  Release publishing, local-registry Cargo package synthesis, the Rust SDK
  package-shape fixture, and example staging docs now use the pinned Bun
  launcher. `release.py` no longer imports the packager module and keeps only
  the trivial native/tool crate-name helper it needs for release-source
  rendering. Fresh parity/checks passed: old Python and new Bun Linux
  `linux-x64-gnu` fixture package generation with matching normalized
  `packages.json`, matching generated crate member lists, and equal crate byte
  sizes; `python3 tools/release/check_artifact_targets.py`, `python3
  tools/release/check_release_metadata.py`, `python3
  tools/release/check_consumer_shape.py --products-json
  '["liboliphaunt-native","oliphaunt-rust"]'`, and `python3 -m py_compile` for
  touched Python release/policy callers. Follow-up validation passed:
  `tools/dev/bun.sh tools/policy/check-python-entrypoints.mjs --list`, `bash
  tools/policy/check-tooling-stack.sh`, `bash tools/policy/check-repo-structure.sh`,
  `python3 tools/policy/check-release-policy.py`, full `python3
  tools/release/check_consumer_shape.py`, `tools/release/release.py check`, `bash
  src/sdks/rust/tools/check-sdk.sh package-shape`, and `git diff --check
  --cached && git diff --check`.
- 2026-06-27: Ported staged artifact validation from Python to Bun as
  `tools/release/check-staged-artifacts.mjs`. CI mobile validation, SDK package
  staging, release SDK validation, and mobile exact-extension package assembly
  now call the pinned Bun launcher; the old Python entrypoint was removed from
  the intentional Python inventory. Fresh parity/checks passed: the legacy
  Python validator's `--inspect-present` mode before removal,
  `tools/dev/bun.sh tools/release/check-staged-artifacts.mjs --inspect-present`,
  `bash tools/policy/check-sdk-mobile-extension-surface.sh`, `python3
  tools/release/check_artifact_targets.py`, `python3
  tools/policy/check-release-policy.py`, `python3
  tools/release/check_release_metadata.py`, `python3
  tools/release/check_consumer_shape.py`, `tools/dev/bun.sh
  tools/policy/check-python-entrypoints.mjs --list`, `tools/release/release.py
  check`, `bash tools/policy/check-tooling-stack.sh`, `bash
  tools/policy/check-workflows.sh`, `bash tools/policy/check-repo-structure.sh`,
  and `git diff --check --cached && git diff --check`.
- 2026-06-27: Rechecked the root/tool crate split requested for PostgreSQL
  client tools. Native root runtime packages/crates are limited by
  `tools/release/native-runtime-payload-policy.json` to `initdb`, `pg_ctl`, and
  `postgres`, while split `oliphaunt-tools` packages/crates carry only
  `pg_dump` and `psql`. WASIX root crates carry `postgres` and `initdb`, reject
  `pg_ctl`, `pg_dump`, and `psql` in the root archive, and publish
  `pg_dump.wasix.wasm` plus `psql.wasix.wasm` through `oliphaunt-wasix-tools`
  and tools-AOT crates. Fresh checks passed: `python3
  tools/release/check_consumer_shape.py --products-json
  '["liboliphaunt-native","liboliphaunt-wasix","oliphaunt-rust","oliphaunt-js"]'`,
  `python3 tools/release/check_artifact_targets.py`, `tools/dev/bun.sh
  tools/policy/check-wasix-release-dependency-invariants.mjs`, `cargo check -p
  oliphaunt-tools --locked`, `cargo test -p oliphaunt-tools --locked`, `cargo
  check -p oliphaunt-wasix-tools --locked`, `cargo check -p oliphaunt-wasix
  --no-default-features --features tools --locked`, and `bash
  examples/tools/check-examples.sh`.
- 2026-06-27: Continued the tooling cleanup by porting the shared CI affected
  planner from `tools/graph/ci_plan.py` to `tools/graph/ci_plan.mjs`. The Builds
  workflow now invokes the Bun planner directly, `tools/graph/graph.mjs` and
  release policy checks query its JSON subcommands, and stale Python inventory
  references were removed. Fresh checks passed: workflow-dispatch planner
  smoke with `tools/dev/bun.sh tools/graph/ci_plan.mjs`, `tools/dev/bun.sh
  tools/graph/graph.mjs check`, `python3 tools/policy/check-release-policy.py`, and `bash
  tools/policy/check-repo-structure.sh`.
- 2026-06-27: Ported the local graph metadata generator/checker from
  `tools/graph/graph.py` to `tools/graph/graph.mjs`. The `graph-tools` Moon
  project now runs as JavaScript through `tools/dev/bun.sh`, repo structure
  policy requires the Bun entrypoint, and the intentional Python entrypoint
  inventory is down to 16 tracked files. Fresh checks passed:
  `tools/dev/bun.sh tools/graph/graph.mjs check`, `$HOME/.proto/bin/moon run
  graph-tools:check`, `bash tools/policy/check-repo-structure.sh`, `bash
  tools/policy/check-tooling-stack.sh`, `tools/dev/bun.sh
  tools/policy/check-python-entrypoints.mjs`, `python3
  tools/release/check_artifact_targets.py`, `python3
  tools/policy/check-release-policy.py`, and `git diff --cached --check`.
- 2026-06-27: Ported liboliphaunt native GitHub release asset validation from
  `tools/release/check_liboliphaunt_release_assets.py` to
  `tools/release/check-liboliphaunt-release-assets.mjs`. The aggregate
  packager and release CLI now invoke the Bun checker through `tools/dev/bun.sh`,
  and the intentional Python entrypoint inventory is down to 15 tracked files.
  Fresh checks passed: `tools/dev/bun.sh
  tools/release/check-liboliphaunt-release-assets.mjs --asset-dir
  target/liboliphaunt/release-assets`, `python3
  tools/release/check_artifact_targets.py`, `python3
  tools/release/check_consumer_shape.py --products-json
  '["liboliphaunt-native"]'`, `python3 tools/release/check_release_metadata.py`,
  `bash tools/policy/check-repo-structure.sh`, `bash
  tools/policy/check-tooling-stack.sh`, `tools/dev/bun.sh
  tools/policy/check-python-entrypoints.mjs`, `python3 -m py_compile` for
  touched Python release checks, full `python3 tools/release/check_consumer_shape.py`,
  `tools/release/release.py check`, and `git diff --cached --check`.
- 2026-06-27: Ported release PR derived-file synchronization from
  `tools/release/sync_release_pr.py` to `tools/release/sync-release-pr.mjs`.
  The release workflow and `release.py check` now use the Bun sync/check path
  through `tools/dev/bun.sh`; the script still delegates extension evidence
  validation to the existing extension model generator and preserves the
  `--check`/write contract. Fresh parity checks passed:
  `tools/dev/bun.sh tools/release/sync-release-pr.mjs --check` and
  `tools/release/sync_release_pr.py --check` before removing the Python file.
  Follow-up checks passed: `tools/dev/bun.sh
  tools/policy/check-python-entrypoints.mjs`, `bash
  tools/policy/check-tooling-stack.sh`, `python3
  tools/policy/check-release-policy.py`, `tools/release/release.py check`, and
  `git diff --cached --check`.
- 2026-06-27: Added and pushed the native Rust `oliphaunt-tools` Cargo facade
  crate so consumer manifests can depend on the facade while Cargo selects the
  target `oliphaunt-tools-*` payload crate. The Rust SDK release renderer now
  emits `oliphaunt-tools` instead of direct target tools dependencies, native
  liboliphaunt Cargo publishing orders part crates, target aggregators, then
  facade crates, and local-registry/example checks expect the facade plus
  payload crate shape. Fresh checks passed: `cargo check -p oliphaunt-tools
  --locked`, `cargo test -p oliphaunt-tools --locked`, `cargo package -p
  oliphaunt-tools --locked --allow-dirty --no-verify`, `tools/release/release.py
  check`, `python3 tools/release/check_release_metadata.py`, `python3
  tools/release/check_consumer_shape.py`, `python3
  tools/release/check_artifact_targets.py`, `bash tools/policy/check-sdk-parity.sh`,
  `examples/tools/with-local-registries.sh cargo metadata --manifest-path
  examples/tauri/src-tauri/Cargo.toml --locked --format-version 1`, and `bash
  examples/tools/check-examples.sh` with the stale generated registry index
  temporarily hidden from checksum comparison.
- 2026-06-27: Ported the release artifact target matrix helper from Python to
  Bun. `tools/release/artifact_target_matrix.mjs` now derives liboliphaunt
  native/WASIX, broker, Node direct, React Native Android, and exact-extension
  CI matrices from the shared Bun artifact target metadata in
  `tools/release/release-artifact-targets.mjs`; `tools/graph/ci_plan.mjs` and
  artifact policy checks consume that JSON surface instead of importing
  `artifact_target_matrix.py`. Fresh checks passed: Python/Bun matrix parity for
  every former matrix name, focused selected-extension matrix smoke,
  `GITHUB_EVENT_NAME=workflow_dispatch tools/dev/bun.sh tools/graph/ci_plan.mjs`, focused
  `WASM_TARGET=linux-x64-gnu` and `NATIVE_TARGET=linux-x64-gnu` planner probes,
  `python3 tools/release/check_artifact_targets.py`, `tools/dev/bun.sh
  tools/graph/graph.mjs check`, `python3 tools/policy/check-release-policy.py`, `bash
  tools/policy/check-repo-structure.sh`, and `git diff --check`.
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
  and `postgres`; native `oliphaunt-tools` selecting `oliphaunt-tools-*`
  payload crates carrying `pg_dump` and `psql`; WASIX root carrying only
  `initdb` plus runtime/template payloads; and `oliphaunt-wasix-tools`
  carrying `pg_dump.wasix.wasm` and `psql.wasix.wasm`.
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
  `bash -n src/sdks/swift/tools/check-sdk.sh`,
  `tools/dev/bun.sh tools/release/build-sdk-ci-artifacts.mjs --help`,
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
  per-SDK workflow booleans. `tools/dev/bun.sh tools/release/check-staged-artifacts.mjs` also
  derives SDK products from `artifact_targets.sdk_package_products()`. Fresh
  checks passed: direct `ci-products` smoke, `python3
  tools/release/check_artifact_targets.py`, `tools/dev/bun.sh
  tools/release/check-staged-artifacts.mjs --inspect-present`, `python3
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
- [x] Ensure each native example uses the `oliphaunt-tools` facade from the local registry when it exercises standalone tools.
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
- [x] Inventory Python and Rust helper scripts and decide which should move to Bun.
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
- Local-registry Cargo payload inspection confirmed
  `liboliphaunt-native-linux-x64-gnu-part-*` contains `initdb`, `pg_ctl`, and
  `postgres` only under `runtime/bin`, while the `oliphaunt-tools` facade
  selects `oliphaunt-tools-linux-x64-gnu-part-*` payloads containing only
  `pg_dump` and `psql` there.
- The small liboliphaunt release fixture now includes all five native desktop
  PostgreSQL binaries so fixture Cargo packaging exercises the split:
  `liboliphaunt-native-*` keeps `initdb`, `pg_ctl`, and `postgres`, while the
  `oliphaunt-tools` facade selects `oliphaunt-tools-*` payloads that keep
  `pg_dump` and `psql`. Consumer-shape checks enforce the same generator
  contract.
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
  Native Tauri compiled the `oliphaunt-tools` facade plus split runtime, target
  tools payload, and extension crates from `oliphaunt-local`; WASIX Tauri
  exercised the split WASIX runtime/tools/AOT and selected extension package
  graph through WebDriver.
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
  tools, ICU, root AOT, tools-AOT crate names, AOT target-cfg dependency maps,
  and `tools` feature dependency expectations from
  `tools/release/wasix-cargo-artifact-contract.mjs` via
  `release_graph_query.mjs wasix-cargo-artifact-contract`. Release metadata,
  consumer-shape, release publication, and staged artifact checks consume that
  shared contract instead of importing the WASIX cargo artifact packager for
  read-only metadata. Focused validation passed with
  `tools/dev/bun.sh tools/release/check-staged-artifacts.mjs --help`,
  `tools/dev/bun.sh tools/release/release_graph_query.mjs wasix-cargo-artifact-contract`,
  `python3 tools/release/check_release_metadata.py`, and
  `python3 tools/release/check_consumer_shape.py --products-json
  '["liboliphaunt-native","liboliphaunt-wasix","oliphaunt-wasix-rust","oliphaunt-rust"]'`.
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
  `tools/dev/bun.sh tools/release/build-sdk-ci-artifacts.mjs oliphaunt-wasix-rust` staged the same
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
  the workflow now invokes `tools/dev/bun.sh tools/graph/ci_plan.mjs` directly, keeping
  the shared planner as the single Bun entrypoint for CI job selection.
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
- `.github/scripts/download-build-artifacts.mjs` now merges duplicate release
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
  The current inventory contains 5 tracked Python files: release orchestration,
  release/package validators, local registry publishing, and the extension
  model generator. New Python files must either be intentionally allowlisted or
  ported to Bun. The current migration order is:
  1. port the remaining release checkers in the release-graph cluster
     (`check_release_metadata.py`, `check_consumer_shape.py`) behind parity
     smokes and then remove their Python compatibility imports;
  2. port `local_registry_publish.py` after artifact package generation and
     release metadata are Bun-native, preserving the local registry e2e path;
  3. port `release.py` last, when the underlying validators and registry helpers
     have Bun entrypoints;
  4. port `src/extensions/tools/check-extension-model.py` as a separate
     generator migration, because it is the canonical multi-language extension
     model and needs generated-output parity across SDKs.
- The local-registry metadata needed by release metadata checks now has a Bun
  helper in `tools/release/local_registry_metadata.mjs`. It exposes the
  local-publish artifact preset and extension manifest discovery/dedupe without
  importing `local_registry_publish.py`, so `check_release_metadata.py` no
  longer depends on another Python module while it awaits its full Bun port.
  The Python local-registry publisher also consumes that helper for those
  metadata decisions, leaving publishing mechanics in Python for now while the
  release graph and manifest-dedupe policy live in Bun.
- While those Python entrypoints remain, policy tooling now keeps Python compile
  bytecode out of source/tool directories. `check-policy-tools.sh` routes
  `py_compile` output through `PYTHONPYCACHEPREFIX` under its temp directory,
  and `check-tooling-stack.sh` rejects source-tree `__pycache__` or `.pyc`
  artifacts outside build output directories.
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
  diffs tied to `tools/release/release_plan.mjs --format json`, and the
  release check command invokes the Bun checker directly.
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
  explicit Python entrypoint inventory.
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
  affected project/task selection, and the graph checker now runs as
  `tools/graph/graph.mjs`. On 2026-06-26, validation passed with the direct Bun
  helper smoke, pull-request-mode `ci_plan.mjs` smoke, graph checks,
  `check-tooling-stack.sh`, `check-repo-structure.sh`,
  `check_artifact_targets.py`, and `check-release-policy.py`.
- Rust helper inventory is machine-checked by
  `tools/policy/check-rust-helper-crates.mjs` and currently limited to
  `tools/xtask` and `tools/perf/runner`. Both remain Rust-owned for now:
  `xtask` owns WASIX asset parsing, archive/hash work, AOT/template
  feature-gated paths, and release workspace assembly; `tools/perf/runner`
  links the Rust SDK/runtime code and database clients for benchmark controls.
  Future Bun migration should target individual release/policy orchestration
  scripts first, not these Rust crates wholesale.
- Helper dead-code discovery now has an active-source mode:
  `tools/dev/bun.sh tools/policy/list-helper-reference-candidates.mjs --max-refs 0 --active-only`
  ignores Markdown/history references and reports scripts with no code, CI, or
  tooling callers. On 2026-06-27 it reported
  `src/runtimes/liboliphaunt/native/bin/check-c-abi-conformance.sh`,
  `src/runtimes/liboliphaunt/native/bin/smoke-macos-happy-path.sh`,
  `tools/dev/install-hooks.sh`, and four policy readiness helpers
  (`check-feature-powerset.sh`, `check-rust-lint.sh`, `check-semver.sh`,
  `check-supply-chain.sh`). The native wrapper pair was then retired in favor
  of the canonical `tools/run-host-c-smoke.mjs --abi-only` and
  `bin/smoke-host-happy-path.sh` entrypoints, with repo-structure guards
  blocking the compatibility names from returning. The developer-hook installer
  and the four policy readiness helpers were ported to Bun entrypoints
  (`install-hooks.mjs`, `check-feature-powerset.mjs`, `check-rust-lint.mjs`,
  `check-semver.mjs`, and `check-supply-chain.mjs`) while preserving their
  command semantics, with the policy wrappers sharing
  `tools/policy/lib/run-command.mjs`. Before the checked allowlist below, a
  fresh active-only scan after these changes still reported the five new Bun
  human/readiness entrypoints because Markdown/docs callers are intentionally
  ignored in that mode.
- Helper dead-code discovery now also has a checked intentional-entrypoint
  allowlist at `tools/policy/helper-entrypoints.allowlist`. The default
  active-source scan hides known human/readiness entrypoints, while
  `--include-allowlisted` still shows them for audit. This keeps the scan useful
  for real removal candidates after manual entrypoints have already been
  reviewed.
- The Android mobile CI disk reclamation helper was ported from
  `.github/scripts/reclaim-android-mobile-build-disk.sh` to
  `.github/scripts/reclaim-android-mobile-build-disk.mjs`; CI now invokes it
  through Bun, and `check-tooling-stack.sh` rejects the retired shell entrypoint.
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
- Publish-step-to-registry-target coverage now comes from the Bun release graph
  through `release_graph_query.mjs publish-step-target-coverage`. `release.py`
  consumes the Python compatibility adapter instead of carrying a duplicate
  table, and `check_release_metadata.py` no longer imports the Python release
  orchestrator just to compare publish target coverage.
- The release metadata checker no longer carries its own Gradle
  `VERSION_NAME` parser or unused Cargo manifest-name reader. Kotlin product
  version parsing stays on the Bun `product-versions` query path, and
  `check_release_metadata.py` guards that the shared Bun parser still handles
  `gradle.properties`.
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
  `pg_ctl`, native `oliphaunt-tools` selects payload artifacts that keep only
  `pg_dump` and `psql`, WASIX root/runtime artifacts keep `postgres` plus
  `initdb`, and `oliphaunt-wasix-tools` plus tools-AOT artifacts keep
  `pg_dump` and `psql` with no WASIX `pg_ctl`. The focused shape checks passed:
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
  verifier. `check_release_versions.mjs` now owns release-version and released
  dependency asset verification directly in Bun. Direct smokes passed for an
  empty selection, `oliphaunt-swift` plus `liboliphaunt-native`, the JS/native
  dependency closure, and the React Native/Swift/Kotlin/native dependency
  closure.
- On 2026-06-26, public release planning moved onto shared Bun graph tooling.
  `release-graph.mjs` owns release-please/Moon graph loading, release ordering,
  path affectedness, and product-tag planning for Bun release helpers.
  `release_plan.mjs` replaced the old Python planner; before the later
  compatibility-command removal, it also backed `tools/release/release.py plan`.
  Parity checks matched the old Python planner for docs-only changed-file JSON,
  release-tool changed-file JSON, and the release workflow
  `--from-product-tags --include-current-tags --format github-output` mode.
- On 2026-06-27, the internal graph and release-policy checkers stopped importing
  the old Python `release_plan.py`. Python callers now consume the shared Bun
  graph through `release_graph_query.mjs`, leaving `release-graph.mjs` as the
  single release-planning authority while those checker clusters are ported.
- On 2026-06-26, native runtime payload optimization moved from Python to Bun.
  `optimize_native_runtime_payload.mjs` now owns pruning, stripping, and
  validation for root runtime payloads and split `oliphaunt-tools` payloads,
  while Python release orchestrators call the Bun CLI and read the shared
  `native-runtime-payload-policy.json` tool split policy. Direct synthetic
  smokes proved runtime mode keeps only `initdb`, `pg_ctl`, and `postgres`,
  tools mode keeps only `pg_dump` and `psql`, and the modified Python callers
  still compile.
- On 2026-06-27, `check-release-policy.py` stopped importing the Python
  `product_metadata.py` compatibility adapter. It now reads product configs,
  extension metadata, and artifact targets directly through
  `release_graph_query.mjs`, and `check_release_metadata.py` guards that the
  policy checker does not reintroduce the adapter while the larger checker
  cluster is being ported.
- On 2026-06-27, `check_artifact_targets.py` also stopped importing
  `product_metadata.py`. It now uses small local wrappers over
  `release_graph_query.mjs` for artifact targets, extension artifact targets,
  SDK package rows, product config paths, Moon release metadata, and current
  versions; the release metadata checker now rejects reintroducing the adapter
  in the artifact-target checker.
