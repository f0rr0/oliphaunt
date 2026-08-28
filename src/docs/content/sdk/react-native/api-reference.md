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
| Single-statement SQL | decoded `query`, byte-preserving `queryRaw`, `execute` | Read object or array rows, retain exact wire rows, or assert that a command returns no rows |
| Multi-statement and metadata | `exec`, `describe` | Return simple-query results in order or resolve parameter/result OIDs without executing |
| Parameters and codecs | `text`, `binary`, `typedNull`, `json`, `array`, `postgresOids`, per-query encoders and decoders | Use safe scalar inference, deterministic PostgreSQL types, or extension-owned OID codecs |
| Transactions | callback `transaction`, transaction `rollback`, transaction `closed` | Pin the mobile session for a callback and explicitly roll back without a later commit |
| Raw protocol | database `execProtocolRaw`, `execProtocolRawStream` | Send PostgreSQL protocol bytes as one result or synchronous callback chunks through JSI `ArrayBuffer`; transaction handles deliberately do not expose this bypass, and callbacks cannot return thenables or reenter the same handle (`cancel` remains out of band) |
| Lifecycle | read-only `closed`, `cancel`, `close`, `Symbol.asyncDispose` | Cancel remains out of band while the close cutoff drains admitted work, stops at native teardown, and forgotten handles use exact-generation best-effort cleanup |
| Data movement | `backup`, `restore` | Delegate archive validation and destination materialization to Swift or Kotlin |
| Diagnostics | query-scoped `notices`, standard `Error`, `PostgresError` | Preserve PostgreSQL notices and SQLSTATE data in TypeScript |

```ts
const result = await db.query('SELECT $1::int4 AS answer', [41]);
const answer = result.rows[0]?.answer;
const fields = (await db.describe('SELECT $1::uuid', [2950])).fields;
```

The cross-SDK behavior follows the
[stable database API](https://github.com/f0rr0/oliphaunt/blob/main/docs/architecture/stable-database-api.md).

Inside a callback transaction, do not issue manual `BEGIN`, `START
TRANSACTION`, `COMMIT`, `END`, `ABORT`, `PREPARE TRANSACTION`, or `AND CHAIN`.
Use callback return/throw or `rollback()`; `SAVEPOINT` and `ROLLBACK TO` are
supported. `ROLLBACK AND CHAIN` is unsupported and wire-indistinguishable from
`ROLLBACK TO`, so Oliphaunt rejects `ROLLBACK`/`ABORT ... AND CHAIN` before
dispatch and enforces every other ownership boundary from PostgreSQL response
frames. A proven escape makes the database close-only and suppresses any
follow-up SDK transaction command.

After a callback failure, a successful automatic rollback rethrows the original
value unchanged. If rollback also fails, an `AggregateError` contains the
callback failure followed by the rollback failure. If the callback throws a
different value after an earlier independent database or protocol failure
poisoned or expired ownership, an `AggregateError` contains the callback failure
followed by that database failure and the database is close-only. Ordinary
PostgreSQL statement errors that remain safely rollbackable do not automatically
produce an aggregate.

The React Native SDK owns the JavaScript boundary. Runtime behavior remains
platform-native: Apple calls flow through Swift, Android calls flow through
Kotlin.
