#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
source_root="$PWD"
scratch="$(mktemp -d)"
trap 'exit_status=$?
  if [ "$exit_status" -ne 0 ] && [ -f "${case_root:-$scratch}/result" ]; then cat "$case_root/result" >&2; fi
  rm -rf "$scratch"; exit "$exit_status"' EXIT
sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
prepare() {
  case_root="$scratch/$1"
  bun tools/release/download-build-artifacts.test.mts prepare "$case_root" "${2:-}"
}
invoke() {
  local mode="$1"; shift
  env -i PATH="$PATH" HOME="$HOME" \
    BUN_OPTIONS="--preload=$source_root/tools/release/testdata/download-build-artifacts-github.mts" \
    TMPDIR="$case_root" FAKE_ARTIFACT_ARCHIVE="$case_root/artifact.zip" \
    FAKE_GH_LOG="$case_root/gh.log" FAKE_GH_STATE="$case_root/state" FAKE_MODE="$mode" \
    FAKE_CANDIDATE_MODE="${candidate_mode:-}" FAKE_DUPLICATE_JOB="${duplicate_job:-}" \
    FAKE_JOB_CASE="${job_case:-}" \
    FAKE_RUN_STATUS="${run_status:-completed}" FAKE_RUN_CONCLUSION="${run_conclusion-success}" \
    GH_REPO=f0rr0/oliphaunt GH_TOKEN=test-token \
    OLIPHAUNT_GITHUB_RUN_SNAPSHOT_DIR="$case_root/snapshots" \
    OLIPHAUNT_GITHUB_READ_BASE_DELAY_MS=0 OLIPHAUNT_GITHUB_READ_MAX_DELAY_MS=0 \
    OLIPHAUNT_GITHUB_READ_DEADLINE_MS="${read_deadline:-300000}" \
    OLIPHAUNT_GITHUB_READ_MAX_ATTEMPTS="${read_attempts:-10}" \
    bash .github/scripts/download-build-artifacts.sh CI "${requested_sha:-$sha}" "$case_root/durable" \
      --job Qualified --artifact exact-artifact "$@" > "$case_root/result" 2>&1
}
reject() {
  local expected="$1" message="$2"; shift 2
  local status=0
  invoke "$@" || status=$?
  if [[ "$status" != "$expected" ]]; then cat "$case_root/result" >&2; exit 1; fi
  rg -q "$message" "$case_root/result"
}
clean() { bun tools/release/download-build-artifacts.test.mts assert "$case_root" "${1:-}"; }
prepare transient
invoke transient --run-id 77
[[ "$(cat "$case_root/durable/payload.txt")" == correct && "$(cat "$case_root/state")" == 2 ]]
clean
prepare permanent
mkdir "$case_root/durable"
printf preserve-me > "$case_root/durable/existing.txt"
reject 1 'HTTP 404' permanent --run-id 77
[[ "$(cat "$case_root/durable/existing.txt")" == preserve-me && "$(cat "$case_root/state")" == 1 ]]
clean
prepare collision
mkdir "$case_root/durable"
printf old-bytes > "$case_root/durable/payload.txt"
reject 1 'different bytes|conflicts with the durable destination' success --run-id 77
[[ "$(cat "$case_root/durable/payload.txt")" == old-bytes ]]
clean
prepare identity
requested_sha=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb reject 1 'does not belong to commit' success --run-id 77
[[ ! -e "$case_root/durable" && ! -e "$case_root/state" ]]
prepare approved
invoke success --run-id 77 --artifact-metadata-json "$(cat "$case_root/approved.json")"
rm -rf "$case_root/durable"
reject 1 'immutable identity drifted' success --run-id 77 --artifact-metadata-json "$(cat "$case_root/wrong.json")"
prepare subset
invoke success --run-id 77 --artifact-metadata-json "$(cat "$case_root/subset.json")"
rm -rf "$case_root/durable"
reject 2 'unique artifact names' success --run-id 77 --artifact-metadata-json "$(cat "$case_root/duplicate.json")"
prepare snapshot
invoke success --run-id 77
invoke success --run-id 77
clean snapshot
# Only a pending exact producer may converge; its immutable identity remains pinned.
producer=(--run-id 77 --job-success-only --workflow-path .github/workflows/ci.yml
  --event workflow_dispatch --ref refs/heads/main --source-tree bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb)
