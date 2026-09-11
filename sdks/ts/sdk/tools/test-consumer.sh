#!/usr/bin/env bash
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
cd "$root"
[[ "$(uname -s):$(uname -m)" == Linux:x86_64 ]] || {
  echo 'the packed SDK consumer uses Linux x64 artifacts; run test-native for host source behavior' >&2
  exit 2
}
consumer="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-ts-consumer.XXXXXX")"
trap 'rm -rf "$consumer"' EXIT HUP INT TERM
bun sdks/ts/sdk/tools/prepare-consumer.mts "$consumer"
bun install --cwd "$consumer" --ignore-scripts --omit optional
export OLIPHAUNT_SMOKE_SDK="$consumer/node_modules/@oliphaunt/ts/lib/index.js"
export LIBOLIPHAUNT_PATH="$consumer/runtime/lib/liboliphaunt.so"
export OLIPHAUNT_INSTALL_DIR="$consumer/runtime/runtime"
export OLIPHAUNT_BROKER="$consumer/broker/bin/oliphaunt-broker"
export OLIPHAUNT_NODE_ADDON="$consumer/addon/oliphaunt_node.node"
export OLIPHAUNT_RUNTIME_DIR="$OLIPHAUNT_INSTALL_DIR"
bash sdks/ts/sdk/tools/test-native.sh
