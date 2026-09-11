#!/usr/bin/env sh
set -eu

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 1
  fi
}

require node
require bun
require cargo
require tar

case "$(uname -s)" in
  Darwin) platform="macos" ;;
  Linux) platform="linux" ;;
  MINGW* | MSYS* | CYGWIN*) platform="windows" ;;
  *)
    echo "unsupported Node direct adapter platform: $(uname -s)" >&2
    exit 2
    ;;
esac

case "$(uname -m)" in
  arm64 | aarch64) arch="arm64" ;;
  x86_64 | amd64) arch="x64" ;;
  *)
    echo "unsupported Node direct adapter architecture: $(uname -m)" >&2
    exit 2
    ;;
esac

case "$platform:$arch" in
  macos:arm64) target="macos-arm64" ;;
  linux:x64) target="linux-x64-gnu" ;;
  linux:arm64) target="linux-arm64-gnu" ;;
  windows:x64) target="windows-x64-msvc" ;;
  *)
    echo "unsupported Node direct adapter target: $platform/$arch" >&2
    exit 2
    ;;
esac

if [ "$platform" = "macos" ]; then
  MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-11.0}"
  case "$MACOSX_DEPLOYMENT_TARGET" in
    "" | *[!0-9.]*)
      echo "MACOSX_DEPLOYMENT_TARGET must be a numeric dotted version" >&2
      exit 2
      ;;
  esac
  export MACOSX_DEPLOYMENT_TARGET
fi

to_shell_path() {
  if [ "$platform" = "windows" ] && command -v cygpath >/dev/null 2>&1; then
    cygpath -u "$1"
  else
    printf '%s\n' "$1"
  fi
}

