#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tomllib
from pathlib import Path
from tempfile import TemporaryDirectory

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools/release"))

import product_metadata  # noqa: E402

PROMOTED = ROOT / "src/extensions/catalog/extensions.promoted.toml"
SMOKE = ROOT / "src/extensions/catalog/extensions.smoke.toml"
CATALOG = ROOT / "src/extensions/generated/extensions.catalog.json"
BUILD_PLAN = ROOT / "src/extensions/generated/extensions.build-plan.json"
CONTRIB_RECIPE = ROOT / "src/extensions/contrib/postgres18.toml"
RECIPE_SCHEMA = ROOT / "src/extensions/schemas/recipe.schema.json"
SUPPORT_SCHEMA = ROOT / "src/extensions/schemas/support-table.schema.json"
SUPPORT_TABLE = ROOT / "src/extensions/generated/docs/extensions.json"
EVIDENCE_MATRIX = ROOT / "src/extensions/evidence/matrix.toml"
EVIDENCE_RUN_SCHEMA = ROOT / "src/extensions/evidence/schemas/run.schema.json"
EVIDENCE_MATRIX_SCHEMA = ROOT / "src/extensions/evidence/schemas/matrix.schema.json"
EVIDENCE_RUNS = ROOT / "src/extensions/evidence/runs"
EVIDENCE_TABLE = ROOT / "src/extensions/generated/docs/extension-evidence.json"
THIRD_PARTY_ROOT = ROOT / "src/sources/third-party"
EXTERNAL_ROOT = ROOT / "src/extensions/external"
EXTERNAL_RELEASE_METADATA_FILENAMES = {"CHANGELOG.md", "VERSION", "release.toml"}
GENERATED_SDKS = {
    "rust": ROOT / "src/extensions/generated/sdk/rust.json",
    "swift": ROOT / "src/extensions/generated/sdk/swift.json",
    "kotlin": ROOT / "src/extensions/generated/sdk/kotlin.json",
    "js": ROOT / "src/extensions/generated/sdk/js.json",
    "react-native": ROOT / "src/extensions/generated/sdk/react-native.json",
}
GENERATED_RUST_SDK_MODULE = ROOT / "src/sdks/rust/src/generated/extensions.rs"
GENERATED_TS_SDK_MODULE = ROOT / "src/sdks/js/src/generated/extensions.ts"
GENERATED_KOTLIN_SDK_METADATA = ROOT / "src/sdks/kotlin/oliphaunt/src/generated/extensions.json"
GENERATED_KOTLIN_SDK_MODULE = ROOT / "src/sdks/kotlin/oliphaunt/src/commonMain/kotlin/dev/oliphaunt/GeneratedExtensions.kt"
GENERATED_RN_SDK_MODULE = ROOT / "src/sdks/react-native/src/generated/extensions.ts"
GENERATED_RN_PLUGIN_METADATA = ROOT / "src/sdks/react-native/src/generated/extensions.json"
GENERATED_MOBILE_REGISTRY = ROOT / "src/extensions/generated/mobile/static-registry.json"
GENERATED_MOBILE_STATIC_SPECS = ROOT / "src/extensions/generated/mobile/static-extensions.tsv"
GENERATED_WASIX_METADATA = ROOT / "src/extensions/generated/wasix/extensions.json"
BIOME_VERSION = "2.4.16"

RUST_INTERNAL_EXTENSION_CANDIDATES = [
    {
        "id": "graph",
        "sql-name": "graph",
        "rust-constant": "GRAPH",
        "creates-extension": True,
        "native-module-stem": "graph",
        "selected-extension-dependencies": [],
        "runtime-share-data-files": [],
        "shared-preload-libraries": [],
        "first-party": False,
        "mobile-release-ready": False,
        "external-policy": {
            "upstream": "https://github.com/evokoa/pggraph",
            "license": "Apache-2.0",
            "source-kind": "Pgrx",
            "redistribution": "Allowed",
            "requires-shared-preload": False,
            "notes": "Optional shared_preload_libraries='graph' enables startup _PG_init behavior; background-worker maintenance paths must be tested per engine mode.",
        },
    },
    {
        "id": "pg_search",
        "sql-name": "pg_search",
        "rust-constant": "PG_SEARCH",
        "creates-extension": True,
        "native-module-stem": "pg_search",
        "selected-extension-dependencies": [],
        "runtime-share-data-files": [],
        "shared-preload-libraries": ["pg_search"],
        "first-party": False,
        "mobile-release-ready": False,
        "external-policy": {
            "upstream": "https://github.com/paradedb/paradedb",
            "license": "AGPL-3.0 community edition",
            "source-kind": "Pgrx",
            "redistribution": "RequiresCommercialLicense",
            "requires-shared-preload": True,
            "notes": "ParadeDB pg_search requires shared_preload_libraries='pg_search', registers preload-time WAL machinery, and uses PostgreSQL parallel workers.",
        },
    },
]

BASE_SOURCE_DIGEST_INPUTS = [
    "src/postgres/versions/18/source.toml",
    "src/extensions/catalog/extensions.promoted.toml",
    "src/extensions/catalog/extensions.smoke.toml",
    "src/extensions/contrib/postgres18.toml",
    "src/extensions/generated/extensions.catalog.json",
    "src/extensions/generated/extensions.build-plan.json",
    "src/extensions/generated/contrib-build.tsv",
    "src/extensions/generated/pgxs-build.tsv",
    "src/runtimes/liboliphaunt/wasix/assets/generated/asset-inputs.sha256",
]

ID_RE = re.compile(r"^[a-z][a-z0-9_]*$")
SQL_NAME_RE = re.compile(r"^[a-z][a-z0-9_-]*$")
SMOKE_STATUSES = {"passed", "failed", "not-run", "blocked"}
SUPPORT_STATUSES = {"unsupported", "candidate", "experimental", "supported"}


def fail(message: str) -> None:
    raise SystemExit(message)


def ensure_trailing_newline(text: str) -> str:
    return text if text.endswith("\n") else f"{text}\n"


def format_rust_source(source: str) -> str:
    try:
        return ensure_trailing_newline(
            subprocess.check_output(
                ["rustfmt", "--emit", "stdout"],
                cwd=ROOT,
                input=source,
                text=True,
            )
        )
    except (FileNotFoundError, subprocess.CalledProcessError) as error:
        fail(f"failed to format generated Rust extension metadata with rustfmt: {error}")


def format_typescript_source(source: str, path: Path) -> str:
    pnpm = shutil.which("pnpm") or shutil.which("pnpm.cmd")
    if pnpm is None:
        fail(f"failed to format generated TypeScript extension metadata with Biome {BIOME_VERSION}: pnpm was not found")
    try:
        return ensure_trailing_newline(
            subprocess.check_output(
                [
                    pnpm,
                    f"--package=@biomejs/biome@{BIOME_VERSION}",
                    "dlx",
                    "biome",
                    "format",
                    "--stdin-file-path",
                    rel(path),
                ],
                cwd=ROOT,
                input=source,
                text=True,
            )
        )
    except (FileNotFoundError, subprocess.CalledProcessError) as error:
        fail(f"failed to format generated TypeScript extension metadata with Biome {BIOME_VERSION}: {error}")


def rel(path: Path) -> str:
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return path.as_posix()


def read_toml(path: Path) -> dict:
    try:
        with path.open("rb") as handle:
            return tomllib.load(handle)
    except tomllib.TOMLDecodeError as error:
        fail(f"{rel(path)} is invalid TOML: {error}")


def read_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        fail(f"{rel(path)} is invalid JSON: {error}")


def source_pin_paths() -> list[Path]:
    if not THIRD_PARTY_ROOT.is_dir():
        fail(f"{rel(THIRD_PARTY_ROOT)} must exist")
    if not EXTERNAL_ROOT.is_dir():
        fail(f"{rel(EXTERNAL_ROOT)} must exist")
    paths = [
        path
        for path in THIRD_PARTY_ROOT.glob("**/*.toml")
        if path.is_file()
    ]
    paths.extend(
        path
        for path in EXTERNAL_ROOT.glob("**/source.toml")
        if path.is_file()
    )
    return sorted(paths, key=rel)


def normalized_rel_list(values: object, label: str) -> list[str]:
    if not isinstance(values, list) or not all(isinstance(value, str) for value in values):
        fail(f"{label} must be a list of repository-relative paths")
    return [value.replace("\\", "/") for value in values]


def load_source_names() -> set[str]:
    source_names: set[str] = set()
    for path in source_pin_paths():
        data = read_toml(path)
        name = data.get("name")
        if not isinstance(name, str) or not name:
            fail(f"{rel(path)} must declare a source name")
        if name in source_names:
            fail(f"duplicate source pin {name} across source metadata")
        source_names.add(name)
    if not source_names:
        fail("source metadata must contain at least one source pin")
    return source_names


def source_digest_inputs() -> list[str]:
    source_files = [rel(path) for path in source_pin_paths()]
    recipe_files = sorted(
        rel(path)
        for path in EXTERNAL_ROOT.glob("**/*")
        if path.is_file()
        and path.name != "source.toml"
        and path.name not in EXTERNAL_RELEASE_METADATA_FILENAMES
    )
    return [*BASE_SOURCE_DIGEST_INPUTS, *source_files, *recipe_files]


def source_digest(paths: list[str] | None = None) -> str:
    paths = source_digest_inputs() if paths is None else paths
    digest = hashlib.sha256()
    for relative in paths:
        path = ROOT / relative
        if not path.exists():
            fail(f"source digest input is missing: {relative}")
        contents = path.read_bytes().replace(b"\r\n", b"\n").replace(b"\r", b"\n")
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update(contents)
        digest.update(b"\0")
    return f"sha256:{digest.hexdigest()}"


def validate_id(value: object, label: str) -> str:
    if not isinstance(value, str) or ID_RE.fullmatch(value) is None:
        fail(f"{label} must be a lower snake-case extension id, got {value!r}")
    return value


def validate_sql_name(value: object, label: str) -> str:
    if not isinstance(value, str) or SQL_NAME_RE.fullmatch(value) is None:
        fail(f"{label} must be an exact SQL extension name, got {value!r}")
    return value


def extension_rows(path: Path) -> list[dict]:
    data = read_toml(path)
    if data.get("format-version") != 1:
        fail(f"{rel(path)} must use format-version = 1")
    rows = data.get("extensions")
    if not isinstance(rows, list) or not rows:
        fail(f"{rel(path)} must define [[extensions]] rows")
    return rows


