#!/usr/bin/env bash

set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
temporary="$(mktemp -d)"
trap 'rm -rf -- "$temporary"' EXIT HUP INT TERM
sentinel="$temporary/sentinel"
printf 'preserve\n' >"$sentinel"

expect_rejected() {
  local environment_name="$1"
  local script="$2"
  local value="$3"
  local output="$temporary/output"

  if env "$environment_name=$value" "$script" >"$output" 2>&1; then
    printf '%s accepted unsafe suite name: %s\n' "$script" "$value" >&2
    exit 1
  fi
  [ "$(cat "$sentinel")" = preserve ] || {
    printf '%s mutated the external sentinel for suite name: %s\n' \
      "$script" "$value" >&2
    exit 1
  }
  grep -Fq 'invalid ' "$output" || {
    printf '%s did not fail at suite-name validation: %s\n' "$script" "$value" >&2
    exit 1
  }
}

expect_test_rejected() {
  local script="$1"
  local value="$2"
  local output="$temporary/output"

  if "$script" "$value" >"$output" 2>&1; then
    printf '%s accepted unsafe regression test name: %s\n' "$script" "$value" >&2
    exit 1
  fi
  [ "$(cat "$sentinel")" = preserve ] || {
    printf '%s mutated the external sentinel for test name: %s\n' \
      "$script" "$value" >&2
    exit 1
  }
  grep -Fq 'invalid PostgreSQL regression test name' "$output" || {
    printf '%s did not fail at test-name validation: %s\n' "$script" "$value" >&2
    exit 1
  }
}

for value in '' . .. -leading ../escape ../../victim '/absolute' 'contains space' $'line\nbreak'; do
  expect_rejected WASIX_REGRESS_SUITE_NAME \
    "$project_root/bin/run-wasix-regress-subset.sh" "$value"
done

for value in --help -V ../boolean 'boolean case' 'boolean.sql' $'line\nbreak' 1boolean; do
  expect_test_rejected "$project_root/bin/run-wasix-regress-subset.sh" "$value"
done

printf 'regression suite/test-name validation tests passed\n'
