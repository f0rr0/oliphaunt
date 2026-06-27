# Examples, CI, Release, and SDK Validation Tracker

This is the working checklist for validating the registry-first example flow and
the release/tooling surface after the runtime tool crate split.

## P0: Registry-First Example Validation

- [x] Rebuild or stage current local registry artifacts from the active branch.
- [x] Publish local Cargo crates into `target/local-registries/cargo`, including:
  - `liboliphaunt-native-linux-x64-gnu`
  - `oliphaunt-tools`
  - `oliphaunt-tools-linux-x64-gnu`
  - `oliphaunt-broker-linux-x64-gnu`
  - selected native extension crates
  - `liboliphaunt-wasix-portable`
  - `oliphaunt-wasix-tools`
  - host WASIX AOT and tools-AOT crates
  - selected WASIX extension crates and extension-AOT crates
- [x] Publish local npm packages to Verdaccio for root desktop examples.
- [x] Update root examples so their manifests model the registry install path:
  - native Tauri resolves the native `oliphaunt-tools` facade, which selects the target tools payload crate
  - WASIX examples explicitly resolve the WASIX tools and tools-AOT artifact crates
  - product-local WASIX example no longer uses path dependencies
- [x] Exercise tool paths in example code, not only in dependency manifests:
  - native example should execute a flow that requires packaged `pg_dump`
  - WASIX example should execute a flow that requires packaged `pg_dump`
  - WASIX example should execute noninteractive `psql SELECT 1` from `oliphaunt-wasix-tools`
- [x] Run `examples/tools/with-local-registries.sh` installs/builds for each root example.
- [x] Run native and WASIX app smoke flows where available.

## P1: CI and Release Shape

- [ ] Verify CI lanes build and upload the artifact families now expected by examples:
  - native runtime Cargo crates
  - native tools Cargo crates
  - broker Cargo crates
  - WASIX runtime Cargo crates
  - WASIX tools Cargo crates
  - WASIX AOT crates
  - WASIX tools-AOT crates
  - extension runtime/AOT crates
- [x] Verify release dry-runs publish the same package families to local registries.
- [ ] Keep release checks DRY: generation, validation, and publication should share one
      package-family model per ecosystem.
- [x] Make extension Maven registry surfaces explicit in generated extension metadata
      instead of silently appending them during release.
- [x] Derive release workflow artifact downloads and node-direct package dirs from the
      same target graph used by CI.
- [x] Decide whether existing-tag probes are a real idempotency gate or dead workflow
      code.
- [ ] Validate local Linux CI lanes with a local GitHub Actions runner when practical.
- [x] Document local runner limitations instead of pretending macOS, Windows, iOS, or
      Android lanes were validated on Linux.

## P1: SDK Consistency

- [ ] Compare native runtime/tool/extension/ICU resolution across Rust, JS, React
      Native, Swift, and Kotlin.
- [ ] Compare WASIX runtime/tool/AOT/extension/ICU resolution across Rust and JS-facing
      examples.
- [ ] Remove subtle duplicate logic where one SDK has a stronger resolver or validator
      than another.
- [ ] Ensure examples exercise the same control flows the SDKs document.
- [x] Validate Android split/local runtime extension files before generated manifests
      declare the selected extensions.
- [x] Align Deno native runtime/tools/extension resolution with Node/Bun, or document
      and test Deno as intentionally unsupported for registry-managed extensions.
- [x] Port Rust/JS exact-extension archive validation rules into the Android Gradle
      resolver.
- [x] Thread mobile `sharedPreloadLibraries` from manifests into startup args.
- [x] Add an explicit WASIX tools preflight before first `pg_dump` or `psql` use.

## P2: Dead Code and Tooling Cleanup

- [x] Run dead-code scans for Rust, TypeScript, shell, and release scripts.
- [x] Remove generated or stale example build outputs if they are tracked accidentally.
- [x] Identify Python release scripts that can be moved to Bun without losing the
      ecosystem fit or making release behavior harder to validate.
