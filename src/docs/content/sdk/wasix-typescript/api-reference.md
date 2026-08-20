---
title: WASIX TypeScript API Reference
description: Public API map for portable TypeScript database, storage, query, and physical archive operations.
---

# WASIX TypeScript API Reference

Use the generated TypeDoc reference for exact declarations.

| Area | Public surface | Purpose |
| --- | --- | --- |
| Client | `Oliphaunt.open`, `Oliphaunt.restore` | Open a database or restore an archive into persistent storage |
| Database | `query`, `execute`, `execProtocolRaw` | Run typed SQL or advanced PostgreSQL protocol bytes |
| Transactions | `transaction` and `OliphauntTransaction` | Reserve the session for a callback with automatic commit or rollback |
| Data movement | `backup` | Create the single supported WASIX physical archive |
| Persistence | `checkpoint` | Run PostgreSQL `CHECKPOINT` and publish persistent changes |
| Lifecycle | `close`, `Symbol.asyncDispose` | Stop the database and release provider ownership |
| Storage | `memory`, plus the `storage/indexed-db`, `storage/opfs`, `storage/node`, `storage/bun`, and `storage/deno` subpaths | Select one host-appropriate storage provider |
| Query values | `QueryParam`, `QueryResult`, `QueryRow`, `CommandResult` | Use PostgreSQL parameter and result values |
| Errors | `PostgresError`, `WasixStorageError` | Distinguish PostgreSQL failures from host persistence failures |
| Extensions | `WasixExtensionDescriptor` | Select an exact independently packaged WASIX extension |

The public API has no backup-format enum, capability object, initialization
profile, replace policy, runtime fallback, server, tools, cancellation, or COPY
streaming mode. Those are either fixed semantics or deferred features, not
configuration switches.
