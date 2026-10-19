#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"
directory="${1:?expected observation directory}"
bash tools/dev/bun.sh tools/ci/ci-plan-test-observations.mts "$directory"
unset MOON_BASE MOON_HEAD
export MOON_CACHE=off
# Each request writes its own file. Four workers bound memory and preserve all
# graph/affected proofs while avoiding serial workspace startup for every case.
# NUL records preserve paths, and affected queries carry an ignored placeholder
# because BSD xargs does not preserve a trailing empty argument consistently.
while IFS=$'\t' read -r kind id target; do
  printf '%s\0%s\0%s\0' "$kind" "$id" "$target"
done < "$directory/requests.tsv" | xargs -0 -n 3 -P 4 bash -eu -c '
  directory=$1 moon_bin=$2 kind=$3 id=$4 target=$5
  case "$kind" in
    affected)
      "$moon_bin" query affected stdin --upstream none --downstream deep \
        < "$directory/affected-$id.input" > "$directory/affected-$id.json" ;;
    task) "$moon_bin" task-graph "$target" --json > "$directory/task-$id.json" ;;
    *) echo "unexpected test observation kind: $kind" >&2; exit 1 ;;
  esac
' ci-observation "$directory" "${MOON_BIN:-moon}"
