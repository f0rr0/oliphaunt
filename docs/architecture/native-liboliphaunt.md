# Native `liboliphaunt` architecture

`liboliphaunt` is the compiled PostgreSQL 18 boundary shared by the native SDK
family. It owns the patched embedded backend, the process-wide direct runtime,
the stable C ABI, root validation, direct-runtime ownership, physical
backup/restore, cancellation, raw protocol execution, and static extension
registration.

Language SDKs own typed query values, builders, paths, async adapters, package
resolution, cluster-seed hydration, server and broker process orchestration, and
language-native errors. They do not reimplement the C runtime's direct
lifecycle, archive parser, or root validation.

## Public C boundary

ABI version 10 exports one fixed surface from
`src/runtimes/liboliphaunt/native/include/oliphaunt.h`:

- `oliphaunt_init`, `oliphaunt_detach`, `oliphaunt_close`, generation-guarded
  close, version access, and atomic caller-owned error copies;
- simple query, owned raw protocol response, and callback protocol streaming;
- `oliphaunt_cancel`;
- one physical `oliphaunt_backup` and one static `oliphaunt_restore`;
- scheduler-safe `_with_error` variants that capture each operation's error in
  caller-owned storage before its native invocation returns;
- static extension registration; and
- response release.

`OliphauntConfig.flags` accepts zero or
`OLIPHAUNT_CONFIG_EXTERNAL_ROOT_LOCK`. The flag tells `liboliphaunt` that the
caller already owns the stable sibling root lease; without it, the C runtime
acquires that lease itself. Every other bit is rejected. Fixed runtime behavior
is not represented as a profile enum, archive-format enum, replacement policy,
or initialization mode.

## Direct lifecycle

One PostgreSQL backend may be resident in a process. The first successful init
starts it and publishes a logical generation. `detach` ends the current logical
lease while leaving the backend resident; a compatible reopen advances the
generation. Every reopen must preserve the resident runtime's original
internal-versus-external root-lock ownership mode. Generation-guarded close
prevents stale language cleanup owners from terminating a newer logical lease.
Terminal close shuts down the resident backend and prevents another physical
backend from starting in that process.

The runtime temporarily owns process-global PostgreSQL environment needed by
the embedded backend and restores caller state at terminal close. Applications
that need independent PostgreSQL processes use broker or server mode rather
than multiple direct handles.

## Managed roots

The configured path is always `<root>/pgdata`. `oliphaunt_init` validates an
already-prepared root and never runs `initdb`, hydrates a cluster seed, creates a
descriptor, or adopts raw PGDATA. Before backend startup it requires:

- a real root, `pgdata`, and `pgdata/global` directory, with no symbolic-link,
  junction, or reparse-point substitution;
- no root entries other than `.oliphaunt.json` and `pgdata`;
- an exact semantic `.oliphaunt.json` descriptor;
- regular `PG_VERSION` containing PostgreSQL major 18;
- nonempty regular `global/pg_control`; and
- a real `pg_wal` directory.

The descriptor has exactly `schema`, `engineFamily`, `pgdata`,
`postgresMajor`, and `physicalFormat`. JSON order and ordinary whitespace do
not matter. The accepted tuples are exactly `native` / `native-pg18-v1` / 18
and `wasix` / `wasix-pg18-v1` / 18. Unknown, missing, duplicate, wrongly typed,
or mismatched values are rejected without changing the root.

SDK initialization owns new-root construction: it creates or hydrates PGDATA,
validates the minimal PostgreSQL markers, and publishes the native descriptor
last. This keeps failed initialization from leaving a descriptor-only managed
root.

Direct init and static restore each take one non-blocking sibling lease for the
target root. The lease is outside the managed root and outside backups. SDK
bindings that do not already own the lease leave the config flag clear and rely
on the C boundary. The native Rust SDK instead retains the lease acquired while
preparing a direct root and passes `OLIPHAUNT_CONFIG_EXTERNAL_ROOT_LOCK`; its
broker child follows the same direct path. The native Rust server retains the
equivalent lease itself because its PostgreSQL process bypasses the C runtime.

