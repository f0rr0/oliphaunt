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
require pnpm
require bun
require tar

case "$(uname -s)" in
  Darwin) platform="macos" ;;
  Linux) platform="linux" ;;
  MINGW*|MSYS*|CYGWIN*) platform="windows" ;;
  *) echo "unsupported Node direct adapter platform: $(uname -s)" >&2; exit 2 ;;
esac

case "$(uname -m)" in
  arm64|aarch64) arch="arm64" ;;
  x86_64|amd64) arch="x64" ;;
  *) echo "unsupported Node direct adapter architecture: $(uname -m)" >&2; exit 2 ;;
esac

case "$platform:$arch" in
  macos:arm64) target="macos-arm64" ;;
  linux:x64) target="linux-x64-gnu" ;;
  linux:arm64) target="linux-arm64-gnu" ;;
  windows:x64) target="windows-x64-msvc" ;;
  *) echo "unsupported Node direct adapter target: $platform/$arch" >&2; exit 2 ;;
esac

if [ "$platform" = "macos" ]; then
  MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-11.0}"
  case "$MACOSX_DEPLOYMENT_TARGET" in
    ""|*[!0-9.]*)
      echo "MACOSX_DEPLOYMENT_TARGET must be a numeric dotted version" >&2
      exit 2
      ;;
  esac
  export MACOSX_DEPLOYMENT_TARGET
fi

to_shell_path() {
  if [ "$platform" = "windows" ] && command -v cygpath >/dev/null 2>&1; then
    normalized="$(node -e 'process.stdout.write(process.argv[1].replace(/\\/g, "/"))' "$1")"
    cygpath -u "$normalized"
  else
    printf '%s\n' "$1"
  fi
}

