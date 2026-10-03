#!/usr/bin/env bash
set -euo pipefail

host_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$host_dir/../../.." && pwd)"
source_manifest="$host_dir/source.toml"
provenance_script="$host_dir/build-provenance.mts"
target_parent="$repo_root/target/oliphaunt-wasix-ts/host"
target_dir="$target_parent/wasmer-sdk"
cargo_target_dir="$target_parent/cargo"

toml_value() {
  local wanted_section="$1"
  local wanted_key="$2"
  awk -v wanted_section="$wanted_section" -v wanted_key="$wanted_key" '
    /^\[/ {
      section = $0
      gsub(/^\[|\]$/, "", section)
      next
    }
    section == wanted_section && $1 == wanted_key {
      sub(/^[^=]*=[[:space:]]*"/, "")
      sub(/"[[:space:]]*$/, "")
      print
      exit
    }
  ' "$source_manifest"
}

wasmer_js_version="$(toml_value wasmer-js version)"
wasmer_wasix_version="$(toml_value wasmer-wasix version)"
wasmer_version="$(toml_value wasmer version)"
virtual_fs_version="$(toml_value virtual-fs version)"
virtual_mio_version="$(toml_value virtual-mio version)"

for value in "$wasmer_js_version" "$wasmer_wasix_version" "$wasmer_version" "$virtual_fs_version" "$virtual_mio_version"; do
  if [[ -z "$value" ]]; then
    echo "wasix-ts host build: malformed $source_manifest" >&2
    exit 1
  fi
done

if ! command -v bun >/dev/null 2>&1; then
  echo "wasix-ts host build: required command not found: bun" >&2
  exit 1
fi
patch_series="$(bun "$provenance_script" --patch-series)"
input_hash="$(bun "$provenance_script" --inputs-sha256)"
if [[ ! "$input_hash" =~ ^[0-9a-f]{64}$ ]]; then
  echo "wasix-ts host build: invalid source identity" >&2
  exit 1
fi

patch_command="patch"
if command -v gpatch >/dev/null 2>&1; then
  patch_command="gpatch"
fi

if [[ -f "$target_dir/.oliphaunt-input-sha256" ]] \
    && [[ "$(<"$target_dir/.oliphaunt-input-sha256")" == "$input_hash" ]] \
    && [[ -f "$target_dir/dist/index.mjs" ]] \
    && [[ -f "$target_dir/dist/worker.mjs" ]] \
    && [[ -f "$target_dir/dist/wasmer_js_bg.wasm" ]]; then
  echo "wasix-ts host build: using source-pinned SDK at $target_dir"
  exit 0
fi

mkdir -p "$target_parent"

for command_name in awk bun curl git node npm "$patch_command" wasm-pack; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "wasix-ts host build: required command not found: $command_name" >&2
    exit 1
  fi
done
if [[ "$(wasm-pack --version)" != "wasm-pack ${WASM_PACK_VERSION:-0.15.0}" ]]; then
  echo "wasix-ts host build: wasm-pack ${WASM_PACK_VERSION:-0.15.0} is required" >&2
  exit 1
fi

build_root="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-wasmer-sdk.XXXXXX")"
cleanup() {
  rm -rf -- "$build_root"
}
trap cleanup EXIT

wasmer_js_dir="$build_root/wasmer-js"
wasmer_wasix_dir="$build_root/wasmer-wasix-$wasmer_wasix_version"
wasmer_dir="$build_root/wasmer-$wasmer_version"
virtual_fs_dir="$build_root/virtual-fs-$virtual_fs_version"
virtual_mio_dir="$build_root/virtual-mio-$virtual_mio_version"

# Use the same bounded transports, exact pins and safe extraction as the other
# producers. Only temporary source trees are patched; verified archives persist.
source "$repo_root/src/third-party/tools/fetch-sources.sh"
bun - "$source_manifest" "$build_root" <<'JS'
import {readFileSync, writeFileSync} from 'node:fs';
const pins = Bun.TOML.parse(readFileSync(process.argv[2], 'utf8'));
for (const name of ['wasmer-js', 'wasmer-wasix', 'wasmer', 'virtual-fs', 'virtual-mio']) {
  const pin = pins[name];
  const source = name === 'wasmer-js'
    ? {name, kind:'git', url:pin.url, branch:'oliphaunt-pinned', commit:pin.commit}
    : {name:`${name}-${pin.version}`, kind:'archive', url:pin.url, branch:pin.version,
       commit:pin.sha256, sha256:pin.sha256, stripPrefix:`${name}-${pin.version}`};
  writeFileSync(`${process.argv[3]}/${name}.json`, JSON.stringify(source));
}
JS
oliphaunt_acquisition_start 'browser host sources' 1800
for source_name in wasmer-js wasmer-wasix wasmer virtual-fs virtual-mio; do
  fetch_source "$build_root/$source_name.json" "$build_root" "$target_parent/archives" fetch
done
actual_wasmer_js_version="$(bun "$repo_root/tools/dev/node-info.mts" package-version "$wasmer_js_dir/package.json")"
if [[ "$actual_wasmer_js_version" != "$wasmer_js_version" ]]; then
  echo "wasix-ts host build: pinned Wasmer JS version is $actual_wasmer_js_version, expected $wasmer_js_version" >&2
  exit 1
fi

while IFS= read -r patch_name; do
  [[ -n "$patch_name" ]] || continue
  patch_file="$host_dir/patches/$patch_name"
  case "$patch_name" in
    ????-wasmer-js-*.patch)
      patch_dir="$wasmer_js_dir"
      ;;
    ????-wasmer-wasix-*.patch)
      patch_dir="$wasmer_wasix_dir"
      ;;
    ????-wasmer-*.patch)
      patch_dir="$wasmer_dir"
      ;;
    ????-virtual-fs-*.patch)
      patch_dir="$virtual_fs_dir"
      ;;
    ????-virtual-mio-*.patch)
      patch_dir="$virtual_mio_dir"
      ;;
    *)
      echo "wasix-ts host build: patch target is not declared by its canonical name: $patch_name" >&2
      exit 1
      ;;
  esac
  "$patch_command" --batch --forward --fuzz=0 -d "$patch_dir" -p1 < "$patch_file"
