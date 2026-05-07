#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$root"

python3 <<'PY'
import pathlib
import sys
import tomllib

root = pathlib.Path.cwd()
root_manifest_path = root / "Cargo.toml"
root_manifest = tomllib.loads(root_manifest_path.read_text(encoding="utf-8"))
root_version = root_manifest["package"]["version"]
expected_req = f"={root_version}"


def dependency_tables(manifest):
    yield "dependencies", manifest.get("dependencies", {})
    for cfg, table in manifest.get("target", {}).items():
        yield f"target.{cfg}.dependencies", table.get("dependencies", {})


def dependency_name(dep_key, spec):
    if isinstance(spec, dict):
        return spec.get("package", dep_key)
    return dep_key


def dependency_version(spec):
    if isinstance(spec, str):
        return spec
    if isinstance(spec, dict):
        return spec.get("version")
    return None


def dependency_path(spec):
    if isinstance(spec, dict):
        return spec.get("path")
    return None


def is_internal_payload_crate(name):
    return name == "pglite-oxide-assets" or name.startswith("pglite-oxide-aot-")


errors = []
root_deps = {}
for table_name, deps in dependency_tables(root_manifest):
    for dep_key, spec in deps.items():
        name = dependency_name(dep_key, spec)
        if not is_internal_payload_crate(name):
            continue
        if name in root_deps:
            errors.append(f"{name} is declared more than once in root dependencies")
        root_deps[name] = (table_name, spec)

internal_manifest_paths = [root / "crates/assets/Cargo.toml"]
internal_manifest_paths.extend(sorted((root / "crates/aot").glob("*/Cargo.toml")))

for manifest_path in internal_manifest_paths:
    manifest = tomllib.loads(manifest_path.read_text(encoding="utf-8"))
    package = manifest["package"]
    name = package["name"]
    version = package["version"]
    if not is_internal_payload_crate(name):
        errors.append(f"{manifest_path}: unexpected internal crate name {name!r}")
        continue
    if version != root_version:
        errors.append(
            f"{manifest_path}: {name} version {version} does not match root version {root_version}"
        )

    dep = root_deps.get(name)
    if dep is None:
        errors.append(f"root Cargo.toml does not depend on internal crate {name}")
        continue
    table_name, spec = dep
    version_req = dependency_version(spec)
    if version_req != expected_req:
        errors.append(
            f"root Cargo.toml {table_name}.{name} uses version {version_req!r}; expected {expected_req!r}"
        )
    path = dependency_path(spec)
    if path is None:
        errors.append(f"root Cargo.toml {table_name}.{name} must keep a path dependency")
        continue
    expected_path = manifest_path.parent.resolve()
    actual_path = (root / path).resolve()
    if actual_path != expected_path:
        errors.append(
            f"root Cargo.toml {table_name}.{name} points at {path!r}; expected {manifest_path.parent}"
        )

extra_deps = sorted(set(root_deps) - {tomllib.loads(path.read_text(encoding="utf-8"))["package"]["name"] for path in internal_manifest_paths})
for name in extra_deps:
    errors.append(f"root Cargo.toml depends on unknown internal crate {name}")

if errors:
    print("release version invariant violations:", file=sys.stderr)
    for error in errors:
        print(f"  - {error}", file=sys.stderr)
    sys.exit(1)

print("release version invariants ok")
PY

blocked='wasm''time|wasm''time-wasi|wasmer-compiler-(llvm|cranelift|singlepass)|llvm-sys|cranelift-|singlepass'

if cargo tree -p pglite-oxide --features extensions --locked | rg -n "$blocked"; then
  cat >&2 <<'MSG'
blocked runtime dependency found in the normal user dependency tree.

The production path must stay on headless Wasmer AOT loading. Backend compiler
crates such as LLVM, Cranelift, Singlepass, and Wasmtime must not enter the
normal user build.
MSG
  exit 1
fi

if cargo tree -p xtask --features aot-serializer --locked | rg -n 'wasmer-compiler-(cranelift|singlepass)|cranelift-|singlepass|wasm''time'; then
  cat >&2 <<'MSG'
blocked maintainer serializer dependency found.

The AOT serializer may use Wasmer LLVM only. Cranelift, Singlepass, and Wasmtime
belong in isolated maintainer experiments, not in release/AOT tooling.
MSG
  exit 1
fi

echo "dependency invariants ok"
