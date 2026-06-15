from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import os
import pathlib
import subprocess
import sys
from collections import deque
from typing import Iterable

import product_metadata


ROOT = pathlib.Path(__file__).resolve().parents[2]
EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
GENERATED_PATH_PARTS = {
    ".build",
    ".cxx",
    ".expo",
    ".gradle",
    ".kotlin",
    ".moon",
    ".next",
    ".source",
    "DerivedData",
    "Pods",
    "__pycache__",
    "dist",
    "lib",
    "node_modules",
    "out",
    "target",
}
RELEASE_DEPENDENCY_SCOPES = {"production", "peer"}


def fail(message: str) -> None:
    raise SystemExit(message)


def load_graph() -> dict:
    graph = product_metadata.load_graph()
    graph["moon_projects"] = moon_projects_by_id()
    return graph


def moon_bin() -> str:
    if configured := os.environ.get("MOON_BIN"):
        return configured
    proto_moon = pathlib.Path.home() / ".proto" / "bin" / "moon"
    return str(proto_moon) if proto_moon.exists() else "moon"


def run_git(args: list[str]) -> str:
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True)


def run_moon(args: list[str]) -> dict:
    output = subprocess.check_output([moon_bin(), *args], cwd=ROOT, text=True)
    return json.loads(output)


def moon_projects_by_id() -> dict[str, dict]:
    data = run_moon(["query", "projects"])
    projects = data.get("projects")
    if not isinstance(projects, list):
        fail("moon query projects did not return a projects array")

    parsed: dict[str, dict] = {}
    for project in projects:
        if not isinstance(project, dict) or not isinstance(project.get("id"), str):
            continue
        config = project.get("config") if isinstance(project.get("config"), dict) else {}
        raw_deps = project.get("dependencies") or config.get("dependsOn") or []
        dependencies: dict[str, str] = {}
        if isinstance(raw_deps, list):
            for dependency in raw_deps:
                if isinstance(dependency, str):
                    dependencies[dependency] = "production"
                elif isinstance(dependency, dict) and isinstance(dependency.get("id"), str):
                    dependencies[dependency["id"]] = str(dependency.get("scope") or "production")
        parsed[project["id"]] = {
            "id": project["id"],
            "source": project.get("source") or config.get("source") or "",
            "dependsOn": sorted(dependencies),
            "dependencyScopes": dict(sorted(dependencies.items())),
            "tags": sorted(config.get("tags") or []),
            "project": config.get("project") if isinstance(config.get("project"), dict) else {},
        }
    return parsed


def tag_match_pattern(prefix: str) -> str:
    return f"{prefix}[0-9]*" if prefix else "[0-9]*"


def tag_prefixes(product_config: dict) -> list[str]:
    prefix = product_config.get("tag_prefix")
    if not isinstance(prefix, str) or not prefix:
        fail("release metadata product entries must declare tag_prefix")
    legacy_prefixes = product_config.get("legacy_tag_prefixes", [])
    if not isinstance(legacy_prefixes, list) or not all(
        isinstance(item, str) for item in legacy_prefixes
    ):
        fail("release metadata legacy_tag_prefixes must be a string list when present")
    return [prefix, *legacy_prefixes]


