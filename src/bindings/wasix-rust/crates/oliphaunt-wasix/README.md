# `oliphaunt-wasix`

Embedded PostgreSQL 18 for Rust through the canonical `liboliphaunt-wasix`
runtime. The root API is synchronous and runs PostgreSQL directly on the
calling thread. Applications that need to keep an async executor responsive can
opt into the cloneable, dedicated owner-thread API under
`oliphaunt_wasix::worker`.
You can also start a one-client local PostgreSQL endpoint. Narrow in-tree SQLx
and `tokio-postgres` smokes cover ordinary connections and queries; this is not
a blanket compatibility claim for PostgreSQL clients or ORMs.

```sh
cargo add oliphaunt-wasix
```

## Direct API

<!-- liboliphaunt-doc-example:wasix-rust-basic-query -->
```rust,no_run
use oliphaunt_wasix::{DatabaseStorage, Oliphaunt};

fn main() -> anyhow::Result<()> {
    let mut database = Oliphaunt::builder()
        .storage(DatabaseStorage::Directory("./data/main".into()))
        .startup_guc("work_mem", "8MB")
        .open()?;

    database.execute("CREATE TABLE items(id integer PRIMARY KEY, value text NOT NULL)")?;
    database
        .sql("INSERT INTO items VALUES ($1, $2)")
        .bind(1_i32)
        .bind("hello")
        .execute()?;
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
    Ok(())
}
```

The root `Oliphaunt` is the no-hop database. Opening, queries, transactions,
backup, restore, and close run synchronously on the calling thread. The handle
is deliberately exclusive: database methods take `&mut self`, and a
transaction borrows that handle. This makes execution placement and ordering
explicit without an internal queue or message boundary.

Starting close permanently retires the handle. `is_closed()` becomes true,
later work is rejected, and repeated close calls replay the first terminal
result. A transaction callback panic is caught long enough to attempt rollback;
the original panic is then resumed. If rollback or commit cannot be confirmed,
the database is poisoned until close.

`execute` and `query` are the parameter-free forms;
`execute_with_params` and `query_with_params` use PostgreSQL positional
parameters. Query rows retain ordered raw bytes and expose OID-aware typed
access through `FromSql`; `Parameter`/`IntoParameter` carry OID, format, and
nullable bytes. `exec` returns ordered simple-query results, `describe` resolves
wire metadata without executing, and the database and transaction publish
`is_closed()`. `query` also accepts command-only statements, returning empty
fields and rows while retaining the command tag and affected-row count. A
transaction mirrors the structured methods and supports explicit `rollback()`
without a later commit.

`exec_protocol_raw` is the buffered escape hatch for callers that need
PostgreSQL frontend-protocol bytes. `exec_protocol_raw_stream` delivers
bounded callback chunks and streams COPY output through the guest protocol
pump instead of accumulating the complete response. Every fallible API returns the
crate-owned `Result<T>`. Its opaque `Error` implements `std::error::Error` and
offers `postgres_error()`; PostgreSQL failures return the exported
`PostgresError` details, notices, and SQLSTATE. Failed rollback or an uncertain
COMMIT poisons the database and never sends a misleading second control command.
Streaming callbacks execute synchronously on the calling thread and provide
backpressure to PostgreSQL. WASIX query cancellation is intentionally absent
until the guest runtime can interrupt execution and prove protocol recovery.

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

<!-- liboliphaunt-doc-example:wasix-rust-backup-restore -->
```rust,no_run
use oliphaunt_wasix::{DatabaseStorage, Oliphaunt};

fn main() -> anyhow::Result<()> {
    let mut source = Oliphaunt::open()?;
    let backup = source.backup()?;
    source.close()?;

    Oliphaunt::restore("./data/restored", backup)?;
    let mut restored = Oliphaunt::builder()
        .storage(DatabaseStorage::Directory("./data/restored".into()))
        .open()?;
    restored.close()?;
    Ok(())
}
```

`restore` accepts an absent or empty directory, validates and stages the whole
archive, then publishes the managed root. The archive contains `pgdata/**` and
`.oliphaunt/backup-manifest.properties`; it does not contain the destination's
`.oliphaunt.json` descriptor. Physical archives are for the same PostgreSQL
major and WASIX physical format. Restore is synchronous; once publication
starts, it runs to completion or returns an error. Use logical dump/restore for
upgrades.

