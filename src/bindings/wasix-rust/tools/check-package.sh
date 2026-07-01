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

require_source_text() {
  local file="$1"
  local text="$2"
  local message="$3"
  if ! grep -Fq "$text" "$file"; then
    echo "$message" >&2
    exit 1
  fi
}

require_cfg_tools_line() {
  local file="$1"
  local line="$2"
  local message="$3"
  if ! awk -v expected="$line" '
    previous == "#[cfg(feature = \"tools\")]" && $0 == expected {
      found = 1
    }
    {
      previous = $0
    }
    END {
      exit found ? 0 : 1
    }
  ' "$file"; then
    echo "$message" >&2
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

if ! awk '
  /^\[\[bin\]\]/ {
    if (in_bin && name == "oliphaunt-wasix-dump" && !required) {
      exit 1
    }
    in_bin = 1
    name = ""
    required = 0
    next
  }
  /^\[/ {
    if (in_bin && name == "oliphaunt-wasix-dump" && !required) {
      exit 1
    }
    in_bin = 0
  }
  in_bin && /^name = "oliphaunt-wasix-dump"$/ {
    name = "oliphaunt-wasix-dump"
  }
  in_bin && /^required-features = \["tools"\]$/ {
    required = 1
  }
  END {
    if (in_bin && name == "oliphaunt-wasix-dump" && !required) {
      exit 1
    }
  }
' src/bindings/wasix-rust/crates/oliphaunt-wasix/Cargo.toml; then
  echo "oliphaunt-wasix-dump must declare required-features = [\"tools\"]" >&2
  exit 1
fi

require_source_text src/bindings/wasix-rust/crates/oliphaunt-wasix/Cargo.toml '"dep:oliphaunt-wasix-tools",' \
  "oliphaunt-wasix tools feature must select the split oliphaunt-wasix-tools crate"
require_source_text src/bindings/wasix-rust/crates/oliphaunt-wasix/Cargo.toml '"dep:oliphaunt-wasix-tools-aot-x86_64-unknown-linux-gnu",' \
  "oliphaunt-wasix tools feature must select the Linux x64 tools-AOT crate"
require_source_text src/bindings/wasix-rust/crates/oliphaunt-wasix/Cargo.toml '"dep:oliphaunt-wasix-tools-aot-aarch64-unknown-linux-gnu",' \
  "oliphaunt-wasix tools feature must select the Linux arm64 tools-AOT crate"
require_source_text src/bindings/wasix-rust/crates/oliphaunt-wasix/Cargo.toml '"dep:oliphaunt-wasix-tools-aot-aarch64-apple-darwin",' \
  "oliphaunt-wasix tools feature must select the macOS arm64 tools-AOT crate"
require_source_text src/bindings/wasix-rust/crates/oliphaunt-wasix/Cargo.toml '"dep:oliphaunt-wasix-tools-aot-x86_64-pc-windows-msvc",' \
  "oliphaunt-wasix tools feature must select the Windows x64 tools-AOT crate"
require_cfg_tools_line src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/mod.rs "pub mod pg_dump;" \
  "WASIX split-tools public module must stay behind cfg(feature = \"tools\")"
require_cfg_tools_line src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/mod.rs "pub use pg_dump::{PgDumpOptions, PsqlOptions, preflight_wasix_tools};" \
  "WASIX split-tools internal exports must stay behind cfg(feature = \"tools\")"
require_cfg_tools_line src/bindings/wasix-rust/crates/oliphaunt-wasix/src/lib.rs "pub use oliphaunt::{PgDumpOptions, PsqlOptions, preflight_wasix_tools};" \
  "WASIX split-tools crate-root exports must stay behind cfg(feature = \"tools\")"

echo "oliphaunt-wasix package shape verified: $listing"
