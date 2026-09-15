#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"
if [[ "${1:-}" == --help || "${1:-}" == -h ]]; then
  echo 'usage: publish-registries.sh --products-json JSON [--head-ref REF] [--publication-lock FILE] [--bootstrap-ledger DIRECTORY]'
  exit 0
fi
state="$(mktemp -d)"
pids=()
cleanup() { rm -rf "$state"; }
trap cleanup EXIT
args=("$@")
source_ref="${RELEASE_HEAD_SHA:-HEAD}"
for ((index=0; index<${#args[@]}; index++)); do
  case "${args[index]}" in
    --head-ref) source_ref="${args[index+1]:?--head-ref requires a value}" ;;
    --head-ref=*) source_ref="${args[index]#*=}" ;;
  esac
done
native() { bash tools/release/with-source.sh "$source_ref" bash tools/dev/bun.sh tools/release/release-publish.mts "$1" "$state" "${@:2}" "${args[@]}"; }
native registry-prepare
if jq -e 'any(.plan.operations[]; .ecosystem == "npm")' "$state/context.json" >/dev/null; then
  transport_timeout="$(command -v timeout || command -v gtimeout)" || { echo 'GNU timeout is required for npm publication' >&2; exit 1; }
fi
wait_dependencies() {
  local dependency
  for dependency in $(jq -r --argjson index "$1" '.schedule.dependencies[$index][]' "$state/context.json"); do
    until [[ -f "$state/operation-$dependency.json" ]]; do
      [[ ! -f "$state/abort" ]] || return 1
      sleep 0.1
    done
  done
  [[ ! -f "$state/abort" ]]
}
lane() (
  trap 'status=$?; if [[ "$status" != 0 ]]; then : > "$state/abort"; fi; exit "$status"' EXIT
  if [[ "$1" == cargo ]]; then
    for batch in $(jq -r '.schedule.cargoBatches | keys[]' "$state/context.json"); do
      first="$(jq -r --argjson batch "$batch" '.schedule.cargoBatches[$batch][0]' "$state/context.json")"
      wait_dependencies "$first"
      native registry-cargo "$batch"
    done
  else
    for index in $(jq -r --arg ecosystem "$1" '.plan.operations[] | select(.ecosystem == $ecosystem) | .operationOrder' "$state/context.json"); do
      wait_dependencies "$index"
      if [[ "$1" == maven ]]; then
        native registry-maven "$index"
      else
        native registry-npm-before "$index"
        [[ ! -f "$state/abort" ]] || exit 1
        [[ ! -f "$state/operation-$index.json" ]] || continue
        admission="$state/npm-$index.json"
        tarball="$(jq -r .tarball "$admission")"
        registry="$(jq -r .registry "$admission")"
        seconds="$(jq -r '.timeout / 1000 | floor' "$admission")"
        status=0
        NPM_CONFIG_FETCH_RETRIES=0 "$transport_timeout" --kill-after=5s "${seconds}s" \
          npm publish "$tarball" --access public --provenance --registry "$registry" || status=$?
        native registry-npm-after "$index"
        if [[ "$status" != 0 ]]; then echo "npm operation $index reconciled after exit $status"; fi
      fi
    done
  fi
)
# A failed lane stops new admissions. Existing mutations finish and reconcile;
# Cargo's native batch retains its token until its in-flight upload has drained.
for ecosystem in cargo npm maven; do lane "$ecosystem" & pids+=("$!"); done
result=0
for pid in "${pids[@]}"; do wait "$pid" || result=$?; done
[[ "$result" == 0 ]] || exit "$result"
native registry-finish
