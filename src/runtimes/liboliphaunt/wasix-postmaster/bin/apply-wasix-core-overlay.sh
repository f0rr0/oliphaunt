#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"
source "$FRESH_ROOT/lib/wasix-build-lock.sh"

fresh_ensure_dirs
fresh_require_command git
fresh_require_managed_generated_path "$WASIX_SRC_DIR" WASIX_SRC_DIR
fresh_lock_wasix_core_build "$WASIX_INSTALL_DIR"

"$FRESH_ROOT/bin/prepare-baseline.sh" >/dev/null

fresh_lock_postgres_baseline shared
baseline_fingerprint="$(fresh_postgres_baseline_fingerprint)"
fresh_require_postgres_baseline "$baseline_fingerprint" || {
  printf 'WASIX overlay refused an invalid PostgreSQL baseline: %s\n' "$BASELINE_DIR" >&2
  exit 2
}
baseline_head="$FRESH_POSTGRES_BASELINE_HEAD"
baseline_tree="$FRESH_POSTGRES_BASELINE_TREE"
overlay_digest="$(fresh_overlay_digest)"
signature_file="$WASIX_SRC_DIR/.fresh-wasix-core-signature"

if [ -d "$WASIX_SRC_DIR/.git" ] && [ ! -L "$WASIX_SRC_DIR/.git" ] &&
  [ -f "$signature_file" ] && [ ! -L "$signature_file" ]; then
  current_worktree_state="$(
    fresh_git_worktree_state_sha256 "$WASIX_SRC_DIR" ".fresh-wasix-core-signature"
  )" || current_worktree_state=""
  if fresh_require_manifest_value "$signature_file" schema \
      oliphaunt.wasix-postmaster.postgres-worktree.v2 >/dev/null 2>&1 &&
    fresh_require_manifest_value "$signature_file" baseline_fingerprint \
      "$baseline_fingerprint" >/dev/null 2>&1 &&
    fresh_require_manifest_value "$signature_file" baseline_head \
      "$baseline_head" >/dev/null 2>&1 &&
    fresh_require_manifest_value "$signature_file" baseline_tree \
      "$baseline_tree" >/dev/null 2>&1 &&
    fresh_require_manifest_value "$signature_file" overlay_sha256 \
      "$overlay_digest" >/dev/null 2>&1 &&
    fresh_require_manifest_value "$signature_file" worktree_state_sha256 \
      "$current_worktree_state" >/dev/null 2>&1
  then
    fresh_unlock_postgres_baseline
    printf 'WASIX core worktree already up to date at %s\n' "$WASIX_SRC_DIR"
    exit 0
  fi
fi

rm -rf "$WASIX_SRC_DIR"
# A standalone clone keeps overlay bookkeeping out of the immutable baseline's
# .git directory.  --no-local copies objects instead of linking them, so a
# later baseline refresh cannot invalidate this prepared source tree.
git clone --quiet --no-local "$BASELINE_DIR" "$WASIX_SRC_DIR"
git -C "$WASIX_SRC_DIR" checkout --quiet --detach "$baseline_head"
fresh_unlock_postgres_baseline

cp -R "$FRESH_ROOT/postgres/overlays/wasix-core/." "$WASIX_SRC_DIR/"

apply_patch_series() {
  local patches_dir="$1"
  local series_file="$2"
  local patch
  local patch_name

  [ -f "$series_file" ] && [ ! -L "$series_file" ] || {
    echo "missing regular PostgreSQL patch series: $series_file" >&2
    exit 2
  }
  while IFS= read -r patch_name || [ -n "$patch_name" ]; do
    case "$patch_name" in
      ''|'#'*) continue ;;
      */*)
        echo "unsafe PostgreSQL patch entry: $patch_name" >&2
        exit 2
        ;;
    esac
    patch="$patches_dir/$patch_name"
    [ -f "$patch" ] && [ ! -L "$patch" ] || {
      echo "missing regular PostgreSQL patch from series: $patch" >&2
      exit 2
    }
    git -C "$WASIX_SRC_DIR" apply --whitespace=nowarn "$patch"
  done <"$series_file"
}

apply_patch_series "$FRESH_ROOT/postgres/patches" \
  "$FRESH_ROOT/postgres/patches/series"
apply_patch_series \
  "$REPO_ROOT/src/runtimes/liboliphaunt/wasix/assets/build/postgres/patches" \
  "$FRESH_ROOT/postgres/main-optimizations.series"

worktree_state="$(
  fresh_git_worktree_state_sha256 "$WASIX_SRC_DIR" ".fresh-wasix-core-signature"
)" || exit
fresh_is_sha256 "$worktree_state" || {
  printf 'could not derive WASIX core worktree identity\n' >&2
  exit 2
}
{
  printf 'schema=oliphaunt.wasix-postmaster.postgres-worktree.v2\n'
  printf 'baseline_fingerprint=%s\n' "$baseline_fingerprint"
  printf 'baseline_head=%s\n' "$baseline_head"
  printf 'baseline_tree=%s\n' "$baseline_tree"
  printf 'overlay_sha256=%s\n' "$overlay_digest"
  printf 'worktree_state_sha256=%s\n' "$worktree_state"
} >"$signature_file"

report="$REPORT_DIR/wasix-core-overlay.md"
fresh_write_report_header "$report" "WASIX Core Overlay"
{
  printf '## Result\n\n'
  printf -- '- Worktree: `%s`\n' "$WASIX_SRC_DIR"
  printf -- '- Baseline fingerprint: `%s`\n' "$baseline_fingerprint"
  printf -- '- Baseline commit: `%s`\n' "$baseline_head"
  printf -- '- Baseline tree: `%s`\n' "$baseline_tree"
  printf -- '- Overlay digest: `%s`\n\n' "$overlay_digest"
  printf '## Patch Discipline\n\n'
  printf -- '- Production patch source is clean PostgreSQL `%s`, this overlay, and the compatible optimization subset owned by the main WASIX runtime.\n' "$POSTGRES_TAG"
  printf -- '- The overlay adds a WASIX configure template/header, narrow process/shared-memory port files, and small patch files for DSM, dynamic loading, and static libpq encoding linkage.\n'
  printf -- '- Single-user shims, loop rewrites, fake sockets, fake longjmp, fake poll, fake shared memory, disabled largefile, and disabled spinlocks are intentionally absent.\n'
} >>"$report"

printf 'applied WASIX core overlay at %s\n' "$WASIX_SRC_DIR"
