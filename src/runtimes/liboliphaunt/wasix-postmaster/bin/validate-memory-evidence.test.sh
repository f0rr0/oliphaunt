#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
validator="$root/bin/validate-memory-evidence.sh"
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT

header='monotonic_ms	target	phase	pss_kb_total	pss_anon_kb_total	page_table_kb_total	cgroup_path	cgroup_swap_current_bytes	cgroup_scope_swap_peak_bytes	cgroup_scope_event_high_total	cgroup_scope_event_max_total	cgroup_scope_event_oom_total	cgroup_scope_event_oom_kill_total	cgroup_memory_max	cgroup_memory_high	cgroup_swap_max	cgroup_scope_memory_peak_bytes	cgroup_memory_pressure_some_total_usec	cgroup_memory_pressure_full_total_usec	smaps_status	cgroup_status'

write_fixture() {
  local destination="$1"
  local second_smaps="${2:-ok}"
  local second_cgroup="${3:-ok}"
  local second_swap="${4:-0}"
  local second_event_max="${5:-0}"
  local second_memory_max="${6:-268435456}"
  local second_time="${7:-1500}"
  local phase="${8:-fanout:indexed-read}"
  printf '%b\n' "$header" >"$destination"
  printf '1000\twasix\tfanout:indexed-read\t1000\t700\t50\t/user.slice/test.scope\t0\t0\t10\t0\t0\t0\t268435456\t134217728\t0\t1000000\t1000\t500\tok\tok\n' \
    >>"$destination"
  printf '%s\twasix\t%s\t1200\t800\t60\t/user.slice/test.scope\t%s\t0\t15\t%s\t0\t0\t%s\t134217728\t0\t1100000\t51000\t20500\t%s\t%s\n' \
    "$second_time" "$phase" "$second_swap" "$second_event_max" \
    "$second_memory_max" "$second_smaps" "$second_cgroup" >>"$destination"
}

common_args=(
  --target wasix
  --interval-seconds 0.5
  --require-phase fanout:indexed-read
  --require-cgroup yes
  --memory-max 256M
  --memory-high 128M
  --swap-max 0
)

run_valid() {
  "$validator" --samples "$1" "${common_args[@]}" --output "$2"
  grep -Fq $'wasix\tpassed\tvalidated-full-memory-evidence\t2' "$2"
}

expect_failure() {
  local fixture="$1"
  local expected="$2"
  if "$validator" --samples "$fixture" "${common_args[@]}" \
    --output "$tmp/failure.out.tsv"
  then
    printf 'expected validation failure for %s\n' "$fixture" >&2
    exit 1
  fi
  grep -Fq "$expected" "$tmp/failure.out.tsv"
}

expect_budget_failure() {
  local expected="$1"
  shift
  if "$validator" --samples "$tmp/valid.tsv" "${common_args[@]}" "$@" \
    --output "$tmp/budget-failure.out.tsv"
  then
    printf 'expected budget validation failure containing %s\n' "$expected" >&2
    exit 1
  fi
  grep -Fq "$expected" "$tmp/budget-failure.out.tsv"
}

write_fixture "$tmp/valid.tsv"
run_valid "$tmp/valid.tsv" "$tmp/valid.out.tsv"

# A fully specified budget above every observation passes and records explicit
# units, limits, elapsed time, counter deltas, and derived fractions.
"$validator" --samples "$tmp/valid.tsv" "${common_args[@]}" \
  --max-peak-pss-kib 1300 \
  --max-peak-pss-anon-kib 900 \
  --max-peak-page-table-kib 70 \
  --max-cgroup-high-events-delta 6 \
  --max-psi-some-stall-fraction 0.11 \
  --max-psi-full-stall-fraction 0.05 \
  --output "$tmp/budget-positive.out.tsv"
grep -Fq 'budget.max_peak_pss_kib=1300;observed.peak_pss_kib=1200' \
  "$tmp/budget-positive.out.tsv"
grep -Fq 'observed.cgroup_budget_elapsed_ms=500' "$tmp/budget-positive.out.tsv"
grep -Fq 'observed.cgroup_high_events_delta=5' "$tmp/budget-positive.out.tsv"
grep -Fq 'observed.psi_some_delta_usec=50000;observed.psi_some_stall_fraction=0.100000000' \
  "$tmp/budget-positive.out.tsv"
grep -Fq 'observed.psi_full_delta_usec=20000;observed.psi_full_stall_fraction=0.040000000' \
  "$tmp/budget-positive.out.tsv"

# Every budget is inclusive at its exact boundary.
"$validator" --samples "$tmp/valid.tsv" "${common_args[@]}" \
  --max-peak-pss-kib 1200 \
  --max-peak-pss-anon-kib 800 \
  --max-peak-page-table-kib 60 \
  --max-cgroup-high-events-delta 5 \
  --max-psi-some-stall-fraction 0.1 \
  --max-psi-full-stall-fraction 0.04 \
  --output "$tmp/budget-boundary.out.tsv"
grep -Fq $'wasix\tpassed\tvalidated-full-memory-evidence;budget.scope=required-phases' \
  "$tmp/budget-boundary.out.tsv"

