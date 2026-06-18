#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "package-liboliphaunt-aggregate-assets.sh: must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

fail() {
  echo "package-liboliphaunt-aggregate-assets.sh: $*" >&2
  exit 1
}

asset_dir="${OLIPHAUNT_LIBOLIPHAUNT_RELEASE_ASSETS:-target/liboliphaunt/release-assets}"
[ -d "$asset_dir" ] || fail "missing liboliphaunt release asset directory: $asset_dir"

version="$(python3 tools/release/product_metadata.py version liboliphaunt-native)"
checksum_file="$asset_dir/liboliphaunt-${version}-release-assets.sha256"

python3 - "$asset_dir" "$checksum_file" <<'PY'
from __future__ import annotations

import hashlib
import sys
from pathlib import Path

asset_dir = Path(sys.argv[1])
checksum_file = Path(sys.argv[2])
payloads = sorted(
    path
    for path in asset_dir.iterdir()
    if path.is_file()
    and path != checksum_file
    and (
        path.name.endswith(".tar.gz")
        or path.name.endswith(".tar.zst")
        or path.name.endswith(".zip")
        or path.name.endswith(".tsv")
    )
)
if not payloads:
    raise SystemExit(f"no liboliphaunt release payload assets found in {asset_dir}")

lines = []
for path in payloads:
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    lines.append(f"{digest}  ./{path.name}\n")
checksum_file.write_text("".join(lines), encoding="utf-8")
PY

tools/release/check_liboliphaunt_release_assets.py --asset-dir "$asset_dir"
