#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
[ "$(uname -s)" = Linux ] || { echo 'Linux baseline command checks require Linux'; exit 0; }
root="$PWD"
mkdir -p target
scratch="$(mktemp -d "$root/target/linux-baseline-test-XXXXXX")"
outside="$(mktemp -d)"
trap 'rm -rf "$scratch" "$outside"' EXIT
mkdir -p "$scratch/bin" "$scratch/consumer"
printf 'preserve\n' > "$outside/sentinel"
case "$(uname -m)" in
  x86_64|amd64) rust_host=x86_64-unknown-linux-gnu; target=linux-x64-gnu ;;
  aarch64|arm64) rust_host=aarch64-unknown-linux-gnu; target=linux-arm64-gnu ;;
  *) echo 'Unsupported test host' >&2; exit 1 ;;
esac
cat > "$scratch/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "${1:-}" = image ] && [ "${2:-}" = inspect ]; then
  printf '%s\n' "${FAKE_IMAGE_DIGEST:-${!#}}"
elif [ "${1:-}" = run ]; then
  case "$*" in
    *'cargo build -p oliphaunt-broker'*)
      mkdir -p "$FAKE_TARGET_DIR/release"
      printf '#!/bin/sh\nexit 0\n' > "$FAKE_TARGET_DIR/release/oliphaunt-broker"
      chmod 755 "$FAKE_TARGET_DIR/release/oliphaunt-broker" ;;
    *'cargo build --locked --offline --manifest-path /workspace/sdks/ts-wasix/node-addon/Cargo.toml'*)
      mkdir -p "$FAKE_TARGET_DIR/$FAKE_RUST_HOST/release"
      printf 'fixture\n' > "$FAKE_TARGET_DIR/$FAKE_RUST_HOST/release/liboliphaunt_wasix_napi.so" ;;
  esac
else exit 1
fi
DOCKER
chmod 755 "$scratch/bin/docker"
export PATH="$scratch/bin:$PATH" CARGO_HOME="$scratch/cargo-home"
export FAKE_DOCKER_LOG="$scratch/docker.log" FAKE_TARGET_DIR="$scratch/output" FAKE_RUST_HOST="$rust_host"
export OLIPHAUNT_WASIX_GENERATED_ASSETS_DIR="$scratch/inputs/portable"
export OLIPHAUNT_WASM_GENERATED_AOT_DIR="$scratch/inputs/aot"
export OLIPHAUNT_WASIX_EXTENSION_ARTIFACT_ROOT="$scratch/inputs/extensions"
export OLIPHAUNT_WASIX_NAPI_BUILD_INPUTS="$scratch/inputs/build-inputs.json"
mkdir -p "$OLIPHAUNT_WASIX_GENERATED_ASSETS_DIR" "$OLIPHAUNT_WASM_GENERATED_AOT_DIR" "$OLIPHAUNT_WASIX_EXTENSION_ARTIFACT_ROOT"
printf '{}\n' > "$OLIPHAUNT_WASIX_NAPI_BUILD_INPUTS"

assert_isolated() {
  local flag
  for flag in '--pull never' '--network none' '--read-only' '--cap-drop ALL' '--security-opt no-new-privileges'; do
    grep -Fq -- "$flag" "$FAKE_DOCKER_LOG"
  done
  ! grep -Eq 'docker\.sock|credentials|config\.json' "$FAKE_DOCKER_LOG"
}
broker=broker/tools/build-linux-broker-baseline.sh
wasix=sdks/ts-wasix/node-addon/tools/build-linux-wasix-napi-baseline.sh
consumer=tools/packaging/check-linux-consumer-baseline.sh
bash "$broker" "$FAKE_TARGET_DIR"
assert_isolated
grep -Fq -- "$root:/workspace:ro" "$FAKE_DOCKER_LOG"
grep -Fq 'CARGO_NET_OFFLINE=true' "$FAKE_DOCKER_LOG"
grep -Fq 'OLIPHAUNT_BROKER_AUTH_TOKEN=abi-probe' "$FAKE_DOCKER_LOG"
: > "$FAKE_DOCKER_LOG"
bash "$wasix" "$FAKE_TARGET_DIR" "$rust_host" release
assert_isolated
grep -Fq 'OLIPHAUNT_WASIX_GENERATED_ASSETS_DIR=/workspace/target/' "$FAKE_DOCKER_LOG"
grep -Fq 'OLIPHAUNT_WASIX_NAPI_BUILD_INPUTS=/workspace/target/' "$FAKE_DOCKER_LOG"
grep -Fq 'cargo build --locked --offline' "$FAKE_DOCKER_LOG"
grep -Fq -- '--features release' "$FAKE_DOCKER_LOG"
: > "$FAKE_DOCKER_LOG"
bash "$consumer" --target "$target" --root "$scratch/consumer"
assert_isolated
grep -Fq -- "$scratch/consumer:/consumer:ro" "$FAKE_DOCKER_LOG"

reject() {
  if "$@" > "$scratch/rejection" 2>&1; then
    echo "Unexpectedly accepted: $*" >&2; exit 1
  fi
}
outside_relative="$(realpath --relative-to="$root/target" "$outside")"
for path in "$outside" "$root/target/$outside_relative"; do
  reject bash "$broker" "$path"
  grep -Fq 'must be below' "$scratch/rejection"
  reject bash "$wasix" "$path" "$rust_host" release
  grep -Fq 'must be below' "$scratch/rejection"
done
ln -s "$outside" "$scratch/escaped"
reject bash "$broker" "$scratch/escaped"
grep -Fq 'must be below' "$scratch/rejection"
reject bash "$consumer" --target "$target" --root "$scratch/escaped"
grep -Fq 'must be below' "$scratch/rejection"
test "$(cat "$outside/sentinel")" = preserve
reject env FAKE_IMAGE_DIGEST=wrong-image bash "$broker" "$FAKE_TARGET_DIR"
grep -Fq 'required pinned digest' "$scratch/rejection"
echo 'Linux baseline isolation, pin rejection and outside-path preservation passed'
