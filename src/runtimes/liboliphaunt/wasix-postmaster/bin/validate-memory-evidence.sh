#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: validate-memory-evidence.sh --samples FILE --target NAME
       --interval-seconds N --require-phase NAME [--require-phase NAME ...]
       --require-cgroup yes|no [--memory-max LIMIT] [--memory-high LIMIT]
       [--swap-max LIMIT]
       [--max-peak-pss-kib N] [--max-peak-pss-anon-kib N]
       [--max-peak-page-table-kib N]
       [--max-cgroup-high-events-delta N]
       [--max-psi-some-stall-fraction F]
       [--max-psi-full-stall-fraction F]
       --output FILE

Validate full-detail memory evidence. Required phases must have race-free smaps
and, when requested, complete cgroup-v2 samples with the exact configured
limits, zero swap use, and no memory.max/OOM events. Missing optional cgroup
files remain unavailable; they are never interpreted as zero.

Timestamps must increase globally. Cadence gaps are gated between consecutive
samples of the same required phase; setup, checkpoint, backend preparation,
drain, and shutdown transitions are intentionally outside that claim.

Performance budgets are optional and preserve the unbudgeted validation
contract when omitted. KiB limits apply to the global maximum over all valid
samples in the required phases. Cgroup high-event and PSI budgets sum the
first-to-last counter delta within each required phase; every such phase must
be one contiguous interval with at least two valid cgroup samples. PSI stall
fractions are counter-delta microseconds divided by monotonic elapsed
microseconds and must be between 0 and 1 inclusive. Requesting a cgroup budget
requires usable cgroup evidence even when --require-cgroup is no.
USAGE
}

samples=""
target=""
interval_seconds=""
require_cgroup=""
memory_max=""
memory_high=""
swap_max=""
max_peak_pss_kib=""
max_peak_pss_anon_kib=""
max_peak_page_table_kib=""
max_cgroup_high_events_delta=""
max_psi_some_stall_fraction=""
max_psi_full_stall_fraction=""
output=""
required_phases=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    --samples) shift; [ "$#" -gt 0 ] || exit 2; samples="$1" ;;
    --target) shift; [ "$#" -gt 0 ] || exit 2; target="$1" ;;
    --interval-seconds) shift; [ "$#" -gt 0 ] || exit 2; interval_seconds="$1" ;;
    --require-phase) shift; [ "$#" -gt 0 ] || exit 2; required_phases+=("$1") ;;
    --require-cgroup) shift; [ "$#" -gt 0 ] || exit 2; require_cgroup="$1" ;;
    --memory-max) shift; [ "$#" -gt 0 ] || exit 2; memory_max="$1" ;;
    --memory-high) shift; [ "$#" -gt 0 ] || exit 2; memory_high="$1" ;;
    --swap-max) shift; [ "$#" -gt 0 ] || exit 2; swap_max="$1" ;;
    --max-peak-pss-kib) shift; [ "$#" -gt 0 ] && [ -n "$1" ] || exit 2; max_peak_pss_kib="$1" ;;
    --max-peak-pss-anon-kib) shift; [ "$#" -gt 0 ] && [ -n "$1" ] || exit 2; max_peak_pss_anon_kib="$1" ;;
    --max-peak-page-table-kib) shift; [ "$#" -gt 0 ] && [ -n "$1" ] || exit 2; max_peak_page_table_kib="$1" ;;
    --max-cgroup-high-events-delta) shift; [ "$#" -gt 0 ] && [ -n "$1" ] || exit 2; max_cgroup_high_events_delta="$1" ;;
    --max-psi-some-stall-fraction) shift; [ "$#" -gt 0 ] && [ -n "$1" ] || exit 2; max_psi_some_stall_fraction="$1" ;;
    --max-psi-full-stall-fraction) shift; [ "$#" -gt 0 ] && [ -n "$1" ] || exit 2; max_psi_full_stall_fraction="$1" ;;
    --output) shift; [ "$#" -gt 0 ] || exit 2; output="$1" ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if [ -z "$samples" ] || [ ! -r "$samples" ]; then
  echo '--samples must be readable' >&2
  exit 2
