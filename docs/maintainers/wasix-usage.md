# WASIX usage and maintenance

This document records the supported `oliphaunt-wasix` Rust shape and the
public `@oliphaunt/wasix` TypeScript binding. WASIX is a separate product
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

- `Memory` is the default and uses a true Wasmer memory filesystem;
- `TemporaryDirectory` is an SDK-owned disposable host directory;
- `Directory(path)` is a caller-owned persistent host directory;
- `ApplicationData(identity)` resolves a retained platform app-data directory.

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

### Server and data movement

`OliphauntServer::builder().start()` also defaults to memory. Select the same
`DatabaseStorage` and `DatabaseInitialization` values when a client library
needs a PostgreSQL URL.

Use logical dumps for upgrades and cross-version movement. Use
`backup()` plus `DatabaseInitialization::PhysicalArchive(bytes)`, or
`try_clone()`, only for compatible same-version physical copies. The dump CLI
spells persistent input as `--directory PATH`.

## TypeScript host

`@oliphaunt/wasix` runs the portable guest in a browser module Worker or a Node
worker thread. Omitted storage is fresh memory on both hosts. Browser IndexedDB
is deliberately a selective adapter import:

```ts
import Oliphaunt from '@oliphaunt/wasix';
import pgtap from '@oliphaunt/extension-pgtap-wasix';
import { indexedDB } from '@oliphaunt/wasix/storage/indexed-db';

const database = await Oliphaunt.open({
  storage: indexedDB('maintainer-proof'),
  extensions: [pgtap],
});

await database.query('select pgtap_version()');
await database.close();
```

The adapter snapshots the complete memory-backed PGDATA into one atomic
IndexedDB record after explicit `checkpoint()` and clean `close()`. Web Locks
enforce one worker owner per persistent database. SQL errors recover through
`ReadyForQuery` without poisoning storage. Snapshot failure retains the previous
generation and poisons the live handle because newer commits may exist only in
memory.

This is checkpoint/clean-close persistence, not per-query or crash durability.
OPFS is absent because the current Wasmer browser filesystem cannot expose a
truthful direct synchronous mount. Node currently supports the memory default
only. Package exports select the worker-thread adapter automatically; neither
host routes through the TypeScript SDK's native runtime.

Extension packages use the WASIX-only suffix, while native/default package
identifiers remain unsuffixed. Browser and Node WASIX hosts consume the
same host-neutral descriptor and bytes. A WASIX leaf shares the version and
release line of its owning extension product.

## Wasmer compatibility

The Rust binding and canonical runtime use Wasmer `7.2.1` and the matching
WASIX/virtual support family `0.702.1`.

The latest npm `@wasmer/sdk` release is `0.10.0`, whose source remains on a
coherent Wasmer 6.1/WASIX 0.601 family. The browser binding therefore uses a
source-patched host pinned under `src/bindings/wasix-ts/host`. Updating only
`wasmer-wasix` is not compatible: moving the browser host to 0.702 requires a
coordinated Wasmer JS port, its matching support crates and WebC APIs, and
requalification of the PostgreSQL error-recovery pump and extension carriers.

## Qualification

Use the product tasks rather than ad hoc root wrappers:

```sh
moon run oliphaunt-wasix-rust:package
moon run oliphaunt-wasix-ts:package oliphaunt-wasix-ts:smoke-node
moon run oliphaunt-wasix-ts:smoke oliphaunt-wasix-ts:smoke-pg-uuidv7
```

The browser smokes are local-only finite Chrome proofs and require the canonical
runtime outputs. The normal smoke proves pgtap, distinct SQLSTATE errors,
`ReadyForQuery` recovery, subsequent SQL, clean Terminate, and successful guest
exit. The pg_uuidv7 canary additionally proves the exact selected native WASIX
module; it is not a generic dynamic-extension support claim.

The Node smoke packs the SDK, runtime carrier, and selected extension carrier,
installs them in a fresh external project, and proves conditional export,
package-relative asset, extension, recovery, and clean-close behavior.
