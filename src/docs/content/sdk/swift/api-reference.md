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
| Raw protocol | `execProtocolRaw`, `execProtocolRawStream` | Send PostgreSQL protocol bytes as one result or synchronous callback chunks; callbacks reject same-handle reentry except out-of-band cancellation |
| Transactions | `transaction`, `OliphauntTransaction.rollback`, transaction `isClosed` | Keep work on the actor-owned session and explicitly roll back without a later commit |
| Lifecycle | database `isClosed`, `cancel`, `close` | FIFO admission drains calls accepted before the close cutoff; cancellation remains available until native teardown starts |
| Data movement | `backup`, static `restore(destination:bytes:)` | Move user data through the native physical archive |
| Diagnostics | result `notices`, `OliphauntError`, `OliphauntPostgresError`, `OliphauntTransactionRollbackError` | Preserve PostgreSQL diagnostics and both callback/rollback failures |

```swift
let result = try await database.query(
    "SELECT $1::int4 AS answer",
    parameters: [.int32(41)]
)
let answer: Int32? = try result.rows[0].value(named: "answer")
```

The cross-SDK behavior follows the
[stable database API](https://github.com/f0rr0/oliphaunt/blob/main/docs/architecture/stable-database-api.md).

iOS and macOS apps start with `OliphauntDatabase`. The C ABI remains the
lower-level boundary used by the Swift package.
