#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

fail() {
  echo "package-mobile-release-assets.sh: $*" >&2
  exit 1
}

targets_csv="${OLIPHAUNT_EXTENSION_PACKAGE_NATIVE_TARGETS:-}"
[ -n "$targets_csv" ] || fail "OLIPHAUNT_EXTENSION_PACKAGE_NATIVE_TARGETS must list one or more native targets"

products_csv="${OLIPHAUNT_EXTENSION_PACKAGE_PRODUCTS:-}"
args=()
validation_args=()
if [ -z "$products_csv" ]; then
  fail "OLIPHAUNT_EXTENSION_PACKAGE_PRODUCTS must list selected exact-extension products for mobile packaging"
fi
IFS=',' read -r -a products <<<"$products_csv"
for product in "${products[@]}"; do
  product="$(printf '%s' "$product" | xargs)"
  [ -n "$product" ] || continue
  args+=("$product")
  validation_args+=(--require-extension-product "$product")
done

[ "${#args[@]}" -gt 0 ] || fail "OLIPHAUNT_EXTENSION_PACKAGE_PRODUCTS did not contain any products"

IFS=',' read -r -a targets <<<"$targets_csv"
seen=","
for target in "${targets[@]}"; do
  target="$(printf '%s' "$target" | xargs)"
  [ -n "$target" ] || continue
  case "$target" in
    android-arm64-v8a|android-x86_64|ios-xcframework)
      ;;
    *)
      fail "mobile extension package target must be android-arm64-v8a, android-x86_64, or ios-xcframework; got $target"
      ;;
  esac
  case "$seen" in
    *",$target,"*)
      ;;
    *)
      seen="$seen$target,"
      args+=(--require-native-target "$target")
      ;;
  esac
done

case " ${args[*]} " in
  *" --require-native-target "*)
    ;;
  *)
    fail "OLIPHAUNT_EXTENSION_PACKAGE_NATIVE_TARGETS did not contain any targets"
    ;;
esac

python3 tools/release/build-extension-ci-artifacts.py "${args[@]}"
python3 tools/release/check_staged_artifacts.py "${validation_args[@]}"
