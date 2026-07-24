---
title: API Reference
description: TypeScript SDK API map for desktop JavaScript, native assets, broker helpers, SQL, lifecycle, and data movement.
---

# API Reference

Use the TypeDoc reference for exact declarations. This page maps the TypeScript
SDK by task.

| Area | Public surface | Use it for |
| --- | --- | --- |
| Opening | `Oliphaunt.open`, `OpenConfig` | Open a native direct, broker, or server-backed database from Node.js, Bun, or Deno |
| Native assets | asset resolver exports | Locate released runtime artifacts from the package |
| Runtime mode | `engine`, `supportedModes()` | Choose direct, broker, or server where the desktop runtime supports it |
| Capabilities | `capabilities()` | Check protocol, streaming, backup, restore, extension, and lifecycle support |
| SQL | `query`, `execute`, typed result helpers | Run SQL and read typed values from JavaScript |
| Raw protocol | `execProtocolRaw`, protocol utilities | Send PostgreSQL protocol bytes through the selected native path |
| Streaming | `execProtocolStream` | Consume large result sets without materializing one huge JS buffer |
| Broker/server helpers | helper process APIs | Start or connect to a local helper when isolation or PostgreSQL-compatible clients are needed |
| Data movement | `backup`, `restore`, archive helpers | Move roots through validated physical archives |
| Errors | `OliphauntError`, `PostgresError` | Handle SDK errors and SQLSTATE data |

React Native apps use `@oliphaunt/react-native`. This package is for desktop
JavaScript runtimes.
