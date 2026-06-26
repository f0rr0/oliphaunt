# SDK Parity

`oliphaunt` is a native PostgreSQL product with peer SDK surfaces:

- Rust: SDK for Tauri and Rust desktop apps;
- Swift: Apple SDK for iOS and macOS apps;
- Kotlin: Android SDK;
- React Native: TypeScript/TurboModule SDK over Swift and Kotlin.
- TypeScript: desktop JavaScript SDK for Node.js, Bun, Deno, and Tauri
  JavaScript apps.

The machine-checked SDK registry is
`tools/policy/sdk-manifest.toml`. It is the compact source
of truth for SDK classification, target platforms, runtime ownership, artifact
resolution, and React Native delegation. The prose below explains the contract;
the parity check guards the registry and the docs together.

The generated public surface inventory is
[`sdk-api-surface.md`](sdk-api-surface.md). It is intentionally no-build so
normal iteration stays fast, but it still makes public Rust, Swift, Kotlin,
React Native, and TypeScript symbol drift visible in review.

Shared semantics use product-native tests fed by shared fixture corpora, not a
fake universal harness. `src/shared/fixtures/protocol/query-response-cases.json` is the
backend-response corpus consumed by Rust, Swift, Kotlin, React Native,
TypeScript, and the WASM wire parser. Additional shared contracts live under
`src/shared/fixtures/sdk-capabilities/`, `src/shared/fixtures/runtime-resources/`,
`src/shared/fixtures/backup/`, and `src/shared/fixtures/lifecycle/`; RN-specific binary transport
fixtures live under `src/shared/fixtures/react-native-jsi/`.

Mobile crash/reopen/concurrency semantics are tracked separately in
[`Mobile Stability`](/learn/mobile-stability) because they differ by platform
sandbox.

The common product concepts are defined by `liboliphaunt`, the shared fixture
contracts, the public parity matrix, and the release metadata. Rust, Swift,
Kotlin, TypeScript, React Native, and WASM are peer products with ecosystem
contracts. Any deviation needs an explicit reason, not silent drift.

## SDK Taxonomy

SDK ownership is product ownership, not just source layout:

- Rust is the Tauri/Rust desktop SDK. Its Cargo crate lives under
  `src/sdks/rust`; its public docs live under
  `src/docs/content/sdk/rust`.
- Swift owns iOS and macOS runtime behavior.
- Kotlin owns Android runtime behavior.
- React Native owns TypeScript DX and TurboModule transport, while delegating
  runtime behavior to Swift on Apple platforms and Kotlin on Android.
- TypeScript owns desktop JavaScript runtime behavior for Node.js, Bun, Deno,
  and Tauri JavaScript apps. Its broker mode consumes the published
  `oliphaunt-broker` runtime and the shared `PGOB` protocol.

The SDKs are peers over the same `liboliphaunt` C ABI and runtime-resource model.
React Native is not a fifth runtime. Its native modules are adapters over the
Swift and Kotlin SDKs so platform bugs, packaging, extension checks,
backup/restore behavior, and lifecycle semantics are fixed once in the platform
SDK that native app developers also use.

The Rust SDK owns the runtime-resource producer contract. Generated manifests
must declare `schema=oliphaunt-runtime-resources-v1` and the expected
per-extension `layout`; Swift and Kotlin validate those fields before using
generated resources, and React Native inherits the same checks through those
platform SDKs.

## Artifact Resolution

Normal installs must use the host ecosystem's package manager. SDKs can still
offer explicit local overrides for contributor and custom-runtime workflows, but
those overrides are not the consumer install path.

