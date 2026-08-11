#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bench="$root/bin/bench-wasix-concurrent-query-suite.sh"
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT

sed -n '/^monitor_resource_usage()/,/^summarize_resource_usage()/p' "$bench" |
  sed '$d' >"$tmp/monitor.sh"
# shellcheck source=/dev/null
source "$tmp/monitor.sh"

scenario=""
scenario_root=""
scenario_stop_file=""

counter_value() {
  local name="$1"
  local value

  value="$(<"$scenario_root/$name.count")"
  printf '%s\n' "$value"
}

advance_counter() {
  local name="$1"
  local value

  value="$(counter_value "$name")"
  value=$((value + 1))
  printf '%s\n' "$value" >"$scenario_root/$name.count"
  printf '%s\n' "$value"
}

new_scenario() {
  scenario="$1"
  scenario_root="$tmp/$scenario"
  scenario_stop_file="$scenario_root/stop"
  mkdir -p "$scenario_root"
  printf 'fanout:indexed-read\n' >"$scenario_root/phase"
  printf '0\n' >"$scenario_root/snapshot.count"
  printf '0\n' >"$scenario_root/cgroup.count"
  printf '0\n' >"$scenario_root/fd.count"
  printf '0\n' >"$scenario_root/ps.count"
  printf '0\n' >"$scenario_root/smaps.count"
  printf '0\n' >"$scenario_root/sleep.count"
}

now_ms() {
  printf '%s\n' "$((1000 + $(counter_value snapshot)))"
}

uname() {
  printf 'Linux\n'
}

collect_process_tree_snapshot() {
  local call

  call="$(advance_counter snapshot)"
  case "$scenario" in
    race-then-stable)
      case "$call" in
        1 | 3 | 4) printf '10\tbirth-a\n' ;;
        2) printf '10\tbirth-a\n11\tbirth-b\n' ;;
        *)
          printf 'unexpected race-then-stable snapshot call: %s\n' "$call" >&2
          return 1
          ;;
      esac
      [ "$call" -ne 4 ] || : >"$scenario_stop_file"
      ;;
    persistent-race)
      printf '10\tbirth-a\n'
      if ((call % 2 == 0)); then
        printf '%s\tbirth-%s\n' "$((100 + call))" "$call"
      fi
      [ "$call" -ne 8 ] || : >"$scenario_stop_file"
      ;;
    light-stable)
      [ "$call" -le 2 ] || {
        printf 'unexpected light-stable snapshot call: %s\n' "$call" >&2
        return 1
      }
      printf '10\tbirth-a\n'
      [ "$call" -ne 2 ] || : >"$scenario_stop_file"
      ;;
    stable-cadence)
      [ "$call" -le 4 ] || {
        printf 'unexpected stable-cadence snapshot call: %s\n' "$call" >&2
        return 1
      }
      printf '10\tbirth-a\n'
      [ "$call" -ne 4 ] || : >"$scenario_stop_file"
      ;;
    phase-change-then-stable)
      [ "$call" -le 4 ] || {
        printf 'unexpected phase-change-then-stable snapshot call: %s\n' \
          "$call" >&2
        return 1
      }
      printf '10\tbirth-a\n'
      if [ "$call" -eq 2 ]; then
        printf 'fanout:indexed-read\n' >"$scenario_root/phase"
      elif [ "$call" -eq 4 ]; then
        : >"$scenario_stop_file"
      fi
      ;;
    persistent-phase-change)
      [ "$call" -le 8 ] || {
        printf 'unexpected persistent-phase-change snapshot call: %s\n' \
          "$call" >&2
        return 1
      }
      printf '10\tbirth-a\n'
      if ((call % 2 == 0)); then
        if ((((call / 2)) % 2 == 1)); then
          printf 'fanout:indexed-update\n' >"$scenario_root/phase"
        else
          printf 'fanout:indexed-read\n' >"$scenario_root/phase"
        fi
      fi
      ;;
    empty-tree)
      [ "$call" -ne 4 ] || : >"$scenario_stop_file"
      ;;
    *)
      printf 'unknown monitor mock scenario: %s\n' "$scenario" >&2
      return 1
      ;;
  esac
}

