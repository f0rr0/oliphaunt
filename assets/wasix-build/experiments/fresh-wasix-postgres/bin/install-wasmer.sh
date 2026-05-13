#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"

fresh_ensure_dirs
fresh_require_command curl
fresh_require_command tar

host_arch="$(fresh_host_arch)"
install_dir="$FRESH_WORK_ROOT/tools/wasmer-v$FRESH_WASMER_VERSION"
archive="$FRESH_WORK_ROOT/tools/wasmer-$host_arch-v$FRESH_WASMER_VERSION.tar.gz"
url="https://github.com/wasmerio/wasmer/releases/download/v$FRESH_WASMER_VERSION/wasmer-$host_arch.tar.gz"
report="$REPORT_DIR/wasmer-install.md"

fresh_write_report_header "$report" "Wasmer CLI Install"

if [ -x "$install_dir/bin/wasmer" ]; then
  {
    printf '## Result\n\n'
    printf -- '- Status: `pass`\n'
    printf -- '- Action: `reuse-existing`\n'
    printf -- '- Wasmer: `%s`\n' "$("$install_dir/bin/wasmer" --version 2>/dev/null || true)"
    printf -- '- Binary: `%s`\n' "$install_dir/bin/wasmer"
  } >>"$report"
  printf '%s\n' "$install_dir/bin/wasmer"
  exit 0
fi

tmp_dir="$FRESH_WORK_ROOT/tools/.wasmer-install-$FRESH_WASMER_VERSION"
rm -rf "$tmp_dir"
mkdir -p "$tmp_dir"

curl -fL "$url" -o "$archive"
tar -xzf "$archive" -C "$tmp_dir"

candidate="$(find "$tmp_dir" -type f -path '*/bin/wasmer' -perm -111 | head -1)"
if [ -z "$candidate" ]; then
  echo "downloaded Wasmer archive did not contain bin/wasmer" >&2
  exit 1
fi

rm -rf "$install_dir"
mkdir -p "$(dirname "$install_dir")"
mv "$(dirname "$(dirname "$candidate")")" "$install_dir"
rm -rf "$tmp_dir"

{
  printf '## Result\n\n'
  printf -- '- Status: `pass`\n'
  printf -- '- Action: `download-install`\n'
  printf -- '- URL: `%s`\n' "$url"
  printf -- '- Archive: `%s`\n' "$archive"
  printf -- '- Wasmer: `%s`\n' "$("$install_dir/bin/wasmer" --version)"
  printf -- '- Binary: `%s`\n' "$install_dir/bin/wasmer"
} >>"$report"

printf '%s\n' "$install_dir/bin/wasmer"
