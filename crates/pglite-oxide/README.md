<p align="center">
  <img src="docs/assets/pglite-oxide.png" alt="pglite-oxide logo" width="360">
</p>

<h1 align="center">pglite-oxide</h1>

<p align="center">
  <strong>Embedded Postgres for Rust tests and local apps.</strong><br>
  Real PostgreSQL. Instant testing. Packaged runtime. Direct Rust API or a local Postgres URL.
</p>

<p align="center">
  <a href="https://github.com/f0rr0/pglite-oxide/blob/main/docs/USAGE.md">Usage</a>
  ·
  <a href="https://github.com/f0rr0/pglite-oxide/blob/main/docs/PERFORMANCE.md">Performance</a>
  ·
  <a href="https://github.com/f0rr0/pglite-oxide/blob/main/docs/EXTENSIONS.md">Extensions</a>
  ·
  <a href="https://github.com/f0rr0/pglite-oxide/blob/main/docs/PG_DUMP.md">Dump & Upgrade</a>
  ·
  <a href="https://github.com/f0rr0/pglite-oxide/blob/main/docs/TESTING.md">Testing</a>
  ·
  <a href="https://github.com/f0rr0/pglite-oxide/blob/main/docs/TAURI.md">Tauri</a>
</p>

<p align="center">
  <a href="https://github.com/f0rr0/pglite-oxide/actions/workflows/ci.yml"><img src="https://github.com/f0rr0/pglite-oxide/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://crates.io/crates/pglite-oxide"><img src="https://img.shields.io/crates/v/pglite-oxide.svg" alt="crates.io"></a>
  <a href="https://docs.rs/pglite-oxide"><img src="https://docs.rs/pglite-oxide/badge.svg" alt="docs.rs"></a>
  <a href="https://www.rust-lang.org"><img src="https://img.shields.io/badge/msrv-1.92-blue" alt="MSRV"></a>
  <a href="https://github.com/f0rr0/pglite-oxide#license"><img src="https://img.shields.io/badge/license-MIT%20AND%20Apache--2.0%20AND%20PostgreSQL-blue" alt="License"></a>
</p>

`pglite-oxide` brings PGlite/Postgres to Rust with a small API. Open a database
directly with `Pglite`, or hand `PgliteServer` to SQLx and any standard
Postgres client. The packaged runtime is PostgreSQL 17.5. No local Postgres
install, no Docker, no runtime build toolchain.

## Add Postgres In One Minute ⚡

Already using SQLx or another Postgres client? Add the crate and point your
client at an embedded database URL:

```sh
cargo add pglite-oxide
```

```rust,no_run
use pglite_oxide::PgliteServer;
use sqlx::{Connection, Row};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let server = PgliteServer::temporary_tcp()?;
    // For a persistent TCP server:
    // let server = PgliteServer::builder().path("./.pglite").start()?;
    let mut conn = sqlx::PgConnection::connect(&server.database_url()).await?;

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

## Why pglite-oxide ✨

Postgres should be as easy to add to a Rust project as SQLite.

- ⚡ **No service tax**: no Docker, no local Postgres, no testcontainers.
- 🔌 **Use your real stack**: SQLx, `tokio-postgres`, CLIs, and other clients
  connect through a normal local URL.
- 🌉 **Proxy included**: expose an embedded database to non-Rust tools with
  `pglite-proxy`.
- 🧪 **Clean tests**: temporary databases are isolated, fast, and removed on
  drop.
- 💾 **Persistent apps**: keep local app data across restarts when you want it.
- 🧩 **Extensions included**: `pgvector`, `pg_trgm`, `hstore`, `citext`, and
  more.
- 📦 **Portable dumps**: use bundled `pg_dump` for logical backups and upgrade
  paths.
- 🚀 **Near-native feel**: close to native Postgres, fully embedded.

## Near-Native Performance 🚀

Current local snapshot on `Apple M1 Pro`, `16 GB RAM`, and `macOS 26.4.1`.
Full numbers and reproduction steps live in the
[performance guide](https://github.com/f0rr0/pglite-oxide/blob/main/docs/PERFORMANCE.md). Lower is better.

| Operation | native pg + SQLx | pglite-oxide + SQLx | vanilla PGlite + SQLx |
|---|---:|---:|---:|
| 25,000 INSERTs in one transaction | 132.36 ms | 149.54 ms | 257.02 ms |
| 25,000 INSERTs in one statement | 46.14 ms | 59.39 ms | 117.19 ms |
| 25,000 INSERTs into an indexed table | 188.72 ms | 253.38 ms | 352.64 ms |
| 5,000 indexed SELECTs | 81.39 ms | 125.31 ms | 203.05 ms |
| 25,000 indexed UPDATEs | 351.05 ms | 578.96 ms | 720.63 ms |

`pglite-oxide` stays close to native Postgres while running entirely embedded
and consistently performs better than vanilla PGlite.

## Extensions 🧩

Bundled extensions are supported, including `pgvector`, `pg_trgm`, `hstore`,
`citext`, `ltree`, and more. See the
[extensions guide](https://github.com/f0rr0/pglite-oxide/blob/main/docs/EXTENSIONS.md)
for the full catalog and usage details.

```rust,no_run
use pglite_oxide::{extensions, PgliteServer};
use sqlx::Connection;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let server = PgliteServer::builder()
        .path("./.pglite")
        .extension(extensions::VECTOR)
        .start()?;
    let mut conn = sqlx::PgConnection::connect(&server.database_url()).await?;

    sqlx::query("CREATE TABLE IF NOT EXISTS items (embedding vector(3))")
        .execute(&mut conn)
        .await?;
    sqlx::query("INSERT INTO items VALUES ('[1,2,3]')")
        .execute(&mut conn)
        .await?;

    conn.close().await?;
    server.shutdown()?;
    Ok(())
}
```

## Docs

- [Usage guide](https://github.com/f0rr0/pglite-oxide/blob/main/docs/USAGE.md)
- [Extensions](https://github.com/f0rr0/pglite-oxide/blob/main/docs/EXTENSIONS.md)
- [Performance guide](https://github.com/f0rr0/pglite-oxide/blob/main/docs/PERFORMANCE.md)
- [Dump and upgrade guide](https://github.com/f0rr0/pglite-oxide/blob/main/docs/PG_DUMP.md)
- [Testing guide](https://github.com/f0rr0/pglite-oxide/blob/main/docs/TESTING.md)
- [Tauri usage](https://github.com/f0rr0/pglite-oxide/blob/main/docs/TAURI.md)
- [Runtime guide](https://github.com/f0rr0/pglite-oxide/blob/main/docs/RUNTIME.md)
