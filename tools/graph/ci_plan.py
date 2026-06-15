#!/usr/bin/env python3
"""Map Moon affected tasks onto stable GitHub Actions jobs.

Moon is the only project/task graph. Stable GitHub job names are selected from
Moon task tags named ``ci-<job-id>``. GitHub Actions still owns platform matrix
fan-out because runner OS, native target triples, and simulator/device targets
are CI execution details, not source projects.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools" / "release"))

import artifact_target_matrix  # noqa: E402
from affected import affected_projects_and_tasks  # noqa: E402


BASE_JOBS = {"affected"}
ALWAYS_JOBS = set(BASE_JOBS)
BUILDER_JOBS = {
    "broker-runtime",
    "extension-artifacts-native",
    "extension-artifacts-wasix",
    "extension-packages",
    "js-sdk-package",
    "kotlin-sdk-package",
    "liboliphaunt-native-android",
    "liboliphaunt-native-desktop",
    "liboliphaunt-native-ios",
    "liboliphaunt-native-release-assets",
    "liboliphaunt-wasix-aot",
    "liboliphaunt-wasix-release-assets",
    "liboliphaunt-wasix-runtime",
    "mobile-build-android",
    "mobile-build-ios",
    "mobile-extension-packages",
    "node-direct",
    "react-native-sdk-package",
    "rust-sdk-package",
    "swift-sdk-package",
    "wasix-rust-package",
}
NATIVE_RUNTIME_JOBS = {
    "liboliphaunt-native-android",
    "liboliphaunt-native-desktop",
    "liboliphaunt-native-ios",
}
NATIVE_RUNTIME_TASKS = {
    "liboliphaunt-native:release-runtime",
    "liboliphaunt-native:release-runtime-desktop",
    "liboliphaunt-native:release-runtime-mobile-target",
}
WASM_RUNTIME_JOBS = {
    "liboliphaunt-wasix-runtime",
    "liboliphaunt-wasix-aot",
    "liboliphaunt-wasix-release-assets",
}
AGGREGATE_ARTIFACT_JOBS = {"liboliphaunt-native-release-assets"}
WASM_RUNTIME_PORTABLE_TASK = "liboliphaunt-wasix:runtime-portable"
WASM_RUNTIME_AOT_TASK = "liboliphaunt-wasix:runtime-aot"
MOBILE_JOB_SURFACES = {
    "mobile-build-android": "react-native-android",
    "mobile-build-ios": "react-native-ios",
}
ANDROID_MOBILE_JOBS = {"mobile-build-android"}
IOS_MOBILE_JOBS = {"mobile-build-ios"}
EXTENSION_ARTIFACT_CONSUMER_JOBS = {
    "extension-packages",
    "mobile-extension-packages",
}
WASIX_EXTENSION_ARTIFACT_PORTABLE_CONSUMER_JOBS = {
    "extension-packages",
    "extension-artifacts-wasix",
}
MOBILE_SMOKE_EXTENSION_PRODUCTS = {"oliphaunt-extension-vector"}


def moon_bin() -> str:
    if configured := os.environ.get("MOON_BIN"):
        return configured
    for candidate in (
        Path.home() / ".proto" / "shims" / "moon",
        Path.home() / ".proto" / "bin" / "moon",
    ):
        if candidate.exists():
            return str(candidate)
    return "moon"


def moon(args: list[str]) -> dict[str, object]:
    output = subprocess.check_output([moon_bin(), *args], cwd=ROOT, text=True)
    return json.loads(output)


def moon_ci_job_targets() -> dict[str, list[str]]:
    queried = moon(["query", "tasks"])
    tasks_by_project = queried.get("tasks")
    if not isinstance(tasks_by_project, dict):
        raise RuntimeError("moon query tasks did not return a tasks object")

    jobs: dict[str, set[str]] = {}
    for project_id, project_tasks in tasks_by_project.items():
        if not isinstance(project_tasks, dict):
            continue
        for task_id, task in project_tasks.items():
            if not isinstance(task, dict):
                continue
            target = task.get("target") or f"{project_id}:{task_id}"
            tags = task.get("tags", [])
            if not isinstance(tags, list):
                continue
            for tag in tags:
                if isinstance(tag, str) and tag.startswith("ci-"):
                    job = tag.removeprefix("ci-")
                    jobs.setdefault(job, set()).add(str(target))
    return {job: sorted(targets) for job, targets in sorted(jobs.items())}


CI_JOB_TARGETS: dict[str, list[str]] = moon_ci_job_targets()
ALL_BUILDER_JOBS = (set(BUILDER_JOBS) | WASM_RUNTIME_JOBS | AGGREGATE_ARTIFACT_JOBS) - ALWAYS_JOBS
COVERAGE_JOB_PRODUCTS = {
    job: targets[0].split(":", 1)[0]
    for job, targets in CI_JOB_TARGETS.items()
    if any(target.endswith(":coverage") for target in targets)
}
CI_JOBS_CONFIG = {
    "always_jobs": sorted(ALWAYS_JOBS),
    "ci_job_targets": CI_JOB_TARGETS,
    "coverage_job_products": COVERAGE_JOB_PRODUCTS,
    "wasm_runtime_jobs": sorted(WASM_RUNTIME_JOBS),
}


def job_targets_for_jobs(jobs: set[str]) -> dict[str, list[str]]:
    return {
        job: CI_JOB_TARGETS[job]
        for job in sorted(jobs)
        if job in CI_JOB_TARGETS
    }


def empty_matrix() -> dict[str, list[dict[str, str]]]:
    return {"include": []}


def jobs_for_targets(targets: set[str], *, allowed_jobs: set[str] | None = None) -> set[str]:
    jobs: set[str] = set()
    target_set = set(targets)
    for job, job_targets in CI_JOB_TARGETS.items():
        if allowed_jobs is not None and job not in allowed_jobs:
            continue
        if target_set & set(job_targets):
            jobs.add(job)
    return jobs


def add_implied_jobs(jobs: set[str], tasks: set[str]) -> None:
    if jobs & {
        "liboliphaunt-wasix-runtime",
        "liboliphaunt-wasix-aot",
        "liboliphaunt-wasix-release-assets",
    } or {WASM_RUNTIME_PORTABLE_TASK, WASM_RUNTIME_AOT_TASK} & tasks:
        jobs.update(WASM_RUNTIME_JOBS)

    if jobs & set(MOBILE_JOB_SURFACES):
        jobs.add("mobile-extension-packages")
        jobs.add("react-native-sdk-package")

    if jobs & ANDROID_MOBILE_JOBS:
        jobs.add("liboliphaunt-native-android")
        jobs.add("kotlin-sdk-package")

    if jobs & IOS_MOBILE_JOBS:
        jobs.add("liboliphaunt-native-ios")
        jobs.add("swift-sdk-package")

    if "swift-sdk-package" in jobs:
        jobs.add("liboliphaunt-native-ios")

    if "liboliphaunt-native-release-assets" in jobs:
        jobs.update(NATIVE_RUNTIME_JOBS)

    if jobs & EXTENSION_ARTIFACT_CONSUMER_JOBS:
        jobs.add("extension-artifacts-native")

    if jobs & WASIX_EXTENSION_ARTIFACT_PORTABLE_CONSUMER_JOBS:
        jobs.add("extension-artifacts-wasix")
        jobs.add("liboliphaunt-wasix-runtime")


def plan_jobs_for_affected(
    direct_projects: set[str],
    tasks: set[str],
) -> set[str]:
    jobs = set(ALWAYS_JOBS)
    jobs.update(jobs_for_targets(tasks, allowed_jobs=ALL_BUILDER_JOBS))
    if "react-native-sdk-package" in jobs:
        jobs.update(ANDROID_MOBILE_JOBS)
        jobs.update(IOS_MOBILE_JOBS)
    if "ci-workflows" in direct_projects:
        jobs.update(ALL_BUILDER_JOBS)
    add_implied_jobs(jobs, tasks)
    if tasks & NATIVE_RUNTIME_TASKS:
        jobs.add("liboliphaunt-native-release-assets")
        jobs.update(NATIVE_RUNTIME_JOBS)
    return jobs


def native_target_subset_for_jobs(jobs: set[str], tasks: set[str]) -> set[str] | None:
    if not (jobs & NATIVE_RUNTIME_JOBS):
        return None
    if "liboliphaunt-native-release-assets" in jobs:
        return None
    if tasks & NATIVE_RUNTIME_TASKS:
        return None

    targets = mobile_native_targets_for_jobs(jobs)
    if "swift-sdk-package" in jobs:
        targets.add("ios-xcframework")
    if "kotlin-sdk-package" in jobs:
        targets.update(artifact_target_matrix.liboliphaunt_native_runtime_targets_for_surface("maven"))
    return targets or None


def mobile_native_targets_for_jobs(jobs: set[str]) -> set[str]:
    targets: set[str] = set()
    for job, surface in MOBILE_JOB_SURFACES.items():
        if job in jobs:
            targets.update(artifact_target_matrix.liboliphaunt_native_runtime_targets_for_surface(surface))
    return targets


def mobile_extension_package_native_targets(jobs: set[str], selected_targets: set[str] | None) -> list[str]:
    if "mobile-extension-packages" not in jobs:
        return []
    if selected_targets is not None:
        return sorted(selected_targets)
    return sorted(mobile_native_targets_for_jobs(jobs))


def focused_mobile_native_targets(
    mobile_target: str,
    native_target: str,
    focused_mobile_jobs: set[str],
) -> set[str]:
    targets = mobile_native_targets_for_jobs(focused_mobile_jobs)
    if native_target == "all":
        return targets
    if mobile_target == "both":
        raise RuntimeError("focused mobile_target=both requires native_target=all")
    if native_target not in targets:
        valid_targets = ", ".join(sorted(targets))
        raise RuntimeError(
            f"native_target={native_target} is not valid for mobile_target={mobile_target}; "
            f"expected one of: all, {valid_targets}"
        )
    return {native_target}


def plan_for_pull_request() -> tuple[set[str], set[str], set[str], str, set[str] | None]:
    base = os.environ.get("MOON_BASE")
    head = os.environ.get("MOON_HEAD")
    if not base or not head:
        raise RuntimeError("MOON_BASE and MOON_HEAD are required for pull_request CI planning")

    direct_projects, projects, tasks = affected_projects_and_tasks()
    jobs = plan_jobs_for_affected(direct_projects, tasks)
    selected_native_targets = native_target_subset_for_jobs(jobs, tasks)
    reason = (
        f"direct affected projects: {', '.join(sorted(direct_projects)) or '(none)'}; "
        f"downstream affected projects: {', '.join(sorted(projects)) or '(none)'}; "
        f"affected tasks: {', '.join(sorted(tasks)) or '(none)'}"
    )
    return jobs, projects, tasks, reason, selected_native_targets


def liboliphaunt_native_desktop_runtime_matrix(
    native_target: str = "all",
    selected_targets: set[str] | None = None,
) -> dict[str, list[dict[str, str]]]:
    return artifact_target_matrix.liboliphaunt_native_desktop_runtime_matrix(
        native_target=native_target,
        selected_targets=selected_targets,
    )


def liboliphaunt_native_android_runtime_matrix(
    native_target: str = "all",
    selected_targets: set[str] | None = None,
) -> dict[str, list[dict[str, str]]]:
    return artifact_target_matrix.liboliphaunt_native_android_runtime_matrix(
        native_target=native_target,
        selected_targets=selected_targets,
    )


def liboliphaunt_native_ios_runtime_matrix(
    native_target: str = "all",
    selected_targets: set[str] | None = None,
) -> dict[str, list[dict[str, str]]]:
    return artifact_target_matrix.liboliphaunt_native_ios_runtime_matrix(
        native_target=native_target,
        selected_targets=selected_targets,
    )


def react_native_android_mobile_app_matrix(
    native_target: str = "all",
    selected_targets: set[str] | None = None,
) -> dict[str, list[dict[str, str]]]:
    return artifact_target_matrix.react_native_android_mobile_app_matrix(
        native_target=native_target,
        selected_targets=selected_targets,
    )


def broker_runtime_matrix(native_target: str = "all") -> dict[str, list[dict[str, str]]]:
    matrix = artifact_target_matrix.broker_runtime_matrix()
    if native_target == "all":
        return matrix
    include = [target for target in matrix["include"] if target["target"] == native_target]
    if not include:
        valid_targets = ", ".join(target["target"] for target in matrix["include"])
        raise RuntimeError(f"unknown broker target {native_target}; expected one of: all, {valid_targets}")
    return {"include": include}


def node_direct_runtime_matrix(native_target: str = "all") -> dict[str, list[dict[str, str]]]:
    matrix = artifact_target_matrix.node_direct_runtime_matrix()
    if native_target == "all":
        return matrix
    include = [target for target in matrix["include"] if target["target"] == native_target]
    if not include:
        valid_targets = ", ".join(target["target"] for target in matrix["include"])
        raise RuntimeError(f"unknown Node direct target {native_target}; expected one of: all, {valid_targets}")
    return {"include": include}


def extension_artifacts_wasix_matrix(
    wasm_target: str = "all",
    selected_products: set[str] | None = None,
) -> dict[str, list[dict[str, str]]]:
    return artifact_target_matrix.extension_artifacts_wasix_matrix(wasm_target, selected_products)


def liboliphaunt_wasix_aot_runtime_matrix(wasm_target: str = "all") -> dict[str, list[dict[str, str]]]:
    return artifact_target_matrix.liboliphaunt_wasix_aot_runtime_matrix(wasm_target)


def extension_artifacts_native_matrix(
    native_target: str = "all",
    selected_targets: set[str] | None = None,
    selected_products: set[str] | None = None,
) -> dict[str, list[dict[str, str]]]:
    return artifact_target_matrix.extension_artifacts_native_matrix(native_target, selected_targets, selected_products)


def targets_for_jobs(jobs: set[str]) -> set[str]:
    targets: set[str] = set()
    for job in jobs:
        targets.update(CI_JOB_TARGETS.get(job, []))
    return targets


def selected_extension_products_for_plan(
    direct_projects: set[str],
    tasks: set[str],
    jobs: set[str],
) -> set[str] | None:
    exact_products = set(artifact_target_matrix.exact_extension_products())
    selected = (direct_projects & exact_products) | {
        target.split(":", 1)[0]
        for target in tasks
        if target.split(":", 1)[0] in exact_products
    }
    broad_extension_inputs = {
        "extension-artifacts-native",
        "extension-artifacts-wasix",
        "extension-contrib-postgres18",
        "extension-model",
        "extension-packages",
        "extensions",
        "liboliphaunt-native",
        "liboliphaunt-wasix",
        "postgres18",
        "source-inputs",
        "third-party-native",
        "third-party-shared",
        "third-party-wasix",
    }
    if direct_projects & broad_extension_inputs:
        return exact_products
    if "extension-packages:assemble-release" in tasks and not selected:
        return exact_products
    if "extension-packages" in jobs and not selected:
        return exact_products
    if jobs & set(MOBILE_JOB_SURFACES):
        selected.update(MOBILE_SMOKE_EXTENSION_PRODUCTS)
    if jobs & {"extension-artifacts-native", "extension-artifacts-wasix"} and not selected:
        return exact_products
    if "extension-packages:assemble-mobile" in tasks and not selected:
        return exact_products
    if not selected:
        return None
    return selected


def plan_for_full_run(
    wasm_target: str = "all",
    native_target: str = "all",
    mobile_target: str = "all",
) -> tuple[set[str], set[str], set[str], str, set[str] | None]:
    if mobile_target != "all":
        mobile_jobs_by_target = {
            "android": {"mobile-build-android"},
            "ios": {"mobile-build-ios"},
            "both": {"mobile-build-android", "mobile-build-ios"},
        }
        focused_mobile_jobs = mobile_jobs_by_target.get(mobile_target)
        if focused_mobile_jobs is None:
            raise RuntimeError(f"unknown mobile target {mobile_target}; expected one of: all, android, ios, both")
        focused_jobs = set(BASE_JOBS) | focused_mobile_jobs
        add_implied_jobs(focused_jobs, set())
        focused_native_targets = focused_mobile_native_targets(mobile_target, native_target, focused_mobile_jobs)
        return (
            focused_jobs,
            {"liboliphaunt-native", "oliphaunt-react-native"},
            targets_for_jobs(focused_mobile_jobs),
            f"manual focused mobile CI run for {mobile_target}",
            focused_native_targets,
        )

    if native_target != "all":
        if native_target.startswith("android-") or native_target == "ios-xcframework":
            focused_jobs = set(BASE_JOBS) | {
                "liboliphaunt-native-android" if native_target.startswith("android-") else "liboliphaunt-native-ios"
            }
            focused_projects = {"liboliphaunt-native"}
        else:
            focused_jobs = set(BASE_JOBS) | {"liboliphaunt-native-desktop", "broker-runtime", "node-direct"}
            focused_projects = {"liboliphaunt-native", "oliphaunt-broker", "oliphaunt-node-direct"}
        add_implied_jobs(focused_jobs, set())
        return (
            focused_jobs,
            focused_projects,
            targets_for_jobs(focused_jobs),
            f"manual focused native runtime CI run for {native_target}",
            None,
        )

    if wasm_target != "all":
        focused_jobs = set(BASE_JOBS) | {
            "liboliphaunt-wasix-runtime",
            "liboliphaunt-wasix-aot",
        }
        return (
            focused_jobs,
            {"liboliphaunt-wasix"},
            targets_for_jobs(focused_jobs),
            f"manual focused WASIX runtime CI run for {wasm_target}",
            None,
        )

    jobs = set(BASE_JOBS) | BUILDER_JOBS | WASM_RUNTIME_JOBS
    add_implied_jobs(jobs, targets_for_jobs(jobs))
    return jobs, set(), targets_for_jobs(jobs), "non-PR full CI/runtime run", None


def output(name: str, value: object) -> None:
    if isinstance(value, str):
        rendered = value
    else:
        rendered = json.dumps(value, sort_keys=True, separators=(",", ":"))
    path = os.environ.get("GITHUB_OUTPUT")
    if path:
        with Path(path).open("a", encoding="utf-8") as handle:
            print(f"{name}={rendered}", file=handle)
    print(f"{name}={rendered}")


def write_plan_artifact(plan: dict[str, object]) -> None:
    path = ROOT / "target" / "graph" / "ci-plan.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"{json.dumps(plan, indent=2, sort_keys=True)}\n", encoding="utf-8")


def emit_github_outputs() -> int:
    try:
        if os.environ.get("GITHUB_EVENT_NAME") == "pull_request":
            jobs, projects, tasks, reason, selected_native_targets = plan_for_pull_request()
        else:
            jobs, projects, tasks, reason, selected_native_targets = plan_for_full_run(
                os.environ.get("WASM_TARGET", "all"),
                os.environ.get("NATIVE_TARGET", "all"),
                os.environ.get("MOBILE_TARGET", "all"),
            )
    except Exception as error:
        print(f"affected planning failed: {error}", file=sys.stderr)
        return 2
    direct_projects: set[str] = set()
    if os.environ.get("GITHUB_EVENT_NAME") == "pull_request":
        try:
            direct_projects, _, _ = affected_projects_and_tasks()
        except Exception:
            direct_projects = set()
    selected_extension_products = selected_extension_products_for_plan(direct_projects, tasks, jobs)

    plan = {
        "jobs": sorted(jobs),
        "builder_jobs": sorted(jobs & BUILDER_JOBS),
        "job_targets": job_targets_for_jobs(jobs),
        "projects": sorted(projects),
        "tasks": sorted(tasks),
        "liboliphaunt_native_desktop_runtime_matrix": (
            liboliphaunt_native_desktop_runtime_matrix(
                os.environ.get("NATIVE_TARGET", "all"),
                selected_native_targets,
            )
            if "liboliphaunt-native-desktop" in jobs
            else empty_matrix()
        ),
        "liboliphaunt_native_android_runtime_matrix": (
            liboliphaunt_native_android_runtime_matrix(
                os.environ.get("NATIVE_TARGET", "all"),
                selected_native_targets,
            )
            if "liboliphaunt-native-android" in jobs
            else empty_matrix()
        ),
        "liboliphaunt_native_ios_runtime_matrix": (
            liboliphaunt_native_ios_runtime_matrix(
                os.environ.get("NATIVE_TARGET", "all"),
                selected_native_targets,
            )
            if "liboliphaunt-native-ios" in jobs
            else empty_matrix()
        ),
        "extension_artifacts_native_matrix": (
            extension_artifacts_native_matrix(
                os.environ.get("NATIVE_TARGET", "all"),
                selected_native_targets if "extension-packages" not in jobs else None,
                selected_extension_products,
            )
            if "extension-artifacts-native" in jobs
            else empty_matrix()
        ),
        "extension_artifacts_wasix_matrix": (
            extension_artifacts_wasix_matrix("all", selected_extension_products)
            if "extension-artifacts-wasix" in jobs
            else empty_matrix()
        ),
        "liboliphaunt_wasix_aot_runtime_matrix": (
            liboliphaunt_wasix_aot_runtime_matrix(os.environ.get("WASM_TARGET", "all"))
            if "liboliphaunt-wasix-aot" in jobs
            else empty_matrix()
        ),
        "extension_package_products": sorted(selected_extension_products or []),
        "extension_package_products_csv": ",".join(sorted(selected_extension_products or [])),
        "mobile_extension_package_native_targets": mobile_extension_package_native_targets(jobs, selected_native_targets),
        "mobile_extension_package_native_targets_csv": ",".join(
            mobile_extension_package_native_targets(jobs, selected_native_targets)
        ),
        "react_native_android_mobile_app_matrix": (
            react_native_android_mobile_app_matrix(
                os.environ.get("NATIVE_TARGET", "all"),
                selected_native_targets,
            )
            if "mobile-build-android" in jobs
            else empty_matrix()
        ),
        "broker_runtime_matrix": (
            broker_runtime_matrix(os.environ.get("NATIVE_TARGET", "all"))
            if "broker-runtime" in jobs
            else empty_matrix()
        ),
        "node_direct_runtime_matrix": (
            node_direct_runtime_matrix(os.environ.get("NATIVE_TARGET", "all"))
            if "node-direct" in jobs
            else empty_matrix()
        ),
        "reason": reason,
    }
    write_plan_artifact(plan)
    for name, value in plan.items():
        output(name, value)
    return 0


if __name__ == "__main__":
    raise SystemExit(emit_github_outputs())
