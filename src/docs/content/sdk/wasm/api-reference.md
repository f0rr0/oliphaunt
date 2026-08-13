---
title: Rust WASIX API Reference
description: Rust WASIX API map for protocol types, storage, extensions, and dump/restore.
---

# Rust WASIX API Reference

Use the `oliphaunt-wasix` rustdoc reference for exact declarations. This page
maps the Rust binding by task; it does not describe the separate
[`@oliphaunt/wasix-ts` TypeScript API](./browser-typescript).

| Area | Public surface | Use it for |
| --- | --- | --- |
| Opening | `Oliphaunt`, `OliphauntBuilder`, `OliphauntServerBuilder` | Open a memory database by default or configure storage explicitly |
| Storage | `DatabaseStorage`, `ApplicationData` | Select memory, a temporary directory, an app-owned directory, or app data |
| Initialization | `DatabaseInitialization` | Initialize empty storage from the packaged template, `initdb`, or a same-version physical backup |
| Runtime assets | asset loader and catalog APIs | Select the released WASIX PostgreSQL runtime artifacts |
| Capabilities | `EngineCapabilities`, `engine_capabilities()` | Check protocol support for the opened Rust host |
| SQL | query and execute helpers | Run SQL through the WASIX runtime |
| Raw protocol | protocol request and response types | Send PostgreSQL protocol bytes to the WASIX backend |
| Server/proxy | WASIX server helper APIs | Expose PostgreSQL-compatible access where the WASIX runtime supports it |
| Extensions | exact extension selectors | Include only selected WASIX-built extension artifacts |
| Backup/restore | `backup()`, `PhysicalArchive`, logical dump APIs | Move data between compatible stores or export logical dumps |
| Errors | WASIX SDK and PostgreSQL error types | Handle runtime errors and SQLSTATE data |

The Rust WASIX binding owns its packaged PostgreSQL runtime assets and Rust host
behavior. Native direct, broker, and server modes are documented in the native
SDK sections. The TypeScript binding intentionally omits Rust server, streaming,
capability, and dump/restore APIs.
