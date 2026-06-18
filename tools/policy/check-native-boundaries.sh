#!/usr/bin/env sh
set -eu

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

python3 <<'PY'
import json
import pathlib
import re
import sys
import tomllib

root = pathlib.Path.cwd()
errors: list[str] = []

legacy_package_names = {
    "oliphaunt-wasix",
    "oliphaunt-wasix-assets",
}
legacy_name_prefixes = (
    "oliphaunt-wasix-aot-",
)
legacy_runtime_names = {
    "wasmer",
    "wasmer-wasix",
    "wasmer-vfs",
    "wasmer-types",
    "wasmer-headless",
}
legacy_path_fragments = (
    "src/bindings/wasix-rust/crates/oliphaunt-wasix",
    "src/runtimes/liboliphaunt/wasix/crates/assets",
    "src/runtimes/liboliphaunt/wasix/crates/aot",
)


def rel(path: pathlib.Path) -> str:
    return path.relative_to(root).as_posix()


def read_toml(relative_path: str) -> dict:
    path = root / relative_path
    return tomllib.loads(path.read_text(encoding="utf-8"))


def dependency_tables(manifest: dict):
    for table_name in ("dependencies", "dev-dependencies", "build-dependencies"):
        yield table_name, manifest.get(table_name, {})
    for cfg, table in manifest.get("target", {}).items():
        for table_name in ("dependencies", "dev-dependencies", "build-dependencies"):
            yield f"target.{cfg}.{table_name}", table.get(table_name, {})


def dependency_name(dep_key: str, spec) -> str:
    if isinstance(spec, dict):
        return spec.get("package", dep_key)
    return dep_key


def dependency_path(spec):
    if isinstance(spec, dict):
        return spec.get("path")
    return None


def is_blocked_rust_dependency(name: str) -> bool:
    return (
        name in legacy_package_names
        or name in legacy_runtime_names
        or any(name.startswith(prefix) for prefix in legacy_name_prefixes)
    )


def check_native_rust_manifest(relative_path: str) -> None:
    manifest_path = root / relative_path
    manifest = read_toml(relative_path)
    for table_name, deps in dependency_tables(manifest):
        for dep_key, spec in deps.items():
            name = dependency_name(dep_key, spec)
            if is_blocked_rust_dependency(name):
                errors.append(
                    f"{relative_path} {table_name}.{dep_key} depends on legacy runtime resources {name!r}"
                )
            path_value = dependency_path(spec)
            if path_value is None:
                continue
            dependency_target = (manifest_path.parent / path_value).resolve()
            dependency_target_rel = dependency_target.relative_to(root).as_posix()
            if any(
                dependency_target_rel == fragment
                or dependency_target_rel.startswith(f"{fragment}/")
                for fragment in legacy_path_fragments
            ):
                errors.append(
                    f"{relative_path} {table_name}.{dep_key} points at legacy path {dependency_target_rel}"
                )


def check_json_manifest(relative_path: str) -> None:
    manifest = json.loads((root / relative_path).read_text(encoding="utf-8"))
    for table_name in (
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
    ):
        deps = manifest.get(table_name, {})
        for name in deps:
            if name in legacy_package_names or any(
                name.startswith(prefix) for prefix in legacy_name_prefixes
            ):
                errors.append(
                    f"{relative_path} {table_name}.{name} depends on legacy WASIX package"
                )


def require_text(relative_path: str, text: str, message: str) -> None:
    if text not in (root / relative_path).read_text(encoding="utf-8"):
        errors.append(f"{relative_path}: {message}; expected {text!r}")


