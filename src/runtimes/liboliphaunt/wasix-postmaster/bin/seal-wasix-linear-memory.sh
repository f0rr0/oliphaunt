#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"

usage() {
  cat <<'EOF'
Usage: seal-wasix-linear-memory.sh [options]

Seal every installed WASIX WebAssembly module to the versioned product memory
ABI after all code-rewriting passes have completed.

Options:
  --install-dir DIR          WASIX PostgreSQL prefix (default: WASIX_INSTALL_DIR)
  --predecessor-receipt FILE Exact sealed-export structural receipt
  -h, --help                 Show this help
EOF
}

fail() {
  printf 'WASIX linear-memory sealer: %s\n' "$*" >&2
  exit 2
}

install_dir="$WASIX_INSTALL_DIR"
predecessor_receipt=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --install-dir|--predecessor-receipt)
      option="$1"
      shift
      [ "$#" -gt 0 ] || fail "$option requires a value"
      case "$option" in
        --install-dir) install_dir="$1" ;;
        --predecessor-receipt) predecessor_receipt="$1" ;;
      esac
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *) fail "unknown argument: $1" ;;
  esac
  shift
done

[ -n "$predecessor_receipt" ] || fail '--predecessor-receipt is required'
for command in find flock od python3 sha256sum sort; do
  fresh_require_command "$command"
done
[ -d "$install_dir" ] && [ ! -L "$install_dir" ] ||
  fail "missing non-symlink install prefix: $install_dir"
install_dir="$(cd "$install_dir" && pwd -P)"
fresh_require_managed_generated_path "$install_dir" WASIX_INSTALL_DIR

stage="$install_dir/.oliphaunt-linear-memory.pending"
fresh_require_managed_generated_path "$stage" linear-memory-stage
transaction_tool="$FRESH_ROOT/lib/linear_memory_transaction.py"
[ -f "$transaction_tool" ] && [ ! -L "$transaction_tool" ] ||
  fail "missing regular linear-memory transaction helper: $transaction_tool"
lock_path="$install_dir/.oliphaunt-linear-memory.lock"
exec {linear_memory_lock_fd}>"$lock_path"
chmod 0600 "$lock_path"
flock -n "$linear_memory_lock_fd" ||
  fail "another linear-memory transaction holds the install-prefix lock: $lock_path"
python3 "$transaction_tool" recover \
  --install-root "$install_dir" \
  --stage "$stage" >/dev/null ||
  fail 'could not recover an interrupted linear-memory transaction'

[ -f "$predecessor_receipt" ] && [ ! -L "$predecessor_receipt" ] ||
  fail "missing regular predecessor receipt: $predecessor_receipt"
predecessor_receipt="$(cd "$(dirname "$predecessor_receipt")" && pwd -P)/$(basename "$predecessor_receipt")"
expected_predecessor="$install_dir/share/postgresql/wasix-postmaster.sealed-export.structure.receipt"
[ "$predecessor_receipt" = "$expected_predecessor" ] ||
  fail "predecessor receipt must be the canonical sealed-export receipt: $expected_predecessor"

memory_tool="$FRESH_MEMORY_PROFILE_BIN"
fresh_require_memory_profile_tool "$memory_tool" "$FRESH_POSTMASTER_EXECUTOR_BUILD_RECEIPT"
aggregate_destination="$install_dir/share/postgresql/wasix-postmaster.linear-memory-profile.receipt.json"
if [ -e "$aggregate_destination" ] || [ -L "$aggregate_destination" ]; then
  [ -f "$aggregate_destination" ] && [ ! -L "$aggregate_destination" ] ||
    fail "existing linear-memory receipt is not a regular file: $aggregate_destination"
  python3 "$FRESH_ROOT/lib/sealed_export_chain.py" \
    --install-root "$install_dir" \
    --project-root "$FRESH_ROOT" \
    --allow-linear-memory-descendant ||
    fail 'existing linear-memory descendant proof chain is invalid'
  python3 - "$aggregate_destination" "$install_dir" "$memory_tool" <<'PY'
import json
from pathlib import Path, PurePosixPath
import subprocess
import sys

receipt_path, install_root, tool = sys.argv[1:]
with open(receipt_path, encoding="utf-8") as stream:
    receipt = json.load(stream)
