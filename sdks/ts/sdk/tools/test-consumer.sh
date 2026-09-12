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
bun sdks/ts/sdk/tools/prepare-consumer.mts "$consumer" "${1:-}"
if [[ "${1:-}" == --published-dependencies ]]; then
  clean=(env -i)
  while IFS= read -r -d '' entry; do clean+=("$entry"); done < "$consumer/install-environment"
  "${clean[@]}" bun install --cwd "$consumer" --ignore-scripts --omit optional --registry https://registry.npmjs.org --cache-dir "$consumer/cache"
else
  bun install --cwd "$consumer" --ignore-scripts --omit optional
fi
export OLIPHAUNT_SMOKE_SDK="$consumer/node_modules/@oliphaunt/ts/lib/index.js"
if [[ "${1:-}" == --published-dependencies ]]; then
  bun sdks/ts/sdk/tools/published-consumer.mts "$consumer"
  export LIBOLIPHAUNT_PATH="$consumer/node_modules/@oliphaunt/liboliphaunt-linux-x64-gnu/lib/liboliphaunt.so"
  export OLIPHAUNT_INSTALL_DIR="$consumer/node_modules/@oliphaunt/liboliphaunt-linux-x64-gnu/runtime"
  export OLIPHAUNT_BROKER="$consumer/node_modules/@oliphaunt/broker-linux-x64-gnu/bin/oliphaunt-broker"
  export OLIPHAUNT_NODE_ADDON="$consumer/node_modules/@oliphaunt/node-direct-linux-x64-gnu/prebuilds/oliphaunt_node.node"
else
export LIBOLIPHAUNT_PATH="$consumer/runtime/lib/liboliphaunt.so"
export OLIPHAUNT_INSTALL_DIR="$consumer/runtime/runtime"
export OLIPHAUNT_BROKER="$consumer/broker/bin/oliphaunt-broker"
export OLIPHAUNT_NODE_ADDON="$consumer/addon/oliphaunt_node.node"
fi
export OLIPHAUNT_RUNTIME_DIR="$OLIPHAUNT_INSTALL_DIR"
bash sdks/ts/sdk/tools/test-native.sh
