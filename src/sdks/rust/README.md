# oliphaunt

## Install

Add the Rust SDK like any other Cargo dependency:

```toml
[dependencies]
oliphaunt = "0.1.0"
```

For Tauri or native Rust apps that use `NativeDirect`, resolve the matching
native runtime assets during your app packaging step:

```bash
cargo install oliphaunt --version 0.1.0
oliphaunt-resources \
  --resolve-release-assets \
  --liboliphaunt-native-version 0.1.0 \
  --release-target linux-x64-gnu \
  --extension vector \
  --output target/oliphaunt-resources \
  --force
```

`--extension` accepts exact PostgreSQL extension names only. If you select
`vector`, the resolver downloads and verifies the base runtime plus the
`vector` artifact and its mandatory dependencies; it does not download unrelated
extensions.

## Compatibility

| SDK | Native core | Distribution |
| --- | --- | --- |
| `oliphaunt` `0.1.0` | `liboliphaunt` `0.1.0` | crates.io plus checksum-covered GitHub release assets |

The resolver verifies `liboliphaunt-<version>-release-assets.sha256` before it
uses downloaded runtime or extension artifacts.

Apps that use `NativeBroker` also resolve the matching helper binary during
packaging:

```bash
oliphaunt-resources \
  --resolve-broker-release-assets \
  --broker-version 0.1.0 \
  --broker-release-target linux-x64-gnu \
  --output target/oliphaunt-broker \
  --force
```

Set `OLIPHAUNT_BROKER_ASSET_DIR=target/oliphaunt-broker` for packaged apps when
the helper is not installed next to the application executable. The broker
resolver verifies `oliphaunt-broker-<version>-release-assets.sha256` before
extracting the selected helper archive.

## Quickstart

```text
use oliphaunt::Oliphaunt;

# async fn demo() -> oliphaunt::Result<()> {
let db = Oliphaunt::builder()
    .path(".oliphaunt")
    .native_direct()
    .extension(oliphaunt::Extension::Vector)
    .open()
    .await?;

let result = db.query("SELECT 1::text AS value").await?;
assert_eq!(result.get_text(0, "value")?, Some("1"));

db.close().await?;
# Ok(())
# }
```

This crate is the native-first Rust SDK path for Oliphaunt. Rust is a product SDK
surface for Tauri and Rust desktop apps, not an internal implementation detail.
It is intentionally separate from the existing WASIX-oriented `oliphaunt-wasix`
API so the final shape can be designed around native PostgreSQL instead of
compatibility constraints.

The public model is:

- `NativeDirect`: in-process, one physical PostgreSQL session, serialized by an
  owner executor.
- `NativeBroker`: helper-process mode that isolates roots from the application
  process. A shared broker runtime supervises one worker process per root and
  admits up to `.broker_max_roots(n)` active roots.
- `NativeServer`: PostgreSQL-compatible local server mode for true independent
  client sessions.

`EngineCapabilities::reopenable` is true for all modes, but the semantics are
mode-specific and exposed explicitly. `NativeDirect` sets
`same_root_logical_reopen=true`, `root_switchable=false`, and
`crash_restartable=false`: it can logically close and reopen the same resident
root in the same process, but it remains single-root and process-global.
`NativeBroker` is process-isolated, root-switchable, and crash-restartable for
its helper process. `NativeServer` is root-switchable and exposes independent
client sessions, but the current SDK-owned server handle does not restart a
crashed server process in place.

The crate defines the SDK contract, configuration model, exact-extension model,
typed query helpers, structured PostgreSQL errors, startup user/database
identity, capabilities, and owner-thread execution boundary. Concrete
PostgreSQL 18 bindings plug in through `NativeRuntime`.

## Runtime Footprint

`OliphauntBuilder::runtime_footprint(...)` selects the PostgreSQL startup
footprint before the backend starts:

- `RuntimeFootprintProfile::Throughput`: current throughput lane
  (`shared_buffers=128MB`, `wal_buffers=4MB`, `min_wal_size=80MB`).
- `RuntimeFootprintProfile::BalancedMobile`: one-session mobile defaults with
  lower server slot counts, `shared_buffers=32MB`, `min_wal_size=32MB`, and
  PG18 sync I/O.