def validate_catalog_rows() -> None:
    promoted = extension_rows(PROMOTED)
    smoke = extension_rows(SMOKE)
    promoted_ids: set[str] = set()
    for row in promoted:
        extension_id = validate_id(row.get("id"), f"{rel(PROMOTED)} row id")
        if extension_id in promoted_ids:
            fail(f"{rel(PROMOTED)} has duplicate extension id {extension_id}")
        promoted_ids.add(extension_id)
        unexpected = sorted(key for key in row if "pack" in key or "bundle" in key or "alias" in key)
        if unexpected:
            fail(f"{rel(PROMOTED)} row {extension_id} must not use pack/bundle/alias keys: {unexpected}")
        build = row.get("build", True)
        stable = row.get("stable", False)
        blocker = row.get("blocker")
        if not isinstance(build, bool):
            fail(f"{rel(PROMOTED)} row {extension_id} build must be boolean when present")
        if not isinstance(stable, bool):
            fail(f"{rel(PROMOTED)} row {extension_id} stable must be boolean when present")
        if (not build or not stable) and not isinstance(blocker, str):
            fail(f"{rel(PROMOTED)} row {extension_id} must explain non-release status with blocker")

    smoke_ids: set[str] = set()
    for row in smoke:
        extension_id = validate_id(row.get("id"), f"{rel(SMOKE)} row id")
        if extension_id in smoke_ids:
            fail(f"{rel(SMOKE)} has duplicate extension id {extension_id}")
        smoke_ids.add(extension_id)
        for field in ("direct", "server", "restart", "dump-restore"):
            status = row.get(field, "not-run")
            if status not in SMOKE_STATUSES:
                fail(f"{rel(SMOKE)} row {extension_id} has invalid {field} status {status!r}")

    missing_smoke = sorted(promoted_ids - smoke_ids)
    extra_smoke = sorted(smoke_ids - promoted_ids)
    if missing_smoke:
        fail(f"{rel(SMOKE)} is missing rows for promoted catalog ids: {missing_smoke}")
    if extra_smoke:
        fail(f"{rel(SMOKE)} has rows for unknown promoted catalog ids: {extra_smoke}")


def validate_contrib_recipe(build_plan: dict) -> None:
    data = read_toml(CONTRIB_RECIPE)
    if data.get("format-version") != 1:
        fail(f"{rel(CONTRIB_RECIPE)} must use format-version = 1")
    if data.get("postgres-version") != "18.4":
        fail(f"{rel(CONTRIB_RECIPE)} must target PostgreSQL 18.4")
    if data.get("source-kind") != "postgres-contrib":
        fail(f"{rel(CONTRIB_RECIPE)} must declare source-kind = postgres-contrib")
    if data.get("source-root") != "src/postgres/versions/18/contrib":
        fail(f"{rel(CONTRIB_RECIPE)} must point at src/postgres/versions/18/contrib")
    rows = data.get("extensions")
    if not isinstance(rows, list) or not rows:
        fail(f"{rel(CONTRIB_RECIPE)} must declare contrib extension rows")
    recipe_by_id: dict[str, dict] = {}
    for row in rows:
        extension_id = validate_id(row.get("id"), f"{rel(CONTRIB_RECIPE)} row id")
        validate_sql_name(row.get("sql-name"), f"{rel(CONTRIB_RECIPE)} row {extension_id} sql-name")
        for field in ("contrib-dir", "module-file"):
            if not isinstance(row.get(field), str) or not row[field]:
                fail(f"{rel(CONTRIB_RECIPE)} row {extension_id} must define {field}")
        data_files = row.get("data-files", [])
        if not isinstance(data_files, list) or not all(isinstance(value, str) for value in data_files):
            fail(f"{rel(CONTRIB_RECIPE)} row {extension_id} data-files must be an array of strings when present")
        for recipe_field in (
            "mobile-static-dependencies",
            "mobile-static-include-dependencies",
            "mobile-static-include-dirs",
            "mobile-static-cflags",
            "mobile-static-hash-source-dependencies",
            "mobile-static-hash-dirs",
        ):
            values = row.get(recipe_field, [])
            if not isinstance(values, list) or not all(isinstance(value, str) and value for value in values):
                fail(
                    f"{rel(CONTRIB_RECIPE)} row {extension_id} {recipe_field} "
                    "must be an array of strings when present"
                )
        if extension_id in recipe_by_id:
            fail(f"{rel(CONTRIB_RECIPE)} has duplicate extension id {extension_id}")
        recipe_by_id[extension_id] = row

    plan_rows = [
        row for row in build_plan.get("extensions", []) if row.get("build-kind") == "postgres-contrib"
    ]
    plan_by_id = {validate_id(row.get("id"), f"{rel(BUILD_PLAN)} row id"): row for row in plan_rows}
    if sorted(recipe_by_id) != sorted(plan_by_id):
        fail(
            f"{rel(CONTRIB_RECIPE)} ids must match generated contrib build plan; "
            f"recipe-only={sorted(set(recipe_by_id) - set(plan_by_id))}, "
            f"plan-only={sorted(set(plan_by_id) - set(recipe_by_id))}"
        )
    for extension_id, plan in plan_by_id.items():
        recipe = recipe_by_id[extension_id]
        expected = {
            "sql-name": plan.get("sql-name"),
            "contrib-dir": plan.get("contrib-dir"),
            "module-file": plan.get("module-file"),
        }
        for field, value in expected.items():
            if recipe.get(field) != value:
                fail(
                    f"{rel(CONTRIB_RECIPE)} row {extension_id} {field}={recipe.get(field)!r} "
                    f"does not match generated build plan {value!r}"
                )


def validate_external_recipes() -> None:
    source_names = load_source_names()
    build_plan = read_json(BUILD_PLAN)
    build_by_sql_name = {
        row.get("sql-name", row.get("id")): row
        for row in build_plan.get("extensions", [])
        if isinstance(row, dict)
    }
    validate_external_source_pins(build_by_sql_name, source_names)
    for recipe in sorted(EXTERNAL_ROOT.glob("*/recipe.toml")):
        data = read_toml(recipe)
        if data.get("schema") != "oliphaunt-extension-recipe-v1":
            fail(f"{rel(recipe)} must use schema = oliphaunt-extension-recipe-v1")
        sql_name = validate_sql_name(data.get("sql_name"), f"{rel(recipe)} sql_name")
        if recipe.parent.name != sql_name:
            fail(f"{rel(recipe)} directory name must match sql_name {sql_name}")
        kind = data.get("kind")
        if kind not in {"external-simple-pgxs", "external-complex"}:
            fail(f"{rel(recipe)} kind must be external-simple-pgxs or external-complex")
        source = data.get("source")
        if source not in source_names:
            fail(f"{rel(recipe)} source {source!r} must reference source metadata")
        majors = data.get("postgres_majors")
        if not isinstance(majors, list) or 18 not in majors:
            fail(f"{rel(recipe)} must explicitly support postgres_majors including 18")
        if not isinstance(data.get("license"), str) or not data["license"]:
            fail(f"{rel(recipe)} must declare license metadata")
        lifecycle = data.get("lifecycle")
        artifacts = data.get("artifacts")
        support = data.get("support")
        if not isinstance(lifecycle, dict) or not isinstance(artifacts, dict) or not isinstance(support, dict):
            fail(f"{rel(recipe)} must declare lifecycle, artifacts, and support tables")
        runtime_environment = data.get("runtime_environment") or []
        if not isinstance(runtime_environment, list):
            fail(f"{rel(recipe)} runtime_environment must be an array when present")
        for index, entry in enumerate(runtime_environment):
            if not isinstance(entry, dict):
                fail(f"{rel(recipe)} runtime_environment[{index}] must be a table")
            for field in ("name", "path", "required_file"):
                if not isinstance(entry.get(field), str) or not entry[field]:
                    fail(f"{rel(recipe)} runtime_environment[{index}].{field} must be a non-empty string")
        for field in (
            "requires",
            "implicit_sql_dependencies",
            "load_sql",
            "post_create_sql",
            "shared_preload_libraries",
        ):
            if not isinstance(lifecycle.get(field), list):
                fail(f"{rel(recipe)} lifecycle.{field} must be an array")
        for field in (
            "creates_extension",
            "restart_required",
            "background_workers",
            "shared_memory",
            "session_load_required",
            "needs_superuser",
            "trusted",
        ):
            if not isinstance(lifecycle.get(field), bool):
                fail(f"{rel(recipe)} lifecycle.{field} must be boolean")
        for field in (
            "control_files",
            "sql_globs",
            "native_modules",
            "native_dependency_modules",
            "data_files",
            "headers",
            "licenses",
        ):
            if not isinstance(artifacts.get(field), list):
                fail(f"{rel(recipe)} artifacts.{field} must be an array")
        for field in ("extension_sql_file_prefixes", "extension_sql_file_names"):
            if field in artifacts and not isinstance(artifacts.get(field), list):
                fail(f"{rel(recipe)} artifacts.{field} must be an array when present")
        for family, claims in support.items():
            if not isinstance(claims, dict):
                fail(f"{rel(recipe)} support.{family} must be a table")
            for mode, status in claims.items():
                if status not in SUPPORT_STATUSES:
                    fail(f"{rel(recipe)} support.{family}.{mode} has invalid status {status!r}")

        tests = recipe.parent / "tests"
        for path in (tests / "smoke.sql", tests / "upstream.toml"):
            if not path.exists():
                fail(f"{rel(recipe)} must provide {rel(path)}")
        if "-- oliphaunt-statement" not in (tests / "smoke.sql").read_text(encoding="utf-8"):
            fail(f"{rel(tests / 'smoke.sql')} must include explicit statement delimiters")

        if kind == "external-complex":
            for path in (
                recipe.parent / "deps.toml",
                recipe.parent / "targets/native.toml",
                recipe.parent / "targets/wasix.toml",
                recipe.parent / "targets/native-static-registry.toml",
                recipe.parent / "patches/README.md",
                recipe.parent / "blockers.toml",
            ):
                if not path.exists():
                    fail(f"{rel(recipe)} complex recipe is missing {rel(path)}")
            deps = read_toml(recipe.parent / "deps.toml")
            declared_deps = [
                row.get("name")
                for row in deps.get("dependencies", [])
                if isinstance(row, dict) and isinstance(row.get("name"), str)
            ]
            if len(declared_deps) != len(set(declared_deps)):
                fail(f"{rel(recipe.parent / 'deps.toml')} has duplicate dependency names")
            missing_source_pins = sorted(set(declared_deps) - source_names)
            if missing_source_pins:
                fail(
                    f"{rel(recipe.parent / 'deps.toml')} references sources missing from source metadata: "
                    f"{missing_source_pins}"
                )
            for dependency in deps.get("dependencies", []):
                if not isinstance(dependency, dict) or not dependency.get("license"):
                    fail(f"{rel(recipe.parent / 'deps.toml')} dependencies must include license metadata")

        generated = build_by_sql_name.get(sql_name)
        if generated is None:
            fail(f"{rel(recipe)} has no matching generated build-plan row")
        if generated.get("source-kind") != "postgis" and kind == "external-complex":
            fail(f"{rel(recipe)} complex recipe must match generated source-kind postgis")
        generated_modules = set(generated.get("load-order") or [])
        for module in artifacts.get("native_modules", []):
            if module not in generated_modules:
                fail(f"{rel(recipe)} native module {module!r} must match generated load-order")


