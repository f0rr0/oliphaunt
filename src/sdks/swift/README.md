# Oliphaunt Swift SDK

## Install

Add Oliphaunt from Swift Package Manager:

```text
dependencies: [
    .package(url: "https://github.com/f0rr0/oliphaunt.git", exact: "0.6.0")
]
```

Then add the `Oliphaunt` product to the iOS or macOS app target. Release tags
are source tags for the Swift API and are paired with compatible
`liboliphaunt-native-v<version>` GitHub release assets, for example
`liboliphaunt-native-v0.1.0`. Those assets contain the base Apple XCFramework,
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
a resource-only product containing `share/icu`; `Oliphaunt` discovers that
bundle resource at runtime. Do not add `OliphauntICU` for applications that do
not use ICU collations.

Optional PostgreSQL extensions are release-owned exact-extension artifacts. The
PostgreSQL 18 contrib members share the `oliphaunt-extension-contrib-pg18`
release product, while external projects such as `vector` keep independent
`oliphaunt-extension-vector` versions. The base
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
carrier from every release product that owns a selected or mandatory dependency
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

Each exact-extension release publishes its own checksum-covered
`<release-product>-<version>-swift-extension-carrier.json` GitHub release asset.
This applies whether the extension release predates or follows the Swift source
tag. Compose the asset with the embedded base using the repeatable
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
cache; `--allow-file-urls` exists only for local CI fixtures. The older
`--input oliphaunt-swiftpm-extension-input-v1` form remains available for
advanced tooling, but consumers do not need to hand-author that intermediate
schema. That input explicitly pins `nativeRuntime.product` and
`nativeRuntime.version`; generation requires every extracted resource manifest
to carry the same stable `liboliphaunt-native` identity. Native carrier rows
include an extension XCFramework plus exact dependency XCFramework roles and
build-derived registration symbols. SQL-only rows such as `pgtap` carry runtime
resources without a fake binary target.

The generator copies only `files/share/postgresql` from each resource artifact;
native libraries and build archives cannot enter a Swift resource bundle. Each
generated product registers its `Bundle.module` fragment before database open.
`OliphauntRuntimeResources` resolves mandatory dependencies and atomically
composes the extension-free base with exactly those registered fragments into a
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
| `Oliphaunt` `0.6.0` | `liboliphaunt` `0.1.0` | SwiftPM source tag plus checksum-covered GitHub release assets |

Exact extensions are selected by PostgreSQL SQL extension name and released as
separate exact-extension artifacts. Selecting `vector` must only fetch/link
`vector` artifacts and mandatory manifest dependencies; unselected extension
XCFrameworks and runtime files must not enter the app bundle.

## Quickstart

<!-- liboliphaunt-doc-example:swift-open-exec-close -->
```swift
let db = try await OliphauntDatabase.open(
    configuration: OliphauntConfiguration(
        mode: .nativeDirect,
        runtimeFootprint: .balancedMobile,
        startupGUCs: [
            OliphauntStartupGUC("shared_buffers", "32MB")
        ],
        username: "postgres",
        database: "postgres"
    )
)
let response = try await db.execProtocolRaw(simpleQueryBytes)
try await db.close()
```

Swift package for iOS and macOS apps on the native `liboliphaunt` product line.

The public API is actor-based and mirrors the Rust SDK shape: open a database,
execute raw PostgreSQL protocol bytes, inspect capabilities, create SQL or
physical backup artifacts, restore same-version physical archives into an
explicit root, run transaction closures on the active physical session, request
PostgreSQL checkpoints, configure startup `username`/`database` identity,
cancel active work, and close. The package includes
`OliphauntNativeDirectEngine`, a C-ABI-backed native direct runtime that loads
`liboliphaunt` dynamically or resolves already-linked symbols. `OliphauntDatabase`
uses that native-direct engine by default for `.nativeDirect`; broker and server
still fail explicitly until those Swift runtimes are linked.
Use `OliphauntDatabase.supportedModes()` to discover that support before opening a
database; the returned entries include canonical direct/broker/server
capabilities and the reason unavailable modes are not currently openable.
Capabilities report the same product contract as Rust: raw and streaming
protocol support, cancellation, backup/restore, simple-query execution,
extensions, session semantics, multi-root support, and the concrete backup/restore formats
the opened mode accepts. Use `supportsBackupFormat(_:)` and
`supportsRestoreFormat(_:)` on either `OliphauntCapabilities` or `OliphauntDatabase`
for UI/action gating instead of manually matching arrays. `backup(_:)` enforces
those capabilities before it calls the native session, and
`OliphauntDatabase.restore` rejects unsupported restore artifact formats before it
calls the engine. Lifecycle capability fields follow the Rust contract:
`sameRootLogicalReopen`, `rootSwitchable`, and `crashRestartable` distinguish
direct's same-root resident reopen from broker/server process-managed behavior.
Native direct is not root-switchable or crash-restartable. Mobile direct mode
has one resident backend per app process and one physical session. Use server
mode only where the SDK reports true server support; it is not a
crash-isolated server and it does not provide independent concurrent client
sessions.

