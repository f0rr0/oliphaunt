#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
root="$(git -C "$script_dir" rev-parse --show-toplevel 2>/dev/null)" || {
  echo "unable to determine repository root from $script_dir; run this script from a Git checkout" >&2
  exit 1
}
[ -f "$root/package.json" ] && [ -d "$root/src/extensions/artifacts/wasix" ] || {
  echo "package-wasix-extension-assets.sh: must run inside the Oliphaunt workspace" >&2
  exit 1
}
cd "$root"

fail() {
  echo "package-wasix-extension-assets.sh: $*" >&2
  exit 1
}

raw_target="${OLIPHAUNT_EXTENSION_TARGET:-portable}"
case "$raw_target" in
  portable | wasix-portable) target_id="wasix-portable" ;;
  *) fail "WASIX exact-extension artifacts are portable; unsupported target '$raw_target'" ;;
esac

extension_product="${OLIPHAUNT_EXTENSION_PRODUCT:-${1:-}}"
extension_products="${OLIPHAUNT_EXTENSION_PRODUCTS:-}"
if [ -n "$extension_product" ]; then
  if [ -n "$extension_products" ]; then
    extension_products="$extension_products,$extension_product"
  else
    extension_products="$extension_product"
  fi
fi
asset_root="$root/target/oliphaunt-wasix/assets"
generated_metadata="$root/src/extensions/generated/wasix/extensions.json"
default_out_dir="$root/target/extensions/wasix/release-assets/$target_id"
if [ -n "$extension_product" ] && [ -z "${OLIPHAUNT_EXTENSION_PRODUCTS:-}" ]; then
  default_out_dir="$default_out_dir/$extension_product"
fi
out_dir="${OLIPHAUNT_WASIX_EXTENSION_RELEASE_ASSET_DIR:-$default_out_dir}"

[ -f "$generated_metadata" ] || fail "missing generated WASIX extension metadata: ${generated_metadata#$root/}"
[ -d "$asset_root/extensions" ] || fail "missing WASIX extension asset directory: ${asset_root#$root/}/extensions"

"$root/tools/dev/bun.sh" \
  "$root/src/extensions/artifacts/wasix/tools/package-release-assets.mjs" \
  --root "$root" \
  --asset-root "$asset_root" \
  --metadata "$generated_metadata" \
  --out-dir "$out_dir" \
  --target "$target_id" \
  --extension-products "$extension_products"

echo "wasixExtensionReleaseAssetDir=$out_dir"
