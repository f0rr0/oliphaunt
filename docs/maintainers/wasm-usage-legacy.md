# WASIX Usage Guide

This legacy maintainer note describes the preserved `oliphaunt-wasix` crate.
Native Rust SDK work should start with the public native runtime docs and
`src/sdks/rust/README.md`.

`oliphaunt-wasix` has two primary entry points:

- `Oliphaunt` for direct embedded queries from Rust;
- `OliphauntServer` for libraries that need a PostgreSQL connection URI.

Prefer `Oliphaunt` unless you specifically need a Postgres client connection.

## Install Mode

Projects use the SDK crate and the package-manager-resolved WASIX artifact
products selected by the language build integration. After the first public
release, the initial dependency line is:

```toml
oliphaunt-wasix = "0.1"
```

Enable extension APIs explicitly:

```toml
oliphaunt-wasix = { version = "0.1", features = ["extensions"] }
```

The `0.5.x` repository-wide tags are legacy history, not versions of this
independently tagged product. Source remains at `0.0.0` until the generated
first-release PR moves it to `0.1.0`.

The crate has no `bundled` feature and no public runtime/AOT archive env-var
install mode. Normal database opens require staged package-manager runtime and
AOT artifacts.

## Opening Databases

Persistent database under an explicit path:

```rust,no_run
use oliphaunt_wasix::Oliphaunt;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut db = Oliphaunt::open("./.oliphaunt")?;
    db.close()?;
    Ok(())
}
```

Persistent database under the platform app-data directory:

```rust,no_run
use oliphaunt_wasix::Oliphaunt;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut db = Oliphaunt::builder()
        .app("com", "example", "desktop-app")
        .open()?;
    db.close()?;
    Ok(())
}
```

Fast temporary database for tests:

```rust,no_run
use oliphaunt_wasix::Oliphaunt;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut db = Oliphaunt::temporary()?;
    db.close()?;
    Ok(())
}
```

Explicit fresh-cluster temporary database:

```rust,no_run
use oliphaunt_wasix::Oliphaunt;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut db = Oliphaunt::builder().fresh_temporary().open()?;
    db.close()?;
    Ok(())
}
```

`temporary()` uses the cached template path. `fresh_temporary()` disables that
cache and runs the packaged `initdb` path instead. Use it when a test needs a
brand-new cluster, not for the common fast path.

The direct builder also exposes:

- `path(...)`, `app(...)`, and `app_id(...)` for persistent roots;
- `temporary()`, `template_cache(bool)`, and `fresh_temporary()` for ephemeral
  roots;
- `load_data_dir_archive(...)` for restoring a physical data-dir archive before
  open.

## Startup Configuration

Use builder methods for startup-time database settings:

```rust,no_run
use oliphaunt_wasix::Oliphaunt;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut db = Oliphaunt::builder()
        .temporary()
        .postgres_config("synchronous_commit", "off")
        .postgres_config("work_mem", "8MB")
        .username("postgres")
        .database("template1")
        .relaxed_durability(true)
        .open()?;
    db.close()?;
    Ok(())
}
```

Relevant direct and server builder methods:

- `postgres_config(name, value)` and `postgres_configs(...)`;
- `username(...)` and `database(...)`;
- `debug_level(level)` with PostgreSQL levels `0..=5`;
- `relaxed_durability(true)` for cacheable local workloads;
- `startup_arg(...)` and `startup_args(...)` for advanced PostgreSQL arguments.

Use `postgres_config` for ordinary GUCs. It follows PostgreSQL's normal
`-c name=value` startup behavior, and explicit values override the default
startup profile.

For `OliphauntServer`, the same startup methods are available on
`OliphauntServer::builder()`. The `oliphaunt-wasix-proxy` CLI exposes startup GUCs with
`--postgres-config NAME=VALUE`.

## Queries

`exec` runs SQL without parameters. `query` runs the extended protocol with
JSON parameters.

