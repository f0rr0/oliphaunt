# SDK Products

SDK source lives under `sdks/`, with language manifests and local build/test
entrypoints. This document describes the development checkout; newly introduced
carriers and bindings are not assumed to be publicly released.

These are product SDKs, not auxiliary bindings. Native Rust, Rust WASIX, Swift,
Kotlin, React Native, native TypeScript, and WASIX TypeScript should expose the
same product concepts where the target platform can do so honestly:

- Native Rust is the SDK for Tauri and Rust desktop apps using `liboliphaunt`.
- Rust WASIX is the portable/AOT SDK for Tauri and Rust desktop apps that embed
  the WASIX runtime.
- Swift is the SDK for iOS and macOS apps.
- Kotlin is the SDK for Android apps. Only the Android AAR, Gradle plugin and
  marker, and declared Android ABI carriers are public release surfaces.
- React Native is the TypeScript/TurboModule SDK over the Swift and Kotlin SDKs.
- TypeScript is the SDK for Node.js, Bun, and Deno. Tauri apps use the Rust SDK
  behind narrow app-owned commands.
- WASIX TypeScript is the SDK for browser, Node.js, Bun, Deno, and Electron
  applications. Browser root is caller-owned; the native-host root uses a Rust actor,
  with explicit `/direct` and package-Worker placements.

`tools/release/sdk-manifest.toml` records the SDK inventory. The documentation
site does not build SDK API references. Product dependencies and release identities live in each product's
Moon and package manifests. Product tests and package checks verify runtime
delegation and consumer behavior.

- `sdks/rust/sdk/`: canonical native Rust SDK for Tauri and Rust desktop apps.
- `sdks/rust-wasix/`: Rust SDK over the portable
  and host-AOT `liboliphaunt-wasix` runtime products.
- `sdks/ts-wasix/sdk/`: TypeScript SDK over the browser portable WASIX
  carrier and the Node/Bun/Deno/Electron Rust Node-API carrier. Its native-host root
  uses a Rust owner actor, `/direct` opts into caller-realm execution, and
  `/worker` owns a JavaScript Worker on every runtime. Optional `pg_dump` and
  `psql` belong to `postgres-tools/wasix`, including its TypeScript facade in
  `postgres-tools/wasix/ts`. Portable and AOT tool inputs are supplied explicitly
  to the adapter; the database addon does not embed the frontend tool payloads.
- `sdks/swift/`: Swift package with an actor-first `Oliphaunt` API, platform
  resource composition, and generated UniFFI bindings to the shared Rust native
  database implementation.
- `sdks/kotlin/`: Android SDK with a suspend-first common implementation,
  JVM contract tests, and generated bindings to that same Rust implementation. Maven
  publication is deliberately limited to the Android consumer surface.
- `sdks/react-native/`: React Native New Architecture package. Its product contract
  is a typed TypeScript/TurboModule layer over the Swift and Kotlin SDKs, with
  no independent database semantics.
- `sdks/ts/sdk/`: desktop JavaScript SDK for Node.js, Bun, and Deno.
  Tauri apps expose narrow app-owned commands from the Rust SDK. Direct topology
  is the default across supported JavaScript
  runtimes; Node.js and Bun use the prebuilt Rust napi-rs addon. Deno retains its
  nonblocking FFI adapter until the addon passes Worker teardown with queued
  stream delivery; ordinary SQL success alone does not establish that parity.
  TypeScript broker mode consumes the published `oliphaunt-broker` executable
  and PostgreSQL wire protocol for SQL and cancellation. A separate authenticated
  management connection owns backup and shutdown. App developers consume
  verified release assets without building Rust locally. Runtime, addon, and
  optional database resources have separate packages.

`sdks/rust/liboliphaunt-native` owns native runtime loading and direct execution.
`sdks/rust/mobile-bindings` is the private UniFFI adapter consumed by Swift and
Kotlin. It does not own a second PostgreSQL runtime. `broker/` is an independent
process owner over the shared native implementation. `pgwire-server/` owns the
WASIX socket library and CLI. Browser host implementation and its Wasmer patches
live under `runtimes/wasix-browser-host`, outside the TypeScript SDK.

