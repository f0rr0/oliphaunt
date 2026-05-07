# Runtime Guide

`pglite-oxide` embeds a PostgreSQL-compatible runtime in the current Rust
process. The direct API talks to that backend directly, and `PgliteServer`
exposes the same backend through a local Postgres connection string.

## Choose A Mode

Use `Pglite` when your Rust code owns the database calls:

- direct function and method calls;
- no socket listener;
- best fit for tests, commands, jobs, and Tauri state.

Use `PgliteServer` when a library expects a PostgreSQL URI:

- SQLx, Diesel, SeaORM, `tokio-postgres`, or cross-language clients;
- local TCP or Unix socket listener;
- compatibility layer for existing Postgres clients.

Both modes still use one embedded backend.

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
