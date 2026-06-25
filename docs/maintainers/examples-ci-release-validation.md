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
- [ ] Publish local npm packages to Verdaccio for root desktop examples.
- [x] Update root examples so their manifests model the registry install path:
  - native Tauri explicitly resolves the native tools artifact crate
  - WASIX examples explicitly resolve the WASIX tools and tools-AOT artifact crates
  - product-local WASIX example no longer uses path dependencies
- [ ] Exercise tool paths in example code, not only in dependency manifests:
  - native example should execute a flow that requires packaged `pg_dump`
  - WASIX example should execute a flow that requires packaged `pg_dump`
  - WASIX example should compile with `psql` available from `oliphaunt-wasix-tools`
- [x] Run `examples/tools/with-local-registries.sh` installs/builds for each root example.
- [ ] Run native and WASIX app smoke flows where available.

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
- Release and asset guards passed for `xtask assets check --strict-generated`,
  `check_consumer_shape.py`, and `check_artifact_targets.py`. Native tools are
  modeled as derived registry package targets from the native runtime release
  archive, not as standalone GitHub release assets.
