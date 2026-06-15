#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

out_dir="target/oliphaunt-broker/package"
listing="$out_dir/oliphaunt-broker.package-files.txt"
mkdir -p "$out_dir"

cargo package --list -p oliphaunt-broker --locked --allow-dirty >"$listing"

require_entry() {
  local entry="$1"
  if ! grep -Fxq "$entry" "$listing"; then
    echo "oliphaunt-broker package is missing required entry: $entry" >&2
    exit 1
  fi
}

reject_pattern() {
  local pattern="$1"
  if grep -Eq "$pattern" "$listing"; then
    echo "oliphaunt-broker package contains forbidden entry matching: $pattern" >&2
    grep -E "$pattern" "$listing" >&2
    exit 1
  fi
}

require_entry "Cargo.toml"
require_entry "README.md"
require_entry "src/main.rs"
require_entry "targets/checksums.toml"
require_entry "targets/linux-arm64-gnu.toml"
require_entry "targets/linux-x64-gnu.toml"
require_entry "targets/macos-arm64.toml"
require_entry "targets/windows-x64-msvc.toml"

reject_pattern '(^|/)(target|release-assets|release-stage)(/|$)'
reject_pattern '^src/runtimes/liboliphaunt/'
reject_pattern '^src/sdks/rust/'

echo "oliphaunt-broker package shape verified: $listing"
