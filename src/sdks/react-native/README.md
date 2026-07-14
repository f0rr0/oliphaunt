# Oliphaunt React Native SDK

## Install

Install the New Architecture package from npm:

```bash
pnpm add @oliphaunt/react-native
```

Expo apps select the compatible native core and exact PostgreSQL extensions in
`app.json`:

```json
{
  "expo": {
    "plugins": [
      [
        "@oliphaunt/react-native",
        {
          "liboliphauntVersion": "0.1.0",
          "extensions": ["vector"]
        }
      ]
    ]
  }
}
```

The config plugin delegates iOS packaging to the Swift SDK and Android packaging
to the Kotlin SDK. It writes normal native project settings so app builds fetch
checksum-covered `liboliphaunt-native-v0.1.0` assets and include only the exact
extensions selected by the app.
Normal React Native and Expo app consumers do not install Rust, run Cargo, build
PostgreSQL, or copy native Oliphaunt artifacts. The package uses standard New
Architecture, Expo config-plugin, CocoaPods project integration, and Gradle
integration to resolve prebuilt release assets.

Base React Native installs do not include full ICU data. Applications that need
PostgreSQL ICU collations install the ICU sidecar npm package and enable the
config plugin flag:

```bash
pnpm add @oliphaunt/react-native @oliphaunt/icu
```

```json
{
  "expo": {
    "plugins": [
      ["@oliphaunt/react-native", { "icu": true }]
    ]
  }
}
```

On iOS, the config plugin adds the `OliphauntICU` local podspec from
`@oliphaunt/icu`. On Android, it sets `oliphauntIcu=true` so the app-applied
Gradle plugin resolves `dev.oliphaunt.runtime:oliphaunt-icu`. Leave `icu` false
for applications that do not use ICU collations.

## Compatibility

| Package | Swift SDK | Kotlin SDK | Native core |
| --- | --- | --- | --- |
| `@oliphaunt/react-native` `0.1.0` | `Oliphaunt` `0.6.0` | `dev.oliphaunt:oliphaunt-android` `0.1.0` | `liboliphaunt` `0.1.0` |

React Native iOS uses the Swift SDK through npm-shipped podspec shims required
by current React Native iOS integration. The Expo config plugin wires
`COliphaunt` and `Oliphaunt` podspecs that resolve the released Swift SDK source
tag through CocoaPods, so builds do not require CocoaPods trunk publication and
the npm package does not vendor Swift SDK source. React Native Android uses the
Kotlin SDK and Gradle resolver.

## Quickstart

<!-- liboliphaunt-doc-example:react-native-open-query -->
```ts
import {Oliphaunt} from '@oliphaunt/react-native';

const db = await Oliphaunt.open({
  engine: 'nativeDirect',
  temporary: true,
  runtimeFootprint: 'balancedMobile',
  startupGUCs: [{name: 'shared_buffers', value: '32MB'}],
  username: 'postgres',
  database: 'postgres',
  extensions: ['vector'],
});
const response = await db.query('SELECT 1::text AS value');
const value = response.getText(0, 'value');
await db.close();
```

Modern React Native package for `liboliphaunt`.

This package targets the React Native New Architecture. The public TypeScript
API accepts and returns `Uint8Array` for raw PostgreSQL protocol bytes. The
TurboModule Codegen surface is intentionally limited to typed lifecycle and
capability calls. Protocol, backup, and restore bytes require the versioned
`globalThis.__oliphauntReactNativeJsi` transport and use `ArrayBuffer`/typed
arrays directly. The iOS and Android New Architecture adapters install that
JSI transport and delegate the binary handoff to `Oliphaunt` and
`OliphauntAndroid`; there is no base64 binary fallback.

The native layer should stay deliberately thin:

- Apple runtime behavior belongs to the Swift SDK. The current package ships an
  iOS adapter; any future React Native macOS target must use the same
  `Oliphaunt` boundary.
- Android runtime behavior belongs to the Kotlin SDK.
- React Native owns TypeScript handles, the TurboModule Codegen
  lifecycle/control surface, the JSI transport installer, and JS ergonomics.
- RN Android delegates to the Kotlin SDK through `OliphauntAndroid`.
- RN iOS delegates to `Oliphaunt` through a small Objective-C-visible Swift
  adapter.
