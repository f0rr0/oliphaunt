#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "native extension lifecycle proof must run inside the Oliphaunt checkout" >&2
  exit 1
}
cd "$root"

shard_index="${SHARD_INDEX:-${1:-}}"
shard_count="${SHARD_COUNT:-${2:-}}"
if [ -z "$shard_index" ] || [ -z "$shard_count" ]; then
  echo "usage: set SHARD_INDEX and SHARD_COUNT or run-native-extension-lifecycle-proof.sh SHARD_INDEX SHARD_COUNT" >&2
  exit 2
fi
case "$shard_index:$shard_count" in
  *[!0-9:]*|:*|*:) echo "native extension lifecycle shard values must be unsigned integers" >&2; exit 2 ;;
esac

input_root="$root/target/native-extension-lifecycle/input"
stage_root="$root/target/native-extension-lifecycle/stage-$shard_index"
evidence_root="$root/target/native-extension-lifecycle/evidence"
runner="$input_root/proof-runner/oliphaunt-native-extension-proof"
candidate_sha="${CI_HEAD_SHA:?CI_HEAD_SHA must bind the native lifecycle proof to the immutable candidate}"
planned_sql_names="${OLIPHAUNT_NATIVE_EXTENSION_PROOF_SQL_NAMES:?planned native lifecycle extension SQL names are required}"
actual_sha="$(git rev-parse HEAD)"
[ "$actual_sha" = "$candidate_sha" ] || {
  echo "native extension lifecycle candidate mismatch: expected $candidate_sha, got $actual_sha" >&2
  exit 1
}
candidate_tree="$(git rev-parse 'HEAD^{tree}')"

"$root/tools/dev/bun.sh" "$root/tools/release/stage-native-extension-lifecycle.mjs" \
  --runtime-assets "$input_root/runtime" \
  --extension-assets "$input_root/extensions" \
  --broker-assets "$input_root/broker" \
  --proof-runner "$runner" \
  --candidate-sha "$candidate_sha" \
  --candidate-tree "$candidate_tree" \
  --extensions-csv "$planned_sql_names" \
  --output "$stage_root"

[ -f "$runner" ] || {
  echo "same-run native extension proof runner is missing: $runner" >&2
  exit 1
}
chmod 0755 "$runner"
mkdir -p "$evidence_root"

export OLIPHAUNT_RESOURCES_DIR="$stage_root/resources"
export LIBOLIPHAUNT_PATH="$stage_root/resources/native-runtime/liboliphaunt-native/lib/liboliphaunt.so"
export OLIPHAUNT_INSTALL_DIR="$stage_root/resources/native-runtime/liboliphaunt-native/runtime"
export OLIPHAUNT_TOOLS_DIR="$stage_root/resources/native-tools/oliphaunt-tools/runtime"
export OLIPHAUNT_EMBEDDED_MODULE_DIR="$stage_root/resources/native-runtime/liboliphaunt-native/lib/modules"
export OLIPHAUNT_BROKER="$stage_root/broker/bin/oliphaunt-broker"
runtime_library_dir="$(dirname "$LIBOLIPHAUNT_PATH")"
export LD_LIBRARY_PATH="$runtime_library_dir${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export TMPDIR="$stage_root/tmp"
mkdir -p "$TMPDIR"

cp "$stage_root/inputs.json" "$evidence_root/inputs-shard-$shard_index.json"
"$runner" --shard-index "$shard_index" --shard-count "$shard_count" 2>&1 \
  | tee "$evidence_root/proof-shard-$shard_index.log"
"$root/tools/dev/bun.sh" "$root/tools/release/write-native-extension-lifecycle-receipt.mjs" \
  --inputs "$stage_root/inputs.json" \
  --log "$evidence_root/proof-shard-$shard_index.log" \
  --shard-index "$shard_index" \
  --shard-count "$shard_count" \
  --output "$evidence_root/receipt-shard-$shard_index.json"
