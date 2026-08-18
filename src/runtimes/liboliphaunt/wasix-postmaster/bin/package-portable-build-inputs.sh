#!/usr/bin/env bash

set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
repo_root="$(git -C "$project_root" rev-parse --show-toplevel)"
source "$project_root/lib/common.sh"

guest_dir="$(fresh_wasix_core_install_dir_for release-o3)"
sysroot_dir="$FRESH_WORK_ROOT/runtime/build/patched-wasixcc-sysroot"
probes_dir="$FRESH_WORK_ROOT/runtime/build/probes"
output_dir="$FRESH_WORK_ROOT/portable-inputs"
archive="$output_dir/wasix-postmaster-portable-build-inputs.tar.gz"

for required_dir in "$guest_dir" "$sysroot_dir" "$probes_dir"; do
  [ -d "$required_dir" ] && [ ! -L "$required_dir" ] || {
    printf 'missing regular portable build input directory: %s\n' "$required_dir" >&2
    exit 2
  }
done
[ -f "$guest_dir/guest-build.receipt" ] && [ ! -L "$guest_dir/guest-build.receipt" ] || {
  printf 'missing regular guest build receipt: %s\n' "$guest_dir/guest-build.receipt" >&2
  exit 2
}
[ -f "$sysroot_dir/.oliphaunt-patched-sysroots.manifest" ] || {
  printf 'missing patched sysroot carrier manifest: %s\n' "$sysroot_dir" >&2
  exit 2
}
compile_signatures=()
while IFS= read -r signature; do
  compile_signatures+=("$signature")
done < <(find "$probes_dir" -maxdepth 1 -type f \
  -name '.compile-signature*' -print | LC_ALL=C sort)
[ "${#compile_signatures[@]}" -gt 0 ] || {
  printf 'missing complete runtime capability probe signature: %s\n' "$probes_dir" >&2
  exit 2
}

actual_guest_identity="$(python3 "$project_root/lib/guest_build_provenance.py" identity "$guest_dir")"
expected_guest_identity="$(fresh_manifest_value "$guest_dir/guest-build.receipt" installed_closure_sha256)"
[ "$actual_guest_identity" = "$expected_guest_identity" ] || {
  echo 'portable guest bytes differ from their build receipt' >&2
  exit 2
}

mkdir -p "$output_dir"
[ ! -e "$archive" ] || {
  printf 'refusing to overwrite portable build inputs: %s\n' "$archive" >&2
  exit 2
}
stage="$(mktemp -d "$FRESH_WORK_ROOT/.portable-inputs-stage.XXXXXX")"
cleanup() {
  chmod -R u+w "$stage" 2>/dev/null || true
  rm -rf -- "$stage"
}
trap cleanup EXIT HUP INT TERM
mkdir -p "$stage/portable-inputs/install" "$stage/portable-inputs/runtime/build"
cp -a "$guest_dir" "$stage/portable-inputs/install/wasix-core-release-o3"
cp -a "$sysroot_dir" "$stage/portable-inputs/runtime/build/patched-wasixcc-sysroot"
cp -a "$probes_dir" "$stage/portable-inputs/runtime/build/probes"
"$repo_root/tools/dev/bun.sh" \
  "$repo_root/tools/release/materialize-release-symlinks.mjs" \
  "$stage/portable-inputs"

"$repo_root/tools/dev/bun.sh" "$repo_root/tools/release/archive_dir.mjs" \
  --keep-parent "$stage/portable-inputs" "$archive"
chmod 0444 "$archive"
printf 'packaged portable WASIX postmaster build inputs: %s\n' "$archive"
