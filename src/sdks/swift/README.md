# Oliphaunt Swift SDK

## Install

Add Oliphaunt from Swift Package Manager:

```text
dependencies: [
    .package(url: "https://github.com/f0rr0/oliphaunt.git", exact: "0.6.1")
]
```

Then add the `Oliphaunt` product to the iOS or macOS app target. Release tags
are source tags for the Swift API and are paired with compatible
`liboliphaunt-native-v<version>` GitHub release assets, for example
`liboliphaunt-native-v0.1.1`. Those assets contain the base Apple XCFramework,
portable runtime resources, and checksum manifest.
CocoaPods trunk is not a release path for Oliphaunt. The SwiftPM release tag
resolves a generated manifest with a checksum-pinned `liboliphaunt` binary
target; the SDK auto-discovers the bundled runtime resources from that framework
for ordinary native-direct opens.
Normal iOS and macOS app consumers do not install Rust, run Cargo, build
PostgreSQL, or copy local Oliphaunt artifacts. SwiftPM resolves the Swift API
and checksum-pinned binary/runtime assets for the selected release.

Base Apple packages do not include full ICU data. Applications that need
PostgreSQL ICU collations add the `OliphauntICU` SwiftPM product to the same app
target as `Oliphaunt`. The generated release manifest exposes `OliphauntICU` as
a resource-only product containing the canonical ICU data. The target runtime
resources carry the matching platform-qualified cluster seed, and `Oliphaunt`
resolves the pair as one checked closure. Do not add `OliphauntICU` for
applications that do not use ICU collations.

Optional PostgreSQL extensions are exact-extension artifacts. PostgreSQL 18
contrib members share the logical `oliphaunt-extension-contrib-pg18` artifact;
its native carrier uses the `liboliphaunt-native` release and version. External
projects such as `vector` keep independent `oliphaunt-extension-vector`
releases. The base
Swift package does not publish hidden extension products or bundle unselected
extension files. Swift and React Native iOS integrations resolve selected SQL
names and their dependency closure from the checksum-bound JSON carrier
manifest. Each exact-extension release also carries a strict
`manifest.properties` metadata index for auditing and non-Swift tooling; it is
not a second remote-asset resolver.

The SDK-owned SwiftPM integration generator starts from the selection-neutral
carrier embedded in the Swift source tag and composes independently versioned
extension release carriers. Given explicit SQL extension names, it resolves the
mandatory dependency closure, downloads into a content-addressed cache, verifies
byte sizes and SHA-256 checksums, safely extracts only runtime resources, and
emits a standalone consumer-owned local package with checksum-pinned binary
targets, C descriptors that strongly reference built symbols,
dependency-ordered Swift wrappers, and sanitized resource targets. Download one
carrier from every release owner that supplies a selected or mandatory dependency
extension, then pass each carrier explicitly:

```bash
CONTRIB_CARRIER=/path/to/oliphaunt-extension-contrib-pg18-X.Y.Z-swift-extension-carrier.json
POSTGIS_CARRIER=/path/to/oliphaunt-extension-postgis-X.Y.Z-swift-extension-carrier.json
PGTAP_CARRIER=/path/to/oliphaunt-extension-pgtap-X.Y.Z-swift-extension-carrier.json

node src/sdks/swift/tools/render-extension-products.mjs \
  --extension-carrier "$CONTRIB_CARRIER" \
  --extension-carrier "$POSTGIS_CARRIER" \
  --extension-carrier "$PGTAP_CARRIER" \
  --extensions cube,postgis,pgtap \
  --output-dir /path/to/package/generated/swiftpm/extensions
```

The output path is a create-only completion transaction. The generator builds a
private sibling staging tree, verifies every materialized resource and local
XCFramework against a no-symlink file-and-directory inventory with SHA-256 for
every file, then
claims the still-absent output with an exclusive directory creation. It moves
`Package.swift` and the completion marker only after the package contents, so a
claimed directory without that marker is incomplete. It never replaces or
deletes an existing output, even an empty one or one with an earlier generator
marker; callers that intentionally regenerate must remove their known
destination before invoking it again. A generation failure retains private
staging for explicit caller cleanup, and a process crash during the final
multi-entry publication can retain a claimed incomplete output. The generator
never recursively removes either path.

