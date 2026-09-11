#!/usr/bin/env bash
set -euo pipefail
root="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$root"
data="${OLIPHAUNT_ICU_DATA_DIR:-$root/target/database-resources/icu/data/share/icu}"
bash database-resources/icu/tools/package-liboliphaunt-icu-data.sh "$data" "$root/target/database-resources/release-assets"
bun database-resources/tools/package-carriers.mts
