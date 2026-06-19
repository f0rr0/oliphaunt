#!/usr/bin/env python3
"""Emit GitHub Actions matrices derived from release artifact targets."""

from __future__ import annotations

import argparse
from dataclasses import dataclass, field
import json
import os
from pathlib import Path
from typing import Iterable

import artifact_targets
import extension_artifact_targets
import product_metadata


@dataclass
class ExtensionTargetGroup:
    target: str
    runner: str
    extensions: set[str] = field(default_factory=set)
    sql_names: set[str] = field(default_factory=set)
    build_root: str | None = None
    ci_artifact_root: str | None = None
    runtime_kind: str | None = None
    triple: str | None = None


def build_root_for_liboliphaunt_target(target_id: str) -> str:
    if target_id == "macos-arm64":
        return "target/liboliphaunt-pg18"
    if target_id == "android-arm64-v8a":
        return "target/liboliphaunt-pg18-android-arm64"
    if target_id == "ios-xcframework":
        return "target/liboliphaunt-ios-xcframework"
    return f"target/liboliphaunt-pg18-{target_id}"


def ci_artifact_root_for_liboliphaunt_target(target_id: str) -> str:
    return f"target/liboliphaunt-native-ci/{target_id}"


def liboliphaunt_native_runtime_matrix() -> dict[str, list[dict[str, str]]]:
    include: list[dict[str, str]] = []
    for target in artifact_targets.artifact_targets(
        product="liboliphaunt-native",
        kind="native-runtime",
        published_only=True,
    ):
        if target.runner is None:
            product_metadata.fail(f"{target.id} must declare runner")
        include.append(
            {
                "target": target.target,
                "runner": target.runner,
                "build-root": build_root_for_liboliphaunt_target(target.target),
                "ci-artifact-root": ci_artifact_root_for_liboliphaunt_target(target.target),
            }
        )
    if not include:
        product_metadata.fail("no published liboliphaunt-native native-runtime targets")
    return {"include": include}


def _filtered_liboliphaunt_native_runtime_matrix(
    predicate,
    *,
    native_target: str = "all",
    selected_targets: set[str] | None = None,
    label: str,
) -> dict[str, list[dict[str, str]]]:
    include = [
        item
        for item in liboliphaunt_native_runtime_matrix()["include"]
        if predicate(item["target"])
    ]
    if native_target != "all":
        include = [item for item in include if item["target"] == native_target]
    if selected_targets is not None:
        include = [item for item in include if item["target"] in selected_targets]
    if not include:
        product_metadata.fail(f"no published liboliphaunt-native {label} targets matched the selected CI plan")
    return {"include": include}


def liboliphaunt_native_desktop_runtime_matrix(
    *,
    native_target: str = "all",
    selected_targets: set[str] | None = None,
) -> dict[str, list[dict[str, str]]]:
    return _filtered_liboliphaunt_native_runtime_matrix(
        lambda target: target.startswith(("linux-", "macos-", "windows-")),
        native_target=native_target,
        selected_targets=selected_targets,
        label="desktop",
    )


def liboliphaunt_native_android_runtime_matrix(
    *,
    native_target: str = "all",
    selected_targets: set[str] | None = None,
) -> dict[str, list[dict[str, str]]]:
    return _filtered_liboliphaunt_native_runtime_matrix(
        lambda target: target.startswith("android-"),
        native_target=native_target,
        selected_targets=selected_targets,
        label="Android",
    )


def liboliphaunt_native_ios_runtime_matrix(
    *,
    native_target: str = "all",
    selected_targets: set[str] | None = None,
) -> dict[str, list[dict[str, str]]]:
    return _filtered_liboliphaunt_native_runtime_matrix(
        lambda target: target == "ios-xcframework",
        native_target=native_target,
        selected_targets=selected_targets,
        label="iOS",
    )


