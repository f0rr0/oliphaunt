#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
source_root="$PWD"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
deadline="$(command -v gtimeout || command -v timeout)"
mkdir "$scratch/bin"
printf '#!/bin/sh\nexit 0\n' > "$scratch/bin/sleep"
cat > "$scratch/bin/gh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == api && "$2" == --method && "$3" == POST ]] || exit 93
[[ ! -e "$FAKE_DISPATCH" ]] || exit 94
while [[ $# -gt 0 ]]; do
  if [[ "$1" == --input ]]; then cp "$2" "$FAKE_DISPATCH"; break; fi
  shift
done
[[ "$FAKE_MODE" != qualification-ambiguous ]] || exit 95
printf '{"workflow_run_id":88}\n'
SH
chmod +x "$scratch/bin/"*
prepare() { case_root="$scratch/$1"; mkdir "$case_root"; : > "$case_root/output"; }
invoke() {
  local mode="$1"; shift
  status=0
  env -i PATH="$scratch/bin:$PATH" HOME="$HOME" \
    BUN_OPTIONS="--preload=$source_root/tools/release/testdata/require-workflow-success-github.mts" \
    FAKE_LOG="$case_root/log" FAKE_STATE="$case_root/state" FAKE_MODE="$mode" \
    FAKE_RELEASE="$([[ "$1" == Release ]] && echo 1 || true)" \
    FAKE_DISPATCH="$case_root/dispatch.json" FAKE_ARCHIVE_ROOT="$case_root" \
    GH_REPO=f0rr0/oliphaunt GH_TOKEN=test-token GITHUB_OUTPUT="$case_root/output" \
    OLIPHAUNT_GITHUB_READ_BASE_DELAY_MS=0 OLIPHAUNT_GITHUB_READ_DEADLINE_MS=1000 \
    OLIPHAUNT_GITHUB_READ_MAX_ATTEMPTS=1 OLIPHAUNT_GITHUB_READ_MAX_DELAY_MS=0 \
    "$deadline" 15 bash .github/scripts/require-workflow-success.sh "$@" > "$case_root/result" 2>&1 || status=$?
}
expect_status() { if [[ "$status" != "$1" ]]; then cat "$case_root/result" >&2; echo "Expected $1, got $status" >&2; exit 1; fi; }
selected=(CI "$sha" 0 --run-id 77 --job Qualified --artifact required-artifact)
standard=(CI "$sha" 10 --job Qualified --artifact required-artifact)
for mode in reuse active absent failed advanced ambiguous race uncovered; do
  prepare "qualification-$mode"
  bun tools/release/require-workflow-success.test.mts prepare "$case_root" "$mode"
  scope=(CI "$sha" 10 --job Qualified --artifact oliphaunt-release-candidate)
  invoke "qualification-$mode" "${scope[@]}" --plan-qualification '["oliphaunt-js"]'
  [[ ! -e "$case_root/dispatch.json" ]]
  if [[ "$status" == 0 ]] && rg -q 'qualification_request_required=true' "$case_root/output"; then
    invoke "qualification-$mode" CI "$sha" 10 --dispatch-qualification '["oliphaunt-js"]'
    if rg -q 'actions/runs/88/artifacts' "$case_root/log"; then echo 'Dispatch consumed candidate artifacts' >&2; exit 1; fi
  fi
  if [[ "$status" == 0 ]]; then invoke "qualification-$mode" "${scope[@]}" --qualification-products '["oliphaunt-js"]'; fi
  case "$mode" in
    reuse|active|absent|uncovered) expect_status 0 ;;
    *) [[ "$status" != 0 ]] ;;
  esac
  case "$mode" in
    absent|ambiguous|race|uncovered)
      bun tools/release/require-workflow-success.test.mts dispatch "$case_root"
      if [[ "$status" == 0 ]]; then
        invoke "qualification-$mode" CI "$sha" 10 --dispatch-qualification '["oliphaunt-js"]'
        expect_status 0
      fi ;;
    *) [[ ! -e "$case_root/dispatch.json" ]] ;;
  esac
done
prepare transient
invoke transient "${standard[@]}"
expect_status 0
rg -q 'waiter remains active' "$case_root/result"
bun tools/release/require-workflow-success.test.mts output "$case_root"
[[ "$(cat "$case_root/state")" == 2 ]]
prepare permanent
invoke permanent "${standard[@]}"
expect_status 64
rg -q 'permanent GitHub read failure' "$case_root/result"
[[ "$(cat "$case_root/state")" == 1 ]]
prepare pagination
invoke beyond-first-page "${standard[@]}"
expect_status 0
rg -q 'selected CI run 77' "$case_root/result"
rg -q 'actions/workflows/9/runs' "$case_root/log"
[[ "$(cat "$case_root/state")" == 2 ]]
for mode in wrong-sha in-progress-run failed-run duplicate-artifact expired-artifact duplicate-job; do
  prepare "$mode"
  invoke "$mode" "${selected[@]}"
  expect_status 1
  [[ ! -s "$case_root/output" ]]
  case "$mode" in
    wrong-sha) message='belongs to .* not' ;;
    in-progress-run|failed-run) message='not completed/success' ;;
    duplicate-artifact|expired-artifact) message='exactly one non-expired artifact' ;;
    duplicate-job) message='Qualified=count-2' ;;
  esac
  rg -q "$message" "$case_root/result"
done
prepare upper-sha
invoke upper-sha "${selected[@]}"
expect_status 0
gate=(CI "$sha" 0 --artifact required-artifact --gate-artifact gate-artifact)
prepare gate
invoke '' "${gate[@]}"
expect_status 0
bun tools/release/require-workflow-success.test.mts output "$case_root" gate
prepare missing-gate
invoke missing-gate-artifact "${gate[@]}"
expect_status 1
rg -q 'gate-artifact.*found 0' "$case_root/result"
[[ ! -s "$case_root/output" ]]
prepare duplicate-identities
invoke '' CI "$sha" 0 --artifact required-artifact --gate-artifact required-artifact
expect_status 64
rg -q 'artifact identity list is malformed' "$case_root/result"
[[ ! -s "$case_root/output" ]]
prepare malformed-metadata
invoke malformed-artifact-metadata "${standard[@]}"
expect_status 64
rg -q 'artifact inventory contains malformed metadata' "$case_root/result"
rg -q 'permanent GitHub read failure' "$case_root/result"
[[ "$(cat "$case_root/state")" == 1 && ! -s "$case_root/output" ]]
for mode in failed-run failed-candidate in-progress-run duplicate-job expired-artifact wrong-sha; do
  prepare "recovery-$mode"
  invoke "$mode" Release "$sha" 0 --run-id 77 --release-candidate --artifact required-artifact
  if [[ "$mode" == failed-run ]]; then expect_status 0; else expect_status 1; [[ ! -s "$case_root/output" ]]; fi
done
prepare invalid-recovery
invoke failed-run CI "$sha" 0 --run-id 77 --release-candidate
expect_status 2
for mode in metadata-auth metadata-transient; do
  prepare "$mode"
  invoke "$mode" CI "$sha" 0 --run-id 77 --job Qualified
  if [[ "$mode" == metadata-auth ]]; then expect_status 64; else expect_status 75; fi
  [[ ! -s "$case_root/output" ]]
done
echo 'Workflow waiter: qualification reuse/dispatch, exact evidence, retries and frozen recovery passed'