| SDK | Runtime/library artifacts | Standalone tools | Extension artifacts | Explicit local override |
| --- | --- | --- | --- | --- |
| Rust | Cargo-resolved `liboliphaunt-native-*` artifact crates staged by `oliphaunt-build` | split `oliphaunt-tools-*` Cargo artifact crates copied into the runtime cache | exact `oliphaunt-extension-*` Cargo artifact crates | `OLIPHAUNT_RESOURCES_DIR` |
| TypeScript | npm optional platform packages such as `@oliphaunt/liboliphaunt-*` and `@oliphaunt/node-direct-*` | split `@oliphaunt/tools-*` npm packages | Node/Bun exact extension npm packages; Deno requires an explicit prepared `runtimeDirectory` for extension materialization | `libraryPath` and `runtimeDirectory` |
| Swift | SwiftPM release assets and packaged runtime resources | not exposed in mobile native-direct mode | exact extension XCFramework artifacts selected by SQL extension name | `runtimeDirectory` or `resourceRoot` |
| Kotlin | Maven runtime artifacts applied through the Android Gradle plugin | not exposed in Android native-direct mode | exact extension Maven artifacts selected by SQL extension name | `runtimeDirectory` or `resourceRoot` |
| React Native | delegated SwiftPM and Maven platform SDK resolution | delegated to the platform SDK; no separate RN tool runtime | delegated exact extension artifacts through Swift/Kotlin integrations | `runtimeDirectory` or `resourceRoot` |

## Parity Bar

Rust is classified as an SDK, not an internal implementation detail. Its release
contract matters in the same way as Swift, Kotlin, TypeScript, React Native,
and WASM contracts. It owns Rust/Tauri ergonomics, direct/broker/server APIs,
and the broker helper used by TypeScript; it is not the only proof layer for
shared semantics.

Parity is required where the target platform can support the behavior without
lying about PostgreSQL semantics or degrading developer experience. A feature is
allowed to differ only when the difference is documented with a product reason:

- impossible or inappropriate for the platform sandbox;
- better expressed through a platform-native API shape;
- intentionally not implemented yet because a fake implementation would be
  worse than an explicit unsupported error.

Unsupported does not mean undefined. Each SDK must expose a clear error for
unsupported modes or backup formats, and the parity matrix must explain why the
gap is acceptable.

Mode support is part of the public contract, not tribal knowledge. Each SDK
must expose a `supportedModes`-style API that lists `nativeDirect`,
`nativeBroker`, and `nativeServer`, marks whether the current platform adapter
can open each mode, and carries the canonical capability shape plus the product
reason for any unavailable mode.

## Required Concepts