Swift defaults to the mobile resident profile: `runtimeFootprint:
.balancedMobile` and `durability: .balanced`. Use `.safe` when last-commit
survival matters more than commit latency, `.throughput` for throughput-lane
diagnostics, or `.smallMobile` for memory-pressure experiments. `startupGUCs`
are validated and appended after the footprint and durability defaults so
profiling builds can override specific PostgreSQL GUCs without changing the
public ABI.

For large responses or COPY-style traffic, stream backend protocol bytes through
the C ABI instead of materializing one owned response first:

<!-- liboliphaunt-doc-example:swift-streaming -->
```swift
try await db.execProtocolStream(simpleQueryBytes) { chunk in
    consume(chunk)
}
```

For ordinary one-result-set SQL, use the typed simple-query helper:

<!-- liboliphaunt-doc-example:swift-typed-query -->
```swift
let result = try await db.query("SELECT 1::text AS value")
let value = try result.getText(row: 0, column: "value")
```

`query(_:)` parses normal PostgreSQL backend protocol frames into field
metadata, rows, command tags, nulls, and structured PostgreSQL errors through
`OliphauntError.postgres(OliphauntPostgresError)`, preserving SQLSTATE and raw
`ErrorResponse` fields. Multi-result-set and COPY traffic stay on
`execProtocolRaw`.
Pass `parameters:` for PostgreSQL extended-protocol parameters:

Use `transaction {}` for multi-step work that must stay on the same physical
session. Database calls outside the active `OliphauntTransaction` are rejected
until the transaction commits or rolls back.
Use `checkpoint()` to request a PostgreSQL checkpoint through the same actor
session; it is rejected while a transaction is active.

<!-- liboliphaunt-doc-example:swift-parameterized-query -->
```swift
let result = try await db.query(
    "SELECT $1::text AS value",
    parameters: [.text("hello")]
)
```

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

The native-direct env-backed test opens a temporary root, executes `SELECT 1`
through raw and streaming PostgreSQL protocol bytes, cancels an active
`pg_sleep`, creates a
same-version physical backup through the C ABI, restores it into a new root, and
closes the runtime. Exact extensions are accepted when
`OliphauntNativeDirectEngine` is constructed with a `runtimeDirectory` built with
those extensions, or with `OliphauntRuntimeResources` pointing at packaged runtime
resources whose manifest lists the requested extensions. Extension names are validated
before loading native code.

For iOS and app-bundled macOS builds, package resources using this layout and
construct the engine with `OliphauntRuntimeResources(bundle:)` or
`OliphauntRuntimeResources(resourceRoot:)`:

```text
oliphaunt/
  runtime/
    manifest.properties
    files/
  template-pgdata/
    manifest.properties
    files/
      PG_VERSION
```

Release automation publishes `liboliphaunt-<version>-runtime-resources.tar.gz`
with that layout and covers it in
`liboliphaunt-<version>-release-assets.sha256`. App integrations should consume
that artifact through the SwiftPM/RN package integration or through a clean
release asset resolver, never by asking app developers to build PostgreSQL from
this repository.
`runtime/manifest.properties` must include
`schema=oliphaunt-runtime-resources-v1`,
`layout=postgres-runtime-files-v1`, `cacheKey=<portable-id>`, and
two distinct extension domains. `selectedExtensions` is the complete,
dependency-closed set of packaged SQL identities, including module-only
products such as `auto_explain`. `extensions` is exactly the subset whose
catalog rows support `CREATE EXTENSION`; it must be a subset of
`selectedExtensions`. Runtime availability and requested-extension checks use
`selectedExtensions`, while control/install-SQL checks apply only to requested
members of `extensions`. New producers must always write both fields. The SDK
reads `extensions` as the full selection only for a legacy manifest in which
`selectedExtensions` is absent; an explicitly empty `selectedExtensions` never
falls back.

`template-pgdata` manifests must use
`layout=postgres-template-pgdata-v1`. Current packages also record
`sharedPreloadLibraries`, `mobileStaticRegistryState`,
`mobileStaticRegistryPending`, `mobileStaticRegistryRegistered`, and
`nativeModuleStems`. `mobileStaticRegistryRegistered` is exactly the selected
SQL-name subset that has native modules, and `nativeModuleStems` is the
corresponding exact native-module-stem set; neither may claim an unselected SQL
identity. iOS-family targets reject selected extensions while the registry
state is `pending`. The Swift SDK rejects unknown package layouts, materializes
runtime files into Application Support using the cache key, and hydrates new
PGDATA roots from `template-pgdata/files`.
Apple mobile platforms require either a packaged template PGDATA or an existing
root with `PG_VERSION`; they do not rely on executing `initdb` from app storage.
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
The resource root also includes `package-size.tsv`; call
`OliphauntRuntimeResources.packageSizeReport()` to inspect total package bytes,
runtime/template/static-registry bytes, de-duplicated selected extension bytes,
and per-extension footprints before shipping an app bundle.

Broker and server engines still follow the Rust SDK shape and fail explicitly
until those Swift runtimes are linked.