prepare producer-success
job_case=pending-success invoke success "${producer[@]}"
invoke success "${producer[@]}"
clean producer:2:2:accepted
prepare producer-cached pending-snapshot
job_case=cached-success invoke success "${producer[@]}"
clean producer:1:1:accepted
prepare producer-shared-cache
job_case=cache-other-pending invoke success "${producer[@]}"
job_case=cache-other-success invoke success "${producer[@]}" --job 'Second producer'
clean producer:2:2:accepted
prepare producer-immediate
# An unrelated failed workflow must not disqualify the successful requested role.
run_conclusion=failure invoke success "${producer[@]}" --run-attempt 1 --job-attempt 1
clean producer:1:1:accepted
for fault in failure cancelled missing event; do
  prepare "producer-$fault"
  job_case="$fault" reject 1 'does not satisfy required job|missing required job|event mismatch' success "${producer[@]}"
  [[ ! -e "$case_root/durable" && ! -e "$case_root/state" ]]
  clean producer:1:0
done
prepare producer-duplicate
job_case=pending-success duplicate_job=true reject 1 'ambiguous latest executions' success "${producer[@]}"
clean producer:1:0
prepare producer-wrong-attempt
job_case=pending-success reject 1 'producing job attempt mismatch' success "${producer[@]}" --job-attempt 2
clean producer:1:0
for fault in failure source-drift producer-drift rerun-drift 404; do
  prepare "producer-pending-$fault"
  job_case="pending-$fault" reject 1 'does not satisfy required job|does not belong to commit|identity changed|HTTP 404' success "${producer[@]}"
  [[ ! -e "$case_root/durable" && ! -e "$case_root/state" ]]
  clean producer:2:0
done
prepare producer-timeout
job_case=pending-timeout read_attempts=3 reject 1 'retry budget exhausted after 3 attempt' success "${producer[@]}"
clean producer:3:0
prepare producer-deadline
# A larger ambient HTTP deadline must not expand the five-minute readiness cap.
job_case=pending-deadline read_deadline=3600000 reject 1 'deadline (exhausted|expired)' success "${producer[@]}"
clean producer:2:0
prepare pagination
candidate_mode=beyond-first-page invoke success
[[ "$(cat "$case_root/durable/payload.txt")" == correct ]]
clean pagination
for status in in_progress completed; do
  prepare "run-$status"
  conclusion=failure
  [[ "$status" != in_progress ]] || conclusion=''
  run_status="$status" run_conclusion="$conclusion" reject 1 'malformed or not completed/success|does not belong to commit' success --run-id 77
  [[ ! -e "$case_root/durable" && ! -e "$case_root/state" ]]
done
prepare duplicate-job
duplicate_job=true reject 1 'job Qualified has ambiguous latest executions' success --run-id 77
[[ ! -e "$case_root/durable" && ! -e "$case_root/state" ]]
for kind in traversal corrupt; do
  prepare "$kind" "$kind"
  mkdir "$case_root/durable"
  printf preserve > "$case_root/durable/existing.txt"
  if invoke success --run-id 77; then echo 'Unsafe ZIP accepted' >&2; exit 1; fi
  [[ "$(cat "$case_root/durable/existing.txt")" == preserve && ! -e "$scratch/escaped.txt" && ! -e "$case_root/escaped.txt" ]]
  clean
done
# Checksum merging uses the actual CLI and must not damage the destination on conflict.
mkdir "$scratch/checksums"
checksum="$scratch/checksums"
one=1111111111111111111111111111111111111111111111111111111111111111
two=2222222222222222222222222222222222222222222222222222222222222222
printf '%s  ./linux.tar.gz\n' "$one" > "$checksum/first"
printf '%s  windows.zip\n%s  ./linux.tar.gz\n' "$two" "$one" > "$checksum/second"
bun .github/scripts/merge-checksum-manifest.mts "$checksum/first" "$checksum/second"
printf '%s  ./linux.tar.gz\n%s  ./windows.zip\n' "$one" "$two" > "$checksum/expected"
cmp "$checksum/first" "$checksum/expected"
printf '%s  ./linux.tar.gz\n' "$two" > "$checksum/conflict"
if bun .github/scripts/merge-checksum-manifest.mts "$checksum/first" "$checksum/conflict" > "$checksum/result" 2>&1; then exit 1; fi
rg -q 'conflicting checksum for linux' "$checksum/result"
cmp "$checksum/first" "$checksum/expected"
compgen -G "$checksum/.oliphaunt-checksums-*" > /dev/null && exit 1
echo 'Artifact downloads: exact identities, retries, atomic promotion, corruption and checksum conflicts passed'
