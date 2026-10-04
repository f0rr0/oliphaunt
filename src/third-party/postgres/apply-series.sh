#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
[ "$#" -eq 2 ] || { echo "usage: $0 SOURCE_DIRECTORY PATCH_SERIES" >&2; exit 2; }
source_dir="${1:?PostgreSQL source directory required}"
source_dir="$(cd "$source_dir" && pwd -P)"
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
  # Generated source trees may be nested inside the Oliphaunt checkout.
  # Do not discover that enclosing Git worktree and silently skip hunks.
  GIT_CEILING_DIRECTORIES="$(dirname "$source_dir")" \
    git -C "$source_dir" apply --whitespace=error-all "$patch"
done < "$series"
