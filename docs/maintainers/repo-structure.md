# Repository Structure

This repository is organized as a multi-product workspace, not as one Rust crate
with adjacent experiments.

## Evidence

- Cargo supports a virtual workspace when the root `Cargo.toml` has
  `[workspace]` and no `[package]`. Cargo documents this as useful when there
  is no primary package or packages should be kept in separate directories:
  https://doc.rust-lang.org/cargo/reference/workspaces.html
- Cargo workspaces share one lockfile and one target directory, which keeps
  cross-crate Rust development coherent while letting each package own its own
  manifest and public boundary:
  https://doc.rust-lang.org/cargo/reference/workspaces.html
- Swift Package Manager expects each package to own a `Package.swift`, products,
  targets, and target-scoped resources. The Swift SDK therefore lives under
  `src/sdks/swift` as a normal Swift package instead of as ad hoc root files:
  https://docs.swift.org/package-manager/PackageDescription/PackageDescription.html
- Gradle's multi-project model uses a root build plus isolated subprojects
  declared from settings, which maps to the Kotlin/Android SDK under
  `src/sdks/kotlin`:
  https://docs.gradle.org/current/userguide/multi_project_builds.html
- moon provides the product graph, affected-CI selection, and task discovery.
  It does not replace package-native tools; Cargo, SwiftPM/Xcode, Gradle,
  pnpm/Expo, PostgreSQL build scripts, and shell harnesses remain authoritative:
  https://moonrepo.dev/docs

## Top-Level Policy

The repository root should contain shared metadata and entrypoints only. Product
source lives under `src/<product>/`.

- `src/runtimes/liboliphaunt/native/` owns the C ABI and PostgreSQL patch stack.
- `src/sdks/rust/` owns the Rust SDK and Cargo package.
- `src/sdks/swift/`, `src/sdks/kotlin/`,
  `src/sdks/react-native/`, and `src/sdks/js/` own platform and
  runtime SDKs.
- `src/bindings/wasix-rust/` owns the released Rust WASIX binding.
- `src/bindings/wasix-ts/` owns the public browser, Node, Bun, Deno, and Electron WASIX TypeScript
  binding and its optional `tools-package/` `pg_dump`/`psql` facade. It is a
  peer binding, not part of the native TypeScript SDK; portable program bytes
  remain owned by `liboliphaunt-wasix`.
- `src/runtimes/liboliphaunt/wasix-postmaster/` owns the released concurrent
  PostgreSQL postmaster runtime and its sealed WASIX backend carrier. It reuses
  canonical source and toolchain inputs where semantics agree, while owning
  its concurrency-specific patches, carrier, release metadata, and support
  claims.
- `src/*/moon.yml` is the canonical product graph. `tools/policy/sdk-manifest.toml`
  is a small SDK parity ownership registry and must agree with Moon metadata.
- Tooling lives under `tools/`.
- Benchmarks live under `benchmarks/`.
- `src/docs/` is the public documentation product. It owns public SDK
  docs under `src/docs/content/sdk`, generated matrices, tested
  snippets, API-reference stubs, and LLM docs rendered into
  `target/docs`.
- Cross-product architecture, performance, release, and maintainer source docs
  live under `docs/`.
- Shared fixture corpora consumed by at least two product-native test suites
  live under `src/shared/fixtures/`.
- Pinned PostgreSQL source metadata, runtime-level third-party source pins,
  toolchain pins, extension-owned source pins, and generated extension catalogs
  live under `src/postgres/versions/18`, `src/sources/third-party`,
  `src/sources/toolchains`, and `src/extensions`.
- Postmaster-specific Wasmer and wasix-libc pins live under
  `src/sources/third-party/wasix-postmaster/`. The default `production-all`
  source scope includes every released product input; the focused
  `wasix-postmaster-runtime` scope acquires only this product's runtime inputs.

There should be no tracked product source under retired roots such as
`crates/`, `sdks/`, root `liboliphaunt/`, or root product examples.

Tests, fixtures, and benchmarks follow the consumer surface instead of a single
synthetic root:

- Product-native tests live in each product's package-native test root:
  `src/sdks/rust/tests/`, `src/sdks/swift/Tests/`,
  `src/sdks/kotlin/oliphaunt/src/*Test/`,
  `src/sdks/react-native/src/__tests__/`,
  `src/sdks/js/src/__tests__/`, and
  `src/bindings/wasix-rust/crates/oliphaunt-wasix/tests/`, plus
  `src/bindings/wasix-ts/src/__tests__/` for the WASIX TypeScript binding, and
  `src/bindings/wasix-ts/tools-package/src/__tests__/` for its optional tools facade.
