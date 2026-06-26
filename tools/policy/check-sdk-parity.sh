#!/usr/bin/env sh
set -eu

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
. "$script_dir/sdk-check-lib.sh"

require_command node

require_file README.md
require_file docs/internal/OLIPHAUNT_README.md
require_file src/docs/content/reference/sdk-products.mdx
require_file docs/maintainers/sdk-products-policy.md
require_file tools/policy/sdk-manifest.toml
require_file docs/maintainers/rust-sdk-policy.md
require_file src/sdks/swift/README.md
require_file src/sdks/kotlin/README.md
require_file src/sdks/react-native/README.md
require_file src/sdks/js/README.md
require_file docs/maintainers/repo-structure.md
require_file src/docs/content/learn/native-runtime.mdx
require_file src/docs/content/sdk/wasm/runtime.mdx
require_file docs/maintainers/wasm-usage-legacy.md
require_file docs/maintainers/sdk-parity-policy.md
require_file docs/maintainers/sdk-api-surface.md
require_file src/shared/fixtures/protocol/query-response-cases.json
require_file src/docs/content/sdk/react-native/architecture.mdx
require_file src/docs/content/learn/mobile-stability.mdx
require_file tools/policy/check-native-boundaries.sh
require_file tools/policy/check-mobile-extension-artifacts.sh
require_file src/sdks/react-native/OliphauntReactNative.podspec
require_file src/sdks/react-native/android/settings.gradle
require_file src/sdks/react-native/android/build.gradle
require_file src/sdks/react-native/ios/OliphauntAdapter.swift
require_file src/sdks/react-native/android/src/main/java/dev/oliphaunt/reactnative/OliphauntModule.kt
require_file src/sdks/swift/Sources/COliphaunt/include/module.modulemap
require_file src/sdks/swift/Sources/COliphaunt/include/oliphaunt.h
require_file src/sdks/react-native/examples/expo/package.json
require_file src/sdks/react-native/examples/expo/eas.json
require_file src/sdks/react-native/examples/expo/src/SmokeDashboard.tsx
require_file src/sdks/react-native/examples/expo/src/sqlite-benchmark.ts
require_file src/sdks/react-native/tools/expo-android-runner.sh
require_file src/sdks/react-native/tools/expo-ios-runner.sh
require_file src/runtimes/liboliphaunt/native/patches/postgresql-18.4/0007-liboliphaunt-disable-shell-commands-on-apple-mobile.patch
require_file src/runtimes/liboliphaunt/native/patches/postgresql-18.4/0008-liboliphaunt-clean-embedded-symbols.patch
require_file src/runtimes/liboliphaunt/native/bin/check-postgres18-ios-simulator.sh
require_file src/runtimes/liboliphaunt/native/bin/build-postgres18-ios-simulator.sh
require_file src/runtimes/liboliphaunt/native/bin/build-ios-extension-xcframeworks.sh
require_file src/sdks/rust/src/config.rs
require_file src/sdks/rust/src/builder.rs
require_file src/sdks/rust/tests/sdk_config_modes.rs
require_file src/sdks/rust/tests/sdk_shape.rs
require_file src/sdks/rust/tests/sdk_native_smoke.rs
require_file src/sdks/kotlin/oliphaunt/src/androidUnitTest/kotlin/dev/oliphaunt/OliphauntAndroidRuntimeAssetsTest.kt
require_file src/sdks/kotlin/oliphaunt/src/androidUnitTest/kotlin/dev/oliphaunt/OliphauntAndroidDefaultEngineTest.kt
require_file src/sdks/rust/src/error.rs
require_file src/sdks/rust/src/query.rs
require_file src/sdks/rust/tests/protocol_query_fixtures.rs
require_file src/sdks/rust/tests/sdk_extensions.rs
require_file src/sdks/swift/Sources/Oliphaunt/OliphauntQuery.swift
require_file src/sdks/swift/Sources/Oliphaunt/Oliphaunt.swift
require_file src/sdks/swift/Tests/OliphauntTests/OliphauntTests.swift
require_file src/sdks/swift/Tests/OliphauntTests/ProtocolFixtureTests.swift
require_file src/sdks/kotlin/oliphaunt/src/commonMain/kotlin/dev/oliphaunt/Query.kt
require_file src/sdks/kotlin/oliphaunt/src/commonMain/kotlin/dev/oliphaunt/Oliphaunt.kt
require_file src/sdks/kotlin/oliphaunt/src/commonTest/kotlin/dev/oliphaunt/OliphauntDatabaseTest.kt
require_file src/sdks/kotlin/oliphaunt/src/jvmTest/kotlin/dev/oliphaunt/SharedProtocolFixtureTest.kt
require_file src/sdks/react-native/src/query.ts
require_file src/sdks/react-native/src/client.ts
require_file src/sdks/react-native/src/specs/NativeOliphaunt.ts
require_file src/sdks/react-native/src/__tests__/client.test.ts
require_file src/sdks/react-native/src/__tests__/protocol-fixtures.test.ts
require_file src/sdks/react-native/src/index.ts
require_file src/sdks/js/package.json
require_file src/sdks/js/jsr.json
require_file src/sdks/js/src/index.ts
require_file src/sdks/js/src/client.ts
require_file src/sdks/js/src/query.ts
require_file src/sdks/js/src/runtime/broker.ts
require_file src/sdks/js/src/__tests__/client.test.ts
require_file src/sdks/js/src/__tests__/protocol-fixtures.test.ts
require_text src/sdks/swift/tools/check-sdk.sh 'ProtocolFixtureTests.swift' \
  "Swift SDK packaging check must include the shared protocol fixture test file"

node tools/policy/generate-sdk-api-surface.mjs --check
node tools/policy/check-sdk-doc-examples.mjs
tools/policy/check-native-boundaries.sh

if ! cmp -s src/runtimes/liboliphaunt/native/include/oliphaunt.h src/sdks/swift/Sources/COliphaunt/include/oliphaunt.h; then
  echo "Swift COliphaunt packaged C ABI header must match src/runtimes/liboliphaunt/native/include/oliphaunt.h" >&2
  exit 1
fi
if ! cmp -s src/runtimes/liboliphaunt/native/include/oliphaunt.h src/sdks/react-native/android/src/main/cpp/include/oliphaunt.h; then
  echo "React Native Android packaged C ABI header must match src/runtimes/liboliphaunt/native/include/oliphaunt.h" >&2
  exit 1
fi

require_text docs/internal/OLIPHAUNT_README.md 'and `src/sdks/js/`: platform and runtime SDKs.' \
  "internal Oliphaunt README must classify Rust as an SDK peer"
require_text docs/internal/OLIPHAUNT_README.md '- `src/runtimes/liboliphaunt/native/`: C ABI, PostgreSQL 18 source pin, patch stack, native build and' \
  "internal Oliphaunt README must use the canonical liboliphaunt directory name"
require_text docs/internal/OLIPHAUNT_README.md '- `tools/policy/sdk-manifest.toml`: SDK ownership registry used by parity checks.' \
  "internal Oliphaunt README must mention the SDK ownership registry"
require_manifest_text rust 'classification = "sdk"' \
  "SDK manifest must classify Rust as a product SDK"
require_manifest_text rust 'implementation_path = "src/sdks/rust"' \
  "SDK manifest must point Rust SDK ownership at the Rust crate"
require_manifest_text rust 'primary_targets = ["tauri", "rust-desktop"]' \
  "SDK manifest must classify Rust as the Tauri/Rust desktop SDK"
require_manifest_text rust 'available_modes = ["native-direct", "native-broker", "native-server"]' \
  "SDK manifest must declare Rust mode availability"
require_manifest_text rust 'artifact_resolution = "cargo-artifact-crates"' \
  "SDK manifest must declare Rust Cargo artifact runtime resolution"
require_manifest_text rust 'tool_resolution = "split-oliphaunt-tools-cargo-crates"' \
  "SDK manifest must declare Rust split oliphaunt-tools Cargo resolution"
require_manifest_text rust 'extension_resolution = "exact-extension-cargo-crates"' \
  "SDK manifest must declare Rust exact-extension Cargo resolution"
require_manifest_text rust 'resource_override = "OLIPHAUNT_RESOURCES_DIR"' \
  "SDK manifest must declare Rust's explicit local runtime-resource override"
require_text src/sdks/rust/crates/oliphaunt-build/src/lib.rs "runtime/bin/psql" \
  "Rust oliphaunt-build must validate psql in split native-tools artifact manifests"
require_text src/sdks/rust/crates/oliphaunt-build/src/lib.rs "bin/pg_ctl.wasix.wasm" \
  "Rust oliphaunt-build must reject pg_ctl from split WASIX tools artifact manifests"
require_text src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/aot.rs 'TOOL_AOT_ARTIFACTS: &[&str] = &["tool:pg_dump", "tool:psql"]' \
  "WASIX SDK must define the exact split tools AOT artifact set"
require_text src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/aot.rs "validate_tools_aot_manifest_artifacts(&tools_manifest.artifacts)" \
  "WASIX SDK must validate split tools AOT manifests before merging them into the runtime AOT namespace"
require_text src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/aot.rs "tools AOT manifest contains unexpected artifact" \
  "WASIX SDK must reject non-tool artifacts from split tools AOT manifests"
require_text src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/aot.rs "tools AOT manifest is missing required artifact" \
  "WASIX SDK must reject split tools AOT manifests that omit pg_dump or psql"
require_manifest_text wasix-rust 'classification = "sdk"' \
  "SDK manifest must classify WASIX Rust as a product SDK"
require_manifest_text wasix-rust 'package_name = "oliphaunt-wasix"' \
  "SDK manifest must name the WASIX Rust registry package"
require_manifest_text wasix-rust 'implementation_path = "src/bindings/wasix-rust/crates/oliphaunt-wasix"' \
  "SDK manifest must point WASIX Rust ownership at the WASIX binding crate"
require_manifest_text wasix-rust 'primary_targets = ["wasix", "wasm"]' \
  "SDK manifest must classify WASIX Rust as the WASIX/WASM SDK"
require_manifest_text wasix-rust 'runtime_boundary = "oliphaunt-wasix"' \
  "SDK manifest must classify the WASIX Rust runtime boundary"
require_manifest_text wasix-rust 'parity_role = "wasm-peer"' \
  "SDK manifest must classify WASIX Rust as a WASM peer SDK"
require_manifest_text wasix-rust 'available_modes = ["wasix-direct", "wasix-server"]' \
  "SDK manifest must declare WASIX Rust mode availability"
require_manifest_text wasix-rust 'unsupported_modes = ["native-direct", "native-broker", "native-server"]' \
  "SDK manifest must declare native liboliphaunt modes as unsupported for WASIX Rust"
require_manifest_text wasix-rust 'artifact_resolution = "liboliphaunt-wasix-cargo-artifact-crates"' \
  "SDK manifest must declare WASIX Rust runtime artifact resolution"
require_manifest_text wasix-rust 'tool_resolution = "optional-oliphaunt-wasix-tools-cargo-crates"' \
  "SDK manifest must declare WASIX Rust split tools resolution"
require_manifest_text wasix-rust 'extension_resolution = "exact-extension-wasix-cargo-crates"' \
  "SDK manifest must declare WASIX Rust exact-extension Cargo resolution"
require_manifest_text wasix-rust 'resource_override = "OLIPHAUNT_WASM_GENERATED_ASSETS_DIR"' \
  "SDK manifest must declare WASIX Rust generated-asset override"
require_manifest_text swift 'classification = "sdk"' \
  "SDK manifest must classify Swift as a product SDK"
require_manifest_text swift 'primary_targets = ["ios", "macos"]' \
  "SDK manifest must classify Swift as the iOS/macOS SDK"
require_manifest_text swift 'runtime_boundary = "Oliphaunt"' \
  "SDK manifest must classify Swift as the iOS/macOS runtime boundary"
require_manifest_text swift 'available_modes = ["native-direct"]' \
  "SDK manifest must declare current Swift mode availability"
require_manifest_text swift 'unsupported_modes = ["native-broker", "native-server"]' \
  "SDK manifest must declare current Swift unsupported modes"
require_manifest_text swift 'artifact_resolution = "swiftpm-release-assets"' \
  "SDK manifest must declare SwiftPM release asset resolution"
require_manifest_text swift 'tool_resolution = "not-applicable-mobile-native-direct"' \
  "SDK manifest must declare that Swift mobile native-direct does not expose standalone PostgreSQL tools"
require_manifest_text swift 'extension_resolution = "exact-extension-xcframework-artifacts"' \
  "SDK manifest must declare Swift exact-extension XCFramework resolution"
require_manifest_text swift 'resource_override = "runtimeDirectory-resourceRoot"' \
  "SDK manifest must declare Swift's explicit local runtime-resource overrides"
require_manifest_text kotlin 'classification = "sdk"' \
  "SDK manifest must classify Kotlin as a product SDK"
require_manifest_text kotlin 'primary_targets = ["android"]' \
  "SDK manifest must classify Kotlin as the Android SDK"
require_manifest_text kotlin 'runtime_boundary = "OliphauntAndroid"' \
  "SDK manifest must classify the Kotlin Android facade as the runtime boundary"
require_manifest_text kotlin 'available_modes = ["native-direct"]' \
  "SDK manifest must declare current Kotlin mode availability"
require_manifest_text kotlin 'unsupported_modes = ["native-broker", "native-server"]' \
  "SDK manifest must declare current Kotlin unsupported modes"
require_manifest_text kotlin 'artifact_resolution = "maven-runtime-artifacts"' \
  "SDK manifest must declare Kotlin Maven runtime artifact resolution"
require_manifest_text kotlin 'tool_resolution = "not-applicable-mobile-native-direct"' \
  "SDK manifest must declare that Kotlin Android native-direct does not expose standalone PostgreSQL tools"
require_manifest_text kotlin 'extension_resolution = "exact-extension-maven-artifacts"' \
  "SDK manifest must declare Kotlin exact-extension Maven resolution"
require_manifest_text kotlin 'resource_override = "runtimeDirectory-resourceRoot"' \
  "SDK manifest must declare Kotlin's explicit local runtime-resource overrides"
require_manifest_text react-native 'classification = "sdk"' \
  "SDK manifest must classify React Native as an SDK"
require_manifest_text react-native 'runtime_owner = false' \
  "SDK manifest must prevent React Native from owning a separate database runtime"
require_manifest_text react-native 'delegates_apple_to = "swift"' \
  "SDK manifest must route React Native Apple runtime behavior through Swift"
require_manifest_text react-native 'delegates_android_to = "kotlin"' \
  "SDK manifest must route React Native Android runtime behavior through Kotlin"
require_manifest_text react-native 'available_modes = ["native-direct"]' \
  "SDK manifest must declare current React Native delegated mode availability"
require_manifest_text react-native 'unsupported_modes = ["native-broker", "native-server"]' \
  "SDK manifest must declare current React Native unsupported modes"
require_manifest_text react-native 'artifact_resolution = "delegated-swiftpm-maven"' \
  "SDK manifest must declare React Native delegated platform artifact resolution"
require_manifest_text react-native 'tool_resolution = "delegated-platform-sdk"' \
  "SDK manifest must declare React Native delegated tool behavior"
require_manifest_text react-native 'extension_resolution = "delegated-exact-extension-artifacts"' \
  "SDK manifest must declare React Native delegated exact-extension resolution"
require_manifest_text react-native 'resource_override = "runtimeDirectory-resourceRoot"' \
  "SDK manifest must declare React Native's delegated local runtime-resource overrides"
for mobile_tool in pg_dump psql; do
  reject_tree_text src/sdks/swift/Sources "$mobile_tool" \
    "Swift native-direct must not expose standalone PostgreSQL client tools; desktop tool access belongs to Rust/TypeScript split tool packages"
  reject_tree_text src/sdks/kotlin/oliphaunt/src/commonMain "$mobile_tool" \
    "Kotlin common SDK must not expose standalone PostgreSQL client tools; Android native-direct has no mobile tool runtime"
  reject_tree_text src/sdks/kotlin/oliphaunt/src/androidMain "$mobile_tool" \
    "Kotlin Android native-direct must not expose standalone PostgreSQL client tools; Android package resources are runtime-only"
  reject_tree_text src/sdks/react-native/src "$mobile_tool" \
    "React Native must not expose a separate standalone PostgreSQL tool API; tool behavior is delegated to platform SDK capabilities"
  reject_tree_text src/sdks/react-native/ios "$mobile_tool" \
    "React Native iOS must not grow a standalone PostgreSQL tool runtime; runtime behavior delegates to Swift"
  reject_tree_text src/sdks/react-native/android/src/main "$mobile_tool" \
    "React Native Android must not grow a standalone PostgreSQL tool runtime; runtime behavior delegates to Kotlin"
done
require_manifest_text typescript 'classification = "sdk"' \
  "SDK manifest must classify TypeScript as an SDK"