print_cgroup_metrics() {
  local memory_current="$1"

  printf '/fixture.scope\t%s\t125000000\t0\t0\t2\t0\t0\t0\t0\t268435456\t234881024\t0\t70000000\t50000000\t0\t1000000\t64000\t2000000\t4096\t0\t10\t5\t100\t200\t50\t10\t2\t1\t100\t80\tcomplete\tnone\tmemory.events.local\n' \
    "$memory_current"
}

collect_linux_cgroup_metrics() {
  local call

  call="$(advance_counter cgroup)"
  if { [ "$scenario" = race-then-stable ] ||
      [ "$scenario" = phase-change-then-stable ]; } && [ "$call" -eq 1 ]; then
    print_cgroup_metrics 999999999
  else
    print_cgroup_metrics 120000000
  fi
}

fresh_collect_host_fd_occupancy() {
  local call

  call="$(advance_counter fd)"
  if { [ "$scenario" = race-then-stable ] ||
      [ "$scenario" = phase-change-then-stable ]; } && [ "$call" -eq 1 ]; then
    printf '999\t1\t1\tok\n'
  elif [ "$scenario" = persistent-race ]; then
    printf '777\t1\t1\tok\n'
  else
    printf '7\t1\t1\tok\n'
  fi
}

ps() {
  local call

  call="$(advance_counter ps)"
  if { [ "$scenario" = race-then-stable ] ||
      [ "$scenario" = phase-change-then-stable ]; } && [ "$call" -eq 1 ]; then
    printf '999 1999 99.9\n'
  elif [ "$scenario" = persistent-race ]; then
    printf '777 888 9.9\n'
  else
    printf '100 200 1.0\n'
  fi
}

collect_linux_smaps_rollup() {
  local call

  call="$(advance_counter smaps)"
  if { [ "$scenario" = race-then-stable ] ||
      [ "$scenario" = phase-change-then-stable ]; } && [ "$call" -eq 1 ]; then
    printf '999\t999\t999\t999\t999\t999\t999\t999\t1\t999\t999\t999\t999\n'
  elif [ "$scenario" = persistent-race ]; then
    printf '777\t700\t77\t0\t750\t27\t710\t0\t1\t9\t8\t375\t375\n'
  else
    printf '10\t6\t4\t0\t8\t2\t7\t0\t1\t3\t1\t4\t4\n'
  fi
}

sleep() {
  advance_counter sleep >/dev/null
}

run_monitor() {
  local detail="$1"

  # These globals are consumed by the monitor function extracted above.
  # shellcheck disable=SC2034
  cgroup_memory_max=268435456 cgroup_memory_high=234881024 cgroup_swap_max=0
  monitor_resource_usage wasix 10 "$scenario_root/phase" "$scenario_stop_file" \
    "$scenario_root/samples.tsv" 0.5 "$detail" \
    2>"$scenario_root/monitor.log"
}

assert_one_data_row() {
  local samples="$1"

  [ "$(wc -l <"$samples" | tr -d '[:space:]')" -eq 2 ] || {
    printf 'expected exactly one resource data row: %s\n' "$samples" >&2
    return 1
  }
  awk -F '\t' '
    NR == 1 && (NF != 66 || $66 != "process_tree_status") { exit 1 }
    NR == 2 && NF != 66 { exit 1 }
  ' "$samples" || {
    printf 'resource monitor did not emit the 66-column process-tree schema: %s\n' \
      "$samples" >&2
    return 1
  }
}

new_scenario race-then-stable
run_monitor full
assert_one_data_row "$scenario_root/samples.tsv"
[ "$(counter_value snapshot)" -eq 4 ]
[ "$(counter_value cgroup)" -eq 2 ]
[ "$(counter_value fd)" -eq 2 ]
[ "$(counter_value ps)" -eq 2 ]
[ "$(counter_value smaps)" -eq 2 ]
[ "$(counter_value sleep)" -eq 0 ]
[ "$(grep -c 'resource sample process-tree race; retry=1/3' \
  "$scenario_root/monitor.log")" -eq 1 ]
if grep -Eq '999|1999|99[.]9' "$scenario_root/samples.tsv"; then
  echo 'a discarded raced attempt leaked sentinel metrics into the stable row' >&2
  exit 1
