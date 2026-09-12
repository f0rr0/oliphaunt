#!/usr/bin/env bash
set -euo pipefail
owner="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mode=checkout
if [[ "${1:-}" == --changes-only ]]; then mode=changes; shift; fi
[[ "$#" -ge 2 ]] || { echo 'usage: publication-controller.sh [--changes-only] SOURCE_SHA CONTROLLER_SHA [COMMAND ...]' >&2; exit 2; }
source_sha="$1"; controller_sha="$2"; shift 2
[[ "$source_sha" =~ ^[0-9a-f]{40}$ && "$controller_sha" =~ ^[0-9a-f]{40}$ ]] || { echo 'publication source and controller must be full commit SHAs' >&2; exit 2; }
if [[ "$mode" == checkout ]]; then bash "$owner/qualified-release-replay.sh" "$controller_sha" "$controller_sha"; fi
git merge-base --is-ancestor "$source_sha" "$controller_sha" || { echo 'publication source must be an ancestor of the controller' >&2; exit 2; }
scratch="$(mktemp)"
trap 'rm -f "$scratch"' EXIT
git diff --no-renames --name-only -z "$source_sha" "$controller_sha" > "$scratch"
OLIPHAUNT_PUBLICATION_CONTROLLER_JSON="$(node "$owner/publication-controller.mts" "$source_sha" "$controller_sha" "$mode" "$scratch")"
export OLIPHAUNT_PUBLICATION_CONTROLLER_JSON
rm -f "$scratch"
trap - EXIT
if [[ "$#" -gt 0 ]]; then exec "$@"; fi
echo "verified publication controller $controller_sha for frozen source $source_sha"
