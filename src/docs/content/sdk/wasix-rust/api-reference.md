---
title: Rust WASIX API Reference
description: Rust WASIX API map for protocol types, storage, extensions, and dump/restore.
---

# Rust WASIX API Reference

Use the `oliphaunt-wasix` rustdoc reference for exact declarations. This page
maps the Rust binding by task; it does not describe the separate
[`@oliphaunt/wasix-ts` TypeScript API](/docs/sdk/wasix-typescript/api-reference).

| Area | Public surface | Use it for |
| --- | --- | --- |
| Direct opening | root `Oliphaunt`, `OliphauntBuilder`, `OliphauntServerBuilder` | Open a `!Send + !Sync` database on the calling thread with memory storage by default |
| Asynchronous handles | root `AsyncOliphaunt`, `AsyncOliphauntBuilder`, `AsyncOliphauntServer`, `AsyncOliphauntServerBuilder` | Keep an async executor responsive through cloneable handles backed by dedicated owner threads |
| Storage | `DatabaseStorage` | Select memory or a caller-supplied host directory |
| Single-statement SQL | `query`, `execute`, parameterized variants, fluent `sql(...).bind(...)` | Run one extended-query command and return decoded rows or a command result |
| Multi-statement and metadata | `exec`, `describe`, fluent `describe` | Return ordered simple-query results or parameter/result OIDs without executing |
| Parameters and rows | `TypeOid`, `Parameter`, `IntoParameter`, `ValueFormat`, `QueryRow::try_get`, `FromSql` | Encode typed/null values and decode by OID-validated index or unambiguous name while retaining raw bytes |
| Raw protocol | `exec_protocol_raw`, `exec_protocol_raw_stream`, `RawStreamResult`, `RawStreamError` | Send PostgreSQL protocol bytes or feed bounded chunks to `()` / typed `Result<(), E>` callbacks; COPY output uses the guest stream pump |
| Transactions | synchronous or async callback `transaction`, `TransactionResult`, `TransactionError`, `rollback`, `is_closed` | Pin the physical session, use `?` through `E: From<Error>`, and retain typed callback plus settlement failures; managed handles omit raw protocol and reject manual lifecycle ownership |
| Lifecycle | synchronous `is_closed`, `close`; async `Clone + Send + Sync`, async `close` | Choose exclusive caller ownership or one shared FIFO, with replayable terminal teardown |
| Server/proxy | root `OliphauntServer` or `AsyncOliphauntServer`, `connection_string`, `is_closed`, `close` | Use an exclusive `Send + !Sync` blocking server handle or cloneable `Send + Sync` async lifecycle handle |
| Extensions | root `Extension`, per-feature associated constants, enabled-set `ALL`, `by_sql_name` | Select WASIX-built extension artifacts by SQL name; unavailable selectors do not compile and migrations still own `CREATE EXTENSION` |
| Backup/restore | `Oliphaunt::backup` / `restore`; `AsyncOliphaunt::backup` / `restore` | Move the one WASIX physical archive between compatible stores |
| Tools | database `pg_dump` / `psql`; root `tools::{PgDumpOptions, PsqlOptions, PostgresToolError}` | Run packaged PostgreSQL logical dump and non-interactive psql synchronously or asynchronously through the selected handle |
| Diagnostics | result `notices`, `Result<T>`, opaque `Error`, non-exhaustive `ErrorKind`, `PostgresError`, `DecodeError` | Match stable recovery categories while preserving PostgreSQL diagnostics and typed callback/settlement failures |

```rust
let result = database
    .sql("SELECT $1::int4 AS answer")
    .bind(41_i32)
    .query()?;
let answer: i32 = result.rows()[0].try_get("answer")?;
```

## Calling and ownership contract

The root is the direct API. It constructs the Wasmer store and PostgreSQL
session on the calling thread. Database methods are synchronous, take `&mut
self`, and have no SDK queue or message hop. A transaction borrows the database
exclusively. Raw-stream callbacks run on that same thread and apply immediate
backpressure before the method returns. The retained protocol attachment means
callbacks must own `Send + 'static` captures; use `Arc<Mutex<_>>` for mutable
state rather than borrowing the stack. Because the retained Wasmer store is thread-affine, root
`Oliphaunt` is deliberately `!Send + !Sync`: create, use, close, and drop it on
one OS thread. Choose `AsyncOliphaunt` when the handle itself must move or be
shared across threads.

```rust
use oliphaunt_wasix::Oliphaunt;

fn query_on_this_thread() -> oliphaunt_wasix::Result<()> {
    let mut database = Oliphaunt::open()?;
    let result = database.sql("SELECT $1::int4 AS answer").bind(41_i32).query()?;
    let answer: i32 = result.rows()[0].try_get("answer")?;
    assert_eq!(answer, 41);
    database.close()
}
```

`AsyncOliphaunt` moves that direct implementation to a dedicated owner thread.
It is `Clone + Send + Sync`; its async methods
take `&self`, and every clone addresses the same session. Work, transaction
boundaries, and close enter one FIFO in admission order. Ordinary work and
transaction begin await a fair, bounded admission budget; saturation suspends
the future rather than returning a queue-full error. Lifecycle controls
do not consume that budget and cannot overtake earlier admitted work.
Individual futures are `Send` only when their captured inputs, callbacks, and
outputs satisfy the corresponding `Send` bounds; the handle's auto-traits do
not override user types.

```rust
use oliphaunt_wasix::AsyncOliphaunt;

async fn query_asynchronously() -> oliphaunt_wasix::Result<()> {
    let database = AsyncOliphaunt::open().await?;
    let result = database.sql("SELECT $1::int4 AS answer").bind(41_i32).query().await?;
    let answer: i32 = result.rows()[0].try_get("answer")?;
    assert_eq!(answer, 41);
    database.close().await
}
```

Async close drains work already admitted before its atomic cutoff and rejects
capacity waiters plus later work. A retryable close does not resurrect stale
waiters. Concurrent callers receive the same close result. A callback
transaction pins the session and rejects unpinned work until it settles. An
async raw-stream callback runs synchronously on the owner thread and must not
reenter that database. Callback errors and direct callback panics are surfaced
only after the guest pump confirms recovery. A pump failure is authoritative,
poisons the session until close, and is never masked by the callback outcome.
Recovered async callback panics are `RawStreamError::CallbackPanicked` and leave
the session reusable; pump/recovery failures are `RawStreamError::Database`.

Transaction callbacks return ordinary `Result<T, E>` with `E: From<Error>`.
`CallbackAndRollback` means rollback was attempted and failed;
`CallbackAndDatabase` means an independent database/protocol failure expired
the transaction and host ownership was retired without sending rollback.

The cross-SDK behavior follows the
[stable database API](https://github.com/f0rr0/oliphaunt/blob/main/docs/architecture/stable-database-api.md).

The Rust WASIX binding owns its packaged PostgreSQL runtime assets and Rust host
behavior. Native direct, broker, and server topologies are documented in the
native SDK sections. The WASIX TypeScript root runs in the importing realm; its
explicit `@oliphaunt/wasix-ts/worker` entry point opts into package-owned Worker
execution.
TypeScript exposes equivalent optional tools and a local server on
socket-capable hosts through TypeScript-native package entry points, while
sharing the WASIX physical backup/restore contract rather than Rust signatures.

All fallible methods return the crate-owned `Result<T>`. `Error` keeps runtime
implementation details private, implements `std::error::Error`, and exposes
`postgres_error()` plus `transaction_rollback_errors()` for the callback and
rollback error pair. Use `PostgresError` when SQLSTATE and ordered backend
error fields matter.