- Rust SDK tests are split by contract: deliberate public vocabulary stays in
  `src/sdks/rust/tests/public_api.rs`, native-environment smokes stay in
  `src/sdks/rust/tests/native_smoke.rs`, and extension coverage stays in
  `src/sdks/rust/tests/native_extensions.rs` and
  `src/sdks/rust/tests/sdk_extensions.rs`.
- Product-private fixtures stay beside those tests. Shared fixtures move to
  `src/shared/fixtures/` only when the contract is consumed by multiple
  products, or when a product-specific boundary fixture needs central policy
  enforcement. `src/shared/fixtures/protocol/query-response-cases.json` is the
  current shared PostgreSQL backend-response corpus consumed from product-native
  Rust, Swift, Kotlin, TypeScript, React Native, and WASIX query-decoding tests.
- Benchmark plans, datasets, and published reports live in `benchmarks/`.
  Executable benchmark harnesses live in `tools/perf/` unless the harness is a
  deliberate product API.

## Product Boundaries

- `liboliphaunt` is the native C boundary. It owns PostgreSQL source pins, patches,
  exported headers, and native build harnesses.
- `src/sdks/rust` is the Rust-native SDK for Tauri and Rust desktop
  apps. It should depend on `liboliphaunt` artifacts through explicit
  runtime/build configuration, not on `oliphaunt-wasix` internals.
- `docs/maintainers/rust-sdk-policy.md` is the Rust SDK policy entrypoint. The package
  source, tests, and release metadata live in `src/sdks/rust`.
- `src/bindings/wasix-rust/crates/oliphaunt-wasix` is the existing WASIX package. It stays intact as a
  release lane and comparison target. It should not expose native engine
  selection or link/load `liboliphaunt`; native Rust work belongs in
  `src/sdks/rust`.
- `src/bindings/wasix-ts` is the public browser, Node, Bun, Deno, and Electron
  binding over the same portable WASIX runtime. It owns browser module Workers,
  native-host Rust actor/direct/Worker placement, archive-to-memory mounts,
  the patched package-relative browser Wasmer host, and the direct pgwire
  client. It must not depend on `src/sdks/js`, native runtime carriers other
  than its exact WASIX Node-API carriers, Node direct, or the broker. Conditional
  exports select the browser or native host without changing package identity.
- `src/runtimes/liboliphaunt/wasix-postmaster` is a peer release product, not an
  implementation directory of `liboliphaunt-wasix`. It owns a distinct Moon
  release component and sealed carrier because its concurrent process and
  shared-memory semantics differ from the single-backend runtime. Generated
  checkouts, builds, carriers, caches, and reports stay under
  `target/oliphaunt-wasix-postmaster/`.
- `src/runtimes/liboliphaunt/wasix/assets/build` is source-only: scripts, patches,
  Docker inputs, and shims. Generated WASIX build and work trees live under
  `target/oliphaunt-wasix/wasix-build`.
- `src/sdks/swift` is a normal Swift package for iOS and macOS apps. It owns
  `Oliphaunt`, a C header target, and Swift tests.
- `src/sdks/kotlin` is a Gradle multi-project build for the Android SDK. It owns
  the common suspend implementation, JVM contract tests, Android wrapper, and
  Android runtime tests; only its Android AAR/plugin/ABI surfaces are published.
- `src/sdks/react-native` is a React Native New Architecture package. It owns the
  TypeScript DX layer and TurboModule Codegen spec. Platform runtime behavior
  belongs to the Swift and Kotlin SDKs; React Native native code should be
  adapter glue, not a parallel PostgreSQL lifecycle implementation.
- `src/sdks/js` is the SDK for Node.js, Bun, and Deno. Tauri apps currently
  use the Rust SDK behind narrow app-owned commands. The TypeScript SDK owns
  JavaScript runtime FFI adapters, npm package metadata, and
  broker/server client orchestration. Its broker implementation depends on the
  published `oliphaunt-broker` runtime and the shared `PGOB` protocol,
  so that dependency must remain modeled in Moon and product-local release
  metadata.

Native SDKs are product peers over the native `liboliphaunt` PostgreSQL
boundary. Rust WASIX and WASIX TypeScript are peers over the separate portable
WASIX runtime boundary. All should have parity wherever their target can
support behavior honestly; gaps must be explicit and justified in
`docs/maintainers/sdk-parity-policy.md`.

