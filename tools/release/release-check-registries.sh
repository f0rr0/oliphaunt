#!/usr/bin/env bash
set -euo pipefail
require_identities=false
products_json=''
args=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help)
      echo 'usage: release-check-registries.sh [--products-json JSON] [--head-ref REF] [--registry-inventory-output FILE] [--require-identities]'
      exit 0 ;;
    --require-identities) require_identities=true; shift ;;
    --products-json)
      [ "$#" -ge 2 ] || { echo '--products-json requires a value' >&2; exit 2; }
      products_json="$2"; args+=("$1" "$2"); shift 2 ;;
    --products-json=*) products_json="${1#*=}"; args+=("$1"); shift ;;
    *) args+=("$1"); shift ;;
  esac
done
if [ "${#args[@]}" -eq 0 ]; then
  echo 'No release products selected; registry publication checks skipped.'
  exit 0
fi
if [ "$require_identities" = true ] && [ -z "$products_json" ]; then
  echo 'check-registries --require-identities requires --products-json' >&2; exit 2
fi
bash "$(dirname "${BASH_SOURCE[0]}")/check-release-versions.sh" "${args[@]}" --check-registries || exit 2
if [ "$require_identities" = true ]; then
  bun tools/release/check_registry_publication.mts --products-json "$products_json" --require-identities || exit 2
fi