def validate_external_source_pins(build_by_sql_name: dict[str, dict], source_names: set[str]) -> None:
    for source_path in sorted(EXTERNAL_ROOT.glob("*/source.toml")):
        extension_dir = source_path.parent
        sql_name = validate_sql_name(extension_dir.name, f"{rel(source_path)} directory")
        source = read_toml(source_path)
        name = source.get("name")
        if not isinstance(name, str) or name not in source_names:
            fail(f"{rel(source_path)} must declare a valid source name")
        if sql_name not in build_by_sql_name:
            continue
        generated = build_by_sql_name[sql_name]
        generated_source_dir = generated.get("source-dir")
        if isinstance(generated_source_dir, str) and generated_source_dir:
            expected_checkout = f"target/oliphaunt-sources/checkouts/{name}"
            if generated_source_dir != expected_checkout:
                fail(
                    f"{rel(source_path)} source name {name!r} implies checkout "
                    f"{expected_checkout}, but generated build plan uses {generated_source_dir}"
                )


def validate_extension_release_metadata() -> None:
    for product in product_metadata.extension_product_ids():
        product_metadata.extension_source_identity(product)
        product_metadata.validate_extension_metadata(product)


def extension_family(source_kind: object) -> str:
    return {
        "postgres-contrib": "PostgreSQL contrib",
        "oliphaunt-other-extension": "External PGXS",
        "postgis": "Complex external",
    }.get(str(source_kind), "Other")


def extension_activation(extension: dict) -> str:
    lifecycle = extension.get("lifecycle", {})
    create_extension = bool(lifecycle.get("create-extension"))
    load_sql = lifecycle.get("load-sql") or []
    if create_extension and load_sql:
        return "CREATE EXTENSION + LOAD"
    if create_extension:
        return "CREATE EXTENSION"
    if load_sql:
        return "LOAD"
    return "manual"


def extension_version(extension: dict) -> str:
    control = extension.get("control")
    if isinstance(control, dict):
        version = control.get("default-version")
        if isinstance(version, str) and "@" not in version:
            return version
    return ""


def native_module_stem(extension: dict) -> str | None:
    module_file = extension.get("native-module-file") or extension.get("module-file")
    if not isinstance(module_file, str) or not module_file:
        return None
    for suffix in (".so", ".dylib", ".dll"):
        if module_file.endswith(suffix):
            return module_file[: -len(suffix)]
    return module_file


def shared_preload_libraries(extension: dict) -> list[str]:
    lifecycle = extension.get("lifecycle") or {}
    values = []
    for assignment in lifecycle.get("startup-config") or []:
        if not isinstance(assignment, str):
            continue
        key, separator, value = assignment.partition("=")
        if separator and key == "shared_preload_libraries":
            values.extend(part.strip() for part in value.split(",") if part.strip())
    return sorted(set(values))


def extension_data_files_from_recipe(extension: dict) -> list[str]:
    sql_name = extension.get("sql-name", extension.get("id"))
    if not isinstance(sql_name, str):
        return []
    recipe = ROOT / "src/extensions/external" / sql_name / "recipe.toml"
    if not recipe.exists():
        contrib_rows = read_toml(CONTRIB_RECIPE).get("extensions") or []
        for row in contrib_rows:
            if isinstance(row, dict) and row.get("sql-name") == sql_name:
                data_files = row.get("data-files") or []
                return sorted(value for value in data_files if isinstance(value, str))
        return []
    artifacts = read_toml(recipe).get("artifacts") or {}
    data_files = artifacts.get("data_files") or []
    return sorted(value for value in data_files if isinstance(value, str))


def extension_artifact_list_from_recipe(extension: dict, field: str) -> list[str]:
    sql_name = extension.get("sql-name", extension.get("id"))
    if not isinstance(sql_name, str):
        return []
    recipe = ROOT / "src/extensions/external" / sql_name / "recipe.toml"
    if not recipe.exists():
        return []
    artifacts = read_toml(recipe).get("artifacts") or {}
    values = artifacts.get(field) or []
    return sorted(value for value in values if isinstance(value, str))


def extension_runtime_environment_from_recipe(extension: dict) -> list[dict[str, str]]:
    sql_name = extension.get("sql-name", extension.get("id"))
    if not isinstance(sql_name, str):
        return []
    recipe = ROOT / "src/extensions/external" / sql_name / "recipe.toml"
    if not recipe.exists():
        return []
    rows = read_toml(recipe).get("runtime_environment") or []
    env = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        name = row.get("name")
        path = row.get("path")
        required_file = row.get("required_file")
        if all(isinstance(value, str) and value for value in (name, path, required_file)):
            env.append({"name": name, "path": path, "required_file": required_file})
    return sorted(env, key=lambda row: (row["name"], row["path"], row["required_file"]))


def runtime_share_data_files(data_files: list[str]) -> list[str]:
    prefix = "share/postgresql/"
    return sorted(value[len(prefix) :] if value.startswith(prefix) else value for value in data_files)


def contrib_recipe_row(sql_name: str) -> dict | None:
    for row in read_toml(CONTRIB_RECIPE).get("extensions") or []:
        if isinstance(row, dict) and row.get("sql-name") == sql_name:
            return row
    return None


def validate_string_list(values: object, label: str) -> list[str]:
    if values is None:
        return []
    if not isinstance(values, list) or not all(isinstance(value, str) and value for value in values):
        fail(f"{label} must be an array of non-empty strings")
    return values


def external_mobile_dependency_archive_map(sql_name: str) -> dict[str, list[str]]:
    deps_path = ROOT / "src/extensions/external" / sql_name / "deps.toml"
    if not deps_path.exists():
        return {}
    archive_map: dict[str, list[str]] = {}
    for row in read_toml(deps_path).get("dependencies") or []:
        if not isinstance(row, dict):
            fail(f"{rel(deps_path)} dependencies must be tables")
        name = row.get("name")
        if not isinstance(name, str) or not name:
            fail(f"{rel(deps_path)} dependency rows must define a name")
        archives = validate_string_list(
            row.get("mobile-static-dependencies"),
            f"{rel(deps_path)} dependency {name} mobile-static-dependencies",
        )
        archive_map[name] = archives or [name]
    return archive_map


def expand_mobile_static_dependencies(
    sql_name: str,
    dependency_names: list[str],
    archive_map: dict[str, list[str]],
) -> list[str]:
    archives: list[str] = []
    for dependency in dependency_names:
        if dependency not in archive_map:
            fail(f"mobile static dependency {dependency!r} for {sql_name} has no archive mapping")
        archives.extend(archive_map[dependency])
    return sorted(dict.fromkeys(archives))


def external_mobile_static_dependencies(sql_name: str, field: str) -> list[str]:
    target_path = ROOT / "src/extensions/external" / sql_name / "targets/native-static-registry.toml"
    if not target_path.exists():
        return []
    target = read_toml(target_path)
    dependencies = validate_string_list(target.get(field), f"{rel(target_path)} {field}")
    if not dependencies and field != "dependencies":
        dependencies = validate_string_list(target.get("dependencies"), f"{rel(target_path)} dependencies")
    return expand_mobile_static_dependencies(
        sql_name,
        dependencies,
        external_mobile_dependency_archive_map(sql_name),
    )


def contrib_mobile_static_dependencies(sql_name: str) -> list[str]:
    row = contrib_recipe_row(sql_name)
    if row is None:
        return []
    return sorted(
        dict.fromkeys(
            validate_string_list(
                row.get("mobile-static-dependencies"),
                f"{rel(CONTRIB_RECIPE)} row {sql_name} mobile-static-dependencies",
            )
        )
    )


def mobile_static_dependencies(sql_name: str, field: str = "dependencies") -> list[str]:
    external = external_mobile_static_dependencies(sql_name, field)
    if external:
        return external
    return contrib_mobile_static_dependencies(sql_name)


def contrib_mobile_static_list(sql_name: str, recipe_field: str) -> list[str]:
    row = contrib_recipe_row(sql_name)
    if row is None:
        return []
    return sorted(
        dict.fromkeys(
            validate_string_list(
                row.get(recipe_field),
                f"{rel(CONTRIB_RECIPE)} row {sql_name} {recipe_field}",
            )
        )
    )


def external_mobile_target_list(sql_name: str, field: str) -> list[str]:
    target_path = ROOT / "src/extensions/external" / sql_name / "targets/native-static-registry.toml"
    if not target_path.exists():
        return []
    target = read_toml(target_path)
    return sorted(
        dict.fromkeys(
            validate_string_list(target.get(field), f"{rel(target_path)} {field}")
        )
    )


def mobile_static_include_dependencies(sql_name: str) -> list[str]:
    external = external_mobile_target_list(sql_name, "include_dependencies")
    if external:
        return external
    return contrib_mobile_static_list(sql_name, "mobile-static-include-dependencies")


def mobile_static_include_dirs(sql_name: str) -> list[str]:
    external = external_mobile_target_list(sql_name, "include_dirs")
    if external:
        return external
    return contrib_mobile_static_list(sql_name, "mobile-static-include-dirs")


def mobile_static_cflags(sql_name: str) -> list[str]:
    external = external_mobile_target_list(sql_name, "cflags")
    if external:
        return external
    return contrib_mobile_static_list(sql_name, "mobile-static-cflags")


def mobile_static_hash_source_dependencies(sql_name: str, field: str = "dependencies") -> list[str]:
    target_path = ROOT / "src/extensions/external" / sql_name / "targets/native-static-registry.toml"
    if target_path.exists():
        target_field = {
            "dependencies": "dependencies",
            "ios_dependencies": "ios_dependencies",
            "android_dependencies": "android_dependencies",
        }[field]
        target = read_toml(target_path)
        dependencies = validate_string_list(target.get(target_field), f"{rel(target_path)} {target_field}")
        if not dependencies and target_field != "dependencies":
            dependencies = validate_string_list(target.get("dependencies"), f"{rel(target_path)} dependencies")
        return sorted(
            dict.fromkeys(
                dependencies
            )
        )
    return contrib_mobile_static_list(sql_name, "mobile-static-hash-source-dependencies")


