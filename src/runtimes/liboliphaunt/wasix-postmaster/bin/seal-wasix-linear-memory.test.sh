#!/usr/bin/env bash

set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
source "$project_root/lib/common.sh"
memory_tool="$FRESH_MEMORY_PROFILE_BIN"
[ -f "$memory_tool" ] && [ -x "$memory_tool" ] || {
  printf 'missing executable memory-profile tool: %s\n' "$memory_tool" >&2
  exit 2
}
repo_root="$(cd "$project_root/../../../.." && pwd -P)"
mkdir -p "$repo_root/target/oliphaunt-wasix-postmaster"
test_root="$(mktemp -d "$repo_root/target/oliphaunt-wasix-postmaster/linear-memory-test.XXXXXX")"
cleanup() {
  chmod -R u+w "$test_root" 2>/dev/null || true
  rm -rf -- "$test_root"
}
trap cleanup EXIT

make_fixture() {
  local name="$1"
  local root="$test_root/$name"
  local receipt="$root/executor.receipt"
  mkdir -p \
    "$root/install/bin" \
    "$root/install/lib/postgresql" \
    "$root/install/share/postgresql"
  python3 - "$root" <<'PY'
import os
import sys
from pathlib import Path

root = Path(sys.argv[1])
module = bytes.fromhex(
    "0061736d01000000"
    "0212"
    "01"
    "03656e76"
    "066d656d6f7279"
    "02"
    "03"
    "01"
    "808004"
)
for relative in (
    "bin/initdb",
    "bin/postgres",
    "lib/libpq.so.5.18",
    "lib/postgresql/dict_snowball.so",
    "lib/postgresql/plpgsql.so",
):
    path = root / "install" / relative
    path.write_bytes(module)
    os.chmod(path, 0o755)
PY
  python3 "$project_root/testdata/make-sealed-export-fixture.py" \
    --install-root "$root/install" \
    --project-root "$project_root"
  memory_hash="$(sha256sum "$memory_tool" | awk '{print $1}')"
  python3 - "$receipt" "$memory_hash" <<'PY'
import sys

path, memory_hash = sys.argv[1:]
fields = [
    ("schema", "oliphaunt.wasix-postmaster.postmaster-executor-build.v3"),
    ("build_recipe_sha256", "1" * 64),
    ("wasmer_build_receipt_sha256", "2" * 64),
    ("wasmer_source_commit", "3" * 40),
    ("wasmer_patch_sha256", "4" * 64),
    ("wasmer_prepared_signature_sha256", "5" * 64),
    ("wasmer_cargo_lock_sha256", "6" * 64),
    ("runtime_abi_id", "7" * 64),
    ("artifact_abi_version", "21"),
    ("executor_package", "oliphaunt-wasix-postmaster-executor"),
    ("executor_binary", "oliphaunt-wasix-postmaster-executor"),
    ("executor_features", "product-executor"),
    ("executor_role", "postmaster-product"),
    ("runtime_policy_id", "fixture"),
    ("cli_contract", "fixture"),
    ("executor_binary_sha256", "8" * 64),
    ("start_proof_binary", "oliphaunt-wasix-start-proof"),
    ("start_proof_features", "start-proof-tool"),
    ("start_proof_policy", "fixture"),
    ("start_proof_binary_sha256", "9" * 64),
    ("memory_profile_binary", "oliphaunt-wasix-memory-profile"),
    ("memory_profile_features", "memory-profile-tool"),
    ("linear_memory_profile_id", "oliphaunt.wasix-postmaster.linear-memory.wasm32-max256m-u64-static4g-guard2g.v1"),
    ("memory_profile_binary_sha256", memory_hash),
    ("postmaster_compiler_binary", "oliphaunt-wasix-postmaster-compiler"),
    ("postmaster_compiler_features", "product-compiler"),
    ("compiler_cpu_policy", "generic-baseline"),
    ("compiler_cpu_features", "none"),
    ("postmaster_compiler_binary_sha256", "a" * 64),
    ("host_platform", "fixture"),
    ("host_abi", "fixture"),
    ("rustc_host", "fixture"),
    ("rustc_version", "fixture"),
]
with open(path, "x", encoding="utf-8", newline="\n") as stream:
    for key, value in fields:
        stream.write(f"{key}={value}\n")
PY
  printf '%s\n' "$root"
}

