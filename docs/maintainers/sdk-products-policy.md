# SDK Products

SDK source lives under `src/` with the product it releases. This document is
the cross-SDK policy and parity contract.

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

`tools/policy/sdk-manifest.toml` is the repo-level SDK registry. The canonical
product graph lives in `src/*/moon.yml`; `sdk-contracts:check` parses both and
rejects ownership or package-identity drift. Product tests and package checks,
not source-text assertions, prove runtime delegation and consumer behavior.

- `src/sdks/rust/`: canonical native Rust SDK for Tauri and Rust desktop apps.
- `src/bindings/wasix-rust/crates/oliphaunt-wasix/`: Rust SDK over the portable
  and host-AOT `liboliphaunt-wasix` runtime products.
- `src/bindings/wasix-ts/`: TypeScript SDK over the browser portable WASIX
  carrier and the Node/Bun/Deno/Electron Rust Node-API carrier. Its native-host root
  uses a Rust owner actor, `/direct` opts into caller-realm execution, and
  `/worker` owns a JavaScript Worker on every runtime. `tools-package/` owns the optional
  TypeScript facade for `pg_dump` against root, direct, or Worker handles and
  non-interactive `psql` against browser Worker or any native-host placement. Browser tool
  modules are a separate `liboliphaunt-wasix` carrier; native tools are embedded
  in the Node-API carrier.
- `src/sdks/swift/`: Swift package with an actor-first `Oliphaunt` API and a
  native-direct C ABI product boundary over `liboliphaunt`; it can materialize
  packaged runtime/cluster-seed resources for iOS and macOS apps.
- `src/sdks/kotlin/`: Android SDK with a suspend-first common implementation,
  JVM contract tests, and the Android native-direct JNI engine. Maven
  publication is deliberately limited to the Android consumer surface.
- `src/sdks/react-native/`: React Native New Architecture package. Its product contract
  is a typed TypeScript/TurboModule layer over the Swift and Kotlin SDKs, with
  no independent database semantics.
- `src/sdks/js/`: desktop JavaScript SDK for Node.js, Bun, and Deno.
  Tauri apps expose narrow app-owned commands from the Rust SDK. Direct topology
  is the default across supported JavaScript
  runtimes; Node.js and Bun use the package-owned prebuilt Node direct adapter,
  while Deno uses nonblocking runtime FFI. TypeScript broker mode consumes the
  published `oliphaunt-broker` runtime and the shared `PGOB` protocol
  instead of inventing another broker runtime; app developers get verified
  release assets by default instead of building Rust locally. The npm package
  is the native-runtime distribution for Node, Bun, and Deno.

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
moon run oliphaunt-rust:check
moon run oliphaunt-wasix-rust:check
moon run oliphaunt-wasix-ts:check
moon run oliphaunt-wasix-ts:tools-check
moon run oliphaunt-swift:check
moon run oliphaunt-kotlin:check
moon run oliphaunt-react-native:check
moon run oliphaunt-js:check
moon run sdk-contracts:check
moon run extension-model:check
```

The Kotlin and React Native Android validation scripts opt into Gradle
configuration cache by default. Set `OLIPHAUNT_GRADLE_CONFIGURATION_CACHE=0`
when debugging Gradle task configuration itself.

When a local `target/liboliphaunt-pg18` build exists, the Swift and Kotlin lanes
automatically run their native-direct C ABI tests against that library and
runtime tree.

Build app-bundle resources from the Rust/native track with:

```sh
cargo run -p oliphaunt-native-packaging --bin oliphaunt-resources -- \
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