def mobile_static_hash_dirs(sql_name: str) -> list[str]:
    external = external_mobile_target_list(sql_name, "hash_dirs")
    if external:
        return external
    return contrib_mobile_static_list(sql_name, "mobile-static-hash-dirs")


def mobile_static_source_files(sql_name: str) -> list[str]:
    return external_mobile_target_list(sql_name, "source_files")


def mobile_static_source_recursive_dirs(sql_name: str) -> list[str]:
    return external_mobile_target_list(sql_name, "source_recursive_dirs")


def external_target_data(sql_name: str, target: str) -> dict | None:
    path = ROOT / "src/extensions/external" / sql_name / "targets" / f"{target}.toml"
    if not path.exists():
        return None
    data = read_toml(path)
    status = data.get("status")
    if status not in SUPPORT_STATUSES:
        fail(f"{rel(path)} status has invalid value {status!r}")
    return data


def external_target_status(sql_name: str, target: str) -> str | None:
    data = external_target_data(sql_name, target)
    if data is None:
        return None
    return str(data["status"])


def external_recipe_support(sql_name: str) -> dict:
    recipe = ROOT / "src/extensions/external" / sql_name / "recipe.toml"
    if not recipe.exists():
        return {}
    support = read_toml(recipe).get("support") or {}
    return support if isinstance(support, dict) else {}


def extension_target_statuses(sql_name: str) -> dict[str, str | None]:
    return {
        "native": external_target_status(sql_name, "native"),
        "wasix": external_target_status(sql_name, "wasix"),
        "mobile": external_target_status(sql_name, "mobile"),
    }


def extension_support_statuses(sql_name: str) -> dict:
    support = external_recipe_support(sql_name)
    return {
        family: {
            mode: status
            for mode, status in claims.items()
            if isinstance(mode, str) and status in SUPPORT_STATUSES
        }
        for family, claims in support.items()
        if isinstance(family, str) and isinstance(claims, dict)
    }


def mobile_release_ready(sql_name: str) -> bool:
    target_status = external_target_status(sql_name, "mobile")
    if target_status is not None:
        return target_status == "supported"

    mobile_support = extension_support_statuses(sql_name).get("mobile")
    if mobile_support:
        return all(status == "supported" for status in mobile_support.values())

    return True


def desktop_release_ready(sql_name: str, promotion: dict) -> bool:
    if not (bool(promotion.get("promoted")) and bool(promotion.get("stable"))):
        return False

    target_status = external_target_status(sql_name, "native")
    if target_status is not None:
        return target_status == "supported"

    native_support = extension_support_statuses(sql_name).get("native")
    if native_support:
        return all(status == "supported" for status in native_support.values())

    return True


def target_native_support_modules(sql_name: str, target: str) -> list[dict]:
    path = ROOT / "src/extensions/external" / sql_name / "targets" / f"{target}.toml"
    if not path.exists():
        return []
    rows = read_toml(path).get("native_support_modules") or []
    modules = []
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            fail(f"{rel(path)} native_support_modules[{index}] must be a table")
        module = {}
        for field in ("name", "runtime_path", "build_path", "aot_file"):
            value = row.get(field)
            if not isinstance(value, str) or not value:
                fail(f"{rel(path)} native_support_modules[{index}] must define {field}")
            module[field.replace("_", "-")] = value
        modules.append(module)
    modules.sort(key=lambda module: module["name"])
    return modules


def generated_sdk_metadata(catalog: dict, sdk: str) -> dict:
    rows = []
    public_sql_names = {
        extension.get("sql-name", extension.get("id"))
        for extension in catalog.get("extensions", [])
        if (extension.get("promotion") or {}).get("promoted") is True
    }
    for extension in catalog.get("extensions", []):
        promotion = extension.get("promotion") or {}
        if promotion.get("promoted") is not True:
            continue
        data_files = extension_data_files_from_recipe(extension)
        dependencies = extension.get("dependencies") or []
        sql_name = str(extension.get("sql-name", extension.get("id")))
        rows.append(
            {
                "id": extension.get("id"),
                "sql-name": sql_name,
                "display-name": extension.get("display-name", extension.get("id")),
                "postgres-major": 18,
                "creates-extension": bool((extension.get("lifecycle") or {}).get("create-extension")),
                "native-module-stem": native_module_stem(extension),
                "dependencies": dependencies,
                "selected-extension-dependencies": sorted(
                    dependency for dependency in dependencies if dependency in public_sql_names
                ),
                "native-dependencies": extension.get("native-dependencies") or [],
                "shared-preload-libraries": shared_preload_libraries(extension),
                "data-files": data_files,
                "runtime-share-data-files": runtime_share_data_files(data_files),
                "extension-sql-file-prefixes": extension_artifact_list_from_recipe(
                    extension, "extension_sql_file_prefixes"
                ),
                "extension-sql-file-names": extension_artifact_list_from_recipe(
                    extension, "extension_sql_file_names"
                ),
                "runtime-environment": extension_runtime_environment_from_recipe(extension),
                "public": bool(promotion.get("promoted")),
                "stable": bool(promotion.get("stable")),
                "desktop-release-ready": desktop_release_ready(sql_name, promotion),
                "mobile-release-ready": mobile_release_ready(sql_name),
                "target-status": extension_target_statuses(sql_name),
                "support": extension_support_statuses(sql_name),
                "source-kind": extension.get("source-kind"),
                "archive": promotion.get("archive") or "",
            }
        )
    rows.sort(key=lambda row: (str(row["sql-name"]), str(row["id"])))
    return {
        "format-version": 1,
        "consumer": sdk,
        "generated-from": [
            {"name": "extension-catalog", "path": rel(CATALOG)},
            {"name": "extension-evidence", "path": rel(EVIDENCE_TABLE)},
        ],
        "extensions": rows,
    }


def generated_typescript_extension_module(metadata: dict) -> str:
    def camel(row: dict) -> dict:
        return {
            "id": row["id"],
            "sqlName": row["sql-name"],
            "displayName": row["display-name"],
            "postgresMajor": row["postgres-major"],
            "createsExtension": row["creates-extension"],
            "nativeModuleStem": row["native-module-stem"],
            "dependencies": row["dependencies"],
            "selectedExtensionDependencies": row["selected-extension-dependencies"],
            "nativeDependencies": row["native-dependencies"],
            "sharedPreloadLibraries": row["shared-preload-libraries"],
            "dataFiles": row["data-files"],
            "runtimeShareDataFiles": row["runtime-share-data-files"],
            "extensionSqlFilePrefixes": row["extension-sql-file-prefixes"],
            "extensionSqlFileNames": row["extension-sql-file-names"],
            "public": row["public"],
            "stable": row["stable"],
            "desktopReleaseReady": row["desktop-release-ready"],
            "mobileReleaseReady": row["mobile-release-ready"],
            "targetStatus": row["target-status"],
            "support": row["support"],
            "sourceKind": row["source-kind"],
            "archive": row["archive"],
        }

    rows = [camel(row) for row in metadata.get("extensions", [])]
    source = (
        "// This file is generated by src/extensions/tools/check-extension-model.py.\n"
        "// Do not edit by hand.\n\n"
        "export type GeneratedExtensionMetadata = {\n"
        "  readonly id: string;\n"
        "  readonly sqlName: string;\n"
        "  readonly displayName: string;\n"
        "  readonly postgresMajor: number;\n"
        "  readonly createsExtension: boolean;\n"
        "  readonly nativeModuleStem: string | null;\n"
        "  readonly dependencies: readonly string[];\n"
        "  readonly selectedExtensionDependencies: readonly string[];\n"
        "  readonly nativeDependencies: readonly string[];\n"
        "  readonly sharedPreloadLibraries: readonly string[];\n"
        "  readonly dataFiles: readonly string[];\n"
        "  readonly runtimeShareDataFiles: readonly string[];\n"
        "  readonly extensionSqlFilePrefixes: readonly string[];\n"
        "  readonly extensionSqlFileNames: readonly string[];\n"
        "  readonly public: boolean;\n"
        "  readonly stable: boolean;\n"
        "  readonly desktopReleaseReady: boolean;\n"
        "  readonly mobileReleaseReady: boolean;\n"
        "  readonly targetStatus: { readonly native?: string | null; readonly wasix?: string | null; readonly mobile?: string | null };\n"
        "  readonly support: Readonly<Record<string, Readonly<Record<string, string>>>>;\n"
        "  readonly sourceKind: string;\n"
        "  readonly archive: string;\n"
        "};\n\n"
        f"export const GENERATED_EXTENSION_METADATA = {json.dumps(rows, indent=2, sort_keys=True)} as const satisfies readonly GeneratedExtensionMetadata[];\n\n"
        "export function generatedExtensionBySqlName(sqlName: string): GeneratedExtensionMetadata | undefined {\n"
        "  return GENERATED_EXTENSION_METADATA.find((extension) => extension.sqlName === sqlName);\n"
        "}\n\n"
        "export function generatedSharedPreloadLibraries(extensionSqlNames: readonly string[]): string[] {\n"
        "  const libraries = new Set<string>();\n"
        "  for (const sqlName of extensionSqlNames) {\n"
        "    const extension = generatedExtensionBySqlName(sqlName);\n"
        "    for (const library of extension?.sharedPreloadLibraries ?? []) {\n"
        "      libraries.add(library);\n"
        "    }\n"
        "  }\n"
        "  return [...libraries].sort();\n"
        "}\n"
    )
    return format_typescript_source(source, GENERATED_TS_SDK_MODULE)


def generated_kotlin_extension_module(metadata: dict) -> str:
    names = sorted(str(row["sql-name"]) for row in metadata.get("extensions", []))
    body = "\n".join(f"    {json.dumps(name)}," for name in names)
    return (
        "// This file is generated by src/extensions/tools/check-extension-model.py.\n"
        "// Do not edit by hand.\n\n"
        "package dev.oliphaunt\n\n"
        "internal val generatedExtensionSqlNames: Set<String> = setOf(\n"
        f"{body}\n"
        ")\n\n"
        "internal fun generatedExtensionSqlNameExists(sqlName: String): Boolean = generatedExtensionSqlNames.contains(sqlName)\n"
    )


