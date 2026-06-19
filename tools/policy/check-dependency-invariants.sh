#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

python3 <<'PY'
import pathlib
import sys
import tomllib

root = pathlib.Path.cwd()
product_manifest_path = root / "src/bindings/wasix-rust/crates/oliphaunt-wasix/Cargo.toml"
product_manifest = tomllib.loads(product_manifest_path.read_text(encoding="utf-8"))
product_version = product_manifest["package"]["version"]
expected_req = f"={product_version}"


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
    return name == "oliphaunt-wasix-assets" or name.startswith("oliphaunt-wasix-aot-")


errors = []
product_deps = {}
for table_name, deps in dependency_tables(product_manifest):
    for dep_key, spec in deps.items():
        name = dependency_name(dep_key, spec)
        if not is_internal_payload_crate(name):
            continue
        if name in product_deps:
            errors.append(f"{name} is declared more than once in oliphaunt-wasix dependencies")
        product_deps[name] = (table_name, spec)

internal_manifest_paths = [root / "src/runtimes/liboliphaunt/wasix/crates/assets/Cargo.toml"]
internal_manifest_paths.extend(sorted((root / "src/runtimes/liboliphaunt/wasix/crates/aot").glob("*/Cargo.toml")))

for manifest_path in internal_manifest_paths:
    manifest = tomllib.loads(manifest_path.read_text(encoding="utf-8"))
    package = manifest["package"]
    name = package["name"]
    version = package["version"]
    if not is_internal_payload_crate(name):
        errors.append(f"{manifest_path}: unexpected internal crate name {name!r}")
        continue
    if version != product_version:
        errors.append(
            f"{manifest_path}: {name} version {version} does not match oliphaunt-wasix version {product_version}"
        )

    dep = product_deps.get(name)
    if dep is None:
        errors.append(f"src/bindings/wasix-rust/crates/oliphaunt-wasix/Cargo.toml does not depend on internal crate {name}")
        continue
    table_name, spec = dep
    version_req = dependency_version(spec)
    if version_req != expected_req:
        errors.append(
            f"src/bindings/wasix-rust/crates/oliphaunt-wasix/Cargo.toml {table_name}.{name} uses version {version_req!r}; expected {expected_req!r}"
        )
    path = dependency_path(spec)
    if path is None:
        errors.append(f"src/bindings/wasix-rust/crates/oliphaunt-wasix/Cargo.toml {table_name}.{name} must keep a path dependency")
        continue
    expected_path = manifest_path.parent.resolve()
    actual_path = (product_manifest_path.parent / path).resolve()
    if actual_path != expected_path:
        errors.append(
            f"src/bindings/wasix-rust/crates/oliphaunt-wasix/Cargo.toml {table_name}.{name} points at {path!r}; expected {manifest_path.parent}"
        )

extra_deps = sorted(set(product_deps) - {tomllib.loads(path.read_text(encoding="utf-8"))["package"]["name"] for path in internal_manifest_paths})
for name in extra_deps:
    errors.append(f"src/bindings/wasix-rust/crates/oliphaunt-wasix/Cargo.toml depends on unknown internal crate {name}")

if errors:
    print("release version invariant violations:", file=sys.stderr)
    for error in errors:
        print(f"  - {error}", file=sys.stderr)
    sys.exit(1)

print("release version invariants ok")
PY

blocked='wasm''time|wasm''time-wasi|wasmer-compiler-(llvm|cranelift|singlepass)|llvm-sys|cranelift-|singlepass'

if cargo tree -p oliphaunt-wasix --features extensions --locked | rg -n "$blocked"; then
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
