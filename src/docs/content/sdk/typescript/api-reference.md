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
| Server | `Oliphaunt.openServer`, server `connectionString`, `closed`, `close`, `Symbol.asyncDispose` | Own a PostgreSQL listener and connect caller-owned ORMs, drivers, or tools; the handle has no privileged database connection |
| Single-statement SQL | decoded `query`, byte-preserving `queryRaw`, `execute` | Read object or array rows by default, retain exact wire rows when needed, or assert a command returns no rows |
| Multi-statement and metadata | `exec`, `describe` | Return simple-query results in statement order or resolve parameter/result OIDs without executing |
| Parameters and codecs | `text`, `binary`, `typedNull`, `json`, `array`, `postgresOids`, per-query encoders and decoders | Use safe scalar inference, deterministic PostgreSQL types, or extension-owned OID codecs |
| Transactions | callback `transaction`, transaction `rollback`, transaction `closed` | Own the physical session for a callback and explicitly roll back without a later commit |
| Raw protocol | database `execProtocolRaw`, `execProtocolRawStream` | Send PostgreSQL protocol bytes as one owned response or synchronous callback chunks through the selected native path; transaction and server handles do not expose this bypass |
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

Inside a callback transaction, do not issue manual `BEGIN`, `START
TRANSACTION`, `COMMIT`, `END`, `ABORT`, `PREPARE TRANSACTION`, or `AND CHAIN`.
Use callback return/throw or `rollback()`; `SAVEPOINT` and `ROLLBACK TO` are
supported. `ROLLBACK AND CHAIN` is unsupported and wire-indistinguishable from
`ROLLBACK TO`, so Oliphaunt rejects `ROLLBACK`/`ABORT ... AND CHAIN` before
dispatch and enforces every other ownership boundary from PostgreSQL response
frames. A proven escape makes the database close-only and suppresses any
follow-up SDK transaction command.

After a callback failure, a successful automatic rollback rethrows the original
value unchanged. A simultaneous rollback failure produces an `AggregateError`
with the callback failure first and rollback failure second. If an earlier
independent database or protocol failure already poisoned or expired ownership
and the callback throws a different value, an `AggregateError` retains the
callback failure first and database failure second, and the database is
close-only. Ordinary PostgreSQL statement errors that remain safely rollbackable
do not automatically produce an aggregate.

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
A thrown callback is returned unchanged only when the runtime confirms recovery
to a known PostgreSQL protocol boundary. An execution, transport, or recovery
failure takes precedence and poisons a session whose state is unknown.
