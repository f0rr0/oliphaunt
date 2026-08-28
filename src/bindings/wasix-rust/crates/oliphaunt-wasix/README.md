# `oliphaunt-wasix`

Embedded PostgreSQL 18 for Rust through the canonical `liboliphaunt-wasix`
runtime. The root API is synchronous and runs PostgreSQL directly on the
calling thread. Its retained Wasmer store is thread-affine, so root `Oliphaunt`
is `!Send + !Sync` and must be created, used, closed, and dropped on one OS
thread. Applications that need a movable/shared handle or need to keep an async
executor responsive use the cloneable `Send + Sync` root `AsyncOliphaunt`
handle, which owns a dedicated database thread.

You can also start a one-client local PostgreSQL endpoint. Narrow in-tree SQLx
and `tokio-postgres` smokes cover ordinary connections and queries; this is not
a blanket compatibility claim for PostgreSQL clients or ORMs.

```sh
cargo add oliphaunt-wasix
```

## Direct API

<!-- liboliphaunt-doc-example:wasix-rust-basic-query -->
```rust,no_run
use oliphaunt_wasix::{DatabaseStorage, Error, Oliphaunt};

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
        Ok::<(), Error>(())
    })?;
    database.close()?;
    Ok(())
}
```

The root `Oliphaunt` is the no-hop database. Opening, queries, transactions,
backup, restore, and close run synchronously on the calling thread. The handle
is deliberately thread-affine and exclusive: it is `!Send + !Sync`, database
methods take `&mut self`, and a transaction borrows that handle. Create, use,
close, and drop it on one OS thread. This makes execution placement and ordering
explicit without an internal queue or message boundary.

Starting close permanently retires the handle. `is_closed()` becomes true,
later work is rejected, and repeated close calls replay the first terminal
result. A transaction callback panic is caught long enough to attempt rollback;
the original panic is then resumed. If rollback or commit cannot be confirmed,
the database is poisoned until close.

`execute` and `query` are the parameter-free forms;
`execute_with_params` and `query_with_params` use PostgreSQL positional
parameters. Query rows retain ordered raw bytes and expose OID-aware typed
access through `FromSql`. Natural Rust values use `IntoParameter` and carry
their PostgreSQL type OID and preferred encoding. `Parameter` provides
explicit OID, format, and nullable bytes; its `text`, `binary`, and `null`
constructors leave the OID for PostgreSQL to infer. An explicit OID 0 is
accepted by `describe` because it is PostgreSQL's wire-level inference
sentinel; an absent OID is the single execution spelling for inference. `exec`
returns ordered simple-query
results, `describe` resolves
wire metadata without executing, and the database and transaction publish
`is_closed()`. `query` also accepts command-only statements, returning empty
fields and rows while retaining the command tag and affected-row count. A
transaction mirrors the structured methods and supports explicit `rollback()`
without a later commit.

Managed transaction handles intentionally omit raw-protocol methods. Do not
send transaction lifecycle SQL (`BEGIN`, `COMMIT`, `END`, `ROLLBACK`, or
`AND CHAIN`) through their structured methods; use callback completion or
`rollback()` instead. Savepoints, including `ROLLBACK TO SAVEPOINT`, remain
ordinary transaction work. Use the root database's raw-protocol adapter only
when the application deliberately owns the full PostgreSQL session state.

Transaction callbacks return ordinary `Result<T, E>` with `E: From<Error>`, so
database work uses `?` while typed business aborts stay application-owned. The
outer `TransactionResult<T, E>` distinguishes callback failure, an actually
attempted rollback failure, and an independent database/protocol failure for
which no rollback was sent.

`exec_protocol_raw` is the buffered escape hatch for callers that need
PostgreSQL frontend-protocol bytes. `exec_protocol_raw_stream` delivers
bounded callback chunks and streams COPY output through the guest protocol
pump instead of accumulating the complete response. Ordinary fallible methods
return the crate-owned `Result<T>`; transactions and streams use the generic
`TransactionResult<T, E>` and `RawStreamResult<T, E>` wrappers. The opaque
`Error` implements `std::error::Error`, exposes a stable non-exhaustive
`ErrorKind` through `kind()`, and offers `postgres_error()`; PostgreSQL failures return the exported
`PostgresError` details, notices, and SQLSTATE. Failed rollback or an uncertain
COMMIT poisons the database and never sends a misleading second control command.
Streaming callbacks execute synchronously before the direct method returns and
provide backpressure to PostgreSQL. The retained WASIX stdio attachment requires
the callback to own `Send + 'static` captures; use `Arc<Mutex<_>>` for mutable
state. Return `()` for infallible delivery or `Result<(), E>` for a typed stop.
A callback error or panic is surfaced only after a successful guest protocol
pump confirms recovery. Direct callback panics then resume; async owner-thread
panics become `RawStreamError::CallbackPanicked` without poisoning. If the pump
fails, `RawStreamError::Database` is authoritative, the database becomes
close-only, and a retained callback panic is not resumed into an unknown session
state. WASIX query cancellation is intentionally absent
until the guest runtime can interrupt execution and prove protocol recovery.

The builder also supports `username`, `database`, `startup_gucs`, and bundled
`extension`/`extensions` when the corresponding crate features are enabled.
Selecting an extension makes its artifact and required pre-start configuration
available; it never runs `CREATE EXTENSION`, `LOAD`, or migration SQL. Install
database-local objects explicitly through your normal migrations. Each
associated selector is compiled only by its matching `extension-*` feature;
`Extension::ALL` and `Extension::by_sql_name` therefore describe exactly the
artifacts enabled in the current Cargo build, not the full packaging catalog.

## Storage and physical backup

