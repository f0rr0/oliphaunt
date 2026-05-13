# Native libpglite PG18 Path

The native product is split into two repo boundaries:

- `libpglite/` owns the C ABI, PostgreSQL 18 source pin, patch stack, build
  scripts, C smoke harness, and runtime header.
- `crates/libpglite-oxide/` owns the Rust SDK shape over that C ABI.

The existing `pglite-oxide` crate and WASIX release lane remain in place while
the native path is built out separately.

## Source And Patch Stack

The C lane is pinned in:

```text
libpglite/postgres18/source.toml
```

It currently targets PostgreSQL `18.3` and applies the patch stack in
`libpglite/patches/postgresql-18.3`.

The entrypoint does not use `postgres --single`. It adds a dedicated embedded
backend entrypoint, routes libpq backend reads/writes through host-owned I/O
callbacks, and runs PostgreSQL's normal exit callbacks without calling
`exit(3)`.

## Build

Build the macOS happy-path dylib with:

```sh
libpglite/bin/build-postgres18-macos.sh
```

The script emits:

```text
target/libpglite-pg18/out/libpglite.dylib
target/libpglite-pg18/install/bin/initdb
target/libpglite-pg18/install/bin/postgres
```

`ccache` is used automatically when available. Set `LIBPGLITE_CCACHE=off` to
disable it, or set `LIBPGLITE_CCACHE=/path/to/ccache` to force a specific
binary. The older `PGLITE_OXIDE_NATIVE_*` variables still work as migration
fallbacks.

## C ABI Contract

The canonical header is:

```text
libpglite/include/libpglite.h
```

The current ABI is intentionally small:

- `pglite_init`
- `pglite_exec_protocol`
- `pglite_close`
- `pglite_last_error`
- `pglite_version`
- `pglite_capabilities`
- `pglite_free_response`

`pglite_exec_protocol` accepts frontend PostgreSQL protocol frames after
`pglite_init` has initialized the embedded backend session. Responses are owned
by the native library until `pglite_free_response`.

Native v1 is one embedded PostgreSQL lifetime per process. A second same-process
`pglite_init` after close is rejected deliberately because PostgreSQL 18 leaves
process-global state that is not safely reusable without a deeper reset or
broker design.

## Rust SDK

Point the Rust SDK at the build outputs:

```sh
export LIBPGLITE_OXIDE_LIBPGLITE="$PWD/target/libpglite-pg18/out/libpglite.dylib"
export LIBPGLITE_OXIDE_INITDB="$PWD/target/libpglite-pg18/install/bin/initdb"
export LIBPGLITE_OXIDE_POSTGRES="$PWD/target/libpglite-pg18/install/bin/postgres"
```

```rust,no_run
use libpglite_oxide::{LibPgliteRuntime, Pglite};

# async fn demo() -> libpglite_oxide::Result<()> {
let db = Pglite::builder()
    .path(".libpglite-oxide")
    .runtime(LibPgliteRuntime::from_env())
    .open()
    .await?;

db.execute("SELECT 1 AS value").await?;
db.close().await?;
# Ok(())
# }
```

Without `LIBPGLITE_OXIDE_LIBPGLITE`, the native runtime returns a clear startup
error. The old `pglite-oxide` crate is still the WASIX-oriented release lane.

## Smoke Tests

Use the C smoke as the fastest C ABI harness:

```sh
libpglite/bin/smoke-macos-happy-path.sh
```

It compiles the tiny C harness, opens a database, sends raw protocol bytes for
`SELECT 1 AS value`, closes cleanly, then launches the harness again against the
same PGDATA root to verify persistence/reopen across process boundaries.

Use the Rust SDK shape test for the separate package:

```sh
LIBPGLITE_OXIDE_LIBPGLITE="$PWD/target/libpglite-pg18/out/libpglite.dylib" \
LIBPGLITE_OXIDE_INITDB="$PWD/target/libpglite-pg18/install/bin/initdb" \
LIBPGLITE_OXIDE_POSTGRES="$PWD/target/libpglite-pg18/install/bin/postgres" \
cargo test -p libpglite-oxide --test sdk_shape -- --nocapture
```

## Current Deliberate Gaps

- No same-process native reopen; use one native lifetime per process for now.
- Extension packs are materialized for selected PG18-supported extensions, but
  signed custom manifests and mobile static registries are not complete yet.
- No native broker implementation yet.
- No native server implementation yet.
- No Swift, Kotlin, or React Native package until the Rust SDK boundary settles.
