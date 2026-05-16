#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$ROOT/../.." && pwd)"
UPSTREAM_PGSRC="${UPSTREAM_PGSRC:-$REPO_ROOT/assets/checkouts/postgres-pglite}"
PATCHED_PGSRC="${PATCHED_PGSRC:-$ROOT/work/postgres-pglite-wasix-src}"
FRESH_ROOT="${FRESH_ROOT:-$ROOT/experiments/fresh-wasix-postgres}"
OVERLAY_DIR="${OVERLAY_DIR:-$FRESH_ROOT/overlays/wasix-core}"
PATCH_DIR="${PATCH_DIR:-$FRESH_ROOT/patches}"
POSTGRES_PGLITE_COMMIT="${POSTGRES_PGLITE_COMMIT:-$(git -C "$UPSTREAM_PGSRC" rev-parse HEAD)}"

overlay_digest() {
  {
    if [ -d "$OVERLAY_DIR" ]; then
      find "$OVERLAY_DIR" -type f | sort | while IFS= read -r path; do
        printf '%s\n' "${path#$OVERLAY_DIR/}"
        shasum -a 256 "$path"
      done
    fi
    if [ -d "$PATCH_DIR" ]; then
      find "$PATCH_DIR" -type f -name '*.patch' | sort | while IFS= read -r path; do
        printf '%s\n' "${path#$PATCH_DIR/}"
        shasum -a 256 "$path"
      done
    fi
  } | shasum -a 256 | awk '{print $1}'
}

PATCH_SHA="$(overlay_digest)"
HEAD_FILE="$PATCHED_PGSRC/.pglite-oxide-source-head"
PATCH_FILE="$PATCHED_PGSRC/.pglite-oxide-patch-sha256"

if [ -e "$PATCHED_PGSRC/.git" ] \
  && [ -f "$HEAD_FILE" ] \
  && [ -f "$PATCH_FILE" ] \
  && [ "$(cat "$HEAD_FILE")" = "$POSTGRES_PGLITE_COMMIT" ] \
  && [ "$(cat "$PATCH_FILE")" = "$PATCH_SHA" ]; then
  echo "reusing patched PostgreSQL WASIX core source at $PATCHED_PGSRC"
  exit 0
fi

test -d "$UPSTREAM_PGSRC/.git"
test -d "$OVERLAY_DIR"
test -d "$PATCH_DIR"

git -C "$UPSTREAM_PGSRC" worktree remove --force "$PATCHED_PGSRC" >/dev/null 2>&1 || true
rm -rf "$PATCHED_PGSRC"
git -C "$UPSTREAM_PGSRC" worktree prune
git -C "$UPSTREAM_PGSRC" worktree add --detach "$PATCHED_PGSRC" "$POSTGRES_PGLITE_COMMIT"

cp -R "$OVERLAY_DIR/." "$PATCHED_PGSRC/"
find "$PATCH_DIR" -type f -name '*.patch' | sort | while IFS= read -r patch; do
  git -C "$PATCHED_PGSRC" apply --whitespace=nowarn "$patch"
done

printf '%s' "$POSTGRES_PGLITE_COMMIT" > "$HEAD_FILE"
printf '%s' "$PATCH_SHA" > "$PATCH_FILE"
echo "prepared patched PostgreSQL WASIX core source at $PATCHED_PGSRC"
