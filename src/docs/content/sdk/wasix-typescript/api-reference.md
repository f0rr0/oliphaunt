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
| Raw protocol | `execProtocolRaw`, `execProtocolRawStream` | Send PostgreSQL protocol bytes as one result or synchronous bounded chunks; callbacks cannot return thenables or reenter the same handle |
| Data movement | `backup` | Create the single supported WASIX physical archive |
| Persistence | Implicit operation and transaction publication boundaries | Publish persistent changes before the owning promise settles |
| Lifecycle | read-only `closed`, `close`, `Symbol.asyncDispose` | Perform one terminal teardown, stop the database, and release provider ownership |
| Storage | `memory`, plus the `storage/indexed-db`, `storage/opfs`, `storage/node`, `storage/bun`, and `storage/deno` subpaths | Select one host-appropriate storage provider |
| Query values | `QueryParam`, `QueryResult`, `RawQueryResult`, `QueryField`, `CommandResult`, `ExecResult`, `DescribeResult` | Use decoded or lossless PostgreSQL parameter and result values |
| Diagnostics | query-scoped `notices`, `PostgresError`, `WasixStorageError` | Distinguish PostgreSQL diagnostics from host persistence failures |
| Extensions | `WasixExtensionDescriptor` | Select an exact independently packaged WASIX extension |
| Optional tools | `pgDump`, `psql`, `PostgresToolError` from `@oliphaunt/wasix-tools` | Run a standard plain logical dump against direct or Worker handles, or non-interactive psql against a Worker handle |
| Optional local server | `openServer`, `ServerListen`, `OliphauntServer.connectionString`, read-only `OliphauntServer.closed`, `close`, and `Symbol.asyncDispose` from `@oliphaunt/wasix-ts/server/node`, `/bun`, or `/deno` | Publish and lifecycle-manage one loopback TCP or PostgreSQL-named Unix endpoint on a socket-capable host |

```ts
const result = await database.query('select $1::int4 as answer', [41]);
const answer = result.rows[0]?.answer;
const raw = await database.queryRaw('select $1::bytea as payload', [new Uint8Array([1, 2])]);
```

The cross-SDK behavior follows the
[stable database API](https://github.com/f0rr0/oliphaunt/blob/main/docs/architecture/stable-database-api.md).

WASIX `close()` has one memoized terminal outcome. It stops admission as soon
as close begins and lets already accepted database work finish up to the
bounded orderly-shutdown deadline. On expiry it requests forced Worker
termination and awaits that attempt before releasing other resources; the
deadline does not claim that total teardown is already complete. A
rejected close still leaves `closed === true`; repeat calls return the same
rejected promise rather than claiming the destroyed session can be retried.
Provider close and allocation release are attempted before that rejection is
reported. A close call made from the active transaction callback rejects before
teardown begins and leaves the database open; call it again after the callback
settles.

An unreachable database handle has generation-guarded best-effort cleanup. It
can retire only its own Worker or caller-realm guest/storage lease, and a stale
finalizer is a no-op. This is a leak-safety fallback, not a prompt lifecycle
boundary; use `close()` or `await using` whenever teardown must be observed.

The public API has no backup-format enum, capability object, initialization
profile, replace policy, runtime fallback, cancellation, or dedicated COPY
streaming mode. Server and tool support is deliberately absent from the core
database object and exposed only through the optional surfaces above. These are
fixed semantics rather than configuration switches.