resolve_output_path() {
  raw="$1"
  case "$raw" in
    /*|[A-Za-z]:/*|[A-Za-z]:\\*|\\\\*) ;;
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

version="$(node -e "console.log(require('./src/runtimes/node-direct/package.json').version)")"
node_exec="$(to_shell_path "$(node -p "process.execPath")")"
node_bin_dir="$(dirname "$node_exec")"
node_root="$(dirname "$node_bin_dir")"
node_include="${NODE_INCLUDE_DIR:-}"
if [ -n "$node_include" ]; then
  node_include="$(to_shell_path "$node_include")"
fi
if [ -z "$node_include" ]; then
  for candidate in "$node_root/include/node" "$node_root/include"; do
    if [ -f "$candidate/node_api.h" ]; then
      node_include="$candidate"
      break
    fi
  done
fi
if [ -z "$node_include" ]; then
  node_include="$(
    node -e '
const path = require("node:path");
try {
  process.stdout.write(path.dirname(require.resolve("node-api-headers/include/node_api.h", {
    paths: [process.cwd(), path.join(process.cwd(), "src/runtimes/node-direct")]
  })));
} catch {
  process.exit(1);
}
' 2>/dev/null || true
  )"
  if [ -n "$node_include" ]; then
    node_include="$(to_shell_path "$node_include")"
  fi
fi
if [ -z "$node_include" ]; then
  node_include="$(
    sh src/runtimes/node-direct/tools/install-node-fallback.sh headers
  )"
  node_include="$(to_shell_path "$node_include")"
fi

if [ ! -f "$node_include/node_api.h" ]; then
  echo "missing node_api.h; set NODE_INCLUDE_DIR or install node-api-headers" >&2
  exit 2
fi

out_dir="$(resolve_output_path "${OLIPHAUNT_NODE_ADDON_OUT_DIR:-$root/target/oliphaunt-artifacts/node-direct/$target}")"
asset_dir="$(resolve_output_path "${OLIPHAUNT_NODE_ADDON_ASSET_OUT_DIR:-$root/target/oliphaunt-node-direct/release-assets}")"
npm_package_dir="$(resolve_output_path "${OLIPHAUNT_NODE_ADDON_NPM_PACKAGE_OUT_DIR:-$root/target/oliphaunt-node-direct/npm-packages}")"
npm_package_work_root="$(resolve_output_path "${OLIPHAUNT_NODE_ADDON_NPM_PACKAGE_WORK_DIR:-$root/target/oliphaunt-node-direct/npm-package-work/$target}")"
src="src/runtimes/node-direct/native/node-addon/oliphaunt_node.cc"
addon="$out_dir/oliphaunt_node.node"
addon_file="$addon"

mkdir -p "$out_dir" "$asset_dir" "$npm_package_dir"

cxx="${CXX:-c++}"
oliphaunt_include="$root/src/runtimes/liboliphaunt/native/include"

case "$platform" in
  macos)
    "$cxx" -std=c++17 -O3 -DNAPI_VERSION=8 -DNODE_GYP_MODULE_NAME=oliphaunt_node \
      "-I$node_include" "-I$oliphaunt_include" -fPIC \
      "-mmacosx-version-min=$MACOSX_DEPLOYMENT_TARGET" -bundle -undefined dynamic_lookup \
      "$src" -o "$addon"
    ;;
  linux)
    "$cxx" -std=c++17 -O3 -DNAPI_VERSION=8 -DNODE_GYP_MODULE_NAME=oliphaunt_node \
      "-I$node_include" "-I$oliphaunt_include" -fPIC -shared \
      "$src" -ldl -o "$addon"
    ;;
  windows)
    node_lib="${NODE_LIB:-}"
    if [ -n "$node_lib" ]; then
      node_lib="$(to_shell_path "$node_lib")"
    fi
    if [ -z "$node_lib" ]; then
      for candidate in "$node_bin_dir/node.lib" "$node_root/x64/node.lib" "$node_root/lib/node.lib" "$node_root/node.lib"; do
        if [ -f "$candidate" ]; then
          node_lib="$candidate"
          break
        fi
      done
    fi
    if [ -z "$node_lib" ]; then
      case "$arch" in
        x64) node_dist_arch="x64" ;;
        arm64) node_dist_arch="arm64" ;;
        *) echo "unsupported Node direct Windows architecture for node.lib: $arch" >&2; exit 2 ;;
      esac
      node_lib="$(
        sh src/runtimes/node-direct/tools/install-node-fallback.sh windows-lib "$node_dist_arch"
      )"
      node_lib="$(to_shell_path "$node_lib")"
    fi
    if [ ! -f "$node_lib" ]; then
      echo "missing node.lib; set NODE_LIB" >&2
      exit 2
    fi
    cxx="${CXX:-cl}"
    windows_build_dir="$root/target/oliphaunt-node-direct/native-build/$target"
    rm -rf "$windows_build_dir"
    mkdir -p "$windows_build_dir"
    addon_object="$windows_build_dir/oliphaunt_node.obj"
    addon_import_library="$windows_build_dir/oliphaunt_node.lib"
    if command -v cygpath >/dev/null 2>&1; then
      node_include="$(cygpath -w "$node_include")"
      oliphaunt_include="$(cygpath -w "$oliphaunt_include")"
      node_lib="$(cygpath -w "$node_lib")"
      src="$(cygpath -w "$src")"
      addon="$(cygpath -w "$addon")"
      addon_object="$(cygpath -w "$addon_object")"
      addon_import_library="$(cygpath -w "$addon_import_library")"
    fi
    "$cxx" //nologo //std:c++17 //O2 //EHsc //LD //DNAPI_VERSION=8 //DNODE_GYP_MODULE_NAME=oliphaunt_node "-I$node_include" "-I$oliphaunt_include" "$src" //Fo:"$addon_object" //link "$node_lib" //OUT:"$addon" //IMPLIB:"$addon_import_library"
    ;;
esac

tools/dev/bun.sh tools/release/strip_native_release_binaries.mjs "$addon_file"

node - "$addon" <<'JS'
const addonPath = process.argv[2];
const addon = require(addonPath);
const expected = [
  'version',
  'capabilities',
  'open',
  'execProtocolRaw',
  'execSimpleQuery',
  'execProtocolStream',
  'backup',
  'restore',
  'cancel',
  'detach',
];
for (const name of expected) {
  if (typeof addon[name] !== 'function') {
    throw new Error(`compiled Node direct addon is missing export ${name}`);
  }
}
JS

bash src/runtimes/node-direct/tools/test-node-addon-cleanup-lifecycle.sh "$addon_file"

if [ "$platform" = "windows" ]; then
  asset="oliphaunt-node-direct-$version-$target.zip"
else
  asset="oliphaunt-node-direct-$version-$target.tar.gz"
fi
asset_stage="$root/target/oliphaunt-node-direct/release-stage/$target"
rm -rf "$asset_stage"
mkdir -p "$asset_stage"
cp "$addon_file" "$asset_stage/oliphaunt_node.node"
tools/dev/bun.sh tools/release/release-notices.mjs stage "$asset_stage" --profile source-sdk
tools/dev/bun.sh tools/release/platform-binary-contract.mjs --target "$target" --root "$asset_stage"
if [ "$platform" = "linux" ]; then
  tools/release/check-linux-consumer-baseline.sh --target "$target" --root "$asset_stage"
fi
tools/release/archive_dir.mjs "$asset_stage" "$asset_dir/$asset"

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

tools/release/write_checksum_manifest.mjs \
  --asset-dir "$asset_dir" \
  --output "oliphaunt-node-direct-$version-release-assets.sha256" \
  --pattern 'oliphaunt-node-direct-*.tar.gz' \
  --pattern 'oliphaunt-node-direct-*.zip'

printf 'Node direct addon smoke passed: %s\n' "$addon"
case "$target" in
  macos-arm64) optional_package="darwin-arm64" ;;
  linux-x64-gnu) optional_package="linux-x64-gnu" ;;
  linux-arm64-gnu) optional_package="linux-arm64-gnu" ;;
  windows-x64-msvc) optional_package="win32-x64-msvc" ;;
  *) echo "unsupported Node direct optional npm package target: $target" >&2; exit 2 ;;
esac
package_source="$root/src/runtimes/node-direct/packages/$optional_package"
package_work="$npm_package_work_root/$optional_package"
rm -rf "$package_work"
mkdir -p "$package_work/prebuilds"
cp -R "$package_source/." "$package_work/"
rm -rf "$package_work/prebuilds"
mkdir -p "$package_work/prebuilds"
cp "$addon_file" "$package_work/prebuilds/oliphaunt_node.node"
tools/dev/bun.sh tools/release/release-notices.mjs stage "$package_work" --profile source-sdk
pack_json="$(pnpm --dir "$package_work" pack --pack-destination "$npm_package_dir" --json)"
printf '%s\n' "$pack_json" >"$npm_package_dir/$optional_package.pnpm-pack.json"
tarball="$(
  PACK_JSON="$pack_json" PACK_DIR="$npm_package_dir" node <<'JS'
const path = require('node:path');
const raw = JSON.parse(process.env.PACK_JSON || '[]');
const entry = Array.isArray(raw) ? raw[0] : raw;
if (!entry || typeof entry.filename !== 'string' || !entry.filename.endsWith('.tgz')) {
  throw new Error('pnpm pack did not report a .tgz filename');
}
process.stdout.write(path.isAbsolute(entry.filename) ? entry.filename : path.join(process.env.PACK_DIR, entry.filename));
JS
)"
tarball="$(to_shell_path "$tarball")"
[ -f "$tarball" ] || {
  echo "pnpm pack did not create $tarball" >&2
  exit 1
}
if ! tar_list_gzip "$tarball" | grep -Fxq "package/prebuilds/oliphaunt_node.node"; then
  echo "Node direct optional npm package is missing prebuilds/oliphaunt_node.node: $tarball" >&2
  exit 1
fi
tools/dev/bun.sh tools/release/check-node-direct-release-assets.mjs \
  --asset-dir "$asset_dir" \
  --allow-partial \
  --npm-package "$tarball"
printf 'Node direct optional npm package staged: %s\n' "$tarball"
printf '%s\n' "$asset_dir/$asset"
