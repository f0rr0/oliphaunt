#!/usr/bin/env python3
"""Validate selected product versions are publishable from current tags."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import NoReturn

import product_metadata
import release_plan


ROOT = Path(__file__).resolve().parents[2]
REGISTRY_TARGETS = {
    "crates-io",
    "npm",
    "jsr",
    "maven-central",
}


def fail(message: str) -> NoReturn:
    print(f"check_release_versions.py: {message}", file=sys.stderr)
    raise SystemExit(1)


def load_graph() -> dict:
    return release_plan.load_graph()


def parse_products(raw: str | None, graph: dict) -> list[str]:
    products = graph.get("products")
    if not isinstance(products, dict):
        fail("release metadata must define [products.<id>] entries")
    if raw is None:
        return sorted(products)
    value = json.loads(raw)
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        fail("--products-json must be a JSON string list")
    unknown = sorted(set(value) - set(products))
    if unknown:
        fail(f"unknown release products: {', '.join(unknown)}")
    return value


def parse_stable_version(version: str) -> tuple[int, int, int]:
    match = re.fullmatch(r"([0-9]+)[.]([0-9]+)[.]([0-9]+)", version)
    if not match:
        fail(f"release version must be stable x.y.z for automated publish, got {version!r}")
    return tuple(int(part) for part in match.groups())


def git_output(args: list[str]) -> str:
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True).strip()


def registry_command(args: list[str]) -> list[str]:
    return [
        "tools/dev/bun.sh",
        "tools/release/check_registry_publication.mjs",
        *args,
    ]


def registry_run(args: list[str]) -> None:
    result = subprocess.run(registry_command(args), cwd=ROOT, check=False)
    if result.returncode != 0:
        raise SystemExit(result.returncode)


def registry_json(args: list[str]) -> dict:
    output = subprocess.check_output(registry_command(args), cwd=ROOT, text=True)
    value = json.loads(output)
    if not isinstance(value, dict):
        fail("registry publication helper did not return a JSON object")
    return value


def registry_assert_product_publication(
    product: str,
    *,
    require_published: bool,
    version_override: str | None = None,
) -> None:
    args = [
        "--product",
        product,
        "--require-published" if require_published else "--require-unpublished",
    ]
    if version_override is not None:
        args.extend(["--version", version_override])
    registry_run(args)


def registry_report_product_publication(product: str) -> None:
    registry_run(["--product", product, "--report"])


def registry_query_product_publication(product: str) -> tuple[list[dict], list[dict], list[dict]]:
    data = registry_json(["query-product-publication", "--product", product])
    packages = data.get("packages")
    missing = data.get("missing")
    published = data.get("published")
    if not isinstance(packages, list) or not isinstance(missing, list) or not isinstance(published, list):
        fail("registry publication helper returned malformed publication status")
    return packages, missing, published


def verify_github_release_assets(product: str, version: str) -> None:
    result = subprocess.run(
        [
            "tools/dev/bun.sh",
            "tools/release/check_github_release_assets.mjs",
            product,
            "--version",
            version,
            "--default-assets",
        ],
        cwd=ROOT,
        check=False,
    )
    if result.returncode != 0:
        raise SystemExit(result.returncode)


def tag_match_pattern(prefix: str) -> str:
    return f"{prefix}[0-9]*" if prefix else "[0-9]*"


def tag_prefixes(config: dict) -> list[str]:
    prefix = config.get("tag_prefix")
    if not isinstance(prefix, str) or not prefix:
        fail("release products must declare tag_prefix")
    legacy_prefixes = config.get("legacy_tag_prefixes", [])
    if not isinstance(legacy_prefixes, list) or not all(
        isinstance(item, str) for item in legacy_prefixes
    ):
        fail("legacy_tag_prefixes must be a string list when present")
    return [prefix, *legacy_prefixes]


def product_tags(prefix: str) -> list[str]:
    output = subprocess.check_output(
        ["git", "tag", "--list", tag_match_pattern(prefix)],
        cwd=ROOT,
        text=True,
    )
    return [line.strip() for line in output.splitlines() if line.strip()]


def tag_version(prefix: str, tag: str) -> tuple[int, int, int] | None:
    if not tag.startswith(prefix):
        return None
    version = tag[len(prefix) :]
    if not re.fullmatch(r"[0-9]+[.][0-9]+[.][0-9]+", version):
        return None
    return parse_stable_version(version)


def tag_commit(tag: str) -> str:
    return git_output(["rev-list", "-n", "1", tag])


def tag_exists(tag: str) -> bool:
    result = subprocess.run(
        ["git", "rev-parse", "--verify", "--quiet", f"refs/tags/{tag}^{{commit}}"],
        cwd=ROOT,
        check=False,
        text=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return result.returncode == 0


def commit_for_ref(ref: str) -> str:
    return git_output(["rev-parse", f"{ref}^{{commit}}"])


def read_text(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def react_native_compatibility_versions() -> tuple[str, str]:
    package = json.loads(read_text("src/sdks/react-native/package.json"))
    metadata = package.get("oliphaunt")
    if not isinstance(metadata, dict):
        fail("React Native package.json must declare oliphaunt compatibility metadata")
    swift_version = metadata.get("swiftSdkVersion")
    kotlin_version = metadata.get("kotlinSdkVersion")
    if not isinstance(swift_version, str) or not isinstance(kotlin_version, str):
        fail("React Native compatibility metadata must include Swift and Kotlin SDK versions")
    return swift_version, kotlin_version


def typescript_compatibility_versions() -> tuple[str, str, str]:
    package = json.loads(read_text("src/sdks/js/package.json"))
    metadata = package.get("oliphaunt")
    if not isinstance(metadata, dict):
        fail("TypeScript package.json must declare oliphaunt compatibility metadata")
    liboliphaunt_version = metadata.get("liboliphauntVersion")
    broker_version = metadata.get("brokerVersion")
    node_direct_version = metadata.get("nodeDirectAddonVersion")
    if (
        not isinstance(liboliphaunt_version, str)
        or not isinstance(broker_version, str)
        or not isinstance(node_direct_version, str)
    ):
        fail("TypeScript compatibility metadata must include liboliphaunt, broker, and Node direct versions")
    return liboliphaunt_version, broker_version, node_direct_version


def dependency_version_for(consumer: str, dependency: str) -> str:
    if consumer == "oliphaunt-swift" and dependency == "liboliphaunt-native":
        return read_text("src/sdks/swift/LIBOLIPHAUNT_VERSION").strip()
    if consumer == "oliphaunt-react-native" and dependency == "oliphaunt-swift":
        swift_version, _ = react_native_compatibility_versions()
        return swift_version
    if consumer == "oliphaunt-react-native" and dependency == "oliphaunt-kotlin":
        _, kotlin_version = react_native_compatibility_versions()
        return kotlin_version
    if consumer == "oliphaunt-js" and dependency == "liboliphaunt-native":
        liboliphaunt_version, _, _ = typescript_compatibility_versions()
        return liboliphaunt_version
    if consumer == "oliphaunt-js" and dependency == "oliphaunt-broker":
        _, broker_version, _ = typescript_compatibility_versions()
        return broker_version
    if consumer == "oliphaunt-js" and dependency == "oliphaunt-node-direct":
        _, _, node_direct_version = typescript_compatibility_versions()
        return node_direct_version
    return product_metadata.read_current_version(dependency)


def validate_product(product: str, config: dict, head_ref: str) -> bool:
    prefix = config.get("tag_prefix")
    if not isinstance(prefix, str) or not prefix:
        fail(f"{product} must declare tag_prefix")
    version = product_metadata.read_current_version(product)
    current = parse_stable_version(version)
    current_tag = f"{prefix}{version}"
    head_commit = commit_for_ref(head_ref)
    tags = product_tags(prefix)
    if current_tag in tags:
        current_tag_commit = tag_commit(current_tag)
        if current_tag_commit != head_commit:
            fail(
                f"{product} version {version} is already tagged as {current_tag} "
                f"at {current_tag_commit}, not release commit {head_commit}; "
                "merge the release-please release PR before publishing"
            )
        return True
    previous_versions = [
        parsed
        for candidate_prefix in tag_prefixes(config)
        for tag in product_tags(candidate_prefix)
        if (parsed := tag_version(candidate_prefix, tag)) is not None
    ]
    if previous_versions and current <= max(previous_versions):
        latest = ".".join(str(part) for part in max(previous_versions))
        fail(
            f"{product} version {version} is not newer than latest tagged version {latest}; "
            "merge the release-please release PR before publishing"
        )
    return False


def validate_registry_publication(
    products: list[str],
    graph: dict,
    current_tag_at_head: dict[str, bool],
    head_ref: str,
) -> None:
    graph_products = graph.get("products")
    if not isinstance(graph_products, dict):
        fail("release metadata must define [products.<id>] entries")
    head_commit = commit_for_ref(head_ref)
    for product in products:
        config = graph_products[product]
        targets = config.get("publish_targets", [])
        if not isinstance(targets, list) or not all(isinstance(item, str) for item in targets):
            fail(f"{product}.publish_targets must be a string list")
        registry_targets = set(targets) & REGISTRY_TARGETS
        if not registry_targets:
            continue
        if current_tag_at_head.get(product, False):
            if "crates-io" in registry_targets:
                registry_assert_product_publication(
                    product,
                    require_published=True,
                )
            else:
                registry_report_product_publication(product)
            continue
        packages, _, published = registry_query_product_publication(product)
        if not packages:
            print(f"{product} has no external registry packages to check")
            continue
        if published:
            prefix = config.get("tag_prefix")
            if not isinstance(prefix, str) or not prefix:
                fail(f"{product} must declare tag_prefix")
            version = product_metadata.read_current_version(product)
            current_tag = f"{prefix}{version}"
            fail(
                f"{product} version {version} is already published in public registries: "
                + ", ".join(str(package["label"]) for package in published)
                + f"; the matching product tag {current_tag} is missing or does not "
                f"point at release commit {head_commit}. If this was an intentional "
                "first package identity bootstrap, create and push that product tag at "
                "the same release commit, then rerun the release workflow as a completion "
                "run. Otherwise merge the release-please release PR before publishing."
            )
        print(
            f"{product} registry unpublished check passed: "
            + ", ".join(str(package["label"]) for package in packages)
        )


def validate_dependency_tag(
    consumer: str,
    dependency: str,
    dependency_version: str,
    graph: dict,
    selected: set[str],
) -> None:
    parse_stable_version(dependency_version)
    if dependency in selected:
        return
    dependency_config = graph["products"].get(dependency)
    if not isinstance(dependency_config, dict):
        fail(f"{consumer} declares unknown release dependency {dependency}")
    prefix = dependency_config.get("tag_prefix")
    if not isinstance(prefix, str) or not prefix:
        fail(f"{dependency} must declare tag_prefix")
    tag = f"{prefix}{dependency_version}"
    if not tag_exists(tag):
        fail(
            f"{consumer} depends on {dependency} {dependency_version}, but release tag "
            f"{tag} does not exist and {dependency} is not selected for this release"
        )
    validate_released_dependency_artifacts(consumer, dependency, dependency_version, graph)


def validate_released_dependency_artifacts(
    consumer: str,
    dependency: str,
    dependency_version: str,
    graph: dict,
) -> None:
    dependency_config = graph["products"].get(dependency)
    if not isinstance(dependency_config, dict):
        fail(f"{consumer} declares unknown release dependency {dependency}")
    targets = dependency_config.get("publish_targets", [])
    if not isinstance(targets, list) or not all(isinstance(item, str) for item in targets):
        fail(f"{dependency}.publish_targets must be a string list")
    registry_targets = set(targets) & REGISTRY_TARGETS
    if registry_targets:
        registry_assert_product_publication(
            dependency,
            require_published=True,
            version_override=dependency_version,
        )
    if "github-release-assets" in targets:
        verify_github_release_assets(dependency, dependency_version)


def validate_release_dependencies(products: list[str], graph: dict) -> None:
    selected = set(products)
    graph_products = graph.get("products")
    if not isinstance(graph_products, dict):
        fail("release metadata must define [products.<id>] entries")
    moon_projects = graph.get("moon_projects")
    if not isinstance(moon_projects, dict):
        fail("Moon project graph is missing from release metadata")
    product_project = {
        product: release_plan.release_product_project_id(product, graph_products, moon_projects)
        for product in graph_products
    }
    project_product = {project: product for product, project in product_project.items()}
    for product in products:
        config = graph_products.get(product)
        if not isinstance(config, dict):
            fail(f"selected product {product} is missing from release metadata")
        project = moon_projects.get(product_project[product], {})
        dependencies = [
            project_product[dependency]
            for dependency in project.get("dependsOn", [])
            if dependency in project_product
        ]
        for dependency in dependencies:
            validate_dependency_tag(
                product,
                dependency,
                dependency_version_for(product, dependency),
                graph,
                selected,
            )


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--products-json", help="JSON list of selected product ids")
    parser.add_argument(
        "--head-ref",
        default="HEAD",
        help="release commit ref; an existing current-version tag is allowed only if it points here",
    )
    parser.add_argument(
        "--check-registries",
        action="store_true",
        help="also validate selected product versions against external package registries",
    )
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    graph = load_graph()
    selected = parse_products(args.products_json, graph)
    current_tag_at_head: dict[str, bool] = {}
    for product in selected:
        current_tag_at_head[product] = validate_product(
            product,
            graph["products"][product],
            args.head_ref,
        )
    validate_release_dependencies(selected, graph)
    if args.check_registries:
        validate_registry_publication(selected, graph, current_tag_at_head, args.head_ref)
    print("release version checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