require_manifest_text typescript 'package_name = "@oliphaunt/ts"' \
  "SDK manifest must name the TypeScript registry package"
require_manifest_text typescript 'primary_targets = ["node", "bun", "deno", "tauri-javascript"]' \
  "SDK manifest must classify TypeScript as the desktop JavaScript SDK"
require_manifest_text typescript 'available_modes = ["native-direct", "native-broker", "native-server"]' \
  "SDK manifest must declare TypeScript mode availability"
require_manifest_text typescript 'depends_on_rust_broker_helper = true' \
  "SDK manifest must make the TypeScript broker helper dependency explicit"
require_manifest_text typescript 'artifact_resolution = "npm-optional-platform-packages"' \
  "SDK manifest must declare TypeScript npm optional platform package resolution"
require_manifest_text typescript 'tool_resolution = "split-oliphaunt-tools-npm-packages"' \
  "SDK manifest must declare TypeScript split oliphaunt-tools npm resolution"
require_manifest_text typescript 'extension_resolution = "node-bun-exact-extension-npm-packages-prepared-runtimeDirectory-validation"' \
  "SDK manifest must declare TypeScript registry extension resolution plus prepared runtimeDirectory validation"
require_manifest_text typescript 'resource_override = "libraryPath-runtimeDirectory"' \
  "SDK manifest must declare TypeScript's explicit local native override paths"
require_text src/sdks/js/src/native/assets-deno.ts "target.toolsPackageName" \
  "TypeScript Deno native resolver must consume the split oliphaunt-tools package"
require_text src/sdks/js/src/native/assets-deno.ts "materializeDenoToolsRuntime" \
  "TypeScript Deno native resolver must merge liboliphaunt and oliphaunt-tools runtime trees"
require_text src/sdks/js/src/native/assets-deno.ts "nativeClientToolsForTarget" \
  "TypeScript Deno native resolver must validate pg_dump and psql in split tools packages"
require_text src/sdks/js/src/native/assets-node.ts "publishRuntimeCache" \
  "TypeScript Node/Bun native resolver must publish package-managed runtime caches through a staged cache root"
require_text src/sdks/js/src/native/assets-node.ts "withRuntimeCacheLock" \
  "TypeScript Node/Bun native resolver must serialize package-managed runtime cache publication"
require_text src/sdks/js/src/native/assets-node.ts ".build-" \
  "TypeScript Node/Bun native resolver must build package-managed runtime caches outside the live root"
require_text src/sdks/js/src/native/assets-deno.ts "publishDenoRuntimeCache" \
  "TypeScript Deno native resolver must publish package-managed runtime caches through a staged cache root"
require_text src/sdks/js/src/native/assets-deno.ts "withDenoRuntimeCacheLock" \
  "TypeScript Deno native resolver must serialize package-managed runtime cache publication"
require_text src/sdks/js/src/native/assets-deno.ts "deno.rename" \
  "TypeScript Deno native resolver must install finished runtime caches with runtime-owned rename"
require_text src/sdks/js/src/native/deno.ts "install.packageManaged" \
  "TypeScript Deno nativeDirect must keep registry-managed extension materialization explicitly unsupported"
require_text src/sdks/js/src/native/extension-runtime.ts "validatePreparedRuntimeExtensions" \
  "TypeScript native bindings must share prepared runtimeDirectory extension validation"
require_text src/sdks/js/src/native/assets-deno.ts "validatePreparedDenoRuntimeExtensions" \
  "TypeScript Deno native resolver must validate explicit prepared runtimeDirectory extension files"
require_text src/sdks/js/src/runtime/broker.ts "Deno nativeBroker explicit runtimeDirectory" \
  "TypeScript Deno nativeBroker must validate explicit prepared runtimeDirectory extension files"
require_text src/sdks/js/src/runtime/server.ts "resolveDenoNativeInstall" \
  "TypeScript Deno nativeServer must resolve package-managed server tools through the Deno native resolver"
require_text src/sdks/js/src/runtime/server.ts "Deno nativeServer does not automatically materialize extension packages" \
  "TypeScript Deno nativeServer must fail clearly for registry-managed extension materialization"
require_text src/sdks/js/src/runtime/broker.ts "Deno nativeBroker does not automatically materialize extension packages" \
  "TypeScript Deno nativeBroker must fail clearly for registry-managed extension materialization"
require_text src/sdks/js/src/runtime/broker.ts "brokerNativeInstallEnv(nativeInstall)" \
  "TypeScript nativeBroker restore must pass the same resolved native install environment used by broker open"
require_text src/sdks/js/src/runtime/server.ts "requireServerClientTools" \
  "TypeScript nativeServer startup must preflight split client tools for explicit and package-managed installs"
require_text src/sdks/js/src/runtime/server.ts "requireTool(toolDirectory, 'psql')" \
  "TypeScript nativeServer startup must validate psql alongside pg_dump"
require_text src/sdks/js/src/generated/extensions.ts "extensionSqlFilePrefixes" \
  "TypeScript generated extension metadata must expose noncanonical extension SQL file prefixes for package validation"
require_text src/sdks/js/src/native/assets-node.ts "requireExtensionPackagePayload" \
  "TypeScript Node/Bun exact-extension resolver must validate complete extension payload files before materialization"
require_text src/sdks/js/src/native/extension-runtime.ts "missing SQL install files" \
  "TypeScript exact-extension resolver must reject payloads missing selected extension install SQL"
require_text src/sdks/js/src/__tests__/asset-resolver.test.ts "nodeExtensionMaterializationRejectsIncompletePackagePayloads" \
  "TypeScript asset resolver tests must cover incomplete exact-extension payload rejection"
require_text docs/maintainers/sdk-products-policy.md "These are product SDKs, not auxiliary bindings." \
  "SDK maintainer policy must frame Rust/Swift/Kotlin/RN as product SDKs"
require_text docs/maintainers/sdk-products-policy.md '`tools/policy/sdk-manifest.toml` is the repo-level SDK registry kept for' \
  "SDK maintainer policy must identify the SDK ownership registry"
require_text docs/maintainers/sdk-products-policy.md 'The canonical product graph now lives' \
  "SDK maintainer policy must identify moon project manifests as the canonical product graph"
require_text src/docs/content/reference/sdk-products.mdx "Rust is the SDK for Tauri and Rust desktop apps." \
  "SDK README must state the Rust SDK target"
require_text src/docs/content/reference/sdk-products.mdx "React Native is the TypeScript/TurboModule SDK over the Swift and Kotlin SDKs." \
  "SDK README must state RN is layered over Swift/Kotlin"
require_text src/docs/content/reference/sdk-products.mdx "TypeScript is the SDK for Node.js, Bun, Deno, and Tauri JavaScript apps." \
  "SDK README must state the TypeScript SDK target"
require_text src/docs/content/reference/sdk-products.mdx "TypeScript broker mode uses a published broker helper" \
  "SDK README must make TypeScript broker helper ownership explicit"
require_text src/docs/content/reference/sdk-products.mdx 'Android calls flow through the Kotlin SDK' \
  "SDK README must route React Native Android through the Kotlin SDK"
require_text docs/maintainers/sdk-products-policy.md "Silent drift between SDKs" \
  "SDK README must require justified SDK parity gaps"
require_text docs/maintainers/rust-sdk-policy.md "The Rust SDK is a peer product SDK for Tauri and Rust desktop apps." \
  "Rust SDK README must identify Rust as a peer product SDK"
require_text docs/maintainers/rust-sdk-policy.md "Tauri desktop apps" \
  "Rust SDK README must state Tauri as the primary Rust SDK app target"
require_text src/sdks/rust/README.md "Rust is a product SDK" \
  "Rust crate README must classify Rust as a product SDK"
require_text src/sdks/rust/README.md "Swift owns iOS and macOS runtime behavior" \
  "Rust crate README must state Swift owns Apple runtime behavior"
require_text src/sdks/rust/README.md "Kotlin owns Android runtime behavior" \
  "Rust crate README must state Kotlin owns Android runtime behavior"
require_text src/sdks/rust/README.md "React Native owns the TypeScript and" \
  "Rust crate README must state React Native owns JS/TurboModule DX"
require_text src/sdks/rust/README.md "runtime behavior to those platform SDKs" \
  "Rust crate README must state React Native delegates runtime behavior"
require_text src/docs/content/learn/native-runtime.mdx "# Native Runtime" \
  "runtime docs must describe the native liboliphaunt runtime by default"
require_text src/docs/content/learn/native-runtime.mdx '| `NativeDirect` | in-process | one serialized physical session | one resident root per process | same-root logical reopen; WAL recovery after process relaunch |' \
  "runtime docs must make direct lifecycle semantics explicit"
require_text src/docs/content/learn/native-runtime.mdx "Use server mode" \
  "runtime docs must make Rust clone/executor semantics explicit"
require_text src/docs/content/learn/native-runtime.mdx 'Direct and broker mode reject `max_client_sessions` values other' \
  "runtime docs must reject fake direct/broker pool semantics"
reject_text src/docs/content/learn/native-runtime.mdx "oliphaunt-wasix" \
  "native runtime docs must not describe the legacy WASIX package"
reject_text src/docs/content/learn/native-runtime.mdx "OliphauntServer" \
  "native runtime docs must not use legacy OliphauntServer terminology"
require_text src/docs/content/sdk/wasm/runtime.mdx "# WASIX Runtime Guide" \
  "WASIX runtime docs must identify themselves as WASIX-specific"
require_text docs/maintainers/wasm-usage-legacy.md "# WASIX Usage Guide" \
  "usage docs must identify themselves as WASIX-specific"
require_text docs/maintainers/repo-structure.md "Rust-native SDK for Tauri and Rust desktop" \
  "repo structure docs must classify Rust as the Tauri/Rust desktop SDK"
require_text docs/maintainers/repo-structure.md 'tools/policy/check-native-boundaries.sh' \
  "repo structure docs must document the native/legacy boundary guard"
require_text docs/maintainers/repo-structure.md 'default feature set is intentionally' \
  "repo structure docs must document the lean xtask default feature boundary"
require_text docs/maintainers/repo-structure.md 'explicit feature flags' \
  "repo structure docs must document that legacy xtask capabilities are opt-in"
require_text docs/maintainers/repo-structure.md 'src/runtimes/liboliphaunt/native/` for C, PostgreSQL patches, and platform build scripts' \
  "repo structure docs must use the canonical liboliphaunt directory name"
require_text docs/maintainers/repo-structure.md "Swift package for iOS and macOS apps" \
  "repo structure docs must classify Swift as the iOS/macOS SDK"
require_text docs/maintainers/repo-structure.md "Kotlin Multiplatform build for" \
  "repo structure docs must classify Kotlin as the Android SDK"
require_text docs/maintainers/repo-structure.md "React Native native code should be" \
  "repo structure docs must keep React Native as platform SDK adapter glue"
require_text docs/maintainers/repo-structure.md "tools/policy/sdk-manifest.toml" \
  "repo structure docs must mention the SDK ownership registry"
require_text docs/maintainers/repo-structure.md "parity wherever the target platform can support" \
  "repo structure docs must require justified SDK parity"
require_text docs/maintainers/sdk-parity-policy.md "Rust: SDK for Tauri and Rust desktop apps;" \
  "SDK parity docs must define Rust as the Tauri/Rust SDK"
require_text docs/maintainers/sdk-parity-policy.md "Swift: Apple SDK for iOS and macOS apps;" \
  "SDK parity docs must define Swift target platforms"
require_text docs/maintainers/sdk-parity-policy.md "Kotlin: Android SDK;" \
  "SDK parity docs must define Kotlin target platforms"
require_text docs/maintainers/sdk-parity-policy.md "React Native: TypeScript/TurboModule SDK over Swift and Kotlin." \
  "SDK parity docs must define React Native ownership"
require_text docs/maintainers/sdk-parity-policy.md '`tools/policy/sdk-manifest.toml`' \
  "SDK parity docs must link the machine-checked SDK registry"
require_text docs/maintainers/sdk-parity-policy.md '[`sdk-api-surface.md`](sdk-api-surface.md)' \
  "SDK parity docs must link the generated SDK API surface inventory"
require_text docs/maintainers/sdk-parity-policy.md "WASIX Rust are peer products with" \
  "SDK parity docs must classify SDKs as peer products"
require_text docs/maintainers/sdk-parity-policy.md "WASIX Rust: Rust SDK for the WASIX/WASM runtime product." \
  "SDK parity docs must define WASIX Rust ownership"
require_text docs/maintainers/sdk-parity-policy.md 'src/shared/fixtures/protocol/query-response-cases.json' \
  "SDK parity docs must document the shared protocol fixture corpus"
require_text docs/maintainers/sdk-parity-policy.md "React Native is not a fifth runtime." \
  "SDK parity docs must forbid an independent React Native runtime"
require_text docs/maintainers/sdk-parity-policy.md "## Artifact Resolution" \
  "SDK parity docs must include the artifact-resolution contract"
require_text docs/maintainers/sdk-parity-policy.md "Explicit local override" \
  "SDK parity docs must include explicit local override paths in the artifact-resolution matrix"
require_text docs/maintainers/sdk-parity-policy.md "split \`oliphaunt-tools-*\` Cargo artifact crates copied into the runtime cache" \
  "SDK parity docs must describe Rust split tools Cargo artifact resolution"
require_text docs/maintainers/sdk-parity-policy.md "\`OLIPHAUNT_RESOURCES_DIR\`" \
  "SDK parity docs must document Rust's explicit local runtime-resource override"
require_text docs/maintainers/sdk-parity-policy.md "Cargo-resolved \`liboliphaunt-wasix-portable\`, \`oliphaunt-icu\`, and target AOT artifact crates" \
  "SDK parity docs must describe WASIX Rust runtime artifact resolution"
require_text docs/maintainers/sdk-parity-policy.md "optional \`oliphaunt-wasix-tools\` plus target tools-AOT artifact crates behind the \`tools\` feature" \
  "SDK parity docs must describe WASIX Rust split tools Cargo artifact resolution"
require_text docs/maintainers/sdk-parity-policy.md "\`OLIPHAUNT_WASM_GENERATED_ASSETS_DIR\`" \
  "SDK parity docs must document WASIX Rust's generated-asset override"
require_text docs/maintainers/sdk-parity-policy.md "split \`@oliphaunt/tools-*\` npm packages" \
  "SDK parity docs must describe TypeScript split tools npm resolution"
require_text docs/maintainers/sdk-parity-policy.md "\`libraryPath\` and \`runtimeDirectory\`" \
  "SDK parity docs must document TypeScript's explicit local native override paths"
require_text docs/maintainers/sdk-parity-policy.md "explicit prepared \`runtimeDirectory\` values are validated for selected extension files" \
  "SDK parity docs must document TypeScript prepared runtimeDirectory extension validation"
require_text docs/maintainers/sdk-parity-policy.md "\`runtimeDirectory\` or \`resourceRoot\`" \
  "SDK parity docs must document mobile SDK explicit local runtime-resource overrides"
require_text docs/maintainers/sdk-parity-policy.md "### Desktop TypeScript Deltas" \
  "SDK parity docs must describe desktop TypeScript deltas explicitly"
require_text docs/maintainers/sdk-parity-policy.md "### WASIX Rust Deltas" \
  "SDK parity docs must describe WASIX Rust deltas explicitly"
require_text docs/maintainers/sdk-parity-policy.md "The default open profile is \`runtimeFootprint: 'throughput'\` with" \
  "SDK parity docs must document the desktop TypeScript default profile"
require_text docs/maintainers/sdk-parity-policy.md "\`pg_ctl\` is intentionally absent because there is no external" \
  "SDK parity docs must document why WASIX Rust has no pg_ctl"
require_text docs/maintainers/sdk-parity-policy.md "Node.js direct mode resolves the prebuilt \`@oliphaunt/node-direct-*\`" \
  "SDK parity docs must document Node direct optional adapter resolution"
require_text docs/maintainers/sdk-parity-policy.md "not exposed in Android native-direct mode" \
  "SDK parity docs must state Android native-direct does not expose standalone PostgreSQL tools"
require_text docs/maintainers/sdk-parity-policy.md "delegated SwiftPM and Maven platform SDK resolution" \
  "SDK parity docs must state React Native artifact resolution is delegated"
require_text docs/maintainers/sdk-parity-policy.md "Cloned Rust \`Oliphaunt\` handles share one SDK executor" \
  "SDK parity docs must make cloned Rust handle/executor semantics explicit"
require_text docs/maintainers/sdk-parity-policy.md "FIFO async serial gate" \
  "SDK parity docs must make Swift session serialization explicit"
require_text docs/maintainers/sdk-parity-policy.md "delegate ordering to the platform serial session" \
  "SDK parity docs must make React Native delegated ordering explicit"
require_text docs/maintainers/sdk-parity-policy.md "Runtime footprint profiles" \
  "SDK parity docs must include the shared runtime-footprint profile contract"
