# `oliphaunt-wasix`

Embedded PostgreSQL 18 for Rust through the canonical `liboliphaunt-wasix`
runtime. The root API is asynchronous and owns a dedicated database thread; use
the explicit `blocking` module when a caller-thread, no-hop direct database API
is preferable.
You can also start a one-client local PostgreSQL endpoint. Narrow in-tree SQLx
and `tokio-postgres` smokes cover ordinary connections and queries; this is not
a blanket compatibility claim for PostgreSQL clients or ORMs.

```sh
cargo add oliphaunt-wasix
```

## Async direct API

<!-- liboliphaunt-doc-example:wasix-rust-basic-query -->
```rust,no_run
use oliphaunt_wasix::{DatabaseStorage, Oliphaunt};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
let database = Oliphaunt::builder()
    .storage(DatabaseStorage::Directory("./data/main".into()))
    .startup_guc("work_mem", "8MB")
    .open().await?;

database.execute("CREATE TABLE items(id integer PRIMARY KEY, value text NOT NULL)").await?;
database.execute_with_params(
    "INSERT INTO items VALUES ($1, $2)",
    ["1", "hello"],
).await?;
let result = database.query_with_params(
    "SELECT value FROM items WHERE id = $1",
    [1_i32],
).await?;
assert_eq!(result.get_text(0, "value")?, Some("hello"));

database.transaction(async |transaction| {
    transaction.execute("UPDATE items SET value = 'committed' WHERE id = 1").await?;
    Ok(())
}).await?;
database.close().await?;
Ok(())
}
```

`Oliphaunt` is `Clone + Send + Sync`. Every clone targets one PostgreSQL
session whose Wasmer store is constructed and retained on an SDK-owned thread.
Database work therefore does not block an async executor thread. All admitted
database operations, transaction boundaries, and close are placed into one
FIFO in their admission order. The ordinary-work portion is bounded; lifecycle
controls retain reserved admission capacity but never overtake earlier work.
Starting close establishes an atomic cutoff: earlier admitted work drains
before close, while later ordinary work is rejected. Dropping an ordinary
operation before it starts removes its database effect; after owner execution
begins, it runs to a PostgreSQL readiness boundary even if its future is
abandoned. Dropping an active transaction future queues best-effort rollback in
the same order. While a callback transaction is active, unpinned work is
rejected.

Concurrent `close().await` callers join one immutable close attempt and receive
the same success or failure. Pre-shutdown validation, such as an active
transaction, publishes its failure before reopening admission for a distinct
explicit attempt. Once database shutdown or server stop begins, the handle is
permanently retired: `is_closed()` is true, later work is rejected, and every
later close replays that terminal attempt's exact result. The explicit blocking
database follows the same phase boundary on the caller thread.

`execute` and `query` are the parameter-free forms;
`execute_with_params` and `query_with_params` use PostgreSQL positional
parameters. Query rows retain ordered raw bytes and expose OID-aware typed
access through `FromSql`; `Parameter`/`IntoParameter` carry OID, format, and
nullable bytes. `exec` returns ordered simple-query results, `describe` resolves
wire metadata without executing, and the database and transaction publish
`is_closed()`. `query` also accepts command-only statements, returning empty
fields and rows while retaining the command tag and affected-row count. A
transaction mirrors the structured methods and supports one-shot async
`rollback()` without a later commit. The blocking callback form also catches a
callback panic, rolls back when the outcome is still known, releases its
exclusive transaction borrow, and then resumes the original panic. If rollback
cannot be confirmed, the database is poisoned until close.

`exec_protocol_raw` is the buffered escape hatch for callers that need
PostgreSQL frontend-protocol bytes. `exec_protocol_raw_stream` delivers
bounded callback chunks and streams COPY output through the guest protocol
pump instead of accumulating the complete response. Every fallible API returns the
crate-owned `Result<T>`. Its opaque `Error` implements `std::error::Error` and
offers `postgres_error()`; PostgreSQL failures return the exported
`PostgresError` details, notices, and SQLSTATE. Failed rollback or an uncertain
COMMIT poisons the database and never sends a misleading second control command.
Streaming callbacks execute synchronously on the database owner thread, one at
a time, and provide backpressure to PostgreSQL. They must not await reentrant
work on the same database; owner-thread reentrancy is rejected instead of
deadlocking. WASIX query cancellation is intentionally absent
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

