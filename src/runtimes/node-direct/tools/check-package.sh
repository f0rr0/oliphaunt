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

reject_text() {
  local path="$1"
  local text="$2"
  local message="$3"
  if grep -Fq "$text" "$path"; then
    echo "$message" >&2
    echo "forbidden text: $text in $path" >&2
    exit 1
  fi
}

check_static() {
  require_file "$package_dir/package.json"
  require_file "$package_dir/native/node-addon/oliphaunt_node.cc"
  require_file "$package_dir/native/node-addon/fixtures/fake_liboliphaunt.cc"
  require_file "src/runtimes/liboliphaunt/native/include/oliphaunt.h"
  require_file "$package_dir/tools/build-node-addon.sh"
  require_file "$package_dir/tools/check-package-metadata.mjs"
  require_file "$package_dir/tools/install-node-fallback.sh"
  require_file "$package_dir/tools/extract-node-headers.mjs"
  require_file "$package_dir/tools/node-addon-cleanup-lifecycle.test.mjs"
  require_file "$package_dir/tools/test-node-addon-cleanup-lifecycle.sh"
  require_file "src/sources/toolchains/node.toml"
  bash "$package_dir/tools/test-node-addon-cleanup-lifecycle.sh" --test-path-classifier
  require_text "$package_dir/package.json" '"name": "@oliphaunt/node-direct"' \
    "Node direct runtime must have a product-local package identity"
  require_text "$package_dir/tools/build-node-addon.sh" "src/runtimes/node-direct/native/node-addon/oliphaunt_node.cc" \
    "Node direct build must compile product-owned addon source"
  require_text "$package_dir/tools/build-node-addon.sh" "oliphaunt-node-direct-\$version-\$target.tar.gz" \
    "Node direct build must emit product-scoped release assets"
  require_text "$package_dir/tools/build-node-addon.sh" "tools/release/archive_dir.mjs" \
    "Node direct build must create release assets with the shared deterministic archive helper"
  require_text "$package_dir/tools/build-node-addon.sh" "Node direct addon smoke passed" \
    "Node direct build must load-smoke the compiled addon before publishing an artifact"
  # shellcheck disable=SC2016 # The build-script expression is intentionally matched literally.
  require_text "$package_dir/tools/build-node-addon.sh" \
    '"$lifecycle_test_addon_file"' \
    "Node direct build must execute the compiled environment cleanup lifecycle proof"
  require_text "$package_dir/tools/build-node-addon.sh" 'require pnpm' \
    "Node direct packaging must require the pinned workspace package manager"
  # shellcheck disable=SC2016 # The build-script expression is intentionally matched literally.
  require_text "$package_dir/tools/build-node-addon.sh" 'pnpm --dir "$package_work" pack --pack-destination "$npm_package_dir" --json' \
    "Node direct packaging must use pinned pnpm for deterministic package staging"
  reject_text "$package_dir/tools/build-node-addon.sh" 'require npm' \
    "Node direct builders do not install npm and must not depend on an ambient npm CLI"
  require_text "$package_dir/tools/build-node-addon.sh" "install-node-fallback.sh headers" \
    "Node direct build must use the pinned fallback installer for missing Node headers"
  require_text "$package_dir/tools/build-node-addon.sh" "install-node-fallback.sh windows-lib" \
    "Node direct build must use the pinned fallback installer for missing Windows import libraries"
  # shellcheck disable=SC2016 # The build-script expression is intentionally matched literally.
  require_text "$package_dir/tools/build-node-addon.sh" '"-I$node_include" "-I$oliphaunt_include" "$src"' \
    "Node direct MSVC build must include both Node and canonical liboliphaunt ABI headers"
  reject_text "$package_dir/tools/build-node-addon.sh" "https://nodejs.org" \
    "Node direct build must not duplicate Node fallback release metadata outside its manifest"
  reject_text "$package_dir/tools/build-node-addon.sh" "python3 -" \
    "Node direct build must not use inline Python for archive creation or package validation"
  reject_text "$package_dir/tools/build-node-addon.sh" "oliphaunt-js-node-direct" \
    "Node direct runtime must not emit TypeScript-owned addon assets"
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
  tools/dev/bun.sh "$package_dir/tools/check-package-metadata.mjs"
}

case "$mode" in
  check-static)
    check_static
    ;;
  test-unit)
    check_static
    ;;
  package-shape)
    check_static
    require_text "pnpm-workspace.yaml" '"src/runtimes/node-direct/packages/*"' \
      "pnpm workspace must include Node direct optional platform packages"
    ;;
  *)
    echo "unknown Node direct check mode: $mode" >&2
    exit 2
    ;;
esac

echo "oliphaunt-node-direct $mode passed"
