# Oliphaunt Kotlin SDK

## Install

Add the Android SDK and the app-applied Oliphaunt Android plugin from Maven
Central:

```gradle
plugins {
    id("com.android.application")
    id("dev.oliphaunt.android") version "0.1.0"
}

dependencies {
    implementation("dev.oliphaunt:oliphaunt:0.1.0")
}

oliphaunt {
    extensions.add("vector")
    // Optional: androidAbis.set(listOf("arm64-v8a"))
}
```

The plugin downloads and verifies checksum-covered `liboliphaunt-native-v0.1.0`
GitHub release assets, packages `liboliphaunt.so` for selected Android ABIs,
and bundles only the selected exact extension artifacts. If the app selects
`vector`, unrelated extension files are not copied into the APK/AAB.
Normal Android app consumers use Gradle, Maven Central, and the Android
toolchain they already have. They do not install Rust, run Cargo, build
PostgreSQL, or copy Oliphaunt native artifacts by hand.

## Compatibility

| SDK | Native core | Android distribution |
| --- | --- | --- |
| `dev.oliphaunt:oliphaunt` `0.1.0` | `liboliphaunt` `0.1.0` | Maven Central SDK and `dev.oliphaunt.android` plugin plus checksum-covered GitHub release assets |

The Android release lane publishes `arm64-v8a` and `x86_64` artifacts. Apps may
restrict ABI packaging with `-PoliphauntAndroidAbiFilters=arm64-v8a` or another
comma-separated subset.

## Quickstart

<!-- liboliphaunt-doc-example:kotlin-android-open -->
```kotlin
val db = OliphauntAndroid.open(
    context = applicationContext,
    config = OliphauntConfig(
        mode = EngineMode.NativeDirect,
        runtimeFootprint = RuntimeFootprintProfile.BalancedMobile,
        startupGucs = listOf(PostgresStartupGuc("shared_buffers", "32MB")),
        username = "postgres",
        database = "postgres",
        extensions = listOf("vector"),
    ),
)
val result = db.query("SELECT 1::text AS value")
val value = result.getText(0, "value")
db.close()
```

Kotlin Multiplatform package for the native `liboliphaunt` product line.

The common API mirrors the Rust SDK shape and uses suspend functions plus a
serialized `OliphauntDatabase` handle. Raw protocol execution, capability reporting,
SQL/physical backup artifacts, transaction closures, explicit PostgreSQL
checkpoints, startup `username`/`database` identity, and same-version physical
restore all use this shared shape. JVM, Android, and Kotlin/Native implementations can share the API
while platform modules provide the actual native runtime.
Use `OliphauntDatabase.supportedModes()` to discover the current platform default,
or pass an injected engine to inspect that engine. On Android,
`OliphauntAndroid.supportedModes()` reports the same Android facade contract. The
support entries still carry canonical direct/broker/server capability semantics
so unavailable modes are explicit and not confused with direct-mode aliases.
Capabilities report the same product contract as Rust: raw and streaming
protocol support, cancellation, backup/restore, simple-query execution,
extensions, session semantics, multi-root support, and the concrete backup/restore formats
the opened mode accepts. Use `supportsBackupFormat(...)` and
`supportsRestoreFormat(...)` on either `EngineCapabilities` or `OliphauntDatabase`
for UI/action gating instead of manually matching lists. `backup(...)` enforces
those capabilities before it calls the platform session, and
`OliphauntDatabase.restore(...)` rejects unsupported restore artifact formats
before it calls the platform engine. Lifecycle capability fields follow the Rust
contract: `sameRootLogicalReopen`, `rootSwitchable`, and `crashRestartable`
distinguish direct's same-root resident reopen from broker/server
process-managed behavior. Native direct is not root-switchable or
crash-restartable. Mobile direct mode has one resident backend per app process
and one physical session. Use server mode only where the SDK reports true
server support; it is not a crash-isolated server and it does not provide
independent concurrent client sessions.

This package uses the current Kotlin Multiplatform structure: common API in
`commonMain`, Kotlin/Native cinterop metadata under `src/nativeInterop`, Android
JNI/CMake sources under `src/androidMain/cpp`, and platform runtimes layered
behind `OliphauntEngine`.

Kotlin/Native now includes a native-direct runtime over the `liboliphaunt` C ABI.
It builds a tiny static cinterop bridge that dynamically loads `liboliphaunt`,
opens one embedded PostgreSQL backend on a dedicated owner thread, serializes
handle-bound native work on that queue, and keeps `cancel()` outside that queue
so long-running SQL can be interrupted. `close()` marks the handle closed, waits
for the execution queue, and detaches the logical native session while keeping
the resident backend alive for same-root reopen.

