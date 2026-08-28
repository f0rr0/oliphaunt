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

printf '\n==> cargo test -p oliphaunt-wasix --doc --locked\n'
cargo test -p oliphaunt-wasix --doc --locked

printf '\n==> cargo test -p oliphaunt-wasix --doc --locked --features tools\n'
cargo test -p oliphaunt-wasix --doc --locked --features tools

printf '\n==> cargo nextest run -p oliphaunt-wasix --locked --profile ci --no-default-features --lib --no-tests=fail --test-threads=1\n'
cargo nextest run -p oliphaunt-wasix --locked --profile ci --no-default-features --lib --no-tests=fail --test-threads=1

# The public API suite is intentionally safe to run without generated runtime
# assets. Compile it with the optional extension and tools vocabulary enabled so
# root re-exports and both sync/async method shapes cannot silently drift. A
# leaf extension feature proves its associated selector is present without
# making the coarse `extensions` carrier falsely expose the whole catalog.
printf '\n==> cargo nextest run -p oliphaunt-wasix --locked --profile ci --no-default-features --features extensions,tools,extension-vector --test public_api --no-tests=fail --test-threads=1\n'
cargo nextest run -p oliphaunt-wasix --locked --profile ci \
  --no-default-features --features extensions,tools,extension-vector \
  --test public_api --no-tests=fail --test-threads=1

# These integration suites start the packaged WASIX runtime when executed.
# Unit qualification still compiles them so public imports and client-facing
# signatures are checked on every change; the runtime family's
# `src/runtimes/liboliphaunt/wasix/tools/runtime-smoke.sh` owns execution once
# exact AOT/runtime assets have been installed.
printf '\n==> cargo test -p oliphaunt-wasix --locked --no-default-features --features extensions --test runtime_smoke --test client_compat --no-run\n'
cargo test -p oliphaunt-wasix --locked --no-default-features \
  --features extensions --test runtime_smoke --test client_compat --no-run

tools_filter="oliphaunt::tools::tests::public_tools_round_trip_shared_logical_fixture"
tools_command=(
  cargo test -p oliphaunt-wasix --locked --no-default-features
  --features extensions,tools,extension-pgtap
  --lib "$tools_filter"
)
printf '\n==> verify exactly one current WASIX logical-tools test is compiled\n'
oliphaunt_assert_cargo_test_filter_count 1 "$tools_filter" "${tools_command[@]}"