| Concept | Rust | Swift | Kotlin | React Native |
| --- | --- | --- | --- | --- |
| Native direct mode | yes | yes | yes | via Swift/Kotlin |
| Native broker mode | yes | future platform adapter | future platform adapter | via Swift/Kotlin |
| Native server mode | yes | future platform adapter | future platform adapter | via Swift/Kotlin |
| Raw protocol API | `exec_protocol_raw` | `execProtocolRaw` | `execProtocolRaw` | `execProtocolRaw` |
| Streaming protocol API | `exec_protocol_raw_stream` | `execProtocolStream` | `execProtocolStream` | `execProtocolStream` over the selected raw transport; New Architecture builds use `jsi-array-buffer` |
| Typed query helpers | yes | yes, simple and parameterized result parser | yes, simple and parameterized result parser | yes, JS simple and parameterized result parser |
| Simple-query SQL validation | simple-query builders reject NUL-containing SQL before frontend frame construction | simple-query builders reject NUL-containing SQL before frontend frame construction | simple-query builders reject NUL-containing SQL before frontend frame construction | simple-query builders reject NUL-containing SQL before frontend frame construction |
| Extended-query input validation | extended-query builders reject NUL-containing SQL and parameter lists above the PostgreSQL protocol `Int16` limit before frontend frame construction | extended-query builders reject NUL-containing SQL and parameter lists above the PostgreSQL protocol `Int16` limit before frontend frame construction | extended-query builders reject NUL-containing SQL and parameter lists above the PostgreSQL protocol `Int16` limit before frontend frame construction | extended-query builders reject NUL-containing SQL and parameter lists above the PostgreSQL protocol `Int16` limit before frontend frame construction |
| Backend UTF-8 parsing | backend C-strings and text accessors reject malformed UTF-8 instead of replacement decoding | backend C-strings and text accessors reject malformed UTF-8 instead of replacement decoding | backend C-strings and text accessors reject malformed UTF-8 instead of replacement decoding | backend C-strings and text accessors reject malformed UTF-8 instead of replacement decoding |
| Backend response validation | typed query parsers accept known simple/extended-query control tags, validate async backend control-message framing and `ReadyForQuery` transaction status, and reject unexpected backend tags instead of ignoring them | typed query parsers accept known simple/extended-query control tags, validate async backend control-message framing and `ReadyForQuery` transaction status, and reject unexpected backend tags instead of ignoring them | typed query parsers accept known simple/extended-query control tags, validate async backend control-message framing and `ReadyForQuery` transaction status, and reject unexpected backend tags instead of ignoring them | typed query parsers accept known simple/extended-query control tags, validate async backend control-message framing and `ReadyForQuery` transaction status, and reject unexpected backend tags instead of ignoring them |
| Transaction helper | `transaction()` returns an explicit pinned handle; `with_transaction(...)` commits or rolls back an async closure; unpinned work is rejected | `transaction {}` uses the actor-owned session for raw and streaming work and rejects database work outside the active transaction handle | `transaction {}` uses the serialized session for raw and streaming work and rejects database work outside the active transaction handle | `transaction(async tx => ...)` preserves the platform session boundary for raw and streaming work and rejects database work outside the active transaction handle |
| Structured PostgreSQL errors | `Error::Postgres(PostgresError)` with SQLSTATE and raw ErrorResponse fields | `OliphauntError.postgres(OliphauntPostgresError)` with SQLSTATE and raw ErrorResponse fields | `PostgresException(PostgresError)` with SQLSTATE and raw ErrorResponse fields | `PostgresError` with SQLSTATE and raw ErrorResponse fields |
| Capability reporting | raw, stream, cancel, backup/restore, simple query, extensions, session model, multi-root support | same C ABI capability bits surfaced as Swift properties, including `multiRoot` | same C ABI capability bits surfaced as Kotlin properties, including `multiRoot` | same capability fields delegated from Swift/Kotlin, including `multiRoot` |
| Backup/restore format discovery | direct/broker: physical archive; server: SQL and physical archive backup; restore: physical archive; capability and handle `supports_backup_format`/`supports_restore_format` helpers | `backupFormats`, `restoreFormats`, and capability/database `supportsBackupFormat`/`supportsRestoreFormat` helpers | `backupFormats`, `restoreFormats`, and capability/database `supportsBackupFormat`/`supportsRestoreFormat` helpers | delegated `backupFormats` and `restoreFormats` capability fields plus TypeScript `supportsBackupFormat`/`supportsRestoreFormat` helpers and matching database methods |
| Backup format enforcement | `EngineExecutor::backup` rejects unsupported formats before the owner queue | `OliphauntDatabase.backup` rejects unsupported formats before the native session call | `OliphauntDatabase.backup` rejects unsupported formats before the platform session call | `OliphauntDatabase.backup` rejects unsupported formats before the TurboModule backup call |
| Checkpoint | `checkpoint()` sends PostgreSQL `CHECKPOINT` through the opened engine and rejects while a session pin is active | `checkpoint()` sends PostgreSQL `CHECKPOINT` through the actor-owned session and rejects while a transaction is active | `checkpoint()` sends PostgreSQL `CHECKPOINT` through the serialized session and rejects while a transaction is active | `checkpoint()` sends PostgreSQL `CHECKPOINT` through the delegated platform session and rejects while a transaction is active |
| Restore format enforcement | `Oliphaunt::restore` rejects non-physical artifacts before target materialization | `OliphauntDatabase.restore` rejects non-physical artifacts before the engine call | `OliphauntDatabase.restore` rejects non-physical artifacts before the platform engine call | `Oliphaunt.restore` rejects non-physical artifacts before the TurboModule restore call |
| Root validation | persistent roots are rejected when empty or NUL-containing before runtime selection; restore targets are rejected before materialization | roots must be file URLs and are rejected when empty or NUL-containing before engine calls | blank or NUL-containing open and restore roots are rejected before platform engine calls | blank or NUL-containing open and restore roots are rejected before TurboModule calls |
| Mode support discovery | `EngineCapabilities::rust_sdk_support()` | `OliphauntDatabase.supportedModes()` | `OliphauntDatabase.supportedModes()` and `OliphauntAndroid.supportedModes()` | `Oliphaunt.supportedModes()` delegated from Swift/Kotlin |
| Handle/executor ownership | Cloned Rust `Oliphaunt` handles share one SDK executor, FIFO owner queue, session pin, cancel handle, and close state in direct, broker, and server modes; cloning is not a connection pool | Swift database values are actor-owned session handles guarded by a FIFO async serial gate; additional references share the same actor/session and server-mode independent clients must use server support when implemented | Kotlin database values are coroutine session handles guarded by `executionMutex`; additional references share the same coroutine/session boundary and server-mode independent clients must use server support when implemented | React Native `OliphauntDatabase` objects wrap the delegated Swift/Kotlin session handle and delegate ordering to the platform serial session; JS references do not create independent sessions |
| Connection identity | `Oliphaunt::builder().username(...).database(...)` feeds direct, broker, and server startup identity; invalid empty/NUL values are rejected before runtime open | `OliphauntConfiguration(username:database:)` feeds native-direct startup identity and rejects invalid empty/NUL values before engine open | `OliphauntConfig(username, database)` feeds native-direct startup identity and rejects invalid empty/NUL values before engine open | `open({ username, database })` forwards the same identity through Swift/Kotlin and rejects invalid empty/NUL values before the TurboModule call |
| Runtime footprint profiles | `RuntimeFootprintProfile::{Throughput,BalancedMobile,SmallMobile}` defines the shared PostgreSQL startup-GUC contract; balanced/small mobile lower slot counts, shared buffers, WAL footprint, and PG18 AIO concurrency | `OliphauntRuntimeFootprintProfile` carries the same three profiles and generated startup args for Apple direct mode; the Apple SDK default is `balancedMobile` + `balanced` | `RuntimeFootprintProfile` carries the same three profiles and generated startup args for Android/Kotlin direct mode; the Android/Kotlin default is `BalancedMobile` + `Balanced` | `runtimeFootprint: 'throughput' | 'balancedMobile' | 'smallMobile'` forwards the selected profile through Swift/Kotlin; the TypeScript default is `balancedMobile` + `balanced` |
| Startup GUC overrides | `startup_guc`/`startup_gucs` append validated `name=value` overrides after durability and footprint profiles so benchmark/device sweeps can override profile defaults | `startupGUCs` appends validated overrides after the selected profile before the Swift engine call | `startupGucs` appends validated overrides after the selected profile before the Kotlin engine call | `startupGUCs` accepts validated string or object values in TypeScript and forwards string assignments through the TurboModule to Swift/Kotlin |
| Extensions | yes | yes | yes | via Swift/Kotlin |
| Packaged runtime resources | yes, producer | yes, consumer | yes, consumer | via platform SDK consumers |
| Package-size evidence | `NativeRuntimeResources::size_report` and `oliphaunt/package-size.tsv` producer | `OliphauntRuntimeResources.packageSizeReport()` parses the shared TSV | `OliphauntAndroid.packageSizeReport(context)` and `OliphauntAndroid.packageSizeReport(resourceRoot)` parse the shared TSV | `Oliphaunt.packageSizeReport(...)` delegates to Swift/Kotlin and returns the same typed report |
| Packaged native library | host library path today | XCFramework target | Android `jniLibs` | Swift/Kotlin package artifacts |
| Physical backup/restore | yes | yes | yes | via Swift/Kotlin |
| Cancellation | yes | yes | yes | via Swift/Kotlin |
| Close behavior | `Oliphaunt::close` rejects queued work, waits for active work, then closes/detaches; use `cancel()` explicitly to interrupt SQL | `OliphauntDatabase.close` rejects queued work, waits for active work, then detaches; use `cancel()` explicitly to interrupt SQL | `OliphauntDatabase.close` rejects queued work, waits for active work, then detaches; use `cancel()` explicitly to interrupt SQL | `OliphauntDatabase.close` delegates the same wait-and-detach behavior through Swift/Kotlin |
| True concurrent sessions | server mode only | server mode only | server mode only | server mode only |