done <<< "$patch_series"

# The pinned source commit's npm lock predates its package metadata. Patch only
# the missing root metadata and dependencies, then install the integrity-pinned
# graph without allowing the package manager to rewrite it.
npm --prefix "$wasmer_js_dir" ci --ignore-scripts --no-audit --no-fund

(
  cd "$wasmer_js_dir"
  CARGO_TARGET_DIR="$cargo_target_dir" wasm-pack build --release --target=web --weak-refs --no-pack
  npm run build:rollup
)

for output in index.mjs worker.mjs wasmer_js_bg.wasm; do
  if [[ ! -f "$wasmer_js_dir/dist/$output" ]]; then
    echo "wasix-ts host build: expected output missing: dist/$output" >&2
    exit 1
  fi
done

staging_dir="$target_parent/.wasmer-sdk-$input_hash"
if [[ -e "$staging_dir" ]]; then
  rm -rf -- "$staging_dir"
fi
mkdir -p "$staging_dir"
cp -R "$wasmer_js_dir/dist" "$staging_dir/dist"
cp "$wasmer_js_dir/LICENSE" "$staging_dir/LICENSE"
printf '%s\n' "$input_hash" > "$staging_dir/.oliphaunt-input-sha256"
bun "$provenance_script" --json > "$staging_dir/provenance.json"
chmod -R u+rwX,go+rX "$staging_dir"

previous_dir="$target_parent/.wasmer-sdk-previous"
if [[ -e "$previous_dir" ]]; then
  rm -rf -- "$previous_dir"
fi
if [[ -e "$target_dir" ]]; then
  mv "$target_dir" "$previous_dir"
fi
mv "$staging_dir" "$target_dir"
if [[ -e "$previous_dir" ]]; then
  rm -rf -- "$previous_dir"
fi

echo "wasix-ts host build: wrote source-pinned SDK to $target_dir"
