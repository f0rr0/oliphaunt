#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

. "$root/tools/test/cargo-test-filter.sh"

fail() {
  echo "check-release.sh: $*" >&2
  exit 1
}

run() {
  printf '\n==> %s\n' "$*"
  "$@"
}

host_triple="$(rustc -vV | awk '/^host:/{print $2}')"
case "$host_triple" in
  aarch64-apple-darwin|aarch64-unknown-linux-gnu|x86_64-pc-windows-msvc|x86_64-unknown-linux-gnu)
    ;;
  *)
    fail "unsupported host target for WASIX release preflight: $host_triple"
    ;;
esac

required_artifacts=(
  "target/oliphaunt-wasix/assets/bin/pg_dump.wasix.wasm"
  "target/oliphaunt-wasix/assets/bin/psql.wasix.wasm"
  "target/oliphaunt-wasix/aot/$host_triple/manifest.json"
)
for artifact in "${required_artifacts[@]}"; do
  [[ -f "$artifact" ]] || fail "missing release-shaped WASIX artifact: $artifact"
done

run bash src/bindings/wasix-rust/tools/check-package.sh

tools_filter="oliphaunt::tools::tests::public_tools_round_trip_shared_logical_fixture"
tools_command=(
  env OLIPHAUNT_WASM_AOT_VERIFY=full
  cargo test -p oliphaunt-wasix --locked --no-default-features
  --features extensions,tools,extension-pgtap
  --lib "$tools_filter"
)
oliphaunt_assert_cargo_test_filter_count 1 "$tools_filter" "${tools_command[@]}"
run "${tools_command[@]}" -- --exact --nocapture --test-threads=1