`DatabaseStorage::Memory` is the default and keeps mutable PGDATA in Wasmer's
memory filesystem. `DatabaseStorage::Directory(path)` persists a managed root;
the caller-supplied Rust path must be nonempty and contain no NUL bytes:

```text
data/main/
├── .oliphaunt.json
└── pgdata/
```

A new empty root is initialized from the matching packaged cluster seed. An
existing root must contain an exact descriptor and complete PostgreSQL 18 PGDATA;
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

The endpoint uses loopback TCP on every supported host; Unix hosts may instead
select a Unix-domain socket. It uses PostgreSQL trust authentication, refuses
TLS and GSS negotiation, and owns one connected client at a time. Its current
`CancelRequest` path does not authenticate or interrupt the guest backend, so
client cancellation is unsupported. Treat the example below as the covered
SQLx connection shape, not proof of pool, COPY, cancellation, or
arbitrary-driver conformance.

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

With the `tools` feature, an open database gains fluent methods for the matching
packaged WASIX PostgreSQL programs. The optional `tools` namespace contains
their options and structured error type:

<!-- liboliphaunt-doc-example:wasix-rust-tools -->
```rust,no_run
# #[cfg(feature = "tools")]
use oliphaunt_wasix::{Oliphaunt, tools};

# #[cfg(feature = "tools")]
fn main() -> anyhow::Result<()> {
    let mut source = Oliphaunt::open()?;
    let sql = source.pg_dump(tools::PgDumpOptions::new().arg("--schema-only"))?;
    source.close()?;
    let mut target = Oliphaunt::open()?;
    target.psql(tools::PsqlOptions::new().script(sql))?;
    target.close()?;
    Ok(())
}

# #[cfg(not(feature = "tools"))]
# fn main() {}
```

`pg_dump` returns standard plain PostgreSQL SQL unchanged. `psql` is
non-interactive and accepts a command, a script, or ordinary passthrough
arguments. Connection, file input/output, format, compression, encoding, and
parallel-job flags are managed and rejected from passthrough arguments. Direct
tools are exclusive operations on the database and reset session state before
and after the tool run.

## Asynchronous API

Use `AsyncOliphaunt` when PostgreSQL must not block the calling async executor:

<!-- liboliphaunt-doc-example:wasix-rust-async -->
```rust,no_run
use oliphaunt_wasix::AsyncOliphaunt;

#[tokio::main]
async fn main() -> oliphaunt_wasix::Result<()> {
    let database = AsyncOliphaunt::open().await?;
    let rows = database.query("SELECT 42::int4 AS answer").await?;
    assert_eq!(rows.get_text(0, "answer")?, Some("42"));
    database.close().await
}
```

`AsyncOliphaunt` is `Clone + Send + Sync`. Every clone targets one
PostgreSQL session whose Wasmer store is constructed and retained on an
SDK-owned thread. Database work therefore does not block the calling executor
thread. All admitted operations, transaction boundaries, and close are placed
into one FIFO. Ordinary work awaits fair, bounded admission; saturation applies
async backpressure instead of returning a queue-full error. Lifecycle controls
do not consume ordinary capacity but never overtake earlier admitted work.
Individual futures are `Send` only when their captured inputs, callbacks, and
outputs also satisfy the applicable `Send` bounds.
Starting close establishes an atomic cutoff: work already in the owner FIFO
drains, while capacity waiters and later work are rejected. A retryable close
does not resurrect waiters that missed its cutoff.

Dropping an ordinary operation before it starts removes its database effect.
After asynchronous execution begins, it runs to a PostgreSQL readiness boundary
even if its future is abandoned. Dropping an active transaction future queues
best-effort rollback in the same order. While a callback transaction is active,
unpinned work is rejected. Concurrent `close().await` callers join one close
attempt and receive the same result.

An async transaction-body panic unwinds the awaiting task immediately. Its
active transaction is dropped and queues best-effort rollback in the owner
FIFO. The unwind does not wait for rollback to finish, but later database work
cannot overtake that cleanup. This differs from the direct callback transaction,
which settles synchronously before resuming the panic.

The `Async*` root types mirror the direct database, SQL builder, transaction,
backup/restore, raw-protocol, server, and optional tools surfaces with async
methods. Streaming callbacks run synchronously on the database owner and must
not reenter the same database; reentrancy is rejected instead of deadlocking.
Their captures must also be owned `Send + 'static`; use `Arc<Mutex<_>>` for
shared mutable state.
`database.pg_dump(options).await` and `database.psql(options).await` queue the
packaged tools on that same owner.

The direct local server has a synchronous lifecycle API, but its listener
thread owns the wire-protocol backend. The handle is `Send + !Sync`; move its
exclusive ownership between threads rather than sharing references. Its
`close(&mut self)` preserves the handle so `is_closed()` can report terminal
retirement and repeated close calls can replay the first result. The async
server handle is cloneable `Send + Sync`.
Server `is_closed()` reports SDK lifecycle state only. It does not poll the
proxy listener or guarantee that the published PostgreSQL endpoint is
reachable; use the connected driver or pool for connection health.

TCP endpoints are loopback-only because the embedded proxy uses PostgreSQL
trust authentication. The default listener uses an automatically assigned
loopback port on every supported host. `ServerListen::tcp_port` selects a fixed
TCP port. On Unix hosts only, `ServerListen::unix` or
`ServerListen::unix_port` selects a PostgreSQL-style Unix socket directory.
The resolved directory must be valid UTF-8 so the returned connection string
preserves its exact path across Rust drivers and ORMs.
The server deliberately owns one connected client at a time; use the separate
postmaster product for concurrent sessions.

The crate packages no mutable runtime downloads. Cargo resolves the matching
runtime, AOT, tool, and selected extension artifacts built from the same
`liboliphaunt-wasix` source identity.