```rust,no_run
use oliphaunt_wasix::Oliphaunt;
use serde_json::json;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut db = Oliphaunt::temporary()?;

    db.exec("CREATE TABLE items(id INT PRIMARY KEY, value TEXT)", None)?;
    db.query(
        "INSERT INTO items(id, value) VALUES ($1, $2)",
        &[json!(1), json!("alpha")],
        None,
    )?;

    let result = db.query("SELECT value FROM items WHERE id = $1", &[json!(1)], None)?;
    println!("{:?}", result.rows);

    db.close()?;
    Ok(())
}
```

Parameters are `serde_json::Value`. Default parsers and serializers cover
common Postgres scalar types, JSON, bytea, UUIDs, timestamps, and built-in
arrays.

When you add runtime-created array types such as arrays of enums, domains, or
composites, `oliphaunt-wasix` usually discovers them lazily. If you want to refresh
that state explicitly, call `refresh_array_types()`.

## Query Options

`QueryOptions` controls result parsing and protocol behavior:

- `row_mode` switches between object rows and positional arrays;
- `parsers` and `serializers` override type handling for specific OIDs;
- `blob` attaches bytes to `/dev/blob` for `COPY FROM`;
- `param_types` pins parameter OIDs for cases where PostgreSQL cannot infer
  them cleanly;
- `on_notice` handles backend notices on a query-by-query basis.

Example:

```rust,no_run
use oliphaunt_wasix::{Oliphaunt, QueryOptions, RowMode};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut db = Oliphaunt::temporary()?;
    let options = QueryOptions {
        row_mode: Some(RowMode::Array),
        ..QueryOptions::default()
    };

    let result = db.query("SELECT 1, 2", &[], Some(&options))?;
    println!("{:?}", result.rows);

    db.close()?;
    Ok(())
}
```

Use `describe_query(...)` when you need parameter and result type metadata
without executing the query.

## Transactions

Use `transaction` when several direct calls should commit or roll back together.

```rust,no_run
use oliphaunt_wasix::Oliphaunt;
use serde_json::json;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut db = Oliphaunt::temporary()?;
    db.exec("CREATE TABLE items(value TEXT)", None)?;

    db.transaction(|tx| {
        tx.query("INSERT INTO items(value) VALUES ($1)", &[json!("alpha")], None)?;
        tx.query("INSERT INTO items(value) VALUES ($1)", &[json!("beta")], None)?;
        Ok(())
    })?;

    db.close()?;
    Ok(())
}
```

The `Transaction` handle also exposes `exec`, `query`, `refresh_array_types`,
`commit`, and `rollback`.

## Notifications

Use `listen` when you want channel-specific `LISTEN/NOTIFY` callbacks, and
`on_notification` when you want to observe every notification.

```rust,no_run
use oliphaunt_wasix::Oliphaunt;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut db = Oliphaunt::temporary()?;

    let specific = db.listen("events", |payload| {
        println!("events payload: {payload}");
    })?;
    let global = db.on_notification(|channel, payload| {
        println!("{channel}: {payload}");
    });

    db.exec("NOTIFY events, 'hello'", None)?;

    db.unlisten(specific)?;
    db.off_notification(global);
    db.close()?;
    Ok(())
}
```

`unlisten_channel(...)` removes all listeners for a specific channel.

## `/dev/blob` and COPY

Direct `Oliphaunt` can send and receive bytes through the virtual `/dev/blob`
device.

```rust,no_run
use oliphaunt_wasix::{Oliphaunt, QueryOptions};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut db = Oliphaunt::temporary()?;
    db.exec("CREATE TABLE items(value TEXT)", None)?;

    let import = QueryOptions {
        blob: Some(b"alpha\nbeta\n".to_vec()),
        ..QueryOptions::default()
    };
    db.exec("COPY items FROM '/dev/blob'", Some(&import))?;

    let exported = db.exec("COPY items TO '/dev/blob'", None)?;
    let blob = exported[0].blob.clone().expect("COPY TO blob");
    println!("{}", String::from_utf8(blob)?);

    db.close()?;
    Ok(())
}
```

