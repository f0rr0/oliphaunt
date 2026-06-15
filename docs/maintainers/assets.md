# Maintainer Asset Notes

This page is maintainer documentation for packaged runtime assets, generated
payloads, and release provenance. It is not end-user product documentation.
Native application users should start with `README.md`, `src/docs/content/learn/native-runtime.md`, and
the SDK README for their platform. WASIX users should use
the public WASM SDK guide and `src/docs/content/sdk/wasm/runtime.md`.

`oliphaunt-wasix` ships the database runtime as package-managed assets. Most users
do not need to download Postgres, run Docker, install LLVM, or configure a
runtime path.

## What Ships

With default features, the crate includes:

- the portable Oliphaunt/Postgres WASIX runtime tree;
- a prepopulated PGDATA template for faster temporary databases;
- bundled extension archives for supported SQL extensions;
- the packaged `initdb` module used by asset CI and explicit fresh-initdb paths;
- the packaged `pg_dump` module used by the public dump API and CLI;
- a target-specific Wasmer AOT pack when the current host target is supported.

The internal asset crates exist only because crates.io packages dependencies as
separate crates. Application code should depend on `oliphaunt-wasix`, not on
`oliphaunt-wasix-assets` or `oliphaunt-wasix-aot-*` directly.

## Feature Flags

Default install:

```toml
oliphaunt-wasix = "0.5"
```

Default features include the packaged runtime/AOT assets and bundled extension
APIs:

```toml
oliphaunt-wasix = { version = "0.5", default-features = false, features = ["bundled"] }
```

The `bundled` feature keeps the package-managed Oliphaunt/Postgres runtime and the
current platform's AOT crate, but leaves the public extension API disabled.
This is the "embedded Postgres without extension helpers" mode.

Size-sensitive builds can opt out of packaged assets entirely:

```toml
oliphaunt-wasix = { version = "0.5", default-features = false }
```

When bundled assets are disabled, normal database opens do not have packaged
runtime/AOT assets available. This mode is intended for specialized maintainer
and custom-runtime workflows.

## Cache Behavior

Runtime files are expanded into a cache and then composed with a small writable
per-root skeleton by default. Temporary and template-backed databases use a
cached PGDATA template as a lower filesystem and materialize files into the
database root only when PostgreSQL opens them for mutation.

The runtime tree keeps both `/bin/oliphaunt` and `/bin/postgres`. They are the same
backend module; the `postgres` path exists so upstream `initdb` can discover and
spawn the backend through PostgreSQL's normal `find_other_exec()` path.

The cache is content-addressed by the asset manifest and artifact hashes. If an
asset hash does not match the manifest, startup fails instead of using a mixed
or corrupted runtime.

## Extension Assets

Extensions are demand-driven. An extension archive is installed into the
database root only when the builder requests it or `enable_extension` is called:

```rust,no_run
use oliphaunt_wasix::{extensions, Oliphaunt};

let mut db = Oliphaunt::builder()
    .temporary()
    .extension(extensions::VECTOR)
    .open()?;

db.enable_extension(extensions::PG_TRGM)?;
# Ok::<_, Box<dyn std::error::Error>>(())
```

Archive extraction rejects parent traversal, absolute paths, symlinks,
hardlinks, device nodes, and unsupported entry types.

## Provenance

Asset provenance is recorded in runtime source pins under
`src/sources/third-party/**`, extension-owned source pins under
`src/extensions/external/**/source.toml` and
`src/extensions/external/**/dependencies/**/source.toml`,
`src/sources/toolchains/**`, the committed asset input fingerprint, and the
generated runtime/AOT manifests produced by the
`CI` workflow's WASM runtime lane. Generated manifests record source pins,
runtime hashes, `initdb` hashes, PGDATA template hashes, extension archive
hashes, target information, and Wasmer engine identity. PostgreSQL ICU support
uses the same provenance path: ICU is source-pinned in
`src/sources/third-party/shared/icu.toml`, checked out under
`target/oliphaunt-sources/checkouts/icu`, and built as target-specific static
libraries by the native and WASIX runtime builders.

