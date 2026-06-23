#!/usr/bin/env sh
set -eu

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
. "$script_dir/sdk-check-lib.sh"

require_text src/sdks/kotlin/oliphaunt/build.gradle.kts "schema=oliphaunt-runtime-resources-v1" \
  "Kotlin Android Gradle packaging must emit the shared runtime-resource schema"
require_text src/sdks/kotlin/oliphaunt/build.gradle.kts "validateRuntimeResourcesSchema" \
  "Kotlin Android Gradle packaging must reject stale runtime-resource schemas before copying app assets"
require_text src/sdks/kotlin/oliphaunt/build.gradle.kts "mobileStaticRegistryPending=" \
  "Kotlin Android Gradle packaging must emit mobile static-registry metadata"
require_text src/sdks/kotlin/oliphaunt/build.gradle.kts "sharedPreloadLibraries=" \
  "Kotlin Android Gradle packaging must emit shared-preload metadata"
require_text src/sdks/kotlin/oliphaunt/build.gradle.kts "nativeModuleStems=" \
  "Kotlin Android Gradle packaging must emit expected native module stems"
require_text src/sdks/kotlin/oliphaunt/build.gradle.kts "generatedExtensionMetadata.from(layout.projectDirectory.file(\"src/generated/extensions.json\"))" \
  "Kotlin Android Gradle packaging must consume package-local generated extension metadata"
require_text src/sdks/kotlin/oliphaunt/build.gradle.kts "mobile-release-ready" \
  "Kotlin Android Gradle packaging must reject extensions without release-ready mobile artifacts"
require_text src/sdks/kotlin/oliphaunt/build.gradle.kts "generatedNativeModuleStem(extension)" \
  "Kotlin Android Gradle packaging must derive native module stems from generated extension metadata"
require_text src/sdks/kotlin/oliphaunt/build.gradle.kts "cannot select unknown extension" \
  "Kotlin Android split runtime packaging must reject extensions absent from generated metadata"
reject_text src/sdks/kotlin/oliphaunt/build.gradle.kts "?: return extension" \
  "Kotlin Android Gradle packaging must not infer native module stems for unknown extensions"
reject_text src/sdks/kotlin/oliphaunt/build.gradle.kts '"postgis" -> "postgis-3"' \
  "Kotlin Android Gradle packaging must not hardcode PostGIS native module stems"
require_text src/sdks/kotlin/oliphaunt/build.gradle.kts "mobileStaticRegistrySource=" \
  "Kotlin Android Gradle packaging must emit mobile static-registry source metadata"
require_text src/sdks/kotlin/oliphaunt/build.gradle.kts "oliphauntAndroidExtensionArchivesDir" \
  "Kotlin Android Gradle packaging must accept prebuilt per-extension archive roots"
require_text src/sdks/kotlin/oliphaunt/build.gradle.kts "static-registry/archives" \
  "Kotlin Android Gradle packaging must default to selected archives carried by runtime resources"
reject_text src/sdks/kotlin/oliphaunt/build.gradle.kts "ResolveOliphauntAndroidReleaseAssetsTask" \
  "Kotlin Android SDK packaging must not carry a duplicate URL-backed release-asset resolver"
reject_text src/sdks/kotlin/oliphaunt/build.gradle.kts "resolveOliphauntAndroidReleaseAssets" \
  "Kotlin Android SDK packaging must not expose a duplicate URL-backed release-asset task"
require_text src/sdks/kotlin/oliphaunt-android-gradle-plugin/src/main/java/dev/oliphaunt/android/OliphauntAndroidPlugin.java "dev.oliphaunt.extensions:" \
  "Kotlin Android public Gradle plugin must add exact extension artifact dependencies through Maven"
require_text src/sdks/kotlin/oliphaunt-android-gradle-plugin/src/main/java/dev/oliphaunt/android/OliphauntAndroidPlugin.java "androidTarget(abi)" \
  "Kotlin Android public Gradle plugin must resolve ABI-specific extension artifact coordinates"
require_text src/sdks/kotlin/oliphaunt-android-gradle-plugin/src/main/java/dev/oliphaunt/android/ResolveOliphauntAndroidAssetsTask.java "oliphaunt-extension-artifact-v1" \
  "Kotlin Android public Gradle plugin must validate target-scoped extension runtime artifact manifests"
require_text src/sdks/kotlin/oliphaunt-android-gradle-plugin/src/main/java/dev/oliphaunt/android/ResolveOliphauntAndroidAssetsTask.java "mobileStaticArchives" \
  "Kotlin Android public Gradle plugin must stage mobile static archives from target-scoped extension artifacts"
require_text src/sdks/kotlin/oliphaunt-android-gradle-plugin/src/main/java/dev/oliphaunt/android/ResolveOliphauntAndroidAssetsTask.java "mobileStaticDependencyArchives" \
  "Kotlin Android public Gradle plugin must stage selected mobile static dependency archives from target-scoped extension artifacts"
require_text src/sdks/kotlin/oliphaunt/src/androidMain/cpp/CMakeLists.txt "add_library(oliphaunt_extensions SHARED" \
  "Kotlin Android CMake must link a support library from prebuilt static extension archives"
require_text src/sdks/kotlin/oliphaunt/src/androidMain/cpp/CMakeLists.txt "oliphaunt_dependency_archives" \
  "Kotlin Android CMake must link selected mobile static dependency archives"
require_text src/sdks/kotlin/oliphaunt/src/androidMain/cpp/oliphaunt_android_bridge.cpp "liboliphaunt_extensions.so" \
  "Kotlin Android bridge must discover the prebuilt extension support library"
require_text src/sdks/kotlin/oliphaunt/src/androidMain/cpp/oliphaunt_android_bridge.cpp "liboliphaunt_selected_static_extensions" \
  "Kotlin Android native bridge must register generated static extension rows before open"
require_text src/sdks/kotlin/oliphaunt/build.gradle.kts "resolveExtensionSelection" \
  "Kotlin Android Gradle packaging must resolve exact extension selections"
require_text src/sdks/kotlin/README.md "Maven Central artifact is the Android SDK and JNI adapter" \
  "Kotlin docs must state that Maven does not implicitly ship liboliphaunt/runtime/extension assets"
require_text src/sdks/kotlin/oliphaunt/src/androidMain/kotlin/dev/oliphaunt/OliphauntAndroidRuntimeAssets.kt "Available extensions" \
  "Kotlin Android resource parser must validate exact extension availability"
require_text src/sdks/react-native/android/build.gradle "schema=oliphaunt-runtime-resources-v1" \
  "React Native Android Gradle packaging must emit the shared runtime-resource schema for the Kotlin SDK"
require_text src/sdks/react-native/android/build.gradle "validateRuntimeResourcesSchema" \
  "React Native Android Gradle packaging must reject stale runtime-resource schemas before copying app assets"
require_text src/sdks/react-native/android/build.gradle "mobileStaticRegistryPending=" \
  "React Native Android Gradle packaging must emit mobile static-registry metadata"
require_text src/sdks/react-native/android/build.gradle "sharedPreloadLibraries=" \
  "React Native Android Gradle packaging must emit shared-preload metadata"
require_text src/sdks/react-native/android/build.gradle "nativeModuleStems=" \
  "React Native Android Gradle packaging must emit expected native module stems"
require_text src/sdks/react-native/android/build.gradle "generatedExtensionMetadata.from(file(\"../src/generated/extensions.json\"))" \
  "React Native Android Gradle packaging must consume package-local generated extension metadata"
require_text src/sdks/react-native/android/build.gradle "mobile-release-ready" \
  "React Native Android Gradle packaging must reject extensions without release-ready mobile artifacts"
require_text src/sdks/react-native/app.plugin.js "MOBILE_RELEASE_READY_EXTENSION_SQL_NAMES" \
  "React Native config plugin must reject extensions without release-ready mobile artifacts"
