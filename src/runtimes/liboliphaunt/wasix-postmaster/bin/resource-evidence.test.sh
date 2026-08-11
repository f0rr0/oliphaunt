#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bench="$root/bin/bench-wasix-concurrent-query-suite.sh"
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT

sed -n '/^summarize_resource_usage()/,/^sample_pg_wait_events()/p' "$bench" |
  sed '$d' >"$tmp/summarizer.sh"
sed -n '/^parse_cgroup_memory_stat_file_cache()/,/^cgroup_has_child_cgroup()/p' "$bench" |
  sed '$d' >"$tmp/file-cache-parser.sh"
# shellcheck source=/dev/null
source "$tmp/summarizer.sh"
# shellcheck source=/dev/null
source "$tmp/file-cache-parser.sh"

printf 'fixture-header\n' >"$tmp/samples.tsv"
valid=(
  1000 wasix fanout:indexed-read 10 2 100 200 1.0 50 '10 11'
  1000 600 300 100 700 400 900 0 2 8 64 100 600
)
for _ in {1..23}; do valid+=(""); done
valid+=(10 2 2 ok 2 2 ok disabled)
for _ in {1..11}; do valid+=(""); done
valid+=(ok)
(IFS=$'\t'; printf '%s\n' "${valid[*]}") >>"$tmp/samples.tsv"

raced=(1001 wasix fanout:indexed-read 10 0 0 0 0.0 0 '')
for _ in {1..13}; do raced+=(""); done
for _ in {1..23}; do raced+=(""); done
raced+=("" 0 2 raced 2 2 raced disabled)
for _ in {1..11}; do raced+=(""); done
raced+=(raced)
(IFS=$'\t'; printf '%s\n' "${raced[*]}") >>"$tmp/samples.tsv"

: >"$tmp/summary.tsv"
summarize_resource_usage wasix "$tmp/samples.tsv" "$tmp/summary.tsv"
awk -F '\t' '
  NF != 110 { exit 1 }
  {
    if ($3 != 100 || $10 != 1000 || $25 != 1) exit 1
    if ($73 != 1 || $74 != 0 || $75 != 0 || $76 != 0 || $77 != 1) exit 1
    if ($78 != 0 || $79 != 2 || $80 != 0) exit 1
  }
' "$tmp/summary.tsv"

complete_stat='active_file 100
inactive_file 200
file_mapped 50
workingset_refault_file 10
workingset_activate_file 2
workingset_restore_file 1
pgscan 100
pgsteal 80'
[ "$(printf '%s\n' "$complete_stat" | parse_cgroup_memory_stat_file_cache)" = \
  $'100\t200\t50\t10\t2\t1\t100\t80\tcomplete\tnone' ]
[ "$(printf '%s\n' "$complete_stat" | sed '/workingset_restore_file/d' | \
  parse_cgroup_memory_stat_file_cache)" = \
  $'100\t200\t50\t10\t2\t\t100\t80\tpartial\tworkingset_restore_file' ]
if printf '%s\nactive_file 101\n' "$complete_stat" |
  parse_cgroup_memory_stat_file_cache >/dev/null 2>&1; then
  echo 'duplicate optional memory.stat key passed parser' >&2
  exit 1
fi

write_cache_sample() {
  local timestamp="$1"
  local active_file="$2"
  local inactive_file="$3"
  local file_mapped="$4"
  local refault="$5"
  local activate="$6"
  local restore="$7"
  local pgscan="$8"
  local pgsteal="$9"
  local row=(
    "$timestamp" wasix fanout:indexed-update 10 2 100 200 1.0 50 '10 11'
    1000 600 300 100 700 400 900 0 2 8 64 100 600
    /fixture.scope 120000000 125000000 0 0 2 3 0 0 0
    268435456 234881024 0
    70000000 50000000 0 1000000 64000 2000000 4096 0 10 5
    10 2 2 ok 2 2 ok ok
    "$active_file" "$inactive_file" "$file_mapped"
    "$refault" "$activate" "$restore" "$pgscan" "$pgsteal"
    complete none memory.events.local
    ok
  )
  (IFS=$'\t'; printf '%s\n' "${row[*]}")
}

printf 'fixture-header\n' >"$tmp/cache-samples.tsv"
write_cache_sample 1000 100 200 50 10 2 1 100 80 >>"$tmp/cache-samples.tsv"
write_cache_sample 2000 110 250 40 15 5 1 140 110 >>"$tmp/cache-samples.tsv"
: >"$tmp/cache-summary.tsv"
summarize_resource_usage wasix "$tmp/cache-samples.tsv" "$tmp/cache-summary.tsv"
awk -F '\t' '
  NF != 110 { exit 1 }
  $81 != 110 || $83 != 250 || $85 != 50 { exit 1 }
  $87 != "complete" || $88 != "none" || $89 != "memory.events.local" ||
    $90 != 1000 { exit 1 }
  $91 != 10 || $92 != 15 || $93 != 5 || $94 != "5.000000" { exit 1 }
  $95 != 2 || $96 != 5 || $97 != 3 || $98 != "3.000000" { exit 1 }
  $99 != 1 || $100 != 1 || $101 != 0 || $102 != "0.000000" { exit 1 }
  $103 != 100 || $104 != 140 || $105 != 40 || $106 != "40.000000" { exit 1 }
  $107 != 80 || $108 != 110 || $109 != 30 || $110 != "30.000000" { exit 1 }
