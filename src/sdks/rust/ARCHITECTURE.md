# Native Rust SDK Architecture

`oliphaunt` is the clean native path for the Rust SDK. It is not a
compatibility layer over the current WASIX runtime and it should not grow
WASIX-specific fallback policy.

## Runtime Modes

- `NativeDirect` is the embedded default. It owns one physical PostgreSQL
  backend session and serializes all work through an owner executor. Handles are
  cloneable, but they share the same physical session.
- `NativeBroker` is the robust desktop shape. A helper process owns database
  roots, workers, root locks, recovery, upgrades, and extension loading.
- `NativeServer` is the true multi-client mode. It is the only mode that should
  advertise independent PostgreSQL client sessions or support general-purpose
  pools.

The SDK must not fake independent Postgres sessions in direct mode.

## Rust Boundary

The public Rust boundary is `OliphauntBuilder -> Oliphaunt`. Concrete PostgreSQL
bindings implement `NativeRuntime` and return an `EngineSession`. The SDK owns
configuration, capabilities, extension selection, and serialized execution;
the runtime owns PostgreSQL lifecycle and protocol execution.

`OliphauntRuntime` is the concrete runtime for the native C ABI. It loads
`liboliphaunt` from `LIBOLIPHAUNT_PATH` or an explicit path and serves
`NativeDirect`.

`NativeBrokerRuntime` supervises `oliphaunt-broker` worker processes. Each
worker owns one root and one direct backend, and the shared Rust runtime admits
up to `.broker_max_roots(n)` active roots. This keeps broker crash/process
isolation real instead of simulating it inside the client process, while still
supporting multi-root desktop apps without violating the native direct
process-global backend constraint. On Unix platforms the SDK uses a
Unix-domain socket by default to keep broker traffic off the TCP stack; set
`OLIPHAUNT_BROKER_TRANSPORT=tcp` only when debugging or forcing the
portable fallback path. The SDK generates a per-session authentication token,
passes it to the helper through the child environment, and sends it as the first
IPC frame before protocol or control messages are accepted. Cancellation uses a
separate authenticated IPC endpoint, so a cancel request is not blocked behind
the query response stream. The parent bootstrap policy is passed to the helper,
so `ExistingOnly` and tooling-only `initdb` behave the same way in broker mode
as they do in direct mode. If the helper exits between operations, the session
relaunches a fresh helper against the same root before the next operation. If a
helper dies while a request is in flight, that request returns an error rather
than being replayed with unknown commit state; later operations can relaunch and
recover through PostgreSQL WAL recovery.

`NativeServerRuntime` starts a real local PostgreSQL server process, connects to
it using the PostgreSQL v3 startup/query protocol, and exposes a connection
string. This is the only mode that advertises independent sessions. SDK-owned
query cancellation uses PostgreSQL's native CancelRequest packet with the
`BackendKeyData` returned during startup.

Internally, the `liboliphaunt` runtime is split so the C boundary does not become a
catch-all module:

- `oliphaunt/mod.rs`: runtime/session behavior and `EngineSession`
  implementation.
- `oliphaunt/ffi.rs`: ABI structs, symbol loading, and native library
  resolution.
- `oliphaunt/root.rs`: root locking, PGDATA path preparation, and temporary-root
  cleanup.
- `oliphaunt/root/runtime.rs`: profile-aware runtime-cache orchestration.
- `oliphaunt/root/runtime/locate.rs`: native PostgreSQL install and embedded
  module discovery.
- `oliphaunt/root/runtime/install.rs`: selected runtime asset installation for
  direct/broker and server profiles.
- `oliphaunt/root/runtime/cache_key.rs`: runtime cache key, manifest, and
  validation logic.
- `oliphaunt/root/files.rs`: deterministic filesystem copying, APFS clone
  fallback behavior, directory utilities, and cleanup helpers.
- `oliphaunt/root/fingerprint.rs`: content fingerprinting used by runtime and
  template cache keys.
- `oliphaunt/root/extensions.rs`: selected extension SQL/data/module
  materialization and filters that keep unselected extension assets invisible.
- `oliphaunt/root/template.rs`: packaged-template PGDATA cache construction,
  `initdb` bootstrap, and atomic root hydration.
- `broker.rs` and `ipc.rs`: helper process supervision and local IPC.
- `server.rs` and `pgwire.rs`: local PostgreSQL server lifecycle and raw wire
  protocol client.

## Concurrency

Direct mode uses an owner thread. `Oliphaunt` handles are cheap clones that send
commands to that owner. `SessionPin` reserves the physical session for
transaction or session-state-sensitive work, and unpinned work is rejected while
the pin is active.

`Transaction` is built on `SessionPin`: it sends `BEGIN`, keeps all work pinned,
and releases the physical session on `COMMIT` or `ROLLBACK`.

Close is a lifecycle boundary, not another ordinary queued query. When close
begins, new and already queued non-close work is rejected with `EngineStopped`.
If backend work is active, close waits for that work to finish before queueing
the runtime close or direct-mode logical detach. Query interruption is explicit
through `Oliphaunt::cancel()`; idle close does not send a spurious cancel.

## Storage

The live database is a root directory. The SDK models root locking, bootstrap
strategy, and backup formats explicitly.

`BootstrapStrategy::PackagedTemplate` is the production first-open path. New
roots are hydrated from a content-keyed base PGDATA template before the engine is
entered, which avoids paying `initdb` on every fresh open. The template is built
with the standalone PostgreSQL server runtime, then copied into roots with
copy-on-write cloning on macOS when the filesystem supports it. The diagnostic
environment variable `OLIPHAUNT_PGDATA_COPY_MODE=copy` forces physical
byte copies when investigating first-write copy-on-write effects. Direct and
broker execution still use the liboliphaunt-embedded runtime profile after the root
exists.

Runtime resources are also content-keyed. Direct/broker runtimes use
liboliphaunt-linked extension modules; server runtimes use standalone PostgreSQL
extension modules. Both profiles share the same manifest-gated
`share/postgresql` filtering so unselected extensions stay invisible.

Physical backup follows PostgreSQL's online backup protocol instead of copying a
live data directory blindly. Direct and server mode call `pg_backup_start`,
archive the `pgdata` tree with transient files omitted, then append the
`backup_label` and `tablespace_map` returned by `pg_backup_stop`. The `pg_wal`
contents are collected after `pg_backup_stop` so the archive carries the WAL
needed to recover a same-version clone. Broker mode delegates to the direct
runtime inside the helper process. Logical SQL backup is server-only and uses
packaged `pg_dump`.

`initdb` remains an explicit tooling fallback through
`BootstrapStrategy::InitdbToolingOnly`. `ExistingOnly` refuses to open an empty
or partial root in direct, broker, and server mode.

## Extensions

Extensions are opt-in exact PostgreSQL extension names. `CREATE EXTENSION`
should only succeed when the selected extension assets are present and, on
mobile, when required static registry rows are linked. Static registry loading is
the portable mobile path; signed dynamic desktop loading is a separate future
capability and not a grouping abstraction.

## Performance Contract

Native implementations should benchmark direct protocol RTT, typed query
overhead, batched writes, large result streaming, cold/warm open, package size,
memory, backup/restore, SQLite comparison, and native PostgreSQL controls before
becoming a default.