for module in receipt["modules"]:
    relative = module["path"]
    pure = PurePosixPath(relative)
    if pure.is_absolute() or any(part in ("", ".", "..") for part in pure.parts):
        raise SystemExit(f"unsafe existing linear-memory module path: {relative!r}")
    subprocess.run(
        [tool, "verify", str(Path(install_root).joinpath(*pure.parts))],
        check=True,
        stdout=subprocess.DEVNULL,
    )
PY
  printf 'WASIX linear-memory profile already sealed: receipt=%s\n' \
    "$aggregate_destination"
  exit 0
fi

python3 "$FRESH_ROOT/lib/sealed_export_chain.py" \
  --install-root "$install_dir" \
  --project-root "$FRESH_ROOT" ||
  fail 'sealed-export predecessor proof chain is invalid'
profile_json="$($memory_tool --profile-json)" || fail 'could not read memory-tool profile'
predecessor_sha256="$(sha256sum "$predecessor_receipt" | awk '{print $1}')"
fresh_is_sha256 "$predecessor_sha256" || fail 'predecessor receipt hash is invalid'
predecessor_relative="${predecessor_receipt#"$install_dir"/}"

python3 "$transaction_tool" init \
  --install-root "$install_dir" \
  --stage "$stage" ||
  fail 'could not initialize the linear-memory transaction'
index="$stage/modules.tsv"
: >"$index"
transaction_active=1
cleanup() {
  local status=$?
  trap - EXIT
  if [ "${transaction_active:-0}" -eq 1 ] && \
    { [ -e "$stage" ] || [ -L "$stage" ]; }; then
    if ! python3 "$transaction_tool" recover \
      --install-root "$install_dir" \
      --stage "$stage" >/dev/null; then
      printf 'WASIX linear-memory sealer: automatic transaction recovery failed: %s\n' \
        "$stage" >&2
      status=2
    fi
  fi
  exit "$status"
}
trap cleanup EXIT

module_count=0
module_paths="$stage/module-paths.nul"
find "$install_dir/bin" "$install_dir/lib" -type f -print0 | \
  LC_ALL=C sort -z >"$module_paths" ||
  fail 'could not enumerate the installed WebAssembly module closure'
