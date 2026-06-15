#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

fail() {
  echo "build-sdk-ci-artifacts.sh: $*" >&2
  exit 1
}

require() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

stage_glob() {
  local glob="$1"
  local destination="$2"
  local matched=0
  mkdir -p "$destination"
  shopt -s nullglob
  for artifact in $glob; do
    matched=1
    cp -R "$artifact" "$destination/"
  done
  shopt -u nullglob
  [ "$matched" -eq 1 ] || fail "no artifacts matched $glob"
}

rust_crate_name() {
  local manifest="$1"
  python3 - "$manifest" <<'PY'
from pathlib import Path
import sys
import tomllib

data = tomllib.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
package = data["package"]
print(f"{package['name']}-{package['version']}.crate")
PY
}

cargo_package_dir() {
  local target_dir="${CARGO_TARGET_DIR:-$root/target}"
  if [[ "$target_dir" != /* ]]; then
    target_dir="$root/$target_dir"
  fi
  printf '%s/package\n' "$target_dir"
}

cargo_workspace_excludes_except() {
  python3 - "$@" <<'PY'
import json
import subprocess
import sys

wanted = set(sys.argv[1:])
metadata = json.loads(
    subprocess.check_output(
        ["cargo", "metadata", "--no-deps", "--format-version", "1"],
        text=True,
    )
)
for package in metadata["packages"]:
    name = package["name"]
    if name not in wanted:
        print(name)
PY
}

package_npm_workspace() {
  local package_dir="$1"
  local destination="$2"
  require pnpm
  mkdir -p "$destination"
  local pack_json pack_file
  pack_json="$(pnpm --dir "$package_dir" pack --pack-destination "$destination" --json)"
  printf '%s\n' "$pack_json" >"$destination/pnpm-pack.json"
  pack_file="$(
    PACK_JSON="$pack_json" PACK_DIR="$destination" node -e "
const manifest = JSON.parse(process.env.PACK_JSON || '{}');
if (!manifest.filename || !manifest.filename.endsWith('.tgz')) {
  throw new Error('pnpm pack did not report a .tgz filename');
}
const path = require('node:path');
console.log(path.isAbsolute(manifest.filename) ? manifest.filename : path.join(process.env.PACK_DIR || '', manifest.filename));
"
  )"
  [ -f "$pack_file" ] || fail "pnpm pack did not create $pack_file"
}

stage_jsr_source_workspace() {
  local package_dir="$1"
  local destination="$2"
  rm -rf "$destination"
  mkdir -p "$destination"
  (
    cd "$package_dir"
    tar \
      --exclude='./node_modules' \
      --exclude='./node_modules/*' \
      --exclude='./lib' \
      --exclude='./lib/*' \
      --exclude='./.turbo' \
      --exclude='./.turbo/*' \
      -cf - .
  ) | (
    cd "$destination"
    tar -xf -
  )
  [ -f "$destination/jsr.json" ] || fail "JSR source workspace is missing jsr.json"
  [ -f "$destination/package.json" ] || fail "JSR source workspace is missing package.json"
  [ -d "$destination/src" ] || fail "JSR source workspace is missing src/"
}

product="${1:-}"
[ -n "$product" ] || fail "usage: tools/release/build-sdk-ci-artifacts.sh <oliphaunt-rust|oliphaunt-swift|oliphaunt-kotlin|oliphaunt-js|oliphaunt-react-native|oliphaunt-wasix-rust>"

artifact_root="$root/target/sdk-artifacts/$product"
work_root="$root/target/sdk-artifacts-work/$product"
rm -rf "$artifact_root" "$work_root"
mkdir -p "$artifact_root" "$work_root"

case "$product" in
  oliphaunt-rust)
    require cargo
    require python3
    env OLIPHAUNT_SDK_CHECK_SCRATCH="$work_root/check" \
      src/sdks/rust/tools/check-sdk.sh package-shape
    cargo package -p oliphaunt --locked --allow-dirty
    crate_name="$(rust_crate_name "$root/src/sdks/rust/Cargo.toml")"
    package_dir="$(cargo_package_dir)"
    [ -f "$package_dir/$crate_name" ] || fail "cargo package did not create $package_dir/$crate_name"
    cp "$package_dir/$crate_name" "$artifact_root/$crate_name"
    cp "$root/target/liboliphaunt-sdk-check/rust-cargo-package-list.txt" \
      "$artifact_root/cargo-package-files.txt"
    ;;
  oliphaunt-swift)
    require swift
    env OLIPHAUNT_SDK_CHECK_SCRATCH="$work_root/check" \
      src/sdks/swift/tools/check-sdk.sh package-shape
    stage_glob "$work_root/check/package-shape/swift-source-archive/Oliphaunt-source.zip" "$artifact_root"
    [ -n "${OLIPHAUNT_SWIFT_RELEASE_ASSET_DIR:-}" ] ||
      fail "oliphaunt-swift package artifacts require OLIPHAUNT_SWIFT_RELEASE_ASSET_DIR"
    python3 tools/release/render_swiftpm_release_package.py \
      --asset-dir "$OLIPHAUNT_SWIFT_RELEASE_ASSET_DIR" \
      --output "$artifact_root/Package.swift.release" \
      --generated-tree "$work_root/swiftpm-release-tree"
    grep -Fq "liboliphaunt-native-v" "$artifact_root/Package.swift.release" ||
      fail "staged SwiftPM release manifest must use the public liboliphaunt GitHub release URL"
    if grep -Fq "file://" "$artifact_root/Package.swift.release"; then
      fail "staged SwiftPM release manifest must not contain local file URLs"
    fi
    ;;
  oliphaunt-kotlin)
    env OLIPHAUNT_KOTLIN_ANDROID_ABI_FILTERS=arm64-v8a,x86_64 \
      OLIPHAUNT_SDK_CHECK_SCRATCH="$work_root/check" \
      src/sdks/kotlin/tools/check-sdk.sh package-shape
    kotlin_maven_repo="$work_root/maven-local"
    kotlin_build_root="$work_root/gradle-build"
    kotlin_cxx_root="$work_root/cxx-build"
    kotlin_cache_root="$work_root/gradle-cache"
    kotlin_version="$(sed -n 's/^VERSION_NAME=//p' "$root/src/sdks/kotlin/gradle.properties" | tail -n 1)"
    [ -n "$kotlin_version" ] || fail "missing VERSION_NAME in src/sdks/kotlin/gradle.properties"
    "$root/src/sdks/kotlin/gradlew" -p "$root/src/sdks/kotlin" \
      :oliphaunt:publishAndroidReleasePublicationToMavenLocal \
      :oliphaunt-android-gradle-plugin:publishToMavenLocal \
      "-Dmaven.repo.local=$kotlin_maven_repo" \
      "-PoliphauntAndroidAbiFilters=arm64-v8a,x86_64" \
      "-PoliphauntBuildRoot=$kotlin_build_root" \
      "-PoliphauntCxxBuildRoot=$kotlin_cxx_root" \
      --project-cache-dir "$kotlin_cache_root" \
      --no-configuration-cache
    [ -f "$kotlin_maven_repo/dev/oliphaunt/oliphaunt-android/$kotlin_version/oliphaunt-android-$kotlin_version.aar" ] ||
      fail "Kotlin SDK Maven artifact did not publish oliphaunt-android"
    [ -f "$kotlin_maven_repo/dev/oliphaunt/oliphaunt-android-gradle-plugin/$kotlin_version/oliphaunt-android-gradle-plugin-$kotlin_version.jar" ] ||
      fail "Kotlin SDK Maven artifact did not publish the Android Gradle plugin"
    mkdir -p "$artifact_root/maven"
    cp -R "$kotlin_maven_repo/." "$artifact_root/maven/"
    ;;
  oliphaunt-js)
    require node
    env OLIPHAUNT_JS_SKIP_REGISTRY_DRY_RUN=1 \
      OLIPHAUNT_SDK_CHECK_SCRATCH="$work_root/check" \
      src/sdks/js/tools/check-sdk.sh package-shape
    package_npm_workspace "$work_root/check/package-shape/src/sdks/js" "$artifact_root"
    stage_jsr_source_workspace "$work_root/check/package-shape/src/sdks/js" "$artifact_root/jsr-source"
    ;;
  oliphaunt-react-native)
    require node
    env OLIPHAUNT_SDK_CHECK_SCRATCH="$work_root/check" \
      src/sdks/react-native/tools/check-sdk.sh package-shape
    package_npm_workspace "$work_root/check/package-shape/src/sdks/react-native" "$artifact_root"
    ;;
  oliphaunt-wasix-rust)
    require cargo
    require python3
    env OLIPHAUNT_WASM_PACKAGE_OUT="$artifact_root" \
      src/bindings/wasix-rust/tools/check-package.sh
    # Cargo cannot verify a root crate that depends on same-release internal
    # crates until the runtime asset/AOT crates have been published. The
    # liboliphaunt-wasix release lane owns and validates those internal crates;
    # this builder stages only the binding crate payload.
    mapfile -t wasix_internal_packages < <(cargo run --quiet -p xtask -- assets internal-packages)
    wasix_packages=("${wasix_internal_packages[@]}" "oliphaunt-wasix")
    package_args=(--workspace --locked --allow-dirty --no-verify)
    while IFS= read -r excluded_package; do
      [ -n "$excluded_package" ] || continue
      package_args+=(--exclude "$excluded_package")
    done < <(cargo_workspace_excludes_except "${wasix_packages[@]}")
    cargo package "${package_args[@]}"
    crate_name="$(rust_crate_name "$root/src/bindings/wasix-rust/crates/oliphaunt-wasix/Cargo.toml")"
    package_dir="$(cargo_package_dir)"
    [ -f "$package_dir/$crate_name" ] || fail "cargo package did not create $package_dir/$crate_name"
    cp "$package_dir/$crate_name" "$artifact_root/$crate_name"
    cp "$root/target/oliphaunt-wasix-rust/package/oliphaunt-wasix.package-files.txt" \
      "$artifact_root/cargo-package-files.txt"
    ;;
  *)
    fail "unsupported SDK product: $product"
    ;;
esac

find "$artifact_root" -mindepth 1 -maxdepth 1 \( -type f -o -type d \) -print | sort >"$artifact_root/artifacts.txt"
[ -s "$artifact_root/artifacts.txt" ] || fail "no SDK artifacts were staged for $product"
python3 tools/release/check_staged_artifacts.py --require-sdk-product "$product"
printf 'Staged %s SDK artifacts under %s\n' "$product" "$artifact_root"