require_text docs/maintainers/sdk-parity-policy.md "Startup GUC overrides" \
  "SDK parity docs must include the shared startup-GUC override contract"
require_text src/docs/content/learn/mobile-stability.mdx "- one resident backend per app process;" \
  "mobile stability docs must make direct mode's resident backend contract explicit"
require_text src/docs/content/learn/mobile-stability.mdx "- one physical session;" \
  "mobile stability docs must make direct mode's one-session contract explicit"
require_text src/docs/content/learn/mobile-stability.mdx "- serialized requests;" \
  "mobile stability docs must make direct mode's serialized-session contract explicit"
require_text src/docs/content/learn/mobile-stability.mdx "- same-root logical reopen only;" \
  "mobile stability docs must make direct mode's same-root logical reopen contract explicit"
require_text src/docs/content/learn/mobile-stability.mdx "- app-process ownership;" \
  "mobile stability docs must make direct mode's app-process ownership explicit"
require_text src/docs/content/learn/mobile-stability.mdx "prepareForBackground" \
  "mobile stability docs must document foreground/background lifecycle APIs"
require_text src/docs/content/learn/mobile-stability.mdx "resumeFromBackground" \
  "mobile stability docs must document foreground/background lifecycle APIs"
require_text src/sdks/rust/src/config.rs "pub enum RuntimeFootprintProfile" \
  "Rust SDK must expose runtime footprint profiles"
require_text src/sdks/rust/src/config.rs "BalancedMobile" \
  "Rust SDK must expose the balanced mobile footprint profile"
require_text src/sdks/rust/src/config.rs "SmallMobile" \
  "Rust SDK must expose the small mobile footprint profile"
require_text src/sdks/rust/src/config.rs '("shared_buffers", "32MB")' \
  "Rust balanced mobile profile must lower shared_buffers"
require_text src/sdks/rust/src/config.rs '("shared_buffers", "8MB")' \
  "Rust small mobile profile must use the lowest supported shared_buffers profile"
require_text src/sdks/rust/src/config.rs '("wal_buffers", "-1")' \
  "Rust balanced mobile profile must let WAL buffers autotune"
require_text src/sdks/rust/src/config.rs '("io_method", "sync")' \
  "Rust mobile profiles must disable the PG18 worker AIO path"
require_text src/sdks/rust/src/config.rs '("io_max_concurrency", "1")' \
  "Rust mobile profiles must cap PG18 IO concurrency"
require_text src/sdks/rust/src/builder.rs "pub fn runtime_footprint" \
  "Rust builder must expose runtime footprint selection"
require_text src/sdks/rust/src/builder.rs "pub fn startup_guc" \
  "Rust builder must expose startup GUC overrides"
require_text src/sdks/rust/src/builder.rs "pub fn startup_gucs" \
  "Rust builder must expose bulk startup GUC overrides"
require_text src/sdks/rust/tests/sdk_config_modes.rs "runtime_footprint_profiles_define_the_mobile_pg18_startup_contract" \
  "Rust SDK shape tests must lock the mobile PG18 startup GUC contract"
require_text src/sdks/rust/tests/sdk_config_modes.rs "direct_broker_server_lifecycle_capabilities_are_honest" \
  "Rust SDK shape tests must lock direct/broker/server lifecycle capability semantics"
require_text src/sdks/swift/Sources/Oliphaunt/Oliphaunt.swift "public enum OliphauntRuntimeFootprintProfile" \
  "Swift SDK must expose runtime footprint profiles"
require_text src/sdks/swift/Sources/Oliphaunt/Oliphaunt.swift "public var runtimeFootprint" \
  "Swift configuration must expose runtime footprint selection"
require_text src/sdks/swift/Sources/Oliphaunt/Oliphaunt.swift "public var startupGUCs" \
  "Swift configuration must expose startup GUC overrides"
require_text src/sdks/swift/Sources/Oliphaunt/Oliphaunt.swift '"shared_buffers=32MB"' \
  "Swift balanced mobile profile must mirror the Rust shared_buffers contract"
require_text src/sdks/swift/Sources/Oliphaunt/Oliphaunt.swift '"shared_buffers=8MB"' \
  "Swift small mobile profile must mirror the Rust low-memory shared_buffers contract"
require_text src/sdks/swift/Sources/Oliphaunt/Oliphaunt.swift '"wal_buffers=-1"' \
  "Swift balanced mobile profile must mirror the Rust WAL buffer contract"
require_text src/sdks/swift/Sources/Oliphaunt/Oliphaunt.swift '"io_max_concurrency=1"' \
  "Swift mobile profiles must mirror the Rust PG18 IO concurrency contract"
require_text src/sdks/swift/Tests/OliphauntTests/OliphauntTests.swift "runtimeFootprintProfilesBuildTheMobileStartupGUCContract" \
  "Swift tests must lock the mobile PG18 startup GUC contract"
require_text src/sdks/kotlin/oliphaunt/src/commonMain/kotlin/dev/oliphaunt/Oliphaunt.kt "public enum class RuntimeFootprintProfile" \
  "Kotlin SDK must expose runtime footprint profiles"
require_text src/sdks/kotlin/oliphaunt/src/commonMain/kotlin/dev/oliphaunt/Oliphaunt.kt "val runtimeFootprint" \
  "Kotlin configuration must expose runtime footprint selection"
require_text src/sdks/kotlin/oliphaunt/src/commonMain/kotlin/dev/oliphaunt/Oliphaunt.kt "val startupGucs" \
  "Kotlin configuration must expose startup GUC overrides"
require_text src/sdks/kotlin/oliphaunt/src/commonMain/kotlin/dev/oliphaunt/Oliphaunt.kt '"shared_buffers=32MB"' \
  "Kotlin balanced mobile profile must mirror the Rust shared_buffers contract"
require_text src/sdks/kotlin/oliphaunt/src/commonMain/kotlin/dev/oliphaunt/Oliphaunt.kt '"shared_buffers=8MB"' \
  "Kotlin small mobile profile must mirror the Rust low-memory shared_buffers contract"
require_text src/sdks/kotlin/oliphaunt/src/commonMain/kotlin/dev/oliphaunt/Oliphaunt.kt '"wal_buffers=-1"' \
  "Kotlin balanced mobile profile must mirror the Rust WAL buffer contract"
require_text src/sdks/kotlin/oliphaunt/src/commonMain/kotlin/dev/oliphaunt/Oliphaunt.kt '"io_max_concurrency=1"' \
  "Kotlin mobile profiles must mirror the Rust PG18 IO concurrency contract"
require_text src/sdks/kotlin/oliphaunt/src/commonTest/kotlin/dev/oliphaunt/OliphauntDatabaseTest.kt "runtimeFootprintProfilesBuildTheMobileStartupGucContract" \
  "Kotlin tests must lock the mobile PG18 startup GUC contract"
require_text src/sdks/react-native/src/client.ts "export type RuntimeFootprintProfile" \
  "React Native SDK must expose runtime footprint profiles"
require_text src/sdks/react-native/src/client.ts "engine?: 'nativeDirect'" \
  "React Native OpenConfig must only expose nativeDirect until the RN bridge supports broker/server open paths"
require_text src/sdks/react-native/src/client.ts "runtimeFootprint?: RuntimeFootprintProfile" \
  "React Native OpenConfig must expose runtime footprint selection"
require_text src/sdks/react-native/src/client.ts "startupGUCs?: ReadonlyArray<PostgresStartupGUC>" \
  "React Native OpenConfig must expose startup GUC overrides"
require_text src/sdks/react-native/src/client.ts "React Native open currently supports nativeDirect" \
  "React Native SDK must reject broker/server open requests before crossing the native bridge"
require_text src/sdks/react-native/src/__tests__/client.test.ts "testOpenRejectsBrokerServerBeforeNativeCall" \
  "React Native tests must lock broker/server open rejection before native calls"
require_text src/sdks/react-native/src/__tests__/client.test.ts "@ts-expect-error React Native open currently supports nativeDirect only." \
  "React Native tests must lock the direct-only OpenConfig type surface"
require_text src/sdks/react-native/src/client.ts "function normalizeRuntimeFootprint" \
  "React Native SDK must validate runtime footprint profiles before native calls"
require_text src/sdks/react-native/src/client.ts "function validateStartupGUCs" \
  "React Native SDK must validate startup GUC overrides before native calls"
require_text src/sdks/react-native/src/specs/NativeOliphaunt.ts "runtimeFootprint?: string" \
  "React Native Codegen config must forward runtime footprint selection"
require_text src/sdks/react-native/src/specs/NativeOliphaunt.ts "startupGUCs?: Array<string>" \
  "React Native Codegen config must forward startup GUC overrides"
require_text src/sdks/react-native/src/client.ts "config.runtimeFootprint ?? 'balancedMobile'" \
  "React Native SDK default opens must use the mobile runtime footprint profile"
require_text src/sdks/react-native/src/client.ts "durability: config.durability ?? 'balanced'" \
  "React Native SDK default opens must use the SQLite-like balanced durability profile"
require_text src/sdks/js/src/config.ts "config.runtimeFootprint ?? 'throughput'" \
  "TypeScript SDK default opens must keep the desktop throughput runtime footprint profile"
require_text src/sdks/js/src/config.ts "config.durability ?? 'safe'" \
  "TypeScript SDK default opens must keep the crash-safe desktop durability profile"
require_text src/sdks/js/README.md "Node.js resolves the matching" \
  "TypeScript README must say Node direct mode uses the prebuilt optional adapter"
require_text src/sdks/js/ARCHITECTURE.md "\`@oliphaunt/node-direct-*\` Node-API adapter optional package" \
  "TypeScript architecture docs must say Node direct uses the installed optional adapter package"
require_text src/sdks/swift/Sources/Oliphaunt/Oliphaunt.swift "durability: OliphauntDurability = .balanced" \
  "Swift SDK default opens must use the SQLite-like balanced durability profile"
require_text src/sdks/swift/Sources/Oliphaunt/Oliphaunt.swift "runtimeFootprint: OliphauntRuntimeFootprintProfile = .balancedMobile" \
  "Swift SDK default opens must use the mobile runtime footprint profile"
require_text src/sdks/kotlin/oliphaunt/src/commonMain/kotlin/dev/oliphaunt/Oliphaunt.kt "val durability: DurabilityProfile = DurabilityProfile.Balanced" \
  "Kotlin SDK default opens must use the SQLite-like balanced durability profile"
require_text src/sdks/kotlin/oliphaunt/src/commonMain/kotlin/dev/oliphaunt/Oliphaunt.kt "val runtimeFootprint: RuntimeFootprintProfile = RuntimeFootprintProfile.BalancedMobile" \
  "Kotlin SDK default opens must use the mobile runtime footprint profile"
require_text src/sdks/react-native/src/__tests__/client.test.ts "testOpenForwardsNativeRuntimeOverrides" \
  "React Native tests must prove runtime footprint and startup GUC forwarding"
require_text src/sdks/react-native/src/__tests__/client.test.ts "testOpenValidatesStartupGUCsBeforeNativeCall" \
  "React Native tests must prove startup GUC validation happens before native calls"
require_text src/sdks/react-native/ios/OliphauntAdapter.swift "parseRuntimeFootprint" \
  "React Native iOS adapter must parse runtime footprint profiles through Swift"
require_text src/sdks/react-native/ios/OliphauntAdapter.swift "startupGUCs(config, \"startupGUCs\")" \
  "React Native iOS adapter must forward startup GUC overrides through Swift"
require_text src/sdks/react-native/android/src/main/java/dev/oliphaunt/reactnative/OliphauntModule.kt "parseRuntimeFootprint" \
  "React Native Android adapter must parse runtime footprint profiles through Kotlin"
require_text src/sdks/react-native/android/src/main/java/dev/oliphaunt/reactnative/OliphauntModule.kt "startupGucs(\"startupGUCs\")" \
  "React Native Android adapter must forward startup GUC overrides through Kotlin"
require_text docs/maintainers/sdk-parity-policy.md "src/sdks/react-native/tools/expo-android-runner.sh" \
  "React Native maintainer docs must identify the real Android app smoke harness"
require_text docs/maintainers/sdk-parity-policy.md "src/sdks/react-native/tools/expo-ios-runner.sh" \
  "React Native maintainer docs must identify the iOS app smoke harness"
require_text docs/maintainers/sdk-parity-policy.md "moon run oliphaunt-react-native:smoke-mobile" \
  "React Native maintainer docs must identify the default Expo dev-client installed-app harness"
require_text docs/maintainers/sdk-parity-policy.md "EXPO_UNSTABLE_MCP_SERVER=1" \
  "React Native maintainer docs must document Expo local MCP validation"
require_text src/sdks/react-native/README.md "src/sdks/react-native/examples/expo" \
  "React Native README must identify the Expo installed-app example"
require_text src/sdks/react-native/README.md "moon run oliphaunt-react-native:smoke-mobile" \
  "React Native README must identify the default Expo dev-client installed-app validation lane"
require_text src/sdks/react-native/examples/expo/README.md "pnpm run smoke" \
  "Expo example README must document the default combined dev-client smoke harness"
require_text src/sdks/react-native/examples/expo/package.json '"smoke:android"' \
  "Expo example must expose the Android installed-app smoke command"
require_text src/sdks/react-native/examples/expo/package.json '"smoke:ios"' \
  "Expo example must expose the iOS installed-app smoke command"
require_text src/sdks/react-native/examples/expo/package.json '"smoke": "pnpm run smoke:android && pnpm run smoke:ios"' \
  "Expo example must expose the default combined dev-client smoke command"
require_text src/sdks/react-native/tools/check-sdk.sh 'rn_headers="$(prepare_scratch_dir react-native-ios-headers)"' \
  "React Native iOS syntax checks must stage synthetic headers in the task scratch dir, not shared /tmp"
require_text src/sdks/react-native/examples/expo/eas.json '"developmentClient": true' \
  "Expo example EAS development profile must build a development client"
require_text src/sdks/react-native/examples/expo/app.json '"expo-dev-client"' \
  "Expo example app config must declare the development-client plugin"
require_text src/sdks/react-native/examples/expo/app.json '"launchMode": "most-recent"' \
  "Expo example development-client plugin must launch the most recent project by default"
require_text src/sdks/react-native/examples/expo/package.json '"expo-sqlite"' \
  "Expo example must include native SQLite so mobile benchmarks can report same-device SQLite comparison data"
require_text src/sdks/react-native/examples/expo/app.json '"expo-sqlite"' \
  "Expo example app config must include the native SQLite plugin"
require_text src/sdks/react-native/examples/expo/package.json '"crash:android"' \
  "Expo example must expose the Android process-death recovery command"
require_text src/sdks/react-native/examples/expo/package.json '"crash:ios"' \
  "Expo example must expose the iOS process-death recovery command"
require_text src/sdks/react-native/examples/expo/package.json '"start": "EXPO_UNSTABLE_MCP_SERVER=1 expo start --dev-client"' \
  "Expo example must default Metro to the development-client harness with local Expo MCP capabilities, not Expo Go"
require_text src/sdks/react-native/examples/expo/package.json '"android:start": "EXPO_UNSTABLE_MCP_SERVER=1 expo start --dev-client --android"' \
  "Expo example Android start command must use the development-client harness with local Expo MCP capabilities"
require_text src/sdks/react-native/examples/expo/package.json '"ios:start": "EXPO_UNSTABLE_MCP_SERVER=1 expo start --dev-client --ios"' \
  "Expo example iOS start command must use the development-client harness with local Expo MCP capabilities"
require_text src/sdks/react-native/examples/expo/package.json '"mcp:start"' \
  "Expo example must expose the Expo local MCP dev-server command"
require_text src/sdks/react-native/examples/expo/scripts/reset-project.js "EXPO_UNSTABLE_MCP_SERVER=1 npx expo start --dev-client" \
  "Expo reset helper must keep the development-client server with local MCP capabilities as the default harness"
require_text src/sdks/react-native/examples/expo/src/SmokeDashboard.tsx "EXPO_PUBLIC_OLIPHAUNT_RUNTIME_FOOTPRINT" \
  "Expo example must forward runtime footprint tuning into installed-app smoke and benchmark runs"
require_text src/sdks/react-native/examples/expo/src/SmokeDashboard.tsx "EXPO_PUBLIC_OLIPHAUNT_STARTUP_GUCS" \
  "Expo example must forward startup GUC tuning into installed-app smoke and benchmark runs"
require_text src/sdks/react-native/examples/expo/src/SmokeDashboard.tsx "EXPO_PUBLIC_OLIPHAUNT_DURABILITY" \
  "Expo example must forward durability tuning into installed-app smoke and benchmark runs"
require_text src/sdks/react-native/examples/expo/src/SmokeDashboard.tsx "background_checkpoint" \
  "Expo benchmark dashboard must display background checkpoint latency"
require_text src/sdks/react-native/examples/expo/src/SmokeDashboard.tsx "sqliteBenchmark" \
  "Expo benchmark dashboard must include native-device SQLite comparison evidence"