expect_budget_failure 'budget-exceeded:peak-pss-kib:observed-1200:limit-1199' \
  --max-peak-pss-kib 1199
expect_budget_failure 'budget-exceeded:peak-pss-anon-kib:observed-800:limit-799' \
  --max-peak-pss-anon-kib 799
expect_budget_failure 'budget-exceeded:peak-page-table-kib:observed-60:limit-59' \
  --max-peak-page-table-kib 59
expect_budget_failure 'budget-exceeded:cgroup-high-events-delta:observed-5:limit-4' \
  --max-cgroup-high-events-delta 4
expect_budget_failure 'budget-exceeded:psi-some-stall-fraction:observed-0.100000000:limit-0.099' \
  --max-psi-some-stall-fraction 0.099
expect_budget_failure 'budget-exceeded:psi-full-stall-fraction:observed-0.040000000:limit-0.039' \
  --max-psi-full-stall-fraction 0.039

# Required phases are aggregated independently. Pressure accumulated during an
# intervening non-required phase is not charged to either measured phase.
printf '%b\n' "$header" >"$tmp/multi-phase.tsv"
{
  printf '1000\twasix\tfanout:indexed-read\t1000\t700\t50\t/user.slice/test.scope\t0\t0\t10\t0\t0\t0\t268435456\t134217728\t0\t1000000\t1000\t500\tok\tok\n'
  printf '1500\twasix\tfanout:indexed-read\t1200\t800\t60\t/user.slice/test.scope\t0\t0\t15\t0\t0\t0\t268435456\t134217728\t0\t1100000\t51000\t20500\tok\tok\n'
  printf '2000\twasix\tidle\t1250\t825\t61\t/user.slice/test.scope\t0\t0\t100\t0\t0\t0\t268435456\t134217728\t0\t1150000\t200000\t100000\tok\tok\n'
  printf '2500\twasix\tfanout:indexed-update\t1300\t850\t62\t/user.slice/test.scope\t0\t0\t100\t0\t0\t0\t268435456\t134217728\t0\t1200000\t200000\t100000\tok\tok\n'
  printf '3000\twasix\tfanout:indexed-update\t1400\t900\t70\t/user.slice/test.scope\t0\t0\t102\t0\t0\t0\t268435456\t134217728\t0\t1250000\t225000\t110000\tok\tok\n'
} >>"$tmp/multi-phase.tsv"
"$validator" --samples "$tmp/multi-phase.tsv" --target wasix \
  --interval-seconds 0.5 \
  --require-phase fanout:indexed-read \
  --require-phase fanout:indexed-update \
  --require-cgroup yes --memory-max 256M --memory-high 128M --swap-max 0 \
  --max-peak-pss-kib 1400 \
  --max-cgroup-high-events-delta 7 \
  --max-psi-some-stall-fraction 0.075 \
  --max-psi-full-stall-fraction 0.03 \
  --output "$tmp/multi-phase.out.tsv"
grep -Fq 'observed.cgroup_budget_elapsed_ms=1000' "$tmp/multi-phase.out.tsv"
grep -Fq 'observed.cgroup_high_events_delta=7' "$tmp/multi-phase.out.tsv"
grep -Fq 'observed.psi_some_stall_fraction=0.075000000' "$tmp/multi-phase.out.tsv"
grep -Fq 'observed.psi_full_stall_fraction=0.030000000' "$tmp/multi-phase.out.tsv"

printf '%b\n' "$header" >"$tmp/no-cgroup.tsv"
printf '1000\tnative\tfanout:indexed-read\t1000\t700\t50\t\t\t\t\t\t\t\t\t\t\t\t\t\tok\tdisabled\n' \
  >>"$tmp/no-cgroup.tsv"
"$validator" --samples "$tmp/no-cgroup.tsv" --target native \
  --interval-seconds 0.5 --require-phase fanout:indexed-read \
  --require-cgroup no --output "$tmp/no-cgroup.out.tsv"
grep -Fq $'native\tpassed\tvalidated-full-memory-evidence\t1' \
  "$tmp/no-cgroup.out.tsv"

write_fixture "$tmp/missing-phase-source.tsv" ok ok 0 0 268435456 1500 idle
sed 's/fanout:indexed-read/idle/g' "$tmp/missing-phase-source.tsv" \
  >"$tmp/missing-phase.tsv"
expect_failure "$tmp/missing-phase.tsv" 'phase-missing:fanout:indexed-read'
write_fixture "$tmp/raced.tsv" raced
expect_failure "$tmp/raced.tsv" 'smaps-raced:fanout:indexed-read'
write_fixture "$tmp/unavailable.tsv" ok unavailable
expect_failure "$tmp/unavailable.tsv" 'cgroup-unavailable:fanout:indexed-read'
write_fixture "$tmp/swap.tsv" ok ok 4096
expect_failure "$tmp/swap.tsv" 'swap-current-nonzero'
write_fixture "$tmp/max-event.tsv" ok ok 0 1
expect_failure "$tmp/max-event.tsv" 'memory-max-event'
write_fixture "$tmp/limit.tsv" ok ok 0 0 999
expect_failure "$tmp/limit.tsv" 'memory-max-mismatch'
write_fixture "$tmp/cadence.tsv" ok ok 0 0 268435456 4000
expect_failure "$tmp/cadence.tsv" 'cadence-gap'

