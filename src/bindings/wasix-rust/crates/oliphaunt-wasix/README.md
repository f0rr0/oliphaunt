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
  <a href="https://github.com/f0rr0/oliphaunt#license"><img src="https://img.shields.io/badge/license-MIT%20AND%20Apache--2.0%20AND%20PostgreSQL-blue" alt="License"></a>
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
use oliphaunt_wasix::OliphauntServer;
use sqlx::{Connection, Row};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let server = OliphauntServer::temporary_tcp()?;
    // For a persistent TCP server:
    // let server = OliphauntServer::builder().path("./.oliphaunt").start()?;
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

## Why oliphaunt-wasix ✨

Postgres should be as easy to add to a Rust project as SQLite.

- ⚡ **No service tax**: no Docker, no local Postgres, no testcontainers.
- 🔌 **Use your real stack**: SQLx, `tokio-postgres`, CLIs, and other clients
  connect through a normal local URL.
- 🌉 **Proxy included**: expose an embedded database to non-Rust tools with
  `oliphaunt-wasix-proxy`.
- 🧪 **Clean tests**: temporary databases are isolated, fast, and removed on
  drop.
- 💾 **Persistent apps**: keep local app data across restarts when you want it.
- 🧩 **Extensions available**: install exact extension release assets owned by
  your application.
- 📦 **Portable dumps**: use the WASIX `pg_dump` asset from the matching runtime
  release for logical backups and upgrade paths.
- 🚀 **Near-native feel**: close to native Postgres, fully embedded.

## Near-Native Performance 🚀

Current local snapshot on `Apple M1 Pro`, `16 GB RAM`, and `macOS 26.4.1`.
Full numbers and reproduction steps live in the
[performance guide](https://github.com/f0rr0/oliphaunt/blob/main/src/docs/content/reference/performance.md). Lower is better.

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
- [Performance guide](https://github.com/f0rr0/oliphaunt/blob/main/src/docs/content/reference/performance.md)
- [Dump and upgrade guide](https://github.com/f0rr0/oliphaunt/blob/main/src/docs/content/sdk/wasm/dump-restore.md)
- [Tauri usage](https://github.com/f0rr0/oliphaunt/blob/main/src/docs/content/learn/tauri.md)
- [WASIX runtime guide](https://github.com/f0rr0/oliphaunt/blob/main/src/docs/content/sdk/wasm/runtime.md)