require_text src/sdks/react-native/examples/expo/src/sqlite-benchmark.ts "PRAGMA journal_mode = WAL" \
  "Expo SQLite benchmark must use an explicit WAL durability model"
require_text src/sdks/react-native/examples/expo/src/sqlite-benchmark.ts "PRAGMA synchronous = \${synchronous}" \
  "Expo SQLite benchmark must map safe/balanced/fastDev to explicit synchronous settings"
require_text src/sdks/react-native/examples/expo/src/SmokeDashboard.tsx "OLIPHAUNT_EXPO_CRASH_RECOVERY_PASS" \
  "Expo example must emit a machine-readable process-death recovery pass signal"
require_text src/sdks/react-native/examples/expo/src/SmokeDashboard.tsx "liboliphauntRoot" \
  "Expo example must accept a persistent root for process-death recovery"
require_text src/sdks/react-native/src/benchmark.ts "id: 'background_checkpoint'" \
  "React Native benchmark must measure background checkpoint latency"
require_text tools/perf/matrix/run_mobile_footprint_matrix.sh "summary.json" \
  "Mobile footprint matrix must persist machine-readable summary reports"
require_text tools/perf/matrix/run_mobile_footprint_matrix.sh "crashCommand=" \
  "Mobile footprint matrix must plan process-death recovery evidence"
require_text tools/perf/matrix/run_mobile_footprint_matrix.sh "crashRecoveryElapsedMs" \
  "Mobile footprint matrix summary must include process-death recovery timing"
require_text tools/perf/matrix/run_mobile_footprint_matrix.sh "OLIPHAUNT_EXPO_ANDROID_SCRATCH" \
  "Mobile footprint matrix must isolate Android case scratch directories"
require_text tools/perf/matrix/run_mobile_footprint_matrix.sh "OLIPHAUNT_EXPO_IOS_SCRATCH" \
  "Mobile footprint matrix must isolate iOS case scratch directories"
require_text src/sdks/react-native/tools/expo-android-runner.sh "OLIPHAUNT_EXPO_MOBILE_STARTUP_GUCS" \
  "Expo Android harness must expose mobile startup GUC benchmark tuning"
require_text src/sdks/react-native/tools/expo-ios-runner.sh "OLIPHAUNT_EXPO_MOBILE_STARTUP_GUCS" \
  "Expo iOS harness must expose mobile startup GUC benchmark tuning"
require_text src/sdks/react-native/tools/expo-android-runner.sh "OLIPHAUNT_EXPO_MOBILE_RUNTIME_FOOTPRINT" \
  "Expo Android harness must expose mobile runtime footprint benchmark tuning"
require_text src/sdks/react-native/tools/expo-ios-runner.sh "OLIPHAUNT_EXPO_MOBILE_RUNTIME_FOOTPRINT" \
  "Expo iOS harness must expose mobile runtime footprint benchmark tuning"
require_text src/sdks/react-native/tools/expo-android-runner.sh "EXPO_PUBLIC_OLIPHAUNT_ROOT" \
  "Expo Android harness must pass persistent roots through the controlled dev-client Metro environment"
require_text src/sdks/react-native/tools/expo-ios-runner.sh "EXPO_PUBLIC_OLIPHAUNT_ROOT" \
  "Expo iOS harness must pass persistent roots through the controlled dev-client Metro environment"
require_text src/sdks/react-native/tools/expo-runner-android-device.sh "start_metro_if_needed crash-write" \
  "Expo Android crash recovery must run a phase-specific dev-client bundle for the write phase"
require_text src/sdks/react-native/tools/expo-runner-ios-installed-app.sh "start_metro_if_needed crash-write" \
  "Expo iOS crash recovery must run a phase-specific dev-client bundle for the write phase"
require_text src/sdks/react-native/tools/expo-runner-android-device.sh "start_metro_if_needed crash-verify" \
  "Expo Android crash recovery must run a phase-specific dev-client bundle for the verify phase"
require_text src/sdks/react-native/tools/expo-runner-ios-installed-app.sh "start_metro_if_needed crash-verify" \
  "Expo iOS crash recovery must run a phase-specific dev-client bundle for the verify phase"
require_text src/sdks/react-native/tools/expo-android-runner.sh "[ \"\$runner\" = \"crash\" ] && default_durability_profile=safe" \
  "Expo Android crash recovery must default to safe durability"
require_text src/sdks/react-native/tools/expo-ios-runner.sh "[ \"\$runner\" = \"crash\" ] && default_durability_profile=safe" \
  "Expo iOS crash recovery must default to safe durability"
require_text tools/perf/matrix/run_mobile_footprint_matrix.sh "synchronous_commit_off_does_not_guarantee_last_commit" \
  "Mobile footprint matrix must not treat balanced durability as last-commit crash evidence"
require_text src/sdks/react-native/tools/expo-runner-android-device.sh "OLIPHAUNT_EXPO_CRASH_WRITE_READY" \
  "Expo Android harness must run the process-death recovery write phase"
require_text src/sdks/react-native/tools/expo-runner-ios-installed-app.sh "OLIPHAUNT_EXPO_CRASH_WRITE_READY" \
  "Expo iOS harness must run the process-death recovery write phase"
require_text src/sdks/react-native/examples/expo/src/SmokeDashboard.tsx "OLIPHAUNT_EXPO_SMOKE_PASS" \
  "Expo example must emit a machine-readable installed-app smoke pass signal"
require_text src/sdks/react-native/tools/expo-android-runner.sh "expo prebuild --platform android" \
  "Expo Android smoke must be reproducible from a checkout without a committed android/ directory"
require_text src/sdks/react-native/tools/expo-ios-runner.sh "expo prebuild --platform ios --no-install" \
  "Expo iOS smoke must be reproducible from a checkout without a committed ios/ directory"
require_text src/sdks/react-native/tools/expo-ios-runner.sh "refusing macOS liboliphaunt.dylib" \
  "Expo iOS smoke must reject macOS liboliphaunt artifacts"
require_text src/runtimes/liboliphaunt/native/src/liboliphaunt_bootstrap.c "OLIPHAUNT_CAN_EXEC_INITDB 0" \
  "liboliphaunt bootstrap must compile out initdb process execution on Apple mobile targets"
require_text src/runtimes/liboliphaunt/native/src/liboliphaunt_bootstrap.c "hydrate the root from packaged template PGDATA before oliphaunt_init" \
  "Oliphaunt mobile bootstrap must fail with an actionable template-PGDATA error"
require_text src/runtimes/liboliphaunt/native/patches/postgresql-18.4/0007-liboliphaunt-disable-shell-commands-on-apple-mobile.patch "OLIPHAUNT_EMBEDDED_NO_SHELL_COMMANDS" \
  "PostgreSQL mobile patch must compile shell command execution out of embedded Apple mobile builds"
require_text src/runtimes/liboliphaunt/native/patches/postgresql-18.4/0007-liboliphaunt-disable-shell-commands-on-apple-mobile.patch "TARGET_OS_VISION" \
  "PostgreSQL mobile patch must cover visionOS along with iOS, tvOS, and watchOS"
require_text src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh "OLIPHAUNT_EMBEDDED_NO_SHELL_COMMANDS" \
  "PostgreSQL patch verification must include the Apple mobile shell-command guard"
require_text src/runtimes/liboliphaunt/native/tools/run-host-c-smoke.mjs "iOS liboliphaunt C source syntax check passed" \
  "C ABI conformance must include the fast iOS simulator C-source syntax guard"
require_text src/runtimes/liboliphaunt/native/bin/check-postgres18-ios-simulator.sh "PostgreSQL 18 iOS simulator embedded probe passed" \
  "liboliphaunt must expose a fast PostgreSQL iOS simulator embedded patch probe"
require_text src/runtimes/liboliphaunt/native/bin/check-postgres18-ios-simulator.sh "oliphaunt_static_extension_magic(file_scanner->static_extension)" \
  "PostgreSQL iOS simulator probe must cover static extension magic lookup"
require_text src/runtimes/liboliphaunt/native/bin/check-postgres18-ios-simulator.sh "--with-icu" \
  "PostgreSQL iOS simulator probe must exercise the ICU-enabled embedded configuration"
require_text src/runtimes/liboliphaunt/native/bin/icu.sh "U_STATIC_IMPLEMENTATION" \
  "liboliphaunt ICU helper must compile PostgreSQL as a static ICU consumer"
require_text src/runtimes/liboliphaunt/native/bin/icu.sh "files-data-static-libs-static-consumer" \
  "liboliphaunt ICU helper must keep ICU data as runtime files while linking static ICU code"
require_text src/runtimes/liboliphaunt/native/bin/icu.sh "oliphaunt_icu_stub_data_archive_ready" \
  "liboliphaunt ICU helper must reject real-data ICU static archives"
require_text src/runtimes/liboliphaunt/native/bin/icu.sh "oliphaunt_icu_files_data_ready" \
  "liboliphaunt ICU helper must verify ICU files data exists"
require_text src/runtimes/liboliphaunt/native/bin/icu.sh "oliphaunt_icu_prepare_files_data_install_dirs" \
  "liboliphaunt ICU helper must precreate nested files-data install directories"
require_text src/runtimes/liboliphaunt/native/bin/icu.sh 'PKGDATA_OPTS="$icu_pkgdata_opts"' \
  "liboliphaunt ICU helper must pass pkgdata options consistently through make install"
require_text src/runtimes/liboliphaunt/native/bin/icu.sh "oliphaunt_icu_stage_data" \
  "liboliphaunt ICU helper must stage ICU files data into the optional ICU package payload"
require_text src/runtimes/liboliphaunt/native/bin/icu.sh "oliphaunt_icu_artifacts_ready" \
  "liboliphaunt ICU helper must provide one reusable archive/header readiness gate"
require_text src/runtimes/liboliphaunt/native/bin/icu.sh "oliphaunt_icu_linked_symbols_ready" \
  "liboliphaunt ICU helper must verify ICU code is linked without embedding data symbols"
require_text src/runtimes/liboliphaunt/native/bin/icu.sh "packagedata" \
  "liboliphaunt ICU helper must explicitly build real ICU resource data"
reject_text src/runtimes/liboliphaunt/native/postgres18/source.toml "register-static-icu-data" \
  "PostgreSQL native patch stack must not register static ICU data"
require_text src/runtimes/liboliphaunt/native/src/liboliphaunt_native.c "ICU_DATA" \
  "native liboliphaunt backend must set ICU_DATA only when packaged runtime resources contain ICU data"
require_text src/runtimes/liboliphaunt/native/src/liboliphaunt_bootstrap.c "ICU_DATA" \
  "native liboliphaunt initdb fallback must set ICU_DATA only when packaged runtime resources contain ICU data"
require_text src/runtimes/liboliphaunt/native/src/liboliphaunt_bootstrap.c "--locale-provider=libc" \
  "native liboliphaunt initdb fallback must initialize the base runtime without requiring ICU data"
require_text src/runtimes/liboliphaunt/native/patches/postgresql-18.4/0016-liboliphaunt-skip-icu-collation-version-without-icu-data.patch 'getenv("ICU_DATA")' \
  "native liboliphaunt PostgreSQL patch stack must skip ICU collation version refresh when optional ICU data is absent"
require_text src/runtimes/liboliphaunt/native/bin/build-postgres18-windows.ps1 "meson-embedded-plpgsql.log" \
  "Windows native build must compile embedded PL/pgSQL objects for the liboliphaunt DLL and module artifact"
require_text src/runtimes/liboliphaunt/native/bin/build-postgres18-windows.ps1 "/DOLIPHAUNT_BUILTIN_PLPGSQL" \
  "Windows native liboliphaunt DLL must include built-in PL/pgSQL symbols"
require_text src/runtimes/liboliphaunt/native/bin/build-postgres18-windows.ps1 "Build-EmbeddedPlpgsqlModule" \
  "Windows native build must emit the embedded PL/pgSQL module required by release packaging"
require_text src/sdks/rust/src/liboliphaunt/root/runtime/locate.rs 'release_root.join("lib/modules")' \
  "Rust native runtime locator must find release-packaged embedded modules beside Windows DLL assets"
require_text src/runtimes/liboliphaunt/native/smoke/liboliphaunt_smoke.c "LANGUAGE plpgsql" \
  "native liboliphaunt smoke must execute PL/pgSQL so embedded module packaging is exercised"
require_text src/sdks/rust/src/server.rs "ICU_DATA" \
  "Rust native-server mode must set ICU_DATA only when packaged runtime resources contain ICU data"
require_text src/sdks/rust/src/server.rs "--locale-provider=libc" \
  "Rust native-server mode must initialize the base runtime without requiring ICU data"
require_text src/sdks/rust/src/liboliphaunt/root/template.rs "ICU_DATA" \
  "Rust native template PGDATA generation must set ICU_DATA only when packaged runtime resources contain ICU data"
require_text src/sdks/rust/src/liboliphaunt/root/template.rs "--locale-provider=libc" \
  "Rust native template PGDATA generation must initialize the base runtime without requiring ICU data"
require_text src/sdks/js/src/runtime/server.ts "ICU_DATA" \
  "TypeScript native-server mode must set ICU_DATA only when packaged runtime resources contain ICU data"
require_text src/sdks/js/src/runtime/server.ts "--locale-provider=libc" \
  "TypeScript native-server mode must initialize the base runtime without requiring ICU data"
require_text src/sdks/rust/src/runtime_resources.rs "NativeRuntimeFeature::Icu" \
  "native runtime resources must expose ICU as a runtime feature, not as a SQL extension"
require_text src/sdks/rust/src/runtime_resources/package.rs "remove_base_icu_data" \
  "native runtime resources must strip ICU data from base packages"
require_text src/sdks/rust/src/runtime_resources/package.rs "runtimeFeatures" \
  "native runtime resource manifests must record selected runtime features separately from extensions"
require_text src/runtimes/liboliphaunt/native/bin/build-postgres18-linux.sh 'icu_data_dir="$work_root/icu/share/icu"' \
  "Linux native build must stage ICU files data into the optional sidecar package payload"
require_text src/runtimes/liboliphaunt/native/bin/build-postgres18-linux.sh 'rm -rf "$install_dir/share/icu"' \
  "Linux native base install must remove stale bundled ICU data"
require_text src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh 'icu_data_dir="$work_root/icu/share/icu"' \
  "macOS native build must stage ICU files data into the optional sidecar package payload"
require_text src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh 'rm -rf "$install_dir/share/icu"' \
  "macOS native base install must remove stale bundled ICU data"
require_text src/runtimes/liboliphaunt/native/bin/build-postgres18-ios-simulator.sh "platform IOSSIMULATOR" \
  "iOS simulator liboliphaunt artifact build must reject non-simulator dylibs"
require_text src/runtimes/liboliphaunt/native/bin/build-postgres18-ios-simulator.sh "--with-icu" \
  "iOS simulator liboliphaunt artifact build must enable PostgreSQL ICU support"
require_text src/runtimes/liboliphaunt/native/bin/build-postgres18-ios-simulator.sh "oliphaunt_icu_linked_symbols_ready" \
  "iOS simulator artifact gate must prove ICU code is linked without embedding data symbols"
require_text src/runtimes/liboliphaunt/native/bin/build-postgres18-ios-device.sh "platform IOS" \
  "iOS device liboliphaunt artifact build must reject non-device dylibs"
require_text src/runtimes/liboliphaunt/native/bin/build-postgres18-ios-device.sh "--with-icu" \
  "iOS device liboliphaunt artifact build must enable PostgreSQL ICU support"
require_text src/runtimes/liboliphaunt/native/bin/build-postgres18-ios-device.sh "oliphaunt_icu_linked_symbols_ready" \
  "iOS device artifact gate must prove ICU code is linked without embedding data symbols"
require_text src/runtimes/liboliphaunt/native/bin/build-postgres18-android-arm64.sh "--with-icu" \
  "Android liboliphaunt artifact build must enable PostgreSQL ICU support"
require_text src/runtimes/liboliphaunt/native/bin/build-postgres18-android-arm64.sh "oliphaunt_icu_linked_symbols_ready" \
  "Android artifact gate must prove ICU code is linked without embedding data symbols"
require_text src/runtimes/liboliphaunt/native/bin/build-ios-xcframework.sh "xcodebuild -create-xcframework" \
  "iOS packaging must produce a first-class liboliphaunt XCFramework"
require_text src/runtimes/liboliphaunt/native/postgres18/source.toml '"0008-liboliphaunt-clean-embedded-symbols.patch"' \
  "PostgreSQL source manifest must include all native patch files"
require_text src/sdks/react-native/moon.yml 'command: "pnpm --dir src/sdks/react-native/examples/expo run smoke"' \
  "React Native Moon smoke task must expose the default Expo dev-client app smoke lane"
require_text src/sdks/swift/moon.yml 'command: "bash src/sdks/swift/tools/check-sdk.sh smoke-runtime"' \
  "Swift Moon smoke task must route through the SDK-owned runtime smoke"
