#!/usr/bin/env python3
"""Ensure release-please version bumps cover Moon-selected release products."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from typing import NoReturn

import product_metadata
import release_plan


ROOT = product_metadata.ROOT
MANIFEST = ".release-please-manifest.json"


def fail(message: str) -> NoReturn:
    print(f"check_release_pr_coverage.py: {message}", file=sys.stderr)
    raise SystemExit(1)


def git(args: list[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=check,
    )


def git_stdout(args: list[str]) -> str:
    return git(args).stdout


def ref_exists(ref: str) -> bool:
    return git(["rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}"], check=False).returncode == 0


def base_ref() -> str | None:
    base_branch = os.environ.get("GITHUB_BASE_REF")
    candidates: list[str] = []
    if base_branch:
        candidates.extend([f"origin/{base_branch}", base_branch])
    candidates.extend(["origin/main", "main"])
    for candidate in candidates:
        if ref_exists(candidate):
            return candidate
    return None


def manifest_at(ref: str) -> dict[str, str]:
    if git(["cat-file", "-e", f"{ref}:{MANIFEST}"], check=False).returncode != 0:
        return {}
    try:
        raw = git_stdout(["show", f"{ref}:{MANIFEST}"])
    except subprocess.CalledProcessError as error:
        fail(f"failed to read {MANIFEST} at {ref}: {error.stderr.strip()}")
    value = json.loads(raw)
    if not isinstance(value, dict) or not all(
        isinstance(key, str) and isinstance(item, str) for key, item in value.items()
    ):
        fail(f"{MANIFEST} at {ref} must be a JSON string object")
    return value


def current_manifest() -> dict[str, str]:
    value = json.loads((ROOT / MANIFEST).read_text(encoding="utf-8"))
    if not isinstance(value, dict) or not all(
        isinstance(key, str) and isinstance(item, str) for key, item in value.items()
    ):
        fail(f"{MANIFEST} must be a JSON string object")
    return value


def changed_files(ref: str) -> list[str]:
    return release_plan.normalize_files(
        release_plan.changed_files_from_refs(ref, "HEAD")
    )


def main() -> int:
    ref = base_ref()
    if ref is None:
        fail("could not resolve base ref for release PR coverage check")
    files = changed_files(ref)
    if MANIFEST not in files:
        print("release PR coverage check skipped; release-please manifest is unchanged")
        return 0

    before_manifest = manifest_at(ref)
    after_manifest = current_manifest()
    graph = release_plan.load_graph()
    products = graph["products"]

    versioned_products = {
        product
        for product in product_metadata.product_ids(graph)
        if before_manifest.get(product_metadata.package_path(product)) != after_manifest.get(
            product_metadata.package_path(product)
        )
    }
    plan = release_plan.build_plan(graph, files)
    selected_products = set(plan.get("releaseProducts", []))
    missing = sorted(selected_products - versioned_products)
    if missing:
        fail(
            "release-please did not version every Moon-selected release product. "
            "Moon remains the dependency authority, but release-please must own "
            "the corresponding versions/tags. Missing product version bumps: "
            + ", ".join(missing)
        )
    unknown_versioned = sorted(versioned_products - set(products))
    if unknown_versioned:
        fail(f"{MANIFEST} changed unknown products: {', '.join(unknown_versioned)}")
    print("release PR product coverage checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
