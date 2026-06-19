#!/usr/bin/env python3
"""Fail fast when selected release products are missing publish credentials."""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import NoReturn

import product_metadata

OIDC_TARGETS = {"crates-io", "npm", "jsr"}
MAVEN_TARGETS = {"maven-central"}
GITHUB_TARGETS = {"github-release", "github-release-assets", "swift-package-source-tag"}
FORBIDDEN_ENV_VARS = {
    "CARGO_REGISTRY_TOKEN": (
        {"crates-io"},
        "Cargo publishing uses crates.io trusted publishing through GitHub Actions OIDC",
    ),
    "NPM_TOKEN": (
        {"npm"},
        "npm publishing uses trusted publishing with provenance through GitHub Actions OIDC",
    ),
    "NODE_AUTH_TOKEN": (
        {"npm"},
        "npm publishing uses trusted publishing with provenance through GitHub Actions OIDC",
    ),
    "JSR_TOKEN": ({"jsr"}, "JSR publishing uses GitHub Actions OIDC"),
    "COCOAPODS_TRUNK_TOKEN": (
        set(),
        "Apple SDK releases use SwiftPM plus GitHub assets, not CocoaPods trunk",
    ),
    "COCOAPODS_TRUNK_EMAIL": (
        set(),
        "Apple SDK releases use SwiftPM plus GitHub assets, not CocoaPods trunk",
    ),
}


def fail(message: str) -> NoReturn:
    print(f"check_publish_environment.py: {message}", file=sys.stderr)
    raise SystemExit(1)


def parse_products(raw: str) -> set[str]:
    value = json.loads(raw)
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        fail("--products-json must be a JSON string list")
    products = set(value)
    known = set(product_metadata.product_ids())
    unknown = sorted(products - known)
    if unknown:
        fail(f"unknown release products: {', '.join(unknown)}")
    return products


def require_env(name: str, context: str, failures: list[str]) -> None:
    if not os.environ.get(name):
        failures.append(f"{context} requires {name}")


def require_any_env(names: list[str], context: str, failures: list[str]) -> None:
    if not any(os.environ.get(name) for name in names):
        failures.append(f"{context} requires one of {', '.join(names)}")


def selected_publish_targets(products: set[str]) -> set[str]:
    targets: set[str] = set()
    graph = product_metadata.load_graph()
    for product in products:
        config = product_metadata.product_config(product, graph)
        targets.update(product_metadata.string_list(config, "publish_targets", product))
    return targets


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--products-json", required=True)
    args = parser.parse_args(argv)

    products = parse_products(args.products_json)
    publish_targets = selected_publish_targets(products)
    failures: list[str] = []

    for name, (blocked_targets, reason) in sorted(FORBIDDEN_ENV_VARS.items()):
        applies_to_selection = bool(products) and (
            not blocked_targets or bool(publish_targets & blocked_targets)
        )
        if applies_to_selection and os.environ.get(name):
            failures.append(f"forbidden release credential {name} is set: {reason}")

    if publish_targets & OIDC_TARGETS:
        require_env("ACTIONS_ID_TOKEN_REQUEST_TOKEN", "trusted publishing", failures)
        require_env("ACTIONS_ID_TOKEN_REQUEST_URL", "trusted publishing", failures)

    if publish_targets & GITHUB_TARGETS:
        require_any_env(["GH_TOKEN", "GITHUB_TOKEN"], "GitHub release assets and tags", failures)

    if publish_targets & MAVEN_TARGETS:
        for name in [
            "ORG_GRADLE_PROJECT_mavenCentralUsername",
            "ORG_GRADLE_PROJECT_mavenCentralPassword",
            "ORG_GRADLE_PROJECT_signingInMemoryKey",
            "ORG_GRADLE_PROJECT_signingInMemoryKeyId",
            "ORG_GRADLE_PROJECT_signingInMemoryKeyPassword",
        ]:
            require_env(name, "Maven Central publish", failures)

    if failures:
        fail("missing publish environment:\n  - " + "\n  - ".join(failures))

    print("publish environment checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