require_text src/sdks/react-native/android/build.gradle "generatedNativeModuleStem(extension, metadataBySqlName)" \
  "React Native Android Gradle packaging must derive native module stems from generated extension metadata"
require_text src/sdks/react-native/android/build.gradle "cannot select unknown extension" \
  "React Native Android split runtime packaging must reject extensions absent from generated metadata"
reject_text src/sdks/react-native/android/build.gradle "      return extension" \
  "React Native Android Gradle packaging must not infer native module stems for unknown extensions"
reject_text src/sdks/react-native/android/build.gradle "return \"postgis-3\"" \
  "React Native Android Gradle packaging must not hardcode PostGIS native module stems"
require_text src/sdks/react-native/android/build.gradle "mobileStaticRegistrySource=" \
  "React Native Android Gradle packaging must emit mobile static-registry source metadata"
require_text src/sdks/react-native/android/build.gradle "oliphauntAndroidExtensionArchivesDir" \
  "React Native Android Gradle packaging must accept prebuilt per-extension archive roots"
require_text src/sdks/react-native/android/build.gradle "static-registry/archives" \
  "React Native Android Gradle packaging must default to selected archives carried by runtime resources"
require_text src/sdks/react-native/android/src/main/cpp/CMakeLists.txt "add_library(oliphaunt_extensions SHARED" \
  "React Native Android CMake must link a support library from prebuilt static extension archives"
require_text src/sdks/react-native/android/src/main/cpp/CMakeLists.txt "oliphaunt_dependency_archives" \
  "React Native Android CMake must link selected mobile static dependency archives"
require_text src/sdks/react-native/android/build.gradle "resolveExtensionSelection" \
  "React Native Android Gradle packaging must resolve exact extension selections"
require_text src/sdks/react-native/README.md "published React Native artifact does not carry base \`liboliphaunt\`" \
  "React Native docs must state that the JS package does not implicitly ship native runtime or extension assets"
require_text src/sdks/react-native/app.plugin.js "pod 'Oliphaunt', :podspec => File.join(oliphaunt_podspecs_path, 'Oliphaunt.podspec')" \
  "React Native iOS config plugin must resolve the Swift SDK through npm-shipped podspec shims"
if [ -f src/sdks/swift/COliphaunt.podspec ] || [ -f src/sdks/swift/Oliphaunt.podspec ]; then
  echo "Swift SDK must be SwiftPM-only; React Native podspec shims live in the RN npm package" >&2
  exit 1
fi
require_file src/sdks/react-native/ios/podspecs/COliphaunt.podspec
require_file src/sdks/react-native/ios/podspecs/Oliphaunt.podspec
require_text src/sdks/react-native/ios/podspecs/COliphaunt.podspec "src/sdks/swift/Sources/COliphaunt" \
  "React Native C podspec shim must resolve the released Swift SDK C bridge source"
require_text src/sdks/react-native/ios/podspecs/Oliphaunt.podspec "s.dependency \"COliphaunt\", swift_sdk_version" \
  "React Native Swift podspec shim must depend on the exact C bridge version"
reject_text src/sdks/react-native/package.json "prepare-apple-vendor" \
  "React Native npm package must not generate a vendored Swift SDK source slice"
require_text Package.swift "SwiftPM is the public Apple SDK entrypoint" \
  "SwiftPM must be the public Apple SDK entrypoint"
require_text src/sdks/swift/README.md "CocoaPods trunk is not a release path" \
  "Swift docs must not depend on CocoaPods trunk for public Apple SDK releases"
require_text src/sdks/swift/README.md "liboliphaunt-native-v<version>" \
  "Swift docs must pair SwiftPM source tags with compatible liboliphaunt release assets"
require_text src/sdks/swift/README.md "Optional extension" \
  "Swift docs must keep optional extension XCFrameworks exact-selected instead of bundled by default"
require_text src/sdks/react-native/OliphauntReactNative.podspec "ios/generated/static-registry/*.c" \
  "React Native iOS CocoaPods packaging must compile generated exact-extension static registry glue"
require_text src/sdks/react-native/tools/mobile-extension-runtime.sh "liboliphaunt_extension_*.xcframework" \
  "React Native iOS prebuilt extension unpacking must inspect exact extension XCFramework inputs"
require_text src/sdks/react-native/tools/mobile-extension-runtime.sh 'comm -23 "$expected_file" "$actual_file"' \
  "React Native iOS prebuilt extension unpacking must fail when a selected XCFramework is missing"
require_text src/sdks/react-native/tools/mobile-extension-runtime.sh "unpacked unselected XCFrameworks" \
  "React Native iOS prebuilt extension unpacking must reject unselected extension XCFrameworks"
require_text src/sdks/react-native/tools/expo-ios-runner.sh "validate_ios_static_extension_linkage" \
  "React Native iOS build runner must prove selected static extension frameworks were linked"
require_text src/sdks/react-native/tools/expo-ios-runner.sh "build-only static-registry source" \
  "React Native iOS build runner must reject build-only static-registry source in app resources"
require_text src/sdks/react-native/tools/expo-ios-runner.sh "liboliphaunt_extension_[A-Za-z0-9_]+" \
  "React Native iOS build runner must inspect selected extension framework link inputs"
require_text tools/release/check_staged_artifacts.py "check_ios_prebuilt_extension_linkage" \
  "staged mobile artifact checks must verify iOS selected extension link evidence"
require_text tools/release/check_staged_artifacts.py "static-registry/oliphaunt_static_registry.c" \
  "staged mobile artifact checks must reject build-only static-registry source in iOS app resources"
require_text tools/release/check_staged_artifacts.py "liboliphaunt_extension_[A-Za-z0-9_]+" \
  "staged mobile artifact checks must reject unselected iOS extension framework link inputs"
require_text src/sdks/swift/Sources/Oliphaunt/OliphauntRuntimeResources.swift "available extensions" \
  "Swift resource parser must validate exact extension availability"
require_text src/sdks/swift/Sources/COliphaunt/bridge.c "liboliphaunt_selected_static_extensions" \
  "Swift native bridge must register generated static extension rows before open"
require_text src/sdks/rust/src/runtime_resources.rs "oliphaunt-static-registry-v1" \
  "Rust runtime-resource code must generate the platform static-registry artifact schema"
require_text src/sdks/rust/src/runtime_resources/static_registry.rs "OLIPHAUNT_STATIC_OPTIONAL" \
  "Rust runtime-resource static registry must keep optional extension init hooks distinct from required entry points"
reject_text src/sdks/rust/src/runtime_resources/static_registry.rs "OLIPHAUNT_STATIC_WEAK" \
  "Rust runtime-resource static registry must not make selected extension entry points weak"
require_text src/sdks/rust/src/extension.rs "RELEASE_READY_PG18_SUPPORTED" \
  "Rust SDK must expose the release-ready exact extension catalog"
require_text src/sdks/rust/src/extension.rs "MOBILE_RELEASE_READY_PG18_SUPPORTED" \
  "Rust SDK must expose the release-ready mobile extension catalog"
require_text src/sdks/rust/src/extension.rs "by_release_ready_sql_name" \
  "Rust runtime-resource CLI must resolve public exact extension selections through the release-ready catalog"
require_text src/sdks/rust/src/extension.rs "mod generated_extensions" \
  "Rust SDK extension metadata must be generated from the shared extension catalog"
require_text src/sdks/rust/src/extension.rs "pub use generated_extensions::Extension" \
  "Rust SDK must expose the generated typed Extension enum"
require_text src/sdks/rust/src/extension.rs "generated_extensions::RELEASE_READY_PG18_SUPPORTED" \
  "Rust SDK release-ready extension catalog must delegate to generated metadata"