def extension_artifacts_native_matrix(
    native_target: str = "all",
    selected_targets: set[str] | None = None,
    selected_products: set[str] | None = None,
) -> dict[str, list[dict[str, str]]]:
    by_target: dict[str, ExtensionTargetGroup] = {}
    runtime_targets = {
        target.target: target
        for target in artifact_targets.artifact_targets(
            product="liboliphaunt-native",
            kind="native-runtime",
            published_only=True,
        )
        if target.extension_artifacts
    }
    for extension_target in extension_artifact_targets.artifact_targets(
        family="native",
        published_only=True,
    ):
        if selected_products is not None and extension_target.product not in selected_products:
            continue
        target_id = extension_target.target
        if native_target != "all" and target_id != native_target:
            continue
        if selected_targets is not None and target_id not in selected_targets:
            continue
        runtime_target = runtime_targets.get(target_id)
        if runtime_target is None:
            product_metadata.fail(f"{extension_target.product} declares native extension target {target_id}, but liboliphaunt-native does not publish it")
        if runtime_target.runner is None:
            product_metadata.fail(f"{runtime_target.id} must declare runner")
        grouped = by_target.setdefault(
            target_id,
            ExtensionTargetGroup(
                target=target_id,
                runner=runtime_target.runner,
                build_root=build_root_for_liboliphaunt_target(target_id),
                ci_artifact_root=ci_artifact_root_for_liboliphaunt_target(target_id),
            ),
        )
        grouped.extensions.add(extension_target.product)
        grouped.sql_names.add(extension_target.sql_name)
    include: list[dict[str, str]] = []
    for item in by_target.values():
        extensions = sorted(item.extensions)
        sql_names = sorted(item.sql_names)
        if item.build_root is None or item.ci_artifact_root is None:
            raise AssertionError(f"native extension group {item.target} is missing native build metadata")
        include.append(
            {
                "extensions_csv": ",".join(extensions),
                "sql_names_csv": ",".join(sql_names),
                "extension_count": str(len(extensions)),
                "target": item.target,
                "runner": item.runner,
                "build-root": item.build_root,
                "ci-artifact-root": item.ci_artifact_root,
            }
        )
    if not include:
        valid_targets = ", ".join(extension_artifact_targets.published_target_ids(family="native"))
        product_metadata.fail(f"unknown native extension artifact target {native_target}; expected one of: all, {valid_targets}")
    include.sort(key=lambda item: item["target"])
    return {"include": include}


def liboliphaunt_native_runtime_targets_for_surface(surface: str) -> list[str]:
    targets = [
        target.target
        for target in artifact_targets.artifact_targets(
            product="liboliphaunt-native",
            kind="native-runtime",
            surface=surface,
            published_only=True,
        )
    ]
    if not targets:
        product_metadata.fail(f"no published liboliphaunt-native native-runtime targets for surface {surface}")
    return sorted(targets)


def react_native_android_mobile_app_matrix(
    *,
    native_target: str = "all",
    selected_targets: set[str] | None = None,
) -> dict[str, list[dict[str, str]]]:
    include: list[dict[str, str]] = []
    for target in artifact_targets.artifact_targets(
        product="liboliphaunt-native",
        kind="native-runtime",
        surface="react-native-android",
        published_only=True,
    ):
        if native_target != "all" and target.target != native_target:
            continue
        if selected_targets is not None and target.target not in selected_targets:
            continue
        if target.target == "android-arm64-v8a":
            abi = "arm64-v8a"
        elif target.target == "android-x86_64":
            abi = "x86_64"
        else:
            product_metadata.fail(f"unsupported React Native Android runtime target {target.target}")
        include.append(
            {
                "target": target.target,
                "abi": abi,
                "build-root": build_root_for_liboliphaunt_target(target.target),
            }
        )
    if not include:
        valid_targets = ", ".join(liboliphaunt_native_runtime_targets_for_surface("react-native-android"))
        product_metadata.fail(f"no React Native Android app targets matched; expected one of: all, {valid_targets}")
    include.sort(key=lambda item: item["target"])
    return {"include": include}


def extension_artifacts_wasix_matrix(
    wasm_target: str = "all",
    selected_products: set[str] | None = None,
) -> dict[str, list[dict[str, str]]]:
    by_target: dict[str, ExtensionTargetGroup] = {}
    extension_targets = extension_artifact_targets.artifact_targets(family="wasix", published_only=True)
    for target in artifact_targets.artifact_targets(
        product="liboliphaunt-wasix",
        published_only=True,
    ):
        if target.kind != "wasix-runtime":
            continue
        extension_target = "wasix-portable" if target.target == "portable" else target.target
        if wasm_target != "all" and target.target != wasm_target:
            continue
        for declared in extension_targets:
            if selected_products is not None and declared.product not in selected_products:
                continue
            if declared.target != extension_target:
                continue
            grouped = by_target.setdefault(
                declared.target,
                ExtensionTargetGroup(
                    target=declared.target,
                    runner=target.runner or "ubuntu-latest",
                    runtime_kind=target.kind,
                    triple=target.triple or "",
                ),
            )
            grouped.extensions.add(declared.product)
            grouped.sql_names.add(declared.sql_name)
    include: list[dict[str, str]] = []
    for item in by_target.values():
        extensions = sorted(item.extensions)
        sql_names = sorted(item.sql_names)
        if item.runtime_kind is None or item.triple is None:
            raise AssertionError(f"WASIX extension group {item.target} is missing runtime metadata")
        include.append(
            {
                "extensions_csv": ",".join(extensions),
                "sql_names_csv": ",".join(sql_names),
                "extension_count": str(len(extensions)),
                "target": item.target,
                "runner": item.runner,
                "runtime-kind": item.runtime_kind,
                "triple": item.triple,
            }
        )
    if not include:
        valid_targets = ", ".join(
            target.target
            for target in artifact_targets.artifact_targets(
                product="liboliphaunt-wasix",
                published_only=True,
            )
            if target.kind == "wasix-runtime"
        )
        product_metadata.fail(f"unknown WASIX extension artifact target {wasm_target}; expected one of: all, {valid_targets}")
    include.sort(key=lambda item: item["target"])
    return {"include": include}


