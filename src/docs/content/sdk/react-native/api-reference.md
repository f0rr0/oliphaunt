---
title: API Reference
description: React Native SDK API map for TypeScript, config plugin, TurboModule, JSI binary transport, and mobile lifecycle.
---

# API Reference

Use the TypeDoc reference for exact declarations. This page maps the React Native
SDK by task.

| Area | Public surface | Use it for |
| --- | --- | --- |
| Opening | `Oliphaunt.open`, `OpenConfig`, `DatabaseStorage` | Use temporary storage by default or select an app-data name or directory |
| Config plugin | Expo plugin options | Include the selected native runtime and exact extension artifacts in iOS and Android builds |
| Database handle | `OliphauntDatabase` | Keep the opened database in app state and route calls through one native handle |
| SQL | `query`, `execute`, `QueryResult` | Run SQL and read typed values from JavaScript |
| Raw protocol | `execProtocolRaw`, `execProtocolStream` | Send PostgreSQL protocol bytes as one result or callback chunks through JSI `ArrayBuffer` transport |
| Lifecycle | `checkpoint`, `cancel`, `close`, `Symbol.asyncDispose` | Coordinate active work and close cleanly |
| Data movement | `backup`, `restore` | Delegate archive validation and destination materialization to Swift or Kotlin |
| Errors | standard `Error`, `PostgresError` | Handle SDK errors and PostgreSQL SQLSTATE data in TypeScript |

The React Native SDK owns the JavaScript boundary. Runtime behavior remains
platform-native: Apple calls flow through Swift, Android calls flow through
Kotlin.