def check_tool_crate_boundaries() -> None:
    manifest = read_toml("tools/xtask/Cargo.toml")
    features = manifest.get("features", {})
    dependencies = manifest.get("dependencies", {})

    if features.get("default") != []:
        errors.append(
            "tools/xtask/Cargo.toml must keep the default feature set empty"
        )
    for removed_feature in ("perf", "legacy-oliphaunt"):
        if removed_feature in features:
            errors.append(
                f"tools/xtask/Cargo.toml must not define product-aware feature {removed_feature!r}; use tools/perf/runner"
            )

    forbidden_xtask_dependencies = (
        "directories",
        "futures-util",
        "oliphaunt",
        "oliphaunt-wasix",
        "rusqlite",
        "sqlx",
        "tokio-postgres",
    )
    for dep_name in forbidden_xtask_dependencies:
        if dep_name in dependencies:
            errors.append(
                f"tools/xtask/Cargo.toml must not depend on product/perf crate {dep_name!r}; use tools/perf/runner"
            )

    for dep_name in ("wasmer", "wasmer-types", "wasmer-wasix", "webc", "tokio"):
        spec = dependencies.get(dep_name)
        if not isinstance(spec, dict) or spec.get("optional") is not True:
            errors.append(
                f"tools/xtask/Cargo.toml dependency {dep_name!r} must stay optional so default xtask builds do not compile template/AOT runtime support"
            )

    perf_manifest = read_toml("tools/perf/runner/Cargo.toml")
    perf_features = perf_manifest.get("features", {})
    perf_dependencies = perf_manifest.get("dependencies", {})
    if perf_features.get("default") != []:
        errors.append(
            "tools/perf/runner/Cargo.toml must keep the default feature set empty"
        )
    legacy_feature = set(perf_features.get("legacy-oliphaunt", []))
    for dep_name in ("dep:directories", "dep:oliphaunt-wasix"):
        if dep_name not in legacy_feature:
            errors.append(
                f"tools/perf/runner/Cargo.toml legacy-oliphaunt feature must gate {dep_name}"
            )
    for dep_name in ("oliphaunt", "rusqlite", "sqlx", "tokio-postgres"):
        if dep_name not in perf_dependencies:
            errors.append(
                f"tools/perf/runner/Cargo.toml must own benchmark dependency {dep_name!r}"
            )

    wasix_runner = set(features.get("wasix-runner", []))
    for dep_name in ("dep:wasmer", "dep:wasmer-wasix", "dep:webc"):
        if dep_name not in wasix_runner:
            errors.append(
                f"tools/xtask/Cargo.toml wasix-runner feature must explicitly gate {dep_name}"
            )

    aot_serializer = set(features.get("aot-serializer", []))
    if "dep:wasmer-types" not in aot_serializer:
        errors.append(
            "tools/xtask/Cargo.toml aot-serializer feature must explicitly gate dep:wasmer-types"
        )


def check_native_script_boundary() -> None:
    require_text(
        "tools/perf/matrix/run_native_oliphaunt_matrix.sh",
        "cargo build --release -p oliphaunt-perf -p oliphaunt --bins",
        "native perf matrix must build the dedicated perf runner and native broker helper",
    )
    require_text(
        "tools/perf/matrix/run_native_oliphaunt_matrix.sh",
        "legacyWasixControls=false",
        "native perf matrix plan must classify itself as native-only",
    )
    require_text(
        "src/runtimes/liboliphaunt/native/tools/check-track.sh",
        "run src/runtimes/liboliphaunt/native/tools/check-patch-stack.mjs --check",
        "native track validation must keep the PostgreSQL patch-stack audit in the native lane",
    )
    require_text(
        "src/runtimes/liboliphaunt/native/moon.yml",
        'command: "bash src/runtimes/liboliphaunt/native/tools/check-track.sh host-smoke"',
        "liboliphaunt host-smoke validation must run the host C ABI smoke rather than workspace legacy validation",
    )
    reject_manifest_text(
        "tools/policy/check-policy-tools.sh",
        [
            (
                "tools/policy/check-sdk-parity.sh",
                "policy-tools must stay a thin repository-policy aggregator; SDK parity evidence belongs to dedicated SDK/contract tasks",
            ),
        ],
    )


def reject_manifest_text(relative_path: str, patterns: list[tuple[str, str]]) -> None:
    path = root / relative_path
    text = path.read_text(encoding="utf-8")
    for label, pattern in patterns:
        if re.search(pattern, text, flags=re.IGNORECASE):
            errors.append(f"{relative_path} contains blocked native-boundary reference: {label}")


def walk_files(relative_roots: list[str], suffixes: tuple[str, ...]):
    for relative_root in relative_roots:
        path = root / relative_root
        if not path.exists():
            errors.append(f"missing expected native boundary path: {relative_root}")
            continue
        for file_path in path.rglob("*"):
            if file_path.is_file() and file_path.suffix in suffixes:
                yield file_path


