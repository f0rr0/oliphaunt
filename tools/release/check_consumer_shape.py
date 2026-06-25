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

import artifact_targets
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


def require_absent_text(
    findings: list[Finding],
    product: str,
    check: str,
    path: str,
    fragments: list[str] | tuple[str, ...],
    message: str,
    *,
    severity: str = "P0",
) -> None:
    text = read_text(path)
    present = [fragment for fragment in fragments if fragment in text]
    require(
        findings,
        product,
        check,
        not present,
        message,
        [f"{path}: {fragment}" for fragment in present] or path,
        severity=severity,
    )


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
    result = [str(package) for package in packages]
    if config.get("kind") == "exact-extension-artifact":
        result.extend(
            f"maven:dev.oliphaunt.extensions:{product}-{target.target}"
            for target in extension_artifact_targets.published_android_maven_targets(product)
        )
    return result


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
    expected_registry_packages = {
        "crates:liboliphaunt-native-linux-arm64-gnu",
        "crates:liboliphaunt-native-linux-x64-gnu",
        "crates:liboliphaunt-native-macos-arm64",
        "crates:liboliphaunt-native-windows-x64-msvc",
        "crates:oliphaunt-tools-linux-arm64-gnu",
        "crates:oliphaunt-tools-linux-x64-gnu",
        "crates:oliphaunt-tools-macos-arm64",
        "crates:oliphaunt-tools-windows-x64-msvc",
        "npm:@oliphaunt/icu",
        "npm:@oliphaunt/liboliphaunt-darwin-arm64",
        "npm:@oliphaunt/liboliphaunt-linux-x64-gnu",
        "npm:@oliphaunt/liboliphaunt-linux-arm64-gnu",
        "npm:@oliphaunt/liboliphaunt-win32-x64-msvc",
        "npm:@oliphaunt/tools-darwin-arm64",
        "npm:@oliphaunt/tools-linux-arm64-gnu",
        "npm:@oliphaunt/tools-linux-x64-gnu",
        "npm:@oliphaunt/tools-win32-x64-msvc",
        "maven:dev.oliphaunt.runtime:oliphaunt-icu",
        "maven:dev.oliphaunt.runtime:liboliphaunt-runtime-resources",
        "maven:dev.oliphaunt.runtime:liboliphaunt-android-arm64-v8a",
        "maven:dev.oliphaunt.runtime:liboliphaunt-android-x86_64",
    }
    require(
        findings,
        product,
        "liboliphaunt-platform-packages",
        {"github-release-assets", "npm", "maven-central", "crates-io"}.issubset(product_publish_targets(product))
        and set(product_registry_packages(product)) == expected_registry_packages,
        "liboliphaunt native runtime must publish package-manager artifacts for Rust, Node, Android, and optional ICU consumers.",
        f"src/runtimes/liboliphaunt/native/release.toml registry_packages={product_registry_packages(product)!r}",
        severity="P0",
    )
    icu_package = read_json("src/runtimes/liboliphaunt/native/icu-npm/package.json")
    icu_metadata = icu_package.get("oliphaunt", {})
    require(
        findings,
        product,
        "liboliphaunt-icu-npm-package",
        icu_package.get("name") == "@oliphaunt/icu"
        and icu_package.get("version") == version
        and isinstance(icu_metadata, dict)
        and icu_metadata.get("product") == "oliphaunt-icu"
        and icu_metadata.get("kind") == "icu-data"
        and icu_metadata.get("target") == "portable"
        and icu_metadata.get("dataRelativePath") == "share/icu",
        "Optional native ICU data must publish as a standalone portable npm package.",
        "src/runtimes/liboliphaunt/native/icu-npm/package.json",
        severity="P0",
    )
    icu_podspec = read_text("src/runtimes/liboliphaunt/native/icu-npm/OliphauntICU.podspec")
    release_config = read_json("release-please-config.json")
    native_release = release_config.get("packages", {}).get("src/runtimes/liboliphaunt/native", {})
    native_extra_files = native_release.get("extra-files", [])
    require(
        findings,
        product,
        "liboliphaunt-icu-release-versioning",
        f"s.version = '{version}'" in icu_podspec
        and "x-release-please-version" in icu_podspec
        and {
            "type": "json",
            "path": "icu-npm/package.json",
            "jsonpath": "$.version",
        }
        in native_extra_files
        and {"type": "generic", "path": "icu-npm/OliphauntICU.podspec"} in native_extra_files,
        "Optional native ICU npm and podspec descriptors must version with liboliphaunt-native.",
        "release-please-config.json and src/runtimes/liboliphaunt/native/icu-npm/OliphauntICU.podspec",
        severity="P0",
    )
    release_cli = read_text("tools/release/release.py")
    workflow = read_text(".github/workflows/release.yml")
    require(
        findings,
        product,
        "liboliphaunt-icu-npm-podspec-packaging",
        'extra_descriptors=("OliphauntICU.podspec",)' in release_cli
        and "packed_icu_package_contains" in release_cli,
        "Optional native ICU npm publication must include the React Native iOS podspec and validate the packed tarball.",
        "tools/release/release.py",
        severity="P0",
    )
    for required in [
        "package_liboliphaunt_cargo_artifacts.py",
        "publish_liboliphaunt_cargo_artifacts",
        "liboliphaunt_cargo_artifact_crates",
        "package_liboliphaunt_cargo_artifacts.cargo_package_name",
    ]:
        require(
            findings,
            product,
            "liboliphaunt-rust-artifact-crates",
            required in release_cli,
            "liboliphaunt native Rust consumers must resolve release assets from Cargo artifact crates.",
            f"tools/release/release.py missing {required}",
            severity="P0",
        )
    require(
        findings,
        product,
        "liboliphaunt-rust-artifact-workflow",
        "Publish liboliphaunt native artifact packages to crates.io" in workflow,
        "Release workflow must publish liboliphaunt native Cargo artifact crates before the Rust SDK.",
        ".github/workflows/release.yml",
        severity="P0",
    )
    packaging_scripts = {
        "tools/release/package-liboliphaunt-macos-assets.sh": [
            "oliphaunt_assert_base_runtime_has_no_optional_extensions",
            "optimize_native_runtime_payload.py",
            "plpgsql.dylib",
            "$stage/lib/modules/",
            "liboliphaunt-${version}-${target_id}.tar.gz",
            "run-host-c-smoke.mjs",
        ],
        "tools/release/package-liboliphaunt-linux-assets.sh": [
            "oliphaunt_assert_base_runtime_has_no_optional_extensions",
            "optimize_native_runtime_payload.py",
            "plpgsql.so",
            "$stage/lib/modules/",
            "liboliphaunt-${version}-${target_id}.tar.gz",
            "run-host-c-smoke.mjs",
        ],
        "tools/release/package-liboliphaunt-windows-assets.ps1": [
            "Assert-BaseRuntimeHasNoOptionalExtensions",
            "optimize_native_runtime_payload.py",
            "plpgsql.dll",
            "lib/modules",
            'Copy-Item -Recurse -Force (Join-Path $Runtime "*") (Join-Path $Stage "runtime")',
            "liboliphaunt-$Version-$TargetId.zip",
            "run-host-c-smoke.mjs",
        ],
        "tools/release/package-liboliphaunt-mobile-assets.sh": [
            "oliphaunt_assert_base_runtime_has_no_optional_extensions",
            "liboliphaunt-${version}-runtime-resources",
            "liboliphaunt-${version}-icu-data",
            "liboliphaunt-${version}-apple-spm-xcframework.zip",
        ],
        "tools/release/package-liboliphaunt-aggregate-assets.sh": [
            "liboliphaunt-${version}-release-assets.sha256",
            "check_liboliphaunt_release_assets.py",
        ],
    }
    for script_path, required_snippets in packaging_scripts.items():
        script = read_text(script_path)
        for required in required_snippets:
            require(
                findings,
                product,
                "asset-packaging",
                required in script,
                "liboliphaunt release packaging must publish base runtime assets and checksums through the active CI packagers.",
                f"{script_path} missing {required}",
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
                f"{script_path} still contains {forbidden}",
                severity="P0",
            )
    windows_packager = read_text("tools/release/package-liboliphaunt-windows-assets.ps1")
    for forbidden in [
        "Stage-EmbeddedPlpgsqlModule",
        "runtime/lib/postgresql/plpgsql.dll",
        "Assert-SameFileBytes",
    ]:
        require(
            findings,
            product,
            "windows-runtime-plpgsql",
            forbidden not in windows_packager,
            "Windows release packaging must keep PostgreSQL's normal runtime PL/pgSQL module because initdb loads it during bootstrap.",
            f"tools/release/package-liboliphaunt-windows-assets.ps1 still contains {forbidden}",
            severity="P0",
        )
    for script_path, forbidden in {
        "tools/release/package-liboliphaunt-macos-assets.sh": "$stage/runtime/lib/postgresql/plpgsql.dylib",
        "tools/release/package-liboliphaunt-linux-assets.sh": "$stage/runtime/lib/postgresql/plpgsql.so",
    }.items():
        script = read_text(script_path)
        require(
            findings,
            product,
            "desktop-runtime-plpgsql",
            forbidden not in script and "stage_embedded_plpgsql_module" not in script,
            "Desktop release packaging must keep PostgreSQL's normal runtime PL/pgSQL module; liboliphaunt selects embedded modules at backend startup.",
            f"{script_path} still mutates runtime PL/pgSQL",
            severity="P0",
        )

    native_build_scripts = {
        "src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh": [
            "embedded_postgis_make_args",
            "embedded_module_be_dllibs=\"-L$out_dir -loliphaunt -Wl,-rpath,$out_dir\"",
            "local embedded_pg_ldflags=\"$embedded_module_be_dllibs\"",
            "embedded_extra_make_args+=(\"PG_LDFLAGS=$embedded_pg_ldflags\")",
            "done < <(pgxs_extension_link_args \"$extension\" \"embedded\" \"$embedded_module_be_dllibs\")",
            "printf '%s\\n' \"PG_LDFLAGS=$link_flags\"",
            "printf '%s\\n' \"BE_DLLLIBS=$be_dllibs\"",
            "embedded_postgis_ldflags=\"$embedded_module_be_dllibs\"",
            "LDFLAGS=$embedded_postgis_ldflags ${arg#LDFLAGS=}",
            "BE_DLLLIBS=\"$embedded_module_be_dllibs\" \"${embedded_postgis_make_args[@]}\"",
            "audit_embedded_extension_modules",
        ],
    }
    for script_path, required_snippets in native_build_scripts.items():
        script = read_text(script_path)
        for required in required_snippets:
            require(
                findings,
                product,
                "native-embedded-extension-linkage",
                required in script,
                "Native embedded extension builds must force PostgreSQL symbol lookup through liboliphaunt before platform system libraries.",
                f"{script_path} missing {required}",
                severity="P0",
            )

    native_runtime_sources = {
        "src/runtimes/liboliphaunt/native/src/liboliphaunt_fs.c": [
            "oliphaunt_resolve_embedded_module_dir",
            "oliphaunt_loaded_library_path_dup",
            "lib/modules",
            "out/modules",
        ],
        "src/runtimes/liboliphaunt/native/src/liboliphaunt_native.c": [
            "set_backend_embedded_module_dir_env",
            "OLIPHAUNT_EMBEDDED_MODULE_DIR_ENV",
            "restore_backend_env_var",
        ],
        "src/runtimes/liboliphaunt/native/patches/postgresql-18.4/0010-liboliphaunt-use-host-runtime-paths.patch": [
            "OLIPHAUNT_EMBEDDED_MODULE_DIR",
            "strlcpy(pkglib_path, module_dir, MAXPGPATH)",
            "get_pkglib_path(my_exec_path, pkglib_path)",
        ],
    }
    for source_path, required_snippets in native_runtime_sources.items():
        source = read_text(source_path)
        for required in required_snippets:
            require(
                findings,
                product,
                "embedded-module-path",
                required in source,
                "Native direct release assets must resolve liboliphaunt-linked modules from lib/modules without mutating the standalone PostgreSQL runtime tree.",
                f"{source_path} missing {required}",
                severity="P0",
            )


