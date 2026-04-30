# Runtime Assets

`pglite-oxide` ships the database runtime as package-managed assets. Most users
do not need to download Postgres, run Docker, install LLVM, or configure a
runtime path.

## What Ships

With default features, the crate includes:

- the portable PGlite/Postgres WASIX runtime tree;
- a prepopulated PGDATA template for faster temporary databases;
- bundled extension archives for supported SQL extensions;
- the packaged `pg_dump` module used by the internal dump runner;
- a target-specific Wasmer AOT pack when the current host target is supported.

The internal asset crates exist only because crates.io packages dependencies as
separate crates. Application code should depend on `pglite-oxide`, not on
`pglite-oxide-assets` or `pglite-oxide-aot-*` directly.

## Feature Flags

Default install:

```toml
pglite-oxide = "0.3"
```

Default features include runtime caching and bundled extensions. Size-sensitive
builds can opt out:

```toml
pglite-oxide = { version = "0.3", default-features = false }
```

When bundled assets are disabled, APIs that require packaged extensions are not
available.

## Cache Behavior

Runtime files are expanded into a cache and then composed with a small writable
per-root skeleton by default. Temporary and template-backed databases use a
cached PGDATA template as a lower filesystem and materialize files into the
database root only when PostgreSQL opens them for mutation. Set
`PGLITE_OXIDE_MOUNTFS=0` or `PGLITE_OXIDE_PGDATA_OVERLAY=0` to force the older
full local install/clone paths.

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

Asset provenance is recorded in the generated asset manifest and in
`assets/sources.toml`. The manifest records source pins, runtime hashes,
extension archive hashes, AOT artifact hashes, target information, and Wasmer
engine identity.

Release assets are built with the `release-o3` profile by default: WASIX C code
uses `-O3 -g0 -flto=thin`, links with `-flto=thin`, and Binaryen runs the
wasixcc default optimization plus `--converge`, `--strip-debug`, and
`--strip-producers`.