## Standard PostgreSQL clients and tools

The endpoint is loopback or Unix-socket only, uses PostgreSQL trust
authentication, refuses TLS and GSS negotiation, and owns one connected client
at a time. Its current `CancelRequest` path does not authenticate or interrupt
the guest backend, so client cancellation is unsupported. Treat the example
below as the covered SQLx connection shape, not proof of pool, COPY,
cancellation, or arbitrary-driver conformance.

<!-- liboliphaunt-doc-example:wasix-rust-sqlx-server -->
```rust,no_run
use oliphaunt_wasix::OliphauntServer;
use sqlx::{Connection, Row};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let mut server = OliphauntServer::builder().start()?;
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

<!-- liboliphaunt-doc-example:wasix-rust-tools -->
```rust,no_run
use oliphaunt_wasix::{Oliphaunt, tools};

fn main() -> anyhow::Result<()> {
    let mut source = Oliphaunt::open()?;
    let sql = tools::pg_dump(
        &mut source,
        tools::PgDumpOptions::new().arg("--schema-only"),
    )?;
    source.close()?;
    let mut target = Oliphaunt::open()?;
    tools::psql(&mut target, tools::PsqlOptions::new().script(sql))?;
    target.close()?;
    Ok(())
}
```

`pg_dump` returns standard plain PostgreSQL SQL unchanged. `psql` is
non-interactive and accepts a command, a script, or ordinary passthrough
arguments. Connection, file input/output, format, compression, encoding, and
parallel-job flags are managed and rejected from passthrough arguments. Direct
tools are exclusive operations on the database and reset session state before
and after the tool run.

## Worker API

Use the worker module when PostgreSQL must not block the calling async executor:

<!-- liboliphaunt-doc-example:wasix-rust-worker -->
```rust,no_run
use oliphaunt_wasix::worker::Oliphaunt;

#[tokio::main]
async fn main() -> oliphaunt_wasix::Result<()> {
    let database = Oliphaunt::open().await?;
    let rows = database.query("SELECT 42::int4 AS answer").await?;
    assert_eq!(rows.get_text(0, "answer")?, Some("42"));
    database.close().await
}
```

`worker::Oliphaunt` is `Clone + Send + Sync`. Every clone targets one
PostgreSQL session whose Wasmer store is constructed and retained on an
SDK-owned thread. Database work therefore does not block the calling executor
thread. All admitted operations, transaction boundaries, and close are placed
into one FIFO. Ordinary-work admission is bounded; lifecycle controls retain
reserved capacity but never overtake earlier work. Starting close establishes
an atomic cutoff: earlier work drains, while later work is rejected.

Dropping an ordinary operation before it starts removes its database effect.
After worker execution begins, it runs to a PostgreSQL readiness boundary even
if its future is abandoned. Dropping an active transaction future queues
best-effort rollback in the same order. While a callback transaction is active,
unpinned work is rejected. Concurrent `close().await` callers join one close
attempt and receive the same result.

The worker module mirrors the direct database, SQL builder, transaction,
backup/restore, raw-protocol, server, and optional tools surfaces with async
methods. Streaming callbacks run synchronously on the database worker and must
not reenter the same database; reentrancy is rejected instead of deadlocking.
`worker::tools` queues `pg_dump` and `psql` on that same owner.

The direct local server has a synchronous lifecycle API, but its listener
thread owns the wire-protocol backend. Its `close(&mut self)` preserves the
handle so `is_closed()` can report terminal retirement and repeated close calls
can replay the first result.

TCP endpoints are loopback-only because the embedded proxy uses PostgreSQL
trust authentication. The default listener uses an automatically assigned
loopback port. `ServerListen::tcp_port` selects a fixed port and
`ServerListen::unix` selects a PostgreSQL-style Unix socket directory. The
server deliberately owns one connected client at a time; use the separate
postmaster product for concurrent sessions.

The crate packages no mutable runtime downloads. Cargo resolves the matching
runtime, AOT, tool, and selected extension artifacts built from the same
`liboliphaunt-wasix` source identity.