def rust_string_literal(value: str) -> str:
    return json.dumps(value)


def rust_variant_from_constant(value: str) -> str:
    parts = [part for part in value.split("_") if part]
    if not parts:
        fail(f"invalid rust extension constant {value!r}")
    return "".join(part.lower().capitalize() for part in parts)


def rust_extension_expr(row: dict) -> str:
    return f"Extension::{rust_variant_from_constant(str(row['rust-constant']))}"


def rust_doc_comment(text: str, *, indent: str = "") -> str:
    escaped = text.replace("*/", "* /")
    return "\n".join(f"{indent}/// {line}" if line else f"{indent}///" for line in escaped.splitlines())


def rust_array(
    values: list[str],
    *,
    item_indent: str = "    ",
    closing_indent: str = "",
) -> str:
    if not values:
        return "&[]"
    if len(values) <= 2 and all(len(value) <= 72 for value in values):
        return f"&[{', '.join(values)}]"
    rendered = "".join(f"{item_indent}{value},\n" for value in values)
    return "&[\n" + rendered + closing_indent + "]"


def rust_extension_slice(
    rows: list[dict],
    *,
    item_indent: str = "    ",
    closing_indent: str = "",
) -> str:
    return rust_array(
        [rust_extension_expr(row) for row in rows],
        item_indent=item_indent,
        closing_indent=closing_indent,
    )


def rust_option_string(value: object) -> str:
    if value is None or value == "":
        return "None"
    if not isinstance(value, str):
        fail(f"Rust string option must be a string or null, got {value!r}")
    return f"Some({rust_string_literal(value)})"


def rust_string_slice(
    values: list[str],
    *,
    item_indent: str = "    ",
    closing_indent: str = "",
) -> str:
    return rust_array(
        [rust_string_literal(value) for value in values],
        item_indent=item_indent,
        closing_indent=closing_indent,
    )


def rust_runtime_environment_slice(
    values: list[dict],
    *,
    item_indent: str = "    ",
    closing_indent: str = "",
) -> str:
    if len(values) == 1:
        value = values[0]
        field_indent = item_indent
        return (
            "&[ExtensionRuntimeEnvironment {\n"
            f"{field_indent}name: {rust_string_literal(value['name'])},\n"
            f"{field_indent}relative_path: {rust_string_literal(value['path'])},\n"
            f"{field_indent}required_file: {rust_string_literal(value['required_file'])},\n"
            f"{closing_indent}}}]"
        )
    return rust_array(
        [
            "ExtensionRuntimeEnvironment { "
            f"name: {rust_string_literal(value['name'])}, "
            f"relative_path: {rust_string_literal(value['path'])}, "
            f"required_file: {rust_string_literal(value['required_file'])} "
            "}"
            for value in values
        ],
        item_indent=item_indent,
        closing_indent=closing_indent,
    )


def rust_extension_dependency_slice(
    values: list[str],
    rows_by_sql_name: dict[str, dict],
    *,
    item_indent: str = "    ",
    closing_indent: str = "",
) -> str:
    if not values:
        return "&[]"
    dependencies = []
    for value in values:
        dependency = rows_by_sql_name.get(value)
        if dependency is None:
            fail(f"generated Rust dependency {value!r} is not a known Rust extension row")
        dependencies.append(rust_extension_expr(dependency))
    return rust_array(
        dependencies,
        item_indent=item_indent,
        closing_indent=closing_indent,
    )


def generated_rust_extension_rows(catalog: dict) -> list[dict]:
    rows = []
    public_sql_names = {
        extension.get("sql-name", extension.get("id"))
        for extension in catalog.get("extensions", [])
        if (extension.get("promotion") or {}).get("promoted") is True
    }
    for extension in catalog.get("extensions", []):
        promotion = extension.get("promotion") or {}
        if promotion.get("promoted") is not True:
            continue
        sql_name = str(extension.get("sql-name", extension.get("id")))
        rows.append(
            {
                "id": extension.get("id"),
                "sql-name": sql_name,
                "rust-constant": extension.get("rust-constant"),
                "creates-extension": bool((extension.get("lifecycle") or {}).get("create-extension")),
                "native-module-stem": native_module_stem(extension),
                "selected-extension-dependencies": sorted(
                    dependency
                    for dependency in (extension.get("dependencies") or [])
                    if dependency in public_sql_names
                ),
                "runtime-share-data-files": runtime_share_data_files(
                    extension_data_files_from_recipe(extension)
                ),
                "shared-preload-libraries": shared_preload_libraries(extension),
                "first-party": True,
                "desktop-release-ready": desktop_release_ready(sql_name, promotion),
                "mobile-release-ready": mobile_release_ready(sql_name),
                "extension-sql-file-prefixes": extension_artifact_list_from_recipe(
                    extension, "extension_sql_file_prefixes"
                ),
                "extension-sql-file-names": extension_artifact_list_from_recipe(
                    extension, "extension_sql_file_names"
                ),
                "runtime-environment": extension_runtime_environment_from_recipe(extension),
                "external-policy": None,
            }
        )
    rows.extend(RUST_INTERNAL_EXTENSION_CANDIDATES)
    rows.sort(key=lambda row: str(row["sql-name"]))
    for row in rows:
        if not isinstance(row.get("rust-constant"), str) or not row["rust-constant"]:
            fail(f"Rust generated extension row {row.get('id')} must define rust-constant")
    return rows


def rust_match(
    function_name: str,
    return_type: str,
    rows: list[dict],
    value_for_row,
) -> str:
    arms = [
        f"        {rust_extension_expr(row)} => {value_for_row(row)},"
        for row in rows
    ]
    signature = f"pub(super) const fn {function_name}(extension: Extension) -> {return_type} {{"
    if len(signature) > 100:
        signature = (
            f"pub(super) const fn {function_name}(\n"
            "    extension: Extension,\n"
            f") -> {return_type} {{"
        )
    return (
        "/// Generated extension metadata accessor.\n"
        f"{signature}\n"
        "    match extension {\n"
        + "\n".join(arms)
        + "\n    }\n"
        "}\n"
    )


def generated_rust_extension_module(catalog: dict) -> str:
    rows = generated_rust_extension_rows(catalog)
    rows_by_sql_name = {str(row["sql-name"]): row for row in rows}
    first_party_rows = [row for row in rows if row["first-party"]]
    release_ready_rows = [row for row in rows if row.get("desktop-release-ready")]
    external_rows = [row for row in rows if not row["first-party"]]
    mobile_ready_rows = [row for row in rows if row["mobile-release-ready"]]

    for row in rows:
        if len(row["shared-preload-libraries"]) > 1:
            fail(
                f"Rust Extension::required_shared_preload_library supports one library; "
                f"{row['sql-name']} declared {row['shared-preload-libraries']}"
            )

    text = [
        "// @generated by src/extensions/tools/check-extension-model.py --write",
        "// Do not edit by hand.",
        "",
        "use super::{",
        "    ExtensionArtifactPolicy, ExtensionCoverage, ExtensionManifestEntry, ExtensionModuleAsset,",
        "    ExtensionRedistribution, ExtensionRuntimeEnvironment, ExtensionSmokePlan, ExtensionSourceKind,",
        "    ExtensionSqlAsset, MobileStaticLinkStatus,",
        "};",
        "",
        "/// Native PostgreSQL 18 extension that can be explicitly selected by an app.",
        "#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]",
        "pub enum Extension {",
    ]

    for row in rows:
        doc_prefix = "PostgreSQL"
        policy = row.get("external-policy")
        if isinstance(policy, dict):
            upstream = str(policy.get("upstream", ""))
            if "pggraph" in upstream:
                doc_prefix = "pgGraph"
            elif "paradedb" in upstream:
                doc_prefix = "ParadeDB"
        text.extend(
            [
                rust_doc_comment(f"{doc_prefix} `{row['sql-name']}`.", indent="    "),
                f"    {rust_variant_from_constant(str(row['rust-constant']))},",
            ]
        )

    text.extend(
        [
            "}",
            "",
        "/// First-party PostgreSQL 18 extensions generated from the shared catalog.",
        f"pub(super) const FIRST_PARTY_PG18_SUPPORTED: &[Extension] = {rust_extension_slice(first_party_rows)};",
        "/// Public release-ready PostgreSQL 18 extensions generated from the shared catalog.",
        f"pub(super) const RELEASE_READY_PG18_SUPPORTED: &[Extension] = {rust_extension_slice(release_ready_rows)};",
        "/// Mobile release-ready PostgreSQL 18 extensions generated from the shared catalog.",
        f"pub(super) const MOBILE_RELEASE_READY_PG18_SUPPORTED: &[Extension] = {rust_extension_slice(mobile_ready_rows)};",
        "/// External PostgreSQL 18 extension candidates generated from explicit metadata.",
        f"pub(super) const EXTERNAL_PG18_SUPPORTED: &[Extension] = {rust_extension_slice(external_rows)};",
        "/// All PostgreSQL 18 extension rows known to the Rust SDK.",
        f"pub(super) const ALL_PG18_SUPPORTED: &[Extension] = {rust_extension_slice(rows)};",
        "",
        rust_match("sql_name", "&'static str", rows, lambda row: rust_string_literal(row["sql-name"])),
        rust_match(
            "native_module_stem",
            "Option<&'static str>",
            rows,
            lambda row: rust_option_string(row["native-module-stem"]),
        ),
        rust_match(
            "creates_extension",
            "bool",
            rows,
            lambda row: "true" if row["creates-extension"] else "false",
        ),
        rust_match(
            "dependencies",
            "&'static [Extension]",
            rows,
            lambda row: rust_extension_dependency_slice(
                row["selected-extension-dependencies"],
                rows_by_sql_name,
                item_indent="            ",
                closing_indent="        ",
            ),
        ),
        rust_match(
            "desktop_release_ready",
            "bool",
            rows,
            lambda row: "true" if row.get("desktop-release-ready") else "false",
        ),
        rust_match(
            "mobile_release_ready",
            "bool",
            rows,
            lambda row: "true" if row["mobile-release-ready"] else "false",
        ),
        rust_match(
            "required_shared_preload_library",
            "Option<&'static str>",
            rows,
            lambda row: rust_option_string(
                row["shared-preload-libraries"][0]
                if row["shared-preload-libraries"]
                else None
            ),
        ),
        rust_match(
            "extension_data_files",
            "&'static [&'static str]",
            rows,
            lambda row: rust_string_slice(
                row["runtime-share-data-files"],
                item_indent="            ",
                closing_indent="        ",
            ),
        ),
        rust_match(
            "extension_sql_file_prefixes",
            "&'static [&'static str]",
            rows,
            lambda row: rust_string_slice(
                row.get("extension-sql-file-prefixes") or [],
                item_indent="            ",
                closing_indent="        ",
            ),
        ),
        rust_match(
            "extension_sql_file_names",
            "&'static [&'static str]",
            rows,
            lambda row: rust_string_slice(
                row.get("extension-sql-file-names") or [],
                item_indent="            ",
                closing_indent="        ",
            ),
        ),
        rust_match(
            "runtime_environment",
            "&'static [ExtensionRuntimeEnvironment]",
            rows,
            lambda row: rust_runtime_environment_slice(
                row.get("runtime-environment") or [],
                item_indent="            ",
                closing_indent="        ",
            ),
        ),
    ]
    )

    artifact_arms = []
    for row in rows:
        policy = row.get("external-policy")
        if policy is None:
            artifact_arms.append(f"        {rust_extension_expr(row)} => ExtensionArtifactPolicy::FirstParty,")
            continue
        artifact_arms.append(
            "\n".join(
                [
                    f"        {rust_extension_expr(row)} => ExtensionArtifactPolicy::External {{",
                    f"            upstream: {rust_string_literal(policy['upstream'])},",
                    f"            license: {rust_string_literal(policy['license'])},",
                    f"            source_kind: ExtensionSourceKind::{policy['source-kind']},",
                    f"            redistribution: ExtensionRedistribution::{policy['redistribution']},",
                    f"            requires_shared_preload: {'true' if policy['requires-shared-preload'] else 'false'},",
                    f"            notes: {rust_string_literal(policy['notes'])},",
                    "        },",
                ]
            )
        )
    text.append(
        "/// Generated extension packaging policy accessor.\n"
        "pub(super) const fn artifact_policy(extension: Extension) -> ExtensionArtifactPolicy {\n"
        "    match extension {\n"
        + "\n".join(artifact_arms)
        + "\n    }\n"
        "}\n"
    )

    manifest_rows = ",\n".join(
        f"    manifest_entry({rust_extension_expr(row)})" for row in rows
    )
    text.append(
        "/// Static native extension manifest generated from the shared catalog.\n"
        "pub(super) const NATIVE_EXTENSION_MANIFEST: &[ExtensionManifestEntry] = &[\n"
        f"{manifest_rows},\n"
        "];\n"
    )
    text.append(
        "const fn manifest_entry(extension: Extension) -> ExtensionManifestEntry {\n"
        "    let module = match native_module_stem(extension) {\n"
        "        Some(stem) => ExtensionModuleAsset::NativeModule { stem },\n"
        "        None => ExtensionModuleAsset::SqlOnly,\n"
        "    };\n"
        "    let sql_assets = if creates_extension(extension) {\n"
        "        ExtensionSqlAsset::ControlAndSql\n"
        "    } else {\n"
        "        ExtensionSqlAsset::LoadableModuleOnly\n"
        "    };\n"
        "    let smoke = if creates_extension(extension) {\n"
        "        ExtensionSmokePlan::CreateExtensionCascade\n"
        "    } else {\n"
        "        ExtensionSmokePlan::LoadSharedLibrary\n"
        "    };\n"
        "    let mobile_static_link = match module {\n"
        "        ExtensionModuleAsset::NativeModule { .. } => MobileStaticLinkStatus::PendingRegistry,\n"
        "        ExtensionModuleAsset::SqlOnly => MobileStaticLinkStatus::NotRequiredSqlOnly,\n"
        "    };\n"
        "    ExtensionManifestEntry {\n"
        "        extension,\n"
        "        sql_name: sql_name(extension),\n"
        "        pg_major: 18,\n"
        "        pg18_supported: true,\n"
        "        creates_extension: creates_extension(extension),\n"
        "        sql_assets,\n"
        "        module,\n"
        "        dependencies: dependencies(extension),\n"
        "        data_files: extension_data_files(extension),\n"
        "        smoke,\n"
        "        coverage: ExtensionCoverage::GATED_RELEASE_MATRIX,\n"
        "        mobile_static_link,\n"
        "        artifact_policy: artifact_policy(extension),\n"
        "    }\n"
        "}\n"
    )

    return format_rust_source("\n".join(text))