The public repository tracks source-controlled inputs and crate skeletons. It
does not track upstream source checkouts, generated PGDATA templates, portable
WASIX blobs, or native AOT binaries.
Maintainer source trees are fetched on demand into ignored
`target/oliphaunt-sources/checkouts/**` directories:

```sh
cargo run -p xtask -- assets fetch
```

WASIX build and work trees are generated under
`target/oliphaunt-wasix/wasix-build/**`. The source tree
`src/runtimes/liboliphaunt/wasix/assets/build/**` is reserved for scripts, patches,
Docker inputs, and shims that should affect the committed asset fingerprint.

Normal development and source-free validation do not clone upstream repositories
or run Docker. The source-free gate is:

```sh
cargo run -p xtask -- assets verify-committed
```

It verifies source pins, source/build input fingerprints, extension
metadata/constants when generated manifests are installed, AOT crate templates,
and the absence of committed PGDATA template, portable WASIX, or native AOT
blobs.

Release assets are built with the `release` profile by default: WASIX C code
uses `-O2 -g0`, and Binaryen runs the wasixcc default optimization plus
`--converge`, `--strip-debug`, and `--strip-producers`. The `release-o3`
profile remains available for explicit O3/ThinLTO comparison builds.

Generated runtime hashes in package metadata are refreshed in the release
staging workspace. They are not a committed source-of-truth value in normal
development; `src/sources/third-party/**`,
`src/extensions/external/**/source.toml`,
`src/extensions/external/**/dependencies/**/source.toml`,
`src/sources/toolchains/**`, and
`src/runtimes/liboliphaunt/wasix/assets/generated/asset-inputs.sha256` are the
small committed provenance files.

The `Checks` workflow's WASM runtime/AOT lane mirrors the release topology on
trusted producer runs: one Linux/Docker job builds portable WASIX modules from
`src/runtimes/liboliphaunt/wasix/assets/build` into `target/oliphaunt-wasix/assets`,
then native matrix jobs generate and package target-specific Wasmer AOT crates
into `target/oliphaunt-wasix/aot/<target>`. Artifacts are uploaded with
checksums, manifests, and the committed asset-input fingerprint.

Pull requests run a Moon-based asset plan instead of GitHub path-filtering the
workflow. The plan uses `moon query affected` for the PR base/head, plus the
asset producer path allowlist, to decide whether the expensive producer jobs are
required. Non-asset PRs become an explicit no-op after the source-controlled
asset-input checks. Asset-producing PRs run those input checks and the same full
portable/AOT producer path as `main`, scheduled runs, and explicit maintainer
dispatches.

Manual `Checks` dispatches use the same producer path. Maintainers may select
one native target for focused validation, but the workflow still rebuilds
portable WASIX assets, generates AOT artifacts, runs the runtime gate, stages the
release workspace, package-checks the target crate, and uploads the canonical
release artifact shape.

Native AOT generation intentionally installs Wasmer's LLVM 22.1.x custom build
only inside the `Checks` workflow's WASM AOT jobs or a maintainer's explicit
local artifact build. Normal contributors and end users never need LLVM; they
use committed Rust sources plus downloaded or released AOT payloads.

The normal CI runtime matrix downloads the latest compatible `Checks` workflow
WASM runtime bundle, verifies that the downloaded fingerprint matches the
current source inputs, installs the payloads into ignored generated paths, and
runs runtime tests. Changes to source pins, WASIX patches, extension catalogs,
build scripts, or AOT crate templates are treated as asset-producing: pull
requests must pass the source-controlled asset-input gate and the full producer
workflow before merge, while `main`, scheduled runs, and explicit maintainer dispatches remain
trusted producer lanes for release artifacts. Release validation downloads the
exact-SHA portable and AOT bundles, stages them into a clean release workspace,
validates package contents, and only then publishes.

Published releases also attach public `.tar.zst` mirrors of the validated
portable WASIX and target AOT bundles. `xtask assets download --release <tag>`
installs those release assets directly and does not require the GitHub CLI.

After an intentional asset-source change and regenerated artifacts, refresh the
committed input fingerprint:

```sh
cargo run -p xtask -- assets input-fingerprint --write
```