The input, staging parent, and output must be in a caller-controlled workspace
that is not concurrently mutated by another process running as the same OS
user. The command rejects symlink outputs, outputs that would contain its
checkout or carrier inputs, and any overlap in either direction with its cache,
base package, local XCFrameworks, or extension-resource roots.

Every generated SwiftPM release source tag contains a schema-valid,
selection-neutral carrier at
`src/sdks/swift/Carriers/oliphaunt-react-native-ios-carriers.json`. It pins only
the compatible `liboliphaunt-native` base assets; its `carriers` and
`extensions` arrays are empty. The generator uses that checksum-locked,
Git-tree-addressed base carrier by default, so a pure Swift consumer does not
install the React Native npm package. The Swift source tag never snapshots or
changes the version of an optional extension. A local `--carrier
/path/to/...json` base override is available for release validation and advanced
tooling, but it is not how consumers select extensions.

Each exact-extension artifact publishes a checksum-covered
`<artifact-product>-<version>-swift-extension-carrier.json` asset on its release
owner's `<release-product>-v<version>` GitHub tag. This applies whether the
carrier predates or follows the Swift source tag. Compose the asset with the embedded base using the repeatable
`--extension-carrier` option:

```bash
node src/sdks/swift/tools/render-extension-products.mjs \
  --extension-carrier /path/to/oliphaunt-extension-vector-0.2.0-swift-extension-carrier.json \
  --extensions vector \
  --output-dir /path/to/package/generated/swiftpm/vector
```

One contrib bundle carrier supplies all 32 contrib rows; only the requested SQL
names and their mandatory dependencies enter the generated package. Multiple
external carrier files may be composed in the same command. Every carrier pins
its owning release, compatible `liboliphaunt-native` release, member-specific
asset checksums, and direct extension dependency releases. A mismatched base,
missing or version-skewed dependency, duplicate SQL row, unused carrier file,
or conflicting native dependency asset stops generation before output.

Normal use accepts HTTPS assets only. `--offline` requires a complete verified
cache; `--allow-file-urls` exists only for local CI fixtures. Carrier resolution
pins `nativeRuntime.product` and `nativeRuntime.version`; generation requires
every extracted resource manifest to carry the same stable
`liboliphaunt-native` identity. Native carrier rows
include an extension XCFramework plus exact dependency XCFramework roles and
build-derived registration symbols. SQL-only rows such as `pgtap` carry runtime
resources without a fake binary target.

The generator copies only `files/share/postgresql` from each resource artifact;
native libraries and build archives cannot enter a Swift resource bundle. Each
generated product registers its `Bundle.module` fragment before database open.
Oliphaunt's internal resource loader resolves mandatory dependencies and
atomically composes the extension-free base with exactly those registered fragments into a
deterministic cache entry. It regenerates runtime, static-registry, and size
metadata, rejects conflicting paths, and supports multiple independent native
extensions plus SQL-only extensions. Consumers add the generated product and
call its `register()` method before opening a database that requests that SQL
extension. The application adds the generated directory as a local Swift
package and depends on the generated products it selected. The published base
Oliphaunt package remains extension-free; exact-extension releases remain
checksum-covered GitHub carrier assets rather than pretending
to be separately published Swift packages. `extension-products.json` records
the complete frozen selection. Missing dependency rows, resources, symbols,
base products, or carrier assets fail generation.

React Native iOS uses this Swift SDK through the npm package and its config
plugin. It does not carry a second native database runtime.

## Compatibility

| SDK | Native core | Apple distribution |
| --- | --- | --- |
| `Oliphaunt` `0.6.1` | `liboliphaunt` `0.1.1` | SwiftPM source tag plus checksum-covered GitHub release assets |