- [x] Identify Rust xtask code that is not performance-sensitive or domain-critical and
      can be moved to Bun without compiling unnecessary crates.
- [x] Keep build/runtime-critical Rust and platform shell where they remain idiomatic.

## Current Evidence

- On 2026-06-27, strict npm local-registry publication was rerun against the
  current split runtime/tools package surface with
  `tools/release/local_registry_publish.py publish --surface npm --strict`.
  The run published/replaced the JS SDK package, native root runtime package,
  split native tools package, ICU package, broker/node-direct packages, and
  native extension package/payload families through Verdaccio. Direct generated
  source inspection confirmed `@oliphaunt/liboliphaunt-linux-x64-gnu` contains
  only `runtime/bin/initdb`, `runtime/bin/pg_ctl`, and `runtime/bin/postgres`,
  while `@oliphaunt/tools-linux-x64-gnu` contains only `runtime/bin/pg_dump`
  and `runtime/bin/psql`.
- On 2026-06-27, Linux-local CI evidence was refreshed from disposable
  worktrees at `71407e43da72449f880bb9044b7f5449bbf7b53c`. `act` v0.2.89,
  Docker 29.5.3, and `act -l` parsed CI, Release, and mobile E2E workflows.
  The PR-shaped `release-intent` job succeeded. The `affected` job completed
  CI planning, emitted the builder job set, and produced `check_count=21`,
  `policy_count=64`, and `test_count=7`, then failed only when
  `actions/upload-artifact@v7` hit the local `act` artifact server with
  `unknown field "mime_type"`. Current upstream `nektos/act` issues document
  the same protocol mismatch, so Linux-local `act` still cannot prove
  downstream artifact-dependent CI jobs without either upstream support or a
  deliberate local-only artifact handoff.
- On 2026-06-27, current local-runner research and local checks still support
  `act` as the pragmatic Linux GitHub Actions runner for this repository:
  the upstream `nektos/act` project describes running workflows locally through
  Docker containers, and its runner docs map GitHub runner labels to local
  images. Fresh local checks passed with `act` v0.2.89: `act -l` parsed the CI,
  Release, and mobile E2E workflows, and
  `act workflow_dispatch -W .github/workflows/ci.yml -j release-intent --dryrun
  -P ubuntu-latest=ghcr.io/catthehacker/ubuntu:act-latest` selected the
  expected Linux CI job. Full Linux lane execution remains open because it
  should run from a committed disposable worktree, while macOS, Windows, iOS,
  and Android device/simulator lanes remain outside what a Linux-local `act`
  run proves.
- On 2026-06-27, the P2 helper/dead-code tooling pass was refreshed. The
  helper scanner now counts stable path-suffix references in addition to
  full-path and basename references, so nested tools such as
  `src/docs/tools/check-fumadocs-source.mjs` are not treated as weaker
  candidates merely because callers use a shorter repository-local suffix.
  Fresh scans reported no unreferenced helper entrypoints with
  `tools/dev/bun.sh tools/policy/list-helper-reference-candidates.mjs
  --max-refs 0`, and the tracked-file sweep found no accidentally tracked
  generated example output directories; the tracked lockfiles and
  `coverage/baseline.toml` are intentional policy inputs.
- On 2026-06-27, the remaining Python and Rust helper inventories were
  rechecked. `tools/dev/bun.sh tools/policy/check-python-entrypoints.mjs --list`
  verified the nine remaining Python tooling files, all deferred release,
  local-registry, WASIX-packager, or extension-modeling ports rather than
  low-risk wrappers. `tools/dev/bun.sh
  tools/policy/check-rust-helper-crates.mjs --list` verified the only Rust
  helper crates are `tools/perf/runner` and `tools/xtask`, both retained as
  domain tools.
