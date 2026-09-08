#!/usr/bin/env bash
set -euo pipefail
fail() { echo "$*" >&2; exit 2; }
if [[ "${1:-}" == --qualified-ci ]]; then
  shift
  [[ "${GITHUB_ACTIONS:-}" == true ]] || fail '--qualified-ci is valid only inside GitHub Actions'
  [[ "${CI_RUN_ID:-}" =~ ^[1-9][0-9]*$ ]] || fail '--qualified-ci requires a positive CI_RUN_ID'
  [[ "${GITHUB_REPOSITORY:-}" =~ [^[:space:]] ]] || fail '--qualified-ci requires GITHUB_REPOSITORY'
  [[ "${WASIX_EVIDENCE_REQUIRED:-}" == true || "${WASIX_EVIDENCE_REQUIRED:-}" == false ]] || fail '--qualified-ci requires WASIX_EVIDENCE_REQUIRED to be true or false'
fi
[[ "$#" == 2 ]] || fail 'usage: qualified-release-replay.sh [--qualified-ci] HEAD_REF EXPECTED_SHA'
head_ref="$1"
expected="$2"
[[ "$expected" =~ ^[0-9a-f]{40}$ ]] || fail 'qualified release replay requires an exact 40-character RELEASE_HEAD_SHA'
[[ "$(git rev-parse --verify 'HEAD^{commit}')" == "$expected" ]] || fail 'qualified release replay checkout HEAD mismatch'
[[ "$(git rev-parse --verify "$head_ref^{commit}")" == "$expected" ]] || fail 'qualified release replay head mismatch'
scratch="$(mktemp)"
trap 'rm -f "$scratch"' EXIT
git ls-files -v -z > "$scratch"
while IFS= read -r -d '' entry; do
  case "${entry:0:1}" in
    S|[a-z]) fail "qualified release replay rejects index suppression flags (assume-unchanged or skip-worktree): ${entry:2}" ;;
  esac
done < "$scratch"
git status --porcelain=v1 -z --untracked-files=all > "$scratch"
if [[ -s "$scratch" ]]; then
  echo 'qualified release replay requires a clean source checkout:' >&2
  while IFS= read -r -d '' entry; do printf '%s\n' "$entry" >&2; done < "$scratch"
  exit 2
fi
