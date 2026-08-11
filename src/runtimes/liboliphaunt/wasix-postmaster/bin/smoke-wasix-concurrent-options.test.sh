#!/usr/bin/env bash

set -euo pipefail

script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/smoke-wasix-concurrent-connections.sh"

expect_rejected() {
  local expected="$1"
  shift
  local output status

  set +e
  output="$("$script" "$@" 2>&1)"
  status=$?
  set -e
  [ "$status" -eq 2 ] || {
    printf 'invalid options exited %s instead of 2: %s\n' "$status" "$*" >&2
    exit 1
  }
  case "$output" in
    *"$expected"*) ;;
    *) printf 'missing diagnostic %q for: %s\n' "$expected" "$*" >&2; exit 1 ;;
  esac
}

for label in . .. -leading 'contains space' '../escape'; do
  expect_rejected '--label must start with a letter or number' --label "$label"
done
for port in 0 65536 1.5 invalid; do
  expect_rejected '--port requires a port number from 1 through 65535' --port "$port"
done
for seconds in . 1.2.3 invalid -1; do
  expect_rejected '--hold-seconds requires a non-negative numeric value' \
    --hold-seconds "$seconds"
done

set +e
output="$(WASIX_CONCURRENT_VERIFY_TIMEOUT=0 "$script" 2>&1)"
status=$?
set -e
[ "$status" -eq 2 ] &&
  case "$output" in
    *'WASIX_CONCURRENT_VERIFY_TIMEOUT requires a positive integer'*) true ;;
    *) false ;;
  esac || {
  echo 'invalid verification timeout was not rejected before setup' >&2
  exit 1
}

printf 'WASIX concurrent smoke option validation tests passed\n'
