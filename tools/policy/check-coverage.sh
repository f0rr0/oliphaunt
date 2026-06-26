#!/usr/bin/env sh
set -eu

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

product="${1:-all}"
baseline="coverage/baseline.toml"

fail() {
  echo "$1" >&2
  exit 1
}

require_file() {
  [ -f "$1" ] || fail "missing coverage policy file: $1"
}

require_text() {
  file="$1"
  text="$2"
  grep -Fq -- "$text" "$file" || fail "expected '$text' in $file"
}

reject_text() {
  file="$1"
  text="$2"
  if grep -Fq -- "$text" "$file"; then
    fail "unexpected '$text' in $file"
  fi
}

require_file "$baseline"
require_text "$baseline" "fail_on_unmeasured_product = true"
require_text "$baseline" "minimum_new_sdk_line_coverage = 80.0"
require_text "$baseline" "target_sdk_line_coverage = 85.0"
reject_text "$baseline" "include_globs"
require_text "moon.yml" "coverage-policy:"
require_text "moon.yml" "tools/coverage/summarize"
require_text "moon.yml" "tools/policy/check-coverage.sh all"

products="oliphaunt-rust oliphaunt-swift oliphaunt-kotlin oliphaunt-js oliphaunt-react-native oliphaunt-wasix-rust"

product_moon_yml() {
  case "$1" in
    oliphaunt-rust)
      printf '%s\n' "src/sdks/rust/moon.yml"
      ;;
    oliphaunt-swift)
      printf '%s\n' "src/sdks/swift/moon.yml"
      ;;
    oliphaunt-kotlin)
      printf '%s\n' "src/sdks/kotlin/moon.yml"
      ;;
    oliphaunt-js)
      printf '%s\n' "src/sdks/js/moon.yml"
      ;;
    oliphaunt-react-native)
      printf '%s\n' "src/sdks/react-native/moon.yml"
      ;;
    oliphaunt-wasix-rust)
      printf '%s\n' "src/bindings/wasix-rust/moon.yml"
      ;;
  esac
}

case "$product" in
  all)
    for item in $products; do
      moon_yml="$(product_moon_yml "$item")"
      require_text "$baseline" "[products.$item]"
      require_text "$baseline" "summary = \"target/coverage/$item/summary.json\""
      require_text "$baseline" "line_threshold = 80.0"
      require_text "$moon_yml" "coverage:"
      require_text "$moon_yml" "tools/coverage/run-product $item"
      require_text "$moon_yml" "/target/coverage/$item/**/*"
    done
    ;;
  oliphaunt-rust|oliphaunt-swift|oliphaunt-kotlin|oliphaunt-js|oliphaunt-react-native|oliphaunt-wasix-rust)
    moon_yml="$(product_moon_yml "$product")"
    require_text "$baseline" "[products.$product]"
    require_text "$baseline" "summary = \"target/coverage/$product/summary.json\""
    require_text "$moon_yml" "coverage:"
    require_text "$moon_yml" "tools/coverage/run-product $product"
    require_text "$moon_yml" "/target/coverage/$product/**/*"
    ;;
  *)
    fail "unknown coverage product '$product'"
    ;;
esac

bun tools/policy/check-coverage-baseline.mjs "$product"

printf 'measured coverage policy is modeled for %s\n' "$product"
