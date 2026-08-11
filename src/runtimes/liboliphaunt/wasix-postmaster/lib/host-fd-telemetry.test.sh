#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$ROOT/host-fd-telemetry.sh"

fixture="$(mktemp -d)"
trap 'rm -rf -- "$fixture"' EXIT
proc_root="$fixture/proc"
mkdir -p "$proc_root"

fail() {
  printf 'host FD telemetry test: %s\n' "$*" >&2
  exit 1
}

assert_observation() {
  local expected="$1"
  shift
  local actual

  actual="$(fresh_collect_host_fd_occupancy "$@")" ||
    fail "collector unexpectedly failed for: $*"
  [ "$actual" = "$expected" ] ||
    fail "expected [$expected], got [$actual] for: $*"
}

mkdir -p "$proc_root/101/fd" "$proc_root/202/fd" "$proc_root/303/fd"
: >"$proc_root/101/fd/0"
: >"$proc_root/101/fd/1"
# procfs FD entries are symlinks and their targets may legitimately have been
# unlinked.  Occupancy counts the directory entry without dereferencing it.
ln -s "$fixture/already-deleted" "$proc_root/101/fd/9"
: >"$proc_root/202/fd/4"
: >"$proc_root/202/fd/7"

assert_observation $'5\t2\t2\tok' Linux "$proc_root" "101 202"
assert_observation $'0\t1\t1\tok' Linux "$proc_root" "303"
assert_observation $'\t0\t2\tunsupported' Darwin "$proc_root" "101 202"
assert_observation $'\t0\t2\tunsupported' Linux "$fixture/missing-proc" "101 202"

# PID validation is fail-closed even when the host cannot support telemetry.
if fresh_collect_host_fd_occupancy Darwin "$proc_root" "101 bad" \
  >"$fixture/unsupported-malformed.out" 2>"$fixture/unsupported-malformed.err"
then
  fail "unsupported host bypassed process-set validation"
fi
grep -Fq 'malformed sampled host pid' "$fixture/unsupported-malformed.err" ||
  fail "unsupported-host pid failure was not diagnostic"

# A still-present process without an enumerable fd directory is unavailable,
# while a missing process is a harmless teardown race.  Neither emits a
# numeric partial total.
mkdir -p "$proc_root/404"
assert_observation $'\t0\t1\tunreadable' Linux "$proc_root" "404"
assert_observation $'\t0\t1\traced' Linux "$proc_root" "505"
assert_observation $'\t1\t2\traced' Linux "$proc_root" "101 505"
assert_observation $'\t0\t0\traced' Linux "$proc_root" ""

: >"$proc_root/202/fd/not-an-fd"
if fresh_collect_host_fd_occupancy Linux "$proc_root" "202" \
  >"$fixture/malformed.out" 2>"$fixture/malformed.err"
then
  fail "readable malformed fd entry was accepted"
fi
grep -Fq 'malformed readable host FD entry' "$fixture/malformed.err" ||
  fail "malformed fd failure did not explain the bad entry"

if fresh_collect_host_fd_occupancy Linux "$proc_root" "101 101" \
  >"$fixture/duplicate.out" 2>"$fixture/duplicate.err"
then
  fail "duplicate process set was accepted"
fi
grep -Fq 'duplicate sampled host pid' "$fixture/duplicate.err" ||
  fail "duplicate pid failure was not diagnostic"

printf 'host FD telemetry tests passed\n'