invoke() {
  local root="$1"
  FRESH_WORK_ROOT="$test_root/work" \
  WASIX_INSTALL_DIR="$root/install" \
  FRESH_MEMORY_PROFILE_BIN="$memory_tool" \
  FRESH_POSTMASTER_EXECUTOR_BUILD_RECEIPT="$root/executor.receipt" \
    "$project_root/bin/seal-wasix-linear-memory.sh" \
      --install-dir "$root/install" \
      --predecessor-receipt \
        "$root/install/share/postgresql/wasix-postmaster.sealed-export.structure.receipt"
}

success_root="$(make_fixture success)"
invoke "$success_root"
python3 - "$success_root/install" "$memory_tool" <<'PY'
import json
import subprocess
import sys
from pathlib import Path

root = Path(sys.argv[1])
tool = sys.argv[2]
receipt = json.loads(
    (root / "share/postgresql/wasix-postmaster.linear-memory-profile.receipt.json").read_text()
)
assert receipt["module-count"] == 29
assert [record["path"] for record in receipt["modules"]] == sorted(
    record["path"] for record in receipt["modules"]
)
for record in receipt["modules"]:
    assert record["source-module-sha256"] != record["module-sha256"]
    subprocess.run([tool, "verify", root / record["path"]], check=True, stdout=subprocess.DEVNULL)
PY
receipt_before="$(sha256sum "$success_root/install/share/postgresql/wasix-postmaster.linear-memory-profile.receipt.json" | awk '{print $1}')"
invoke "$success_root" >/dev/null
receipt_after="$(sha256sum "$success_root/install/share/postgresql/wasix-postmaster.linear-memory-profile.receipt.json" | awk '{print $1}')"
[ "$receipt_before" = "$receipt_after" ] || {
  echo 'idempotent linear-memory sealing changed the aggregate receipt' >&2
  exit 1
}

exec {held_lock_fd}>"$success_root/install/.oliphaunt-linear-memory.lock"
flock -n "$held_lock_fd"
if invoke "$success_root" >/dev/null 2>&1; then
  echo 'linear-memory sealer ignored its install-prefix lock' >&2
  exit 1
fi
flock -u "$held_lock_fd"
exec {held_lock_fd}>&-

stale_root="$(make_fixture stale-staging)"
python3 "$project_root/lib/linear_memory_transaction.py" init \
  --install-root "$stale_root/install" \
  --stage "$stale_root/install/.oliphaunt-linear-memory.pending"
invoke "$stale_root" >/dev/null
[ ! -e "$stale_root/install/.oliphaunt-linear-memory.pending" ] || {
  echo 'linear-memory sealer did not recover an abandoned construction stage' >&2
  exit 1
}

rollback_root="$(make_fixture rollback)"
before="$(sha256sum "$rollback_root/install/bin/initdb" | awk '{print $1}')"
chmod 0555 "$rollback_root/install/lib"
if invoke "$rollback_root" >/dev/null 2>&1; then
  echo 'expected publication failure with a read-only later module directory' >&2
  exit 1
fi
chmod 0755 "$rollback_root/install/lib"
after="$(sha256sum "$rollback_root/install/bin/initdb" | awk '{print $1}')"
[ "$after" = "$before" ] || {
  echo 'publication rollback did not restore an earlier module' >&2
  exit 1
}
[ ! -e "$rollback_root/install/share/postgresql/wasix-postmaster.linear-memory-profile.receipt.json" ] || {
  echo 'failed publication exposed an aggregate receipt' >&2
  exit 1
}
[ ! -e "$rollback_root/install/.oliphaunt-linear-memory.pending" ] || {
  echo 'failed publication left recoverable transaction state after rollback' >&2
  exit 1
}

printf 'WASIX linear-memory sealer tests passed\n'
