---
title: TypeScript API reference
description: Entry points, configuration, query results, errors, and lifecycle for @oliphaunt/ts.
---

Import `Oliphaunt` from `@oliphaunt/ts`. The package exports TypeScript declarations for the API below.

## Entry points

| Method | Returns | Behavior |
| --- | --- | --- |
| `Oliphaunt.open(config?)` | `Promise<OliphauntDatabase>` | Opens a direct or broker query session |
| `Oliphaunt.openServer(config?)` | `Promise<OliphauntServer>` | Starts a local PostgreSQL server |
| `Oliphaunt.restore(destination, bytes, options?)` | `Promise<void>` | Restores a native archive into a new or empty directory |

## Open configuration

| Option | Type / default | Meaning |
| --- | --- | --- |
| `storage` | `DatabaseStorage`; temporary directory | `{ kind: 'directory', path: string }` persists data |
| `topology` | `'direct'` or `'broker'`; direct | Execution mode |
| `extensions` | `readonly string[]`; empty | SQL extension names to make available |
| `startupGUCs` | `Record<string, string>` | PostgreSQL settings applied at startup |
| `username`, `database` | Optional strings | Existing PostgreSQL identity; fresh roots use `postgres` |
| `libraryPath`, `runtimeDirectory` | Optional strings | Advanced native resource overrides |
| `brokerExecutable` | Optional string | Broker executable override |

Server configuration replaces `topology`, `brokerExecutable`, and `libraryPath` with `serverExecutable` and `listen`. TCP listen accepts an optional port; Unix listen requires a socket directory and accepts a port.

## Query methods

| Method | Result |
| --- | --- |
| `query(sql, parameters?, options?)` | Decoded `QueryResult` with `rows` and field metadata |
| `execute(sql, parameters?, options?)` | `CommandResult` with command metadata |
| `queryRaw(sql, parameters?, options?)` | Raw column values and field metadata |
| `exec(sql, options?)` | Results for a multi-statement SQL script |
| `describe(sql, parameterTypeOids?)` | Parameter and result-field descriptions |
| `transaction(body)` | The callback's returned value, after commit |

Parameters are positional values corresponding to `$1`, `$2`, and so on. Explicit SQL casts make ambiguous parameters predictable. Generic row annotations describe your expected shape; they do not validate a SQL schema at runtime. Query options support custom type parsers and encoders.

## Database lifecycle

`backup()` returns `Promise<Uint8Array>`. `cancel()` requests interruption of active work. `close()` returns `Promise<void>` and `closed` reports terminal state. The handle also implements `Symbol.asyncDispose` for `await using` in runtimes that support it.

The transaction object exposes the typed query methods and `rollback()`. It expires when the callback settles and cannot escape into later application work. It has no raw-protocol or backup methods.

The server handle exposes `connectionString`, `closed`, `close()`, and `Symbol.asyncDispose`. SQL, cancellation, and backup through a server use your PostgreSQL driver or tools.

## Raw protocol

`execProtocolRaw(input)` returns a buffered PostgreSQL protocol response. `execProtocolRawStream(input, onChunk)` delivers `Uint8Array` chunks to a synchronous callback that returns `undefined`. Input accepts supported binary buffers or byte arrays.

A stream callback is a backpressure boundary. Do not run queries or close the same handle from it. Raw protocol callers own protocol framing and transaction lifecycle. A transport/recovery failure can make the handle close-only even if callback delivery stopped earlier.

## Errors

`PostgresError` preserves backend fields including `sqlstate`. Other errors cover loading, storage, lifecycle, and protocol failures. Composite transaction failures preserve both the callback error and the database/rollback failure. Inspect the original causes rather than retrying based only on a message string.

See the [TypeScript guide](/docs/sdk/typescript/guide) for complete recipes.
