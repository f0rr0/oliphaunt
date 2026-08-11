#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bench="$root/bin/bench-wasix-concurrent-query-suite.sh"
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT

sed -n '/^collect_linux_process_tree()/,/^collect_process_tree_snapshot()/p' "$bench" |
  sed '$d' >"$tmp/collector.sh"
# shellcheck source=/dev/null
source "$tmp/collector.sh"

proc_root="$tmp/proc"
for pid in 10 11 12 13; do
  mkdir -p "$proc_root/$pid/task/$pid"
  : >"$proc_root/$pid/task/$pid/children"
done
printf '11 12\n' >"$proc_root/10/task/10/children"
printf '13\n' >"$proc_root/11/task/11/children"

expected=$'10\n11\n12\n13'
[ "$(collect_linux_process_tree 10 "$proc_root")" = "$expected" ]

# Children created by a non-leader thread are part of the same process tree.
mkdir -p "$proc_root/10/task/99"
printf '13\n' >"$proc_root/10/task/99/children"
[ "$(collect_linux_process_tree 10 "$proc_root")" = "$expected" ]

# A disappeared descendant is harmless; it is no longer in the observed tree.
printf '11 12 14\n' >"$proc_root/10/task/10/children"
[ "$(collect_linux_process_tree 10 "$proc_root")" = "$expected" ]

printf '11 invalid\n' >"$proc_root/10/task/10/children"
if collect_linux_process_tree 10 "$proc_root" >/dev/null 2>&1; then
  echo 'Linux process-tree collector accepted a malformed child PID' >&2
  exit 1
fi

printf '11 12\n' >"$proc_root/10/task/10/children"
rm -f "$proc_root/11/task/11/children"
if collect_linux_process_tree 10 "$proc_root" >/dev/null 2>&1; then
  echo 'Linux process-tree collector accepted an unreadable live task' >&2
  exit 1
fi

if collect_linux_process_tree 10 relative/proc >/dev/null 2>&1; then
  echo 'Linux process-tree collector accepted a relative proc root' >&2
  exit 1
fi
if collect_linux_process_tree 0 "$proc_root" >/dev/null 2>&1; then
  echo 'Linux process-tree collector accepted PID zero' >&2
  exit 1
fi

cgroup_dir="$tmp/scope"
mkdir -p "$cgroup_dir"
printf '10\n11\n12\n13\n' >"$cgroup_dir/cgroup.procs"
[ "$(collect_cgroup_process_set 10 "$cgroup_dir")" = "$expected" ]
printf '11\n12\n13\n' >"$cgroup_dir/cgroup.procs"
if collect_cgroup_process_set 10 "$cgroup_dir" >/dev/null 2>&1; then
  echo 'cgroup process collector accepted a scope without its measured root' >&2
  exit 1
fi
printf '10\n11\n11\n' >"$cgroup_dir/cgroup.procs"
if collect_cgroup_process_set 10 "$cgroup_dir" >/dev/null 2>&1; then
  echo 'cgroup process collector accepted duplicate membership' >&2
  exit 1
fi

echo 'passed: Linux process-tree collection is bounded to the measured tree'
