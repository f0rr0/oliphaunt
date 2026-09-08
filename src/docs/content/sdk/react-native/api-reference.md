---
title: React Native API reference
description: Storage, query methods, transactions, and lifecycle in @oliphaunt/react-native.
---

Import the default `Oliphaunt` export or the named export from `@oliphaunt/react-native`. The package includes TypeScript declarations.

## Entry points and storage

`Oliphaunt.open(config?)` returns `Promise<OliphauntDatabase>`. Configuration accepts `storage`, `startupGUCs`, `username`, `database`, and `extensions`.

| Storage value | Lifetime |
| --- | --- |
| `{ kind: 'temporaryDirectory' }` | Disposable; default |
| `{ kind: 'directory', path: string }` | Persistent explicit path |
| `{ kind: 'applicationData', name: string }` | Persistent platform-resolved app-data path |

`Oliphaunt.restore(destination, bytes)` accepts either persistent storage form and returns `Promise<void>`. The destination must be new or empty. Archive input accepts supported binary buffers and byte arrays.

## Query methods

| Method | Purpose |
| --- | --- |
| `query(sql, parameters?, options?)` | Decoded rows and field metadata |
| `execute(sql, parameters?, options?)` | Command metadata |
| `queryRaw(sql, parameters?, options?)` | Nullable column bytes and metadata |
| `exec(sql, options?)` | Multi-statement SQL results |
| `describe(sql, parameterTypeOids?)` | Statement metadata |
| `transaction(body)` | Callback-owned transaction |

Query options include positional rows and custom codecs. Duplicate field names require array row mode. Row type annotations do not validate a query's schema at runtime.

Transactions expose typed query methods and `rollback()`. They do not expose raw protocol, backup, or close. Return to commit, throw to roll back, and use the callback handle only during its lifetime. Savepoints are supported; manual outer transaction-lifecycle SQL is not.

## Lifecycle and errors

`backup()` returns `Promise<Uint8Array>`. `cancel()` requests an interrupt. `close()` returns `Promise<void>`, `closed` reports state, and `Symbol.asyncDispose` supports explicit async disposal where the JavaScript runtime provides it.

`PostgresError` preserves SQLSTATE and backend diagnostics. Composite transaction failures use `AggregateError` with the callback failure followed by the rollback or database failure. Unknown commit outcomes are not automatically retried.

## Raw protocol

`execProtocolRaw` buffers backend frames. `execProtocolRawStream` passes chunks to a synchronous callback returning `undefined`; promises and reentrant query calls are unsupported. Raw protocol requires a protocol-aware caller and is separate from typed row queries.

The SDK runs through Swift on iOS and Kotlin on Android. It exposes direct embedding, not desktop broker or server APIs. See [native integration](/docs/sdk/react-native/architecture) for packaging and runtime behavior.
