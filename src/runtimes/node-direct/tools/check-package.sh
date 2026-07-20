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
  require_file "src/runtimes/liboliphaunt/native/include/oliphaunt.h"
  require_file "$package_dir/tools/build-node-addon.sh"
  require_file "$package_dir/tools/install-node-fallback.sh"
  require_file "$package_dir/tools/extract-node-headers.mjs"
  require_file "src/sources/toolchains/node.toml"
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
  require_text "$package_dir/tools/build-node-addon.sh" 'require pnpm' \
    "Node direct packaging must require the pinned workspace package manager"
  require_text "$package_dir/tools/build-node-addon.sh" 'pnpm --dir "$package_work" pack --pack-destination "$npm_package_dir" --json' \
    "Node direct packaging must use pinned pnpm for deterministic package staging"
  reject_text "$package_dir/tools/build-node-addon.sh" 'require npm' \
    "Node direct builders do not install npm and must not depend on an ambient npm CLI"
  require_text "$package_dir/tools/build-node-addon.sh" "install-node-fallback.sh headers" \
    "Node direct build must use the pinned fallback installer for missing Node headers"
  require_text "$package_dir/tools/build-node-addon.sh" "install-node-fallback.sh windows-lib" \
    "Node direct build must use the pinned fallback installer for missing Windows import libraries"
  require_text "$package_dir/tools/build-node-addon.sh" '"-I$node_include" "-I$oliphaunt_include" "$src"' \
    "Node direct MSVC build must include both Node and canonical liboliphaunt ABI headers"
  reject_text "$package_dir/tools/build-node-addon.sh" "https://nodejs.org" \
    "Node direct build must not duplicate Node fallback release metadata outside its manifest"
  reject_text "$package_dir/tools/build-node-addon.sh" "python3 -" \
    "Node direct build must not use inline Python for archive creation or package validation"
  reject_text "$package_dir/tools/build-node-addon.sh" "oliphaunt-js-node-direct" \
    "Node direct runtime must not emit TypeScript-owned addon assets"
  require_text "$package_dir/native/node-addon/oliphaunt_node.cc" "NAPI_MODULE" \
    "Node direct addon must register a Node-API module"
  require_text "$package_dir/native/node-addon/oliphaunt_node.cc" '#include "oliphaunt.h"' \
    "Node direct addon must compile against the canonical liboliphaunt ABI header"
  reject_text "$package_dir/native/node-addon/oliphaunt_node.cc" "struct OliphauntInitOptions" \
    "Node direct addon must not duplicate the canonical init-options ABI layout"
  require_text "$package_dir/native/node-addon/oliphaunt_node.cc" \
    "dlopen(path.c_str(), RTLD_NOW | RTLD_GLOBAL)" \
    "Node direct must expose embedded PostgreSQL symbols to extension DSOs"
  require_text "$package_dir/native/node-addon/oliphaunt_node.cc" \
    'LoadSymbol(env, dynamic, "oliphaunt_init_ex")' \
    "Node direct must resolve the versioned per-handle initialization ABI"
  require_text "$package_dir/native/node-addon/oliphaunt_node.cc" \
    'GetString(env, config, "moduleDirectory", false)' \
    "Node direct must carry the selected extension module directory through its native boundary"
  reject_text "$package_dir/native/node-addon/oliphaunt_node.cc" \
    "dlopen(path.c_str(), RTLD_NOW | RTLD_LOCAL)" \
    "Node direct must not hide embedded PostgreSQL symbols from extension DSOs"
}

check_platform_packages() {
  local packages=(
    "darwin-arm64"
    "linux-x64-gnu"
    "linux-arm64-gnu"
    "win32-x64-msvc"
  )
  for platform_package in "${packages[@]}"; do
    local path="$package_dir/packages/$platform_package/package.json"
    require_file "$path"
    require_text "$path" '"optional": true' \
      "Node direct platform package metadata must mark the package optional"
    require_text "$path" '"./oliphaunt_node.node": "./prebuilds/oliphaunt_node.node"' \
      "Node direct platform packages must export the prebuilt addon by stable path"
    reject_text "$path" '"scripts"' \
      "Node direct platform packages must not run install or build scripts"
    reject_text "$path" "node-gyp" \
      "Node direct platform packages must not require node-gyp"
  done
}

case "$mode" in
  check-static)
    check_static
    ;;
  test-unit)
    check_static
    check_platform_packages
    ;;
  package-shape)
    check_static
    check_platform_packages
    require_text "pnpm-workspace.yaml" '"src/runtimes/node-direct/packages/*"' \
      "pnpm workspace must include Node direct optional platform packages"
    require_text "src/sdks/js/package.json" '"@oliphaunt/node-direct-darwin-arm64"' \
      "TypeScript SDK must depend on Node direct optional platform packages"
    ;;
  *)
    echo "unknown Node direct check mode: $mode" >&2
    exit 2
    ;;
esac

echo "oliphaunt-node-direct $mode passed"
