---
title: API Reference
description: WASM SDK API map for the WASIX runtime family, protocol types, storage, extensions, and dump/restore.
---

# API Reference

Use the WASM rustdoc reference for exact declarations. This page maps the WASM
SDK by task.

| Area | Public surface | Use it for |
| --- | --- | --- |
| Opening | runtime builders and root options | Open persistent or temporary WASM roots |
| Runtime assets | asset loader and catalog APIs | Select the released WASIX PostgreSQL runtime artifacts |
| Capabilities | capability reporting | Check protocol, extension, storage, dump, restore, and server support |
| SQL | query and execute helpers | Run SQL through the WASM runtime |
| Raw protocol | protocol request and response types | Send PostgreSQL protocol bytes to the WASM backend |
| Server/proxy | WASM server helper APIs | Expose PostgreSQL-compatible access where the WASM runtime supports it |
| Extensions | exact extension selectors | Include only selected WASM-built extension artifacts |
| Dump/restore | dump and restore APIs | Move data between compatible roots or export logical dumps |
| Errors | WASM SDK and PostgreSQL error types | Handle runtime errors and SQLSTATE data |

The WASM SDK is a first-class runtime family with its own packaged PostgreSQL
runtime assets. Native direct, broker, and server mode behavior is documented in
the native SDK sections.