#[tokio::main]
async fn main() -> anyhow::Result<()> {
let source = Oliphaunt::open().await?;
let backup = source.backup().await?;
source.close().await?;

Oliphaunt::restore("./data/restored", backup).await?;
let restored = Oliphaunt::builder()
    .storage(DatabaseStorage::Directory("./data/restored".into()))
    .open().await?;
restored.close().await?;
Ok(())
}
```

`restore` accepts an absent or empty directory, validates and stages the whole
archive, then publishes the managed root. The archive contains `pgdata/**` and
`.oliphaunt/backup-manifest.properties`; it does not contain the destination's
`.oliphaunt.json` descriptor. Physical archives are for the same PostgreSQL
major and WASIX physical format. Once its worker starts, abandoning the restore
future does not cancel filesystem publication. Use logical dump/restore for
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
    let server = OliphauntServer::builder().start().await?;
    let mut connection = sqlx::PgConnection::connect(&server.connection_string()).await?;
    let row = sqlx::query("SELECT 42::int AS answer")
        .fetch_one(&mut connection)
        .await?;
    assert_eq!(row.try_get::<i32, _>("answer")?, 42);
    connection.close().await?;
    server.close().await?;
    Ok(())
}
```

With the `tools` feature, the optional `tools` namespace runs the matching
packaged WASIX PostgreSQL programs directly against an open database:

<!-- liboliphaunt-doc-example:wasix-rust-tools -->
```rust,no_run
use oliphaunt_wasix::{Oliphaunt, tools};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
let source = Oliphaunt::open().await?;
let sql = tools::pg_dump(
    &source,
    tools::PgDumpOptions::new().arg("--schema-only"),
).await?;
source.close().await?;
let target = Oliphaunt::open().await?;
tools::psql(&target, tools::PsqlOptions::new().script(sql)).await?;
target.close().await?;
Ok(())
}
```

`pg_dump` returns standard plain PostgreSQL SQL unchanged. `psql` is
non-interactive and accepts a command, a script, or ordinary passthrough
arguments. Connection, file input/output, format, compression, encoding, and
parallel-job flags are managed and rejected from passthrough arguments. Direct
tools are exclusive operations on the database owner and reset session state
before and after the tool run.

## Explicit blocking API

The original synchronous API remains available without a worker hop:

<!-- liboliphaunt-doc-example:wasix-rust-blocking -->
```rust,no_run
use oliphaunt_wasix::blocking::Oliphaunt;

fn main() -> oliphaunt_wasix::Result<()> {
    let mut database = Oliphaunt::open()?;
    let rows = database.query("SELECT 42::int4 AS answer")?;
    assert_eq!(rows.get_text(0, "answer")?, Some("42"));
    database.close()
}
```

The blocking database handle is deliberately exclusive: methods take `&mut
self`, a transaction borrows the handle, and direct PostgreSQL work runs on the
calling thread. The same query values, SQL builder, errors, storage, backup, raw
protocol, server, and optional tools are available under
`oliphaunt_wasix::blocking`. The local server remains a synchronous lifecycle
API but, by design, its listener thread owns the wire-protocol backend. Its
`close(&mut self)` preserves the handle so `is_closed()` can report terminal
retirement and repeated close calls can replay the first result. Use the direct
blocking database in a dedicated application thread or Worker when blocking
that caller is acceptable.

TCP endpoints are loopback-only because the embedded proxy uses PostgreSQL
trust authentication. The default listener uses an automatically assigned
loopback port. `ServerListen::tcp_port` selects a fixed port and
`ServerListen::unix` selects a PostgreSQL-style Unix socket directory. The
server deliberately owns one connected client at a time; use the separate
postmaster product for concurrent sessions.

The crate packages no mutable runtime downloads. Cargo resolves the matching
runtime, AOT, tool, and selected extension artifacts built from the same
`liboliphaunt-wasix` source identity.
