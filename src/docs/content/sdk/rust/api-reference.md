---
title: API Reference
description: Rust SDK API map for builders, runtime modes, query results, lifecycle, and data movement.
---

# API Reference

Use the Rust API reference for exact signatures. This page maps the public
surface so you can jump from a product concept to the item you need.

| Area | Public surface | Use it for |
| --- | --- | --- |
| Opening | `Oliphaunt::builder()`, `OliphauntBuilder`, `DatabaseStorage` | Choose storage, startup identity, PostgreSQL GUCs, and extensions |
| Runtime | `direct()`, `broker()`, `open()`, `open_server()` | Open an embedded database or the concrete local-server handle |
| SQL | `query`, `execute`, `query_with_params`, `execute_with_params` | Run simple and parameterized SQL through the selected runtime |
| Raw protocol | `exec_protocol_raw`, `exec_protocol_stream` | Send PostgreSQL protocol bytes as one owned response or bounded callback chunks |
| Transactions | callback `transaction` and `Transaction` | Pin the physical session while a transaction is active |
| Lifecycle | `checkpoint`, `cancel`, `close` | Control active work and detach from the runtime cleanly |
| Data movement | database `backup`, static `Oliphaunt::restore` | Export and restore the one embedded physical archive |
| Optional tools | `pg_dump`, `psql`, `PgDumpOptions`, `PsqlOptions` from `oliphaunt-tools` | Run standard logical tools against a native server connection string without adding tools to the core SDK |
| Errors | `Error`, `PostgresError` | Handle SDK errors and PostgreSQL SQLSTATE data |

The Rust SDK is the full native mode surface for Tauri and Rust desktop apps.
Use server mode when you need independent PostgreSQL clients; cloned direct-mode
handles still share one serialized session.
