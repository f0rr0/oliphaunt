#!/usr/bin/env python3
"""Release artifact target metadata from legacy graph and product-local files."""

from __future__ import annotations

import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import product_metadata

ROOT = Path(__file__).resolve().parents[2]

PRODUCT_LOCAL_TARGET_DIRS = (
    ROOT / "src/runtimes/liboliphaunt/native/targets",
    ROOT / "src/runtimes/liboliphaunt/wasix/targets",
    ROOT / "src/runtimes/broker/targets",
    ROOT / "src/runtimes/node-direct/targets",
)


@dataclass(frozen=True)
class ArtifactTarget:
    id: str
    product: str
    kind: str
    target: str
    asset: str
    published: bool
    surfaces: tuple[str, ...]
    triple: str | None = None
    runner: str | None = None
    library_relative_path: str | None = None
    executable_relative_path: str | None = None
    npm_package: str | None = None
    llvm_url: str | None = None
    extension_artifacts: bool = True

    def asset_name(self, version: str) -> str:
        return self.asset.format(version=version)


def _string(value: object, key: str, target_id: str, required: bool = True) -> str | None:
    if isinstance(value, str) and value:
        return value
    if required:
        product_metadata.fail(f"artifact target {target_id}.{key} must be a non-empty string")
    if value is not None:
        product_metadata.fail(f"artifact target {target_id}.{key} must be a string")
    return None


def _surfaces(value: object, target_id: str) -> tuple[str, ...]:
    if not isinstance(value, list) or not value or not all(isinstance(item, str) and item for item in value):
        product_metadata.fail(f"artifact target {target_id}.surfaces must be a non-empty string list")
    return tuple(value)


def _published(value: object, target_id: str) -> bool:
    if isinstance(value, bool):
        return value
    product_metadata.fail(f"artifact target {target_id}.published must be true or false")


def _optional_bool(value: object, key: str, target_id: str, default: bool) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    product_metadata.fail(f"artifact target {target_id}.{key} must be true or false")


def _local_target_tables() -> list[dict]:
    tables: list[dict] = []
    for directory in PRODUCT_LOCAL_TARGET_DIRS:
        if not directory.exists():
            continue
        for path in sorted(directory.glob("*.toml")):
            data = tomllib.loads(path.read_text(encoding="utf-8"))
            if not isinstance(data, dict):
                product_metadata.fail(f"{path.relative_to(ROOT)} must contain one target table")
            table = dict(data)
            table["_source_file"] = str(path.relative_to(ROOT))
            tables.append(table)
    return tables


def raw_artifact_target_tables(graph: dict | None = None) -> list[dict]:
    """Return artifact target tables from product-local metadata."""

    data = graph if graph is not None else product_metadata.load_graph()
    graph_targets = data.get("artifact_targets", [])
    if not isinstance(graph_targets, list):
        product_metadata.fail("compatibility artifact_targets must be an array of tables")
    tables: list[dict] = []
    for raw in graph_targets:
        if not isinstance(raw, dict):
            product_metadata.fail("compatibility artifact_targets entries must be tables")
        table = dict(raw)
        table.setdefault("_source_file", "product metadata compatibility graph")
        tables.append(table)
    tables.extend(_local_target_tables())
    return tables


def artifact_targets(
    graph: dict | None = None,
    *,
    product: str | None = None,
    kind: str | None = None,
    surface: str | None = None,
    published_only: bool = False,
) -> list[ArtifactTarget]:
    data = graph if graph is not None else product_metadata.load_graph()
    raw_targets = raw_artifact_target_tables(data)

    products = product_metadata.graph_products(data)
    parsed: list[ArtifactTarget] = []
    seen: set[str] = set()
    for raw in raw_targets:
        target_id = _string(raw.get("id"), "id", "<unknown>")
        assert target_id is not None
        if target_id in seen:
            source_file = raw.get("_source_file", "unknown source")
            product_metadata.fail(f"duplicate artifact target id {target_id} in {source_file}")
        seen.add(target_id)

        target_product = _string(raw.get("product"), "product", target_id)
        assert target_product is not None
        if target_product not in products:
            product_metadata.fail(f"artifact target {target_id} references unknown product {target_product}")

        parsed_target = ArtifactTarget(
            id=target_id,
            product=target_product,
            kind=_string(raw.get("kind"), "kind", target_id) or "",
            target=_string(raw.get("target"), "target", target_id) or "",
            asset=_string(raw.get("asset"), "asset", target_id) or "",
            published=_published(raw.get("published"), target_id),
            surfaces=_surfaces(raw.get("surfaces"), target_id),
            triple=_string(raw.get("triple"), "triple", target_id, required=False),
            runner=_string(raw.get("runner"), "runner", target_id, required=False),
            library_relative_path=_string(raw.get("library_relative_path"), "library_relative_path", target_id, required=False),
            executable_relative_path=_string(raw.get("executable_relative_path"), "executable_relative_path", target_id, required=False),
            npm_package=_string(raw.get("npm_package"), "npm_package", target_id, required=False),
            llvm_url=_string(raw.get("llvm_url"), "llvm_url", target_id, required=False),
            extension_artifacts=_optional_bool(raw.get("extension_artifacts"), "extension_artifacts", target_id, True),
        )
        if product is not None and parsed_target.product != product:
            continue
        if kind is not None and parsed_target.kind != kind:
            continue
        if surface is not None and surface not in parsed_target.surfaces:
            continue
        if published_only and not parsed_target.published:
            continue
        parsed.append(parsed_target)

    return parsed


def expected_assets(
    product: str,
    version: str,
    *,
    surface: str = "github-release",
    published_only: bool = True,
    kinds: Iterable[str] | None = None,
) -> list[str]:
    allowed_kinds = set(kinds) if kinds is not None else None
    assets = [
        target.asset_name(version)
        for target in artifact_targets(
            product=product,
            surface=surface,
            published_only=published_only,
        )
        if allowed_kinds is None or target.kind in allowed_kinds
    ]
    if not assets:
        product_metadata.fail(f"{product} has no artifact targets for surface {surface}")
    return sorted(assets)
