# Usage Guide

`pglite-oxide` has two public entry points:

- `Pglite` for direct embedded calls from Rust
- `PgliteServer` for crates that need a PostgreSQL connection URI

Prefer `Pglite` unless you specifically need a Postgres wire-protocol client.

## Opening Databases

Persistent database under an explicit path:

```rust,no_run
use pglite_oxide::Pglite;

fn main() -> anyhow::Result<()> {
    let mut db = Pglite::open("./.pglite")?;
    db.close()?;
    Ok(())
}
```

Persistent database under the platform app-data directory:

```rust,no_run
use pglite_oxide::Pglite;

fn main() -> anyhow::Result<()> {
    let mut db = Pglite::builder()
        .app("com", "example", "desktop-app")
        .open()?;
    db.close()?;
    Ok(())
}
```

Temporary database for tests:

```rust,no_run
use pglite_oxide::Pglite;

fn main() -> anyhow::Result<()> {
    let mut db = Pglite::temporary()?;
    db.close()?;
    Ok(())
}
```

`Pglite::temporary()` uses the process-local template cluster cache by default.
The current WASIX runtime creates new roots from the bundled PGDATA template;
explicit fresh-initdb paths use the bundled split WASIX `initdb` module.

Fresh persistent databases use the bundled PGDATA template by default, so app
code does not need to opt into the fast startup path.

## PostgreSQL Startup Config

Use `postgres_config` for settings that should be applied before the embedded
backend starts. Values are passed through PostgreSQL's normal `-c name=value`
startup path, and later SQL can still use ordinary `SET` or `SET LOCAL`
semantics.

```rust,no_run
use pglite_oxide::Pglite;

fn main() -> anyhow::Result<()> {
    let mut db = Pglite::builder()
        .temporary()
        .postgres_config("synchronous_commit", "off")
        .postgres_config("work_mem", "8MB")
        .open()?;

    db.exec("SET LOCAL synchronous_commit = on", None)?;
    db.close()?;
    Ok(())
}
```

The same API is available on `PgliteServerBuilder`, and `pglite-proxy` exposes
it as `--postgres-config name=value`.

Use `username` and `database` when the target role/database already exists in
the cluster. This matches PGlite's embedded model: the backend starts as the
local superuser, opens the requested database, and then applies the requested
role with normal PostgreSQL `SET ROLE` semantics.

```rust,no_run
use pglite_oxide::Pglite;

fn main() -> anyhow::Result<()> {
    let root = tempfile::tempdir()?;
    {
        let mut admin = Pglite::builder().path(root.path()).open()?;
        admin.exec("CREATE ROLE app_user LOGIN", None)?;
        admin.exec("CREATE DATABASE app_db OWNER app_user", None)?;
        admin.close()?;
    }

    let mut db = Pglite::builder()
        .path(root.path())
        .username("app_user")
        .database("app_db")
        .relaxed_durability(true)
        .open()?;

    db.exec("SELECT current_user, current_database()", None)?;
    db.close()?;
    Ok(())
}
```

Advanced startup arguments are available through `startup_arg` and
`startup_args`; prefer `postgres_config` for ordinary GUCs. `debug_level`
passes PostgreSQL's `-d` level.

`relaxed_durability(true)` applies a conservative local-app startup profile
without mutating `PostgresConfig`; explicit `postgres_config` values remain the
final authority.

The JavaScript PGlite constructor knobs `initialMemory`, `pgliteWasmModule`,
and `initdbWasmModule` do not have public runtime equivalents here. This crate
uses pinned packaged WASIX assets plus target-specific Wasmer AOT artifacts so
end users do not supply arbitrary modules or local memory profiles at open
time. Maintainer-side asset changes belong in the asset build pipeline.

## Queries

`exec` runs SQL without parameters. `query` runs the extended protocol with JSON
parameters.

```rust,no_run
use pglite_oxide::Pglite;
use serde_json::json;

fn main() -> anyhow::Result<()> {
    let mut db = Pglite::open("./.pglite")?;

    db.exec("CREATE TABLE IF NOT EXISTS items(value TEXT)", None)?;
    db.query("INSERT INTO items(value) VALUES ($1)", &[json!("alpha")], None)?;

    let result = db.query("SELECT value FROM items", &[], None)?;
    println!("{:?}", result.rows);

    db.close()?;
    Ok(())
}
```

Values are passed as `serde_json::Value`. Default parsers and serializers cover
common Postgres types including integers, floats, booleans, JSON/JSONB, bytea,
dates/timestamps, UUIDs, and built-in arrays.

Runtime-created enum/domain/composite arrays are discovered lazily when the
direct API sees their OIDs in parameter or result metadata. If you create custom
types and want to warm the direct-client type cache explicitly, call
`Pglite::refresh_array_types()`.

## Query Options

`QueryOptions` controls result parsing and protocol behavior.

```rust,no_run
use pglite_oxide::{Pglite, QueryOptions, RowMode};

fn main() -> anyhow::Result<()> {
    let mut db = Pglite::open("./.pglite")?;
    let options = QueryOptions {
        row_mode: Some(RowMode::Array),
        ..QueryOptions::default()
    };

    let rows = db.query("SELECT 1, 2", &[], Some(&options))?;
    println!("{:?}", rows.rows);

    db.close()?;
    Ok(())
}
```

