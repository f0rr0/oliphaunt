# Consumer DX Release Implementation Plan

Status: archived design plan; non-normative. See `docs/maintainers/README.md`
and `docs/maintainers/release.md` for the current operational contract. This replaces the previous research
memo. Oliphaunt is still largely unreleased, so this plan uses breaking changes,
removes legacy paths, and optimizes for the final consumer experience.

## Decisions

1. Ship no runtime artifact downloads in public SDK paths.
2. Ship no consumer install lifecycle scripts.
3. Remove CLI-first consumer flows from public docs.
4. Keep `oliphaunt-resources`, extension artifact tools, and release download
   helpers as maintainer and CI tools.
5. Publish byte-carrying artifacts through the package manager used by each
   ecosystem.
6. Publish every byte-carrying PostgreSQL extension as an explicit dependency or
   product. Do not hide contrib extension bytes in base packages.
7. Keep the base runtime free of selected extension payloads and full ICU data.
8. Publish full ICU data as runtime-owned sidecar packages. Do not publish an
   `icu-full` package. Model ICU as a runtime/data capability, not as a SQL
   extension.
9. Generate every consumer package descriptor from the repo product graph,
   release metadata, and extension catalog evidence.
10. Fail builds at package/install/build time on missing artifacts. Never defer
    artifact errors to first database open.

## Grounding

