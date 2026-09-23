#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
bun test ./tools/release/audit-github-release-controls.test.mts
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
fixtures=tools/release/fixtures/github-release-controls
jq '.environments["release-bootstrap"].secretNames = ["RELEASE_TAG_APP_CLIENT_ID", "RELEASE_TAG_APP_PRIVATE_KEY"]' "$fixtures/desired-solo.json" > "$scratch/idle.json"
bun tools/release/audit-github-release-controls.mts --fixture "$scratch/idle.json" --governance solo > "$scratch/result"
rg -q -F '(governance=solo, bootstrap=idle)' "$scratch/result"
jq '.repository.allow_merge_commit = true' "$fixtures/desired-solo.json" > "$scratch/warning.json"
bun tools/release/audit-github-release-controls.mts --fixture "$scratch/warning.json" --governance solo --bootstrap-state ready > "$scratch/result"
rg -q 'WARN repository.merge-commit:' "$scratch/result"
status=0
bun tools/release/audit-github-release-controls.mts --fixture "$fixtures/current-bad.json" --governance solo --bootstrap-state ready > "$scratch/result" 2>&1 || status=$?
[[ "$status" == 1 ]]
rg -q 'Summary: [0-9]+ PASS, [0-9]+ WARN, [1-9][0-9]* FAIL' "$scratch/result"
echo 'GitHub controls CLI: idle default, nonblocking warnings and blocking failures passed'
