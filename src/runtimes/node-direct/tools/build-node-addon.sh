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
require npm
require python3
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

to_shell_path() {
  if [ "$platform" = "windows" ] && command -v cygpath >/dev/null 2>&1; then
    normalized="$(node -e 'process.stdout.write(process.argv[1].replace(/\\/g, "/"))' "$1")"
    cygpath -u "$normalized"
  else
    printf '%s\n' "$1"
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
  require curl
  node_version="$(node -p "process.versions.node")"
  node_headers_dir="$root/target/oliphaunt-node-direct/node-headers/v$node_version"
  node_include="$node_headers_dir/include/node"
  if [ ! -f "$node_include/node_api.h" ]; then
    rm -rf "$node_headers_dir"
    mkdir -p "$node_headers_dir"
    node_headers_archive="$node_headers_dir/node-headers.tar.gz"
    node_headers_url="https://nodejs.org/dist/v$node_version/node-v$node_version-headers.tar.gz"
    curl --fail --location --retry 8 --retry-all-errors --retry-delay 5 --connect-timeout 20 \
      --output "$node_headers_archive" "$node_headers_url"
    tar --force-local -C "$node_headers_dir" --strip-components=1 -xzf "$node_headers_archive"
  fi
fi

if [ ! -f "$node_include/node_api.h" ]; then
  echo "missing node_api.h; set NODE_INCLUDE_DIR or install node-api-headers" >&2
  exit 2
fi

out_dir="${OLIPHAUNT_NODE_ADDON_OUT_DIR:-$root/target/oliphaunt-artifacts/node-direct/$target}"
asset_dir="${OLIPHAUNT_NODE_ADDON_ASSET_OUT_DIR:-$root/target/oliphaunt-node-direct/release-assets}"
npm_package_dir="${OLIPHAUNT_NODE_ADDON_NPM_PACKAGE_OUT_DIR:-$root/target/oliphaunt-node-direct/npm-packages}"
npm_package_work_root="${OLIPHAUNT_NODE_ADDON_NPM_PACKAGE_WORK_DIR:-$root/target/oliphaunt-node-direct/npm-package-work/$target}"
src="src/runtimes/node-direct/native/node-addon/oliphaunt_node.cc"
addon="$out_dir/oliphaunt_node.node"
addon_file="$addon"

mkdir -p "$out_dir" "$asset_dir" "$npm_package_dir"

cxx="${CXX:-c++}"
common_flags="-std=c++17 -O3 -DNAPI_VERSION=8 -DNODE_GYP_MODULE_NAME=oliphaunt_node -I$node_include"

case "$platform" in
  macos)
    "$cxx" $common_flags -fPIC -bundle -undefined dynamic_lookup "$src" -o "$addon"
    ;;
  linux)
    "$cxx" $common_flags -fPIC -shared "$src" -ldl -o "$addon"
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
      require curl
      node_version="$(node -p "process.versions.node")"
      case "$arch" in
        x64) node_dist_arch="x64" ;;
        arm64) node_dist_arch="arm64" ;;
        *) echo "unsupported Node direct Windows architecture for node.lib: $arch" >&2; exit 2 ;;
      esac
      node_lib_dir="$root/target/oliphaunt-node-direct/node-lib/v$node_version-win-$node_dist_arch"
      node_lib="$node_lib_dir/node.lib"
      if [ ! -f "$node_lib" ]; then
        mkdir -p "$node_lib_dir"
        node_lib_url="https://nodejs.org/dist/v$node_version/win-$node_dist_arch/node.lib"
        curl --fail --location --retry 8 --retry-all-errors --retry-delay 5 --connect-timeout 20 \
          --output "$node_lib" "$node_lib_url"
      fi
    fi
    if [ ! -f "$node_lib" ]; then
      echo "missing node.lib; set NODE_LIB" >&2
      exit 2
    fi
    cxx="${CXX:-cl}"
    if command -v cygpath >/dev/null 2>&1; then
      node_include="$(cygpath -w "$node_include")"
      node_lib="$(cygpath -w "$node_lib")"
      src="$(cygpath -w "$src")"
      addon="$(cygpath -w "$addon")"
    fi
    "$cxx" //nologo //std:c++17 //O2 //EHsc //LD //DNAPI_VERSION=8 //DNODE_GYP_MODULE_NAME=oliphaunt_node "-I$node_include" "$src" //link "$node_lib" //OUT:"$addon"
    ;;
esac

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

if [ "$platform" = "windows" ]; then
  asset="oliphaunt-node-direct-$version-$target.zip"
  python3 - "$out_dir" "$asset_dir/$asset" <<'PY'
import pathlib
import sys
import zipfile

out_dir = pathlib.Path(sys.argv[1])
asset = pathlib.Path(sys.argv[2])
with zipfile.ZipFile(asset, "w", compression=zipfile.ZIP_DEFLATED) as archive:
    archive.write(out_dir / "oliphaunt_node.node", "oliphaunt_node.node")
PY
else
  asset="oliphaunt-node-direct-$version-$target.tar.gz"
  tar -C "$out_dir" -czf "$asset_dir/$asset" oliphaunt_node.node
fi

input_dirs="${OLIPHAUNT_NODE_ADDON_ASSET_INPUT_DIRS:-${OLIPHAUNT_RELEASE_ASSET_INPUT_DIRS:-}}"
if [ -n "$input_dirs" ]; then
  old_ifs="$IFS"
  IFS=':'
  for input_dir in $input_dirs; do
    IFS="$old_ifs"
    [ -n "$input_dir" ] || continue
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
    IFS=':'
  done
  IFS="$old_ifs"
fi

tools/release/write_checksum_manifest.py \
  --asset-dir "$asset_dir" \
  --output "oliphaunt-node-direct-$version-release-assets.sha256" \
  --pattern 'oliphaunt-node-direct-*.tar.gz' \
  --pattern 'oliphaunt-node-direct-*.zip'

printf 'Node direct addon smoke passed: %s\n' "$addon"
python3 tools/release/check_node_direct_release_assets.py --asset-dir "$asset_dir" --allow-partial
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
pack_json="$(npm pack "$package_work" --pack-destination "$npm_package_dir" --json)"
printf '%s\n' "$pack_json" >"$npm_package_dir/$optional_package.npm-pack.json"
tarball="$(
  PACK_JSON="$pack_json" PACK_DIR="$npm_package_dir" node <<'JS'
const path = require('node:path');
const raw = JSON.parse(process.env.PACK_JSON || '[]');
const entry = Array.isArray(raw) ? raw[0] : raw;
if (!entry || typeof entry.filename !== 'string' || !entry.filename.endsWith('.tgz')) {
  throw new Error('npm pack did not report a .tgz filename');
}
process.stdout.write(path.isAbsolute(entry.filename) ? entry.filename : path.join(process.env.PACK_DIR, entry.filename));
JS
)"
[ -f "$tarball" ] || {
  echo "npm pack did not create $tarball" >&2
  exit 1
}
python3 - "$tarball" <<'PY' || {
import sys
import tarfile

expected = "package/prebuilds/oliphaunt_node.node"
with tarfile.open(sys.argv[1], "r:gz") as archive:
    if expected not in archive.getnames():
        raise SystemExit(1)
PY
  echo "Node direct optional npm package is missing prebuilds/oliphaunt_node.node: $tarball" >&2
  exit 1
}
printf 'Node direct optional npm package staged: %s\n' "$tarball"
printf '%s\n' "$asset_dir/$asset"
