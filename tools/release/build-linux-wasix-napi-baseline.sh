#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "build-linux-wasix-napi-baseline.sh: must run inside the Oliphaunt git checkout" >&2
  exit 1
}

fail() {
  echo "build-linux-wasix-napi-baseline.sh: $*" >&2
  exit 1
}

require() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

if [ "$#" -ne 3 ]; then
  fail "usage: tools/release/build-linux-wasix-napi-baseline.sh TARGET_DIR TARGET_TRIPLE FEATURES"
fi
if [ "$(uname -s)" != "Linux" ]; then
  fail "the Linux WASIX Node-API baseline build must run on Linux"
fi
require docker
require grep
require realpath
require timeout

case "$(uname -m)" in
  x86_64|amd64) rust_host="x86_64-unknown-linux-gnu" ;;
  aarch64|arm64) rust_host="aarch64-unknown-linux-gnu" ;;
  *) fail "unsupported Linux architecture $(uname -m)" ;;
esac

target_dir="$1"
target_triple="$2"
features="$3"
[ "$target_triple" = "$rust_host" ] || fail "target $target_triple does not match native host $rust_host"
[ "$features" = "release" ] || fail "unsupported WASIX Node-API feature set: $features"

# Official rust:1.93.1-slim-bookworm, pinned as one multi-architecture OCI
# index. Bookworm's glibc 2.36 is below the published glibc 2.38 ceiling. The
# Fedora 39 consumer rehearsal still checks the completed addon under 2.38.
readonly image="rust@sha256:5b9332190bb3b9ece73b810cd1f1e9f06343b294ce184bcb067f0747d7d333ea"
readonly rust_release="1.93.1"
readonly rust_commit="01f6ddf7588f42ae2d7eb0a2f21d44e8e96674cf"
readonly rust_toolchain="${rust_release}-${rust_host}"
readonly expected_builder_glibc="glibc 2.36"
readonly manifest="/workspace/src/runtimes/wasix-napi/Cargo.toml"

