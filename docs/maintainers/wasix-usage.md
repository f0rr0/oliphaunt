# WASIX usage and maintenance

`oliphaunt-wasix` and `@oliphaunt/wasix-ts` are language bindings over the
`liboliphaunt-wasix` runtime family. They share the guest, carrier identities,
managed-root schema, physical format, archive envelope, extension descriptors,
and conformance fixtures. They keep host filesystems, locks, sockets, byte buffers,
and errors language-native.

Neither binding imports, selects, or falls back to a native SDK.

## Rust host

```toml
[dependencies]
oliphaunt-wasix = "0.1"
```

The root `Oliphaunt::open()` API retains Wasmer and PostgreSQL on the calling
thread and uses a true Wasmer memory filesystem. Persistence is an explicit
managed root:

```rust,no_run
use oliphaunt_wasix::{DatabaseStorage, Oliphaunt};

fn main() -> anyhow::Result<()> {
    let mut database = Oliphaunt::builder()
        .storage(DatabaseStorage::Directory("./data/main".into()))
        .open()?;
    assert_eq!(database.query("select 1::text as value")?.get_text(0, "value")?, Some("1"));
    database.close()?;
    Ok(())
}
```

The managed root contains `.oliphaunt.json` and `pgdata`. Runtime overlays and
other mutable guest directories are SDK-owned state elsewhere. A host-directory
owner prevents a second Rust open while the database is live.

Ordinary open initializes a new store from the packaged cluster seed. Tests or
tools that specifically need `initdb` invoke the packaged tool directly.
Physical archives use the dedicated restore API. There is no legacy
PGDATA-only restore path; nonempty descriptorless roots and incomplete stores
fail without mutation.

`OliphauntServer::builder().start()` supplies a local PostgreSQL endpoint when
an existing Rust client needs one; the returned handle exposes only its
connection string, closed state, and close. The parallel
`AsyncOliphauntServer::builder().start().await` keeps lifecycle work off the
async caller. The optional `tools` feature supplies `pg_dump` and
non-interactive `psql` as fluent database methods. Applications that must keep
an async executor responsive use root `AsyncOliphaunt`; it owns a dedicated
database thread, returns futures, and is cloneable. Root `Oliphaunt` stays the
no-hop, exclusive caller-thread surface.

Blocking `Oliphaunt` is neither `Send` nor `Sync`; blocking
`OliphauntServer` is `Send` but not `Sync`. The cloneable async database and
server handles are `Send + Sync`, while `AsyncTransaction` is `Send` but not
`Sync` and requires exclusive mutable access. These traits expose the real
Wasmer/runtime owner instead of implying concurrency that does not exist.

Each exact `extension-*` leaf feature enables the common extension selector
machinery and its matching uppercase associated constant. `Extension::ALL`
and `Extension::by_sql_name` contain only the enabled leaf set, while
`sql_name` returns the selected extension's PostgreSQL name. Reopening a
database whose catalog uses an extension requires the receiving host to select
and provide that runtime code again.

## TypeScript host

```ts
import Oliphaunt from '@oliphaunt/wasix-ts';

await using database = await Oliphaunt.open();
const result = await database.query('select $1::int + 1 as answer', [41]);
```

The package runs in a browser, Node.js, Bun, Deno, or Electron. In browsers the
root owns execution in the importing JavaScript realm. On native hosts the
root uses a dedicated Rust owner thread and keeps the importing event loop
responsive. Import `@oliphaunt/wasix-ts/direct` for the lowest-overhead
caller-realm native placement, or `@oliphaunt/wasix-ts/worker` for a separate
JavaScript Worker realm on every runtime. Browser execution requires
cross-origin isolation.

Memory is the default. Persistent providers are selective imports:

- `storage/indexed-db` and `storage/opfs` in browsers;
- `storage/node`, `storage/bun`, and `storage/deno` on those runtimes.

IndexedDB hydrates a Wasmer memory directory and publishes journaled changes.
OPFS Worker execution uses synchronous access handles for exact-range I/O to an
opaque backing-file pool; the root direct entry point and browsers without that
facility publish the same journal to that same format.
Node, Bun, Deno, and Electron directory providers publish below the managed root's
`pgdata` child. Ordinary operations complete a provider boundary after
`ReadyForQuery`; callback transactions do so once after confirmed `COMMIT` or
`ROLLBACK`. A new persistent direct-OPFS database uses one separate internal
full-publication boundary after initialization. That boundary is not a public
operation or option. Applications that need a PostgreSQL checkpoint issue
`execute("CHECKPOINT")`; it completes the same ordinary provider boundary as
another successful statement.

