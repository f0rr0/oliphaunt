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

crate_dir="$out_dir/crate"
crate_path="$(tools/dev/bun.sh tools/release/package_oliphaunt_wasix_sdk_crate.mjs --output-dir "$crate_dir")"
tar -tzf "$crate_path" | sed 's|^[^/]*/||' | sed '/^$/d' >"$listing"

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
require_entry "src/error.rs"
require_entry "src/lib.rs"
require_entry "src/bin/oliphaunt_wasix_dump.rs"
require_entry "src/bin/oliphaunt_wasix_proxy.rs"
require_entry "src/oliphaunt/aot.rs"
require_entry "src/oliphaunt/assets.rs"
require_entry "src/testdata/database-root.json"
require_entry "src/testdata/physical-archive-wasix-v1.properties"
require_entry "src/testdata/physical-backup-wal-range-v1.properties"
require_entry "src/testdata/postgres-behavior-contract.json"
require_entry "src/testdata/postgres-logical-tools.json"
require_entry "src/testdata/postgres-logical-tools-seed.sql"
require_entry "src/testdata/postgres-logical-tools-verify.sql"
require_entry "src/testdata/postgres-server-listen.json"
require_entry "src/testdata/protocol-query-response-cases.json"
require_entry "src/testdata/wasix-toolchain.toml"
require_entry "tests/public_api.rs"

canonical_extension_smoke_count=0
for recipe in src/shared/fixtures/extensions/*.sql; do
  canonical_extension_smoke_count=$((canonical_extension_smoke_count + 1))
  require_entry "src/testdata/extensions/$(basename "$recipe")"
done
packaged_extension_smoke_count="$(grep -Ec '^src/testdata/extensions/[^/]+\.sql$' "$listing" || true)"
if [ "$packaged_extension_smoke_count" -ne "$canonical_extension_smoke_count" ]; then
  echo "oliphaunt-wasix package must contain exactly the canonical extension smoke recipes: expected $canonical_extension_smoke_count, found $packaged_extension_smoke_count" >&2
  grep -E '^src/testdata/extensions/' "$listing" >&2 || true
  exit 1
fi
if git ls-files --error-unmatch \
  src/bindings/wasix-rust/crates/oliphaunt-wasix/src/testdata/extensions/'*.sql' \
  >/dev/null 2>&1; then
  echo "oliphaunt-wasix source must not commit package-local extension smoke copies; package them from src/shared/fixtures/extensions" >&2
  exit 1
fi
reject_pattern '^src/testdata/postgis-smoke\.sql$'

cmp -s \
  src/bindings/wasix-rust/crates/oliphaunt-wasix/src/testdata/wasix-toolchain.toml \
  src/sources/toolchains/wasix.toml || {
  echo "oliphaunt-wasix packaged toolchain fixture must match src/sources/toolchains/wasix.toml" >&2
  exit 1
}

reject_pattern '(^|/)(payload|artifacts|target)(/|$)'
reject_pattern '(^|/)assets/generated(/|$)'
reject_pattern '^src/runtimes/'
reject_pattern '^src/extensions/generated/'
reject_pattern '^(\.gitignore|moon.yml|release.toml)$'
reject_pattern '^tools/'

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
require_source_text src/bindings/wasix-rust/crates/oliphaunt-wasix/Cargo.toml 'license = "MIT"' \
  "oliphaunt-wasix is a source-only facade and must declare exactly MIT; payload crates carry their own licenses"
require_source_text src/bindings/wasix-rust/crates/oliphaunt-wasix/Cargo.toml '"dep:oliphaunt-wasix-tools-aot-x86_64-unknown-linux-gnu",' \
  "oliphaunt-wasix tools feature must select the Linux x64 tools-AOT crate"
require_source_text src/bindings/wasix-rust/crates/oliphaunt-wasix/Cargo.toml '"dep:oliphaunt-wasix-tools-aot-aarch64-unknown-linux-gnu",' \
  "oliphaunt-wasix tools feature must select the Linux arm64 tools-AOT crate"
require_source_text src/bindings/wasix-rust/crates/oliphaunt-wasix/Cargo.toml '"dep:oliphaunt-wasix-tools-aot-aarch64-apple-darwin",' \
  "oliphaunt-wasix tools feature must select the macOS arm64 tools-AOT crate"
require_source_text src/bindings/wasix-rust/crates/oliphaunt-wasix/Cargo.toml '"dep:oliphaunt-wasix-tools-aot-x86_64-pc-windows-msvc",' \
  "oliphaunt-wasix tools feature must select the Windows x64 tools-AOT crate"
require_source_text src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/mod.rs 'pub mod tools;' \
  "WASIX tools must use the optional public tools namespace"
require_cfg_tools_line src/bindings/wasix-rust/crates/oliphaunt-wasix/src/lib.rs "pub use oliphaunt::tools;" \
  "WASIX tools namespace must stay behind cfg(feature = \"tools\")"
require_source_text src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/tools.rs "pub fn pg_dump(database: &mut crate::Oliphaunt, options: PgDumpOptions)" \
  "WASIX tools namespace must expose direct pg_dump"
require_source_text src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/tools.rs "pub fn psql(database: &mut crate::Oliphaunt, options: PsqlOptions)" \
  "WASIX tools namespace must expose direct psql"
require_source_text src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/tools.rs "pub fn script(mut self, sql: impl Into<String>)" \
  "WASIX PsqlOptions must expose standard script input"

echo "oliphaunt-wasix package shape verified: $listing"
