#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"

print_path=0
refresh=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --print-path)
      print_path=1
      ;;
    --refresh)
      refresh=1
      ;;
    *)
      echo "usage: $0 [--print-path] [--refresh]" >&2
      exit 2
      ;;
  esac
  shift
done

fresh_ensure_dirs
fresh_require_command git

if [ -d "$BASELINE_DIR/.git" ]; then
  if [ "$refresh" -eq 1 ] || ! git -C "$BASELINE_DIR" rev-parse -q --verify "refs/tags/$POSTGRES_TAG" >/dev/null; then
    git -C "$BASELINE_DIR" fetch --depth=1 origin "refs/tags/$POSTGRES_TAG:refs/tags/$POSTGRES_TAG"
  fi
  git -C "$BASELINE_DIR" checkout -q --detach "$POSTGRES_TAG"
  git -C "$BASELINE_DIR" reset -q --hard "$POSTGRES_TAG"
else
  git clone --depth=1 --branch "$POSTGRES_TAG" "$POSTGRES_REMOTE" "$BASELINE_DIR"
fi

baseline_head="$(git -C "$BASELINE_DIR" rev-parse HEAD)"
report="$REPORT_DIR/baseline.md"
fresh_write_report_header "$report" "Clean PostgreSQL Baseline"
{
  printf '## Result\n\n'
  printf -- '- Source directory: `%s`\n' "$BASELINE_DIR"
  printf -- '- Upstream remote: `%s`\n' "$POSTGRES_REMOTE"
  printf -- '- Checked out ref: `%s`\n' "$POSTGRES_TAG"
  printf -- '- Commit: `%s`\n\n' "$baseline_head"
  printf '## Lineage Rule\n\n'
  printf 'This checkout is the clean upstream oracle. Do not apply PGlite patches here.\n'
} >>"$report"

if [ "$print_path" -eq 1 ]; then
  printf '%s\n' "$BASELINE_DIR"
else
  printf 'prepared clean PostgreSQL %s at %s\n' "$POSTGRES_TAG" "$BASELINE_DIR"
fi