## Internal Organization Rules

- Product bindings own their own host code. Rust WASIX may consume Cargo WASIX
  asset crates and WASIX TypeScript may consume the generated host-neutral
  portable runtime carrier plus separately selected WASIX extension npm leaves;
  `oliphaunt` may load `liboliphaunt`. None should call another public
  product's private modules.
- `tools/policy/check-native-boundaries.sh` enforces the native/WASIX split:
  the Rust-native SDK and Swift/Kotlin/React Native package manifests must not
  depend on `oliphaunt-wasix`, WASIX AOT payload crates, or Wasmer runtime
  packages.
- `tools/xtask` is shared repo automation for WASIX assets, release staging,
  and optional performance diagnostics. Its default feature set is intentionally
  empty; template running and AOT serializers must be enabled with explicit
  feature flags.
- `tools/xtask/src/main.rs` is the command router plus shared helpers. WASIX
  asset build, packaging, generated manifest, AOT packaging, and staged metadata
  orchestration lives in `tools/xtask/src/asset_pipeline.rs`. Source-controlled
  asset verification, canonical generated-asset layout checks, AOT target
  catalog checks, and upstream-fix audits live in
  `tools/xtask/src/asset_checks.rs`. Generated asset manifest DTOs, AOT
  manifest DTOs, asset packaging descriptors, and WASM link-metadata parsing
  live in
  `tools/xtask/src/asset_manifest.rs`. Asset download/install code lives in
  `tools/xtask/src/asset_io.rs`, shared filesystem/archive/hash helpers live in
  `tools/xtask/src/fs_utils.rs`,
  release workspace assembly lives in `tools/xtask/src/release_workspace.rs`,
  source-pin and source-spine handling lives in
  `tools/xtask/src/source_spine.rs`, PostgreSQL source/patch-surface guards
  live in `tools/xtask/src/postgres_guard.rs`, cluster-seed execution lives in
  `tools/xtask/src/cluster_seed_runner.rs`, and AOT serialization lives in
  `tools/xtask/src/aot_serializer.rs`. Performance benchmark workload/result
  construction lives in `tools/perf/runner/src/benchmarks.rs`, and report DTOs
  live in `tools/perf/runner/src/report.rs`. Native liboliphaunt execution,
  child-process entrypoints, and SDK-backed diagnostics live in
  `tools/perf/runner/src/native_liboliphaunt.rs`. Native PostgreSQL process,
  protocol, and backup/restore controls live in
  `tools/perf/runner/src/native_postgres.rs`. Prepared-update benchmark
  parsing, transport variants, gates, and native comparison live in
  `tools/perf/runner/src/prepared_updates.rs`. Indexed-update, speed-hotspot,
  and buffer-cache diagnostics live in `tools/perf/runner/src/diagnostics.rs`.
  Benchmark execution should continue to split under `tools/perf/runner/src/`
  by collection, aggregation, transport family, diagnostics, and report
  rendering.
- Native C ABI concerns are split by layer:
  - `src/runtimes/liboliphaunt/native/` for C, PostgreSQL patches, and platform build scripts.
  - `src/sdks/rust/src/liboliphaunt/ffi.rs` for Rust symbol loading and
    ABI structs.
  - `src/sdks/rust/src/liboliphaunt/root.rs` for native root locking,
    runtime materialization, and opt-in extension asset copying.
  - `src/sdks/rust/src/liboliphaunt/root/runtime/` for runtime installation and
    discovery.
  - `src/sdks/rust/src/liboliphaunt/mod.rs` for the Rust runtime/session
    implementation.
- Native runtime-resource packaging is maintainer-only and split by release
  artifact concern under the unpublished `oliphaunt-native-packaging` tool:
  - `tools/native-packaging/src/lib.rs` for resource package orchestration and
    selected extension resolution.
  - `tools/native-packaging/src/manifest.rs` for portable
    manifest parsing, identifier validation, and runtime artifact path rules.
  - `tools/native-packaging/src/package.rs` for resource-tree
    writing, portable tree copying, package manifests, and size reports.
  - `tools/native-packaging/src/extension_artifact.rs` for exact
    prebuilt extension artifact creation, archive extraction, and artifact
    manifest writing.
  - `tools/native-packaging/src/extension_index.rs` for external
    extension artifact index creation, resolution, signing, download, and
    checksum verification.
  - `tools/native-packaging/src/static_registry.rs` for iOS and
    Android static extension registry metadata, generated C source, and mobile
    static archive staging.