- On 2026-06-27, the Python release compatibility layer was narrowed further.
  `tools/release/product_metadata.py` no longer parses
  `release-please-config.json` for version files, changelog paths, or tag
  prefixes, and its extension-target lookup now uses the same cached Bun
  `release_graph_query.mjs` helper as other artifact target reads. The tracked
  Python inventory remains nine files, with `product_metadata.py` reduced to
  987 lines. Fresh checks passed for Python compile, release graph output,
  targeted product metadata reads, release metadata, artifact targets, focused
  consumer-shape checks, release policy, tooling-stack policy,
  `tools/release/release.py check`, strict local Cargo publication, strict
  local npm publication, docs policy, and `git diff --check`.
- On 2026-06-27, the stale direct `tools/release/product_metadata.py version`
  CLI was retired. Product version reads remain on the Bun helper
  `tools/release/product-version.mjs`, and direct execution of
  `product_metadata.py` now fails with module-only guidance instead of exposing
  a second version-read path. Fresh validation passed for the Bun version
  helper, the expected failing Python guidance path, Python compile, tooling
  inventory, policy tooling, docs, `tools/release/release.py check`, and strict
  local Cargo/npm publication. A sweep of 836 generated `.crate` files found no
  crate above the 10 MiB crates.io limit; the largest observed crate was
  10,212,312 bytes.
- On 2026-06-27, strict local Cargo and npm publication were rerun against the
  current split runtime/tools package surface with
  `tools/release/local_registry_publish.py publish --surface cargo --strict`
  and `tools/release/local_registry_publish.py publish --surface npm --strict`.
  A generated crate sweep over `target/local-registries` found no `.crate`
  above the 10 MiB crates.io limit.
- Native Linux x64 Cargo artifact generation now emits split payloads:
  `liboliphaunt-native-linux-x64-gnu-part-000` through `part-006` contain the
  root runtime, and `oliphaunt-tools-linux-x64-gnu-part-000` contains
  `pg_dump` and `psql`. The generated `.crate` files are all below 10 MiB.
- Generated root native payload content has `postgres`, `initdb`, and `pg_ctl`
  only; `pg_dump` and `psql` are present only in `oliphaunt-tools-*`.
- The small liboliphaunt release fixture now models all five native desktop
  PostgreSQL binaries, so fixture packaging verifies that
  `liboliphaunt-native-*` part crates keep only `initdb`, `pg_ctl`, and
  `postgres`, while the `oliphaunt-tools` facade selects `oliphaunt-tools-*`
  part crates that keep `pg_dump` and `psql`.
  Consumer-shape checks now enforce that generator contract.
- The local Cargo registry was refreshed from the split artifacts. The native
  Tauri example regenerated its lockfile through `examples/tools/with-local-registries.sh`,
  `cargo check` passed, and `startup_smoke_runs_sql_dump` passed through packaged
  `pg_dump`.
- JS package-manager shape now mirrors Rust: `@oliphaunt/liboliphaunt-*`
  packages carry the root native runtime, while `@oliphaunt/tools-*` packages
  carry `pg_dump` and `psql`. `@oliphaunt/ts` keeps the user install path
  unchanged by selecting both package families as optional dependencies.
- WASIX portable assets were rebuilt with the runtime root limited to
  `postgres` and `initdb`; `pg_ctl` is not bundled for WASIX, and `pg_dump` plus
  `psql` are split into standalone tool payloads.
- Release validation now checks the nested WASIX runtime archive for
  `postgres` and `initdb`, and fails if `pg_ctl`, `pg_dump`, or `psql` are
  present there.
- WASIX Cargo artifact generation now emits `liboliphaunt-wasix-portable`,
  `oliphaunt-wasix-tools`, per-target `liboliphaunt-wasix-aot-*`, and
  per-target `oliphaunt-wasix-tools-aot-*` crates. The root portable crate,
  tools crate, ICU crate, WASIX extension crates, and AOT crates are all below
  the 10 MiB crates.io package limit in the local generated artifact set.
- The local Cargo publisher now ignores legacy `oliphaunt-wasix-assets` and
  old `oliphaunt-wasix-aot-*` artifact crates in non-strict mode, and rejects
  them in strict mode so local registries expose the new split package surface.
