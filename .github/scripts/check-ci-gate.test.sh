#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
output="$(mktemp)"
trap 'rm -f "$output"' EXIT
gate() {
  env -i PATH="$PATH" HOME="$HOME" NEEDS_JSON="$2" SELECTED_JOBS_JSON="$3" \
    REQUIRED_JOBS_JSON="$3" GATE_LABEL='test gate' \
    bun .github/scripts/check-ci-gate.mts "$1" > "$output" 2>&1
}
reject() {
  local message="$1"; shift
  if gate "$@"; then echo 'CI gate accepted invalid state' >&2; exit 1; fi
  rg -q -F "$message" "$output"
}
gate selected '{}' '[]'
gate selected '{"android":{"result":"success"},"ios":{"result":"success"}}' '["ios","android","ios"]'
for result in skipped failure cancelled; do
  reject "ios=$result" selected "{\"ios\":{\"result\":\"$result\"}}" '["ios"]'
done
reject 'ios=missing' selected '{}' '["ios"]'
reject 'must be a JSON string array' selected '{}' '"ios"'
reject 'resolve=skipped' required '{"resolve":{"result":"skipped"}}' '["resolve"]'
reject 'usage: check-ci-gate.mts [selected|required]' allow-skipped '{}' '["ios"]'
echo 'CI gate: only successful selected and required jobs pass'
