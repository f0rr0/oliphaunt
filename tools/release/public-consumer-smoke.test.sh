#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
bash tools/dev/bun.sh test ./tools/release/public-consumer-smoke.test.mts
source_root="$PWD"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
mkdir "$scratch/cargo"
bun tools/release/public-consumer-smoke.test.mts prepare-cargo "$scratch/cargo"
clean=(env -i)
while IFS= read -r -d '' entry; do clean+=("$entry"); done < "$scratch/cargo/environment"
(cd "$scratch/cargo"; "${clean[@]}" cargo generate-lockfile)
[[ -f "$scratch/cargo/Cargo.lock" ]]
mkdir "$scratch/bin"
export PUBLIC_PROBE_TIMEOUT="$(command -v gtimeout || command -v timeout)"
cat > "$scratch/bin/gtimeout" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
# Stage/startup has its own generous budget. Shorten only the deliberate
# hanging consumer, while still exercising the real process-group timeout.
if [[ " $* " == *" npm install "* && -n "${HANG_PUBLIC_PROBE:-}" ]]; then
  sleep 2
  set -- "$1" 2s "${@:3}"
fi
exec "$PUBLIC_PROBE_TIMEOUT" "$@"
SH
chmod +x "$scratch/bin/gtimeout"
cat > "$scratch/bin/npm" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[[ -z "${SENSITIVE_TOKEN:-}${CARGO_REGISTRY_TOKEN:-}" ]] || { echo 'credentials leaked' >&2; exit 99; }
printf 'attempt\n' >> "$PUBLIC_PROBE_COUNTER"
[[ -z "${FAIL_PUBLIC_PROBE:-}" ]] || exit 7
if [[ -n "${HANG_PUBLIC_PROBE:-}" ]]; then
  sleep 30 &
  printf '%s' "$!" > "$PUBLIC_PROBE_CHILD"
  wait "$!"
fi
bun "$PUBLIC_PROBE_FIXTURE" install-npm
SH
chmod +x "$scratch/bin/npm"
export PATH="$scratch/bin:$PATH" SENSITIVE_TOKEN=must-not-survive CARGO_REGISTRY_TOKEN=must-not-survive
export PUBLIC_PROBE_COUNTER="$scratch/attempts" PUBLIC_PROBE_FIXTURE="$source_root/tools/release/public-consumer-smoke.test.mts"
for mode in success platforms unknown-platform missing-entry fail timeout expired; do
  mkdir "$scratch/$mode"
  bun tools/release/public-consumer-smoke.test.mts prepare-npm "$scratch/$mode" "$mode"
  unset FAIL_PUBLIC_PROBE HANG_PUBLIC_PROBE OMIT_PUBLIC_PROBE PUBLIC_PROBE_CHILD
  expected=0
  if [[ "$mode" == expired ]]; then expected=1; fi
  if [[ "$mode" == unknown-platform ]]; then expected=1; fi
  if [[ "$mode" == missing-entry ]]; then export OMIT_PUBLIC_PROBE=1; expected=1; fi
  if [[ "$mode" == fail ]]; then export FAIL_PUBLIC_PROBE=1; expected=7; fi
  if [[ "$mode" == timeout ]]; then export HANG_PUBLIC_PROBE=1 PUBLIC_PROBE_CHILD="$scratch/child-pid"; expected=124; fi
  status=0
  bash tools/release/public-consumer-smoke.sh --surface "$scratch/$mode" npm > "$scratch/$mode/output" 2>&1 || status=$?
  if [[ "$status" != "$expected" ]]; then cat "$scratch/$mode/output" >&2; exit 1; fi
  if [[ "$mode" == expired ]]; then grep -q "shared public-consumer deadline reached" "$scratch/$mode/output"; fi
  if [[ "$mode" == unknown-platform ]]; then grep -q "unsupported npm consumer target" "$scratch/$mode/output"; fi
  if [[ "$mode" == missing-entry ]]; then grep -q "entry package was not installed from the public registry" "$scratch/$mode/output"; fi
  bun tools/release/public-consumer-smoke.test.mts assert-npm "$scratch/$mode" "$mode"
done
[[ "$(wc -l < "$scratch/attempts")" -eq 12 ]]
pid="$(cat "$scratch/child-pid")"
status=0
state="$(ps -o stat= -p "$pid")" || status=$?
[[ "$status" == 1 || "$state" == Z* || -z "$state" ]]
echo 'Public consumers: clean Cargo context, npm resolution, no retry on failure and descendant timeout passed'

# Exercise the coordinator too: --surface alone never drains its PID arrays.
coordinator="$scratch/coordinator"
mkdir -p "$coordinator/tools/release" "$coordinator/tools/dev" "$coordinator/bin"
cp tools/release/public-consumer-smoke.sh "$coordinator/tools/release/"
export PUBLIC_PROBE_COORDINATOR="$coordinator" PUBLIC_PROBE_BASH="$BASH"
cat > "$coordinator/tools/dev/bun.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
case "$2" in
  --prepare)
    [[ "${4:-}" != --help ]] || exit 0
    printf '{"deadlineMilliseconds":%s,"plan":{"surfaces":[{"ecosystem":"cargo"},{"ecosystem":"npm"},{"ecosystem":"maven"}]}}\n' "$(( ($(date +%s) + 60) * 1000 ))" > "$3/context.json" ;;
  --report)
    for surface in cargo npm maven github; do [[ -f "$PUBLIC_PROBE_COORDINATOR/$surface" ]]; done
    touch "$PUBLIC_PROBE_COORDINATOR/report" ;;
  *) exit 99 ;;
esac
SH
cat > "$coordinator/bin/bash" <<'SH'
#!/bin/bash
set -euo pipefail
if [[ "$1" == "$PUBLIC_PROBE_COORDINATOR/tools/release/public-consumer-smoke.sh" && "${2:-}" == --surface ]]; then
  [[ "${FAIL_PUBLIC_PROBE:-}" != "$4" ]] || exit 7
  sleep 0.1
  touch "$PUBLIC_PROBE_COORDINATOR/$4"
  exit 0
fi
exec "$PUBLIC_PROBE_BASH" "$@"
SH
chmod +x "$coordinator/bin/bash"
unset FAIL_PUBLIC_PROBE HANG_PUBLIC_PROBE
PATH="$coordinator/bin:$PATH" "$PUBLIC_PROBE_BASH" "$coordinator/tools/release/public-consumer-smoke.sh" --help
PATH="$coordinator/bin:$PATH" "$PUBLIC_PROBE_BASH" "$coordinator/tools/release/public-consumer-smoke.sh"
[[ -f "$coordinator/report" ]]
rm "$coordinator/report"
status=0
FAIL_PUBLIC_PROBE=npm PATH="$coordinator/bin:$PATH" "$PUBLIC_PROBE_BASH" "$coordinator/tools/release/public-consumer-smoke.sh" || status=$?
[[ "$status" == 7 && ! -f "$coordinator/report" ]]
echo 'Public consumer coordinator: help, all probes drained, report after success, and failed probe blocks report passed'