require_text src/sdks/rust/src/extension.rs "generated_extensions::NATIVE_EXTENSION_MANIFEST" \
  "Rust SDK native extension manifest must delegate to generated metadata"
require_text src/sdks/rust/src/extension.rs "generated_extensions::extension_data_files" \
  "Rust SDK extension data files must delegate to generated metadata"
require_text src/sdks/rust/src/generated/extensions.rs "@generated by src/extensions/tools/check-extension-model.py" \
  "Rust SDK generated extension metadata must record its generator"
require_text src/sdks/rust/src/generated/extensions.rs "pub enum Extension" \
  "Rust SDK generated extension metadata must own the public Extension enum"
require_text src/extensions/generated/sdk/rust.json "\"mobile-release-ready\"" \
  "generated SDK metadata must expose mobile artifact readiness"
require_text src/extensions/generated/sdk/rust.json "\"target-status\"" \
  "generated SDK metadata must expose target-family status"
require_text src/sdks/rust/src/generated/extensions.rs "Extension::Earthdistance => &[Extension::Cube]" \
  "Rust SDK generated extension metadata must carry exact extension dependencies"
require_text src/sdks/rust/src/generated/extensions.rs "Extension::PgSearch => Some(\"pg_search\")" \
  "Rust SDK generated extension metadata must carry shared-preload requirements"
require_text src/sdks/rust/src/generated/extensions.rs "Extension::PgSearch => ExtensionArtifactPolicy::External" \
  "Rust SDK generated extension metadata must carry external artifact policies"
require_text src/sdks/rust/src/generated/extensions.rs "contrib/postgis-3.6/spatial_ref_sys.sql" \
  "Rust SDK generated extension metadata must carry complex extension data files"
require_text src/extensions/external/postgis/recipe.toml "extension_sql_file_prefixes" \
  "PostGIS helper SQL file ownership must live in recipe metadata"
require_text src/extensions/external/postgis/recipe.toml "[[runtime_environment]]" \
  "PostGIS runtime environment ownership must live in recipe metadata"
require_text src/extensions/external/pgtap/recipe.toml "extension_sql_file_prefixes" \
  "pgTAP helper SQL file ownership must live in recipe metadata"
require_text src/sdks/rust/src/generated/extensions.rs "\"postgis_comments\"" \
  "Rust SDK generated extension metadata must carry PostGIS helper SQL prefixes"
require_text src/sdks/rust/src/generated/extensions.rs "\"postgis_proc_set_search_path\"" \
  "Rust SDK generated extension metadata must carry PostGIS helper SQL prefixes"
require_text src/sdks/rust/src/generated/extensions.rs "\"rtpostgis\"" \
  "Rust SDK generated extension metadata must carry PostGIS helper SQL prefixes"
require_text src/sdks/rust/src/generated/extensions.rs "\"pgtap-core\"" \
  "Rust SDK generated extension metadata must carry pgTAP helper SQL prefixes"
require_text src/sdks/rust/src/generated/extensions.rs "\"pgtap-schema\"" \
  "Rust SDK generated extension metadata must carry pgTAP helper SQL prefixes"
require_text src/sdks/rust/src/generated/extensions.rs "\"uninstall_pgtap.sql\"" \
  "Rust SDK generated extension metadata must carry pgTAP helper SQL filenames"
require_text src/sdks/rust/src/generated/extensions.rs "Extension::Postgis => &[" \
  "Rust SDK generated extension metadata must carry PostGIS runtime environment"
require_text src/sdks/rust/src/generated/extensions.rs "name: \"PROJ_DATA\"" \
  "Rust SDK generated extension metadata must carry PostGIS PROJ_DATA environment"
require_text src/sdks/rust/src/generated/extensions.rs "relative_path: \"share/postgresql/proj\"" \
  "Rust SDK generated extension metadata must carry the PostGIS PROJ data path"
require_text src/sdks/rust/src/generated/extensions.rs "required_file: \"proj.db\"" \
  "Rust SDK generated extension metadata must gate PostGIS PROJ_DATA on proj.db"
require_text src/sdks/rust/src/server.rs "configure_extension_runtime_env" \
  "Rust native server must configure selected extension runtime environment generically"
reject_text src/sdks/rust/src/extension.rs "Self::Earthdistance => &[Self::Cube]" \
  "Rust SDK must not reintroduce hand-written extension dependency tables"
reject_text src/sdks/rust/src/extension.rs "Self::PgSearch => Some(\"pg_search\")" \
  "Rust SDK must not reintroduce hand-written shared-preload tables"
reject_text src/sdks/rust/src/extension.rs "Self::Graph => ExtensionArtifactPolicy::External" \
  "Rust SDK must not reintroduce hand-written external artifact policies"
reject_text src/sdks/rust/src/extension.rs "contrib/postgis-3.6/legacy.sql" \
  "Rust SDK must not reintroduce hand-written complex extension data files"
reject_text src/sdks/rust/src/extension.rs "postgis_comments" \
  "Rust SDK must not reintroduce hand-written PostGIS helper SQL prefixes"
reject_text src/sdks/rust/src/extension.rs "postgis_proc_set_search_path" \
  "Rust SDK must not reintroduce hand-written PostGIS helper SQL prefixes"
reject_text src/sdks/rust/src/extension.rs "rtpostgis" \
  "Rust SDK must not reintroduce hand-written PostGIS helper SQL prefixes"
reject_text src/sdks/rust/src/extension.rs "uninstall_postgis" \
  "Rust SDK must not reintroduce hand-written PostGIS helper SQL filenames"
reject_text src/sdks/rust/src/extension.rs "pgtap-core" \
  "Rust SDK must not reintroduce hand-written pgTAP helper SQL prefixes"
reject_text src/sdks/rust/src/extension.rs "pgtap-schema" \
  "Rust SDK must not reintroduce hand-written pgTAP helper SQL prefixes"
reject_text src/sdks/rust/src/extension.rs "uninstall_pgtap" \
  "Rust SDK must not reintroduce hand-written pgTAP helper SQL filenames"
reject_text src/sdks/rust/src/server.rs "configure_postgis_proj_data_env" \
  "Rust native server must not reintroduce PostGIS-specific environment wiring"
reject_text src/sdks/rust/src/extension.rs "pub const NATIVE_EXTENSION_MANIFEST: &[ExtensionManifestEntry] = &[" \
  "Rust SDK must not reintroduce a hand-written native extension manifest"
reject_text src/sdks/rust/src/extension.rs "pub enum Extension {" \
  "Rust SDK must not reintroduce a hand-written public Extension enum"
require_text src/sdks/rust/src/bin/package_resources.rs "--list-extensions" \
  "Rust runtime-resource CLI must list the prebuilt exact extension catalog without requiring a native build"
require_text src/sdks/rust/src/bin/package_resources.rs "--prebuilt-extension" \
  "Rust runtime-resource CLI must accept exact prebuilt third-party extension artifacts"
require_text src/sdks/rust/src/bin/extension_artifact.rs "oliphaunt-extension-artifact" \
  "Rust SDK must expose a producer CLI for exact prebuilt extension artifacts"
require_text src/sdks/rust/src/bin/extension_artifact.rs "--native-module-file" \
  "Prebuilt extension artifact producer must accept target-specific native module filenames"
require_text src/sdks/rust/src/runtime_resources/extension_artifact.rs "create_prebuilt_extension_artifact" \
  "Rust runtime-resource code must create exact prebuilt extension artifacts from built runtime files"
require_text src/sdks/rust/src/runtime_resources/extension_artifact.rs "nativeModuleFile" \
  "Prebuilt extension artifacts must record target-specific native module filenames"
require_text src/sdks/rust/src/runtime_resources.rs "oliphaunt-extension-artifact-index-v1" \
  "Rust runtime-resource code must define the exact prebuilt extension artifact index schema"
