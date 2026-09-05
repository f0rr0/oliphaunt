#!/usr/bin/env sh
set -eu

root="$(git rev-parse --show-toplevel)"
cd "$root"

. src/runtimes/liboliphaunt/native/tools/runtime-preflight.sh
oliphaunt_runtime_native_host_export_defaults
oliphaunt_runtime_native_host_require basic

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) broker_name="oliphaunt-broker.exe" ;;
  *) broker_name="oliphaunt-broker" ;;
esac
export OLIPHAUNT_BROKER="${OLIPHAUNT_BROKER:-$root/target/moon/oliphaunt-broker/build/debug/$broker_name}"
export OLIPHAUNT_NODE_ADDON="${OLIPHAUNT_NODE_ADDON:-$root/target/oliphaunt-artifacts/node-direct/$(oliphaunt_runtime_native_host_target_id)/oliphaunt_node.node}"

test -x "$OLIPHAUNT_BROKER"
test -f "$OLIPHAUNT_NODE_ADDON"
pnpm --dir src/sdks/js exec tsx src/__tests__/native-smoke.ts
deno run --allow-all src/sdks/js/src/__tests__/deno-native-smoke.mjs