case "$target_dir" in
  /*) ;;
  *) target_dir="$root/$target_dir" ;;
esac
target_dir="$(realpath -m "$target_dir")"
case "$target_dir" in
  "$root/target"/*) ;;
  *) fail "TARGET_DIR must be below $root/target" ;;
esac

workspace_path() {
  local variable="$1"
  local host_path="${!variable:-}"
  [ -n "$host_path" ] || fail "$variable is required"
  case "$host_path" in
    /*) ;;
    *) host_path="$root/$host_path" ;;
  esac
  [ -e "$host_path" ] || fail "$variable path does not exist: $host_path"
  host_path="$(realpath "$host_path")"
  case "$host_path" in
    "$root"/*) ;;
    *) fail "$variable must resolve below $root" ;;
  esac
  printf '/workspace/%s' "${host_path#"$root/"}"
}

generated_assets="$(workspace_path OLIPHAUNT_WASIX_GENERATED_ASSETS_DIR)"
generated_aot="$(workspace_path OLIPHAUNT_WASM_GENERATED_AOT_DIR)"
extension_artifacts="$(workspace_path OLIPHAUNT_WASIX_EXTENSION_ARTIFACT_ROOT)"
icu_data="$(workspace_path OLIPHAUNT_ICU_DATA_DIR)"
build_inputs="$(workspace_path OLIPHAUNT_WASIX_NAPI_BUILD_INPUTS)"

cargo_root="${CARGO_HOME:-$HOME/.cargo}"
registry_dir="$cargo_root/registry"
mkdir -p "$registry_dir"
registry_dir="$(cd "$registry_dir" && pwd -P)"

# Never reuse an object linked on the ambient runner: Cargo freshness cannot
# distinguish its glibc symbol bindings from the pinned baseline's.
rm -rf "$target_dir"
mkdir -p "$target_dir"
target_dir="$(cd "$target_dir" && pwd -P)"

image_is_present() {
  docker image inspect "$image" >/dev/null 2>&1
}

if ! image_is_present; then
  pulled=0
  for attempt in 1 2 3; do
    if timeout 180 docker pull "$image"; then
      pulled=1
      break
    fi
    if [ "$attempt" -lt 3 ]; then
      sleep "$attempt"
    fi
  done
  [ "$pulled" -eq 1 ] || fail "could not pull pinned WASIX Node-API build image after 3 attempts"
fi

repo_digests="$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$image")"
if ! grep -Fxq "docker.io/library/$image" <<<"$repo_digests" \
  && ! grep -Fxq "$image" <<<"$repo_digests"; then
  fail "local WASIX Node-API build image does not report the required pinned digest"
fi

docker_cargo() {
  local network="$1"
  shift
  # The single-quoted script is evaluated inside the pinned container.
  # shellcheck disable=SC2016
  timeout 3600 docker run \
    --rm \
    --pull never \
    --network "$network" \
    --read-only \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    --user "$(id -u):$(id -g)" \
    --tmpfs /tmp:rw,nosuid,nodev \
    --env HOME=/tmp \
    --env CARGO_HOME=/tmp/cargo \
    --env CARGO_TARGET_DIR=/output \
    --env "CARGO_NET_OFFLINE=${CARGO_NET_OFFLINE:-false}" \
    --env "CARGO_HTTP_TIMEOUT=${CARGO_HTTP_TIMEOUT:-30}" \
    --env "CARGO_NET_RETRY=${CARGO_NET_RETRY:-3}" \
    --env CARGO_INCREMENTAL=0 \
    --env CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1 \
    --env CARGO_PROFILE_RELEASE_LTO=thin \
    --env CARGO_PROFILE_RELEASE_STRIP=symbols \
    --env OLIPHAUNT_ARTIFACT_CRATE_REQUIRE_PAYLOAD=1 \
    --env "OLIPHAUNT_WASIX_GENERATED_ASSETS_DIR=$generated_assets" \
    --env "OLIPHAUNT_WASM_GENERATED_AOT_DIR=$generated_aot" \
    --env "OLIPHAUNT_WASIX_EXTENSION_ARTIFACT_ROOT=$extension_artifacts" \
    --env "OLIPHAUNT_ICU_DATA_DIR=$icu_data" \
    --env "OLIPHAUNT_WASIX_NAPI_BUILD_INPUTS=$build_inputs" \
    --env "EXPECTED_BUILDER_GLIBC=$expected_builder_glibc" \
    --env "EXPECTED_RUST_RELEASE=$rust_release" \
    --env "EXPECTED_RUST_COMMIT=$rust_commit" \
    --env "EXPECTED_RUST_HOST=$rust_host" \
    --env "RUSTUP_TOOLCHAIN=$rust_toolchain" \
    --volume "$root:/workspace:ro" \
    --volume "$registry_dir:/cargo-registry" \
    --volume "$target_dir:/output" \
    --workdir /workspace \
    "$image" \
    sh -euc '
      mkdir -p "$CARGO_HOME"
      ln -s /cargo-registry "$CARGO_HOME/registry"
      actual_release="$(rustc --version --verbose | sed -n "s/^release: //p")"
      actual_commit="$(rustc --version --verbose | sed -n "s/^commit-hash: //p")"
      actual_host="$(rustc --version --verbose | sed -n "s/^host: //p")"
      actual_glibc="$(getconf GNU_LIBC_VERSION)"
      [ "$actual_release" = "$EXPECTED_RUST_RELEASE" ]
      [ "$actual_commit" = "$EXPECTED_RUST_COMMIT" ]
      [ "$actual_host" = "$EXPECTED_RUST_HOST" ]
      [ "$actual_glibc" = "$EXPECTED_BUILDER_GLIBC" ]
      exec "$@"
    ' sh "$@"
}

# Fill only the exact locked dependency cache in the networked phase. Package
# code and build scripts execute solely in the subsequent networkless phase.
fetch_args=(cargo fetch --locked --manifest-path "$manifest" --target "$target_triple")
if ! CARGO_NET_OFFLINE=true docker_cargo none "${fetch_args[@]}" --offline; then
  echo "build-linux-wasix-napi-baseline.sh: locked Cargo cache incomplete; fetching before the sealed build" >&2
  CARGO_NET_OFFLINE=false CARGO_HTTP_TIMEOUT=30 CARGO_NET_RETRY=3 \
    docker_cargo bridge "${fetch_args[@]}"
  CARGO_NET_OFFLINE=true docker_cargo none "${fetch_args[@]}" --offline
fi

CARGO_NET_OFFLINE=true docker_cargo none \
  cargo build \
    --locked \
    --offline \
    --manifest-path "$manifest" \
    --target "$target_triple" \
    --release \
    --no-default-features \
    --features "$features"

library="$target_dir/$target_triple/release/liboliphaunt_wasix_napi.so"
[ -f "$library" ] || fail "sealed build did not produce $library"

echo "linux WASIX Node-API baseline build passed: host=$rust_host image=$image glibc=$expected_builder_glibc output=$library"
