#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"

usage() {
  cat <<'EOF'
Usage: seal-wasix-linear-memory.sh [options]

Seal every installed WASIX WebAssembly module to the versioned product memory
ABI after all code-rewriting passes have completed.

Options:
  --install-dir DIR          WASIX PostgreSQL prefix (default: WASIX_INSTALL_DIR)
  --predecessor-receipt FILE Exact sealed-export structural receipt
  -h, --help                 Show this help
EOF
}

fail() {
  printf 'WASIX linear-memory sealer: %s\n' "$*" >&2
  exit 2
}

install_dir="$WASIX_INSTALL_DIR"
predecessor_receipt=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --install-dir|--predecessor-receipt)
      option="$1"
      shift
      [ "$#" -gt 0 ] || fail "$option requires a value"
      case "$option" in
        --install-dir) install_dir="$1" ;;
        --predecessor-receipt) predecessor_receipt="$1" ;;
      esac
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *) fail "unknown argument: $1" ;;
  esac
  shift
done

[ -n "$predecessor_receipt" ] || fail '--predecessor-receipt is required'
for command in bun find od sha256sum sort; do
  fresh_require_command "$command"
done
[ -d "$install_dir" ] && [ ! -L "$install_dir" ] ||
  fail "missing non-symlink install prefix: $install_dir"
install_dir="$(cd "$install_dir" && pwd -P)"
fresh_require_managed_generated_path "$install_dir" WASIX_INSTALL_DIR

[ "${FRESH_WASIX_PRIVATE_INSTALL_DIR:-}" = "$install_dir" ] && [ ! -e "$install_dir/guest-build.receipt" ] ||
  fail "memory sealing requires the producer private install directory"
stage="$install_dir/.oliphaunt-linear-memory.pending"
[ ! -e "$stage" ] && [ ! -L "$stage" ] || fail "private memory stage already exists"
mkdir -p "$stage/modules" "$stage/receipts"
trap 'rm -rf -- "$stage"' EXIT

[ -f "$predecessor_receipt" ] && [ ! -L "$predecessor_receipt" ] ||
  fail "missing regular predecessor receipt: $predecessor_receipt"
predecessor_receipt="$(cd "$(dirname "$predecessor_receipt")" && pwd -P)/$(basename "$predecessor_receipt")"
expected_predecessor="$install_dir/share/postgresql/wasix-postmaster.sealed-export.structure.receipt"
[ "$predecessor_receipt" = "$expected_predecessor" ] ||
  fail "predecessor receipt must be the canonical sealed-export receipt: $expected_predecessor"

memory_tool="$FRESH_MEMORY_PROFILE_BIN"
fresh_require_memory_profile_tool "$memory_tool" "$FRESH_POSTMASTER_EXECUTOR_BUILD_RECEIPT"
aggregate_destination="$install_dir/share/postgresql/wasix-postmaster.linear-memory-profile.receipt.json"
if [ -e "$aggregate_destination" ] || [ -L "$aggregate_destination" ]; then
  [ -f "$aggregate_destination" ] && [ ! -L "$aggregate_destination" ] ||
    fail "existing linear-memory receipt is not a regular file: $aggregate_destination"
  bun "$FRESH_ROOT/lib/sealed-export-chain.mts" \
    --install-root "$install_dir" \
    --project-root "$FRESH_ROOT" \
    --allow-linear-memory-descendant ||
    fail 'existing linear-memory descendant proof chain is invalid'
  module_list="$(bun "$FRESH_ROOT/lib/linear-memory-profile.mts" modules "$aggregate_destination")" ||
    fail 'could not read existing module list'
  while IFS= read -r relative; do
    "$memory_tool" verify "$install_dir/$relative" >/dev/null
  done <<< "$module_list"
  printf 'WASIX linear-memory profile already sealed: receipt=%s\n' \
    "$aggregate_destination"
  exit 0
fi

bun "$FRESH_ROOT/lib/sealed-export-chain.mts" \
  --install-root "$install_dir" \
  --project-root "$FRESH_ROOT" ||
  fail 'sealed-export predecessor proof chain is invalid'
profile_json="$($memory_tool --profile-json)" || fail 'could not read memory-tool profile'
predecessor_sha256="$(sha256sum "$predecessor_receipt" | awk '{print $1}')"
fresh_is_sha256 "$predecessor_sha256" || fail 'predecessor receipt hash is invalid'
predecessor_relative="${predecessor_receipt#"$install_dir"/}"

index="$stage/modules.tsv"
: >"$index"

module_count=0
module_paths="$stage/module-paths.nul"
find "$install_dir/bin" "$install_dir/lib" -type f -print0 | \
  LC_ALL=C sort -z >"$module_paths" ||
  fail 'could not enumerate the installed WebAssembly module closure'
while IFS= read -r -d '' module; do
  magic="$(od -An -tx1 -N4 "$module" | tr -d ' \n')"
  [ "$magic" = 0061736d ] || continue
  relative="${module#"$install_dir"/}"
  case "$relative" in
    ''|/*|*/../*|../*|*/./*|./*|*//*|*$'\t'*|*$'\n'*|*$'\r'*)
      fail "unsafe installed module path: $relative"
      ;;
  esac
  output="$stage/modules/$relative"
  receipt="$stage/receipts/$relative.json"
  mkdir -p "$(dirname "$output")" "$(dirname "$receipt")"
  "$memory_tool" seal --output "$output" --receipt "$receipt" "$module"
  chmod --reference="$module" "$output"
  printf '%s\t%s\n' "$relative" "${receipt#"$stage"/}" >>"$index"
  module_count=$((module_count + 1))
done <"$module_paths"
[ "$module_count" -gt 0 ] || fail 'no installed WebAssembly modules were found'

for required in \
  bin/initdb \
  bin/postgres \
  lib/libpq.so.5.18 \
  lib/postgresql/dict_snowball.so \
  lib/postgresql/plpgsql.so
do
  awk -F '\t' -v expected="$required" '$1 == expected { count += 1 } END { exit count == 1 ? 0 : 1 }' "$index" ||
    fail "required carrier module was not sealed exactly once: $required"
done

aggregate="$stage/wasix-postmaster.linear-memory-profile.receipt.json"
PROFILE_JSON="$profile_json" bun "$FRESH_ROOT/lib/linear-memory-profile.mts" aggregate \
  "$stage" "$index" "$predecessor_relative" "$predecessor_sha256" "$aggregate"

[ "$(sha256sum "$predecessor_receipt" | awk '{print $1}')" = "$predecessor_sha256" ] ||
  fail 'predecessor export receipt changed while modules were sealed'
while IFS=$'\t' read -r relative receipt_relative; do
  "$memory_tool" verify "$stage/modules/$relative" >/dev/null
done <"$index"

[ "$(sha256sum "$predecessor_receipt" | awk '{print $1}')" = "$predecessor_sha256" ] ||
  fail 'predecessor export receipt changed before transaction preparation'

while IFS=$'\t' read -r relative receipt_relative; do
  mv "$stage/modules/$relative" "$install_dir/$relative"
done <"$index"
mv "$aggregate" "$aggregate_destination"
printf 'sealed WASIX linear-memory profile: modules=%s receipt=%s\n' \
  "$module_count" "$aggregate_destination"
