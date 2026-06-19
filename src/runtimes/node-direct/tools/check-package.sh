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
  require_file "$package_dir/tools/build-node-addon.sh"
  require_file "$package_dir/targets/checksums.toml"
  require_file "$package_dir/targets/macos-arm64.toml"
  require_file "$package_dir/targets/linux-x64-gnu.toml"
  require_file "$package_dir/targets/linux-arm64-gnu.toml"
  require_file "$package_dir/targets/windows-x64-msvc.toml"
  require_text "$package_dir/package.json" '"name": "@oliphaunt/node-direct"' \
    "Node direct runtime must have a product-local package identity"
  require_text "$package_dir/tools/build-node-addon.sh" "src/runtimes/node-direct/native/node-addon/oliphaunt_node.cc" \
    "Node direct build must compile product-owned addon source"
  require_text "$package_dir/tools/build-node-addon.sh" "oliphaunt-node-direct-\$version-\$target.tar.gz" \
    "Node direct build must emit product-scoped release assets"
  require_text "$package_dir/tools/build-node-addon.sh" "Node direct addon smoke passed" \
    "Node direct build must load-smoke the compiled addon before publishing an artifact"
  reject_text "$package_dir/tools/build-node-addon.sh" "oliphaunt-js-node-direct" \
    "Node direct runtime must not emit TypeScript-owned addon assets"
  require_text "$package_dir/native/node-addon/oliphaunt_node.cc" "NAPI_MODULE" \
    "Node direct addon must register a Node-API module"
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
