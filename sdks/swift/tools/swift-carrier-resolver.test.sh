#!/usr/bin/env bash
set -euo pipefail
tools="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
bun "$tools/swift-carrier-resolver.test.mts" "$scratch"
bun "$tools/render-extension-products.mts" --carrier "$scratch/sql-only-carrier.json" \
  --extensions pgtap --cache-dir "$scratch/sql-cache" --allow-file-urls --offline \
  --base-package-version 0.1.0 --base-package-path "$tools/.." --output-dir "$scratch/sql-cli"
diff -ru "$scratch/sql-only" "$scratch/sql-cli"
if bun "$tools/render-extension-products.mts" --carrier "$scratch/tampered.json" \
  --extensions postgis --cache-dir "$scratch/tampered-cache" --allow-file-urls \
  --base-package-version 0.1.0 --output-dir "$scratch/tampered-cli" > "$scratch/cli.log" 2>&1; then
  echo 'tampered carrier unexpectedly rendered' >&2
  exit 1
fi
grep -q 'checksum mismatch' "$scratch/cli.log"
