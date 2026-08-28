---
title: API Reference
description: Kotlin and Android SDK API map for configuration, coroutine execution, lifecycle, and resources.
---

# API Reference

Use the Dokka reference for exact declarations. This page maps the Kotlin SDK
surface by task.

| Area | Public surface | Use it for |
| --- | --- | --- |
| Opening | `Oliphaunt.open`, `OliphauntConfig`, `DatabaseStorage` | Use temporary storage by default or an explicit persistent directory |
| Android facade | `Oliphaunt` | Resolve Android resources, ABI assets, and app-context defaults |
| Single-statement SQL | `query`, `execute`, `QueryResult` | Return ordered raw rows or assert that one extended-query command returns no rows |
| Multi-statement and metadata | `exec`, `describe` | Return ordered command-or-row results or resolve parameter/result OIDs without executing |
| Parameters and rows | `PostgresOid`, `QueryParam`, `ValueFormat`, `QueryRow.value`, `PostgresDecoder`, `PostgresDecoders` | Encode typed/null values and decode by OID-validated index or unambiguous name while retaining `ByteArray` |
| Raw protocol | database `execProtocolRaw`, `execProtocolRawStream` | Send PostgreSQL protocol bytes as one result or synchronous callback chunks; raw ownership stays outside managed transaction handles, all same-handle work is rejected while a callback runs, confirmed callback recovery leaves the session reusable, and transport/recovery failures poison it |
| Transactions | `transaction`, transaction `query`/`execute`/`exec`/`describe`, `OliphauntTransaction.rollback`, transaction `isClosed` | Keep typed work inside the pinned session, return to commit, explicitly roll back without a later commit, and use savepoints for nested work |
| Lifecycle | database `isClosed`, `cancel`, `close` | FIFO admission drains calls accepted before the close cutoff; cancellation remains available until native teardown starts, with nonblocking cleaner fallback for forgotten handles |
| Data movement | `backup`, static `restore` | Move app data through the native physical archive |
| Diagnostics | result `notices`, `OliphauntException`, `PostgresException`, `OliphauntTransactionRollbackException`, `OliphauntTransactionDatabaseException` | Preserve PostgreSQL diagnostics and independent transaction failures without dropping the callback exception |

```kotlin
val result = database.query(
    "SELECT $1::int4 AS answer",
    listOf(QueryParam.int(41)),
)
val answer = result.rows.first().value("answer", PostgresDecoders.int)
```

The cross-SDK behavior follows the
[stable database API](https://github.com/f0rr0/oliphaunt/blob/main/docs/architecture/stable-database-api.md).

Managed transaction callbacks must not issue outer-lifecycle SQL: `BEGIN`/`START
TRANSACTION`, `COMMIT`/`END`, a full `ROLLBACK`/`ABORT` (with or without `AND
[NO] CHAIN`), or `PREPARE TRANSACTION`. Use
`rollback()` or return from the callback for outer settlement; `SAVEPOINT`,
`RELEASE SAVEPOINT`, and `ROLLBACK TO SAVEPOINT` remain supported SQL. PostgreSQL
reports `ROLLBACK TO` and `ROLLBACK AND CHAIN` with the same `ROLLBACK` command
tag and transactional ready status, so the SDK rejects `ROLLBACK`/`ABORT ...
AND CHAIN` before dispatch and still validates every actual protocol boundary.
If the callback catches a poisoning database or rollback error and returns, the
transaction still fails with the stored original exception.

After automatic rollback succeeds, the original callback exception is rethrown.
`OliphauntTransactionRollbackException` exposes `callbackError` and
`rollbackError`, uses the callback as `cause`, and records the rollback as a
suppressed exception. If the callback throws a different exception after an
earlier independent database or protocol failure poisoned or expired ownership,
`OliphauntTransactionDatabaseException` exposes `callbackError` and
`databaseError`, uses the callback as `cause`, and records the database error as
a suppressed exception; the database is close-only. Ordinary PostgreSQL
statement errors that remain safely rollbackable do not automatically create
either composite exception.

Android apps use the Android facade for packaged runtime resources. It keeps
native library loading, selected extension assets, and app-private storage in
the platform layer.