IndexedDB publication is one transaction. OPFS honors guest file flushes,
drains WAL at operation boundaries, and flushes all dirty files in PostgreSQL
order for checkpoint, close, or namespace publication. Its portable path uses
copy-on-write file backings and publishes namespace state last. A publication
failure poisons the handle because the live guest may be ahead of durable
storage. PostgreSQL statement errors that recover through `ReadyForQuery` do
not poison storage.

The synchronous OPFS path reserves a bounded set of preopened backing files for the
synchronous hot path. A larger creation burst is staged only until the mandatory
host boundary. That boundary allocates, writes, and flushes every staged file
before publishing namespace state; failure poisons the live handle and leaves
the previous namespace authoritative. Reserve replenishment after a successful
boundary is best-effort housekeeping and cannot change that boundary's reported
commit state; initial capacity failure selects the portable path. Reserve size
is an internal performance detail, not a database-capacity setting.

`backup()` produces the exact WASIX physical archive. `Oliphaunt.restore()`
accepts that archive and new or empty persistent storage. Restore rejects
memory and nonempty destinations. The destination creates its own descriptor.

`execProtocolRawStream()` is the bounded callback form of the raw protocol
escape hatch on a database/root handle. Managed transaction and server handles
have no raw bypass. Transaction ownership is derived from exact backend command
tags and its terminal readiness status; manual lifecycle SQL and `AND CHAIN`
are unsupported, while savepoints and `ROLLBACK TO` remain valid. The optional
`@oliphaunt/wasix-tools` package runs standard plain `pg_dump` against root,
direct, or Worker handles. Non-interactive `psql` supports any handle on Node,
Bun, Deno, and Electron and requires a Worker handle in browsers. It preserves PostgreSQL's
normal COPY-based plain dump rather than rewriting it.

Node, Bun, Deno, and Electron applications may import `openServer` from the shared
host-only `@oliphaunt/wasix-ts/server` subpath. It opens a loopback TCP endpoint
or a PostgreSQL-named Unix socket and services one complete client connection
at a time, matching the single embedded backend. An additional connection can
wait in the operating-system listen backlog, so callers should configure pools
with a maximum size of one instead of relying on deterministic concurrent
rejection. The listener and storage lease persist, while each admitted client
receives a fresh backend. The returned handle exposes only `connectionString`,
closed state, close, and asynchronous disposal; the external driver or ORM owns
all SQL, transactions, and connection lifecycle. PostgreSQL wire
`CancelRequest` is not supported yet. Browsers have no server export.
This compatibility endpoint remains distinct from the concurrent
`liboliphaunt-wasix-postmaster` product.

TypeScript still has no cancellation or dedicated typed COPY API. Those
absences are recorded in the SDK parity policy rather than represented as
capability flags.

Across both bindings, selecting extensions supplies exact runtime artifacts,
dependencies, and required pre-start preload/GUC configuration only. Open and
server start never execute database-local `CREATE EXTENSION`, `ALTER
EXTENSION`, `LOAD`, schema setup, or post-create SQL. Applications and ORM
migrations own those normal PostgreSQL operations.

## Shared storage contract

Rust and TypeScript filesystem roots share:

- the exact five-field `.oliphaunt.json` schema;
- `pgdata` as the only PostgreSQL data child;
- PostgreSQL 18 and `wasix-pg18-v1` as the physical key;
- the exact five-key physical archive manifest.

Ownership mechanisms remain local. Rust and Node/Bun/Deno/Electron TypeScript
hosts use Rust OS advisory owners outside the managed root and outside backups;
browser TypeScript uses Web Locks. Cross-binding root handoff is not a supported
or qualified workflow, and the mechanisms deliberately do not coordinate it.

## Guest and host ownership

The canonical PostgreSQL WASIX patches and guest lifecycle live under
`liboliphaunt-wasix`. Rust and TypeScript consume that output. Host adaptations
remain with the binding that needs them:

- Rust owns Wasmer-native filesystem, socket, and Rust stream integration;
- TypeScript owns JavaScript Workers, native actor/direct placement, IndexedDB,
  OPFS, Web Locks, and JavaScript stream/value shapes.

Do not introduce a second control WebAssembly module or a universal filesystem
interface merely to share host-specific code. Share a contract or fixture when
both bindings need the same invariant; share implementation only where it is
already naturally portable.

## Qualification

```sh
moon run oliphaunt-wasix-rust:package
moon run oliphaunt-wasix-ts:package
moon run oliphaunt-wasix-ts:tools-check
```

Product package and smoke tasks own the host/runtime combinations they publish.
