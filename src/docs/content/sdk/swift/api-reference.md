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
| SQL | `query`, `execute`, `OliphauntQueryResult` | Run SQL and read typed values by row and column |
| Raw protocol | `execProtocolRaw`, `execProtocolStream` | Send PostgreSQL protocol bytes as one result or callback chunks without blocking the main actor |
| Transactions | `transaction`, `OliphauntTransaction` | Keep transaction work on the actor-owned session |
| Lifecycle | `checkpoint`, `cancel`, `close` | Coordinate active work and close cleanly |
| Data movement | `backup`, static `restore(destination:bytes:)` | Move user data through the native physical archive |
| Errors | `OliphauntError`, `OliphauntPostgresError` | Handle Swift errors and PostgreSQL SQLSTATE data |

iOS and macOS apps start with `OliphauntDatabase`. The C ABI remains the
lower-level boundary used by the Swift package.
