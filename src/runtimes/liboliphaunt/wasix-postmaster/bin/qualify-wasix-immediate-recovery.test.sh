#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
qualifier="$root/bin/qualify-wasix-immediate-recovery.sh"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-immediate-recovery-test.XXXXXX")"
trap 'rm -rf -- "$test_root"' EXIT HUP INT TERM

help_output="$("$qualifier" --help)"
for option in \
  '--target TARGET' \
  '--immutable-carrier-receipt FILE' \
  '--cgroup-memory-max SIZE' \
  '--cgroup-memory-high SIZE' \
  '--cgroup-swap-max SIZE'
do
  grep -Fq -- "$option" <<<"$help_output"
done
grep -Fq -- '--immutable-carrier-receipt is required on Linux' "$qualifier"
grep -Fq 'Linux immediate-recovery qualification requires finite --cgroup-memory-max' "$qualifier"
grep -Fq 'required_snapshot_policy=portable-copy' "$qualifier"
if grep -Fq -- '--mode MODE' <<<"$help_output"; then
  echo 'recovery qualifier still exposes a research/diagnostic mode' >&2
  exit 1
fi
grep -Fq -- '--expected-initdb-executions 1' "$qualifier"
grep -Fq -- '--expected-postgres-executions 3' "$qualifier"
grep -Fq 'expected_outer_initdb_invocations' "$qualifier"
grep -Fq 'expected_outer_postgres_invocations' "$qualifier"
grep -Fq 'postgres and dynamic modules' <<<"$help_output"
grep -Fq 'immediate-recovery-evidence.v5' "$qualifier"
grep -Fq "WHERE source = 'command line'" "$qualifier"
if grep -Eq 'adaptive|cache-offers|CACHE_OFFER' "$qualifier"; then
  echo 'recovery qualifier still contains cache experiment machinery' >&2
  exit 1
fi

for function_name in validate_cgroup_size cgroup_size_to_bytes configure_server_cgroup; do
  awk -v signature="${function_name}() {" '
    $0 == signature { capture = 1 }
    capture { print }
    capture && /^}$/ { exit }
  ' "$qualifier" >>"$test_root/cgroup-functions.sh"
done
# shellcheck source=/dev/null
source "$test_root/cgroup-functions.sh"

validate_cgroup_size 256M
validate_cgroup_size 224MiB
validate_cgroup_size 0
! validate_cgroup_size infinity
! validate_cgroup_size -1
[ "$(cgroup_size_to_bytes 256M)" = 268435456 ]
[ "$(cgroup_size_to_bytes 224MiB)" = 234881024 ]
[ "$(cgroup_size_to_bytes 0)" = 0 ]
! cgroup_size_to_bytes 9223372036854775808 >/dev/null 2>&1

cgroup_enabled=1
cgroup_memory_max=256M
cgroup_memory_high=224M
cgroup_swap_max=0
active_cgroup_unit=""
server_command_prefix=()
configure_server_cgroup baseline
[ "$active_cgroup_unit" = "oliphaunt-recovery-$$-baseline" ]
prefix_text="$(printf '%s\n' "${server_command_prefix[@]}")"
grep -Fxq -- '--property=MemoryAccounting=yes' <<<"$prefix_text"
grep -Fxq -- '--property=MemoryMax=256M' <<<"$prefix_text"
grep -Fxq -- '--property=MemoryHigh=224M' <<<"$prefix_text"
grep -Fxq -- '--property=MemorySwapMax=0' <<<"$prefix_text"
cgroup_enabled=0
configure_server_cgroup recovery
[ -z "$active_cgroup_unit" ]
[ "${#server_command_prefix[@]}" -eq 0 ]

awk '
  /^wait_for_unassisted_exit\(\) \{$/ { capture = 1 }
  capture { print }
  capture && /^}$/ { exit }
' "$qualifier" >"$test_root/wait-for-unassisted-exit.sh"
grep -Fq 'wait_for_unassisted_exit() {' \
  "$test_root/wait-for-unassisted-exit.sh"
# shellcheck source=/dev/null
source "$test_root/wait-for-unassisted-exit.sh"

fresh_supervision_now_ms() {
  printf '1000\n'
}

fresh_supervision_pid_running() {
  return 1
}

fresh_pid_matches_birth_identity() {
  return 0
}

fresh_reap_process_group_leader() {
  FRESH_PROCESS_GROUP_WAIT_STATUS="$fixture_wait_status"
}

fresh_process_group_exists() {
  return 1
}

fresh_wait_tcp_port_closed() {
  return 0
}

reset_fixture() {
  fixture_wait_status="$1"
  active_pid=4242
  active_pgid=4242
  active_identity=linux-starttime:303
  active_phase=fixture-shutdown
}

timeout_seconds=1
port=15432
dev_shm="$test_root/dev-shm"
active_cgroup_unit=""
active_cgroup_dir=""
active_cgroup_identity=""
mkdir -p "$dev_shm"

reset_fixture 17
set +e
wait_for_unassisted_exit "$test_root/nonzero-exit.tsv" \
  >"$test_root/nonzero.out" 2>"$test_root/nonzero.err"
status=$?
set -e
[ "$status" -eq 1 ] || {
  printf 'expected nonzero leader status to reject recovery evidence, got %s\n' \
    "$status" >&2
  exit 1
}
[ ! -e "$test_root/nonzero-exit.tsv" ] || {
  printf 'nonzero leader status produced successful recovery evidence\n' >&2
  exit 1
}
grep -Fqx \
  'server leader exited nonzero after unassisted guest shutdown: phase=fixture-shutdown status=17' \
  "$test_root/nonzero.err"
[ "$active_pid" = 4242 ]
[ "$active_pgid" = 4242 ]
[ "$active_identity" = linux-starttime:303 ]
[ "$active_phase" = fixture-shutdown ]

reset_fixture 0
wait_for_unassisted_exit "$test_root/zero-exit.tsv"
awk -F '\t' '
  NR == 1 {
    valid = ($1 == "phase" && $2 == "wait_status" &&
      $3 == "process_group_empty" && $4 == "cgroup_empty" &&
      $5 == "port_closed" && $6 == "shared_objects_empty" &&
      $7 == "escalation_used")
  }
  NR == 2 {
    valid = valid && ($1 == "fixture-shutdown" && $2 == "0" &&
      $3 == "true" && $4 == "not-requested" && $5 == "true" &&
      $6 == "true" && $7 == "false")
  }
  END { exit !(valid && NR == 2) }
' "$test_root/zero-exit.tsv"
[ -z "$active_pid" ]
[ -z "$active_pgid" ]
[ -z "$active_identity" ]
[ -z "$active_phase" ]

fresh_wait_cgroup_empty() {
  [ "$1" = "$test_root/fake-cgroup" ]
  [ "$2" = 42:99 ]
  [ "$3" = 1000 ]
  cgroup_wait_called=1
}
reset_fixture 0
active_cgroup_unit=oliphaunt-recovery-fixture
active_cgroup_dir="$test_root/fake-cgroup"
active_cgroup_identity=42:99
cgroup_wait_called=0
wait_for_unassisted_exit "$test_root/cgroup-exit.tsv"
[ "$cgroup_wait_called" -eq 1 ]
awk -F '\t' 'NR == 2 { exit !($4 == "true") }' \
  "$test_root/cgroup-exit.tsv"

printf 'immediate recovery exit tests passed\n'
