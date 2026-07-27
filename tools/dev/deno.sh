#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
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