- WASIX runtime internals should keep VM orchestration separate from
  reusable host adapters:
  - `src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/base.rs` for
    install/root preparation, runtime layout selection, archive validation, and
    cluster-seed orchestration.
  - `src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/base/cluster_seed_clone.rs`
    for cluster-seed copy/clone mechanics, runtime-state exclusion, reflink
    fallback, and symlink handling.
  - `src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/postgres_mod.rs`
    for PostgreSQL WASIX module lifecycle, exported function wiring, startup
    protocol, and split-initdb command orchestration.
  - `src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/postgres_mod/stdio.rs`
    for WASIX virtual stdio adapters, protocol stream attachment, and bounded
    process-output capture.
  - `src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/postgres_mod/wasix_fs.rs`
    for host filesystem wrapping and `/dev` mounting. Persistent PGDATA is a
    standalone managed directory; only immutable runtime files may be shared
    through the runtime cache.
- Public runtime and build controls should use `OLIPHAUNT_*`. Use
  `LIBOLIPHAUNT_PATH` only for the literal native C library artifact path.
- Large files should have a reason. Once a module mixes lifecycle, packaging,
  protocol, and CLI orchestration, split it along those responsibilities before
  adding more behavior.

## Tooling Rules

- `.moon/` owns product graph, affected task selection, and shared toolchain
  pins. Do not duplicate release dependency rules in ad hoc scripts when moon
  metadata can express them.
- `package.json` owns JavaScript workspace metadata only. Do not add root
  workflow aliases; run product and repo work through Moon targets directly.
- Release Please owns product versions, changelogs, and the generated release
  PR. Bun release entrypoints under `tools/release/*.mjs` own the public and
  protected check, dry-run, publish, exact-SHA tag, and draft-release command
  surface.
- Cargo publication runs through `tools/dev/bun.sh
  tools/release/release-publish.mjs publish` in the protected Release workflow.
  Release packaging freezes each `.crate`, and the exact-byte registry uploader
  sends that lock-matching file through crates.io's Registry Web API. Do not
  replace it with `cargo publish`, which would repackage the source and break
  the frozen-byte contract, or add a Rust-only release orchestrator beside
  Release Please.
- `tools/xtask` owns Rust-heavy automation and release asset orchestration.
- `tools/policy`, `tools/dev`, `tools/perf`, and `tools/release` own
  shell/Python/Node entrypoints by responsibility. CI is thin workflow
  orchestration over Moon tasks and the release CLI.
- `sdk-contracts:check` owns generated API, SDK registry, C ABI header-copy,
  native-boundary, and README-example contracts. The small
  `tools/policy/check-sdk-parity.sh` entry point is a local convenience
  aggregate. Exact extension catalogs belong to `extension-model:check`, while
  SDK behavior, React Native delegation, package contents, and installed-app
  evidence belong to product-local Moon tasks. Stable CI does not infer those
  contracts from prose, test names, or implementation-source spellings.
- `prek` owns Git hooks as a language-neutral runner for whitespace, format,
  and commit-message guards. Heavy asset, lockfile, and workspace checks belong
  in Moon tasks, product-local tools, release CLI subcommands, and CI, not
  automatic pre-push hooks.
- `actionlint` and `zizmor` are intentionally paired: actionlint validates
  GitHub Actions syntax and expression semantics; zizmor audits workflow
  security posture. Do not add a third workflow linter without removing overlap.
- Package-native tools stay native: Cargo for Rust, SwiftPM/Xcode tooling for
  Swift, Gradle for Kotlin/Android, and React Native's own Codegen/build flow
  for React Native.

## Current Tree

```text
.
├── Cargo.toml
├── package.json
├── benchmarks/
├── docs/
├── examples/
│   └── integration/
├── src/
│   ├── shared/
│   │   ├── contracts/
│   │   └── fixtures/
│   ├── liboliphaunt/
│   ├── oliphaunt-rust/
│   ├── oliphaunt-swift/
│   ├── oliphaunt-kotlin/
│   ├── oliphaunt-react-native/
│   ├── oliphaunt-js/
│   ├── oliphaunt-wasix/
│   └── docs/
└── tools/
    ├── dev/
    ├── perf/
    ├── policy/
    ├── release/
    └── xtask/
```
