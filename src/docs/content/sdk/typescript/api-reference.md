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
| Execution | `execution` | Use direct execution (the default) or select broker execution |
| Server | `Oliphaunt.openServer` | Start PostgreSQL as a server for tools and independent clients |
| SQL | `query`, `execute`, typed result helpers | Run SQL and read typed values from JavaScript |
| Raw protocol | `execProtocolRaw`, `execProtocolStream` | Send PostgreSQL protocol bytes as one owned response or callback chunks through the selected native path |
| Data movement | `backup`, `restore` | Move the native physical archive to a new or empty destination |
| Optional tools | `pgDump`, `psql`, `PostgresToolError` from `@oliphaunt/tools` | Run standard logical tools against a native server connection string without adding tools to the core SDK |
| Errors | `PostgresError` | Handle SQLSTATE-bearing PostgreSQL failures |

The root package is the only native runtime entrypoint. It detects Node.js,
Bun, or Deno and resolves the matching installed runtime internally; native
binding factories, runtime handles, and runtime-specific package subpaths are
not consumer APIs.

React Native apps use `@oliphaunt/react-native`. This package is for desktop
JavaScript runtimes over the native runtime family. Browser applications use
[`@oliphaunt/wasix-ts`](/docs/sdk/wasix-typescript).
