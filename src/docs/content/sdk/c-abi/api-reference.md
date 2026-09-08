---
title: C ABI reference
description: Configuration structs, query functions, buffers, errors, and lifecycle in oliphaunt.h.
---

Compile against the `oliphaunt.h` shipped with your native library. Use the header's `OLIPHAUNT_ABI_VERSION` macro rather than copying a numeric ABI version into application code.

## Configuration and data types

| Type | Contract |
| --- | --- |
| `OliphauntHandle` | Opaque native handle; do not inspect or free it directly |
| `OliphauntConfig` | ABI version, prepared `pgdata`, resource paths, identity, flags, startup arguments |
| `OliphauntResponse` | Owned `data` pointer and `len`; release with `oliphaunt_free_response` |
| `OliphauntErrorCapture` | Caller-owned bounded message buffer and length |
| `OliphauntRestoreOptions` | ABI version, managed-root destination, archive bytes and length |
| `OliphauntStaticExtension` | Statically linked module descriptor |

`pgdata` names the child of an existing managed root. `runtime_dir` selects runtime resources. `module_dir` names an existing PostgreSQL module directory or uses discovery when null. `username` and `database` select existing identities.

`startup_args` contains `-c`, `name=value` pairs; storage-routing settings are rejected. Leave `flags` zero unless your binding already owns the required external root lock.

## Open and execute

| Function | Operation |
| --- | --- |
| `oliphaunt_init` | Open a direct logical lease |
| `oliphaunt_exec_simple_query` | Send simple SQL and return protocol bytes |
| `oliphaunt_exec_protocol` | Exchange buffered protocol bytes |
| `oliphaunt_exec_protocol_raw_stream` | Deliver response chunks through a callback |
| `oliphaunt_backup` | Create an owned native physical archive |
| `oliphaunt_restore` | Restore into new or empty managed storage |
| `oliphaunt_free_response` | Release response ownership |

Async FFI hosts should use the corresponding `_with_error` functions for open, queries, streaming, backup, restore, and detach. These preserve return codes and response ownership while filling an error capture before returning.

## Streaming

`OliphauntStreamCallback` receives `(context, data, len)` and returns `int32_t`. Bytes are borrowed for the callback duration. Zero continues delivery; nonzero stops it and initiates protocol recovery. Ordinary same-handle operations are forbidden while streaming; cancellation is permitted.

## Lifecycle

| Function | Operation |
| --- | --- |
| `oliphaunt_cancel` | Cross-thread interrupt request |
| `oliphaunt_detach` | End a logical lease while retaining the resident backend |
| `oliphaunt_logical_generation` | Read the current nonzero lease generation, or zero when unavailable |
| `oliphaunt_close_if_generation` | Terminal close guarded by generation ownership |
| `oliphaunt_close` | Unconditional process-terminal close of the resident handle |

Guarded close returns zero for completed/already completed close, one for a stale active generation that does nothing, and minus one for invalid zero generation or an internal failure. Serialize other operations according to the header contract.

## Errors and version

`oliphaunt_copy_last_error(handle, out, capacity)` returns the full UTF-8 length excluding the NUL terminator. With nonzero capacity, `out` must be nonnull and the copied result is NUL-terminated. Copy immediately on the failing operation's thread, or use an operation-owned error capture.

`oliphaunt_version()` returns the runtime version. `oliphaunt_register_static_extensions` registers descriptors before backend startup.

Read [Build a binding](/docs/sdk/c-abi/guide) for ownership and recovery requirements before wrapping these functions.