def validate_generated_text_file(path: Path, expected: str, write: bool) -> None:
    if write:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(expected, encoding="utf-8")
        return
    if not path.exists():
        fail(f"{rel(path)} is missing; run src/extensions/tools/check-extension-model.py --write")
    if path.read_text(encoding="utf-8") != expected:
        fail(f"{rel(path)} is stale; run src/extensions/tools/check-extension-model.py --write")


def generated_mobile_registry(catalog: dict) -> dict:
    rows = []
    for extension in catalog.get("extensions", []):
        promotion = extension.get("promotion") or {}
        if promotion.get("promoted") is not True:
            continue
        stem = native_module_stem(extension)
        if stem is None:
            continue
        rows.append(
            {
                "id": extension.get("id"),
                "sql-name": extension.get("sql-name", extension.get("id")),
                "native-module-stem": stem,
                "data-files": extension_data_files_from_recipe(extension),
                "native-dependencies": extension.get("native-dependencies") or [],
                "static-registry-required": True,
            }
        )
    rows.sort(key=lambda row: (str(row["sql-name"]), str(row["id"])))
    return {
        "format-version": 1,
        "generated-from": [
            {"name": "extension-catalog", "path": rel(CATALOG)},
            {"name": "extension-definitions", "path": "src/extensions/external"},
        ],
        "modules": rows,
    }


def generated_mobile_static_specs(catalog: dict, build_plan: dict) -> str:
    plan_by_sql_name = {
        row.get("sql-name", row.get("id")): row
        for row in build_plan.get("extensions", [])
        if isinstance(row, dict)
    }
    rows = []
    for module in generated_mobile_registry(catalog)["modules"]:
        sql_name = module["sql-name"]
        plan = plan_by_sql_name.get(sql_name)
        if plan is None:
            fail(f"mobile static module {sql_name} has no generated build-plan row")
        build_kind = plan.get("build-kind")
        if build_kind == "postgres-contrib":
            contrib_dir = plan.get("contrib-dir")
            if not isinstance(contrib_dir, str) or not contrib_dir:
                fail(f"mobile static contrib module {sql_name} is missing contrib-dir")
            source_kind = "contrib"
            source_rel = f"contrib/{contrib_dir}"
        else:
            source_dir = plan.get("source-dir")
            if not isinstance(source_dir, str) or not source_dir:
                fail(f"mobile static external module {sql_name} is missing source-dir")
            source_kind = "external"
            source_rel = source_dir
        static_dependencies = ",".join(mobile_static_dependencies(sql_name))
        ios_static_dependencies = ",".join(mobile_static_dependencies(sql_name, "ios_dependencies"))
        android_static_dependencies = ",".join(mobile_static_dependencies(sql_name, "android_dependencies"))
        include_dependencies = ",".join(mobile_static_include_dependencies(sql_name))
        include_dirs = ",".join(mobile_static_include_dirs(sql_name))
        cflags = ",".join(mobile_static_cflags(sql_name))
        hash_source_dependencies = ",".join(mobile_static_hash_source_dependencies(sql_name))
        ios_hash_source_dependencies = ",".join(
            mobile_static_hash_source_dependencies(sql_name, "ios_dependencies")
        )
        android_hash_source_dependencies = ",".join(
            mobile_static_hash_source_dependencies(sql_name, "android_dependencies")
        )
        hash_dirs = ",".join(mobile_static_hash_dirs(sql_name))
        source_files = ",".join(mobile_static_source_files(sql_name))
        source_recursive_dirs = ",".join(mobile_static_source_recursive_dirs(sql_name))
        rows.append(
            [
                sql_name,
                module["native-module-stem"],
                source_kind,
                source_rel,
                static_dependencies,
                ios_static_dependencies,
                android_static_dependencies,
                include_dependencies,
                include_dirs,
                cflags,
                hash_source_dependencies,
                ios_hash_source_dependencies,
                android_hash_source_dependencies,
                hash_dirs,
                source_files,
                source_recursive_dirs,
            ]
        )
    rows.sort(key=lambda row: row[0])
    lines = [
        "# @generated by src/extensions/tools/check-extension-model.py --write",
        (
            "sql-name\tnative-module-stem\tsource-kind\tsource-rel"
            "\tmobile-static-dependencies\tios-static-dependencies\tandroid-static-dependencies"
                "\tinclude-dependencies\tinclude-dirs\tcflags"
                "\thash-source-dependencies\tios-hash-source-dependencies"
                "\tandroid-hash-source-dependencies\thash-dirs"
                "\tsource-files\tsource-recursive-dirs"
            ),
        *["\t".join(row).rstrip("\t") for row in rows],
        "",
    ]
    return "\n".join(lines)


def generated_wasix_metadata(catalog: dict) -> dict:
    rows = []
    for extension in catalog.get("extensions", []):
        promotion = extension.get("promotion") or {}
        if promotion.get("promoted") is not True:
            continue
        rows.append(
            {
                "id": extension.get("id"),
                "sql-name": extension.get("sql-name", extension.get("id")),
                "archive": promotion.get("archive") or extension.get("archive", ""),
                "native-module-file": extension.get("native-module-file") or extension.get("module-file"),
                "native-support-modules": target_native_support_modules(
                    str(extension.get("sql-name", extension.get("id"))),
                    "wasix",
                ),
                "dependencies": extension.get("dependencies") or [],
                "load-order": extension.get("load-order") or [],
                "lifecycle": extension.get("lifecycle") or {},
            }
        )
    rows.sort(key=lambda row: (str(row["sql-name"]), str(row["id"])))
    return {
        "format-version": 1,
        "generated-from": [
            {"name": "extension-catalog", "path": rel(CATALOG)},
            {"name": "extension-definitions", "path": "src/extensions/external"},
        ],
        "extensions": rows,
    }


def validate_generated_file(path: Path, expected: dict, write: bool) -> None:
    text = json_text(expected)
    if write:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return
    if not path.exists():
        fail(f"{rel(path)} is missing; run src/extensions/tools/check-extension-model.py --write")
    if path.read_text(encoding="utf-8") != text:
        fail(f"{rel(path)} is stale; run src/extensions/tools/check-extension-model.py --write")
    parsed = read_json(path)
    if parsed.get("format-version") != 1:
        fail(f"{rel(path)} must use format-version 1")


