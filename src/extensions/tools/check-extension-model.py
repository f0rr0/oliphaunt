#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import tomllib
from functools import lru_cache
from pathlib import Path
from tempfile import TemporaryDirectory

ROOT = Path(__file__).resolve().parents[3]

SOURCE_CATALOG = ROOT / "src/extensions/catalog/extensions.source.json"
CATALOG = ROOT / "src/extensions/generated/extensions.catalog.json"
NATIVE_COMPONENT_CONTRACT = ROOT / "src/extensions/catalog/native-components.toml"
NATIVE_COMPONENT_TOOL = ROOT / "src/extensions/tools/native-component-contract.mjs"
CONTRIB_RECIPE = ROOT / "src/extensions/contrib/postgres18.toml"
RECIPE_SCHEMA = ROOT / "src/extensions/schemas/recipe.schema.json"
EVIDENCE_MATRIX = ROOT / "src/extensions/evidence/matrix.toml"
EVIDENCE_RUN_SCHEMA = ROOT / "src/extensions/evidence/schemas/run.schema.json"
EVIDENCE_MATRIX_SCHEMA = ROOT / "src/extensions/evidence/schemas/matrix.schema.json"
EVIDENCE_RUNS = ROOT / "src/extensions/evidence/runs"
EVIDENCE_TABLE = ROOT / "src/extensions/generated/docs/extension-evidence.json"
THIRD_PARTY_ROOT = ROOT / "src/sources/third-party"
PRODUCTION_THIRD_PARTY_DOMAINS = ("shared", "native", "wasix")
EXTENSIONS_ROOT = ROOT / "src/extensions"
EXTERNAL_ROOT = EXTENSIONS_ROOT / "external"
SMOKE_RECIPE_ROOT = ROOT / "src/shared/fixtures/extensions"
SMOKE_RECIPE_MANIFEST = SMOKE_RECIPE_ROOT / "manifest.json"
EXTENSION_ENVELOPE_FILENAMES = {
    "CHANGELOG.md",
    "VERSION",
    "moon.yml",
    "release.toml",
}
OBSOLETE_EXTENSION_FILENAMES = {
    "artifacts.toml",
    "blockers.toml",
    "publication-blocker.toml",
}
GENERATED_SDK_METADATA = ROOT / "src/extensions/generated/sdk/extensions.json"
GENERATED_IOS_STATIC_DEPENDENCIES = (
    ROOT / "src/extensions/generated/sdk/ios-static-dependencies.json"
)
OBSOLETE_GENERATED_FILES = (
    ROOT / "src/extensions/generated/extensions.build-plan.json",
    ROOT / "src/extensions/generated/sdk/js.json",
    ROOT / "src/extensions/generated/sdk/kotlin.json",
    ROOT / "src/extensions/generated/sdk/react-native.json",
    ROOT / "src/extensions/generated/sdk/rust.json",
    ROOT / "src/extensions/generated/sdk/swift.json",
    ROOT / "src/sdks/kotlin/oliphaunt/src/generated/extensions.json",
    ROOT / "src/sdks/react-native/src/generated/extensions.json",
)
GENERATED_RUST_SDK_MODULE = ROOT / "src/sdks/rust/src/generated/extensions.rs"
GENERATED_TS_SDK_MODULE = ROOT / "src/sdks/js/src/generated/extensions.ts"
GENERATED_KOTLIN_SDK_MODULE = ROOT / "src/sdks/kotlin/oliphaunt/src/commonMain/kotlin/dev/oliphaunt/GeneratedExtensions.kt"
GENERATED_KOTLIN_GRADLE_PLUGIN_CATALOG = (
    ROOT
    / "src/sdks/kotlin/oliphaunt-android-gradle-plugin/src/main/resources/dev/oliphaunt/android/extensions.properties"
)
GENERATED_RN_SDK_MODULE = ROOT / "src/sdks/react-native/src/generated/extensions.ts"
GENERATED_MOBILE_SMOKE_MODULE = (
    ROOT / "examples/react-native-expo/src/generated/extension-smoke.ts"
)
GENERATED_MOBILE_REGISTRY = ROOT / "src/extensions/generated/mobile/static-registry.json"
GENERATED_MOBILE_STATIC_SPECS = ROOT / "src/extensions/generated/mobile/static-extensions.tsv"
GENERATED_WASIX_METADATA = ROOT / "src/extensions/generated/wasix/extensions.json"
BIOME_VERSION = "2.4.16"
CHECK_EXTENSION_MODEL_PATH = "src/extensions/tools/check-extension-model.mjs"
CHECK_EXTENSION_MODEL_COMMAND = f"tools/dev/bun.sh {CHECK_EXTENSION_MODEL_PATH}"
CHECK_EXTENSION_MODEL_WRITE_COMMAND = f"{CHECK_EXTENSION_MODEL_COMMAND} --write"
CHECK_EXTENSION_MODEL_WRITE_EVIDENCE_COMMAND = f"{CHECK_EXTENSION_MODEL_COMMAND} --write-evidence"
CHECK_EXTENSION_MODEL_WRITE_EVIDENCE_SUMMARY_COMMAND = (
    f"{CHECK_EXTENSION_MODEL_COMMAND} --write-evidence-summary"
)
WASIX_EVIDENCE_TIER = "wasix-full-lifecycle-v1"

BASE_SOURCE_DIGEST_INPUTS = [
    "src/postgres/versions/18/source.toml",
    "src/extensions/catalog/extensions.source.json",
    "src/extensions/catalog/native-components.toml",
    "src/extensions/contrib/postgres18.toml",
    "src/extensions/generated/extensions.catalog.json",
    "src/extensions/generated/contrib-build.tsv",
    "src/extensions/generated/pgxs-build.tsv",
]

ID_RE = re.compile(r"^[a-z][a-z0-9_]*$")
SQL_NAME_RE = re.compile(r"^[a-z][a-z0-9_-]*$")
EVIDENCE_STATUSES = {"passed", "failed", "blocked", "not-run"}


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


@lru_cache(maxsize=1)
def pinned_bun_version() -> str:
    for raw_line in (ROOT / ".prototools").read_text(encoding="utf-8").splitlines():
        key, separator, value = raw_line.partition("=")
        if separator and key.strip() == "bun":
            return value.strip().strip('"')
    fail(".prototools must pin a bun version")


def pinned_bun_executable() -> str | None:
    for name in ["bun.exe", "bun"]:
        candidate = shutil.which(name)
        if candidate is None:
            continue
        try:
            version = subprocess.check_output(
                [candidate, "--version"],
                cwd=ROOT,
                stderr=subprocess.DEVNULL,
                text=True,
            ).strip()
        except (FileNotFoundError, subprocess.CalledProcessError):
            continue
        if version == pinned_bun_version():
            return candidate
    return None


def git_bash_executable() -> str:
    candidates: list[Path] = []
    for root in [os.environ.get("ProgramFiles"), os.environ.get("ProgramFiles(x86)")]:
        if root:
            candidates.extend([Path(root) / "Git/bin/bash.exe", Path(root) / "Git/usr/bin/bash.exe"])
    for name in ["git.exe", "git"]:
        git = shutil.which(name)
        if git is None:
            continue
        for parent in Path(git).parents:
            if parent.name.lower() == "git":
                candidates.extend([parent / "bin/bash.exe", parent / "usr/bin/bash.exe"])
                break
    for name in ["bash.exe", "bash"]:
        bash = shutil.which(name)
        if bash is None:
            continue
        candidate = Path(bash)
        if "system32" not in {part.lower() for part in candidate.parts}:
            candidates.append(candidate)
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)
    fail("failed to find Git for Windows bash.exe; install Git Bash or put it on PATH")


def bun_command(*args: str) -> list[str]:
    if os.name == "nt":
        bun = pinned_bun_executable()
        if bun is not None:
            return [bun, *args]
        return [git_bash_executable(), "tools/dev/bun.sh", *args]
    return ["tools/dev/bun.sh", *args]


@lru_cache(maxsize=None)
def release_graph_rows(command: str) -> tuple[dict, ...]:
    try:
        output = subprocess.check_output(
            bun_command("tools/release/release_graph_query.mjs", command),
            cwd=ROOT,
            text=True,
            stderr=subprocess.PIPE,
        )
    except (FileNotFoundError, subprocess.CalledProcessError) as error:
        stderr = getattr(error, "stderr", "") or ""
        stdout = getattr(error, "output", "") or ""
        detail = "\n".join(part for part in [stderr.strip(), stdout.strip()] if part) or str(error)
        fail(f"failed to query release graph {command}: {detail.strip()}")
    try:
        rows = json.loads(output)
    except json.JSONDecodeError as error:
        fail(f"release graph {command} query did not return valid JSON: {error}")
    if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
        fail(f"release graph {command} query must return a JSON object list")
    return tuple(rows)


