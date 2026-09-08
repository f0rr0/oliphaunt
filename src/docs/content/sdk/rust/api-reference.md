---
title: Rust API reference
description: Native Rust entry points, builder options, queries, transactions, and ownership.
---

The `oliphaunt` crate exports synchronous and asynchronous database APIs. Start with the [quickstart](/docs/sdk/rust) for a complete program.

## Database types

| Type | Ownership | Execution |
| --- | --- | --- |
| `Oliphaunt` | Exclusive, `Send`, not `Sync` | Blocks the caller |
| `AsyncOliphaunt` | Cloneable, `Send + Sync` | Work runs on an SDK thread |
| `OliphauntServer` | Server lifecycle owner | PostgreSQL clients use its endpoint |
| `AsyncOliphauntServer` | Async server lifecycle owner | PostgreSQL clients use its endpoint |

Async clones share one PostgreSQL session. They are not a connection pool.

## Open and configure

`Oliphaunt::open()` creates a temporary direct database. `Oliphaunt::builder()` configures storage and selects `direct().open()` or `broker().open()`. `AsyncOliphaunt` exposes the corresponding async open methods.

`DatabaseStorage::TemporaryDirectory` is disposable; `DatabaseStorage::Directory(PathBuf)` persists data. Builder configuration includes startup PostgreSQL settings, username/database, and exact `Extension` selections. Fresh storage starts with the `postgres` user and database; setting a username does not create a role.

Server builders terminate with `start()`. Listener and server executable options belong to server builders; the broker executable option belongs to broker mode.

## Queries and results

| Operation | Purpose |
| --- | --- |
| `query(sql)` | Buffered typed rows |
| `query_with_params(sql, params)` | Query with parameters |
| `execute(sql)` / `execute_with_params(sql, params)` | Command metadata |
| `sql(sql).bind(value).query()` / `.execute()` | Fluent typed parameters |
| `exec(sql)` | Multiple SQL statements |
| `describe(sql)` | Statement metadata |
| `transaction(callback)` | Callback-owned transaction |

Use `QueryResult::rows()` and `Row::try_get` to decode columns by name or index. The PostgreSQL type and requested Rust type must be compatible; represent nullable values with `Option<T>`.

## Transactions and errors

A transaction exclusively owns the session until settlement. Its typed operations omit raw protocol access. Return a result or use its rollback method; manual outer transaction-control SQL is unsupported. Savepoints are allowed.

`TransactionResult<T, E>` preserves your callback error type. `TransactionError::CallbackAndRollback` retains both failures when rollback was sent and failed. `CallbackAndDatabase` retains an independent database failure that invalidated ownership without sending another rollback. A normal statement error can still be rolled back safely.

Use structured PostgreSQL error fields, including SQLSTATE, to classify database errors. A transport or protocol-recovery failure can leave a handle close-only.

## Backup and lifecycle

`backup()` returns archive bytes. `Oliphaunt::restore(destination, bytes)` restores into new or empty storage; the async type has an async restore operation. Native direct and broker use the same archive family.

`close()` reports teardown errors and makes the handle terminal. `is_closed()` reports its state. Use `cancel_handle()` for out-of-thread cancellation of synchronous work, or `cancel().await` on the async type.

Server handles expose `connection_string()`, closed state, and close. Querying, pooling, and logical tools use ordinary PostgreSQL connections.

## Raw protocol

Buffered and callback-streamed raw protocol APIs are intended for protocol integrations. Root callbacks can borrow caller state; async callbacks must be `Send + 'static`. Callbacks provide synchronous backpressure. Do not re-enter the same database from a callback.

`RawStreamError` distinguishes callback failure from database/recovery failure. A confirmed recovery permits reuse; an independent protocol failure takes precedence and can make the database close-only.

See the [Rust guide](/docs/sdk/rust/guide) for transactions, backups, and runtime recipes.