require_text src/sdks/rust/src/runtime_resources/extension_index.rs "resolve_prebuilt_extension_artifacts_from_indexes" \
  "Rust runtime-resource code must resolve exact external extension names through verified artifact indexes"
require_text src/sdks/rust/src/runtime_resources/extension_index.rs "create_prebuilt_extension_artifact_index" \
  "Rust runtime-resource code must create exact prebuilt extension artifact indexes from validated artifacts"
require_text src/sdks/rust/src/runtime_resources/extension_index.rs "has sha256" \
  "Prebuilt extension artifact indexes must verify SHA-256 before consumption"
require_text src/sdks/rust/src/runtime_resources/extension_index.rs "artifact_cache_dir" \
  "Prebuilt extension artifact indexes must support verified artifact caches for release URL rows"
require_text src/sdks/rust/src/runtime_resources/extension_index.rs "extension-download" \
  "Prebuilt extension artifact HTTPS downloads must stay an explicit packaging-tool feature"
require_text src/sdks/rust/src/runtime_resources.rs "oliphaunt-extension-artifact-index-signature-v1" \
  "Prebuilt extension artifact indexes must have a signed release consumption path"
require_text src/sdks/rust/src/runtime_resources.rs "NativeExtensionArtifactIndexTrustRoot" \
  "Prebuilt extension artifact indexes must verify against explicit trusted publisher keys"
require_text src/sdks/rust/src/runtime_resources/extension_index.rs "list_prebuilt_extension_artifact_index_catalog" \
  "Prebuilt extension artifact indexes must expose exact external catalog discovery"
require_text src/sdks/rust/src/runtime_resources.rs "NativeExtensionArtifactIndexCatalogEntry" \
  "Prebuilt extension artifact indexes must model exact external catalog metadata"
require_text src/sdks/rust/src/runtime_resources/extension_index.rs "extension-signing" \
  "Prebuilt extension artifact index signing must stay an explicit packaging-tool feature"
require_text src/sdks/rust/src/bin/extension_index.rs "oliphaunt-extension-index" \
  "Rust SDK must expose a producer CLI for exact prebuilt extension artifact indexes"
require_text src/sdks/rust/src/bin/extension_index.rs "--base-url" \
  "Rust SDK extension index producer must record release artifact URLs without changing exact selection semantics"
require_text src/sdks/rust/src/bin/extension_index.rs "--signing-key-file" \
  "Rust SDK extension index producer must sign release indexes from an explicit key file"
require_text src/sdks/rust/src/bin/package_resources.rs "--extension-index" \
  "Rust runtime-resource CLI must resolve external exact extension names through artifact indexes"
require_text src/sdks/rust/src/bin/package_resources.rs "--extension-cache" \
  "Rust runtime-resource CLI must download URL-backed indexed artifacts into an explicit verified cache"
require_text src/sdks/rust/src/bin/package_resources.rs "--trusted-extension-index-key-file" \
  "Rust runtime-resource CLI must require signed external extension indexes when a trust root is supplied"
require_text src/sdks/rust/src/bin/package_resources.rs "signed external index metadata is listed" \
  "Rust runtime-resource CLI must list external exact-extension index metadata without artifact downloads"
require_text src/sdks/rust/src/bin/package_resources.rs "mobile_static_archive_targets" \
  "Rust runtime-resource CLI must expose carried mobile static archive targets for exact external extensions"
require_text src/sdks/rust/src/bin/package_resources.rs ".tar.zst" \
  "Rust runtime-resource CLI help must advertise portable compressed prebuilt extension archives"
require_text src/sdks/rust/src/runtime_resources.rs "oliphaunt-extension-artifact-v1" \
  "Rust runtime-resource code must define the exact prebuilt extension artifact schema"
require_text src/sdks/rust/src/runtime_resources/extension_artifact.rs "mobileStaticArchives" \
  "Rust extension artifact schema must carry selected mobile static archives inside exact artifacts"
require_text src/sdks/rust/src/runtime_resources.rs "static-registry/archives" \
  "Rust runtime resources must copy selected prebuilt mobile static archives into platform SDK resources"
require_text src/sdks/rust/src/runtime_resources/extension_artifact.rs "archive_is_tar_zst" \
  "Rust runtime-resource code must accept .tar.zst prebuilt extension artifacts"
require_text src/sdks/rust/src/runtime_resources/extension_artifact.rs "must be a regular file or directory" \
  "Rust runtime-resource code must reject unsafe prebuilt extension archive entry types"
require_text src/sdks/rust/src/runtime_resources.rs "prebuilt_extension_artifact_can_override_builtin_artifact_payload" \
  "Concrete prebuilt extension artifacts must be able to supply the exact release payload for built-in exact-extension names"
require_text src/sdks/rust/src/runtime_resources.rs "unselected files inside a prebuilt extension artifact must not leak" \
  "Rust runtime-resource tests must prove extra files inside prebuilt extension artifacts do not leak"
require_text src/sdks/rust/src/runtime_resources/static_registry.rs "does not have release-ready iOS/Android static artifacts" \
  "Rust runtime-resource code must reject mobile static completion claims for extensions without prebuilt mobile artifacts"
require_text src/runtimes/liboliphaunt/native/bin/mobile-static-extensions.sh "static-extensions.tsv" \
  "liboliphaunt mobile static extension specs must be read from generated extension metadata"
require_text src/extensions/generated/mobile/static-extensions.tsv "$(printf 'sql-name\tnative-module-stem\tsource-kind\tsource-rel\tmobile-static-dependencies\tios-static-dependencies\tandroid-static-dependencies\tinclude-dependencies\tinclude-dirs\tcflags\thash-source-dependencies\tios-hash-source-dependencies\tandroid-hash-source-dependencies\thash-dirs\tsource-files\tsource-recursive-dirs')" \
  "generated mobile static extension specs must expose dependency/include/cflag/hash metadata columns"
require_text src/runtimes/liboliphaunt/native/bin/mobile-static-extensions.sh "oliphaunt_mobile_static_extension_dependency_field" \
  "liboliphaunt mobile static extension dependency selection must read generated dependency fields"
require_text src/runtimes/liboliphaunt/native/bin/mobile-static-extensions.sh "oliphaunt_mobile_static_extension_hash_source_dependencies" \
  "liboliphaunt mobile static extension hashing must read generated hash dependency fields"
require_text src/extensions/generated/mobile/static-extensions.tsv "$(printf 'hstore\thstore\tcontrib\tcontrib/hstore')" \
  "generated mobile static extension specs must include release-ready hstore artifacts"
require_text src/extensions/generated/mobile/static-extensions.tsv "$(printf 'pg_ivm\tpg_ivm\texternal\ttarget/oliphaunt-sources/checkouts/pg_ivm')" \
  "generated mobile static extension specs must include pg_ivm build metadata without claiming mobile release readiness"
require_text src/extensions/generated/mobile/static-extensions.tsv "createas.c,matview.c,pg_ivm.c,ruleutils.c,subselect.c" \
  "generated mobile static extension specs must record pg_ivm's explicit source file set"
reject_text src/runtimes/liboliphaunt/native/bin/mobile-static-extensions.sh "pg_ivm)" \
  "liboliphaunt mobile static extension specs must not hardcode pg_ivm source files"
require_text src/extensions/generated/mobile/static-extensions.tsv "$(printf 'pg_hashids\tpg_hashids\texternal\ttarget/oliphaunt-sources/checkouts/pg_hashids')" \
  "generated mobile static extension specs must include release-ready pg_hashids artifacts"
require_text src/extensions/generated/mobile/static-extensions.tsv "$(printf 'pgcrypto\tpgcrypto\tcontrib\tcontrib/pgcrypto\topenssl\topenssl\topenssl\topenssl\t\t\topenssl\topenssl\topenssl')" \
  "generated mobile static extension specs must record pgcrypto's OpenSSL link/include/hash metadata"
