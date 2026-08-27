---
title: API Reference
description: Rust SDK API map for builders, runtime modes, query results, lifecycle, and data movement.
---

# API Reference

Use the Rust API reference for exact signatures. This page maps the public
surface so you can jump from a product concept to the item you need.

| Area | Public surface | Use it for |
| --- | --- | --- |
| Execution placement | root `Oliphaunt`; `oliphaunt::worker::{Oliphaunt, OliphauntServer}` | Run synchronously on the opening/calling thread, or explicitly choose a dedicated owner thread with async methods |
| Opening | `Oliphaunt::builder()`, placement-specific `OliphauntBuilder`, `DatabaseStorage` | Choose storage, startup identity, PostgreSQL GUCs, and extensions |
| Topology | `direct()`, `broker()`, `open()`, `open_server()` | Independently choose an in-process database, broker process, or concrete local-server handle; each terminal rejects options belonging to another topology |
| Single-statement SQL | `query`, `execute`, parameterized variants, fluent `sql(...).bind(...)` | Return a row-shaped result or assert that one extended-query command returns no rows |
| Multi-statement and metadata | `exec`, `describe`, fluent `sql(...).describe()` | Return ordered simple-query results or resolve parameter/result OIDs without executing; use the fluent form for typed parameters |
| Parameters and rows | `TypeOid`, `Parameter`, `IntoParameter`, `ValueFormat`, `QueryRow::try_get`, `FromSql` | Encode typed/null values and decode by OID-validated index or unambiguous name while retaining raw bytes |
| Raw protocol | `exec_protocol_raw`, `exec_protocol_raw_stream` | Send PostgreSQL protocol bytes as one owned response or bounded callback chunks |
| Transactions | callback `transaction`, `Transaction::rollback`, `Transaction::is_closed` | Pin the physical session and explicitly roll back without a later commit |
| Lifecycle | `is_closed`, `cancel`, root `cancel_handle`, `close` | Observe terminal retirement, interrupt work out of band, and close synchronously or at the worker FIFO boundary |
| Data movement | database `backup`, static `Oliphaunt::restore` | Export and restore the one embedded physical archive |
| Optional tools | `pg_dump`, `psql`, `PgDumpOptions`, `PsqlOptions` from `oliphaunt-tools` | Run standard logical tools against a native server connection string without adding tools to the core SDK |
| Diagnostics | result `notices`, `Error`, `PostgresError`, `DecodeError` | Preserve PostgreSQL notices and SQLSTATE fields separately from lifecycle and codec failures |

```rust
let result = db
    .sql("SELECT $1::int4 AS answer")
    .bind(41_i32)
    .query()?;
let answer: i32 = result.rows()[0].try_get("answer")?;
```

Root database and server handles are exclusive, `!Send + !Sync`, and use
`&mut self` for operations. Their raw-stream callbacks execute inline and may
borrow caller state. Obtain a root `CancelHandle` before entering a long call
when another thread must be able to interrupt it.

Worker handles are cloneable and `Send + Sync`; their methods return `Send`
futures and their raw-stream callbacks run on the owner thread, so callbacks
must be `Send + 'static`. One worker handle still represents one serialized
PostgreSQL session rather than a connection pool.

The cross-SDK behavior follows the
[stable database API](https://github.com/f0rr0/oliphaunt/blob/main/docs/architecture/stable-database-api.md).

The Rust SDK is the full native topology surface for Tauri and Rust desktop
apps. Use server mode when you need independent PostgreSQL clients. Choosing
`oliphaunt::worker` changes scheduling, not topology or session cardinality.
