#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
objects="$(git rev-parse --path-format=absolute --git-path objects)"
mkdir "$scratch/objects"
export GIT_OBJECT_DIRECTORY="$scratch/objects"
export GIT_ALTERNATE_OBJECT_DIRECTORIES="$objects${GIT_ALTERNATE_OBJECT_DIRECTORIES:+:$GIT_ALTERNATE_OBJECT_DIRECTORIES}"
export GIT_AUTHOR_NAME='Release Intent Test' GIT_COMMITTER_NAME='Release Intent Test'
export GIT_AUTHOR_EMAIL=release-intent@example.invalid GIT_COMMITTER_EMAIL=release-intent@example.invalid
tree="$(git rev-parse 'HEAD^{tree}')"
first="$(printf 'fix: validate release intent\n' | git commit-tree "$tree" -p HEAD)"
sibling="$(printf 'fix: sibling change\n' | git commit-tree "$tree" -p HEAD)"
script=.github/scripts/check-release-intent.sh
bash "$script" 'fix: validate release intent' HEAD "$first" main workflow_dispatch refs/heads/main --source-policy-only

reject() {
  local expected="$1"
  shift
  if bash "$script" 'fix: validate release intent' "$@" > "$scratch/rejected.log" 2>&1; then
    echo "Release intent accepted invalid comparison: $*" >&2
    exit 1
  fi
  grep -Fq "$expected" "$scratch/rejected.log"
}
reject 'base must resolve to the exact commit parent' HEAD^ "$first" main workflow_dispatch refs/heads/main
reject 'is not an ancestor' "$first" "$sibling" feature push refs/heads/feature
reject 'requires matching main branch and full ref' HEAD "$first" main workflow_dispatch refs/heads/diagnostic
merge="$(printf 'fix: merged source\n' | git commit-tree "$tree" -p "$first" -p "$sibling")"
reject 'requires an exact one-parent commit' "$first" "$merge" main workflow_dispatch refs/heads/main --source-policy-only
echo 'Release intent exact-parent and ancestry checks passed'

# Exercise both generated-PR and main-merge admission without live registries.
fixture="$scratch/release"
mkdir -p "$fixture/.github/scripts" "$fixture/tools/release" "$fixture/tools/dev"
cp "$script" .github/scripts/release-intent-data.mts "$fixture/.github/scripts/"
git -C "$fixture" init -q
git -C "$fixture" config user.name Fixture
git -C "$fixture" config user.email fixture@example.invalid
printf '%s' '{"changelog-sections":[{"type":"fix"}]}' > "$fixture/release-please-config.json"
printf '%s' '{"sdk":"0.2.1"}' > "$fixture/.release-please-manifest.json"
git -C "$fixture" add .
git -C "$fixture" commit -qm 'fix: initial SDK'
base="$(git -C "$fixture" rev-parse HEAD)"
printf '%s' '{"sdk":"0.2.2"}' > "$fixture/.release-please-manifest.json"
git -C "$fixture" commit -qam 'chore(release): fixture'
cat > "$fixture/tools/release/release-please-state.sh" <<'SH'
shift 2
exec "$@"
SH
cp "$fixture/tools/release/release-please-state.sh" "$fixture/tools/release/with-release-history.sh"
cat > "$fixture/tools/release/with-product-history.sh" <<'SH'
[[ "$1" == "$PWD" && "$2" == HEAD && "$3" == '' && "$4" == @workspace ]] || exit 8
shift 4
exec "$@"
SH
cat > "$fixture/tools/dev/bun.sh" <<'SH'
#!/usr/bin/env bash
case "$1:${2:-}" in
  tools/release/verify-release-commit.mts:--derive-products) echo '["oliphaunt-wasix-ts"]' ;;
  tools/release/verify-release-commit.mts:--products-json) exit 0 ;;
  tools/release/consumer-compatibility.mts:*)
    [[ "$2" == '["oliphaunt-wasix-ts"]' ]] || exit 8
    printf '%s\n' "$2" > "$CI_TEST_CONSUMER_CALL"
    exit "$CI_TEST_CONSUMER_STATUS" ;;
  *) exit 8 ;;
