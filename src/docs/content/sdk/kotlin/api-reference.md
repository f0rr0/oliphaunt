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
| Raw protocol | `execProtocolRaw`, `execProtocolRawStream` | Send PostgreSQL protocol bytes as one result or synchronous callback chunks; callbacks reject same-handle reentry except out-of-band cancellation |
| Transactions | `transaction`, `OliphauntTransaction.rollback`, transaction `isClosed` | Keep work inside the pinned session and explicitly roll back without a later commit |
| Lifecycle | database `isClosed`, `cancel`, `close` | FIFO admission drains calls accepted before the close cutoff; cancellation remains available until native teardown starts, with nonblocking cleaner fallback for forgotten handles |
| Data movement | `backup`, static `restore` | Move app data through the native physical archive |
| Diagnostics | result `notices`, `OliphauntException`, `PostgresException`, `OliphauntTransactionRollbackException` | Preserve PostgreSQL diagnostics and both callback/rollback failures |

```kotlin
val result = database.query(
    "SELECT $1::int4 AS answer",
    listOf(QueryParam.int(41)),
)
val answer = result.rows.first().value("answer", PostgresDecoders.int)
```

The cross-SDK behavior follows the
[stable database API](https://github.com/f0rr0/oliphaunt/blob/main/docs/architecture/stable-database-api.md).

Android apps use the Android facade for packaged runtime resources. It keeps
native library loading, selected extension assets, and app-private storage in
the platform layer.
