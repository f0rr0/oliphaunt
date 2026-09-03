#!/usr/bin/env bash
set -euo pipefail

mode="${1:-check-static}"
root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

package_dir="src/runtimes/node-direct"

require_file() {
  local path="$1"
  if [ ! -f "$path" ]; then
    echo "missing required Node direct file: $path" >&2
    exit 1
  fi
}

require_text() {
  local path="$1"
  local text="$2"
  local message="$3"
  if ! grep -Fq "$text" "$path"; then
    echo "$message" >&2
    echo "missing text: $text in $path" >&2
    exit 1
  fi
}

check_static() {
  require_file "$package_dir/native/node-addon/oliphaunt_node.cc"
  require_file "$package_dir/native/node-addon/fixtures/fake_liboliphaunt.cc"
  require_file "src/runtimes/liboliphaunt/native/include/oliphaunt.h"
  if command -v c++ >/dev/null 2>&1; then
    local node_include
    node_include="$(
      node -e '
const path = require("node:path");
const adjacent = path.resolve(process.execPath, "../../include/node");
try {
  process.stdout.write(require("node:fs").existsSync(path.join(adjacent, "node_api.h"))
    ? adjacent
    : path.dirname(require.resolve("node-api-headers/include/node_api.h", {
        paths: [process.cwd(), path.join(process.cwd(), "src/runtimes/node-direct")]
      })));
} catch {
  process.exit(1);
}
' 2>/dev/null || true
    )"
    if [ -n "$node_include" ] && [ -f "$node_include/node_api.h" ]; then
      c++ -std=c++17 -DNAPI_VERSION=8 -DNODE_GYP_MODULE_NAME=oliphaunt_node \
        -I"$node_include" -Isrc/runtimes/liboliphaunt/native/include -fsyntax-only \
        "$package_dir/native/node-addon/oliphaunt_node.cc"
      c++ -std=c++17 -DNAPI_VERSION=8 -DNODE_GYP_MODULE_NAME=oliphaunt_node \
        -DOLIPHAUNT_NODE_ADDON_LIFECYCLE_TESTING=1 \
        -I"$node_include" -Isrc/runtimes/liboliphaunt/native/include -fsyntax-only \
        "$package_dir/native/node-addon/oliphaunt_node.cc"
    else
      echo "Node direct addon syntax check deferred to the product build with pinned headers"
    fi
    c++ -std=c++17 -DOLIPHAUNT_BUILDING_DLL \
      -Isrc/runtimes/liboliphaunt/native/include -fsyntax-only \
      "$package_dir/native/node-addon/fixtures/fake_liboliphaunt.cc"
  fi
}

test_unit() {
  bash "$package_dir/tools/test-node-addon-cleanup-lifecycle.sh" --test-path-classifier
}

check_package_shape() {
  require_file "$package_dir/package.json"
  require_file "$package_dir/tools/build-node-addon.sh"
  require_file "$package_dir/tools/check-package-metadata.mjs"
  require_file "$package_dir/tools/install-node-fallback.sh"
  require_file "$package_dir/tools/extract-node-headers.mjs"
  require_file "$package_dir/tools/node-addon-cleanup-lifecycle.test.mjs"
  require_file "$package_dir/tools/test-node-addon-cleanup-lifecycle.sh"
  require_file "src/sources/toolchains/node.toml"
  tools/dev/bun.sh "$package_dir/tools/check-package-metadata.mjs"
  require_text "pnpm-workspace.yaml" '"src/runtimes/node-direct/packages/*"' \
    "pnpm workspace must include Node direct optional platform packages"
}

case "$mode" in
  check-static)
    check_static
    ;;
  test-unit)
    test_unit
    ;;
  package-shape)
    check_package_shape
    ;;
  *)
    echo "unknown Node direct check mode: $mode" >&2
    exit 2
    ;;
esac

echo "oliphaunt-node-direct $mode passed"
