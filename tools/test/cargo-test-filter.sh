#!/usr/bin/env bash

# Cargo treats a test-name filter that matches nothing as success. Release and
# runtime smoke lanes must state how many tests they intend to select before
# running the filtered command.
oliphaunt_assert_cargo_test_filter_count() {
  local expected="$1"
  local filter="$2"
  shift 2

  local listed_tests
  local test_count
  listed_tests="$("$@" -- --list)"
  test_count="$(awk -v filter="$filter" '
    index($0, filter) && /: test$/ { count += 1 }
    END { print count + 0 }
  ' <<<"$listed_tests")"
  if [ "$test_count" -ne "$expected" ]; then
    printf '%s\n' "$listed_tests" >&2
    echo "expected exactly $expected tests matching $filter, found $test_count" >&2
    return 1
  fi
}