def validate_generated_sdk_metadata(catalog: dict, build_plan: dict, write: bool) -> None:
    for sdk, path in GENERATED_SDKS.items():
        validate_generated_file(path, generated_sdk_metadata(catalog, sdk), write)
    js_metadata = generated_sdk_metadata(catalog, "js")
    kotlin_metadata = generated_sdk_metadata(catalog, "kotlin")
    rn_metadata = generated_sdk_metadata(catalog, "react-native")
    validate_generated_text_file(
        GENERATED_RUST_SDK_MODULE,
        generated_rust_extension_module(catalog),
        write,
    )
    validate_generated_text_file(
        GENERATED_TS_SDK_MODULE,
        generated_typescript_extension_module(js_metadata),
        write,
    )
    validate_generated_text_file(
        GENERATED_RN_SDK_MODULE,
        generated_typescript_extension_module(rn_metadata),
        write,
    )
    validate_generated_text_file(
        GENERATED_KOTLIN_SDK_MODULE,
        generated_kotlin_extension_module(kotlin_metadata),
        write,
    )
    validate_generated_file(GENERATED_KOTLIN_SDK_METADATA, kotlin_metadata, write)
    validate_generated_file(GENERATED_RN_PLUGIN_METADATA, rn_metadata, write)
    validate_generated_file(GENERATED_MOBILE_REGISTRY, generated_mobile_registry(catalog), write)
    validate_generated_text_file(
        GENERATED_MOBILE_STATIC_SPECS,
        generated_mobile_static_specs(catalog, build_plan),
        write,
    )
    validate_generated_file(GENERATED_WASIX_METADATA, generated_wasix_metadata(catalog), write)


def generated_support_table(catalog: dict) -> dict:
    rows = []
    for extension in catalog.get("extensions", []):
        promotion = extension.get("promotion") or {}
        lifecycle = extension.get("lifecycle") or {}
        smoke = extension.get("smoke") or {}
        sql_name = str(extension.get("sql-name", extension.get("id")))
        rows.append(
            {
                "id": extension.get("id"),
                "sql-name": sql_name,
                "display-name": extension.get("display-name", extension.get("id")),
                "version": extension_version(extension),
                "family": extension_family(extension.get("source-kind")),
                "public": bool(promotion.get("promoted")),
                "stable": bool(promotion.get("stable")),
                "packaged": bool(promotion.get("packaged")),
                "promoted": bool(promotion.get("promoted")),
                "desktop-release-ready": desktop_release_ready(sql_name, promotion),
                "mobile-release-ready": mobile_release_ready(sql_name),
                "target-status": extension_target_statuses(sql_name),
                "support": extension_support_statuses(sql_name),
                "archive": promotion.get("archive") or "",
                "blocker": promotion.get("blocker") or "",
                "activation": extension_activation(extension),
                "dependencies": extension.get("dependencies") or [],
                "native-dependencies": extension.get("native-dependencies") or [],
                "preload-required": bool(lifecycle.get("preload-required")),
                "restart-required": bool(lifecycle.get("restart-required")),
                "smoke": {
                    "direct": smoke.get("direct", "not-run"),
                    "server": smoke.get("server", "not-run"),
                    "restart": smoke.get("restart", "not-run"),
                    "dump-restore": smoke.get("dump-restore", "not-run"),
                },
            }
        )
    rows.sort(key=lambda row: (str(row["sql-name"]), str(row["id"])))
    return {
        "format-version": 1,
        "generated-from": [
            {"name": "extension-catalog", "path": rel(CATALOG)},
            {"name": "extension-build-plan", "path": rel(BUILD_PLAN)},
            {"name": "promotion-config", "path": rel(PROMOTED)},
            {"name": "smoke-evidence", "path": rel(SMOKE)},
        ],
        "extensions": rows,
    }


def json_text(value: dict) -> str:
    return json.dumps(value, indent=2, sort_keys=True) + "\n"


def validate_support_table(catalog: dict, write: bool) -> None:
    expected = json_text(generated_support_table(catalog))
    if write:
        SUPPORT_TABLE.parent.mkdir(parents=True, exist_ok=True)
        SUPPORT_TABLE.write_text(expected, encoding="utf-8")
        return
    if not SUPPORT_TABLE.exists():
        fail(f"{rel(SUPPORT_TABLE)} is missing; run src/extensions/tools/check-extension-model.py --write")
    actual = SUPPORT_TABLE.read_text(encoding="utf-8")
    if actual != expected:
        fail(f"{rel(SUPPORT_TABLE)} is stale; run src/extensions/tools/check-extension-model.py --write")
    table = read_json(SUPPORT_TABLE)
    if table.get("format-version") != 1:
        fail(f"{rel(SUPPORT_TABLE)} must use format-version 1")
    if not table.get("extensions"):
        fail(f"{rel(SUPPORT_TABLE)} must define extension rows")


def public_extensions(catalog: dict) -> list[dict]:
    rows = [
        extension
        for extension in catalog.get("extensions", [])
        if (extension.get("promotion") or {}).get("promoted") is True
    ]
    rows.sort(key=lambda row: (str(row.get("sql-name", row.get("id"))), str(row.get("id"))))
    return rows


def format_toml_string_list(values: list[str]) -> str:
    return "[" + ", ".join(json.dumps(value) for value in values) + "]"


def write_evidence_files(catalog: dict) -> None:
    public_rows = public_extensions(catalog)
    matrix_lines = [
        "format-version = 1",
        "source-digest-inputs = [",
        *[f'  "{path}",' for path in source_digest_inputs()],
        "]",
        "",
    ]
    for extension in public_rows:
        extension_id = validate_id(extension.get("id"), "public extension id")
        matrix_lines.extend(
            [
                "[[claims]]",
                f'extension = "{extension_id}"',
                "postgres-major = 18",
                'artifact-family = "wasix-runtime"',
                'platform-targets = ["portable"]',
                'runtime-modes = ["direct", "server", "restart", "dump-restore"]',
                'evidence-required = ["transitional-catalog-smoke"]',
                "public = true",
                "",
            ]
        )
    EVIDENCE_MATRIX.parent.mkdir(parents=True, exist_ok=True)
    EVIDENCE_MATRIX.write_text("\n".join(matrix_lines).rstrip() + "\n", encoding="utf-8")

    results = []
    for extension in public_rows:
        smoke = extension.get("smoke") or {}
        statuses = {
            "direct": smoke.get("direct", "not-run"),
            "server": smoke.get("server", "not-run"),
            "restart": smoke.get("restart", "not-run"),
            "dump-restore": smoke.get("dump-restore", "not-run"),
        }
        results.append(
            {
                "extension": extension.get("id"),
                "sqlName": extension.get("sql-name", extension.get("id")),
                "postgresMajor": 18,
                "artifactFamily": "wasix-runtime",
                "platformTarget": "portable",
                "runtimeModeStatuses": statuses,
            }
        )
    run = {
        "schema": "oliphaunt-extension-evidence-v1",
        "id": "2026-06-07-transitional-catalog-smoke",
        "evidenceTier": "transitional-catalog-smoke",
        "status": "passed",
        "sourceDigest": source_digest(),
        "sourceDigestInputs": source_digest_inputs(),
        "observedAt": "2026-06-07T00:00:00Z",
        "collector": "src/extensions/tools/check-extension-model.py --write-evidence",
        "notes": (
            "Transitional evidence imported from extensions.smoke.toml while "
            "per-recipe evidence runs are introduced."
        ),
        "results": results,
    }
    EVIDENCE_RUNS.mkdir(parents=True, exist_ok=True)
    (EVIDENCE_RUNS / "2026-06-07-transitional-catalog-smoke.json").write_text(
        json_text(run),
        encoding="utf-8",
    )


