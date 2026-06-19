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

python3 - "$product" <<'PY'
from __future__ import annotations

import sys
import tomllib
from pathlib import Path

selected = sys.argv[1]
expected = [
    "oliphaunt-rust",
    "oliphaunt-swift",
    "oliphaunt-kotlin",
    "oliphaunt-js",
    "oliphaunt-react-native",
    "oliphaunt-wasix-rust",
]
with Path("coverage/baseline.toml").open("rb") as handle:
    baseline = tomllib.load(handle)
products = baseline.get("products", {})
targets = expected if selected == "all" else [selected]
for product in targets:
    config = products.get(product)
    if not isinstance(config, dict):
        raise SystemExit(f"missing coverage product config: {product}")
    if "include_globs" in config:
        raise SystemExit(f"{product}: coverage must use source_globs, not include_globs")
    source_globs = config.get("source_globs")
    if not isinstance(source_globs, list) or not source_globs or not all(isinstance(item, str) for item in source_globs):
        raise SystemExit(f"{product}: source_globs must be a non-empty string array")
    if float(config.get("line_threshold", 0.0)) < 80.0:
        raise SystemExit(f"{product}: aggregate line_threshold must stay at or above 80")
    if float(config.get("per_file_line_threshold", 0.0)) < 50.0:
        raise SystemExit(f"{product}: per_file_line_threshold must stay at or above 50")
    if float(config.get("measured_line_coverage", 0.0)) < float(config.get("line_threshold", 0.0)):
        raise SystemExit(f"{product}: measured_line_coverage audit snapshot is below the aggregate threshold")
    waivers = config.get("waivers", [])
    if not isinstance(waivers, list) or not waivers:
        raise SystemExit(f"{product}: coverage waivers must be explicit even when the list is short")
    for waiver in waivers:
        if not isinstance(waiver, dict):
            raise SystemExit(f"{product}: waiver must be a TOML table")
        has_path = isinstance(waiver.get("path"), str)
        has_glob = isinstance(waiver.get("glob"), str)
        if has_path == has_glob:
            raise SystemExit(f"{product}: waiver must define exactly one of path or glob")
        for key in ("reason", "evidence", "owner", "expires"):
            value = waiver.get(key)
            if not isinstance(value, str) or not value.strip():
                raise SystemExit(f"{product}: waiver {key} must be a non-empty string")
PY

printf 'measured coverage policy is modeled for %s\n' "$product"
