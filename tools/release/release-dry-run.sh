#!/usr/bin/env bash
set -euo pipefail
cd "$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
qualified=false
allow_dirty=false
products=''
head_ref=HEAD
head_set=false
args=()
while [ "$#" -gt 0 ]; do
  flag="$1"
  case "$flag" in
    --qualified-ci) qualified=true; shift; continue ;;
    --allow-dirty) allow_dirty=true; shift; continue ;;
    -h|--help)
      echo 'usage: release-dry-run.sh [--products-json JSON] [--head-ref REF] [--qualified-ci | --allow-dirty]'
      exit 0 ;;
    --products-json=*|--head-ref=*) value="${flag#*=}"; flag="${flag%%=*}"; shift ;;
    --products-json|--head-ref) value="${2:?value required for $flag}"; shift 2 ;;
    *) echo "unknown argument: $flag" >&2; exit 2 ;;
  esac
  [ -n "$value" ] || { echo "$flag requires a value" >&2; exit 2; }
  case "$flag" in
    --products-json)
      [ -z "$products" ] || { echo 'duplicate --products-json' >&2; exit 2; }
      products="$value" ;;
    --head-ref)
      [ "$head_set" = false ] || { echo 'duplicate --head-ref' >&2; exit 2; }
      head_set=true; head_ref="$value" ;;
  esac
  args+=("$flag" "$value")
done
if [ "$qualified" = true ] && { [ "$allow_dirty" = true ] || [ -z "$products" ]; }; then
  echo '--qualified-ci requires products and cannot be combined with --allow-dirty' >&2
  exit 2
fi
if [ -n "$products" ]; then
  bash tools/dev/bun.sh tools/release/product-tags.mts --products-json "$products" >/dev/null
fi
if [ "$qualified" = true ]; then
  bash tools/release/qualified-release-replay.sh --qualified-ci "$head_ref" "${RELEASE_HEAD_SHA:-}"
  bash .github/scripts/release-candidate.sh verify target/release-candidate/oliphaunt-release-candidate.json \
    --plan target/release-candidate/affected-plan/ci-plan.json --qualification-mode full-payload \
    --wasix-evidence-required "$WASIX_EVIDENCE_REQUIRED" --wasix-evidence-root target/release-candidate/wasix-evidence
else
  bash tools/release/release-check.sh
fi
if [ "${#args[@]}" -gt 0 ]; then bash tools/release/release-check-registries.sh "${args[@]}"; fi
