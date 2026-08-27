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
| Direct opening | root `Oliphaunt`, `OliphauntBuilder`, `OliphauntServerBuilder` | Open on the calling thread with memory storage by default |
| Explicit worker | `oliphaunt_wasix::worker::{Oliphaunt, OliphauntBuilder, OliphauntServer, OliphauntServerBuilder}` | Keep an async executor responsive through cloneable handles backed by dedicated owner threads |
| Storage | `DatabaseStorage` | Select memory or a caller-supplied host directory |
| Single-statement SQL | `query`, `execute`, parameterized variants, fluent `sql(...).bind(...)` | Run one extended-query command and return decoded rows or a command result |
| Multi-statement and metadata | `exec`, `describe`, fluent `describe` | Return ordered simple-query results or parameter/result OIDs without executing |
| Parameters and rows | `TypeOid`, `Parameter`, `IntoParameter`, `ValueFormat`, `QueryRow::try_get`, `FromSql` | Encode typed/null values and decode by OID-validated index or unambiguous name while retaining raw bytes |
| Raw protocol | `exec_protocol_raw`, `exec_protocol_raw_stream` | Send PostgreSQL protocol bytes or consume bounded callback chunks; COPY output uses the guest stream pump |
| Transactions | direct or worker callback `transaction`, `Transaction` methods, `rollback`, `is_closed` | Pin the physical session and commit on callback success or roll back on failure or explicit request |
| Lifecycle | direct `is_closed`, `close`; worker `Clone + Send + Sync`, async `close` | Choose exclusive caller ownership or one shared FIFO, with replayable terminal teardown |
| Server/proxy | root direct or `worker::OliphauntServer` APIs, `is_closed`, `close` | Expose one-client-at-a-time PostgreSQL-compatible access with synchronous or async lifecycle calls |
| Extensions | `extensions::Extension`, exact constants, `ALL`, `by_sql_name` | Select WASIX-built extension artifacts by SQL name |
| Backup/restore | direct `backup()`, `Oliphaunt::restore`; async equivalents under `worker` | Move the one WASIX physical archive between compatible stores |
| Tools | root `tools::pg_dump(&mut Oliphaunt, ...)`, `tools::psql(&mut Oliphaunt, ...)`; async equivalents under `worker::tools` | Run packaged PostgreSQL logical dump and non-interactive psql through the selected execution contract |
| Diagnostics | result `notices`, `Result<T>`, `Error`, `PostgresError`, `TransactionRollbackError`, `DecodeError` | Preserve PostgreSQL diagnostics and both callback/rollback failures separately from runtime and codec failures |

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
backpressure.

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

The explicit `worker` module moves that direct implementation to a dedicated
owner thread. `worker::Oliphaunt` is `Clone + Send + Sync`; its async methods
take `&self`, and every clone addresses the same session. Work, transaction
boundaries, and close enter one FIFO in admission order. Ordinary work and
transaction begin share a bounded 64-entry admission budget. Lifecycle controls
retain reserved capacity but cannot overtake earlier work.

```rust
use oliphaunt_wasix::worker::Oliphaunt;

async fn query_on_worker() -> oliphaunt_wasix::Result<()> {
    let database = Oliphaunt::open().await?;
    let result = database.sql("SELECT $1::int4 AS answer").bind(41_i32).query().await?;
    let answer: i32 = result.rows()[0].try_get("answer")?;
    assert_eq!(answer, 41);
    database.close().await
}
```

Worker close drains earlier admissions before its atomic cutoff and rejects
later work. Concurrent callers receive the same close result. A callback
transaction pins the session and rejects unpinned work until it settles. A
worker raw-stream callback runs synchronously on the owner thread and must not
reenter that database.

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
`postgres_error()` and `transaction_rollback_error()`; use `PostgresError` when
SQLSTATE and ordered backend error fields matter.
