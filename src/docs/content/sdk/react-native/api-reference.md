---
title: API Reference
description: React Native SDK API map for TypeScript, config plugin, TurboModule, JSI binary transport, and mobile lifecycle.
---

# API Reference

Use the TypeDoc reference for exact declarations. This page maps the React Native
SDK by task.

| Area | Public surface | Use it for |
| --- | --- | --- |
| Opening | `Oliphaunt.open`, `OpenConfig` | Open a database from TypeScript with root, mode, durability, and selected extensions |
| Config plugin | Expo plugin options | Include the selected native runtime and exact extension artifacts in iOS and Android builds |
| Platform support | `supportedModes()`, `capabilities()` | Read what the installed Swift or Kotlin runtime can actually do |
| Database handle | `OliphauntDatabase` | Keep the opened database in app state and route calls through one native handle |
| SQL | `query`, `execute`, `QueryResult` | Run SQL and read typed values from JavaScript |
| Raw protocol | `execProtocolRaw` | Send PostgreSQL protocol bytes through JSI `ArrayBuffer` transport |
| Streaming | `execProtocolStream` | Receive large protocol responses as native-backed chunks |
| Lifecycle | `prepareForBackground`, `resumeFromBackground`, `close` | Coordinate database work with app background and foreground transitions |
| Data movement | `backup`, `restore` | Delegate archive validation and root materialization to Swift or Kotlin |
| Package report | package-size and extension artifact reports | Verify that the app ships only selected extensions and target ABIs |
| Errors | `OliphauntError`, `PostgresError` | Handle SDK errors and PostgreSQL SQLSTATE data in TypeScript |

The React Native SDK owns the JavaScript boundary. Runtime behavior remains
platform-native: Apple calls flow through Swift, Android calls flow through
Kotlin.