require_text src/sdks/swift/tools/check-sdk.sh "tools/runtime/preflight.sh ios-simulator" \
  "Swift runtime smoke must include the shared PostgreSQL iOS simulator preflight"
require_text src/sdks/swift/moon.yml 'command: "bash tools/release/build-sdk-ci-artifacts.sh oliphaunt-swift"' \
  "Swift Moon package task must stage release-shaped SDK artifacts"
require_text src/sdks/swift/tools/check-sdk.sh "build-ios-xcframework.sh --check-current" \
  "Swift package shape must expose the iOS liboliphaunt artifact check"
require_text src/sdks/kotlin/moon.yml 'command: "bash src/sdks/kotlin/tools/check-sdk.sh smoke-runtime"' \
  "Kotlin Moon smoke task must route through the SDK-owned Android runtime smoke"
require_text src/sdks/kotlin/tools/check-sdk.sh "run_android_runtime_smoke" \
  "Kotlin runtime smoke must run the SDK-owned Android packaging smoke"
require_text src/sdks/kotlin/tools/check-sdk.sh "Kotlin Android smoke AAR must include the explicitly supplied liboliphaunt runtime" \
  "Kotlin runtime smoke must prove explicit Android liboliphaunt packaging"
require_text src/sdks/react-native/tools/expo-ios-runner.sh "build-postgres18-ios-simulator.sh" \
  "Expo iOS smoke must be able to build or locate the native simulator dylib"
require_text src/sdks/react-native/tools/expo-ios-runner.sh "oliphaunt_capture_build_artifact_path" \
  "Expo iOS smoke must parse native build output instead of treating build logs as artifact paths"
require_text src/sdks/react-native/tools/expo-ios-runner.sh 'node_modules/@oliphaunt/react-native/ios/podspecs' \
  "Expo iOS smoke must patch CocoaPods to the installed React Native podspec shims"
reject_text src/sdks/react-native/tools/expo-ios-runner.sh 'OLIPHAUNT_SWIFT_SDK_SOURCE_DIR="$root/src/sdks/swift" pnpm pack' \
  "Expo iOS smoke must not vendor Swift SDK source into the React Native package"
reject_text src/sdks/react-native/tools/expo-ios-runner.sh 'xcodebuild -create-xcframework' \
  "Expo iOS smoke must consume liboliphaunt XCFramework artifacts built by the native runtime builder instead of creating frameworks locally"
require_text src/sdks/react-native/tools/expo-ios-runner.sh 'liboliphaunt_pod_mode="vendored-framework"' \
  "Expo iOS smoke must default to linked liboliphaunt XCFramework artifacts"
require_text src/sdks/react-native/OliphauntReactNative.podspec "s.vendored_frameworks = vendored_frameworks" \
  "React Native iOS podspec must link selected liboliphaunt and extension XCFramework artifacts"
require_text src/sdks/react-native/tools/expo-ios-runner.sh 'OLIPHAUNT_LIBOLIPHAUNT_POD_MODE="$liboliphaunt_pod_mode"' \
  "Expo iOS smoke must pass the selected liboliphaunt pod mode into CocoaPods"
reject_text src/sdks/react-native/tools/expo-ios-runner.sh '-library "$artifact"' \
  "Expo iOS smoke must not wrap simulator dylib artifacts into dynamic-library XCFrameworks for static CocoaPods builds"
require_text src/sdks/react-native/tools/expo-android-runner.sh "oliphaunt_capture_build_artifact_path" \
  "Expo Android smoke must parse native build output instead of treating build logs as artifact paths"
reject_text src/sdks/react-native/tools/expo-android-runner.sh 'OLIPHAUNT_SWIFT_SDK_SOURCE_DIR="$root/src/sdks/swift" pnpm pack' \
  "Expo Android smoke must not vendor Swift SDK source into the React Native package"
require_text src/runtimes/liboliphaunt/native/bin/build-ios-xcframework.sh "oliphaunt_capture_build_artifact_path" \
  "iOS XCFramework packaging must parse native build output instead of treating build logs as artifact paths"
require_text docs/maintainers/sdk-parity-policy.md "Unsupported does not mean undefined." \
  "SDK parity docs must require explicit unsupported behavior"
require_text docs/maintainers/sdk-parity-policy.md "Mode support is part of the public contract, not tribal knowledge." \
  "SDK parity docs must require explicit mode support discovery"
require_text docs/maintainers/sdk-parity-policy.md "Rust is classified as an SDK, not an internal implementation detail." \
  "SDK parity docs must explicitly classify Rust as an SDK"
require_text docs/maintainers/sdk-parity-policy.md "The Rust SDK owns the runtime-resource producer contract." \
  "SDK parity docs must make Rust the runtime-resource producer"
require_text docs/maintainers/sdk-parity-policy.md "schema=oliphaunt-runtime-resources-v1" \
  "SDK parity docs must document the shared runtime-resource schema"
require_text docs/maintainers/sdk-parity-policy.md "Package-size evidence" \
  "SDK parity docs must track package-size evidence across SDKs"
require_text docs/maintainers/sdk-parity-policy.md "OliphauntRuntimeResources.packageSizeReport()" \
  "SDK parity docs must document Swift package-size report parity"
require_text docs/maintainers/sdk-parity-policy.md "OliphauntAndroid.packageSizeReport(context)" \
  "SDK parity docs must document Kotlin Android package-size report parity"
require_text docs/maintainers/sdk-parity-policy.md "Oliphaunt.packageSizeReport(...)" \
  "SDK parity docs must document React Native package-size report parity"
require_text docs/maintainers/extension-packaging-policy.md "The Rust SDK owns the runtime-resource CLI and manifest contract." \
  "Extension docs must make Rust the SDK-owned runtime-resource producer"
require_text docs/maintainers/extension-packaging-policy.md "OliphauntRuntimeResources.packageSizeReport()" \
  "Extension docs must document Swift package-size report consumption"
require_text docs/maintainers/extension-packaging-policy.md "OliphauntAndroid.packageSizeReport(context)" \
  "Extension docs must document Kotlin package-size report consumption"
require_text docs/maintainers/extension-packaging-policy.md "Oliphaunt.packageSizeReport(...)" \
  "Extension docs must document React Native package-size report consumption"
require_text src/sdks/rust/src/runtime_resources.rs "Runtime resources generated by the Rust SDK" \
  "Rust runtime-resource code must identify Rust SDK ownership"
require_text src/sdks/rust/src/bin/package_resources.rs "runtime resources from the Rust SDK for Swift, Kotlin, and React Native" \
  "Rust runtime-resource CLI help must identify Rust SDK ownership"
require_text docs/maintainers/sdk-parity-policy.md "| Typed query helpers | yes | yes, simple and parameterized result parser | yes, simple and parameterized result parser | yes, JS simple and parameterized result parser |" \
  "SDK parity docs must classify typed query helper coverage across SDKs"
require_text docs/maintainers/sdk-parity-policy.md "| Simple-query SQL validation | simple-query builders reject NUL-containing SQL before frontend frame construction | simple-query builders reject NUL-containing SQL before frontend frame construction | simple-query builders reject NUL-containing SQL before frontend frame construction | simple-query builders reject NUL-containing SQL before frontend frame construction |" \
  "SDK parity docs must classify simple-query SQL validation across SDKs"
require_text docs/maintainers/sdk-parity-policy.md "| Extended-query input validation | extended-query builders reject NUL-containing SQL and parameter lists above the PostgreSQL protocol \`Int16\` limit before frontend frame construction | extended-query builders reject NUL-containing SQL and parameter lists above the PostgreSQL protocol \`Int16\` limit before frontend frame construction | extended-query builders reject NUL-containing SQL and parameter lists above the PostgreSQL protocol \`Int16\` limit before frontend frame construction | extended-query builders reject NUL-containing SQL and parameter lists above the PostgreSQL protocol \`Int16\` limit before frontend frame construction |" \
  "SDK parity docs must classify extended-query input validation across SDKs"
require_text docs/maintainers/sdk-parity-policy.md "| Backend UTF-8 parsing | backend C-strings and text accessors reject malformed UTF-8 instead of replacement decoding | backend C-strings and text accessors reject malformed UTF-8 instead of replacement decoding | backend C-strings and text accessors reject malformed UTF-8 instead of replacement decoding | backend C-strings and text accessors reject malformed UTF-8 instead of replacement decoding |" \
  "SDK parity docs must classify strict backend UTF-8 parsing across SDKs"
require_text docs/maintainers/sdk-parity-policy.md "| Backend response validation | typed query parsers accept known simple/extended-query control tags, validate async backend control-message framing and \`ReadyForQuery\` transaction status, and reject unexpected backend tags instead of ignoring them | typed query parsers accept known simple/extended-query control tags, validate async backend control-message framing and \`ReadyForQuery\` transaction status, and reject unexpected backend tags instead of ignoring them | typed query parsers accept known simple/extended-query control tags, validate async backend control-message framing and \`ReadyForQuery\` transaction status, and reject unexpected backend tags instead of ignoring them | typed query parsers accept known simple/extended-query control tags, validate async backend control-message framing and \`ReadyForQuery\` transaction status, and reject unexpected backend tags instead of ignoring them |" \
  "SDK parity docs must classify backend response validation across SDKs"
require_text docs/maintainers/sdk-parity-policy.md "| Transaction helper | \`transaction()\` returns an explicit pinned handle; \`with_transaction(...)\` commits or rolls back an async closure; unpinned work is rejected | \`transaction {}\` uses the actor-owned session for raw and streaming work and rejects database work outside the active transaction handle | \`transaction {}\` uses the serialized session for raw and streaming work and rejects database work outside the active transaction handle | \`transaction(async tx => ...)\` preserves the platform session boundary for raw and streaming work and rejects database work outside the active transaction handle |" \
  "SDK parity docs must classify transaction helper coverage across SDKs"
require_text docs/maintainers/sdk-parity-policy.md "| Structured PostgreSQL errors | \`Error::Postgres(PostgresError)\` with SQLSTATE and raw ErrorResponse fields | \`OliphauntError.postgres(OliphauntPostgresError)\` with SQLSTATE and raw ErrorResponse fields | \`PostgresException(PostgresError)\` with SQLSTATE and raw ErrorResponse fields | \`PostgresError\` with SQLSTATE and raw ErrorResponse fields |" \
  "SDK parity docs must classify structured PostgreSQL errors across SDKs"
require_text docs/maintainers/sdk-parity-policy.md "| Streaming protocol API | \`exec_protocol_raw_stream\` | \`execProtocolStream\` | \`execProtocolStream\` | \`execProtocolStream\` over the selected raw transport; New Architecture builds use \`jsi-array-buffer\` |" \
  "SDK parity docs must classify streaming protocol coverage across SDKs"
require_text docs/maintainers/sdk-parity-policy.md "| Capability reporting | raw, stream, cancel, backup/restore, simple query, extensions, session model, multi-root support | same C ABI capability bits surfaced as Swift properties, including \`multiRoot\` | same C ABI capability bits surfaced as Kotlin properties, including \`multiRoot\` | same capability fields delegated from Swift/Kotlin, including \`multiRoot\` |" \
  "SDK parity docs must classify capability reporting across SDKs"
require_text docs/maintainers/sdk-parity-policy.md "| Backup/restore format discovery | direct/broker: physical archive; server: SQL and physical archive backup; restore: physical archive; capability and handle \`supports_backup_format\`/\`supports_restore_format\` helpers | \`backupFormats\`, \`restoreFormats\`, and capability/database \`supportsBackupFormat\`/\`supportsRestoreFormat\` helpers | \`backupFormats\`, \`restoreFormats\`, and capability/database \`supportsBackupFormat\`/\`supportsRestoreFormat\` helpers | delegated \`backupFormats\` and \`restoreFormats\` capability fields plus TypeScript \`supportsBackupFormat\`/\`supportsRestoreFormat\` helpers and matching database methods |" \
  "SDK parity docs must classify backup/restore format discovery across SDKs"
require_text docs/maintainers/sdk-parity-policy.md "| Backup format enforcement | \`EngineExecutor::backup\` rejects unsupported formats before the owner queue | \`OliphauntDatabase.backup\` rejects unsupported formats before the native session call | \`OliphauntDatabase.backup\` rejects unsupported formats before the platform session call | \`OliphauntDatabase.backup\` rejects unsupported formats before the TurboModule backup call |" \
  "SDK parity docs must classify backup format enforcement across SDKs"
require_text docs/maintainers/sdk-parity-policy.md "| Checkpoint | \`checkpoint()\` sends PostgreSQL \`CHECKPOINT\` through the opened engine and rejects while a session pin is active | \`checkpoint()\` sends PostgreSQL \`CHECKPOINT\` through the actor-owned session and rejects while a transaction is active | \`checkpoint()\` sends PostgreSQL \`CHECKPOINT\` through the serialized session and rejects while a transaction is active | \`checkpoint()\` sends PostgreSQL \`CHECKPOINT\` through the delegated platform session and rejects while a transaction is active |" \
  "SDK parity docs must classify checkpoint coverage across SDKs"
require_text docs/maintainers/sdk-parity-policy.md "| Restore format enforcement | \`Oliphaunt::restore\` rejects non-physical artifacts before target materialization | \`OliphauntDatabase.restore\` rejects non-physical artifacts before the engine call | \`OliphauntDatabase.restore\` rejects non-physical artifacts before the platform engine call | \`Oliphaunt.restore\` rejects non-physical artifacts before the TurboModule restore call |" \
  "SDK parity docs must classify restore format enforcement across SDKs"
require_text docs/maintainers/sdk-parity-policy.md "| Root validation | persistent roots are rejected when empty or NUL-containing before runtime selection; restore targets are rejected before materialization | roots must be file URLs and are rejected when empty or NUL-containing before engine calls | blank or NUL-containing open and restore roots are rejected before platform engine calls | blank or NUL-containing open and restore roots are rejected before TurboModule calls |" \
  "SDK parity docs must classify root validation across SDKs"
require_text docs/maintainers/sdk-parity-policy.md "| Mode support discovery | \`EngineCapabilities::rust_sdk_support()\` | \`OliphauntDatabase.supportedModes()\` | \`OliphauntDatabase.supportedModes()\` and \`OliphauntAndroid.supportedModes()\` | \`Oliphaunt.supportedModes()\` delegated from Swift/Kotlin |" \
  "SDK parity docs must classify mode support discovery across SDKs"
require_text docs/maintainers/sdk-parity-policy.md "| Handle/executor ownership | Cloned Rust \`Oliphaunt\` handles share one SDK executor, FIFO owner queue, session pin, cancel handle, and close state in direct, broker, and server modes; cloning is not a connection pool | Swift database values are actor-owned session handles guarded by a FIFO async serial gate; additional references share the same actor/session and server-mode independent clients must use server support when implemented | Kotlin database values are coroutine session handles guarded by \`executionMutex\`; additional references share the same coroutine/session boundary and server-mode independent clients must use server support when implemented | React Native \`OliphauntDatabase\` objects wrap the delegated Swift/Kotlin session handle and delegate ordering to the platform serial session; JS references do not create independent sessions |" \
  "SDK parity docs must classify shared-handle FIFO executor ownership across SDKs"
require_text docs/maintainers/sdk-parity-policy.md "| Connection identity | \`Oliphaunt::builder().username(...).database(...)\` feeds direct, broker, and server startup identity; invalid empty/NUL values are rejected before runtime open | \`OliphauntConfiguration(username:database:)\` feeds native-direct startup identity and rejects invalid empty/NUL values before engine open | \`OliphauntConfig(username, database)\` feeds native-direct startup identity and rejects invalid empty/NUL values before engine open | \`open({ username, database })\` forwards the same identity through Swift/Kotlin and rejects invalid empty/NUL values before the TurboModule call |" \
  "SDK parity docs must classify startup connection identity across SDKs"
require_text docs/maintainers/sdk-parity-policy.md "| Close behavior | \`Oliphaunt::close\` rejects queued work, waits for active work, then closes/detaches; use \`cancel()\` explicitly to interrupt SQL | \`OliphauntDatabase.close\` rejects queued work, waits for active work, then detaches; use \`cancel()\` explicitly to interrupt SQL | \`OliphauntDatabase.close\` rejects queued work, waits for active work, then detaches; use \`cancel()\` explicitly to interrupt SQL | \`OliphauntDatabase.close\` delegates the same wait-and-detach behavior through Swift/Kotlin |" \
  "SDK parity docs must classify close behavior across SDKs"
require_text docs/maintainers/sdk-parity-policy.md '| Rust | Tauri and Rust desktop apps | `oliphaunt` | direct, broker, server | none for the core SDK contract |' \
  "SDK parity docs must state Rust SDK target and complete mode ownership"