fi
[ -n "$target" ] || { echo '--target is required' >&2; exit 2; }
if ! [[ "$interval_seconds" =~ ^([0-9]+([.][0-9]*)?|[.][0-9]+)$ ]] ||
  ! awk -v value="$interval_seconds" 'BEGIN { exit !(value > 0) }'
then
  echo '--interval-seconds requires a positive number' >&2
  exit 2
fi
case "$require_cgroup" in yes|no) ;; *) echo '--require-cgroup requires yes or no' >&2; exit 2 ;; esac
[ "${#required_phases[@]}" -gt 0 ] || { echo 'at least one --require-phase is required' >&2; exit 2; }
[ -n "$output" ] || { echo '--output is required' >&2; exit 2; }

validate_unsigned_budget() {
  local option="$1"
  local value="$2"
  [ -z "$value" ] && return 0
  case "$value" in
    *[!0-9]*|"") printf '%s requires a nonnegative integer\n' "$option" >&2; exit 2 ;;
  esac
  awk -v value="$value" 'BEGIN { exit !(value <= 9007199254740991) }' || {
    printf '%s exceeds the exact integer range supported by the validator\n' \
      "$option" >&2
    exit 2
  }
}

validate_fraction_budget() {
  local option="$1"
  local value="$2"
  [ -z "$value" ] && return 0
  if ! [[ "$value" =~ ^([0-9]+([.][0-9]*)?|[.][0-9]+)$ ]] ||
    ! awk -v value="$value" 'BEGIN { exit !(value >= 0 && value <= 1) }'
  then
    printf '%s requires a decimal fraction between 0 and 1 inclusive\n' \
      "$option" >&2
    exit 2
  fi
}

validate_unsigned_budget --max-peak-pss-kib "$max_peak_pss_kib"
validate_unsigned_budget --max-peak-pss-anon-kib "$max_peak_pss_anon_kib"
validate_unsigned_budget --max-peak-page-table-kib "$max_peak_page_table_kib"
validate_unsigned_budget --max-cgroup-high-events-delta \
  "$max_cgroup_high_events_delta"
validate_fraction_budget --max-psi-some-stall-fraction \
  "$max_psi_some_stall_fraction"
validate_fraction_budget --max-psi-full-stall-fraction \
  "$max_psi_full_stall_fraction"

smaps_budget_requested=0
if [ -n "$max_peak_pss_kib$max_peak_pss_anon_kib$max_peak_page_table_kib" ]; then
  smaps_budget_requested=1
fi
cgroup_budget_requested=0
if [ -n "$max_cgroup_high_events_delta$max_psi_some_stall_fraction$max_psi_full_stall_fraction" ]; then
  cgroup_budget_requested=1
fi

normalize_limit() {
  local value="$1"
  awk -v value="$value" '
    BEGIN {
      if (value == "") { print ""; exit }
      if (value == "max" || value == "infinity") { print "max"; exit }
      if (value !~ /^[0-9]+([KMGTPE](iB|B)?|B)?$/) exit 1
      number = value
      sub(/[^0-9].*$/, "", number)
      suffix = substr(value, length(number) + 1)
      gsub(/[iIbB]/, "", suffix)
      multiplier = 1
      if (suffix == "K") multiplier = 1024
      else if (suffix == "M") multiplier = 1024 * 1024
      else if (suffix == "G") multiplier = 1024 * 1024 * 1024
      else if (suffix == "T") multiplier = 1024 * 1024 * 1024 * 1024
      else if (suffix == "P") multiplier = 1024 * 1024 * 1024 * 1024 * 1024
      else if (suffix == "E") multiplier = 1024 * 1024 * 1024 * 1024 * 1024 * 1024
      printf "%.0f\n", number * multiplier
    }
  '
}