Android includes a native-direct runtime over JNI with the same owner-thread
session model.
Native Android apps should use the Android entrypoint because it needs a
`Context` for app storage and packaged assets:

Kotlin defaults to the mobile resident profile: `runtimeFootprint =
RuntimeFootprintProfile.BalancedMobile` and `durability =
DurabilityProfile.Balanced`. Use `Safe` when last-commit survival matters more
than commit latency, `Throughput` for throughput-lane diagnostics, or
`SmallMobile` for memory-pressure experiments. `startupGucs` are validated and
appended after the footprint and durability defaults so profiling builds can
override specific PostgreSQL GUCs without changing the native ABI.

Use `database.transaction { tx -> ... }` for multi-step work that must stay on
the same physical session. Database calls outside the active `OliphauntTransaction`
are rejected until the transaction commits or rolls back.
Use `database.checkpoint()` to request a PostgreSQL checkpoint through the same
serialized session; it is rejected while a transaction is active.

Calling the common `OliphauntDatabase.open(...)` or `OliphauntDatabase.restore(...)`
defaults on Android fails with a targeted diagnostic that points to
`OliphauntAndroid.open(context, config)` or
`OliphauntAndroid.restore(context, request)`. This keeps the common API honest
without hiding Android's required `Context`.

For large responses or COPY-style traffic, use the streaming raw-protocol API so
native-direct runtimes can forward backend bytes without building a single owned
response first:

<!-- liboliphaunt-doc-example:kotlin-streaming -->
```kotlin
db.execProtocolStream(ProtocolRequest.simpleQuery("SELECT 1")) { chunk ->
    consume(chunk.bytes)
}
```

For ordinary one-result-set SQL, use the typed simple-query helper:

<!-- liboliphaunt-doc-example:kotlin-typed-query -->
```kotlin
val result = db.query("SELECT 1::text AS value")
val value = result.getText(0, "value")
```

`query(sql)` parses normal PostgreSQL backend protocol frames into field
metadata, rows, command tags, nulls, and structured PostgreSQL errors through
`PostgresException(PostgresError)`, preserving SQLSTATE and raw `ErrorResponse`
fields. Multi-result-set and COPY traffic stay on `execProtocolRaw`.
Pass a `List<QueryParam>` for PostgreSQL extended-protocol parameters:

<!-- liboliphaunt-doc-example:kotlin-parameterized-query -->
```kotlin
val result = db.query(
    "SELECT $1::text AS value",
    listOf(QueryParam.Text("hello")),
)
```

JVM keeps the shared API shape but intentionally reports an unavailable runtime;
desktop JVM apps should use the Rust/Tauri SDK path or a future server/broker
JVM binding rather than a fake direct-mode implementation.

## Local Development

On Kotlin/Native, `OliphauntDatabase.open(config)` and
`OliphauntDatabase.restore(request)` default to `NativeDirectEngine` for
`EngineMode.NativeDirect`. During local development the bridge resolves the
runtime through:

- `LIBOLIPHAUNT_PATH`: path to `liboliphaunt.dylib` or equivalent shared
  library;
- `OLIPHAUNT_INSTALL_DIR`: PostgreSQL install/runtime directory;
- `OLIPHAUNT_KOTLIN_LIBRARY`: Kotlin-specific override for the shared library.

```bash
cd src/sdks/kotlin
./gradlew check

LIBOLIPHAUNT_PATH=/path/to/liboliphaunt.dylib \
OLIPHAUNT_INSTALL_DIR=/path/to/postgres-install \
  ./gradlew :oliphaunt:macosArm64Test --rerun-tasks
```

`src/sdks/kotlin/tools/check-sdk.sh` defaults Android Gradle/CMake work to one
host-appropriate ABI for fast local iteration. Use
`OLIPHAUNT_KOTLIN_ANDROID_ABI_FILTERS=all` for full ABI coverage, or a
comma-separated subset such as `arm64-v8a,x86_64`. React Native forwards its
matching ABI setting through the same `-PoliphauntAndroidAbiFilters=...` Gradle
property so the delegated Android runtime and RN adapter validate the same ABI
matrix.

Kotlin/Native accepts `OliphauntConfig(extensions = listOf("vector"))` when
`NativeDirectEngine` has a runtime directory, or when
`OLIPHAUNT_INSTALL_DIR`/`OLIPHAUNT_RUNTIME_DIR` points at a runtime built
with those extensions. Extension names are validated before native code is loaded.

