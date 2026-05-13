#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"

fresh_ensure_dirs
fresh_require_command git

lock_dir="$FRESH_WORK_ROOT/.overlay.lock"
lock_waits=0
until mkdir "$lock_dir" 2>/dev/null; do
  lock_waits=$((lock_waits + 1))
  if [ "$lock_waits" -gt 300 ]; then
    echo "timed out waiting for overlay lock: $lock_dir" >&2
    exit 2
  fi
  sleep 0.2
done
trap 'rmdir "$lock_dir" 2>/dev/null || true' EXIT

"$FRESH_ROOT/bin/prepare-baseline.sh" >/dev/null

baseline_head="$(git -C "$BASELINE_DIR" rev-parse HEAD)"
overlay_digest="$(fresh_overlay_digest)"
signature="$baseline_head:$overlay_digest"
signature_file="$WASIX_SRC_DIR/.fresh-wasix-core-signature"

if [ -f "$signature_file" ] && [ "$(cat "$signature_file")" = "$signature" ]; then
  printf 'WASIX core worktree already up to date at %s\n' "$WASIX_SRC_DIR"
  exit 0
fi

if [ -e "$WASIX_SRC_DIR/.git" ] || [ -f "$WASIX_SRC_DIR/.git" ]; then
  git -C "$BASELINE_DIR" worktree remove --force "$WASIX_SRC_DIR" >/dev/null 2>&1 || rm -rf "$WASIX_SRC_DIR"
else
  rm -rf "$WASIX_SRC_DIR"
fi

git -C "$BASELINE_DIR" worktree prune
git -C "$BASELINE_DIR" worktree add --detach "$WASIX_SRC_DIR" "$baseline_head"

cp -R "$FRESH_ROOT/overlays/wasix-core/." "$WASIX_SRC_DIR/"

if [ -d "$FRESH_ROOT/patches" ]; then
  find "$FRESH_ROOT/patches" -type f -name '*.patch' | sort | while IFS= read -r patch; do
    git -C "$WASIX_SRC_DIR" apply --whitespace=nowarn "$patch"
  done
fi

printf '%s' "$signature" >"$signature_file"

report="$REPORT_DIR/wasix-core-overlay.md"
fresh_write_report_header "$report" "WASIX Core Overlay"
{
  printf '## Result\n\n'
  printf -- '- Worktree: `%s`\n' "$WASIX_SRC_DIR"
  printf -- '- Baseline commit: `%s`\n' "$baseline_head"
  printf -- '- Overlay digest: `%s`\n\n' "$overlay_digest"
  printf '## Patch Discipline\n\n'
  printf -- '- Production patch source is clean PostgreSQL `%s` plus this overlay.\n' "$POSTGRES_TAG"
  printf -- '- The overlay adds a WASIX configure template/header, narrow process/shared-memory port files, and small patch files for DSM, dynamic loading, and static libpq encoding linkage.\n'
  printf -- '- PGlite shims, loop rewrites, fake sockets, fake longjmp, fake poll, fake shared memory, disabled largefile, and disabled spinlocks are intentionally absent.\n'
} >>"$report"

printf 'applied WASIX core overlay at %s\n' "$WASIX_SRC_DIR"
