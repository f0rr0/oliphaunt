# SDK Products

SDK source lives under `src/` with the product it releases. This document is
the cross-SDK policy and parity contract.

These are product SDKs, not auxiliary bindings. Rust, Swift, Kotlin, React
Native, and TypeScript should expose the same product concepts where the target
platform can do so honestly:

- Rust is the SDK for Tauri and Rust desktop apps.
- Swift is the SDK for iOS and macOS apps.
- Kotlin is the SDK for Android apps. Only the Android AAR, Gradle plugin and
  marker, and declared Android ABI carriers are public release surfaces.
- React Native is the TypeScript/TurboModule SDK over the Swift and Kotlin SDKs.
- TypeScript is the SDK for Node.js, Bun, Deno, and Tauri JavaScript apps.

`tools/policy/sdk-manifest.toml` is the repo-level SDK registry kept for parity
checks during the moon migration. The canonical product graph now lives in
`src/*/moon.yml`; both must agree. `tools/policy/check-sdk-parity.sh` treats the
registry as an ownership guard, so Rust cannot quietly become "just a crate" and
React Native cannot grow an independent PostgreSQL runtime.

- `src/sdks/rust/`: canonical Rust SDK for Tauri and Rust desktop apps.
- `src/sdks/swift/`: Swift package with an actor-first `Oliphaunt` API and a
  native-direct C ABI engine over `liboliphaunt`; `.nativeDirect` uses that engine
  by default and can materialize packaged runtime/template resources for iOS and
  macOS apps.
- `src/sdks/kotlin/`: Kotlin Multiplatform source/build project with a
  suspend-first common API, host-native conformance targets, and the Android
  native-direct JNI engine. The host-native compilations are development and
  parity evidence only; Maven publication is deliberately limited to the
  Android consumer surface.
- `src/sdks/react-native/`: React Native New Architecture package. Its product contract
  is a typed TypeScript/TurboModule layer over the Swift and Kotlin SDKs, with
  no independent database semantics.
- `src/sdks/js/`: desktop JavaScript SDK for Node.js, Bun, Deno, and
  Tauri JavaScript apps. `nativeDirect` is the default across all JavaScript
  runtimes; Node.js uses the package-owned prebuilt Node direct adapter, and Bun
  and Deno use their runtime FFI surfaces. TypeScript broker mode consumes the
  published `oliphaunt-broker` runtime and the shared `PGOB` protocol
  instead of inventing another broker runtime; app developers get verified
  release assets by default instead of building Rust locally. The npm package
  is the native-runtime distribution for Node, Bun, and Deno; the JSR package
  intentionally exposes protocol/query helpers only and must not advertise a
  native runtime.

The Rust SDK is canonical for now; Swift, Kotlin, React Native, and TypeScript
mirror its mode, raw protocol, typed query, transaction, checkpoint, structured PostgreSQL error, capabilities, backup, restore, exact extension, and resource packaging terminology unless a platform restriction is documented.
React Native must not duplicate database runtime behavior: iOS calls flow
through `Oliphaunt`, and Android calls flow through the `oliphaunt`
`OliphauntAndroid` facade.
Every SDK-facing feature must either be implemented with equivalent semantics or
fail with an explicit unsupported error that is justified in
[`sdk-parity-policy.md`](sdk-parity-policy.md). Silent drift between SDKs is a
release blocker.

Validation is package-native:

```sh
moon run oliphaunt-rust:check
moon run oliphaunt-swift:check
moon run oliphaunt-kotlin:check
moon run oliphaunt-react-native:check
moon run oliphaunt-js:check
tools/policy/check-sdk-parity.sh
```

The Kotlin and React Native Android validation scripts opt into Gradle
configuration cache by default. Set `OLIPHAUNT_GRADLE_CONFIGURATION_CACHE=0`
when debugging Gradle task configuration itself.

When a local `target/liboliphaunt-pg18` build exists, the Swift and Kotlin lanes
automatically run their native-direct C ABI tests against that library and
runtime tree.

Build app-bundle resources from the Rust/native track with:

```sh
cargo run -p oliphaunt --bin oliphaunt-resources -- \
  --output target/oliphaunt-resources \
  --extension vector \
  --force
```

Extension selection is exact-name only. SDKs accept exact PostgreSQL extension
names; `vector` means only the SQL extension `vector`, and names like `core`,
`search`, or `geo` must not resolve to hidden extension sets.

The generated `target/oliphaunt-resources/oliphaunt` directory is the resource
root consumed by Swift bundles, Android assets, and React Native apps. Android
Gradle builds also accept the parent directory through
`-PoliphauntRuntimeResourcesDir=target/oliphaunt-resources`.

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
`extensions`, `runtimeFeatures`, and `sharedPreloadLibraries` so SDK-bound
artifacts can be audited independently of the local build path.
Swift and Kotlin reject unknown package layouts rather than silently accepting
stale app resources; React Native inherits those checks through the platform
SDKs.
The resource root also carries `package-size.tsv`. Swift exposes it through
`OliphauntRuntimeResources.packageSizeReport()`, Kotlin Android exposes it through
`OliphauntAndroid.packageSizeReport(context)` or
`OliphauntAndroid.packageSizeReport(resourceRoot)`, and React Native exposes the
same typed report through `Oliphaunt.packageSizeReport(...)` while still delegating
the actual resource lookup to Swift/Kotlin.

Android packages the native C ABI library separately from runtime resources.
Pass a `jniLibs`-style directory with ABI subdirectories through
`-PoliphauntAndroidJniLibsDir=/path/to/jniLibs`; each packaged ABI must include
`liboliphaunt.so`.
