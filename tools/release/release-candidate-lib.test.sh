#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
source_root="$PWD"
bun test ./tools/release/release-candidate-lib.test.mts
repo="$(mktemp -d)"
trap 'rm -rf "$repo"' EXIT
cd "$repo"
git init --quiet
git -c user.name=Fixture -c user.email=fixture@example.invalid commit --quiet --allow-empty -m fixture
sha="$(git rev-parse HEAD)"
tree="$(git rev-parse 'HEAD^{tree}')"
plan="$repo/plan.json"
candidate="$repo/candidate.json"
printf '%s\n' '{"projects":[],"jobs":["affected"],"extension_package_products":[]}' > "$plan"
run() {
  env -i PATH="$PATH" HOME="$HOME" CI_HEAD_SHA="${head_sha:-$sha}" RELEASE_HEAD_SHA="${release_sha:-$sha}" \
    CI_PLAN_PATH="$plan" CI_QUALIFICATION_MODE="${qualification:-full-payload}" WASIX_RELEASE_REGRESSION_REQUIRED=false \
    GITHUB_REPOSITORY=f0rr0/oliphaunt GITHUB_WORKFLOW=CI \
    GITHUB_WORKFLOW_REF=f0rr0/oliphaunt/.github/workflows/ci.yml@refs/heads/main \
    GITHUB_RUN_ID=123 CI_RUN_ID=123 GITHUB_RUN_ATTEMPT=1 GITHUB_EVENT_NAME=push GITHUB_REF=refs/heads/main \
    CI_CHECKED_OUT_SHA=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb CI_SOURCE_TREE=cccccccccccccccccccccccccccccccccccccccc \
    bash "$source_root/.github/scripts/release-candidate.sh" "$@" > "$repo/result" 2>&1
}
reject() { if run "$@"; then echo 'Invalid candidate accepted' >&2; exit 1; fi; }
run write "$candidate"
jq -e --arg sha "$sha" --arg tree "$tree" '.sha==$sha and .tree==$tree' "$candidate" > /dev/null
verify=(verify "$candidate" --plan "$plan" --wasix-evidence-required false)
run "${verify[@]}"
head_sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa reject write "$candidate"
release_sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa reject "${verify[@]}"
jq -n --arg sha "$sha" '{projects:["oliphaunt-js"],jobs:["affected","js-sdk-package"],extension_package_products:[],qualification_mode:"selected-products",qualification_base_sha:null,qualification_head_sha:$sha,qualification_products:["oliphaunt-js"],tasks:["oliphaunt-js:package"]}' > "$plan"
qualification=selected-products run write "$candidate"
run "${verify[@]}" --qualification-mode release --products-json '["oliphaunt-js"]'
reject "${verify[@]}" --qualification-mode release --products-json '["oliphaunt-js","liboliphaunt-native"]'
rg -q 'missing qualification' "$repo/result"
printf '%s\n' '{"projects":["changed"],"jobs":["affected"],"extension_package_products":[]}' > "$plan"
reject "${verify[@]}"
echo 'Candidate commands: actual Git identity, selected scope and changed plan rejection passed'
