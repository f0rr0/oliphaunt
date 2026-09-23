#!/usr/bin/env bash
set -euo pipefail
[[ "$#" -ge 2 ]] || { echo 'usage: with-source.sh REF COMMAND [ARG...]' >&2; exit 2; }
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ref="$1"
shift
commit="$(git rev-parse --verify --end-of-options "$ref^{commit}")"
tree="$(git rev-parse "$commit^{tree}")"
checkout="$(git rev-parse --verify "HEAD^{commit}")"
OLIPHAUNT_GIT_SOURCE_JSON="$(jq -nc --arg ref "$ref" --arg commit "$commit" --arg tree "$tree" --arg checkout "$checkout" '{ref:$ref,commit:$commit,tree:$tree,checkout:$checkout}')"
export OLIPHAUNT_GIT_SOURCE_JSON
exec "$@"
