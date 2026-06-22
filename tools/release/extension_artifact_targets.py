#!/usr/bin/env python3
"""Exact-extension release artifact target metadata."""

from __future__ import annotations

import tomllib
from dataclasses import dataclass
from pathlib import Path

import artifact_targets as runtime_artifact_targets
import product_metadata


ROOT = Path(__file__).resolve().parents[2]
SCHEMA = "oliphaunt-extension-artifact-targets-v1"
FAMILIES = {"native", "wasix"}
KINDS = {
    "native-dynamic",
    "native-static-registry",
    "wasix-runtime",
}
STATUSES = {"supported", "planned", "unsupported"}


@dataclass(frozen=True)
class ExtensionArtifactTarget:
    product: str
    sql_name: str
    target: str
    family: str
    kind: str
    published: bool
    status: str
    source_file: Path
    unsupported_reason: str | None = None


def _read_toml(path: Path) -> dict:
    try:
        data = tomllib.loads(path.read_text(encoding="utf-8"))
    except tomllib.TOMLDecodeError as error:
        product_metadata.fail(f"{path.relative_to(ROOT)} is invalid TOML: {error}")
    if not isinstance(data, dict):
        product_metadata.fail(f"{path.relative_to(ROOT)} must contain a TOML table")
    return data


def _exact_extension_products() -> list[str]:
    products: list[str] = []
    for product in product_metadata.product_ids():
        if product_metadata.product_config(product).get("kind") == "exact-extension-artifact":
            products.append(product)
    return sorted(products)


def _extension_sql_name(product: str) -> str:
    value = product_metadata.product_config(product).get("extension_sql_name")
    if not isinstance(value, str) or not value:
        product_metadata.fail(f"{product} release.toml must declare extension_sql_name")
    return value


def _bool(value: object, label: str) -> bool:
    if isinstance(value, bool):
        return value
    product_metadata.fail(f"{label} must be true or false")


def _string(value: object, label: str) -> str:
    if isinstance(value, str) and value:
        return value
    product_metadata.fail(f"{label} must be a non-empty string")


def artifact_target_file(product: str) -> Path:
    return ROOT / product_metadata.package_path(product) / "targets" / "artifacts.toml"


def _default_source_file(product: str) -> Path:
    return ROOT / product_metadata.package_path(product) / "release.toml"


def _default_native_kind(target: str) -> str:
    if target == "ios-xcframework" or target.startswith("android-"):
        return "native-static-registry"
    return "native-dynamic"


def _wasix_extension_target_id(runtime_target: str) -> str:
    if runtime_target == "portable":
        return "wasix-portable"
    return runtime_target


def _default_target_rows(product: str) -> list[dict]:
    source_file = str(_default_source_file(product).relative_to(ROOT))
    rows: list[dict] = []
    for target in runtime_artifact_targets.artifact_targets(
        product="liboliphaunt-native",
        kind="native-runtime",
        published_only=True,
    ):
        if not target.extension_artifacts:
            continue
        rows.append(
            {
                "target": target.target,
                "family": "native",
                "kind": _default_native_kind(target.target),
                "status": "supported",
                "published": True,
                "_source_file": source_file,
            }
        )
    for target in runtime_artifact_targets.artifact_targets(
        product="liboliphaunt-wasix",
        kind="wasix-runtime",
        published_only=True,
    ):
        rows.append(
            {
                "target": _wasix_extension_target_id(target.target),
                "family": "wasix",
                "kind": "wasix-runtime",
                "status": "supported",
                "published": True,
                "_source_file": source_file,
            }
        )
    if not rows:
        product_metadata.fail(f"{product} could not derive any exact-extension artifact targets")
    return rows