The native Rust SDK is canonical for native mode and resource terminology;
Swift, Kotlin, React Native, and native TypeScript mirror it unless a platform
restriction is documented. Rust WASIX and WASIX TypeScript use the same raw
protocol, typed query, transaction, structured PostgreSQL error, backup,
restore, and exact-extension vocabulary where their runtime supports the
behavior honestly. PostgreSQL `CHECKPOINT` is explicit SQL through `execute`,
not a separate SDK method. Native-only process modes are not WASIX requirements.
React Native must not duplicate database runtime behavior: iOS calls flow
through `Oliphaunt`, and Android calls flow through the `oliphaunt`
`Oliphaunt` facade.
Unsupported product features are absent from an SDK unless
[`sdk-parity-policy.md`](sdk-parity-policy.md) explicitly documents a current
runtime error. Silent drift between SDKs is a release blocker.

Validation is package-native:

```sh
moon run oliphaunt-rust:build
moon run oliphaunt-wasix-rust:build
moon run oliphaunt-wasix-ts:typecheck
moon run oliphaunt-wasix-tools-ts:typecheck
moon run oliphaunt-swift:build
moon run oliphaunt-kotlin:format-check oliphaunt-kotlin:lint oliphaunt-kotlin:build
moon run oliphaunt-react-native:build
moon run oliphaunt-js:build
moon run extensions:lint
```

The Kotlin and React Native Android validation scripts opt into Gradle
configuration cache by default. Set `OLIPHAUNT_GRADLE_CONFIGURATION_CACHE=0`
when debugging Gradle task configuration itself.

Source compilation and runtime integration are separate. Swift's
`test-native` and Kotlin's native binding tests require a real compatible native
library; the mobile packaging lanes additionally build the required Rust target
libraries. The canonical C header is copied by its consuming package producers
and compiled by those consumers, rather than checked by a separate header-copy
layout task.

Initialization data belongs to the independently versioned `database-resources`
product. It provides native and WASIX seeds, each with standard and ICU profiles,
and one canonical ICU data family. Native seeds additionally bind their physical
target; Android and iOS use their explicitly produced datum64 variants. For
example, the owner commands are:

```sh
moon run database-resources:package-icu
moon run database-resources:package-wasix
moon run database-resources:package-android
```

Extension selection is exact-name only. SDKs accept exact PostgreSQL extension
names; `vector` means only the SQL extension `vector`, and names like `core`,
`search`, or `geo` must not resolve to hidden extension sets.

Select seed and ICU carriers explicitly. Browser creation of new storage needs
a seed; an existing database can reopen without one. Native desktop and native
WASIX hosts retain their supported `initdb` fallback. Writable PGDATA is separate
from immutable installed resources. Swift, Gradle, and the Expo plugin compose
the selected mobile carriers during the application build; ordinary applications
do not run the internal `oliphaunt-resources` maintainer CLI.

For iOS and Android release artifacts, build runtime resources with
`--require-mobile-static-registry` once the selected extension modules have
platform static registry rows. Swift, Kotlin, and React Native reject requested
extensions whose packaged runtime advertises pending mobile registry work.
The platform resource build must also pass each linked registry module stem with
`--mobile-static-module <stem>`; the Rust runtime-resource CLI rejects stems
that are not selected by the runtime resources. Those stems are declarations for
validation; mobile-ready output includes
`oliphaunt/static-registry/oliphaunt_static_registry.c`, which exports
`liboliphaunt_selected_static_extensions`. Platform bridges discover that symbol
and register the returned rows through `oliphaunt_register_static_extensions`
before the first database open.
Every SDK consumes the resulting runtime resources through the same manifest
fields. Generated manifests record
`schema=oliphaunt-runtime-resources-v1`, per-package `layout`,
the full dependency-closed `selectedExtensions` domain, its exact
`creates-extension=true` subset in `extensions`, `runtimeFeatures`, and
`sharedPreloadLibraries`. Mobile manifests additionally bind the exact native
SQL-name domain in `mobileStaticRegistryRegistered` and its exact module stems
in `nativeModuleStems`; the static-registry manifest must agree. All domains
are sorted and duplicate-free. SDK resource-availability checks use
`selectedExtensions`, including for selected module-only extensions, so
SDK-bound artifacts can be audited independently of the local build path.
Swift and Kotlin reject unknown package layouts rather than silently accepting
stale app resources; React Native inherits those checks through the platform
SDKs.
The resource root also carries `package-size.tsv` for packaging and release
audits. It is maintainer evidence, not a database SDK API.

Android packages the native C ABI library separately from runtime resources.
Pass a `jniLibs`-style directory with ABI subdirectories through
`-PoliphauntAndroidJniLibsDir=/path/to/jniLibs`; each packaged ABI must include
`liboliphaunt.so`.
