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
runtime_version = (root / "src/runtimes/liboliphaunt/wasix/VERSION").read_text(encoding="utf-8").strip()


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


def is_wasix_artifact_crate(name):
    return name == "liboliphaunt-wasix-portable" or name.startswith("liboliphaunt-wasix-aot-")


errors = []
product_deps = {}
for table_name, deps in dependency_tables(product_manifest):
    for dep_key, spec in deps.items():
        name = dependency_name(dep_key, spec)
        if not is_wasix_artifact_crate(name):
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
    if not is_wasix_artifact_crate(name):
        errors.append(f"{manifest_path}: unexpected WASIX artifact crate name {name!r}")
        continue
    if version != runtime_version:
        errors.append(
            f"{manifest_path}: {name} version {version} does not match liboliphaunt-wasix runtime version {runtime_version}"
        )
    if package.get("publish") is not False:
        errors.append(f"{manifest_path}: source artifact crate template {name} must declare publish = false")
    if name not in product_deps:
        errors.append(f"oliphaunt-wasix must depend on WASIX artifact crate {name}")

for name, (table_name, spec) in sorted(product_deps.items()):
    version = dependency_version(spec)
    path = dependency_path(spec)
    if version != f"={runtime_version}":
        errors.append(
            "src/bindings/wasix-rust/crates/oliphaunt-wasix/Cargo.toml "
            f"{table_name}.{name} must use exact liboliphaunt-wasix version ={runtime_version}, got {version!r}"
        )
    if not path:
        errors.append(
            "src/bindings/wasix-rust/crates/oliphaunt-wasix/Cargo.toml "
            f"{table_name}.{name} must keep a source-checkout path dependency"
        )

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
