# Testing With pglite-oxide

`pglite-oxide` is intended for tests that need real Postgres semantics without
Docker.

## Direct Rust Tests

Use `Pglite::temporary()` when the code under test can call the direct Rust API:

```rust,no_run
use pglite_oxide::Pglite;

#[test]
fn stores_rows() -> Result<(), Box<dyn std::error::Error>> {
    let mut db = Pglite::temporary()?;

    db.exec("CREATE TABLE items (id int primary key, name text)", None)?;
    db.exec("INSERT INTO items VALUES (1, 'alpha')", None)?;

    let rows = db.query("SELECT name FROM items WHERE id = 1", &[], None)?;
    assert_eq!(rows.rows[0].get("name").unwrap(), "alpha");

    db.close()?;
    Ok(())
}
```

Use `fresh_temporary()` only when the test must validate fresh-cluster
initialization behavior:

```rust,no_run
use pglite_oxide::Pglite;

#[test]
fn fresh_cluster_path() -> Result<(), Box<dyn std::error::Error>> {
    let mut db = Pglite::builder().fresh_temporary().open()?;
    db.close()?;
    Ok(())
}
```

## Server Tests

Use `PgliteServer` when the application already talks to Postgres through a
client library:

```rust,no_run
use pglite_oxide::PgliteServer;
use sqlx::{Connection, Row};

#[tokio::test]
async fn sqlx_query() -> Result<(), Box<dyn std::error::Error>> {
    let server = PgliteServer::temporary_tcp()?;
    let mut conn = sqlx::PgConnection::connect(&server.database_url()).await?;

    let row = sqlx::query("SELECT $1::int4 + 1 AS n")
        .bind(41_i32)
        .fetch_one(&mut conn)
        .await?;
    assert_eq!(row.try_get::<i32, _>("n")?, 42);

    conn.close().await?;
    server.shutdown()?;
    Ok(())
}
```

Keep client pools at one connection.

## Extension Tests

Enable bundled extensions through the builder:

```rust,no_run
use pglite_oxide::{extensions, Pglite};

#[test]
fn vector_query() -> Result<(), Box<dyn std::error::Error>> {
    let mut db = Pglite::builder()
        .temporary()
        .extension(extensions::VECTOR)
        .open()?;

    db.exec("CREATE TABLE items (embedding vector(3))", None)?;
    db.exec("INSERT INTO items VALUES ('[1,2,3]')", None)?;
    db.exec("SELECT embedding <-> '[1,2,4]' FROM items", None)?;

    db.close()?;
    Ok(())
}
```

When an extension has bundled dependencies, prefer the builder path over
post-open `enable_extension(...)`.

## Snapshot And Fixture Setup

Use physical data-dir archives or `try_clone()` when a test suite needs a
pre-populated same-version fixture:

```rust,no_run
use pglite_oxide::Pglite;

#[test]
fn clone_fixture() -> Result<(), Box<dyn std::error::Error>> {
    let mut seed = Pglite::temporary()?;
    seed.exec("CREATE TABLE items(value TEXT)", None)?;
    seed.exec("INSERT INTO items VALUES ('alpha')", None)?;

    let mut clone = seed.try_clone()?;
    clone.exec("SELECT * FROM items", None)?;

    clone.close()?;
    seed.close()?;
    Ok(())
}
```

Use logical dumps, not physical archives, when you need a portable export.

## Cross-Language Tests

Use `pglite-proxy` when the test process lives outside Rust:

```sh
pglite-proxy --temporary --tcp 127.0.0.1:0 --print-uri
```

Pass the printed URI to Python `psycopg`, Go `pgx`, Node `pg`, or another
standard Postgres client.

## COPY And Raw Protocol Tests

Direct `Pglite` supports `/dev/blob` for `COPY TO` and `COPY FROM`. Server mode
supports ordinary client-driven `COPY FROM STDIN` and other standard wire
protocol flows through the local Postgres endpoint.
