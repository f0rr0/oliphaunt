#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if ! root="$(git -C "$script_dir" rev-parse --show-toplevel 2>/dev/null)"; then
  # A Docker bind mount of a linked Git worktree can expose the source tree
  # without the external gitdir named by its `.git` file. Keep the pinned
  # launcher usable there, while still requiring the repository's own root
  # markers rather than accepting an arbitrary directory.
  root="$script_dir"
  while [ "$root" != "/" ]; do
    if [ -f "$root/package.json" ] && [ -f "$root/.prototools" ] &&
       [ -f "$root/tools/dev/install-pinned-js-runtime.sh" ]; then
      break
    fi
    root="$(dirname "$root")"
  done
  if [ "$root" = "/" ]; then
    echo "must run inside the Oliphaunt git checkout" >&2
    exit 1
  fi
fi
cd "$root"

fail() {
  echo "$1" >&2
  exit 1
}

proto_version() {
  local tool="$1"
  awk -F '=' -v tool="$tool" '
    $1 ~ "^[[:space:]]*" tool "[[:space:]]*$" {
      value=$2
      gsub(/^[[:space:]"]+|[[:space:]"]+$/, "", value)
      print value
      found=1
    }
    END { if (!found) exit 1 }
  ' .prototools
}

version="$(proto_version deno)"
if command -v deno >/dev/null 2>&1; then
  installed_version="$(deno --version 2>/dev/null | awk 'NR == 1 { print $2 }')"
  if [[ "$installed_version" == "$version" ]]; then
    exec deno "$@"
  fi
fi
pinned_deno="$(bash tools/dev/install-pinned-js-runtime.sh deno --expected-version "$version")"
exec "$pinned_deno" "$@"
