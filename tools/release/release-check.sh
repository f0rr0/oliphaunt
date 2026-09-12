#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

metadata=1
for argument in "$@"; do
  case "$argument" in
    --mutation-tests-only) metadata=0 ;;
    -h|--help) echo 'usage: release-check.sh [--mutation-tests-only]'; exit 0 ;;
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

inventory="$(mktemp)"
trap 'rm -f "$inventory"' EXIT
git ls-files -z --cached --others --exclude-standard -- tools/release > "$inventory"
test_files=()
shell_tests=()
while IFS= read -r -d '' test_file; do
  case "$test_file" in
    tools/release/prepare-release-candidate.test.*) continue ;;
    *.test.sh|*.test.mjs|*.test.mts) ;;
    *) continue ;;
  esac
  if [ ! -f "$test_file" ] || [ -L "$test_file" ]; then continue; fi
  if [[ "$test_file" == *.test.sh ]]; then
    shell_tests+=("$test_file")
    continue
  fi
  if [[ -f "${test_file%.*}.sh" ]]; then
    continue
  fi
  test_files+=("./$test_file")
done < "$inventory"
[ "${#test_files[@]}" -gt 0 ] || { echo 'No release tests found' >&2; exit 1; }

bash tools/release/release-please-state.sh "$PWD" HEAD bash tools/release/with-source.sh HEAD bash tools/ci/with-projects.sh test --timeout=30000 "${test_files[@]}"
for shell_test in "${shell_tests[@]}"; do bash "$shell_test"; done
