---
title: Kotlin API reference
description: Android configuration, coroutine operations, typed results, and exceptions.
---

Import `dev.oliphaunt.*`. The Android `Oliphaunt` facade prepares runtime resources and returns an `OliphauntDatabase`.

## Open and restore

| Function | Result |
| --- | --- |
| `Oliphaunt.open(context, config, runtimeDirectory, resourceRoot)` | Suspends and returns `OliphauntDatabase` |
| `Oliphaunt.restore(context, destination, bytes)` | Restores into a new or empty `File` destination |

Only `context` is required for `open`. Resource overrides are optional `File` values; normal applications use package defaults.

| `OliphauntConfig` field | Type / default |
| --- | --- |
| `storage` | `DatabaseStorage.TemporaryDirectory` |
| Persistent storage | `DatabaseStorage.Directory(File)` |
| `startupGucs` | `List<PostgresStartupGuc>`; empty |
| `username`, `database` | Nullable strings; fresh roots use `postgres` |
| `extensions` | `List<String>`; empty |

The spelling is `startupGucs` in Kotlin. `PostgresStartupGuc` carries a setting name and value.

## Query extensions

`query`, `execute`, `exec`, and `describe` are public extension functions on database and transaction handles. Import them explicitly or use the package import above.

`query(sql, parameters)` returns `QueryResult`; `execute` returns `CommandResult`. `exec` returns ordered results for multiple statements, and `describe` returns statement metadata. Parameters are `List<QueryParam>` values such as `QueryParam.int(...)` and `QueryParam.text(...)`.

Read `result.rows` and decode with `row.value(column, decoder)`, using a name or index and a `PostgresDecoders` member. Raw bytes are available through `raw`, text through `text`, and null values remain nullable. Duplicate column names require positional lookup.

## Transactions and lifecycle

`transaction { tx -> ... }` returns the callback result after commit. Throwing rolls back. The callback receives typed query methods and `rollback()`; the handle expires after settlement. Savepoints are allowed, but manual outer transaction-lifecycle SQL is unsupported.

`backup()` returns `ByteArray`. `cancel()` interrupts active work. `close()` performs observable teardown and `isClosed` reports terminal state. All are suspend functions except the state property. Coroutine cancellation alone is not the PostgreSQL interrupt API.

## Raw protocol

`execProtocolRaw(request)` returns a buffered `ByteArray`. `execProtocolRawStream` delivers raw chunks through a synchronous callback. Do not re-enter ordinary database or transaction methods from that callback. These methods belong to the database, not callback transactions.

## Exceptions

`PostgresException` contains `postgresError`, including nullable `sqlstate`. `OliphauntException` represents SDK failures. Composite transaction exceptions preserve `callbackError` plus `rollbackError` or `databaseError`. An unrecoverable protocol or teardown failure makes the database terminal; close it and reopen persistent storage when appropriate.

See the [Kotlin guide](/docs/sdk/kotlin/guide) for recipes and troubleshooting.
