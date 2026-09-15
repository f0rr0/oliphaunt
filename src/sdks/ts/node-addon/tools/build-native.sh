#!/usr/bin/env bash
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
cd "$root"
target="${CARGO_BUILD_TARGET:-$(rustc -vV | sed -n 's/^host: //p')}"
profile="${OLIPHAUNT_NODE_ADDON_PROFILE:-release}"
out="${1:-$root/target/oliphaunt-node-direct/native}"
case "$target" in
  *-apple-darwin) artifact=liboliphaunt_node_direct.dylib; export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-11.0}" ;;
  *-windows-msvc) artifact=oliphaunt_node_direct.dll ;;
  *-linux-gnu) artifact=liboliphaunt_node_direct.so ;;
  *) echo "unsupported native addon target: $target" >&2; exit 2 ;;
esac
cargo build --locked -p oliphaunt-node-direct --target "$target" --profile "$profile"
if [[ "$profile" == dev ]]; then profile=debug; fi
mkdir -p "$out"
cp "${CARGO_TARGET_DIR:-$root/target}/$target/$profile/$artifact" "$out/oliphaunt_node.node"
