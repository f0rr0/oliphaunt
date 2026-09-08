---
title: WASIX Rust API reference
description: Database types, builders, queries, tools, errors, and ownership in oliphaunt-wasix.
---

Import from `oliphaunt_wasix`. The crate exports synchronous and async database and server types.

## Types and ownership

| Type | Contract |
| --- | --- |
| `Oliphaunt` | Synchronous; neither `Send` nor `Sync`; stays on one OS thread |
| `AsyncOliphaunt` | Cloneable `Send + Sync`; one shared owner thread and session |
| `OliphauntServer` | Synchronous lifecycle for a single-client local endpoint |
| `AsyncOliphauntServer` | Async lifecycle for the same endpoint model |

`Oliphaunt::open()` uses `DatabaseStorage::Memory`. `.builder().storage(DatabaseStorage::Directory(path)).open()` persists data. Builders also accept `startup_guc`, `startup_gucs`, `username`, `database`, and typed `extension` selections.

## Query operations

`query`, `query_with_params`, `execute`, `execute_with_params`, `exec`, and `describe` expose PostgreSQL queries and metadata. `sql(...).bind(...).query()` or `.execute()` provides fluent parameter binding. Results are buffered; use `rows()` and `try_get` with compatible Rust types.

`transaction(callback)` owns the session until settlement and returns `TransactionResult`. Return a result or use the transaction rollback API. Savepoints are supported; manual outer transaction-lifecycle SQL is unsupported. Transaction handles do not expose raw protocol or tools.

## Data movement and tools

`backup()` returns archive bytes; `Oliphaunt::restore(destination, bytes)` restores to new or empty persistent storage. `AsyncOliphaunt` offers async versions.

With the `tools` feature, database handles expose `pg_dump(PgDumpOptions)` and `psql(PsqlOptions)`. The `tools` namespace supplies option and error types. Output is UTF-8 text. These methods exclusively use and reset the session.

## Lifecycle and errors

`close()` observes teardown and `is_closed()` reports state. Closing one async clone closes the shared session. There is no public direct-query cancellation API.

`Error` implements Rust error traits. `kind()` returns a non-exhaustive `ErrorKind`; `postgres_error()` exposes PostgreSQL diagnostics including SQLSTATE. Composite transaction errors retain callback and rollback/database failures separately.

## Raw protocol

Buffered and callback-streamed protocol APIs belong to database handles. Stream callbacks require owned `Send + 'static` captures, including on the synchronous API. `RawStreamError` separates callback failure, callback panic, and database/recovery failure. Only confirmed recovery permits continued session use.

See [Runtime behavior](/docs/sdk/wasix-rust/runtime) and [Dump and restore](/docs/sdk/wasix-rust/dump-restore) for constraints and complete examples.
