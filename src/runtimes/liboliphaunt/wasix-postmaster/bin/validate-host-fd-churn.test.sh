#!/usr/bin/env bash

set -euo pipefail

root="$(mktemp -d)"
trap 'rm -rf -- "$root"' EXIT HUP INT TERM
validator="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/validate-host-fd-churn.sh"

write_fixture() {
  local path="$1" before="$2" after="$3" quiescent="$4"
  local observed="${5:-1}" expected="${6:-${5:-1}}"
  {
    printf 'target\tmode\tstage\tmonotonic_ms\ttotal_open_fds\tobserved_processes\texpected_processes\tstatus\n'
    printf 'wasix\treconnect\tbefore\t1\t%s\t%s\t%s\tok\n' \
      "$before" "$observed" "$expected"
    printf 'wasix\treconnect\tafter\t2\t%s\t%s\t%s\tok\n' \
      "$after" "$observed" "$expected"
    printf 'wasix\treconnect\tquiescent\t3\t%s\t%s\t%s\tok\n' \
      "$quiescent" "$observed" "$expected"
  } >"$path"
}

write_fixture "$root/no-leak.tsv" 40 43 41
"$validator" "$root/no-leak.tsv" wasix reconnect 2 "$root/no-leak-summary.tsv"
grep -Fq $'wasix\treconnect\t40\t43\t41\t1\t2\tpassed' "$root/no-leak-summary.tsv"
[ "$(stat -c '%a' "$root/no-leak-summary.tsv")" = 444 ]

printf 'existing summary\n' >"$root/existing-summary.tsv"
if "$validator" "$root/no-leak.tsv" wasix reconnect 2 \
  "$root/existing-summary.tsv" >/dev/null 2>&1; then
  echo "host FD churn validator replaced existing evidence" >&2
  exit 1
fi
[ "$(cat "$root/existing-summary.tsv")" = 'existing summary' ]

# This is the exact shape of one retained host FD per reconnect sample.
write_fixture "$root/one-per-sample.tsv" 40 1040 1040
if "$validator" "$root/one-per-sample.tsv" wasix reconnect 4 "$root/leak-summary.tsv"; then
  echo "host FD churn validator accepted a one-FD-per-sample leak" >&2
  exit 1
fi
grep -Fq $'wasix\treconnect\t40\t1040\t1040\t1000\t4\tfailed' "$root/leak-summary.tsv"
[ "$(stat -c '%a' "$root/leak-summary.tsv")" = 444 ]

# Values on opposite sides of 2^53 must remain distinct. Floating-point awk
# arithmetic rounded this one-FD growth to zero and incorrectly passed it.
write_fixture "$root/above-double-precision.tsv" \
  9007199254740992 9007199254740993 9007199254740993
if "$validator" "$root/above-double-precision.tsv" wasix reconnect 0 \
  "$root/above-double-precision-summary.tsv"; then
  echo "host FD churn validator lost integer precision above 2^53" >&2
  exit 1
fi
grep -Fq $'wasix\treconnect\t9007199254740992\t9007199254740993\t9007199254740993\t1\t0\tfailed' \
  "$root/above-double-precision-summary.tsv"

write_fixture "$root/process-count-precision.tsv" 40 41 40 \
  9007199254740992 9007199254740993
if "$validator" "$root/process-count-precision.tsv" wasix reconnect 0 \
  "$root/process-count-precision-summary.tsv" >/dev/null 2>&1; then
  echo "host FD churn validator rounded unequal process counts above 2^53" >&2
  exit 1
fi
[ ! -e "$root/process-count-precision-summary.tsv" ]

write_fixture "$root/u64.tsv" \
  18446744073709551614 18446744073709551615 18446744073709551615
"$validator" "$root/u64.tsv" wasix reconnect 1 "$root/u64-summary.tsv"
grep -Fq $'wasix\treconnect\t18446744073709551614\t18446744073709551615\t18446744073709551615\t1\t1\tpassed' \
  "$root/u64-summary.tsv"

write_fixture "$root/above-u64.tsv" 40 41 18446744073709551616
if "$validator" "$root/above-u64.tsv" wasix reconnect 1 \
  "$root/above-u64-summary.tsv" >/dev/null 2>&1; then
  echo "host FD churn validator accepted a counter above u64" >&2
  exit 1
fi
[ ! -e "$root/above-u64-summary.tsv" ]

if "$validator" "$root/no-leak.tsv" wasix reconnect 18446744073709551616 \
  "$root/allowance-above-u64.tsv" >/dev/null 2>&1; then
  echo "host FD churn validator accepted an allowance above u64" >&2
  exit 1
fi
[ ! -e "$root/allowance-above-u64.tsv" ]

if "$validator" "$root/no-leak.tsv" wasix reconnect 00 \
  "$root/noncanonical-allowance.tsv" >/dev/null 2>&1; then
  echo "host FD churn validator accepted a noncanonical allowance" >&2
  exit 1
fi
[ ! -e "$root/noncanonical-allowance.tsv" ]

sed 's/\tok$/\traced/' "$root/no-leak.tsv" >"$root/raced.tsv"
if "$validator" "$root/raced.tsv" wasix reconnect 4 "$root/raced-summary.tsv" >/dev/null 2>&1; then
  echo "host FD churn validator accepted raced observations" >&2
  exit 1
fi

printf 'host FD churn validation tests passed\n'