require_text docs/maintainers/sdk-parity-policy.md '| Swift | iOS and macOS apps | `Oliphaunt` | direct | broker/server are explicit unsupported errors until platform runtimes exist; they must not be faked through direct mode |' \
  "SDK parity docs must justify current Swift broker/server non-parity"
require_text docs/maintainers/sdk-parity-policy.md '| Kotlin | Android apps | `oliphaunt` | Android direct plus Kotlin/Native direct | Android common defaults require the `OliphauntAndroid` Context facade; JVM runtime is explicitly unavailable; Android broker/server must be separate platform adapters, not direct-mode aliases |' \
  "SDK parity docs must justify current Kotlin platform non-parity"
require_text docs/maintainers/sdk-parity-policy.md "| React Native | React Native apps | Swift on Apple, Kotlin on Android | delegated direct | New Architecture JSI ArrayBuffer transport is required for protocol, backup, and restore bytes |" \
  "SDK parity docs must justify current React Native transport/runtime stance"
require_text docs/maintainers/sdk-parity-policy.md "any future RN macOS target must use the same Swift SDK boundary" \
  "SDK parity docs must route future React Native Apple targets through Swift"
require_text docs/maintainers/sdk-parity-policy.md "RN Android delegates the same operations to the Kotlin SDK through the" \
  "SDK parity docs must route React Native Android through the Kotlin SDK facade"
require_text src/docs/content/sdk/react-native/architecture.mdx "through the Android \`dev.oliphaunt.OliphauntAndroid\` facade" \
  "React Native architecture docs must route Android through the Kotlin SDK facade"
require_text src/docs/content/sdk/react-native/architecture.mdx "returning the Kotlin SDK \`OliphauntDatabase\` handle" \
  "React Native architecture docs must keep OliphauntDatabase as the Kotlin SDK handle, not the runtime boundary"
require_text src/docs/content/sdk/react-native/architecture.mdx "\`supportedModes()\` is delegated too" \
  "React Native docs must state mode support is delegated"
require_text src/docs/content/sdk/react-native/architecture.mdx "\`Oliphaunt.restore({ libraryPath, ... })\` forwards the same native library" \
  "React Native docs must document restore library-path override forwarding"

require_text src/sdks/swift/README.md "iOS and macOS apps" \
  "Swift README must state Apple app targets"
require_text src/sdks/swift/README.md 'use the typed simple-query helper' \
  "Swift README must document typed query helper DX"
require_text src/sdks/swift/README.md 'Pass `parameters:` for PostgreSQL extended-protocol parameters' \
  "Swift README must document parameterized query helper DX"
require_text src/sdks/swift/README.md 'execProtocolStream' \
  "Swift README must document streaming raw-protocol DX"
require_text src/sdks/swift/README.md 'Capabilities report the same product contract as Rust' \
  "Swift README must document SDK capability parity"
require_text src/sdks/kotlin/README.md "Android includes a native-direct runtime over JNI" \
  "Kotlin README must state Android runtime ownership"
require_text src/sdks/kotlin/README.md 'use the typed simple-query helper' \
  "Kotlin README must document typed query helper DX"
require_text src/sdks/kotlin/README.md 'Pass a `List<QueryParam>` for PostgreSQL extended-protocol parameters' \
  "Kotlin README must document parameterized query helper DX"
require_text src/sdks/kotlin/README.md 'execProtocolStream' \
  "Kotlin README must document streaming raw-protocol DX"
require_text src/sdks/kotlin/README.md 'Capabilities report the same product contract as Rust' \
  "Kotlin README must document SDK capability parity"
require_text src/sdks/react-native/README.md "RN Android delegates to the Kotlin SDK" \
  "React Native README must state Android delegates to Kotlin"
require_text src/sdks/react-native/README.md 'through `OliphauntAndroid`' \
  "React Native README must state Android uses the Kotlin SDK facade"
require_text src/sdks/react-native/README.md 'stores the returned `OliphauntDatabase` handle' \
  "React Native README must describe OliphauntDatabase as the SDK handle returned by the Kotlin facade"
require_text src/sdks/react-native/README.md '`query(sql)` parses normal PostgreSQL backend protocol frames' \
  "React Native README must document typed query helper DX"
require_text src/sdks/react-native/README.md 'Pass query parameters as the second argument' \
  "React Native README must document parameterized query helper DX"
require_text src/sdks/react-native/README.md 'execProtocolStream' \
  "React Native README must document streaming raw-protocol DX"
require_text src/sdks/react-native/README.md 'Capabilities are delegated from the platform SDK' \
  "React Native README must document delegated capability parity"
require_text src/sdks/react-native/README.md 'Restore forwards `libraryPath` to' \
  "React Native README must document restore library-path override forwarding"
require_text src/sdks/react-native/README.md 'RN iOS delegates to `Oliphaunt`' \
  "React Native README must state iOS delegates to Swift/Oliphaunt"
require_text src/sdks/react-native/README.md "any future React Native macOS target must use the same" \
  "React Native README must route future macOS support through Swift/Oliphaunt"
require_text src/docs/content/reference/sdk-products.mdx "structured PostgreSQL error" \
  "SDK README must include structured PostgreSQL errors in the shared SDK contract"
require_text docs/maintainers/rust-sdk-policy.md "structured PostgreSQL errors with SQLSTATE" \
  "Rust SDK README must document structured PostgreSQL error parity"
require_text docs/maintainers/rust-sdk-policy.md "transaction helpers that keep one physical session pinned" \
  "Rust SDK README must document transaction helper parity"
require_text docs/maintainers/rust-sdk-policy.md "pinned raw and streaming protocol calls" \
  "Rust SDK README must document pinned transaction streaming parity"
require_text docs/maintainers/rust-sdk-policy.md "\`with_transaction(async |tx| { ... })\`" \
  "Rust SDK README must document closure transaction helper parity"
require_text docs/maintainers/rust-sdk-policy.md "\`checkpoint()\` for explicit PostgreSQL checkpoint requests" \
  "Rust SDK README must document checkpoint parity"
require_text docs/maintainers/rust-sdk-policy.md "SDK-owned executable/tooling paths" \
  "Rust SDK README must document executable/tooling path validation"
require_text docs/maintainers/rust-sdk-policy.md "\`EngineCapabilities::rust_sdk_support()\`" \
  "Rust SDK README must document mode support discovery"
require_text docs/maintainers/rust-sdk-policy.md "concrete backup and restore format support" \
  "Rust SDK README must document backup/restore format support discovery"
require_text docs/maintainers/rust-sdk-policy.md "capability and opened-handle \`supports_backup_format\` and" \
  "Rust SDK README must document backup/restore helper APIs"
require_text docs/maintainers/rust-sdk-policy.md "direct and broker mode reject values other than \`1\`" \
  "Rust SDK README must document honest max_client_sessions semantics"
require_text docs/maintainers/rust-sdk-policy.md "SDK-boundary rejection for unsupported backup formats" \
  "Rust SDK README must document backup format enforcement"
require_text docs/maintainers/rust-sdk-policy.md "unsupported restore formats before a target" \
  "Rust SDK README must document restore format enforcement"
require_text src/sdks/swift/README.md "OliphauntError.postgres(OliphauntPostgresError)" \
  "Swift README must document structured PostgreSQL errors"
require_text src/sdks/swift/README.md "Use \`transaction {}\` for multi-step work" \
  "Swift README must document transaction helper DX"
require_text src/sdks/swift/README.md "Use \`checkpoint()\` to request a PostgreSQL checkpoint" \
  "Swift README must document checkpoint DX"
require_text src/sdks/swift/README.md "\`OliphauntDatabase.supportedModes()\`" \
  "Swift README must document mode support discovery"
require_text src/sdks/swift/README.md "concrete backup/restore formats" \
  "Swift README must document backup/restore format support discovery"
require_text src/sdks/swift/README.md "on either \`OliphauntCapabilities\` or \`OliphauntDatabase\`" \
  "Swift README must document backup/restore helper APIs"
require_text src/sdks/swift/README.md "\`backup(_:)\` enforces" \
  "Swift README must document backup format enforcement"
require_text src/sdks/swift/README.md "\`OliphauntDatabase.restore\` rejects unsupported restore artifact formats" \
  "Swift README must document restore format enforcement"
require_text src/sdks/kotlin/README.md "PostgresException(PostgresError)" \
  "Kotlin README must document structured PostgreSQL errors"
require_text src/sdks/kotlin/README.md "Use \`database.transaction { tx -> ... }\`" \
  "Kotlin README must document transaction helper DX"
require_text src/sdks/kotlin/README.md "Use \`database.checkpoint()\` to request a PostgreSQL checkpoint" \
  "Kotlin README must document checkpoint DX"
require_text src/sdks/kotlin/README.md "\`OliphauntAndroid.supportedModes()\` reports the same Android facade contract" \
  "Kotlin README must document Android mode support discovery"
require_text src/sdks/kotlin/README.md "concrete backup/restore formats" \
  "Kotlin README must document backup/restore format support discovery"
require_text src/sdks/kotlin/README.md "on either \`EngineCapabilities\` or \`OliphauntDatabase\`" \
  "Kotlin README must document backup/restore helper APIs"
require_text src/sdks/kotlin/README.md "\`backup(...)\` enforces" \
  "Kotlin README must document backup format enforcement"
require_text src/sdks/kotlin/README.md "\`OliphauntDatabase.restore(...)\` rejects unsupported restore artifact formats" \
  "Kotlin README must document restore format enforcement"
require_text src/sdks/react-native/README.md "structured PostgreSQL errors through" \
  "React Native README must document structured PostgreSQL errors"
require_text src/sdks/react-native/README.md "\`OliphauntDatabase.transaction(async tx => ...)\`" \
  "React Native README must document transaction helper DX"
require_text src/sdks/react-native/README.md "\`OliphauntDatabase.checkpoint()\`" \
  "React Native README must document checkpoint DX"
require_text src/sdks/react-native/README.md "\`Oliphaunt.supportedModes()\`" \
  "React Native README must document mode support discovery"
require_text src/sdks/react-native/README.md "currently accepts \`nativeDirect\` only" \
  "React Native README must document that mode discovery is broader than the current open surface"
require_text src/sdks/react-native/README.md "\`backupFormats\` and \`restoreFormats\`" \
  "React Native README must document backup/restore format support discovery"
require_text src/sdks/react-native/README.md "\`OliphauntDatabase.supportsBackupFormat\` and" \
  "React Native README must document backup/restore helper APIs"
require_text src/sdks/react-native/README.md "\`OliphauntDatabase.backup\` enforces" \
  "React Native README must document backup format enforcement"
require_text src/sdks/react-native/README.md "\`Oliphaunt.restore\` rejects unsupported restore artifact formats" \
  "React Native README must document restore format enforcement"
require_text src/sdks/swift/Tests/OliphauntTests/OliphauntTests.swift "try await transaction.execProtocolStream" \
  "Swift SDK tests must prove transaction-scoped streaming"
require_text src/sdks/kotlin/oliphaunt/src/commonTest/kotlin/dev/oliphaunt/OliphauntDatabaseTest.kt "transaction.execProtocolStream" \
  "Kotlin SDK tests must prove transaction-scoped streaming"
require_text src/sdks/react-native/src/__tests__/client.test.ts "await tx.execProtocolStream" \
  "React Native SDK tests must prove transaction-scoped streaming"
require_text src/sdks/swift/Tests/OliphauntTests/OliphauntTests.swift "SELECT after_rollback" \
  "Swift SDK tests must prove captured transaction handles are inactive after rollback"
require_text src/sdks/kotlin/oliphaunt/src/commonTest/kotlin/dev/oliphaunt/OliphauntDatabaseTest.kt "SELECT after_rollback" \
  "Kotlin SDK tests must prove captured transaction handles are inactive after rollback"
require_text src/sdks/react-native/src/__tests__/client.test.ts "SELECT after_rollback" \
  "React Native SDK tests must prove captured transaction handles are inactive after rollback"
require_text src/sdks/rust/tests/sdk_shape.rs "close_during_transaction_stops_session_and_rejects_pinned_work" \
  "Rust SDK tests must prove close during a transaction is a lifecycle boundary"
require_text src/sdks/swift/Tests/OliphauntTests/OliphauntTests.swift "closeDuringTransactionClosesSessionAndRejectsPinnedWork" \
  "Swift SDK tests must prove close during a transaction is a lifecycle boundary"
require_text src/sdks/kotlin/oliphaunt/src/commonTest/kotlin/dev/oliphaunt/OliphauntDatabaseTest.kt "closeDuringTransactionClosesSessionAndRejectsPinnedWork" \
  "Kotlin SDK tests must prove close during a transaction is a lifecycle boundary"
require_text src/sdks/react-native/src/__tests__/client.test.ts "testCloseDuringTransactionClosesSessionAndRejectsPinnedWork" \
  "React Native SDK tests must prove close during a transaction is a lifecycle boundary"
require_text src/sdks/swift/Sources/Oliphaunt/Oliphaunt.swift "private actor OliphauntAsyncSerialGate" \
  "Swift SDK must enforce an explicit FIFO gate instead of relying on actor non-reentrancy"
require_text src/sdks/swift/Tests/OliphauntTests/OliphauntTests.swift "sessionOperationsQueueFifoAcrossConcurrentTasks" \
  "Swift SDK tests must prove concurrent database calls use FIFO session ordering"
require_text src/sdks/swift/Tests/OliphauntTests/OliphauntTests.swift "closeRejectsQueuedWorkBeforeNativeSessionCall" \
  "Swift SDK tests must prove close rejects queued work before it reaches the native session"

require_text src/sdks/react-native/OliphauntReactNative.podspec 's.dependency "Oliphaunt"' \
  "React Native podspec must depend on the Swift SDK"
require_text src/sdks/react-native/app.plugin.js "ios/podspecs" \
  "React Native Expo config plugin must resolve Swift SDK pods through npm-shipped podspec shims"
require_text src/sdks/react-native/app.plugin.js "pod 'COliphaunt', :podspec => File.join(oliphaunt_podspecs_path, 'COliphaunt.podspec')" \
  "React Native Expo config plugin must inject the C bridge podspec shim instead of requiring CocoaPods trunk"
require_text src/sdks/react-native/ios/podspecs/Oliphaunt.podspec "src/sdks/swift/Sources/Oliphaunt/**/*.swift" \
  "React Native package must point CocoaPods at the released Swift SDK source instead of vendoring it"
require_text src/sdks/react-native/ios/podspecs/COliphaunt.podspec "src/sdks/swift/Sources/COliphaunt/include/oliphaunt.h" \
  "React Native package must point CocoaPods at the released C ABI header instead of vendoring it"
require_text src/sdks/react-native/OliphauntReactNative.podspec 's.source_files = "ios/*.{h,m,mm,swift}", "ios/generated/static-registry/*.c"' \
  "React Native podspec must compile bridge sources and the generated mobile static-extension registry only"
require_file src/sdks/react-native/ios/OliphauntReactNative.h
reject_file src/sdks/react-native/ios/Oliphaunt.h \
  "React Native Objective-C headers must not case-collide with the lowercase liboliphaunt C ABI header"
require_text src/sdks/react-native/ios/Oliphaunt.mm '#import "OliphauntReactNative.h"' \
  "React Native implementation must import the package-specific Objective-C header name"
require_text src/sdks/react-native/OliphauntReactNative.podspec 's.resources = resource_bundle' \
  "React Native podspec must copy the prebuilt Oliphaunt resource bundle as an app resource"
require_text src/sdks/react-native/OliphauntReactNative.podspec 'ios/extension-frameworks/**/*.xcframework' \
  "React Native podspec must treat selected iOS extension XCFrameworks as link inputs instead of app resources"
require_text src/sdks/react-native/ios/podspecs/COliphaunt.podspec 's.module_map = "src/sdks/swift/Sources/COliphaunt/include/module.modulemap"' \
  "React Native C bridge podspec shim must expose a module map for CocoaPods integration"
require_text src/sdks/react-native/tools/expo-ios-runner.sh "stamp_expo_modules_jsi_prebuilt" \
  "Expo iOS smoke must keep local Xcode beta validation on Expo's prebuilt JSI xcframework path"
require_text src/sdks/react-native/tools/expo-ios-runner.sh "patch_expo_modules_jsi_for_host_toolchain" \
  "Expo iOS smoke must adapt ExpoModulesJSI source builds to the local Swift beta compiler when needed"
require_text src/sdks/react-native/tools/expo-ios-runner.sh "OLIPHAUNT_EXPO_IOS_USE_PRECOMPILED_MODULES:-true" \
  "Expo iOS smoke must default to Expo precompiled modules for fast local and CI validation"
require_text src/sdks/react-native/tools/expo-ios-runner.sh "pod install --repo-update" \
  "Expo iOS smoke must refresh CocoaPods specs when source-built Expo modules require pods outside the local cache"
require_text src/sdks/react-native/tools/expo-ios-runner.sh '-clonedSourcePackagesDirPath "$xcode_source_packages"' \
  "Expo iOS smoke must isolate Xcode SwiftPM source packages inside the smoke scratch directory"
