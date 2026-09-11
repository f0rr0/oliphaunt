#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "package-liboliphaunt-icu-data.sh: must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

fail() {
  echo "package-liboliphaunt-icu-data.sh: $*" >&2
  exit 1
}

require() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

source_dir="${1:-}"
out_dir="${2:-}"
[ -n "$source_dir" ] && [ -n "$out_dir" ] ||
  fail "usage: database-resources/icu/tools/package-liboliphaunt-icu-data.sh SOURCE_DIR OUTPUT_DIR"
[ -d "$source_dir" ] || fail "missing portable ICU data directory: $source_dir"

require mktemp
require bun

source "$root/database-resources/icu/tools/data.sh"
if find "$source_dir" -type l -print -quit | grep -q .; then
  fail "portable ICU data directory must not contain symbolic links: $source_dir"
fi
oliphaunt_icu_files_data_ready "$source_dir" ||
  fail "portable ICU data directory has no ICU files payload: $source_dir"
[ "$#" -eq 2 ] || fail "expected SOURCE_DIR OUTPUT_DIR"
version="$(tools/dev/bun.sh tools/release/product-version.mts version database-resources)"
stem=database-resources
asset="${stem}-${version}-icu-data.tar.gz"
mkdir -p "$out_dir"

stage_root="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-icu-data.XXXXXX")"
partial="$out_dir/.${asset}.tmp.$$.tar.gz"
cleanup() {
  rm -rf "$stage_root"
  rm -f "$partial"
}
trap cleanup EXIT INT TERM HUP

# macOS exposes its per-user temporary directory through /var, which is a
# system-owned symlink to /private/var. Resolve only the fresh directory that
# mktemp created for this process; release-notices can then retain its strict
# rejection of arbitrary symlink ancestors supplied by callers.
stage_root="$(cd "$stage_root" && pwd -P)"
stage="$stage_root/${stem}-${version}-icu-data"

oliphaunt_icu_copy_files_data "$source_dir" "$stage/share/icu" ||
  fail "portable ICU data directory does not contain one canonical files-data payload"
oliphaunt_icu_files_data_ready "$stage/share/icu" ||
  fail "staged portable ICU data payload is incomplete"
tools/dev/bun.sh database-resources/contracts/icu-data.mts \
  "$stage/share/icu" \
  "$stage/manifest.properties"
tools/dev/bun.sh database-resources/icu/tools/write-icu-package-size-report.mts \
  "$stage/share/icu" \
  "$stage/package-size.tsv"

tools/dev/bun.sh tools/packaging/release-notices.mts stage "$stage" --profile native-icu-data

tools/packaging/archive-directory.mts "$stage" "$partial"
tools/dev/bun.sh tools/packaging/release-notices.mts check-archive "$partial" --profile native-icu-data
mv -f "$partial" "$out_dir/$asset"
echo "liboliphauntIcuDataReleaseAsset=$out_dir/$asset"