- The published package vendors only the Swift SDK source slice needed for RN iOS
  local pod resolution at publish time; the canonical Swift SDK source remains
  `src/sdks/swift`.

Capabilities are delegated from the platform SDK and keep the same field names
as the product contract: raw and streaming protocol support, cancellation,
backup/restore, simple-query execution, exact extensions, and session semantics.
They also expose `multiRoot` plus `backupFormats` and `restoreFormats`, so TypeScript callers can
disable unsupported SQL or archive actions before crossing the native boundary.
Use the exported `supportsBackupFormat` and `supportsRestoreFormat` helpers, or
the matching `OliphauntDatabase.supportsBackupFormat` and
`OliphauntDatabase.supportsRestoreFormat` methods, when gating app actions.
`OliphauntDatabase.backup` enforces those capabilities before it crosses the
TurboModule boundary. `Oliphaunt.restore` rejects unsupported restore artifact formats
before it crosses the TurboModule restore boundary.
`OliphauntDatabase.transaction(async tx => ...)` keeps multi-step work on the same
platform SDK session and rejects database calls outside the active transaction
handle until commit or rollback.
`OliphauntDatabase.checkpoint()` requests a PostgreSQL checkpoint through the same
delegated platform SDK session and is rejected while a transaction is active.
Call `Oliphaunt.supportedModes()` before opening to discover the platform adapter's
actual direct/broker/server capability report. React Native reports the same
canonical capability shape as Swift/Kotlin and carries explicit reasons for
unavailable modes instead of attempting direct-mode aliases. `OpenConfig.engine`
currently accepts `nativeDirect` only; broker/server entries are discovery
signals until the React Native bridge exposes those open paths.
Lifecycle capability fields are forwarded from the platform SDK:
`sameRootLogicalReopen`, `rootSwitchable`, and `crashRestartable` distinguish
direct's same-root resident reopen from broker/server process-managed behavior.
Native direct is not root-switchable or crash-restartable. Mobile direct mode
has one resident backend per app process and one physical session.
`Oliphaunt.open({ username, database })` forwards startup identity to the Swift or
Kotlin SDK and rejects empty or NUL-containing values before the TurboModule
call.

Packaged runtime/template assets use the same `oliphaunt/runtime` and
`oliphaunt/template-pgdata` resource layout as the Swift and Kotlin SDKs. Empty
mobile roots require a packaged template because mobile bootstrap must not
depend on executing `initdb` from app data.

See [`docs/architecture.md`](docs/architecture.md) for the architecture,
transport, and performance completion criteria.

React Native defaults to the mobile resident profile: `runtimeFootprint:
'balancedMobile'` and `durability: 'balanced'`. Use `'safe'` when last-commit
survival matters more than commit latency, `'throughput'` for throughput-lane
diagnostics, or `'smallMobile'` for memory-pressure experiments. `startupGUCs`
can be objects or `name=value` strings; the TypeScript layer validates them and
forwards `name=value` assignments to Swift/Kotlin, where they are appended
after footprint and durability defaults.

`query(sql)` parses normal PostgreSQL backend protocol frames into field
metadata, rows, command tags, nulls, and structured PostgreSQL errors through
`PostgresError`, preserving SQLSTATE and raw `ErrorResponse` fields.
Multi-result-set and COPY traffic stay on `execProtocolRaw`/`execute`.
Pass query parameters as the second argument to use PostgreSQL's extended
protocol instead of interpolating values into SQL:

For crash-recovery and physical-device harnesses, `root` may be an absolute
native path or an app-sandbox specifier. `app-support://name` resolves under
Application Support on Apple platforms and app-private files storage on
Android; `documents://name` resolves under Documents on Apple platforms and the
same app-private files base on Android. The suffix must be a relative path and
cannot contain `.` or `..`.

<!-- liboliphaunt-doc-example:react-native-parameterized-query -->
```ts
const result = await db.query('SELECT $1::text AS value', ['hello']);
```

`execProtocolStream(bytes, onChunk)` is part of the public TypeScript shape.
`EngineCapabilities.protocolStream` is `true` only when the installed JSI
transport has a real chunked stream primitive. Current iOS and Android adapters
delegate to the Swift/Kotlin streaming APIs and invoke `onChunk` for each native
chunk. If a custom or stale transport omits that primitive, the public method
falls back to the owned-response raw path, invokes `onChunk` once, and reports
`protocolStream=false`.