The Maven Central artifact is the Android SDK and JNI adapter. App builds select
the compatible `liboliphaunt` release with Gradle properties; the SDK downloads
and verifies matching checksum-covered GitHub release assets during the normal
Gradle build. Consumer devices receive the base runtime and only the exact SQL
extensions the app selected.

Android packages runtime/template assets from the published
`liboliphaunt-native-v<version>` release:

```bash
./gradlew :oliphaunt:assembleDebug \
  -PoliphauntLiboliphauntVersion=0.1.0 \
  -PoliphauntExtensions=vector
```

The resolver downloads `liboliphaunt-<version>-release-assets.sha256`,
`liboliphaunt-<version>-runtime-resources.tar.gz`, and ABI-specific Android JNI
archives from
`https://github.com/f0rr0/oliphaunt/releases/download/liboliphaunt-native-v<version>`.
Selected extensions are resolved from exact extension releases such as
`oliphaunt-extension-vector-v0.1.0`; each extension release provides its own
manifest, checksums, runtime artifact, and Android static archives. External
extensions can move independently from the base runtime:

```bash
./gradlew :oliphaunt:assembleRelease \
  -PoliphauntLiboliphauntVersion=0.1.0 \
  -PoliphauntExtensions=vector \
  -PoliphauntExtensionVersions=vector=0.1.0
```

Override the base runtime URL with `-PoliphauntAssetBaseUrl=<url>` for
release-candidate validation. The Android SDK requires
`schema=oliphaunt-runtime-resources-v1`, validates the runtime
`layout=postgres-runtime-files-v1` and template
`layout=postgres-template-pgdata-v1`, and preserves `extensions`,
`sharedPreloadLibraries`, and `mobileStaticRegistryState` from
`manifest.properties`. It rejects a selected extension at runtime when the
package does not advertise that exact extension or reports pending mobile
static-registry rows. Split-resource Android builds are development-only for
module-backed extensions: they can record selected extensions and pending native
module stems, but they cannot mark the package mobile-complete because they do
not generate the C static-registry source. Release mobile extension artifacts include
`static-registry/oliphaunt_static_registry.c` when complete. The Android native
bridge first looks for the registry in `liboliphaunt.so`, then in an optional
`liboliphaunt_extensions.so`, and registers those rows through the loaded
`oliphaunt_register_static_extensions` symbol before the first `oliphaunt_init`.
The same runtime-resource output includes `package-size.tsv`; Android apps can call
`OliphauntAndroid.packageSizeReport(context)` for packaged app assets or
`OliphauntAndroid.packageSizeReport(resourceRoot)` for local unpacked resource
smoke tests. Both paths inspect total package bytes,
runtime/template/static-registry bytes, de-duplicated selected extension bytes,
and per-extension footprints without rewalking packaged assets.

Package the Android native C ABI library with a normal `jniLibs` directory:

```text
jniLibs/
  arm64-v8a/liboliphaunt.so
  x86_64/liboliphaunt.so
```

```bash
./gradlew :oliphaunt:assembleDebug \
  -PoliphauntRuntimeResourcesDir=../../../target/oliphaunt-resources \
  -PoliphauntAndroidJniLibsDir=/path/to/jniLibs
```

Each ABI directory may include additional `.so` dependencies, but it must
include `liboliphaunt.so`. The Gradle task rejects symlinks, unknown ABI names, and
nested library layouts so the AAR shape remains predictable.

For exact mobile extension selection without rebuilding extension sources, Gradle
links only the selected archives named by the runtime-resource manifest into a
small `liboliphaunt_extensions.so` support library:

```bash
./gradlew :oliphaunt:assembleRelease \
  -PoliphauntLiboliphauntVersion=0.1.0 \
  -PoliphauntExtensions=vector
```

The archive root may contain either `extensions/<stem>/liboliphaunt_extension_<stem>.a`
for a single ABI or `<abi>/extensions/<stem>/liboliphaunt_extension_<stem>.a`
for multi-ABI release artifacts. Missing selected archives fail the native build.

You can still pass the split directories directly:

```bash
./gradlew :oliphaunt:assembleDebug \
  -PoliphauntRuntimeDir=/path/to/postgres-install-root \
  -PoliphauntTemplatePgdataDir=/path/to/template-pgdata \
  -PoliphauntExtensions=vector
```

The AAR stores them under `assets/oliphaunt/` with content-keyed manifests. At
runtime the SDK materializes the selected runtime once under `noBackupFilesDir`
and hydrates new PGDATA roots from the packaged template. Empty Android roots
require a packaged template PGDATA or an existing root with `PG_VERSION`.
