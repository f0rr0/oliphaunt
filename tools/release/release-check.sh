#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

scope=all
metadata=1
for argument in "$@"; do
  case "$argument" in
    --mutation-tests-only) metadata=0 ;;
    --mutation-scope=all|--mutation-scope=policy|--mutation-scope=release) scope="${argument#*=}" ;;
    -h|--help) echo 'usage: release-check.sh [--mutation-tests-only] [--mutation-scope=all|policy|release]'; exit 0 ;;
    *) echo "unexpected argument: $argument" >&2; exit 2 ;;
  esac
done
if [ "$metadata" = 1 ]; then bash tools/release/release-metadata-check.sh; fi

# Synthetic fixtures must not inherit live publication credentials or state.
while IFS= read -r name; do
  case "$name" in
    ACTIONS_*|GH_*|GITHUB_*|OLIPHAUNT_GITHUB_*|OLIPHAUNT_RELEASE_*|RELEASE_*|BOOTSTRAP_LEDGER_PATH|CI_RUN_ID|OLIPHAUNT_REQUIRE_GITHUB_CORE_REQUEST_JOURNAL)
      unset "$name" ;;
  esac
done < <(compgen -e)

roots=(tools/policy tools/release)
if [ "$scope" != all ]; then roots=("tools/$scope"); fi
inventory="$(mktemp)"
trap 'rm -f "$inventory"' EXIT
git ls-files -z --cached --others --exclude-standard -- "${roots[@]}" > "$inventory"
test_files=()
while IFS= read -r -d '' test_file; do
  case "$test_file" in
    tools/policy/assertions/workflow-security.test.*|tools/policy/ci-plan-*.test.*|tools/policy/workflow-moon-transfers.test.*|tools/release/release-candidate-sync.test.*) continue ;;
    *.test.mjs|*.test.mts) ;;
    *) continue ;;
  esac
  if [ ! -f "$test_file" ] || [ -L "$test_file" ]; then continue; fi
  test_files+=("./$test_file")
done < "$inventory"
[ "${#test_files[@]}" -gt 0 ] || { echo 'No release tests found' >&2; exit 1; }

bash tools/release/release-please-state.sh "$PWD" HEAD '' bash tools/release/with-source.sh HEAD bash tools/graph/with-projects.sh test --timeout=30000 "${test_files[@]}"
