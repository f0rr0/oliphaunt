#!/usr/bin/env python3
"""Exact-extension release artifact target metadata."""

from __future__ import annotations

import tomllib
from dataclasses import dataclass
from pathlib import Path

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
        if not path.is_file():
            product_metadata.fail(f"{product_id} must declare exact-extension artifact targets at {path.relative_to(ROOT)}")
        data = _read_toml(path)
        if data.get("schema") != SCHEMA:
            product_metadata.fail(f"{path.relative_to(ROOT)} must use schema = {SCHEMA!r}")
        rows = data.get("targets")
        if not isinstance(rows, list) or not rows:
            product_metadata.fail(f"{path.relative_to(ROOT)} must define [[targets]] rows")
        sql_name = _extension_sql_name(product_id)
        seen: set[tuple[str, str, str]] = set()
        for index, row in enumerate(rows):
            if not isinstance(row, dict):
                product_metadata.fail(f"{path.relative_to(ROOT)} targets[{index}] must be a table")
            target = _string(row.get("target"), f"{path.relative_to(ROOT)} targets[{index}].target")
            target_family = _string(row.get("family"), f"{path.relative_to(ROOT)} targets[{index}].family")
            kind = _string(row.get("kind"), f"{path.relative_to(ROOT)} targets[{index}].kind")
            status = _string(row.get("status"), f"{path.relative_to(ROOT)} targets[{index}].status")
            published = _bool(row.get("published"), f"{path.relative_to(ROOT)} targets[{index}].published")
            if target_family not in FAMILIES:
                product_metadata.fail(f"{path.relative_to(ROOT)} target {target} has invalid family {target_family!r}")
            if kind not in KINDS:
                product_metadata.fail(f"{path.relative_to(ROOT)} target {target} has invalid kind {kind!r}")
            if status not in STATUSES:
                product_metadata.fail(f"{path.relative_to(ROOT)} target {target} has invalid status {status!r}")
            if target_family == "wasix" and kind != "wasix-runtime":
                product_metadata.fail(f"{path.relative_to(ROOT)} target {target} must use kind wasix-runtime for wasix family")
            if target_family == "native" and kind == "wasix-runtime":
                product_metadata.fail(f"{path.relative_to(ROOT)} target {target} cannot use wasix-runtime for native family")
            reason = row.get("unsupported_reason")
            if published and status != "supported":
                product_metadata.fail(f"{path.relative_to(ROOT)} target {target} cannot be published with status {status}")
            if not published and (not isinstance(reason, str) or not reason):
                product_metadata.fail(f"{path.relative_to(ROOT)} unpublished target {target} must explain unsupported_reason")
            key = (target, target_family, kind)
            if key in seen:
                product_metadata.fail(f"{path.relative_to(ROOT)} has duplicate target row {key}")
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
                    source_file=path,
                    unsupported_reason=reason if isinstance(reason, str) else None,
                )
            )
    return parsed


def published_target_ids(*, family: str) -> list[str]:
    return sorted({target.target for target in artifact_targets(family=family, published_only=True)})
