#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
bun test ./tools/release/validate-release-workflow-inputs.test.mts
output="$(mktemp)"
trap 'rm -f "$output"' EXIT
sha=84d90b9853530ab72e48a1aa6fb616aaed7a0dc6
validator="${OLIPHAUNT_TEST_BASH:-bash}"
validate() {
  env -i PATH="$PATH" HOME="$HOME" GITHUB_SHA="${4:-$sha}" GITHUB_REF="${5:-refs/heads/main}" \
    RELEASE_OPERATION="$1" RELEASE_COMMIT="${2:-}" RELEASE_APPROVAL_RUN_ID="${3:-}" \
    "$validator" .github/scripts/validate-release-workflow-inputs.sh > "$output" 2>&1
}
reject() {
  local message="$1"; shift
  if validate "$@"; then echo 'Release inputs unexpectedly accepted' >&2; exit 1; fi
  rg -q -F "$message" "$output"
}
validate prepare-release-pr
validate publish
validate prepare-release-pr "$sha"
validate prepare-release-pr "$(printf '%s' "$sha" | tr '[:lower:]' '[:upper:]')"
reject 'release_commit must be a full 40-character commit SHA' prepare-release-pr 84d90b9
reject 'release_commit must equal the exact workflow SHA' publish 1111111111111111111111111111111111111111
validate publish 1111111111111111111111111111111111111111 123
reject 'release operations must execute from refs/heads/main' publish '' 33989155433 "$sha" "refs/tags/oliphaunt-release-transport/$sha"
for approval in 0 latest 12.5; do
  reject 'approval_run_id is valid only' publish '' "$approval"
done
reject 'approval_run_id is valid only' prepare-release-pr '' 33989155433
reject 'Unsupported release operation' delete-everything
reject 'GITHUB_SHA must be a full 40-character commit SHA' publish '' '' 84d90b9
echo 'Release inputs: exact main identity and bounded recovery assertions passed'
