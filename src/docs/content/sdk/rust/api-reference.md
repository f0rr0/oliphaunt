---
title: API Reference
description: Rust SDK API map for builders, runtime modes, query results, lifecycle, and data movement.
---

# API Reference

Use the Rust API reference for exact signatures. This page maps the public
surface so you can jump from a product concept to the item you need.

| Area | Public surface | Use it for |
| --- | --- | --- |
| Opening | `Oliphaunt::builder()`, `OliphauntBuilder`, `DatabaseStorage` | Choose storage, startup identity, PostgreSQL GUCs, and extensions |
| Runtime | `direct()`, `broker()`, `open()`, `open_server()` | Open an embedded database or the concrete local-server handle; each terminal rejects options belonging to another topology |
| Single-statement SQL | `query`, `execute`, parameterized variants, fluent `sql(...).bind(...)` | Return a row-shaped result or assert that one extended-query command returns no rows |
| Multi-statement and metadata | `exec`, `describe`, fluent `sql(...).describe()` | Return ordered simple-query results or resolve parameter/result OIDs without executing; use the fluent form for typed parameters |
| Parameters and rows | `TypeOid`, `Parameter`, `IntoParameter`, `ValueFormat`, `QueryRow::try_get`, `FromSql` | Encode typed/null values and decode by OID-validated index or unambiguous name while retaining raw bytes |
| Raw protocol | `exec_protocol_raw`, `exec_protocol_raw_stream` | Send PostgreSQL protocol bytes as one owned response or bounded callback chunks |
| Transactions | callback `transaction`, `Transaction::rollback`, `Transaction::is_closed` | Pin the physical session and explicitly roll back without a later commit |
| Lifecycle | `is_closed`, `cancel`, `close` | Observe terminal retirement, cancel active work out of band through the pre-teardown drain phase, and establish a close cutoff that rejects later SQL |
| Data movement | database `backup`, static `Oliphaunt::restore` | Export and restore the one embedded physical archive |
| Optional tools | `pg_dump`, `psql`, `PgDumpOptions`, `PsqlOptions` from `oliphaunt-tools` | Run standard logical tools against a native server connection string without adding tools to the core SDK |
| Diagnostics | result `notices`, `Error`, `PostgresError`, `DecodeError` | Preserve PostgreSQL notices and SQLSTATE fields separately from lifecycle and codec failures |

```rust
let result = db
    .sql("SELECT $1::int4 AS answer")
    .bind(41_i32)
    .query()
    .await?;
let answer: i32 = result.rows()[0].try_get("answer")?;
```

The cross-SDK behavior follows the
[stable database API](https://github.com/f0rr0/oliphaunt/blob/main/docs/architecture/stable-database-api.md).

The Rust SDK is the full native mode surface for Tauri and Rust desktop apps.
Use server mode when you need independent PostgreSQL clients; cloned direct-mode
handles still share one serialized session.
