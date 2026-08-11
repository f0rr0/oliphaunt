#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"

fresh_ensure_dirs

wasmer_root="$FRESH_WORK_ROOT/runtime/wasmer"
target_dir="${WASIX_PERF_STATS_TARGET_DIR:-$wasmer_root/target/perf-stats}"
report="$REPORT_DIR/wasmer-perf-stats-build.md"
features="${WASIX_PERF_STATS_WASMER_FEATURES:-llvm,wat,perf-stats}"

if [ ! -d "$wasmer_root/lib/cli" ]; then
  printf 'missing upstream Wasmer checkout: %s\n' "$wasmer_root" >&2
  exit 2
fi

fresh_write_report_header "$report" "Wasmer Perf Stats Build"
{
  printf -- '- Wasmer root: `%s`\n' "$wasmer_root"
  printf -- '- Cargo target dir: `%s`\n' "$target_dir"
  printf -- '- CLI features: `%s`\n\n' "$features"
} >>"$report"

(
  cd "$wasmer_root"
  CARGO_TARGET_DIR="$target_dir" \
    cargo build \
      --manifest-path lib/cli/Cargo.toml \
      --bin wasmer \
      --release \
      --no-default-features \
      --features "$features"
) >"$REPORT_DIR/wasmer-perf-stats-build.log" 2>&1

wasmer_bin="$target_dir/release/wasmer"
if [ ! -x "$wasmer_bin" ]; then
  printf 'perf-stats Wasmer build did not produce %s\n' "$wasmer_bin" >&2
  exit 1
fi

{
  printf '## Result\n\n'
  printf -- '- Status: `pass`\n'
  printf -- '- Wasmer: `%s`\n' "$(fresh_wasmer_version "$wasmer_bin" 2>/dev/null || true)"
  printf -- '- Binary: `%s`\n' "$wasmer_bin"
  printf -- '- Binary hash: `%s`\n' "$(fresh_wasmer_bin_hash "$wasmer_bin")"
  printf -- '- Build log: `%s`\n' "$REPORT_DIR/wasmer-perf-stats-build.log"
} >>"$report"

printf '%s\n' "$wasmer_bin"