If you already use a standard Postgres client, `OliphauntServer` also supports
client-driven `COPY FROM STDIN` through the normal wire protocol.

## SQL Helpers

`format_query` asks Postgres to quote parameter values. `QueryTemplate` and
`quote_identifier` help build SQL while keeping identifiers and values separate.

```rust,no_run
use oliphaunt_wasix::{Oliphaunt, QueryTemplate, format_query, quote_identifier};
use serde_json::json;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut db = Oliphaunt::temporary()?;

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

## Server Mode

Use `OliphauntServer` when another crate expects a PostgreSQL URL.

```rust,no_run
use oliphaunt_wasix::OliphauntServer;
use sqlx::{Connection, Row};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let server = OliphauntServer::temporary_tcp()?;
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

`OliphauntServer::builder()` supports:

- `path(...)`, `temporary()`, and `fresh_temporary()`;
- `tcp(...)`, and on Unix hosts `unix(...)`;
- the same startup configuration methods as `OliphauntBuilder`;
- bundled extensions with `extension(...)` and `extensions(...)`.

Use `connection_uri()` or `database_url()` to hand a URI to a client library.
Generated URLs include `sslmode=disable`.

Server mode still exposes one embedded backend. Configure SQLx, Diesel,
SeaORM, `tokio-postgres`, and framework pools with one connection.

## Raw Protocol

`exec_protocol` is the safest low-level wire-protocol entry point. It returns
parsed backend messages and still handles notices and notifications.

```rust,no_run
use oliphaunt_wasix::{ExecProtocolOptions, Oliphaunt};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut db = Oliphaunt::temporary()?;
    let mut query = vec![b'Q'];
    query.extend_from_slice(&13_i32.to_be_bytes());
    query.extend_from_slice(b"SELECT 1\0");

    let result = db.exec_protocol(&query, ExecProtocolOptions::default())?;
    assert!(!result.messages.is_empty());

    db.close()?;
    Ok(())
}
```

Use `exec_protocol_raw(...)` when you need raw bytes, and
`exec_protocol_raw_stream(...)` when you want to forward backend bytes as they
arrive.

## Physical Data-Dir Archives

Use physical archives for same-version restore and fast cloning. They are not a
cross-version backup protocol.

```rust,no_run
use oliphaunt_wasix::Oliphaunt;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut source = Oliphaunt::temporary()?;
    source.exec("CREATE TABLE items(value TEXT)", None)?;
    source.exec("INSERT INTO items VALUES ('alpha')", None)?;

    let archive = source.dump_data_dir()?;

    let mut restored = Oliphaunt::builder()
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

Use `dump_data_dir_with_format(...)` when you want an explicit
`DataDirArchiveFormat::Tar` or `DataDirArchiveFormat::TarGz`.

## Logical Dumps

With the default feature set, both direct and server APIs expose logical dumps
through `PgDumpOptions`.

```rust,no_run
use oliphaunt_wasix::{PgDumpOptions, Oliphaunt};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut db = Oliphaunt::temporary()?;
    db.exec("CREATE TABLE items(value TEXT)", None)?;
    db.exec("INSERT INTO items VALUES ('alpha')", None)?;

    let sql = db.dump_sql(PgDumpOptions::new().arg("--schema-only"))?;
    println!("{sql}");

    db.close()?;
    Ok(())
}
```

CLI:

```sh
oliphaunt-wasix-dump --root ./.oliphaunt
oliphaunt-wasix-dump --root ./.oliphaunt -- --schema-only
```

See [Dump and restore](../../src/docs/content/sdk/wasm/dump-restore.mdx) for
dump/restore and upgrade guidance.