- Strict local Cargo publishing also fails when WASIX runtime/tools-AOT artifact
  crates are missing, while non-strict pruning removes matching optional
  feature deps from generated source crates to avoid invalid manifests.
- Cargo example checks passed through `examples/tools/with-local-registries.sh`
  for native Tauri, Electron WASIX, Tauri WASIX, and the nested WASIX SQLx
  Tauri example. The WASIX example lockfiles now pin the new
  `oliphaunt-wasix-tools` and `oliphaunt-wasix-tools-aot-*` registry packages.
- On 2026-06-26, local registry publication was rerun with explicit artifact
  roots for native runtime/tools Cargo crates, broker crates, WASIX
  runtime/tools/AOT crates, extension package artifacts, the JS SDK package,
  and the linux x64 node-direct package. Strict Cargo and npm publication
  completed against `target/local-registries`.
- On 2026-06-26, `examples/tools/with-local-registries.sh` frontend installs
  and builds passed for `examples/electron`, `examples/electron-wasix`,
  `examples/tauri`, `examples/tauri-wasix`, and
  `src/bindings/wasix-rust/examples/tauri-sqlx-vanilla`.
- On 2026-06-26, root desktop GUI smokes passed:
  `examples/tools/run-electron-driver-smoke.sh examples/electron`,
  `examples/tools/run-electron-driver-smoke.sh examples/electron-wasix`,
  `examples/tools/run-tauri-webdriver-smoke.sh examples/tauri`, and
  `examples/tools/run-tauri-webdriver-smoke.sh examples/tauri-wasix`.
- On 2026-06-26, the nested WASIX SQLx Tauri profiler was switched to the
  default TCP `OliphauntServer` path so its local-registry smoke executes
  `preflight_tools`, `pg_dump --schema-only`, and noninteractive `psql SELECT 1`
  instead of skipping tool execution on Unix socket runs.
- The validating command passed:
  `examples/tools/with-local-registries.sh cargo run --manifest-path src/bindings/wasix-rust/examples/tauri-sqlx-vanilla/src-tauri/Cargo.toml --bin profile_queries -- --fresh --rows 10 --json-out target/oliphaunt-wasix-rust/examples/tauri-sqlx-vanilla/profile-smoke.json`.
- The nested WASIX SQLx Tauri example check now keeps normal CI on
  `pnpm install --frozen-lockfile` but switches to `--no-frozen-lockfile` when
  `examples/tools/with-local-registries.sh` has disabled pnpm lockfile reads to
  avoid stale same-version local tarball integrity.
- Electron GUI smoke checks passed through
  `examples/tools/run-electron-driver-smoke.sh examples/electron` and
  `examples/tools/run-electron-driver-smoke.sh examples/electron-wasix`.
  Native Electron exercises the published `@oliphaunt/liboliphaunt-*`,
  `@oliphaunt/tools-*`, and extension packages through `@oliphaunt/ts`; WASIX
  Electron exercises the local Cargo registry sidecar with WASIX tools and
  extension crates.
- Release and asset guards passed for `xtask assets check --strict-generated`,
  `check_consumer_shape.py`, and `check_artifact_targets.py`. Native tools are
  modeled as derived registry package targets from the native runtime release
  archive, not as standalone GitHub release assets.
- Release PR derived-file sync now passes after refreshing the WASIX asset input
  fingerprint and extension evidence source digests. `tools/release/release.py
  check` passes through policy, release-please config, artifact targets,
  release metadata, and consumer-shape readiness for the current package set.
- Exact-extension `release.toml` metadata now declares `maven-central` and the
  Android Maven package coordinates explicitly. The release metadata and
  consumer-shape checks enforce that those package names match the generated
  Android extension target graph instead of relying on hidden release-time
  synthesis.
- Release workflow native helper downloads, Node direct optional package
  downloads, the local-registry download preset, and Node direct package-dir
  validation now derive artifact/package names from `artifact_targets` instead
  of copying the platform target list.