def artifact_targets(
    *,
    product: str | None = None,
    family: str | None = None,
    published_only: bool = False,
) -> list[ExtensionArtifactTarget]:
    products = [product] if product is not None else _exact_extension_products()
    parsed: list[ExtensionArtifactTarget] = []
    for product_id in products:
        if product_id not in product_metadata.product_ids():
            product_metadata.fail(f"unknown exact-extension product {product_id}")
        if product_metadata.product_config(product_id).get("kind") != "exact-extension-artifact":
            product_metadata.fail(f"{product_id} is not an exact-extension artifact product")
        path = artifact_target_file(product_id)
        if path.is_file():
            source_file = path
            data = _read_toml(path)
            if data.get("schema") != SCHEMA:
                product_metadata.fail(f"{path.relative_to(ROOT)} must use schema = {SCHEMA!r}")
            rows = data.get("targets")
            if not isinstance(rows, list) or not rows:
                product_metadata.fail(f"{path.relative_to(ROOT)} must define [[targets]] rows")
        else:
            source_file = _default_source_file(product_id)
            rows = _default_target_rows(product_id)
        source_label = source_file.relative_to(ROOT)
        allowed_override_keys = {
            (str(row["target"]), str(row["family"]), str(row["kind"]))
            for row in _default_target_rows(product_id)
        }
        sql_name = _extension_sql_name(product_id)
        seen: set[tuple[str, str, str]] = set()
        for index, row in enumerate(rows):
            if not isinstance(row, dict):
                product_metadata.fail(f"{source_label} targets[{index}] must be a table")
            target = _string(row.get("target"), f"{source_label} targets[{index}].target")
            target_family = _string(row.get("family"), f"{source_label} targets[{index}].family")
            kind = _string(row.get("kind"), f"{source_label} targets[{index}].kind")
            status = _string(row.get("status"), f"{source_label} targets[{index}].status")
            published = _bool(row.get("published"), f"{source_label} targets[{index}].published")
            if target_family not in FAMILIES:
                product_metadata.fail(f"{source_label} target {target} has invalid family {target_family!r}")
            if kind not in KINDS:
                product_metadata.fail(f"{source_label} target {target} has invalid kind {kind!r}")
            if status not in STATUSES:
                product_metadata.fail(f"{source_label} target {target} has invalid status {status!r}")
            if target_family == "wasix" and kind != "wasix-runtime":
                product_metadata.fail(f"{source_label} target {target} must use kind wasix-runtime for wasix family")
            if target_family == "native" and kind == "wasix-runtime":
                product_metadata.fail(f"{source_label} target {target} cannot use wasix-runtime for native family")
            reason = row.get("unsupported_reason")
            if published and status != "supported":
                product_metadata.fail(f"{source_label} target {target} cannot be published with status {status}")
            if not published and (not isinstance(reason, str) or not reason):
                product_metadata.fail(f"{source_label} unpublished target {target} must explain unsupported_reason")
            key = (target, target_family, kind)
            if key in seen:
                product_metadata.fail(f"{source_label} has duplicate target row {key}")
            if path.is_file() and key not in allowed_override_keys:
                product_metadata.fail(
                    f"{source_label} target row {key} is not backed by runtime artifact metadata"
                )
            seen.add(key)
            if family is not None and target_family != family:
                continue
            if published_only and not published:
                continue
            parsed.append(
                ExtensionArtifactTarget(
                    product=product_id,
                    sql_name=sql_name,
                    target=target,
                    family=target_family,
                    kind=kind,
                    published=published,
                    status=status,
                    source_file=source_file,
                    unsupported_reason=reason if isinstance(reason, str) else None,
                )
            )
    return parsed


def published_target_ids(*, family: str) -> list[str]:
    return sorted({target.target for target in artifact_targets(family=family, published_only=True)})


def published_android_maven_targets(product: str) -> list[ExtensionArtifactTarget]:
    return sorted(
        (
            target
            for target in artifact_targets(product=product, family="native", published_only=True)
            if target.kind == "native-static-registry" and target.target.startswith("android-")
        ),
        key=lambda target: target.target,
    )
