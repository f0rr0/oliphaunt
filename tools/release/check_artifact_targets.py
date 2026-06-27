#!/usr/bin/env python3
"""Validate native and helper artifact target metadata."""

from __future__ import annotations

import json
import subprocess
import sys
import tomllib
from pathlib import Path
from typing import NoReturn

import product_metadata


ROOT = Path(__file__).resolve().parents[2]


def fail(message: str) -> NoReturn:
    print(f"check_artifact_targets.py: {message}", file=sys.stderr)
    raise SystemExit(1)


def read_text(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def read_toml(path: Path) -> dict:
    try:
        with path.open("rb") as handle:
            data = tomllib.load(handle)
    except tomllib.TOMLDecodeError as error:
        fail(f"{path.relative_to(ROOT)} is invalid TOML: {error}")
    if not isinstance(data, dict):
        fail(f"{path.relative_to(ROOT)} must contain a TOML table")
    return data


def bun_json(args: list[str]) -> object:
    output = subprocess.check_output(["tools/dev/bun.sh", *args], cwd=ROOT, text=True)
    return json.loads(output)


def artifact_target_matrix(matrix: str) -> dict[str, list[dict[str, str]]]:
    value = bun_json(["tools/release/artifact_target_matrix.mjs", matrix])
    if not isinstance(value, dict) or not isinstance(value.get("include"), list):
        fail(f"{matrix} matrix query did not return a matrix object")
    return value


def ci_plan_full_run(*, wasm_target: str = "all", native_target: str = "all", mobile_target: str = "all") -> dict:
    value = bun_json(
        [
            "tools/graph/ci_plan.mjs",
            "plan-full",
            "--wasm-target",
            wasm_target,
            "--native-target",
            native_target,
            "--mobile-target",
            mobile_target,
        ]
    )
    if not isinstance(value, dict):
        fail("CI planner full-run query did not return an object")
    return value


def ts_template(asset: str) -> str:
    return asset.replace("{version}", "${version}")


def require_text(path: str, text: str, message: str) -> None:
    if text not in read_text(path):
        fail(message)


def reject_text(path: str, text: str, message: str) -> None:
    if text in read_text(path):
        fail(message)


def validate_target_shape() -> None:
    targets = product_metadata.artifact_targets()
    if not targets:
        fail("artifact target metadata must define targets")
    raw_targets = {
        raw.get("id"): raw
        for raw in product_metadata.raw_artifact_target_tables()
        if isinstance(raw, dict) and isinstance(raw.get("id"), str)
    }

    seen_assets: dict[tuple[str, str], str] = {}
    for target in targets:
        raw_target = raw_targets.get(target.id, {})
        if "{version}" not in target.asset:
            fail(f"{target.id} asset template must contain {{version}}")
        if (
            target.published
            and "github-release" not in target.surfaces
            and target.kind not in {"native-tools"}
        ):
            fail(f"{target.id} is published but is not a GitHub release asset")
        if not target.published:
            if raw_target.get("tier") != "planned":
                fail(f"{target.id} is unpublished and must declare tier = \"planned\"")
            reason = raw_target.get("unsupported_reason")
            if not isinstance(reason, str) or len(reason.strip()) < 40:
                fail(f"{target.id} is unpublished and must declare a concrete unsupported_reason")
        if target.kind in {"native-runtime", "broker-helper", "node-direct-addon"}:
            if target.triple is None:
                fail(f"{target.id} must declare a target triple")
            if target.runner is None:
                fail(f"{target.id} must declare the CI/release runner")
        if target.kind == "wasix-aot-runtime":
            if target.triple is None:
                fail(f"{target.id} must declare a target triple")
            if target.runner is None:
                fail(f"{target.id} must declare the CI/release runner")
            if target.llvm_url is None:
                fail(f"{target.id} must declare llvm_url for AOT generation")
        if target.kind in {"native-runtime", "node-direct-addon"}:
            if target.library_relative_path is None:
                fail(f"{target.id} must declare library_relative_path")
        if target.kind == "native-runtime" and target.target.startswith("android-"):
            expected_prefix = f"jni/{target.target.removeprefix('android-')}/"
            if target.library_relative_path is None or not target.library_relative_path.startswith(expected_prefix):
                fail(
                    f"{target.id} library_relative_path must describe the Android release archive "
                    f"layout under {expected_prefix}, got {target.library_relative_path}"
                )
        if target.kind == "broker-helper" and target.executable_relative_path is None:
            fail(f"{target.id} must declare executable_relative_path")
        if "github-release" in target.surfaces:
            dedupe_key = (target.product, target.asset)
            previous = seen_assets.get(dedupe_key)
            if previous is not None:
                fail(f"{target.id} and {previous} use the same asset template {target.asset}")
            seen_assets[dedupe_key] = target.id


def validate_moon_runtime_targets() -> None:
    graph_targets = product_metadata.legacy_central_artifact_target_rows()
    central_targets = [
        raw.get("id")
        for raw in graph_targets
    ]
    if central_targets:
        fail(
            "artifact targets must be derived from Moon release metadata, "
            f"not central release metadata: {central_targets}"
        )

    runtime_target_dirs = {
        "liboliphaunt-native": "src/runtimes/liboliphaunt/native/targets",
        "liboliphaunt-wasix": "src/runtimes/liboliphaunt/wasix/targets",
        "oliphaunt-broker": "src/runtimes/broker/targets",
        "oliphaunt-node-direct": "src/runtimes/node-direct/targets",
    }
    for product, directory in runtime_target_dirs.items():
        files = sorted((ROOT / directory).glob("*.toml"))
        if files:
            fail(
                f"{product} runtime artifact targets must be derived from Moon release metadata, "
                "not product-local target TOML files: "
                + ", ".join(path.relative_to(ROOT).as_posix() for path in files)
            )

    expected_presets = {
        "liboliphaunt-native": "liboliphaunt-native",
        "liboliphaunt-wasix": "liboliphaunt-wasix",
        "oliphaunt-broker": "broker-helper",
        "oliphaunt-node-direct": "node-direct-addon",
    }
    for product, preset in expected_presets.items():
        release = product_metadata.moon_release_metadata(product)
        targets = release.get("artifactTargets")
        if not isinstance(targets, dict):
            fail(f"{product} Moon release metadata must declare artifactTargets")
        if targets.get("preset") != preset:
            fail(f"{product} Moon artifactTargets.preset must be {preset!r}")
        published = targets.get("publishedTargets")
        if not isinstance(published, list) or not published or not all(isinstance(item, str) for item in published):
            fail(f"{product} Moon artifactTargets.publishedTargets must be a non-empty string list")


def wasm_extension_target_id(runtime_target: str) -> str:
    if runtime_target == "portable":
        return "wasix-portable"
    return runtime_target


def validate_extension_artifact_targets() -> None:
    extension_products = product_metadata.extension_product_ids()
    if not extension_products:
        fail("exact-extension release products must be modeled as release products")

    expected_native_targets = {
        target.target
        for target in product_metadata.artifact_targets(
            product="liboliphaunt-native",
            kind="native-runtime",
            published_only=True,
        )
        if target.extension_artifacts
    }
    expected_wasix_targets = {
        wasm_extension_target_id(target.target)
        for target in product_metadata.artifact_targets(
            product="liboliphaunt-wasix",
            published_only=True,
        )
        if target.kind == "wasix-runtime"
    }
    if not expected_native_targets:
        fail("published native runtime targets are required before extension artifacts can be published")
    if not expected_wasix_targets:
        fail("published WASIX runtime targets are required before extension artifacts can be published")

    for product in extension_products:
        rows = product_metadata.extension_artifact_targets(product=product)
        published_native_targets = {
            target.target for target in rows if target.family == "native" and target.published
        }
        declared_native_targets = {
            target.target for target in rows if target.family == "native"
        }
        published_wasix_targets = {
            target.target for target in rows if target.family == "wasix" and target.published
        }
        if declared_native_targets != expected_native_targets:
            fail(
                f"{product} native extension target rows must cover published liboliphaunt native runtimes, "
                f"including explicit unpublished opt-outs: {sorted(declared_native_targets)} vs {sorted(expected_native_targets)}"
            )
        if not published_native_targets:
            fail(f"{product} must publish at least one native extension artifact target")
        if not published_native_targets <= expected_native_targets:
            fail(
                f"{product} published native extension targets must be published liboliphaunt native runtimes: "
                f"{sorted(published_native_targets)} vs {sorted(expected_native_targets)}"
            )
        if published_wasix_targets != expected_wasix_targets:
            fail(
                f"{product} published WASIX extension targets must match published liboliphaunt WASIX runtimes: "
                f"{sorted(published_wasix_targets)} vs {sorted(expected_wasix_targets)}"
            )
        for row in rows:
            if row.family == "native":
                expected_kind = (
                    "native-static-registry"
                    if row.target == "ios-xcframework" or row.target.startswith("android-")
                    else "native-dynamic"
                )
                if row.kind != expected_kind:
                    fail(f"{product} {row.target} must use extension artifact kind {expected_kind}, got {row.kind}")
                if row.published and row.kind == "native-static-registry":
                    static_recipe = ROOT / product_metadata.package_path(product) / "targets" / "native-static-registry.toml"
                    if static_recipe.is_file():
                        static_data = read_toml(static_recipe)
                        status = static_data.get("status")
                        if status != "supported":
                            fail(
                                f"{product} publishes {row.target} native static-registry artifacts, "
                                f"but {static_recipe.relative_to(ROOT)} declares status={status!r}"
                            )
            if row.family == "wasix" and row.kind != "wasix-runtime":
                fail(f"{product} {row.target} must use wasix-runtime extension artifacts")


def validate_github_asset_helpers() -> None:
    require_text(
        "tools/release/package-liboliphaunt-macos-assets.sh",
        "liboliphaunt-${version}-${target_id}.tar.gz",
        "macOS liboliphaunt target packager must emit the release-shaped macOS archive",
    )
    require_text(
        "tools/release/package-liboliphaunt-macos-assets.sh",
        "target/liboliphaunt/release-assets",
        "macOS liboliphaunt target packager must write into the release asset directory",
    )
    require_text(
        "tools/release/check_github_release_assets.mjs",
        "expectedAssets",
        "GitHub release asset checks must derive product assets from product-local artifact targets",
    )
    require_text(
        "tools/release/check-liboliphaunt-release-assets.mjs",
        "allArtifactTargets",
        "liboliphaunt release asset checks must derive required assets from product-local artifact targets",
    )
    require_text(
        "tools/release/check-broker-release-assets.mjs",
        "expectedAssets(PRODUCT, KIND, version",
        "Rust broker release asset checks must derive required assets from product-local artifact targets",
    )
    require_text(
        "src/runtimes/liboliphaunt/native/tools/run-host-c-smoke.mjs",
        "OLIPHAUNT_SMOKE_BIN_DIR",
        "liboliphaunt C ABI smoke runner must support staged-release smoke binaries outside release layouts",
    )
    for packager in (
        "tools/release/package-liboliphaunt-macos-assets.sh",
        "tools/release/package-liboliphaunt-linux-assets.sh",
        "tools/release/package-liboliphaunt-windows-assets.ps1",
    ):
        require_text(
            packager,
            "OLIPHAUNT_SMOKE_BIN_DIR",
            f"{packager} must smoke the staged release layout without writing smoke binaries into the archive",
        )
        require_text(
            packager,
            "run-host-c-smoke.mjs",
            f"{packager} must run the liboliphaunt C ABI smoke against the staged release layout",
        )
        require_text(
            packager,
            "plpgsql",
            f"{packager} must include embedded core PostgreSQL modules for native SDK materialization",
        )


def validate_ci_release_artifacts() -> None:
    ci = read_text(".github/workflows/ci.yml")
    release = read_text(".github/workflows/release.yml")
    required_ci_snippets = {
        "Package liboliphaunt macOS release asset": "CI must build a release-shaped liboliphaunt macOS target archive",
        "tools/release/package-liboliphaunt-macos-assets.sh": "CI must use the macOS liboliphaunt target packager",
        "Package liboliphaunt Linux release asset": "CI must build release-shaped liboliphaunt Linux target archives",
        "tools/release/package-liboliphaunt-linux-assets.sh": "CI must use the Linux liboliphaunt target packager",
        "Package liboliphaunt Windows release asset": "CI must build a release-shaped liboliphaunt Windows target archive",
        "package-liboliphaunt-windows-assets.ps1": "CI must use the Windows liboliphaunt target packager",
        "Package liboliphaunt Android release asset": "CI must package release-shaped liboliphaunt Android target archives",
        "Package liboliphaunt iOS release asset": "CI must package release-shaped liboliphaunt iOS target archives",
        "tools/release/package-liboliphaunt-mobile-assets.sh": "CI must use the mobile liboliphaunt target packager",
        "liboliphaunt-native-release-assets-${{ matrix.target }}": "CI must upload liboliphaunt release-shaped artifacts per target",
        "liboliphaunt-native-release-assets:": "CI must aggregate complete public liboliphaunt release assets",
        "Download liboliphaunt target release assets": "CI must aggregate liboliphaunt target archive outputs",
        ".github/scripts/run-planned-moon-job.sh liboliphaunt-native-release-assets": (
            "CI must aggregate liboliphaunt native release assets through the Moon-modeled builder"
        ),
        "Upload aggregate liboliphaunt release assets": "CI must upload complete liboliphaunt release assets for release consumption",
        "Download Apple liboliphaunt release assets": "Swift SDK package artifacts must consume the Apple SwiftPM liboliphaunt release asset",
        "liboliphaunt-native-release-assets-ios-xcframework": "Swift SDK package artifacts must download the Apple target release asset directly",
        "OLIPHAUNT_SWIFT_RELEASE_ASSET_DIR": "Swift SDK package artifacts must render Package.swift.release from real liboliphaunt release assets in CI",
        ".github/scripts/run-planned-moon-job.sh broker-runtime": "CI must invoke the planned broker Moon job that includes release-shaped helper artifacts",
        "oliphaunt-broker-release-assets-${{ matrix.target }}": "CI must upload broker helper release-shaped artifacts per target",
        ".github/scripts/run-planned-moon-job.sh node-direct": "CI must invoke the planned Node direct Moon job that includes release-shaped addon artifacts",
        "oliphaunt-node-direct-release-assets-${{ matrix.target }}": "CI must upload Node direct release-shaped artifacts per target",
        "oliphaunt-node-direct-npm-package-${{ matrix.target }}": "CI must upload Node direct optional npm package artifacts per target",
        "oliphaunt-extension-package-artifacts": "CI must upload exact-extension package artifacts",
        "oliphaunt-mobile-extension-package-artifacts": "CI must upload target-scoped mobile exact-extension package artifacts",
        "target/extension-artifacts": "CI must use the shared exact-extension package staging layout",
        ".github/scripts/run-planned-moon-job.sh extension-packages": "CI must invoke the Moon-modeled exact-extension package builder",
        ".github/scripts/run-planned-moon-job.sh mobile-extension-packages": "CI must invoke the Moon-modeled mobile exact-extension package builder",
        "Download exact-extension package artifacts": "Mobile build jobs must consume package-shaped exact-extension artifacts",
        "Download WASIX exact-extension artifacts": "CI exact-extension package assembly must consume WASIX extension artifact builder outputs",
        "pattern: liboliphaunt-wasix-extension-artifacts-*": "CI exact-extension package assembly must download every WASIX extension artifact target output",
        "target/extensions/wasix/release-assets": "CI must use the shared WASIX exact-extension release asset staging layout",
        "extension-artifacts-native:\n    name: Builds / extension-native (${{ matrix.target }})\n    needs:\n      - affected": (
            "Native exact-extension artifact builders must be grouped by target"
        ),
        "OLIPHAUNT_EXTENSION_PRODUCTS: ${{ matrix.extensions_csv }}": (
            "Exact-extension artifact builder jobs must pass the selected extension product set into the producer"
        ),
        "liboliphaunt-native-extension-artifacts-${{ matrix.target }}": (
            "Native exact-extension artifact uploads must be addressable by target"
        ),
        "liboliphaunt-native-extension-ccache-${{ matrix.target }}": (
            "Native exact-extension artifact builders must restore target-scoped compiler/build caches"
        ),
        "liboliphaunt-wasix-extension-artifacts-${{ matrix.target }}": (
            "WASIX exact-extension artifact uploads must be addressable by target"
        ),
        "MOON_CACHE=off .github/scripts/run-planned-moon-job.sh extension-artifacts-native": (
            "Native exact-extension artifact builders must inherit Moon source/check prerequisites inside the job"
        ),
        "OLIPHAUNT_MOON_UPSTREAM=none MOON_CACHE=off .github/scripts/run-planned-moon-job.sh extension-artifacts-wasix": (
            "WASIX exact-extension artifact builders must consume downloaded runtime outputs, not re-run upstream producers"
        ),
        "OLIPHAUNT_EXPO_REQUIRE_PREBUILT_EXTENSIONS": "Mobile build jobs must require prebuilt exact-extension artifacts instead of source-built extension fallbacks",
        "OLIPHAUNT_EXPO_REQUIRE_SDK_ARTIFACTS": "Mobile build jobs must require staged SDK package artifacts instead of silent source fallbacks",
        "OLIPHAUNT_EXPO_SDK_ARTIFACT_ROOT": "Mobile build jobs must resolve SDK artifacts from the staged package artifact root",
        "OLIPHAUNT_EXPO_EXTENSION_ARTIFACT_ROOT": "Mobile build jobs must resolve exact-extension artifacts from the staged package artifact root",
        "Validate Android mobile app artifacts": "Android mobile build jobs must inspect the built app for exact selected-extension contents",
        "Validate iOS mobile app artifacts": "iOS mobile build jobs must inspect the built app for exact selected-extension contents",
        "check-staged-artifacts.mjs --require-mobile android --require-mobile-prebuilt-extensions": (
            "Android mobile artifact validation must require prebuilt exact-extension package inputs"
        ),
        "check-staged-artifacts.mjs --require-mobile ios --require-mobile-prebuilt-extensions": (
            "iOS mobile artifact validation must require prebuilt exact-extension package inputs"
        ),
        "OLIPHAUNT_EXPO_IOS_OLIPHAUNT_XCFRAMEWORK": "iOS mobile build jobs must consume the linked liboliphaunt XCFramework artifact",
        "liboliphaunt-wasix-release-assets:": "CI must aggregate WASIX portable and AOT outputs into public release assets",
        "liboliphaunt_wasix_aot_runtime_matrix: ${{ steps.plan.outputs.liboliphaunt_wasix_aot_runtime_matrix }}": (
            "CI affected planning must emit the WASIX AOT target matrix without a separate planning job"
        ),
        "matrix: ${{ fromJson(needs.affected.outputs.liboliphaunt_wasix_aot_runtime_matrix": (
            "WASIX AOT builders must consume the affected-plan target matrix directly"
        ),
        "contains(fromJson(needs.affected.outputs.jobs), 'liboliphaunt-wasix-aot')": (
            "CI must only build WASIX AOT artifacts when the affected planner selected AOT work"
        ),
        "contains(fromJson(needs.affected.outputs.jobs), 'liboliphaunt-wasix-release-assets')": (
            "CI must only aggregate WASIX release assets when the affected planner selected release aggregation"
        ),
        ".github/scripts/run-planned-moon-job.sh liboliphaunt-wasix-release-assets": (
            "CI must package WASIX public release assets through the planned Moon task"
        ),
        "target/oliphaunt-wasix/wasix-build/work/icu-wasix/share/icu/**": (
            "CI must pass the WASIX ICU sidecar produced by the portable runtime job into release asset packaging"
        ),
        "target/oliphaunt-wasix/release-assets": "CI must upload WASIX public release assets",
        "Stage target AOT artifact envelope": "WASIX AOT builders must upload a deterministic artifact envelope",
        "target-triple.txt": "WASIX AOT artifact envelopes must identify their target triple explicitly",
        "target/oliphaunt-wasix/aot-upload/**": "WASIX AOT upload must use the staged artifact envelope, not an implicit target path",
        "Invalid WASIX AOT artifact envelope": "WASIX AOT consumers must validate the downloaded artifact envelope before restoring it",
    }
    for snippet, message in required_ci_snippets.items():
        if snippet not in ci:
            fail(message)
    for artifact in product_metadata.ci_sdk_package_artifact_names():
        if artifact not in ci:
            fail(f"CI must upload SDK package artifact {artifact}")
    for product in product_metadata.sdk_package_products():
        if f"target/sdk-artifacts/{product}" not in ci:
            fail(f"CI must use the shared SDK artifact staging layout for {product}")
    require_text(
        ".github/workflows/release.yml",
        'tools/release/release.py ci-artifacts --product "$product" --family sdk-package',
        "release workflow must derive SDK package artifact names from release metadata",
    )
    require_text(
        ".github/workflows/release.yml",
        'tools/release/release.py ci-products --family sdk-package --products-json "$PRODUCTS_JSON"',
        "release workflow must derive selected SDK package products from release metadata",
    )
    for legacy_env in (
        "PRODUCT_OLIPHAUNT_RUST",
        "PRODUCT_OLIPHAUNT_SWIFT",
        "PRODUCT_OLIPHAUNT_KOTLIN",
        "PRODUCT_OLIPHAUNT_REACT_NATIVE",
        "PRODUCT_OLIPHAUNT_JS",
        "PRODUCT_OLIPHAUNT_WASIX_RUST",
    ):
        reject_text(
            ".github/workflows/release.yml",
            legacy_env,
            f"release workflow must not hard-code SDK product selection with {legacy_env}",
        )
    require_text(
        "src/runtimes/broker/moon.yml",
        'tags: ["release", "artifact", "ci-broker-runtime"]',
        "Broker release-assets must be selected by the ci-broker-runtime Moon tag",
    )
    require_text(
        "src/runtimes/node-direct/moon.yml",
        'tags: ["release", "artifact", "ci-node-direct"]',
        "Node direct release-assets must be selected by the ci-node-direct Moon tag",
    )
    require_text(
        "src/runtimes/node-direct/moon.yml",
        "/target/oliphaunt-node-direct/npm-packages/**/*",
        "Node direct Moon release-assets task must declare optional npm tarballs as outputs",
    )
    require_text(
        "src/runtimes/node-direct/tools/build-node-addon.sh",
        "Node direct optional npm package staged",
        "Node direct CI builder must stage optional npm tarballs for release publishing",
    )
    require_text(
        ".github/workflows/release.yml",
        "Download Node direct optional npm packages",
        "release workflow must download Node direct optional npm package artifacts from CI",
    )
    require_text(
        "tools/release/release.py",
        "node_direct_optional_npm_tarballs",
        "Node direct release publish must validate staged optional npm tarballs",
    )
    require_text(
        "tools/release/release.py",
        'run(["npm", "publish", str(tarball), "--access", "public", "--provenance"])',
        "Node direct optional npm publish must publish CI-built tarballs directly",
    )
    for project_id in product_metadata.sdk_package_products():
        moon_file = (
            "src/bindings/wasix-rust/moon.yml"
            if project_id == "oliphaunt-wasix-rust"
            else f"src/sdks/{'js' if project_id == 'oliphaunt-js' else project_id.removeprefix('oliphaunt-')}/moon.yml"
        )
        require_text(
            moon_file,
            f"tools/release/build-sdk-ci-artifacts.sh {project_id}",
            f"{project_id} package task must stage publishable SDK artifacts",
        )
        require_text(
            moon_file,
            f"/target/sdk-artifacts/{project_id}/**/*",
            f"{project_id} package task must declare staged SDK package artifacts as Moon outputs",
        )
    focused_wasix_jobs = set(ci_plan_full_run(wasm_target="linux-x64-gnu").get("jobs", []))
    if focused_wasix_jobs != {"affected", "liboliphaunt-wasix-runtime", "liboliphaunt-wasix-aot"}:
        fail(
            "focused WASIX target runs must build only the portable runtime and requested AOT producer, "
            f"got {sorted(focused_wasix_jobs)}"
        )
    require_text(
        "tools/graph/ci_plan.mjs",
        "extension_artifacts_wasix_matrix:",
        "CI planner must model WASIX exact-extension artifact matrix output",
    )
    require_text(
        "tools/graph/ci_plan.mjs",
        'jobs.has("extension-artifacts-wasix")',
        "CI planner must emit WASIX exact-extension rows only when the WASIX extension builder is selected",
    )
    require_text(
        "tools/graph/ci_plan.mjs",
        'extensionArtifactsWasixMatrix("all", selectedExtensionProducts',
        "WASIX extension artifacts are portable and must use the portable selector, not the AOT target selector",
    )
    wasix_release_needs = (
        "liboliphaunt-wasix-release-assets:\n"
        "    name: Builds / liboliphaunt-wasix-release-assets\n"
        "    needs:\n"
        "      - affected\n"
        "      - liboliphaunt-wasix-runtime\n"
        "      - liboliphaunt-wasix-aot"
    )
    if wasix_release_needs not in ci:
        fail("WASIX release asset builder must consume portable and AOT runtime builders")
    if 'OLIPHAUNT_EXPO_MOBILE_EXTENSIONS: ""' in ci:
        fail("mobile build jobs must not disable selected extensions with OLIPHAUNT_EXPO_MOBILE_EXTENSIONS=\"\"")
    if "run: cargo run -p xtask -- release package-assets" in ci:
        fail("CI must not bypass Moon for WASIX release asset packaging")
    if "run: src/runtimes/liboliphaunt/wasix/tools/build-runtime-portable.sh" in ci:
        fail("CI must not bypass Moon for portable WASIX runtime builds")
    if "target/oliphaunt-wasix/aot/${{ matrix.target }}/**" in ci:
        fail("WASIX AOT uploads must use the explicit target-triple artifact envelope")
    if "run: src/runtimes/liboliphaunt/wasix/tools/build-aot-target.sh" in ci:
        fail("CI must not bypass Moon for WASIX AOT builds")
    if ci.index("mobile-build-android:") < ci.index("mobile-extension-packages:"):
        fail("mobile exact-extension package producer must be declared before mobile Android build consumers")
    if "mobile-build-android:\n    name: Builds / mobile-android (${{ matrix.target }})\n    needs:\n      - affected\n      - mobile-extension-packages\n      - liboliphaunt-native-android" not in ci:
        fail("Android mobile build must depend on mobile-extension-packages and the Android liboliphaunt target builder")
    if "mobile-build-ios:\n    name: Builds / mobile-ios\n    needs:\n      - affected\n      - mobile-extension-packages\n      - liboliphaunt-native-ios" not in ci:
        fail("iOS mobile build must depend on mobile-extension-packages and the iOS liboliphaunt target builder")
    if "mobile-build-android:\n    name: Builds / mobile-android (${{ matrix.target }})\n    needs:\n      - affected\n      - mobile-extension-packages\n      - liboliphaunt-native-android\n      - kotlin-sdk-package\n      - react-native-sdk-package" not in ci:
        fail("Android mobile build must depend on Android runtime, Kotlin, and React Native package artifacts")
    require_text(
        ".github/workflows/ci.yml",
        "matrix: ${{ fromJson(needs.affected.outputs.react_native_android_mobile_app_matrix) }}",
        "Android mobile build must use the React Native Android runtime target matrix",
    )
    require_text(
        ".github/workflows/ci.yml",
        "react-native-mobile-android-app-${{ matrix.target }}",
        "Android mobile build artifacts must be target-specific",
    )
    if "mobile-build-ios:\n    name: Builds / mobile-ios\n    needs:\n      - affected\n      - mobile-extension-packages\n      - liboliphaunt-native-ios\n      - react-native-sdk-package\n      - swift-sdk-package" not in ci:
        fail("iOS mobile build must depend on iOS runtime, React Native, and Swift package artifacts")
    if "swift-sdk-package:\n    name: Builds / swift-sdk\n    needs:\n      - affected\n      - liboliphaunt-native-ios" not in ci:
        fail("Swift SDK package artifacts must depend on the iOS native target builder that produces the Apple release asset")
    require_text(
        "tools/graph/ci_plan.mjs",
        'jobs.has("swift-sdk-package")',
        "CI affected planner must make Swift SDK package builds imply liboliphaunt target asset producers",
    )
    require_text(
        "tools/graph/ci_plan.mjs",
        'targets.add("ios-xcframework")',
        "CI affected planner must narrow Swift SDK liboliphaunt target builds to the Apple SwiftPM target when possible",
    )
    require_text(
        "src/sdks/react-native/tools/expo-runner-common.sh",
        "expo_single_sdk_artifact_file",
        "React Native mobile runners must have a shared required-SDK-artifact resolver",
    )
    require_text(
        "src/sdks/react-native/tools/expo-android-runner.sh",
        "install_kotlin_sdk_maven_artifacts_if_required",
        "Android mobile runner must consume staged Kotlin Maven artifacts when CI requires SDK artifacts",
    )
    require_text(
        "src/sdks/react-native/tools/expo-ios-runner.sh",
        "prepare_swift_sdk_artifact_git_repo_if_required",
        "iOS mobile runner must consume the staged Swift source artifact when CI requires SDK artifacts",
    )
    require_text(
        "tools/release/build-sdk-ci-artifacts.sh",
        "publishAndroidReleasePublicationToMavenLocal",
        "Kotlin SDK package builder must stage a Maven repository layout for Android consumers",
    )
    require_text(
        "tools/release/build-sdk-ci-artifacts.sh",
        'mkdir -p "$artifact_root/maven"',
        "Kotlin SDK package builder must stage Maven artifacts under target/sdk-artifacts/oliphaunt-kotlin/maven",
    )
    require_text(
        "tools/release/build-sdk-ci-artifacts.sh",
        'check-staged-artifacts.mjs --require-sdk-product "$product"',
        "SDK package builders must validate staged package artifacts for runtime/extension payload leaks",
    )
    reject_text(
        "tools/release/build-sdk-ci-artifacts.sh",
        "outputs/aar/*-release.aar",
        "Kotlin SDK package staging must not copy loose AARs; the staged Maven repository is the package boundary",
    )
    require_text(
        "tools/release/build-sdk-ci-artifacts.sh",
        "oliphaunt-android-gradle-plugin:publishToMavenLocal",
        "Kotlin SDK package builder must stage the Android Gradle plugin Maven artifact",
    )
    require_text(
        "src/extensions/artifacts/packages/tools/package-mobile-release-assets.sh",
        "check-staged-artifacts.mjs \"${validation_args[@]}\"",
        "mobile exact-extension package assembly must validate the staged package manifests and checksums it selected",
    )
    require_text(
        "src/extensions/artifacts/packages/tools/package-mobile-release-assets.sh",
        "OLIPHAUNT_EXTENSION_PACKAGE_PRODUCTS must list selected exact-extension products for mobile packaging",
        "mobile exact-extension package assembly must fail closed without an explicit selected product list",
    )
    reject_text(
        "src/extensions/artifacts/packages/tools/package-mobile-release-assets.sh",
        "args+=(--all)",
        "mobile exact-extension package assembly must not fall back to all extension products",
    )
    require_text(
        "src/runtimes/liboliphaunt/native/moon.yml",
        "tools/release/package-liboliphaunt-aggregate-assets.sh",
        "liboliphaunt native aggregate assets must have one Moon-modeled packager/checker entrypoint",
    )
    require_text(
        "tools/release/check-staged-artifacts.mjs",
        "validateReleaseArchivePayload(assetPath)",
        "staged exact-extension artifact checks must reject placeholder files that are not readable release archives",
    )
    require_text(
        "tools/graph/ci_plan.mjs",
        'jobs.add("mobile-extension-packages")',
        "affected planner must select target-scoped exact-extension packages whenever mobile jobs are selected",
    )
    reject_text(
        "tools/graph/ci_plan.mjs",
        'if "extension-artifacts-native" in jobs:\n        jobs.add("liboliphaunt-native")',
        "affected planner must not create a coarse native-runtime waterfall for exact-extension artifact builds",
    )
    reject_text(
        ".github/workflows/release.yml",
        "product_liboliphaunt_native == 'true' || steps.release_plan.outputs.product_oliphaunt_swift == 'true'",
        "Swift SDK releases must consume staged Swift package artifacts, not force aggregate liboliphaunt asset downloads",
    )
    require_text(
        ".github/workflows/release.yml",
        "steps.release_plan.outputs.product_liboliphaunt_native == 'true' }}",
        "release workflow must still download aggregate liboliphaunt assets for liboliphaunt-native releases",
    )
    require_text(
        "tools/release/release.py",
        "prepare_staged_swift_release_manifest",
        "Swift SDK release must use the Package.swift.release produced by the SDK package builder",
    )
    require_text(
        "tools/release/release.py",
        "def validate_staged_sdk_package",
        "release dry-runs must validate staged SDK package artifacts before publish checks",
    )
    for product_id in product_metadata.sdk_package_products():
        require_text(
            "tools/release/release.py",
            f'validate_staged_sdk_package("{product_id}")',
            f"{product_id} release dry-run must validate the staged SDK package artifact",
        )
    require_text(
        ".github/scripts/run-planned-moon-job.sh",
        "OLIPHAUNT_MOON_UPSTREAM",
        "CI must be able to run downloaded-artifact consumer jobs without re-running Moon upstream producer tasks",
    )
    for consumer_job in (
        "extension-packages",
        "mobile-extension-packages",
        "liboliphaunt-native-release-assets",
        "liboliphaunt-wasix-aot",
        "liboliphaunt-wasix-release-assets",
        "mobile-build-android",
        "mobile-build-ios",
    ):
        require_text(
            ".github/workflows/ci.yml",
            f"OLIPHAUNT_MOON_UPSTREAM=none MOON_CACHE=off .github/scripts/run-planned-moon-job.sh {consumer_job}",
            f"{consumer_job} must consume downloaded builder artifacts without re-running upstream producer tasks",
        )
    if "Stage mobile exact-extension packages" in ci:
        fail("mobile build jobs must not locally stage extension packages; they must consume extension-package builder artifacts")
    if "extension-packages-native" in ci:
        fail("CI must not keep a native-only extension package shortcut; mobile must consume target-scoped exact-extension packages")
    if "oliphaunt-extension-native-package-artifacts" in ci:
        fail("CI must not publish native-only exact-extension package artifacts")
    if "target/extension-artifacts-native" in ci:
        fail("CI must not use a separate native-only extension package staging layout")
    require_text(
        "tools/release/release.py",
        "requires staged exact-extension package artifacts",
        "release CLI must fail closed when extension releases lack staged CI-built package artifacts",
    )
    require_text(
        "tools/release/release.py",
        "validate_extension_release_package",
        "release CLI must validate staged exact-extension package manifests before dry-run or publish",
    )
    require_text(
        "tools/release/release.py",
        "staged_native_targets != declared_native_targets",
        "release CLI must reject partial native exact-extension package artifacts",
    )
    require_text(
        "tools/release/release.py",
        "staged_wasix_targets != declared_wasix_targets",
        "release CLI must reject partial WASIX exact-extension package artifacts",
    )
    require_text(
        "tools/release/release.py",
        "sha256_file(asset_path) != sha_value",
        "release CLI must verify staged exact-extension artifact checksums",
    )
    require_text(
        "tools/release/release.py",
        "validate_checksum_manifest(checksum_manifest, asset_dir)",
        "release CLI must verify staged exact-extension checksum manifests exactly",
    )
    require_text(
        "tools/release/build-extension-ci-artifacts.mjs",
        "nativeAssetName(product, version",
        "exact-extension package artifacts must be named by extension product version",
    )
    require_text(
        "src/extensions/artifacts/native/tools/package-release-assets.sh",
        "native-extension-assets.tsv",
        "native exact-extension artifact producers must emit a target-addressed native asset index",
    )
    require_text(
        "src/extensions/artifacts/native/tools/package-release-assets.sh",
        "OLIPHAUNT_EXTENSION_PRODUCT",
        "native exact-extension artifact producers must support product-scoped builds",
    )
    require_text(
        "src/extensions/artifacts/wasix/tools/package-release-assets.sh",
        "OLIPHAUNT_EXTENSION_PRODUCT",
        "WASIX exact-extension artifact producers must support product-scoped builds",
    )
    require_text(
        "tools/release/build-extension-ci-artifacts.mjs",
        "nativeAssetsFromTargetIndexes",
        "exact-extension package staging must consume target-addressed native asset indexes",
    )
    require_text(
        "tools/release/build-extension-ci-artifacts.mjs",
        'publishedTargetIds("native")',
        "exact-extension package staging must only read declared published native target artifact indexes",
    )
    require_text(
        "tools/release/build-extension-ci-artifacts.mjs",
        'publishedTargetIds("wasix")',
        "exact-extension package staging must only read declared published WASIX target artifact indexes",
    )
    require_text(
        "tools/release/build-extension-ci-artifacts.mjs",
        "if (requireNativeTargets.size > 0 && !requireNativeTargets.has(target))",
        "mobile exact-extension package staging must filter out native targets that the mobile build did not request",
    )
    require_text(
        "tools/release/build-extension-ci-artifacts.mjs",
        "indexContainsSqlName(productIndex, sqlName)",
        "exact-extension package staging must not let stale empty product-scoped native indexes shadow target-level indexes",
    )
    require_text(
        "tools/release/build-extension-ci-artifacts.mjs",
        "-manifest.json",
        "exact-extension package artifacts must publish a machine-readable release manifest",
    )
    require_text(
        "tools/release/check_github_release_assets.mjs",
        "verifyReleaseAssets",
        "GitHub release verification must derive exact-extension asset expectations from staged extension package manifests",
    )
    require_text(
        "tools/release/verify_github_release_attestations.mjs",
        "exact-extension-artifact",
        "Release attestation verification must include exact-extension artifact products",
    )
    require_text(
        "tools/release/release.py",
        "liboliphaunt-native requires staged release assets",
        "release CLI must fail closed when liboliphaunt releases lack staged CI-built runtime artifacts",
    )
    require_text(
        "tools/release/release.py",
        "liboliphaunt-wasix requires staged release assets",
        "release CLI must fail closed when WASIX releases lack staged CI-built runtime artifacts",
    )
    require_text(
        "tools/release/release.py",
        "requires staged JSR source",
        "release CLI must fail closed when TypeScript JSR release artifacts are not staged",
    )
    require_text(
        ".github/workflows/release.yml",
        "Download SDK package artifacts",
        "release workflow must download SDK package artifacts from the CI workflow before publishing",
    )
    require_text(
        ".github/workflows/release.yml",
        "Download liboliphaunt release assets",
        "release workflow must download complete liboliphaunt assets from the CI workflow before publishing",
    )
    require_text(
        ".github/workflows/release.yml",
        "Download native helper release assets",
        "release workflow must download broker and Node direct helper assets from the CI workflow before publishing those helper products",
    )
    require_text(
        ".github/workflows/release.yml",
        "Download WASIX release assets",
        "release workflow must download complete WASIX runtime release assets from the CI workflow before publishing",
    )
    require_text(
        ".github/workflows/release.yml",
        "Upload WASIX GitHub release assets",
        "release workflow must publish WASIX GitHub assets through the liboliphaunt-wasix runtime product",
    )
    require_text(
        ".github/workflows/release.yml",
        "--product liboliphaunt-wasix --step github-release-assets",
        "release workflow must publish WASIX GitHub assets through the liboliphaunt-wasix runtime product",
    )
    require_text(
        ".github/workflows/release.yml",
        "--product liboliphaunt-wasix --step crates-io",
        "release workflow must publish liboliphaunt-wasix Cargo artifact packages before the WASIX Rust binding",
    )
    require_text(
        ".github/workflows/release.yml",
        "tools/release/release.py ci-artifacts --product \"$product\" --kind \"$kind\" --family release-assets",
        "release workflow must derive native helper release artifact names from target metadata",
    )
    require_text(
        ".github/workflows/release.yml",
        '[ "$PRODUCT_OLIPHAUNT_BROKER" = "true" ]',
        "broker helper releases must download broker artifacts from CI",
    )
    require_text(
        ".github/workflows/release.yml",
        '[ "$PRODUCT_OLIPHAUNT_NODE_DIRECT" = "true" ]',
        "Node direct helper releases must download Node direct artifacts from CI",
    )
    require_text(
        ".github/workflows/release.yml",
        "tools/release/release.py ci-artifacts --product oliphaunt-node-direct --kind node-direct-addon --family npm-package",
        "release workflow must derive Node direct npm package artifact names from target metadata",
    )
    require_text(
        ".github/workflows/release.yml",
        "target/oliphaunt-broker/release-assets",
        "release workflow must download broker artifacts into the canonical broker release asset root",
    )
    require_text(
        ".github/workflows/release.yml",
        "target/oliphaunt-node-direct/release-assets",
        "release workflow must download Node direct artifacts into the canonical Node direct release asset root",
    )
    require_text(
        ".github/workflows/release.yml",
        "--product liboliphaunt-native --step npm",
        "release workflow must publish liboliphaunt artifact packages to npm before dependent SDK packages",
    )
    require_text(
        ".github/workflows/release.yml",
        "--product oliphaunt-broker --step npm",
        "release workflow must publish broker artifact packages to npm before dependent SDK packages",
    )
    require_text(
        ".github/workflows/release.yml",
        "--product liboliphaunt-native --step crates-io",
        "release workflow must publish liboliphaunt native Cargo artifact packages before dependent Rust SDK packages",
    )
    require_text(
        ".github/workflows/release.yml",
        "--product oliphaunt-broker --step crates-io",
        "release workflow must publish broker artifact packages to crates.io before dependent Rust SDK packages",
    )
    require_text(
        "tools/release/release.py",
        "npm-package-sources",
        "npm artifact packages must be assembled from staged package sources instead of mutating checked-in package directories",
    )
    require_text(
        "tools/release/release.py",
        "package-liboliphaunt-cargo-artifacts.mjs",
        "liboliphaunt native Cargo artifact packages must be generated from staged native release assets",
    )
    require_text(
        "tools/release/release.py",
        "package_broker_cargo_artifacts.mjs",
        "broker Cargo artifact packages must be generated from staged broker release assets",
    )
    require_text(
        "tools/release/release.py",
        "package_liboliphaunt_wasix_cargo_artifacts.py",
        "liboliphaunt-wasix Cargo artifact packages must be generated from staged WASIX release assets",
    )
    require_text(
        "tools/release/release.py",
        "liboliphaunt_wasix_cargo_artifact_crates",
        "release CLI must package and validate direct WASIX Cargo artifact crates",
    )
    require_text(
        "tools/release/package_liboliphaunt_wasix_cargo_artifacts.py",
        "CRATES_IO_MAX_BYTES",
        "WASIX Cargo artifact packager must enforce the crates.io package size limit",
    )
    require_text(
        "tools/release/package_liboliphaunt_wasix_cargo_artifacts.py",
        "validate_crate_size",
        "WASIX Cargo artifact packager must validate direct artifact crate sizes",
    )
    reject_text(
        "tools/release/package_liboliphaunt_wasix_cargo_artifacts.py",
        "DEFAULT_PART_COUNT",
        "WASIX Cargo artifact packager must not generate reserved part crates",
    )
    require_text(
        "tools/release/package_liboliphaunt_wasix_cargo_artifacts.py",
        "wasix_extension_aot_part_package_name",
        "WASIX Cargo artifact packager may only generate named part crates for oversized extension AOT artifacts",
    )
    require_text(
        "tools/release/package_liboliphaunt_wasix_cargo_artifacts.py",
        "EXTENSION_AOT_SPLIT_THRESHOLD_BYTES",
        "WASIX Cargo artifact packager must keep extension AOT part splitting behind an explicit size threshold",
    )
    require_text(
        "tools/release/release.py",
        "artifact_npm_package_targets",
        "liboliphaunt and broker npm artifact packages must derive package targets from artifact target metadata",
    )
    reject_text(
        "tools/release/release.py",
        "LIBOLIPHAUNT_NPM_PACKAGE_DIRS",
        "liboliphaunt npm package target mapping must not be duplicated outside artifact target metadata",
    )
    reject_text(
        "tools/release/release.py",
        "BROKER_NPM_PACKAGE_DIRS",
        "broker npm package target mapping must not be duplicated outside artifact target metadata",
    )
    require_text(
        "tools/release/release.py",
        "required_runtime_member_paths",
        "liboliphaunt npm artifact packages must include the selected platform runtime tree",
    )
    require_text(
        "tools/release/package-liboliphaunt-cargo-artifacts.mjs",
        "optimizeNativePayload(",
        "liboliphaunt Cargo artifact packages must prune and validate native runtime payloads before splitting",
    )
    reject_text(
        ".github/workflows/release.yml",
        "target/release-assets/native",
        "release workflow must not stage native helper artifacts in a generic release-assets/native bucket",
    )
    require_text(
        "tools/release/build-sdk-ci-artifacts.sh",
        'stage_jsr_source_workspace "$package_shape_dir" "$artifact_root/jsr-source"',
        "TypeScript SDK builder must stage source for JSR publishing in addition to the npm tarball",
    )
    require_text(
        "tools/release/release.py",
        'staged_jsr_source_dir("oliphaunt-js")',
        "TypeScript SDK release must publish JSR from staged CI-built source artifacts",
    )
    require_text(
        "tools/release/release.py",
        "validate_staged_npm_package_tarball",
        "npm SDK release steps must validate CI-built package tarballs before dry-run or publish",
    )
    require_text(
        "tools/release/release.py",
        "must not contain workspace: dependency specifiers",
        "staged npm SDK package validation must reject unpublished workspace protocol specs",
    )
    require_text(
        "tools/release/release.py",
        "verify_staged_cargo_crate_identity",
        "Cargo SDK release steps must verify staged CI-built .crate identity before dry-run or publish",
    )
    for forbidden in (
        "tools/release/package-liboliphaunt-assets.sh",
        "tools/release/package-broker-assets.sh",
        "src/runtimes/node-direct/tools/build-node-addon.sh",
        "src/extensions/artifacts/native/tools/package-release-assets.sh",
        "src/extensions/artifacts/wasix/tools/package-release-assets.sh",
        "tools/release/build-extension-ci-artifacts.mjs",
        "src/sdks/kotlin/tools/check-sdk.sh",
        "src/sdks/react-native/tools/check-sdk.sh",
        "src/sdks/js/tools/check-sdk.sh",
        'xtask(["release", "stage"])',
        '"--staged-wasm"',
        '"--staged-wasix-runtime"',
        "OLIPHAUNT_RELEASE_REQUIRE_STAGED_",
        "OLIPHAUNT_WASM_RELEASE_STAGED",
    ):
        reject_text(
            "tools/release/release.py",
            forbidden,
            f"release CLI must consume staged CI artifacts, not retain local fallback path {forbidden}",
        )
    for forbidden in (
        "OLIPHAUNT_RELEASE_REQUIRE_STAGED_",
        "OLIPHAUNT_WASM_RELEASE_STAGED",
    ):
        reject_text(
            ".github/workflows/release.yml",
            forbidden,
            f"release workflow must not rely on staged-mode env flag {forbidden}; release CLI is staged-artifact-only",
        )
    reject_text(
        ".github/workflows/release.yml",
        "Build liboliphaunt Linux asset",
        "release workflow must not rebuild liboliphaunt Linux assets; it must consume CI artifacts",
    )
    reject_text(
        ".github/workflows/release.yml",
        "Build liboliphaunt Windows asset",
        "release workflow must not rebuild liboliphaunt Windows assets; it must consume CI artifacts",
    )
    reject_text(
        ".github/workflows/release.yml",
        "Build broker Linux asset",
        "release workflow must not rebuild broker Linux assets; it must consume CI artifacts",
    )
    reject_text(
        ".github/workflows/release.yml",
        "Build Node direct native asset",
        "release workflow must not rebuild Node direct assets; it must consume CI artifacts",
    )
    require_text(
        ".github/scripts/download-build-artifacts.sh",
        "artifact_present",
        "shared artifact downloader must select a successful CI run containing every requested artifact",
    )
    require_text(
        ".github/scripts/download-build-artifacts.sh",
        "required_job_success",
        "shared artifact downloader must support the builder-gate handoff when non-builder checks fail",
    )
    require_text(
        ".github/workflows/release.yml",
        "require-workflow-success.sh CI \"$RELEASE_HEAD_SHA\" 7200 --job Builds",
        "release workflow must require the selected release commit CI artifact builder gate instead of the whole workflow conclusion",
    )
    require_text(
        ".github/workflows/release.yml",
        "--job Builds",
        "release workflow artifact downloads must select artifacts from a run whose builds job succeeded",
    )
    require_text(
        ".github/scripts/download-wasix-runtime-build-artifacts.sh",
        "--required-job Builds",
        "WASIX runtime artifact handoff must download from a CI run whose builds job succeeded",
    )
    require_text(
        "tools/xtask/src/asset_io.rs",
        "run_has_required_job_success",
        "xtask WASIX artifact downloads must support filtering selected release runs by required builder job",
    )
    if release.index("Download SDK package artifacts") > release.index("Validate selected release product dry-runs"):
        fail("release workflow must stage SDK artifacts before selected release product dry-runs")
    if release.index("Download liboliphaunt release assets") > release.index("Validate selected release product dry-runs"):
        fail("release workflow must stage liboliphaunt runtime artifacts before selected release product dry-runs")
    if release.index("Download native helper release assets") > release.index("Validate selected release product dry-runs"):
        fail("release workflow must stage native helper artifacts before selected release product dry-runs")
    if release.index("Download WASIX release assets") > release.index("Validate selected release product dry-runs"):
        fail("release workflow must stage WASIX runtime release assets before selected release product dry-runs")
    if release.index("--product liboliphaunt-wasix --step crates-io") > release.index("--product oliphaunt-wasix-rust --step crates-io"):
        fail("release workflow must publish liboliphaunt-wasix Cargo artifact crates before oliphaunt-wasix")
    extension_packages_block = ci[ci.index("extension-packages:") : ci.index("  liboliphaunt-native-desktop:")]
    if "Download portable WASIX runtime outputs" in extension_packages_block:
        fail("extension-packages must consume WASIX extension artifact outputs, not raw portable runtime outputs")


def validate_target_matrices() -> None:
    ci = read_text(".github/workflows/ci.yml")
    release = read_text(".github/workflows/release.yml")
    planner = read_text("tools/graph/ci_plan.mjs")
    for output_name in (
        "liboliphaunt_native_desktop_runtime_matrix",
        "liboliphaunt_native_android_runtime_matrix",
        "liboliphaunt_native_ios_runtime_matrix",
    ):
        if output_name not in ci or f"fromJson(needs.affected.outputs.{output_name})" not in ci:
            fail(f"CI {output_name} matrix must come from affected planner output")
    for output_name, helper in (
        ("liboliphaunt_native_desktop_runtime_matrix", "liboliphauntNativeDesktopRuntimeMatrix"),
        ("liboliphaunt_native_android_runtime_matrix", "liboliphauntNativeAndroidRuntimeMatrix"),
        ("liboliphaunt_native_ios_runtime_matrix", "liboliphauntNativeIosRuntimeMatrix"),
    ):
        require_text(
            "tools/graph/ci_plan.mjs",
            helper,
            f"CI affected planner must derive {output_name} from release metadata artifact targets",
        )
    if "broker_runtime_matrix" not in ci or "fromJson(needs.affected.outputs.broker_runtime_matrix)" not in ci:
        fail("CI broker matrix must come from affected planner output")
    if "node_direct_runtime_matrix" not in ci or "fromJson(needs.affected.outputs.node_direct_runtime_matrix)" not in ci:
        fail("CI Node direct matrix must come from affected planner output")
    if (
        "extension_artifacts_wasix_matrix" not in ci
        or "fromJson(needs.affected.outputs.extension_artifacts_wasix_matrix)" not in ci
    ):
        fail("CI WASIX extension artifact matrix must come from affected planner output")
    require_text(
        ".github/workflows/ci.yml",
        "Build native exact-extension artifacts",
        "CI must build native exact-extension artifacts in their own producer job",
    )
    if (
        "extension_artifacts_native_matrix" not in ci
        or "fromJson(needs.affected.outputs.extension_artifacts_native_matrix)" not in ci
    ):
        fail("CI native extension artifact matrix must come from affected planner output")
    require_text(
        "src/extensions/artifacts/native/moon.yml",
        "src/extensions/artifacts/native/tools/package-release-assets.sh",
        "CI native exact-extension artifact producer must use the release-shaped native extension packager",
    )
    require_text(
        "src/extensions/artifacts/packages/moon.yml",
        "tools/release/build-extension-ci-artifacts.mjs --all --require-native --require-wasix",
        "CI exact-extension package producer must use the shared product artifact builder",
    )
    require_text(
        "src/extensions/artifacts/packages/moon.yml",
        "/target/extensions/wasix/aot-artifacts/**/*",
        "CI exact-extension package producer must consume WASIX extension AOT artifacts",
    )
    require_text(
        "src/runtimes/liboliphaunt/wasix/tools/build-runtime-portable.sh",
        "cargo run -p xtask -- assets check --strict-generated",
        "WASIX portable runtime build must validate generated extension/runtime assets",
    )
    require_text(
        "src/runtimes/liboliphaunt/wasix/tools/build-aot-target.sh",
        'cargo run -p xtask -- assets package-extension-aot --target-triple "$target"',
        "WASIX AOT target build must package extension AOT artifacts for extension Cargo crates",
    )
    require_text(
        "src/runtimes/liboliphaunt/wasix/tools/build-aot-target.sh",
        "cargo run -p xtask -- assets check-aot --target-triple \"$target\"",
        "WASIX AOT target build must validate target AOT artifacts",
    )
    if "native-release-targets:" in release or "native-release-assets:" in release:
        fail("release workflow must not define separate native asset builder jobs; CI owns runtime/helper artifacts")
    if "artifact_target_matrix.py native-release-hosts" in release:
        fail("release workflow must not use the removed native-release-hosts matrix")
    if "../release/artifact_target_matrix.mjs" not in planner:
        fail("shared affected planner must query the release artifact target matrix helper")

    liboliphaunt_matrix = artifact_target_matrix("liboliphaunt-native-runtime")
    liboliphaunt_targets = {item["target"] for item in liboliphaunt_matrix["include"]}
    expected_liboliphaunt_targets = {
        target.target
        for target in product_metadata.artifact_targets(
            product="liboliphaunt-native",
            kind="native-runtime",
            published_only=True,
        )
    }
    if liboliphaunt_targets != expected_liboliphaunt_targets:
        fail(
            "liboliphaunt CI matrix does not match published native runtime targets: "
            f"{sorted(liboliphaunt_targets)} vs {sorted(expected_liboliphaunt_targets)}"
        )

    extension_native_matrix = artifact_target_matrix("extension-artifacts-native")
    extension_native_pairs = {
        (product, item["target"])
        for item in extension_native_matrix["include"]
        for product in item["extensions_csv"].split(",")
        if product
    }
    expected_extension_native_pairs = {
        (target.product, target.target)
        for target in product_metadata.extension_artifact_targets(family="native", published_only=True)
    }
    if extension_native_pairs != expected_extension_native_pairs:
        fail(
            "native extension artifact CI matrix does not match published exact-extension native product/target pairs: "
            f"{sorted(extension_native_pairs)} vs {sorted(expected_extension_native_pairs)}"
        )

    broker_matrix = artifact_target_matrix("broker-runtime")
    broker_targets = {item["target"] for item in broker_matrix["include"]}
    expected_broker_targets = {
        target.target
        for target in product_metadata.artifact_targets(
            product="oliphaunt-broker",
            kind="broker-helper",
            published_only=True,
        )
    }
    if broker_targets != expected_broker_targets:
        fail(
            "broker CI matrix does not match published broker helper targets: "
            f"{sorted(broker_targets)} vs {sorted(expected_broker_targets)}"
        )

    node_direct_matrix = artifact_target_matrix("node-direct-runtime")
    node_direct_targets = {item["target"] for item in node_direct_matrix["include"]}
    expected_node_direct_targets = {
        target.target
        for target in product_metadata.artifact_targets(
            product="oliphaunt-node-direct",
            kind="node-direct-addon",
            published_only=True,
        )
    }
    if node_direct_targets != expected_node_direct_targets:
        fail(
            "Node direct CI matrix does not match published Node direct targets: "
            f"{sorted(node_direct_targets)} vs {sorted(expected_node_direct_targets)}"
        )

    extension_wasix_matrix = artifact_target_matrix("extension-artifacts-wasix")
    extension_wasix_pairs = {
        (product, item["target"])
        for item in extension_wasix_matrix["include"]
        for product in item["extensions_csv"].split(",")
        if product
    }
    expected_extension_wasix_pairs = {
        (target.product, target.target)
        for target in product_metadata.extension_artifact_targets(family="wasix", published_only=True)
    }
    if extension_wasix_pairs != expected_extension_wasix_pairs:
        fail(
            "WASIX extension artifact CI matrix does not match published exact-extension WASIX product/target pairs: "
            f"{sorted(extension_wasix_pairs)} vs {sorted(expected_extension_wasix_pairs)}"
        )


def validate_typescript_runtime_targets() -> None:
    for target in product_metadata.artifact_targets(
        product="liboliphaunt-native",
        kind="native-runtime",
        surface="typescript-native-direct",
    ):
        path = "src/sdks/js/src/native/common.ts"
        if target.published:
            if target.npm_package is None:
                fail(f"{target.id} must declare npm_package for TypeScript native resolution")
            if target.library_relative_path is None:
                fail(f"{target.id} must declare library_relative_path for TypeScript native resolution")
            require_text(path, target.npm_package, f"TypeScript native resolver must advertise {target.id}")
            require_text(path, target.target, f"TypeScript native resolver must expose target id {target.target}")
            require_text(
                path,
                target.library_relative_path,
                f"TypeScript native resolver must expose library path for {target.id}",
            )
            require_text(
                path,
                "runtimeRelativePath",
                f"TypeScript native resolver must expose runtime package path for {target.id}",
            )
        else:
            if target.npm_package is not None:
                reject_text(path, target.npm_package, f"TypeScript native resolver must not advertise unpublished target {target.id}")
            reject_text(path, target.target, f"TypeScript native resolver must not expose unpublished target id {target.target}")

    for target in product_metadata.artifact_targets(
        product="oliphaunt-broker",
        kind="broker-helper",
        surface="typescript-broker",
    ):
        path = "src/sdks/js/src/runtime/broker.ts"
        if target.published:
            if target.npm_package is None:
                fail(f"{target.id} must declare npm_package for TypeScript broker resolution")
            if target.executable_relative_path is None:
                fail(f"{target.id} must declare executable_relative_path for TypeScript broker resolution")
            require_text(path, target.npm_package, f"TypeScript broker resolver must advertise {target.id}")
            require_text(path, target.target, f"TypeScript broker resolver must expose target id {target.target}")
            require_text(
                path,
                target.executable_relative_path,
                f"TypeScript broker resolver must expose executable path for {target.id}",
            )
        else:
            if target.npm_package is not None:
                reject_text(path, target.npm_package, f"TypeScript broker resolver must not advertise unpublished target {target.id}")
            reject_text(path, target.target, f"TypeScript broker resolver must not expose unpublished target id {target.target}")

    for target in product_metadata.artifact_targets(
        product="oliphaunt-node-direct",
        kind="node-direct-addon",
        surface="npm-optional",
    ):
        path = "src/sdks/js/src/native/node-addon.ts"
        if target.published:
            if target.npm_package is None:
                fail(f"{target.id} must declare npm_package for TypeScript Node direct resolution")
            require_text(path, target.npm_package, f"TypeScript Node direct resolver must advertise {target.id}")
            require_text(path, target.target, f"TypeScript Node direct resolver must expose target id {target.target}")
            require_text(
                path,
                "ADDON_STEM",
                f"TypeScript Node direct resolver must expose addon path for {target.id}",
            )
        else:
            if target.npm_package is not None:
                reject_text(path, target.npm_package, f"TypeScript Node direct resolver must not advertise unpublished target {target.id}")
            reject_text(path, target.target, f"TypeScript Node direct resolver must not expose unpublished target id {target.target}")


def validate_rust_broker_targets() -> None:
    manifest = "src/sdks/rust/Cargo.toml"
    path = "src/sdks/rust/src/broker.rs"
    require_text(
        manifest,
        'broker-helper = "oliphaunt-broker"',
        "Rust SDK package metadata must identify the broker helper runtime it consumes",
    )
    require_text(
        manifest,
        f'broker-version = "{product_metadata.read_current_version("oliphaunt-broker")}"',
        "Rust SDK package metadata must pin the compatible broker helper version",
    )
    require_text(
        path,
        "OLIPHAUNT_BROKER_ASSET_DIR",
        "Rust broker resolver must support package-shaped broker artifact fixtures",
    )
    for target in product_metadata.artifact_targets(
        product="oliphaunt-broker",
        kind="broker-helper",
        surface="rust-broker",
    ):
        if target.published:
            require_text(path, target.asset, f"Rust broker resolver must advertise {target.id}")
            require_text(path, target.target, f"Rust broker resolver must expose target id {target.target}")
            if target.executable_relative_path is not None:
                require_text(
                    path,
                    target.executable_relative_path,
                    f"Rust broker resolver must expose helper path for {target.id}",
                )
        else:
            reject_text(path, target.asset, f"Rust broker resolver must not advertise unpublished target {target.id}")
            reject_text(path, target.target, f"Rust broker resolver must not expose unpublished target id {target.target}")


def validate_expected_product_assets() -> None:
    expected = {
        "liboliphaunt-native": {
            "liboliphaunt-{version}-macos-arm64.tar.gz",
            "oliphaunt-tools-{version}-macos-arm64.tar.gz",
            "liboliphaunt-{version}-linux-x64-gnu.tar.gz",
            "oliphaunt-tools-{version}-linux-x64-gnu.tar.gz",
            "liboliphaunt-{version}-linux-arm64-gnu.tar.gz",
            "oliphaunt-tools-{version}-linux-arm64-gnu.tar.gz",
            "liboliphaunt-{version}-windows-x64-msvc.zip",
            "oliphaunt-tools-{version}-windows-x64-msvc.zip",
            "liboliphaunt-{version}-ios-xcframework.tar.gz",
            "liboliphaunt-{version}-apple-spm-xcframework.zip",
            "liboliphaunt-{version}-android-arm64-v8a.tar.gz",
            "liboliphaunt-{version}-android-x86_64.tar.gz",
            "liboliphaunt-{version}-runtime-resources.tar.gz",
            "liboliphaunt-{version}-icu-data.tar.gz",
            "liboliphaunt-{version}-package-size.tsv",
            "liboliphaunt-{version}-release-assets.sha256",
        },
        "oliphaunt-broker": {
            "oliphaunt-broker-{version}-macos-arm64.tar.gz",
            "oliphaunt-broker-{version}-linux-x64-gnu.tar.gz",
            "oliphaunt-broker-{version}-linux-arm64-gnu.tar.gz",
            "oliphaunt-broker-{version}-windows-x64-msvc.zip",
            "oliphaunt-broker-{version}-release-assets.sha256",
        },
        "oliphaunt-node-direct": {
            "oliphaunt-node-direct-{version}-macos-arm64.tar.gz",
            "oliphaunt-node-direct-{version}-linux-x64-gnu.tar.gz",
            "oliphaunt-node-direct-{version}-linux-arm64-gnu.tar.gz",
            "oliphaunt-node-direct-{version}-windows-x64-msvc.zip",
            "oliphaunt-node-direct-{version}-release-assets.sha256",
        },
        "liboliphaunt-wasix": {
            "liboliphaunt-wasix-{version}-runtime-portable.tar.zst",
            "liboliphaunt-wasix-{version}-icu-data.tar.zst",
            "liboliphaunt-wasix-{version}-runtime-aot-macos-arm64.tar.zst",
            "liboliphaunt-wasix-{version}-runtime-aot-linux-x64-gnu.tar.zst",
            "liboliphaunt-wasix-{version}-runtime-aot-linux-arm64-gnu.tar.zst",
            "liboliphaunt-wasix-{version}-runtime-aot-windows-x64-msvc.tar.zst",
            "liboliphaunt-wasix-{version}-release-assets.sha256",
        },
    }
    for product, assets in expected.items():
        actual = {
            target.asset
            for target in product_metadata.artifact_targets(
                product=product,
                surface="github-release",
                published_only=True,
            )
        }
        if actual != assets:
            fail(f"{product} published artifact targets expected {sorted(assets)}, got {sorted(actual)}")


def main() -> int:
    validate_target_shape()
    validate_moon_runtime_targets()
    validate_extension_artifact_targets()
    validate_github_asset_helpers()
    validate_ci_release_artifacts()
    validate_target_matrices()
    validate_typescript_runtime_targets()
    validate_rust_broker_targets()
    validate_expected_product_assets()
    print("artifact target checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