def validate_extension_metadata_row(row: dict) -> None:
    product = row.get("product")
    if not isinstance(product, str) or not product.startswith("oliphaunt-extension-"):
        fail(f"release graph extension-metadata row must declare an exact-extension product: {product!r}")
    artifact_product = row.get("artifactProduct", product)
    if artifact_product != product:
        fail(
            "release graph extension-metadata row must keep product and artifactProduct equal: "
            f"{product!r} != {artifact_product!r}"
        )
    for key in [
        "sqlName",
        "memberPath",
        "class",
        "versioning",
        "sourcePath",
        "cargoPackage",
        "npmPackage",
        "mavenGroup",
        "mavenArtifact",
    ]:
        value = row.get(key)
        if not isinstance(value, str) or not value:
            fail(f"release graph extension-metadata {product}.{key} must be a non-empty string")
    compatibility = row.get("compatibility")
    if not isinstance(compatibility, dict):
        fail(f"release graph extension-metadata {product}.compatibility must be an object")
    for key in [
        "postgresMajor",
        "extensionRuntimeContract",
        "nativeRuntimeProduct",
        "nativeRuntimeVersion",
        "wasixRuntimeProduct",
        "wasixRuntimeVersion",
    ]:
        value = compatibility.get(key)
        if not isinstance(value, str) or not value:
            fail(f"release graph extension-metadata {product}.compatibility.{key} must be a non-empty string")
    source_identity = row.get("sourceIdentity")
    if not isinstance(source_identity, dict) or not source_identity:
        fail(f"release graph extension-metadata {product}.sourceIdentity must be an object")


@lru_cache(maxsize=1)
def extension_metadata_rows() -> tuple[dict, ...]:
    rows = release_graph_rows("extension-metadata")
    seen: set[str] = set()
    for row in rows:
        validate_extension_metadata_row(row)
        sql_name = str(row["sqlName"])
        if sql_name in seen:
            fail(f"release graph extension-metadata query returned duplicate SQL member {sql_name}")
        seen.add(sql_name)
    if not rows:
        fail("release graph extension-metadata query returned no products")
    return rows


@lru_cache(maxsize=1)
def extension_metadata_by_sql_name() -> dict[str, dict]:
    rows = {}
    for source in extension_metadata_rows():
        row = dict(source)
        row["artifactProduct"] = row.get("artifactProduct", row["product"])
        compatibility = row["compatibility"]
        row["releaseProduct"] = (
            compatibility["nativeRuntimeProduct"]
            if row["versioning"] == "runtime-bound"
            else row["artifactProduct"]
        )
        rows[str(row["sqlName"])] = row
    return rows


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
        for domain in PRODUCTION_THIRD_PARTY_DOMAINS
        for path in (THIRD_PARTY_ROOT / domain).glob("**/*.toml")
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


