---
title: Rust WASIX API Reference
description: Rust WASIX API map for protocol types, storage, extensions, and dump/restore.
---

# Rust WASIX API Reference

Use the `oliphaunt-wasix` rustdoc reference for exact declarations. This page
maps the Rust binding by task; it does not describe the separate
[`@oliphaunt/wasix-ts` TypeScript API](/docs/sdk/wasix-typescript/api-reference).

| Area | Public surface | Use it for |
| --- | --- | --- |
| Opening | `Oliphaunt`, `OliphauntBuilder`, `OliphauntServerBuilder` | Open a memory database by default or configure storage explicitly |
| Storage | `DatabaseStorage` | Select memory or a caller-supplied host directory |
| SQL | query and execute helpers | Run SQL through the WASIX runtime |
| Raw protocol | `exec_protocol_raw`, `exec_protocol_stream` | Send PostgreSQL protocol bytes or consume bounded response chunks; COPY output uses the guest stream pump |
| Server/proxy | WASIX server helper APIs | Expose PostgreSQL-compatible access where the WASIX runtime supports it |
| Extensions | `extensions::Extension`, exact constants, `ALL`, `by_sql_name` | Select WASIX-built extension artifacts by SQL name |
| Backup/restore | `backup()`, `Oliphaunt::restore` | Move the one WASIX physical archive between compatible stores |
| Tools | `tools::pg_dump`, `tools::psql`, `tools::PgDumpOptions`, `tools::PsqlOptions` with the `tools` feature | Run packaged PostgreSQL logical dump and non-interactive psql directly against an open database |
| Errors | `Result<T>`, `Error`, `PostgresError`, `PostgresErrorField` | Handle SDK failures and inspect PostgreSQL errors for SQLSTATE data |

The Rust WASIX binding owns its packaged PostgreSQL runtime assets and Rust host
behavior. Native direct, broker, and server modes are documented in the native
SDK sections. WASIX TypeScript exposes equivalent optional tools and a local
server on socket-capable hosts through TypeScript-native package entry points;
it shares the WASIX physical backup/restore contract without copying Rust APIs.

All fallible methods return the crate-owned `Result<T>`. `Error` keeps runtime
implementation details private, implements `std::error::Error`, and exposes
`postgres_error()`; use `PostgresError` when SQLSTATE and ordered backend error
fields matter.
