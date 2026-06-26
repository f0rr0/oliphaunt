#!/usr/bin/env python3
"""Generate and explain Oliphaunt product/task/release metadata data."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tomllib
from collections import deque
from pathlib import Path
from typing import Any, NoReturn


ROOT = Path(__file__).resolve().parents[2]
GRAPH_ROOT = ROOT / "target" / "graph"
COVERAGE_BASELINE_PATH = ROOT / "coverage" / "baseline.toml"
SYNTHETIC_ROOT = ROOT / "tools" / "graph" / "synthetic"
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

sys.path.insert(0, str(ROOT / "tools" / "release"))
sys.path.insert(0, str(ROOT / "tools" / "graph"))
import release_plan  # noqa: E402
from ci_plan import CI_JOB_TARGETS, CI_JOBS_CONFIG, plan_jobs_for_affected  # noqa: E402


def fail(message: str) -> NoReturn:
    raise SystemExit(f"graph.py: {message}")


def moon_bin() -> str:
    if configured := os.environ.get("MOON_BIN"):
        return configured
    proto_moon = Path.home() / ".proto" / "bin" / "moon"
    return str(proto_moon) if proto_moon.exists() else "moon"


def rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def read_toml(path: Path) -> dict[str, Any]:
    if not path.is_file():
        fail(f"missing TOML input: {rel(path)}")
    with path.open("rb") as handle:
        return tomllib.load(handle)


def run_moon(args: list[str], *, stdin: str | None = None) -> dict[str, Any]:
    command = [moon_bin(), *args]
    env = dict(os.environ)
    output = subprocess.check_output(command, cwd=ROOT, env=env, text=True, input=stdin)
    return json.loads(output)


def affected_names(value: object) -> set[str]:
    if isinstance(value, dict):
        return {str(key) for key in value}
    if isinstance(value, list):
        result: set[str] = set()
        for item in value:
            if isinstance(item, str):
                result.add(item)
            elif isinstance(item, dict):
                identifier = item.get("id") or item.get("target")
                if identifier:
                    result.add(str(identifier))
        return result
    return set()


def moon_projects() -> list[dict[str, Any]]:
    data = run_moon(["query", "projects"])
    projects = data.get("projects")
    if not isinstance(projects, list):
        fail("moon query projects did not return a projects array")
    return projects


def moon_tasks() -> dict[str, Any]:
    data = run_moon(["query", "tasks"])
    tasks = data.get("tasks")
    if not isinstance(tasks, dict):
        fail("moon query tasks did not return a tasks object")
    return tasks


def normalize_project(project: dict[str, Any]) -> dict[str, Any]:
    config = project.get("config") if isinstance(project.get("config"), dict) else {}
    raw_deps = project.get("dependencies") or config.get("dependsOn") or []
    if not isinstance(raw_deps, list):
        fail(f"Moon project {project.get('id')} has non-list dependsOn")
    deps: dict[str, str] = {}
    for dependency in raw_deps:
        if isinstance(dependency, str):
            deps[dependency] = "production"
        elif isinstance(dependency, dict) and isinstance(dependency.get("id"), str):
            deps[dependency["id"]] = str(dependency.get("scope") or "production")
        else:
            fail(f"Moon project {project.get('id')} has unsupported dependency entry {dependency!r}")
    return {
        "id": project["id"],
        "source": project.get("source") or config.get("source") or "",
        "language": project.get("language") or config.get("language"),
        "layer": project.get("layer") or config.get("layer"),
        "stack": project.get("stack") or config.get("stack"),
        "tags": sorted(config.get("tags") or []),
        "dependsOn": sorted(deps),
        "dependencyScopes": dict(sorted(deps.items())),
        "project": config.get("project") if isinstance(config.get("project"), dict) else {},
        "tasks": sorted((project.get("tasks") or {}).keys()),
    }


def normalize_task(task: dict[str, Any]) -> dict[str, Any]:
    inputs = sorted(
        {
            *task.get("inputFiles", {}).keys(),
            *task.get("inputGlobs", {}).keys(),
            *[
                item.get("file") or item.get("glob")
                for item in task.get("inputs", [])
                if isinstance(item, dict) and (item.get("file") or item.get("glob"))
            ],
        }
    )
    outputs = sorted(
        {
            *task.get("outputFiles", {}).keys(),
            *task.get("outputGlobs", {}).keys(),
            *[
                item.get("file") or item.get("glob") or item
                for item in task.get("outputs", [])
                if isinstance(item, (dict, str))
            ],
        }
    )
    deps = sorted(
        (
            {
                "target": dep.get("target"),
                "cacheStrategy": dep.get("cacheStrategy"),
            }
            if isinstance(dep, dict)
            else {"target": dep, "cacheStrategy": None}
            for dep in task.get("deps", [])
        ),
        key=lambda dep: (dep.get("target") or "", dep.get("cacheStrategy") or ""),
    )
    command = " ".join([task.get("command") or "", *(task.get("args") or [])]).strip()
    return {
        "command": command,
        "deps": deps,
        "tags": sorted(task.get("tags") or []),
        "inputs": inputs,
        "outputs": outputs,
        "cache": (task.get("options") or {}).get("cache"),
        "runInCI": (task.get("options") or {}).get("runInCI", True),
    }


def release_products(release_metadata: dict[str, Any]) -> dict[str, dict[str, Any]]:
    products = release_metadata.get("products")
    if not isinstance(products, dict):
        fail("release metadata must define [products.<id>] tables")
    return products


def dependents_by_project(projects: dict[str, dict[str, Any]]) -> dict[str, list[str]]:
    dependents: dict[str, set[str]] = {project: set() for project in projects}
    for project, config in projects.items():
        for dependency in config["dependsOn"]:
            dependents.setdefault(dependency, set()).add(project)
    return {project: sorted(values) for project, values in sorted(dependents.items())}


def downstream_closure(project: str, dependents: dict[str, list[str]]) -> list[str]:
    seen = {project}
    queue: deque[str] = deque([project])
    while queue:
        current = queue.popleft()
        for dependent in dependents.get(current, []):
            if dependent not in seen:
                seen.add(dependent)
                queue.append(dependent)
    return sorted(seen)


def owner_project_for_path(projects: dict[str, dict[str, Any]], path: str) -> str | None:
    if is_generated_local_state(path):
        return None
    matches = [
        project
        for project in projects.values()
        if project["source"] == "." or path == project["source"] or path.startswith(f"{project['source']}/")
    ]
    matches.sort(key=lambda project: len(project["source"]), reverse=True)
    return matches[0]["id"] if matches else None


def is_generated_local_state(path: str) -> bool:
    if path.startswith("target/"):
        return True
    return any(part in GENERATED_PATH_PARTS for part in Path(path).parts)


def coverage_expectations(
    coverage_baseline: dict[str, Any],
    tasks: dict[str, Any],
) -> dict[str, Any]:
    products = coverage_baseline.get("products")
    if not isinstance(products, dict):
        fail("coverage baseline must define [products.<id>] tables")
    expectations: dict[str, Any] = {}
    for product, config in sorted(products.items()):
        product_tasks = tasks.get(product, {})
        expectations[product] = {
            "tool": config.get("tool"),
            "lineThreshold": config.get("line_threshold"),
            "measuredLineCoverage": config.get("measured_line_coverage"),
            "summary": config.get("summary"),
            "reports": config.get("reports", []),
            "includeGlobs": config.get("source_globs", config.get("include_globs", [])),
            "excludeGlobs": config.get("exclude_globs", []),
            "moonCoverageTask": "coverage" in product_tasks,
        }
    return expectations


def ci_matrix(tasks: dict[str, Any]) -> dict[str, Any]:
    jobs: dict[str, Any] = {}
    missing: dict[str, list[str]] = {}
    for job, targets in CI_JOB_TARGETS.items():
        missing_targets: list[str] = []
        for target in targets:
            project, task = target.split(":", 1)
            if task not in tasks.get(project, {}):
                missing_targets.append(target)
        jobs[job] = {
            "targets": targets,
            "allTargetsExist": not missing_targets,
        }
        if missing_targets:
            missing[job] = missing_targets
    return {
        "metadata": {
            "alwaysJobs": sorted(CI_JOBS_CONFIG["always_jobs"]),
            "coverageJobProducts": dict(sorted(CI_JOBS_CONFIG["coverage_job_products"].items())),
            "wasmRuntimeJobs": sorted(CI_JOBS_CONFIG["wasm_runtime_jobs"]),
            "source": "Moon task tags ci-<job>",
        },
        "jobs": jobs,
        "requiredJobs": sorted(CI_JOB_TARGETS),
        "missingTargets": missing,
    }


def build_graph() -> dict[str, Any]:
    release_metadata = release_plan.load_graph()
    coverage_baseline = read_toml(COVERAGE_BASELINE_PATH)
    projects = {project["id"]: normalize_project(project) for project in moon_projects()}
    tasks_raw = moon_tasks()
    tasks = {
        project: {task_id: normalize_task(task) for task_id, task in sorted(project_tasks.items())}
        for project, project_tasks in sorted(tasks_raw.items())
    }
    products = release_products(release_metadata)
    product_ids = list(products)
    dependents = dependents_by_project(projects)
    return {
        "moonProjects": projects,
        "moonTasks": tasks,
        "moonDependents": dependents,
        "releaseProducts": {
            product: {
                "owner": config.get("owner"),
                "kind": config.get("kind"),
                "moonProject": release_plan.release_product_project_id(product, products, projects),
                "tagPrefix": config.get("tag_prefix"),
                "publishTargets": config.get("publish_targets", []),
                "releaseArtifacts": config.get("release_artifacts", []),
                "moonProjectExists": release_plan.release_product_project_id(product, products, projects) in projects,
            }
            for product, config in products.items()
        },
        "releaseOrder": release_plan.release_order(products, projects, product_ids),
        "coverageExpectations": coverage_expectations(coverage_baseline, tasks_raw),
        "ciMatrix": ci_matrix(tasks_raw),
        "productIds": product_ids,
        "policy": release_metadata.get("policy", {}),
    }


def explain_paths(paths: list[str], graph: dict[str, Any]) -> dict[str, Any]:
    projects = graph["moonProjects"]
    dependents = graph["moonDependents"]
    normalized_paths = normalize_explain_paths(paths)
    release_metadata = release_plan.load_graph()
    release_impact = release_plan.build_plan(
        release_metadata,
        release_plan.normalize_files(normalized_paths),
    )
    explanations = []
    for path in normalized_paths:
        owner = owner_project_for_path(projects, path)
        explanations.append(
            {
                "path": path,
                "ownerProject": owner,
                "moonAffectedProjects": downstream_closure(owner, dependents) if owner else [],
                "coverageProducts": coverage_products_for_path(path, graph),
            }
        )
    return {
        "paths": explanations,
        "releasePlan": release_impact,
    }


def normalize_explain_paths(paths: Iterable[str]) -> list[str]:
    normalized: set[str] = set()
    for path in paths:
        value = path.strip().replace("\\", "/")
        if value.startswith("./"):
            value = value[2:]
        if value:
            normalized.add(value)
    return sorted(normalized)


def coverage_products_for_path(path: str, graph: dict[str, Any]) -> list[str]:
    if is_generated_local_state(path):
        return []
    products: list[str] = []
    for product, config in graph["coverageExpectations"].items():
        includes = config.get("includeGlobs", [])
        excludes = config.get("excludeGlobs", [])
        if release_plan.product_matches(path, includes) and not release_plan.product_matches(
            path, excludes
        ):
            products.append(product)
    return sorted(products)


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"{json.dumps(value, indent=2, sort_keys=True)}\n", encoding="utf-8")


def write_graph(graph: dict[str, Any]) -> None:
    GRAPH_ROOT.mkdir(parents=True, exist_ok=True)
    write_json(
        GRAPH_ROOT / "products.json",
        {
            "moonProjects": graph["moonProjects"],
            "moonDependents": graph["moonDependents"],
            "releaseProducts": graph["releaseProducts"],
            "releaseOrder": graph["releaseOrder"],
            "productIds": graph["productIds"],
        },
    )
    write_json(GRAPH_ROOT / "tasks.json", graph["moonTasks"])
    write_json(GRAPH_ROOT / "ci-matrix.json", graph["ciMatrix"])
    write_json(GRAPH_ROOT / "coverage-expectations.json", graph["coverageExpectations"])
    write_json(
        GRAPH_ROOT / "explain.json",
        {
            "usage": "tools/graph/graph.py explain --path <repo-relative-path>",
            "syntheticCases": {
                contract: synthetic_contract_cases(contract).get("cases", {})
                for contract in ("affected", "release", "coverage")
            },
        },
    )


def synthetic_contract_cases(contract: str) -> dict[str, Any]:
    path = SYNTHETIC_ROOT / f"{contract}.toml"
    if not path.is_file():
        fail(f"missing synthetic graph fixture: {rel(path)}")
    return read_toml(path)


def assert_equal_list(label: str, actual: list[str], expected: list[str]) -> None:
    if sorted(actual) != sorted(expected):
        fail(f"{label}: expected {sorted(expected)}, got {sorted(actual)}")


def assert_docs_evidence_paths_do_not_select_builder_jobs() -> None:
    forbidden_jobs = {
        "extension-artifacts-native",
        "extension-artifacts-wasix",
        "extension-packages",
        "liboliphaunt-wasix-aot",
        "liboliphaunt-wasix-release-assets",
        "liboliphaunt-wasix-runtime",
        "mobile-build-android",
        "mobile-build-ios",
        "mobile-extension-packages",
    }
    paths = [
        "src/extensions/evidence/runs/2026-06-07-transitional-catalog-smoke.json",
        "src/extensions/generated/docs/extension-evidence.json",
        "src/extensions/generated/docs/extensions.json",
    ]
    for path in paths:
        affected = run_moon(
            ["query", "affected", "--upstream", "none", "--downstream", "none"],
            stdin=f"{path}\n",
        )
        jobs = plan_jobs_for_affected(
            affected_names(affected.get("projects")),
            affected_names(affected.get("tasks")),
        )
        unexpected = sorted(jobs & forbidden_jobs)
        if unexpected:
            fail(f"{path} must not select CI builder jobs, got {unexpected}")


def task(graph: dict[str, Any], project: str, task_id: str) -> dict[str, Any]:
    try:
        return graph["moonTasks"][project][task_id]
    except KeyError:
        fail(f"missing Moon task {project}:{task_id}")


def assert_task_tags(graph: dict[str, Any], project: str, task_id: str, expected: list[str]) -> None:
    actual = task(graph, project, task_id).get("tags", [])
    missing = sorted(set(expected) - set(actual))
    if missing:
        fail(f"{project}:{task_id} tags: missing {missing}, got {sorted(actual)}")


def assert_dep_cache_strategy(
    graph: dict[str, Any],
    project: str,
    task_id: str,
    target: str,
    expected: str,
) -> None:
    deps = task(graph, project, task_id).get("deps", [])
    for dep in deps:
        if dep.get("target") == target:
            if dep.get("cacheStrategy") != expected:
                fail(
                    f"{project}:{task_id} dependency {target}: expected cacheStrategy={expected}, "
                    f"got {dep.get('cacheStrategy')}"
                )
            return
    fail(f"{project}:{task_id} is missing dependency {target}")


def check_graph(graph: dict[str, Any]) -> None:
    projects = graph["moonProjects"]
    release_products_config = release_products(release_plan.load_graph())
    for product, config in release_products_config.items():
        project_id = release_plan.release_product_project_id(product, release_products_config, projects)
        project = projects.get(project_id)
        if project is None:
            fail(f"release product {product} does not have an owning Moon project")
        if "release-product" not in project.get("tags", []):
            fail(f"release product {product} Moon project {project_id} must be tagged release-product")
        metadata = project.get("project", {}).get("metadata", {})
        release = metadata.get("release") if isinstance(metadata, dict) else None
        if not isinstance(release, dict):
            release = project.get("project", {}).get("release")
        if not isinstance(release, dict):
            fail(f"release product {product} Moon project {project_id} must declare project.release metadata")
        if release.get("component") != product:
            fail(f"release product {product} Moon metadata component mismatch: {release.get('component')}")
        if release.get("packagePath") != config.get("path"):
            fail(f"release product {product} Moon metadata packagePath mismatch: {release.get('packagePath')}")

    missing_ci_targets = graph["ciMatrix"]["missingTargets"]
    if missing_ci_targets:
        fail(f"CI matrix references missing Moon targets: {missing_ci_targets}")

    assert_docs_evidence_paths_do_not_select_builder_jobs()

    for project, project_tasks in graph["moonTasks"].items():
        for task_id, config in project_tasks.items():
            if not config.get("tags"):
                fail(f"{project}:{task_id} must declare Moon task tags")

    for project in graph["moonProjects"]:
        for task_id in ("check", "test"):
            if task_id in graph["moonTasks"].get(project, {}):
                if task_id == "check":
                    expected_tags = ["quality", "static"]
                elif project == "liboliphaunt-native":
                    expected_tags = ["quality", "runtime"]
                else:
                    expected_tags = ["quality", "unit"]
                assert_task_tags(graph, project, task_id, expected_tags)

    for project in (
        "oliphaunt-rust",
        "oliphaunt-swift",
        "oliphaunt-kotlin",
        "oliphaunt-react-native",
        "oliphaunt-js",
        "oliphaunt-wasix-rust",
    ):
        assert_task_tags(graph, project, "coverage", ["coverage", "quality"])
        assert_task_tags(graph, project, "bench-run", ["bench", "measured"])

    for target in (
        "oliphaunt-rust:coverage",
        "oliphaunt-swift:coverage",
        "oliphaunt-kotlin:coverage",
        "oliphaunt-js:coverage",
        "oliphaunt-react-native:coverage",
        "oliphaunt-wasix-rust:coverage",
    ):
        assert_dep_cache_strategy(graph, "repo", "coverage", target, "outputs")
    assert_dep_cache_strategy(graph, "docs", "smoke", "docs:build", "outputs")
    assert_dep_cache_strategy(graph, "docs", "release-check", "docs:build", "outputs")

    for product, config in graph["coverageExpectations"].items():
        if not config["moonCoverageTask"]:
            fail(f"coverage baseline product {product} has no Moon coverage task")
        if config["lineThreshold"] is None or config["measuredLineCoverage"] is None:
            fail(f"coverage baseline product {product} is missing measured threshold data")

    affected_cases = synthetic_contract_cases("affected").get("cases")
    if not isinstance(affected_cases, dict):
        fail("tools/graph/synthetic/affected.toml must define [cases.<id>] tables")
    for case_id, case in affected_cases.items():
        path = case.get("path")
        if not isinstance(path, str):
            fail(f"synthetic affected case {case_id} is missing path")
        explanation = explain_paths([path], graph)
        moon_projects = explanation["paths"][0]["moonAffectedProjects"]
        assert_equal_list(f"{case_id} Moon affected projects", moon_projects, case.get("moon_projects", []))

    release_cases = synthetic_contract_cases("release").get("cases")
    if not isinstance(release_cases, dict):
        fail("tools/graph/synthetic/release.toml must define [cases.<id>] tables")
    for case_id, case in release_cases.items():
        path = case.get("path")
        if not isinstance(path, str):
            fail(f"synthetic release case {case_id} is missing path")
        release_impact = release_plan.build_plan(
            release_plan.load_graph(),
            release_plan.normalize_files([path]),
        )
        planned_release_products = release_impact["releaseProducts"]
        assert_equal_list(
            f"{case_id} direct release products",
            release_impact["directProducts"],
            case.get("direct_products", []),
        )
        assert_equal_list(
            f"{case_id} release products",
            planned_release_products,
            case.get("release_products", []),
        )
        if "docs_only" in case and release_impact.get("docsOnly") is not case["docs_only"]:
            fail(
                f"{case_id} docsOnly: expected {case['docs_only']}, "
                f"got {release_impact.get('docsOnly')}"
            )

    coverage_cases = synthetic_contract_cases("coverage").get("cases")
    if not isinstance(coverage_cases, dict):
        fail("tools/graph/synthetic/coverage.toml must define [cases.<id>] tables")
    for case_id, case in coverage_cases.items():
        path = case.get("path")
        if not isinstance(path, str):
            fail(f"synthetic coverage case {case_id} is missing path")
        explanation = explain_paths([path], graph)
        assert_equal_list(
            f"{case_id} coverage products",
            explanation["paths"][0]["coverageProducts"],
            case.get("coverage_products", []),
        )

    for project, task_id, expected_cache, expected_output in [
        ("graph-tools", "cache-witness", False, None),
        ("graph-tools", "cache-witness-fixture", True, "/target/graph/cache-witness/output.txt"),
    ]:
        config = task(graph, project, task_id)
        if config.get("cache") is not expected_cache:
            fail(
                f"{project}:{task_id} cache: expected {expected_cache}, "
                f"got {config.get('cache')}"
            )
        if expected_output is not None and expected_output not in config.get("outputs", []):
            fail(f"{project}:{task_id} must declare output {expected_output}")


def print_explanation(explanation: dict[str, Any], fmt: str) -> None:
    if fmt == "json":
        print(json.dumps(explanation, indent=2, sort_keys=True))
        return
    for path in explanation["paths"]:
        print(f"{path['path']}")
        print(f"  owner project: {path['ownerProject'] or '(none)'}")
        print("  Moon affected: " + (", ".join(path["moonAffectedProjects"]) or "(none)"))
        print("  coverage: " + (", ".join(path["coverageProducts"]) or "(none)"))
    plan = explanation["releasePlan"]
    print("Release direct products: " + (", ".join(plan["directProducts"]) or "(none)"))
    print("Release products: " + (", ".join(plan["releaseProducts"]) or "(none)"))


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("generate")
    subparsers.add_parser("check")
    explain = subparsers.add_parser("explain")
    explain.add_argument("--path", action="append", required=True, help="repo-relative path")
    explain.add_argument("--format", choices=["text", "json"], default="text")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    graph = build_graph()
    if args.command == "generate":
        write_graph(graph)
        print(f"generated graph data in {rel(GRAPH_ROOT)}")
    elif args.command == "check":
        write_graph(graph)
        check_graph(graph)
        print(f"graph checks passed ({len(graph['moonProjects'])} Moon projects, {len(graph['productIds'])} release products)")
    elif args.command == "explain":
        write_graph(graph)
        print_explanation(explain_paths(args.path, graph), args.format)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