For `COPY ... FROM '/dev/blob'`, set `QueryOptions::blob` to the bytes exposed
through the guest `/dev/blob`. For `COPY ... TO '/dev/blob'`, read the returned
`Results::blob`.

## Data Directory Archives

Use physical PGDATA archives for same-version import/export and fast cloning.
The archive is built from a materialized effective PGDATA view, including
template-overlay whiteouts. Creating one quiesces and restarts the embedded
backend, so transient session state is not part of the archive. It is not a
cross-version backup protocol; use logical `pg_dump` when you need portable SQL.

```rust,no_run
use pglite_oxide::Pglite;

fn main() -> anyhow::Result<()> {
    let mut source = Pglite::temporary()?;
    source.exec("CREATE TABLE items(value TEXT)", None)?;
    source.exec("INSERT INTO items VALUES ('alpha')", None)?;

    let archive = source.dump_data_dir()?;

    let mut restored = Pglite::builder()
        .temporary()
        .load_data_dir_archive(archive)
        .open()?;
    let mut cloned = restored.try_clone()?;

    cloned.exec("SELECT * FROM items", None)?;
    restored.close()?;
    cloned.close()?;
    source.close()?;
    Ok(())
}
```

Archives are owned by `pglite-oxide` and should be restored with the same
PostgreSQL/PGlite asset version.

## Transactions

Use `transaction` when several direct calls should commit or roll back together.

```rust,no_run
use pglite_oxide::Pglite;
use serde_json::json;

fn main() -> anyhow::Result<()> {
    let mut db = Pglite::open("./.pglite")?;

    db.transaction(|tx| {
        tx.query("INSERT INTO items(value) VALUES ($1)", &[json!("alpha")], None)?;
        tx.query("INSERT INTO items(value) VALUES ($1)", &[json!("beta")], None)?;
        Ok(())
    })?;

    db.close()?;
    Ok(())
}
```

## SQL Helpers

`format_query` asks Postgres to quote parameter values. `QueryTemplate` helps
build SQL while keeping identifiers and values separate.

```rust,no_run
use pglite_oxide::{Pglite, QueryTemplate, format_query, quote_identifier};
use serde_json::json;

fn main() -> anyhow::Result<()> {
    let mut db = Pglite::open("./.pglite")?;

    let sql = format_query(&mut db, "SELECT $1::int", &[json!(42)])?;
    assert_eq!(sql, "SELECT '42'::int");

    let mut template = QueryTemplate::new();
    template.push_sql("SELECT * FROM ");
    template.push_identifier("items");
    template.push_sql(" WHERE value = ");
    template.push_param(json!("alpha"));
    let built = template.build();

    assert_eq!(built.query, "SELECT * FROM \"items\" WHERE value = $1");
    assert_eq!(quote_identifier("a\"b"), "\"a\"\"b\"");

    db.close()?;
    Ok(())
}
```

## PostgreSQL Clients

Use `PgliteServer` when another crate expects a PostgreSQL URL. The server owns
one embedded backend, so configure downstream pools with one connection.

```rust,no_run
use pglite_oxide::PgliteServer;
use sqlx::{Connection, Row};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let server = PgliteServer::temporary_tcp()?;
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

For app persistence, use:

```rust,no_run
use pglite_oxide::PgliteServer;

fn main() -> anyhow::Result<()> {
    let server = PgliteServer::builder()
        .path("./.pglite")
        .start()?;
    server.shutdown()?;
    Ok(())
}
```

Connection URIs generated by the crate include `sslmode=disable`.
Server mode supports client-driven `COPY FROM STDIN`; normal Postgres clients
can use their COPY APIs and the embedded backend owns the `CopyInResponse`,
`CopyData`, and `CopyDone` protocol flow. Direct Rust blob COPY remains
available for fully host-owned byte transfer.

## Raw Protocol

The direct API exposes PGlite-style raw protocol entry points for callers that
already speak the PostgreSQL frontend protocol.

```rust,no_run
use pglite_oxide::{ExecProtocolOptions, Pglite};

fn main() -> anyhow::Result<()> {
    let mut db = Pglite::temporary()?;
    let mut query = vec![b'Q'];
    query.extend_from_slice(&13_i32.to_be_bytes());
    query.extend_from_slice(b"SELECT 1\0");

    let bytes = db.exec_protocol_raw(&query, ExecProtocolOptions::default())?;
    db.exec_protocol_raw_stream(&query, ExecProtocolOptions::default(), |_chunk| Ok(()))?;
    assert!(!bytes.is_empty());
    db.close()?;
    Ok(())
}
```

Most applications should use `exec`, `query`, or `PgliteServer`; raw protocol
APIs are for compatibility layers and protocol tooling.

## Logical Dumps

With the default `extensions` feature, the packaged WASIX `pg_dump` tool is
available through both direct and server APIs.

```rust,no_run
use pglite_oxide::{PgDumpOptions, Pglite};

fn main() -> anyhow::Result<()> {
    let mut db = Pglite::temporary()?;
    db.exec("CREATE TABLE items(value TEXT)", None)?;
    db.exec("INSERT INTO items VALUES ('alpha')", None)?;

    let sql = db.dump_sql(PgDumpOptions::new())?;
    assert!(sql.contains("INSERT INTO"));

    db.close()?;
    Ok(())
}
```

CLI:

```sh
pglite-dump --root ./.pglite > dump.sql
pglite-dump --root ./.pglite -- --schema-only > schema.sql
```