reject_text src/runtimes/liboliphaunt/native/bin/mobile-static-extensions.sh "pgcrypto) printf '%s\\n' openssl" \
  "liboliphaunt mobile static extension specs must not hardcode pgcrypto dependency selection"
reject_text src/runtimes/liboliphaunt/native/bin/mobile-static-extensions.sh "openssl/include" \
  "liboliphaunt mobile static extension specs must not hardcode pgcrypto include paths"
reject_text src/runtimes/liboliphaunt/native/bin/mobile-static-extensions.sh "checkouts/openssl" \
  "liboliphaunt mobile static extension specs must not hardcode pgcrypto hash source paths"
require_text src/extensions/generated/mobile/static-extensions.tsv "$(printf 'uuid-ossp\tuuid-ossp\tcontrib\tcontrib/uuid-ossp')" \
  "generated mobile static extension specs must include uuid-ossp's buildable module path"
require_text src/extensions/generated/mobile/static-extensions.tsv "$(printf 'uuid-ossp\tuuid-ossp\tcontrib\tcontrib/uuid-ossp\tuuid\tuuid\tuuid\t\tsrc/runtimes/liboliphaunt/native/portable-uuid/include\t-DHAVE_UUID_E2FS=1,-DHAVE_UUID_UUID_H=1\t\t\t\tsrc/runtimes/liboliphaunt/native/portable-uuid')" \
  "generated mobile static extension specs must record uuid-ossp's portable UUID link/include/cflag/hash metadata"
reject_text src/runtimes/liboliphaunt/native/bin/mobile-static-extensions.sh "uuid-ossp) printf '%s\\n' uuid" \
  "liboliphaunt mobile static extension specs must not hardcode uuid-ossp dependency selection"
reject_text src/runtimes/liboliphaunt/native/bin/mobile-static-extensions.sh "HAVE_UUID_E2FS" \
  "liboliphaunt mobile static extension specs must not hardcode uuid-ossp C flags"
require_text src/extensions/generated/mobile/static-extensions.tsv "$(printf 'postgis\tpostgis-3\texternal\ttarget/oliphaunt-sources/checkouts/postgis\tgeos,geos-c,json-c,libcharset,libiconv,libxml2,proj,sqlite\tgeos,geos-c,json-c,libxml2,proj,sqlite\tgeos,geos-c,json-c,libcharset,libiconv,libxml2,proj,sqlite\t\t\t\tgeos,json-c,libiconv,libxml2,proj,sqlite\tgeos,json-c,libxml2,proj,sqlite\tgeos,json-c,libiconv,libxml2,proj,sqlite')" \
  "generated mobile static extension specs must record PostGIS generic/iOS/Android static and hash dependency sets"
reject_text src/runtimes/liboliphaunt/native/bin/mobile-static-extensions.sh "for dependency_dir in geos proj sqlite json-c libxml2 libiconv" \
  "liboliphaunt mobile static extension specs must not hardcode PostGIS hash dependency sets"
require_text src/runtimes/liboliphaunt/native/bin/build-postgres18-windows.ps1 '"libxml2s.lib", "libxml2.lib", "xml2.lib"' \
  "Windows PostGIS dependency probes must accept libxml2's static CMake import library name"
require_text src/runtimes/liboliphaunt/native/bin/build-postgres18-ios-simulator.sh 'pg_extension_cflags="$native_cflags $icu_cflags"' \
  "iOS simulator mobile static extension compiles must inherit PostgreSQL ICU include flags"
require_text src/runtimes/liboliphaunt/native/bin/build-postgres18-ios-device.sh 'pg_extension_cflags="$native_cflags $icu_cflags"' \
  "iOS device mobile static extension compiles must inherit PostgreSQL ICU include flags"
require_text src/runtimes/liboliphaunt/native/bin/build-postgres18-android-arm64.sh 'pg_extension_cflags="$native_cflags $postgres_cppflags $icu_cflags"' \
  "Android mobile static extension compiles must inherit PostgreSQL ICU include flags"
require_text src/runtimes/liboliphaunt/native/bin/mobile-postgis-extensions.sh "pg_finfo_%s_difference" \
  "PostGIS mobile static builds must map token-pasted legacy pg_finfo aliases"
require_text src/extensions/artifacts/native/tools/package-release-assets.sh "pg_finfo_\${static_prefix}_difference" \
  "PostGIS release artifacts must publish token-pasted legacy pg_finfo aliases"
require_text src/extensions/artifacts/native/tools/package-release-assets.sh 'bun "$packager" list-catalog' \
  "Native extension release packaging must derive the exact extension catalog through neutral Bun tooling"
require_text src/extensions/artifacts/native/tools/package-release-assets.sh '"$packager" create-artifact' \
  "Native extension release packaging must create artifacts through neutral Bun tooling"
require_text src/extensions/artifacts/native/tools/extension-artifact-packager.mjs "packageLayout=oliphaunt-extension-artifact-v1" \
  "Native extension Bun packaging must emit the shared exact-extension artifact schema"
reject_text src/extensions/artifacts/native/tools/package-release-assets.sh "cargo run -p oliphaunt" \
  "Native extension release packaging must not piggyback on Rust SDK resource binaries"
require_text src/extensions/artifacts/native/tools/package-release-assets.sh 'mobile_dependency_args[@]+"${mobile_dependency_args[@]}"' \
  "Native extension release packaging must guard empty mobile dependency arrays under Bash strict mode"
require_text src/extensions/artifacts/native/tools/package-release-assets.sh 'extra_args[@]+"${extra_args[@]}"' \
  "Native extension release packaging must guard empty mobile artifact argument arrays under Bash strict mode"
require_text src/runtimes/liboliphaunt/native/bin/build-ios-extension-xcframeworks.sh 'selected_dependencies[@]+"${selected_dependencies[@]}"' \
  "iOS extension XCFramework packaging must guard empty dependency arrays under Bash strict mode"
require_text src/sdks/react-native/tools/expo-runner-runtime-resources.sh 'optional_data_excludes[@]+"${optional_data_excludes[@]}"' \
  "React Native mobile runtime resource packaging must guard empty optional data exclude arrays under Bash strict mode"
require_text src/sdks/react-native/tools/expo-runner-workspace.sh 'react_native_package_extra_excludes[@]+"${react_native_package_extra_excludes[@]}"' \
  "React Native package workspace staging must guard empty extra exclude arrays under Bash strict mode"
reject_text src/sdks/react-native/tools/expo-ios-runner.sh "mapfile" \
  "iOS mobile app runner must stay compatible with macOS Bash 3.2"
reject_text src/sdks/react-native/tools/expo-ios-runner.sh "readarray" \
  "iOS mobile app runner must stay compatible with macOS Bash 3.2"
require_text src/sdks/react-native/tools/expo-runner-workspace.sh "ensure_mobile_runtime_tool_permissions" \
  "React Native mobile app runners must repair executable bits on artifact-downloaded runtime tools before invoking initdb"
require_text src/sdks/react-native/tools/expo-android-runner.sh 'ensure_mobile_runtime_tool_permissions "$runtime_source"' \
  "Android mobile app runner must repair executable bits on downloaded native runtime tools"
require_text src/sdks/react-native/tools/expo-ios-runner.sh 'ensure_mobile_runtime_tool_permissions "$runtime_source"' \
  "iOS mobile app runner must repair executable bits on downloaded native runtime tools"
require_text src/sdks/rust/src/liboliphaunt/root/runtime/install.rs "ensure_runtime_tool_executable" \
  "Rust runtime resource installer must not preserve non-executable artifact modes for PostgreSQL tools"
