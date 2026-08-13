<h1 align="center">oliphaunt-wasix</h1>

<p align="center">
  <strong>Embedded Postgres for Rust tests and local apps.</strong><br>
  Real PostgreSQL. Direct Rust API or a local Postgres URL.
</p>

<p align="center">
  <a href="https://github.com/f0rr0/oliphaunt/blob/main/src/docs/content/sdk/wasm/guide.mdx">Guide</a>
  ·
  <a href="https://github.com/f0rr0/oliphaunt/blob/main/src/docs/content/reference/performance.md">Performance</a>
  ·
  <a href="https://github.com/f0rr0/oliphaunt/blob/main/src/docs/content/reference/extensions.mdx">Extensions</a>
  ·
  <a href="https://github.com/f0rr0/oliphaunt/blob/main/src/docs/content/sdk/wasm/dump-restore.md">Dump & Upgrade</a>
  ·
  <a href="https://github.com/f0rr0/oliphaunt/blob/main/src/docs/content/sdk/wasm/runtime.md">Runtime</a>
  ·
  <a href="https://github.com/f0rr0/oliphaunt/blob/main/src/docs/content/learn/tauri.md">Tauri</a>
</p>

<p align="center">
  <a href="https://github.com/f0rr0/oliphaunt/actions/workflows/ci.yml"><img src="https://github.com/f0rr0/oliphaunt/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://crates.io/crates/oliphaunt-wasix"><img src="https://img.shields.io/crates/v/oliphaunt-wasix.svg" alt="crates.io"></a>
  <a href="https://docs.rs/oliphaunt-wasix"><img src="https://docs.rs/oliphaunt-wasix/badge.svg" alt="docs.rs"></a>
  <a href="https://www.rust-lang.org"><img src="https://img.shields.io/badge/msrv-1.93-blue" alt="MSRV"></a>
  <a href="https://github.com/f0rr0/oliphaunt#license"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License"></a>
</p>

`oliphaunt-wasix` brings the WASIX Oliphaunt/Postgres runtime to Rust with a
small API. Open a database directly with `Oliphaunt`, or hand `OliphauntServer`
to SQLx and any standard Postgres client. The release-built runtime is
PostgreSQL 18.4. Cargo resolves the matching WASIX runtime and AOT artifact
crates; applications do not download runtime assets at first database open.

## Add Postgres In One Minute ⚡

Already using SQLx or another Postgres client? The WASIX API shape is:

```sh
cargo add oliphaunt-wasix
```

```rust,no_run
use oliphaunt_wasix::{DatabaseStorage, OliphauntServer};
use sqlx::{Connection, Row};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // The builder defaults to a true in-memory WASIX database.
    let server = OliphauntServer::builder().start()?;
    // For a persistent database instead:
    // let server = OliphauntServer::builder()
    //     .storage(DatabaseStorage::Directory("./.oliphaunt".into()))
    //     .start()?;
    let mut conn = sqlx::PgConnection::connect(&server.connection_uri()).await?;

    let row = sqlx::query("SELECT $1::int4 + 1 AS answer")
        .bind(41_i32)
        .fetch_one(&mut conn)
        .await?;
    assert_eq!(row.try_get::<i32, _>("answer")?, 42);

    conn.close().await?;
    server.shutdown()?;
    Ok(())
}
```

That's it. Real PostgreSQL, no service setup.

Direct API query failures downcast to `OliphauntError`. Its
`postgres_error()` accessor returns the structured `PostgresError`; branch on
`sqlstate` and use the retained query context for diagnostics.

## Storage and initialization

`storage` describes the lifetime and owner of mutable database state. It is not
an asset manifest and consumers do not provide runtime archive URLs.

```rust,no_run
use oliphaunt_wasix::{
    ApplicationData, DatabaseInitialization, DatabaseStorage, Oliphaunt,
};

# fn example() -> anyhow::Result<()> {
// Default: true WASIX memory storage, initialized from the packaged template.
let mut test_db = Oliphaunt::open()?;
test_db.close()?;

// Explicit persistence in an application-owned directory.
let mut local_db = Oliphaunt::builder()
    .storage(DatabaseStorage::Directory("./.oliphaunt".into()))
    .open()?;
local_db.close()?;

// Or let the platform resolve an application-data directory.
let mut app_db = Oliphaunt::builder()
    .storage(DatabaseStorage::ApplicationData(ApplicationData::new(
        "dev", "Oliphaunt", "Example",
    )))
    .initialization(DatabaseInitialization::PackagedTemplate)
    .open()?;
app_db.close()?;
# Ok(())
# }
```

