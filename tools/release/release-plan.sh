#!/usr/bin/env bash
set -euo pipefail
cd "$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
if [[ "${1:-}" != --with-graph ]]; then
  exec bash tools/graph/with-projects.sh --exec bash tools/release/release-plan.sh --with-graph "$@"
fi
shift
request="$(mktemp -d)"
trap 'rm -rf "$request"' EXIT
bash tools/dev/bun.sh tools/release/release_plan.mts --history-inputs "$request" "$@"
{ IFS= read -r -d '' head; IFS= read -r -d '' base; } < "$request/refs"
if [[ -n "$head" ]]; then
  bash src/shared/product-metadata/with-product-history.sh "$PWD" "$head" "$base" "$request/graph.json" bash tools/dev/bun.sh tools/release/release_plan.mts "$@"
else
  bash tools/dev/bun.sh tools/release/release_plan.mts "$@"
fi
