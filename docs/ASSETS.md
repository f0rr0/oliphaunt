# Maintainer Asset Notes

This page is maintainer documentation for packaged runtime assets, generated
payloads, and release provenance. It is not end-user product documentation.
Application users should start with `README.md`, `docs/USAGE.md`, and
`docs/RUNTIME.md`.

`pglite-oxide` ships the database runtime as package-managed assets. Most users
do not need to download Postgres, run Docker, install LLVM, or configure a
runtime path.

## What Ships

With default features, the crate includes:

- the portable PGlite/Postgres WASIX runtime tree;
- a prepopulated PGDATA template for faster temporary databases;
- bundled extension archives for supported SQL extensions;
- the packaged `initdb` module used by asset CI and explicit fresh-initdb paths;
- the packaged `pg_dump` module used by the public dump API and CLI;
- a target-specific Wasmer AOT pack when the current host target is supported.

The internal asset crates exist only because crates.io packages dependencies as
separate crates. Application code should depend on `pglite-oxide`, not on
`pglite-oxide-assets` or `pglite-oxide-aot-*` directly.

## Feature Flags

Default install:

```toml
pglite-oxide = "0.4"
```

Default features include the packaged runtime/AOT assets and bundled extension
APIs:

```toml
pglite-oxide = { version = "0.4", default-features = false, features = ["bundled"] }
```

The `bundled` feature keeps the package-managed PGlite/Postgres runtime and the
current platform's AOT crate, but leaves the public extension API disabled.
This is the "embedded Postgres without extension helpers" mode.

Size-sensitive builds can opt out of packaged assets entirely:

```toml
pglite-oxide = { version = "0.4", default-features = false }
```

When bundled assets are disabled, normal database opens do not have packaged
runtime/AOT assets available. This mode is intended for specialized maintainer
and custom-runtime workflows.

## Cache Behavior

Runtime files are expanded into a cache and then composed with a small writable
per-root skeleton by default. Temporary and template-backed databases use a
cached PGDATA template as a lower filesystem and materialize files into the
database root only when PostgreSQL opens them for mutation.

The runtime tree keeps both `/bin/pglite` and `/bin/postgres`. They are the same
backend module; the `postgres` path exists so upstream `initdb` can discover and
spawn the backend through PostgreSQL's normal `find_other_exec()` path.

The cache is content-addressed by the asset manifest and artifact hashes. If an
asset hash does not match the manifest, startup fails instead of using a mixed
or corrupted runtime.

## Extension Assets

Extensions are demand-driven. An extension archive is installed into the
database root only when the builder requests it or `enable_extension` is called:

```rust,no_run
use pglite_oxide::{extensions, Pglite};

let mut db = Pglite::builder()
    .temporary()
    .extension(extensions::VECTOR)
    .open()?;

db.enable_extension(extensions::PG_TRGM)?;
# Ok::<_, Box<dyn std::error::Error>>(())
```

Archive extraction rejects parent traversal, absolute paths, symlinks,
hardlinks, device nodes, and unsupported entry types.

## Provenance

Asset provenance is recorded in `assets/sources.toml`, the committed asset
input fingerprint, and the generated asset/AOT manifests produced by the Assets
workflow. Generated manifests record source pins, runtime hashes, `initdb`
hashes, PGDATA template hashes, extension archive hashes, target information,
and Wasmer engine identity.

The public repository tracks source-controlled inputs and crate skeletons. It
does not track upstream source checkouts, generated PGDATA templates, portable
WASIX blobs, or native AOT binaries.
Maintainer source trees are fetched on demand into ignored
`assets/checkouts/**` directories:

```sh
cargo run -p xtask -- assets fetch
```

Normal development and source-free validation do not clone upstream repositories
or run Docker. The source-free gate is:

```sh
cargo run -p xtask -- assets verify-committed
```

It verifies source pins, source/build input fingerprints, extension
metadata/constants when generated manifests are installed, AOT crate templates,
and the absence of committed PGDATA template, portable WASIX, or native AOT
blobs.

Release assets are built with the `release-o3` profile by default: WASIX C code
uses `-O3 -g0 -flto=thin`, links with `-flto=thin`, and Binaryen runs the
wasixcc default optimization plus `--converge`, `--strip-debug`, and
`--strip-producers`.

Generated runtime hashes in package metadata are refreshed in the release
staging workspace. They are not a committed source-of-truth value in normal
development; `assets/sources.toml` and `assets/generated/asset-inputs.sha256`
are the small committed provenance files.

The `Assets` workflow mirrors the release topology: one Linux/Docker job builds
portable WASIX modules from `assets/wasix-build` into
`target/pglite-oxide/assets`, then native matrix jobs generate and package
target-specific Wasmer AOT crates into `target/pglite-oxide/aot/<target>`.
Artifacts are uploaded with checksums, manifests, and the committed asset-input
fingerprint.

Manual `Assets` runs use the same producer path. Maintainers may select one
native target for focused validation, but the workflow still rebuilds portable
WASIX assets, generates AOT artifacts, runs the runtime gate, stages the release
workspace, package-checks the target crate, and uploads the canonical release
artifact shape.

Native AOT generation intentionally installs Wasmer's LLVM 22.1.x custom build
only inside the Assets workflow or a maintainer's explicit local artifact
build. Normal contributors and end users never need LLVM; they use committed
Rust sources plus downloaded or released AOT payloads.

The normal CI runtime matrix downloads the latest compatible Assets workflow
bundle, verifies that the downloaded fingerprint matches the current source
inputs, installs the payloads into ignored generated paths, and runs runtime
tests. Any change to source pins, WASIX patches, extension catalogs, build
scripts, or AOT crate templates is treated as asset-producing and must pass the
full `Assets` workflow. Release validation downloads the exact-SHA portable and
AOT bundles, stages them into a clean release workspace, validates package
contents, and only then publishes.

After an intentional asset-source change and regenerated artifacts, refresh the
committed input fingerprint:

```sh
cargo run -p xtask -- assets input-fingerprint --write
```
