#!/usr/bin/env python3
from __future__ import annotations

import pathlib
import sys
import tomllib


ROOT = pathlib.Path(__file__).resolve().parents[1]
CONTRACT = ROOT / "contract.toml"


def fail(message: str) -> None:
    raise SystemExit(f"extension-runtime-contract: {message}")


def main() -> None:
    try:
        data = tomllib.loads(CONTRACT.read_text(encoding="utf-8"))
    except Exception as error:
        fail(f"cannot parse {CONTRACT}: {error}")

    if data.get("schema") != "oliphaunt-extension-runtime-contract-v1":
        fail("contract.toml must use schema oliphaunt-extension-runtime-contract-v1")
    runtime = data.get("runtime")
    selection = data.get("selection")
    artifacts = data.get("artifacts")
    if not isinstance(runtime, dict) or not isinstance(selection, dict) or not isinstance(artifacts, dict):
        fail("contract.toml must define runtime, selection, and artifacts tables")
    if runtime.get("resource_layout") != "share/postgresql/extension":
        fail("runtime.resource_layout must match PostgreSQL extension resources")
    if runtime.get("dynamic_loader") != "postgres-compatible":
        fail("runtime.dynamic_loader must stay PostgreSQL-compatible")
    if runtime.get("static_registry_abi") != 1:
        fail("runtime.static_registry_abi must be 1 until the C ABI changes")
    if selection.get("unit") != "sql-extension-name":
        fail("selection.unit must be exact SQL extension name")
    for key in ("implicit_extensions", "implicit_extension_groups"):
        if selection.get(key) is not False:
            fail(f"selection.{key} must be false")
    if artifacts.get("base_runtime_contains_optional_extensions") is not False:
        fail("base runtime must not contain optional extension artifacts")
    if artifacts.get("extension_artifacts_are_exact") is not True:
        fail("extension artifacts must be exact-selected")


if __name__ == "__main__":
    main()
