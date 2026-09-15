#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ "$#" != 0 ]]; then echo 'usage: bootstrap-registry-identities.sh (uses the approved workflow environment)' >&2; exit 2; fi
state="$(mktemp -d)"
trap 'rm -rf "$state"' EXIT
native() { bash tools/dev/bun.sh .github/scripts/bootstrap-registry-identities.mts "$1" "$state"; }
publisher() {
  bash tools/release/with-source.sh "${RELEASE_HEAD_SHA:-HEAD}" bash tools/dev/bun.sh tools/release/release-publish.mts "$1" "$state" "$2" \
    --bootstrap-identities --head-ref "$RELEASE_HEAD_SHA" --publication-lock "$PUBLICATION_LOCK_PATH" \
    --bootstrap-ledger "$BOOTSTRAP_LEDGER_PATH"
}
native --prepare
if jq -e 'any(.admittedPlan[]; .ecosystem == "npm")' "$state/context.json" >/dev/null; then
  transport_timeout="$(command -v timeout || command -v gtimeout)" || { echo 'GNU timeout is required for npm bootstrap' >&2; exit 1; }
fi
checkpoint() {
  local files count previous status
  shopt -s nullglob
  files=("$state"/operation-*.json)
  count="${#files[@]}"
  previous=0
  [[ ! -f "$state/checkpoint-count" ]] || previous="$(cat "$state/checkpoint-count")"
  (( count - previous >= 32 )) || return 0
  until mkdir "$state/checkpoint-lock" 2>/dev/null; do
    [[ ! -f "$state/abort" ]] || return 0
    sleep 0.1
  done
  status=0
  native --checkpoint || status=$?
  if [[ "$status" != 0 ]]; then : > "$state/checkpoint-failed"; : > "$state/abort"; fi
  rmdir "$state/checkpoint-lock"
  return "$status"
}
publish_carrier() {
  local index="$1" ecosystem="$2" admission tarball registry seconds
  if [[ "$ecosystem" == cargo ]]; then publisher bootstrap-cargo "$index"; return; fi
  publisher bootstrap-npm-before "$index" || return
  [[ ! -f "$state/operation-$index.json" && ! -f "$state/abort" ]] || return 0
  admission="$state/npm-$index.json"
  tarball="$(jq -r .tarball "$admission")" || return
  registry="$(jq -r .registry "$admission")" || return
  seconds="$(jq -r '.timeout / 1000 | floor' "$admission")" || return
  NPM_CONFIG_FETCH_RETRIES=0 "$transport_timeout" --kill-after=5s "${seconds}s" \
    npm publish "$tarball" --access public --provenance --registry "$registry" || true
  publisher bootstrap-npm-after "$index"
}
lane() (
  trap 'status=$?; if [[ "$status" != 0 ]]; then : > "$state/lane-failed"; : > "$state/abort"; fi; exit "$status"' EXIT
  ecosystem="$1"
  if [[ "$ecosystem" == cargo ]]; then
    unset NODE_AUTH_TOKEN NPM_BOOTSTRAP_TOKEN NPM_CONFIG__AUTH NPM_CONFIG__AUTHTOKEN NPM_CONFIG_USERCONFIG NPM_TOKEN
  else
    unset CARGO_REGISTRIES_CRATES_IO_TOKEN CARGO_REGISTRY_TOKEN CRATES_IO_BOOTSTRAP_TOKEN CRATES_IO_TRUST_CONFIG_TOKEN
  fi
  for index in $(jq -r --arg ecosystem "$ecosystem" '.admittedPlan | to_entries[] | select(.value.ecosystem == $ecosystem) | .key' "$state/context.json"); do
    [[ ! -f "$state/abort" ]] || break
    for dependency in $(jq -r --argjson index "$index" '.dependencies[$index][]' "$state/context.json"); do
      until [[ -f "$state/operation-$dependency.json" ]]; do
        [[ ! -f "$state/abort" ]] || exit 0
        sleep 0.1
      done
    done
    [[ ! -f "$state/abort" ]] || break
    status=0
    publish_carrier "$index" "$ecosystem" 2> "$state/stderr-$index" || status=$?
    cat "$state/stderr-$index" >&2
    echo "$status" > "$state/status-$index"
    if [[ "$status" != 0 ]]; then : > "$state/abort"; break; fi
    [[ ! -f "$state/abort" ]] || break
    checkpoint
  done
)
lane cargo & cargo_pid=$!
lane npm & npm_pid=$!
wait "$cargo_pid" || true
wait "$npm_pid" || true
# Flush accepted uploads even after a peer or checkpoint failure. A successful
# recovery preserves receipts without erasing the original failure.
native --checkpoint || : > "$state/checkpoint-failed"
native --finish
