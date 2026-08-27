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
| Topology | `topology` | Use the direct topology (the default) or select the broker topology |
| Server | `Oliphaunt.openServer` | Start PostgreSQL as a server for tools and independent clients |
| Single-statement SQL | decoded `query`, byte-preserving `queryRaw`, `execute` | Read object or array rows by default, retain exact wire rows when needed, or assert a command returns no rows |
| Multi-statement and metadata | `exec`, `describe` | Return simple-query results in statement order or resolve parameter/result OIDs without executing |
| Parameters and codecs | `text`, `binary`, `typedNull`, `json`, `array`, `postgresOids`, per-query encoders and decoders | Use safe scalar inference, deterministic PostgreSQL types, or extension-owned OID codecs |
| Transactions | callback `transaction`, transaction `rollback`, transaction `closed` | Own the physical session for a callback and explicitly roll back without a later commit |
| Raw protocol | `execProtocolRaw`, `execProtocolRawStream`, `ProtocolChunkCallback` | Send PostgreSQL protocol bytes as one owned response or callback chunks through the selected native path |
| Data movement | `backup`, `restore`, `RestoreOptions` | Move the native physical archive to a new or empty destination |
| Optional tools | `pgDump`, `psql`, `PostgresToolError` from `@oliphaunt/tools` | Run standard logical tools against a native server connection string without adding tools to the core SDK |
| Lifecycle | read-only `closed`, `cancel`, `close`, `Symbol.asyncDispose` | Explicitly await cleanup and coordinate active work without a separate readiness API |
| Diagnostics | query-scoped `notices`, `PostgresError` | Preserve ordered PostgreSQL notices and SQLSTATE-bearing error fields |

```ts
const result = await db.query('SELECT $1::int4 AS answer', [41]);
const answer = result.rows[0]?.answer;
const description = await db.describe('SELECT $1::uuid', [2950]);
```

The cross-SDK behavior follows the
[stable database API](https://github.com/f0rr0/oliphaunt/blob/main/docs/architecture/stable-database-api.md).

The root package is the only native runtime entrypoint. It detects Node.js,
Bun, or Deno and resolves the matching installed runtime internally; native
binding factories, runtime handles, and runtime-specific package subpaths are
not consumer APIs.

React Native apps use `@oliphaunt/react-native`. This package is for desktop
JavaScript runtimes over the native runtime family. Browser applications use
[`@oliphaunt/wasix-ts`](/docs/sdk/wasix-typescript).

`close()` and `Symbol.asyncDispose` are the public lifecycle contract. A
forgotten direct, broker, or server object has a best-effort runtime fallback,
but garbage collection is neither prompt nor observable. On Deno the fallback schedules
nonblocking, generation-guarded terminal cleanup: a stale finalizer cannot
close a newer logical lease, and an executed cleanup spends the native database
process lifetime. Broker/server fallbacks schedule cleanup using only an exact
private handle plus a lease generation; stale generations are no-ops. Always
close explicitly when the process must reuse the resident runtime or report
teardown failure.

Native direct close remains retryable only when logical deactivation did not
occur. A broker/server teardown error past its destructive cutoff is terminal:
`closed` is true, later work is rejected, and repeated close calls return the
same attempt outcome. Raw-stream callbacks are synchronous and cannot reenter
same-handle work other than out-of-band cancellation. After `close()` stops
ordinary admission, cancellation remains available until runtime teardown starts.