require_text src/sdks/react-native/tools/expo-android-runner.sh 'return 0 # exact-extension packages may provide the static registry source.' \
  "Android mobile static registry lookup must not abort when exact-extension packages provide the registry source"
require_text src/sdks/react-native/tools/expo-ios-runner.sh 'return 0 # exact-extension packages may provide the static registry source.' \
  "iOS mobile static registry lookup must not abort when exact-extension packages provide the registry source"
uuid_ossp_wasix_contrib_row="$(printf 'uuid_ossp\tuuid-ossp\tuuid-ossp\tuuid-ossp.so\textensions/uuid-ossp.tar.zst\ttrue')"
require_text src/extensions/generated/contrib-build.tsv "$uuid_ossp_wasix_contrib_row" \
  "WASIX contrib build plan must build stable uuid-ossp after smoke evidence exists"
require_text src/extensions/generated/mobile/static-extensions.tsv "$(printf 'pg_textsearch\tpg_textsearch\texternal\ttarget/oliphaunt-sources/checkouts/pg_textsearch')" \
  "generated mobile static extension specs must include pg_textsearch build metadata without claiming mobile release readiness"
require_text src/extensions/generated/mobile/static-extensions.tsv "$(printf 'pg_textsearch\tpg_textsearch\texternal\ttarget/oliphaunt-sources/checkouts/pg_textsearch\t\t\t\t\tsource:src\t\t\t\t\t\t\tsrc')" \
  "generated mobile static extension specs must record pg_textsearch recursive source and include layout"
reject_text src/runtimes/liboliphaunt/native/bin/mobile-static-extensions.sh "pg_textsearch)" \
  "liboliphaunt mobile static extension specs must not hardcode pg_textsearch source layout"
require_text src/extensions/generated/mobile/static-extensions.tsv "$(printf 'pg_uuidv7\tpg_uuidv7\texternal\ttarget/oliphaunt-sources/checkouts/pg_uuidv7')" \
  "generated mobile static extension specs must include release-ready pg_uuidv7 artifacts"
require_text src/runtimes/liboliphaunt/native/bin/build-postgres18-windows.ps1 "oliphaunt_pg_uuidv7_clock_gettime" \
  "Windows native exact-extension producer must shim pg_uuidv7 CLOCK_REALTIME through PostgreSQL portable timestamps"
require_text src/runtimes/liboliphaunt/native/bin/build-postgres18-windows.ps1 "extern PGDLLEXPORT Datum tp_handler(PG_FUNCTION_ARGS);" \
  "Windows native exact-extension producer must align pg_textsearch tp_handler linkage with PG_FUNCTION_INFO_V1"
require_text src/runtimes/liboliphaunt/native/bin/build-postgres18-windows.ps1 "USE_CRT_DLL=1 NO_TCL=1 LDFLAGS=" \
  "Windows PostGIS SQLite dependency build must avoid stale SQLite MSVC CRT linker suppression"
require_text src/runtimes/liboliphaunt/native/bin/build-postgres18-windows.ps1 "cmake @cmakeArgs" \
  "Windows PostGIS CMake dependency wrapper must not splat PowerShell's automatic args variable"
require_text src/extensions/generated/mobile/static-extensions.tsv "$(printf 'vector\tvector\texternal\ttarget/oliphaunt-sources/checkouts/pgvector')" \
  "generated mobile static extension specs must resolve pgvector sources by checkout name, not SQL name"
require_text src/extensions/generated/pgxs-build.tsv "$(printf 'vector\tvector\ttarget/oliphaunt-sources/checkouts/pgvector\tvector.so')" \
  "native PGXS build plan must map exact vector artifact builds to the pgvector checkout"
require_text src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh "pgxs_extension_source_rel" \
  "macOS native PGXS builder must resolve external source checkouts from generated build-plan metadata"
require_text src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh 'BE_DLLLIBS=$be_dllibs -lm' \
  "macOS native PGXS builder must keep libm extensions on the Darwin bundle-loader link path"
require_text src/runtimes/liboliphaunt/native/bin/build-postgres18-linux.sh "pgxs_extension_source_rel" \
  "Linux native PGXS builder must resolve external source checkouts from generated build-plan metadata"
reject_text src/runtimes/liboliphaunt/native/bin/mobile-static-extensions.sh "hstore|hstore|contrib" \
  "liboliphaunt mobile static extension specs must not reintroduce a handwritten shell case table"
require_text src/runtimes/liboliphaunt/native/bin/build-postgres18-ios-simulator.sh "mobile-static-extensions.sh" \
  "iOS simulator build must use the shared mobile static extension artifact specs"
require_text src/runtimes/liboliphaunt/native/bin/build-postgres18-ios-simulator.sh 'object="$object_dir/${source_rel%.c}.o"' \
  "iOS simulator mobile static extension builds must preserve nested source paths instead of colliding basenames"
require_text src/runtimes/liboliphaunt/native/bin/build-postgres18-ios-simulator.sh "liboliphaunt_extension_\$stem.a" \
  "iOS simulator build must emit per-extension static archives for selected mobile modules"
require_text src/runtimes/liboliphaunt/native/bin/build-postgres18-ios-simulator.sh "build_openssl_dependency" \
  "iOS simulator build must build selected mobile static dependency archives"
require_text src/runtimes/liboliphaunt/native/bin/build-postgres18-ios-simulator.sh "build_uuid_dependency" \
  "iOS simulator build must build uuid-ossp's portable UUID dependency archive"
require_text src/runtimes/liboliphaunt/native/bin/build-postgres18-ios-device.sh "mobile-static-extensions.sh" \
  "iOS device build must use the shared mobile static extension artifact specs"
require_text src/runtimes/liboliphaunt/native/bin/build-postgres18-ios-device.sh 'object="$object_dir/${source_rel%.c}.o"' \
  "iOS device mobile static extension builds must preserve nested source paths instead of colliding basenames"
require_text src/runtimes/liboliphaunt/native/bin/build-postgres18-ios-device.sh "liboliphaunt_extension_\$stem.a" \
  "iOS device build must emit per-extension static archives for selected mobile modules"
require_text src/runtimes/liboliphaunt/native/bin/build-postgres18-ios-device.sh "build_openssl_dependency" \
  "iOS device build must build selected mobile static dependency archives"
require_text src/runtimes/liboliphaunt/native/bin/build-postgres18-ios-device.sh "build_uuid_dependency" \
  "iOS device build must build uuid-ossp's portable UUID dependency archive"
require_text src/runtimes/liboliphaunt/native/bin/build-ios-extension-xcframeworks.sh "OLIPHAUNT_MOBILE_STATIC_EXTENSIONS" \
  "iOS extension XCFramework packaging must consume exact extension selections"
require_text src/runtimes/liboliphaunt/native/bin/build-ios-extension-xcframeworks.sh "--runtime-resources" \
  "iOS extension XCFramework packaging must derive selected extensions from Rust runtime resources"
require_text src/runtimes/liboliphaunt/native/bin/build-ios-extension-xcframeworks.sh "nativeModuleStems" \
  "iOS extension XCFramework packaging must use exact selected native module stems"
require_text src/runtimes/liboliphaunt/native/bin/build-ios-extension-xcframeworks.sh "static_registry_manifest_value" \
  "iOS extension XCFramework packaging must map custom prebuilt module stems back to exact extension names"
require_text src/runtimes/liboliphaunt/native/bin/build-ios-extension-xcframeworks.sh "static-registry/archives" \
  "iOS extension XCFramework packaging must prefer selected mobile static archives carried by runtime resources"
require_text src/runtimes/liboliphaunt/native/bin/build-ios-extension-xcframeworks.sh "for custom prebuilt extensions, pass --runtime-resources" \
  "iOS extension XCFramework packaging must allow custom prebuilt stems through runtime-resource manifests"
