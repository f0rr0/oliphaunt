---
title: API Reference
description: Rust SDK API map for builders, runtime modes, query results, lifecycle, and data movement.
---

# API Reference

Use the Rust API reference for exact signatures. This page maps the public
surface so you can jump from a product concept to the item you need.

| Area | Public surface | Use it for |
| --- | --- | --- |
| Calling shape | database `Oliphaunt`, `AsyncOliphaunt`; lifecycle `OliphauntServer`, `AsyncOliphauntServer` | Block the caller directly, or choose cloneable async handles backed by a dedicated owner thread |
| Opening | database `open()`, server `start()`, type-associated `builder()`, `DatabaseStorage` | Use the default temporary direct database, configure direct/broker databases, or start a local server through its dedicated builder |
| Topology | database `direct()`, `broker()`, `open()`; server `OliphauntServer::builder().start()` | Choose an in-process database, broker process, or endpoint/lifecycle-only local-server handle without mixing topology-specific options |
| Single-statement SQL | `query`, `execute`, parameterized variants, fluent `sql(...).bind(...)` | Return a row-shaped result or assert that one extended-query command returns no rows |
| Multi-statement and metadata | `exec`, `describe`, fluent `sql(...).describe()` | Return ordered simple-query results or resolve parameter/result OIDs without executing; use the fluent form for typed parameters |
| Parameters and rows | `TypeOid`, `Parameter`, `IntoParameter`, `ValueFormat`, `QueryRow::try_get`, `FromSql` | Encode typed/null values and decode by OID-validated index or unambiguous name while retaining raw bytes |
| Raw protocol | `exec_protocol_raw`, `exec_protocol_raw_stream`, `RawStreamResult`, `RawStreamError` | Send PostgreSQL protocol bytes as one owned response, or return bounded chunks to an infallible `()` or typed `Result<(), E>` callback |
| Transactions | callback `transaction`, `TransactionResult`, `TransactionError`, `Transaction::rollback`, `Transaction::is_closed` | Pin the physical session, use `?` with `E: From<Error>`, and retain typed business plus settlement failures |
| Lifecycle | database `is_closed`, `cancel`, root `cancel_handle`, `close`; server `connection_string`, `is_closed`, `close` | Observe terminal retirement, interrupt database work out of band, connect external server clients, and close synchronously or at the async owner FIFO boundary |
| Data movement | database `backup`, static `Oliphaunt::restore` | Export and restore the one embedded physical archive |
| Optional tools | `pg_dump`, `psql`, `PgDumpOptions`, `PsqlOptions` from `oliphaunt-tools` | Run standard logical tools against a native server connection string without adding tools to the core SDK |
| Diagnostics | result `notices`, opaque `Error`, non-exhaustive `ErrorKind`, `PostgresError`, `TransactionError`, `RawStreamError`, `DecodeError` | Match stable recovery categories while preserving SQLSTATE, callback, settlement, and codec failures without conflation |

```rust
let result = db
    .sql("SELECT $1::int4 AS answer")
    .bind(41_i32)
    .query()?;
let answer: i32 = result.rows()[0].try_get("answer")?;
```

Root database and server lifecycle handles are exclusive and `Send + !Sync`.
Database operations and synchronous server close use exclusive ownership.
Ownership may move between threads, but the same owner cannot be shared
concurrently. Calls block until completion without first dispatching through an
async SDK owner. Server handles expose no hidden SQL, transaction, raw-protocol,
or cancellation session; use a PostgreSQL client through `connection_string()`.
In native direct mode,
`liboliphaunt` owns PostgreSQL execution on its backend thread, so synchronous
describes the caller's wait rather than PostgreSQL's OS-thread placement.
Raw-stream callbacks execute inline and may borrow caller state.
Their original panic is resumed only after the adapter confirms
`ReadyForQuery`; an independent recovery failure is returned instead and makes
the session close-only.
Use `|chunk| { consume(chunk); }` for infallible delivery. A fallible callback
returns a concrete `Result<(), E>`; a recovered error is
`RawStreamError::Callback(E)`. On the async owner thread, a panic after confirmed
recovery is `CallbackPanicked` and the session remains reusable. A simultaneous
runtime/recovery failure is always `Database` and poisons the session.
Obtain a root `CancelHandle` before entering a long call when another thread
must be able to interrupt it.

`AsyncOliphaunt` handles are cloneable and `Send + Sync`. A method future is
`Send` when its captured inputs, callback, and output are `Send`; raw-stream
callbacks run on the owner thread and therefore must be `Send + 'static`.
Callback panics resolve as SDK errors after confirmed
recovery rather than unwinding on the awaiting thread. One async handle still represents one serialized
PostgreSQL session rather than a connection pool. Ordinary work awaits fair,
bounded admission before entering the owner FIFO; saturation suspends the
future instead of returning a queue-full error.

Transaction callbacks return ordinary `Result<T, E>` with `E: From<Error>`.
`TransactionError::CallbackAndRollback` means rollback was sent and failed;
`CallbackAndDatabase` means an independent database or raw-protocol failure
expired the transaction and no rollback was sent. The corresponding accessors
preserve that distinction.
Managed transaction handles omit raw protocol and do not support manual
transaction-lifecycle SQL or `AND CHAIN`; use callback return, `rollback()`, or
a root raw-protocol adapter that owns the complete lifecycle. Savepoints and
`ROLLBACK TO SAVEPOINT` remain valid.

The cross-SDK behavior follows the
[stable database API](https://github.com/f0rr0/oliphaunt/blob/main/docs/architecture/stable-database-api.md).

The Rust SDK is the full native topology surface for Tauri and Rust desktop
apps. Use server mode when you need independent PostgreSQL clients. Choosing an
`Async*` type changes calling shape and scheduling, not topology or session
cardinality.