For app/device smoke tests, call the installed-package runner inside a real
React Native New Architecture app after packaging `liboliphaunt` and runtime
resources:

<!-- liboliphaunt-doc-example:react-native-smoke-runner -->
```ts
import {runInstalledOliphauntReactNativeSmoke} from '@oliphaunt/react-native';

const report = await runInstalledOliphauntReactNativeSmoke({
  open: {engine: 'nativeDirect', temporary: true, extensions: ['vector']},
  requirePackageSizeReport: true,
  afterSmoke: async database => {
    await database.execute('CREATE TABLE app_smoke (id integer PRIMARY KEY)');
  },
});
```

The runner opens through the installed TurboModule/JSI transport, verifies
`SELECT 1`, verifies a parameterized query, optionally requires packaged
resource size evidence, reports JS timer progress during the smoke, optionally
runs app-specific validation on the same live session, and closes the database.

For measured device work, use the benchmark runner instead of reading smoke
latencies. It records warmup-controlled raw protocol RTT, typed query RTT,
parameterized RTT, transaction insert throughput, indexed lookup, indexed
aggregate, indexed update, background checkpoint latency, large raw-result
transfer, package size, event-loop liveness, and a same-device Expo SQLite WAL
baseline for mobile comparison:

<!-- liboliphaunt-doc-example:react-native-benchmark-runner -->
```ts
import {Oliphaunt, runOliphauntReactNativeBenchmark} from '@oliphaunt/react-native';

const report = await runOliphauntReactNativeBenchmark(Oliphaunt, {
  requirePackageSizeReport: true,
});
```

The monorepo includes a real Expo development-build app at
`src/sdks/react-native/examples/expo`. Its Android smoke harness packages the
current SDK tarball, runs Expo prebuild when the ignored generated Android
project is absent, packages `liboliphaunt.so` and runtime/template resources,
builds the dev-client APK, launches through Expo dev-client, and waits for
`OLIPHAUNT_EXPO_SMOKE_PASS`:

```bash
pnpm --dir ../../src/sdks/react-native/examples/expo run smoke
pnpm --dir ../../src/sdks/react-native/examples/expo run smoke:android
moon run oliphaunt-react-native:smoke-mobile
pnpm --dir src/sdks/react-native/examples/expo run smoke:android
```

`moon run oliphaunt-react-native:smoke-mobile` is the default installed-app
validation lane. It delegates to the Expo development-client harness and runs
the Android and iOS smokes over the packed SDK; use the platform-specific lanes
when only one simulator/device stack is available.

The example defaults Metro to the dev-client plus local MCP path: `pnpm start`,
`pnpm run android:start`, and `pnpm run ios:start` all use
`EXPO_UNSTABLE_MCP_SERVER=1 expo start --dev-client`.
The installed-app smoke, benchmark, and crash scripts own their dev-client
Metro process by default with the same local MCP capabilities enabled so runner
mode, durability, startup GUCs, and persistent crash roots are passed through
`EXPO_PUBLIC_OLIPHAUNT_*` env instead of depending on Expo launcher URL
forwarding. If port 8081 is already in use and no explicit
`OLIPHAUNT_EXPO_*_METRO_PORT` is set, the scripts choose a free port in
8082-8099; set `OLIPHAUNT_EXPO_*_REUSE_METRO=1` only for manual debugging with
an already configured Metro server.
Installed-app smoke and benchmark runs default to the mobile performance profile
(`runtimeFootprint: 'balancedMobile'`, `durability: 'balanced'`). Crash-recovery
runs default to `durability: 'safe'` because `balanced` sets
`synchronous_commit=off`, which is allowed to lose the last acknowledged
transaction after process death. Set
`OLIPHAUNT_EXPO_MOBILE_RUNTIME_FOOTPRINT` and
`OLIPHAUNT_EXPO_MOBILE_STARTUP_GUCS` to sweep the device footprint matrix
without changing app code. The matrix wrapper accepts
`--runtime-footprint all` when comparing `throughput`, `balancedMobile`, and
`smallMobile` with the same shared-buffer/WAL startup-GUC axes.

For benchmark artifacts:

```bash
pnpm --dir ../../src/sdks/react-native/examples/expo run bench:android
pnpm --dir ../../src/sdks/react-native/examples/expo run bench:ios
```

The harnesses emit `OLIPHAUNT_EXPO_BENCH_PASS`, persist parsed JSON reports
under `target/oliphaunt-expo-<platform>-benchmark/reports/`, and collect
platform memory evidence where available.

For process-death recovery evidence:

```bash
pnpm --dir ../../src/sdks/react-native/examples/expo run crash:android
pnpm --dir ../../src/sdks/react-native/examples/expo run crash:ios
```

Those lanes run a two-phase installed-app harness. The write phase uses a
persistent app-private root and intentionally leaves the direct-mode database
open; the platform script force-stops or terminates the app, relaunches the
verify phase with the same root, and expects the committed row to survive
PostgreSQL recovery before emitting `OLIPHAUNT_EXPO_CRASH_RECOVERY_PASS`.
For development-client builds, each phase starts a fresh Metro bundle with the
phase-specific runner (`crash-write`, then `crash-verify`) and root in Expo
public env.
The mobile footprint matrix runs this lane for safe-durability cases by default;
balanced cases remain latency/footprint evidence rather than last-commit
survival evidence.

The same example exposes an iOS smoke/build harness. It packages the RN SDK
with an iOS `oliphaunt/` resource bundle, uses the Swift `Oliphaunt` pods, and
rejects macOS dylibs so Apple validation cannot accidentally use the host
artifact:

```bash
OLIPHAUNT_EXPO_IOS_OLIPHAUNT_XCFRAMEWORK=/path/to/liboliphaunt.xcframework \
OLIPHAUNT_EXPO_IOS_RUNTIME_DIR=/path/to/postgres-runtime \
OLIPHAUNT_EXPO_IOS_TEMPLATE_PGDATA_DIR=/path/to/template-pgdata \
pnpm --dir ../../src/sdks/react-native/examples/expo run smoke:ios

../../pnpm --dir src/sdks/react-native/examples/expo run smoke:ios
```

Set `OLIPHAUNT_EXPO_IOS_BUILD_ONLY=1` to validate generated spec, local iOS pod,
and Xcode integration without launching a simulator. For an unsigned generic
iPhoneOS compile/package check, also set `OLIPHAUNT_EXPO_IOS_SDK=iphoneos` and
`OLIPHAUNT_EXPO_IOS_CODE_SIGNING_ALLOWED=NO`; physical install/launch
benchmarks still require a runnable paired phone and valid signing.

For physical iOS runs, set `OLIPHAUNT_EXPO_IOS_SDK=iphoneos` and point
`OLIPHAUNT_EXPO_IOS_OLIPHAUNT_XCFRAMEWORK` at an XCFramework with an iPhoneOS
slice. The harness checks Developer Mode and Developer Disk Image availability
through `devicectl`, then auto-selects the single Xcode development team when
one is configured, or you can set `OLIPHAUNT_EXPO_IOS_DEVELOPMENT_TEAM`
explicitly. Set the team explicitly when Xcode has multiple teams configured.
It fails before expensive project preparation if no local signing identity
exists; set `OLIPHAUNT_EXPO_IOS_ALLOW_PROVISIONING_UPDATES=1` to explicitly
allow automatic provisioning. It also supports
`OLIPHAUNT_EXPO_IOS_CODE_SIGN_IDENTITY`,
`OLIPHAUNT_EXPO_IOS_PROVISIONING_PROFILE_SPECIFIER`, and
`OLIPHAUNT_EXPO_IOS_ALLOW_PROVISIONING_UPDATES` for local or CI signing.

For Expo-assisted local debugging, the example includes `expo-mcp`:

```bash
pnpm --dir ../../src/sdks/react-native/examples/expo run mcp:start
```

This starts Metro with `EXPO_UNSTABLE_MCP_SERVER=1` for local MCP capabilities
such as app logs, DevTools, screenshots, and simulator/device automation.

## Local Development

```bash
pnpm install
pnpm test
pnpm run typecheck
pnpm run codegen:check
ANDROID_HOME="$HOME/Library/Android/sdk" ../../src/sdks/react-native/tools/check-sdk.sh
```

