---
title: API Reference
description: C ABI API map for native runtime initialization, protocol execution, response ownership, and lifecycle.
---

# API Reference

Use the Doxygen reference for exact declarations. This page maps the C ABI by
task.

| Area | Public surface | Use it for |
| --- | --- | --- |
| Initialization | `oliphaunt_init`, `oliphaunt_init_ex`, `OliphauntConfig`, `OliphauntInitOptions` | Open a native direct backend with explicit root, durability, runtime resource, and extension settings |
| Versioning | `oliphaunt_version` | Report the runtime and PostgreSQL build identity |
| Capabilities | `oliphaunt_capabilities`, `OliphauntCapabilities` | Discover protocol, streaming, extension, backup, restore, lifecycle, and mode support |
| Raw protocol | `oliphaunt_exec_protocol` | Send PostgreSQL frontend protocol bytes and receive backend messages |
| Streaming | `oliphaunt_exec_protocol_stream`, response sink callbacks | Handle large protocol responses without forcing one contiguous response buffer |
| Simple SQL | SQL helper entry points where exposed | Run smoke and embedding checks without requiring a higher-level SDK parser |
| Response ownership | `OliphauntResponse`, `oliphaunt_free_response` | Free ABI-owned buffers exactly once |
| Errors | `oliphaunt_last_error`, structured error fields where available | Read the last SDK or PostgreSQL error for a handle |
| Data movement | backup and restore entry points where exposed | Move PostgreSQL roots through validated archives |
| Lifecycle | `oliphaunt_checkpoint`, `oliphaunt_close` | Flush, detach, and release the resident backend handle |

Most app developers use a language SDK instead of calling the C ABI directly.
The C ABI is primarily for binding authors and applications that need the native
runtime boundary itself.

`oliphaunt_init` retains the ABI v6 behavior used by existing bindings. Its
embedded module directory comes from a valid `OLIPHAUNT_EMBEDDED_MODULE_DIR`
host override, then the packaged release-layout fallbacks. `oliphaunt_init_ex`
accepts a separately versioned `OliphauntInitOptions`. A non-empty
`options.module_dir` is copied into the handle and is authoritative over the
process environment and release-layout discovery. A non-null options record
requires ABI version 1, an existing non-empty `module_dir`, and zero reserved
flags. Pass `NULL` options to preserve the legacy resolution contract.
