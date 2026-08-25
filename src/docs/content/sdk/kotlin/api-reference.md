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
| SQL | `query`, `execute`, `QueryResult` | Run SQL and read typed values from coroutine code |
| Raw protocol | `execProtocolRaw`, `execProtocolStream` | Send PostgreSQL protocol bytes as one result or callback chunks through the serialized session |
| Transactions | `transaction`, `OliphauntTransaction` | Keep transaction work inside the pinned session boundary |
| Lifecycle | `checkpoint`, `cancel`, `close` | Coordinate active work and close cleanly |
| Data movement | `backup`, static `restore` | Move app data through the native physical archive |
| Errors | `OliphauntException`, `PostgresException` | Handle SDK errors and PostgreSQL SQLSTATE data |

Android apps use the Android facade for packaged runtime resources. It keeps
native library loading, selected extension assets, and app-private storage in
the platform layer.