- The local-registry `local-publish` preset now derives WASIX AOT runtime
  artifact names from release target metadata as well, and rejects duplicate
  artifact names. The preset currently resolves 35 unique CI artifacts for local
  publish staging.
- Dead existing-tag workflow probes were removed; rerun idempotency remains in
  the publish handlers that own the actual registry or GitHub publication step.
- TypeScript optional runtime package validation and release PR sync now share
  the `artifact_targets` package map for broker, native runtime/tools, and
  node-direct optional packages.
- Consumer-shape registry package checks for `liboliphaunt-native` and
  `oliphaunt-broker` now derive platform target membership and npm package
  names from `artifact_targets`.
- WASIX Cargo artifact checks now derive the public portable runtime, tools,
  ICU, root AOT, and tools-AOT package family from the WASIX Cargo packager
  helper used by release publication. The same helper drives the WASIX target
  AOT Cargo dependency maps and the `oliphaunt-wasix` `tools` feature
  expectations in release metadata and consumer-shape checks.
- SDK package artifact names now derive from release products with
  `kind = "sdk"`. Release downloads and local registry publication ask
  `release.py ci-artifacts --family sdk-package` for the artifact name, and
  the WASIX Rust binding uses the same SDK release kind as the other SDKs.
- Local GitHub Actions discovery is ready on Linux: `act` v0.2.89, Docker, and
  `gh` are installed, and `act -l` parses the CI, Release, and mobile E2E
  workflows. `act workflow_dispatch -W .github/workflows/ci.yml -j release-intent
  --dryrun -P ubuntu-latest=ghcr.io/catthehacker/ubuntu:act-latest` selects the
  expected Linux CI job. Full local lane execution should run from a committed
  disposable worktree because `actions/checkout` validates committed HEAD, not
  uncommitted edits.
- CI/release DRY audit still needs a pass over broader workflow topology string
  checks to separate legitimate job-shape assertions from remaining copied
  package-surface contracts.
- Android split/local runtime packaging now rejects selected extensions missing
  control or versioned SQL files in the copied runtime tree before manifests
  declare them. The public Android Gradle resolver performs the same check
  after Maven exact-extension runtime artifacts are merged. Release metadata
  and consumer-shape checks now enforce that the resolver extracts the selected
  Maven artifact, merges its `files/` payload, and validates both the selected
  `.control` file and versioned SQL files before updating generated manifests.
- On 2026-06-26,
  `examples/tools/with-local-registries.sh bash src/sdks/react-native/tools/check-sdk.sh build-android-bridge`
  passed with the checked-in Gradle wrapper. The lane covers split runtime,
  prebuilt runtime resources, selected-extension missing-SQL failures, Android
  static extension link evidence, unit tests, and lint.
- Swift runtime-resource package-kind rejection is covered by an executable
  `@Test`, and release metadata plus consumer-shape checks require that
  annotation to remain present.
- Mobile native-direct startup now passes packaged runtime
  `sharedPreloadLibraries` through to `shared_preload_libraries=...` startup
  args in Kotlin Android/React Native Android and Swift/React Native iOS.
  Kotlin static/unit checks, mobile extension policy checks, and release checks
  passed locally; Swift-specific test execution was not run because this Linux
  host does not have a Swift toolchain.
- A read-only SDK parity audit found these remaining issues: broader SDK
  resolver/control-flow parity still needs a full pass, and any remaining
  prose-only invariants should gain policy checks.
- Deno nativeDirect is now documented and tested as intentionally unsupported
  for registry-managed extension materialization without an explicit prepared
  `runtimeDirectory`; release metadata checks require the guard and test.
- Local-registry native extension Cargo packaging now deduplicates
  `extension-artifacts.json` rows by product/version/sql name before generating
  crates. This keeps downloaded local-registry artifacts and canonical
  `target/extension-artifacts` outputs from triggering duplicate packaging work;
  a targeted smoke found 39 unique extension manifests and generated 54 unique
  native extension crates, including the PostGIS aggregator plus 15 part crates.
