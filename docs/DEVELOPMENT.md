# Maintainer Development Guide

This page is maintainer documentation for repository validation, generated
artifacts, and local release workflows. It is not end-user product
documentation.

Run the local gates before opening a PR:

```sh
scripts/bootstrap-tools.sh
scripts/validate.sh dev
scripts/validate.sh workflows
scripts/validate.sh supply-chain
```

The validation entrypoint is split by maintainer workflow:

- `scripts/validate.sh repo`: file hygiene and formatting;
- `scripts/validate.sh artifacts`: source-controlled asset input verification
  plus AOT crate template checks;
- `scripts/validate.sh lint`: dependency invariants and clippy;
- `scripts/validate.sh test`: source-only no-default-features checks,
  doctests, and test compilation without requiring generated runtime assets;
- `scripts/validate.sh workflows`: local `actionlint` and `zizmor` checks using
  the same zizmor config and severity/persona as CI;
- `scripts/validate.sh runtime`: hard-requires portable assets plus host AOT,
  installs them into ignored paths, and runs the real runtime tests;
- `scripts/validate.sh runtime-smoke`: the runtime smoke subset;
- `scripts/validate.sh examples`: Tauri/Rust/frontend example checks;
- `scripts/validate.sh package`: package all published crates and enforce
  crates.io size limits;
- `scripts/validate.sh feature-powerset`: cargo-hack feature combination checks;
- `scripts/validate.sh semver`: cargo-semver-checks public API compatibility;
- `scripts/validate.sh supply-chain`: cargo-deny dependency policy checks;
- `scripts/validate.sh ci`: full local CI parity lane;
- `scripts/validate.sh dev-ci`: fast contributor lane for repo, lint, source
  tests, and examples;
- `scripts/validate.sh release`: release-workspace package checks plus publish
  dry-runs for internal crates after CI-generated AOT artifacts have been
  downloaded.

The hook split is intentionally small:

- pre-commit: file hygiene and formatting
- pre-push: whitespace diff check, `scripts/validate.sh lint`, and
  `scripts/validate.sh test`
- CI/release: path-aware combinations of the same validation modes, workflow
  linting, feature powerset, public API compatibility, crate packaging,
  native AOT runtime tests, release-plz dry-run/publish, and supply-chain
  policy

Install local hooks and pinned CLI tools when needed. The bootstrap installs
`cargo-binstall` first and uses binary installs for Rust tools before falling
back to source builds.

```sh
scripts/bootstrap-tools.sh
scripts/install-hooks.sh
```

`tests/runtime_smoke.rs` starts the real WASM backend and is intentionally
slower than the protocol unit tests.

## Maintenance Utilities

The repository includes maintenance commands:

- `pglite-dump` is the logical dump CLI entry point.
- `pglite-proxy` exposes a local PostgreSQL socket backed by the embedded
  runtime.
- `xtask assets template` generates the architecture-independent PGDATA
  template from the split WASIX `initdb` module. Portable WASIX, PGDATA
  templates, and native AOT payloads remain generated-only.

Asset and source checks:

```sh
cargo run -p xtask -- assets verify-committed
cargo run -p xtask -- assets fetch
cargo run -p xtask -- assets check --strict-local
cargo run -p xtask -- assets check --strict-generated
cargo run -p xtask --features template-runner -- assets template
cargo run -p xtask -- assets source-spine --check-patch-applies
cargo run -p xtask -- assets audit-upstream --strict
cargo run -p xtask -- assets input-fingerprint --write
cargo run -p xtask -- package-size --enforce
```

## Local Runtime Development

Local development has three supported modes.

Fast contributor mode does not require Docker, upstream source checkouts, or
generated native AOT payloads. Use it for ordinary Rust, docs, tests, examples,
and workflow edits:

```sh
scripts/validate.sh dev-ci
cargo check --workspace --all-targets
cargo test --workspace --no-default-features
```

For the shortest source-only path, use:

```sh
scripts/validate.sh dev
```

Host-platform artifact mode is for runtime work on the current machine. It
builds or packages only the current host target, leaves all generated payloads
in ignored paths, and then runs the real runtime tests:

```sh
host="$(rustc -vV | awk '/^host:/{print $2}')"
cargo run -p xtask -- assets fetch
cargo run -p xtask --features aot-serializer -- assets build-host
scripts/validate.sh runtime
```

Local AOT generation requires the Wasmer LLVM 22.1.x build for the
maintainer-only serializer. That build includes the LLVM target set Wasmer's
LLVM backend expects, including LoongArch and WebAssembly. Set
`LLVM_SYS_221_PREFIX` to an extracted
`wasmerio/llvm-custom-builds` 22.x archive, or use downloaded-artifact mode to
avoid local LLVM setup.

When the portable WASIX assets are already current and only the host AOT crate
needs to be refreshed, skip the source/Docker build and generate host AOT from
the existing generated portable assets:

```sh
host="$(rustc -vV | awk '/^host:/{print $2}')"
cargo run -p xtask -- assets aot --target-triple "$host"
cargo run -p xtask -- assets package-aot --target-triple "$host"
scripts/validate.sh runtime
```

Downloaded-artifact mode is the intended way to test a CI-produced runtime
locally without rebuilding Postgres/WASIX. Download the successful Assets
workflow artifacts for the exact commit and install the host target payloads
into the same ignored generated locations used by the local build path:

```sh
host="$(rustc -vV | awk '/^host:/{print $2}')"
cargo run -p xtask -- assets download --sha <sha> --target-triple "$host"
scripts/validate.sh runtime
```

For Rust-only work where the asset inputs have not changed, the same command
can install the latest compatible `main` bundle after verifying the
asset-input fingerprint:

```sh
host="$(rustc -vV | awk '/^host:/{print $2}')"
cargo run -p xtask -- assets download --latest-compatible --target-triple "$host"
scripts/validate.sh runtime
```

Released artifact bundles can be installed without the GitHub CLI because they
are public GitHub release assets:

```sh
host="$(rustc -vV | awk '/^host:/{print $2}')"
cargo run -p xtask -- assets download --release <tag> --target-triple "$host"
scripts/validate.sh runtime
```

Release validation can download every supported target from the exact Assets
workflow SHA:

```sh
cargo run -p xtask -- assets download --sha <sha> --all-targets
scripts/validate.sh release
```

Developers should not be expected to build every target locally. Local runtime
work validates the host target; the Assets workflow is the authority for the
full macOS, Linux, and Windows AOT matrix.

Contributors do not need upstream source checkouts for normal Rust, docs,
examples, or package validation. Maintainers fetch sources only when rebuilding
the portable WASIX runtime, extensions, `initdb`, `pg_dump`, or the generated
PGDATA template. Portable WASIX artifacts, generated PGDATA templates, and
native AOT artifacts are generated under `target/pglite-oxide/**` locally or by
CI; they are not committed to git.

Rust-only PRs download the latest compatible Assets workflow bundle, verify its
asset-input fingerprint, install it into ignored generated paths, and run the
runtime test suite on every supported host target. Asset-producing PRs run the
heavier `Assets` workflow instead: that workflow rebuilds portable WASIX from
pinned sources, generates native AOT for every target, runs smoke tests, and
uploads release artifacts.

Release process details are tracked in [RELEASE.md](RELEASE.md).
Completed implementation work is summarized in [DONE.md](DONE.md), and the
implementation backlog is tracked in [TODO.md](TODO.md).
