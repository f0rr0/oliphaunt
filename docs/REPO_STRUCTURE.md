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
  targets, and target-scoped resources. Future Swift work should therefore live
  under `sdks/swift` as a normal Swift package instead of as ad hoc root files:
  https://docs.swift.org/package-manager/PackageDescription/PackageDescription.html
- Gradle's multi-project model uses a root build plus isolated subprojects
  declared from settings, which maps cleanly to a future Kotlin SDK under
  `sdks/kotlin`:
  https://docs.gradle.org/current/userguide/multi_project_builds.html
- `just` is a command runner for project-specific recipes, not a replacement
  build system. That is a good fit for a polyglot repo where Cargo, SwiftPM,
  Gradle, CMake/Make, and shell tools all remain authoritative:
  https://just.systems/man/en/

## Top-Level Policy

The repository root should contain product boundaries, shared metadata, and
entrypoints only. It should not contain package source trees.

- Rust packages live under `crates/`.
- The C ABI and PostgreSQL patch stack live under `libpglite/`.
- Language SDKs live under `sdks/<language-or-platform>/`.
- Tooling lives under `tools/`.
- Benchmarks live under `benchmarks/`.
- Product and engineering docs live under `docs/`.
- Generated or pinned build inputs live under `assets/` until the WASIX lane is
  retired or migrated.

There should be no root-level `src/` or `tests/` for product code.

## Product Boundaries

- `libpglite` is the native C boundary. It owns PostgreSQL source pins, patches,
  exported headers, and native build harnesses.
- `crates/libpglite-oxide` is the Rust-native SDK. It should depend on
  `libpglite` artifacts through explicit runtime/build configuration, not on
  `pglite-oxide` internals.
- `crates/pglite-oxide` is the existing WASIX package. It stays intact as a
  release lane and comparison target.
- `sdks/swift`, `sdks/kotlin`, and `sdks/react-native` will bind to `libpglite`
  or to a thin native SDK layer. They should not reach into PostgreSQL internals.

## Tooling Rules

- `tools/xtask` owns Rust-heavy automation and release asset orchestration.
- `tools/scripts` owns shell/Python entrypoints used by CI and local validation.
- `Justfile` owns ergonomic aliases only. A `just` recipe must call the same
  real command CI would call.
- Package-native tools stay native: Cargo for Rust, SwiftPM/Xcode tooling for
  Swift, Gradle for Kotlin/Android, and React Native's own Codegen/build flow
  for React Native.

## Current Tree

```text
.
├── Cargo.toml
├── Justfile
├── assets/
├── benchmarks/
├── build-support/
├── crates/
│   ├── libpglite-oxide/
│   ├── pglite-oxide/
│   ├── assets/
│   └── aot/
├── docs/
├── examples/
├── libpglite/
├── sdks/
│   ├── kotlin/
│   ├── react-native/
│   └── swift/
└── tools/
    ├── scripts/
    └── xtask/
```
