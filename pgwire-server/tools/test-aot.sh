#!/usr/bin/env bash
set -euo pipefail
cd "$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
host="$(rustc -vV | awk '/^host:/{print $2}')"
target="${AOT_TARGET:-$host}"
if [ "$host" != "$target" ]; then
  echo "AOT server execution requires host $host to match target $target" >&2
  exit 1
fi
proof_root="$PWD/target/pgwire-server-aot-smoke"
OLIPHAUNT_WASIX_GENERATED_ASSET_ROOT="$PWD/target/extensions/wasix/assets" \
OLIPHAUNT_WASIX_EXTENSION_AOT_ARTIFACT_ROOT="$PWD/target/extensions/wasix/aot-artifacts" \
  bash tools/dev/bun.sh extensions/artifacts/packages/tools/build-extension-ci-artifacts.mts \
    --output-root "$proof_root/extension-artifacts" --family wasix --require-wasix \
    oliphaunt-extension-contrib-pg18
OLIPHAUNT_WASM_AOT_VERIFY=full \
OLIPHAUNT_WASIX_EXTENSION_ARTIFACT_ROOT="$proof_root/extension-artifacts" \
  cargo test -p oliphaunt-pgwire-server --locked --features extension-uuid-ossp \
    --test extensions uuid_ossp_aot_server_smoke -- --ignored --exact --nocapture
