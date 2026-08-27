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
| Async opening | root `Oliphaunt`, `OliphauntBuilder`, `OliphauntServerBuilder` | Await owner-thread database open or local-server start; memory is the default |
| Explicit blocking | `oliphaunt_wasix::blocking::{Oliphaunt, OliphauntBuilder, OliphauntServer, OliphauntServerBuilder}` | Run the same WASIX engine through exclusive `&mut self` database and terminally replayable server handles |
| Storage | `DatabaseStorage` | Select memory or a caller-supplied host directory |
| Async single-statement SQL | `query`, `execute`, parameterized variants, fluent `sql(...).bind(...)` | Await one extended-query command through `&self`; return decoded rows or a command result |
| Async multi-statement and metadata | `exec`, `describe`, fluent `describe` | Await ordered simple-query results or parameter/result OIDs without executing |
| Parameters and rows | `TypeOid`, `Parameter`, `IntoParameter`, `ValueFormat`, `QueryRow::try_get`, `FromSql` | Encode typed/null values and decode by OID-validated index or unambiguous name while retaining raw bytes |
| Raw protocol | async `exec_protocol_raw`, `exec_protocol_raw_stream` | Send PostgreSQL protocol bytes or synchronously consume bounded owner-thread callback chunks; COPY output uses the guest stream pump |
| Transactions | async or blocking callback `transaction`, `Transaction` methods, `rollback`, `is_closed` | Pin the one physical session, commit on callback success, or roll back on error, explicit request, abandoned future, or blocking callback panic |
| Lifecycle | `Clone`, `is_closed`, async `close` | Share one session across `Send + Sync` handles, retry pre-shutdown validation, and memoize one terminal teardown result |
| Server/proxy | root async or explicit blocking `OliphauntServer` APIs, `is_closed`, `close` | Expose one-client-at-a-time PostgreSQL-compatible access with observable, replayable terminal close semantics |
| Extensions | `extensions::Extension`, exact constants, `ALL`, `by_sql_name` | Select WASIX-built extension artifacts by SQL name |
| Backup/restore | async `backup()`, async `Oliphaunt::restore` | Move the one WASIX physical archive between compatible stores without blocking the caller's executor thread |
| Tools | async root `tools::pg_dump(&Oliphaunt, ...)`, `tools::psql(&Oliphaunt, ...)`; synchronous equivalents under `blocking::tools` | Queue packaged PostgreSQL logical dump and non-interactive psql on the selected database owner |
| Diagnostics | result `notices`, `Result<T>`, `Error`, `PostgresError`, `TransactionRollbackError`, `DecodeError` | Preserve PostgreSQL diagnostics and both callback/rollback failures separately from runtime and codec failures |

```rust
let result = database
    .sql("SELECT $1::int4 AS answer")
    .bind(41_i32)
    .query().await?;
let answer: i32 = result.rows()[0].try_get("answer")?;
```

## Calling and ownership contract

The crate root is not a synchronous API disguised as futures. Opening creates
one SDK-owned thread, constructs the Wasmer store there, and keeps all direct
PostgreSQL operations on that owner. `Oliphaunt` is `Clone + Send + Sync`, its
fallible operations are async and take `&self`, and every clone addresses the
same session.

Direct database work, transaction boundaries, and close enter one owner queue
in admission order. Ordinary work and transaction begin share a bounded
64-entry admission budget; lifecycle controls have reserved capacity but cannot
overtake earlier work. Close drains admissions before its atomic cutoff and
rejects later ordinary work. Concurrent callers subscribe to that exact attempt
before releasing admission and therefore receive its same result. A validation
failure before shutdown leaves admission open for a distinct retry. Once
database shutdown or server stop begins, `is_closed()` is true and every later
close replays the terminal attempt's exact success or failure. A callback
transaction pins the session and rejects unpinned work until it settles. Server
clients use separate socket sessions rather than this direct queue. A raw-stream
callback runs synchronously on the owner thread to apply backpressure and must
not await reentrant work on the same database.

Use the explicit blocking module when a caller-thread contract is the desired
performance and scheduling choice:

```rust
use oliphaunt_wasix::blocking::Oliphaunt;

fn query_on_this_thread() -> oliphaunt_wasix::Result<()> {
    let mut database = Oliphaunt::open()?;
    let result = database.sql("SELECT $1::int4 AS answer").bind(41_i32).query()?;
    let answer: i32 = result.rows()[0].try_get("answer")?;
    assert_eq!(answer, 41);
    database.close()
}
```

The cross-SDK behavior follows the
[stable database API](https://github.com/f0rr0/oliphaunt/blob/main/docs/architecture/stable-database-api.md).

The Rust WASIX binding owns its packaged PostgreSQL runtime assets and Rust host
behavior. Native direct, broker, and server topologies are documented in the
native SDK sections. The WASIX TypeScript root owns a Worker; its explicit
`@oliphaunt/wasix-ts/blocking` entry point opts into caller-realm execution.
TypeScript exposes equivalent optional tools and a local server on
socket-capable hosts through TypeScript-native package entry points, while
sharing the WASIX physical backup/restore contract rather than Rust signatures.

All fallible methods return the crate-owned `Result<T>`. `Error` keeps runtime
implementation details private, implements `std::error::Error`, and exposes
`postgres_error()` and `transaction_rollback_error()`; use `PostgresError` when
SQLSTATE and ordered backend error fields matter.
