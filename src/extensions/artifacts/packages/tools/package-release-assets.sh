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
for product in "${products[@]}"; do
  product="$(printf '%s' "$product" | xargs)"
  [ -n "$product" ] || continue
  validation_args+=(--require-extension-product "$product")
done
if [ "${#validation_args[@]}" -eq 1 ]; then
  validation_args+=(--require-extension-product all)
fi

tools/dev/bun.sh tools/release/build-extension-ci-artifacts.mjs --all --require-native --require-wasix
tools/dev/bun.sh tools/release/check-staged-artifacts.mjs "${validation_args[@]}"