esac
SH
chmod +x "$fixture/tools/dev/bun.sh"
cat > "$fixture/tools/release/release-plan.sh" <<'SH'
touch "$CI_TEST_PLAN_CALL"
echo '{"releaseProducts":["oliphaunt-wasix-ts"]}'
SH
export CI_TEST_CONSUMER_CALL="$scratch/consumer-call" CI_TEST_PLAN_CALL="$scratch/plan-call"
for branch in release-please--branches--main main; do
  rm -f "$CI_TEST_PLAN_CALL" "$CI_TEST_CONSUMER_CALL"
  status=0
  (cd "$fixture"; CI_TEST_CONSUMER_STATUS=9 bash .github/scripts/check-release-intent.sh \
    'chore(release): fixture' "$base" HEAD "$branch") || status=$?
  [[ "$status" == 9 && -s "$CI_TEST_CONSUMER_CALL" && ! -e "$CI_TEST_PLAN_CALL" ]]
  (cd "$fixture"; CI_TEST_CONSUMER_STATUS=0 bash .github/scripts/check-release-intent.sh \
    'chore(release): fixture' "$base" HEAD "$branch")
  [[ -s "$CI_TEST_CONSUMER_CALL" && -e "$CI_TEST_PLAN_CALL" ]]
  rm -f "$CI_TEST_PLAN_CALL" "$CI_TEST_CONSUMER_CALL"
  (cd "$fixture"; MOON_BIN=/definitely-unavailable-moon CI_TEST_CONSUMER_STATUS=9 bash .github/scripts/check-release-intent.sh \
    'chore(release): fixture' "$base" HEAD "$branch" pull_request "refs/heads/$branch" --source-policy-only)
  [[ ! -e "$CI_TEST_CONSUMER_CALL" && ! -e "$CI_TEST_PLAN_CALL" ]]
done
echo 'Legacy release intent rejects incompatible consumers; native source policy leaves admission to authenticated Prepare'
status=0
(cd "$fixture"; CI_TEST_CONSUMER_STATUS=0 bash .github/scripts/check-release-intent.sh \
  'fix: manual version update' "$base" HEAD feature pull_request refs/heads/feature --source-policy-only \
  > "$scratch/manual-version.log" 2>&1) || status=$?
[[ "$status" == 1 ]]
rg -Fq 'Release Please manifest version bumps are release owned' "$scratch/manual-version.log"
normalized_head="$(git -C "$fixture" rev-parse HEAD)"
git -C "$fixture" commit --allow-empty -qm 'chore(release): extra commit'
status=0
(cd "$fixture"; CI_TEST_CONSUMER_STATUS=0 bash .github/scripts/check-release-intent.sh \
  'chore(release): fixture' "$base" HEAD release-please--branches--main pull_request refs/heads/release-please--branches--main --source-policy-only \
  > "$scratch/normalized-parent.log" 2>&1) || status=$?
[[ "$status" == 1 ]]
rg -Fq 'does not exactly match base' "$scratch/normalized-parent.log"
git -C "$fixture" reset --hard --quiet "$normalized_head"
echo 'Native source policy preserves manual-version and normalized single-parent guards'
base="$(git -C "$fixture" rev-parse HEAD)"
git -C "$fixture" commit --allow-empty -qm 'fix: publication controller'
rm -f "$CI_TEST_PLAN_CALL" "$CI_TEST_CONSUMER_CALL"
status=0
(cd "$fixture"; CI_TEST_CONSUMER_STATUS=9 CI_RELEASE_PRODUCTS_JSON='["oliphaunt-wasix-ts"]' \
  bash .github/scripts/check-release-intent.sh 'fix: publication controller' \
  "$base" HEAD main workflow_dispatch refs/heads/main) || status=$?
[[ "$status" == 9 && -s "$CI_TEST_CONSUMER_CALL" && ! -e "$CI_TEST_PLAN_CALL" ]]
rm -f "$CI_TEST_CONSUMER_CALL"
(cd "$fixture"; CI_TEST_CONSUMER_STATUS=9 CI_RELEASE_PRODUCTS_JSON='["oliphaunt-wasix-ts"]' \
  bash .github/scripts/check-release-intent.sh 'fix: diagnostic source' \
  "$base" HEAD diagnostic workflow_dispatch refs/heads/diagnostic)
[[ ! -e "$CI_TEST_CONSUMER_CALL" && -e "$CI_TEST_PLAN_CALL" ]]
echo 'Release intent: selected main dispatch validates consumers; feature diagnostics retain source checks'
base="$(git -C "$fixture" rev-parse HEAD)"
mkdir -p "$fixture/sdk"
printf '// harmless source maintenance\n' > "$fixture/sdk/source.rs"
git -C "$fixture" add sdk
git -C "$fixture" commit -qm 'chore: source maintenance'
rm -f "$CI_TEST_PLAN_CALL" "$CI_TEST_CONSUMER_CALL"
(cd "$fixture"; MOON_BIN=/definitely-unavailable-moon CI_TEST_CONSUMER_STATUS=0 \
  bash .github/scripts/check-release-intent.sh 'chore: source maintenance' \
  "$base" HEAD feature pull_request refs/heads/feature --source-policy-only)
[[ ! -e "$CI_TEST_PLAN_CALL" && ! -e "$CI_TEST_CONSUMER_CALL" ]]
echo 'Native source policy accepts a clean feature without path selection or Moon lookup'