## Current Platform Stance

| SDK | Primary app target | Runtime owner | Current native mode | Non-parity that is allowed today |
| --- | --- | --- | --- | --- |
| Rust | Tauri and Rust desktop apps | `oliphaunt` | direct, broker, server | none for the core SDK contract |
| Swift | iOS and macOS apps | `Oliphaunt` | direct | broker/server are explicit unsupported errors until platform runtimes exist; they must not be faked through direct mode |
| Kotlin | Android apps | `oliphaunt` | Android direct plus Kotlin/Native direct | Android common defaults require the `OliphauntAndroid` Context facade; JVM runtime is explicitly unavailable; Android broker/server must be separate platform adapters, not direct-mode aliases |
| React Native | React Native apps | Swift on Apple, Kotlin on Android | delegated direct | New Architecture JSI ArrayBuffer transport is required for protocol, backup, and restore bytes |

## React Native Ownership

React Native should not own a separate database runtime. It owns:

- TypeScript types and ergonomic JS handles;
- TurboModule Codegen;
- versioned JSI ArrayBuffer transport installers for protocol, backup, and restore bytes;
- JS protocol/query helpers, including chunked JSI streaming when the installed
  transport provides it and explicit `protocolStream=false` when a custom or
  stale transport can only return one owned response;
- a typed `packageSizeReport(...)` facade over the Swift/Kotlin resource
  package readers;
