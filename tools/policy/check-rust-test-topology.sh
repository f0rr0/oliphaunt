#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

fail() {
  printf 'rust test topology check failed: %s\n' "$1" >&2
  exit 1
}

require_text() {
  local file="$1"
  local text="$2"
  local message="$3"

  [ -f "$file" ] || fail "missing required file: $file"
  grep -Fq "$text" "$file" || fail "$message"
}

reject_text() {
  local file="$1"
  local text="$2"
  local message="$3"

  [ -f "$file" ] || fail "missing required file: $file"
  if grep -Fq "$text" "$file"; then
    fail "$message"
  fi
}

require_text .config/nextest.toml '[profile.ci]' \
  "cargo-nextest CI profile must remain configured centrally"
require_text src/sdks/rust/tools/check-sdk.sh 'cargo test -p oliphaunt --doc --locked' \
  "Rust SDK doctests must run in the Rust SDK product test task"
require_text src/sdks/rust/tools/check-sdk.sh 'native_runtime_lock cargo nextest run -p oliphaunt --locked --profile ci --no-tests=fail --test-threads=1' \
  "Rust SDK executable tests must run through native-runtime-locked cargo-nextest"
require_text src/bindings/wasix-rust/tools/check-unit.sh 'cargo test -p oliphaunt-wasix --doc --locked' \
  "WASIX Rust doctests must run in the WASIX Rust product test task"
require_text src/bindings/wasix-rust/tools/check-unit.sh 'cargo nextest run -p oliphaunt-wasix --locked --profile ci --no-default-features --lib --no-tests=fail --test-threads=1' \
  "WASIX Rust unit tests must run through cargo-nextest in the WASIX Rust product test task"
require_text src/runtimes/broker/moon.yml 'command: "cargo test -p oliphaunt-broker --locked"' \
  "Broker runtime tests must be owned by the broker runtime product task"
require_text tools/xtask/moon.yml 'command: "cargo check -p xtask --features template-runner --locked"' \
  "xtask template-runner validation must stay in xtask:test"

require_text moon.yml 'check-rust-test-topology.sh' \
  "repo:test must run the topology policy script"
reject_text moon.yml 'command: "tools/policy/check-rust-tests.sh"' \
  "repo:test must not call the retired broad Cargo test wrapper"
reject_text moon.yml 'cargo test --doc --workspace' \
  "root Moon tasks must not run all workspace doctests inside :test"
reject_text moon.yml 'cargo check --workspace --no-default-features' \
  "root Moon tasks must not run broad workspace Cargo checks inside :test"

printf 'rust test topology checks passed\n'
