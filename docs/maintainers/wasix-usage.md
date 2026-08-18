# WASIX usage and maintenance

This document records the supported `oliphaunt-wasix` Rust shape and the
public `@oliphaunt/wasix-ts` TypeScript binding. WASIX is a separate product
family. Neither binding imports, aliases, or falls back to a native SDK.

## Rust host

Applications install the SDK and package-manager-resolved runtime products:

```toml
[dependencies]
oliphaunt-wasix = "0.1"
```

Enable extension APIs only when the application selects WASIX extension
artifacts:

```toml
oliphaunt-wasix = { version = "0.1", features = ["extensions"] }
```

The crate has no public archive-URL or environment-variable installation mode.
The release graph supplies the matching portable runtime, AOT, tools, and exact
extension carriers.

### Storage and initialization

`DatabaseStorage` owns the mutable PGDATA lifetime:

- `Memory` is the default and uses Wasmer memory filesystems for PGDATA and
  every mutable guest runtime directory;
- `Directory(path)` is a caller-owned host directory. Applications resolve
  temporary or platform app-data paths before passing them to the SDK.

Memory storage creates no host temporary workspace. Its per-instance runtime
upper layer and PGDATA are separate memory filesystems over one process-shared
immutable memory runtime. Runtime source assets and compiled AOT artifacts may
still use process-wide host caches, but they are not writable guest storage.

For retained storage, the selected directory is PGDATA itself. Extensions,
`/home`, `/tmp`, and other mutable overlay state use a separate SDK-owned runtime
workspace. Host directory `fd_sync` calls reach `sync_all`, namespace changes
sync parent directories, and normal durability keeps PostgreSQL `fsync` enabled.
Retained paths contain the complete cluster. The retired nested
`tmp/oliphaunt/base` and PGDATA-overlay layouts are rejected rather than silently
migrated.

`DatabaseInitialization` is orthogonal:

- `PackagedTemplate` is the normal default;
- `FreshInitdb` runs the packaged WASIX `initdb` tool;
- `PhysicalArchive(bytes)` hydrates a compatible same-version physical backup.

The ordinary zero-configuration path is therefore:

```rust,no_run
use oliphaunt_wasix::Oliphaunt;

fn main() -> anyhow::Result<()> {
    let mut database = Oliphaunt::open()?;
    database.exec("select 1", None)?;
    database.close()?;
    Ok(())
}
```

Persistence is explicit:

```rust,no_run
use oliphaunt_wasix::{DatabaseStorage, Oliphaunt};

fn main() -> anyhow::Result<()> {
    let mut database = Oliphaunt::builder()
        .storage(DatabaseStorage::Directory("./.oliphaunt".into()))
        .open()?;
    database.close()?;
    Ok(())
}
```

The clean-break surface intentionally has no `path`, `app`, `temporary`,
`fresh_temporary`, `template_cache`, or argument-taking `Oliphaunt::open`
aliases. Internal runtime overlays may still use filesystem roots where that is
the accurate implementation term; they are not database configuration.

### Startup and queries

The direct and server builders share startup configuration:

- `postgres_config(name, value)` and `postgres_configs(...)`;
- `username(...)` and `database(...)`;
- `debug_level(...)` and `relaxed_durability(...)`;
- `startup_arg(...)` and `startup_args(...)` for advanced PostgreSQL arguments.

`exec` runs SQL without parameters. `query` uses PostgreSQL's extended protocol
with `serde_json::Value` parameters. `QueryOptions` controls row mode, parsers,
serializers, parameter OIDs, `/dev/blob`, and notices. Transaction, LISTEN/NOTIFY,
raw protocol, and COPY behavior remain on the direct database handle.

### Extensions

Extensions are exact opt-ins. The base runtime does not carry optional extension
payloads:

```rust,no_run
use oliphaunt_wasix::{extensions, Oliphaunt};

fn main() -> anyhow::Result<()> {
    let mut database = Oliphaunt::builder()
        .extension(extensions::VECTOR)
        .open()?;
    database.exec("create extension if not exists vector", None)?;
    database.close()?;
    Ok(())
}
```

Generated extension metadata resolves mandatory dependencies and startup
requirements before PostgreSQL starts. Post-open activation fails closed for an
extension whose lifecycle requires preload or restart.

