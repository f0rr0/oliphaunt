#!/usr/bin/env python3
from __future__ import annotations

import json
import re
import os
import pathlib
import subprocess
import sys
import tomllib


ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools/release"))
sys.path.insert(0, str(ROOT / "tools/graph"))

import ci_plan  # noqa: E402
import artifact_targets  # noqa: E402
import product_metadata  # noqa: E402
import release_plan  # noqa: E402


BASE_PRODUCTS = {
    "liboliphaunt-native",
    "liboliphaunt-wasix",
    "oliphaunt-rust",
    "oliphaunt-broker",
    "oliphaunt-node-direct",
    "oliphaunt-swift",
    "oliphaunt-kotlin",
    "oliphaunt-react-native",
    "oliphaunt-js",
    "oliphaunt-wasix-rust",
}
CONSUMER_SHAPE_PRODUCTS_FIXTURE = "src/shared/fixtures/consumer-shape/products.json"


def fail(message: str) -> None:
    raise SystemExit(message)


def read_text(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def read_toml(path: pathlib.Path) -> dict:
    with path.open("rb") as handle:
        return tomllib.load(handle)


def extension_product_id(sql_name: str) -> str:
    return "oliphaunt-extension-" + sql_name.replace("_", "-").lower()


def expected_extension_products_from_sdk_catalog() -> set[str]:
    data = json.loads(read_text("src/extensions/generated/sdk/rust.json"))
    rows = data.get("extensions")
    if not isinstance(rows, list) or not rows:
        fail("generated Rust extension catalog must define public extensions")
    products = set()
    for row in rows:
        if not isinstance(row, dict):
            fail("generated Rust extension catalog rows must be objects")
        sql_name = row.get("sql-name")
        if not isinstance(sql_name, str) or not sql_name:
            fail("generated Rust extension catalog rows must declare sql-name")
        products.add(extension_product_id(sql_name))
    return products


def expected_contrib_extension_products_from_manifest() -> set[str]:
    data = read_toml(ROOT / "src/extensions/contrib/postgres18.toml")
    rows = data.get("extensions")
    if not isinstance(rows, list) or not rows:
        fail("PostgreSQL contrib extension manifest must define extension rows")
    products = set()
    for row in rows:
        if not isinstance(row, dict):
            fail("PostgreSQL contrib extension manifest rows must be tables")
        sql_name = row.get("sql-name")
        if not isinstance(sql_name, str) or not sql_name:
            fail("PostgreSQL contrib extension manifest rows must declare sql-name")
        products.add(extension_product_id(sql_name))
    return products


def expected_products() -> set[str]:
    return BASE_PRODUCTS | expected_extension_products_from_sdk_catalog()


def moon_projects() -> dict[str, dict]:
    moon_bin = os.environ.get("MOON_BIN")
    if moon_bin is None:
        proto_moon = pathlib.Path.home() / ".proto/bin/moon"
        moon_bin = str(proto_moon) if proto_moon.exists() else "moon"
    output = subprocess.check_output(
        [moon_bin, "query", "projects"],
        cwd=ROOT,
        text=True,
    )
    projects = json.loads(output).get("projects")
    if not isinstance(projects, list):
        fail("moon query projects did not return a projects array")
    return {project["id"]: project for project in projects}


def project_release_metadata(project: dict) -> dict | None:
    config = project.get("config") if isinstance(project.get("config"), dict) else {}
    project_config = config.get("project") if isinstance(config.get("project"), dict) else {}
    metadata = project_config.get("metadata") if isinstance(project_config.get("metadata"), dict) else {}
    release = metadata.get("release") if isinstance(metadata, dict) else None
    if isinstance(release, dict):
        return release
    release = project_config.get("release")
    return release if isinstance(release, dict) else None


def assert_no_file(path: str) -> None:
    if (ROOT / path).exists():
        fail(f"{path} must not exist; Moon is the only dependency/affectedness graph")


def assert_contains(path: str, snippet: str, message: str) -> None:
    if snippet not in read_text(path):
        fail(message)


def workflow_job_blocks(path: str) -> dict[str, str]:
    text = read_text(path)
    jobs_section = text.split("\njobs:\n", 1)[1] if "\njobs:\n" in text else ""
    if not jobs_section:
        fail(f"{path} must declare a jobs section")
    matches = list(re.finditer(r"^  ([A-Za-z0-9_-]+):\n", jobs_section, flags=re.MULTILINE))
    if not matches:
        fail(f"{path} parser found no jobs")
    blocks: dict[str, str] = {}
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(jobs_section)
        blocks[match.group(1)] = jobs_section[match.start():end]
    return blocks


def workflow_step_blocks(job_block: str) -> dict[str, str]:
    matches = list(re.finditer(r"^      - name: (.+)\n", job_block, flags=re.MULTILINE))
    blocks: dict[str, str] = {}
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(job_block)
        name = match.group(1).strip()
        blocks[name] = job_block[match.start():end]
    return blocks


def workflow_job_needs(blocks: dict[str, str], job: str) -> set[str]:
    block = blocks.get(job)
    if block is None:
        fail(f"CI workflow is missing job {job}")
    match = re.search(r"(?ms)^    needs:\n(?P<body>(?:      - [A-Za-z0-9_-]+\n)+)", block)
    if match is None:
        return set()
    return {
        line.removeprefix("      - ").strip()
        for line in match.group("body").splitlines()
        if line.strip()
    }


def assert_job_contains(blocks: dict[str, str], job: str, snippet: str, message: str) -> None:
    block = blocks.get(job)
    if block is None:
        fail(f"CI workflow is missing job {job}")
    if snippet not in block:
        fail(message)


def assert_step_contains(steps: dict[str, str], step: str, snippet: str, message: str) -> None:
    block = steps.get(step)
    if block is None:
        fail(f"workflow is missing step {step!r}")
    if snippet not in block:
        fail(message)


def assert_step_if_contains_publish_guard(steps: dict[str, str], step: str) -> None:
    block = steps.get(step)
    if block is None:
        fail(f"workflow is missing step {step!r}")
    if "inputs.operation == 'publish'" not in block:
        fail(f"{step!r} must be guarded by inputs.operation == 'publish'")


def normalized_shell(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def assert_text_order(text: str, snippets: list[str], message: str) -> None:
    index = -1
    for snippet in snippets:
        next_index = text.find(snippet, index + 1)
        if next_index == -1:
            fail(f"{message}: missing {snippet!r}")
        index = next_index


def check_release_metadata(graph: dict) -> None:
    products = graph.get("products")
    if not isinstance(products, dict):
        fail("release metadata must define products")
    if set(products) != expected_products():
        fail(f"release product set mismatch: expected {sorted(expected_products())}, got {sorted(products)}")
    modeled_extension_products = {
        product
        for product in product_metadata.product_ids(graph)
        if product_metadata.product_config(product, graph).get("kind") == "exact-extension-artifact"
    }
    expected_extension_products = expected_extension_products_from_sdk_catalog()
    if modeled_extension_products != expected_extension_products:
        fail(
            "exact-extension release products must match the public generated extension catalog: "
            f"expected {sorted(expected_extension_products)}, got {sorted(modeled_extension_products)}"
        )

    projects = moon_projects()
    for product, config in products.items():
        release_path = ROOT / config["path"] / "release.toml"
        raw = read_toml(release_path)
        for forbidden in ("depends_on", "source_globs", "package_visible_globs"):
            if forbidden in raw:
                fail(f"{release_path.relative_to(ROOT)} must not declare {forbidden}; Moon owns graph shape")
        for key in ("id", "owner", "kind", "publish_targets", "release_artifacts"):
            if key not in raw:
                fail(f"{release_path.relative_to(ROOT)} must declare {key}")
        if not config.get("tag_prefix") or not config.get("version_files") or not config.get("changelog_path"):
            fail(f"{product} must have release-please tag/version/changelog metadata")

        project_id = release_plan.release_product_project_id(product, products, graph["moon_projects"])
        project = projects.get(project_id)
        if project is None:
            fail(f"{product} has no owning Moon project")
        tags = set(project.get("config", {}).get("tags", []))
        if "release-product" not in tags:
            fail(f"{project_id} must be tagged release-product")
        release = project_release_metadata(project)
        if release is None:
            fail(f"{project_id} must declare project.release metadata")
        if release.get("component") != product:
            fail(f"{project_id} release component expected {product}, got {release.get('component')}")
        if release.get("packagePath") != config.get("path"):
            fail(f"{project_id} packagePath expected {config.get('path')}, got {release.get('packagePath')}")


def check_release_planning(graph: dict) -> None:
    contains_cases = {
        "src/shared/js-core/src/query.ts": {"oliphaunt-js", "oliphaunt-react-native"},
        "src/postgres/versions/18/source.toml": {
            "liboliphaunt-native",
            "liboliphaunt-wasix",
            "oliphaunt-rust",
            "oliphaunt-swift",
            "oliphaunt-kotlin",
            "oliphaunt-react-native",
            "oliphaunt-js",
            "oliphaunt-wasix-rust",
        },
        "src/extensions/contrib/postgres18.toml": expected_contrib_extension_products_from_manifest(),
    }
    for path, expected in contains_cases.items():
        plan = release_plan.build_plan(graph, [path])
        actual = set(plan.get("releaseProducts", []))
        if not expected <= actual:
            fail(f"{path} release plan expected at least {sorted(expected)}, got {sorted(actual)}")

    exact_cases = {
        "src/extensions/contrib/amcheck/release.toml": {"oliphaunt-extension-amcheck"},
        "src/extensions/external/vector/source.toml": {"oliphaunt-extension-vector"},
        "src/shared/fixtures/protocol/query-response-cases.json": set(),
        "docs/maintainers/release.md": set(),
    }
    for path, expected in exact_cases.items():
        plan = release_plan.build_plan(graph, [path])
        actual = set(plan.get("releaseProducts", []))
        if actual != expected:
            fail(f"{path} release plan expected exactly {sorted(expected)}, got {sorted(actual)}")


def check_ci_policy() -> None:
    assert_no_file("tools/graph/jobs.toml")
    assert_no_file("tools/release/release-inputs.toml")
    ci = read_text(".github/workflows/ci.yml")
    for forbidden in ("targets=(", "tools/graph/jobs.toml", "tools/release/release-inputs.toml"):
        if forbidden in ci:
            fail(f"CI workflow must not contain {forbidden}")
    assert_contains("tools/graph/ci_plan.py", "moon([\"query\", \"tasks\"])", "CI planner must read Moon task tags")
    assert_contains("tools/graph/ci_plan.py", "ci-<job-id>", "CI planner must document ci-* task tags")
    assert_contains(
        "tools/graph/ci_plan.py",
        "extension_package_products_csv",
        "CI planner must emit selected exact-extension products for artifact package builders",
    )
    assert_contains(
        ".github/workflows/ci.yml",
        "OLIPHAUNT_EXTENSION_PACKAGE_PRODUCTS",
        "CI extension package builders must consume selected exact-extension products from the affected plan",
    )
    assert_contains(
        "tools/release/build-extension-ci-artifacts.py",
        "OLIPHAUNT_EXTENSION_PACKAGE_PRODUCTS",
        "exact-extension package builder must support selected product subsets",
    )
    assert_contains(
        ".github/scripts/select-planned-moon-targets.mjs",
        "OLIPHAUNT_CI_JOB_TARGETS_JSON",
        "CI product jobs must consume planned Moon targets through the Bun selector",
    )
    if not ci_plan.CI_JOB_TARGETS:
        fail("CI planner found no Moon ci-* task tags")
    if "liboliphaunt-wasix-aot-targets" in ci_plan.BUILDER_JOBS:
        fail("builder_jobs must contain artifact-producing jobs, not the WASIX AOT target planner")

    workflow_blocks = workflow_job_blocks(".github/workflows/ci.yml")
    workflow_jobs = set(workflow_blocks)
    if not workflow_jobs:
        fail("CI workflow parser found no jobs")
    moon_jobs = set(ci_plan.CI_JOB_TARGETS)
    builder_moon_jobs = moon_jobs & ci_plan.BUILDER_JOBS
    no_moon_target_jobs = {
        "affected",
        "checks",
        "tests",
        "builds",
        "required",
    }
    allowed_workflow_jobs = builder_moon_jobs | no_moon_target_jobs
    missing_workflow_jobs = sorted(ci_plan.BUILDER_JOBS - workflow_jobs)
    if missing_workflow_jobs:
        fail(f"builder Moon ci-* tags have no CI workflow job: {missing_workflow_jobs}")
    untagged_workflow_jobs = sorted(workflow_jobs - allowed_workflow_jobs)
    if untagged_workflow_jobs:
        fail(f"CI workflow must only define phase gates, builder jobs, and aggregate exceptions: {untagged_workflow_jobs}")
    non_builder_workflow_jobs = sorted((moon_jobs - ci_plan.BUILDER_JOBS) & workflow_jobs)
    if non_builder_workflow_jobs:
        fail(f"CI workflow must not define non-builder Moon jobs as dedicated artifact build jobs: {non_builder_workflow_jobs}")

    required_match = re.search(r"(?ms)^  required:\n.*?^    needs:\n(?P<body>(?:      - [A-Za-z0-9_-]+\n)+)", ci)
    if required_match is None:
        fail("CI workflow required job must declare a static needs list")
    required_needs = {
        line.removeprefix("      - ").strip()
        for line in required_match.group("body").splitlines()
        if line.strip()
    }
    if required_needs != {"affected", "checks", "tests", "builds"}:
        fail(f"required.needs must be the CI phase gates only: ['affected', 'checks', 'tests', 'builds']; got {sorted(required_needs)}")

    builds_match = re.search(r"(?ms)^  builds:\n.*?^    needs:\n(?P<body>(?:      - [A-Za-z0-9_-]+\n)+)", ci)
    if builds_match is None:
        fail("CI workflow builds job must declare a static needs list")
    builds_needs = {
        line.removeprefix("      - ").strip()
        for line in builds_match.group("body").splitlines()
        if line.strip()
    }
    missing_builders = sorted(ci_plan.BUILDER_JOBS - builds_needs)
    if missing_builders:
        fail(f"builds.needs is missing builder jobs: {missing_builders}")
    if "tests" not in builds_needs:
        fail("builds.needs must include tests so artifact aggregation cannot race the test phase")

    planned_job_invocations = set(
        match.group(1)
        for match in re.finditer(r"run-planned-moon-job[.]sh ([A-Za-z0-9_-]+)", ci)
    )
    missing_planned_invocations = sorted(builder_moon_jobs - planned_job_invocations)
    if missing_planned_invocations:
        fail(f"builder workflow jobs do not consume planned Moon targets: {missing_planned_invocations}")
    for line_number, line in enumerate(ci.splitlines(), start=1):
        match = re.search(r"run-planned-moon-job[.]sh ([A-Za-z0-9_-]+)", line)
        if match is None:
            continue
        job = match.group(1)
        if job in ci_plan.BUILDER_JOBS and "MOON_CACHE=off" not in line:
            fail(f"builder job {job} must disable Moon cache in CI at .github/workflows/ci.yml:{line_number}")
        if job in ci_plan.BUILDER_JOBS and "OLIPHAUNT_MOON_UPSTREAM=none" not in line:
            fail(
                f"builder job {job} must not run upstream Moon checks in CI "
                f"at .github/workflows/ci.yml:{line_number}"
            )

    expected_mobile_build_needs = {
        "mobile-build-android": {
            "affected",
            "tests",
            "mobile-extension-packages",
            "liboliphaunt-native-android",
            "kotlin-sdk-package",
            "react-native-sdk-package",
        },
        "mobile-build-ios": {
            "affected",
            "tests",
            "mobile-extension-packages",
            "liboliphaunt-native-ios",
            "react-native-sdk-package",
            "swift-sdk-package",
        },
    }
    for job, expected in expected_mobile_build_needs.items():
        actual = workflow_job_needs(workflow_blocks, job)
        if actual != expected:
            fail(f"{job}.needs must consume staged runtime, SDK, and exact-extension builders: expected {sorted(expected)}, got {sorted(actual)}")
        for snippet in (
            "OLIPHAUNT_EXPO_ALLOW_NATIVE_BUILDS: \"0\"",
            "OLIPHAUNT_EXPO_REQUIRE_SDK_ARTIFACTS: \"1\"",
            "OLIPHAUNT_EXPO_REQUIRE_PREBUILT_EXTENSIONS: \"1\"",
            "OLIPHAUNT_EXPO_EXTENSION_ARTIFACT_ROOT:",
            "oliphaunt-mobile-extension-package-artifacts",
            "--require-mobile-prebuilt-extensions",
        ):
            assert_job_contains(workflow_blocks, job, snippet, f"{job} must use staged SDK/runtime/exact-extension artifacts and reject source-build fallbacks")
    assert_job_contains(
        workflow_blocks,
        "mobile-build-android",
        "OLIPHAUNT_EXPO_ANDROID_BUILD_TYPE: release",
        "Android mobile app builder must publish the same release-mode artifact that installed-app E2E consumes",
    )
    assert_job_contains(
        workflow_blocks,
        "mobile-build-ios",
        "OLIPHAUNT_EXPO_IOS_CONFIGURATION: Release",
        "iOS mobile app builder must publish the same release-mode artifact that installed-app E2E consumes",
    )
    assert_job_contains(
        workflow_blocks,
        "mobile-build-ios",
        "OLIPHAUNT_EXPO_IOS_SDK: iphonesimulator",
        "iOS mobile app builder must publish a simulator artifact for free installed-app E2E",
    )

    android_build = workflow_blocks["mobile-build-android"]
    for snippet in (
        "matrix: ${{ fromJson(needs.affected.outputs.react_native_android_mobile_app_matrix) }}",
        "liboliphaunt-native-target-${{ matrix.target }}",
        "OLIPHAUNT_EXPO_ANDROID_ABI: ${{ matrix.abi }}",
        "oliphaunt-kotlin-sdk-package-artifacts",
        "oliphaunt-react-native-sdk-package-artifacts",
        "react-native-mobile-android-app-${{ matrix.target }}",
    ):
        if snippet not in android_build:
            fail(f"mobile-build-android must download/upload {snippet}")
    for path, snippet, message in (
        (
            "src/sdks/react-native/android/build.gradle",
            "OLIPHAUNT_ANDROID_LINK_EVIDENCE_FILE",
            "React Native Android Gradle packaging must pass static-extension link evidence into CMake",
        ),
        (
            "src/sdks/react-native/android/src/main/cpp/CMakeLists.txt",
            "oliphaunt-android-static-extension-link-v1",
            "React Native Android CMake packaging must emit deterministic static-extension link evidence",
        ),
        (
            "src/sdks/react-native/tools/expo-android-runner.sh",
            "androidLinkEvidence",
            "React Native Android mobile build reports must include static-extension link evidence",
        ),
        (
            "tools/release/check_staged_artifacts.py",
            "check_android_prebuilt_extension_linkage",
            "staged mobile artifact checks must validate Android static-extension link evidence",
        ),
    ):
        if snippet not in read_text(path):
            fail(message)

    ios_build = workflow_blocks["mobile-build-ios"]
    for snippet in (
        "liboliphaunt-native-target-ios-xcframework",
        "oliphaunt-swift-sdk-package-artifacts",
        "oliphaunt-react-native-sdk-package-artifacts",
        "react-native-mobile-ios-app",
    ):
        if snippet not in ios_build:
            fail(f"mobile-build-ios must download/upload {snippet}")

    wasix_extension_packager = read_text("src/extensions/artifacts/wasix/tools/package-release-assets.sh")
    if "--strict-generated" in wasix_extension_packager:
        fail("WASIX exact-extension packaging must consume portable runtime outputs; strict generation checks belong to the portable runtime builder")

    mobile_e2e = read_text(".github/workflows/mobile-e2e.yml")
    for snippet in (
        'name: Mobile E2E',
        'workflows: ["CI"]',
        'BUILD_GATE_JOB: builds',
        'bun .github/scripts/resolve-mobile-e2e.mjs',
        'bun .github/scripts/check-ci-gate.mjs allow-skipped',
        'react-native-mobile-android-app-android-x86_64',
        'react-native-mobile-ios-app',
        'uses: ./.github/actions/setup-maestro',
        'tools/dev/start-android-emulator-ci.sh',
        'bash src/sdks/react-native/tools/mobile-e2e.sh android',
        'bash src/sdks/react-native/tools/mobile-e2e.sh ios',
        'OLIPHAUNT_EXPO_ANDROID_BUILD_TYPE: release',
        'OLIPHAUNT_EXPO_IOS_CONFIGURATION: Release',
        'OLIPHAUNT_EXPO_IOS_SDK: iphonesimulator',
    ):
        if snippet not in mobile_e2e:
            fail(f"Mobile E2E workflow must consume built app artifacts with pinned installed-app tooling: missing {snippet}")
    for forbidden in (
        "run-planned-moon-job.sh",
        "mobile-build:android",
        "mobile-build:ios",
        "tools/mobile-build.sh",
        "OLIPHAUNT_EXPO_ALLOW_NATIVE_BUILDS",
    ):
        if forbidden in mobile_e2e:
            fail(f"Mobile E2E workflow must not rebuild source artifacts or invoke builder tasks: {forbidden}")

    release_workflow_blocks = workflow_job_blocks(".github/workflows/release.yml")
    release_tool_patterns = ("tools/release/release.py", "tools/release/artifact_target_matrix.py")
    missing_moon_setup = sorted(
        job
        for job, block in release_workflow_blocks.items()
        if any(pattern in block for pattern in release_tool_patterns)
        and "./.github/actions/setup-moon" not in block
    )
    if missing_moon_setup:
        fail(f"release workflow jobs invoke release metadata without setup-moon: {missing_moon_setup}")

    if not (ROOT / CONSUMER_SHAPE_PRODUCTS_FIXTURE).is_file():
        fail(f"missing consumer shape fixture: {CONSUMER_SHAPE_PRODUCTS_FIXTURE}")


def check_release_workflow_policy() -> None:
    release_blocks = workflow_job_blocks(".github/workflows/release.yml")
    publish_block = release_blocks.get("publish")
    if publish_block is None:
        fail("Release workflow must define a publish job")
    publish_steps = workflow_step_blocks(publish_block)

    for permission in (
        "actions: read",
        "attestations: write",
        "contents: write",
        "id-token: write",
    ):
        if permission not in publish_block:
            fail(f"Release publish job must declare {permission}")

    assert_text_order(
        publish_block,
        [
            "Require same-SHA CI build gate",
            "Download WASIX runtime build artifacts",
            "Download WASIX release assets",
            "Download exact-extension package artifacts",
            "Download SDK package artifacts",
            "Download liboliphaunt release assets",
            "Download native helper release assets",
            "Download Node direct optional npm packages",
            "Validate selected release product dry-runs",
        ],
        "Release dry-run must validate same-SHA builder outputs before product dry-runs",
    )

    for snippet in (
        "id: ci_build_gate",
        'require-workflow-success.sh CI "$GITHUB_SHA" 7200 --job builds',
        "CI_RUN_ID: ${{ steps.ci_build_gate.outputs.run_id }}",
        "--run-id \"$CI_RUN_ID\"",
        "--run-id \"${CI_RUN_ID}\"",
        "--job builds",
        "--artifact liboliphaunt-wasix-release-assets",
        "--artifact oliphaunt-extension-package-artifacts",
        "--artifact liboliphaunt-native-release-assets",
        "--artifact \"$artifact\"",
        "download_sdk_artifact oliphaunt-rust oliphaunt-rust-sdk-package-artifacts",
        "download_sdk_artifact oliphaunt-swift oliphaunt-swift-sdk-package-artifacts",
        "download_sdk_artifact oliphaunt-kotlin oliphaunt-kotlin-sdk-package-artifacts",
        "download_sdk_artifact oliphaunt-react-native oliphaunt-react-native-sdk-package-artifacts",
        "download_sdk_artifact oliphaunt-js oliphaunt-js-sdk-package-artifacts",
        "download_sdk_artifact oliphaunt-wasix-rust oliphaunt-wasix-rust-package-artifacts",
        "--artifact oliphaunt-node-direct-npm-package-macos-arm64",
        "target/oliphaunt-broker/release-assets",
        "target/oliphaunt-node-direct/release-assets",
        "tools/release/release.py publish-dry-run --products-json",
    ):
        if snippet not in publish_block:
            fail(f"Release workflow dry-run handoff is missing {snippet!r}")
    if "target/release-assets/native" in publish_block:
        fail("Release workflow must download native helper artifacts into product-owned release asset roots")

    download_calls = list(re.finditer(r"[.]github/scripts/download-build-artifacts[.]sh", publish_block))
    if not download_calls:
        fail("Release workflow must download staged builder artifacts from the CI workflow")
    for index, call in enumerate(download_calls):
        next_call = download_calls[index + 1].start() if index + 1 < len(download_calls) else -1
        next_step = publish_block.find("\n      - name:", call.end())
        end_candidates = [candidate for candidate in (next_call, next_step) if candidate != -1]
        end = min(end_candidates) if end_candidates else len(publish_block)
        call_text = normalized_shell(publish_block[call.start():end])
        # Every release artifact download must come from the same-SHA CI
        # workflow and the builds aggregate, even when wrapped in shell
        # helper functions.
        for required in ("CI", '"$GITHUB_SHA"', "--run-id", "--job builds", "--artifact"):
            if required not in call_text:
                fail(f"Release artifact download must require {required}: {call_text[:240]}")

    build_artifact_script = read_text(".github/scripts/download-build-artifacts.sh")
    for snippet in (
        "--run-id",
        "selected_run_id",
        'required_job_success "$run_id"',
        'artifact_present "$run_id" "$artifact"',
    ):
        if snippet not in build_artifact_script:
            fail(f"shared CI artifact downloader must support and verify pinned run ids: missing {snippet!r}")

    require_workflow_script = read_text(".github/scripts/require-workflow-success.sh")
    for snippet in ("--run-id", "GITHUB_OUTPUT", "run_id=", 'emit_run_id "$run_id"'):
        if snippet not in require_workflow_script:
            fail(f"CI build gate must emit and validate selected run ids: missing {snippet!r}")

    wasix_download_script = read_text(".github/scripts/download-wasix-runtime-build-artifacts.sh")
    for snippet in ("CI_RUN_ID", '--run-id "$CI_RUN_ID"', "--required-job builds"):
        if snippet not in wasix_download_script:
            fail(f"WASIX runtime artifact handoff must consume the selected CI run id: missing {snippet!r}")

    guarded_publish_steps = {
        "Create release-please GitHub releases",
        "Publish liboliphaunt GitHub release assets",
        "Publish selected extension GitHub release assets",
        "Attest selected extension release assets",
        "Attest liboliphaunt release assets",
        "Publish Swift SDK GitHub release and SwiftPM tags",
        "Publish Kotlin SDK to Maven Central",
        "Publish React Native package to npm",
        "Publish WASIX runtime crates to crates.io",
        "Publish WASIX Rust binding to crates.io",
        "Publish Rust SDK to crates.io",
        "Publish broker GitHub release assets",
        "Attest broker release assets",
        "Publish Node direct GitHub release assets",
        "Attest Node direct release assets",
        "Publish Node direct optional packages to npm",
        "Publish TypeScript packages to npm and JSR",
        "Upload WASIX GitHub release assets",
        "Attest WASIX release assets",
        "Verify published release",
        "Run consumer shape gates",
    }
    for step in guarded_publish_steps:
        assert_step_if_contains_publish_guard(publish_steps, step)

    attestation_requirements = {
        "Attest selected extension release assets": [
            "actions/attest-build-provenance@",
            "target/extension-artifacts/*/release-assets/*.tar.gz",
            "target/extension-artifacts/*/release-assets/*.tar.zst",
            "target/extension-artifacts/*/release-assets/*.zip",
            "target/extension-artifacts/*/release-assets/*.json",
            "target/extension-artifacts/*/release-assets/*.properties",
            "target/extension-artifacts/*/release-assets/*.sha256",
        ],
        "Attest liboliphaunt release assets": [
            "actions/attest-build-provenance@",
            "target/liboliphaunt/release-assets/*.tar.gz",
            "target/liboliphaunt/release-assets/*.tar.zst",
            "target/liboliphaunt/release-assets/*.zip",
            "target/liboliphaunt/release-assets/*.tsv",
            "target/liboliphaunt/release-assets/*.sha256",
        ],
        "Attest broker release assets": [
            "actions/attest-build-provenance@",
            "target/oliphaunt-broker/release-assets/*.tar.gz",
            "target/oliphaunt-broker/release-assets/*.zip",
            "target/oliphaunt-broker/release-assets/*.sha256",
        ],
        "Attest Node direct release assets": [
            "actions/attest-build-provenance@",
            "target/oliphaunt-node-direct/release-assets/*.tar.gz",
            "target/oliphaunt-node-direct/release-assets/*.zip",
            "target/oliphaunt-node-direct/release-assets/*.sha256",
        ],
        "Attest WASIX release assets": [
            "actions/attest-build-provenance@",
            "target/oliphaunt-wasix/release-assets/*.tar.zst",
            "target/oliphaunt-wasix/release-assets/*.sha256",
        ],
    }
    for step, snippets in attestation_requirements.items():
        for snippet in snippets:
            assert_step_contains(publish_steps, step, snippet, f"{step} must attest {snippet}")

    assert_step_contains(
        publish_steps,
        "Verify published release",
        "tools/release/release.py verify-release --products-json",
        "Release workflow must verify published products through the release CLI",
    )
    assert_contains(
        "tools/release/release.py",
        "tools/release/verify_github_release_attestations.py",
        "release.py verify-release must verify GitHub artifact attestations",
    )
    for snippet in (
        "--signer-workflow",
        ".github/workflows/release.yml",
        "--source-ref",
        "refs/heads/main",
        "--deny-self-hosted-runners",
    ):
        assert_contains(
            "tools/release/verify_github_release_attestations.py",
            snippet,
            "Release attestation verification must pin signer workflow, source ref, and runner trust",
        )


def extension_native_targets(jobs: set[str], tasks: set[str]) -> set[str]:
    selected_targets = ci_plan.native_target_subset_for_jobs(jobs, tasks)
    matrix = ci_plan.extension_artifacts_native_matrix("all", selected_targets)
    include = matrix.get("include")
    if not isinstance(include, list):
        fail("native extension artifact matrix must declare include rows")
    targets = {row.get("target") for row in include if isinstance(row, dict)}
    if not all(isinstance(target, str) for target in targets):
        fail("native extension artifact matrix rows must declare string target")
    return set(targets)


def assert_single_extension_matrix_selection(product: str) -> None:
    jobs = ci_plan.plan_jobs_for_affected(
        {product},
        {f"{product}:assemble-release"},
    )
    selection = ci_plan.selected_extension_products_for_plan(
        {product},
        {f"{product}:assemble-release"},
        jobs,
    )
    if selection != {product}:
        fail(f"single exact-extension changes must narrow extension artifact matrices, got {sorted(selection or [])}")
    native_matrix = ci_plan.extension_artifacts_native_matrix(
        "all",
        None,
        selection,
    )
    matrix_products = {
        item
        for row in native_matrix.get("include", [])
        if isinstance(row, dict)
        for item in str(row.get("extensions_csv", "")).split(",")
        if item
    }
    if matrix_products != {product}:
        fail(f"single exact-extension native matrix must include only {product}, got {sorted(matrix_products)}")

    aggregate_tasks = {
        f"{product}:assemble-release",
        "extension-artifacts-native:build-target",
        "extension-artifacts-wasix:build-target",
        "extension-packages:assemble-release",
    }
    aggregate_jobs = ci_plan.plan_jobs_for_affected({product}, aggregate_tasks)
    aggregate_selection = ci_plan.selected_extension_products_for_plan(
        {product},
        aggregate_tasks,
        aggregate_jobs,
    )
    if aggregate_selection != {product}:
        fail(
            "single exact-extension changes must stay product-scoped even when aggregate artifact/package tasks are selected, "
            f"got {sorted(aggregate_selection or [])}"
        )
    aggregate_native_products = {
        item
        for row in ci_plan.extension_artifacts_native_matrix("all", None, aggregate_selection).get("include", [])
        if isinstance(row, dict)
        for item in str(row.get("extensions_csv", "")).split(",")
        if item
    }
    if aggregate_native_products != {product}:
        fail(
            f"single exact-extension aggregate native matrix must include only {product}, got {sorted(aggregate_native_products)}"
        )
    aggregate_wasix_products = {
        item
        for row in ci_plan.extension_artifacts_wasix_matrix("all", aggregate_selection).get("include", [])
        if isinstance(row, dict)
        for item in str(row.get("extensions_csv", "")).split(",")
        if item
    }
    if aggregate_wasix_products != {product}:
        fail(
            f"single exact-extension aggregate WASIX matrix must include only {product}, got {sorted(aggregate_wasix_products)}"
        )


def check_ci_builder_planning() -> None:
    full_jobs, _projects, _tasks, _reason, _selected_targets = ci_plan.plan_for_full_run()
    allowed_full_non_builders = ci_plan.BASE_JOBS
    unexpected_full_jobs = sorted(full_jobs - ci_plan.BUILDER_JOBS - allowed_full_non_builders)
    if unexpected_full_jobs:
        fail(
            "full non-PR CI runs must select artifact-producing builder jobs only; "
            f"unexpected jobs: {unexpected_full_jobs}"
        )
    forbidden_full_jobs = sorted(
        full_jobs
        & {
            "coverage-summary",
            "docs",
            "js-regression",
            "mobile-e2e-android",
            "mobile-e2e-ios",
            "release-intent",
            "release-readiness",
            "repo",
            "rust-regression",
            "wasm-regression",
        }
    )
    if forbidden_full_jobs:
        fail(f"full non-PR CI runs must not select check/regression/policy jobs: {forbidden_full_jobs}")

    focused_wasix_jobs, _projects, _tasks, _reason, _targets = ci_plan.plan_for_full_run(
        wasm_target="linux-x64-gnu",
    )
    expected_focused_wasix_jobs = {
        "affected",
        "liboliphaunt-wasix-runtime",
        "liboliphaunt-wasix-aot",
    }
    if focused_wasix_jobs != expected_focused_wasix_jobs:
        fail(
            "focused WASIX target CI runs must build only the portable runtime and requested AOT target, "
            f"got {sorted(focused_wasix_jobs)}"
        )

    focused_mobile_expectations = {
        "android": {
            "affected",
            "extension-artifacts-native",
            "kotlin-sdk-package",
            "liboliphaunt-native-android",
            "mobile-build-android",
            "mobile-extension-packages",
            "react-native-sdk-package",
        },
        "ios": {
            "affected",
            "extension-artifacts-native",
            "liboliphaunt-native-ios",
            "mobile-build-ios",
            "mobile-extension-packages",
            "react-native-sdk-package",
            "swift-sdk-package",
        },
    }
    for target, expected_jobs in focused_mobile_expectations.items():
        focused_jobs, *_ = ci_plan.plan_for_full_run(mobile_target=target)
        if not expected_jobs <= focused_jobs:
            fail(
                f"focused {target} CI run is missing builder jobs: "
                f"expected at least {sorted(expected_jobs)}, got {sorted(focused_jobs)}"
            )
        focused_forbidden = focused_jobs & {"mobile-e2e-android", "mobile-e2e-ios"}
        if focused_forbidden:
            fail(
                f"focused {target} CI run must build app artifacts only, not E2E jobs: "
                f"{sorted(focused_forbidden)}"
            )

    android_arm_jobs, _projects, _tasks, _reason, android_arm_targets = ci_plan.plan_for_full_run(
        native_target="android-arm64-v8a",
        mobile_target="android",
    )
    if android_arm_targets != {"android-arm64-v8a"}:
        fail(
            "focused Android mobile CI run with native_target=android-arm64-v8a must narrow every "
            f"target-scoped builder to android-arm64-v8a, got {sorted(android_arm_targets or [])}"
        )
    if ci_plan.mobile_extension_package_native_targets(android_arm_jobs, android_arm_targets) != ["android-arm64-v8a"]:
        fail("focused Android mobile extension package targets must match the selected Android native target")

    ios_focused_jobs, _projects, _tasks, _reason, ios_focused_targets = ci_plan.plan_for_full_run(
        native_target="ios-xcframework",
        mobile_target="ios",
    )
    if ios_focused_targets != {"ios-xcframework"}:
        fail(
            "focused iOS mobile CI run with native_target=ios-xcframework must narrow every "
            f"target-scoped builder to ios-xcframework, got {sorted(ios_focused_targets or [])}"
        )
    if ci_plan.mobile_extension_package_native_targets(ios_focused_jobs, ios_focused_targets) != ["ios-xcframework"]:
        fail("focused iOS mobile extension package targets must match the selected iOS native target")

    try:
        ci_plan.plan_for_full_run(native_target="ios-xcframework", mobile_target="android")
    except RuntimeError as error:
        if "not valid for mobile_target=android" not in str(error):
            fail(f"focused Android/iOS target mismatch failed with an unclear error: {error}")
    else:
        fail("focused Android mobile CI run must reject native_target=ios-xcframework")

    try:
        ci_plan.plan_for_full_run(native_target="android-arm64-v8a", mobile_target="both")
    except RuntimeError as error:
        if "mobile_target=both requires native_target=all" not in str(error):
            fail(f"focused mobile_target=both mismatch failed with an unclear error: {error}")
    else:
        fail("focused mobile_target=both must reject a single native target")

    react_native_jobs = ci_plan.plan_jobs_for_affected(
        set(),
        {"oliphaunt-react-native:package-artifacts"},
    )
    react_native_expected_jobs = {
        "extension-artifacts-native",
        "kotlin-sdk-package",
        "liboliphaunt-native-android",
        "liboliphaunt-native-ios",
        "mobile-build-android",
        "mobile-build-ios",
        "mobile-extension-packages",
        "react-native-sdk-package",
        "swift-sdk-package",
    }
    if not react_native_expected_jobs <= react_native_jobs:
        fail(
            "React Native SDK package changes must build both mobile app artifacts from staged SDK/runtime/extension inputs; "
            f"missing {sorted(react_native_expected_jobs - react_native_jobs)} from {sorted(react_native_jobs)}"
        )
    react_native_targets = ci_plan.native_target_subset_for_jobs(
        react_native_jobs,
        {"oliphaunt-react-native:package-artifacts"},
    )
    expected_react_native_targets = {"android-arm64-v8a", "android-x86_64", "ios-xcframework"}
    if react_native_targets != expected_react_native_targets:
        fail(
            "React Native SDK package changes must request Android and iOS native runtime targets, "
            f"got {sorted(react_native_targets or [])}"
        )

    assert_single_extension_matrix_selection("oliphaunt-extension-vector")
    assert_single_extension_matrix_selection("oliphaunt-extension-amcheck")
    broad_selection = ci_plan.selected_extension_products_for_plan(
        {"extensions"},
        {"extension-packages:assemble-release"},
        {"extension-packages", "extension-artifacts-native", "extension-artifacts-wasix"},
    )
    all_extension_products = expected_extension_products_from_sdk_catalog()
    if broad_selection != all_extension_products:
        fail(
            "broad extension catalog changes must select the full exact-extension product set, "
            f"got {sorted(broad_selection or [])}"
        )

    full_builder_selection = ci_plan.selected_extension_products_for_plan(
        set(),
        {
            "extension-packages:assemble-release",
            "extension-packages:assemble-mobile",
            "oliphaunt-react-native:mobile-build-android",
            "oliphaunt-react-native:mobile-build-ios",
        },
        {
            "extension-artifacts-native",
            "extension-artifacts-wasix",
            "extension-packages",
            "mobile-build-android",
            "mobile-build-ios",
            "mobile-extension-packages",
        },
    )
    if full_builder_selection != all_extension_products:
        fail(
            "full builder runs must select the full exact-extension product set, "
            f"got {sorted(full_builder_selection or [])}"
        )

    mobile_focused_selection = ci_plan.selected_extension_products_for_plan(
        set(),
        {"oliphaunt-react-native:mobile-build-android"},
        {"mobile-build-android", "mobile-extension-packages", "extension-artifacts-native"},
    )
    if mobile_focused_selection != {"oliphaunt-extension-vector"}:
        fail(
            "focused mobile builder runs must build only the selected smoke extension, "
            f"got {sorted(mobile_focused_selection or [])}"
        )

    android_tasks = {"oliphaunt-react-native:mobile-build-android"}
    android_jobs = ci_plan.plan_jobs_for_affected(set(), android_tasks)
    if "extension-artifacts-native" not in android_jobs:
        fail("Android mobile build must build selected native extension artifacts")
    android_targets = extension_native_targets(android_jobs, android_tasks)
    if android_targets != {"android-arm64-v8a", "android-x86_64"}:
        fail(f"Android mobile build must only request Android extension artifacts, got {sorted(android_targets)}")

    android_e2e_jobs = ci_plan.plan_jobs_for_affected(set(), {"oliphaunt-react-native:mobile-e2e-android"})
    if android_e2e_jobs != ci_plan.BASE_JOBS:
        fail(f"CI must not select Android E2E jobs; got {sorted(android_e2e_jobs)}")

    ios_tasks = {"oliphaunt-react-native:mobile-build-ios"}
    ios_jobs = ci_plan.plan_jobs_for_affected(set(), ios_tasks)
    if "extension-artifacts-native" not in ios_jobs:
        fail("iOS mobile build must build selected native extension artifacts")
    ios_targets = extension_native_targets(ios_jobs, ios_tasks)
    if ios_targets != {"ios-xcframework"}:
        fail(f"iOS mobile build must only request iOS extension artifacts, got {sorted(ios_targets)}")

    ios_e2e_jobs = ci_plan.plan_jobs_for_affected(set(), {"oliphaunt-react-native:mobile-e2e-ios"})
    if ios_e2e_jobs != ci_plan.BASE_JOBS:
        fail(f"CI must not select iOS E2E jobs; got {sorted(ios_e2e_jobs)}")

    extension_tasks = {"extension-packages:assemble-release"}
    extension_jobs = ci_plan.plan_jobs_for_affected(set(), extension_tasks)
    full_targets = extension_native_targets(extension_jobs, extension_tasks)
    expected_full_targets = {
        target.target
        for target in artifact_targets.artifact_targets(
            product="liboliphaunt-native",
            kind="native-runtime",
            published_only=True,
        )
        if target.extension_artifacts
    }
    if full_targets != expected_full_targets:
        fail(f"extension package build must request all supported native extension artifacts, got {sorted(full_targets)}")

    swift_jobs = ci_plan.plan_jobs_for_affected(set(), {"oliphaunt-swift:package-artifacts"})
    if "liboliphaunt-native-ios" not in swift_jobs:
        fail("Swift SDK package build must build the Apple liboliphaunt XCFramework")
    swift_targets = ci_plan.native_target_subset_for_jobs(swift_jobs, {"oliphaunt-swift:package-artifacts"})
    if swift_targets != {"ios-xcframework"}:
        fail(f"Swift SDK package build must only request the Apple XCFramework runtime target, got {sorted(swift_targets or [])}")

    kotlin_jobs = ci_plan.plan_jobs_for_affected(set(), {"oliphaunt-kotlin:package-artifacts"})
    if kotlin_jobs != ci_plan.BASE_JOBS | {"kotlin-sdk-package"}:
        fail(f"Kotlin SDK package build must only package the Kotlin SDK, got {sorted(kotlin_jobs)}")

    rust_jobs = ci_plan.plan_jobs_for_affected(set(), {"oliphaunt-rust:package-artifacts"})
    if rust_jobs != ci_plan.BASE_JOBS | {"rust-sdk-package"}:
        fail(f"Rust SDK package build must only package the Rust SDK, got {sorted(rust_jobs)}")

    js_jobs = ci_plan.plan_jobs_for_affected(set(), {"oliphaunt-js:package-artifacts"})
    if js_jobs != ci_plan.BASE_JOBS | {"js-sdk-package"}:
        fail(f"TypeScript SDK package build must only package the TypeScript SDK, got {sorted(js_jobs)}")

    wasix_rust_jobs = ci_plan.plan_jobs_for_affected(set(), {"oliphaunt-wasix-rust:package-artifacts"})
    if wasix_rust_jobs != ci_plan.BASE_JOBS | {"wasix-rust-package"}:
        fail(f"WASIX Rust binding package build must only package the binding crate, got {sorted(wasix_rust_jobs)}")


def main() -> int:
    graph = release_plan.load_graph()
    policy = graph.get("policy")
    if not isinstance(policy, dict):
        fail("release metadata must define policy")
    if policy.get("repository") != "f0rr0/oliphaunt":
        fail("release policy repository must be f0rr0/oliphaunt")
    if policy.get("versioning") != "independent":
        fail("release policy must use independent versioning")

    check_release_metadata(graph)
    check_release_planning(graph)
    check_ci_policy()
    check_release_workflow_policy()
    check_ci_builder_planning()
    print("release policy checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
