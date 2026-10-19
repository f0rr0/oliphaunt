#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
fixture=.github/scripts/write-affected-moon-target-matrices.test.mts
bash tools/dev/bun.sh "$fixture" prepare "$scratch"
cat >"$scratch/moon" <<'MOON'
#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >>"$QUERY_LOG"
case "$1" in
  --version) printf 'moon %s\n' "$QUERY_VERSION" ;;
  query)
    if read -r unexpected; then echo "query inherited stdin: $unexpected" >&2; exit 2; fi
    cat "$QUERY_FILE"; exit "${QUERY_EXIT:-0}" ;;
  task-graph) cat "$QUERY_GRAPH" ;;
  *) exit 2 ;;
esac
MOON
chmod +x "$scratch/moon"
export GITHUB_OUTPUT="$scratch/github-output" MOON_BIN="$scratch/moon"
export QUERY_FILE="$scratch/query.json" QUERY_GRAPH="$scratch/graph.json" QUERY_LOG="$scratch/commands"
QUERY_VERSION=$(cat "$scratch/version")
export QUERY_VERSION QUERY_EXIT=0 MOON_BASE='' MOON_HEAD=''
unset CI_PLAN_PATH CI_QUALIFICATION_MODE
invoke() {
  rm -f "$GITHUB_OUTPUT" "$QUERY_LOG"
  bash .github/scripts/write-affected-moon-target-matrices.sh <<< 'caller input must not replace the requested commit range'
}
MOON_BASE=base MOON_HEAD=head invoke
bash tools/dev/bun.sh "$fixture" verify "$scratch"
invoke
grep -Fxq 'query tasks' "$QUERY_LOG"
CI_PLAN_PATH="$scratch/plan.json" CI_QUALIFICATION_MODE=selected-products MOON_BASE=base MOON_HEAD=head invoke
grep -Fxq 'query tasks' "$QUERY_LOG"
grep -Fxq 'check_count=0' "$GITHUB_OUTPUT"
grep -Fxq 'test_count=1' "$GITHUB_OUTPUT"
grep -q '"requires_rust":true' "$GITHUB_OUTPUT"
status=0
QUERY_EXIT=7 invoke || status=$?
[[ "$status" == 7 ]]
if grep -q task-graph "$QUERY_LOG"; then exit 1; fi
printf '{"tasks":' >"$QUERY_FILE"
if invoke 2>"$scratch/error"; then echo 'accepted truncated Moon JSON' >&2; exit 1; fi
grep -q 'returned invalid JSON' "$scratch/error"
