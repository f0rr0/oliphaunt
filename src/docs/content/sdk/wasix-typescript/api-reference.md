---
title: WASIX TypeScript API Reference
description: Public API map for portable TypeScript database, storage, query, and physical archive operations.
---

# WASIX TypeScript API Reference

Use the generated TypeDoc reference for exact declarations.

| Area | Public surface | Purpose |
| --- | --- | --- |
| Client | `Oliphaunt.open`, `Oliphaunt.restore` | Open a database or restore an archive into persistent storage |
| Database | `query`, `execute`, `execProtocolRaw`, `execProtocolStream` | Run typed SQL or buffered/bounded callback PostgreSQL protocol bytes |
| Transactions | `transaction` and `OliphauntTransaction` | Reserve the session for a callback with automatic commit or rollback |
| Data movement | `backup` | Create the single supported WASIX physical archive |
| Persistence | `checkpoint` | Run PostgreSQL `CHECKPOINT` and publish persistent changes |
| Lifecycle | `close`, `Symbol.asyncDispose` | Stop the database and release provider ownership |
| Storage | `memory`, plus the `storage/indexed-db`, `storage/opfs`, `storage/node`, `storage/bun`, and `storage/deno` subpaths | Select one host-appropriate storage provider |
| Query values | `QueryParam`, `QueryResult`, `QueryRow`, `CommandResult` | Use PostgreSQL parameter and result values |
| Errors | `PostgresError`, `WasixStorageError` | Distinguish PostgreSQL failures from host persistence failures |
| Extensions | `WasixExtensionDescriptor` | Select an exact independently packaged WASIX extension |
| Optional tools | `pgDump`, `psql`, `PostgresToolError` from `@oliphaunt/wasix-tools` | Run a standard plain logical dump against direct or worker placement, or non-interactive psql against worker placement |
| Optional local server | `openServer`, `ServerListen`, `OliphauntServer` from `@oliphaunt/wasix-ts/server/node`, `/bun`, or `/deno` | Publish one loopback TCP or PostgreSQL-named Unix endpoint on a socket-capable host |

The public API has no backup-format enum, capability object, initialization
profile, replace policy, runtime fallback, cancellation, or dedicated COPY
streaming mode. Server and tool support is deliberately absent from the core
database object and exposed only through the optional surfaces above. These are
fixed semantics rather than configuration switches.
