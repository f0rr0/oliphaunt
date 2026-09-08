---
title: WASIX TypeScript API reference
description: Imports, storage descriptors, configuration, methods, and runtime-specific constraints.
---

`@oliphaunt/wasix-ts` exports `Oliphaunt` and its TypeScript declarations. The default export is the same client.

## Entry points

| Import | Exports / purpose |
| --- | --- |
| Package root | `Oliphaunt.open`, `Oliphaunt.restore`, query types and helpers |
| `/direct` | Explicit caller-thread placement |
| `/worker` | Worker placement with the same query contract |
| `/server` | Desktop-only `openServer` |
| `/storage/indexed-db`, `/storage/opfs` | Browser persistent providers |
| `/storage/node`, `/storage/bun`, `/storage/deno` | Desktop directory providers |

`open(config?)` returns `Promise<OliphauntDatabase>`. `restore(storage, bytes)` returns `Promise<void>` and requires a `PersistentWasixStorage` destination.

## Configuration

| Field | Type / default |
| --- | --- |
| `storage` | `WasixStorage`; fresh memory filesystem |
| `extensions` | `readonly WasixExtensionDescriptor[]`; empty |
| `startupGUCs` | `Record<string, string>`; no extra settings |
| `username`, `database` | Optional strings; fresh roots use `postgres` |
| `icu` | Optional imported `WasixIcuDescriptor` |

Extension descriptors come from `@oliphaunt/extension-*-wasix` packages. SQL-name strings are not accepted. Host placement is selected by import, not an `execution` configuration option.

## Queries and transactions

`query`, `execute`, `queryRaw`, `exec`, and `describe` provide typed queries, command metadata, raw column values, multiple statements, and statement metadata. They accept positional parameters and appropriate query options. Typed rows are buffered.

`transaction(body)` owns one session until settlement. Returning commits; throwing rolls back. The transaction handle exposes typed query methods and `rollback()`, and expires after use. Raw protocol and backup belong only to the database. Manual outer transaction-lifecycle SQL is unsupported; savepoints are supported.

## Persistence and close

`backup()` returns `Promise<Uint8Array>`. Persistent operations settle only after required provider publication. Restore validates archive compatibility and rejects nonempty destinations.

`close()` returns `Promise<void>` and performs one terminal teardown attempt. `closed` reports terminal state, including unexpected isolated-host termination. Repeated close calls share the same result. `Symbol.asyncDispose` uses the same close operation.

There is no public direct-query `cancel()` method. Browser TCP listeners and independent endpoint sessions are unavailable.

## Protocol and errors

`execProtocolRaw` returns buffered backend bytes. `execProtocolRawStream` accepts a synchronous callback returning `undefined`. The callback is a backpressure boundary and cannot return a promise or re-enter the same database.

`PostgresError` contains SQLSTATE and backend diagnostics. A recovered callback failure can leave a session usable; transport, recovery, or persistence-publication failure can make it close-only. Composite transaction failures retain both relevant causes.

See the [guide](/docs/sdk/wasix-typescript/guide) for tools, storage examples, and host requirements.