Codegen is retained deliberately for the official New Architecture
TurboModule surface: `open`, `close`, `cancel`, `capabilities`,
`supportedModes`, and package-size reporting. It is not a binary transport.
The package check fails if protocol execution, backup, or restore bytes are
added to the Codegen spec, or if runtime source reintroduces base64/Node
`Buffer` conversion.

The package check defaults Android Gradle/CMake work to one ABI for fast local
iteration. Use `OLIPHAUNT_REACT_NATIVE_ANDROID_ABI_FILTERS=all` for full ABI
coverage, or a comma-separated subset such as `arm64-v8a,x86_64`.

For local iOS smoke work, the RN module calls the Swift SDK `Oliphaunt` API.
Pass `libraryPath` and `runtimeDirectory`, or set
`OLIPHAUNT_REACT_NATIVE_IOS_*`, `OLIPHAUNT_SWIFT_*`, or
`OLIPHAUNT_*` environment variables in the test process. Pass
`resourceRoot` when testing an unpacked `oliphaunt/` resource layout. Restore
accepts the same `libraryPath` override because it also crosses the native C ABI.
Empty iOS roots require packaged template PGDATA or an existing root with
`PG_VERSION`.

For local Android smoke work, the RN module calls the Kotlin SDK
`OliphauntAndroid` facade and stores the returned `OliphauntDatabase` handle. Package
or load `liboliphaunt.so` and pass `libraryPath`/`runtimeDirectory`, or set
`OLIPHAUNT_REACT_NATIVE_ANDROID_*` or `OLIPHAUNT_KOTLIN_ANDROID_*` environment
variables in the test process. Restore forwards `libraryPath` to
`OliphauntAndroid.restore(...)` for the same local override path.

The published React Native artifact does not carry base `liboliphaunt`
binaries, PostgreSQL runtime resources, or optional extension assets. React
Native apps receive those through the delegated SwiftPM-backed local iOS pods
and the app-applied `dev.oliphaunt.android` Gradle plugin on Android, using the
same exact SQL extension selection as native apps.

For Expo/dev-client apps, add the config plugin and select exact PostgreSQL
extension names:

```json
{
  "expo": {
    "plugins": [
      ["@oliphaunt/react-native", { "extensions": ["vector"] }]
    ]
  }
}
```

The config plugin writes the native extension selection, applies
`id 'dev.oliphaunt.android' version '<compatible Kotlin SDK version>'` to the
Android app module, and injects the npm-shipped Swift SDK podspec shims for iOS.
The React Native Android module depends on the Kotlin SDK and ships only its JSI
bridge by default, avoiding duplicate ownership of `liboliphaunt.so`, runtime
resources, and extension assets.

React Native uses the same runtime-resource contract as the platform SDKs. iOS
delegates the mobile static-registry check to `Oliphaunt`; Android preserves
the Rust runtime-resource generator manifest in the Kotlin SDK AAR and delegates
the runtime check to the Kotlin SDK. Extension selection is not reimplemented in TypeScript:
`packageLayout`, per-package `layout`, `extensions`, `sharedPreloadLibraries`,
and mobile static registry state are validated by Swift on Apple platforms and
Kotlin on Android.
`package-size.tsv` is preserved in the same platform resource bundle/AAR.
`Oliphaunt.packageSizeReport(...)` returns the Rust runtime-resource generator's total, runtime,
template PGDATA, static-registry, selected-extension, and per-extension byte
evidence by delegating to `Oliphaunt` on Apple platforms and
`OliphauntAndroid` on Android instead of maintaining a JS-specific resource
walker.

`Oliphaunt.processMemory()` returns app-reported process memory for benchmark
and diagnostics paths. iOS uses Mach task VM data (`residentBytes` and
`physicalFootprintBytes`) from inside the app process. Android uses
`Debug.MemoryInfo` (`totalPssKb`, dirty pages, native heap, and runtime heap).
Prefer this report over host-side process scraping for physical devices; Core
Device and `adb shell` output varies across OS versions and can omit the fields
needed for reproducible RSS/PSS summaries.

Package Android native libraries with the same ABI layout Android apps already
use:

```text
jniLibs/
  arm64-v8a/liboliphaunt.so
  x86_64/liboliphaunt.so
```

