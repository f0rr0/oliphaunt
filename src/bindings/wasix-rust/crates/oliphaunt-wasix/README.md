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
need PostgreSQL frontend-protocol bytes. `exec_protocol_stream` delivers
bounded callback chunks and streams COPY output through the guest protocol
pump instead of accumulating the complete response. Every fallible API returns the
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

A new empty root is initialized from the matching packaged cluster seed. An existing
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

With the `tools` feature, the optional `tools` namespace runs the matching
packaged WASIX PostgreSQL programs directly against an open database:

```rust,no_run
use oliphaunt_wasix::{Oliphaunt, tools};

# fn main() -> anyhow::Result<()> {
let mut source = Oliphaunt::open()?;
let sql = tools::pg_dump(
    &mut source,
    tools::PgDumpOptions::new().arg("--schema-only"),
)?;
source.close()?;
let mut target = Oliphaunt::open()?;
tools::psql(&mut target, tools::PsqlOptions::new().script(sql))?;
target.close()?;
# Ok(())
# }
```

`pg_dump` returns standard plain PostgreSQL SQL unchanged. `psql` is
non-interactive and accepts a command, a script, or ordinary passthrough
arguments. Connection, file input/output, format, compression, encoding, and
parallel-job flags are managed and rejected from passthrough arguments. Direct
tools are exclusive operations on the database handle and reset session state
before and after the tool run.

TCP endpoints are loopback-only because the embedded proxy uses PostgreSQL
trust authentication. The default listener uses an automatically assigned
loopback port. `ServerListen::tcp_port` selects a fixed port and
`ServerListen::unix` selects a PostgreSQL-style Unix socket directory. The
server deliberately owns one connected client at a time; use the separate
postmaster product for concurrent sessions.

The crate packages no mutable runtime downloads. Cargo resolves the matching
runtime, AOT, tool, and selected extension artifacts built from the same
`liboliphaunt-wasix` source identity.