Extension selection belongs to each runtime open, not to PGDATA. Reopening a
`Directory` whose catalog uses an extension must select that extension again;
the catalog persists, while its exact runtime package files are supplied by the
new builder.

### Server and data movement

`OliphauntServer::builder().start()` also defaults to memory. Select the same
`DatabaseStorage` and `DatabaseInitialization` values when a client library
needs a PostgreSQL URL.

Use logical dumps for upgrades and cross-version movement. Use
`backup()` plus `DatabaseInitialization::PhysicalArchive(bytes)`, or
`try_clone()`, only for compatible same-version physical copies. The dump CLI
spells persistent input as `--directory PATH`.

## TypeScript host

`@oliphaunt/wasix-ts` runs the portable guest with worker-isolated execution by
default. Browsers, Node.js, Bun, and Deno may instead select `execution: 'direct'` to construct
PostgreSQL asynchronously in the caller realm, then drive it synchronously
while keeping the same Promise-based database contract. Direct constructs no
Worker and each database call blocks that JavaScript agent until PostgreSQL
returns. Omitted storage is fresh memory on every host. Browser
IndexedDB is deliberately a selective adapter import:

```ts
import Oliphaunt from '@oliphaunt/wasix-ts';
import pgtap from '@oliphaunt/extension-pgtap-wasix';
import { indexedDB } from '@oliphaunt/wasix-ts/storage/indexed-db';

const database = await Oliphaunt.open({
  storage: indexedDB('maintainer-proof'),
  extensions: [pgtap],
});

await database.query('select pgtap_version()');
await database.close();
```

Use the same `open()` entry point for latency-sensitive placement:

```ts
await using database = await Oliphaunt.open({ execution: 'direct' });
const answer = await database.transaction((transaction) =>
  transaction.query('select $1::int + 1 as answer', [41]),
);
```

`execution` selects package lifecycle placement, not another PostgreSQL engine
or another database class. Each open owns an independent database process;
in-memory databases and distinct persistent store names can remain open in
either placement on every host.

The source-pinned Wasmer host records current-state PGDATA mutations, including
writes and truncates through descriptors PostgreSQL keeps open across calls.
After each completed protocol operation reaches `ReadyForQuery`, persistent
providers publish only those paths before resolving the operation. Callback
transactions suppress the internal boundaries and publish once after confirmed
`COMMIT` or `ROLLBACK`; a post-commit publication failure rejects and poisons
the handle. Each logical IndexedDB name owns an independent physical IndexedDB
database and commits its path rows atomically. OPFS and server directories
publish WAL first, ordinary files second, `global/pg_control` last, then
removals. Explicit `checkpoint()` runs PostgreSQL `CHECKPOINT` and then one
storage boundary. Web Locks enforce one browser owner per name. SQL errors
recover without poisoning storage; storage failures poison the handle because
retrying a commit is unsafe.

OPFS is an honest asynchronous delta provider, not a claimed synchronous guest
mount, and reports unknown durability after partial cross-file failure.
Node, Bun, and Deno add selectively imported `storage/node`, `storage/bun`, and
`storage/deno` raw-PGDATA adapters with an exclusive cross-process path lock for
local filesystems on one host. Linux
leases include host, boot, and PID namespace identities, so only locally
proven-dead owners are reaped; foreign scope leases fail closed as `busy`.
Network and cross-host shared filesystems are unsupported, and persistent
directory opens are restricted to the active runtime's main thread so process-owned leases
remain recoverable and child-worker cleanup remains reliable. Package exports
select the matching server-runtime adapter automatically; no host routes through the
TypeScript SDK's native runtime.

Extension packages use the WASIX-only suffix, while native/default package
identifiers remain unsuffixed. Browser, Node, Bun, and Deno WASIX hosts consume the
same host-neutral descriptor and bytes. A WASIX leaf shares the version and
release line of its owning extension product.

## Guest and host patch ownership