```bash
gradle -p android assembleDebug \
  -PoliphauntRuntimeResourcesDir=../../target/oliphaunt-resources \
  -PoliphauntAndroidJniLibsDir=/path/to/jniLibs
```

The Android build rejects unknown ABI names, symlinks, nested layouts, and ABI
directories that do not contain `liboliphaunt.so`.

For release builds with module-backed extensions, pass the prebuilt mobile
extension archive root to the Kotlin SDK packaging path as well. The Kotlin SDK
AAR links the small `liboliphaunt_extensions.so` from the selected
`liboliphaunt_extension_<stem>.a` archives and the generated static-registry
source; React Native does not compile PostgreSQL or extension sources in the app
build.

```bash
gradle -p android assembleRelease \
  -PoliphauntRuntimeResourcesDir=../../target/oliphaunt-resources \
  -PoliphauntAndroidJniLibsDir=/path/to/jniLibs \
  -PoliphauntAndroidExtensionArchivesDir=/path/to/liboliphaunt-android-arm64/out
```

The older split inputs remain available when integrating with a custom build:

```bash
gradle -p android assembleDebug \
  -PoliphauntRuntimeDir=/path/to/postgres-install-root \
  -PoliphauntTemplatePgdataDir=/path/to/template-pgdata \
  -PoliphauntExtensions=vector
```

The build packages those directories under `assets/oliphaunt/` with generated
content manifests. At runtime the Kotlin SDK materializes the runtime directory
once under `noBackupFilesDir` and hydrates new PGDATA roots from the packaged
template. Android records the packaged exact extension names in the runtime
manifest and fails open early if JS requests an extension that was not packaged.
Split-resource Android builds intentionally keep module-backed extensions in
`pending` state because they cannot generate
or verify `static-registry/oliphaunt_static_registry.c`; use the Rust runtime-resource generator
output with `--mobile-static-module <stem>` for a mobile-complete release
package. iOS performs the same manifest check through
`Oliphaunt` when packaged runtime resources are used. The React Native package
does not implement extension loading in TypeScript; its iOS/Android native
layers inherit the Swift/Kotlin bridge behavior. Mobile-ready Rust runtime-resource generator
output includes `static-registry/oliphaunt_static_registry.c`; the native
bridges discover `liboliphaunt_selected_static_extensions` in the linked native
artifact or Android `liboliphaunt_extensions.so` and register the rows through
`oliphaunt_register_static_extensions` before opening the database.
The React Native npm package is selection-neutral: it contains bridge source and
the iOS carrier resolver, but no app-specific runtime resources, generated
registry, or XCFramework payload. Each independently versioned exact-extension
package publishes a small carrier manifest at
`oliphaunt-react-native-ios-carriers.json`; the manifest freezes exact GitHub
asset URLs, byte sizes, SHA-256 digests, archive members, semantic dependencies,
native dependency frameworks, and registration symbols. SQL-only extensions
carry runtime SQL/control resources and no fabricated native framework.

The Expo config plugin resolves the selected exact-extension packages and their
dependency closure, downloads assets into a content-addressed user cache,
verifies every byte before extraction, and writes only to the consuming app's
`ios/oliphaunt` directory. It then adds the generated app-owned payload podspec
to the Podfile. Package installation and `pnpm pack` never download assets or
write generated payload into `node_modules`.

CI can exercise the same resolver against the canonical aggregate carrier made
by release automation:

```bash
node node_modules/@oliphaunt/react-native/tools/stage-ios-app.mjs \
  --carrier /path/to/oliphaunt-react-native-ios-carriers.json \
  --extensions cube,postgis,pgtap \
  --output-dir ios/oliphaunt
```

`--allow-file-urls` is an explicit CI/test-only opt-in; normal consumers accept
HTTPS carrier URLs only. Resolution fails closed on missing dependencies,
cycles, checksum or size mismatches, unsafe archive entries, conflicting files,
or an incomplete/extra native framework role inventory. The generated registry
strongly references selected native symbols, so a missing selected artifact is
a build/link failure rather than a runtime surprise. Device and simulator lanes
still execute the packaged app to validate the complete consumer path.

Backup and restore use the same same-version physical archive model as the
Rust/Swift/Kotlin SDKs. RN Android delegates those calls to the Kotlin Android
SDK; RN iOS delegates those calls to `Oliphaunt`.
