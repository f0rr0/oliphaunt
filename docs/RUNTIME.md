# Runtime Guide

`pglite-oxide` embeds a PostgreSQL-compatible runtime in the current Rust
process. The direct API talks to that backend directly, and `PgliteServer`
exposes the same backend through a local Postgres connection string.

## PostgreSQL 18 WASIX Server-Core

On the PostgreSQL 18 branch, bundled assets use the WASIX server-core runtime.
That runtime exposes a real `postgres` server binary and is served through
`PgliteServer`. The legacy direct `Pglite` backend is not available with these
assets and fails fast with a message pointing callers at `PgliteServer`.

The PG18 server-core runner uses an external Wasmer CLI while the in-process
runner work is still being validated. The server builder exposes explicit
runtime controls so tests and applications do not need process-global
environment setup:

```rust,no_run
use std::time::Duration;

use pglite_oxide::{PgliteServer, WasmerCompiler};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let server = PgliteServer::builder()
        .temporary()
        .wasmer_bin("/path/to/wasmer")
        .wasmer_home_dir(".pglite-wasmer/home")
        .wasmer_cache_dir(".pglite-wasmer/cache")
        .wasmer_compiler(WasmerCompiler::Llvm)
        .wasmer_compiler_threads(4)
        .server_ready_timeout(Duration::from_secs(180))
        .start()?;

    server.shutdown()?;
    Ok(())
}
```

If a builder value is not supplied, the runner keeps the existing env fallback
order: `PGLITE_OXIDE_WASMER_BIN`/`WASMER_BIN`,
`PGLITE_OXIDE_WASMER_DIR`/`WASMER_DIR`,
`PGLITE_OXIDE_WASMER_CACHE_DIR`/`WASMER_CACHE_DIR`,
`PGLITE_OXIDE_WASMER_COMPILER`, `PGLITE_OXIDE_WASMER_COMPILER_THREADS`, and
`PGLITE_OXIDE_SERVER_READY_TIMEOUT_MS`.

Callers that need to support both current stable assets and the PG18
server-core lane can query `packaged_runtime_kind()` or
`using_wasix_postgres_server_core_assets()` and choose `PgliteServer` whenever
the runtime kind is `PgliteRuntimeKind::WasixPostgresServer`.

## Choose A Mode

Use `Pglite` when your Rust code owns the database calls:

- direct function and method calls;
- no socket listener;
- best fit for tests, commands, jobs, and Tauri state.

Use `PgliteServer` when a library expects a PostgreSQL URI:

- SQLx, Diesel, SeaORM, `tokio-postgres`, or cross-language clients;
- local TCP or Unix socket listener;
- compatibility layer for existing Postgres clients.

With the PG18 server-core assets, choose `PgliteServer`; with legacy direct
assets, both modes still use one embedded backend.

## Persistence Modes

Direct and server builders expose the same root choices:

- `path(...)` for a persistent database under an explicit directory;
- `app(...)` or `app_id(...)` for a persistent database under app data;
- `temporary()` for a fast cached temporary database;
- `fresh_temporary()` for an explicit fresh-cluster path.

Choose `temporary()` for most tests. Choose `fresh_temporary()` only when you
need a brand-new cluster and are willing to pay its slower startup path.

## Operational Limits

The current runtime model is single-backend:

- one `Pglite` instance owns one embedded backend;
- one `PgliteServer` exposes one embedded backend;
- downstream client pools should use one connection;
- server mode is for local compatibility, not a multi-user Postgres replacement.

Generated server URLs include `sslmode=disable`. `CancelRequest` and normal
startup packets are supported, but there is still one backend behind the server.

## Root Locking And Lifecycle

Persistent roots are locked while open. A second direct or server open against
the same root fails instead of sharing one data directory unsafely.

Close database clients before calling `PgliteServer::shutdown()`. The current
server thread waits for active client work to finish before exiting.

If you need a same-version physical clone, use `dump_data_dir()` /
`load_data_dir_archive(...)` or `try_clone()`. For portable exports and
upgrades, use logical dumps through `pg_dump`.

## Startup And Preload

The crate exposes two preload hooks:

```rust,no_run
use pglite_oxide::{extensions, Pglite};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    Pglite::preload()?;
    Pglite::preload_extensions([extensions::VECTOR])?;
    Ok(())
}
```

Call them before a visible startup path when you want to warm the packaged
runtime and bundled extension artifacts.

Startup configuration belongs on the builders:

- `postgres_config(...)` for PostgreSQL GUCs;
- `username(...)` and `database(...)` for the session target;
- `relaxed_durability(true)` for cacheable local workloads;
- `startup_arg(...)` only for advanced cases.

## Supported Targets

Default builds include packaged runtime assets and host artifacts for:

- macOS arm64;
- Linux x64;
- Linux arm64;
- Windows x64.

Unsupported host targets fail with a missing-artifact error instead of trying
to compile PostgreSQL locally.

Browser, worker, and mobile topics from upstream PGlite docs do not apply to
this crate. `pglite-oxide` is a Rust crate for local embedded and desktop/server
workloads.

## What Server Mode Is For

Reach for `PgliteServer` when you need client-library compatibility:

- SQLx migrations and query APIs;
- ORMs that expect a PostgreSQL URI;
- test fixtures for Python, Go, or Node clients;
- local tools that already speak the Postgres wire protocol.

Reach for `Pglite` when you control the Rust call site. It avoids the extra
socket layer and keeps the API surface smaller.
