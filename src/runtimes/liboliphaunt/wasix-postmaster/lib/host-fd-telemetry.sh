#!/usr/bin/env bash

# Print four tab-separated fields for a single host open-FD observation:
#
#   total_open_fds  observed_processes  expected_processes  status
#
# The total is deliberately blank unless every process in the supplied set was
# observed.  That keeps an unsupported host, an unreadable procfs, or a
# teardown race from looking like a real zero or a complete partial sum.
fresh_collect_host_fd_occupancy() (
  if [ "$#" -ne 3 ]; then
    printf 'host FD collector requires kernel, proc root, and pid set\n' >&2
    return 2
  fi

  local kernel="$1"
  local proc_root="$2"
  local pids="$3"
  local pid pid_dir fd_dir entry name
  local total=0
  local process_total=0
  local observed_processes=0
  local raced_processes=0
  local unreadable_processes=0
  local process_open_fds
  local seen_pids=" "
  local -a fd_entries=()

  # Validate and count the requested process set before platform capability
  # checks.  Even an unsupported observation must retain the truthful expected
  # cardinality instead of implying that no processes were requested.
  for pid in $pids; do
    case "$pid" in
      ""|0|0*|*[!0-9]*)
        printf 'malformed sampled host pid: %s\n' "$pid" >&2
        return 2
        ;;
    esac
    case "$seen_pids" in
      *" $pid "*)
        printf 'duplicate sampled host pid: %s\n' "$pid" >&2
        return 2
        ;;
    esac
    seen_pids="$seen_pids$pid "
    process_total=$((process_total + 1))
  done

  if [ "$kernel" != "Linux" ]; then
    printf '\t0\t%s\tunsupported\n' "$process_total"
    return 0
  fi
  case "$proc_root" in
    /*) ;;
    *)
      printf 'host FD proc root must be absolute: %s\n' "$proc_root" >&2
      return 2
      ;;
  esac
  if [ ! -d "$proc_root" ]; then
    printf '\t0\t%s\tunsupported\n' "$process_total"
    return 0
  fi

  # nullglob makes an actually empty readable fd directory distinct from an
  # unexpanded wildcard.  The function runs in a subshell so this setting
  # cannot leak into the benchmark harness.
  shopt -s nullglob
  for pid in $pids; do
    pid_dir="$proc_root/$pid"
    fd_dir="$pid_dir/fd"

    if [ ! -e "$pid_dir" ] && [ ! -L "$pid_dir" ]; then
      raced_processes=$((raced_processes + 1))
      continue
    fi
    if [ ! -d "$fd_dir" ] || [ ! -r "$fd_dir" ] || [ ! -x "$fd_dir" ]; then
      if [ ! -e "$pid_dir" ] && [ ! -L "$pid_dir" ]; then
        raced_processes=$((raced_processes + 1))
      else
        unreadable_processes=$((unreadable_processes + 1))
      fi
      continue
    fi

    fd_entries=("$fd_dir"/*)
    # The process or its fd directory can disappear after the first state
    # check but before glob expansion.  Reject that partial snapshot as a
    # harmless race rather than accepting an empty glob as a real zero.
    if [ ! -e "$pid_dir" ] && [ ! -L "$pid_dir" ]; then
      raced_processes=$((raced_processes + 1))
      continue
    fi
    if [ ! -d "$fd_dir" ] || [ ! -r "$fd_dir" ] || [ ! -x "$fd_dir" ]; then
      if [ ! -e "$pid_dir" ] && [ ! -L "$pid_dir" ]; then
        raced_processes=$((raced_processes + 1))
      else
        unreadable_processes=$((unreadable_processes + 1))
      fi
      continue
    fi
    process_open_fds=0
    for entry in "${fd_entries[@]}"; do
      name="${entry##*/}"
      case "$name" in
        ""|*[!0-9]*)
          printf 'malformed readable host FD entry: %s\n' "$entry" >&2
          return 2
          ;;
      esac
      process_open_fds=$((process_open_fds + 1))
    done
    total=$((total + process_open_fds))
    observed_processes=$((observed_processes + 1))
  done

  if [ "$unreadable_processes" -gt 0 ]; then
    printf '\t%s\t%s\tunreadable\n' "$observed_processes" "$process_total"
  elif [ "$raced_processes" -gt 0 ] || [ "$process_total" -eq 0 ]; then
    printf '\t%s\t%s\traced\n' "$observed_processes" "$process_total"
  else
    printf '%s\t%s\t%s\tok\n' "$total" "$observed_processes" "$process_total"
  fi
)
