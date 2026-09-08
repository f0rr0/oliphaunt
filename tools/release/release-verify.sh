#!/usr/bin/env bash
set -euo pipefail
lock=''
receipts=''
github_receipt=''
products_json=''
head_ref=HEAD
args=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help)
      echo 'usage: release-verify.sh [--products-json JSON] [--head-ref REF] [--publication-lock FILE --registry-receipts FILE --github-release-receipt FILE]'
      exit 0 ;;
    --publication-lock|--registry-receipts|--github-release-receipt)
      [ "$#" -ge 2 ] || { echo "$1 requires a value" >&2; exit 2; }
      case "$1" in
        --publication-lock) lock="$2" ;;
        --registry-receipts) receipts="$2" ;;
        --github-release-receipt) github_receipt="$2" ;;
      esac
      shift 2 ;;
    --publication-lock=*) lock="${1#*=}"; shift ;;
    --registry-receipts=*) receipts="${1#*=}"; shift ;;
    --github-release-receipt=*) github_receipt="${1#*=}"; shift ;;
    --head-ref)
      head_ref="${2:?--head-ref requires a value}"; args+=("$1" "$2"); shift 2 ;;
    --head-ref=*) head_ref="${1#*=}"; args+=("$1"); shift ;;
    --products-json)
      [ "$#" -ge 2 ] || { echo '--products-json requires a value' >&2; exit 2; }
      products_json="$2"; args+=("$1" "$2"); shift 2 ;;
    --products-json=*) products_json="${1#*=}"; args+=("$1"); shift ;;
    *) args+=("$1"); shift ;;
  esac
done
if [ -n "$lock$receipts$github_receipt" ]; then
  if [ -z "$lock" ] || [ -z "$receipts" ] || [ -z "$github_receipt" ] || [ -z "$products_json" ]; then
    echo '--publication-lock, --registry-receipts, --github-release-receipt and --products-json must be supplied together' >&2
    exit 2
  fi
  bun tools/release/registry-integrity.mts --lock "$lock" --products-json "$products_json" \
    --verify-receipts "$receipts" --sealed-receipts || exit 2
  bash "$(dirname "${BASH_SOURCE[0]}")/check-release-versions.sh" "${args[@]}" || exit 2
  bash "$(dirname "${BASH_SOURCE[0]}")/with-source.sh" "$head_ref" bash tools/release/verify-github-release-attestations.sh finalize --publication-lock "$lock" \
    "${args[@]}" --receipt "$github_receipt" || exit 2
else
  bash "$(dirname "${BASH_SOURCE[0]}")/check-release-versions.sh" "${args[@]}" --check-registries || exit 2
  bash "$(dirname "${BASH_SOURCE[0]}")/with-source.sh" "$head_ref" bash tools/release/verify-github-release-attestations.sh "${args[@]}" || exit 2
fi
