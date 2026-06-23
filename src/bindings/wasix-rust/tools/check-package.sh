#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

out_dir="target/oliphaunt-wasix-rust/package"
listing="$out_dir/oliphaunt-wasix.package-files.txt"
mkdir -p "$out_dir"

cargo package --list -p oliphaunt-wasix --locked --allow-dirty >"$listing"

require_entry() {
  local entry="$1"
  if ! grep -Fxq "$entry" "$listing"; then
    echo "oliphaunt-wasix package is missing required entry: $entry" >&2
    exit 1
  fi
}

reject_pattern() {
  local pattern="$1"
  if grep -Eq "$pattern" "$listing"; then
    echo "oliphaunt-wasix package contains forbidden runtime/build entry matching: $pattern" >&2
    grep -E "$pattern" "$listing" >&2
    exit 1
  fi
}

require_entry "Cargo.toml"
require_entry "README.md"
require_entry "src/lib.rs"
require_entry "src/bin/oliphaunt_wasix_dump.rs"
require_entry "src/bin/oliphaunt_wasix_proxy.rs"
require_entry "src/oliphaunt/aot.rs"
require_entry "src/oliphaunt/assets.rs"
require_entry "src/protocol/parser.rs"

reject_pattern '(^|/)(payload|artifacts|target)(/|$)'
reject_pattern '(^|/)assets/generated(/|$)'
reject_pattern '^src/runtimes/'
reject_pattern '^src/extensions/generated/'

echo "oliphaunt-wasix package shape verified: $listing"
