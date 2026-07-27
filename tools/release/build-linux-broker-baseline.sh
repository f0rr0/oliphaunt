#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "build-linux-broker-baseline.sh: must run inside the Oliphaunt git checkout" >&2
  exit 1
}

fail() {
  echo "build-linux-broker-baseline.sh: $*" >&2
  exit 1
}

require() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

if [ "$#" -ne 1 ]; then
  fail "usage: tools/release/build-linux-broker-baseline.sh TARGET_DIR"
fi
if [ "$(uname -s)" != "Linux" ]; then
  fail "the Linux broker baseline build must run on Linux"
fi

case "$(uname -m)" in
  x86_64|amd64) rust_host="x86_64-unknown-linux-gnu" ;;
  aarch64|arm64) rust_host="aarch64-unknown-linux-gnu" ;;
  *) fail "unsupported Linux architecture $(uname -m)" ;;
esac

# Official rust:1.93.1-slim-bookworm, pinned as one multi-architecture OCI index.
# Debian Bookworm links the broker below the repository-wide glibc 2.38 ceiling
# while retaining the normal linux-*-gnu carrier ABI and the exact workspace
# Rust release. Never replace this with a moving tag.
readonly image="rust@sha256:5b9332190bb3b9ece73b810cd1f1e9f06343b294ce184bcb067f0747d7d333ea"
readonly rust_release="1.93.1"
readonly rust_commit="01f6ddf7588f42ae2d7eb0a2f21d44e8e96674cf"
readonly rust_toolchain="${rust_release}-${rust_host}"

target_dir="$1"
case "$target_dir" in
  /*) ;;
  *) target_dir="$root/$target_dir" ;;
esac
case "$target_dir" in
  "$root/target"/*) ;;
  *) fail "TARGET_DIR must be below $root/target" ;;
esac

cargo_root="${CARGO_HOME:-$HOME/.cargo}"
registry_dir="$cargo_root/registry"
mkdir -p "$registry_dir"
registry_dir="$(cd "$registry_dir" && pwd -P)"

# Never reuse an object linked on the ambient runner: Cargo freshness alone
# cannot distinguish the runner's glibc symbol bindings from the baseline's.
rm -rf "$target_dir"
mkdir -p "$target_dir"
target_dir="$(cd "$target_dir" && pwd -P)"

require docker
require grep
require timeout

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
  [ "$pulled" -eq 1 ] || fail "could not pull pinned broker build image after 3 attempts"
fi

repo_digests="$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$image")"
if ! grep -Fxq "docker.io/library/$image" <<<"$repo_digests" \
  && ! grep -Fxq "$image" <<<"$repo_digests"; then
  fail "local broker build image does not report the required pinned digest"
fi

docker_cargo() {
  local network="$1"
  shift
  # The single-quoted script is evaluated inside the pinned container.
  # shellcheck disable=SC2016
  timeout 900 docker run \
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
      [ "$actual_release" = "$EXPECTED_RUST_RELEASE" ]
      [ "$actual_commit" = "$EXPECTED_RUST_COMMIT" ]
      [ "$actual_host" = "$EXPECTED_RUST_HOST" ]
      exec "$@"
    ' sh "$@"
}

# The exact locked dependency cache is filled in a non-executing Cargo phase.
# Package code and build scripts execute only in the subsequent networkless
# build. Usually setup-rust has already restored every required registry entry,
# so the first offline fetch avoids a registry round trip entirely.
if ! CARGO_NET_OFFLINE=true docker_cargo none cargo fetch --locked --offline; then
  echo "build-linux-broker-baseline.sh: locked Cargo cache incomplete; fetching before the sealed build" >&2
  CARGO_NET_OFFLINE=false CARGO_HTTP_TIMEOUT=30 CARGO_NET_RETRY=3 \
    docker_cargo bridge cargo fetch --locked
  CARGO_NET_OFFLINE=true docker_cargo none cargo fetch --locked --offline
fi

CARGO_NET_OFFLINE=true docker_cargo none \
  cargo build -p oliphaunt-broker --release --locked --offline

broker="$target_dir/release/oliphaunt-broker"
[ -x "$broker" ] || fail "sealed build did not produce $broker"

# Execute enough of the real helper to distinguish a successful dynamic load
# and argument parse from an ld.so failure. Exit 2 is the broker's intentional
# response to the private probe argument.
# shellcheck disable=SC2016
docker_cargo none sh -euc '
  set +e
  output="$(/output/release/oliphaunt-broker --oliphaunt-linux-abi-probe 2>&1)"
  code=$?
  set -e
  [ "$code" -eq 2 ]
  [ "$output" = "OLIPHAUNT_BROKER_ERROR unknown broker argument '\''--oliphaunt-linux-abi-probe'\''" ]
' sh

echo "linux broker baseline build passed: host=$rust_host image=$image output=$broker"
