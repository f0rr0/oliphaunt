#!/usr/bin/env bash

set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runner="$project_root/bin/qualify-wasix-checkpoint-recycle.sh"
fixture="$(mktemp -d)"
trap 'rm -rf -- "$fixture"' EXIT
mkdir -p "$fixture/carrier"

"$runner" --print-plan >"$fixture/smoke.tsv"
grep -Fxq $'mode\tsmoke' "$fixture/smoke.tsv"
grep -Fxq $'blocks\t1' "$fixture/smoke.tsv"
grep -Fxq $'duration_seconds\t40' "$fixture/smoke.tsv"
grep -Fxq $'classification\tresearch-only-non-release' \
  "$fixture/smoke.tsv"

"$runner" --mode diagnostic --print-plan >"$fixture/diagnostic.tsv"
grep -Fxq $'blocks\t3' "$fixture/diagnostic.tsv"
grep -Fxq $'duration_seconds\t240' "$fixture/diagnostic.tsv"
grep -Fxq $'min_wal_bytes\t536870912' "$fixture/diagnostic.tsv"
grep -Fxq $'min_checkpoints\t6' "$fixture/diagnostic.tsv"
grep -Fxq $'cgroup_memory_max\t256M' "$fixture/diagnostic.tsv"
grep -Fxq $'cgroup_memory_high\t224M' "$fixture/diagnostic.tsv"
grep -Fxq $'cgroup_swap_max\t0' "$fixture/diagnostic.tsv"

"$runner" --cgroup-memory-max 384M --cgroup-memory-high 320MiB \
  --cgroup-swap-max 64M --print-plan >"$fixture/cgroup.tsv"
grep -Fxq $'cgroup_memory_max_bytes\t402653184' "$fixture/cgroup.tsv"
grep -Fxq $'cgroup_memory_high_bytes\t335544320' "$fixture/cgroup.tsv"
grep -Fxq $'cgroup_swap_max_bytes\t67108864' "$fixture/cgroup.tsv"

if "$runner" --cgroup-memory-max 256M --cgroup-memory-high 257M \
  --print-plan >"$fixture/high.stdout" 2>"$fixture/high.stderr"; then
  echo 'plan accepted MemoryHigh above MemoryMax' >&2
  exit 1
fi
grep -Fq 'MemoryHigh may not exceed MemoryMax' "$fixture/high.stderr"

if "$runner" --cgroup-memory-max infinity --print-plan \
  >"$fixture/infinite.stdout" 2>"$fixture/infinite.stderr"; then
  echo 'plan accepted an unbounded MemoryMax' >&2
  exit 1
fi
grep -Fq 'invalid cgroup size: infinity' "$fixture/infinite.stderr"

if "$runner" --mode qualification --blocks 9 --print-plan \
  >"$fixture/qualification.stdout" 2>"$fixture/qualification.stderr"; then
  echo 'qualification plan accepted fewer than ten balanced blocks' >&2
  exit 1
fi
grep -Fq 'requires at least 10 balanced blocks' "$fixture/qualification.stderr"

if "$runner" --stagger-us 1000001 --print-plan \
  >"$fixture/stagger.stdout" 2>"$fixture/stagger.stderr"; then
  echo 'plan accepted a stagger outside the compiled probe limit' >&2
  exit 1
fi
grep -Fq 'exceeds the probe limit' "$fixture/stagger.stderr"

grep -Fq 'fresh postmaster' "$runner"
grep -Fq '"--property=MemoryMax=$cgroup_memory_max"' "$runner"
grep -Fq '"--property=MemoryHigh=$cgroup_memory_high"' "$runner"
grep -Fq '"--property=MemorySwapMax=$cgroup_swap_max"' "$runner"
grep -Fq 'database system was shut down at' "$runner"
grep -Fq 'research-only' "$runner"
[ "$(grep -Fc 'run --quiet --disable-cache' "$runner")" -eq 1 ] || {
  echo 'qualifier must have exactly one Wasmer run prefix' >&2
  exit 1
}
[ "$(grep -Fc -- '--data-checksums --no-instructions' "$runner")" -eq 2 ] || {
  echo 'both native and WASIX initdb must enable data checksums' >&2
  exit 1
}
[ "$(grep -Fc 'verify_online_data_checksums' "$runner")" -eq 4 ] || {
  echo 'online checksum verification must cover both pairs and recycle epochs' >&2
  exit 1
}
grep -Fq '"$pg_checksums_bin" --check -D "$pgdata"' "$runner"
grep -Fq "grep -Fq 'Checksum operation completed'" "$runner"
grep -Fq 'extract-checkpoint-summary.py' "$runner"
grep -Fq 'OLIPHAUNT_WASIX_REQUIRE_ZERO_WRITE_AOT=1' "$runner"
grep -Fq -- '--required-snapshot-mode direct-immutable-inode' "$runner"
grep -Fq 'checkpoint-qualification-policy.v3' "$runner"
grep -Fq 'validate-adaptive-file-cache-telemetry.py' "$runner"
grep -Fq 'Path::with_extension("adaptive.json")' "$runner"
grep -Fq 'checkpoint-evidence-envelope.v3' "$runner"
grep -Fq 'standalone-cgroup-policy.v1' "$runner"
if grep -Fq 'OLIPHAUNT_WASIX_ADAPTIVE_CACHE_TELEMETRY_FILE' "$runner"; then
  echo 'checkpoint qualifier added an adaptive policy environment surface' >&2
  exit 1
fi
if "$runner" --sealed-carrier "$fixture/carrier" \
  >"$fixture/missing-receipt.stdout" 2>"$fixture/missing-receipt.stderr"; then
  echo 'executable checkpoint qualifier accepted no immutable receipt' >&2
  exit 1
fi
grep -Fq -- '--immutable-carrier-receipt is required' \
  "$fixture/missing-receipt.stderr"

printf 'checkpoint/recycle qualifier tests passed\n'