def latest_tag_for_prefix(prefix: str, head_ref: str) -> str:
    result = subprocess.run(
        [
            "git",
            "describe",
            "--tags",
            "--abbrev=0",
            "--match",
            tag_match_pattern(prefix),
            head_ref,
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode == 0:
        return result.stdout.strip()
    return ""


def latest_product_tag(product_config: dict, head_ref: str) -> str:
    for prefix in tag_prefixes(product_config):
        if tag := latest_tag_for_prefix(prefix, head_ref):
            return tag
    return EMPTY_TREE


def commit_for_ref(ref: str) -> str:
    return run_git(["rev-parse", f"{ref}^{{commit}}"]).strip()


def changed_files_from_refs(base_ref: str, head_ref: str) -> list[str]:
    try:
        if base_ref == EMPTY_TREE:
            output = run_git(["diff", "--name-only", base_ref, head_ref, "--"])
        else:
            output = run_git(["diff", "--name-only", f"{base_ref}...{head_ref}", "--"])
    except subprocess.CalledProcessError as error:
        fail(f"failed to read changed files between {base_ref} and {head_ref}: {error}")
    return sorted(line for line in output.splitlines() if line)


def normalize_files(files: Iterable[str]) -> list[str]:
    normalized: set[str] = set()
    for file in files:
        path = file.strip().replace("\\", "/")
        if path.startswith("./"):
            path = path[2:]
        if path and not is_generated_local_state(path):
            normalized.add(path)
    return sorted(normalized)


def is_generated_local_state(path: str) -> bool:
    if path.startswith("target/"):
        return True
    return any(part in GENERATED_PATH_PARTS for part in pathlib.Path(path).parts)


def split_patterns(patterns: Iterable[str]) -> tuple[list[str], list[str]]:
    includes: list[str] = []
    excludes: list[str] = []
    for pattern in patterns:
        if pattern.startswith("!"):
            excludes.append(pattern[1:])
        else:
            includes.append(pattern)
    return includes, excludes


def matches_pattern(path: str, pattern: str) -> bool:
    return fnmatch.fnmatchcase(path, pattern)


def matches_any(path: str, patterns: Iterable[str]) -> bool:
    return any(matches_pattern(path, pattern) for pattern in patterns)


def product_matches(path: str, patterns: Iterable[str]) -> bool:
    includes, excludes = split_patterns(patterns)
    return matches_any(path, includes) and not matches_any(path, excludes)


def owner_project_for_path(projects: dict[str, dict], path: str) -> str | None:
    # Moon 2.3 exposes project sources/dependencies as JSON, but does not expose
    # a non-executing stdin changed-file affectedness query. Release planning
    # keeps this as a pure adapter over `moon query projects`; no hand-authored
    # source globs or dependency graph are allowed here.
    if is_generated_local_state(path):
        return None
    matches = [
        project
        for project in projects.values()
        if project["source"] == "."
        or path == project["source"]
        or path.startswith(f"{project['source']}/")
    ]
    matches.sort(key=lambda project: len(project["source"]), reverse=True)
    return matches[0]["id"] if matches else None


def dependents_by_project(projects: dict[str, dict], *, release_only: bool = False) -> dict[str, set[str]]:
    dependents: dict[str, set[str]] = {project: set() for project in projects}
    for project, config in projects.items():
        scopes = config.get("dependencyScopes", {})
        for dependency in config.get("dependsOn", []):
            if release_only and scopes.get(dependency, "production") not in RELEASE_DEPENDENCY_SCOPES:
                continue
            dependents.setdefault(dependency, set()).add(project)
    return dependents


def downstream_projects(
    projects: dict[str, dict],
    direct: Iterable[str],
    *,
    release_only: bool = False,
) -> set[str]:
    dependents = dependents_by_project(projects, release_only=release_only)
    selected: set[str] = set(direct)
    queue: deque[str] = deque(sorted(selected))
    while queue:
        current = queue.popleft()
        for downstream in sorted(dependents.get(current, set())):
            if downstream not in selected:
                selected.add(downstream)
                queue.append(downstream)
    return selected


def release_product_project_id(product: str, products: dict[str, dict], projects: dict[str, dict]) -> str:
    if product in projects:
        return product
    package_path = products[product].get("path")
    if not isinstance(package_path, str) or not package_path:
        fail(f"release product {product} is missing package path metadata")
    matches = [
        project
        for project in projects.values()
        if package_path == project["source"] or package_path.startswith(f"{project['source']}/")
    ]
    matches.sort(key=lambda project: len(project["source"]), reverse=True)
    if not matches:
        fail(f"release product {product} has no owning Moon project for {package_path}")
    return matches[0]["id"]


def release_products_for_projects(
    products: dict[str, dict],
    projects: dict[str, dict],
    project_ids: Iterable[str],
) -> set[str]:
    selected_projects = set(project_ids)
    selected: set[str] = set()
    for product in products:
        project_id = release_product_project_id(product, products, projects)
        if project_id in selected_projects:
            selected.add(product)
    return selected


def release_order(products: dict[str, dict], projects: dict[str, dict], selected: Iterable[str]) -> list[str]:
    selected_set = set(selected)
    product_project = {
        product: release_product_project_id(product, products, projects)
        for product in products
    }
    ordered: list[str] = []
    remaining = set(selected_set)
    while remaining:
        ready: list[str] = []
        for product in sorted(remaining):
            project_id = product_project[product]
            project_config = projects.get(project_id, {})
            scopes = project_config.get("dependencyScopes", {})
            deps = {
                dependency
                for dependency in project_config.get("dependsOn", [])
                if scopes.get(dependency, "production") in RELEASE_DEPENDENCY_SCOPES
            }
            selected_deps = {
                candidate
                for candidate, candidate_project in product_project.items()
                if candidate in selected_set and candidate_project in deps
            }
            if selected_deps <= set(ordered):
                ready.append(product)
        if not ready:
            fail(f"Moon release product graph has a dependency cycle: {sorted(remaining)}")
        ordered.extend(ready)
        remaining.difference_update(ready)
    return ordered


def docs_only_change(files: Iterable[str]) -> bool:
    normalized = list(files)
    return bool(normalized) and all(
        file.startswith("docs/")
        or file.startswith("src/docs/")
        or file in {"README.md"}
        for file in normalized
    )


def build_plan(graph: dict, files: list[str]) -> dict:
    products = graph.get("products")
    if not isinstance(products, dict):
        fail("release metadata must define [products.<id>] entries")
    projects = graph.get("moon_projects")
    if not isinstance(projects, dict):
        fail("Moon project graph is missing from release plan metadata")

    direct_projects = {
        project
        for file in files
        if (project := owner_project_for_path(projects, file)) is not None
    }
    affected_projects = downstream_projects(projects, direct_projects)
    release_projects = downstream_projects(projects, direct_projects, release_only=True)
    release_product_set = release_products_for_projects(products, projects, release_projects)
    release_products = release_order(products, projects, release_product_set)
    release_product_projects = {
        release_product_project_id(product, products, projects)
        for product in release_products
    }
    direct = release_order(
        products,
        projects,
        release_products_for_projects(products, projects, direct_projects),
    )
    return finalize_plan({
        "changedFiles": files,
        "directProducts": direct,
        "releaseProducts": release_products,
        "directMoonProjects": sorted(direct_projects),
        "affectedMoonProjects": sorted(affected_projects),
        "releaseMoonProjects": sorted(release_product_projects),
        "productIds": list(products),
        "hasReleaseChanges": bool(release_products),
        "docsOnly": not release_products and docs_only_change(files),
        "versioning": graph.get("policy", {}).get("versioning", "independent"),
        "extensionSelection": "exact-sql-extension",
    })


def build_plan_from_product_tags(
    graph: dict,
    head_ref: str,
    include_current_tags: bool = False,
) -> dict:
    products = graph.get("products")
    if not isinstance(products, dict):
        fail("release metadata must define [products.<id>] entries")

    direct: set[str] = set()
    changed: set[str] = set()
    product_base_refs: dict[str, str] = {}
    current_tagged_products: set[str] = set()
    head_commit = commit_for_ref(head_ref) if include_current_tags else ""

    for product, config in products.items():
        base_ref = latest_product_tag(config, head_ref)
        product_base_refs[product] = base_ref
        if include_current_tags and base_ref != EMPTY_TREE:
            tag_commit = commit_for_ref(base_ref)
            if tag_commit == head_commit:
                direct.add(product)
                current_tagged_products.add(product)
                continue
        product_files = changed_files_from_refs(base_ref, head_ref)
        changed.update(product_files)
        product_plan = build_plan(graph, normalize_files(product_files))
        if product in product_plan.get("releaseProducts", []):
            direct.add(product)

    projects = graph.get("moon_projects")
    if not isinstance(projects, dict):
        fail("Moon project graph is missing from release plan metadata")
    direct_projects = {
        release_product_project_id(product, products, projects)
        for product in direct
    }
    affected_projects = downstream_projects(projects, direct_projects)
    release_projects = downstream_projects(projects, direct_projects, release_only=True)
    release_products = release_order(
        products,
        projects,
        release_products_for_projects(products, projects, release_projects),
    )
    return finalize_plan({
        "changedFiles": sorted(changed),
        "directProducts": release_order(products, projects, direct),
        "releaseProducts": release_products,
        "directMoonProjects": sorted(direct_projects),
        "affectedMoonProjects": sorted(affected_projects),
        "releaseMoonProjects": sorted(release_projects),
        "productIds": list(products),
        "hasReleaseChanges": bool(release_products),
        "docsOnly": not release_products and docs_only_change(changed),
        "versioning": graph.get("policy", {}).get("versioning", "independent"),
        "extensionSelection": "exact-sql-extension",
        "productBaseRefs": product_base_refs,
        "currentTaggedProducts": sorted(current_tagged_products),
    })


def release_products_slug(products: list[str]) -> str:
    if not products:
        return "none"
    short_names = {
        "liboliphaunt-native": "native",
    }
    return "-".join(short_names.get(product, product.replace("oliphaunt-", "")) for product in products)


def finalize_plan(plan: dict) -> dict:
    hash_input = {
        "changedFiles": plan.get("changedFiles", []),
        "directProducts": plan.get("directProducts", []),
        "releaseProducts": plan.get("releaseProducts", []),
        "productBaseRefs": plan.get("productBaseRefs", {}),
        "currentTaggedProducts": plan.get("currentTaggedProducts", []),
    }
    digest = hashlib.sha256(
        json.dumps(hash_input, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()[:12]
    plan["planHash"] = digest
    plan["releaseBranch"] = f"release/{release_products_slug(plan.get('releaseProducts', []))}-{digest}"
    return plan


def print_github_output(plan: dict) -> None:
    products = plan["releaseProducts"]
    extension_products = sorted(product for product in products if product.startswith("oliphaunt-extension-"))
    print(f"has_release_changes={str(plan['hasReleaseChanges']).lower()}")
    print(f"has_extension_products={str(bool(extension_products)).lower()}")
    print(f"docs_only={str(plan['docsOnly']).lower()}")
    print(f"products_csv={','.join(products)}")
    print(f"products_json={json.dumps(products, separators=(',', ':'))}")
    print(f"extension_products_json={json.dumps(extension_products, separators=(',', ':'))}")
    print(f"plan_hash={plan['planHash']}")
    print(f"release_branch={plan['releaseBranch']}")
    for product in plan.get("productIds", []):
        key = "product_" + product.replace("-", "_")
        print(f"{key}={str(product in products).lower()}")
    print(
        "direct_products_json="
        f"{json.dumps(plan['directProducts'], separators=(',', ':'))}"
    )
    print(
        "product_base_refs_json="
        f"{json.dumps(plan.get('productBaseRefs', {}), separators=(',', ':'))}"
    )


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Plan independent Oliphaunt product releases from changed files."
    )
    parser.add_argument("--base-ref", help="base git ref for diff planning")
    parser.add_argument("--head-ref", default="HEAD", help="head git ref for diff planning")
    parser.add_argument(
        "--from-product-tags",
        action="store_true",
        help="plan from each product's latest tag instead of one shared base ref",
    )
    parser.add_argument(
        "--include-current-tags",
        action="store_true",
        help="with --from-product-tags, keep products selected when their latest tag already points at HEAD",
    )
    parser.add_argument(
        "--changed-file",
        action="append",
        default=[],
        help="explicit changed file; may be passed more than once",
    )
    parser.add_argument(
        "--format",
        choices=["text", "json", "github-output"],
        default="text",
        help="output format",
    )
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    if args.changed_file:
        files = normalize_files(args.changed_file)
        graph = load_graph()
        plan = build_plan(graph, files)
    elif args.from_product_tags:
        graph = load_graph()
        plan = build_plan_from_product_tags(
            graph,
            args.head_ref,
            include_current_tags=args.include_current_tags,
        )
    elif args.base_ref:
        files = changed_files_from_refs(args.base_ref, args.head_ref)
        graph = load_graph()
        plan = build_plan(graph, files)
    else:
        files = []
        graph = load_graph()
        plan = build_plan(graph, files)

    if args.format == "json":
        print(json.dumps(plan, indent=2, sort_keys=True))
    elif args.format == "github-output":
        print_github_output(plan)
    else:
        changed_files = plan.get("changedFiles", [])
        if not changed_files:
            print("No changed files were provided; no product release is planned.")
        elif plan["hasReleaseChanges"]:
            print("Release products: " + ", ".join(plan["releaseProducts"]))
            print("Direct products: " + ", ".join(plan["directProducts"]))
        else:
            print("No product release is planned for these changes.")
    return 0
