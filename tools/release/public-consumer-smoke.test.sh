#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
bun test ./tools/release/public-consumer-smoke.test.mts
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
for mode in success fail timeout; do
  mkdir "$scratch/$mode"
  bun tools/release/public-consumer-smoke.test.mts prepare-npm "$scratch/$mode" "$mode"
  unset FAIL_PUBLIC_PROBE HANG_PUBLIC_PROBE PUBLIC_PROBE_CHILD
  expected=0
  if [[ "$mode" == fail ]]; then export FAIL_PUBLIC_PROBE=1; expected=7; fi
  if [[ "$mode" == timeout ]]; then export HANG_PUBLIC_PROBE=1 PUBLIC_PROBE_CHILD="$scratch/child-pid"; expected=124; fi
  status=0
  bash tools/release/public-consumer-smoke.sh --surface "$scratch/$mode" npm > "$scratch/$mode/output" 2>&1 || status=$?
  if [[ "$status" != "$expected" ]]; then cat "$scratch/$mode/output" >&2; exit 1; fi
  bun tools/release/public-consumer-smoke.test.mts assert-npm "$scratch/$mode" "$mode"
done
[[ "$(wc -l < "$scratch/attempts")" -eq 3 ]]
pid="$(cat "$scratch/child-pid")"
status=0
state="$(ps -o stat= -p "$pid")" || status=$?
[[ "$status" == 1 || "$state" == Z* || -z "$state" ]]
echo 'Public consumers: clean Cargo context, npm resolution, no retry on failure and descendant timeout passed'
