#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "check-rust-release-consumer.sh: must run inside the Oliphaunt checkout" >&2
  exit 1
}
cd "$root"

fail() {
  echo "check-rust-release-consumer.sh: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

require_directory() {
  [ -n "${2:-}" ] || fail "missing required environment variable $1"
  [ -d "$2" ] || fail "$1 is not a directory: $2"
}

require_file() {
  [ -f "$1" ] || fail "missing required file: $1"
  [ -s "$1" ] || fail "required file is empty: $1"
}

require_executable() {
  require_file "$1"
  [ -x "$1" ] || fail "required executable is not executable: $1"
}

find_exact_artifact() {
  local directory="$1"
  local name="$2"
  local -a matches=()
  while IFS= read -r match; do
    matches+=("$match")
  done < <(find "$directory" -type f -name "$name" -print)
  [ "${#matches[@]}" -eq 1 ] ||
    fail "expected exactly one $name under $directory; found ${#matches[@]}"
  printf '%s\n' "${matches[0]}"
}

safe_extract_tar_gz() {
  local archive="$1"
  local destination="$2"
  local member normalized
  require_file "$archive"
  mkdir -p "$destination"
  while IFS= read -r member; do
    [ -n "$member" ] || fail "archive has an empty member name: $archive"
    if [ "$member" = "." ] || [ "$member" = "./" ]; then
      continue
    fi
    normalized="${member#./}"
    case "$normalized" in
      ""|/*|..|../*|*/..|*/../*|*\\*)
        fail "archive contains an unsafe member $member: $archive"
        ;;
    esac
  done < <(tar -tzf "$archive")
  tar -xzf "$archive" -C "$destination"
}

require_command cargo
require_command cmp
require_command diff
require_command find
require_command rg
require_command tar

[ "$(uname -s)" = "Linux" ] || fail "canonical Rust release consumer must run on Linux"
case "$(uname -m)" in
  x86_64|amd64) ;;
  *) fail "canonical Rust release consumer requires Linux x64; found $(uname -m)" ;;
esac

candidate_sha="${CI_HEAD_SHA:-}"
[[ "$candidate_sha" =~ ^[0-9a-f]{40}$ ]] ||
  fail "CI_HEAD_SHA must be the full immutable candidate commit"
actual_sha="$(git rev-parse HEAD)"
[ "$actual_sha" = "$candidate_sha" ] ||
  fail "checked-out candidate $actual_sha does not match CI_HEAD_SHA $candidate_sha"

sdk_artifact_dir="${OLIPHAUNT_RUST_SDK_ARTIFACT_DIR:-}"
native_asset_dir="${OLIPHAUNT_RUST_NATIVE_ASSET_DIR:-}"
broker_asset_dir="${OLIPHAUNT_RUST_BROKER_ASSET_DIR:-}"
extension_asset_dir="${OLIPHAUNT_RUST_EXTENSION_ASSET_DIR:-}"
require_directory OLIPHAUNT_RUST_SDK_ARTIFACT_DIR "$sdk_artifact_dir"
require_directory OLIPHAUNT_RUST_NATIVE_ASSET_DIR "$native_asset_dir"
require_directory OLIPHAUNT_RUST_BROKER_ASSET_DIR "$broker_asset_dir"
require_directory OLIPHAUNT_RUST_EXTENSION_ASSET_DIR "$extension_asset_dir"

rust_version="$(tools/dev/bun.sh tools/release/product-version.mjs version oliphaunt-rust)"
native_version="$(tools/dev/bun.sh tools/release/product-version.mjs version liboliphaunt-native)"
broker_version="$(tools/dev/bun.sh tools/release/product-version.mjs version oliphaunt-broker)"

rust_crate="$sdk_artifact_dir/oliphaunt-$rust_version.crate"
build_crate="$sdk_artifact_dir/oliphaunt-build-$rust_version.crate"
package_listing="$sdk_artifact_dir/cargo-package-files.txt"
native_archive="$native_asset_dir/liboliphaunt-$native_version-linux-x64-gnu.tar.gz"
tools_archive="$native_asset_dir/oliphaunt-tools-$native_version-linux-x64-gnu.tar.gz"
broker_archive="$broker_asset_dir/oliphaunt-broker-$broker_version-linux-x64-gnu.tar.gz"
vector_archive="$(find_exact_artifact \
  "$extension_asset_dir" \
  "liboliphaunt-$native_version-extension-vector-linux-x64-gnu-runtime.tar.gz")"

for artifact in \
  "$rust_crate" \
  "$build_crate" \
  "$package_listing" \
  "$native_archive" \
  "$tools_archive" \
  "$broker_archive" \
  "$vector_archive"; do
  require_file "$artifact"
done

scratch="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-rust-release-consumer.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT

# The public Rust crate has an all-supported-target dependency graph. A bounded
# Linux proof cannot resolve unpublished packages for every other target, so
# prove its exact envelope and source bytes separately, then execute those same
# source bytes through a checkout path dependency with exact Linux artifacts.
safe_extract_tar_gz "$rust_crate" "$scratch/rust-envelope"
safe_extract_tar_gz "$build_crate" "$scratch/build-envelope"
rust_envelope="$scratch/rust-envelope/oliphaunt-$rust_version"
build_envelope="$scratch/build-envelope/oliphaunt-build-$rust_version"
require_file "$rust_envelope/Cargo.toml"
require_file "$rust_envelope/src/lib.rs"
require_file "$build_envelope/Cargo.toml"
require_file "$build_envelope/src/lib.rs"

rg -q '^name = "oliphaunt"$' "$rust_envelope/Cargo.toml" || fail "Rust crate envelope has the wrong package name"
rg -q "^version = \"$rust_version\"$" "$rust_envelope/Cargo.toml" || fail "Rust crate envelope has the wrong version"
for public_crate in "$rust_crate" "$build_crate"; do
  OLIPHAUNT_CARGO_CRATE="$public_crate" tools/dev/bun.sh -e '
    const { cargoPublishMetadataFromCrate } = await import("./tools/release/frozen-cargo-publish.mjs");
    cargoPublishMetadataFromCrate(process.env.OLIPHAUNT_CARGO_CRATE);
  ' || fail "${public_crate##*/} contains non-registry dependency source metadata"
done
for dependency in \
  "liboliphaunt-native-linux-x64-gnu" \
  "oliphaunt-tools" \
  "oliphaunt-broker-linux-x64-gnu"; do
  rg -Fq "$dependency" "$rust_envelope/Cargo.toml" || fail "Rust crate envelope is missing $dependency"
done

diff -qr --exclude lib.rs "$root/src/sdks/rust/src" "$rust_envelope/src" >/dev/null ||
  fail "packed Rust SDK source differs from the exact checkout outside the generated target guard"
local_lib_bytes="$(wc -c < "$root/src/sdks/rust/src/lib.rs" | tr -d '[:space:]')"
head -c "$local_lib_bytes" "$rust_envelope/src/lib.rs" | cmp - "$root/src/sdks/rust/src/lib.rs" ||
  fail "packed Rust SDK lib.rs is not derived from the exact checkout"
rg -Fq '// Generated release-only native target guard.' "$rust_envelope/src/lib.rs" ||
  fail "packed Rust SDK is missing the generated unsupported-target guard"
cmp "$root/src/sdks/rust/build.rs" "$rust_envelope/build.rs" ||
  fail "packed Rust SDK build.rs differs from the exact checkout"
cmp "$root/src/sdks/rust/crates/oliphaunt-build/src/lib.rs" "$build_envelope/src/lib.rs" ||
  fail "packed oliphaunt-build source differs from the exact checkout"
echo "OLIPHAUNT_RUST_RELEASE_CONSUMER_STAGE_PASS stage=package-envelope"

safe_extract_tar_gz "$native_archive" "$scratch/native"
safe_extract_tar_gz "$tools_archive" "$scratch/tools"
safe_extract_tar_gz "$broker_archive" "$scratch/broker"
safe_extract_tar_gz "$vector_archive" "$scratch/vector-artifact"

library="$scratch/native/lib/liboliphaunt.so"
install_dir="$scratch/native/runtime"
tools_dir="$scratch/tools/runtime"
broker="$scratch/broker/bin/oliphaunt-broker"
postgres="$install_dir/bin/postgres"
initdb="$install_dir/bin/initdb"
embedded_modules="$scratch/native/lib/modules"
vector_manifest="$scratch/vector-artifact/manifest.properties"
vector_files="$scratch/vector-artifact/files"

require_file "$library"
require_directory native-runtime "$install_dir"
require_directory native-tools "$tools_dir"
require_directory embedded-modules "$embedded_modules"
require_executable "$broker"
require_executable "$postgres"
require_executable "$initdb"
require_executable "$tools_dir/bin/pg_dump"
require_executable "$tools_dir/bin/psql"
require_file "$embedded_modules/plpgsql.so"
require_file "$vector_manifest"
require_directory vector-files "$vector_files"
for property in \
  'packageLayout=oliphaunt-extension-artifact-v1' \
  'sqlName=vector' \
  'nativeTarget=linux-x64-gnu' \
  'nativeRuntimeProduct=liboliphaunt-native' \
  "nativeRuntimeVersion=$native_version"; do
  rg -Fxq "$property" "$vector_manifest" || fail "vector artifact manifest is missing $property"
done
require_file "$vector_files/lib/postgresql/vector.so"
require_file "$vector_files/share/postgresql/extension/vector.control"

resources="$scratch/resources"
mkdir -p "$resources/extension/oliphaunt-extension-vector"
cp -R "$vector_files/." "$resources/extension/oliphaunt-extension-vector/"
consumer_work="$scratch/runtime-proof"
mkdir -p "$consumer_work" "$scratch/runtime-cache" "$scratch/cargo-target"

echo "==> Rust package envelope verified; running exact-byte Linux runtime API proof"
env \
  LIBOLIPHAUNT_PATH="$library" \
  OLIPHAUNT_INSTALL_DIR="$install_dir" \
  OLIPHAUNT_TOOLS_DIR="$tools_dir" \
  OLIPHAUNT_POSTGRES="$postgres" \
  OLIPHAUNT_INITDB="$initdb" \
  OLIPHAUNT_EMBEDDED_MODULE_DIR="$embedded_modules" \
  OLIPHAUNT_RESOURCES_DIR="$resources" \
  OLIPHAUNT_RUNTIME_CACHE_DIR="$scratch/runtime-cache" \
  OLIPHAUNT_BROKER="$broker" \
  OLIPHAUNT_RUST_RELEASE_CONSUMER_WORK_DIR="$consumer_work" \
  LD_LIBRARY_PATH="$install_dir/lib:$scratch/native/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
  CARGO_TARGET_DIR="$scratch/cargo-target" \
  cargo run --locked --manifest-path src/sdks/rust/tests/release-consumer/Cargo.toml
