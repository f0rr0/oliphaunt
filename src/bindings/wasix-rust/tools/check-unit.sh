#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

. "$root/tools/test/cargo-test-filter.sh"

if ! cargo nextest --version >/dev/null 2>&1; then
  echo "missing cargo-nextest; run tools/dev/bootstrap-tools.sh" >&2
  exit 1
fi

printf '\n==> cargo test -p oliphaunt-wasix --doc --locked --features tools\n'
cargo test -p oliphaunt-wasix --doc --locked --features tools

printf '\n==> cargo nextest run -p oliphaunt-wasix --locked --profile ci --no-default-features --lib --no-tests=fail --test-threads=1\n'
cargo nextest run -p oliphaunt-wasix --locked --profile ci --no-default-features --lib --no-tests=fail --test-threads=1

tools_filter="oliphaunt::tools::tests::public_tools_round_trip_shared_logical_fixture"
tools_command=(
  cargo test -p oliphaunt-wasix --locked --no-default-features
  --features extensions,tools,extension-pgtap
  --lib "$tools_filter"
)
printf '\n==> verify exactly one current WASIX logical-tools test is compiled\n'
oliphaunt_assert_cargo_test_filter_count 1 "$tools_filter" "${tools_command[@]}"
