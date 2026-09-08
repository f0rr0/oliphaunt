#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$root"
tool="$root/benchmarks/perf/wasix-node/benchmark.mts"
measured=false
for argument in "$@"; do
  if [ "$argument" = --run ]; then measured=true; fi
done
if [ "$measured" = false ]; then exec node "$tool" "$@"; fi
deadline="$(command -v gtimeout || command -v timeout)"
command -v jq >/dev/null
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
git rev-parse HEAD > "$scratch/git-commit"
git status --porcelain=v1 --untracked-files=all > "$scratch/git-status"
node "$tool" --prepare "$scratch" "$@"
(
  cd "$scratch/consumer"
  NPM_CONFIG_IGNORE_SCRIPTS=true PNPM_CONFIG_IGNORE_SCRIPTS=true \
    "$deadline" --kill-after=3s 120s pnpm install --ignore-scripts --no-frozen-lockfile
)
node "$tool" --inspect "$scratch" "$@"
plan="$(jq -r '.planSource.file' "$scratch/measurement.json")"
jq -r '.sequence[] | [.repeat, .engine] | @tsv' "$scratch/measurement.json" > "$scratch/order"
while IFS=$'\t' read -r repeat engine; do
  extra=()
  if [[ "$engine" = candidate-* ]]; then extra=(--candidate-root "$scratch/consumer"); fi
  "$deadline" --kill-after=3s 900s node benchmarks/perf/wasix-node/engine-runner.mts \
    --engine "$engine" --repeat "$repeat" --plan "$plan" \
    --output "$scratch/runs/$repeat-$engine.json" "${extra[@]}"
done < "$scratch/order"
node "$tool" --report "$scratch" "$@"
