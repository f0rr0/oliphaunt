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

Optional PostgreSQL extensions are separate exact-extension release artifacts,
for example `oliphaunt-extension-vector` for `CREATE EXTENSION vector`. The base
Swift package does not publish hidden extension products or bundle unselected
extension files. Each exact-extension release artifact carries a
`manifest.properties` file that lists assets by `family`, `target`, and `kind`
so Swift and React Native iOS integrations can resolve only the matching
`ios-xcframework` or desktop runtime assets for the SQL extension names the app
requested and their manifest dependencies.

The SDK-owned SwiftPM integration generator consumes the same canonical,
release-produced carrier manifest as React Native. Given explicit SQL extension
names, it resolves the mandatory dependency closure, downloads into a
content-addressed cache, verifies byte sizes and SHA-256 checksums, safely
extracts only runtime resources, and emits a standalone consumer-owned local
package with checksum-pinned binary targets, C descriptors that strongly
reference built symbols, dependency-ordered Swift wrappers, and sanitized
resource targets:

```bash
node src/sdks/swift/tools/render-extension-products.mjs \
  --extensions cube,postgis,pgtap \
  --output-dir /path/to/package/generated/swiftpm/extensions
```

Every generated SwiftPM release source tag contains the exact aggregate carrier
at `src/sdks/swift/Carriers/oliphaunt-react-native-ios-carriers.json`. The
generator uses that checksum-locked, Git-tree-addressed file by default, so a
pure Swift consumer does not install the React Native npm package. A local
`--carrier /path/to/...json` override is available for release validation and
advanced tooling.

Normal use accepts HTTPS assets only. `--offline` requires a complete verified
cache; `--allow-file-urls` exists only for local CI fixtures. The older
`--input oliphaunt-swiftpm-extension-input-v1` form remains available for
advanced tooling, but consumers do not need to hand-author that intermediate
schema. Native carrier rows include an extension XCFramework plus exact
dependency XCFramework roles and build-derived registration symbols. SQL-only
rows such as `pgtap` carry runtime resources without a fake binary target.

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
Oliphaunt package remains extension-free; independently versioned extension
releases remain checksum-covered GitHub carrier assets rather than pretending
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
`extensions=<comma-separated-extension-names>`. `template-pgdata` manifests must
use `layout=postgres-template-pgdata-v1`. Current packages also record
`sharedPreloadLibraries`,
`mobileStaticRegistryState`, and `mobileStaticRegistryPending`; iOS-family
targets reject selected extensions while that state is `pending`. The Swift SDK
rejects unknown package layouts, materializes runtime
files into Application Support using the cache key, and hydrates new PGDATA
roots from `template-pgdata/files`.
Apple mobile platforms require either a packaged template PGDATA or an existing
root with `PG_VERSION`; they do not rely on executing `initdb` from app storage.
When a selected extension contains native modules, the Swift package must
link those modules with the generated static-registry source. Complete Rust
runtime-resource generator output includes `static-registry/oliphaunt_static_registry.c`; the
Swift C bridge discovers `liboliphaunt_selected_static_extensions` and registers
the returned rows through `oliphaunt_register_static_extensions` before the first
database open. The manifest state is a release gate, not a loader substitute.
For release builds with exact prebuilt mobile archives, select SQL extension
names in the app integration. `OliphauntExtensionArtifactResolver` resolves the
exact release asset names for the selected SQL extension names, their manifest
dependencies, and the requested native target. The app package integration then
fetches or bundles only those resolved artifacts from the extension release:
`liboliphaunt_extension_<stem>.xcframework`, any selected
`liboliphaunt_dependency_<name>.xcframework` dependencies carried by that
extension artifact, and the matching runtime manifest. Optional extension and
dependency XCFrameworks are not fetched, bundled, or linked unless the app
selected their exact PostgreSQL extension name.
The resolver fetches only those extension XCFrameworks and runtime files, so
unselected extension artifacts never enter the app bundle as an implementation
side effect.
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
