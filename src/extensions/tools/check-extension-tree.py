#!/usr/bin/env python3
from __future__ import annotations

import pathlib
import sys
import tomllib


ROOT = pathlib.Path(__file__).resolve().parents[3]
EXTENSION_ARTIFACT_TARGET_SCHEMA = "oliphaunt-extension-artifact-targets-v1"


def fail(message: str) -> None:
    raise SystemExit(f"extension-tree: {message}")


def parse_toml(path: pathlib.Path) -> object:
    try:
        return tomllib.loads(path.read_text(encoding="utf-8"))
    except Exception as error:
        fail(f"cannot parse {path.relative_to(ROOT)}: {error}")


def check_external(path: pathlib.Path) -> None:
    source = path / "source.toml"
    if not source.is_file():
        fail(f"{path.relative_to(ROOT)} must own source.toml")
    source_data = parse_toml(source)
    for key in ("name", "url"):
        if not isinstance(source_data.get(key), str) or not source_data[key]:
            fail(f"{source.relative_to(ROOT)} must define non-empty {key}")

    release = path / "release.toml"
    if release.is_file():
        release_data = parse_toml(release)
        if release_data.get("kind") == "exact-extension-artifact":
            artifact_targets = path / "targets" / "artifacts.toml"
            if artifact_targets.is_file():
                check_artifact_target_override(artifact_targets)

    for toml_file in sorted(path.rglob("*.toml")):
        parse_toml(toml_file)


def check_contrib(path: pathlib.Path) -> None:
    manifest = path / "postgres18.toml"
    if not manifest.is_file():
        fail(f"{path.relative_to(ROOT)} must contain postgres18.toml")
    data = parse_toml(manifest)
    if data.get("format-version") != 1:
        fail(f"{manifest.relative_to(ROOT)} must use format-version = 1")
    if data.get("postgres-version") != "18.4":
        fail(f"{manifest.relative_to(ROOT)} must target PostgreSQL 18.4")
    if data.get("source-kind") != "postgres-contrib":
        fail(f"{manifest.relative_to(ROOT)} must describe postgres-contrib")
    if not isinstance(data.get("extensions"), list) or not data["extensions"]:
        fail(f"{manifest.relative_to(ROOT)} must define extension rows")
    for toml_file in sorted(path.rglob("*.toml")):
        parse_toml(toml_file)


def contrib_manifest_rows() -> dict[str, dict]:
    manifest = ROOT / "src/extensions/contrib/postgres18.toml"
    data = parse_toml(manifest)
    rows = data.get("extensions")
    if not isinstance(rows, list):
        fail(f"{manifest.relative_to(ROOT)} must define extension rows")
    parsed: dict[str, dict] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        extension_id = row.get("id")
        if isinstance(extension_id, str) and extension_id:
            parsed[extension_id] = row
    return parsed


def check_artifact_product(path: pathlib.Path, *, family: str) -> None:
    release = path / "release.toml"
    if not release.is_file():
        fail(f"{path.relative_to(ROOT)} must own release.toml")
    release_data = parse_toml(release)
    if release_data.get("kind") != "exact-extension-artifact":
        fail(f"{release.relative_to(ROOT)} must declare kind = 'exact-extension-artifact'")
    sql_name = release_data.get("extension_sql_name")
    if not isinstance(sql_name, str) or not sql_name:
        fail(f"{release.relative_to(ROOT)} must declare extension_sql_name")
    artifact_targets = path / "targets" / "artifacts.toml"
    if artifact_targets.is_file():
        check_artifact_target_override(artifact_targets)
    if family == "contrib":
        extension_id = path.name
        row = contrib_manifest_rows().get(extension_id)
        if row is None:
            fail(f"{path.relative_to(ROOT)} must match a row in src/extensions/contrib/postgres18.toml")
        if row.get("sql-name") != sql_name:
            fail(
                f"{release.relative_to(ROOT)} extension_sql_name {sql_name!r} "
                f"must match contrib manifest sql-name {row.get('sql-name')!r}"
            )
    for toml_file in sorted(path.rglob("*.toml")):
        parse_toml(toml_file)


def check_artifact_target_override(artifact_targets: pathlib.Path) -> None:
    target_data = parse_toml(artifact_targets)
    if target_data.get("schema") != EXTENSION_ARTIFACT_TARGET_SCHEMA:
        fail(
            f"{artifact_targets.relative_to(ROOT)} must use schema = "
            f"{EXTENSION_ARTIFACT_TARGET_SCHEMA!r}"
        )
    if not isinstance(target_data.get("targets"), list) or not target_data["targets"]:
        fail(f"{artifact_targets.relative_to(ROOT)} must define [[targets]] rows")


def main(argv: list[str]) -> None:
    if len(argv) != 2:
        fail("usage: check-extension-tree.py <src/extensions/{contrib|external/<name>}>")
    path = (ROOT / argv[1]).resolve()
    try:
        path.relative_to(ROOT)
    except ValueError:
        fail(f"path is outside repository: {path}")
    if not path.is_dir():
        fail(f"path does not exist: {path.relative_to(ROOT)}")
    if path == ROOT / "src/extensions/contrib":
        check_contrib(path)
    elif path.parent == ROOT / "src/extensions/contrib":
        check_artifact_product(path, family="contrib")
    elif path.parent == ROOT / "src/extensions/external":
        check_external(path)
        release = path / "release.toml"
        if release.is_file() and parse_toml(release).get("kind") == "exact-extension-artifact":
            check_artifact_product(path, family="external")
    else:
        fail(f"unsupported extension tree path: {path.relative_to(ROOT)}")


if __name__ == "__main__":
    main(sys.argv)