resolve_output_path() {
  raw="$1"
  case "$raw" in
    /* | [A-Za-z]:/* | [A-Za-z]:\\* | \\\\*) ;;
    *) raw="$root/$raw" ;;
  esac
  if [ "$platform" = "windows" ] && command -v cygpath >/dev/null 2>&1; then
    cygpath -am "$raw"
  else
    printf '%s\n' "$raw"
  fi
}

tar_list_gzip() {
  if [ "$platform" = "windows" ]; then
    tar --force-local -tzf "$1"
  else
    tar -tzf "$1"
  fi
}

version="$(bun tools/dev/node-info.mts package-version sdks/ts/node-addon/package.json)"
out_dir="$(resolve_output_path "${OLIPHAUNT_NODE_ADDON_OUT_DIR:-$root/target/oliphaunt-artifacts/node-direct/$target}")"
asset_dir="$(resolve_output_path "${OLIPHAUNT_NODE_ADDON_ASSET_OUT_DIR:-$root/target/oliphaunt-node-direct/release-assets}")"
npm_package_dir="$(resolve_output_path "${OLIPHAUNT_NODE_ADDON_NPM_PACKAGE_OUT_DIR:-$root/target/oliphaunt-node-direct/npm-packages}")"
npm_package_work_root="$(resolve_output_path "${OLIPHAUNT_NODE_ADDON_NPM_PACKAGE_WORK_DIR:-$root/target/oliphaunt-node-direct/npm-package-work/$target}")"
addon="$out_dir/oliphaunt_node.node"
addon_file="$addon"
mkdir -p "$out_dir" "$asset_dir" "$npm_package_dir"
bash sdks/ts/node-addon/tools/build-native.sh "$out_dir"
bash tools/packaging/strip-native-binaries.sh "$addon_file"

if [ "$platform" = "windows" ]; then
  asset="oliphaunt-node-direct-$version-$target.zip"
else
  asset="oliphaunt-node-direct-$version-$target.tar.gz"
fi
asset_stage="$root/target/oliphaunt-node-direct/release-stage/$target"
rm -rf "$asset_stage"
mkdir -p "$asset_stage"
cp "$addon_file" "$asset_stage/oliphaunt_node.node"
tools/dev/bun.sh tools/packaging/release-notices.mts stage "$asset_stage" --profile source-sdk
tools/dev/bun.sh sdks/ts/node-addon/tools/dependency-license-contract.mts stage "$asset_stage" --target "$target"
tools/dev/bun.sh tools/packaging/platform-binary-contract.mts --target "$target" --root "$asset_stage"
if [ "$platform" = "linux" ]; then
  tools/packaging/check-linux-consumer-baseline.sh --target "$target" --root "$asset_stage"
fi
tools/packaging/archive-directory.mts "$asset_stage" "$asset_dir/$asset"

input_dirs="${OLIPHAUNT_NODE_ADDON_ASSET_INPUT_DIRS:-${OLIPHAUNT_RELEASE_ASSET_INPUT_DIRS:-}}"
if [ -n "$input_dirs" ]; then
  old_ifs="$IFS"
  if [ "$platform" = "windows" ]; then
    input_delimiter=';'
  else
    input_delimiter=':'
  fi
  IFS="$input_delimiter"
  for input_dir in $input_dirs; do
    IFS="$old_ifs"
    [ -n "$input_dir" ] || continue
    input_dir="$(to_shell_path "$input_dir")"
    [ -d "$input_dir" ] || {
      echo "release asset input directory does not exist: $input_dir" >&2
      exit 1
    }
    find "$input_dir" -maxdepth 1 -type f \( -name 'oliphaunt-node-direct-*.tar.gz' -o -name 'oliphaunt-node-direct-*.zip' \) -print |
      sort |
      while IFS= read -r input_asset; do
        [ -n "$input_asset" ] || continue
        cp -p "$input_asset" "$asset_dir/"
      done
    IFS="$input_delimiter"
  done
  IFS="$old_ifs"
fi

tools/packaging/write-checksum-manifest.mts \
  --asset-dir "$asset_dir" \
  --output "oliphaunt-node-direct-$version-release-assets.sha256" \
  --pattern 'oliphaunt-node-direct-*.tar.gz' \
  --pattern 'oliphaunt-node-direct-*.zip'

printf 'Node direct addon built and validated: %s\n' "$addon"
case "$target" in
  macos-arm64) optional_package="darwin-arm64" ;;
  linux-x64-gnu) optional_package="linux-x64-gnu" ;;
  linux-arm64-gnu) optional_package="linux-arm64-gnu" ;;
  windows-x64-msvc) optional_package="win32-x64-msvc" ;;
  *)
    echo "unsupported Node direct optional npm package target: $target" >&2
    exit 2
    ;;
esac
package_source="$root/sdks/ts/node-addon/packages/$optional_package"
package_work="$npm_package_work_root/$optional_package"
rm -rf "$package_work"
mkdir -p "$package_work/prebuilds"
cp -R "$package_source/." "$package_work/"
rm -rf "$package_work/prebuilds"
mkdir -p "$package_work/prebuilds"
cp "$addon_file" "$package_work/prebuilds/oliphaunt_node.node"
tools/dev/bun.sh tools/packaging/release-notices.mts stage "$package_work" --profile source-sdk
tools/dev/bun.sh sdks/ts/node-addon/tools/dependency-license-contract.mts stage "$package_work" --target "$target"
find "$package_work" -type f -exec chmod 0644 {} +
chmod 0755 "$package_work/prebuilds/oliphaunt_node.node"
filename="$(bun "$root/tools/packaging/npm-package.mts" "$package_work")"
tarball="$npm_package_dir/$filename"
bun pm pack --cwd "$package_work" --filename "$tarball"
[ -f "$tarball" ] || {
  echo "bun pm pack did not create $tarball" >&2
  exit 1
}
if ! tar_list_gzip "$tarball" | grep -Fxq "package/prebuilds/oliphaunt_node.node"; then
  echo "Node direct optional npm package is missing prebuilds/oliphaunt_node.node: $tarball" >&2
  exit 1
fi
tools/dev/bun.sh sdks/ts/node-addon/tools/check-release-assets.mts \
  --asset-dir "$asset_dir" \
  --allow-partial \
  --npm-package "$tarball"
printf 'Node direct optional npm package staged: %s\n' "$tarball"
printf '%s\n' "$asset_dir/$asset"
