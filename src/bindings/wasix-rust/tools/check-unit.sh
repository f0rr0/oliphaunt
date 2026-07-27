#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

if ! cargo nextest --version >/dev/null 2>&1; then
  echo "missing cargo-nextest; run tools/dev/bootstrap-tools.sh" >&2
  exit 1
fi

printf '\n==> cargo test -p oliphaunt-wasix --doc --locked\n'
cargo test -p oliphaunt-wasix --doc --locked

printf '\n==> cargo nextest run -p oliphaunt-wasix --locked --profile ci --no-default-features --lib --no-tests=fail --test-threads=1\n'
cargo nextest run -p oliphaunt-wasix --locked --profile ci --no-default-features --lib --no-tests=fail --test-threads=1

printf '\n==> cargo test -p oliphaunt-wasix --locked --no-default-features --features extensions,tools --lib preflight_wasix_tools_loads_split_artifacts --no-run\n'
cargo test -p oliphaunt-wasix --locked --no-default-features --features extensions,tools --lib preflight_wasix_tools_loads_split_artifacts --no-run