normalized_memory_max="$(normalize_limit "$memory_max")" || {
  printf 'unsupported --memory-max value: %s\n' "$memory_max" >&2; exit 2;
}
normalized_memory_high="$(normalize_limit "$memory_high")" || {
  printf 'unsupported --memory-high value: %s\n' "$memory_high" >&2; exit 2;
}
normalized_swap_max="$(normalize_limit "$swap_max")" || {
  printf 'unsupported --swap-max value: %s\n' "$swap_max" >&2; exit 2;
}
if [ "$require_cgroup" = yes ]; then
  [ -n "$normalized_memory_max" ] || normalized_memory_max=max
  [ -n "$normalized_memory_high" ] || normalized_memory_high=max
  [ -n "$normalized_swap_max" ] || normalized_swap_max=max
fi

phase_list=""
for phase in "${required_phases[@]}"; do
  case "$phase" in
    ""|*'|'*|*$'\t'*|*$'\n'*) echo 'invalid required phase' >&2; exit 2 ;;
  esac
  case "|$phase_list|" in *"|$phase|"*) echo "duplicate required phase: $phase" >&2; exit 2 ;; esac
  if [ -n "$phase_list" ]; then phase_list="$phase_list|$phase"; else phase_list="$phase"; fi
done

tmp_output="$output.tmp.$$"
trap 'rm -f -- "$tmp_output"' EXIT
set +e
detail="$(awk -F '\t' \
  -v expected_target="$target" \
  -v interval_ms="$(awk -v value="$interval_seconds" 'BEGIN { printf "%.0f", value * 1000 }')" \
  -v required="$phase_list" \
  -v require_cgroup="$require_cgroup" \
  -v expected_memory_max="$normalized_memory_max" \
  -v expected_memory_high="$normalized_memory_high" \
  -v expected_swap_max="$normalized_swap_max" \
  -v smaps_budget_requested="$smaps_budget_requested" \
  -v cgroup_budget_requested="$cgroup_budget_requested" \
  -v max_peak_pss_kib="$max_peak_pss_kib" \
  -v max_peak_pss_anon_kib="$max_peak_pss_anon_kib" \
  -v max_peak_page_table_kib="$max_peak_page_table_kib" \
  -v max_cgroup_high_events_delta="$max_cgroup_high_events_delta" \
  -v max_psi_some_stall_fraction="$max_psi_some_stall_fraction" \
  -v max_psi_full_stall_fraction="$max_psi_full_stall_fraction" '
  function fail(message) {
    if (failure == "") failure = message
  }
  function unsigned(value) { return value ~ /^[0-9]+$/ }
  function add_diagnostic(name, value) {
    diagnostics = diagnostics ";" name "=" value
  }
  function observe_cumulative(name, value, row) {
    if (!unsigned(value)) {
      fail("cgroup-counter-unavailable:" name ":row-" row)
      return 0
    }
    if (have_cumulative[name] && (value + 0) < previous_cumulative[name])
      fail("cgroup-counter-decreased:" name ":row-" row)
    previous_cumulative[name] = value + 0
    have_cumulative[name] = 1
    return 1
  }
  BEGIN {
    required_count = split(required, required_phase, "|")
    for (i = 1; i <= required_count; i++) required_set[required_phase[i]] = 1
    max_gap_ms = interval_ms * 4 + 500

    if (require_cgroup == "yes") {
      cumulative_required["cgroup_scope_memory_peak_bytes"] = 1
      cumulative_required["cgroup_scope_swap_peak_bytes"] = 1
      cumulative_required["cgroup_scope_event_max_total"] = 1
      cumulative_required["cgroup_scope_event_oom_total"] = 1
      cumulative_required["cgroup_scope_event_oom_kill_total"] = 1
      cumulative_required["cgroup_memory_pressure_some_total_usec"] = 1
      cumulative_required["cgroup_memory_pressure_full_total_usec"] = 1
    }
    if (max_cgroup_high_events_delta != "")
      cumulative_required["cgroup_scope_event_high_total"] = 1
    if (max_psi_some_stall_fraction != "")
      cumulative_required["cgroup_memory_pressure_some_total_usec"] = 1
    if (max_psi_full_stall_fraction != "")
      cumulative_required["cgroup_memory_pressure_full_total_usec"] = 1
  }
  NR == 1 {
    for (i = 1; i <= NF; i++) column[$i] = i
    needed = "monotonic_ms target phase cgroup_path cgroup_swap_current_bytes cgroup_scope_swap_peak_bytes cgroup_scope_event_max_total cgroup_scope_event_oom_total cgroup_scope_event_oom_kill_total cgroup_memory_max cgroup_memory_high cgroup_swap_max cgroup_scope_memory_peak_bytes cgroup_memory_pressure_some_total_usec cgroup_memory_pressure_full_total_usec smaps_status cgroup_status"
    if (max_peak_pss_kib != "") needed = needed " pss_kb_total"
    if (max_peak_pss_anon_kib != "") needed = needed " pss_anon_kb_total"
    if (max_peak_page_table_kib != "") needed = needed " page_table_kb_total"
    if (max_cgroup_high_events_delta != "")
      needed = needed " cgroup_scope_event_high_total"
    split(needed, names, " ")
    for (i in names) if (!(names[i] in column)) fail("missing-column:" names[i])
    next
  }
  {
    rows++
    timestamp = $(column["monotonic_ms"])
    row_target = $(column["target"])
    phase = $(column["phase"])
    smaps_status = $(column["smaps_status"])
    cgroup_status = $(column["cgroup_status"])
    required_row = phase in required_set
    if (!unsigned(timestamp)) fail("invalid-monotonic-ms:row-" NR)
    if (row_target != expected_target) fail("target-mismatch:row-" NR)
    if (have_timestamp) {
      if ((timestamp + 0) <= previous_timestamp) fail("non-monotonic-cadence:row-" NR)
      else if (required_row && previous_phase == phase &&
               (timestamp + 0) - previous_timestamp > max_gap_ms)
        fail("cadence-gap:row-" NR ":" ((timestamp + 0) - previous_timestamp) "ms")
    }
    previous_timestamp = timestamp + 0
    previous_phase = phase
    have_timestamp = 1
    if (cgroup_budget_requested) {
      if (!required_row) {
        if (active_budget_phase != "") {
          closed_budget_phase[active_budget_phase] = 1
          active_budget_phase = ""
        }
      } else if (phase != active_budget_phase) {
        if (closed_budget_phase[phase])
          fail("budget-phase-noncontiguous:" phase ":row-" NR)
        if (active_budget_phase != "")
          closed_budget_phase[active_budget_phase] = 1
        active_budget_phase = phase
      }
    }
    if (!required_row) next
    phase_rows[phase]++
    if (smaps_status != "ok") fail("smaps-" smaps_status ":" phase ":row-" NR)
    else {
      phase_smaps_ok[phase]++
      if (max_peak_pss_kib != "") {
        value = $(column["pss_kb_total"])
        if (!unsigned(value)) {
          fail("smaps-counter-unavailable:pss_kb_total:row-" NR)
          invalid_peak_pss = 1
        }
        else if (!have_peak_pss || (value + 0) > peak_pss_kib) {
          peak_pss_kib = value + 0
          have_peak_pss = 1
        }
      }
      if (max_peak_pss_anon_kib != "") {
        value = $(column["pss_anon_kb_total"])
        if (!unsigned(value)) {
          fail("smaps-counter-unavailable:pss_anon_kb_total:row-" NR)
          invalid_peak_pss_anon = 1
        }
        else if (!have_peak_pss_anon || (value + 0) > peak_pss_anon_kib) {
          peak_pss_anon_kib = value + 0
          have_peak_pss_anon = 1
        }
      }
      if (max_peak_page_table_kib != "") {
        value = $(column["page_table_kb_total"])
        if (!unsigned(value)) {
          fail("smaps-counter-unavailable:page_table_kb_total:row-" NR)
          invalid_peak_page_table = 1
        }
        else if (!have_peak_page_table || (value + 0) > peak_page_table_kib) {
          peak_page_table_kib = value + 0
          have_peak_page_table = 1
        }
      }
    }
    if (require_cgroup == "yes" || cgroup_budget_requested) {
      if (cgroup_status != "ok") {
        fail("cgroup-" cgroup_status ":" phase ":row-" NR)
        next
      }
      phase_cgroup_ok[phase]++
      row_cgroup_budget_valid = 1
      path = $(column["cgroup_path"])
      if (path == "") {
        fail("cgroup-path-missing:" phase ":row-" NR)
        row_cgroup_budget_valid = 0
      }
      if (cgroup_path == "") cgroup_path = path
      else if (path != cgroup_path) {
        fail("cgroup-path-changed:row-" NR)
        row_cgroup_budget_valid = 0
      }
      if (require_cgroup == "yes") {
        memory_max = $(column["cgroup_memory_max"])
        memory_high = $(column["cgroup_memory_high"])
        swap_max = $(column["cgroup_swap_max"])
        if (memory_max != expected_memory_max) fail("memory-max-mismatch:row-" NR)
        if (memory_high != expected_memory_high) fail("memory-high-mismatch:row-" NR)
        if (swap_max != expected_swap_max) fail("swap-max-mismatch:row-" NR)
        swap_current = $(column["cgroup_swap_current_bytes"])
        swap_peak = $(column["cgroup_scope_swap_peak_bytes"])
        event_max = $(column["cgroup_scope_event_max_total"])
        event_oom = $(column["cgroup_scope_event_oom_total"])
        event_oom_kill = $(column["cgroup_scope_event_oom_kill_total"])
        if (!unsigned(swap_current) || swap_current != 0)
          fail("swap-current-nonzero:row-" NR)
        if (!unsigned(swap_peak) || swap_peak != 0)
          fail("swap-peak-nonzero:row-" NR)
        if (!unsigned(event_max) || event_max != 0)
          fail("memory-max-event:row-" NR)
        if (!unsigned(event_oom) || event_oom != 0)
          fail("memory-oom-event:row-" NR)
        if (!unsigned(event_oom_kill) || event_oom_kill != 0)
          fail("memory-oom-kill-event:row-" NR)
      }
      for (name in cumulative_required) {
        if (!observe_cumulative(name, $(column[name]), NR))
          row_cgroup_budget_valid = 0
      }

      if (cgroup_budget_requested && row_cgroup_budget_valid) {
        phase_cgroup_budget_samples[phase]++
        if (!have_phase_cgroup_budget[phase]) {
          phase_first_ms[phase] = timestamp + 0
          if (max_cgroup_high_events_delta != "")
            phase_first_high[phase] = $(column["cgroup_scope_event_high_total"]) + 0
          if (max_psi_some_stall_fraction != "")
            phase_first_psi_some[phase] = $(column["cgroup_memory_pressure_some_total_usec"]) + 0
          if (max_psi_full_stall_fraction != "")
            phase_first_psi_full[phase] = $(column["cgroup_memory_pressure_full_total_usec"]) + 0
          have_phase_cgroup_budget[phase] = 1
        }
        phase_last_ms[phase] = timestamp + 0
        if (max_cgroup_high_events_delta != "")
          phase_last_high[phase] = $(column["cgroup_scope_event_high_total"]) + 0
        if (max_psi_some_stall_fraction != "")
          phase_last_psi_some[phase] = $(column["cgroup_memory_pressure_some_total_usec"]) + 0
        if (max_psi_full_stall_fraction != "")
          phase_last_psi_full[phase] = $(column["cgroup_memory_pressure_full_total_usec"]) + 0
      }
    }
  }
  END {
    if (NR < 2) fail("no-samples")
    for (i = 1; i <= required_count; i++) {
      phase = required_phase[i]
      if (!phase_rows[phase]) fail("phase-missing:" phase)
      else if (!phase_smaps_ok[phase]) fail("phase-without-valid-smaps:" phase)
      if (require_cgroup == "yes" && !phase_cgroup_ok[phase])
        fail("phase-without-valid-cgroup:" phase)
    }

    if (smaps_budget_requested)
      add_diagnostic("budget.scope", "required-phases")
    if (max_peak_pss_kib != "") {
      add_diagnostic("budget.max_peak_pss_kib", max_peak_pss_kib)
      if (invalid_peak_pss || !have_peak_pss) {
        fail("budget-observation-unavailable:peak-pss-kib")
        add_diagnostic("observed.peak_pss_kib", "unavailable")
      } else {
        add_diagnostic("observed.peak_pss_kib", sprintf("%.0f", peak_pss_kib))
        if (peak_pss_kib > (max_peak_pss_kib + 0))
          fail("budget-exceeded:peak-pss-kib:observed-" sprintf("%.0f", peak_pss_kib) ":limit-" max_peak_pss_kib)
      }
    }
    if (max_peak_pss_anon_kib != "") {
      add_diagnostic("budget.max_peak_pss_anon_kib", max_peak_pss_anon_kib)
      if (invalid_peak_pss_anon || !have_peak_pss_anon) {
        fail("budget-observation-unavailable:peak-pss-anon-kib")
        add_diagnostic("observed.peak_pss_anon_kib", "unavailable")
      } else {
        add_diagnostic("observed.peak_pss_anon_kib", sprintf("%.0f", peak_pss_anon_kib))
        if (peak_pss_anon_kib > (max_peak_pss_anon_kib + 0))
          fail("budget-exceeded:peak-pss-anon-kib:observed-" sprintf("%.0f", peak_pss_anon_kib) ":limit-" max_peak_pss_anon_kib)
      }
    }
    if (max_peak_page_table_kib != "") {
      add_diagnostic("budget.max_peak_page_table_kib", max_peak_page_table_kib)
      if (invalid_peak_page_table || !have_peak_page_table) {
        fail("budget-observation-unavailable:peak-page-table-kib")
        add_diagnostic("observed.peak_page_table_kib", "unavailable")
      } else {
        add_diagnostic("observed.peak_page_table_kib", sprintf("%.0f", peak_page_table_kib))
        if (peak_page_table_kib > (max_peak_page_table_kib + 0))
          fail("budget-exceeded:peak-page-table-kib:observed-" sprintf("%.0f", peak_page_table_kib) ":limit-" max_peak_page_table_kib)
      }
    }

    cgroup_budget_evaluable = cgroup_budget_requested
    if (cgroup_budget_requested) {
      if (!smaps_budget_requested)
        add_diagnostic("budget.scope", "required-phases")
      for (i = 1; i <= required_count; i++) {
        phase = required_phase[i]
        if (phase_cgroup_budget_samples[phase] < 2 ||
            !have_phase_cgroup_budget[phase] ||
            phase_last_ms[phase] <= phase_first_ms[phase]) {
          fail("budget-cgroup-interval-unavailable:" phase)
          cgroup_budget_evaluable = 0
          continue
        }
        elapsed_ms = phase_last_ms[phase] - phase_first_ms[phase]
        total_budget_elapsed_ms += elapsed_ms
        if (max_cgroup_high_events_delta != "")
          total_high_events_delta += phase_last_high[phase] - phase_first_high[phase]
        if (max_psi_some_stall_fraction != "")
          total_psi_some_delta_usec += phase_last_psi_some[phase] - phase_first_psi_some[phase]
        if (max_psi_full_stall_fraction != "")
          total_psi_full_delta_usec += phase_last_psi_full[phase] - phase_first_psi_full[phase]
      }
      if (cgroup_budget_evaluable) {
        elapsed_usec = total_budget_elapsed_ms * 1000
        add_diagnostic("observed.cgroup_budget_elapsed_ms", sprintf("%.0f", total_budget_elapsed_ms))
        if (max_cgroup_high_events_delta != "") {
          add_diagnostic("budget.max_cgroup_high_events_delta", max_cgroup_high_events_delta)
          add_diagnostic("observed.cgroup_high_events_delta", sprintf("%.0f", total_high_events_delta))
          if (total_high_events_delta > (max_cgroup_high_events_delta + 0))
            fail("budget-exceeded:cgroup-high-events-delta:observed-" sprintf("%.0f", total_high_events_delta) ":limit-" max_cgroup_high_events_delta)
        }
        if (max_psi_some_stall_fraction != "") {
          psi_some_fraction = total_psi_some_delta_usec / elapsed_usec
          add_diagnostic("budget.max_psi_some_stall_fraction", max_psi_some_stall_fraction)
          add_diagnostic("observed.psi_some_delta_usec", sprintf("%.0f", total_psi_some_delta_usec))
          add_diagnostic("observed.psi_some_stall_fraction", sprintf("%.9f", psi_some_fraction))
          if (total_psi_some_delta_usec > elapsed_usec)
            fail("psi-some-stall-fraction-out-of-range")
          else if (total_psi_some_delta_usec > (max_psi_some_stall_fraction + 0) * elapsed_usec)
            fail("budget-exceeded:psi-some-stall-fraction:observed-" sprintf("%.9f", psi_some_fraction) ":limit-" max_psi_some_stall_fraction)
        }
        if (max_psi_full_stall_fraction != "") {
          psi_full_fraction = total_psi_full_delta_usec / elapsed_usec
          add_diagnostic("budget.max_psi_full_stall_fraction", max_psi_full_stall_fraction)
          add_diagnostic("observed.psi_full_delta_usec", sprintf("%.0f", total_psi_full_delta_usec))
          add_diagnostic("observed.psi_full_stall_fraction", sprintf("%.9f", psi_full_fraction))
          if (total_psi_full_delta_usec > elapsed_usec)
            fail("psi-full-stall-fraction-out-of-range")
          else if (total_psi_full_delta_usec > (max_psi_full_stall_fraction + 0) * elapsed_usec)
            fail("budget-exceeded:psi-full-stall-fraction:observed-" sprintf("%.9f", psi_full_fraction) ":limit-" max_psi_full_stall_fraction)
        }
      } else {
        if (max_cgroup_high_events_delta != "")
          add_diagnostic("budget.max_cgroup_high_events_delta", max_cgroup_high_events_delta)
        if (max_psi_some_stall_fraction != "")
          add_diagnostic("budget.max_psi_some_stall_fraction", max_psi_some_stall_fraction)
        if (max_psi_full_stall_fraction != "")
          add_diagnostic("budget.max_psi_full_stall_fraction", max_psi_full_stall_fraction)
        add_diagnostic("observed.cgroup_budget_interval", "unavailable")
      }
    }

    if (failure != "") { print failure diagnostics; exit 1 }
    print "validated-full-memory-evidence" diagnostics
  }
' "$samples")"
validation_status=$?
set -e

detail="$(printf '%s' "$detail" | tr '\t\r\n' '   ')"
if [ "$validation_status" -eq 0 ]; then status=passed; else status=failed; fi
sample_count="$(awk 'END { print (NR > 0 ? NR - 1 : 0) }' "$samples")"
{
  printf 'target\tstatus\tdetail\tsamples\n'
  printf '%s\t%s\t%s\t%s\n' "$target" "$status" "$detail" "$sample_count"
} >"$tmp_output"
mv "$tmp_output" "$output"
trap - EXIT
exit "$validation_status"