require_text src/sdks/react-native/tools/expo-ios-runner.sh '-packageCachePath "$xcode_package_cache"' \
  "Expo iOS smoke must isolate Xcode SwiftPM package cache inside the smoke scratch directory"
require_text src/sdks/react-native/tools/expo-ios-runner.sh "-skipPackageUpdates" \
  "Expo iOS smoke must not update SwiftPM packages during deterministic CI builds"
require_text src/sdks/react-native/tools/expo-ios-runner.sh ":modular_headers => true" \
  "Expo iOS smoke must integrate the local C bridge as a modular header pod"
require_text src/sdks/react-native/android/settings.gradle 'project(":oliphaunt").projectDir = localKotlinSdkDir' \
  "React Native Android settings must include the local Kotlin SDK project"
require_text src/sdks/react-native/android/build.gradle "implementation localKotlinSdkProject" \
  "React Native Android must depend on the Kotlin SDK when built locally"
require_text src/sdks/react-native/ios/OliphauntAdapter.swift "import Oliphaunt" \
  "React Native iOS adapter must import the Swift SDK"
require_text src/sdks/react-native/android/src/main/java/dev/oliphaunt/reactnative/OliphauntModule.kt "import dev.oliphaunt.OliphauntAndroid" \
  "React Native Android module must import the Kotlin SDK facade"
require_text src/sdks/rust/src/engine.rs "pub struct EngineModeSupport" \
  "Rust SDK must expose an explicit mode support contract"
require_text src/sdks/rust/src/database.rs "pub async fn transaction(&self) -> Result<Transaction>" \
  "Rust SDK must expose a transaction helper"
require_text src/sdks/rust/src/database.rs "pub async fn with_transaction<T>" \
  "Rust SDK must expose a closure transaction helper"
require_text src/sdks/rust/src/database.rs "pub async fn exec_protocol_raw_stream<F>" \
  "Rust SDK session pins and transactions must expose pinned streaming protocol calls"
require_text src/sdks/rust/src/database.rs "pub async fn checkpoint(&self) -> Result<()>" \
  "Rust SDK must expose checkpoint"
require_text src/sdks/rust/src/engine.rs "pub multi_root: bool" \
  "Rust SDK capabilities must expose multi-root support"
require_text src/sdks/rust/src/engine.rs "pub backup_formats: Vec<BackupFormat>" \
  "Rust SDK capabilities must expose supported backup formats"
require_text src/sdks/rust/src/engine.rs "pub restore_formats: Vec<BackupFormat>" \
  "Rust SDK capabilities must expose supported restore formats"
require_text src/sdks/rust/src/engine.rs "pub fn supports_backup_format(&self, format: BackupFormat) -> bool" \
  "Rust SDK capabilities must expose backup format helper"
require_text src/sdks/rust/src/engine.rs "pub fn supports_restore_format(&self, format: BackupFormat) -> bool" \
  "Rust SDK capabilities must expose restore format helper"
require_text src/sdks/rust/src/database.rs "pub fn supports_backup_format(&self, format: BackupFormat) -> bool" \
  "Rust SDK opened handle must expose backup format helper"
require_text src/sdks/rust/src/database.rs "pub fn supports_restore_format(&self, format: BackupFormat) -> bool" \
  "Rust SDK opened handle must expose restore format helper"
require_text src/sdks/rust/src/executor.rs "if !self.capabilities.supports_backup_format(request.format)" \
  "Rust SDK backup must reject unsupported formats before engine execution"
require_text src/sdks/rust/src/executor.rs "Command::Backup { request, reply } =>" \
  "Rust SDK backup must route through the owner executor"
require_text src/sdks/rust/src/executor.rs "Err(Error::SessionPinned)" \
  "Rust SDK owner executor must reject unpinned work while a session pin is active"
require_text src/sdks/rust/src/backup.rs "restore currently requires a physical archive artifact" \
  "Rust SDK restore must reject unsupported formats before target materialization"
require_text src/sdks/rust/src/config.rs "database root must not be empty" \
  "Rust SDK open config must reject empty persistent roots before runtime selection"
require_text src/sdks/rust/src/config.rs "database root must not contain NUL bytes" \
  "Rust SDK open config must reject NUL-containing persistent roots before runtime selection"
require_text src/sdks/rust/src/config.rs "native broker max_client_sessions must be exactly 1" \
  "Rust SDK broker mode must reject fake multi-session pools before helper startup"
require_text src/sdks/rust/src/config.rs "validate_config_path(\"initdb path\", initdb)" \
  "Rust SDK initdb tooling path must reject malformed paths before startup"
require_text src/sdks/rust/src/config.rs "validate_config_path(\"native broker executable path\", executable)" \
  "Rust SDK broker executable path must reject malformed paths before helper startup"
require_text src/sdks/rust/src/config.rs "validate_config_path(\"native server executable path\", executable)" \
  "Rust SDK server executable path must reject malformed paths before process startup"
require_text src/sdks/rust/src/backup.rs "restore target root must not contain NUL bytes" \
  "Rust SDK restore must reject NUL-containing target roots before archive unpack"
require_text src/sdks/rust/src/database.rs "call \`cancel()\` explicitly when a" \
  "Rust SDK close docs must require explicit cancellation rather than implicit close-time cancel"
require_text src/sdks/swift/Sources/Oliphaunt/Oliphaunt.swift "public struct OliphauntEngineModeSupport" \
  "Swift SDK must expose an explicit mode support contract"
require_text src/sdks/swift/Sources/Oliphaunt/Oliphaunt.swift "public func transaction<T: Sendable>" \
  "Swift SDK must expose a transaction helper"
require_text src/sdks/swift/Sources/Oliphaunt/Oliphaunt.swift "public func checkpoint() async throws" \
  "Swift SDK must expose checkpoint"
require_text src/sdks/swift/Sources/Oliphaunt/Oliphaunt.swift "public var multiRoot: Bool" \
  "Swift SDK capabilities must expose multi-root support"
require_text src/sdks/swift/Sources/Oliphaunt/Oliphaunt.swift "public var backupFormats: [OliphauntBackupFormat]" \
  "Swift SDK capabilities must expose supported backup formats"
require_text src/sdks/swift/Sources/Oliphaunt/Oliphaunt.swift "public var restoreFormats: [OliphauntBackupFormat]" \
  "Swift SDK capabilities must expose supported restore formats"
require_text src/sdks/swift/Sources/Oliphaunt/Oliphaunt.swift "public func supportsBackupFormat(_ format: OliphauntBackupFormat) -> Bool" \
  "Swift SDK capabilities must expose backup format helper"
require_text src/sdks/swift/Sources/Oliphaunt/Oliphaunt.swift "public func supportsRestoreFormat(_ format: OliphauntBackupFormat) -> Bool" \
  "Swift SDK capabilities must expose restore format helper"
require_text src/sdks/swift/Sources/Oliphaunt/Oliphaunt.swift "public func supportsBackupFormat(_ format: OliphauntBackupFormat) async throws -> Bool" \
  "Swift SDK opened database must expose backup format helper"
require_text src/sdks/swift/Sources/Oliphaunt/Oliphaunt.swift "public func supportsRestoreFormat(_ format: OliphauntBackupFormat) async throws -> Bool" \
  "Swift SDK opened database must expose restore format helper"
require_text src/sdks/swift/Sources/Oliphaunt/Oliphaunt.swift "guard capabilities.supportsBackupFormat(request.format) else" \
  "Swift SDK backup must reject unsupported formats before native session calls"
require_text src/sdks/swift/Sources/Oliphaunt/Oliphaunt.swift "guard request.artifact.format == .physicalArchive else" \
  "Swift SDK restore must reject unsupported formats before engine calls"
require_text src/sdks/swift/Sources/Oliphaunt/Oliphaunt.swift "must be a file URL" \
  "Swift SDK must reject non-file roots before engine calls"
require_text src/sdks/swift/Sources/Oliphaunt/Oliphaunt.swift "validateOliphauntRoot(configuration.root, label: \"database root\")" \
  "Swift SDK open must validate roots before engine calls"
require_text src/sdks/swift/Sources/Oliphaunt/Oliphaunt.swift "validateOliphauntRoot(request.root, label: \"restore root\")" \
  "Swift SDK restore must validate roots before engine calls"
require_text src/sdks/swift/Sources/Oliphaunt/Oliphaunt.swift "must not contain NUL bytes" \
  "Swift SDK root validation must reject NUL-containing roots before C ABI calls"
require_text src/sdks/swift/Sources/Oliphaunt/Oliphaunt.swift "try await closingSession.close()" \
  "Swift SDK close must wait on session close without issuing implicit cancel"
require_text src/sdks/kotlin/oliphaunt/src/commonMain/kotlin/dev/oliphaunt/Oliphaunt.kt "public data class EngineModeSupport" \
  "Kotlin SDK must expose an explicit mode support contract"
require_text src/sdks/kotlin/oliphaunt/src/commonMain/kotlin/dev/oliphaunt/Oliphaunt.kt "public suspend fun <T> transaction" \
  "Kotlin SDK must expose a transaction helper"
require_text src/sdks/kotlin/oliphaunt/src/commonMain/kotlin/dev/oliphaunt/Oliphaunt.kt "public suspend fun checkpoint()" \
  "Kotlin SDK must expose checkpoint"
require_text src/sdks/kotlin/oliphaunt/src/commonMain/kotlin/dev/oliphaunt/Oliphaunt.kt "val multiRoot: Boolean" \
  "Kotlin SDK capabilities must expose multi-root support"
require_text src/sdks/kotlin/oliphaunt/src/commonMain/kotlin/dev/oliphaunt/Oliphaunt.kt "val backupFormats: List<BackupFormat>" \
  "Kotlin SDK capabilities must expose supported backup formats"
require_text src/sdks/kotlin/oliphaunt/src/commonMain/kotlin/dev/oliphaunt/Oliphaunt.kt "val restoreFormats: List<BackupFormat>" \
  "Kotlin SDK capabilities must expose supported restore formats"
require_text src/sdks/kotlin/oliphaunt/src/commonMain/kotlin/dev/oliphaunt/Oliphaunt.kt "public fun supportsBackupFormat(format: BackupFormat): Boolean" \
  "Kotlin SDK capabilities must expose backup format helper"
require_text src/sdks/kotlin/oliphaunt/src/commonMain/kotlin/dev/oliphaunt/Oliphaunt.kt "public fun supportsRestoreFormat(format: BackupFormat): Boolean" \
  "Kotlin SDK capabilities must expose restore format helper"
require_text src/sdks/kotlin/oliphaunt/src/commonMain/kotlin/dev/oliphaunt/Oliphaunt.kt "public suspend fun supportsBackupFormat(format: BackupFormat): Boolean" \
  "Kotlin SDK opened database must expose backup format helper"
require_text src/sdks/kotlin/oliphaunt/src/commonMain/kotlin/dev/oliphaunt/Oliphaunt.kt "public suspend fun supportsRestoreFormat(format: BackupFormat): Boolean" \
  "Kotlin SDK opened database must expose restore format helper"
require_text src/sdks/kotlin/oliphaunt/src/commonMain/kotlin/dev/oliphaunt/Oliphaunt.kt "if (!capabilities.supportsBackupFormat(request.format))" \
  "Kotlin SDK backup must reject unsupported formats before platform session calls"
require_text src/sdks/kotlin/oliphaunt/src/commonMain/kotlin/dev/oliphaunt/Oliphaunt.kt "if (request.artifact.format != BackupFormat.PhysicalArchive)" \
  "Kotlin SDK restore must reject unsupported formats before platform engine calls"
require_text src/sdks/kotlin/oliphaunt/src/commonMain/kotlin/dev/oliphaunt/Oliphaunt.kt "validateRootPath(config.root, \"database root\")" \
  "Kotlin SDK open must reject malformed roots before platform engine calls"
require_text src/sdks/kotlin/oliphaunt/src/commonMain/kotlin/dev/oliphaunt/Oliphaunt.kt "validateRootPath(request.root, \"restore root\")" \
  "Kotlin SDK restore must reject malformed roots before platform engine calls"
require_text src/sdks/kotlin/oliphaunt/src/commonMain/kotlin/dev/oliphaunt/Oliphaunt.kt "must not contain NUL bytes" \
  "Kotlin SDK root validation must reject NUL-containing roots before platform engine calls"
require_text src/sdks/kotlin/oliphaunt/src/commonMain/kotlin/dev/oliphaunt/Oliphaunt.kt "executionMutex.withLock {" \
  "Kotlin SDK close must wait on serialized session close without issuing implicit cancel"
require_text src/sdks/kotlin/oliphaunt/src/nativeMain/kotlin/dev/oliphaunt/NativeDirectEngine.kt "oliphaunt_kotlin_close(current)" \
  "Kotlin/Native direct session close must detach through the native close bridge"
require_text src/sdks/kotlin/oliphaunt/src/nativeMain/kotlin/dev/oliphaunt/NativeDirectEngine.kt "OliphauntConfig as NativeOliphauntConfig" \
  "Kotlin/Native direct engine must not let the C ABI config shadow the public SDK config"
require_text src/sdks/kotlin/oliphaunt/src/nativeMain/kotlin/dev/oliphaunt/NativeDirectEngine.kt "alloc<NativeOliphauntConfig>" \
  "Kotlin/Native direct engine must allocate the aliased C ABI config explicitly"
require_text src/sdks/kotlin/oliphaunt/src/commonMain/kotlin/dev/oliphaunt/Oliphaunt.kt "defaultOliphauntEngine(EngineMode.NativeDirect)" \
  "Kotlin SDK common restore/support defaults must use the platform default native-direct engine"
require_text src/sdks/kotlin/oliphaunt/src/androidMain/kotlin/dev/oliphaunt/DefaultEngine.kt "use OliphauntAndroid.open(context, config)" \
  "Kotlin Android common open default must point apps to the Context facade"
require_text src/sdks/kotlin/oliphaunt/src/androidMain/kotlin/dev/oliphaunt/DefaultEngine.kt "use OliphauntAndroid.restore(context, request)" \
  "Kotlin Android common restore default must point apps to the Context facade"
require_text src/sdks/react-native/src/client.ts "supportedModes(): Promise<EngineModeSupport[]>" \
  "React Native SDK must expose mode support discovery"
require_text src/sdks/react-native/src/client.ts "async transaction<T>" \
  "React Native SDK must expose a transaction helper"
require_text src/sdks/react-native/src/client.ts "async checkpoint(): Promise<void>" \
  "React Native SDK must expose checkpoint"
require_text src/sdks/react-native/src/client.ts "multiRoot: boolean" \
  "React Native SDK capabilities must expose multi-root support"
require_text src/sdks/react-native/src/client.ts "backupFormats: BackupFormat[]" \
  "React Native SDK capabilities must expose supported backup formats"
require_text src/sdks/react-native/src/client.ts "restoreFormats: BackupFormat[]" \
  "React Native SDK capabilities must expose supported restore formats"
require_text src/sdks/react-native/src/client.ts "export function supportsBackupFormat" \
  "React Native SDK must expose a backup format helper"
require_text src/sdks/react-native/src/client.ts "export function supportsRestoreFormat" \
  "React Native SDK must expose a restore format helper"
require_text src/sdks/react-native/src/client.ts "if (!supportsBackupFormat(capabilities, format))" \
  "React Native SDK backup must reject unsupported formats before TurboModule calls"
require_text src/sdks/react-native/src/client.ts "if (artifact.format !== 'physicalArchive')" \
  "React Native SDK restore must reject unsupported formats before TurboModule calls"
require_text src/sdks/react-native/src/client.ts "database root must not be empty" \
  "React Native SDK open must reject blank roots before TurboModule calls"
require_text src/sdks/react-native/src/client.ts "restore root must not be empty" \
  "React Native SDK restore must reject blank roots before TurboModule calls"
require_text src/sdks/react-native/src/client.ts "database root must not contain NUL bytes" \
  "React Native SDK open must reject NUL-containing roots before TurboModule calls"
require_text src/sdks/react-native/src/client.ts "restore root must not contain NUL bytes" \
  "React Native SDK restore must reject NUL-containing roots before TurboModule calls"
require_text src/sdks/react-native/src/client.ts "libraryPath must not be empty" \
  "React Native SDK must reject blank native library overrides before TurboModule calls"
require_text src/sdks/react-native/src/client.ts "runtimeDirectory must not be empty" \
  "React Native SDK must reject blank native runtime-directory overrides before TurboModule calls"
require_text src/sdks/react-native/src/__tests__/client.test.ts "libraryPath must not contain NUL bytes" \
  "React Native SDK tests must prove malformed native override paths stay before the bridge"
require_text src/sdks/react-native/src/client.ts "await this.#native.close(this.#handle);" \
  "React Native SDK close must delegate close without issuing implicit cancel"
