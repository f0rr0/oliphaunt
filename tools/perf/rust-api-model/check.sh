#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
root="$(git -C "$script_dir" rev-parse --show-toplevel 2>/dev/null)" || {
  echo "unable to determine the Oliphaunt repository root" >&2
  exit 1
}
cd "$root"

cargo test -p oliphaunt-perf --locked \
  --features rust-api-model-wasix \
  --bin oliphaunt-rust-api-model
tools/dev/bun.sh test tools/perf/rust-api-model/summarize.test.mjs
