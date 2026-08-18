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

`Oliphaunt::open()` uses a true Wasmer memory filesystem. Persistence is an
explicit managed root:

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

Ordinary open initializes a new store from the packaged template. Tests or
tools that specifically need `initdb` invoke the packaged tool directly.
Physical archives use the dedicated restore API. There is no legacy
PGDATA-only restore path; nonempty descriptorless roots and incomplete stores
fail without mutation.

`OliphauntServer` supplies a local PostgreSQL endpoint when an existing Rust
client needs one. The optional `tools` feature supplies `pg_dump` and `psql`.
These are Rust host facilities, not features implied for a browser package.

Extensions are exact Cargo feature/package selections. Reopening a database
whose catalog uses an extension requires the receiving host to provide that
extension code again.

## TypeScript host

```ts
import Oliphaunt from '@oliphaunt/wasix-ts';

await using database = await Oliphaunt.open();
const result = await database.query('select $1::int + 1 as answer', [41]);
```

The package runs in a browser, Node.js, Bun, or Deno. Worker placement is the
default; `execution: 'direct'` uses the same API in the caller realm and blocks
that realm during PostgreSQL work. Browser execution requires cross-origin
isolation.

Memory is the default. Persistent providers are selective imports:

- `storage/indexed-db` and `storage/opfs` in browsers;
- `storage/node`, `storage/bun`, and `storage/deno` on those runtimes.

IndexedDB hydrates a Wasmer memory directory and publishes journaled changes.
OPFS worker execution uses direct synchronous access to an opaque backing-file
pool; other browser placements publish the same journal to that same format.
Node, Bun, and Deno directory providers publish below the managed root's
`pgdata` child. Ordinary operations complete a provider boundary after
`ReadyForQuery`; callback transactions do so once after confirmed `COMMIT` or
`ROLLBACK`; explicit `checkpoint()` sends PostgreSQL `CHECKPOINT` and then
publishes.

IndexedDB publication is one transaction. Direct OPFS honors guest file flushes,
drains WAL at operation boundaries, and flushes all dirty files in PostgreSQL
order for checkpoint, close, or namespace publication. Its portable path uses
copy-on-write file backings and publishes namespace state last. A publication
failure poisons the handle because the live guest may be ahead of durable
storage. PostgreSQL statement errors that recover through `ReadyForQuery` do
not poison storage.

`backup()` produces the exact WASIX physical archive. `Oliphaunt.restore()`
accepts that archive and new or empty persistent storage. Restore rejects
memory and nonempty destinations. The destination creates its own descriptor.

TypeScript has no current server, `pg_dump`/`psql`, cancellation, or direct COPY
streaming API. These absences are recorded in the SDK parity policy rather than
represented as capability flags.

## Shared storage contract

Rust and TypeScript filesystem roots share:

- the exact five-field `.oliphaunt.json` schema;
- `pgdata` as the only PostgreSQL data child;
- PostgreSQL 18 and `wasix-pg18-v1` as the physical key;
- the exact five-key physical archive manifest.

Ownership mechanisms remain local. Rust and Node/Bun/Deno TypeScript hosts use
their own stable sibling owners outside the managed root and outside backups;
browser TypeScript uses Web Locks. Cross-binding root handoff is not a supported
or qualified workflow, and the mechanisms deliberately do not coordinate it.

## Guest and host ownership

The canonical PostgreSQL WASIX patches and guest lifecycle live under
`liboliphaunt-wasix`. Rust and TypeScript consume that output. Host adaptations
remain with the binding that needs them:

- Rust owns Wasmer-native filesystem, socket, and Rust stream integration;
- TypeScript owns Web Workers, worker threads, IndexedDB, OPFS, Web Locks, and
  JavaScript stream/value shapes.

Do not introduce a second control WebAssembly module or a universal filesystem
interface merely to share host-specific code. Share a contract or fixture when
both bindings need the same invariant; share implementation only where it is
already naturally portable.

## Qualification

```sh
moon run oliphaunt-wasix-rust:package
moon run oliphaunt-wasix-ts:package
```

Product package and smoke tasks own the host/runtime combinations they publish.
