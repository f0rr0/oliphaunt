#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
cd "$root"

. runtimes/liboliphaunt-native/tools/runtime-preflight.sh
oliphaunt_runtime_native_host_export_defaults

case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*) broker_name="oliphaunt-broker.exe" ;;
  *) broker_name="oliphaunt-broker" ;;
esac
export OLIPHAUNT_BROKER="${OLIPHAUNT_BROKER:-$root/target/debug/$broker_name}"
export OLIPHAUNT_NODE_ADDON="${OLIPHAUNT_NODE_ADDON:-$root/target/oliphaunt-node-direct/native/oliphaunt_node.node}"
export OLIPHAUNT_RUNTIME_DIR="${OLIPHAUNT_RUNTIME_DIR:-$OLIPHAUNT_INSTALL_DIR}"

test -x "$OLIPHAUNT_BROKER"
test -f "$OLIPHAUNT_NODE_ADDON"
OLIPHAUNT_SMOKE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-js-smoke.XXXXXX")"
export OLIPHAUNT_SMOKE_ROOT
trap 'rm -rf "$OLIPHAUNT_SMOKE_ROOT"' EXIT HUP INT TERM
# A direct backend remains bound to its root until the host process exits.
for host in node bun deno; do
  export OLIPHAUNT_SMOKE_HOST="$host"
  for OLIPHAUNT_SMOKE_PHASE in source restored; do
    export OLIPHAUNT_SMOKE_PHASE
    printf 'Checking %s native SDK (%s)\n' "$host" "$OLIPHAUNT_SMOKE_PHASE"
    case "$host" in
      node) node --experimental-strip-types sdks/ts/sdk/src/__tests__/native-smoke.mts ;;
      bun) bun sdks/ts/sdk/src/__tests__/native-smoke.mts ;;
      deno) deno run --no-config --node-modules-dir=manual --allow-all sdks/ts/sdk/src/__tests__/native-smoke.mts ;;
    esac
  done
done
bun sdks/ts/sdk/src/__tests__/native-server-smoke.ts
