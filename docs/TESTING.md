# Testing With pglite-oxide

`pglite-oxide` is designed for tests that need real Postgres semantics without
Docker.

## Direct Rust Tests

Use a temporary embedded database when the code under test can call the Rust API:

```rust,no_run
use pglite_oxide::Pglite;

#[test]
fn stores_rows() -> Result<(), Box<dyn std::error::Error>> {
    let mut db = Pglite::builder().temporary().open()?;

    db.exec("CREATE TABLE items (id int primary key, name text)", None)?;
    db.exec("INSERT INTO items VALUES (1, 'alpha')", None)?;

    let rows = db.query("SELECT name FROM items WHERE id = 1", &[], None)?;
    assert_eq!(rows.rows[0].get("name").unwrap(), "alpha");
    Ok(())
}
```

Temporary databases use a template cache by default. Fresh runtime `initdb` is
not exposed until the split WASIX `initdb` runner is added, so tests should use
ordinary temporary databases unless they are explicitly testing that future
runner.

## SQLx Tests

Use `PgliteServer` when the application already talks to Postgres through SQLx:

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

Keep the pool size at one connection.

## Extension Tests

Enable extensions through the builder:

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
    Ok(())
}
```

## Cross-Language Tests

Use `pglite-proxy` to start a temporary local server and print a Postgres URL:

```sh
pglite-proxy --temporary --tcp 127.0.0.1:0 --print-uri
```

Pass the printed URL to Python `psycopg`, Go `pgx`, Node `pg`, or any other
Postgres client.

## Server Limits In Tests

Server mode exposes one embedded backend. Configure pools with one connection.
Streaming `COPY FROM STDIN` through the server currently returns SQLSTATE
`0A000`; direct Rust blob COPY remains available.
