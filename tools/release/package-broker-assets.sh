#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

version="$(python3 tools/release/product_metadata.py version oliphaunt-broker)"
out_dir="${OLIPHAUNT_BROKER_RELEASE_ASSETS:-$root/target/oliphaunt-broker/release-assets}"
stage_root="$root/target/oliphaunt-broker/release-stage"
host_os="$(uname -s)"
host_arch="$(uname -m)"

fail() {
  echo "package-broker-assets.sh: $*" >&2
  exit 1
}

command -v bun >/dev/null 2>&1 || fail "missing required command: bun"

python_bin="${PYTHON:-python3}"
if ! command -v "$python_bin" >/dev/null 2>&1; then
  if command -v python >/dev/null 2>&1; then
    python_bin=python
  else
    fail "missing required command: python3"
  fi
fi

case "$host_os:$host_arch" in
  Darwin:arm64) target_id="macos-arm64" ;;
  Linux:x86_64|Linux:amd64) target_id="linux-x64-gnu" ;;
  Linux:aarch64|Linux:arm64) target_id="linux-arm64-gnu" ;;
  MINGW*:x86_64|MSYS*:x86_64|CYGWIN*:x86_64) target_id="windows-x64-msvc" ;;
  *) fail "unsupported oliphaunt-broker release asset host $host_os/$host_arch" ;;
esac

asset_extension="tar.gz"
broker_stage_name="oliphaunt-broker"
if [ "$target_id" = "windows-x64-msvc" ]; then
  asset_extension="zip"
  broker_stage_name="oliphaunt-broker.exe"
fi

cargo_target_dir="${CARGO_TARGET_DIR:-$root/target}"
case "$cargo_target_dir" in
  /*) ;;
  *) cargo_target_dir="$root/$cargo_target_dir" ;;
esac
broker_bin="$cargo_target_dir/release/$broker_stage_name"

asset="oliphaunt-broker-${version}-${target_id}.${asset_extension}"
checksum_asset="oliphaunt-broker-${version}-release-assets.sha256"
stage="$stage_root/oliphaunt-broker-${version}-${target_id}"

rm -rf "$stage_root" "$out_dir"
mkdir -p "$stage/bin" "$out_dir"

cargo build -p oliphaunt-broker --release --locked
[ -x "$broker_bin" ] || fail "missing broker helper at $broker_bin"

cp "$broker_bin" "$stage/bin/$broker_stage_name"
chmod 0755 "$stage/bin/$broker_stage_name"
"$python_bin" tools/release/strip_native_release_binaries.py "$stage"
cat >"$stage/manifest.properties" <<EOF
schema=oliphaunt-broker-release-assets-v1
product=oliphaunt-broker
version=$version
target=$target_id
binary=bin/$broker_stage_name
EOF

tools/release/archive_dir.py "$stage" "$out_dir/$asset"

input_dirs="${OLIPHAUNT_BROKER_RELEASE_ASSET_INPUT_DIRS:-${OLIPHAUNT_RELEASE_ASSET_INPUT_DIRS:-}}"
if [ -n "$input_dirs" ]; then
  IFS=':' read -r -a input_dir_array <<<"$input_dirs"
  for input_dir in "${input_dir_array[@]}"; do
    [ -n "$input_dir" ] || continue
    [ -d "$input_dir" ] || fail "release asset input directory does not exist: $input_dir"
    while IFS= read -r input_asset; do
      [ -n "$input_asset" ] || continue
      cp -p "$input_asset" "$out_dir/"
    done < <(find "$input_dir" -maxdepth 1 -type f \( -name 'oliphaunt-broker-*.tar.gz' -o -name 'oliphaunt-broker-*.zip' \) -print | sort)
  done
fi

(
  tools/release/write_checksum_manifest.mjs \
    --asset-dir "$out_dir" \
    --output "$checksum_asset" \
    --pattern 'oliphaunt-broker-*.tar.gz' \
    --pattern 'oliphaunt-broker-*.zip'
)
check_args=(--asset-dir "$out_dir")
if [ "${OLIPHAUNT_RELEASE_ASSET_PARTIAL:-0}" = "1" ]; then
  check_args+=(--allow-partial)
fi
tools/release/check_broker_release_assets.py "${check_args[@]}"
echo "oliphauntBrokerReleaseAssetDir=$out_dir"