require_text src/runtimes/liboliphaunt/native/bin/build-ios-extension-xcframeworks.sh "oliphaunt-ios-extension-xcframeworks-v1" \
  "iOS extension XCFramework packaging must emit an auditable selected-extension manifest"
require_text src/runtimes/liboliphaunt/native/bin/build-ios-extension-xcframeworks.sh "liboliphaunt_extension_\$stem.xcframework" \
  "iOS extension XCFramework packaging must emit one framework per selected extension archive"
require_text src/runtimes/liboliphaunt/native/bin/build-ios-extension-xcframeworks.sh "dependencyArchives" \
  "iOS extension XCFramework packaging must discover selected mobile dependency archives from runtime resources"
require_text src/runtimes/liboliphaunt/native/bin/build-ios-extension-xcframeworks.sh "liboliphaunt_dependency_\$dependency.xcframework" \
  "iOS extension XCFramework packaging must emit one framework per selected dependency archive"
require_text src/runtimes/liboliphaunt/native/bin/build-postgres18-android-arm64.sh "mobile-static-extensions.sh" \
  "Android build must use the shared mobile static extension artifact specs"
require_text src/runtimes/liboliphaunt/native/bin/build-postgres18-android-arm64.sh 'object="$object_dir/${source_rel%.c}.o"' \
  "Android mobile static extension builds must preserve nested source paths instead of colliding basenames"
require_text src/runtimes/liboliphaunt/native/bin/build-postgres18-android-arm64.sh "liboliphaunt_extension_\$stem.a" \
  "Android build must emit per-extension static archives for selected mobile modules"
require_text src/runtimes/liboliphaunt/native/bin/build-postgres18-android-arm64.sh "build_openssl_dependency" \
  "Android build must build selected mobile static dependency archives"
require_text src/runtimes/liboliphaunt/native/bin/build-postgres18-android-arm64.sh "build_uuid_dependency" \
  "Android build must build uuid-ossp's portable UUID dependency archive"
require_text tools/policy/check-mobile-extension-artifacts.sh "OLIPHAUNT_MOBILE_EXTENSION_CHECK_EXTENSIONS" \
  "product checks must expose a configurable mobile exact-extension artifact proof"
require_text tools/policy/check-mobile-extension-artifacts.sh "all-mobile" \
  "product checks must validate the full mobile-prebuilt exact-extension catalog by exact SQL name"
require_text tools/policy/check-mobile-extension-artifacts.sh "mobile_prebuilt" \
  "product checks must derive full mobile coverage from the exact extension catalog"
require_text tools/policy/check-mobile-extension-artifacts.sh "liboliphaunt_extension_\$stem.xcframework" \
  "mobile exact-extension artifact proof must validate iOS selected-extension XCFrameworks"
require_text tools/policy/check-mobile-extension-artifacts.sh "liboliphaunt_extensions.so" \
  "mobile exact-extension artifact proof must validate Android selected-extension support libraries"
require_text tools/policy/check-mobile-extension-artifacts.sh "reject_unselected_extension_controls" \
  "mobile exact-extension artifact proof must reject unselected extension assets"
require_text tools/policy/check-mobile-extension-artifacts.sh "mobile_prebuilt_extensions" \
  "mobile exact-extension artifact proof must derive unselected checks from the catalog"
require_text docs/maintainers/extension-packaging-policy.md "The release invariant is strict" \
  "extension docs must state the selected-only app-bundle invariant"
require_text docs/maintainers/extension-packaging-policy.md "The manifest records exact extension names only" \
  "extension docs must make exact extension selection the only extension selection model"
require_text docs/maintainers/extension-packaging-policy.md "release readiness is target-specific" \
  "extension docs must document target-specific release readiness"
require_text docs/maintainers/extension-packaging-policy.md "public selection surface may advertise only the exact extensions" \
  "extension docs must document the target-specific public selection invariant"
require_text docs/maintainers/extension-packaging-policy.md "Apache AGE" \
  "extension docs must record Oliphaunt-listed PG18 compatibility blockers separately from release-ready parity"
require_text docs/maintainers/extension-packaging-policy.md "The only current" \
  "extension docs must make the Oliphaunt-listed PG18 blocker set explicit"
require_text docs/maintainers/extension-packaging-policy.md "\`--with-uuid=e2fs\`" \
  "extension docs must record uuid-ossp's PostgreSQL UUID library requirement"
require_text docs/maintainers/extension-packaging-policy.md "src/runtimes/liboliphaunt/native/portable-uuid" \
  "extension docs must record uuid-ossp's portable UUID dependency source"
require_text docs/maintainers/extension-packaging-policy.md "\`uuid-ossp\` is stable in the" \
  "extension docs must record uuid-ossp release-ready promotion"
require_text docs/maintainers/extension-packaging-policy.md "WASIX side-module builds and packages with matching archive" \
  "extension docs must reflect the verified uuid-ossp WASIX package state"
require_text src/runtimes/liboliphaunt/wasix/assets/build/docker_contrib_extensions.sh 'PGSRC/src/include' \
  "WASIX contrib build must compile uuid-ossp's portable UUID dependency with prepared source headers"
require_text src/runtimes/liboliphaunt/wasix/assets/build/docker_runtime_support.sh "OLIPHAUNT_WASM_SKIP_IMAGE_BUILD" \
  "WASIX runtime support Docker wrapper must be able to reuse a prebuilt image"
require_text src/runtimes/liboliphaunt/wasix/assets/build/docker_initdb.sh "OLIPHAUNT_WASM_SKIP_IMAGE_BUILD" \
  "WASIX initdb Docker wrapper must be able to reuse a prebuilt image"
require_text src/runtimes/liboliphaunt/wasix/assets/build/docker_pgxs_extensions.sh "OLIPHAUNT_WASM_SKIP_IMAGE_BUILD" \
  "WASIX PGXS Docker wrapper must be able to reuse a prebuilt image"
require_text src/runtimes/liboliphaunt/wasix/assets/build/docker_pgdump.sh "OLIPHAUNT_WASM_SKIP_IMAGE_BUILD" \
  "WASIX pg_dump Docker wrapper must be able to reuse a prebuilt image"
require_text src/runtimes/liboliphaunt/wasix/assets/build/wasix_third_party.sh "oliphaunt_wasix_run_extension_build_in_docker_if_needed" \
  "WASIX extension build helpers must provide generic Docker delegation"
require_text src/runtimes/liboliphaunt/wasix/assets/build/wasix_third_party.sh "OLIPHAUNT_WASM_EXTENSION_BUILD_IN_DOCKER" \
  "generic WASIX extension Docker delegation must set an in-container sentinel"
require_text src/runtimes/liboliphaunt/wasix/assets/build/wasix_third_party.sh "oliphaunt_wasix_extension_build_outputs_exist" \
  "WASIX extension build helpers must validate recipe-owned build outputs"
require_text src/runtimes/liboliphaunt/wasix/assets/build/wasix_third_party.sh "required_build_files" \
  "WASIX extension build helpers must read required output files from the target recipe"
require_text src/runtimes/liboliphaunt/wasix/assets/build/wasix_third_party.sh "required_build_globs" \
  "WASIX extension build helpers must read required output globs from the target recipe"
require_text src/extensions/external/postgis/tools/build_wasix.sh "oliphaunt_wasix_run_extension_build_in_docker_if_needed" \
  "PostGIS WASIX build must delegate through the generic extension Docker helper when the WASIX compiler is unavailable"
require_text src/extensions/external/postgis/tools/build_wasix.sh "oliphaunt_wasix_extension_build_outputs_exist" \
  "PostGIS WASIX build must validate outputs through recipe-owned helper metadata"
require_text src/runtimes/liboliphaunt/wasix/assets/build/build_wasix_libiconv.sh "oliphaunt_wasix_apply_wasix_profile configure" \
  "libiconv WASIX configure probes must run without build-time wasm-opt"
