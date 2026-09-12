#!/usr/bin/env bash
set -euo pipefail
root="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$root"
source database-resources/icu/tools/data.sh
oliphaunt_icu_install_canonical_data \
  "${OLIPHAUNT_ICU_DATA_ARCHIVE:-$root/target/oliphaunt-sources/checkouts/icu-data/icudt76l.dat}" \
  "$root/target/database-resources/icu/data/share/icu"
