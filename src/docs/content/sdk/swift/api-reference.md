---
title: API Reference
description: Swift SDK API map for Apple app storage, async database calls, lifecycle, and native resources.
---

# API Reference

Use the Swift DocC reference for exact declarations. This page maps the Apple
SDK surface by task.

| Area | Public surface | Use it for |
| --- | --- | --- |
| Opening | `OliphauntDatabase.open`, `OliphauntConfiguration` | Open a persistent or temporary root with Apple-friendly defaults |
| Runtime mode | `OliphauntEngineMode`, `supportedModes()` | Discover modes advertised by the selected Apple target |
| Capabilities | `OliphauntCapabilities` | Check protocol, streaming, backup, restore, lifecycle, and extension support |
| SQL | `query`, `execute`, `OliphauntQueryResult` | Run SQL and read typed values by row and column |
| Raw protocol | `execProtocolRaw`, `execProtocolStream` | Send PostgreSQL protocol bytes without blocking the main actor |
| Transactions | `transaction`, `OliphauntTransaction` | Keep transaction work on the actor-owned session |
| Lifecycle | `prepareForBackground`, `resumeFromBackground`, `cancel`, `close` | Coordinate database work with app lifecycle transitions |
| Data movement | `backup`, `restore`, `OliphauntBackupRequest` | Move user data through validated archives and app-owned file URLs |
| Errors | `OliphauntError`, `OliphauntPostgresError` | Handle Swift errors and PostgreSQL SQLSTATE data |

iOS and macOS apps start with `OliphauntDatabase`. The C ABI remains the
lower-level boundary used by the Swift package.