require_text src/runtimes/liboliphaunt/wasix/assets/build/build_wasix_libiconv.sh "oliphaunt_wasix_apply_wasix_profile build" \
  "libiconv WASIX compilation must restore the selected build profile before make"
require_text docs/maintainers/extension-packaging-policy.md "OpenSSL for \`pgcrypto\`" \
  "extension docs must keep the pgcrypto mobile dependency explicit"
require_text docs/maintainers/extension-packaging-policy.md "PostGIS mobile metadata" \
  "extension docs must mention the PostGIS mobile metadata boundary"
require_text docs/maintainers/extension-packaging-policy.md "remains candidate until the selected iOS and Android static" \
  "extension docs must keep the PostGIS mobile candidate boundary explicit"
require_text src/docs/content/reference/sdk-products.mdx "Extension selection is exact-name only" \
  "SDK docs must present exact extension selection without product-level grouping"
require_text docs/maintainers/extension-packaging-policy.md "no selector expansion, alias, shorthand" \
  "extension docs must reject multi-extension selector expansion"
require_text docs/maintainers/extension-packaging-policy.md "\`mobile_prebuilt=no\` is a hard release" \
  "extension docs must state that app developers should not build missing mobile artifacts from source"
require_text docs/maintainers/extension-packaging-policy.md "--prebuilt-extension vendor/acme_ext.tar.zst" \
  "extension docs must document exact prebuilt third-party extension artifacts"
require_text docs/maintainers/extension-packaging-policy.md "oliphaunt-extension-artifact" \
  "extension docs must document producer tooling for exact prebuilt extension artifacts"
require_text docs/maintainers/extension-packaging-policy.md "oliphaunt-extension-artifact-index-v1" \
  "extension docs must document exact prebuilt extension artifact indexes"
require_text docs/maintainers/extension-packaging-policy.md "oliphaunt-extension-index" \
  "extension docs must document producer tooling for exact prebuilt extension artifact indexes"
require_text docs/maintainers/extension-packaging-policy.md "mobile_prebuilt = true" \
  "extension docs must document mobile-prebuilt metadata in exact extension indexes"
require_text docs/maintainers/extension-packaging-policy.md "mobile_static_archive_targets" \
  "extension docs must document external exact mobile static archive target metadata"
require_text docs/maintainers/extension-packaging-policy.md "mobileStaticArchives=" \
  "extension docs must document carried mobile static archives in exact extension artifacts"
require_text docs/maintainers/extension-packaging-policy.md "--list-extensions" \
  "extension docs must show exact external extension discovery from artifact indexes"
require_text docs/maintainers/extension-packaging-policy.md "--extension-index vendor/oliphaunt-extensions.toml" \
  "extension docs must show selecting external extensions through artifact indexes"
require_text docs/maintainers/extension-packaging-policy.md "--extension-cache ~/.cache/oliphaunt/extensions" \
  "extension docs must show verified cache consumption for URL-backed exact extension artifacts"
require_text docs/maintainers/extension-packaging-policy.md "\`extension-download\`" \
  "extension docs must keep HTTP/TLS artifact downloads out of the default embedded SDK dependency story"
require_text docs/maintainers/extension-packaging-policy.md "--trusted-extension-index-key-file acme-release-2026q2:keys/acme-extension-index.ed25519.pub" \
  "extension docs must show signed release index verification through an explicit trust root"
require_text docs/maintainers/extension-packaging-policy.md "\`extension-signing\`" \
  "extension docs must keep signed-index verification out of the default embedded SDK dependency story"
require_text docs/maintainers/extension-packaging-policy.md "nativeModuleFile=acme_ext.so" \
  "extension docs must document target-specific native module files in prebuilt artifacts"
require_text docs/maintainers/extension-packaging-policy.md "\`.tar.zst\`" \
  "extension docs must document portable compressed prebuilt extension artifacts"
require_text docs/maintainers/extension-packaging-policy.md "packageLayout=oliphaunt-extension-artifact-v1" \
  "extension docs must document the prebuilt extension artifact manifest schema"
require_text docs/maintainers/extension-packaging-policy.md "does not compile PostgreSQL or extension source in the app project" \
  "extension docs must state that Android app builds link prebuilt extension artifacts only"
require_text docs/maintainers/extension-packaging-policy.md "strong references for selected" \
  "extension docs must state selected extension artifacts are build/link requirements"
require_text docs/maintainers/extension-packaging-policy.md "--runtime-resources <dir>" \
  "extension docs must state iOS extension packaging derives selection from runtime resources"
require_text src/sdks/swift/README.md "The resolver fetches only those extension" \
  "Swift SDK docs must document selected-extension iOS XCFramework packaging"
require_text src/sdks/swift/README.md "selected their exact PostgreSQL extension name" \
  "Swift SDK docs must document deriving iOS selected-extension artifacts from exact SQL extension selections"
require_text src/sdks/swift/README.md "strongly references selected" \
  "Swift SDK docs must describe selected extension link-time failure semantics"
require_text src/sdks/react-native/README.md "build-ios-extension-xcframeworks.sh" \
  "React Native SDK docs must document selected-extension iOS XCFramework packaging"
require_text src/sdks/react-native/README.md "--runtime-resources <dir>" \
  "React Native SDK docs must document deriving iOS selected-extension artifacts from runtime resources"
require_text src/sdks/react-native/README.md "strongly references selected" \
  "React Native SDK docs must describe selected extension link-time failure semantics"
ios_extension_smoke_root="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-ios-extension-xcframework-check.XXXXXX")"
mkdir -p "$ios_extension_smoke_root/resources/oliphaunt/runtime"
cat >"$ios_extension_smoke_root/resources/oliphaunt/runtime/manifest.properties" <<'EOF'
schema=oliphaunt-runtime-resources-v1
layout=postgres-runtime-files-v1
extensions=
mobileStaticRegistryState=not-required
nativeModuleStems=
EOF
OLIPHAUNT_IOS_EXTENSION_XCFRAMEWORK_ROOT="$ios_extension_smoke_root/out" \
  src/runtimes/liboliphaunt/native/bin/build-ios-extension-xcframeworks.sh \
    --runtime-resources "$ios_extension_smoke_root/resources" >/dev/null
require_text "$ios_extension_smoke_root/out/out/manifest.properties" "packageLayout=oliphaunt-ios-extension-xcframeworks-v1" \
  "iOS extension XCFramework builder must emit a selected-extension manifest"
OLIPHAUNT_IOS_EXTENSION_XCFRAMEWORK_ROOT="$ios_extension_smoke_root/out" \
  src/runtimes/liboliphaunt/native/bin/build-ios-extension-xcframeworks.sh \
    --check-current \
    --runtime-resources "$ios_extension_smoke_root/resources" >/dev/null
rm -rf "$ios_extension_smoke_root"
require_text src/runtimes/liboliphaunt/native/bin/build-external-pgrx-extensions-macos.sh "--check-current" \
  "liboliphaunt must expose a no-build currentness gate for opt-in external pgrx artifacts"
require_text src/runtimes/liboliphaunt/native/bin/build-external-pgrx-extensions-macos.sh "--refresh-current-stamps" \
  "liboliphaunt must expose a no-build restamp path for valid external pgrx artifacts"
require_text src/runtimes/liboliphaunt/native/bin/build-external-pgrx-extensions-macos.sh "build_fingerprint_schema" \
  "external pgrx artifact fingerprints must be schema-versioned instead of hashing incidental harness text"
require_text src/runtimes/liboliphaunt/native/postgres18/external-extensions.toml "pgrx_version = \"0.18.0\"" \
  "external pgrx extension candidates must be pinned to a cargo-pgrx version"
printf '\nSDK mobile extension surface checks passed.\n'
