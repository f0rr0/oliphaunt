#!/usr/bin/env python3
"""Validate tracked consumer-facing package shape for Oliphaunt products.

This is deliberately not a public-registry install test. It proves that the
repository surfaces are directionally ready for consumers: package metadata,
install docs, generated app wiring, asset resolver hooks, and exact-extension
selection stay present and consistent with the release metadata.
"""

from __future__ import annotations

import argparse
import json
import sys
import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import NoReturn

import product_metadata
import extension_artifact_targets


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_FIXTURE = ROOT / "src/shared/fixtures/consumer-shape/products.json"
SCHEMA = "oliphaunt-consumer-shape-v1"
SEVERITY_ORDER = {"P0": 0, "P1": 1, "P2": 2}
FORBIDDEN_INSTALL_SCRIPTS = {"preinstall", "install", "postinstall", "prepare"}


@dataclass(frozen=True)
class Finding:
    severity: str
    product: str
    check: str
    message: str
    evidence: tuple[str, ...]

    @property
    def id(self) -> str:
        return f"{self.product}.{self.check}"


def fail(message: str) -> NoReturn:
    print(f"check_consumer_shape.py: {message}", file=sys.stderr)
    raise SystemExit(2)


def relative(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def read_text(path: str) -> str:
    full = ROOT / path
    if not full.is_file():
        fail(f"required checker input is missing: {path}")
    return full.read_text(encoding="utf-8")


def read_optional_text(path: str) -> str | None:
    full = ROOT / path
    if not full.is_file():
        return None
    return full.read_text(encoding="utf-8")


def read_json(path: str) -> dict:
    try:
        value = json.loads(read_text(path))
    except json.JSONDecodeError as error:
        fail(f"{path} is not valid JSON: {error}")
    if not isinstance(value, dict):
        fail(f"{path} must contain a JSON object")
    return value


def read_toml(path: str) -> dict:
    try:
        return tomllib.loads(read_text(path))
    except tomllib.TOMLDecodeError as error:
        fail(f"{path} is not valid TOML: {error}")


def read_gradle_properties(path: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw_line in read_text(path).splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip()
    return values


def parse_products_json(raw: str | None) -> list[str]:
    if raw is None:
        return []
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as error:
        fail(f"--products-json must be valid JSON: {error}")
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        fail("--products-json must be a JSON string list")
    known = set(product_metadata.product_ids())
    unknown = sorted(set(value) - known)
    if unknown:
        fail(f"unknown release products: {', '.join(unknown)}")
    return value


def load_fixture(path: Path) -> dict[str, dict]:
    if not path.is_file():
        fail(f"consumer-shape fixture is missing: {relative(path)}")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        fail(f"{relative(path)} is not valid JSON: {error}")
    if payload.get("schema") != SCHEMA:
        fail(f"{relative(path)} must declare schema {SCHEMA}")
    products = payload.get("products")
    if not isinstance(products, dict):
        fail(f"{relative(path)} must contain a products object")
    for product, config in products.items():
        if not isinstance(config, dict):
            fail(f"{relative(path)} product {product} must be an object")
        files = config.get("files")
        if not isinstance(files, list) or not all(isinstance(item, str) for item in files):
            fail(f"{relative(path)} product {product}.files must be a string list")
        required_text = config.get("requiredText", {})
        if not isinstance(required_text, dict):
            fail(f"{relative(path)} product {product}.requiredText must be an object")
        for required_file, snippets in required_text.items():
            if required_file not in files:
                fail(f"{relative(path)} product {product} requires text in an undeclared file: {required_file}")
            if not isinstance(snippets, list) or not all(isinstance(item, str) for item in snippets):
                fail(f"{relative(path)} product {product}.requiredText[{required_file}] must be a string list")
    return products


def add(
    findings: list[Finding],
    product: str,
    check: str,
    message: str,
    evidence: str | list[str] | tuple[str, ...],
    *,
    severity: str = "P1",
) -> None:
    if isinstance(evidence, str):
        evidence_tuple = (evidence,)
    else:
        evidence_tuple = tuple(evidence)
    findings.append(Finding(severity, product, check, message, evidence_tuple))


def require(
    findings: list[Finding],
    product: str,
    check: str,
    condition: bool,
    message: str,
    evidence: str | list[str] | tuple[str, ...],
    *,
    severity: str = "P1",
) -> None:
    if not condition:
        add(findings, product, check, message, evidence, severity=severity)


def validate_fixture_contract(
    findings: list[Finding],
    fixture: dict[str, dict],
    selected_products: list[str],
) -> None:
    for product in selected_products:
        config = fixture.get(product)
        if config is None:
            add(
                findings,
                product,
                "missing-fixture",
                "Product has no consumer-shape fixture.",
                "src/shared/fixtures/consumer-shape/products.json",
                severity="P0",
            )
            continue
        for path in config["files"]:
            if not (ROOT / path).is_file():
                add(
                    findings,
                    product,
                    "required-file",
                    "Consumer-shape fixture references a file that does not exist.",
                    path,
                    severity="P0",
                )
        for path, snippets in config.get("requiredText", {}).items():
            text = read_optional_text(path)
            if text is None:
                continue
            missing = [snippet for snippet in snippets if snippet not in text]
            if missing:
                add(
                    findings,
                    product,
                    "required-text",
                    "Consumer-facing fixture text is missing.",
                    [f"{path}: {snippet}" for snippet in missing],
                    severity="P1",
                )


def product_registry_packages(product: str) -> list[str]:
    config = product_metadata.product_config(product)
    packages = config.get("registry_packages", [])
    if not isinstance(packages, list):
        fail(f"{product}.registry_packages must be a list")
    return [str(package) for package in packages]


def product_publish_targets(product: str) -> list[str]:
    config = product_metadata.product_config(product)
    targets = config.get("publish_targets", [])
    if not isinstance(targets, list):
        fail(f"{product}.publish_targets must be a list")
    return [str(target) for target in targets]


def check_npm_package_common(
    findings: list[Finding],
    product: str,
    path: str,
    expected_name: str,
    expected_directory: str,
) -> dict:
    package = read_json(path)
    require(
        findings,
        product,
        "npm-name",
        package.get("name") == expected_name,
        "npm package name must match the public registry identity.",
        f"{path}: name={package.get('name')!r}",
        severity="P0",
    )
    require(
        findings,
        product,
        "npm-version",
        package.get("version") == product_metadata.read_current_version(product),
        "npm package version must match the release metadata product version.",
        f"{path}: version={package.get('version')!r}",
        severity="P0",
    )
    repository = package.get("repository", {})
    require(
        findings,
        product,
        "npm-repository",
        isinstance(repository, dict)
        and repository.get("url") == "git+https://github.com/f0rr0/oliphaunt.git"
        and repository.get("directory") == expected_directory,
        "npm package repository metadata must point at the public repo and product directory.",
        f"{path}: repository={repository!r}",
    )
    publish_config = package.get("publishConfig", {})
    require(
        findings,
        product,
        "npm-provenance",
        isinstance(publish_config, dict)
        and publish_config.get("access") == "public"
        and publish_config.get("provenance") is True,
        "npm publishConfig must opt into public provenance publishing.",
        f"{path}: publishConfig={publish_config!r}",
        severity="P0",
    )
    scripts = package.get("scripts", {})
    forbidden = sorted(set(scripts) & FORBIDDEN_INSTALL_SCRIPTS) if isinstance(scripts, dict) else []
    require(
        findings,
        product,
        "npm-install-scripts",
        not forbidden,
        "Consumer installs must not run native build or repository-local setup scripts.",
        f"{path}: forbidden scripts={', '.join(forbidden)}",
        severity="P0",
    )
    return package


def check_liboliphaunt(findings: list[Finding]) -> None:
    product = "liboliphaunt-native"
    version = read_text("src/runtimes/liboliphaunt/native/VERSION").strip()
    require(
        findings,
        product,
        "version-source",
        version == product_metadata.read_current_version(product),
        "liboliphaunt VERSION must be the release metadata version source.",
        f"src/runtimes/liboliphaunt/native/VERSION={version!r}",
        severity="P0",
    )
    script = read_text("tools/release/package-liboliphaunt-assets.sh")
    for required in [
        "assert_base_runtime_has_no_optional_extensions",
        "liboliphaunt-${version}-release-assets.sha256",
        "stage_runtime_resources=\"$stage_root/liboliphaunt-${version}-runtime-resources\"",
        "archive_staged_dir \"$stage_runtime_resources\"",
        "liboliphaunt-${version}-apple-spm-xcframework.zip",
    ]:
        require(
            findings,
            product,
            "asset-packaging",
            required in script,
            "liboliphaunt release packaging must publish base runtime assets and checksums.",
            f"tools/release/package-liboliphaunt-assets.sh missing {required}",
            severity="P0",
        )
    for forbidden in [
        "write_extension_asset_index_header",
        "src/extensions/artifacts/native/tools/package-release-assets.sh",
    ]:
        require(
            findings,
            product,
            "asset-packaging",
            forbidden not in script,
            "liboliphaunt release packaging must not publish exact-extension artifacts; extension products own those assets.",
            f"tools/release/package-liboliphaunt-assets.sh still contains {forbidden}",
            severity="P0",
        )


def check_rust(findings: list[Finding]) -> None:
    product = "oliphaunt-rust"
    manifest = read_toml("src/sdks/rust/Cargo.toml")
    package = manifest.get("package", {})
    require(
        findings,
        product,
        "cargo-name",
        package.get("name") == "oliphaunt",
        "Rust SDK crate name must match the public crates.io package.",
        f"src/sdks/rust/Cargo.toml package.name={package.get('name')!r}",
        severity="P0",
    )
    require(
        findings,
        product,
        "cargo-version",
        package.get("version") == product_metadata.read_current_version(product),
        "Rust SDK crate version must match the release metadata product version.",
        f"src/sdks/rust/Cargo.toml package.version={package.get('version')!r}",
        severity="P0",
    )
    bins = {item.get("name") for item in manifest.get("bin", []) if isinstance(item, dict)}
    require(
        findings,
        product,
        "cargo-binaries",
        "oliphaunt-resources" in bins,
        "Rust SDK must ship the runtime resource helper binary it documents.",
        "missing [[bin]] oliphaunt-resources",
        severity="P0",
    )
    require(
        findings,
        product,
        "registry-package",
        "crates:oliphaunt" in product_registry_packages(product),
        "Rust SDK release metadata must publish the Rust SDK to crates.io.",
        "src/sdks/rust/release.toml",
        severity="P0",
    )


def check_broker(findings: list[Finding]) -> None:
    product = "oliphaunt-broker"
    manifest = read_toml("src/runtimes/broker/Cargo.toml")
    package = manifest.get("package", {})
    require(
        findings,
        product,
        "cargo-name",
        package.get("name") == "oliphaunt-broker",
        "Broker runtime package name must match the helper executable product.",
        f"src/runtimes/broker/Cargo.toml package.name={package.get('name')!r}",
        severity="P0",
    )
    bins = {item.get("name") for item in manifest.get("bin", []) if isinstance(item, dict)}
    require(
        findings,
        product,
        "broker-binary",
        "oliphaunt-broker" in bins,
        "Broker runtime must ship the oliphaunt-broker executable.",
        "missing [[bin]] oliphaunt-broker",
        severity="P0",
    )
    require(
        findings,
        product,
        "release-assets",
        "github-release-assets" in product_publish_targets(product),
        "Broker runtime must publish platform helper binaries as release assets.",
        "src/runtimes/broker/release.toml",
        severity="P0",
    )


def check_node_direct(findings: list[Finding]) -> None:
    product = "oliphaunt-node-direct"
    package = read_json("src/runtimes/node-direct/package.json")
    version = product_metadata.read_current_version(product)
    require(
        findings,
        product,
        "npm-name",
        package.get("name") == "@oliphaunt/node-direct" and package.get("private") is True,
        "Node direct root package must stay a private source/build package; only platform packages are published.",
        f"src/runtimes/node-direct/package.json name={package.get('name')!r} private={package.get('private')!r}",
        severity="P0",
    )
    require(
        findings,
        product,
        "npm-version",
        package.get("version") == version,
        "Node direct root package version must match the release metadata product version.",
        f"src/runtimes/node-direct/package.json version={package.get('version')!r}",
        severity="P0",
    )
    metadata = package.get("oliphaunt", {})
    require(
        findings,
        product,
        "node-direct-liboliphaunt-pin",
        isinstance(metadata, dict)
        and metadata.get("liboliphauntVersion") == product_metadata.read_current_version("liboliphaunt-native"),
        "Node direct source package must pin the compatible native liboliphaunt runtime version.",
        f"src/runtimes/node-direct/package.json oliphaunt={metadata!r}",
        severity="P0",
    )
    scripts = package.get("scripts", {})
    forbidden = sorted(set(scripts) & FORBIDDEN_INSTALL_SCRIPTS) if isinstance(scripts, dict) else []
    require(
        findings,
        product,
        "npm-install-scripts",
        not forbidden,
        "Node direct source package must not run native build scripts during consumer install.",
        f"src/runtimes/node-direct/package.json forbidden scripts={', '.join(forbidden)}",
        severity="P0",
    )
    require(
        findings,
        product,
        "release-targets",
        {"npm", "github-release-assets"}.issubset(product_publish_targets(product))
        and {
            "node-api-prebuilds",
            "npm-optional-platform-packages",
        }.issubset(set(product_metadata.product_config(product).get("release_artifacts", []))),
        "Node direct must publish both GitHub prebuild assets and optional npm platform packages.",
        "src/runtimes/node-direct/release.toml",
        severity="P0",
    )

    expected_packages = {
        "darwin-arm64": ("@oliphaunt/node-direct-darwin-arm64", ("darwin",), ("arm64",), None),
        "linux-x64-gnu": ("@oliphaunt/node-direct-linux-x64-gnu", ("linux",), ("x64",), ("glibc",)),
        "linux-arm64-gnu": ("@oliphaunt/node-direct-linux-arm64-gnu", ("linux",), ("arm64",), ("glibc",)),
        "win32-x64-msvc": ("@oliphaunt/node-direct-win32-x64-msvc", ("win32",), ("x64",), None),
    }
    require(
        findings,
        product,
        "registry-packages",
        set(product_registry_packages(product)) == {f"npm:{name}" for name, _os, _cpu, _libc in expected_packages.values()},
        "Node direct release metadata must publish exactly the optional platform npm packages.",
        f"src/runtimes/node-direct/release.toml registry_packages={product_registry_packages(product)!r}",
        severity="P0",
    )
    for directory, (package_name, expected_os, expected_cpu, expected_libc) in expected_packages.items():
        package_path = f"src/runtimes/node-direct/packages/{directory}/package.json"
        optional_package = check_npm_package_common(
            findings,
            product,
            package_path,
            package_name,
            f"src/runtimes/node-direct/packages/{directory}",
        )
        require(
            findings,
            product,
            "node-direct-platform-package",
            optional_package.get("optional") is True
            and optional_package.get("os") == list(expected_os)
            and optional_package.get("cpu") == list(expected_cpu)
            and (expected_libc is None or optional_package.get("libc") == list(expected_libc)),
            "Node direct platform packages must constrain npm installation to the matching OS, CPU, and libc.",
            f"{package_path}: os={optional_package.get('os')!r} cpu={optional_package.get('cpu')!r} libc={optional_package.get('libc')!r}",
            severity="P0",
        )
        require(
            findings,
            product,
            "node-direct-platform-package",
            "prebuilds" in optional_package.get("files", [])
            and optional_package.get("exports", {}).get("./oliphaunt_node.node") == "./prebuilds/oliphaunt_node.node",
            "Node direct platform packages must expose the prebuilt addon by the stable export path.",
            f"{package_path}: files={optional_package.get('files')!r} exports={optional_package.get('exports')!r}",
            severity="P0",
        )


def check_swift(findings: list[Finding]) -> None:
    product = "oliphaunt-swift"
    version = read_text("src/sdks/swift/VERSION").strip()
    lib_version = read_text("src/sdks/swift/LIBOLIPHAUNT_VERSION").strip()
    require(
        findings,
        product,
        "swift-version",
        version == product_metadata.read_current_version(product),
        "Swift SDK VERSION must be the release metadata product version.",
        f"src/sdks/swift/VERSION={version!r}",
        severity="P0",
    )
    require(
        findings,
        product,
        "swift-liboliphaunt-pin",
        lib_version == product_metadata.read_current_version("liboliphaunt-native"),
        "Swift SDK must pin the compatible liboliphaunt release.",
        f"src/sdks/swift/LIBOLIPHAUNT_VERSION={lib_version!r}",
        severity="P0",
    )
    root_package = read_text("Package.swift")
    for required in [
        'name: "Oliphaunt"',
        ".iOS(.v17)",
        ".macOS(.v14)",
        'path: "src/sdks/swift/Sources/COliphaunt"',
        'path: "src/sdks/swift/Sources/Oliphaunt"',
    ]:
        require(
            findings,
            product,
            "swiftpm-source-package",
            required in root_package,
            "Root SwiftPM source package must remain a normal Apple consumer entrypoint.",
            f"Package.swift missing {required}",
            severity="P0",
        )
    renderer = read_text("tools/release/render_swiftpm_release_package.py")
    for required in ["binaryTarget(", "checksum", "base Swift package must not require or publish extension files"]:
        require(
            findings,
            product,
            "swiftpm-release-manifest",
            required in renderer,
            "Swift release manifest renderer must checksum-pin the base binary target and keep extensions separate.",
            f"tools/release/render_swiftpm_release_package.py missing {required}",
            severity="P0",
        )
    for forbidden in ["extension_rows", "OliphauntExtension"]:
        require(
            findings,
            product,
            "swiftpm-release-manifest",
            forbidden not in renderer,
            "Swift base release manifest renderer must not synthesize exact-extension products.",
            f"tools/release/render_swiftpm_release_package.py still contains {forbidden}",
            severity="P0",
        )


def check_kotlin(findings: list[Finding]) -> None:
    product = "oliphaunt-kotlin"
    props = read_gradle_properties("src/sdks/kotlin/gradle.properties")
    require(
        findings,
        product,
        "kotlin-coordinates",
        props.get("GROUP") == "dev.oliphaunt",
        "Kotlin SDK group must match the public Maven coordinates.",
        f"src/sdks/kotlin/gradle.properties GROUP={props.get('GROUP')!r}",
        severity="P0",
    )
    require(
        findings,
        product,
        "kotlin-version",
        props.get("VERSION_NAME") == product_metadata.read_current_version(product),
        "Kotlin SDK version must match the release metadata product version.",
        f"src/sdks/kotlin/gradle.properties VERSION_NAME={props.get('VERSION_NAME')!r}",
        severity="P0",
    )
    pinned_lib = read_text(
        "src/sdks/kotlin/oliphaunt-android-gradle-plugin/src/main/resources/dev/oliphaunt/android/liboliphaunt.version"
    ).strip()
    require(
        findings,
        product,
        "android-liboliphaunt-pin",
        pinned_lib == product_metadata.read_current_version("liboliphaunt-native"),
        "Android Gradle plugin must pin the compatible liboliphaunt release.",
        f"liboliphaunt.version={pinned_lib!r}",
        severity="P0",
    )
    plugin_source = read_text(
        "src/sdks/kotlin/oliphaunt-android-gradle-plugin/src/main/java/dev/oliphaunt/android/OliphauntAndroidPlugin.java"
    )
    resolver_source = read_text(
        "src/sdks/kotlin/oliphaunt-android-gradle-plugin/src/main/java/dev/oliphaunt/android/ResolveOliphauntAndroidAssetsTask.java"
    )
    android_plugin_surface = plugin_source + "\n" + resolver_source
    for required in ["dev.oliphaunt.android", "oliphauntExtensions", "resolveOliphauntAndroidAssets"]:
        require(
            findings,
            product,
            "android-consumer-plugin",
            required in plugin_source,
            "Android SDK must expose an app-applied Gradle plugin for consumer asset wiring.",
            f"OliphauntAndroidPlugin.java missing {required}",
            severity="P0",
        )
    for required in [
        "oliphaunt-extension-",
        "oliphauntExtensionVersions",
        "manifest.properties",
        "release-assets.sha256",
        "downloadAndVerifyExtension",
    ]:
        require(
            findings,
            product,
            "android-exact-extension-resolver",
            required in android_plugin_surface,
            "Android asset resolver must consume exact-extension release products rather than liboliphaunt-bundled extension indexes.",
            f"ResolveOliphauntAndroidAssetsTask.java missing {required}",
            severity="P0",
        )


def check_react_native(findings: list[Finding]) -> None:
    product = "oliphaunt-react-native"
    package = check_npm_package_common(
        findings,
        product,
        "src/sdks/react-native/package.json",
        "@oliphaunt/react-native",
        "src/sdks/react-native",
    )
    require(
        findings,
        product,
        "rn-peer-dependencies",
        "react-native" in package.get("peerDependencies", {}) and "react" in package.get("peerDependencies", {}),
        "React Native package must peer-depend on React and React Native instead of bundling app frameworks.",
        "src/sdks/react-native/package.json peerDependencies",
        severity="P0",
    )
    require(
        findings,
        product,
        "rn-codegen",
        isinstance(package.get("codegenConfig"), dict)
        and package["codegenConfig"].get("jsSrcsDir") == "src/specs"
        and package.get("react-native") == "lib/module/index.js",
        "React Native package must expose New Architecture Codegen metadata and compiled React Native entrypoint.",
        "src/sdks/react-native/package.json",
        severity="P0",
    )
    metadata = package.get("oliphaunt", {})
    require(
        findings,
        product,
        "rn-sdk-compatibility",
        isinstance(metadata, dict)
        and metadata.get("swiftSdkVersion") == product_metadata.read_current_version("oliphaunt-swift")
        and metadata.get("kotlinSdkVersion") == product_metadata.read_current_version("oliphaunt-kotlin"),
        "React Native package must pin compatible Swift and Kotlin SDK versions.",
        f"src/sdks/react-native/package.json oliphaunt={metadata!r}",
        severity="P0",
    )
    plugin = read_text("src/sdks/react-native/app.plugin.js")
    for required in [
        "extension '${extension}' must be an exact PostgreSQL extension name",
        "oliphauntExtensions",
        "OliphauntExtensions.json",
        "pod 'Oliphaunt'",
        "dev.oliphaunt.android",
    ]:
        require(
            findings,
            product,
            "expo-config-plugin",
            required in plugin,
            "React Native config plugin must wire exact extension selection through iOS and Android app projects.",
            f"src/sdks/react-native/app.plugin.js missing {required}",
            severity="P0",
        )
    podspec = read_text("src/sdks/react-native/OliphauntReactNative.podspec")
    require(
        findings,
        product,
        "rn-podspec",
        's.dependency "Oliphaunt", native_sdk_version' in podspec and "install_modules_dependencies(s)" in podspec,
        "React Native podspec must delegate iOS runtime behavior to the Swift SDK and RN autolinking.",
        "src/sdks/react-native/OliphauntReactNative.podspec",
        severity="P0",
    )


def check_typescript(findings: list[Finding]) -> None:
    product = "oliphaunt-js"
    package = check_npm_package_common(
        findings,
        product,
        "src/sdks/js/package.json",
        "@oliphaunt/ts",
        "src/sdks/js",
    )
    require(
        findings,
        product,
        "ts-no-runtime-deps",
        not package.get("dependencies"),
        "TypeScript SDK normal installs must not pull a surprise FFI or native-build dependency.",
        "src/sdks/js/package.json dependencies",
        severity="P0",
    )
    expected_optional = {
        "@oliphaunt/node-direct-darwin-arm64",
        "@oliphaunt/node-direct-linux-x64-gnu",
        "@oliphaunt/node-direct-linux-arm64-gnu",
        "@oliphaunt/node-direct-win32-x64-msvc",
    }
    optional_dependencies = package.get("optionalDependencies", {})
    require(
        findings,
        product,
        "ts-node-direct-optional-deps",
        isinstance(optional_dependencies, dict) and set(optional_dependencies) == expected_optional,
        "TypeScript SDK must select Node direct through exact optional platform packages.",
        f"src/sdks/js/package.json optionalDependencies={optional_dependencies!r}",
        severity="P0",
    )
    metadata = package.get("oliphaunt", {})
    require(
        findings,
        product,
        "ts-sdk-compatibility",
        isinstance(metadata, dict)
        and metadata.get("liboliphauntVersion") == product_metadata.read_current_version("liboliphaunt-native")
        and metadata.get("brokerVersion") == product_metadata.read_current_version("oliphaunt-broker")
        and metadata.get("nodeDirectAddonVersion") == product_metadata.read_current_version("oliphaunt-node-direct"),
        "TypeScript SDK must pin compatible liboliphaunt, broker-helper, and Node direct versions.",
        f"src/sdks/js/package.json oliphaunt={metadata!r}",
        severity="P0",
    )
    exports = package.get("exports", {})
    for export_name in [".", "./node", "./bun", "./deno", "./protocol", "./query"]:
        require(
            findings,
            product,
            "ts-exports",
            export_name in exports,
            "TypeScript SDK must publish runtime-specific and protocol exports.",
            f"src/sdks/js/package.json missing exports[{export_name}]",
            severity="P0",
        )
    jsr = read_json("src/sdks/js/jsr.json")
    require(
        findings,
        product,
        "jsr-version",
        jsr.get("version") == product_metadata.read_current_version(product),
        "JSR version must match the TypeScript release metadata product version.",
        f"src/sdks/js/jsr.json version={jsr.get('version')!r}",
        severity="P0",
    )
    jsr_exports = jsr.get("exports", {})
    require(
        findings,
        product,
        "jsr-exports",
        isinstance(jsr_exports, dict) and {"./deno", "./protocol", "./query"}.issubset(jsr_exports),
        "JSR package must expose the Deno-native and shared protocol entrypoints.",
        f"src/sdks/js/jsr.json exports={jsr_exports!r}",
        severity="P0",
    )


def check_wasm(findings: list[Finding]) -> None:
    product = "oliphaunt-wasix-rust"
    manifest = read_toml("src/bindings/wasix-rust/crates/oliphaunt-wasix/Cargo.toml")
    package = manifest.get("package", {})
    require(
        findings,
        product,
        "wasm-crate-name",
        package.get("name") == "oliphaunt-wasix",
        "WASM crate name must match the public crate.",
        f"oliphaunt-wasix Cargo.toml package.name={package.get('name')!r}",
        severity="P0",
    )
    require(
        findings,
        product,
        "wasm-version",
        package.get("version") == product_metadata.read_current_version(product),
        "WASM crate version must match the release metadata product version.",
        f"oliphaunt-wasix Cargo.toml package.version={package.get('version')!r}",
        severity="P0",
    )
    metadata = package.get("metadata", {}).get("oliphaunt-wasix", {}).get("assets", {})
    require(
        findings,
        product,
        "wasm-pg18",
        metadata.get("postgres-version") == "18.4",
        "WASM consumer crate must advertise the active PostgreSQL 18.4 runtime.",
        f"package.metadata.oliphaunt-wasix.assets.postgres-version={metadata.get('postgres-version')!r}",
        severity="P0",
    )
    features = manifest.get("features", {})
    require(
        findings,
        product,
        "wasm-bundled-assets",
        "bundled" in features and "extensions" in features,
        "WASM crate must keep bundled runtime/assets as an explicit consumer feature.",
        "oliphaunt-wasix Cargo.toml features",
        severity="P0",
    )


def check_liboliphaunt_wasix(findings: list[Finding]) -> None:
    product = "liboliphaunt-wasix"
    version = read_text("src/runtimes/liboliphaunt/wasix/VERSION").strip()
    require(
        findings,
        product,
        "wasix-runtime-version",
        version == product_metadata.read_current_version(product),
        "WASIX runtime VERSION must be the release metadata product version.",
        f"src/runtimes/liboliphaunt/wasix/VERSION={version!r}",
        severity="P0",
    )
    asset_manifest = read_toml("src/runtimes/liboliphaunt/wasix/crates/assets/Cargo.toml")
    asset_package = asset_manifest.get("package", {})
    require(
        findings,
        product,
        "wasix-assets-crate",
        asset_package.get("name") == "oliphaunt-wasix-assets"
        and asset_package.get("version") == product_metadata.read_current_version(product),
        "WASIX runtime asset crate must publish under the runtime product version.",
        f"src/runtimes/liboliphaunt/wasix/crates/assets/Cargo.toml package={asset_package!r}",
        severity="P0",
    )
    require(
        findings,
        product,
        "wasix-publish-targets",
        {"crates-io", "github-release-assets"}.issubset(product_publish_targets(product)),
        "WASIX runtime must publish Cargo asset/AOT crates and GitHub runtime assets.",
        "src/runtimes/liboliphaunt/wasix/release.toml",
        severity="P0",
    )
    registry_packages = set(product_registry_packages(product))
    require(
        findings,
        product,
        "wasix-registry-packages",
        {
            "crates:oliphaunt-wasix-assets",
            "crates:oliphaunt-wasix-aot-aarch64-apple-darwin",
            "crates:oliphaunt-wasix-aot-x86_64-unknown-linux-gnu",
            "crates:oliphaunt-wasix-aot-aarch64-unknown-linux-gnu",
            "crates:oliphaunt-wasix-aot-x86_64-pc-windows-msvc",
        }.issubset(registry_packages),
        "WASIX runtime release metadata must expose the portable assets crate and every published AOT crate.",
        f"src/runtimes/liboliphaunt/wasix/release.toml registry_packages={sorted(registry_packages)!r}",
        severity="P0",
    )


def check_exact_extension(findings: list[Finding], product: str) -> None:
    config = product_metadata.product_config(product)
    package_path = product_metadata.package_path(product)
    sql_name = config.get("extension_sql_name")
    version_path = f"{package_path}/VERSION"
    version = read_text(version_path).strip()
    require(
        findings,
        product,
        "extension-version",
        version == product_metadata.read_current_version(product),
        "Exact-extension VERSION must be the release metadata product version.",
        f"{version_path}={version!r}",
        severity="P0",
    )
    require(
        findings,
        product,
        "extension-release-metadata",
        config.get("kind") == "exact-extension-artifact"
        and product_publish_targets(product) == ["github-release-assets"]
        and config.get("release_artifacts") == ["exact-extension-artifacts"]
        and isinstance(sql_name, str)
        and sql_name,
        "Exact-extension release metadata must publish only exact GitHub artifact assets by SQL extension name.",
        f"{package_path}/release.toml",
        severity="P0",
    )
    target_file = f"{package_path}/targets/artifacts.toml"
    read_toml(target_file)
    targets = extension_artifact_targets.artifact_targets(product=product, published_only=True)
    native_targets = {target.target for target in targets if target.family == "native"}
    wasix_targets = {target.target for target in targets if target.family == "wasix"}
    require(
        findings,
        product,
        "extension-targets",
        {
            "android-arm64-v8a",
            "android-x86_64",
            "ios-xcframework",
            "linux-arm64-gnu",
            "linux-x64-gnu",
            "macos-arm64",
        }.issubset(native_targets)
        and wasix_targets == {"wasix-portable"},
        "Exact-extension artifact targets must cover mobile and non-Windows native artifact surfaces plus WASIX portable; optional platform opt-outs must be explicit in target metadata.",
        f"{target_file}: native={sorted(native_targets)!r} wasix={sorted(wasix_targets)!r}",
        severity="P0",
    )
    require(
        findings,
        product,
        "extension-consumer-assets",
        all(target.kind == "native-static-registry" for target in targets if target.target.startswith("android-") or target.target == "ios-xcframework")
        and all(target.kind == "native-dynamic" for target in targets if target.target.startswith(("linux-", "macos-", "windows-")))
        and all(target.kind == "wasix-runtime" for target in targets if target.family == "wasix"),
        "Exact-extension target metadata must distinguish mobile static-registry artifacts, desktop dynamic artifacts, and WASIX runtime artifacts.",
        target_file,
        severity="P0",
    )


PRODUCT_CHECKS = {
    "liboliphaunt-native": check_liboliphaunt,
    "liboliphaunt-wasix": check_liboliphaunt_wasix,
    "oliphaunt-rust": check_rust,
    "oliphaunt-broker": check_broker,
    "oliphaunt-node-direct": check_node_direct,
    "oliphaunt-swift": check_swift,
    "oliphaunt-kotlin": check_kotlin,
    "oliphaunt-react-native": check_react_native,
    "oliphaunt-js": check_typescript,
    "oliphaunt-wasix-rust": check_wasm,
}


def exact_extension_products() -> set[str]:
    return {
        product
        for product in product_metadata.product_ids()
        if product_metadata.product_config(product).get("kind") == "exact-extension-artifact"
    }


def known_consumer_products() -> set[str]:
    return set(PRODUCT_CHECKS) | exact_extension_products()


def collect_findings(selected_products: list[str], fixture_path: Path) -> list[Finding]:
    fixture = load_fixture(fixture_path)
    findings: list[Finding] = []
    validate_fixture_contract(findings, fixture, selected_products)
    for product in selected_products:
        check = PRODUCT_CHECKS.get(product)
        if check is not None:
            check(findings)
            continue
        if product in exact_extension_products():
            check_exact_extension(findings, product)
            continue
        else:
            add(
                findings,
                product,
                "missing-product-check",
                "Product has no consumer-shape metadata checker.",
                "tools/release/check_consumer_shape.py",
                severity="P0",
            )
    return sorted(findings, key=lambda finding: (SEVERITY_ORDER[finding.severity], finding.product, finding.check))


def apply_filters(findings: list[Finding], severities: list[str], ids: list[str]) -> list[Finding]:
    severity_set = set(severities)
    id_set = set(ids)
    if severity_set:
        findings = [finding for finding in findings if finding.severity in severity_set]
    if id_set:
        findings = [finding for finding in findings if finding.id in id_set]
    return findings


def payload(selected_products: list[str], findings: list[Finding]) -> dict:
    counts: dict[str, int] = {}
    for finding in findings:
        counts[finding.severity] = counts.get(finding.severity, 0) + 1
    return {
        "schema": SCHEMA,
        "products": selected_products,
        "ready": len(findings) == 0,
        "findingCount": len(findings),
        "countsBySeverity": counts,
        "findings": [
            {
                "id": finding.id,
                "severity": finding.severity,
                "product": finding.product,
                "check": finding.check,
                "message": finding.message,
                "evidence": list(finding.evidence),
            }
            for finding in findings
        ],
    }


def print_text(report: dict) -> None:
    if report["ready"]:
        print("consumer shape checks passed")
        return
    print(f"consumer shape gaps found: {report['findingCount']}")
    for finding in report["findings"]:
        print(f"- [{finding['severity']}] {finding['id']}: {finding['message']}")
        for evidence in finding["evidence"]:
            print(f"  evidence: {evidence}")


def print_markdown(report: dict) -> None:
    print("# Consumer Shape Readiness\n")
    if report["ready"]:
        print("No consumer-shape gaps were found.")
        return
    print("| Severity | Finding | Message | Evidence |")
    print("| --- | --- | --- | --- |")
    for finding in report["findings"]:
        evidence = "<br>".join(str(item).replace("|", "\\|") for item in finding["evidence"])
        print(
            f"| {finding['severity']} | `{finding['id']}` | "
            f"{finding['message'].replace('|', '\\|')} | {evidence} |"
        )


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture", default=str(DEFAULT_FIXTURE))
    parser.add_argument("--products-json")
    parser.add_argument("--product", action="append", default=[])
    parser.add_argument("--severity", action="append", choices=sorted(SEVERITY_ORDER))
    parser.add_argument("--id", action="append", default=[])
    parser.add_argument("--format", choices=["text", "json", "markdown"], default="text")
    parser.add_argument("--require-ready", action="store_true")
    args = parser.parse_args(argv)

    selected = args.product or parse_products_json(args.products_json) or sorted(known_consumer_products())
    unknown = sorted(set(selected) - known_consumer_products())
    if unknown:
        fail(f"unknown consumer-shape products: {', '.join(unknown)}")

    findings = collect_findings(selected, Path(args.fixture))
    findings = apply_filters(findings, args.severity or [], args.id)
    report = payload(selected, findings)

    if args.format == "json":
        print(json.dumps(report, indent=2, sort_keys=True))
    elif args.format == "markdown":
        print_markdown(report)
    else:
        print_text(report)

    if args.require_ready and findings:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
