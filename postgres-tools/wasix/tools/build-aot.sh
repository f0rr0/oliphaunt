#!/usr/bin/env bash
set -euo pipefail
cd "$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
export OLIPHAUNT_WASM_BUILD_PROFILE="${ASSET_PROFILE:-release}"
target="${AOT_TARGET:-$(rustc -vV | awk '/^host:/{print $2}')}"
host="$(rustc -vV | awk '/^host:/{print $2}')"
[ "$target" = "$host" ] || { echo "AOT target $target requires its matching builder host, got $host" >&2; exit 1; }
bash runtimes/liboliphaunt-wasix/tools/serialize-aot.sh --target-triple "$target" --product tools
cargo run -p xtask --locked -- assets package-aot --target-triple "$target" --product tools
