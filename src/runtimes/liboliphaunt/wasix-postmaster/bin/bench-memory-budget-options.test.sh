#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bench="$root/bin/bench-wasix-concurrent-query-suite.sh"
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT

expect_usage_failure() {
  local label="$1"
  shift
  set +e
  "$bench" "$@" >"$tmp/$label.log" 2>&1
  local actual=$?
  set -e
  if [ "$actual" -ne 2 ]; then
    printf '%s: expected exit 2, got %s\n' "$label" "$actual" >&2
    sed -n '1,80p' "$tmp/$label.log" >&2
    exit 1
  fi
}

expect_usage_failure invalid-kib --max-peak-pss-kib 1.5
expect_usage_failure disabled-sampler \
  --resource-detail off --max-peak-pss-kib 1
expect_usage_failure missing-cgroup --max-psi-some-stall-fraction 0.1
expect_usage_failure lifecycle-conflict \
  --wasix-lifecycle-plateau --max-peak-pss-kib 1

mkdir -p "$tmp/fake/bin" "$tmp/report"
printf '%s\n' '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'printf "%s\n" "$@" >"$CAPTURED_ARGS"' \
  'output=""' \
  'while [ "$#" -gt 0 ]; do' \
  '  if [ "$1" = --output ]; then shift; output="$1"; fi' \
  '  shift' \
  'done' \
  'printf "target\\tstatus\\tdetail\\tsamples\\nwasix\\tpassed\\tfixture\\t2\\n" >"$output"' \
  >"$tmp/fake/bin/validate-memory-evidence.sh"
chmod +x "$tmp/fake/bin/validate-memory-evidence.sh"

sed -n '/^validate_target_memory_evidence()/,/^run_target()/p' "$bench" |
  sed '$d' >"$tmp/validator-function.sh"
# shellcheck source=/dev/null
source "$tmp/validator-function.sh"

FRESH_ROOT="$tmp/fake"
fresh_wasmer_bin_hash() {
  sha256sum "$1" | awk '{ print $1 }'
}
memory_budget_identity="$(printf 'fixture memory budget\n' | sha256sum | awk '{ print $1 }')"
execution_identity_sha256="$(printf 'fixture execution identity\n' | sha256sum | awk '{ print $1 }')"
resource_detail=full
resource_sample_interval=0.1
cgroup_memory_max=256M
cgroup_memory_high=224M
cgroup_swap_max=0
max_peak_pss_kib=163840
max_peak_pss_anon_kib=98304
max_peak_page_table_kib=2048
max_cgroup_high_events_delta=4096
max_psi_some_stall_fraction=0.015
max_psi_full_stall_fraction=0.010
workloads=(indexed-read mixed-write indexed-update indexed-insert)
memory_evidence_tsv="$tmp/report/aggregate.tsv"
CAPTURED_ARGS="$tmp/forwarded.args"
export CAPTURED_ARGS
printf 'fixture\n' >"$tmp/resource-samples.tsv"

validate_target_memory_evidence wasix "$tmp/report" "$tmp/resource-samples.tsv"

assert_pair() {
  local option="$1"
  local expected="$2"
  awk -v option="$option" -v expected="$expected" '
    previous == option && $0 == expected { found = 1 }
    { previous = $0 }
    END { exit(found ? 0 : 1) }
  ' "$CAPTURED_ARGS" || {
    printf 'missing forwarded pair: %s %s\n' "$option" "$expected" >&2
    exit 1
  }
}

assert_pair --max-peak-pss-kib 163840
assert_pair --max-peak-pss-anon-kib 98304
assert_pair --max-peak-page-table-kib 2048
assert_pair --max-cgroup-high-events-delta 4096
assert_pair --max-psi-some-stall-fraction 0.015
assert_pair --max-psi-full-stall-fraction 0.010
awk -F '\t' '$1 == "wasix" && $2 == "passed" { found = 1 } END { exit(found ? 0 : 1) }' \
  "$memory_evidence_tsv"
awk -F '\t' -v budget="$memory_budget_identity" -v execution="$execution_identity_sha256" '
  NR == 1 {
    exit !($1 == "schema_version" && $5 == "resource_samples_sha256" &&
      $6 == "memory_budget_sha256" && $7 == "execution_identity_sha256" &&
      $8 == "validator_sha256" && $9 == "memory_evidence_sha256")
  }
  NR == 2 {
    exit !($1 == "oliphaunt.wasix-postmaster.memory-validation.v1" &&
      $2 == "wasix" && $3 == "passed" && $6 == budget && $7 == execution)
  }
' "$tmp/report/memory-validation-receipt.tsv"

printf 'passed: benchmark memory budget parsing and forwarding\n'
