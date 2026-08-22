# `oliphaunt-wasix`

Embedded PostgreSQL 18 for Rust through the canonical `liboliphaunt-wasix`
runtime. Use the direct typed API, or start a local PostgreSQL server for SQLx,
`tokio-postgres`, and other standard clients.

```sh
cargo add oliphaunt-wasix
```

## Direct API

```rust,no_run
use oliphaunt_wasix::{DatabaseStorage, Oliphaunt};

# fn main() -> anyhow::Result<()> {
let mut database = Oliphaunt::builder()
    .storage(DatabaseStorage::Directory("./data/main".into()))
    .startup_guc("work_mem", "8MB")
    .open()?;

database.execute("CREATE TABLE items(id integer PRIMARY KEY, value text NOT NULL)")?;
database.execute_with_params(
    "INSERT INTO items VALUES ($1, $2)",
    ["1", "hello"],
)?;
let result = database.query_with_params(
    "SELECT value FROM items WHERE id = $1",
    [1_i32],
)?;
assert_eq!(result.get_text(0, "value")?, Some("hello"));

database.transaction(|transaction| {
    transaction.execute("UPDATE items SET value = 'committed' WHERE id = 1")?;
    Ok(())
})?;
database.close()?;
# Ok(())
# }
```

`execute` and `query` are the parameter-free forms;
`execute_with_params` and `query_with_params` use PostgreSQL positional
parameters. `exec_protocol_raw` is the buffered escape hatch for callers that
need PostgreSQL frontend-protocol bytes. Every fallible API returns the
crate-owned `Result<T>`. Its opaque `Error` implements `std::error::Error` and
offers `postgres_error()`; PostgreSQL failures return the exported
`PostgresError` details for fields such as SQLSTATE.

The builder also supports `username`, `database`, `startup_gucs`, and bundled
`extension`/`extensions` when the corresponding crate features are enabled.

## Storage and physical backup

`DatabaseStorage::Memory` is the default and keeps mutable PGDATA in Wasmer's
memory filesystem. `DatabaseStorage::Directory(path)` persists a managed root:

```text
data/main/
├── .oliphaunt.json
└── pgdata/
```

A new empty root is initialized from the packaged PGDATA template. An existing
root must contain an exact descriptor and complete PostgreSQL 18 PGDATA;
incomplete or unexpected contents fail without being adopted, deleted, or
reinitialized.

Rust uses one stable sibling advisory lock for both open and restore. It
coordinates Rust WASIX owners of that path, including before a new root exists.
The WASIX TypeScript binding has its own binding-local lease. Cross-binding root
handoff is not a supported or qualified workflow.

Physical backup is a PostgreSQL online backup in a plain tar archive:

```rust,no_run
use oliphaunt_wasix::{DatabaseStorage, Oliphaunt};

# fn main() -> anyhow::Result<()> {
let mut source = Oliphaunt::open()?;
let backup = source.backup()?;
source.close()?;

Oliphaunt::restore("./data/restored", backup)?;
let mut restored = Oliphaunt::builder()
    .storage(DatabaseStorage::Directory("./data/restored".into()))
    .open()?;
restored.close()?;
# Ok(())
# }
```

`restore` accepts an absent or empty directory, validates and stages the whole
archive, then publishes the managed root. The archive contains `pgdata/**` and
`.oliphaunt/backup-manifest.properties`; it does not contain the destination's
`.oliphaunt.json` descriptor. Physical archives are for the same PostgreSQL
major and WASIX physical format. Use logical dump/restore for upgrades.

## Standard PostgreSQL clients and tools

```rust,no_run
use oliphaunt_wasix::OliphauntServer;
use sqlx::{Connection, Row};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let server = OliphauntServer::builder().start()?;
    let mut connection = sqlx::PgConnection::connect(&server.connection_string()).await?;
    let row = sqlx::query("SELECT 42::int AS answer")
        .fetch_one(&mut connection)
        .await?;
    assert_eq!(row.try_get::<i32, _>("answer")?, 42);
    connection.close().await?;
    server.close()?;
    Ok(())
}
```

With the `tools` feature, `OliphauntServer::pg_dump` and
`OliphauntServer::psql` run the matching packaged WASIX PostgreSQL tools.
`pg_dump` returns the standard PostgreSQL plain-text script unchanged; restore
it through `psql(PsqlOptions::new().script(sql))` or another PostgreSQL client
script API. Release other server clients before invoking these methods: the
WASIX server deliberately serves one client session at a time. `server.close()`
deterministically disconnects any active client before joining the server
worker.

TCP endpoints are loopback-only because the embedded proxy uses PostgreSQL
trust authentication. Use the default `127.0.0.1:0`, another loopback address,
or a Unix-domain socket; non-loopback TCP binds are rejected by `start()`.

The crate packages no mutable runtime downloads. Cargo resolves the matching
runtime, AOT, tool, and selected extension artifacts built from the same
`liboliphaunt-wasix` source identity.
