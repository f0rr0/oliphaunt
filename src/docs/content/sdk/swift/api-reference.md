---
title: Swift API reference
description: Configuration, typed queries, transactions, and errors in the Swift SDK.
---

Import `Oliphaunt`. `OliphauntDatabase` is an actor exposing `async throws` database operations.

## Open and restore

`OliphauntDatabase.open(configuration:)` returns a database. The configuration defaults to `OliphauntConfiguration()`.

| Configuration field | Type / default |
| --- | --- |
| `storage` | `OliphauntDatabaseStorage`; `.temporaryDirectory` |
| Persistent storage | `.directory(URL)` using a file URL, or `.applicationData(name:)` |
| `startupGUCs` | `[OliphauntStartupGUC]`; empty |
| `username`, `database` | Optional strings; fresh roots use `postgres` |
| `extensions` | `[OliphauntExtension]`; empty, typed extension selections |

Construct a startup setting with `OliphauntStartupGUC("name", "value")`. Identity fields select an existing role and database.

`OliphauntDatabase.restore(destination:bytes:)` accepts a destination `URL` and archive `Data`. It restores into new or empty persistent storage.

## Broker mode

`OliphauntBroker.open(configuration:options:)` returns the same database interface from a separate process. Use application-data names for persistent broker storage. See [mobile broker setup](/docs/learn/mobile-stability#broker-mode) for platform requirements, file-based restore, deadlines, and failure handling.

## Queries

| Operation | Purpose |
| --- | --- |
| `query(_:parameters:)` | Buffered typed rows |
| `execute(_:parameters:)` | Command result |
| `exec(_:)` | Results for a multi-statement SQL script |
| `describe(...)` | Statement parameter and column metadata |
| `transaction(_:)` | Exclusive callback transaction |

Query parameters include typed values such as `.string`, `.int32`, and `.int64`. Read a column through `result.rows[index].value(named:)` with an explicit compatible Swift type. Use optional types for nullable columns.

Transaction callbacks receive an `OliphauntTransaction` with typed query methods and `rollback()`. The handle expires when the transaction settles. Returning commits; throwing rolls back. Savepoints are allowed; manually ending or replacing the outer transaction is unsupported.

## Lifecycle and raw protocol

`backup()` returns `Data`. `cancel()` requests an interrupt. `close()` observes shutdown; `isClosed` reports terminal state. Work is serialized on one PostgreSQL session, away from the main actor.

Buffered `execProtocolRaw` and callback `execProtocolRawStream` are database-only interfaces for protocol integrations. Stream callbacks are synchronous backpressure boundaries. Same-handle calls that inherit the callback's task-local context, including `Task { ... }`, are rejected before queueing. Unrelated callers retain their queue order. Detached tasks and dispatch queues do not inherit that context: return from the callback before waiting for their work on the same database. Another database and out-of-band `cancel()` remain available.

See [large mobile responses](/docs/learn/mobile-stability#large-responses) for buffered response limits and streaming alternatives.

## Errors

PostgreSQL errors retain backend diagnostics and SQLSTATE. Runtime, storage, protocol, and lifecycle failures are distinct from ordinary SQL failures.

`OliphauntTransactionRollbackError` retains `callbackError` and `rollbackError`. `OliphauntTransactionDatabaseError` retains `callbackError` and `databaseError` when an independent database failure already invalidated the transaction. A database with uncertain protocol state becomes close-only.

Swift task cancellation alone does not cancel a PostgreSQL query. Call the explicit cancellation API and observe the query result.

See the [Swift guide](/docs/sdk/swift/guide) for application recipes and extension packaging.
