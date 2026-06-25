# Examples, CI, Release, and SDK Validation Tracker

This is the working checklist for validating the registry-first example flow and
the release/tooling surface after the runtime tool crate split.

## P0: Registry-First Example Validation

- [ ] Rebuild or stage current local registry artifacts from the active branch.
- [ ] Publish local Cargo crates into `target/local-registries/cargo`, including:
  - `liboliphaunt-native-linux-x64-gnu`
  - `oliphaunt-tools-linux-x64-gnu`
  - `oliphaunt-broker-linux-x64-gnu`
  - selected native extension crates
  - `liboliphaunt-wasix-portable`
  - `oliphaunt-wasix-tools`
  - host WASIX AOT and tools-AOT crates
  - selected WASIX extension crates and extension-AOT crates
- [ ] Publish local npm packages to Verdaccio for root desktop examples.
- [ ] Update root examples so their manifests model the registry install path:
  - native Tauri explicitly resolves the native tools artifact crate
  - WASIX examples explicitly resolve the WASIX tools and tools-AOT artifact crates
  - product-local WASIX example no longer uses path dependencies
- [ ] Exercise tool paths in example code, not only in dependency manifests:
  - native example should execute a flow that requires packaged `pg_dump`
  - WASIX example should execute a flow that requires packaged `pg_dump`
  - WASIX example should compile with `psql` available from `oliphaunt-wasix-tools`
- [ ] Run `examples/tools/with-local-registries.sh` installs/builds for each root example.
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
- [ ] Verify release dry-runs publish the same package families to local registries.
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
- Current local WASIX release assets are stale: the new WASIX packager rejects
  them because `oliphaunt.wasix.tar.zst` still contains `oliphaunt/bin/pg_dump`.
  A fresh WASIX release asset build is required before WASIX example e2e can be
  claimed.
