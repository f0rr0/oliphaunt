#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

validation_args=(--require-full-extension-targets)
products_csv="${OLIPHAUNT_EXTENSION_PACKAGE_PRODUCTS:-}"
IFS=',' read -r -a products <<<"$products_csv"
if ((${#products[@]} > 0)); then
  for product in "${products[@]}"; do
    product="$(printf '%s' "$product" | xargs)"
    [ -n "$product" ] || continue
    validation_args+=("$product")
  done
fi
if [ "${#validation_args[@]}" -eq 1 ]; then
  validation_args+=(all)
fi

tools/dev/bun.sh extensions/artifacts/packages/tools/build-extension-ci-artifacts.mts --all --require-native --require-wasix
tools/dev/bun.sh extensions/artifacts/packages/tools/check-carriers.mts "${validation_args[@]}"
