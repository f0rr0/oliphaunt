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
| Versioning | `oliphaunt_version` | Report the Oliphaunt runtime package version |
| Raw protocol | `oliphaunt_exec_protocol` | Send PostgreSQL frontend protocol bytes and receive backend messages |
| Streaming | `oliphaunt_exec_protocol_raw_stream`, response sink callbacks | Handle large raw protocol responses without forcing one contiguous response buffer |
| Simple SQL | `oliphaunt_exec_simple_query` | Execute one SQL string without constructing a frontend protocol frame |
| Cancellation | `oliphaunt_cancel` | Request cancellation of the active PostgreSQL operation on a handle |
| Response ownership | `OliphauntResponse`, `oliphaunt_free_response` | Free ABI-owned buffers exactly once |
| Errors | `OliphauntErrorCapture`, the `_with_error` operation variants, `oliphaunt_copy_last_error` | Capture an asynchronous FFI operation's error before its native worker returns, or copy a synchronous caller's operation-local error into caller-owned memory |
| Data movement | `oliphaunt_backup`, `oliphaunt_restore`, `OliphauntRestoreOptions` | Back up PostgreSQL data from an open managed root and restore it into a new or existing-empty receiving root |
| Static extensions | `oliphaunt_register_static_extensions`, `OliphauntStaticExtension`, `OliphauntStaticExtensionSymbol` | Register process-wide statically linked extension modules before backend startup |
| Lifecycle | `oliphaunt_detach`, `oliphaunt_logical_generation`, `oliphaunt_close_if_generation`, `oliphaunt_close` | Detach a logical lease, guard host cleanup against stale leases, or terminate the resident backend |

Most app developers use a language SDK instead of calling the C ABI directly.
The C ABI is primarily for binding authors and applications that need the native
runtime boundary itself.

ABI v10 retains the optional embedded module directory at
`OliphauntConfig.module_dir`. A non-empty path is copied into the handle and is
authoritative over process environment and release-layout discovery. Set it to
`NULL` for the sensible default: a valid `OLIPHAUNT_EMBEDDED_MODULE_DIR`, then
packaged release-layout discovery.

Hosts that schedule one FFI call on a worker thread and resume user code on a
different thread use the matching `_with_error` entry point. They pass a
required `OliphauntErrorCapture`; the operation fills it before releasing its
native handle lease and returning. The fixed 1,028-byte layout contains a
32-bit UTF-8 byte length from 0 through 1,023 followed by a 1,024-byte
NUL-terminated message; capture does not further truncate the runtime's
equally bounded error.
Successful calls clear the entire capture. This keeps concurrent
Promise failures attributable to their own native invocation instead of a
later shared handle error.

Bindings call `oliphaunt_copy_last_error` on the same thread immediately after
a failed operation. The runtime keeps that operation's error in owned
thread-local storage, so another thread's failed cancellation or database call
cannot change the error between a size probe and the subsequent copy. Repeated
copies remain stable until that thread begins another fallible C operation. If
there is no operation-local snapshot, the function atomically reads the latest
handle error, or the process-global error when passed `NULL`.

The return value is the full UTF-8 byte length even when the supplied buffer is
smaller, and nonempty output capacity is always NUL-terminated. The ABI exposes
no borrowed error pointer; bindings keep the copied message in language-owned
memory.

A raw-stream callback rejection returns
`OLIPHAUNT_STREAM_CALLBACK_ABORTED` only after the runtime has confirmed
`ReadyForQuery`. Negative stream results identify native validation, transport,
backend, or recovery failures and take precedence over a simultaneous binding
callback exception.

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
