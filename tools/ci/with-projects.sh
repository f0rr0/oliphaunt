#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
while IFS= read -r name; do
  case "$name" in PROTO_*) unset "$name" ;; esac
done < <(compgen -e)
moon_bin="${MOON_BIN:-moon}"
expected=$(sed -n 's/^moon *= *"\([^"]*\)".*/\1/p' .prototools)
if [[ -z "$expected" || "$("$moon_bin" --version)" != "moon $expected" ]]; then
  echo "Moon $expected is required" >&2; exit 1
fi
projects="$(mktemp)"
trap 'rm -f "$projects"' EXIT
export OLIPHAUNT_MOON_PROJECTS_FILE="$projects"
"$moon_bin" query projects > "$projects"
if [[ "${1:-}" == --exec ]]; then
  shift
  "$@"
else
  bash tools/dev/bun.sh "$@"
fi
