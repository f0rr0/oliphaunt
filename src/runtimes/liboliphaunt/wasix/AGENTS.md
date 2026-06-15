# WASIX Runtime Agent Guide

## Scope

This directory owns the WASIX PostgreSQL runtime source inputs, generated asset
metadata, AOT carrier crates, and WASIX release asset topology.

The Rust public binding lives in `src/bindings/wasix-rust/`. Keep the runtime
asset lane and the Rust API lane aligned, but do not collapse them.

## Boundaries

- Do not move native SDK behavior into the WASIX lane. Native SDK work belongs
  under `src/runtimes/liboliphaunt/native/` and `src/sdks/*`.
- Do not commit generated portable WASIX blobs, PGDATA templates, AOT binaries,
  or work trees. Generated payloads live under ignored `target/oliphaunt-wasix/`
  paths.
- Source-controlled WASIX build inputs live under `assets/build/`, source pins
  under `src/sources/**`, generated asset fingerprints under
  `assets/generated/`, and carrier crates under `crates/assets` and
  `crates/aot/*`.
- Keep asset-input fingerprint updates deliberate. Do not refresh fingerprints
  to hide a mismatched source graph.

## Commands

```sh
moon run liboliphaunt-wasix:check
moon run liboliphaunt-wasix:release-check
moon run liboliphaunt-wasix:smoke
moon run oliphaunt-wasix-rust:check
moon run oliphaunt-wasix-rust:test
moon run oliphaunt-wasix-rust:package
tools/policy/check-wasm-artifacts.sh
cargo run -p xtask -- assets verify-committed
cargo run -p xtask -- assets input-fingerprint --write
```

Use runtime build/download commands only when the task explicitly requires
runtime payload evidence. Normal source, docs, package, and API work should not
force Docker, LLVM, or full AOT generation.

## Validation Pattern

- For source metadata or patch-stack changes, run
  `moon run liboliphaunt-wasix:check`.
- For generated asset skeleton/fingerprint policy, run
  `tools/policy/check-wasm-artifacts.sh`.
- For Rust binding changes, run `moon run oliphaunt-wasix-rust:check` and
  `moon run oliphaunt-wasix-rust:test`.
- For package-shape changes, run `moon run oliphaunt-wasix-rust:package`.
- For runtime evidence, install or build the required host payloads, then run
  `moon run liboliphaunt-wasix:smoke --cache off`.

## Edit Checklist

- If a source pin, build script, extension input, or AOT template changes,
  inspect the affected Moon and CI artifact-builder paths.
- If public WASIX API changes, update `src/bindings/wasix-rust`, docs, package
  shape, and release metadata together.
- Keep `oliphaunt-wasix` release history stable while native parity evolves.
