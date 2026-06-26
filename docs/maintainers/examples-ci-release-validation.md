# Examples, CI, Release, and SDK Validation Tracker

This is the working checklist for validating the registry-first example flow and
the release/tooling surface after the runtime tool crate split.

## P0: Registry-First Example Validation

- [x] Rebuild or stage current local registry artifacts from the active branch.
- [x] Publish local Cargo crates into `target/local-registries/cargo`, including:
  - `liboliphaunt-native-linux-x64-gnu`
  - `oliphaunt-tools-linux-x64-gnu`
  - `oliphaunt-broker-linux-x64-gnu`
  - selected native extension crates
  - `liboliphaunt-wasix-portable`
  - `oliphaunt-wasix-tools`
  - host WASIX AOT and tools-AOT crates
  - selected WASIX extension crates and extension-AOT crates
- [x] Publish local npm packages to Verdaccio for root desktop examples.
- [x] Update root examples so their manifests model the registry install path:
  - native Tauri explicitly resolves the native tools artifact crate
  - WASIX examples explicitly resolve the WASIX tools and tools-AOT artifact crates
  - product-local WASIX example no longer uses path dependencies
- [x] Exercise tool paths in example code, not only in dependency manifests:
  - native example should execute a flow that requires packaged `pg_dump`
  - WASIX example should execute a flow that requires packaged `pg_dump`
  - WASIX example should compile with `psql` available from `oliphaunt-wasix-tools`
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
- [ ] Document local runner limitations instead of pretending macOS, Windows, iOS, or
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
- [ ] Align Deno native runtime/tools/extension resolution with Node/Bun, or document
      and test Deno as intentionally unsupported for registry-managed extensions.
- [ ] Port Rust/JS exact-extension archive validation rules into the Android Gradle
      resolver.
- [x] Thread mobile `sharedPreloadLibraries` from manifests into startup args.
- [x] Add an explicit WASIX tools preflight before first `pg_dump` or `psql` use.

## P2: Dead Code and Tooling Cleanup

- [ ] Run dead-code scans for Rust, TypeScript, shell, and release scripts.
- [ ] Remove generated or stale example build outputs if they are tracked accidentally.
- [ ] Identify Python release scripts that can be moved to Bun without losing the
      ecosystem fit or making release behavior harder to validate.
- [ ] Identify Rust xtask code that is not performance-sensitive or domain-critical and
      can be moved to Bun without compiling unnecessary crates.
- [ ] Keep build/runtime-critical Rust and platform shell where they remain idiomatic.

## Current Evidence

- Native Linux x64 Cargo artifact generation now emits split payloads:
  `liboliphaunt-native-linux-x64-gnu-part-000` through `part-006` contain the
  root runtime, and `oliphaunt-tools-linux-x64-gnu-part-000` contains
  `pg_dump` and `psql`. The generated `.crate` files are all below 10 MiB.
- Generated root native payload content has `postgres`, `initdb`, and `pg_ctl`
  only; `pg_dump` and `psql` are present only in `oliphaunt-tools-*`.
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
- WASIX Cargo artifact generation now emits `liboliphaunt-wasix-portable`,
  `oliphaunt-wasix-tools`, per-target `liboliphaunt-wasix-aot-*`, and
  per-target `oliphaunt-wasix-tools-aot-*` crates. The root portable crate,
  tools crate, ICU crate, WASIX extension crates, and AOT crates are all below
  the 10 MiB crates.io package limit in the local generated artifact set.
- The local Cargo publisher now ignores legacy `oliphaunt-wasix-assets` and
  old `oliphaunt-wasix-aot-*` artifact crates when stale target directories are
  present, so local registries expose the new split package surface.
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
- Dead existing-tag workflow probes were removed; rerun idempotency remains in
  the publish handlers that own the actual registry or GitHub publication step.
- TypeScript optional runtime package validation and release PR sync now share
  the `artifact_targets` package map for broker, native runtime/tools, and
  node-direct optional packages.
- Consumer-shape registry package checks for `liboliphaunt-native` and
  `oliphaunt-broker` now derive platform target membership and npm package
  names from `artifact_targets`.
- Local GitHub Actions discovery is ready on Linux: `act` v0.2.89, Docker, and
  `gh` are installed, and `act -l` parses the CI, Release, and mobile E2E
  workflows. `act workflow_dispatch -W .github/workflows/ci.yml -j release-intent
  --dryrun -P ubuntu-latest=ghcr.io/catthehacker/ubuntu:act-latest` selects the
  expected Linux CI job. Full local lane execution should run from a committed
  disposable worktree because `actions/checkout` validates committed HEAD, not
  uncommitted edits.
- A read-only CI/release audit found this remaining issue: some policy checks
  compare copied literals instead of generated package contracts.
- Android split/local runtime packaging now rejects selected extensions missing
  control or versioned SQL files in the copied runtime tree before manifests
  declare them. The public Android Gradle resolver performs the same check
  after Maven exact-extension runtime artifacts are merged.
- Mobile native-direct startup now passes packaged runtime
  `sharedPreloadLibraries` through to `shared_preload_libraries=...` startup
  args in Kotlin Android/React Native Android and Swift/React Native iOS.
  Kotlin static/unit checks, mobile extension policy checks, and release checks
  passed locally; Swift-specific test execution was not run because this Linux
  host does not have a Swift toolchain.
- A read-only SDK parity audit found these next issues: Deno native resolution
  does not follow Node/Bun tools and extension materialization, Android Maven
  extension validation is weaker than Rust/JS, and WASIX split tools are only
  validated lazily.