Exact extensions are selected by PostgreSQL SQL extension name and released as
separate exact-extension artifacts. Selecting `vector` must only fetch/link
`vector` artifacts and mandatory manifest dependencies; unselected extension
XCFrameworks and runtime files must not enter the app bundle.

## Quickstart

<!-- liboliphaunt-doc-example:swift-open-exec-close -->
```swift
let db = try await OliphauntDatabase.open(
    configuration: OliphauntConfiguration(
        storage: .directory(applicationDatabaseURL),
        startupGUCs: [
            OliphauntStartupGUC("shared_buffers", "32MB")
        ],
        username: "postgres",
        database: "postgres"
    )
)
let rows = try await db.query(
    "SELECT name FROM widgets WHERE id = $1",
    parameters: [.int64(42)]
)
let name: String? = try rows.rows[0].value(named: "name")

let command = try await db.execute(
    "UPDATE widgets SET active = $1 WHERE id = $2",
    parameters: [.bool(true), .int64(42)]
)
print(command.commandTag ?? "")
print(command.rowCount as Any)
try await db.close()
```

`username` selects an existing PostgreSQL role. New roots are always
bootstrapped with `postgres`; create another role from that account before
reopening the root with a different username.

Swift package for iOS and macOS apps on the native `liboliphaunt` product line.

The public API is actor-based and deliberately small. `query` executes one
statement and returns ordered raw cells plus field metadata, command metadata,
and typed row access through `OliphauntPostgresDecodable`. `execute` is the
stricter one-statement, no-rows assertion. `exec` uses the simple-query protocol
for ordered multi-statement command-or-rows results, while `describe` resolves
parameter OIDs and optional result fields without executing. Results preserve
ordered notices; SQL errors preserve the same PostgreSQL diagnostic fields and
notices.

Parameters carry an optional `OliphauntPostgresOID`, text or binary format, and
nullable owned bytes. Common factories such as `.bool`, `.int32`, `.int64`,
`.string`, `.bytes`, and `.uuid` publish the correct OID; use `.typedNull(.uuid)`
for an ambiguous null, or explicit `.text`/`.binary` with a custom OID for an
extension type. Omit `typeOID` to request PostgreSQL parameter inference;
explicit parameter OID `0` is rejected so omission cannot be confused with a
caller-supplied type. Typed getters validate the field OID and format before
decoding; `row.raw(_:)` remains the lossless fallback.

The database also provides callback-scoped transactions, `cancel`, physical
`backup` and `restore`, raw PostgreSQL protocol execution,
and idempotent `close`. `isClosed` becomes true only after a successful close.
Raw protocol execution remains available for PostgreSQL features without a
typed API. `execProtocolRaw` returns one owned response, while
`execProtocolRawStream` delivers raw backend protocol chunks to a callback without
buffering the complete response. The callback is a synchronous backpressure
boundary: same-database and transaction work is rejected from its scope, with
`cancel()` as the sole out-of-band exception. Neither API adds a second protocol
parser. Callback failures are surfaced only after the native runtime confirms
protocol recovery, so the session remains reusable. A buffered or streaming
transport or recovery failure is authoritative and poisons the database; close
it instead of assuming a later operation can recover the physical session.

These APIs are genuinely asynchronous for the caller even though embedded
PostgreSQL is blocking internally. A dedicated serial owner queue performs root
preparation, open, protocol calls, backup, and close; those operations never run
on the main actor. Ordinary work, `BEGIN`, transaction settlement, and close
share FIFO admission. A transaction or close establishes an atomic cutoff:
operations admitted before it drain first, while later incompatible calls are
rejected. `cancel()` uses a separate control queue so it can interrupt the active
call instead of waiting behind it. It remains available while an admitted close
is draining earlier FIFO work and becomes unavailable when native teardown
starts. Cancelling a Swift task does not implicitly
cancel PostgreSQL; call `cancel()` when an interrupt is intended.

