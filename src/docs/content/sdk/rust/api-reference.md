---
title: API Reference
description: Rust SDK API map for builders, runtime modes, query results, lifecycle, and data movement.
---

# API Reference

Use the Rust API reference for exact signatures. This page maps the public
surface so you can jump from a product concept to the item you need.

| Area | Public surface | Use it for |
| --- | --- | --- |
| Opening | `Oliphaunt::builder()`, `OliphauntBuilder` | Choose root, mode, durability, runtime assets, startup identity, and extensions |
| Runtime mode | `EngineMode`, `native_direct()`, `native_broker()`, `native_server()` | Select direct, broker, or server behavior explicitly |
| Capabilities | `EngineCapabilities`, `supported_modes()` | Check protocol, streaming, backup, restore, extension, and session support |
| SQL | `query`, `execute`, `query_params` | Run simple and parameterized SQL through the selected runtime |
| Raw protocol | `exec_protocol_raw`, `exec_protocol_stream` | Send PostgreSQL protocol bytes or stream large responses |
| Transactions | `transaction`, `with_transaction`, `SessionPin` | Pin the physical session while a transaction is active |
| Lifecycle | `checkpoint`, `cancel`, `close` | Control active work and detach from the runtime cleanly |
| Data movement | `backup`, `restore`, `BackupRequest`, `RestoreRequest` | Export, import, and validate physical archives |
| Errors | `Error`, `PostgresError`, `RuntimeUnavailable` | Handle SDK errors and PostgreSQL SQLSTATE data |

The Rust SDK is the full native mode surface for Tauri and Rust desktop apps.
Use server mode when you need independent PostgreSQL clients; cloned direct-mode
handles still share one serialized session.
