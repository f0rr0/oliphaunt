#!/usr/bin/env python3
"""Validate Oliphaunt's target source architecture invariants.

This is a source architecture guard. It rejects retired product aliases and
validates the structured source/extension metadata that current products rely
on.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tomllib
from pathlib import Path
from typing import Any, NoReturn


ROOT = Path(__file__).resolve().parents[2]
EXTENSION_ID = re.compile(r"^[a-z][a-z0-9_]{0,127}$")
SQL_EXTENSION_NAME = re.compile(r"^[a-z][a-z0-9_-]{0,127}$")

CURRENT_SOURCE_DOMAINS = {
    "src/postgres/versions/18",
    "src/sources",
    "src/extensions",
    "src/shared",
}

CURRENT_SOURCE_DOMAIN_PROJECTS = {
    "src/postgres/versions/18",
    "src/sources/third-party/shared",
    "src/sources/third-party/native",
    "src/sources/third-party/wasix",
    "src/sources/toolchains",
    "src/extensions",
    "src/shared/js-core",
}

TARGET_SOURCE_DOMAINS = {
    "src/postgres",
    "src/sources",
    "src/extensions",
    "src/runtimes",
    "src/shared",
    "src/sdks",
    "src/bindings",
    "src/docs",
}

CURRENT_PRODUCT_ROOTS = {
    "src/runtimes/liboliphaunt/native": "liboliphaunt-native",
    "src/sdks/rust": "oliphaunt-rust",
    "src/sdks/swift": "oliphaunt-swift",
    "src/sdks/kotlin": "oliphaunt-kotlin",
    "src/sdks/react-native": "oliphaunt-react-native",
    "src/sdks/js": "oliphaunt-js",
    "src/bindings/wasix-rust": "oliphaunt-wasix-rust",
    "src/docs": "docs",
}

ALLOWED_SRC_TOP_LEVEL = {
    *(path.removeprefix("src/") for path in CURRENT_SOURCE_DOMAINS),
    *(path.removeprefix("src/") for path in TARGET_SOURCE_DOMAINS),
    *(path.removeprefix("src/") for path in CURRENT_PRODUCT_ROOTS),
}

RETIRED_ROOTS = {
    "assets",
    "crates",
    "fixtures",
    "liboliphaunt-native",
    "sdks",
}

FORBIDDEN_PRODUCT_IDENTITIES = {
    "@oliphaunt/sdk-apple",
    "apple-sdk",
    "oliphaunt-apple",
}

FORBIDDEN_RETIRED_RELEASE_TOOL_TEXT = {
    "release-plz",
    "git-cliff",
}

SDK_RUNTIME_SOURCE_PREFIXES = (
    "src/sdks/rust/src/",
    "src/sdks/swift/Sources/",
    "src/sdks/kotlin/oliphaunt/src/commonMain/",
    "src/sdks/kotlin/oliphaunt/src/androidMain/",
    "src/sdks/kotlin/oliphaunt/src/nativeMain/",
    "src/sdks/react-native/src/",
    "src/sdks/react-native/ios/",
    "src/sdks/react-native/android/src/main/",
    "src/sdks/js/src/",
)

TRANSITIONAL_EXTENSION_RULE_ALLOWLIST = {
    (
        "src/sdks/js/src/config.ts",
        "if (extension === 'pg_search')",
    ),
    (
        "src/sdks/js/src/config.ts",
        "libraries.add('pg_search')",
    ),
}

TRANSITIONAL_EXTENSION_RULE_FILES = {
    # Replaced by generated SDK extension metadata in checklist item 8.
    "src/sdks/rust/src/extension.rs",
    "src/sdks/rust/src/runtime_resources.rs",
    # Copied native ABI headers currently include one example module stem.
    "src/sdks/swift/Sources/COliphaunt/include/oliphaunt.h",
    "src/sdks/kotlin/oliphaunt/src/androidMain/cpp/include/oliphaunt.h",
    "src/sdks/react-native/android/src/main/cpp/include/oliphaunt.h",
}

PROMOTED_CATALOG = ROOT / "src/extensions/catalog/extensions.promoted.toml"
SMOKE_CATALOG = ROOT / "src/extensions/catalog/extensions.smoke.toml"
GENERATED_CATALOG = ROOT / "src/extensions/generated/extensions.catalog.json"
GENERATED_BUILD_PLAN = ROOT / "src/extensions/generated/extensions.build-plan.json"
GENERATED_EXTENSION_DOCS = ROOT / "src/extensions/generated/docs/extensions.json"
GENERATED_EXTENSION_EVIDENCE = ROOT / "src/extensions/generated/docs/extension-evidence.json"
EVIDENCE_MATRIX = ROOT / "src/extensions/evidence/matrix.toml"
EVIDENCE_RUN_SCHEMA = ROOT / "src/extensions/evidence/schemas/run.schema.json"
EVIDENCE_MATRIX_SCHEMA = ROOT / "src/extensions/evidence/schemas/matrix.schema.json"
EVIDENCE_RUNS = ROOT / "src/extensions/evidence/runs"
GENERATED_SDK_METADATA = [
    ROOT / "src/extensions/generated/sdk/rust.json",
    ROOT / "src/extensions/generated/sdk/swift.json",
    ROOT / "src/extensions/generated/sdk/kotlin.json",
    ROOT / "src/extensions/generated/sdk/js.json",
    ROOT / "src/extensions/generated/sdk/react-native.json",
]
GENERATED_SDK_PACKAGE_METADATA = [
    ROOT / "src/sdks/js/src/generated/extensions.ts",
    ROOT / "src/sdks/kotlin/oliphaunt/src/generated/extensions.json",
    ROOT / "src/sdks/react-native/src/generated/extensions.ts",
    ROOT / "src/sdks/react-native/src/generated/extensions.json",
]
GENERATED_MOBILE_REGISTRY = ROOT / "src/extensions/generated/mobile/static-registry.json"
GENERATED_WASIX_METADATA = ROOT / "src/extensions/generated/wasix/extensions.json"
GENERATED_TSV = [
    ROOT / "src/extensions/generated/contrib-build.tsv",
    ROOT / "src/extensions/generated/pgxs-build.tsv",
]


def fail(message: str) -> NoReturn:
    raise SystemExit(f"check-final-source-architecture.py: {message}")


def rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def require_file(path: Path) -> None:
    if not path.is_file():
        fail(f"missing required file: {rel(path)}")


def require_dir(path: Path) -> None:
    if not path.is_dir():
        fail(f"missing required directory: {rel(path)}")


def tracked_files(*paths: str) -> list[str]:
    command = ["git", "ls-files", "-z", "--", *paths]
    output = subprocess.check_output(command, cwd=ROOT)
    return sorted(path for path in output.decode("utf-8").split("\0") if path)


def read_toml(path: Path) -> dict[str, Any]:
    require_file(path)
    with path.open("rb") as handle:
        return tomllib.load(handle)


def read_json(path: Path) -> dict[str, Any]:
    require_file(path)
    with path.open(encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        fail(f"{rel(path)} must contain a JSON object")
    return value


def validate_extension_id(value: object, context: str) -> str:
    if not isinstance(value, str) or not EXTENSION_ID.fullmatch(value):
        fail(f"{context} has invalid exact SQL extension id {value!r}")
    return value


def validate_sql_extension_name(value: object, context: str) -> str:
    if not isinstance(value, str) or not SQL_EXTENSION_NAME.fullmatch(value):
        fail(f"{context} has invalid exact SQL extension name {value!r}")
    return value


def validate_unique_ids(ids: list[str], context: str) -> None:
    seen: set[str] = set()
    duplicates: set[str] = set()
    for extension_id in ids:
        if extension_id in seen:
            duplicates.add(extension_id)
        seen.add(extension_id)
    if duplicates:
        fail(f"{context} has duplicate extension ids: {sorted(duplicates)}")


def extension_rows(path: Path) -> list[dict[str, Any]]:
    value = read_toml(path).get("extensions")
    if not isinstance(value, list):
        fail(f"{rel(path)} must define [[extensions]] rows")
    rows: list[dict[str, Any]] = []
    for index, row in enumerate(value):
        if not isinstance(row, dict):
            fail(f"{rel(path)} extensions[{index}] must be a table")
        rows.append(row)
    return rows


def check_source_domains() -> None:
    for source_domain in CURRENT_SOURCE_DOMAINS:
        require_dir(ROOT / source_domain)
    for source_domain in CURRENT_SOURCE_DOMAIN_PROJECTS:
        require_file(ROOT / source_domain / "moon.yml")
    require_file(ROOT / "src/shared/contracts/moon.yml")
    require_file(ROOT / "src/shared/fixtures/moon.yml")
    for retired in RETIRED_ROOTS:
        files = tracked_files(retired)
        if files:
            fail(f"retired root source alias {retired}/ still has tracked files: {files[:8]}")

    src_children = {
        path.split("/", 2)[1]
        for path in tracked_files("src")
        if path.count("/") >= 1
    }
    unexpected = sorted(src_children - ALLOWED_SRC_TOP_LEVEL)
    if unexpected:
        fail(f"unexpected top-level source domains under src/: {unexpected}")


def check_source_spine_policy() -> None:
    path = ROOT / "tools/xtask/src/source_spine.rs"
    source_spine = path.read_text(encoding="utf-8")
    if "Path::new(SOURCE_CHECKOUT_ROOT).join(name)" not in source_spine:
        fail(f"{rel(path)} must derive source checkout paths from SOURCE_CHECKOUT_ROOT and source name")
    for forbidden in [
        '"pgtap" =>',
        '"postgis" =>',
        '"pgvector" =>',
        "target/oliphaunt-sources/checkouts/pgtap",
        "target/oliphaunt-sources/checkouts/postgis",
        "target/oliphaunt-sources/checkouts/pgvector",
    ]:
        if forbidden in source_spine:
            fail(f"{rel(path)} must not hardcode source checkout mapping {forbidden!r}")


def check_xtask_extension_policy() -> None:
    postgres_guard = ROOT / "tools/xtask/src/postgres_guard.rs"
    postgres_guard_text = postgres_guard.read_text(encoding="utf-8")
    if 'extension.build_kind == "postgis"' in postgres_guard_text:
        fail(
            f"{rel(postgres_guard)} must not key PostGIS source-shape checks off "
            "the reusable build-kind family"
        )
    if 'extension.source_kind == "postgis"' not in postgres_guard_text:
        fail(
            f"{rel(postgres_guard)} must keep PostGIS source-shape checks keyed "
            "to source_kind"
        )


def check_product_roots() -> None:
    for product_root, project_id in CURRENT_PRODUCT_ROOTS.items():
        moon_yml = ROOT / product_root / "moon.yml"
        require_file(moon_yml)
        text = moon_yml.read_text(encoding="utf-8")
        if f'id: "{project_id}"' not in text:
            fail(f"{product_root}/moon.yml must declare id {project_id!r}")

    for forbidden in ("src/apple-sdk", "src/oliphaunt-apple", "src/apple"):
        files = tracked_files(forbidden)
        if files:
            fail(f"forbidden Swift SDK alias has tracked files: {files[:8]}")


def check_forbidden_product_identity_text() -> None:
    scan_files = tracked_files(
        "src",
        ".github",
        "tools/release",
        "Cargo.toml",
        "Package.swift",
        "package.json",
        "pnpm-workspace.yaml",
    )
    offenders: list[str] = []
    for path in scan_files:
        if path.startswith("src/postgres/versions/18/"):
            continue
        full_path = ROOT / path
        if not full_path.exists():
            continue
        try:
            text = full_path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        lowered = text.lower()
        for identity in FORBIDDEN_PRODUCT_IDENTITIES:
            if identity in lowered:
                offenders.append(f"{path}: contains {identity}")
    if offenders:
        fail("forbidden product identity text found:\n" + "\n".join(offenders[:20]))


def check_forbidden_retired_release_tool_text() -> None:
    scan_files = tracked_files(
        "src",
        ".github",
        "tools/release",
        "Cargo.toml",
        "Package.swift",
        "package.json",
        "pnpm-workspace.yaml",
        "release-please-config.json",
        ".release-please-manifest.json",
    )
    offenders: list[str] = []
    for path in scan_files:
        if path.startswith("src/postgres/versions/18/"):
            continue
        full_path = ROOT / path
        if not full_path.exists():
            continue
        try:
            text = full_path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        lowered = text.lower()
        for name in FORBIDDEN_RETIRED_RELEASE_TOOL_TEXT:
            if name in lowered:
                offenders.append(f"{path}: contains retired release tool reference {name}")
    if offenders:
        fail("retired release tool text found on active product/release surfaces:\n" + "\n".join(offenders[:20]))


def check_extension_catalogs() -> None:
    promoted_rows = extension_rows(PROMOTED_CATALOG)
    smoke_rows = extension_rows(SMOKE_CATALOG)
    promoted_ids = [validate_extension_id(row.get("id"), f"{rel(PROMOTED_CATALOG)} row") for row in promoted_rows]
    smoke_ids = [validate_extension_id(row.get("id"), f"{rel(SMOKE_CATALOG)} row") for row in smoke_rows]
    validate_unique_ids(promoted_ids, rel(PROMOTED_CATALOG))
    validate_unique_ids(smoke_ids, rel(SMOKE_CATALOG))
    unknown_smoke = sorted(set(smoke_ids) - set(promoted_ids))
    if unknown_smoke:
        fail(f"{rel(SMOKE_CATALOG)} references extensions not in promoted catalog: {unknown_smoke}")

    for row in promoted_rows:
        unexpected_pack_keys = sorted(key for key in row if "pack" in key or "bundle" in key or "alias" in key)
        if unexpected_pack_keys:
            fail(f"extension row {row.get('id')} must not use pack/bundle/alias keys: {unexpected_pack_keys}")
        if row.get("stable") is False and not row.get("blocker"):
            fail(f"candidate extension {row.get('id')} must explain its blocker")


def check_generated_extension_metadata() -> None:
    catalog = read_json(GENERATED_CATALOG)
    build_plan = read_json(GENERATED_BUILD_PLAN)
    docs_table = read_json(GENERATED_EXTENSION_DOCS)
    evidence_table = read_json(GENERATED_EXTENSION_EVIDENCE)
    if catalog.get("format-version") != 1:
        fail(f"{rel(GENERATED_CATALOG)} must use format-version 1")
    if build_plan.get("format-version") != 1:
        fail(f"{rel(GENERATED_BUILD_PLAN)} must use format-version 1")
    if docs_table.get("format-version") != 1:
        fail(f"{rel(GENERATED_EXTENSION_DOCS)} must use format-version 1")
    if evidence_table.get("format-version") != 1:
        fail(f"{rel(GENERATED_EXTENSION_EVIDENCE)} must use format-version 1")
    for path in [*GENERATED_SDK_METADATA, GENERATED_MOBILE_REGISTRY, GENERATED_WASIX_METADATA]:
        value = read_json(path)
        if value.get("format-version") != 1:
            fail(f"{rel(path)} must use format-version 1")
    for path in GENERATED_SDK_PACKAGE_METADATA:
        require_file(path)

    promoted_ids = {validate_extension_id(row.get("id"), f"{rel(PROMOTED_CATALOG)} row") for row in extension_rows(PROMOTED_CATALOG)}
    catalog_extensions = catalog.get("extensions")
    build_extensions = build_plan.get("extensions")
    if not isinstance(catalog_extensions, list) or not catalog_extensions:
        fail(f"{rel(GENERATED_CATALOG)} must define non-empty extensions")
    if not isinstance(build_extensions, list) or not build_extensions:
        fail(f"{rel(GENERATED_BUILD_PLAN)} must define non-empty extensions")

    catalog_ids = [validate_extension_id(row.get("id"), f"{rel(GENERATED_CATALOG)} row") for row in catalog_extensions]
    build_ids = [validate_extension_id(row.get("id"), f"{rel(GENERATED_BUILD_PLAN)} row") for row in build_extensions]
    validate_unique_ids(catalog_ids, rel(GENERATED_CATALOG))
    validate_unique_ids(build_ids, rel(GENERATED_BUILD_PLAN))
    unknown_catalog = sorted(set(catalog_ids) - promoted_ids)
    unknown_build = sorted(set(build_ids) - promoted_ids)
    if unknown_catalog:
        fail(f"{rel(GENERATED_CATALOG)} has ids not declared in promoted catalog: {unknown_catalog}")
    if unknown_build:
        fail(f"{rel(GENERATED_BUILD_PLAN)} has ids not declared in promoted catalog: {unknown_build}")

    for row in build_extensions:
        extension_id = validate_extension_id(row.get("id"), f"{rel(GENERATED_BUILD_PLAN)} row")
        sql_name = validate_sql_extension_name(row.get("sql-name", extension_id), f"{rel(GENERATED_BUILD_PLAN)} row")
        build_kind = row.get("build-kind")
        if build_kind not in {"postgres-contrib", "pgxs-external", "pgxs-sql-only", "autotools"}:
            fail(
                f"{rel(GENERATED_BUILD_PLAN)} extension {extension_id} has unsupported "
                f"build-kind {build_kind!r}"
            )
        if build_kind == sql_name:
            fail(
                f"{rel(GENERATED_BUILD_PLAN)} extension {extension_id} uses extension-specific "
                f"build-kind {build_kind!r}; build-kind must be a reusable build family"
            )
        archive = row.get("archive")
        if not isinstance(archive, str) or archive != f"extensions/{sql_name}.tar.zst":
            fail(f"{rel(GENERATED_BUILD_PLAN)} extension {extension_id} has invalid exact-extension archive {archive!r}")
        if any(key in row for key in ("pack", "packs", "bundle", "alias", "aliases")):
            fail(f"{rel(GENERATED_BUILD_PLAN)} extension {extension_id} must not use pack/bundle/alias metadata")
        if build_kind == "autotools":
            build_script = row.get("build-script")
            if not isinstance(build_script, str) or not build_script:
                fail(
                    f"{rel(GENERATED_BUILD_PLAN)} extension {extension_id} "
                    "must declare build-script for recipe-staged autotools builds"
                )
            for field in ("required-build-files", "required-build-globs"):
                values = row.get(field)
                if not isinstance(values, list) or not values or not all(isinstance(value, str) and value for value in values):
                    fail(
                        f"{rel(GENERATED_BUILD_PLAN)} extension {extension_id} "
                        f"must declare non-empty {field} for recipe-staged autotools builds"
                    )

    for path in GENERATED_TSV:
        require_file(path)
        text = path.read_text(encoding="utf-8")
        if "pack" in text.lower() or "bundle" in text.lower():
            fail(f"{rel(path)} must not contain extension pack/bundle metadata")


def check_extension_evidence() -> None:
    require_file(EVIDENCE_MATRIX)
    require_file(EVIDENCE_RUN_SCHEMA)
    require_file(EVIDENCE_MATRIX_SCHEMA)
    require_dir(EVIDENCE_RUNS)
    if not list(EVIDENCE_RUNS.glob("*.json")):
        fail(f"{rel(EVIDENCE_RUNS)} must contain extension evidence run files")

    matrix = read_toml(EVIDENCE_MATRIX)
    if matrix.get("format-version") != 1:
        fail(f"{rel(EVIDENCE_MATRIX)} must use format-version 1")
    claims = matrix.get("claims")
    if not isinstance(claims, list) or not claims:
        fail(f"{rel(EVIDENCE_MATRIX)} must declare [[claims]]")

    public_ids = {
        validate_extension_id(row.get("id"), f"{rel(PROMOTED_CATALOG)} row")
        for row in extension_rows(PROMOTED_CATALOG)
        if row.get("stable") is True and row.get("build") is not False
    }
    claim_ids = {
        validate_extension_id(claim.get("extension"), f"{rel(EVIDENCE_MATRIX)} claim")
        for claim in claims
        if isinstance(claim, dict) and claim.get("public") is True
    }
    missing = sorted(public_ids - claim_ids)
    extra = sorted(claim_ids - public_ids)
    if missing:
        fail(f"{rel(EVIDENCE_MATRIX)} is missing public claims for stable catalog rows: {missing}")
    if extra:
        fail(f"{rel(EVIDENCE_MATRIX)} claims public support for non-stable catalog rows: {extra}")


def check_extension_recipes() -> None:
    retired_recipes_root = ROOT / "src/extensions/recipes"
    if retired_recipes_root.exists():
        fail(f"{rel(retired_recipes_root)} is retired; external extension definitions live under src/extensions/external")
    external_root = ROOT / "src/extensions/external"
    if not external_root.exists():
        fail(f"{rel(external_root)} must exist")
    recipe_files = sorted(external_root.glob("*/recipe.toml"))
    for recipe in recipe_files:
        data = read_toml(recipe)
        if data.get("schema") != "oliphaunt-extension-recipe-v1":
            fail(f"{rel(recipe)} must use schema = oliphaunt-extension-recipe-v1")
        sql_name = validate_sql_extension_name(data.get("sql_name"), f"{rel(recipe)} recipe")
        kind = data.get("kind")
        if kind not in {"external-simple-pgxs", "external-complex"}:
            fail(f"{rel(recipe)} must declare an external recipe kind")
        if recipe.parent.name != sql_name:
            fail(f"{rel(recipe)} directory must match exact SQL extension name")
        for section in ("lifecycle", "artifacts", "support"):
            if not isinstance(data.get(section), dict):
                fail(f"{rel(recipe)} must declare [{section}]")
        recipe_dir = recipe.parent
        require_file(recipe_dir / "tests" / "smoke.sql")
        targets = recipe_dir / "targets"
        if not targets.is_dir() or not any(targets.glob("*.toml")):
            fail(f"{rel(recipe)} must declare at least one target TOML under targets/")
        if kind == "external-complex":
            require_file(recipe_dir / "deps.toml")
            require_file(recipe_dir / "tests" / "upstream.toml")
            require_file(recipe_dir / "patches" / "README.md")
            require_file(recipe_dir / "blockers.toml")


def check_sdk_local_extension_rules() -> None:
    catalog_ids = {
        validate_extension_id(row.get("id"), f"{rel(PROMOTED_CATALOG)} row")
        for row in extension_rows(PROMOTED_CATALOG)
    }
    complex_ids = catalog_ids & {"age", "graph", "pg_search", "pg_textsearch", "postgis", "vector"}
    offenders: list[str] = []
    for path in tracked_files("src/sdks/rust", "src/sdks/swift", "src/sdks/kotlin", "src/sdks/react-native", "src/sdks/js"):
        if not path.startswith(SDK_RUNTIME_SOURCE_PREFIXES):
            continue
        if path in TRANSITIONAL_EXTENSION_RULE_FILES or "/generated/" in path:
            continue
        if "/tests/" in path or "/Tests/" in path or "/__tests__/" in path:
            continue
        try:
            lines = (ROOT / path).read_text(encoding="utf-8").splitlines()
        except UnicodeDecodeError:
            continue
        for line_number, line in enumerate(lines, start=1):
            stripped = line.strip()
            if (path, stripped) in TRANSITIONAL_EXTENSION_RULE_ALLOWLIST:
                continue
            for extension_id in complex_ids:
                if re.search(rf"['\"`]({re.escape(extension_id)})['\"`]", stripped):
                    offenders.append(f"{path}:{line_number}: hardcodes extension {extension_id!r}: {stripped}")
    if offenders:
        fail(
            "SDK runtime source must not hardcode complex extension rules outside generated metadata; "
            "known transitional exceptions must be explicit:\n" + "\n".join(offenders[:20])
        )


def self_test() -> None:
    try:
        validate_extension_id("bad-name", "self-test")
    except SystemExit:
        pass
    else:
        fail("self-test expected invalid extension id to fail")

    try:
        validate_unique_ids(["vector", "vector"], "self-test")
    except SystemExit:
        pass
    else:
        fail("self-test expected duplicate extension ids to fail")


def check_live_repo() -> None:
    check_source_domains()
    check_source_spine_policy()
    check_xtask_extension_policy()
    check_product_roots()
    check_forbidden_product_identity_text()
    check_forbidden_retired_release_tool_text()
    check_extension_catalogs()
    check_generated_extension_metadata()
    check_extension_evidence()
    check_extension_recipes()
    check_sdk_local_extension_rules()


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true", help="run embedded failure-case checks")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    if args.self_test:
        self_test()
    check_live_repo()
    print("final source architecture policy checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