- `RuntimeFootprintProfile::SmallMobile`: the same one-session shape with
  `shared_buffers=8MB`, smaller work memory, `min_wal_size=32MB`, and PG18
  sync I/O.

The current PG18 artifact uses 16MB WAL segments, so `min_wal_size` below 32MB
is not a valid runtime GUC override. Testing 8MB/16MB WAL minima requires a
separate PostgreSQL build with a smaller WAL segment size.

`OliphauntBuilder::startup_guc(name, value)` appends explicit PostgreSQL `-c`
overrides after the selected footprint and durability profile, so benchmark
matrices can test individual GUCs without adding new API for each PostgreSQL
knob. Server mode still appends its configured `max_client_sessions` as
`max_connections`, because that API is the server-mode session contract.

Swift, Kotlin, and React Native should preserve this contract where their
platforms can do so honestly:

- Swift owns iOS and macOS runtime behavior.
- Kotlin owns Android runtime behavior.
- React Native owns the TypeScript and TurboModule layer while delegating
  runtime behavior to those platform SDKs.

Parity gaps must be explicit unsupported errors with a documented reason, not
silent API drift.

The default builder runtime matches the selected mode:

- `NativeDirect` loads the in-process C ABI through `OliphauntRuntime`.
- `NativeBroker` starts the packaged `oliphaunt-broker` helper and talks
  to it over local IPC. Unix platforms use Unix-domain sockets by default;
  `OLIPHAUNT_BROKER_TRANSPORT=tcp` forces the portable TCP fallback. The
  helper requires a generated per-session authentication frame before accepting
  protocol, backup, checkpoint, or close requests. Builder bootstrap policy is
  passed through to the helper, so `.existing_only()` remains strict in broker
  mode. Multi-root broker apps use one isolated helper per active root, bounded
  by `.broker_max_roots(n)`.
- `NativeServer` starts a real local PostgreSQL server process and exposes a
  connection string.

The crate does not depend on `oliphaunt-wasix`; native PostgreSQL lifecycle,
runtime resources, and exact extension materialization are owned here.

## Extensions

Extensions are opt-in by exact PostgreSQL SQL extension name. Rust callers use
`.extension(Extension::Vector)` or `.extension(Extension::PgTrgm)`, and package
tools use `--extension vector,pg_trgm`. Selecting `vector` includes `vector`
only, plus mandatory dependencies declared by the manifest. For example,
`earthdistance` materializes `cube` because PostgreSQL requires it.

The public `NATIVE_EXTENSION_MANIFEST` records supported PG18 extension rows,
including SQL/control assets, module requirements, dependencies, smoke SQL
strategy, direct-C-ABI/broker/server coverage, mobile static-link status, and
artifact policy. Extensions that require preload hooks, currently ParadeDB
`pg_search`, are reflected in startup automatically through
`shared_preload_libraries` when selected.

Release readiness is explicit and target-specific.
`oliphaunt-resources --list-extensions` prints a TSV catalog without requiring a
local PostgreSQL build; `desktop_prebuilt=yes` means the extension is available
from Oliphaunt desktop release artifacts, and `mobile_prebuilt=yes` means
iOS/Android apps can include it without compiling extension source. A row may
be known first-party metadata without being release-ready for every target.
PostGIS is visible in the catalog but remains `desktop_prebuilt=no` and
`mobile_prebuilt=no` while its native/mobile target files are candidate.
`pgcrypto` is mobile-prebuilt through the first-party OpenSSL static
`libcrypto` archive. `uuid-ossp` is mobile-prebuilt through the first-party
portable UUID static `libuuid` archive. `mobile_prebuilt=no` remains a hard
release boundary for extensions outside the validated set.

