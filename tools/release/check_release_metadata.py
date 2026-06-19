#!/usr/bin/env python3
"""Validate release-owned version metadata and derived registry manifests."""

from __future__ import annotations

import json
import re
import sys
import tomllib
from pathlib import Path
from typing import NoReturn

import product_metadata


ROOT = Path(__file__).resolve().parents[2]


def fail(message: str) -> NoReturn:
    print(f"check_release_metadata.py: {message}", file=sys.stderr)
    raise SystemExit(1)


def read_text(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def require_text(path: str, needle: str, message: str) -> None:
    if needle not in read_text(path):
        fail(message)


def reject_text(path: str, needle: str, message: str) -> None:
    if needle in read_text(path):
        fail(message)


def validate_no_consumer_install_scripts(package: dict, label: str) -> None:
    scripts = package.get("scripts", {})
    if not isinstance(scripts, dict):
        return
    for script_name in ["preinstall", "install", "postinstall", "prepare"]:
        if script_name in scripts:
            fail(f"{label} package must not run {script_name} during consumer installs")
    for script_name, command in scripts.items():
        if not isinstance(command, str):
            continue
        if re.search(r"\b(cargo|rustup)\b", command):
            fail(f"{label} package script {script_name!r} must not require Rust tooling")


def load_graph() -> dict:
    return product_metadata.load_graph()


def stable_version(version: str, product: str) -> None:
    if not re.fullmatch(r"[0-9]+[.][0-9]+[.][0-9]+", version):
        fail(f"{product} must use a stable x.y.z release version, got {version!r}")


def cargo_manifest_version(path: str) -> str:
    manifest = tomllib.loads(read_text(path))
    package = manifest.get("package")
    if not isinstance(package, dict) or not isinstance(package.get("version"), str):
        fail(f"{path} must declare [package].version")
    return package["version"]


def cargo_manifest_name(path: str) -> str:
    manifest = tomllib.loads(read_text(path))
    package = manifest.get("package")
    if not isinstance(package, dict) or not isinstance(package.get("name"), str):
        fail(f"{path} must declare [package].name")
    return package["name"]


def gradle_property(path: str, name: str) -> str:
    for raw_line in read_text(path).splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        if key.strip() == name:
            return value.strip()
    fail(f"{path} must declare {name}")


def validate_graph_files(graph: dict) -> None:
    products = product_metadata.graph_products(graph)
    for product in products:
        for path in [
            *product_metadata.version_files(product, graph),
            *product_metadata.derived_version_files(product, graph),
        ]:
            if not (ROOT / path).is_file():
                fail(f"{product} release metadata path does not exist: {path}")
    product_metadata.validate_all_extension_metadata(graph)


def validate_release_setup_docs() -> None:
    setup = read_text("docs/maintainers/release-setup.md")
    normalized_setup = re.sub(r"\s+", " ", setup)
    required_fragments = [
        "Rust/Tauri: `cargo add oliphaunt`",
        "iOS/macOS Swift: Xcode or SwiftPM",
        'Android/Kotlin: Maven Central plus `id("dev.oliphaunt.android")`',
        "React Native/Expo: `pnpm add @oliphaunt/react-native` plus the Expo config",
        "TypeScript/Node/Bun: `pnpm add @oliphaunt/ts`",
        "TypeScript/Deno: `deno add jsr:@oliphaunt/ts`",
        "Normal app consumers must not install Rust, run Cargo, build PostgreSQL",
        "Do not set up CocoaPods trunk credentials",
        "CocoaPods trunk is scheduled to become read-only on December 2, 2026",
        "JSR's GitHub Actions OIDC publishing path",
        "MAVEN_CENTRAL_USERNAME",
        "SwiftPM plus GitHub release assets",
        "oliphaunt-broker",
        "consumer-shape --require-ready --products-json '<released products>'",
        "check-registries --products-json '<released products>' --head-ref HEAD --require-identities",
        "For the first public release, select every product",
        "manually bootstrap any first Cargo crates",
        "Manual registry bootstrap is a release-completion state",
        "create and push the matching product tag at the same release commit",
        "TypeScript broker mode needs the matching `oliphaunt-broker` runtime",
    ]
    for fragment in required_fragments:
        normalized_fragment = re.sub(r"\s+", " ", fragment)
        if normalized_fragment not in normalized_setup:
            fail(f"release setup guide is missing {fragment!r}")

    before_publish_section = setup.split("Run these from GitHub Actions", 1)[0]
    normalized_before_publish_section = re.sub(r"\s+", " ", before_publish_section)
    if "Consumer shape is strict" not in normalized_before_publish_section:
        fail("release setup guide must explain that strict consumer shape is a tracked package-shape gate")
    if setup.count("Sonatype Central Portal token setup:") != 1:
        fail("release setup guide must contain exactly one Sonatype token setup reference")


def validate_rust() -> None:
    require_text(
        "src/sdks/rust/tools/check-sdk.sh",
        "--resolve-release-assets",
        "Rust SDK package check must exercise release-shaped liboliphaunt asset resolution",
    )
    require_text(
        "src/sdks/rust/tools/check-sdk.sh",
        "create-liboliphaunt-release-fixture.py",
        "Rust SDK package check must use deterministic release-shaped liboliphaunt asset fixtures",
    )
    require_text(
        "src/sdks/rust/tools/check-sdk.sh",
        "--resolve-broker-release-assets",
        "Rust SDK package check must exercise release-shaped broker helper asset resolution",
    )
    require_text(
        "src/sdks/rust/tools/check-sdk.sh",
        "create-broker-release-fixture.py",
        "Rust SDK package check must use deterministic release-shaped broker asset fixtures",
    )
    require_text(
        "src/sdks/rust/src/bin/package_resources.rs",
        "--resolve-broker-release-assets",
        "Rust SDK resource resolver must expose broker helper release asset resolution",
    )
    require_text(
        "src/sdks/rust/README.md",
        "OLIPHAUNT_BROKER_ASSET_DIR",
        "Rust SDK README must document how packaged broker-mode apps find the broker helper",
    )
    require_text(
        "src/sdks/rust/src/bin/package_resources.rs",
        '"linux-x64-gnu" => assets.push(format!("liboliphaunt-{version}-linux-x64-gnu.tar.gz"))',
        "Rust SDK release asset resolver must support Linux x64 liboliphaunt assets",
    )
    require_text(
        "src/sdks/rust/src/bin/package_resources.rs",
        '"linux-arm64-gnu" =>',
        "Rust SDK release asset resolver must support Linux arm64 liboliphaunt assets",
    )
    require_text(
        "src/sdks/rust/src/bin/package_resources.rs",
        '"windows-x64-msvc" =>',
        "Rust SDK release asset resolver must support Windows x64 liboliphaunt assets",
    )


def validate_broker() -> None:
    require_text(
        "tools/release/package-broker-assets.sh",
        "oliphaunt-broker-${version}-${target_id}.${asset_extension}",
        "Broker runtime release must package platform-scoped oliphaunt-broker helper assets",
    )
    require_text(
        "tools/release/package-broker-assets.sh",
        'target_id="windows-x64-msvc"',
        "Broker runtime release must package the Windows broker helper target",
    )
    require_text(
        "tools/release/package-broker-assets.sh",
        "oliphaunt-broker-${version}-release-assets.sha256",
        "Broker runtime release must publish a checksum manifest for broker helper assets",
    )
    require_text(
        "tools/release/check_broker_release_assets.py",
        "executable_relative_path",
        "Broker runtime release asset checker must verify the metadata-declared helper executable",
    )


def validate_swift(swift_version: str, liboliphaunt_version: str) -> None:
    if read_text("src/sdks/swift/VERSION").strip() != swift_version:
        fail("Swift VERSION must match oliphaunt-swift product version")
    if read_text("src/sdks/swift/LIBOLIPHAUNT_VERSION").strip() != liboliphaunt_version:
        fail("Swift LIBOLIPHAUNT_VERSION must match the current liboliphaunt product version")
    require_text(
        "Package.swift",
        'path: "src/sdks/swift/Sources/Oliphaunt"',
        "root SwiftPM package must expose the Apple SDK from the monorepo root",
    )
    require_text(
        "Package.swift",
        'path: "src/sdks/swift/Sources/COliphaunt"',
        "root SwiftPM package must expose the C bridge target from the monorepo root",
    )
    require_text(
        "tools/release/render_swiftpm_release_package.py",
        "binaryTarget(",
        "SwiftPM release manifest renderer must emit a binary liboliphaunt target",
    )
    require_text(
        "tools/release/render_swiftpm_release_package.py",
        "liboliphaunt-native-v",
        "SwiftPM release manifest renderer must use liboliphaunt GitHub release assets",
    )
    require_text(
        "src/sdks/swift/tools/check-sdk.sh",
        "render_swiftpm_release_package.py",
        "Swift SDK package check must render the public SwiftPM release manifest from release-shaped assets",
    )
    require_text(
        "src/sdks/swift/tools/check-sdk.sh",
        "OLIPHAUNT_SWIFT_RELEASE_ASSET_DIR",
        "Swift SDK package check must consume real liboliphaunt release assets when CI provides them",
    )
    require_text(
        "src/sdks/swift/tools/check-sdk.sh",
        "liboliphaunt-$liboliphaunt_version-apple-spm-xcframework.zip",
        "Swift SDK package check must require the real Apple SwiftPM XCFramework release asset",
    )
    require_text(
        "src/sdks/swift/tools/check-sdk.sh",
        "Swift package-shape requires OLIPHAUNT_SWIFT_RELEASE_ASSET_DIR",
        "Swift SDK package check must fail closed instead of fabricating local release assets",
    )
    require_text(
        "tools/release/build-sdk-ci-artifacts.sh",
        "render_swiftpm_release_package.py",
        "Swift SDK package artifact builder must render the staged public SwiftPM release manifest",
    )
    require_text(
        "tools/release/build-sdk-ci-artifacts.sh",
        '"$artifact_root/Package.swift.release"',
        "Swift SDK package artifact builder must stage Package.swift.release as a release artifact",
    )
    require_text(
        "tools/release/build-sdk-ci-artifacts.sh",
        "staged SwiftPM release manifest must not contain local file URLs",
        "Swift SDK package artifact builder must reject local file URLs in release artifacts",
    )
    reject_text(
        "tools/release/build-sdk-ci-artifacts.sh",
        'cp "$work_root/check/package-shape/Package.swift.release"',
        "Swift SDK package artifact builder must not stage the local validation manifest",
    )
    require_text(
        "tools/release/render_swiftpm_release_package.py",
        "base Swift package must not require or publish extension files",
        "SwiftPM release manifest renderer must keep exact extensions out of the base package",
    )
    renderer = read_text("tools/release/render_swiftpm_release_package.py")
    for forbidden in ("extension_rows", "dependency_closure", "OliphauntExtension"):
        if forbidden in renderer:
            fail(f"SwiftPM release manifest renderer must not synthesize base-package extension products: {forbidden}")
    require_text(
        "tools/release/publish_swiftpm_source_tag.py",
        "commit-tree",
        "SwiftPM source-tag publisher must create a release-only manifest commit",
    )
    require_text(
        "tools/release/publish_swiftpm_source_tag.py",
        "--include-tree",
        "SwiftPM source-tag publisher must be able to include generated release-tree files",
    )
    require_text(
        "tools/release/release.py",
        "staged_swift_release_artifacts",
        "release CLI must validate staged Swift source and SwiftPM manifest artifacts before dry-run or tagging",
    )
    require_text(
        "tools/release/release.py",
        "Oliphaunt-source.zip",
        "release CLI must require the staged Swift source archive",
    )
    require_text(
        "tools/release/release.py",
        "Package.swift.release",
        "release CLI must require the staged SwiftPM release manifest",
    )
    require_text(
        "tools/release/release.py",
        "apple-spm-xcframework.zip",
        "release CLI must validate that the staged SwiftPM manifest points at the Apple liboliphaunt binary artifact",
    )
    require_text(
        "tools/release/release.py",
        "--manifest",
        "release CLI must pass a SwiftPM manifest to the source-tag publisher",
    )
    require_text(
        "tools/release/release.py",
        "--include-tree",
        "release CLI must pass the SwiftPM release-tree root to the source-tag publisher",
    )
    require_text(
        "tools/release/release.py",
        'output_manifest = output_dir / "Package.swift.release"',
        "release CLI must stage the SwiftPM binary manifest before tagging",
    )
    require_text(
        "src/sdks/swift/README.md",
        "Normal iOS and macOS app consumers do not install Rust",
        "Swift SDK README must make the no-Rust consumer install path explicit",
    )
    require_text(
        "src/sdks/swift/README.md",
        "oliphaunt-extension-vector",
        "Swift SDK README must describe exact-extension artifacts by release product, not hidden SwiftPM products",
    )
    swift_readme = read_text("src/sdks/swift/README.md")
    allowed_extension_api_symbols = {
        "OliphauntExtensionArtifactResolution",
        "OliphauntExtensionArtifactResolver",
        "OliphauntExtensionReleaseAsset",
        "OliphauntExtensionReleaseManifest",
        "OliphauntExtensionSizeReport",
    }
    for symbol in re.findall(r"\bOliphauntExtension[A-Z][A-Za-z0-9]*\b", swift_readme):
        if symbol not in allowed_extension_api_symbols:
            fail(
                "Swift SDK README must not advertise generated OliphauntExtension* "
                f"products until they exist: {symbol}"
            )
    for retired_podspec in [
        ROOT / "src/sdks/swift/COliphaunt.podspec",
        ROOT / "src/sdks/swift/Oliphaunt.podspec",
    ]:
        if retired_podspec.exists():
            fail(
                f"standalone Swift SDK must stay SwiftPM-only; remove {retired_podspec.relative_to(ROOT)}"
            )


def validate_kotlin(kotlin_version: str, liboliphaunt_version: str) -> None:
    actual = gradle_property("src/sdks/kotlin/gradle.properties", "VERSION_NAME")
    if actual != kotlin_version:
        fail("Kotlin VERSION_NAME must match oliphaunt-kotlin product version")
    plugin_liboliphaunt_version = read_text(
        "src/sdks/kotlin/oliphaunt-android-gradle-plugin/src/main/resources/dev/oliphaunt/android/liboliphaunt.version"
    ).strip()
    if plugin_liboliphaunt_version != liboliphaunt_version:
        fail("Kotlin Android Gradle plugin embedded liboliphaunt version must match liboliphaunt product version")
    require_text(
        "src/sdks/kotlin/oliphaunt/build.gradle.kts",
        'version = providers.gradleProperty("VERSION_NAME")',
        "Kotlin publication must derive project.version from VERSION_NAME",
    )
    require_text(
        "src/sdks/kotlin/oliphaunt/build.gradle.kts",
        'group = providers.gradleProperty("GROUP")',
        "Kotlin publication must derive group from gradle.properties",
    )
    require_text(
        "src/sdks/kotlin/oliphaunt-android-gradle-plugin/build.gradle.kts",
        'id = "dev.oliphaunt.android"',
        "Kotlin release must publish the app-applied Android Gradle plugin marker",
    )
    require_text(
        "src/sdks/kotlin/README.md",
        "Normal Android app consumers use Gradle, Maven Central",
        "Kotlin README must make the no-Rust consumer install path explicit",
    )
    require_text(
        "src/sdks/kotlin/tools/check-sdk.sh",
        "resolveOliphauntAndroidReleaseAssets",
        "Kotlin SDK package check must exercise the Android release asset resolver",
    )
    require_text(
        "src/sdks/kotlin/tools/check-sdk.sh",
        "create-liboliphaunt-release-fixture.py",
        "Kotlin SDK package check must use deterministic release-shaped liboliphaunt asset fixtures",
    )


def validate_react_native(rn_version: str, swift_version: str, kotlin_version: str) -> None:
    package = json.loads(read_text("src/sdks/react-native/package.json"))
    validate_no_consumer_install_scripts(package, "React Native")
    if package.get("version") != rn_version:
        fail("React Native package.json version must match oliphaunt-react-native product version")
    metadata = package.get("oliphaunt")
    if not isinstance(metadata, dict):
        fail("React Native package.json must include oliphaunt compatibility metadata")
    if metadata.get("swiftSdkVersion") != swift_version:
        fail("React Native package.json swiftSdkVersion must match current Swift SDK version")
    if metadata.get("kotlinSdkVersion") != kotlin_version:
        fail("React Native package.json kotlinSdkVersion must match current Kotlin SDK version")
    require_text(
        "src/sdks/react-native/OliphauntReactNative.podspec",
        'package["version"]',
        "React Native podspec must derive its version from package.json",
    )
    require_text(
        "src/sdks/react-native/OliphauntReactNative.podspec",
        'package.fetch("oliphaunt", {}).fetch("swiftSdkVersion", package["version"])',
        "React Native podspec must derive its Swift SDK dependency from package metadata",
    )
    require_text(
        "src/sdks/react-native/OliphauntReactNative.podspec",
        's.dependency "Oliphaunt", native_sdk_version',
        "React Native podspec must depend on the compatible Swift SDK version",
    )
    require_text(
        "src/sdks/react-native/android/settings.gradle",
        "if (configuredKotlinSdkDir != null && !configuredKotlinSdkDir.isBlank())",
        "React Native Android local Kotlin SDK composite builds must be explicit development overrides",
    )
    require_text(
        "src/sdks/react-native/android/build.gradle",
        '?: "dev.oliphaunt:oliphaunt:${kotlinSdkVersion}"',
        "React Native Android package must default to the published Kotlin SDK Maven coordinate",
    )
    require_text(
        "src/sdks/react-native/tools/check-sdk.sh",
        "local Kotlin SDK composite builds must be explicit development overrides",
        "React Native package check must guard the release-shaped Kotlin dependency boundary",
    )
    require_text(
        "src/sdks/react-native/app.plugin.js",
        "ios/podspecs",
        "React Native Expo config plugin must resolve Swift SDK pods through npm-shipped podspec shims",
    )
    require_text(
        "src/sdks/react-native/app.plugin.js",
        "pod 'COliphaunt', :podspec => File.join(oliphaunt_podspecs_path, 'COliphaunt.podspec')",
        "React Native Expo config plugin must inject the C bridge podspec shim",
    )
    require_text(
        "src/sdks/react-native/ios/podspecs/COliphaunt.podspec",
        "src/sdks/swift/Sources/COliphaunt",
        "React Native C podspec shim must point CocoaPods at the released Swift SDK C bridge source",
    )
    require_text(
        "src/sdks/react-native/ios/podspecs/COliphaunt.podspec",
        's.module_map = "src/sdks/swift/Sources/COliphaunt/include/module.modulemap"',
        "React Native C podspec shim must expose the COliphaunt module map",
    )
    require_text(
        "src/sdks/react-native/ios/podspecs/Oliphaunt.podspec",
        "src/sdks/swift/Sources/Oliphaunt/**/*.swift",
        "React Native Swift podspec shim must point CocoaPods at the released Swift SDK source",
    )
    require_text(
        "src/sdks/react-native/ios/podspecs/Oliphaunt.podspec",
        's.dependency "COliphaunt", swift_sdk_version',
        "React Native Swift podspec shim must depend on the exact C bridge version",
    )
    reject_text(
        "src/sdks/react-native/package.json",
        "prepare-apple-vendor",
        "React Native package must not generate a vendored Swift SDK source slice before publishing",
    )
    repository = package.get("repository")
    if not isinstance(repository, dict):
        fail("React Native package must declare repository metadata")
    if repository.get("url") != "git+https://github.com/f0rr0/oliphaunt.git":
        fail("React Native package repository URL must match canonical release repository")
    if repository.get("directory") != "src/sdks/react-native":
        fail("React Native package repository.directory must point at the package root")
    publish_config = package.get("publishConfig")
    if not isinstance(publish_config, dict) or publish_config.get("provenance") is not True:
        fail("React Native package must request npm provenance")
    require_text(
        "src/sdks/react-native/README.md",
        "Normal React Native and Expo app consumers do not install Rust",
        "React Native README must make the no-Rust consumer install path explicit",
    )


def validate_typescript(
    ts_version: str,
    liboliphaunt_version: str,
    broker_version: str,
    node_direct_version: str,
) -> None:
    package = json.loads(read_text("src/sdks/js/package.json"))
    validate_no_consumer_install_scripts(package, "TypeScript")
    if package.get("version") != ts_version:
        fail("TypeScript package.json version must match oliphaunt-js product version")
    metadata = package.get("oliphaunt")
    if not isinstance(metadata, dict):
        fail("TypeScript package.json must include oliphaunt compatibility metadata")
    if metadata.get("liboliphauntVersion") != liboliphaunt_version:
        fail("TypeScript package.json liboliphauntVersion must match current liboliphaunt product version")
    if metadata.get("brokerVersion") != broker_version:
        fail("TypeScript package.json brokerVersion must match current broker runtime version")
    if metadata.get("nodeDirectAddonVersion") != node_direct_version:
        fail("TypeScript package.json nodeDirectAddonVersion must match current Node direct runtime version")
    if metadata.get("nodeDirectAddon") != "oliphaunt-node-direct":
        fail("TypeScript package.json must identify the Node native-direct adapter it consumes")
    if metadata.get("brokerHelper") != "oliphaunt-broker":
        fail("TypeScript package.json must identify the Rust broker helper it consumes")
    repository = package.get("repository")
    if not isinstance(repository, dict):
        fail("TypeScript package must declare repository metadata")
    if repository.get("url") != "git+https://github.com/f0rr0/oliphaunt.git":
        fail("TypeScript package repository URL must match canonical release repository")
    if repository.get("directory") != "src/sdks/js":
        fail("TypeScript package repository.directory must point at the package root")
    publish_config = package.get("publishConfig")
    if not isinstance(publish_config, dict) or publish_config.get("provenance") is not True:
        fail("TypeScript npm registry artifact must request provenance")
    dependencies = package.get("dependencies", {})
    if isinstance(dependencies, dict) and dependencies:
        fail("TypeScript SDK normal installs must not declare hard runtime dependencies")
    expected_optional = {
        "@oliphaunt/node-direct-darwin-arm64",
        "@oliphaunt/node-direct-linux-x64-gnu",
        "@oliphaunt/node-direct-linux-arm64-gnu",
        "@oliphaunt/node-direct-win32-x64-msvc",
    }
    optional_dependencies = package.get("optionalDependencies", {})
    if not isinstance(optional_dependencies, dict) or set(optional_dependencies) != expected_optional:
        fail("TypeScript package.json must declare exactly the Node direct optional platform packages")
    expected_optional_version = f"workspace:{node_direct_version}"
    stale_optional = {
        name: version
        for name, version in optional_dependencies.items()
        if version != expected_optional_version
    }
    if stale_optional:
        fail(
            "TypeScript package.json Node direct optional dependency versions "
            f"must all be {expected_optional_version}"
        )
    exports = package.get("exports")
    if not isinstance(exports, dict):
        fail("TypeScript package must declare explicit exports")
    for export_name in [".", "./node", "./bun", "./deno", "./protocol", "./query"]:
        if export_name not in exports:
            fail(f"TypeScript package is missing export {export_name}")

    jsr_config = json.loads(read_text("src/sdks/js/jsr.json"))
    if jsr_config.get("name") != "@oliphaunt/ts":
        fail("TypeScript JSR package name must be @oliphaunt/ts")
    if jsr_config.get("version") != ts_version:
        fail("TypeScript jsr.json version must match oliphaunt-js product version")
    jsr_exports = jsr_config.get("exports")
    if not isinstance(jsr_exports, dict):
        fail("TypeScript JSR config must declare explicit exports")
    for export_name in [".", "./node", "./bun", "./deno", "./protocol", "./query"]:
        if export_name not in jsr_exports:
            fail(f"TypeScript JSR package is missing export {export_name}")
    require_text(
        "src/sdks/js/tools/check-sdk.sh",
        "jsr publish --dry-run",
        "TypeScript SDK checks must validate JSR package shape",
    )
    require_text(
        "src/sdks/js/tools/check-sdk.sh",
        "packed TypeScript package must rewrite Node direct optional dependencies to exact published versions",
        "TypeScript SDK checks must inspect the packed npm manifest for publish-safe Node direct optional dependencies",
    )
    require_text(
        "src/sdks/js/tools/check-sdk.sh",
        'tools/dev/bun.sh" "$package_dir/.oliphaunt-bun-smoke.ts"',
        "TypeScript SDK checks must validate Bun through the pinned repo launcher",
    )
    require_text(
        "src/sdks/js/tools/check-sdk.sh",
        ".oliphaunt-bun-smoke.ts",
        "TypeScript SDK checks must run a Bun import smoke for the npm-registry package surface",
    )
    require_text(
        "src/sdks/js/README.md",
        "Deno can consume packages from",
        "TypeScript README must explain npm-vs-JSR install guidance for Deno consumers",
    )
    require_text(
        "src/sdks/js/README.md",
        "There is no `postinstall` native compilation step",
        "TypeScript README must make the no-build consumer install path explicit",
    )
    require_text(
        "src/sdks/js/README.md",
        "Node.js, Bun, and Deno use `nativeDirect` by default",
        "TypeScript README must document the consistent nativeDirect default",
    )
    require_text(
        "src/sdks/js/README.md",
        "prebuilt Node direct adapter",
        "TypeScript README must keep Node direct mode on a zero-build package-owned adapter path",
    )
    require_text(
        "src/sdks/js/ARCHITECTURE.md",
        "Node.js, Bun, and Deno all default to\n`nativeDirect`",
        "TypeScript architecture must keep default engine selection consistent across runtimes",
    )
    require_text(
        "src/sdks/js/ARCHITECTURE.md",
        "oliphaunt-node-direct-*",
        "TypeScript architecture must keep Node direct mode on prebuilt adapter release assets",
    )
    require_text(
        "src/sdks/js/tools/check-sdk.sh",
        "cargo build -p oliphaunt-broker --locked",
        "TypeScript broker smoke must build the Rust broker helper when no released helper is present",
    )
    require_text(
        "src/sdks/js/src/native/common.ts",
        "liboliphaunt-native-v",
        "TypeScript SDK must resolve product-scoped liboliphaunt release tags",
    )
    require_text(
        "src/sdks/js/src/native/assets-node.ts",
        "liboliphauntReleaseAssetUrl",
        "TypeScript Node/Bun native binding must download compatible liboliphaunt release assets",
    )
    require_text(
        "src/sdks/js/src/native/node-addon.ts",
        "oliphaunt-node-direct",
        "TypeScript Node native-direct binding must download compatible Node-API adapter release assets",
    )
    require_text(
        "src/runtimes/node-direct/native/node-addon/oliphaunt_node.cc",
        "NAPI_MODULE",
        "Node direct runtime must have a package-owned Node-API implementation",
    )
    require_text(
        "src/runtimes/node-direct/tools/build-node-addon.sh",
        "oliphaunt-node-direct-$version-$target.tar.gz",
        "Node direct release tooling must package the Node native-direct adapter release asset",
    )
    require_text(
        "src/runtimes/node-direct/tools/build-node-addon.sh",
        "Node direct addon smoke passed",
        "Node direct release tooling must load-smoke the compiled adapter before publishing it",
    )
    require_text(
        "src/runtimes/node-direct/tools/build-node-addon.sh",
        "check_node_direct_release_assets.py",
        "Node direct release tooling must validate addon archives and checksums after building",
    )
    require_text(
        "tools/release/release.py",
        "check_node_direct_release_assets.py",
        "Node direct release publishing must validate addon archives and checksums before upload/npm staging",
    )
    require_text(
        ".github/workflows/ci.yml",
        ".github/scripts/run-planned-moon-job.sh node-direct",
        "Node direct CI matrix must invoke the planned Moon job that includes release-shaped addon artifacts on each published target",
    )
    require_text(
        "src/runtimes/node-direct/moon.yml",
        'tags: ["release", "artifact", "ci-node-direct"]',
        "Node direct release-assets must be selected by the ci-node-direct Moon tag",
    )
    require_text(
        ".github/workflows/ci.yml",
        ".github/actions/setup-msvc",
        "Node direct Windows CI must set up an MSVC developer environment for cl.exe",
    )
    require_text(
        ".github/actions/setup-msvc/action.yml",
        "ilammy/msvc-dev-cmd@0b201ec74fa43914dc39ae48a89fd1d8cb592756",
        "shared MSVC CI setup must use the pinned MSVC developer environment action",
    )
    require_text(
        ".github/actions/setup-msvc/action.yml",
        "CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER",
        "shared MSVC CI setup must force Rust MSVC builds to use the MSVC linker under Git Bash",
    )
    require_text(
        "tools/release/release.py",
        "node_direct_optional_npm_tarballs",
        "Node direct release dry-run must validate staged optional npm tarballs from the builder job",
    )
    require_text(
        "src/sdks/js/src/native/assets-deno.ts",
        "liboliphauntReleaseAssetUrl",
        "TypeScript Deno native binding must download compatible liboliphaunt release assets",
    )
    require_text(
        "src/sdks/js/src/runtime/broker.ts",
        "restorePhysicalArchiveWithBroker",
        "TypeScript broker helper must restore physical archives without requiring third-party Node FFI",
    )
    require_text(
        "src/sdks/js/src/__tests__/asset-resolver.test.ts",
        "nodeResolverInstallsVerifiedReleaseAsset",
        "TypeScript release asset resolver must have regression coverage",
    )
    require_text(
        "src/sdks/js/src/runtime/broker.ts",
        "resolveBrokerNativeInstall",
        "TypeScript broker mode must resolve the liboliphaunt install before launching the Rust helper",
    )
    require_text(
        "src/sdks/js/src/runtime/broker.ts",
        "OLIPHAUNT_INSTALL_DIR",
        "TypeScript broker mode must pass the resolved PostgreSQL runtime tree to the Rust helper",
    )
    require_text(
        "src/sdks/js/src/runtime/broker.ts",
        "LIBOLIPHAUNT_PATH",
        "TypeScript broker mode must pass the resolved liboliphaunt library to the Rust helper",
    )
    require_text(
        "src/sdks/js/src/runtime/broker.ts",
        "oliphauntBrokerReleaseAssetUrl",
        "TypeScript broker mode must resolve the published Rust broker helper release asset",
    )
    require_text(
        "src/sdks/js/src/runtime/broker.ts",
        "OLIPHAUNT_BROKER_ASSET_DIR",
        "TypeScript broker helper resolver must support local release-asset fixtures for tests and release validation",
    )


def validate_node_direct(node_direct_version: str, liboliphaunt_version: str) -> None:
    package = json.loads(read_text("src/runtimes/node-direct/package.json"))
    if package.get("version") != node_direct_version:
        fail("Node direct package.json version must match oliphaunt-node-direct product version")
    metadata = package.get("oliphaunt")
    if not isinstance(metadata, dict):
        fail("Node direct package.json must include oliphaunt compatibility metadata")
    if metadata.get("liboliphauntVersion") != liboliphaunt_version:
        fail("Node direct package.json liboliphauntVersion must match current liboliphaunt product version")


def version_file_value(path: str) -> str:
    if Path(path).name == "Cargo.toml":
        return cargo_manifest_version(path)
    return read_text(path).strip()


def validate_wasm(wasix_runtime_version: str, wasm_binding_version: str) -> None:
    runtime_version_files = product_metadata.version_files("liboliphaunt-wasix")
    for path in runtime_version_files:
        if version_file_value(path) != wasix_runtime_version:
            fail(f"{path} must use liboliphaunt-wasix runtime version {wasix_runtime_version}")
    binding_version_files = product_metadata.version_files("oliphaunt-wasix-rust")
    for path in binding_version_files:
        if version_file_value(path) != wasm_binding_version:
            fail(f"{path} must use oliphaunt-wasix binding version {wasm_binding_version}")
    manifest = tomllib.loads(read_text("src/bindings/wasix-rust/crates/oliphaunt-wasix/Cargo.toml"))
    dependencies = dict(manifest.get("dependencies", {}))
    for target in manifest.get("target", {}).values():
        if isinstance(target, dict) and isinstance(target.get("dependencies"), dict):
            dependencies.update(target["dependencies"])
    for name in [cargo_manifest_name(path) for path in runtime_version_files if Path(path).name == "Cargo.toml"]:
        dependency = dependencies.get(name)
        if not isinstance(dependency, dict):
            fail(f"oliphaunt-wasix dependency {name} must be a table")
        if dependency.get("version") != f"={wasix_runtime_version}":
            fail(f"oliphaunt-wasix dependency {name} must pin version ={wasix_runtime_version}")


def main() -> int:
    graph = load_graph()
    validate_graph_files(graph)
    validate_release_setup_docs()

    versions = {
        product: product_metadata.read_current_version(product)
        for product in product_metadata.product_ids(graph)
    }
    for product, version in versions.items():
        stable_version(version, product)

    validate_rust()
    validate_broker()
    validate_swift(versions["oliphaunt-swift"], versions["liboliphaunt-native"])
    validate_kotlin(versions["oliphaunt-kotlin"], versions["liboliphaunt-native"])
    validate_react_native(
        versions["oliphaunt-react-native"],
        versions["oliphaunt-swift"],
        versions["oliphaunt-kotlin"],
    )
    validate_typescript(
        versions["oliphaunt-js"],
        versions["liboliphaunt-native"],
        versions["oliphaunt-broker"],
        versions["oliphaunt-node-direct"],
    )
    validate_node_direct(versions["oliphaunt-node-direct"], versions["liboliphaunt-native"])
    validate_wasm(versions["liboliphaunt-wasix"], versions["oliphaunt-wasix-rust"])

    print("release metadata checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
