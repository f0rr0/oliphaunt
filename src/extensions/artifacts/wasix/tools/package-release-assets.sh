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
selected_sql_names=""
if [ -n "$extension_products" ]; then
  selected_sql_names="$(
    python3 - "$extension_products" <<'PY'
import sys
from pathlib import Path

root = Path.cwd()
sys.path.insert(0, str(root / "tools" / "release"))
import product_metadata

products = sorted({item.strip() for item in sys.argv[1].split(",") if item.strip()})
if not products:
    raise SystemExit("no exact-extension products were selected")
sql_names = []
for product in products:
    config = product_metadata.product_config(product)
    if config.get("kind") != "exact-extension-artifact":
        raise SystemExit(f"{product} is not an exact-extension artifact product")
    sql_name = config.get("extension_sql_name")
    if not isinstance(sql_name, str) or not sql_name:
        raise SystemExit(f"{product} release metadata must declare extension_sql_name")
    sql_names.append(sql_name)
print(",".join(sorted(set(sql_names))))
PY
  )"
fi

version="$(python3 tools/release/product_metadata.py version liboliphaunt-wasix)"
asset_root="$root/target/oliphaunt-wasix/assets"
generated_metadata="$root/src/extensions/generated/wasix/extensions.json"
default_out_dir="$root/target/extensions/wasix/release-assets/$target_id"
if [ -n "$extension_product" ] && [ -z "${OLIPHAUNT_EXTENSION_PRODUCTS:-}" ]; then
  default_out_dir="$default_out_dir/$extension_product"
fi
out_dir="${OLIPHAUNT_WASIX_EXTENSION_RELEASE_ASSET_DIR:-$default_out_dir}"
asset_index="$out_dir/liboliphaunt-wasix-${version}-wasix-extension-assets.tsv"

[ -f "$generated_metadata" ] || fail "missing generated WASIX extension metadata: ${generated_metadata#$root/}"
[ -d "$asset_root/extensions" ] || fail "missing WASIX extension asset directory: ${asset_root#$root/}/extensions"

rm -rf "$out_dir"
mkdir -p "$out_dir"

python3 - "$root" "$asset_root" "$generated_metadata" "$out_dir" "$version" "$target_id" "$asset_index" "$selected_sql_names" <<'PY'
from __future__ import annotations

import csv
import json
import shutil
import sys
from pathlib import Path


root = Path(sys.argv[1])
asset_root = Path(sys.argv[2])
metadata_path = Path(sys.argv[3])
out_dir = Path(sys.argv[4])
version = sys.argv[5]
target_id = sys.argv[6]
asset_index = Path(sys.argv[7])
selected_sql_names = {item.strip() for item in sys.argv[8].split(",") if item.strip()}


def fail(message: str) -> None:
    raise SystemExit(f"package-wasix-extension-assets.sh: {message}")


data = json.loads(metadata_path.read_text(encoding="utf-8"))
extensions = data.get("extensions")
if not isinstance(extensions, list) or not extensions:
    fail(f"{metadata_path.relative_to(root)} must contain a non-empty extensions array")

rows: list[dict[str, object]] = []
for item in extensions:
    if not isinstance(item, dict):
        fail(f"{metadata_path.relative_to(root)} contains a non-object extension row")
    sql_name = item.get("sql-name")
    archive = item.get("archive")
    if not isinstance(sql_name, str) or not sql_name:
        fail(f"{metadata_path.relative_to(root)} contains an extension row without sql-name")
    if selected_sql_names and sql_name not in selected_sql_names:
        continue
    if not isinstance(archive, str) or not archive:
        fail(f"{metadata_path.relative_to(root)} row for {sql_name} is missing archive")
    source = asset_root / archive
    if not source.is_file():
        fail(f"missing WASIX extension archive for {sql_name}: {source.relative_to(root)}")
    if source.stat().st_size == 0:
        fail(f"WASIX extension archive for {sql_name} is empty: {source.relative_to(root)}")
    destination_name = f"liboliphaunt-wasix-{version}-extension-{sql_name}-{target_id}.tar.zst"
    destination = out_dir / destination_name
    shutil.copy2(source, destination)
    rows.append(
        {
            "sql_name": sql_name,
            "target": target_id,
            "kind": "wasix-runtime",
            "artifact": destination_name,
            "artifact_bytes": destination.stat().st_size,
        }
    )

if not rows:
    fail("no WASIX extension artifacts were staged")

with asset_index.open("w", encoding="utf-8", newline="") as handle:
    writer = csv.DictWriter(
        handle,
        delimiter="\t",
        fieldnames=["sql_name", "target", "kind", "artifact", "artifact_bytes"],
        lineterminator="\n",
    )
    writer.writeheader()
    writer.writerows(rows)

print(f"staged {len(rows)} WASIX exact-extension artifact(s) in {out_dir.relative_to(root)}")
PY

echo "wasixExtensionReleaseAssetDir=$out_dir"