Third-party extensions use the same exact-selection contract through prebuilt
artifacts. `oliphaunt-resources --prebuilt-extension <artifact>` consumes an
unpacked directory, `.tar`, or `.tar.zst` with an
`oliphaunt-extension-artifact-v1` manifest plus a `files/` PostgreSQL runtime
tree that already contains the extension's control, SQL, data, and native
module files. The app project links/copies binary artifacts only; it does not
build PostgreSQL or extension source. Prebuilt artifacts cannot override
built-in release-ready names, and their dependencies must resolve to exact
built-in extensions or other provided prebuilt artifacts.
`oliphaunt-extension-artifact` creates the same artifact schema from already
built runtime files, copying only the exact selected extension's declared
control, SQL, data, and native module files into a directory, `.tar`, or
`.tar.zst` artifact. For mobile module extensions,
`--mobile-static-archive <target>:<archive>` stores the selected iOS/Android
static archive inside the artifact so app projects link binary artifacts only.
Dependency-backed modules can also pass
`--mobile-static-dependency-archive <target>:<name>:<archive>`; runtime
resources copy those archives into the static-registry package, Android SDKs
link them from the selected archive root, and the iOS helper packages them as
`liboliphaunt_dependency_<name>.xcframework`.
For distribution, publish an `oliphaunt-extension-artifact-index-v1` TOML file
with exact `sql_name`, `target`, dependency, preload, mobile-prebuilt, relative
artifact `path`, optional artifact `url`, mobile static archive target names,
`sha256`, and `bytes` rows.
`oliphaunt-resources --list-extensions --extension-index <index.toml>
--extension-target <target>` lists built-in plus signed external exact
extension availability without downloading artifacts or building source.
`oliphaunt-extension-index --output
vendor/oliphaunt-extensions.toml --target macos-arm64 --artifact
vendor/acme_ext-macos-arm64.tar.zst --base-url
https://cdn.example.com/oliphaunt/extensions/macos-arm64
--signing-key-file acme-release-2026q2:keys/acme-extension-index.ed25519`
writes that index from validated artifact archives and signs the exact index
bytes into `<index>.sig`. `oliphaunt-resources --extension acme_ext
--extension-index vendor/oliphaunt-extensions.toml --extension-target
macos-arm64 --extension-cache ~/.cache/oliphaunt/extensions
--trusted-extension-index-key-file
acme-release-2026q2:keys/acme-extension-index.ed25519.pub` verifies the signed
index, then verifies the indexed artifact and resolves transitive exact
dependencies before building the SDK runtime resources. Local sidecar artifacts
are preferred. Missing URL-backed artifacts are downloaded into the cache, then
byte-count, SHA-256, and manifest verified before use. HTTPS downloads are
behind the `extension-download` tooling feature, and signed-index verification
is behind `extension-signing`, so embedded Rust/Tauri apps do not compile
HTTP/TLS or signing code just because they use the SDK library.

Mobile static registries are intentionally marked per generated resource
package. SQL-only extensions do not need static registration. Module-backed
extensions remain `pending` until the selected extension has an Oliphaunt
prebuilt mobile artifact and the platform package declares its exact module
stem.
Runtime resources also record package-level `mobileStaticRegistryState` metadata;
use `oliphaunt-resources --require-mobile-static-registry` for iOS/Android
release packaging. Platform package builds that actually link static extension
registry rows declare exact module stems with `--mobile-static-module <stem>`;
unknown, unselected, or non-mobile-ready stems are rejected. Complete mobile
packages also emit
`static-registry/oliphaunt_static_registry.c`, generated from selected
extension SQL assets, copied selected third-party archives under
`static-registry/archives`, plus `mobileStaticRegistrySource` in the runtime
manifest. Swift/Kotlin/React Native bridges register that generated table before
`oliphaunt_init`. Selected extension preload requirements are recorded as
`sharedPreloadLibraries` in the generated runtime manifest.

The runtime-resource CLI only accepts exact release-ready extension names. External
candidate metadata, such as pgGraph and ParadeDB, remains internal until the
extension has pinned artifacts, redistribution clearance, and direct, broker,
server, restart, backup, restore, and mobile static-registry evidence.

## Backup

`BackupRequest::physical_archive()` is the same-version clone/export path for
native roots. Direct and server mode enter PostgreSQL backup mode with
`pg_backup_start`, archive the `pgdata` tree, then write PostgreSQL's generated
`backup_label` and `tablespace_map` from `pg_backup_stop` into the archive. WAL
is collected after `pg_backup_stop`, making the archive self-contained for
same-version restore. Broker mode forwards the same operation through its helper
process.