Optimize at the narrowest shared layer that owns the invariant. PostgreSQL
patches 0040 and 0041 specialize backend spinlocks and atomics, patch 0042
batches checked secure-random reads, and patch 0043 disables only the optional
writeback hint that WASIX rejects on PostgreSQL's read-only startup
descriptors. Real `fsync`/`fdatasync` remains active. These patches are valid
because every released WASIX database uses one PostgreSQL backend per
WebAssembly instance. They are compiled into the canonical guest once, so the
Rust binding's AOT artifacts and the portable module used by browser direct,
browser worker, and Node/Bun/Deno worker execution all benefit. They are not
host-specific patches.

Transport remains host-specific. Current TypeScript placements, including the
dedicated browser worker, use the direct guest-memory PGWire driver; worker
execution isolates its synchronous guest calls from the browser main thread.
PostgreSQL patch 0039 declares the hybrid transport ABI used only when the Rust
proxy enters COPY streaming; it does not add a process-level stdio entry point.
Rust pumps the existing lifecycle exports through its native Wasmer host. The patches under
`src/bindings/wasix-ts/host` adapt the pinned Wasmer JS 6.1/WASIX 0.601 host;
that host binds the explicitly single-backend guest clock directly to imported
memory. Its direct PGWire driver also moves
request bytes straight from JavaScript into guest memory and returns one owned
JavaScript response, avoiding intermediate copies without exposing a view that
PostgreSQL could later mutate. Direct-session stderr is retained only as a
bounded 16 KiB diagnostic tail and attached on lifecycle failure. These host
adaptations do not belong in the Rust host,
which uses the coherent Wasmer
7.2.1/WASIX 0.702.1 family. Native runtimes keep PostgreSQL's normal concurrent
atomics and their own transport rather than inheriting either WASIX contract.
Wasmer 7.2.1 explicitly disables WebAssembly exception-handling tests on
Windows, so the Rust MSVC host retains PostgreSQL's top-level process-exit
recovery boundary. Nested `PG_TRY`/`PG_CATCH` qualification applies to the
other Rust hosts and the JavaScript host; Windows still proves top-level error
recovery but does not claim nested Wasm-EH support.

## Wasmer compatibility

The Rust binding and canonical runtime use Wasmer `7.2.1` and the matching
WASIX/virtual support family `0.702.1`.

The latest npm `@wasmer/sdk` release is `0.10.0`, but the referenced source
commit identifies itself as 0.8.0 and remains on a coherent Wasmer 6.1/WASIX
0.601 family. The browser binding therefore uses a source-patched host pinned
under `src/bindings/wasix-ts/host`. Updating only
`wasmer-wasix` is not compatible: moving the browser host to 0.702 requires a
coordinated Wasmer JS port, its matching support crates and WebC APIs, and
requalification of the PostgreSQL error-recovery pump and extension carriers.

## Qualification

Use the product tasks rather than ad hoc root wrappers:

```sh
moon run oliphaunt-wasix-rust:package
moon run oliphaunt-wasix-ts:package-smoke-node oliphaunt-wasix-ts:package-smoke-bun oliphaunt-wasix-ts:package-smoke-deno
moon run oliphaunt-wasix-ts:smoke-node oliphaunt-wasix-ts:smoke-bun oliphaunt-wasix-ts:smoke-deno
moon run oliphaunt-wasix-ts:smoke oliphaunt-wasix-ts:smoke-pg-uuidv7
```

The `package-smoke-*` tasks are the fast packed-consumer checks. They use a
contract-valid inert runtime descriptor to prove package conditions, runtime
entrypoints, directory adapters, and `worker_threads` behavior without
building PostgreSQL or any extension. The full `smoke-*` tasks consume the
canonical portable runtime and therefore deliberately depend on the runtime
producer; CI supplies that producer's same-run artifact before invoking them.

The browser smokes are local-only finite Chrome proofs and require the canonical
runtime outputs. The normal smoke proves pgtap, distinct SQLSTATE errors,
`ReadyForQuery` recovery, subsequent SQL, clean Terminate, and successful guest
exit. The pg_uuidv7 canary additionally proves the exact selected native WASIX
module; it is not a generic dynamic-extension support claim.

The Node, Bun, and Deno smokes each pack the SDK, runtime carrier, and selected
extension carrier, install them in a fresh external project, and prove the
runtime's conditional export, package-relative asset, extension, recovery,
operation-boundary persistence, and clean-close behavior.