`DatabaseStorage::TemporaryDirectory` remains available when a real host
directory with instance lifetime is useful. It is distinct from `Memory`:
memory PGDATA lives in Wasmer's virtual filesystem and never gets materialized
under the temporary runtime workspace. Initialization is independent and may
use the packaged template, a fresh WASIX `initdb`, or a compatible physical
backup. A caller-owned directory that contains an incomplete cluster fails
closed; Oliphaunt never deletes or silently reinitializes it.

```rust,no_run
use oliphaunt_wasix::{DatabaseInitialization, DatabaseStorage, Oliphaunt};

# fn example() -> anyhow::Result<()> {
let mut source = Oliphaunt::open()?;
source.exec("CREATE TABLE items (value text)", None)?;
let backup = source.backup()?;
source.close()?;

let mut restored = Oliphaunt::builder()
    .storage(DatabaseStorage::Directory("./restored".into()))
    .initialization(DatabaseInitialization::PhysicalArchive(backup))
    .open()?;
restored.close()?;
# Ok(())
# }
```

The current memory boundary is PGDATA, not the whole engine process. Wasmer
still uses an SDK-owned temporary workspace for runtime overlay files and may
use process resources such as threads, sockets, and its AOT cache. Likewise,
`try_clone()` takes a quiesced physical snapshot into a new memory filesystem;
it is not a zero-copy clone of a resource-free runtime. This is the deliberate
first implementation of the broader resource-free cloning request in issue
[#90](https://github.com/f0rr0/oliphaunt/issues/90).

## Why oliphaunt-wasix ✨

Postgres should be as easy to add to a Rust project as SQLite.

- ⚡ **No service tax**: no Docker, no local Postgres, no testcontainers.
- 🔌 **Use your real stack**: SQLx, `tokio-postgres`, CLIs, and other clients
  connect through a normal local URL.
- 🌉 **Proxy included**: expose an embedded database to non-Rust tools with
  `oliphaunt-wasix-proxy`.
- 🧪 **Clean tests**: memory databases are isolated, fast, and never create a
  host PGDATA directory.
- 💾 **Persistent apps**: keep local app data across restarts when you want it.
- 🧩 **Extensions available**: install exact extension release assets owned by
  your application.
- 📦 **Portable tools**: enable the `tools` feature to resolve the matching
  `oliphaunt-wasix-tools` `pg_dump` and `psql` artifacts for logical backups,
  checks, and upgrade paths.
- 🚀 **Near-native feel**: close to native Postgres, fully embedded.

## Near-Native Performance 🚀

The canonical guest specializes backend spinlocks and scalar atomics for the
enforced one-backend-per-WebAssembly-instance runtime. Rust AOT artifacts are
built from that same guest, so this binding receives the optimization alongside
the portable module used by browser and Node hosts; it is not Node-specific.
Frontend tools, PGXS side modules, and PostgreSQL builds that permit concurrent
backends retain the normal atomic implementation.

Current local snapshot on `Apple M1 Pro`, `16 GB RAM`, and `macOS 26.4.1`.
Full numbers and reproduction steps live in the
[performance guide](https://github.com/f0rr0/oliphaunt/blob/main/src/docs/content/reference/performance.mdx). Lower is better.

| Operation | native pg + SQLx | oliphaunt-wasix + SQLx | vanilla Oliphaunt + SQLx |
|---|---:|---:|---:|
| 25,000 INSERTs in one transaction | 132.36 ms | 149.54 ms | 257.02 ms |
| 25,000 INSERTs in one statement | 46.14 ms | 59.39 ms | 117.19 ms |
| 25,000 INSERTs into an indexed table | 188.72 ms | 253.38 ms | 352.64 ms |
| 5,000 indexed SELECTs | 81.39 ms | 125.31 ms | 203.05 ms |
| 25,000 indexed UPDATEs | 351.05 ms | 578.96 ms | 720.63 ms |

`oliphaunt-wasix` stays close to native Postgres while running entirely embedded
and consistently performs better than vanilla Oliphaunt.

## Extensions 🧩

WASIX extensions are exact package artifacts. The base runtime does not include
optional extension payloads. Applications select only the extension packages
they use.

## Docs

- [WASM guide](https://github.com/f0rr0/oliphaunt/blob/main/src/docs/content/sdk/wasm/guide.mdx)
- [Extensions](https://github.com/f0rr0/oliphaunt/blob/main/src/docs/content/reference/extensions.mdx)
- [Performance guide](https://github.com/f0rr0/oliphaunt/blob/main/src/docs/content/reference/performance.mdx)
- [Dump and upgrade guide](https://github.com/f0rr0/oliphaunt/blob/main/src/docs/content/sdk/wasm/dump-restore.mdx)
- [Tauri usage](https://github.com/f0rr0/oliphaunt/blob/main/src/docs/content/learn/tauri.mdx)
- [WASIX runtime guide](https://github.com/f0rr0/oliphaunt/blob/main/src/docs/content/sdk/wasm/runtime.mdx)