' "$tmp/cache-summary.tsv"

cp "$tmp/cache-samples.tsv" "$tmp/decreased-cache-counter.tsv"
awk -F '\t' -v OFS='\t' 'NR == 3 { $58 = 9 } { print }' \
  "$tmp/decreased-cache-counter.tsv" >"$tmp/decreased-cache-counter.new"
mv "$tmp/decreased-cache-counter.new" "$tmp/decreased-cache-counter.tsv"
if summarize_resource_usage wasix "$tmp/decreased-cache-counter.tsv" \
  "$tmp/decreased-cache-counter-summary.tsv"; then
  echo 'decreasing cumulative memory.stat counter passed summary' >&2
  exit 1
fi

awk -F '\t' -v OFS='\t' '
  NR > 1 {
    $60 = ""
    $63 = "partial"
    $64 = "workingset_restore_file"
    $65 = "memory.events"
  }
  { print }
' "$tmp/cache-samples.tsv" >"$tmp/partial-cache-samples.tsv"
: >"$tmp/partial-cache-summary.tsv"
summarize_resource_usage wasix "$tmp/partial-cache-samples.tsv" \
  "$tmp/partial-cache-summary.tsv"
awk -F '\t' '
  NF != 110 { exit 1 }
  $87 != "partial" || $88 != "workingset_restore_file" ||
    $89 != "memory.events" { exit 1 }
  $91 != 10 || $92 != 15 || $93 != 5 || $94 != "5.000000" { exit 1 }
  $99 != "" || $100 != "" || $101 != "" || $102 != "" { exit 1 }
' "$tmp/partial-cache-summary.tsv"

cp "$tmp/cache-samples.tsv" "$tmp/changed-events-source.tsv"
awk -F '\t' -v OFS='\t' 'NR == 3 { $65 = "memory.events" } { print }' \
  "$tmp/changed-events-source.tsv" >"$tmp/changed-events-source.new"
mv "$tmp/changed-events-source.new" "$tmp/changed-events-source.tsv"
if summarize_resource_usage wasix "$tmp/changed-events-source.tsv" \
  "$tmp/changed-events-source-summary.tsv"; then
  echo 'changing memory.events source passed summary' >&2
  exit 1
fi

cp "$tmp/samples.tsv" "$tmp/malformed-smaps.tsv"
awk -F '\t' -v OFS='\t' 'NR == 3 { $11 = 1 } { print }' \
  "$tmp/malformed-smaps.tsv" >"$tmp/malformed-smaps.new"
mv "$tmp/malformed-smaps.new" "$tmp/malformed-smaps.tsv"
if summarize_resource_usage wasix "$tmp/malformed-smaps.tsv" "$tmp/bad-summary.tsv"; then
  echo 'raced smaps values were accepted as peak evidence' >&2
  exit 1
fi

cp "$tmp/samples.tsv" "$tmp/malformed-process-tree.tsv"
awk -F '\t' -v OFS='\t' 'NR == 3 { $6 = 999 } { print }' \
  "$tmp/malformed-process-tree.tsv" >"$tmp/malformed-process-tree.new"
mv "$tmp/malformed-process-tree.new" "$tmp/malformed-process-tree.tsv"
if summarize_resource_usage wasix "$tmp/malformed-process-tree.tsv" \
  "$tmp/bad-process-tree-summary.tsv"; then
  echo 'raced process-tree values were accepted as peak evidence' >&2
  exit 1
fi

cp "$tmp/samples.tsv" "$tmp/malformed-cgroup.tsv"
awk -F '\t' -v OFS='\t' 'NR == 3 { $24 = "/stale"; $54 = "unavailable" } { print }' \
  "$tmp/malformed-cgroup.tsv" >"$tmp/malformed-cgroup.new"
mv "$tmp/malformed-cgroup.new" "$tmp/malformed-cgroup.tsv"
if summarize_resource_usage wasix "$tmp/malformed-cgroup.tsv" "$tmp/bad-cgroup-summary.tsv"; then
  echo 'partial unavailable cgroup values were accepted as evidence' >&2
  exit 1
fi

# The benchmark calls this wrapper from a function evaluated in an `if`, where
# Bash suppresses errexit.  Keep explicit failure propagation so malformed raw
# evidence cannot be followed by a successful target qualification.
summarize_resource_usage() { return 1; }
if summarize_resource_usage_checked wasix "$tmp/samples.tsv" \
  "$tmp/checked-summary.tsv" 2>"$tmp/checked-summary.stderr"; then
  echo 'checked resource summary wrapper swallowed a validation failure' >&2
  exit 1
fi
grep -Fqx \
  "resource evidence summary validation failed for wasix; see $tmp/samples.tsv" \
  "$tmp/checked-summary.stderr"
summarize_resource_usage() { :; }
summarize_resource_usage_checked wasix "$tmp/samples.tsv" \
  "$tmp/checked-summary.tsv"

printf 'passed: resource evidence status and peak validation\n'