fi
awk -F '\t' '
  NR == 2 {
    if ($5 != 1 || $6 != 100 || $7 != 200 || $8 != "1.0" || $9 != 100 ||
        $10 !~ /^10 *$/ || $11 != 10 || $19 != 1 || $24 != "/fixture.scope" ||
        $25 != 120000000 || $47 != 7 || $48 != 1 || $49 != 1 ||
        $50 != "ok" || $51 != 1 || $52 != 1 || $53 != "ok" ||
        $54 != "ok" || $55 != 100 || $65 != "memory.events.local" ||
        $66 != "ok") exit 1
  }
' "$scenario_root/samples.tsv" || {
  echo 'stable retry row did not contain only the second capture' >&2
  exit 1
}

new_scenario persistent-race
run_monitor full
assert_one_data_row "$scenario_root/samples.tsv"
[ "$(counter_value snapshot)" -eq 8 ]
[ "$(counter_value cgroup)" -eq 4 ]
[ "$(counter_value fd)" -eq 4 ]
[ "$(counter_value ps)" -eq 4 ]
[ "$(counter_value smaps)" -eq 4 ]
[ "$(counter_value sleep)" -eq 0 ]
[ "$(grep -c 'resource sample process-tree race; retry=' \
  "$scenario_root/monitor.log")" -eq 3 ]
if grep -Eq '777|888|9[.]9' "$scenario_root/samples.tsv"; then
  echo 'an exhausted process-tree race retained non-atomic process metrics' >&2
  exit 1
fi
awk -F '\t' '
  NR == 2 {
    if ($5 != 0 || $6 != 0 || $7 != 0 || $8 != "0.0" || $9 != 0 ||
        $10 != "" || $24 != "/fixture.scope" || $25 != 120000000 ||
        $47 != "" || $48 != 0 || $49 != 1 || $50 != "raced" ||
        $51 != 1 || $52 != 1 || $53 != "raced" || $54 != "ok" ||
        $55 != 100 || $65 != "memory.events.local" || $66 != "raced") exit 1
    for (column = 11; column <= 23; column++) if ($column != "") exit 1
  }
' "$scenario_root/samples.tsv" || {
  echo 'exhausted race row did not isolate process metrics from cgroup metrics' >&2
  exit 1
}

new_scenario light-stable
run_monitor light
assert_one_data_row "$scenario_root/samples.tsv"
[ "$(counter_value snapshot)" -eq 2 ]
[ "$(counter_value smaps)" -eq 0 ]
[ "$(counter_value sleep)" -eq 0 ]
[ ! -s "$scenario_root/monitor.log" ]
awk -F '\t' '
  NR == 2 {
    if ($5 != 1 || $6 != 100 || $10 !~ /^10 *$/ || $50 != "ok" ||
        $51 != 1 || $52 != 0 || $53 != "disabled" || $54 != "ok" ||
        $66 != "ok") exit 1
    for (column = 11; column <= 23; column++) if ($column != "") exit 1
  }
' "$scenario_root/samples.tsv" || {
  echo 'light-detail row lost independent process-tree status semantics' >&2
  exit 1
}

new_scenario persistent-race
run_monitor light
assert_one_data_row "$scenario_root/samples.tsv"
[ "$(counter_value snapshot)" -eq 8 ]
[ "$(counter_value smaps)" -eq 0 ]
[ "$(counter_value sleep)" -eq 0 ]
[ "$(grep -c 'resource sample process-tree race; retry=' \
  "$scenario_root/monitor.log")" -eq 3 ]
awk -F '\t' '
  NR == 2 {
    if ($5 != 0 || $6 != 0 || $7 != 0 || $8 != "0.0" || $9 != 0 ||
        $10 != "" || $47 != "" || $48 != 0 || $49 != 1 ||
        $50 != "raced" || $51 != 1 || $52 != 0 || $53 != "raced" ||
        $54 != "ok" || $66 != "raced") exit 1
    for (column = 11; column <= 23; column++) if ($column != "") exit 1
  }
' "$scenario_root/samples.tsv" || {
  echo 'light-detail exhaustion retained disabled or non-atomic process evidence' >&2
  exit 1
}