def check_rust(findings: list[Finding]) -> None:
    product = "oliphaunt-rust"
    manifest = read_toml("src/sdks/rust/Cargo.toml")
    build_manifest = read_toml("src/sdks/rust/crates/oliphaunt-build/Cargo.toml")
    package = manifest.get("package", {})
    build_package = build_manifest.get("package", {})
    product_version = product_metadata.read_current_version(product)
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
        package.get("version") == product_version,
        "Rust SDK crate version must match the release metadata product version.",
        f"src/sdks/rust/Cargo.toml package.version={package.get('version')!r}",
        severity="P0",
    )
    require(
        findings,
        product,
        "artifact-relay-links",
        package.get("links") == "oliphaunt_artifact_relay" and package.get("build") == "build.rs",
        "Rust SDK must expose Cargo artifact manifests to application build scripts through a stable links relay.",
        f"src/sdks/rust/Cargo.toml package.links={package.get('links')!r} package.build={package.get('build')!r}",
        severity="P0",
    )
    require(
        findings,
        product,
        "build-helper-cargo-name",
        build_package.get("name") == "oliphaunt-build",
        "Rust build helper crate name must match the public crates.io package.",
        f"src/sdks/rust/crates/oliphaunt-build/Cargo.toml package.name={build_package.get('name')!r}",
        severity="P0",
    )
    require(
        findings,
        product,
        "build-helper-cargo-version",
        build_package.get("version") == product_version,
        "Rust build helper crate version must match the Rust SDK product version.",
        f"src/sdks/rust/crates/oliphaunt-build/Cargo.toml package.version={build_package.get('version')!r}",
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
        {"crates:oliphaunt", "crates:oliphaunt-build"}.issubset(product_registry_packages(product)),
        "Rust SDK release metadata must publish the SDK and build helper to crates.io.",
        "src/sdks/rust/release.toml",
        severity="P0",
    )
    build_source = read_text("src/sdks/rust/crates/oliphaunt-build/src/lib.rs")
    require(
        findings,
        product,
        "build-helper-no-network",
        not any(fragment in build_source for fragment in ["ureq", "reqwest", "OLIPHAUNT_RELEASE_BASE_URL", "github.com"]),
        "oliphaunt-build must stage Cargo-resolved artifacts without network downloads.",
        "src/sdks/rust/crates/oliphaunt-build/src/lib.rs",
        severity="P0",
    )
    require(
        findings,
        product,
        "build-helper-out-dir",
        "OUT_DIR" in build_source and "target/oliphaunt" not in build_source,
        "oliphaunt-build must use Cargo OUT_DIR for generated resources.",
        "src/sdks/rust/crates/oliphaunt-build/src/lib.rs",
        severity="P0",
    )
    relay_source = read_text("src/sdks/rust/build.rs")
    require(
        findings,
        product,
        "artifact-relay-build-script",
        "DEP_OLIPHAUNT_ARTIFACT_" in relay_source
        and "cargo::metadata=" in relay_source
        and "RELAY_ENV_PREFIX" in relay_source,
        "Rust SDK build script must relay direct Cargo artifact metadata to application build scripts.",
        "src/sdks/rust/build.rs",
        severity="P0",
    )
    sdk_manifest_text = read_text("src/sdks/rust/Cargo.toml")
    require(
        findings,
        product,
        "publish-only-broker-dependencies",
        "oliphaunt-broker-linux-x64-gnu" not in sdk_manifest_text
        and "prepare_oliphaunt_release_source" in read_text("tools/release/release.py"),
        "Rust SDK source manifest must stay local-check friendly; broker artifact dependencies are injected into the generated publish source.",
        "src/sdks/rust/Cargo.toml and tools/release/release.py",
        severity="P0",
    )
    require_absent_text(
        findings,
        product,
        "public-docs-no-cli-first-install",
        "src/sdks/rust/README.md",
        [
            "oliphaunt-resources --prebuilt-extension",
            "oliphaunt-resources --extension",
            "Missing URL-backed artifacts are downloaded",
            "--extension-cache",
        ],
        "Rust public README must not document maintainer CLI/download flows as the consumer extension install path.",
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
    expected_registry_packages = {
        "crates:oliphaunt-broker-linux-arm64-gnu",
        "crates:oliphaunt-broker-linux-x64-gnu",
        "crates:oliphaunt-broker-macos-arm64",
        "crates:oliphaunt-broker-windows-x64-msvc",
        "npm:@oliphaunt/broker-darwin-arm64",
        "npm:@oliphaunt/broker-linux-x64-gnu",
        "npm:@oliphaunt/broker-linux-arm64-gnu",
        "npm:@oliphaunt/broker-win32-x64-msvc",
    }
    require(
        findings,
        product,
        "broker-npm-platform-packages",
        {"crates-io", "npm"}.issubset(product_publish_targets(product))
        and set(product_registry_packages(product)) == expected_registry_packages,
        "Broker runtime must publish platform helper binaries as npm packages and Cargo artifact crates.",
        f"src/runtimes/broker/release.toml registry_packages={product_registry_packages(product)!r}",
        severity="P0",
    )
    version = product_metadata.read_current_version(product)
    for target in artifact_targets.artifact_targets(
        product=product,
        kind="broker-helper",
        surface="rust-broker",
        published_only=True,
    ):
        crate_name = f"oliphaunt-broker-{target.target}"
        crate_dir = Path("src/runtimes/broker/crates") / target.target
        manifest_path = crate_dir / "Cargo.toml"
        source_path = crate_dir / "src/lib.rs"
        build_path = crate_dir / "build.rs"
        manifest = read_toml(manifest_path.as_posix())
        package = manifest.get("package", {})
        require(
            findings,
            product,
            f"broker-cargo-artifact-{target.target}",
            package.get("name") == crate_name
            and package.get("version") == version
            and package.get("links") == f"oliphaunt_artifact_broker_{target.target.replace('-', '_')}"
            and package.get("build") == "build.rs"
            and manifest.get("workspace") == {},
            "Broker Cargo artifact descriptor crates must match broker artifact target metadata.",
            manifest_path.as_posix(),
            severity="P0",
        )
        source = read_text(source_path.as_posix())
        require(
            findings,
            product,
            f"broker-cargo-artifact-source-{target.target}",
            f'RELEASE_TARGET: &str = "{target.target}"' in source
            and f'CARGO_TARGET: &str = "{target.triple}"' in source
            and f'EXECUTABLE_RELATIVE_PATH: &str = "{target.executable_relative_path}"' in source,
            "Broker Cargo artifact source constants must match broker artifact target metadata.",
            source_path.as_posix(),
            severity="P0",
        )
        build_source = read_text(build_path.as_posix())
        require(
            findings,
            product,
            f"broker-cargo-artifact-build-{target.target}",
            "cargo::metadata=manifest=" in build_source
            and "OLIPHAUNT_ARTIFACT_CRATE_REQUIRE_PAYLOAD" in build_source
            and not any(fragment in build_source for fragment in ["ureq", "reqwest", "github.com"]),
            "Broker Cargo artifact build scripts must emit Cargo manifests from packaged payloads without network access.",
            build_path.as_posix(),
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
        "oliphauntExtensionVersions",
        "manifest.properties",
    ]:
        require(
            findings,
            product,
            "android-exact-extension-resolver",
            required in android_plugin_surface,
            "Android asset resolver must consume exact-extension package products rather than liboliphaunt-bundled extension indexes.",
            f"ResolveOliphauntAndroidAssetsTask.java missing {required}",
            severity="P0",
        )
    maven_artifact_publisher = read_text("src/sdks/kotlin/oliphaunt-maven-artifacts/build.gradle.kts")
    release_cli = read_text("tools/release/release.py")
    release_workflow = read_text(".github/workflows/release.yml")
    for required in [
        "include(\":oliphaunt-maven-artifacts\")",
        "MavenPublication",
        "OLIPHAUNT_MAVEN_ARTIFACTS_MANIFEST",
        "extension = \"tar.gz\"",
        "validateOliphauntMavenArtifacts",
    ]:
        require(
            findings,
            product,
            "android-maven-artifact-publisher",
            required in maven_artifact_publisher or required in read_text("src/sdks/kotlin/settings.gradle.kts"),
            "Android runtime and extension tarballs must publish through a manifest-driven Maven artifact publisher.",
            f"missing {required}",
            severity="P0",
        )
    for required in [
        "build_maven_artifact_manifest.py",
        "publish_liboliphaunt_runtime_maven",
        "publish_selected_extension_maven",
        ":oliphaunt-maven-artifacts:publishAndReleaseToMavenCentral",
    ]:
        require(
            findings,
            product,
            "android-maven-release-hooks",
            required in release_cli,
            "Release CLI must publish Android runtime and exact-extension artifacts to Maven Central.",
            f"tools/release/release.py missing {required}",
            severity="P0",
        )
    maven_artifact_release_helper = ""
    if "def run_maven_artifact_publisher(" in release_cli:
        maven_artifact_release_helper = release_cli.split("def run_maven_artifact_publisher(", 1)[1].split("\ndef ", 1)[0]
    require(
        findings,
        product,
        "android-maven-artifact-publisher-cache-mode",
        "--no-configuration-cache" in maven_artifact_release_helper
        and "--configuration-cache" not in maven_artifact_release_helper,
        "Manifest-driven Maven artifact publishing must not use Gradle configuration cache.",
        "run_maven_artifact_publisher must pass --no-configuration-cache",
        severity="P0",
    )
    for required in [
        "Publish liboliphaunt Android runtime artifacts to Maven Central",
        "Publish selected extension Android artifacts to Maven Central",
    ]:
        require(
            findings,
            product,
            "android-maven-release-workflow",
            required in release_workflow,
            "Release workflow must run Maven Central publication for Android runtime and exact-extension artifacts.",
            f".github/workflows/release.yml missing {required}",
            severity="P0",
        )
    for source_path in [
        "src/sdks/kotlin/oliphaunt-android-gradle-plugin/src/main/java/dev/oliphaunt/android/OliphauntAndroidPlugin.java",
        "src/sdks/kotlin/oliphaunt-android-gradle-plugin/src/main/java/dev/oliphaunt/android/ResolveOliphauntAndroidAssetsTask.java",
        "src/sdks/kotlin/oliphaunt/build.gradle.kts",
    ]:
        require_absent_text(
            findings,
            product,
            "android-no-runtime-downloads",
            source_path,
            [
                "github.com/f0rr0/oliphaunt/releases/download",
                "openStream()",
                "downloadAsset(",
                "downloadAndVerify(",
                "downloadAndVerifyExtension(",
                "downloadExtensionAsset(",
                "assetBaseUrl",
                "release-asset-cache",
            ],
            "Android consumer builds must resolve runtime and extension bytes through Gradle/Maven dependencies, not GitHub release downloads.",
        )
    require_absent_text(
        findings,
        product,
        "android-public-docs-no-runtime-downloads",
        "src/sdks/kotlin/README.md",
        [
            "downloads and verifies",
            "GitHub release assets during the normal Gradle build",
            "https://github.com/f0rr0/oliphaunt/releases/download",
            "PoliphauntAssetBaseUrl",
        ],
        "Kotlin public README must not document GitHub release downloads as the Android consumer install path.",
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
        "ts-no-regular-runtime-deps",
        package.get("dependencies") in ({}, None),
        "TypeScript SDK must install liboliphaunt runtime resources through the selected optional platform package.",
        f"src/sdks/js/package.json dependencies={package.get('dependencies')!r}",
        severity="P0",
    )
    expected_optional = {
        "@oliphaunt/broker-darwin-arm64": product_metadata.read_current_version("oliphaunt-broker"),
        "@oliphaunt/broker-linux-x64-gnu": product_metadata.read_current_version("oliphaunt-broker"),
        "@oliphaunt/broker-linux-arm64-gnu": product_metadata.read_current_version("oliphaunt-broker"),
        "@oliphaunt/broker-win32-x64-msvc": product_metadata.read_current_version("oliphaunt-broker"),
        "@oliphaunt/liboliphaunt-darwin-arm64": product_metadata.read_current_version("liboliphaunt-native"),
        "@oliphaunt/liboliphaunt-linux-x64-gnu": product_metadata.read_current_version("liboliphaunt-native"),
        "@oliphaunt/liboliphaunt-linux-arm64-gnu": product_metadata.read_current_version("liboliphaunt-native"),
        "@oliphaunt/liboliphaunt-win32-x64-msvc": product_metadata.read_current_version("liboliphaunt-native"),
        "@oliphaunt/node-direct-darwin-arm64": product_metadata.read_current_version("oliphaunt-node-direct"),
        "@oliphaunt/node-direct-linux-x64-gnu": product_metadata.read_current_version("oliphaunt-node-direct"),
        "@oliphaunt/node-direct-linux-arm64-gnu": product_metadata.read_current_version("oliphaunt-node-direct"),
        "@oliphaunt/node-direct-win32-x64-msvc": product_metadata.read_current_version("oliphaunt-node-direct"),
        "@oliphaunt/tools-darwin-arm64": product_metadata.read_current_version("liboliphaunt-native"),
        "@oliphaunt/tools-linux-x64-gnu": product_metadata.read_current_version("liboliphaunt-native"),
        "@oliphaunt/tools-linux-arm64-gnu": product_metadata.read_current_version("liboliphaunt-native"),
        "@oliphaunt/tools-win32-x64-msvc": product_metadata.read_current_version("liboliphaunt-native"),
    }
    optional_dependencies = package.get("optionalDependencies", {})
    require(
        findings,
        product,
        "ts-runtime-optional-deps",
        isinstance(optional_dependencies, dict)
        and optional_dependencies
        == {name: f"workspace:{version}" for name, version in expected_optional.items()},
        "TypeScript SDK must select native runtime helpers through exact optional platform packages and must not install ICU by default.",
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
        and metadata.get("icuPackage") == "@oliphaunt/icu"
        and metadata.get("icuVersion") == product_metadata.read_current_version("liboliphaunt-native")
        and metadata.get("brokerVersion") == product_metadata.read_current_version("oliphaunt-broker")
        and metadata.get("nodeDirectAddonVersion") == product_metadata.read_current_version("oliphaunt-node-direct"),
        "TypeScript SDK must pin compatible liboliphaunt, optional ICU, broker-helper, and Node direct versions.",
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
        isinstance(jsr_exports, dict)
        and {".", "./protocol", "./query"}.issubset(jsr_exports)
        and not {"./node", "./bun", "./deno"}.intersection(jsr_exports),
        "JSR package must expose protocol/query entrypoints and no native runtime entrypoints.",
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
        "bundled" not in features and "extensions" in features,
        "WASM crate must not expose an inert bundled feature; runtime artifacts must come from package-manager-resolved artifact products.",
        "oliphaunt-wasix Cargo.toml features",
        severity="P0",
    )
    lib_rs = read_text("src/bindings/wasix-rust/crates/oliphaunt-wasix/src/lib.rs")
    require(
        findings,
        product,
        "wasm-bundled-assets",
        'compile_error!' not in lib_rs and "does not embed WASIX runtime assets" not in lib_rs,
        "The WASM crate must remove the inert bundled feature contract instead of publishing a feature that always fails.",
        "src/bindings/wasix-rust/crates/oliphaunt-wasix/src/lib.rs",
        severity="P0",
    )
    require(
        findings,
        product,
        "wasm-default-features",
        features.get("default") == [],
        "WASM crate default features must not depend on unpublished runtime asset crates.",
        f"oliphaunt-wasix Cargo.toml default={features.get('default')!r}",
        severity="P0",
    )
    runtime_version = product_metadata.read_current_version("liboliphaunt-wasix")
    dependencies = manifest.get("dependencies", {})
    target_tables = manifest.get("target", {})
    expected_runtime_dependency = dependencies.get("liboliphaunt-wasix-portable")
    expected_tools_dependency = dependencies.get("oliphaunt-wasix-tools")
    require(
        findings,
        product,
        "wasm-runtime-artifact-dependency",
        isinstance(expected_runtime_dependency, dict)
        and expected_runtime_dependency.get("version") == f"={runtime_version}",
        "WASM crate must depend on the public portable runtime artifact crate at the liboliphaunt-wasix version.",
        f"liboliphaunt-wasix-portable dependency={expected_runtime_dependency!r}",
        severity="P0",
    )
    require(
        findings,
        product,
        "wasm-tools-artifact-dependency",
        isinstance(expected_tools_dependency, dict)
        and expected_tools_dependency.get("version") == f"={runtime_version}",
        "WASM crate must depend on the public WASIX tools artifact crate at the liboliphaunt-wasix version.",
        f"oliphaunt-wasix-tools dependency={expected_tools_dependency!r}",
        severity="P0",
    )
    expected_aot_dependencies = {
        'cfg(all(target_os = "macos", target_arch = "aarch64"))': "liboliphaunt-wasix-aot-aarch64-apple-darwin",
        'cfg(all(target_os = "linux", target_arch = "x86_64", target_env = "gnu"))': "liboliphaunt-wasix-aot-x86_64-unknown-linux-gnu",
        'cfg(all(target_os = "linux", target_arch = "aarch64", target_env = "gnu"))': "liboliphaunt-wasix-aot-aarch64-unknown-linux-gnu",
        'cfg(all(target_os = "windows", target_arch = "x86_64", target_env = "msvc"))': "liboliphaunt-wasix-aot-x86_64-pc-windows-msvc",
    }
    expected_tools_aot_dependencies = {
        'cfg(all(target_os = "macos", target_arch = "aarch64"))': "oliphaunt-wasix-tools-aot-aarch64-apple-darwin",
        'cfg(all(target_os = "linux", target_arch = "x86_64", target_env = "gnu"))': "oliphaunt-wasix-tools-aot-x86_64-unknown-linux-gnu",
        'cfg(all(target_os = "linux", target_arch = "aarch64", target_env = "gnu"))': "oliphaunt-wasix-tools-aot-aarch64-unknown-linux-gnu",
        'cfg(all(target_os = "windows", target_arch = "x86_64", target_env = "msvc"))': "oliphaunt-wasix-tools-aot-x86_64-pc-windows-msvc",
    }
    missing_aot_dependencies = []
    for cfg, crate in {**expected_aot_dependencies, **expected_tools_aot_dependencies}.items():
        target = target_tables.get(cfg)
        target_dependencies = target.get("dependencies", {}) if isinstance(target, dict) else {}
        dependency = target_dependencies.get(crate)
        if not isinstance(dependency, dict) or dependency.get("version") != f"={runtime_version}":
            missing_aot_dependencies.append(f"{cfg}:{crate}")
    require(
        findings,
        product,
        "wasm-aot-artifact-dependencies",
        not missing_aot_dependencies,
        "WASM crate must depend on every public target-specific root/tools AOT artifact crate behind exact Cargo target cfgs.",
        missing_aot_dependencies or "src/bindings/wasix-rust/crates/oliphaunt-wasix/Cargo.toml",
        severity="P0",
    )
    aot_source = read_text("src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/aot.rs")
    missing_aot_cfgs = [
        cfg.removeprefix("cfg(").removesuffix(")")
        for cfg in expected_aot_dependencies
        if cfg.removeprefix("cfg(").removesuffix(")") not in aot_source
    ]
    require(
        findings,
        product,
        "wasm-aot-rust-cfgs-match-cargo",
        not missing_aot_cfgs,
        "WASM AOT Rust cfgs must match the Cargo target dependency cfgs so unsupported target environments do not reference missing crates.",
        missing_aot_cfgs or "src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/aot.rs",
        severity="P0",
    )
    relay_source = read_text("src/bindings/wasix-rust/crates/oliphaunt-wasix/build.rs")
    require(
        findings,
        product,
        "wasm-artifact-relay-build-script",
        package.get("links") == "oliphaunt_artifact_wasix_relay"
        and package.get("build") == "build.rs"
        and "DEP_OLIPHAUNT_ARTIFACT_" in relay_source
        and "cargo::metadata=" in relay_source,
        "WASM crate must relay Cargo-resolved runtime/tool/AOT artifact manifests through Cargo links metadata.",
        "src/bindings/wasix-rust/crates/oliphaunt-wasix/build.rs",
        severity="P0",
    )
    for source_path in [
        "src/bindings/wasix-rust/crates/oliphaunt-wasix/README.md",
        "src/docs/content/sdk/wasm/guide.mdx",
        "src/docs/content/sdk/wasm/runtime.mdx",
        "src/docs/content/sdk/wasm/index.mdx",
    ]:
        require_absent_text(
            findings,
            product,
            "wasm-public-docs-no-archive-env",
            source_path,
            [
                "OLIPHAUNT_WASM_RUNTIME_ARCHIVE",
                "OLIPHAUNT_WASM_AOT_ARCHIVE",
                "OLIPHAUNT_WASM_AOT_DIR",
                "GitHub release",
            ],
            "WASIX public docs must not document app-owned runtime archive environment variables or release-asset downloads as the consumer install path.",
        )
    for source_path in [
        "src/bindings/wasix-rust/crates/oliphaunt-wasix/src/lib.rs",
        "src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/base.rs",
        "src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/aot.rs",
    ]:
        require_absent_text(
            findings,
            product,
            "wasm-no-public-archive-env-runtime",
            source_path,
            [
                "OLIPHAUNT_WASM_RUNTIME_ARCHIVE",
                "OLIPHAUNT_WASM_AOT_ARCHIVE",
                "OLIPHAUNT_WASM_AOT_DIR",
            ],
            "WASIX runtime artifact selection must use generated package manifests instead of public archive environment variables.",
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
    tools_manifest = read_toml("src/runtimes/liboliphaunt/wasix/crates/tools/Cargo.toml")
    tools_package = tools_manifest.get("package", {})
    require(
        findings,
        product,
        "wasix-assets-crate",
        asset_package.get("name") == "liboliphaunt-wasix-portable"
        and asset_package.get("version") == product_metadata.read_current_version(product),
        "WASIX runtime asset crate must publish under the runtime product version.",
        f"src/runtimes/liboliphaunt/wasix/crates/assets/Cargo.toml package={asset_package!r}",
        severity="P0",
    )
    require(
        findings,
        product,
        "wasix-tools-crate",
        tools_package.get("name") == "oliphaunt-wasix-tools"
        and tools_package.get("version") == product_metadata.read_current_version(product),
        "WASIX tools asset crate must publish under the runtime product version.",
        f"src/runtimes/liboliphaunt/wasix/crates/tools/Cargo.toml package={tools_package!r}",
        severity="P0",
    )
    require(
        findings,
        product,
        "wasix-publish-targets",
        product_publish_targets(product) == ["github-release-assets", "crates-io"],
        "WASIX runtime must publish GitHub release assets and Cargo artifact crates.",
        "src/runtimes/liboliphaunt/wasix/release.toml",
        severity="P0",
    )
    registry_packages = set(product_registry_packages(product))
    expected_registry_packages = {
        "crates:oliphaunt-icu",
        "crates:liboliphaunt-wasix-portable",
        "crates:oliphaunt-wasix-tools",
        "crates:liboliphaunt-wasix-aot-aarch64-apple-darwin",
        "crates:liboliphaunt-wasix-aot-aarch64-unknown-linux-gnu",
        "crates:liboliphaunt-wasix-aot-x86_64-pc-windows-msvc",
        "crates:liboliphaunt-wasix-aot-x86_64-unknown-linux-gnu",
        "crates:oliphaunt-wasix-tools-aot-aarch64-apple-darwin",
        "crates:oliphaunt-wasix-tools-aot-aarch64-unknown-linux-gnu",
        "crates:oliphaunt-wasix-tools-aot-x86_64-pc-windows-msvc",
        "crates:oliphaunt-wasix-tools-aot-x86_64-unknown-linux-gnu",
    }
    require(
        findings,
        product,
        "wasix-registry-packages",
        registry_packages == expected_registry_packages,
        "WASIX runtime release metadata must expose the public portable runtime, tools, target-specific root/tools AOT, and ICU data artifact crates.",
        f"src/runtimes/liboliphaunt/wasix/release.toml registry_packages={sorted(registry_packages)!r}",
        severity="P0",
    )
    release_source = read_text("tools/release/release.py")
    wasix_packager_source = read_text("tools/release/package_liboliphaunt_wasix_cargo_artifacts.py")
    workflow_source = read_text(".github/workflows/release.yml")
    require(
        findings,
        product,
        "wasix-cargo-artifact-release-flow",
        "package_liboliphaunt_wasix_cargo_artifacts.py" in release_source
        and "liboliphaunt_wasix_cargo_artifact_crates" in release_source
        and "--product liboliphaunt-wasix --step crates-io" in workflow_source,
        "Release flow must generate and publish WASIX Cargo artifact crates from staged WASIX release assets.",
        ["tools/release/release.py", ".github/workflows/release.yml"],
        severity="P0",
    )
    require(
        findings,
        product,
        "wasix-direct-cargo-artifact-packaging",
        "CRATES_IO_MAX_BYTES" in wasix_packager_source
        and "validate_crate_size" in wasix_packager_source
        and "DEFAULT_PART_COUNT" not in wasix_packager_source
        and "part_package_name" not in wasix_packager_source
        and '"role": "artifact"' in wasix_packager_source,
        "WASIX Cargo artifact packaging must publish direct public artifact crates and fail above the crates.io size limit instead of splitting into part crates.",
        "tools/release/package_liboliphaunt_wasix_cargo_artifacts.py",
        severity="P0",
    )
    version = product_metadata.read_current_version(product)
    expected_assets = set(artifact_targets.expected_assets(product, version, surface="github-release"))
    require(
        findings,
        product,
        "wasix-release-assets",
        {
            f"liboliphaunt-wasix-{version}-runtime-portable.tar.zst",
            f"liboliphaunt-wasix-{version}-icu-data.tar.zst",
            f"liboliphaunt-wasix-{version}-runtime-aot-macos-arm64.tar.zst",
            f"liboliphaunt-wasix-{version}-runtime-aot-linux-x64-gnu.tar.zst",
            f"liboliphaunt-wasix-{version}-runtime-aot-linux-arm64-gnu.tar.zst",
            f"liboliphaunt-wasix-{version}-runtime-aot-windows-x64-msvc.tar.zst",
            f"liboliphaunt-wasix-{version}-release-assets.sha256",
        }.issubset(expected_assets),
        "WASIX runtime release metadata must expose portable, target AOT, and checksum GitHub release assets.",
        f"src/runtimes/liboliphaunt/wasix/moon.yml: {sorted(expected_assets)!r}",
        severity="P0",
    )


def check_exact_extension(findings: list[Finding], product: str) -> None:
    config = product_metadata.product_config(product)
    package_path = product_metadata.package_path(product)
    sql_name = config.get("extension_sql_name")
    expected_registry_packages = {
        f"maven:dev.oliphaunt.extensions:{product}-{target.target}"
        for target in extension_artifact_targets.published_android_maven_targets(product)
    }
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
        and {"github-release-assets", "maven-central"}.issubset(set(product_publish_targets(product)))
        and config.get("registry_packages") == []
        and set(product_registry_packages(product)) == expected_registry_packages
        and config.get("release_artifacts") == ["exact-extension-artifacts"]
        and isinstance(sql_name, str)
        and sql_name,
        "Exact-extension release metadata must publish exact GitHub artifacts and derived Android Maven packages by SQL extension name.",
        f"{package_path}/release.toml registry_packages={sorted(product_registry_packages(product))!r}",
        severity="P0",
    )
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
        "Exact-extension artifact targets must cover mobile and non-Windows native artifact surfaces plus WASIX portable; default targets are derived from runtime metadata unless a product owns an override file.",
        f"{package_path}/release.toml: native={sorted(native_targets)!r} wasix={sorted(wasix_targets)!r}",
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
        f"{package_path}/release.toml: {[f'{target.target}:{target.kind}' for target in targets]!r}",
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
