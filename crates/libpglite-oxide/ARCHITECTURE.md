# Native Rust SDK Architecture

`libpglite-oxide` is the clean native path for the Rust SDK. It is not a
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

The public Rust boundary is `PgliteBuilder -> Pglite`. Concrete PostgreSQL
bindings implement `NativeRuntime` and return an `EngineSession`. The SDK owns
configuration, capabilities, extension-pack selection, and serialized execution;
the runtime owns PostgreSQL lifecycle and protocol execution.

`LibPgliteRuntime` is the initial concrete runtime for the native C ABI. It
loads `libpglite` from `LIBPGLITE_OXIDE_LIBPGLITE` or an explicit path. It only
serves `NativeDirect`; broker and server modes have separate runtime scaffolds
so direct mode cannot accidentally grow fake multi-client semantics.

## Concurrency

Direct mode uses an owner thread. `Pglite` handles are cheap clones that send
commands to that owner. `SessionPin` reserves the physical session for
transaction or session-state-sensitive work, and unpinned work is rejected while
the pin is active.

`Transaction` is built on `SessionPin`: it sends `BEGIN`, keeps all work pinned,
and releases the physical session on `COMMIT` or `ROLLBACK`.

## Storage

The live database is a root directory. The SDK models root locking, bootstrap
strategy, and backup formats explicitly. Production native targets should use a
packaged template cluster for first open; `initdb` is a tooling fallback.

## Extensions

Extensions are opt-in packs. `CREATE EXTENSION` should only succeed when the
selected manifest pack provides the extension. Static registry loading is the
portable path; signed dynamic packs are a desktop capability.

## Performance Contract

Native implementations should benchmark direct protocol RTT, typed query
overhead, batched writes, large result streaming, cold/warm open, package size,
memory, backup/restore, SQLite comparison, and current WASIX comparison before
becoming a default.
