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
    FAKE_RUN_STATUS="${run_status:-completed}" FAKE_RUN_CONCLUSION="${run_conclusion-success}" \
    GH_REPO=f0rr0/oliphaunt GH_TOKEN=test-token \
    OLIPHAUNT_GITHUB_RUN_SNAPSHOT_DIR="$case_root/snapshots" \
    OLIPHAUNT_GITHUB_READ_BASE_DELAY_MS=0 OLIPHAUNT_GITHUB_READ_MAX_DELAY_MS=0 \
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
duplicate_job=true reject 1 'does not satisfy required job Qualified' success --run-id 77
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
