#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "check-release-consumer.sh: must run inside the Oliphaunt checkout" >&2
  exit 1
}
cd "$root"

scratch=""
cleanup() {
  [ -z "$scratch" ] || rm -rf "$scratch"
}
trap cleanup EXIT

fail() {
  echo "check-release-consumer.sh: $*" >&2
  exit 1
}

require_file() {
  [ -s "$1" ] || fail "missing or empty file: $1"
}

find_one() {
  local directory="$1"
  local pattern="$2"
  local matches=()
  while IFS= read -r file; do
    matches+=("$file")
  done < <(find "$directory" -type f -name "$pattern" -print)
  [ "${#matches[@]}" -eq 1 ] ||
    fail "expected one $pattern under $directory, found ${#matches[@]}"
  printf '%s\n' "${matches[0]}"
}

require_linux_x64() {
  [ "$(uname -s)" = "Linux" ] || fail "release consumer requires Linux"
  case "$(uname -m)" in
    x86_64|amd64) ;;
    *) fail "release consumer requires x64, found $(uname -m)" ;;
  esac
}

build_consumer() {
  local sdk_artifacts="$1"
  local output="$2"
  local crate dependency_crate product packed_manifest
  local dependency_args=()
  [ -d "$sdk_artifacts" ] || fail "Rust SDK artifact directory is missing: $sdk_artifacts"
  crate="$(find_one "$sdk_artifacts" 'oliphaunt-[0-9]*.crate')"
  scratch="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-rust-release-consumer-build.XXXXXX")"

  for product in oliphaunt-query liboliphaunt-native-bindings oliphaunt-broker oliphaunt-build; do
    local artifact_dir="target/sdk-artifacts/$product"
    [ "$product" != oliphaunt-build ] || artifact_dir="$sdk_artifacts"
    dependency_crate="$(find_one "$artifact_dir" "$product-*.crate")"
    dependency_args+=(--dependency-crate "$dependency_crate")
  done

  packed_manifest="$(
    tools/dev/bun.sh tools/packaging/cargo-package-test-closure.mts "$scratch" \
      --crate "$crate" "${dependency_args[@]}" \
      --stub-dependency-prefix liboliphaunt-native- \
      --stub-dependency-prefix oliphaunt-broker-
  )"
  mkdir -p "$scratch/packed" "$scratch/consumer/src"
  mv "$(dirname "$packed_manifest")" "$scratch/packed/oliphaunt"
  cp src/native/sdks/rust/tests/release-consumer/Cargo.toml "$scratch/consumer/Cargo.toml"
  cp src/native/sdks/rust/tests/release-consumer/src/main.rs "$scratch/consumer/src/main.rs"

  CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$scratch/target}" \
    cargo --config "$scratch/.cargo/config.toml" --config net.offline=false fetch \
      --manifest-path "$scratch/consumer/Cargo.toml"
  CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$scratch/target}" \
    cargo --config "$scratch/.cargo/config.toml" metadata \
      --manifest-path "$scratch/consumer/Cargo.toml" --locked --offline --format-version 1 > /dev/null
  CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$scratch/target}" \
    cargo --config "$scratch/.cargo/config.toml" build \
      --manifest-path "$scratch/consumer/Cargo.toml" --locked --offline --release
  mkdir -p "$(dirname "$output")"
  install -m 0755 \
    "${CARGO_TARGET_DIR:-$scratch/target}/release/oliphaunt-rust-release-consumer" "$output"
  echo "Built packed-crate Rust release consumer: $output"
}

run_candidate_override() {
  local consumer="$1"
  local native_assets="$2"
  local tools_assets="$3"
  local broker_assets="$4"
  local runtime_archive tools_archive broker_archive install_dir tools_dir native_dir
  require_linux_x64
  require_file "$consumer"
  [ -x "$consumer" ] || fail "release consumer is not executable: $consumer"
  # The installed-pinned phase built this executable from the SDK's declared
  # package closure. This phase may replace runtime resources, never Cargo deps.
  [ -d "$native_assets" ] || fail "native asset directory is missing: $native_assets"
  runtime_archive="$(find_one "$native_assets" 'liboliphaunt-*-linux-x64-gnu.tar.gz')"
  tools_archive="$(find_one "$tools_assets" 'oliphaunt-tools-*-linux-x64-gnu.tar.gz')"
  broker_archive="$(find_one "$broker_assets" 'oliphaunt-broker-*-linux-x64-gnu.tar.gz')"
  scratch="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-rust-release-consumer-run.XXXXXX")"

  native_dir="$scratch/resources/native-runtime/liboliphaunt-native"
  mkdir -p "$native_dir" "$scratch/tools" "$scratch/broker" "$scratch/runtime-cache"
  tar -xzf "$runtime_archive" -C "$native_dir"
  tar -xzf "$tools_archive" -C "$scratch/tools"
  tar -xzf "$broker_archive" -C "$scratch/broker"
  install_dir="$native_dir/runtime"
  tools_dir="$scratch/tools/runtime"
  for file in "$native_dir/lib/liboliphaunt.so" "$scratch/broker/bin/oliphaunt-broker" "$install_dir/bin/postgres" "$install_dir/bin/initdb" "$install_dir/bin/pg_ctl" \
    "$tools_dir/bin/pg_basebackup" "$tools_dir/bin/pg_dump" "$tools_dir/bin/psql"; do
    require_file "$file"
  done

  env \
    -u LIBOLIPHAUNT_PATH -u OLIPHAUNT_RESOURCES_DIR \
    OLIPHAUNT_CONSUMER_RESOURCES_DIR="$scratch/resources" \
    OLIPHAUNT_EMBEDDED_MODULE_DIR="$native_dir/lib/modules" \
    OLIPHAUNT_BROKER="$scratch/broker/bin/oliphaunt-broker" \
    OLIPHAUNT_INSTALL_DIR="$install_dir" \
    OLIPHAUNT_TOOLS_DIR="$tools_dir" \
    OLIPHAUNT_RUNTIME_CACHE_DIR="$scratch/runtime-cache" \
    LD_LIBRARY_PATH="$install_dir/lib:$native_dir/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
    "$consumer" "$scratch/database"
}

case "${1:-}" in
  build)
    [ "$#" -eq 3 ] || fail "usage: $0 build SDK_ARTIFACT_DIR OUTPUT"
    build_consumer "$2" "$3"
    ;;
  candidate-override)
    [ "$#" -eq 5 ] || fail "usage: $0 candidate-override CONSUMER NATIVE_ASSET_DIR TOOLS_ASSET_DIR BROKER_ASSET_DIR"
    run_candidate_override "$2" "$3" "$4" "$5"
    ;;
  *) fail "usage: $0 {build SDK_ARTIFACT_DIR OUTPUT|candidate-override CONSUMER NATIVE_ASSET_DIR TOOLS_ASSET_DIR BROKER_ASSET_DIR}" ;;
esac
