---
title: API Reference
description: Kotlin and Android SDK API map for configuration, coroutine execution, lifecycle, and resources.
---

# API Reference

Use the Dokka reference for exact declarations. This page maps the Kotlin SDK
surface by task.

| Area | Public surface | Use it for |
| --- | --- | --- |
| Opening | `OliphauntDatabase.open`, `OliphauntConfig` | Open a persistent or temporary root from Kotlin code |
| Android facade | `OliphauntAndroid` | Resolve Android resources, ABI assets, and app-context defaults |
| Runtime mode | `EngineMode`, `supportedModes()` | Discover modes advertised by the selected Android target |
| Capabilities | `EngineCapabilities` | Check protocol, streaming, backup, restore, lifecycle, and extension support |
| SQL | `query`, `execute`, `QueryResult` | Run SQL and read typed values from coroutine code |
| Raw protocol | `execProtocolRaw`, `execProtocolStream` | Send PostgreSQL protocol bytes through the serialized session |
| Transactions | `transaction`, `OliphauntTransaction` | Keep transaction work inside the pinned session boundary |
| Lifecycle | `prepareForBackground`, `resumeFromBackground`, `cancel`, `close` | Coordinate database work with Android app lifecycle transitions |
| Data movement | `backup`, `restore`, `BackupRequest` | Move app data through validated archives and Android file APIs |
| Errors | `OliphauntException`, `PostgresException` | Handle SDK errors and PostgreSQL SQLSTATE data |

Android apps use the Android facade for packaged runtime resources. It keeps
native library loading, selected extension assets, and app-private storage in
the platform layer.
