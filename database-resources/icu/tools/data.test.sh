#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
source database-resources/icu/tools/data.sh
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
archive="${OLIPHAUNT_ICU_DATA_ARCHIVE:-$scratch/canonical.dat}"
if [ -z "${OLIPHAUNT_ICU_DATA_ARCHIVE:-}" ]; then
  printf abc > "$archive"
  oliphaunt_icu_canonical_data_sha256() {
    printf '%s\n' 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  }
fi
mkdir "$scratch/bin"
for tool in basename find grep sort rm mkdir cp mv; do
  ln -s "$(command -v "$tool")" "$scratch/bin/$tool"
done
printf corrupt > "$scratch/corrupt.dat"
for hasher in sha256sum shasum; do
  command -v "$hasher" >/dev/null || continue
  ln -s "$(command -v "$hasher")" "$scratch/bin/$hasher"
  (
    export PATH="$scratch/bin"
    oliphaunt_icu_require_canonical_data "$archive"
    oliphaunt_icu_install_canonical_data "$archive" "$scratch/installed"
    for invalid in "$scratch/missing.dat" "$scratch/corrupt.dat"; do
      if oliphaunt_icu_install_canonical_data "$invalid" "$scratch/installed" > "$scratch/error" 2>&1; then
        echo "Invalid archive accepted: $invalid" >&2; exit 1
      fi
      oliphaunt_icu_require_canonical_data "$scratch/installed/icudt76l.dat"
    done
    if oliphaunt_icu_sha256 "$scratch/missing.dat" 2>/dev/null; then
      echo "Hashing a missing file succeeded" >&2; exit 1
    fi
  )
  rm "$scratch/bin/$hasher"
done
if PATH="$scratch/bin" oliphaunt_icu_require_canonical_data "$archive" 2> "$scratch/error"; then
  echo "Hashing succeeded without a hash command" >&2; exit 1
fi
grep -q "requires sha256sum or shasum" "$scratch/error"
