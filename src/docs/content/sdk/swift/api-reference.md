---
title: API Reference
description: Swift SDK API map for Apple app storage, async database calls, lifecycle, and native resources.
---

# API Reference

Use the Swift DocC reference for exact declarations. This page maps the Apple
SDK surface by task.

| Area | Public surface | Use it for |
| --- | --- | --- |
| Opening | `OliphauntDatabase.open`, `OliphauntConfiguration`, `OliphauntDatabaseStorage` | Use temporary storage by default or an explicit persistent file URL |
| Single-statement SQL | `query`, `execute`, `OliphauntQueryResult` | Return ordered raw rows or assert that one extended-query command returns no rows |
| Multi-statement and metadata | `exec`, `describe` | Return ordered command-or-row results or resolve parameter/result OIDs without executing |
| Parameters and rows | `OliphauntPostgresOID`, `OliphauntQueryParam`, `OliphauntValueFormat`, `OliphauntQueryRow.value`, `OliphauntPostgresDecodable` | Encode typed/null values and decode by OID-validated index or unambiguous name while retaining `Data` |
| Raw protocol | database `execProtocolRaw`, `execProtocolRawStream` | Send PostgreSQL protocol bytes as one result or synchronous callback chunks; raw ownership stays outside managed transaction handles, same-handle callback reentry is rejected, confirmed callback recovery leaves the session reusable, and transport/recovery failures poison it |
| Transactions | `transaction`, transaction `query`/`execute`/`exec`/`describe`, `OliphauntTransaction.rollback`, transaction `isClosed` | Keep typed work on the actor-owned session, return to commit, explicitly roll back without a later commit, and use savepoints for nested work |
| Lifecycle | database `isClosed`, `cancel`, `close` | FIFO admission drains calls accepted before the close cutoff; cancellation remains available until native teardown starts |
| Data movement | `backup`, static `restore(destination:bytes:)` | Move user data through the native physical archive |
| Diagnostics | result `notices`, `OliphauntError`, `OliphauntPostgresError`, `OliphauntTransactionRollbackError`, `OliphauntTransactionDatabaseError` | Preserve PostgreSQL diagnostics and independent transaction failures without dropping the callback error |

```swift
let result = try await database.query(
    "SELECT $1::int4 AS answer",
    parameters: [.int32(41)]
)
let answer: Int32? = try result.rows[0].value(named: "answer")
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
transaction still fails with the stored original error.

After automatic rollback succeeds, the original callback error is rethrown.
`OliphauntTransactionRollbackError` reports a callback-plus-rollback failure in
its public `callbackError` and `rollbackError` fields. If the callback throws a
different error after an earlier independent database or protocol failure
poisoned or expired ownership, `OliphauntTransactionDatabaseError` reports both
through its public `callbackError` and `databaseError` fields, and the database
is close-only. Ordinary PostgreSQL statement errors that remain safely
rollbackable do not automatically create either composite error.

iOS and macOS apps start with `OliphauntDatabase`. The C ABI remains the
lower-level boundary used by the Swift package.