require_text src/sdks/react-native/src/client.ts "libraryPath?: string;" \
  "React Native SDK restore options must accept native library override"
require_text src/sdks/react-native/src/client.ts "libraryPath ?? null" \
  "React Native SDK restore must forward native library override to JSI transport"
require_text src/sdks/react-native/android/src/main/java/dev/oliphaunt/reactnative/OliphauntModule.kt 'putBoolean("multiRoot", multiRoot)' \
  "React Native Android must delegate multi-root capability from Kotlin"
require_text src/sdks/react-native/ios/OliphauntAdapter.swift 'values["multiRoot"] = capabilities.multiRoot' \
  "React Native iOS must delegate multi-root capability from Swift"
require_text src/sdks/react-native/src/jsiTransport.ts "libraryPath: string | null" \
  "React Native JSI transport must carry restore native library override"
require_text src/sdks/react-native/ios/OliphauntAdapter.swift "OliphauntDatabase.supportedModes()" \
  "React Native iOS must delegate mode support to the Swift SDK"
require_text src/sdks/react-native/android/src/main/java/dev/oliphaunt/reactnative/OliphauntModule.kt "OliphauntAndroid.supportedModes()" \
  "React Native Android must delegate mode support to the Kotlin SDK"
require_text src/sdks/react-native/ios/OliphauntAdapter.swift "libraryPath: String?" \
  "React Native iOS restore must accept native library override"
require_text src/sdks/react-native/android/src/main/java/dev/oliphaunt/reactnative/OliphauntModule.kt "libraryPath = reactNativeLibraryPath(validatePathOverride(libraryPath, \"libraryPath\"))" \
  "React Native Android restore must forward native library override to Kotlin SDK"
require_text src/sdks/swift/Sources/Oliphaunt/Oliphaunt.swift "execProtocolStream" \
  "Swift SDK must expose streaming raw-protocol execution"
require_text src/sdks/swift/Sources/Oliphaunt/Oliphaunt.swift "queryCancel" \
  "Swift SDK must expose query-cancel capability reporting"
require_text src/sdks/swift/Sources/Oliphaunt/Oliphaunt.swift "backupRestore" \
  "Swift SDK must expose backup/restore capability reporting"
require_text src/sdks/swift/Sources/Oliphaunt/Oliphaunt.swift "simpleQuery" \
  "Swift SDK must expose simple-query capability reporting"
require_text src/sdks/kotlin/oliphaunt/src/commonMain/kotlin/dev/oliphaunt/Oliphaunt.kt "execProtocolStream" \
  "Kotlin SDK must expose streaming raw-protocol execution"
require_text src/sdks/kotlin/oliphaunt/src/commonMain/kotlin/dev/oliphaunt/Oliphaunt.kt "queryCancel" \
  "Kotlin SDK must expose query-cancel capability reporting"
require_text src/sdks/kotlin/oliphaunt/src/commonMain/kotlin/dev/oliphaunt/Oliphaunt.kt "backupRestore" \
  "Kotlin SDK must expose backup/restore capability reporting"
require_text src/sdks/kotlin/oliphaunt/src/commonMain/kotlin/dev/oliphaunt/Oliphaunt.kt "simpleQuery" \
  "Kotlin SDK must expose simple-query capability reporting"
require_text src/sdks/react-native/src/client.ts "execProtocolStream" \
  "React Native SDK must expose streaming raw-protocol execution"
require_text src/sdks/react-native/src/client.ts "queryCancel" \
  "React Native SDK must expose query-cancel capability reporting"
require_text src/sdks/react-native/src/client.ts "backupRestore" \
  "React Native SDK must expose backup/restore capability reporting"
require_text src/sdks/react-native/src/client.ts "simpleQuery" \
  "React Native SDK must expose simple-query capability reporting"
require_text src/sdks/rust/src/error.rs "pub struct PostgresError" \
  "Rust SDK must expose structured PostgreSQL errors"
require_text src/sdks/rust/src/query.rs "parse_postgres_error_response" \
  "Rust SDK query parser must preserve PostgreSQL ErrorResponse fields"
require_text src/sdks/swift/Sources/Oliphaunt/Oliphaunt.swift "case postgres(OliphauntPostgresError)" \
  "Swift SDK must expose structured PostgreSQL errors"
require_text src/sdks/swift/Sources/Oliphaunt/OliphauntQuery.swift "public struct OliphauntPostgresError" \
  "Swift SDK query parser must preserve PostgreSQL ErrorResponse fields"
require_text src/sdks/kotlin/oliphaunt/src/commonMain/kotlin/dev/oliphaunt/Oliphaunt.kt "public class PostgresException" \
  "Kotlin SDK must expose structured PostgreSQL errors"
require_text src/sdks/kotlin/oliphaunt/src/commonMain/kotlin/dev/oliphaunt/Query.kt "public data class PostgresError" \
  "Kotlin SDK query parser must preserve PostgreSQL ErrorResponse fields"
require_text src/sdks/react-native/src/query.ts "export class PostgresError extends Error" \
  "React Native SDK must expose structured PostgreSQL errors"
require_text src/sdks/react-native/src/index.ts "PostgresError" \
  "React Native SDK must re-export structured PostgreSQL errors"
require_text src/sdks/react-native/src/client.ts "validateExtensionIds" \
  "React Native SDK must validate extension identifiers before crossing the bridge"
require_text src/sdks/react-native/src/client.ts "generatedExtensionBySqlName(trimmed)" \
  "React Native SDK must validate selected extension identifiers against the generated catalog before crossing the bridge"
require_text src/sdks/react-native/src/__tests__/client.test.ts "mobile/vector" \
  "React Native SDK must test malformed extension identifiers before native open"
require_text src/sdks/react-native/src/__tests__/client.test.ts "pg_search" \
  "React Native SDK must test unknown generated-catalog extension identifiers before native open"
require_text src/sdks/js/src/config.ts "generatedExtensionBySqlName(trimmed)" \
  "TypeScript SDK must validate selected extension identifiers against the generated catalog before runtime startup"
require_text src/sdks/js/src/__tests__/config.test.ts "pg_search" \
  "TypeScript SDK must test unknown generated-catalog extension identifiers before startup"
require_text src/sdks/react-native/ios/OliphauntAdapter.swift "extensions must be an array of strings" \
  "React Native iOS adapter must reject malformed extension arrays before Swift SDK open"
reject_text src/sdks/react-native/ios/OliphauntAdapter.swift 'compactMap { $0 as? String }' \
  "React Native iOS adapter must not silently drop malformed extension entries"
require_text src/sdks/react-native/ios/OliphauntAdapter.swift "startupIdentity" \
  "React Native iOS adapter must validate startup identity before Swift SDK open"
require_text src/sdks/react-native/ios/OliphauntAdapter.swift "username must not contain NUL bytes" \
  "React Native iOS adapter must reject malformed startup identity before Swift SDK open"
require_text src/sdks/react-native/ios/OliphauntAdapter.swift "resourceRoot must not be empty" \
  "React Native iOS adapter must reject blank resource roots before Swift SDK open"
require_text src/sdks/react-native/ios/OliphauntAdapter.swift "must be a string" \
  "React Native iOS adapter must reject malformed scalar config values before Swift SDK open"
require_text src/sdks/react-native/ios/OliphauntAdapter.swift "libraryPath must not be empty" \
  "React Native iOS adapter must reject blank native library overrides before Swift SDK open/restore"
require_text src/sdks/react-native/ios/OliphauntAdapter.swift "runtimeDirectory must not be empty" \
  "React Native iOS adapter must reject blank runtime-directory overrides before Swift SDK open"
require_text src/sdks/react-native/ios/OliphauntAdapter.swift "return try nonBlankValue(try string(dictionary, key), key, emptyMessage: emptyMessage)" \
  "React Native iOS adapter path helper must reject NUL-containing roots and native override paths"
reject_text src/sdks/react-native/ios/OliphauntAdapter.swift 'username: string(config, "username")' \
  "React Native iOS adapter must not drop empty startup identity values before Swift SDK open"
reject_text src/sdks/react-native/ios/OliphauntAdapter.swift '(value as? String)?.isEmpty == false' \
  "React Native iOS adapter must not silently drop malformed scalar config values"
require_text src/sdks/react-native/android/src/main/java/dev/oliphaunt/reactnative/OliphauntModule.kt "extensions must be an array of strings" \
  "React Native Android adapter must reject malformed extension arrays before Kotlin SDK open"
reject_text src/sdks/react-native/android/src/main/java/dev/oliphaunt/reactnative/OliphauntModule.kt 'getString(index)?.let(::add)' \
  "React Native Android adapter must not silently drop malformed extension entries"
require_text src/sdks/react-native/android/src/main/java/dev/oliphaunt/reactnative/OliphauntModule.kt "startupIdentity" \
  "React Native Android adapter must validate startup identity before Kotlin SDK open"
require_text src/sdks/react-native/android/src/main/java/dev/oliphaunt/reactnative/OliphauntModule.kt "username must not contain NUL bytes" \
  "React Native Android adapter must reject malformed startup identity before Kotlin SDK open"
require_text src/sdks/react-native/android/src/main/java/dev/oliphaunt/reactnative/OliphauntModule.kt '$name must be a string' \
  "React Native Android adapter must reject malformed scalar config values before Kotlin SDK open"
require_text src/sdks/react-native/android/src/main/java/dev/oliphaunt/reactnative/OliphauntModule.kt "pathOverride" \
  "React Native Android adapter must validate native override paths before Kotlin SDK open/restore"
require_text src/sdks/react-native/android/src/main/java/dev/oliphaunt/reactnative/OliphauntModule.kt "libraryPath must not be empty" \
  "React Native Android adapter must reject blank native library overrides before Kotlin SDK open/restore"
require_text src/sdks/react-native/android/src/main/java/dev/oliphaunt/reactnative/OliphauntModule.kt "validateRootPath(root, \"restore root\")" \
  "React Native Android adapter must reject malformed restore roots before Kotlin SDK restore"
require_text src/sdks/react-native/android/src/main/java/dev/oliphaunt/reactnative/OliphauntModule.kt "validateRootPath(it, \"database root\")" \
  "React Native Android adapter must reject malformed open roots before Kotlin SDK open"
require_text src/sdks/swift/Tests/OliphauntTests/OliphauntTests.swift "extension/vector.control" \
  "Swift SDK tests must prove selected mobile extension assets materialize"
require_text src/sdks/swift/Tests/OliphauntTests/OliphauntTests.swift "extension/hstore.control" \
  "Swift SDK tests must prove unselected mobile extension assets stay invisible"
require_text src/sdks/kotlin/tools/check-sdk.sh "selected vector extension control file" \
  "Kotlin SDK check must prove selected Android extension assets are packaged"
require_text src/sdks/kotlin/tools/check-sdk.sh "unselected hstore extension control file" \
  "Kotlin SDK check must prove unselected Android extension assets stay invisible"
require_text src/sdks/react-native/tools/check-sdk.sh "unselected hstore extension control file" \
  "React Native SDK check must prove Android AAR extension asset boundaries through Kotlin"
require_text src/sdks/kotlin/tools/check-sdk.sh "package-size.tsv" \
  "Kotlin SDK check must prove Android resource packaging preserves package-size reports"
require_text src/sdks/react-native/tools/check-sdk.sh "package-size.tsv" \
  "React Native SDK check must prove Android AAR packaging preserves package-size reports"
require_text src/sdks/rust/tools/check-sdk.sh "cargo package -p oliphaunt --locked --allow-dirty --list" \
  "Rust SDK check must inspect the cargo package file list before release"
require_text src/sdks/swift/tools/check-sdk.sh "archive-source --output" \
  "Swift SDK check must inspect the SwiftPM source archive before release"
require_text src/sdks/swift/tools/check-sdk.sh "reject_archive_entry_prefix" \
  "Swift SDK check must reject generated build directories from the SwiftPM source archive"
require_text src/sdks/react-native/tools/check-sdk.sh "ios/podspecs/Oliphaunt.podspec" \
  "React Native SDK check must prove the packed artifact includes the Swift SDK podspec shim needed by iOS autolinking"
require_text src/sdks/kotlin/tools/check-sdk.sh ":oliphaunt:bundleReleaseAar" \
  "Kotlin SDK check must assemble the Android release AAR package surface"
require_text src/sdks/kotlin/tools/check-sdk.sh 'kotlin_version="$(kotlin_package_version)"' \
  "Kotlin SDK check must derive package artifact names from Gradle release metadata"
require_text src/sdks/kotlin/tools/check-sdk.sh 'oliphaunt-metadata-$kotlin_version-sources.jar' \
  "Kotlin SDK check must inspect Kotlin Multiplatform source artifacts"
require_text src/sdks/kotlin/tools/check-sdk.sh 'oliphaunt-metadata-$kotlin_version.jar' \
  "Kotlin SDK check must inspect Kotlin Multiplatform metadata artifacts"
require_text src/sdks/kotlin/oliphaunt/build.gradle.kts 'it.name.startsWith("cinteropOliphaunt")' \
  "Kotlin/Native cinterop tasks must build the local static bridge before interop"
require_text src/sdks/kotlin/oliphaunt/build.gradle.kts "dependsOn(buildNativeBridge)" \
  "Kotlin/Native cinterop tasks must depend on the generated bridge archive"
require_text src/sdks/react-native/tools/check-sdk.sh "pack --dry-run --json" \
  "React Native SDK check must inspect the Node package file list before release"
require_text src/sdks/swift/Sources/Oliphaunt/OliphauntRuntimeResources.swift "oliphaunt-runtime-resources-v1" \
  "Swift SDK must validate the shared runtime-resource schema"
require_text src/sdks/kotlin/oliphaunt/src/androidMain/kotlin/dev/oliphaunt/OliphauntAndroidRuntimeAssets.kt "oliphaunt-runtime-resources-v1" \
  "Kotlin Android SDK must validate the shared runtime-resource schema"
require_text src/sdks/kotlin/oliphaunt/src/androidUnitTest/kotlin/dev/oliphaunt/OliphauntAndroidRuntimeAssetsTest.kt "unsupported runtime resource schema" \
  "Kotlin Android SDK must test stale runtime-resource schema rejection"
require_text src/sdks/swift/Tests/OliphauntTests/OliphauntTests.swift "runtimeResourcesRejectUnsupportedRuntimeFeatures" \
  "Swift SDK tests must reject unsupported shared runtime-resource runtimeFeatures"
require_text src/sdks/kotlin/oliphaunt/src/androidUnitTest/kotlin/dev/oliphaunt/OliphauntAndroidRuntimeAssetsTest.kt "rejectsUnsupportedRuntimeFeatures" \
  "Kotlin Android SDK tests must reject unsupported shared runtime-resource runtimeFeatures"
require_text docs/maintainers/sdk-parity-policy.md 'runtimeFeatures' \
  "SDK parity docs must list runtimeFeatures in the shared runtime-resource manifest fields"
require_text src/sdks/swift/Sources/Oliphaunt/OliphauntRuntimeResources.swift "OliphauntRuntimeResourceSizeReport" \
  "Swift SDK must expose the shared package-size report"
require_text src/sdks/swift/Tests/OliphauntTests/OliphauntTests.swift "runtimeResourcesExposePackageSizeReport" \
  "Swift SDK tests must prove package-size report parsing"
require_text src/sdks/kotlin/oliphaunt/src/androidMain/kotlin/dev/oliphaunt/AndroidNativeDirectEngine.kt "packageSizeReport" \
  "Kotlin Android SDK must expose package-size report parsing"
require_text src/sdks/kotlin/oliphaunt/src/androidUnitTest/kotlin/dev/oliphaunt/OliphauntAndroidRuntimeAssetsTest.kt "parsesPackageSizeReportFromResourceRoot" \
  "Kotlin Android SDK tests must prove local resource-root package-size parsing"
require_text src/sdks/kotlin/oliphaunt/src/androidUnitTest/kotlin/dev/oliphaunt/OliphauntAndroidRuntimeAssetsTest.kt "parsesPackageSizeReport" \
  "Kotlin Android SDK tests must prove package-size report parsing"
require_text src/sdks/react-native/src/client.ts "packageSizeReport" \
  "React Native SDK must expose package-size report parsing"
require_text src/sdks/react-native/src/__tests__/client.test.ts "testPackageSizeReportDelegatesToNativeSdk" \
  "React Native SDK tests must prove package-size report delegation"
require_text src/sdks/react-native/android/src/main/java/dev/oliphaunt/reactnative/OliphauntModule.kt "OliphauntAndroid.packageSizeReport" \
  "React Native Android must delegate package-size reports to the Kotlin SDK"
require_text src/sdks/react-native/ios/OliphauntAdapter.swift "packageSizeReportWithConfig" \
  "React Native iOS must delegate package-size reports to the Swift SDK"
tools/policy/check-sdk-mobile-extension-surface.sh
tools/policy/check-react-native-boundary.sh

printf '\nSDK parity ownership checks passed.\n'