def liboliphaunt_wasix_aot_runtime_matrix(wasm_target: str = "all") -> dict[str, list[dict[str, str]]]:
    include: list[dict[str, str]] = []
    for target in artifact_targets.artifact_targets(
        product="liboliphaunt-wasix",
        kind="wasix-aot-runtime",
        published_only=True,
    ):
        if wasm_target != "all" and wasm_target not in {target.target, target.triple}:
            continue
        if target.runner is None:
            product_metadata.fail(f"{target.id} must declare runner")
        if target.triple is None:
            product_metadata.fail(f"{target.id} must declare triple")
        if target.llvm_url is None:
            product_metadata.fail(f"{target.id} must declare llvm_url")
        include.append(
            {
                "os": target.runner,
                "target": target.triple,
                "target_id": target.target,
                "package": f"oliphaunt-wasix-aot-{target.triple}",
                "artifact": f"liboliphaunt-wasix-runtime-aot-{target.target}",
                "llvm_url": target.llvm_url,
            }
        )
    if not include:
        valid_targets = ", ".join(
            target.target
            for target in artifact_targets.artifact_targets(
                product="liboliphaunt-wasix",
                kind="wasix-aot-runtime",
                published_only=True,
            )
        )
        product_metadata.fail(f"unknown WASIX AOT runtime target {wasm_target}; expected one of: all, {valid_targets}")
    include.sort(key=lambda item: item["target_id"])
    return {"include": include}


def exact_extension_products() -> list[str]:
    return sorted({target.product for target in extension_artifact_targets.artifact_targets()})


def broker_runtime_matrix() -> dict[str, list[dict[str, str]]]:
    include: list[dict[str, str]] = []
    for target in artifact_targets.artifact_targets(
        product="oliphaunt-broker",
        kind="broker-helper",
        published_only=True,
    ):
        if target.runner is None:
            product_metadata.fail(f"{target.id} must declare runner")
        include.append(
            {
                "target": target.target,
                "runner": target.runner,
            }
        )
    if not include:
        product_metadata.fail("no published oliphaunt-broker helper targets")
    return {"include": include}


def node_direct_runtime_matrix() -> dict[str, list[dict[str, str]]]:
    include: list[dict[str, str]] = []
    for target in artifact_targets.artifact_targets(
        product="oliphaunt-node-direct",
        kind="node-direct-addon",
        published_only=True,
    ):
        if target.runner is None:
            product_metadata.fail(f"{target.id} must declare runner")
        include.append(
            {
                "target": target.target,
                "runner": target.runner,
            }
        )
    if not include:
        product_metadata.fail("no published oliphaunt-node-direct targets")
    return {"include": include}


def emit_github_output(name: str, value: object) -> None:
    rendered = json.dumps(value, sort_keys=True, separators=(",", ":"))
    output_path = os.environ.get("GITHUB_OUTPUT")
    if output_path:
        with Path(output_path).open("a", encoding="utf-8") as handle:
            print(f"{name}={rendered}", file=handle)
    print(f"{name}={rendered}")


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "matrix",
        choices=[
            "liboliphaunt-native-runtime",
            "liboliphaunt-native-desktop-runtime",
            "liboliphaunt-native-android-runtime",
            "liboliphaunt-native-ios-runtime",
            "react-native-android-mobile-app",
            "extension-artifacts-native",
            "extension-artifacts-wasix",
            "liboliphaunt-wasix-aot-runtime",
            "broker-runtime",
            "node-direct-runtime",
        ],
        help="matrix shape to emit",
    )
    parser.add_argument("--github-output", action="store_true", help="write matrix=... to $GITHUB_OUTPUT")
    args = parser.parse_args(list(argv) if argv is not None else None)

    product_metadata.load_graph()
    match args.matrix:
        case "liboliphaunt-native-runtime":
            matrix = liboliphaunt_native_runtime_matrix()
        case "liboliphaunt-native-desktop-runtime":
            matrix = liboliphaunt_native_desktop_runtime_matrix()
        case "liboliphaunt-native-android-runtime":
            matrix = liboliphaunt_native_android_runtime_matrix()
        case "liboliphaunt-native-ios-runtime":
            matrix = liboliphaunt_native_ios_runtime_matrix()
        case "react-native-android-mobile-app":
            matrix = react_native_android_mobile_app_matrix()
        case "extension-artifacts-native":
            matrix = extension_artifacts_native_matrix()
        case "extension-artifacts-wasix":
            matrix = extension_artifacts_wasix_matrix()
        case "liboliphaunt-wasix-aot-runtime":
            matrix = liboliphaunt_wasix_aot_runtime_matrix()
        case "broker-runtime":
            matrix = broker_runtime_matrix()
        case "node-direct-runtime":
            matrix = node_direct_runtime_matrix()
        case _:
            raise AssertionError(args.matrix)

    if args.github_output:
        emit_github_output("matrix", matrix)
    else:
        print(json.dumps(matrix, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
