#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source_dir="${1:?PostgreSQL source directory required}"
series="${2:?ordered patch series required}"
while IFS= read -r entry || [ -n "$entry" ]; do
  case "$entry" in
    ''|'#'*) continue ;;
    /*|*..*|*\\*) echo "unsafe PostgreSQL patch path: $entry" >&2; exit 2 ;;
  esac
  patch="$repo_root/$entry"
  [ -f "$patch" ] && [ ! -L "$patch" ] || {
    echo "missing regular PostgreSQL patch: $patch" >&2; exit 2;
  }
  if [ "${3:-}" = "--context-fuzz" ]; then
    # The existing embedded WASIX series contains upstream-context offsets.
    (cd "$source_dir" && patch --batch --forward --no-backup-if-mismatch -p1 < "$patch")
  else
    git -C "$source_dir" apply --whitespace=error-all "$patch"
  fi
done < "$series"