Transactions use one physical session and expose `query`, `execute`, `exec`,
and `describe`; raw protocol execution stays on the database because it owns
transaction lifecycle explicitly. `rollback()` is one-shot: it closes the
transaction, lets the callback return a value, and suppresses `COMMIT`; returning
normally commits. Do not issue outer-lifecycle SQL such as `BEGIN`/`START
TRANSACTION`, `COMMIT`/`END`, a full `ROLLBACK`/`ABORT` (with or without
`AND [NO] CHAIN`), or `PREPARE TRANSACTION` inside a managed callback. Use
`SAVEPOINT`, `RELEASE SAVEPOINT`, and `ROLLBACK TO SAVEPOINT` for nested work.
PostgreSQL reports both `ROLLBACK TO` and `ROLLBACK AND CHAIN` as `ROLLBACK`
with `ReadyForQuery=T`, so the SDK rejects `ROLLBACK`/`ABORT ... AND CHAIN`
before dispatch and still validates every actual protocol boundary. A detected
lifecycle command, escaped idle session, failed rollback, or uncertain commit
makes the database close-only; close it before reopening.
If a callback catches such a poisoning database or rollback error and returns,
the transaction still fails with the stored original error; an unsafe session
cannot be converted into success by swallowing the error.
After a successful automatic rollback, the original callback error is rethrown.
When the callback and rollback both fail,
`OliphauntTransactionRollbackError` retains them in its public `callbackError`
and `rollbackError` fields. If an earlier independent database or protocol
failure has already poisoned or expired transaction ownership and the callback
then throws a different error, `OliphauntTransactionDatabaseError` retains the
two errors in its public `callbackError` and `databaseError` fields; the database
is close-only. An ordinary PostgreSQL statement error that remains safely
rollbackable is not automatically wrapped in either composite error.

`startupGUCs` are passed directly as PostgreSQL `-c name=value` arguments.
There are no SDK-specific durability, memory, or runtime profiles.

Database storage is optional in the common case. The default,
`.temporaryDirectory`, uses an SDK-owned directory below the operating system's
temporary location. Native direct keeps that directory for its process-resident
database so a logical close can be reopened safely; it is not durable storage
and may be reclaimed after the process exits. Select persistence explicitly
with `storage: .directory(applicationDatabaseURL)`. `close()` never deletes a
directory supplied by the application.

Use `transaction {}` for multi-step work that must stay on the same physical
session. Database calls outside the active `OliphauntTransaction` are rejected
until the transaction commits or rolls back.
Use `execute("CHECKPOINT")` when an explicit PostgreSQL checkpoint is required;
like other database operations, it is rejected while a transaction is active.

<!-- liboliphaunt-doc-example:swift-parameterized-query -->
```swift
let result = try await db.query(
    "SELECT $1::text AS value, $2::uuid AS optional_id",
    parameters: [.string("hello"), .typedNull(.uuid)]
)
```

## Physical backup and storage

`backup()` returns the native physical archive as `Data`. Restore accepts those
bytes and a new destination; it never replaces an existing database root.

<!-- liboliphaunt-doc-example:swift-backup-restore -->
```swift
let bytes = try await db.backup()
try await db.close()
try await OliphauntDatabase.restore(destination: restoredDatabaseURL, bytes: bytes)
```

A persistent database directory is a managed root:

```text
.oliphaunt.json
pgdata/
```

The descriptor is published only after a packaged cluster seed or packaged `initdb`
has produced complete PGDATA. Existing managed roots must contain PostgreSQL 18 `PG_VERSION`, `global/pg_control`, and
`pg_wal`. A pre-existing nonempty directory without the descriptor is rejected
without modification. Physical archives contain PGDATA and the exact physical
backup manifest. Restore creates the receiving root descriptor after validating
the extracted PGDATA.

## Local Development

For local contributor tests from this repository:

```bash
cd src/sdks/swift
swift test
```

To run the native C ABI smoke from Swift:

```bash
LIBOLIPHAUNT_PATH=/path/to/liboliphaunt.dylib \
OLIPHAUNT_INSTALL_DIR=/path/to/postgres/install \
swift test
```

