#!/usr/bin/env bash
set -euo pipefail
[ "$#" = 0 ] || { echo 'usage: write-affected-moon-target-matrices.sh' >&2; exit 2; }
while IFS= read -r name; do
  case "$name" in PROTO_*) unset "$name" ;; esac
done < <(compgen -e)
moon_bin="${MOON_BIN:-moon}"
expected="$(sed -n 's/^moon *= *"\([^"]*\)".*/\1/p' .prototools)"
if [ -z "$expected" ] || [ "$("$moon_bin" --version)" != "moon $expected" ]; then
  echo "Moon $expected is required" >&2; exit 1;
fi
query_dir="$(mktemp -d)"
trap 'rm -rf "$query_dir"' EXIT
query_args=(query tasks)
base="${MOON_BASE:-}"
head="${MOON_HEAD:-}"
if [[ -n "${base//[[:space:]]/}" && -n "${head//[[:space:]]/}" ]]; then
  query_args+=(--affected --upstream none --downstream direct)
fi
"$moon_bin" "${query_args[@]}" >"$query_dir/selected.json"
"$moon_bin" task-graph --json >"$query_dir/graph.json"
node .github/scripts/write-affected-moon-target-matrices.mts "$query_dir/selected.json" "$query_dir/graph.json"
