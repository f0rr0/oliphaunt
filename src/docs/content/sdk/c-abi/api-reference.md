---
title: API Reference
description: C ABI API map for native runtime initialization, protocol execution, response ownership, and lifecycle.
---

# API Reference

Use the Doxygen reference for exact declarations. This page maps the C ABI by
task.

| Area | Public surface | Use it for |
| --- | --- | --- |
| Initialization | `oliphaunt_init`, `OliphauntConfig` | Open a native direct backend for the prepared `pgdata` child of a managed root; initialization does not create it |
| Versioning | `oliphaunt_version` | Report the runtime and PostgreSQL build identity |
| Raw protocol | `oliphaunt_exec_protocol` | Send PostgreSQL frontend protocol bytes and receive backend messages |
| Streaming | `oliphaunt_exec_protocol_stream`, response sink callbacks | Handle large protocol responses without forcing one contiguous response buffer |
| Simple SQL | `oliphaunt_exec_simple_query` | Execute one SQL string without constructing a frontend protocol frame |
| Cancellation | `oliphaunt_cancel` | Request cancellation of the active PostgreSQL operation on a handle |
| Response ownership | `OliphauntResponse`, `oliphaunt_free_response` | Free ABI-owned buffers exactly once |
| Errors | `oliphaunt_last_error` | Read the last error string for a handle, or the global error string with `NULL` |
| Data movement | `oliphaunt_backup`, `oliphaunt_restore`, `OliphauntRestoreOptions` | Back up PostgreSQL data from an open managed root and restore it into a new or existing-empty receiving root |
| Static extensions | `oliphaunt_register_static_extensions`, `OliphauntStaticExtension`, `OliphauntStaticExtensionSymbol` | Register process-wide statically linked extension modules before backend startup |
| Lifecycle | `oliphaunt_detach`, `oliphaunt_logical_generation`, `oliphaunt_close_if_generation`, `oliphaunt_close` | Detach a logical lease, guard host cleanup against stale leases, or terminate the resident backend |

Most app developers use a language SDK instead of calling the C ABI directly.
The C ABI is primarily for binding authors and applications that need the native
runtime boundary itself.

ABI v8 places the optional embedded module directory at
`OliphauntConfig.module_dir`. A non-empty path is copied into the handle and is
authoritative over process environment and release-layout discovery. Set it to
`NULL` for the sensible default: a valid `OLIPHAUNT_EMBEDDED_MODULE_DIR`, then
packaged release-layout discovery.

Direct-mode `oliphaunt_detach` leaves the same-PGDATA backend resident so a later
init can acquire a new logical lease. Binding authors capture the nonzero
`oliphaunt_logical_generation` immediately after every successful init and use
`oliphaunt_close_if_generation` during host-environment teardown. It
closes only the matching current lease; while a newer lease is active, a stale
generation returns a positive no-op result and must not terminate that owner.
Once terminal close has completed, cleanup returns zero because the terminal
condition is already satisfied. Invalid arguments or lifecycle-state errors
return a negative result. `oliphaunt_close` is the unconditional terminal
operation for hosts that serialize the entire process lifetime themselves.
