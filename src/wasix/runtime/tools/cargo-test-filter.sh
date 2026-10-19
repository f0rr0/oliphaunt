#!/usr/bin/env bash

# Cargo treats a test-name filter that matches nothing as success. Runtime
# smoke lanes must actually select tests, without coupling to a suite's size.
oliphaunt_require_cargo_test_filter() {
  local filter="$1"
  shift

  local listed_tests
  local test_count
  listed_tests="$("$@" -- --list)" || return
  test_count="$(awk -v filter="$filter" '
    index($0, filter) && /: test$/ { count += 1 }
    END { print count + 0 }
  ' <<<"$listed_tests")"
  if [ "$test_count" -eq 0 ]; then
    printf '%s\n' "$listed_tests" >&2
    echo "no tests match $filter" >&2
    return 1
  fi
}