def validate_evidence(catalog: dict) -> dict:
    for path in (EVIDENCE_MATRIX, EVIDENCE_RUN_SCHEMA, EVIDENCE_MATRIX_SCHEMA):
        if not path.exists():
            fail(f"missing required extension evidence file: {rel(path)}")
    matrix = read_toml(EVIDENCE_MATRIX)
    if matrix.get("format-version") != 1:
        fail(f"{rel(EVIDENCE_MATRIX)} must use format-version = 1")
    digest_inputs = normalized_rel_list(
        matrix.get("source-digest-inputs"),
        f"{rel(EVIDENCE_MATRIX)} source-digest-inputs",
    )
    if digest_inputs != source_digest_inputs():
        fail(f"{rel(EVIDENCE_MATRIX)} source-digest-inputs must match the checker contract")
    public_ids = {validate_id(row.get("id"), "public catalog extension") for row in public_extensions(catalog)}
    claims = matrix.get("claims")
    if not isinstance(claims, list) or not claims:
        fail(f"{rel(EVIDENCE_MATRIX)} must declare [[claims]]")
    claim_ids: set[str] = set()
    for claim in claims:
        extension_id = validate_id(claim.get("extension"), f"{rel(EVIDENCE_MATRIX)} claim extension")
        if claim.get("public") is not True:
            continue
        if extension_id in claim_ids:
            fail(f"{rel(EVIDENCE_MATRIX)} has duplicate public claim for {extension_id}")
        claim_ids.add(extension_id)
        if claim.get("postgres-major") != 18:
            fail(f"{rel(EVIDENCE_MATRIX)} claim {extension_id} must target postgres-major = 18")
        for field in ("artifact-family", "platform-targets", "runtime-modes", "evidence-required"):
            if field not in claim:
                fail(f"{rel(EVIDENCE_MATRIX)} claim {extension_id} is missing {field}")
    missing_claims = sorted(public_ids - claim_ids)
    extra_claims = sorted(claim_ids - public_ids)
    if missing_claims:
        fail(f"{rel(EVIDENCE_MATRIX)} is missing public claims for {missing_claims}")
    if extra_claims:
        fail(f"{rel(EVIDENCE_MATRIX)} claims public support for non-public extensions {extra_claims}")

    current_digest = source_digest(digest_inputs)
    evidence: dict[tuple[str, str, str, str], dict[str, str]] = {}
    latest: dict[tuple[str, str, str, str], dict] = {}
    run_files = sorted(EVIDENCE_RUNS.glob("*.json"))
    if not run_files:
        fail(f"{rel(EVIDENCE_RUNS)} must contain evidence run JSON files")
    for run_file in run_files:
        run = read_json(run_file)
        if run.get("schema") != "oliphaunt-extension-evidence-v1":
            fail(f"{rel(run_file)} has unsupported evidence schema")
        if run.get("sourceDigest") != current_digest:
            fail(
                f"{rel(run_file)} sourceDigest is stale; expected {current_digest}, "
                f"got {run.get('sourceDigest')!r}"
            )
        run_digest_inputs = normalized_rel_list(
            run.get("sourceDigestInputs"),
            f"{rel(run_file)} sourceDigestInputs",
        )
        if run_digest_inputs != digest_inputs:
            fail(f"{rel(run_file)} sourceDigestInputs must match {rel(EVIDENCE_MATRIX)}")
        if run.get("status") != "passed":
            continue
        tier = run.get("evidenceTier")
        if not isinstance(tier, str) or not tier:
            fail(f"{rel(run_file)} must define evidenceTier")
        results = run.get("results")
        if not isinstance(results, list) or not results:
            fail(f"{rel(run_file)} must define evidence results")
        for result in results:
            extension_id = validate_id(result.get("extension"), f"{rel(run_file)} result extension")
            if result.get("postgresMajor") != 18:
                continue
            family = result.get("artifactFamily")
            target = result.get("platformTarget")
            statuses = result.get("runtimeModeStatuses")
            if not isinstance(family, str) or not isinstance(target, str) or not isinstance(statuses, dict):
                fail(f"{rel(run_file)} result {extension_id} must define family, target, and runtimeModeStatuses")
            evidence[(extension_id, tier, family, target)] = statuses
            latest[(extension_id, tier, family, target)] = {
                "run-id": run.get("id", run_file.stem),
                "run-path": rel(run_file),
                "evidence-tier": tier,
                "artifact-family": family,
                "platform-target": target,
                "source-digest": current_digest,
                "observed-at": run.get("observedAt", ""),
                "runtime-mode-statuses": statuses,
            }

    claim_rows = []
    for claim in claims:
        if claim.get("public") is not True:
            continue
        extension_id = claim["extension"]
        tiers = claim["evidence-required"]
        targets = claim["platform-targets"]
        modes = claim["runtime-modes"]
        family = claim["artifact-family"]
        if not isinstance(tiers, list) or not isinstance(targets, list) or not isinstance(modes, list):
            fail(f"{rel(EVIDENCE_MATRIX)} claim {extension_id} has invalid evidence target arrays")
        accepted = []
        for tier in tiers:
            for target in targets:
                statuses = evidence.get((extension_id, tier, family, target))
                if statuses is None:
                    fail(f"public extension claim {extension_id} lacks evidence tier {tier} for {family}/{target}")
                for mode in modes:
                    if statuses.get(mode) != "passed":
                        fail(
                            f"public extension claim {extension_id} lacks passing {mode} evidence "
                            f"for tier {tier} on {family}/{target}"
                        )
                accepted.append(latest[(extension_id, tier, family, target)])
        catalog_row = next((row for row in catalog.get("extensions", []) if row.get("id") == extension_id), {})
        claim_rows.append(
            {
                "extension": extension_id,
                "sql-name": catalog_row.get("sql-name", extension_id),
                "public": True,
                "postgres-major": claim.get("postgres-major"),
                "artifact-family": family,
                "platform-targets": targets,
                "runtime-modes": modes,
                "evidence-required": tiers,
                "latest-accepted-evidence": accepted,
            }
        )

    claim_rows.sort(key=lambda row: (str(row["sql-name"]), str(row["extension"])))
    return {
        "format-version": 1,
        "generated-from": [
            {"name": "extension-catalog", "path": rel(CATALOG)},
            {"name": "evidence-matrix", "path": rel(EVIDENCE_MATRIX)},
            {"name": "evidence-runs", "path": rel(EVIDENCE_RUNS)},
        ],
        "source-digest": current_digest,
        "source-digest-inputs": digest_inputs,
        "claims": claim_rows,
    }


def validate_evidence_table(catalog: dict, write: bool) -> None:
    expected = json_text(validate_evidence(catalog))
    if write:
        EVIDENCE_TABLE.parent.mkdir(parents=True, exist_ok=True)
        EVIDENCE_TABLE.write_text(expected, encoding="utf-8")
        return
    if not EVIDENCE_TABLE.exists():
        fail(f"{rel(EVIDENCE_TABLE)} is missing; run src/extensions/tools/check-extension-model.py --write")
    actual = EVIDENCE_TABLE.read_text(encoding="utf-8")
    if actual != expected:
        fail(f"{rel(EVIDENCE_TABLE)} is stale; run src/extensions/tools/check-extension-model.py --write")
    table = read_json(EVIDENCE_TABLE)
    if table.get("format-version") != 1:
        fail(f"{rel(EVIDENCE_TABLE)} must use format-version 1")
    if not table.get("claims"):
        fail(f"{rel(EVIDENCE_TABLE)} must define public evidence claims")


def run_xtask_check() -> None:
    result = subprocess.run(
        ["cargo", "run", "-p", "xtask", "--", "extensions", "check"],
        cwd=ROOT,
        check=False,
    )
    if result.returncode != 0:
        raise SystemExit(result.returncode)


def self_test() -> None:
    digest_inputs = set(source_digest_inputs())
    for path in [
        "src/extensions/external/vector/VERSION",
        "src/extensions/external/vector/CHANGELOG.md",
        "src/extensions/external/vector/release.toml",
    ]:
        if path in digest_inputs:
            fail(f"self-test expected release metadata to be excluded from source digest inputs: {path}")
    for path in [
        "src/extensions/external/postgis/recipe.toml",
        "src/extensions/external/postgis/deps.toml",
    ]:
        if path not in digest_inputs:
            fail(f"self-test expected source recipe input to stay in source digest inputs: {path}")

    with TemporaryDirectory() as tmp:
        bad = Path(tmp) / "bad.toml"
        bad.write_text(
            'format-version = 1\n\n[[extensions]]\nid = "vector"\n\n[[extensions]]\nid = "vector"\n',
            encoding="utf-8",
        )
        try:
            original = globals()["PROMOTED"]
            globals()["PROMOTED"] = bad
            validate_catalog_rows()
        except SystemExit:
            pass
        else:
            fail("self-test expected duplicate extension id to fail")
        finally:
            globals()["PROMOTED"] = original

    originals = {
        "EVIDENCE_MATRIX": globals()["EVIDENCE_MATRIX"],
        "EVIDENCE_RUN_SCHEMA": globals()["EVIDENCE_RUN_SCHEMA"],
        "EVIDENCE_MATRIX_SCHEMA": globals()["EVIDENCE_MATRIX_SCHEMA"],
        "EVIDENCE_RUNS": globals()["EVIDENCE_RUNS"],
    }
    catalog = {"extensions": [{"id": "vector", "sql-name": "vector", "promotion": {"promoted": True}}]}
    try:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            globals()["EVIDENCE_MATRIX"] = root / "missing.toml"
            globals()["EVIDENCE_RUN_SCHEMA"] = root / "run.schema.json"
            globals()["EVIDENCE_MATRIX_SCHEMA"] = root / "matrix.schema.json"
            globals()["EVIDENCE_RUNS"] = root / "runs"
            globals()["EVIDENCE_RUN_SCHEMA"].write_text("{}\n", encoding="utf-8")
            globals()["EVIDENCE_MATRIX_SCHEMA"].write_text("{}\n", encoding="utf-8")
            globals()["EVIDENCE_RUNS"].mkdir()
            try:
                validate_evidence(catalog)
            except SystemExit:
                pass
            else:
                fail("self-test expected missing evidence matrix to fail")

        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            globals()["EVIDENCE_MATRIX"] = root / "matrix.toml"
            globals()["EVIDENCE_RUN_SCHEMA"] = root / "run.schema.json"
            globals()["EVIDENCE_MATRIX_SCHEMA"] = root / "matrix.schema.json"
            globals()["EVIDENCE_RUNS"] = root / "runs"
            globals()["EVIDENCE_RUNS"].mkdir()
            globals()["EVIDENCE_RUN_SCHEMA"].write_text("{}\n", encoding="utf-8")
            globals()["EVIDENCE_MATRIX_SCHEMA"].write_text("{}\n", encoding="utf-8")
            globals()["EVIDENCE_MATRIX"].write_text(
                "\n".join(
                    [
                        "format-version = 1",
                        "source-digest-inputs = [",
                        *[f'  "{path}",' for path in source_digest_inputs()],
                        "]",
                        "",
                        "[[claims]]",
                        'extension = "vector"',
                        "postgres-major = 18",
                        'artifact-family = "wasix-runtime"',
                        'platform-targets = ["portable"]',
                        'runtime-modes = ["direct"]',
                        'evidence-required = ["self-test"]',
                        "public = true",
                        "",
                    ]
                ),
                encoding="utf-8",
            )
            (globals()["EVIDENCE_RUNS"] / "stale.json").write_text(
                json_text(
                    {
                        "schema": "oliphaunt-extension-evidence-v1",
                        "id": "stale",
                        "evidenceTier": "self-test",
                        "status": "passed",
                        "sourceDigest": "sha256:stale",
                        "sourceDigestInputs": source_digest_inputs(),
                        "results": [
                            {
                                "extension": "vector",
                                "postgresMajor": 18,
                                "artifactFamily": "wasix-runtime",
                                "platformTarget": "portable",
                                "runtimeModeStatuses": {"direct": "passed"},
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )
            try:
                validate_evidence(catalog)
            except SystemExit:
                pass
            else:
                fail("self-test expected stale evidence digest to fail")
    finally:
        for name, value in originals.items():
            globals()[name] = value


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write", action="store_true", help="regenerate derived support-table JSON")
    parser.add_argument("--write-evidence", action="store_true", help="regenerate transitional evidence matrix/run files")
    parser.add_argument("--check", action="store_true", help="validate generated files without writing")
    parser.add_argument("--self-test", action="store_true", help="run negative validation tests")
    args = parser.parse_args()

    if args.self_test:
        self_test()

    for path in (RECIPE_SCHEMA, SUPPORT_SCHEMA, PROMOTED, SMOKE, CATALOG, BUILD_PLAN, CONTRIB_RECIPE):
        if not path.exists():
            fail(f"missing required extension model file: {rel(path)}")

    validate_catalog_rows()
    catalog = read_json(CATALOG)
    build_plan = read_json(BUILD_PLAN)
    if args.write_evidence:
        write_evidence_files(catalog)
    validate_extension_release_metadata()
    validate_contrib_recipe(build_plan)
    validate_external_recipes()
    validate_support_table(catalog, write=args.write)
    validate_evidence_table(catalog, write=args.write or args.write_evidence)
    validate_generated_sdk_metadata(catalog, build_plan, write=args.write)
    if not args.write:
        run_xtask_check()
    print("extension model checks passed")


if __name__ == "__main__":
    main()