@lru_cache(maxsize=1)
def native_component_inventory() -> dict:
    result = subprocess.run(
        bun_command(rel(NATIVE_COMPONENT_TOOL), "inventory"),
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or f"exit {result.returncode}"
        fail(f"failed to load {rel(NATIVE_COMPONENT_CONTRACT)}: {detail}")
    try:
        inventory = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        fail(f"native component resolver returned invalid JSON: {error}")
    if inventory.get("schema") != "oliphaunt-native-components-v1":
        fail(f"{rel(NATIVE_COMPONENT_CONTRACT)} has an unsupported schema")
    if not isinstance(inventory.get("components"), list) or not isinstance(
        inventory.get("resolutions"), list
    ):
        fail(f"{rel(NATIVE_COMPONENT_CONTRACT)} inventory is malformed")
    return inventory


def native_component_resolutions(sql_name: str) -> list[dict]:
    return [
        row
        for row in native_component_inventory()["resolutions"]
        if row.get("extension") == sql_name
    ]


def native_component_resolution(
    sql_name: str,
    family: str,
    kind: str,
    target: str,
) -> dict:
    matches = [
        row
        for row in native_component_resolutions(sql_name)
        if row.get("family") == family
        and row.get("kind") == kind
        and row.get("target") == target
    ]
    if len(matches) > 1:
        fail(f"native component contract is ambiguous for {sql_name}/{family}/{kind}/{target}")
    return matches[0] if matches else {
        "components": [],
        "sources": [],
        "sourcePaths": [],
        "linkUnits": [],
        "runtimeFiles": [],
    }


def native_component_union(sql_name: str, field: str) -> list[str]:
    return sorted(
        {
            value
            for row in native_component_resolutions(sql_name)
            for value in row.get(field, [])
            if isinstance(value, str) and value
        }
    )


def validate_native_component_inventory(catalog: dict) -> None:
    inventory = native_component_inventory()
    source_names = load_source_names()
    public_sql_names = {
        row.get("sql-name", row.get("id"))
        for row in catalog.get("extensions", [])
        if isinstance(row, dict)
    }
    contract_sources = {
        row.get("source")
        for row in inventory["components"]
        if isinstance(row, dict) and row.get("source") is not None
    }
    unknown_sources = sorted(contract_sources - source_names)
    if unknown_sources:
        fail(
            f"{rel(NATIVE_COMPONENT_CONTRACT)} references missing source metadata: "
            f"{unknown_sources}"
        )
    requirement_extensions = {
        row.get("extension")
        for row in inventory["resolutions"]
        if isinstance(row, dict)
    }
    unknown_extensions = sorted(requirement_extensions - public_sql_names)
    if unknown_extensions:
        fail(
            f"{rel(NATIVE_COMPONENT_CONTRACT)} references unknown catalog extensions: "
            f"{unknown_extensions}"
        )


def source_digest_inputs() -> list[str]:
    source_files = [rel(path) for path in source_pin_paths()]
    recipe_files = sorted(
        rel(path)
        for path in EXTERNAL_ROOT.glob("**/*")
        if path.is_file()
        and path.name != "source.toml"
        and path.name not in EXTENSION_ENVELOPE_FILENAMES
    )
    smoke_recipe_files = [
        rel(SMOKE_RECIPE_MANIFEST),
        *sorted(rel(path) for path in SMOKE_RECIPE_ROOT.glob("*.sql") if path.is_file()),
    ]
    return [*BASE_SOURCE_DIGEST_INPUTS, *source_files, *recipe_files, *smoke_recipe_files]


def validate_no_obsolete_extension_files(root: Path = EXTENSIONS_ROOT) -> None:
    obsolete = sorted(
        rel(path)
        for path in root.glob("**/*")
        if path.is_file() and path.name in OBSOLETE_EXTENSION_FILENAMES
    )
    if obsolete:
        fail(
            "obsolete per-extension artifact or lifecycle state must stay off main: "
            + ", ".join(obsolete)
        )


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


@lru_cache(maxsize=1)
def current_git_identity() -> tuple[str, str]:
    try:
        commit = subprocess.check_output(
            ["git", "rev-parse", "HEAD^{commit}"],
            cwd=ROOT,
            text=True,
            stderr=subprocess.PIPE,
        ).strip()
        tree = subprocess.check_output(
            ["git", "rev-parse", f"{commit}^{{tree}}"],
            cwd=ROOT,
            text=True,
            stderr=subprocess.PIPE,
        ).strip()
    except (FileNotFoundError, subprocess.CalledProcessError) as error:
        stderr = getattr(error, "stderr", "") or ""
        fail(f"failed to resolve exact evidence source commit/tree: {stderr.strip() or error}")
    if re.fullmatch(r"[0-9a-f]{40}", commit) is None or re.fullmatch(r"[0-9a-f]{40}", tree) is None:
        fail("git returned an invalid exact evidence source commit/tree")
    return commit, tree


def require_clean_evidence_inputs() -> None:
    try:
        status = subprocess.check_output(
            ["git", "status", "--porcelain=v1", "--", *source_digest_inputs()],
            cwd=ROOT,
            text=True,
            stderr=subprocess.PIPE,
        ).strip()
    except (FileNotFoundError, subprocess.CalledProcessError) as error:
        stderr = getattr(error, "stderr", "") or ""
        fail(f"failed to verify exact evidence source inputs: {stderr.strip() or error}")
    if status:
        fail(
            "full WASIX evidence source inputs differ from the recorded commit; "
            f"refusing dirty exact-SHA evidence:\n{status}"
        )


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


def validate_contrib_recipe(catalog: dict) -> None:
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
        duplicate_fields = sorted(
            field
            for field in (
                "mobile-static-dependencies",
                "mobile-static-include-dependencies",
                "mobile-static-hash-source-dependencies",
            )
            if field in row
        )
        if duplicate_fields:
            fail(
                f"{rel(CONTRIB_RECIPE)} row {extension_id} duplicates native component "
                f"requirements in {rel(NATIVE_COMPONENT_CONTRACT)}: {duplicate_fields}"
            )
        for recipe_field in (
            "mobile-static-include-dirs",
            "mobile-static-cflags",
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

    catalog_rows = [
        row
        for row in catalog.get("extensions", [])
        if row.get("source-kind") == "postgres-contrib"
    ]
    catalog_by_id = {
        validate_id(row.get("id"), f"{rel(CATALOG)} row id"): row for row in catalog_rows
    }
    if sorted(recipe_by_id) != sorted(catalog_by_id):
        fail(
            f"{rel(CONTRIB_RECIPE)} ids must match the generated contrib catalog; "
            f"recipe-only={sorted(set(recipe_by_id) - set(catalog_by_id))}, "
            f"catalog-only={sorted(set(catalog_by_id) - set(recipe_by_id))}"
        )
    for extension_id, catalog_row in catalog_by_id.items():
        recipe = recipe_by_id[extension_id]
        expected = {
            "sql-name": catalog_row.get("sql-name"),
            "module-file": catalog_row.get("native-module-file"),
        }
        for field, value in expected.items():
            if recipe.get(field) != value:
                fail(
                    f"{rel(CONTRIB_RECIPE)} row {extension_id} {field}={recipe.get(field)!r} "
                    f"does not match generated catalog {value!r}"
                )


def validate_external_recipes(catalog: dict) -> None:
    source_names = load_source_names()
    catalog_by_sql_name = {
        row.get("sql-name", row.get("id")): row
        for row in catalog.get("extensions", [])
        if isinstance(row, dict)
    }
    validate_external_source_pins(catalog_by_sql_name, source_names)
    validate_pg_textsearch_mobile_version_flag()
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
        if not isinstance(lifecycle, dict) or not isinstance(artifacts, dict):
            fail(f"{rel(recipe)} must declare lifecycle and artifacts tables")
        if "support" in data:
            fail(f"{rel(recipe)} must not carry an intermediate support-status table")
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
        if kind == "external-complex":
            for path in (
                recipe.parent / "targets/native.toml",
                recipe.parent / "targets/wasix.toml",
                recipe.parent / "targets/native-static-registry.toml",
                recipe.parent / "patches/README.md",
            ):
                if not path.exists():
                    fail(f"{rel(recipe)} complex recipe is missing {rel(path)}")

        for target_path in sorted((recipe.parent / "targets").glob("*.toml")):
            target = read_toml(target_path)
            duplicate_fields = sorted(
                field
                for field in (
                    "dependencies",
                    "ios_dependencies",
                    "android_dependencies",
                    "include_dependencies",
                    "status",
                )
                if field in target
            )
            if duplicate_fields:
                fail(
                    f"{rel(target_path)} duplicates native component requirements in "
                    f"{rel(NATIVE_COMPONENT_CONTRACT)}: {duplicate_fields}"
                )

        generated = catalog_by_sql_name.get(sql_name)
        if generated is None:
            fail(f"{rel(recipe)} has no matching generated catalog row")
        if generated.get("source-kind") != "postgis" and kind == "external-complex":
            fail(f"{rel(recipe)} complex recipe must match generated source-kind postgis")
        generated_modules = set(generated.get("load-order") or [])
        for module in artifacts.get("native_modules", []):
            if module not in generated_modules:
                fail(f"{rel(recipe)} native module {module!r} must match generated load-order")


def split_smoke_statements(sql: str) -> list[str]:
    return [
        statement.strip()
        for statement in sql.split("-- oliphaunt-statement")
        if statement.strip()
    ]


def validate_extension_smoke_recipes(catalog: dict) -> None:
    expected = sorted(
        validate_sql_name(
            row.get("sql-name", row.get("id")),
            f"{rel(CATALOG)} extension smoke SQL name",
        )
        for row in catalog.get("extensions", [])
        if isinstance(row, dict)
    )
    manifest = read_json(SMOKE_RECIPE_MANIFEST)
    if set(manifest) != {"format-version", "recipes"} or manifest.get("format-version") != 1:
        fail(f"{rel(SMOKE_RECIPE_MANIFEST)} must contain only format-version 1 and recipes")
    recipes = manifest.get("recipes")
    if not isinstance(recipes, dict):
        fail(f"{rel(SMOKE_RECIPE_MANIFEST)} recipes must be an object")
    if sorted(recipes) != expected:
        fail(
            f"{rel(SMOKE_RECIPE_MANIFEST)} must exactly map the public extension catalog; "
            f"recipe-only={sorted(set(recipes) - set(expected))}, "
            f"catalog-only={sorted(set(expected) - set(recipes))}"
        )
    expected_files = [f"{sql_name}.sql" for sql_name in expected]
    mapped_files = list(recipes.values())
    if mapped_files != expected_files or len(set(mapped_files)) != len(mapped_files):
        fail(
            f"{rel(SMOKE_RECIPE_MANIFEST)} must map each SQL name to its unique <sql-name>.sql recipe"
        )
    files = sorted(path for path in SMOKE_RECIPE_ROOT.iterdir() if path.is_file())
    invalid = [
        rel(path)
        for path in files
        if path != SMOKE_RECIPE_MANIFEST and path.suffix != ".sql"
    ]
    if invalid:
        fail(f"{rel(SMOKE_RECIPE_ROOT)} contains non-SQL recipe files: {invalid}")
    sql_files = [path for path in files if path.suffix == ".sql"]
    actual = [path.name for path in sql_files]
    if actual != expected_files:
        fail(
            f"{rel(SMOKE_RECIPE_ROOT)} must exactly match the public extension catalog; "
            f"recipe-only={sorted(set(actual) - set(expected_files))}, "
            f"catalog-only={sorted(set(expected_files) - set(actual))}"
        )
    for path in sql_files:
        text = path.read_text(encoding="utf-8")
        if "-- oliphaunt-statement" not in text:
            fail(f"{rel(path)} must include explicit statement delimiters")
        if not split_smoke_statements(text):
            fail(f"{rel(path)} must contain at least one SQL statement")


def validate_pg_textsearch_mobile_version_flag() -> None:
    extension_dir = EXTERNAL_ROOT / "pg_textsearch"
    source_path = extension_dir / "source.toml"
    target_path = extension_dir / "targets/native-static-registry.toml"
    source = read_toml(source_path)
    control = source.get("extension-control")
    if not isinstance(control, dict):
        fail(f"{rel(source_path)} must declare extension-control metadata")
    version = control.get("default-version")
    if not isinstance(version, str) or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version):
        fail(f"{rel(source_path)} extension-control.default-version must be a semantic version")

    target = read_toml(target_path)
    cflags = validate_string_list(target.get("cflags"), f"{rel(target_path)} cflags")
    expected = f'-DPG_TEXTSEARCH_VERSION="{version}"'
    if cflags.count(expected) != 1:
        fail(
            f"{rel(target_path)} cflags must contain exactly {expected!r} so Android and iOS "
            "static builds match the pinned pg_textsearch control version"
        )


def validate_external_source_pins(catalog_by_sql_name: dict[str, dict], source_names: set[str]) -> None:
    for source_path in sorted(EXTERNAL_ROOT.glob("*/source.toml")):
        extension_dir = source_path.parent
        sql_name = validate_sql_name(extension_dir.name, f"{rel(source_path)} directory")
        source = read_toml(source_path)
        name = source.get("name")
        if not isinstance(name, str) or name not in source_names:
            fail(f"{rel(source_path)} must declare a valid source name")
        if sql_name not in catalog_by_sql_name:
            continue
        generated = catalog_by_sql_name[sql_name]
        generated_control_file = generated.get("control-file")
        if isinstance(generated_control_file, str) and generated_control_file:
            expected_checkout = f"target/oliphaunt-sources/checkouts/{name}/"
            if not generated_control_file.startswith(expected_checkout):
                fail(
                    f"{rel(source_path)} source name {name!r} implies checkout "
                    f"{expected_checkout}, but generated catalog uses {generated_control_file}"
                )


def validate_extension_release_metadata() -> None:
    extension_metadata_rows()


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


def mobile_static_dependencies(sql_name: str, field: str = "dependencies") -> list[str]:
    targets = {
        "dependencies": ["ios-xcframework", "android-arm64-v8a", "android-x86_64"],
        "ios_dependencies": ["ios-xcframework"],
        "android_dependencies": ["android-arm64-v8a", "android-x86_64"],
    }.get(field)
    if targets is None:
        fail(f"unknown mobile static dependency field {field!r}")
    return sorted(
        {
            dependency
            for target in targets
            for dependency in native_component_resolution(
                sql_name,
                "native",
                "native-static-registry",
                target,
            ).get("linkUnits", [])
        }
    )


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
    return sorted(
        {
            source
            for target in ("ios-xcframework", "android-arm64-v8a", "android-x86_64")
            for source in native_component_resolution(
                sql_name,
                "native",
                "native-static-registry",
                target,
            ).get("sources", [])
        }
    )


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
    targets = {
        "dependencies": ["ios-xcframework", "android-arm64-v8a", "android-x86_64"],
        "ios_dependencies": ["ios-xcframework"],
        "android_dependencies": ["android-arm64-v8a", "android-x86_64"],
    }.get(field)
    if targets is None:
        fail(f"unknown mobile static hash dependency field {field!r}")
    return sorted(
        {
            dependency
            for target in targets
            for dependency in native_component_resolution(
                sql_name,
                "native",
                "native-static-registry",
                target,
            ).get("sources", [])
        }
    )


def mobile_static_hash_dirs(sql_name: str) -> list[str]:
    external = external_mobile_target_list(sql_name, "hash_dirs")
    if external:
        return external
    return contrib_mobile_static_list(sql_name, "mobile-static-hash-dirs")


def mobile_static_source_files(sql_name: str) -> list[str]:
    return external_mobile_target_list(sql_name, "source_files")


def mobile_static_source_recursive_dirs(sql_name: str) -> list[str]:
    return external_mobile_target_list(sql_name, "source_recursive_dirs")


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


def generated_sdk_metadata(catalog: dict) -> dict:
    rows = []
    release_metadata = extension_metadata_by_sql_name()
    public_sql_names = {
        extension.get("sql-name", extension.get("id"))
        for extension in catalog.get("extensions", [])
        if isinstance(extension, dict)
    }
    for extension in catalog.get("extensions", []):
        data_files = extension_data_files_from_recipe(extension)
        dependencies = extension.get("dependencies") or []
        sql_name = str(extension.get("sql-name", extension.get("id")))
        release = release_metadata.get(sql_name)
        if release is None:
            fail(f"release graph has no exact release owner for catalog extension {sql_name}")
        native_requirements = [
            {
                "family": requirement["family"],
                "kind": requirement["kind"],
                "target": requirement["target"],
                "components": requirement["components"],
                "link-units": requirement["linkUnits"],
                "runtime-files": requirement["runtimeFiles"],
            }
            for requirement in native_component_resolutions(sql_name)
        ]
        row = {
            "id": extension.get("id"),
            "sql-name": sql_name,
            "display-name": extension.get("display-name", extension.get("id")),
            "postgres-major": 18,
            "artifact-product": release["artifactProduct"],
            "release-product": release["releaseProduct"],
            "cargo-package": release["cargoPackage"],
            "npm-package": release["npmPackage"],
            "maven-group": release["mavenGroup"],
            "maven-artifact": release["mavenArtifact"],
            "runtime-bound": release["versioning"] == "runtime-bound",
            "creates-extension": bool((extension.get("lifecycle") or {}).get("create-extension")),
            "native-module-stem": native_module_stem(extension),
            "dependencies": dependencies,
            "selected-extension-dependencies": sorted(
                dependency for dependency in dependencies if dependency in public_sql_names
            ),
            "native-components": native_component_union(sql_name, "components"),
            "native-component-requirements": native_requirements,
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
            "source-kind": extension.get("source-kind"),
        }
        rows.append(row)
    rows.sort(key=lambda row: (str(row["sql-name"]), str(row["id"])))
    catalog_sha256 = hashlib.sha256(
        json.dumps(rows, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    return {
        "format-version": 1,
        "extension-catalog-sha256": catalog_sha256,
        "generated-from": [
            {"name": "extension-catalog", "path": rel(CATALOG)},
            {"name": "native-components", "path": rel(NATIVE_COMPONENT_CONTRACT)},
            {"name": "extension-recipes", "path": "src/extensions"},
            {"name": "release-products", "path": "src"},
        ],
        "extensions": rows,
    }


def generated_ios_static_dependencies(catalog: dict) -> dict:
    rows = []
    for extension in catalog.get("extensions", []):
        sql_name = str(extension.get("sql-name", extension.get("id")))
        dependencies = mobile_static_dependencies(sql_name, "ios_dependencies")
        if dependencies:
            rows.append(
                {
                    "sql-name": sql_name,
                    "static-dependencies": dependencies,
                }
            )
    rows.sort(key=lambda row: str(row["sql-name"]))
    return {
        "format-version": 1,
        "generated-from": [
            {"name": "extension-catalog", "path": rel(CATALOG)},
            {"name": "native-components", "path": rel(NATIVE_COMPONENT_CONTRACT)},
            {"name": "contrib-recipe", "path": rel(CONTRIB_RECIPE)},
            {"name": "external-static-targets", "path": "src/extensions/external"},
        ],
        "extensions": rows,
    }


def generated_typescript_extension_module(
    metadata: dict,
    ios_static_dependencies: dict | None = None,
) -> str:
    ios_dependencies_by_sql_name = {
        row["sql-name"]: row["static-dependencies"]
        for row in (ios_static_dependencies or {}).get("extensions", [])
    }
    include_ios_static_dependencies = ios_static_dependencies is not None

    def camel(row: dict) -> dict:
        result = {
            "id": row["id"],
            "sqlName": row["sql-name"],
            "displayName": row["display-name"],
            "postgresMajor": row["postgres-major"],
            "artifactProduct": row["artifact-product"],
            "releaseProduct": row["release-product"],
            "cargoPackage": row["cargo-package"],
            "npmPackage": row["npm-package"],
            "mavenGroup": row["maven-group"],
            "mavenArtifact": row["maven-artifact"],
            "runtimeBound": row["runtime-bound"],
            "createsExtension": row["creates-extension"],
            "nativeModuleStem": row["native-module-stem"],
            "dependencies": row["dependencies"],
            "selectedExtensionDependencies": row["selected-extension-dependencies"],
            "sharedPreloadLibraries": row["shared-preload-libraries"],
            "dataFiles": row["data-files"],
            "runtimeShareDataFiles": row["runtime-share-data-files"],
            "extensionSqlFilePrefixes": row["extension-sql-file-prefixes"],
            "extensionSqlFileNames": row["extension-sql-file-names"],
            "sourceKind": row["source-kind"],
        }
        if include_ios_static_dependencies:
            result["iosStaticDependencies"] = ios_dependencies_by_sql_name.get(
                row["sql-name"], []
            )
        return result

    rows = [camel(row) for row in metadata.get("extensions", [])]
    ios_static_dependency_type = (
        "  readonly iosStaticDependencies: readonly string[];\n"
        if include_ios_static_dependencies
        else ""
    )
    source = (
        f"// This file is generated by {CHECK_EXTENSION_MODEL_PATH}.\n"
        "// Do not edit by hand.\n\n"
        "export type GeneratedExtensionMetadata = {\n"
        "  readonly id: string;\n"
        "  readonly sqlName: string;\n"
        "  readonly displayName: string;\n"
        "  readonly postgresMajor: number;\n"
        "  readonly artifactProduct: string;\n"
        "  readonly releaseProduct: string;\n"
        "  readonly cargoPackage: string;\n"
        "  readonly npmPackage: string;\n"
        "  readonly mavenGroup: string;\n"
        "  readonly mavenArtifact: string;\n"
        "  readonly runtimeBound: boolean;\n"
        "  readonly createsExtension: boolean;\n"
        "  readonly nativeModuleStem: string | null;\n"
        "  readonly dependencies: readonly string[];\n"
        "  readonly selectedExtensionDependencies: readonly string[];\n"
        f"{ios_static_dependency_type}"
        "  readonly sharedPreloadLibraries: readonly string[];\n"
        "  readonly dataFiles: readonly string[];\n"
        "  readonly runtimeShareDataFiles: readonly string[];\n"
        "  readonly extensionSqlFilePrefixes: readonly string[];\n"
        "  readonly extensionSqlFileNames: readonly string[];\n"
        "  readonly sourceKind: string;\n"
        "};\n\n"
        f"export const GENERATED_EXTENSION_METADATA_SHA256 = {json.dumps(metadata['extension-catalog-sha256'])} as const;\n\n"
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


def generated_mobile_extension_smoke_module(metadata: dict) -> str:
    recipes = {
        row["sql-name"]: split_smoke_statements(
            (SMOKE_RECIPE_ROOT / f"{row['sql-name']}.sql").read_text(
                encoding="utf-8"
            )
        )
        for row in metadata.get("extensions", [])
    }
    source = (
        f"// This file is generated by {CHECK_EXTENSION_MODEL_PATH}.\n"
        "// Do not edit by hand. It belongs only to installed mobile qualification.\n\n"
        f"export const GENERATED_MOBILE_EXTENSION_SMOKE = {json.dumps(recipes, indent=2, sort_keys=True)} as const satisfies Readonly<Record<string, readonly string[]>>;\n"
    )
    return format_typescript_source(source, GENERATED_MOBILE_SMOKE_MODULE)


def generated_kotlin_extension_module(metadata: dict) -> str:
    rows = sorted(metadata.get("extensions", []), key=lambda row: str(row["sql-name"]))
    body = "\n".join(
        "    "
        + json.dumps(str(row["sql-name"]))
        + " to GeneratedExtensionRuntimeContract("
        + f"createsExtension = {'true' if row['creates-extension'] else 'false'}, "
        + "nativeModuleStem = "
        + (json.dumps(str(row["native-module-stem"])) if row["native-module-stem"] is not None else "null")
        + "),"
        for row in rows
    )
    return (
        f"// This file is generated by {CHECK_EXTENSION_MODEL_PATH}.\n"
        "// Do not edit by hand.\n\n"
        "package dev.oliphaunt\n\n"
        "internal data class GeneratedExtensionRuntimeContract(\n"
        "    val createsExtension: Boolean,\n"
        "    val nativeModuleStem: String?,\n"
        ")\n\n"
        "internal val generatedExtensionRuntimeContracts: Map<String, GeneratedExtensionRuntimeContract> = mapOf(\n"
        f"{body}\n"
        ")\n\n"
        "internal val generatedExtensionSqlNames: Set<String> = generatedExtensionRuntimeContracts.keys\n\n"
        "internal fun generatedExtensionSqlNameExists(sqlName: String): Boolean = generatedExtensionSqlNames.contains(sqlName)\n"
        "\n"
        "internal fun generatedExtensionRuntimeContract(sqlName: String): GeneratedExtensionRuntimeContract? = generatedExtensionRuntimeContracts[sqlName]\n"
    )


def generated_kotlin_gradle_plugin_catalog(metadata: dict) -> str:
    lines = [
        f"# This file is generated by {CHECK_EXTENSION_MODEL_PATH}.",
        "# Do not edit by hand.",
        "schema=oliphaunt-android-extension-catalog-v2",
        f"catalogSha256={metadata['extension-catalog-sha256']}",
    ]
    for row in sorted(metadata.get("extensions", []), key=lambda item: str(item["sql-name"])):
        sql_name = str(row["sql-name"])
        prefix = f"extension.{sql_name}"
        lines.extend(
            [
                f"{prefix}.artifactProduct={row['artifact-product']}",
                f"{prefix}.releaseProduct={row['release-product']}",
                f"{prefix}.mavenGroup={row['maven-group']}",
                f"{prefix}.mavenArtifact={row['maven-artifact']}",
                f"{prefix}.runtimeBound={'true' if row['runtime-bound'] else 'false'}",
                f"{prefix}.dependencies={','.join(row['selected-extension-dependencies'])}",
            ]
        )
    return "\n".join(lines) + "\n"


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
    release_metadata = extension_metadata_by_sql_name()
    public_sql_names = {
        extension.get("sql-name", extension.get("id"))
        for extension in catalog.get("extensions", [])
        if isinstance(extension, dict)
    }
    for extension in catalog.get("extensions", []):
        sql_name = str(extension.get("sql-name", extension.get("id")))
        release = release_metadata.get(sql_name)
        if release is None:
            fail(f"release graph has no exact release owner for catalogued Rust extension {sql_name}")
        rows.append(
            {
                "id": extension.get("id"),
                "sql-name": sql_name,
                "artifact-product": release["artifactProduct"],
                "release-product": release["releaseProduct"],
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

    for row in rows:
        if len(row["shared-preload-libraries"]) > 1:
            fail(
                f"Rust Extension::required_shared_preload_library supports one library; "
                f"{row['sql-name']} declared {row['shared-preload-libraries']}"
            )

    text = [
        f"// @generated by {CHECK_EXTENSION_MODEL_PATH} --write",
        "// Do not edit by hand.",
        "",
        "use super::ExtensionRuntimeEnvironment;",
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

    return format_rust_source("\n".join(text))


def validate_generated_text_file(path: Path, expected: str, write: bool) -> None:
    if write:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(expected, encoding="utf-8")
        return
    if not path.exists():
        fail(f"{rel(path)} is missing; run {CHECK_EXTENSION_MODEL_WRITE_COMMAND}")
    if path.read_text(encoding="utf-8") != expected:
        fail(f"{rel(path)} is stale; run {CHECK_EXTENSION_MODEL_WRITE_COMMAND}")


def generated_mobile_registry(catalog: dict) -> dict:
    rows = []
    for extension in catalog.get("extensions", []):
        stem = native_module_stem(extension)
        if stem is None:
            continue
        rows.append(
            {
                "id": extension.get("id"),
                "sql-name": extension.get("sql-name", extension.get("id")),
                "native-module-stem": stem,
                "data-files": extension_data_files_from_recipe(extension),
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


def generated_mobile_static_specs(
    catalog: dict,
    *,
    modules: list[dict] | None = None,
) -> str:
    catalog_by_sql_name = {
        row.get("sql-name", row.get("id")): row
        for row in catalog.get("extensions", [])
        if isinstance(row, dict)
    }
    contrib_by_sql_name = {
        row.get("sql-name"): row
        for row in read_toml(CONTRIB_RECIPE).get("extensions", [])
        if isinstance(row, dict)
    }
    rows = []
    selected_modules = generated_mobile_registry(catalog)["modules"] if modules is None else modules
    for module in selected_modules:
        sql_name = module["sql-name"]
        extension = catalog_by_sql_name.get(sql_name)
        if extension is None:
            fail(f"mobile static module {sql_name} has no generated catalog row")
        if extension.get("source-kind") == "postgres-contrib":
            contrib_dir = contrib_by_sql_name.get(sql_name, {}).get("contrib-dir")
            if not isinstance(contrib_dir, str) or not contrib_dir:
                fail(f"mobile static contrib module {sql_name} is missing contrib-dir")
            source_kind = "contrib"
            source_rel = f"contrib/{contrib_dir}"
        else:
            control_file = extension.get("control-file")
            match = (
                re.match(r"^(target/oliphaunt-sources/checkouts/[^/]+)/", control_file)
                if isinstance(control_file, str)
                else None
            )
            if match is None:
                fail(
                    f"mobile static external module {sql_name} cannot derive its source checkout "
                    "from control-file"
                )
            source_kind = "external"
            source_rel = match.group(1)
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
        f"# @generated by {CHECK_EXTENSION_MODEL_PATH} --write",
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
        sql_name = str(extension.get("sql-name", extension.get("id")))
        component_closure = native_component_resolution(
            sql_name,
            "wasix",
            "wasix-runtime",
            "wasix-portable",
        )
        rows.append(
            {
                "id": extension.get("id"),
                "sql-name": sql_name,
                "archive": extension.get("archive") or f"extensions/{extension.get('sql-name', extension.get('id'))}.tar.zst",
                "native-module-file": extension.get("native-module-file") or extension.get("module-file"),
                "native-support-modules": target_native_support_modules(
                    sql_name,
                    "wasix",
                ),
                "native-components": component_closure["components"],
                "native-link-units": component_closure["linkUnits"],
                "native-runtime-files": component_closure["runtimeFiles"],
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
            {"name": "native-components", "path": rel(NATIVE_COMPONENT_CONTRACT)},
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
        fail(f"{rel(path)} is missing; run {CHECK_EXTENSION_MODEL_WRITE_COMMAND}")
    if path.read_text(encoding="utf-8") != text:
        fail(f"{rel(path)} is stale; run {CHECK_EXTENSION_MODEL_WRITE_COMMAND}")
    parsed = read_json(path)
    if parsed.get("format-version") != 1:
        fail(f"{rel(path)} must use format-version 1")


def validate_generated_sdk_metadata(catalog: dict, write: bool) -> None:
    metadata = generated_sdk_metadata(catalog)
    ios_static_dependencies = generated_ios_static_dependencies(catalog)
    validate_generated_file(GENERATED_SDK_METADATA, metadata, write)
    validate_generated_file(
        GENERATED_IOS_STATIC_DEPENDENCIES,
        ios_static_dependencies,
        write,
    )
    for obsolete in OBSOLETE_GENERATED_FILES:
        if write:
            obsolete.unlink(missing_ok=True)
        elif obsolete.exists():
            fail(f"obsolete generated file must be removed: {rel(obsolete)}")
    validate_generated_text_file(
        GENERATED_RUST_SDK_MODULE,
        generated_rust_extension_module(catalog),
        write,
    )
    validate_generated_text_file(
        GENERATED_TS_SDK_MODULE,
        generated_typescript_extension_module(metadata),
        write,
    )
    validate_generated_text_file(
        GENERATED_RN_SDK_MODULE,
        generated_typescript_extension_module(metadata, ios_static_dependencies),
        write,
    )
    validate_generated_text_file(
        GENERATED_MOBILE_SMOKE_MODULE,
        generated_mobile_extension_smoke_module(metadata),
        write,
    )
    validate_generated_text_file(
        GENERATED_KOTLIN_SDK_MODULE,
        generated_kotlin_extension_module(metadata),
        write,
    )
    validate_generated_text_file(
        GENERATED_KOTLIN_GRADLE_PLUGIN_CATALOG,
        generated_kotlin_gradle_plugin_catalog(metadata),
        write,
    )
    validate_generated_file(GENERATED_MOBILE_REGISTRY, generated_mobile_registry(catalog), write)
    validate_generated_text_file(
        GENERATED_MOBILE_STATIC_SPECS,
        generated_mobile_static_specs(catalog),
        write,
    )
    validate_generated_file(GENERATED_WASIX_METADATA, generated_wasix_metadata(catalog), write)


def json_text(value: dict) -> str:
    return json.dumps(value, indent=2, sort_keys=True) + "\n"


def catalog_extensions(catalog: dict) -> list[dict]:
    rows = [extension for extension in catalog.get("extensions", []) if isinstance(extension, dict)]
    rows.sort(key=lambda row: (str(row.get("sql-name", row.get("id"))), str(row.get("id"))))
    return rows


def write_evidence_files(catalog: dict) -> None:
    """Regenerate the claim matrix without mutating observed evidence runs.

    Evidence run JSON is an immutable observation.  A source change that makes
    an existing run stale must stay red until a runtime harness records a new
    run; deriving a fresh `passed` run from catalog metadata would counterfeit
    provenance.
    """
    catalog_rows = catalog_extensions(catalog)
    matrix_lines = [
        "format-version = 1",
        "source-digest-inputs = [",
        *[f'  "{path}",' for path in source_digest_inputs()],
        "]",
        "",
    ]
    for extension in catalog_rows:
        extension_id = validate_id(extension.get("id"), "catalog extension id")
        matrix_lines.extend(
            [
                "[[claims]]",
                f'extension = "{extension_id}"',
                "postgres-major = 18",
                'artifact-family = "wasix-runtime"',
                'platform-targets = ["portable"]',
                'runtime-modes = ["direct", "server", "restart", "dump-restore"]',
                f'evidence-required = ["{WASIX_EVIDENCE_TIER}"]',
                "",
            ]
        )
    EVIDENCE_MATRIX.parent.mkdir(parents=True, exist_ok=True)
    EVIDENCE_MATRIX.write_text("\n".join(matrix_lines).rstrip() + "\n", encoding="utf-8")


def validate_evidence(catalog: dict, require_current: bool = False) -> dict:
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
    catalog_ids = {
        validate_id(row.get("id"), "catalog extension")
        for row in catalog_extensions(catalog)
    }
    claims = matrix.get("claims")
    if not isinstance(claims, list) or not claims:
        fail(f"{rel(EVIDENCE_MATRIX)} must declare [[claims]]")
    claim_ids: set[str] = set()
    for claim in claims:
        extension_id = validate_id(claim.get("extension"), f"{rel(EVIDENCE_MATRIX)} claim extension")
        if extension_id in claim_ids:
            fail(f"{rel(EVIDENCE_MATRIX)} has duplicate claim for {extension_id}")
        claim_ids.add(extension_id)
        if claim.get("postgres-major") != 18:
            fail(f"{rel(EVIDENCE_MATRIX)} claim {extension_id} must target postgres-major = 18")
        for field in ("artifact-family", "platform-targets", "runtime-modes", "evidence-required"):
            if field not in claim:
                fail(f"{rel(EVIDENCE_MATRIX)} claim {extension_id} is missing {field}")
    missing_claims = sorted(catalog_ids - claim_ids)
    extra_claims = sorted(claim_ids - catalog_ids)
    if missing_claims:
        fail(f"{rel(EVIDENCE_MATRIX)} is missing claims for {missing_claims}")
    if extra_claims:
        fail(f"{rel(EVIDENCE_MATRIX)} claims support for unknown extensions {extra_claims}")

    current_digest = source_digest(digest_inputs)
    evidence: dict[tuple[str, str, str, str], dict[str, str]] = {}
    latest: dict[tuple[str, str, str, str], dict] = {}
    latest_order: dict[tuple[str, str, str, str], tuple[str, str, str]] = {}
    run_files = sorted(EVIDENCE_RUNS.glob("*.json"))
    if not run_files:
        fail(f"{rel(EVIDENCE_RUNS)} must contain evidence run JSON files")
    for run_file in run_files:
        run = read_json(run_file)
        if run.get("schema") != "oliphaunt-extension-evidence-v1":
            fail(f"{rel(run_file)} has unsupported evidence schema")
        run_digest = run.get("sourceDigest")
        if not isinstance(run_digest, str) or re.fullmatch(r"sha256:[0-9a-f]{64}", run_digest) is None:
            fail(f"{rel(run_file)} must define a valid sourceDigest")
        run_digest_inputs = normalized_rel_list(
            run.get("sourceDigestInputs"),
            f"{rel(run_file)} sourceDigestInputs",
        )
        run_id = run.get("id")
        if not isinstance(run_id, str) or not run_id:
            fail(f"{rel(run_file)} must define a non-empty id")
        observed_at = run.get("observedAt")
        if not isinstance(observed_at, str) or not observed_at:
            fail(f"{rel(run_file)} must define a non-empty observedAt")
        collector = run.get("collector")
        if not isinstance(collector, str) or not collector:
            fail(f"{rel(run_file)} must define a non-empty collector")
        run_status = run.get("status")
        if run_status not in {"passed", "failed", "blocked"}:
            fail(f"{rel(run_file)} has unsupported status {run_status!r}")
        tier = run.get("evidenceTier")
        if not isinstance(tier, str) or not tier:
            fail(f"{rel(run_file)} must define evidenceTier")
        source_commit = run.get("sourceCommit")
        source_tree = run.get("sourceTree")
        github = run.get("github")
        if tier == WASIX_EVIDENCE_TIER:
            if not isinstance(source_commit, str) or re.fullmatch(r"[0-9a-f]{40}", source_commit) is None:
                fail(f"{rel(run_file)} {tier} evidence must define a full sourceCommit")
            if not isinstance(source_tree, str) or re.fullmatch(r"[0-9a-f]{40}", source_tree) is None:
                fail(f"{rel(run_file)} {tier} evidence must define a full sourceTree")
            if not isinstance(github, dict):
                fail(f"{rel(run_file)} {tier} evidence must define GitHub run provenance")
            for field in ("repository", "workflow", "job"):
                if not isinstance(github.get(field), str) or not github[field]:
                    fail(f"{rel(run_file)} github.{field} must be a non-empty string")
            for field in ("runId", "runAttempt"):
                if not isinstance(github.get(field), int) or isinstance(github[field], bool) or github[field] < 1:
                    fail(f"{rel(run_file)} github.{field} must be a positive integer")
        results = run.get("results")
        if not isinstance(results, list) or not results:
            fail(f"{rel(run_file)} must define evidence results")
        run_results: dict[tuple[str, str, str], dict[str, str]] = {}
        for result in results:
            extension_id = validate_id(result.get("extension"), f"{rel(run_file)} result extension")
            sql_name = result.get("sqlName")
            if not isinstance(sql_name, str) or not sql_name:
                fail(f"{rel(run_file)} result {extension_id} must define sqlName")
            if result.get("postgresMajor") != 18:
                continue
            family = result.get("artifactFamily")
            target = result.get("platformTarget")
            statuses = result.get("runtimeModeStatuses")
            if not isinstance(family, str) or not isinstance(target, str) or not isinstance(statuses, dict):
                fail(f"{rel(run_file)} result {extension_id} must define family, target, and runtimeModeStatuses")
            if not statuses or any(
                not isinstance(mode, str)
                or not mode
                or status not in EVIDENCE_STATUSES
                for mode, status in statuses.items()
            ):
                fail(f"{rel(run_file)} result {extension_id} has invalid runtimeModeStatuses")
            run_key = (extension_id, family, target)
            if run_key in run_results:
                fail(
                    f"{rel(run_file)} has duplicate result for "
                    f"{extension_id} {family}/{target}"
                )
            run_results[run_key] = statuses

        # Evidence observations are immutable history. A run for an older
        # semantic input set remains valid history, but it cannot satisfy a
        # current CI support claim.
        if (
            run_digest != current_digest
            or run_digest_inputs != digest_inputs
            or run_status != "passed"
        ):
            continue
        if tier == WASIX_EVIDENCE_TIER:
            current_commit, current_tree = current_git_identity()
            if source_commit != current_commit or source_tree != current_tree:
                continue
        for (extension_id, family, target), statuses in run_results.items():
            key = (extension_id, tier, family, target)
            order = (observed_at, run_id, rel(run_file))
            if order <= latest_order.get(key, ("", "", "")):
                continue
            evidence[key] = statuses
            latest_order[key] = order
            latest[key] = {
                "run-id": run_id,
                "run-path": rel(run_file),
                "evidence-tier": tier,
                "artifact-family": family,
                "platform-target": target,
                "source-digest": current_digest,
                "source-commit": source_commit,
                "source-tree": source_tree,
                "github": github,
                "observed-at": observed_at,
                "runtime-mode-statuses": statuses,
            }

    claim_rows = []
    for claim in claims:
        extension_id = claim["extension"]
        tiers = claim["evidence-required"]
        targets = claim["platform-targets"]
        modes = claim["runtime-modes"]
        family = claim["artifact-family"]
        if not isinstance(tiers, list) or not isinstance(targets, list) or not isinstance(modes, list):
            fail(f"{rel(EVIDENCE_MATRIX)} claim {extension_id} has invalid evidence target arrays")
        accepted = []
        missing = []
        for tier in tiers:
            for target in targets:
                statuses = evidence.get((extension_id, tier, family, target))
                missing_modes = [mode for mode in modes if statuses is None or statuses.get(mode) != "passed"]
                if missing_modes:
                    missing.append(
                        {
                            "evidence-tier": tier,
                            "artifact-family": family,
                            "platform-target": target,
                            "runtime-modes": missing_modes,
                        }
                    )
                    continue
                accepted.append(latest[(extension_id, tier, family, target)])
        if require_current and missing:
            first = missing[0]
            fail(
                f"extension claim {extension_id} lacks current CI "
                f"{first['evidence-tier']} evidence for "
                f"{first['artifact-family']}/{first['platform-target']} modes "
                f"{first['runtime-modes']}"
            )
        catalog_row = next((row for row in catalog.get("extensions", []) if row.get("id") == extension_id), {})
        claim_rows.append(
            {
                "extension": extension_id,
                "sql-name": catalog_row.get("sql-name", extension_id),
                "postgres-major": claim.get("postgres-major"),
                "artifact-family": family,
                "platform-targets": targets,
                "runtime-modes": modes,
                "evidence-required": tiers,
                "latest-accepted-evidence": accepted,
                "missing-current-evidence": missing,
            }
        )

    claim_rows.sort(key=lambda row: (str(row["sql-name"]), str(row["extension"])))
    return {
        "format-version": 1,
        "qualification-authority": {
            "kind": "exact-sha-ci",
            "collector": "src/extensions/tools/collect-wasix-evidence.sh",
        },
        "generated-from": [
            {"name": "extension-catalog", "path": rel(CATALOG)},
            {"name": "evidence-matrix", "path": rel(EVIDENCE_MATRIX)},
            {"name": "evidence-runs", "path": rel(EVIDENCE_RUNS)},
        ],
        "source-digest": current_digest,
        "source-digest-inputs": digest_inputs,
        "claims": claim_rows,
    }


def record_wasix_evidence_run(catalog: dict, run_id: str, observed_at: str) -> None:
    if re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{6}Z-[a-z0-9-]+", run_id) is None:
        fail(
            "--record-wasix-evidence-run must use "
            "YYYY-MM-DDTHHMMSSZ-lower-kebab-case"
        )
    if re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z", observed_at) is None:
        fail("--observed-at must use UTC YYYY-MM-DDTHH:MM:SSZ")
    output = EVIDENCE_RUNS / f"{run_id}.json"
    if output.exists():
        fail(f"refusing to overwrite immutable evidence run {rel(output)}")

    required_github = {
        "repository": os.environ.get("GITHUB_REPOSITORY", ""),
        "workflow": os.environ.get("GITHUB_WORKFLOW", ""),
        "job": os.environ.get("GITHUB_JOB", ""),
        "runId": os.environ.get("GITHUB_RUN_ID", ""),
        "runAttempt": os.environ.get("GITHUB_RUN_ATTEMPT", ""),
    }
    if os.environ.get("GITHUB_ACTIONS") != "true":
        fail("full WASIX release evidence may only be recorded by the GitHub Actions collector")
    for field in ("repository", "workflow", "job"):
        if not required_github[field]:
            fail(f"GitHub Actions evidence is missing {field}")
    for field in ("runId", "runAttempt"):
        if not str(required_github[field]).isdigit() or int(str(required_github[field])) < 1:
            fail(f"GitHub Actions evidence has invalid {field}")
    source_commit, source_tree = current_git_identity()
    candidate_sha = os.environ.get("CI_HEAD_SHA", "")
    if candidate_sha != source_commit:
        fail(f"GitHub Actions CI_HEAD_SHA {candidate_sha!r} does not match checkout HEAD {source_commit}")
    require_clean_evidence_inputs()

    results = []
    for extension in catalog_extensions(catalog):
        results.append(
            {
                "extension": extension.get("id"),
                "sqlName": extension.get("sql-name", extension.get("id")),
                "postgresMajor": 18,
                "artifactFamily": "wasix-runtime",
                "platformTarget": "portable",
                "runtimeModeStatuses": {
                    "direct": "passed",
                    "server": "passed",
                    "restart": "passed",
                    "dump-restore": "passed",
                },
            }
        )
    run = {
        "schema": "oliphaunt-extension-evidence-v1",
        "id": run_id,
        "evidenceTier": WASIX_EVIDENCE_TIER,
        "status": "passed",
        "sourceDigest": source_digest(),
        "sourceDigestInputs": source_digest_inputs(),
        "sourceCommit": source_commit,
        "sourceTree": source_tree,
        "observedAt": observed_at,
        "collector": "src/extensions/tools/collect-wasix-evidence.sh",
        "github": {
            "repository": required_github["repository"],
            "workflow": required_github["workflow"],
            "runId": int(str(required_github["runId"])),
            "runAttempt": int(str(required_github["runAttempt"])),
            "job": required_github["job"],
        },
        "notes": (
            "Recorded only after the full WASIX catalog-extension direct, server, "
            "restart, materialization, and dump/restore suites succeeded."
        ),
        "results": results,
    }
    EVIDENCE_RUNS.mkdir(parents=True, exist_ok=True)
    output.write_text(json_text(run), encoding="utf-8")


def evidence_table_text(catalog: dict, require_current: bool = False) -> str:
    table = validate_evidence(catalog, require_current=require_current)
    if table.get("format-version") != 1:
        fail(f"generated {rel(EVIDENCE_TABLE)} must use format-version 1")
    if not table.get("claims"):
        fail(f"generated {rel(EVIDENCE_TABLE)} must define evidence claims")
    return json_text(table)


def write_evidence_summary(catalog: dict, require_current: bool = False) -> None:
    """Rewrite only the deterministic evidence summary.

    The claim matrix and observed evidence run records are inputs to this
    projection. They are never created, updated, or removed here. A stale run
    remains immutable history and cannot become current by regenerating this
    summary.
    """
    expected = evidence_table_text(catalog, require_current=require_current)
    EVIDENCE_TABLE.parent.mkdir(parents=True, exist_ok=True)
    EVIDENCE_TABLE.write_text(expected, encoding="utf-8")


def validate_evidence_table(catalog: dict, write: bool, require_current: bool = False) -> None:
    expected = evidence_table_text(catalog, require_current=require_current)
    if write:
        EVIDENCE_TABLE.parent.mkdir(parents=True, exist_ok=True)
        EVIDENCE_TABLE.write_text(expected, encoding="utf-8")
        return
    if not EVIDENCE_TABLE.exists():
        fail(
            f"{rel(EVIDENCE_TABLE)} is missing; run "
            f"{CHECK_EXTENSION_MODEL_WRITE_EVIDENCE_SUMMARY_COMMAND}"
        )
    actual = EVIDENCE_TABLE.read_text(encoding="utf-8")
    if actual != expected:
        fail(
            f"{rel(EVIDENCE_TABLE)} is stale; run "
            f"{CHECK_EXTENSION_MODEL_WRITE_EVIDENCE_SUMMARY_COMMAND}"
        )
    table = read_json(EVIDENCE_TABLE)
    if table.get("format-version") != 1:
        fail(f"{rel(EVIDENCE_TABLE)} must use format-version 1")
    if not table.get("claims"):
        fail(f"{rel(EVIDENCE_TABLE)} must define evidence claims")


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
    for domain in PRODUCTION_THIRD_PARTY_DOMAINS:
        for path in (THIRD_PARTY_ROOT / domain).glob("**/*.toml"):
            if path.is_file() and rel(path) not in digest_inputs:
                fail(
                    "self-test expected production third-party source pin in extension "
                    f"digest inputs: {rel(path)}"
                )
    nonproduction_third_party_inputs = sorted(
        path
        for path in digest_inputs
        if path.startswith("src/sources/third-party/")
        and path.split("/", 4)[3] not in PRODUCTION_THIRD_PARTY_DOMAINS
    )
    if nonproduction_third_party_inputs:
        fail(
            "self-test expected nonproduction source pins to stay outside extension digest "
            "inputs: " + ", ".join(nonproduction_third_party_inputs)
        )
    for path in [
        "src/extensions/external/vector/VERSION",
        "src/extensions/external/vector/CHANGELOG.md",
        "src/extensions/external/vector/release.toml",
    ]:
        if path in digest_inputs:
            fail(f"self-test expected release/package envelope metadata to be excluded from source digest inputs: {path}")
    for path in [
        "src/extensions/external/postgis/recipe.toml",
        "src/extensions/catalog/native-components.toml",
        "src/shared/fixtures/extensions/postgis.sql",
    ]:
        if path not in digest_inputs:
            fail(f"self-test expected source recipe input to stay in source digest inputs: {path}")

    with TemporaryDirectory() as tmp:
        obsolete_root = Path(tmp)
        obsolete = obsolete_root / "external/vector/targets/artifacts.toml"
        obsolete.parent.mkdir(parents=True)
        obsolete.write_text("obsolete = true\n", encoding="utf-8")
        try:
            validate_no_obsolete_extension_files(obsolete_root)
        except SystemExit:
            pass
        else:
            fail("self-test expected an obsolete per-extension artifact manifest to fail")

    originals = {
        "EVIDENCE_MATRIX": globals()["EVIDENCE_MATRIX"],
        "EVIDENCE_RUN_SCHEMA": globals()["EVIDENCE_RUN_SCHEMA"],
        "EVIDENCE_MATRIX_SCHEMA": globals()["EVIDENCE_MATRIX_SCHEMA"],
        "EVIDENCE_RUNS": globals()["EVIDENCE_RUNS"],
        "EVIDENCE_TABLE": globals()["EVIDENCE_TABLE"],
    }
    catalog = {"extensions": [{"id": "vector", "sql-name": "vector"}]}
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
            globals()["EVIDENCE_TABLE"] = root / "generated" / "extension-evidence.json"
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
                        "",
                    ]
                ),
                encoding="utf-8",
            )
            stale_run = globals()["EVIDENCE_RUNS"] / "stale.json"
            stale_run.write_text(
                json_text(
                    {
                        "schema": "oliphaunt-extension-evidence-v1",
                        "id": "stale",
                        "evidenceTier": "self-test",
                        "status": "passed",
                        "sourceDigest": f"sha256:{'0' * 64}",
                        "sourceDigestInputs": source_digest_inputs(),
                        "observedAt": "2026-01-01T00:00:00Z",
                        "collector": "self-test",
                        "results": [
                            {
                                "extension": "vector",
                                "sqlName": "vector",
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
            table = validate_evidence(catalog)
            if not table["claims"][0]["missing-current-evidence"]:
                fail("self-test expected stale evidence to remain history without qualifying current source")
            try:
                validate_evidence(catalog, require_current=True)
            except SystemExit:
                pass
            else:
                fail("self-test expected current-CI qualification to reject stale evidence")

            matrix_before = globals()["EVIDENCE_MATRIX"].read_bytes()
            run_before = stale_run.read_bytes()
            write_evidence_summary(catalog)
            if globals()["EVIDENCE_MATRIX"].read_bytes() != matrix_before:
                fail("self-test evidence-summary write mutated the claim matrix")
            if stale_run.read_bytes() != run_before:
                fail("self-test evidence-summary write mutated an observed run")
            written = read_json(globals()["EVIDENCE_TABLE"])
            if written != table:
                fail("self-test evidence-summary write did not persist the validated projection")
            actual_files = {
                path.relative_to(root).as_posix()
                for path in root.rglob("*")
                if path.is_file()
            }
            expected_files = {
                "generated/extension-evidence.json",
                "matrix.schema.json",
                "matrix.toml",
                "run.schema.json",
                "runs/stale.json",
            }
            if actual_files != expected_files:
                fail(
                    "self-test evidence-summary write changed the evidence file inventory: "
                    f"missing={sorted(expected_files - actual_files)}, "
                    f"extra={sorted(actual_files - expected_files)}"
                )
    finally:
        for name, value in originals.items():
            globals()[name] = value


def main() -> None:
    parser = argparse.ArgumentParser()
    mutation = parser.add_mutually_exclusive_group()
    mutation.add_argument(
        "--write",
        action="store_true",
        help="regenerate all derived extension metadata",
    )
    mutation.add_argument(
        "--write-evidence",
        action="store_true",
        help=(
            "regenerate the evidence claim matrix and deterministic summary; observed run files "
            "are immutable"
        ),
    )
    mutation.add_argument(
        "--write-evidence-summary",
        action="store_true",
        help=(
            "rewrite only generated extension-evidence.json from the claim matrix and immutable "
            "observed runs; never mutate either input"
        ),
    )
    mutation.add_argument(
        "--record-wasix-evidence-run",
        metavar="RUN_ID",
        help="record an immutable full WASIX lifecycle run after the collector succeeds",
    )
    parser.add_argument("--observed-at", help="UTC timestamp for --record-wasix-evidence-run")
    parser.add_argument(
        "--require-current-evidence",
        action="store_true",
        help="fail unless every claim has passing evidence for the current semantic source digest",
    )
    parser.add_argument("--check", action="store_true", help="validate generated files without writing")
    parser.add_argument("--self-test", action="store_true", help="run negative validation tests")
    args = parser.parse_args()

    if args.self_test:
        self_test()

    for path in (
        RECIPE_SCHEMA,
        SOURCE_CATALOG,
        CATALOG,
        CONTRIB_RECIPE,
        SMOKE_RECIPE_ROOT,
    ):
        if not path.exists():
            fail(f"missing required extension model file: {rel(path)}")

    validate_no_obsolete_extension_files()
    catalog = read_json(CATALOG)
    if args.record_wasix_evidence_run:
        if not args.observed_at:
            fail("--record-wasix-evidence-run requires --observed-at")
        record_wasix_evidence_run(catalog, args.record_wasix_evidence_run, args.observed_at)
        write_evidence_files(catalog)
    elif args.observed_at:
        fail("--observed-at requires --record-wasix-evidence-run")
    # A catalog transition changes the evidence claim matrix and every
    # SDK projection together. Keep --write a one-command
    # fixed point while preserving immutable observed evidence run JSON.
    if args.write or args.write_evidence:
        write_evidence_files(catalog)
    validate_extension_release_metadata()
    validate_contrib_recipe(catalog)
    validate_native_component_inventory(catalog)
    validate_external_recipes(catalog)
    validate_extension_smoke_recipes(catalog)
    evidence_summary_pending = args.write_evidence_summary
    if evidence_summary_pending:
        # Validate the complete projection now, but defer the only write until
        # every other model and xtask check has passed.
        evidence_table_text(catalog, require_current=args.require_current_evidence)
    else:
        validate_evidence_table(
            catalog,
            write=args.write or args.write_evidence or bool(args.record_wasix_evidence_run),
            require_current=args.require_current_evidence,
        )
    validate_generated_sdk_metadata(catalog, write=args.write)
    if not args.write:
        run_xtask_check()
    if evidence_summary_pending:
        write_evidence_summary(catalog, require_current=args.require_current_evidence)
    print("extension model checks passed")


if __name__ == "__main__":
    main()
