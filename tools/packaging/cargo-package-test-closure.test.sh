#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
bun test ./tools/packaging/cargo-package-test-closure.test.mts
scratch=$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-cargo-closure-XXXXXX")
trap 'rm -rf "$scratch"' EXIT
crate=$(bun tools/packaging/cargo-package-test-closure.test.mts prepare "$scratch")
script=tools/packaging/check-cargo-package-tests.sh
bash "$script" --crate "$crate" --target-dir "$scratch/target" \
  --stub-dependency carrier --no-default-features --features forward --lib > "$scratch/checked.log"
grep -q 'Cargo package test closure verified: closure-fixture-0.1.0' "$scratch/checked.log"
reject() {
  local expected="$1"; shift
  if bash "$script" "$@" > "$scratch/rejected.log" 2>&1; then exit 1; fi
  grep -q "$expected" "$scratch/rejected.log"
}
reject 'unknown argument' --unknown
reject 'mutually exclusive' --crate "$crate" --all-features --features forward
reject 'requires a value' --crate