new_scenario stable-cadence
run_monitor full
[ "$(wc -l <"$scenario_root/samples.tsv" | tr -d '[:space:]')" -eq 3 ]
[ "$(counter_value snapshot)" -eq 4 ]
[ "$(counter_value cgroup)" -eq 2 ]
[ "$(counter_value fd)" -eq 2 ]
[ "$(counter_value ps)" -eq 2 ]
[ "$(counter_value smaps)" -eq 2 ]
[ "$(counter_value sleep)" -eq 1 ]
[ ! -s "$scenario_root/monitor.log" ]
awk -F '\t' '
  NR == 1 && (NF != 66 || $66 != "process_tree_status") { exit 1 }
  NR > 1 && (NF != 66 || $66 != "ok") { exit 1 }
' "$scenario_root/samples.tsv" || {
  echo 'stable monitor cadence changed while adding immediate retries' >&2
  exit 1
}

new_scenario phase-change-then-stable
printf 'fanout-preparing:indexed-read\n' >"$scenario_root/phase"
run_monitor full
assert_one_data_row "$scenario_root/samples.tsv"
[ "$(counter_value snapshot)" -eq 4 ]
[ "$(counter_value cgroup)" -eq 2 ]
[ "$(counter_value fd)" -eq 2 ]
[ "$(counter_value ps)" -eq 2 ]
[ "$(counter_value smaps)" -eq 2 ]
[ "$(counter_value sleep)" -eq 0 ]
[ "$(grep -c 'resource sample phase changed during capture; retry=1/3 target=wasix from=fanout-preparing:indexed-read to=fanout:indexed-read' \
  "$scenario_root/monitor.log")" -eq 1 ]
if grep -Eq '999|1999|99[.]9|fanout-preparing' "$scenario_root/samples.tsv"; then
  echo 'a cross-phase capture leaked its attribution or sentinel metrics' >&2
  exit 1
fi
awk -F '\t' '
  NR == 2 {
    if ($3 != "fanout:indexed-read" || $5 != 1 || $6 != 100 ||
        $7 != 200 || $8 != "1.0" || $9 != 100 || $11 != 10 ||
        $24 != "/fixture.scope" || $25 != 120000000 || $47 != 7 ||
        $53 != "ok" || $54 != "ok" || $66 != "ok") exit 1
  }
' "$scenario_root/samples.tsv" || {
  echo 'phase-bracket retry did not publish only the stable destination phase' >&2
  exit 1
}

new_scenario persistent-phase-change
if run_monitor full; then
  echo 'persistently unstable phase attribution passed the bounded monitor' >&2
  exit 1
fi
[ "$(wc -l <"$scenario_root/samples.tsv" | tr -d '[:space:]')" -eq 1 ]
[ "$(counter_value snapshot)" -eq 8 ]
[ "$(counter_value cgroup)" -eq 4 ]
[ "$(counter_value fd)" -eq 4 ]
[ "$(counter_value ps)" -eq 4 ]
[ "$(counter_value smaps)" -eq 4 ]
[ "$(counter_value sleep)" -eq 0 ]
[ "$(grep -c 'resource sample phase changed during capture; retry=' \
  "$scenario_root/monitor.log")" -eq 3 ]
[ "$(grep -c 'resource sample phase remained unstable after 3 retries;' \
  "$scenario_root/monitor.log")" -eq 1 ]

new_scenario empty-tree
run_monitor full
assert_one_data_row "$scenario_root/samples.tsv"
[ "$(counter_value snapshot)" -eq 4 ]
[ "$(counter_value cgroup)" -eq 0 ]
[ "$(counter_value fd)" -eq 0 ]
[ "$(counter_value ps)" -eq 0 ]
[ "$(counter_value smaps)" -eq 0 ]
[ "$(counter_value sleep)" -eq 0 ]
[ "$(grep -c 'resource sample empty process tree; retry=' \
  "$scenario_root/monitor.log")" -eq 3 ]
awk -F '\t' '
  NR == 2 {
    if ($5 != 0 || $6 != 0 || $7 != 0 || $8 != "0.0" || $9 != 0 ||
        $10 != "" || $47 != "" || $48 != 0 || $49 != 0 ||
        $50 != "raced" || $51 != 0 || $52 != 0 || $53 != "raced" ||
        $54 != "unavailable" || $66 != "raced") exit 1
  }
' "$scenario_root/samples.tsv" || {
  echo 'empty-tree retry did not terminate with a structured raced row' >&2
  exit 1
}

printf 'passed: resource monitor retries discard raced process metrics and retain independent evidence\n'