while IFS= read -r -d '' module; do
  magic="$(od -An -tx1 -N4 "$module" | tr -d ' \n')"
  [ "$magic" = 0061736d ] || continue
  relative="${module#"$install_dir"/}"
  case "$relative" in
    ''|/*|*/../*|../*|*/./*|./*|*//*|*$'\t'*|*$'\n'*|*$'\r'*)
      fail "unsafe installed module path: $relative"
      ;;
  esac
  output="$stage/modules/$relative"
  receipt="$stage/receipts/$relative.json"
  mkdir -p "$(dirname "$output")" "$(dirname "$receipt")"
  "$memory_tool" seal --output "$output" --receipt "$receipt" "$module"
  chmod --reference="$module" "$output"
  printf '%s\t%s\n' "$relative" "${receipt#"$stage"/}" >>"$index"
  module_count=$((module_count + 1))
done <"$module_paths"
[ "$module_count" -gt 0 ] || fail 'no installed WebAssembly modules were found'

for required in \
  bin/initdb \
  bin/postgres \
  lib/libpq.so.5.18 \
  lib/postgresql/dict_snowball.so \
  lib/postgresql/plpgsql.so
do
  awk -F '\t' -v expected="$required" '$1 == expected { count += 1 } END { exit count == 1 ? 0 : 1 }' "$index" ||
    fail "required carrier module was not sealed exactly once: $required"
done

aggregate="$stage/wasix-postmaster.linear-memory-profile.receipt.json"
PROFILE_JSON="$profile_json" python3 - \
  "$stage" "$index" "$predecessor_relative" "$predecessor_sha256" "$aggregate" <<'PY'
import hashlib
import json
import os
import sys
from pathlib import Path

stage = Path(sys.argv[1])
index = Path(sys.argv[2])
predecessor_path = sys.argv[3]
predecessor_sha256 = sys.argv[4]
output = Path(sys.argv[5])
profile = json.loads(os.environ["PROFILE_JSON"])
expected_profile = {
    "address-width": "wasm32",
    "supported-host-pointer-width": "u64",
    "maximum-pages": 4096,
    "maximum-bytes": 268435456,
    "static-bound-pages": 65536,
    "static-offset-guard-bytes": 2147483648,
    "requires-shared": True,
    "requires-import": "env.memory",
    "excludes-wasm32-end-wrap": True,
    "static-access-lowering": "wasmer-llvm-unchecked-reservation-and-guard-v1",
}
for key, expected in expected_profile.items():
    if profile.get(key) != expected:
        raise SystemExit(f"memory-tool profile mismatch for {key}: {profile.get(key)!r}")
profile_id = profile.get("id")
if profile_id != "oliphaunt.wasix-postmaster.linear-memory.wasm32-max256m-u64-static4g-guard2g.v1":
    raise SystemExit(f"memory-tool profile id mismatch: {profile_id!r}")

records = []
for line in index.read_text(encoding="utf-8").splitlines():
    relative, receipt_relative = line.split("\t")
    receipt_bytes = (stage / receipt_relative).read_bytes()
    receipt = json.loads(receipt_bytes)
    if receipt.get("schema") != "oliphaunt.wasix-postmaster.linear-memory-module.v1":
        raise SystemExit(f"module receipt schema mismatch: {relative}")
    if receipt.get("profile-id") != profile_id:
        raise SystemExit(f"module profile mismatch: {relative}")
    if receipt.get("source-module-sha256") is None:
        raise SystemExit(f"module receipt has no predecessor hash: {relative}")
    records.append({
        "path": relative,
        "source-module-sha256": receipt["source-module-sha256"],
        "module-sha256": receipt["module-sha256"],
        "initial-pages": receipt["initial-pages"],
        "maximum-pages": receipt["maximum-pages"],
        "maximum-bytes": receipt["maximum-bytes"],
        "shared": receipt["shared"],
        "import-module": receipt["import-module"],
        "import-name": receipt["import-name"],
        "transformation": receipt["transformation"],
    })
records.sort(key=lambda record: record["path"])
if len(records) != len({record["path"] for record in records}):
    raise SystemExit("duplicate installed module paths")

def closure_hash(hash_field):
    digest = hashlib.sha256()
    for value in ("oliphaunt.wasix-postmaster.linear-memory-install-closure.v1", hash_field):
        encoded = value.encode()
        digest.update(len(encoded).to_bytes(8, "big"))
        digest.update(encoded)
    for record in records:
        for value in (record["path"], record[hash_field]):
            encoded = value.encode()
            digest.update(len(encoded).to_bytes(8, "big"))
            digest.update(encoded)
    return digest.hexdigest()

aggregate = {
    "schema": "oliphaunt.wasix-postmaster.linear-memory-install.v1",
    "profile-id": profile_id,
    **expected_profile,
    "predecessor-export-closure-receipt": predecessor_path,
    "predecessor-export-closure-receipt-sha256": predecessor_sha256,
    "source-module-closure-sha256": closure_hash("source-module-sha256"),
    "module-closure-sha256": closure_hash("module-sha256"),
    "module-count": len(records),
    "modules": records,
}
with output.open("x", encoding="utf-8", newline="\n") as stream:
    json.dump(aggregate, stream, indent=2, sort_keys=True)
    stream.write("\n")
    stream.flush()
    os.fsync(stream.fileno())
PY

[ "$(sha256sum "$predecessor_receipt" | awk '{print $1}')" = "$predecessor_sha256" ] ||
  fail 'predecessor export receipt changed while modules were sealed'
while IFS=$'\t' read -r relative receipt_relative; do
  "$memory_tool" verify "$stage/modules/$relative" >/dev/null
done <"$index"

[ "$(sha256sum "$predecessor_receipt" | awk '{print $1}')" = "$predecessor_sha256" ] ||
  fail 'predecessor export receipt changed before transaction preparation'

python3 "$transaction_tool" prepare \
  --install-root "$install_dir" \
  --stage "$stage" \
  --aggregate "$aggregate" ||
  fail 'could not prepare durable linear-memory rollback state'
python3 "$transaction_tool" publish \
  --install-root "$install_dir" \
  --stage "$stage" ||
  fail 'could not publish the linear-memory transaction'
transaction_active=0
trap - EXIT
printf 'sealed WASIX linear-memory profile: modules=%s receipt=%s\n' \
  "$module_count" "$aggregate_destination"