check_native_rust_manifest("src/sdks/rust/Cargo.toml")
check_json_manifest("src/sdks/react-native/package.json")
check_json_manifest("src/sdks/react-native/examples/expo/package.json")
check_tool_crate_boundaries()
check_native_script_boundary()

manifest_text_patterns = [
    ("oliphaunt-wasix package", r"\boliphaunt-wasix\b"),
    ("WASIX runtime", r"\bwasix\b"),
    ("Wasmer runtime", r"\bwasmer\b"),
]
for manifest_path in (
    "src/sdks/swift/Package.swift",
    "src/sdks/react-native/OliphauntReactNative.podspec",
    "src/sdks/kotlin/build.gradle.kts",
    "src/sdks/kotlin/oliphaunt/build.gradle.kts",
    "src/sdks/react-native/android/build.gradle",
    "src/sdks/react-native/android/settings.gradle",
):
    reject_manifest_text(manifest_path, manifest_text_patterns)

source_patterns = [
    ("Rust import of legacy crate", r"\b(use|extern\s+crate)\s+oliphaunt_wasix\b"),
    ("Rust path to legacy crate", r"\boliphaunt_wasix::"),
    ("JavaScript import of legacy package", r"\b(import|require)\s*(?:.+?\s+from\s*)?['\"]oliphaunt-wasix['\"]"),
    ("Swift/Kotlin legacy module import", r"\bimport\s+OliphauntWasm\b"),
]
for file_path in walk_files(
    [
        "src/sdks/rust/src",
        "src/sdks/rust/tests",
        "src/runtimes/liboliphaunt/native/include",
        "src/runtimes/liboliphaunt/native/src",
        "src/sdks/swift/Sources",
        "src/sdks/swift/Tests",
        "src/sdks/kotlin/oliphaunt/src",
        "src/sdks/react-native/src",
        "src/sdks/react-native/ios",
        "src/sdks/react-native/android/src",
    ],
    (".rs", ".c", ".h", ".swift", ".kt", ".java", ".ts", ".tsx", ".m", ".mm", ".cpp"),
):
    text = file_path.read_text(encoding="utf-8", errors="ignore")
    for label, pattern in source_patterns:
        if re.search(pattern, text):
            errors.append(f"{rel(file_path)} contains blocked native-boundary code reference: {label}")

sdk_manifest = read_toml("tools/policy/sdk-manifest.toml")
expected_paths = {
    "rust": "src/sdks/rust",
    "swift": "src/sdks/swift",
    "kotlin": "src/sdks/kotlin",
    "react-native": "src/sdks/react-native",
}
seen_paths: dict[str, str] = {}
for sdk, expected_path in expected_paths.items():
    section = sdk_manifest.get("sdks", {}).get(sdk)
    if section is None:
        errors.append(f"tools/policy/sdk-manifest.toml is missing [sdks.{sdk}]")
        continue
    actual_path = section.get("implementation_path")
    if actual_path != expected_path:
        errors.append(
            f"tools/policy/sdk-manifest.toml [sdks.{sdk}].implementation_path is {actual_path!r}; expected {expected_path!r}"
        )
    if actual_path in seen_paths:
        errors.append(
            f"tools/policy/sdk-manifest.toml shares implementation_path {actual_path!r} between {seen_paths[actual_path]} and {sdk}"
        )
    seen_paths[actual_path] = sdk

react_native = sdk_manifest.get("sdks", {}).get("react-native", {})
if react_native.get("runtime_owner") is not False:
    errors.append("React Native SDK must stay a delegating adapter with runtime_owner = false")
if react_native.get("delegates_apple_to") != "swift":
    errors.append("React Native Apple runtime delegation must point at the Swift SDK")
if react_native.get("delegates_android_to") != "kotlin":
    errors.append("React Native Android runtime delegation must point at the Kotlin SDK")

if errors:
    print("native product boundary violations:", file=sys.stderr)
    for error in errors:
        print(f"  - {error}", file=sys.stderr)
    sys.exit(1)

print("native product boundaries ok")
PY
