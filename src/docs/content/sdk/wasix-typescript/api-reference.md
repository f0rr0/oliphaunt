---
title: WASIX TypeScript API Reference
description: Public API map for portable TypeScript database, storage, query, and physical archive operations.
---

# WASIX TypeScript API Reference

Use the generated TypeDoc reference for exact declarations.

| Area | Public surface | Purpose |
| --- | --- | --- |
| Client | `Oliphaunt.open`, `Oliphaunt.restore` | Open a database or restore an archive into persistent storage |
| Single-statement SQL | decoded `query`, byte-preserving `queryRaw`, `execute` | Read object or array rows, retain exact wire rows, or assert that a command returns no rows |
| Multi-statement and metadata | `exec`, `describe` | Return simple-query results in order or resolve parameter/result OIDs without executing |
| Parameters and codecs | `text`, `binary`, `typedNull`, `json`, `array`, `postgresOids`, per-query encoders and decoders | Use safe scalar inference, deterministic PostgreSQL types, or extension-owned OID codecs |
| Transactions | `transaction`, `OliphauntTransaction.rollback`, transaction `closed` | Reserve the session for a callback and explicitly roll back without a later commit |
| Raw protocol | database `execProtocolRaw`, `execProtocolRawStream` | Send PostgreSQL protocol bytes as one result or synchronous bounded callback chunks; transaction handles deliberately do not expose this bypass, confirmed callback recovery preserves the original error and session, and execution, transport, or recovery failures poison it |
| Data movement | `backup` | Create the single supported WASIX physical archive |
| Persistence | Implicit operation and transaction publication boundaries | Publish persistent changes before the owning promise settles |
| Lifecycle | read-only `closed`, `close`, `Symbol.asyncDispose` | Perform one terminal teardown, stop the database, and release provider ownership |
| Storage | `memory`, plus the `storage/indexed-db`, `storage/opfs`, `storage/node`, `storage/bun`, and `storage/deno` subpaths | Select one host-appropriate storage provider |
| Query values | `QueryParam`, `QueryResult`, `RawQueryResult`, `QueryField`, `CommandResult`, `ExecResult`, `DescribeResult` | Use decoded or lossless PostgreSQL parameter and result values |
| Diagnostics | query-scoped `notices`, `PostgresError`, `WasixStorageError` | Distinguish PostgreSQL diagnostics from host persistence failures |
| Extensions | `WasixExtensionDescriptor` | Materialize an exact independently packaged WASIX extension and its startup config; run normal database-local `CREATE EXTENSION`/`LOAD` explicitly in app or ORM migrations |
| Optional tools | `pgDump`, `psql`, `PostgresToolError` from `@oliphaunt/wasix-tools` | Run a standard plain logical dump against direct or Worker handles, or non-interactive psql against a Worker handle |
| Optional local server | `openServer`, `ServerListen`, `OliphauntServer.connectionString`, read-only `OliphauntServer.closed`, `close`, and `Symbol.asyncDispose` from `@oliphaunt/wasix-ts/server/node`, `/bun`, or `/deno` | Publish and lifecycle-manage one loopback TCP or PostgreSQL-named Unix endpoint on a socket-capable host |

```ts
const result = await database.query('select $1::int4 as answer', [41]);
const answer = result.rows[0]?.answer;
const raw = await database.queryRaw('select $1::bytea as payload', [new Uint8Array([1, 2])]);
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

After rollback and required persistence publication succeed, the original
callback failure is rethrown unchanged. If rollback also fails, an
`AggregateError` contains the callback failure followed by the rollback failure.
If the callback throws a different value after an earlier independent database
or protocol failure poisoned or expired ownership, an `AggregateError` contains
the callback failure followed by that database failure and the database is
close-only. Ordinary PostgreSQL statement errors that remain safely rollbackable
do not automatically produce an aggregate.

WASIX `close()` has one memoized terminal outcome. It stops admission as soon
as close begins and lets already accepted database work finish. On the Worker
surface, a bounded orderly-shutdown deadline requests forced Worker termination
on expiry and awaits that attempt before releasing other resources; the
caller-realm root has no Worker transport or forced-termination deadline. A
rejected close still leaves `closed === true`; repeat calls return the same
rejected promise rather than claiming the destroyed session can be retried.
Provider close and allocation release are attempted before that rejection is
reported. A close call made from the active transaction callback rejects before
teardown begins and leaves the database open; call it again after the callback
settles.

An unexpected package-Worker failure also makes `closed === true` immediately.
Later operations fail locally instead of posting to the terminal transport.
`close()` remains idempotent and reports that transport failure while finishing
any remaining package-owned cleanup.

A raw-stream callback cannot return a thenable or reenter the same database or
transaction. Its original error is surfaced only after the runtime confirms a
known recovered protocol boundary, leaving the database reusable. A buffered
raw rejection or streamed execution, transport, or recovery failure is
authoritative instead, poisons the database, and is never masked by a callback
error.

An unreachable database handle has generation-guarded best-effort cleanup. It
can retire only its own Worker or caller-realm guest/storage lease, and a stale
finalizer is a no-op. This is a leak-safety fallback, not a prompt lifecycle
boundary; use `close()` or `await using` whenever teardown must be observed.

The public API has no backup-format enum, capability object, initialization
profile, replace policy, runtime fallback, cancellation, or dedicated COPY
streaming mode. Server and tool support is deliberately absent from the core
database object and exposed only through the optional surfaces above. These are
fixed semantics rather than configuration switches.