# Dynamic preparation can legitimately take longer than the sampler cadence.
# The first required-phase row begins a new evidence interval rather than
# inheriting a setup/checkpoint gap that it could not observe.
printf '%b\n' "$header" >"$tmp/phase-transition-gap.tsv"
{
  printf '1000\twasix\tcheckpoint:indexed-read\t1000\t700\t50\t/user.slice/test.scope\t0\t0\t10\t0\t0\t0\t268435456\t134217728\t0\t1000000\t1000\t500\tok\tok\n'
  printf '4000\twasix\tfanout:indexed-read\t1200\t800\t60\t/user.slice/test.scope\t0\t0\t15\t0\t0\t0\t268435456\t134217728\t0\t1100000\t51000\t20500\tok\tok\n'
} >>"$tmp/phase-transition-gap.tsv"
run_valid "$tmp/phase-transition-gap.tsv" "$tmp/phase-transition-gap.out.tsv"

# A budget request independently requires its evidence source. This remains
# fail-closed even when the general cgroup contract was not requested.
if "$validator" --samples "$tmp/no-cgroup.tsv" --target native \
  --interval-seconds 0.5 --require-phase fanout:indexed-read \
  --require-cgroup no --max-cgroup-high-events-delta 0 \
  --output "$tmp/budget-unavailable-cgroup.out.tsv"
then
  echo 'expected unavailable cgroup budget failure' >&2
  exit 1
fi
grep -Fq 'cgroup-disabled:fanout:indexed-read' \
  "$tmp/budget-unavailable-cgroup.out.tsv"

head -n 2 "$tmp/valid.tsv" >"$tmp/one-cgroup-sample.tsv"
if "$validator" --samples "$tmp/one-cgroup-sample.tsv" "${common_args[@]}" \
  --max-psi-some-stall-fraction 1 \
  --output "$tmp/budget-unavailable-interval.out.tsv"
then
  echo 'expected unavailable cgroup interval failure' >&2
  exit 1
fi
grep -Fq 'budget-cgroup-interval-unavailable:fanout:indexed-read' \
  "$tmp/budget-unavailable-interval.out.tsv"

awk -F '\t' -v OFS='\t' '
  NR == 1 { for (i = 1; i <= NF; i++) column[$i] = i }
  NR == 2 { $(column["pss_kb_total"]) = "" }
  { print }
' "$tmp/valid.tsv" >"$tmp/missing-pss.tsv"
if "$validator" --samples "$tmp/missing-pss.tsv" "${common_args[@]}" \
  --max-peak-pss-kib 2000 --output "$tmp/budget-unavailable-pss.out.tsv"
then
  echo 'expected unavailable PSS budget failure' >&2
  exit 1
fi
grep -Fq 'smaps-counter-unavailable:pss_kb_total' \
  "$tmp/budget-unavailable-pss.out.tsv"

awk -F '\t' -v OFS='\t' '
  NR == 1 { for (i = 1; i <= NF; i++) column[$i] = i }
  NR == 2 { $(column["cgroup_memory_pressure_some_total_usec"]) = "" }
  { print }
' "$tmp/valid.tsv" >"$tmp/missing-psi.tsv"
if "$validator" --samples "$tmp/missing-psi.tsv" --target wasix \
  --interval-seconds 0.5 --require-phase fanout:indexed-read \
  --require-cgroup no --max-psi-some-stall-fraction 1 \
  --output "$tmp/budget-unavailable-psi.out.tsv"
then
  echo 'expected unavailable PSI counter failure' >&2
  exit 1
fi
grep -Fq 'cgroup-counter-unavailable:cgroup_memory_pressure_some_total_usec' \
  "$tmp/budget-unavailable-psi.out.tsv"

for invalid in -1 1.01 nan 1e-2; do
  if "$validator" --samples "$tmp/valid.tsv" "${common_args[@]}" \
    --max-psi-some-stall-fraction "$invalid" \
    --output "$tmp/invalid-fraction.out.tsv" >/dev/null 2>&1
  then
    printf 'expected invalid PSI fraction rejection: %s\n' "$invalid" >&2
    exit 1
  fi
done
if "$validator" --samples "$tmp/valid.tsv" "${common_args[@]}" \
  --max-peak-pss-kib 1.5 --output "$tmp/invalid-kib.out.tsv" >/dev/null 2>&1
then
  echo 'expected invalid KiB budget rejection' >&2
  exit 1
fi
for invalid in '' 9007199254740992; do
  if "$validator" --samples "$tmp/valid.tsv" "${common_args[@]}" \
    --max-cgroup-high-events-delta "$invalid" \
    --output "$tmp/invalid-high-events.out.tsv" >/dev/null 2>&1
  then
    printf 'expected invalid high-event budget rejection: %s\n' "$invalid" >&2
    exit 1
  fi
done

printf 'passed: memory evidence validation\n'
