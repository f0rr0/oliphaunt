---
title: TypeScript API Reference
description: TypeScript API map for desktop JavaScript, native engines, SQL, lifecycle, and data movement.
---

# TypeScript API Reference

Use the TypeDoc reference for exact declarations. This page maps native
`@oliphaunt/ts` by task; WASIX TypeScript is documented separately.

| Area | Public surface | Use it for |
| --- | --- | --- |
| Opening | `Oliphaunt.open`, `OpenConfig`, `DatabaseStorage` | Open with temporary storage by default or an explicit persistent directory |
| Runtime mode | `engine`, `supportedModes()` | Choose direct, broker, or server where the desktop runtime supports it |
| Capabilities | `capabilities()` | Check protocol, streaming, backup, restore, extension, and lifecycle support |
| SQL | `query`, `execute`, typed result helpers | Run SQL and read typed values from JavaScript |
| Raw protocol | `execProtocolRaw`, protocol utilities | Send PostgreSQL protocol bytes through the selected native path |
| Streaming | `execProtocolStream` | Consume large result sets without materializing one huge JS buffer |
| Data movement | `backup`, `restore`, `RestoreDestinationPolicy` | Restore validated physical archives to an explicit destination |
| Errors | `PostgresError` | Handle SQLSTATE-bearing PostgreSQL failures |

The root package is the only native runtime entrypoint. It detects Node.js,
Bun, or Deno and resolves the matching installed runtime internally; native
binding factories, runtime handles, and runtime-specific package subpaths are
not consumer APIs.

React Native apps use `@oliphaunt/react-native`. This package is for desktop
JavaScript runtimes over the native runtime family. Browser applications use
[`@oliphaunt/wasix-ts`](/docs/sdk/wasix/browser-typescript).