- error normalization for JS callers.

Swift owns Apple runtime behavior for iOS and macOS. Kotlin owns Android runtime
behavior. The React Native native modules are adapters over those SDKs. RN iOS
delegates open, protocol execution, backup, restore, cancellation, and close to
`Oliphaunt`; any future RN macOS target must use the same Swift SDK boundary.
RN Android delegates the same operations to the Kotlin SDK through the
`OliphauntAndroid` facade, not by constructing a private native-direct runtime.

### React Native Installed-App Harness

The Expo dev-client example is the installed-app validation harness. The default
combined lane is `moon run oliphaunt-react-native:smoke-mobile`;
platform-specific local lanes are backed by
`src/sdks/react-native/tools/expo-android-runner.sh` and
`src/sdks/react-native/tools/expo-ios-runner.sh`.

Local Expo MCP validation must run with `EXPO_UNSTABLE_MCP_SERVER=1` so the
example can be driven through the same dev-client app surface that developers
use during iteration.

## Defensible Deviations

- React Native keeps TurboModule Codegen for lifecycle/control calls while
  requiring a New Architecture JSI ArrayBuffer transport for binary protocol,
  backup, and restore traffic.
- Swift and Kotlin use platform-native async/actor/coroutine shapes rather than
  copying Rust names exactly.
- Android requires packaged template PGDATA for new roots because mobile apps
  cannot rely on executing `initdb` from writable app storage.

## Release Rule

An SDK feature is complete only when its SDK-specific tests prove the behavior
and the parity matrix either marks it present or documents a justified platform
deviation. Green Rust tests do not prove Swift, Kotlin, or React Native parity.
Green Swift/Kotlin tests do not prove React Native parity unless the RN adapter
tests demonstrate that calls route through those SDKs rather than through a
private runtime.

The fast ownership guard is:

```sh
tools/policy/check-sdk-parity.sh
```

The full SDK aggregate is:

```sh
src/runtimes/liboliphaunt/native/tools/check-track.sh sdks
```