`Oliphaunt::restore(RestoreRequest::physical_archive(...))` restores those
physical archives through the SDK instead of exposing tar layout details to
applications. Restore is staged in a sibling directory, rejects path traversal
and unsafe archive entries, extracts only through validated canonical archive
paths, validates archive tree shape before writing staging files, validates the
required `pgdata` recovery files, and refuses to overwrite an existing root
unless the request uses `replace_existing()`. Physical
archives are deliberately concrete and
single-root: they contain only regular files and directories under `pgdata`, so
links, device nodes, FIFOs, sockets, sparse/special tar records, and external
tablespace indirection fail instead of producing a non-portable mobile/Desktop
artifact.

`BackupRequest::sql()` is available in `NativeServer`, where the SDK can run the
packaged `pg_dump` against the real local server connection string. Direct mode
does not fake a logical dump path because it intentionally exposes one raw
embedded protocol session, not a general server endpoint.

<!-- liboliphaunt-doc-example:rust-backup-restore -->
```rust
use oliphaunt::{BackupRequest, Oliphaunt, RestoreRequest};

# async fn backup_restore() -> oliphaunt::Result<()> {
let source = Oliphaunt::builder()
    .path(".liboliphaunt-source")
    .native_direct()
    .open()
    .await?;

let archive = source.backup(BackupRequest::physical_archive()).await?;
source.close().await?;

Oliphaunt::restore(RestoreRequest::physical_archive(
    ".liboliphaunt-restored",
    archive,
))
.await?;
# Ok(())
# }
```

## Capability Honesty

Direct mode is a serialized single physical PostgreSQL session. Broker mode is
process-isolated but still serializes one physical backend session per opened
root. Server mode is the only mode that advertises independent sessions.
`Oliphaunt` is cloneable as an SDK handle, but every clone shares the same owner
executor, session pin, cancellation handle, and close state. Cloning a handle
never creates an independent PostgreSQL connection; in `NativeServer`, true
independent sessions come from the exposed connection string and normal
PostgreSQL clients. Work accepted by the shared executor runs FIFO on that
single owner, so cloned handles do not interleave direct, broker, or SDK-owned
server protocol calls inside one physical session.

`NativeDirect` advertises `protocol_stream` when the loaded C ABI exports
`oliphaunt_exec_protocol_stream`. `NativeBroker` forwards those native chunks over
IPC and also advertises streaming. `NativeServer` streams complete PostgreSQL
wire frames from the local server connection.

All three modes expose `Oliphaunt::cancel()` for the SDK-owned active query.
Direct mode calls the native C ABI cancellation hook, broker mode uses a
separate authenticated cancel IPC endpoint, and server mode sends PostgreSQL's
native CancelRequest packet.

`Oliphaunt::close()` rejects queued work with `EngineStopped`. For native direct it
logically detaches the SDK handle and keeps the resident PostgreSQL backend
alive for same-root reopen; terminal PostgreSQL shutdown is not part of ordinary
SDK close.

<!-- liboliphaunt-doc-example:rust-basic-query -->
```rust
use oliphaunt::Oliphaunt;

# async fn demo() -> oliphaunt::Result<()> {
let db = Oliphaunt::builder()
    .path(".oliphaunt")
    .native_direct()
    .open()
    .await?;

let result = db.query("SELECT 1::text AS value").await?;
assert_eq!(result.get_text(0, "value")?, Some("1"));

let parameterized = db
    .query_params(
        "SELECT ($1::int4 + $2::int4)::text AS sum",
        [1_i32, 41_i32],
    )
    .await?;
assert_eq!(parameterized.get_text(0, "sum")?, Some("42"));

db.execute("CREATE TABLE items(id bigint PRIMARY KEY)").await?;

db.with_transaction(async |tx| {
    tx.query_params("INSERT INTO items VALUES ($1)", [1_i64])
        .await?;
    Ok(())
})
.await?;

db.close().await?;
# Ok(())
# }
```