The native-direct env-backed test opens temporary storage, executes `SELECT 1`
through PostgreSQL protocol bytes, cancels an active
`pg_sleep`, creates a
same-version physical backup through the C ABI, restores it into a new destination, and
closes the runtime. Exact extensions are accepted when the app links their
generated SwiftPM products and calls each product's `register()` method before
opening the database. Extension names are validated before loading native code.

For iOS and app-bundled macOS builds, generated products package resources using
this layout; the SDK discovers them automatically:

```text
oliphaunt/
  manifest.properties
  runtime/
    manifest.properties
    files/
  cluster-seed/
    manifest.properties
    files/
      PG_VERSION
      global/pg_control
  cluster-seed-icu/
    manifest.properties
    files/
      PG_VERSION
      global/pg_control
```

The macOS XCFramework slice embeds the `macos-arm64` closure. Both iOS slices
embed the `ios-datum64` closure. SwiftPM links exactly one platform slice, so an
application receives one target-qualified closure. React Native uses the separate
`liboliphaunt-<version>-runtime-resources-ios-datum64.tar.gz` carrier when it
composes its app-owned resource bundle; there is no generic or multi-target
runtime-resource archive.

The root receipt binds the closure to one seed target and the two sibling seed
paths. Both seed manifests use the exact native cluster-seed contract; extension
selection and static-registry metadata belong only to the runtime manifest.
`runtime/manifest.properties` must include
`schema=oliphaunt-runtime-resources-v1`,
`layout=postgres-runtime-files-v1`, `mode=native-direct`,
`cacheKey=<portable-id>`, and
two distinct extension domains. `selectedExtensions` is the complete,
dependency-closed set of packaged SQL identities, including module-only
products such as `auto_explain`. `extensions` is exactly the subset whose
catalog rows support `CREATE EXTENSION`; it must be a subset of
`selectedExtensions`. Runtime availability and requested-extension checks use
`selectedExtensions`, while control/install-SQL checks apply only to requested
members of `extensions`. Producers must always write both fields. The SDK
rejects a missing `selectedExtensions`; an explicitly empty value means that
no extensions were selected.
The runtime manifest uses an exact field set. When
`mobileStaticRegistryState=complete`, `mobileStaticRegistrySource` is exactly
`static-registry/oliphaunt_static_registry.c` for packaged generator output or
`swiftpm-linked-products` for SwiftPM product composition; it is empty for all
other registry states.

The Swift SDK rejects unknown package layouts, materializes runtime files into
Application Support using the cache key, and hydrates a new standard or ICU
PGDATA root from its matching target-qualified cluster seed. iOS-family targets
reject selected extensions while the runtime static-registry state is
`pending`.
Apple mobile platforms require either a packaged cluster seed or existing
storage whose `pgdata` child contains `PG_VERSION`; they do not rely on executing `initdb` from app storage.
When a selected extension contains native modules, the Swift package must
link those modules with the generated static-registry source. Complete Rust
runtime-resource generator output includes
`static-registry/oliphaunt_static_registry.c`; the Swift C bridge discovers
`liboliphaunt_selected_static_extensions` and registers the returned rows
through `oliphaunt_register_static_extensions` before the first database open.
The manifest state is a release gate, not a loader substitute.
For release builds with exact prebuilt mobile archives, use
`render-extension-products.mjs` and its checksum-bound carrier inputs described
above. It is the single resolver for contrib bundles and independently versioned
external extensions: it selects the SQL dependency closure, runtime resources,
primary XCFrameworks, and identity-qualified dependency XCFrameworks before it
writes the consumer-owned SwiftPM package. The release `.properties` files are
strict metadata indexes for auditing and non-Swift tooling; the runtime SDK does
not maintain a second, weaker remote-asset resolver. Optional extension and
dependency XCFrameworks therefore never enter the generated package unless the
app selected their exact PostgreSQL extension name.
The generated registry source strongly references selected extension magic and
SQL symbols. If an app selects `vector` but omits the matching prebuilt
`liboliphaunt_extension_vector.xcframework`, the build should fail rather than
shipping an app that fails later at `CREATE EXTENSION vector`.
The generated resource root also includes `package-size.tsv` for release and
bundle-size auditing.