- npm supports platform package selection with `os`, `cpu`, `libc`, and
  `optionalDependencies`; npm also supports omitting dependencies from that
  field. Resolver code must treat missing selected platform packages as install
  errors.
  Source: [npm package.json docs](https://docs.npmjs.com/files/package.json/).
- crates.io has a 10 MB compressed `.crate` limit. Oliphaunt publishes WASIX
  runtime and AOT bytes through direct public artifact crates and fails release
  packaging when a generated `.crate` exceeds that limit. Source:
  [Cargo publishing docs](https://doc.rust-lang.org/cargo/reference/publishing.html).
- SwiftPM binary artifacts are declared in `Package.swift` with URL and checksum.
  Plugins do not add new products after package resolution. Source:
  [SwiftPM binary dependencies](https://github.com/swiftlang/swift-evolution/blob/main/proposals/0272-swiftpm-binary-dependencies.md),
  [SwiftPM plugin docs](https://github.com/swiftlang/swift-package-manager/blob/main/Sources/PackageManagerDocs/Documentation.docc/Plugins.md).
- iOS apps are self-contained bundles and do not download executable code that
  changes functionality after review. Source:
  [Apple App Review Guideline 2.5.2](https://developer.apple.com/app-store/review/guidelines/).
- Android and Gradle support variant-aware publication and dependency
  verification. Source:
  [Android publication variants](https://developer.android.com/build/publish-library/configure-pub-variants),
  [Gradle dependency verification](https://docs.gradle.org/current/userguide/dependency_verification.html).

## Current Code To Remove Or Replace

### JavaScript

Remove runtime GitHub downloads from:

- `src/sdks/js/src/native/assets-node.ts`
- `src/sdks/js/src/native/assets-deno.ts`
- `src/sdks/js/src/native/node-addon.ts`
- `src/sdks/js/src/runtime/broker.ts`

Replace those paths with package-local artifact resolution. Delete public use of:

- `OLIPHAUNT_RELEASE_BASE_URL`
- `OLIPHAUNT_LIBOLIPHAUNT_ASSET_DIR`
- `OLIPHAUNT_NODE_DIRECT_RELEASE_BASE_URL`
- runtime cache installation as a normal public path

Keep fixture directories for tests under test-owned names. Do not expose them as
consumer configuration.

### Rust Native

Remove CLI-first consumer install guidance from:

- `src/sdks/rust/README.md`
- `docs/maintainers/sdk-products-policy.md`
- release metadata checks that treat `--resolve-release-assets` as the consumer
  path

Keep `oliphaunt-resources` for CI and maintainer packaging. Add the consumer
path through `oliphaunt-build`.

### Rust WASIX

Remove the public env-var archive path from consumer docs:

- `OLIPHAUNT_WASM_RUNTIME_ARCHIVE`
- `OLIPHAUNT_WASM_AOT_ARCHIVE`

Delete the inert `bundled` feature contract that advertises a feature and then
hard-fails. Replace it with a build-produced asset manifest contract.

### Android And Kotlin

Remove direct GitHub asset downloads from:

- `src/sdks/kotlin/oliphaunt-android-gradle-plugin/src/main/java/dev/oliphaunt/android/ResolveOliphauntAndroidAssetsTask.java`
- the duplicate resolver in `src/sdks/kotlin/oliphaunt/build.gradle.kts`

Replace downloads with Gradle/Maven artifact dependencies and Gradle dependency
verification.

### React Native

Replace the iOS config-only path in:

- `src/sdks/react-native/app.plugin.js`
- `src/sdks/react-native/OliphauntReactNative.podspec`
- `src/sdks/react-native/ios/podspecs/*.podspec`

The config plugin writes a locked native artifact plan. The native build consumes
real local package artifacts installed by npm packages.

### Swift

Extend the generated SwiftPM release manifest in:

- `tools/release/render_swiftpm_release_package.mjs`

Generate extension products and checksum-pinned binary targets. Do not use a
plugin to add dependencies.

## Target Consumer DX

### JavaScript: Node And Bun

Base install:

```sh
pnpm add @oliphaunt/ts
```

Runtime artifacts:

- `@oliphaunt/ts` declares platform packages for `liboliphaunt`:
  `@oliphaunt/liboliphaunt-darwin-arm64`,
  `@oliphaunt/liboliphaunt-linux-x64-gnu`,
  `@oliphaunt/liboliphaunt-linux-arm64-gnu`, and
  `@oliphaunt/liboliphaunt-win32-x64-msvc`.
- Each `@oliphaunt/liboliphaunt-*` platform package includes the matching
  `liboliphaunt` library and PostgreSQL runtime tree for that platform.
- `@oliphaunt/ts` declares platform packages for `oliphaunt-broker`:
  `@oliphaunt/broker-darwin-arm64`, `@oliphaunt/broker-linux-x64-gnu`,
  `@oliphaunt/broker-linux-arm64-gnu`, and
  `@oliphaunt/broker-win32-x64-msvc`.
- `@oliphaunt/ts` keeps the existing platform packages for
  `oliphaunt-node-direct`.
- Platform packages use `os`, `cpu`, and `libc`.
- Runtime resolution uses literal package names and an exported artifact
  manifest.
- Missing selected platform packages fail with an install message.
- Runtime resolution never fetches GitHub assets.

Extension install:

```sh
pnpm add @oliphaunt/ts @oliphaunt/extension-vector
```

Usage:

```ts
import { Oliphaunt } from '@oliphaunt/ts';
import { vector } from '@oliphaunt/extension-vector';

const db = await Oliphaunt.open({
  root: '.oliphaunt',
  extensions: [vector],
});
```

Contrib uses the same explicit package shape:

```sh
pnpm add @oliphaunt/ts @oliphaunt/extension-pg-trgm
```

```ts
import { pgTrgm } from '@oliphaunt/extension-pg-trgm';
```

Package layout:

- `@oliphaunt/extension-<name>` is a descriptor package.
- Descriptor packages declare platform artifact packages.
- npm byte packages cover native desktop, WASIX, Android ABI, and iOS
  XCFramework target classes.
- Maven byte packages use
  `dev.oliphaunt.extensions:<name>-android-arm64-v8a` and
  `dev.oliphaunt.extensions:<name>-android-x86_64`.
- SwiftPM binary targets are generated into the release manifest.
- Platform artifact packages carry exact extension bytes for one target family.
- Descriptor exports include SQL name, product version, runtime compatibility,
  target package names, checksums, byte sizes, dependencies, and required
  preload libraries.

### JavaScript: Deno And JSR

`jsr:@oliphaunt/ts` is a TypeScript protocol/client package. It does not expose
native-direct or broker runtime artifact resolution.

Deno native users install through npm:

```ts
import { Oliphaunt } from 'npm:@oliphaunt/ts';
```

The Deno native path uses the same npm-installed platform packages as Node and
Bun. The JSR package fails on native runtime creation with an error that points
to `npm:@oliphaunt/ts`.

### Rust Native

Base install:

```sh
cargo add oliphaunt
cargo add --build oliphaunt-build
```

Extension install:

```sh
cargo add oliphaunt-extension-vector
cargo add oliphaunt-extension-pg-trgm
```

ICU install:

```sh
cargo add oliphaunt-icu
```

Application manifest:

```toml
[package.metadata.oliphaunt]
runtime = "liboliphaunt-native"
runtime-version = "0.1.0"
extensions = ["vector", "pg_trgm"]
```

Add `icu = true` under `[package.metadata.oliphaunt]` after adding the
`oliphaunt-icu` dependency.

Build script:

```rust
fn main() {
    oliphaunt_build::configure();
}
```

`oliphaunt-build` is a build-dependency crate released with `oliphaunt-rust`.
It is the Rust application integration point for local runtime packaging.
Cargo resolves the target-specific artifact crates; `oliphaunt-build` only
stages the already-resolved files for the current application build. It performs
all app packaging work:

- reads `[package.metadata.oliphaunt]`;
- reads generated product metadata;
- reads the resolved Cargo package graph;
- resolves native target from Cargo target variables;
- locates Cargo-resolved native runtime, broker, ICU, and exact extension
  artifact crates;
- performs no network I/O;
- adds no dependencies to the Cargo graph;
- writes `OUT_DIR/oliphaunt/oliphaunt-assets.lock`;
- validates the lockfile and manifests;
- writes generated Rust constants and Cargo env vars;
- copies the exact runtime, broker helper, ICU data, and selected extension
  artifacts into `OUT_DIR/oliphaunt/resources`;
- writes no generated files outside `OUT_DIR`;
- emits `cargo:rerun-if-changed=Cargo.toml`;
- fails on missing Cargo dependencies, missing checksums, unknown targets,
  missing extension artifacts, selected ICU without `oliphaunt-icu`, and
  unselected extension leakage.

Cargo owns artifact selection:

- Direct application dependencies expose artifact manifests through Cargo
  `links` metadata. `oliphaunt-build` consumes only the metadata that Cargo
  passes to the application build script.
- `oliphaunt` owns the base runtime and broker selector build script. It reads
  its target-specific artifact dependencies and re-emits the selected manifests
  as `oliphaunt-build` inputs.
- `oliphaunt-extension-*` crates own exact extension selector build scripts.
  They read their target-specific native and WASIX artifact dependencies and
  re-emit selected manifests as `oliphaunt-build` inputs.
- `oliphaunt-icu` is the Cargo ICU data artifact crate. It owns the ICU data
  selector build script and re-emits selected manifests as `oliphaunt-build`
  inputs.
- Raw target artifact crates are private implementation dependencies. Consumers
  do not add target artifact crates directly.
- `oliphaunt-build` stages only artifacts exposed by direct application
  dependencies. It never relies on transitive Cargo metadata.

Consumer code uses the SDK without environment variables:

```rust
let db = oliphaunt::Oliphaunt::builder()
    .path(".oliphaunt")
    .native_direct()
    .extension(oliphaunt::Extension::Vector)
    .open()
    .await?;
```

Tauri documentation shows the one bundler stanza that copies the generated
Oliphaunt resource directory into the app image.

### Rust WASIX

Base install:

```sh
cargo add oliphaunt-wasix
cargo add --build oliphaunt-build
```

Extension install:

```sh
cargo add oliphaunt-extension-vector
```

Application manifest:

```toml
[package.metadata.oliphaunt]
runtime = "liboliphaunt-wasix"
runtime-version = "0.1.0"
extensions = ["vector"]
```

Build script:

```rust
fn main() {
    oliphaunt_build::configure();
}
```

WASIX uses Cargo-selected runtime artifacts. The public `oliphaunt-wasix` crate
depends on `liboliphaunt-wasix-portable` and target-specific `liboliphaunt-wasix-aot-*`
artifact crates. Release packaging generates and packages those public artifact
crates directly from staged WASIX release assets. Each generated `.crate` must
fit the crates.io 10 MB package limit. Release packaging publishes the artifact
crates, then publishes `oliphaunt-wasix`. Consumers add only
`oliphaunt-wasix`; Cargo selects the matching target dependency. The crate does
not expose a `bundled` feature and does not read runtime/AOT archive env vars in
the normal path.

Delete source-only/private WASIX asset and AOT fallbacks from the consumer path.

### Android And Kotlin

Base install:

```gradle
plugins {
    id("com.android.application")
    id("dev.oliphaunt.android") version "0.1.0"
}

dependencies {
    implementation("dev.oliphaunt:oliphaunt-android:0.1.0")
}

oliphaunt {
    runtimeVersion.set("0.1.0")
    extensions.add("vector")
}
```

Plugin behavior:

- maps selected ABIs to Maven runtime artifacts;
- adds runtime artifact dependencies;
- adds exact extension artifact dependencies;
- writes generated Android assets and `jniLibs`;
- verifies dependencies through Gradle dependency verification;
- fails on missing artifacts, checksum mismatches, unknown extensions, and
  unselected extension leakage.

Published artifacts:

- `dev.oliphaunt.runtime:liboliphaunt-android-arm64-v8a`
- `dev.oliphaunt.runtime:liboliphaunt-android-x86_64`
- `dev.oliphaunt.extensions:<extension>-android-arm64-v8a`
- `dev.oliphaunt.extensions:<extension>-android-x86_64`
- `dev.oliphaunt.runtime:oliphaunt-icu`

### Swift

Base install:

```swift
.package(url: "https://github.com/f0rr0/oliphaunt.git", exact: "0.6.0")
```

Base product:

```swift
.product(name: "Oliphaunt", package: "oliphaunt")
```

Extension product:

```swift
.product(name: "OliphauntExtensionVector", package: "oliphaunt")
```

Generated release manifest:

- declares `Oliphaunt`;
- declares one product per exact extension;
- declares `OliphauntICU`;
- declares checksum-pinned binary targets for base runtime artifacts;
- declares checksum-pinned binary targets for exact extension artifacts;
- links selected extension products before app archive.

Runtime open validates that every configured SQL extension has a linked product.
Missing extension products fail before database open. iOS never downloads
runtime, extension, or ICU executable payloads after app archive.

### React Native

Install:

```sh
pnpm add @oliphaunt/react-native @oliphaunt/extension-vector
```

Expo config:

```json
{
  "expo": {
    "plugins": [
      ["@oliphaunt/react-native", { "extensions": ["vector"] }]
    ]
  }
}
```

Config plugin behavior:

- reads installed `@oliphaunt/extension-*` descriptors;
- writes one locked native artifact plan for iOS and Android;
- wires Android through the Kotlin Gradle plugin;
- runs `oliphaunt-react-native-stage-ios` before CocoaPods;
- materializes `ios/frameworks`, `ios/extension-frameworks`, `ios/resources`,
  and `ios/generated/static-registry` from npm-installed extension packages;
- patches Podfile/podspec entries to use staged local artifacts;
- fails during prebuild on missing npm packages, version mismatch, missing iOS
  artifacts, missing Android artifacts, and unselected extension leakage.

React Native owns no independent runtime resolver.

### ICU

ICU product model:

- base runtime excludes full ICU data;
- ICU-enabled runtime capability is explicit in release metadata;
- full ICU data ships as runtime-owned sidecar packages;
- do not publish `icu-full`;
- do not publish a Cargo crate named `icu`;
- package surfaces:
  - npm: `@oliphaunt/icu`
  - Maven: `dev.oliphaunt.runtime:oliphaunt-icu`
  - SwiftPM: `OliphauntICU`
  - Rust native: `oliphaunt-icu` plus `[package.metadata.oliphaunt] icu = true`
  - WASIX Rust: `oliphaunt-icu` behind the `oliphaunt-wasix/icu` feature
- builders fail on ICU selection without a matching ICU data artifact.

## Release Graph

Keep source ownership split and explicit:

- Moon owns tasks, dependency edges, and artifact target membership.
- `release.toml` owns publish targets and registry package names.
- Release Please owns versions, changelogs, and the generated release PR; the
  protected workflow owns exact-SHA tags and draft GitHub releases.
- extension catalog/evidence/recipes own extension identity, readiness,
  dependencies, and capability data.

Add release surfaces, not aggregate products:

- `liboliphaunt-native` owns JS base runtime platform packages, Cargo native
  runtime artifact crates, Android Maven runtime payloads, SwiftPM base binary
  metadata, and native runtime package-size budgets.
- `oliphaunt-broker` owns JS broker helper platform packages and Cargo broker
  artifact crates.
- `oliphaunt-node-direct` keeps the existing npm addon platform packages and
  drops runtime download code.
- each existing `oliphaunt-extension-*` product owns generated npm descriptor
  packages, npm platform byte packages, Cargo descriptor and artifact crates,
  and Maven payload packages.
- `oliphaunt-swift` generates SwiftPM extension products from exact extension
  product metadata.
- `oliphaunt-rust` owns the derived `crates:oliphaunt-build` crate, SDK crate,
  target-specific Cargo dependency wiring, and version file.
- `liboliphaunt-native` owns native ICU release assets plus `@oliphaunt/icu`,
  `dev.oliphaunt.runtime:oliphaunt-icu`, and `OliphauntICU` packaging.
- `liboliphaunt-wasix` owns the WASIX ICU release asset and the
  `crates:oliphaunt-icu` artifact crate.

Do not add a second catalog. Generate package descriptors from existing product
metadata and extension evidence. Commit the generated descriptor snapshots used
by release checks.

## Minimal Release Gates

Keep these gates:

1. Metadata parity: Moon, `release.toml`, release-please, and extension generated
   catalogs agree.
2. Package-size gate: every npm tarball, crate, Maven artifact, Swift binary
   archive, ICU archive, and extension package stays within its declared budget.
3. No runtime download gate: public SDK packages contain no `fetch(`,
   GitHub-release URL construction, or runtime asset cache installer in normal
   runtime paths.
4. Real package smoke: install from packed artifacts in scratch projects for npm,
   JSR protocol package, Cargo native, Cargo WASIX, Android Gradle, SwiftPM, and
   React Native.
5. Network-off smoke: after package install, disable network and open a database
   with one contrib extension and one external extension.
6. Exact extension gate: selected extension artifacts enter the app; unselected
   extension artifacts stay out.
7. Publish idempotency gate: already-published registry artifacts with matching
   version/provenance skip; GitHub assets with matching checksum skip; mismatched
   bytes fail.
8. Release-plan gate: contrib source/runtime-contract changes release contrib
   products only; external extension source changes release that external
   extension only; runtime ABI changes release compatible runtime and extension
   products.

Enforcement ownership:

- `tools/dev/bun.sh tools/release/release-consumer-shape.mjs` validates
  structured package manifests, registry carriers, platform selectors,
  exact-extension targets, and the Moon tasks that own executable consumer
  proofs. It does not scan implementation spelling or documentation prose.
- Product `package` and `release-check` tasks own packed-package, clean-project,
  no-network, and runtime behavior. Candidate CI executes those tasks on the
  runner and artifact combinations they require.
- The Rust package-shape check builds a scratch Cargo application from the
  generated `oliphaunt` release source, calls `oliphaunt-build`, and verifies
  that native-runtime and broker-helper artifacts are staged into the generated
  lockfile.

Remove these gates and policies:

- checks requiring TypeScript runtime GitHub downloads;
- checks requiring Android GitHub asset downloads;
- checks treating `oliphaunt-resources --resolve-release-assets` as consumer DX;
- WASIX checks that keep an inert `bundled` feature;
- docs that present env vars as normal consumer setup;
- duplicate Kotlin asset resolver code outside the Android Gradle plugin.
- Swift metadata gates that forbid generated extension products.

## Implementation Order

1. Replace public docs with the target DX above.
2. Add generated descriptor schema for runtime, extension, ICU, and platform
   artifacts.
3. Add JS `liboliphaunt` and broker platform packages.
4. Remove JS runtime GitHub download paths and update tests to expect missing
   package errors.
5. Generate npm extension descriptor/platform packages for all exact extension
   products.
6. Add JS bundler/package smokes.
7. Add Cargo native runtime, broker, extension, and ICU artifact crates.
8. Add the derived `oliphaunt-build` crate and Rust native build integration.
9. Switch Rust WASIX to Cargo-selected artifact crates,
   `oliphaunt-build` manifest loading, and no public env-var archive setup.
10. Publish Android runtime and extension artifacts to Maven and replace Gradle
   downloads with dependency resolution.
11. Generate SwiftPM extension products and `OliphauntICU` in the release
    manifest.
12. Implement React Native iOS staging from installed npm packages.
13. Add ICU data packages and capability validation.
14. Update release CI to the minimal gates above.
15. Delete obsolete release metadata checks, docs, tests, and environment
    overrides tied to removed paths.