## Physical backup and restore

The C ABI exposes one buffered PostgreSQL 18 native physical archive. Backup
uses PostgreSQL backup mode, archives the complete PGDATA state needed for
recovery, appends required WAL and backup metadata, and emits the exact shared
native archive manifest. Runtime-local files and unsupported linked or special
filesystem entries are excluded or rejected.

Restore accepts a new or existing-empty destination. It:

1. takes the destination's sibling lease;
2. validates the tar container and unpacks into a unique sibling stage;
3. requires the exact native archive manifest and the minimal PostgreSQL files,
   including a real `pgdata/pg_wal` directory;
4. consumes archive metadata and privately writes the destination's native
   `.oliphaunt.json`; and
5. atomically publishes the staged root without replacing nonempty data.

Only regular files and directories are accepted. Absolute/traversing paths,
duplicate canonical paths, links, device nodes, FIFOs, invalid tar metadata,
tree collisions, truncated terminators, trailing data, and external
tablespaces are rejected. The managed-root descriptor is destination identity,
not archive content.

Native SDK archives are mutually compatible because all native adapters reach
this boundary. Native and WASIX physical formats remain separate; standard
PostgreSQL logical dump/restore is the transfer path between runtime families.

## Queries, streaming, and cancellation

Simple query and raw protocol calls operate on PostgreSQL wire messages. Owned
responses remain valid until `oliphaunt_free_response`. The streaming callback
path applies a bounded queue so a slow consumer cannot create unbounded runtime
memory. Cancellation targets the active backend operation and the connection
must recover through normal PostgreSQL protocol readiness before reuse.
Callback rejection has a typed positive status only after recovery reaches
`ReadyForQuery`; a negative stream status is a native transport or recovery
failure and must remain the primary error.

Asynchronous FFI schedulers use the operation-specific `_with_error` ABI
variants. Each invocation receives a fixed-layout `OliphauntErrorCapture` that
is filled on the native worker before its handle lease is released. Synchronous
bindings can continue to copy the operation-local TLS error immediately with
`oliphaunt_copy_last_error`. This distinction prevents a resumed event-loop
thread from reading another operation's shared handle error.

Typed rows, callback transactions, and language stream shapes belong in SDKs.
Keeping the C boundary byte-oriented avoids cross-language object ownership and
keeps protocol behavior identical.

## Extensions

Desktop native runtimes load exact packaged extension modules through normal
PostgreSQL `CREATE EXTENSION` and `$libdir` resolution. Mobile builds register
selected statically linked modules before first init; the process-wide registry
then becomes immutable. SDK packaging resolves exact extension artifacts and
startup preload requirements. Selecting those artifacts does not execute
`CREATE EXTENSION`, `LOAD`, schema setup, or post-create SQL. The runtime does
not invent an extension migration system: application migrations and
PostgreSQL extension SQL remain authoritative.

## Native modes

- Direct mode calls `liboliphaunt` in the application process.
- Broker mode runs the same C boundary in an SDK-owned helper process.
- Server mode runs packaged PostgreSQL and exposes a connection endpoint; it
  does not call the C direct runtime.

Mode-specific transport and process supervision remain SDK concerns. Direct
and broker database handles keep the aligned query, transaction, raw protocol,
backup, and error vocabulary. A server handle owns only process/listener
lifecycle and a connection string; ordinary PostgreSQL clients own its SQL,
transactions, cancellation, and pooling. Native server backup remains
deliberately deferred in the SDK parity policy instead of being simulated
through a hidden direct handle.

## Verification

The native build and smoke lanes validate the public header, exported ABI,
managed-root parser, root topology, lifecycle generations, protocol behavior,
cancellation, backup/restore hardening, and packaged runtime layout. Language
SDK package and smoke lanes then prove their adapters against the same artifact.

```sh
moon run liboliphaunt-native:host-smoke
src/runtimes/liboliphaunt/native/tools/check-track.sh quick
src/runtimes/liboliphaunt/native/tools/check-track.sh sdks
```
