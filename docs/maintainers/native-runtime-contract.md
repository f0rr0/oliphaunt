# Native Runtime Guide

This guide describes the native `oliphaunt` Rust SDK and `liboliphaunt`
runtime. WASIX runtime behavior is documented separately in
[`WASM runtime`](/sdk/wasm/runtime).

## Choose A Mode

`NativeDirect` is the lowest-latency embedded mode. It loads `liboliphaunt` in
the host process and owns one resident PostgreSQL backend for the process
lifetime.

Use it when the Rust SDK owns the database calls and the application wants one
fast embedded PostgreSQL session:

```rust,no_run
use oliphaunt::Oliphaunt;

# async fn open_direct() -> oliphaunt::Result<()> {
let db = Oliphaunt::builder()
    .path(".oliphaunt")
    .native_direct()
    .open()
    .await?;

let rows = db.query("SELECT 1::text AS value").await?;
assert_eq!(rows.get_text(0, "value")?, Some("1"));

db.close().await?;
# Ok(())
# }
```

`NativeBroker` runs the same direct engine in a helper process. It is the robust
desktop/app mode for process isolation and multiple roots managed by one Rust
SDK runtime. Each broker-owned root still has one serialized physical
PostgreSQL backend session.

Use it when process isolation and multi-root ownership matter more than absolute
minimum call overhead:

```rust,no_run
use oliphaunt::Oliphaunt;

# async fn open_broker() -> oliphaunt::Result<()> {
let db = Oliphaunt::builder()
    .path(".oliphaunt")
    .native_broker()
    .broker_max_roots(4)
    .open()
    .await?;

db.execute("CREATE TABLE IF NOT EXISTS events(id bigint PRIMARY KEY)").await?;
db.close().await?;
# Ok(())
# }
```

`NativeServer` starts a real local PostgreSQL-compatible server process. It is
the only SDK mode for independent client sessions, connection pools, `psql`,
`pg_dump`, ORMs, and libraries that expect a PostgreSQL connection string:

```rust,no_run
use oliphaunt::Oliphaunt;

# async fn open_server() -> oliphaunt::Result<String> {
let db = Oliphaunt::builder()
    .path(".oliphaunt")
    .native_server()
    .max_client_sessions(8)
    .open()
    .await?;

Ok(db.connection_string().expect("server mode exposes a URL").to_owned())
# }
```

## Runtime Semantics

The three modes are intentionally different. The SDK must not fake server
semantics in direct or broker mode.

| Mode | Process model | Session model | Root model | Reopen/crash behavior |
| --- | --- | --- | --- | --- |
| `NativeDirect` | in-process | one serialized physical session | one resident root per process | same-root logical reopen only; no crash isolation |
| `NativeBroker` | helper process per active root | one serialized physical session per root | multiple roots bounded by `broker_max_roots` | helper crash can be restarted; app process remains alive |
| `NativeServer` | PostgreSQL server process | independent PostgreSQL client sessions | one server root per opened handle | use normal server restart/recovery flows |

`Oliphaunt` is cloneable as an SDK handle. Clones share the same owner executor,
FIFO queue, session pin, cancellation handle, and close state. Cloning is not a connection pool.
Direct and broker mode reject `max_client_sessions` values other than `1`;
server mode is the independent-session mode.

Transactions and explicit session pins reserve the single SDK-owned physical
session. Unpinned database work, backup, restore-adjacent work, and checkpoints
are rejected while a pin is active so direct and broker calls cannot interleave
inside one transaction-sensitive PostgreSQL session.

## Direct Lifecycle

Direct mode is process-resident:

- one resident backend per process;
- one physical session;
- serialized requests through the SDK owner executor;
- one root per process after the resident backend exists;
- `close()` is a logical detach, not full PostgreSQL shutdown;
- reopening is same-root only inside the same process;
- native PostgreSQL crashes terminate the host process.

The reliability contract is crash consistency, not crash isolation. If the host
process dies, the next launch reopens the same root and PostgreSQL performs WAL
recovery. Applications that need app-process survival after database-process
death should use broker/server modes where the target platform supports them.

## Storage

Native live storage is a PostgreSQL root directory, not a single file. A root
contains PGDATA, Oliphaunt metadata, lock metadata, extension metadata, and
recovery state.

Persistent roots use exclusive locking in direct mode. Broker and server modes
own their roots through the helper/server process. A second unsafe owner fails
instead of sharing a data directory.

Use SDK backup/restore APIs for ergonomic export/import:

- direct and broker support same-version physical archives;
- server supports same-version physical archives and SQL dumps through packaged
  PostgreSQL tooling;
- physical archives are for same-version restore, not cross-version upgrades.

## Startup Configuration

`OliphauntBuilder::runtime_footprint(...)` selects the startup footprint before
PostgreSQL starts:

- `RuntimeFootprintProfile::Throughput`: throughput defaults;
- `RuntimeFootprintProfile::BalancedMobile`: lower slot counts, smaller shared
  buffers/WAL footprint, and PG18 sync I/O for resident mobile apps;
- `RuntimeFootprintProfile::SmallMobile`: the smallest supported resident
  profile for memory-pressure experiments.

`OliphauntBuilder::startup_guc(name, value)` and `startup_gucs(...)` append
validated PostgreSQL `-c name=value` overrides after durability and footprint
profiles. Later overrides win, matching PostgreSQL startup behavior. Server mode
then appends its configured `max_connections` from `max_client_sessions(...)`
because independent session count is the server-mode contract.

## Extensions

Extensions are opt-in. Select exact PostgreSQL extension names before opening:

```rust,no_run
use oliphaunt::{Extension, Oliphaunt};

# async fn open_with_vector() -> oliphaunt::Result<()> {
let db = Oliphaunt::builder()
    .path(".oliphaunt")
    .native_direct()
    .extension(Extension::Vector)
    .open()
    .await?;

db.execute("CREATE EXTENSION IF NOT EXISTS vector").await?;
db.close().await?;
# Ok(())
# }
```

`CREATE EXTENSION` succeeds only when the selected runtime resources contains the extension
assets and, on mobile, when the required static registry entries are present.
Desktop dynamic extension loading is a future capability and must not replace
the current selected-resource release lane until signed loading is implemented
and tested.

## Capabilities

Use capabilities instead of assuming a mode can do everything:

- `session_concurrency` distinguishes serialized SDK sessions from independent
  server sessions;
- `multi_root` is broker-only today;
- `same_root_logical_reopen`, `root_switchable`, and `crash_restartable`
  describe lifecycle semantics explicitly;
- `backup_formats` and `restore_formats` gate backup/restore UI before work is
  queued.

Swift, Kotlin, and React Native expose the same product concepts with
platform-native naming. Unsupported platform modes should report explicit
unsupported reasons rather than aliasing to direct mode.
