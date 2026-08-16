#!/usr/bin/env bash

set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-sealed-carrier.XXXXXX")"
test_root="$(cd "$test_root" && pwd -P)"
cleanup_test_root() {
  chmod -R u+w "$test_root" 2>/dev/null || true
  rm -rf -- "$test_root"
}
trap cleanup_test_root EXIT

export FRESH_WORK_ROOT="$test_root/work"
export FRESH_UPSTREAM_WASMER_BIN="$test_root/wasmer"
export FRESH_UPSTREAM_WASMER_HEADLESS_BIN="$test_root/wasmer-headless"
export FRESH_POSTMASTER_EXECUTOR_BIN="$test_root/postmaster-executor"
export FRESH_START_PROOF_BIN="$test_root/start-proof"
export FRESH_POSTMASTER_COMPILER_BIN="$test_root/postmaster-compiler"
export FRESH_WASMER_BUILD_RECEIPT="$test_root/wasmer-build.receipt"
export FRESH_POSTMASTER_EXECUTOR_BUILD_RECEIPT="$test_root/postmaster-executor-build.receipt"
export WASIX_INSTALL_DIR="$test_root/install"
export WASIX_CORE_PROFILE=release-o3
export FAKE_WASMER_CAPTURE_LOG="$test_root/memory-captures.log"
export FAKE_WASMER_VALIDATION_LOG="$test_root/final-validations.log"
unset FRESH_PINNED_WASMER_CACHE_DIR FRESH_ALLOW_PINNED_CACHE_WRITE

source "$project_root/lib/common.sh"
source "$project_root/lib/sealed-carrier.sh"

atomic_parent="$test_root/atomic-publication"
mkdir -p "$atomic_parent/source" "$atomic_parent/competitor"
printf 'owned-by-competitor\n' >"$atomic_parent/competitor/sentinel"
if fresh_atomic_publish_directory_noreplace \
  "$atomic_parent/source" "$atomic_parent/competitor" >/dev/null 2>&1; then
  printf 'atomic carrier publication replaced a competitor unexpectedly\n' >&2
  exit 1
fi
[ -d "$atomic_parent/source" ] && \
  [ "$(cat "$atomic_parent/competitor/sentinel")" = owned-by-competitor ] || {
  printf 'failed atomic publication mutated source or competitor output\n' >&2
  exit 1
}
mkdir "$atomic_parent/publishable"
printf 'published\n' >"$atomic_parent/publishable/payload"
fresh_atomic_publish_directory_noreplace \
  "$atomic_parent/publishable" "$atomic_parent/published"
[ ! -e "$atomic_parent/publishable" ] && \
  [ "$(cat "$atomic_parent/published/payload")" = published ] || {
  printf 'atomic carrier publication did not rename the exact source directory\n' >&2
  exit 1
}

mkdir -p \
  "$WASIX_INSTALL_DIR/bin" \
  "$WASIX_INSTALL_DIR/lib/postgresql" \
  "$WASIX_INSTALL_DIR/share/postgresql"
cp "$project_root/testdata/fake-sealed-wasmer.py" "$FRESH_UPSTREAM_WASMER_BIN"
cp "$project_root/testdata/fake-sealed-wasmer.py" "$FRESH_UPSTREAM_WASMER_HEADLESS_BIN"
cp "$project_root/testdata/fake-sealed-wasmer.py" "$FRESH_POSTMASTER_EXECUTOR_BIN"
printf '# product-executor-fixture\n' >>"$FRESH_POSTMASTER_EXECUTOR_BIN"
cp "$project_root/testdata/fake-start-proof.py" "$FRESH_START_PROOF_BIN"
cp "$project_root/testdata/fake-postmaster-compiler.py" "$FRESH_POSTMASTER_COMPILER_BIN"
chmod +x "$FRESH_UPSTREAM_WASMER_BIN" "$FRESH_UPSTREAM_WASMER_HEADLESS_BIN" \
  "$FRESH_POSTMASTER_EXECUTOR_BIN" "$FRESH_START_PROOF_BIN" \
  "$FRESH_POSTMASTER_COMPILER_BIN"
printf 'initdb-wasm\n' >"$WASIX_INSTALL_DIR/bin/initdb"
printf 'postgres-wasm\n' >"$WASIX_INSTALL_DIR/bin/postgres"
printf 'libpq-wasm\n' >"$WASIX_INSTALL_DIR/lib/libpq.so.5.18"
printf 'snowball-wasm\n' >"$WASIX_INSTALL_DIR/lib/postgresql/dict_snowball.so"
printf 'plpgsql-wasm\n' >"$WASIX_INSTALL_DIR/lib/postgresql/plpgsql.so"
printf 'sample-config\n' >"$WASIX_INSTALL_DIR/share/postgresql/postgresql.conf.sample"
python3 "$project_root/testdata/make-sealed-export-fixture.py" \
  --install-root "$WASIX_INSTALL_DIR" \
  --project-root "$project_root"
chmod 0644 "$WASIX_INSTALL_DIR/share/postgresql/postgresql.conf.sample"
postgres_sha256="$(fresh_wasmer_bin_hash "$WASIX_INSTALL_DIR/bin/postgres")"
final_wasm_concurrency_receipt="$WASIX_INSTALL_DIR/share/postgresql/wasix-postmaster.final-wasm-concurrency.receipt"
{
  printf 'schema=oliphaunt.wasix-postmaster.final-wasm-concurrency.v1\n'
  printf 'postgres_sha256=%s\n' "$postgres_sha256"
  printf 'wasm_dis_sha256=%064d\n' 2
  printf 'wasm_dis_version=fake-wasm-dis version 130\n'
  printf 'latch_state_contract=packed-atomic-v1\n'
  printf 'atomic_fence_total=995\n'
  printf 'atomic_fence_set_latch=2\n'
  printf 'atomic_fence_reset_latch=1\n'
  printf 'atomic_fence_wait_event_set_wait=1\n'
  printf 'i32_atomic_load_total=2\n'
  printf 'i32_atomic_load_wait_event_set_wait=2\n'
  printf 'i32_atomic_rmw_and_total=7\n'
  printf 'i32_atomic_rmw_and_reset_latch=1\n'
  printf 'i32_atomic_rmw_and_wait_event_set_wait=2\n'
  printf 'i32_atomic_rmw_or_total=117\n'
  printf 'i32_atomic_rmw_or_set_latch=1\n'
  printf 'i32_atomic_rmw_or_wait_event_set_wait=1\n'
} >"$final_wasm_concurrency_receipt"
chmod 0444 "$final_wasm_concurrency_receipt"
final_wasm_concurrency_receipt_sha256="$(
  fresh_wasmer_bin_hash "$final_wasm_concurrency_receipt"
)"

sealed_export_receipt="$WASIX_INSTALL_DIR/share/postgresql/wasix-postmaster.sealed-export.structure.receipt"
linear_memory_receipt="$WASIX_INSTALL_DIR/share/postgresql/wasix-postmaster.linear-memory-profile.receipt.json"
python3 - "$WASIX_INSTALL_DIR" "$sealed_export_receipt" "$linear_memory_receipt" "$project_root" <<'PY'
import hashlib
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
predecessor = Path(sys.argv[2])
output = Path(sys.argv[3])
project_root = Path(sys.argv[4])
side_manifest = project_root / "runtime/policies/sealed-side-modules.v1.tsv"
side_paths = [
    line.split("\t", 1)[0]
    for line in side_manifest.read_text(encoding="utf-8").splitlines()
    if line and not line.startswith("#")
]
module_paths = ("bin/initdb", "bin/postgres", *side_paths)
records = []
for relative in module_paths:
    data = (root / relative).read_bytes()
    records.append(
        {
            "path": relative,
            "source-module-sha256": hashlib.sha256(data).hexdigest(),
            "module-sha256": hashlib.sha256(data).hexdigest(),
            "initial-pages": 1,
            "maximum-pages": 4096,
            "maximum-bytes": 268435456,
            "shared": True,
            "import-module": "env",
            "import-name": "memory",
            "transformation": "pinned-wasixcc-65536-to-embedded-4096-reversible-v1",
        }
    )
records.sort(key=lambda record: record["path"])

def closure_hash(field):
    digest = hashlib.sha256()
    for value in (
        "oliphaunt.wasix-postmaster.linear-memory-install-closure.v1",
        field,
    ):
        encoded = value.encode()
        digest.update(len(encoded).to_bytes(8, "big"))
        digest.update(encoded)
    for record in records:
        for value in (record["path"], record[field]):
            encoded = value.encode()
            digest.update(len(encoded).to_bytes(8, "big"))
            digest.update(encoded)
    return digest.hexdigest()

receipt = {
    "schema": "oliphaunt.wasix-postmaster.linear-memory-install.v1",
    "profile-id": "oliphaunt.wasix-postmaster.linear-memory.wasm32-max256m-u64-static4g-guard2g.v1",
    "address-width": "wasm32",
    "supported-host-pointer-width": "u64",
    "maximum-pages": 4096,
    "maximum-bytes": 268435456,
    "static-bound-pages": 65536,
    "static-offset-guard-bytes": 2147483648,
    "static-access-lowering": "wasmer-llvm-unchecked-reservation-and-guard-v1",
    "requires-shared": True,
    "requires-import": "env.memory",
    "excludes-wasm32-end-wrap": True,
    "predecessor-export-closure-receipt": predecessor.relative_to(root).as_posix(),
    "predecessor-export-closure-receipt-sha256": hashlib.sha256(predecessor.read_bytes()).hexdigest(),
    "source-module-closure-sha256": closure_hash("source-module-sha256"),
    "module-closure-sha256": closure_hash("module-sha256"),
    "module-count": len(records),
    "modules": records,
}
with output.open("x", encoding="utf-8", newline="\n") as stream:
    json.dump(receipt, stream, indent=2, sort_keys=True)
    stream.write("\n")
PY
chmod 0444 "$sealed_export_receipt" "$linear_memory_receipt"
linear_memory_install_receipt_sha256="$(fresh_wasmer_bin_hash "$linear_memory_receipt")"

installed_closure_sha256="$(
  python3 "$project_root/lib/guest_build_provenance.py" \
    identity "$WASIX_INSTALL_DIR"
)"
{
  printf 'schema=oliphaunt.wasix-postmaster.guest-build.v5\n'
  printf 'core_profile=release-o3\n'
  printf 'guest_source_signature_sha256=%064d\n' 1
  printf 'docker_image_id=sha256:%064d\n' 2
  printf 'installed_closure_sha256=%s\n' "$installed_closure_sha256"
  printf 'child_backend=exec\n'
  printf 'effective_cflags=-O3 -g0 -flto=thin\n'
  printf 'effective_ldflags=-flto=thin\n'
  printf 'effective_wasm_opt=yes\n'
  printf 'effective_wasm_opt_flags=--converge:--strip-debug:--strip-producers\n'
  printf 'effective_wasm_opt_suppress_default=yes\n'
  printf 'atomic_fence_total=995\n'
  printf 'atomic_fence_set_latch=2\n'
  printf 'atomic_fence_reset_latch=1\n'
  printf 'atomic_fence_wait_event_set_wait=1\n'
  printf 'latch_state_contract=packed-atomic-v1\n'
  printf 'final_wasm_concurrency_receipt_sha256=%s\n' \
    "$final_wasm_concurrency_receipt_sha256"
  printf 'linear_memory_profile_id=%s\n' "$FRESH_LINEAR_MEMORY_PROFILE_ID"
  printf 'linear_memory_install_receipt_sha256=%s\n' \
    "$linear_memory_install_receipt_sha256"
  printf 'postgres_tag=%s\n' "$POSTGRES_TAG"
  printf 'postgres_version=%s\n' "$POSTGRES_VERSION"
  printf 'sysroot_variant=%s\n' "$WASIXCC_SYSROOT_VARIANT"
} >"$WASIX_INSTALL_DIR/guest-build.receipt"

cargo_lock_sha256="$(printf test-cargo-lock | fresh_sha256_stream)"
runtime_abi_id="$(fresh_runtime_abi_id \
  "$cargo_lock_sha256" "$(fresh_host_arch | sed 's/linux-amd64/x86_64-unknown-linux-gnu/; s/linux-arm64/aarch64-unknown-linux-gnu/; s/darwin-amd64/x86_64-apple-darwin/; s/darwin-arm64/aarch64-apple-darwin/')" \
  "$(fresh_host_arch)" "$(fresh_host_abi)")"
target_triple="$(fresh_host_arch | sed 's/linux-amd64/x86_64-unknown-linux-gnu/; s/linux-arm64/aarch64-unknown-linux-gnu/; s/darwin-amd64/x86_64-apple-darwin/; s/darwin-arm64/aarch64-apple-darwin/')"

{
  printf 'schema=oliphaunt.wasix-postmaster.wasmer-build.v2\n'
  printf 'build_recipe_sha256=%s\n' "$(fresh_runtime_build_recipe_sha256)"
  printf 'wasmer_source_commit=%s\n' "$FRESH_WASMER_SOURCE_COMMIT"
  printf 'wasmer_napi_commit=%s\n' "$FRESH_WASMER_NAPI_COMMIT"
  printf 'wasmer_test_files_commit=%s\n' "$FRESH_WASMER_TEST_FILES_COMMIT"
  printf 'wasmer_spec_commit=%s\n' "$FRESH_WASMER_SPEC_COMMIT"
  printf 'wasmer_patch_sha256=%s\n' "$(fresh_wasmer_bin_hash "$project_root/runtime/patches/wasmer/0001-postgres-wasix-blockers.patch")"
  printf 'wasmer_prepared_signature_sha256=%064d\n' 0
  printf 'wasmer_cargo_lock_sha256=%s\n' "$cargo_lock_sha256"
  printf 'wasmer_binary_sha256=%s\n' "$(fresh_wasmer_bin_hash "$FRESH_UPSTREAM_WASMER_BIN")"
  printf 'wasmer_features=%s\n' "$FRESH_WASMER_COMPILER_FEATURES"
  printf 'wasmer_headless_binary_sha256=%s\n' "$(fresh_wasmer_bin_hash "$FRESH_UPSTREAM_WASMER_HEADLESS_BIN")"
  printf 'wasmer_headless_features=%s\n' "$FRESH_WASMER_HEADLESS_FEATURES"
  printf 'runtime_abi_id=%s\n' "$runtime_abi_id"
  printf 'artifact_abi_version=%s\n' "$FRESH_WASMER_ARTIFACT_ABI_VERSION"
  printf 'wasix_libc_source_commit=%s\n' "$FRESH_WASIX_LIBC_SOURCE_COMMIT"
  printf 'wasix_libc_patch_sha256=%s\n' "$(fresh_wasmer_bin_hash "$project_root/runtime/patches/wasix-libc/0001-postgres-wasix-blockers.patch")"
  printf 'wasix_libc_prepared_signature_sha256=%064d\n' 0
  printf 'sysroot_carrier_manifest_sha256=%064d\n' 0
  printf 'sysroot_variant=%s\n' "$WASIXCC_SYSROOT_VARIANT"
  printf 'sysroot_variant_manifest_sha256=%064d\n' 0
  printf 'host_platform=%s\n' "$(fresh_host_arch)"
  printf 'host_abi=%s\n' "$(fresh_host_abi)"
  printf 'rustc_host=%s\n' "$target_triple"
  printf 'rustc_version=test-rustc\n'
  printf 'llvm_version=22.1.0\n'
} >"$FRESH_WASMER_BUILD_RECEIPT"

{
  printf 'schema=oliphaunt.wasix-postmaster.postmaster-executor-build.v3\n'
  printf 'build_recipe_sha256=%s\n' "$(fresh_runtime_build_recipe_sha256)"
  printf 'wasmer_build_receipt_sha256=%s\n' "$(fresh_wasmer_bin_hash "$FRESH_WASMER_BUILD_RECEIPT")"
  printf 'wasmer_source_commit=%s\n' "$FRESH_WASMER_SOURCE_COMMIT"
  printf 'wasmer_patch_sha256=%s\n' "$(fresh_manifest_value "$FRESH_WASMER_BUILD_RECEIPT" wasmer_patch_sha256)"
  printf 'wasmer_prepared_signature_sha256=%s\n' "$(fresh_manifest_value "$FRESH_WASMER_BUILD_RECEIPT" wasmer_prepared_signature_sha256)"
  printf 'wasmer_cargo_lock_sha256=%s\n' "$cargo_lock_sha256"
  printf 'runtime_abi_id=%s\n' "$runtime_abi_id"
  printf 'artifact_abi_version=%s\n' "$FRESH_WASMER_ARTIFACT_ABI_VERSION"
  printf 'executor_package=%s\n' "$FRESH_POSTMASTER_EXECUTOR_PACKAGE"
  printf 'executor_binary=%s\n' "$FRESH_POSTMASTER_EXECUTOR_BINARY"
  printf 'executor_features=%s\n' "$FRESH_POSTMASTER_EXECUTOR_FEATURES"
  printf 'executor_role=%s\n' "$FRESH_POSTMASTER_EXECUTOR_ROLE"
  printf 'runtime_policy_id=%s\n' "$FRESH_POSTMASTER_EXECUTOR_RUNTIME_POLICY_ID"
  printf 'cli_contract=%s\n' "$FRESH_POSTMASTER_EXECUTOR_CLI_CONTRACT"
  printf 'executor_binary_sha256=%s\n' "$(fresh_wasmer_bin_hash "$FRESH_POSTMASTER_EXECUTOR_BIN")"
  printf 'start_proof_binary=%s\n' "$FRESH_START_PROOF_BINARY"
  printf 'start_proof_features=%s\n' "$FRESH_START_PROOF_FEATURES"
  printf 'start_proof_policy=%s\n' "$FRESH_START_PROOF_POLICY"
  printf 'start_proof_binary_sha256=%s\n' "$(fresh_wasmer_bin_hash "$FRESH_START_PROOF_BIN")"
  printf 'memory_profile_binary=%s\n' "$FRESH_MEMORY_PROFILE_BINARY"
  printf 'memory_profile_features=%s\n' "$FRESH_MEMORY_PROFILE_FEATURES"
  printf 'linear_memory_profile_id=%s\n' "$FRESH_LINEAR_MEMORY_PROFILE_ID"
  printf 'memory_profile_binary_sha256=%064d\n' 9
  printf 'postmaster_compiler_binary=%s\n' "$FRESH_POSTMASTER_COMPILER_BINARY"
  printf 'postmaster_compiler_features=%s\n' "$FRESH_POSTMASTER_COMPILER_FEATURES"
  printf 'compiler_cpu_policy=generic-baseline\n'
  printf 'compiler_cpu_features=none\n'
  printf 'postmaster_compiler_binary_sha256=%s\n' \
    "$(fresh_wasmer_bin_hash "$FRESH_POSTMASTER_COMPILER_BIN")"
  printf 'host_platform=%s\n' "$(fresh_host_arch)"
  printf 'host_abi=%s\n' "$(fresh_host_abi)"
  printf 'rustc_host=%s\n' "$target_triple"
  printf 'rustc_version=test-rustc\n'
} >"$FRESH_POSTMASTER_EXECUTOR_BUILD_RECEIPT"

cache_bucket="$(fresh_wasmer_cache_dir "$FRESH_POSTMASTER_COMPILER_BIN")/compiled/$(fresh_wasmer_compiler_cache_bucket llvm aggressive "$FRESH_WASMER_ARTIFACT_ABI_VERSION")"
mkdir -p "$cache_bucket"
required_modules=(bin/initdb bin/postgres)
while IFS=$'\t' read -r relative _aliases _abi_policy; do
  case "$relative" in
    ""|'#'*) continue ;;
  esac
  required_modules+=("$relative")
done <"$project_root/runtime/policies/sealed-side-modules.v1.tsv"
for relative in "${required_modules[@]}"; do
  module="$WASIX_INSTALL_DIR/$relative"
  module_hash="$(fresh_wasmer_module_hash "$module")"
  "$FRESH_POSTMASTER_COMPILER_BIN" \
    --llvm --llvm-opt-level aggressive --compiler-threads 1 \
    --enable-exceptions --enable-threads \
    -o "$cache_bucket/$module_hash.bin" "$module"
done

cp "$WASIX_INSTALL_DIR/share/postgresql/postgresql.conf.sample" \
  "$test_root/postgresql.conf.sample.saved"
printf 'stale-install-mutation\n' \
  >>"$WASIX_INSTALL_DIR/share/postgresql/postgresql.conf.sample"
if "$project_root/bin/build-sealed-headless-carrier.sh" \
  --output "$test_root/stale-guest-receipt-carrier" \
  --cache-bucket "$cache_bucket" >/dev/null 2>&1
then
  printf 'carrier builder accepted guest bytes differing from their build receipt\n' >&2
  exit 1
fi
mv "$test_root/postgresql.conf.sample.saved" \
  "$WASIX_INSTALL_DIR/share/postgresql/postgresql.conf.sample"

postgres_hash="$(fresh_wasmer_module_hash "$WASIX_INSTALL_DIR/bin/postgres")"
mv "$cache_bucket/$postgres_hash.bin" "$test_root/postgres-aot.saved"
if "$project_root/bin/build-sealed-headless-carrier.sh" \
  --output "$test_root/missing-artifact-carrier" \
  --cache-bucket "$cache_bucket" >/dev/null 2>&1
then
  printf 'carrier builder compiled or ignored a missing AOT artifact\n' >&2
  exit 1
fi
mv "$test_root/postgres-aot.saved" "$cache_bucket/$postgres_hash.bin"

plpgsql_hash="$(fresh_wasmer_module_hash "$WASIX_INSTALL_DIR/lib/postgresql/plpgsql.so")"
mv "$cache_bucket/$plpgsql_hash.bin" "$test_root/plpgsql-aot.saved"
printf 'wrong-plan-or-module-fixture\n' >"$cache_bucket/$plpgsql_hash.bin"
if "$project_root/bin/build-sealed-headless-carrier.sh" \
  --output "$test_root/invalid-inactive-aot-carrier" \
  --cache-bucket "$cache_bucket" >/dev/null 2>&1
then
  printf 'carrier builder accepted an invalid inactive side-module AOT artifact\n' >&2
  exit 1
fi
mv "$test_root/plpgsql-aot.saved" "$cache_bucket/$plpgsql_hash.bin"

: >"$FAKE_WASMER_VALIDATION_LOG"
failed_validation_output="$test_root/failed-initdb-carrier"
if FAKE_WASMER_FAIL_FINAL_INITDB=1 \
  "$project_root/bin/build-sealed-headless-carrier.sh" \
    --output "$failed_validation_output" \
    --cache-bucket "$cache_bucket" >/dev/null 2>&1
then
  printf 'carrier builder published after the final initdb lifecycle failed\n' >&2
  exit 1
fi
[ ! -e "$failed_validation_output" ]
if find "$test_root" -maxdepth 1 -type d \
  \( -name '.failed-initdb-carrier.tmp.*' -o -name '.failed-initdb-carrier.validate.*' \) \
  -print -quit | grep -q .
then
  printf 'carrier builder left staging or validation state after initdb failure\n' >&2
  exit 1
fi
python3 - "$FAKE_WASMER_VALIDATION_LOG" <<'PY'
import json
import os
import sys

with open(sys.argv[1], encoding="utf-8") as stream:
    records = [json.loads(line) for line in stream]
assert [record["program"] for record in records] == ["postgres", "initdb"]
assert records[0]["arguments"] == ["--version"]
assert records[1]["arguments"] != ["--version"]
for record in records:
    for volume in record["volumes"]:
        host, guest = volume.rsplit(":", 1)
        if guest in {"/pgdata", "/dev/shm"}:
            assert not os.path.exists(host), (guest, host)
PY

: >"$FAKE_WASMER_CAPTURE_LOG"
: >"$FAKE_WASMER_VALIDATION_LOG"

if FRESH_PINNED_WASMER_CACHE_DIR="$test_root/foreign-pinned-cache" \
  "$project_root/bin/build-sealed-headless-carrier.sh" \
    --output "$test_root/pinned-cache-carrier" \
    --cache-bucket "$cache_bucket" >/dev/null 2>&1
then
  printf 'carrier builder admitted a pinned or foreign AOT cache root\n' >&2
  exit 1
fi
[ ! -e "$test_root/pinned-cache-carrier" ]

output="$test_root/carrier"
"$project_root/bin/build-sealed-headless-carrier.sh" \
  --output "$output" \
  --cache-bucket "$cache_bucket"

for required in \
  bin/wasmer-headless \
  bin/initdb \
  bin/postgres \
  lib/libpq.so \
  lib/libpq.so.5 \
  lib/libpq.so.5.18 \
  lib/postgresql/dict_snowball.so \
  lib/postgresql/plpgsql.so \
  share/postgresql/postgresql.conf.sample \
  share/postgresql/wasix-postmaster.linear-memory-profile.receipt.json \
  share/postgresql/wasix-postmaster.sealed-export.structure.receipt \
  guest-build.receipt \
  manifest.json \
  payload.files \
  postmaster-executor.receipt \
  wasmer-build.receipt
do
  [ -f "$output/$required" ] && [ ! -L "$output/$required" ] || {
    printf 'missing regular carrier test output: %s\n' "$required" >&2
    exit 1
  }
done
while IFS=$'\t' read -r relative aliases _abi_policy; do
  case "$relative" in
    ""|'#'*) continue ;;
  esac
  [ -f "$output/$relative" ] && [ ! -L "$output/$relative" ] || {
    printf 'missing regular carrier side module: %s\n' "$relative" >&2
    exit 1
  }
  if [ "$aliases" != - ]; then
    old_ifs="$IFS"
    IFS=','
    for alias_relative in $aliases; do
      IFS="$old_ifs"
      cmp -s "$output/$relative" "$output/$alias_relative" || {
        printf 'carrier side-module alias differs from canonical module: %s\n' \
          "$alias_relative" >&2
        exit 1
      }
      IFS=','
    done
    IFS="$old_ifs"
  fi
done <"$project_root/runtime/policies/sealed-side-modules.v1.tsv"
side_module_count="$(awk -F '\t' '!/^#/ && NF { count += 1 } END { print count + 0 }' \
  "$project_root/runtime/policies/sealed-side-modules.v1.tsv")"
[ "$(find "$output/aot" -type f -name '*.bin' | wc -l | tr -d '[:space:]')" -eq "$((side_module_count + 2))" ]
[ "$(wc -l <"$FAKE_WASMER_VALIDATION_LOG" | tr -d '[:space:]')" -eq 2 ]
[ "$(stat -c %a "$output" 2>/dev/null || stat -f %Lp "$output")" = 555 ]
[ "$(stat -c %a "$output/share/postgresql/postgresql.conf.sample" 2>/dev/null || stat -f %Lp "$output/share/postgresql/postgresql.conf.sample")" = 444 ]

python3 - "$output" "$project_root/runtime/policies/sealed-side-modules.v1.tsv" <<'PY'
import hashlib
import json
import os
import sys

root = sys.argv[1]
side_module_policy = sys.argv[2]
with open(os.path.join(root, "manifest.json"), encoding="utf-8") as stream:
    manifest = json.load(stream)
assert manifest["format-version"] == 6
assert manifest["schema"] == "oliphaunt.wasix-postmaster.sealed-aot.v5"
assert manifest["core-profile"] == "release-o3"
with open(os.path.join(root, "guest-build.receipt"), "rb") as stream:
    guest_build_receipt = stream.read()
assert manifest["guest-build-recipe-sha256"] == hashlib.sha256(
    guest_build_receipt
).hexdigest()
assert manifest["entrypoint"] == "runtime:postgres"
linear_profile = manifest["linear-memory-profile"]
assert linear_profile == {
    "id": "oliphaunt.wasix-postmaster.linear-memory.wasm32-max256m-u64-static4g-guard2g.v1",
    "address-width": "wasm32",
    "supported-host-pointer-width": "u64",
    "maximum-pages": 4096,
    "maximum-bytes": 268435456,
    "static-bound-pages": 65536,
    "static-offset-guard-bytes": 2147483648,
    "static-access-lowering": "wasmer-llvm-unchecked-reservation-and-guard-v1",
    "install-receipt-path": "share/postgresql/wasix-postmaster.linear-memory-profile.receipt.json",
    "install-receipt-sha256": hashlib.sha256(
        open(
            os.path.join(
                root,
                "share/postgresql/wasix-postmaster.linear-memory-profile.receipt.json",
            ),
            "rb",
        ).read()
    ).hexdigest(),
}
with open(os.path.join(root, "postmaster-executor.receipt"), encoding="utf-8") as stream:
    executor_receipt = dict(line.rstrip("\n").split("=", 1) for line in stream)
assert executor_receipt["schema"] == "oliphaunt.wasix-postmaster.postmaster-executor-build.v3"
assert executor_receipt["linear_memory_profile_id"] == linear_profile["id"]
assert executor_receipt["executor_role"] == "postmaster-product"
assert executor_receipt["executor_binary_sha256"] == manifest["executor-sha256"]
with open(side_module_policy, encoding="utf-8") as stream:
    side_modules = {
        line.split("\t", 1)[0]
        for line in stream
        if line.strip() and not line.startswith("#")
    }
assert len(manifest["artifacts"]) == len(side_modules) + 2
assert {
    item["module-path"]
    for item in manifest["artifacts"]
    if item["kind"] == "side-module"
} == side_modules
assert {tuple(item["exec-aliases"]) for item in manifest["artifacts"] if item["kind"] == "executable"} == {
    ("/bin/initdb",),
    ("/bin/postgres",),
}
for artifact in manifest["artifacts"]:
    assert "preinitialized-memory" not in artifact
with open(os.path.join(root, "payload.files"), encoding="utf-8") as stream:
    assert stream.readline().strip() == "schema=oliphaunt.wasix-postmaster.payload-files.v1"
    listed_payloads = set()
    for line in stream:
        digest, size, relative = line.rstrip("\n").split("\t")
        assert relative not in listed_payloads
        listed_payloads.add(relative)
        path = os.path.join(root, relative)
        assert os.path.getsize(path) == int(size)
        with open(path, "rb") as payload:
            assert hashlib.sha256(payload.read()).hexdigest() == digest
expected_payloads = set()
for current, dirs, files in os.walk(root):
    dirs.sort()
    files.sort()
    for name in files:
        relative = os.path.relpath(os.path.join(current, name), root)
        if relative != "payload.files":
            expected_payloads.add(relative)
assert listed_payloads == expected_payloads
assert not any(path.startswith(".") for path in listed_payloads)
PY

python3 - "$FAKE_WASMER_VALIDATION_LOG" <<'PY'
import json
import os
import sys

with open(sys.argv[1], encoding="utf-8") as stream:
    records = [json.loads(line) for line in stream]
assert [record["program"] for record in records] == ["postgres", "initdb"]
assert records[0]["arguments"] == ["--version"]
assert records[1]["arguments"] == [
    "-D",
    "/pgdata",
    "-A",
    "trust",
    "--no-locale",
    "--encoding=UTF8",
    "--no-instructions",
]
for record in records:
    guest_volumes = {}
    for volume in record["volumes"]:
        host, guest = volume.rsplit(":", 1)
        assert guest not in guest_volumes
        guest_volumes[guest] = host
    carrier_root = next(host for guest, host in guest_volumes.items() if guest == host)
    assert guest_volumes["/lib"] == os.path.join(carrier_root, "lib")
    assert guest_volumes["/share"] == os.path.join(carrier_root, "share")
    for guest in ("/pgdata", "/dev/shm"):
        assert not os.path.exists(guest_volumes[guest]), (guest, guest_volumes[guest])
PY

if find "$test_root" -maxdepth 1 -type d \
  \( -name '.carrier.tmp.*' -o -name '.carrier.validate.*' \) \
  -print -quit | grep -q .
then
  printf 'carrier builder left staging or validation state after success\n' >&2
  exit 1
fi

manifest_source_fingerprint="$(python3 - "$output/manifest.json" <<'PY'
import json
import sys
with open(sys.argv[1], encoding="utf-8") as stream:
    print(json.load(stream)["source-fingerprint"])
PY
)"
manifest_producer_recipe="$(python3 - "$output/manifest.json" <<'PY'
import json
import sys
with open(sys.argv[1], encoding="utf-8") as stream:
    print(json.load(stream)["producer-recipe-sha256"])
PY
)"
compiler_config="$(fresh_wasmer_compiler_cache_bucket \
  llvm aggressive "$FRESH_WASMER_ARTIFACT_ABI_VERSION")"
expected_producer_recipe="$(fresh_aot_producer_recipe_sha256 \
  "$output/wasmer-build.receipt" \
  "$output/postmaster-executor.receipt" \
  "$compiler_config" \
  "$target_triple" \
  "$manifest_source_fingerprint")"
[ "$manifest_producer_recipe" = "$expected_producer_recipe" ] || {
  printf 'manifest AOT producer recipe is not reproducible from packaged inputs\n' >&2
  exit 1
}
recipe_fixture="$test_root/producer-recipe-fixture"
mkdir -p "$recipe_fixture/bin" "$recipe_fixture/lib"
cp "$project_root/bin/precompile-wasix-core.sh" "$recipe_fixture/bin/"
cp "$project_root/bin/build-sealed-headless-carrier.sh" "$recipe_fixture/bin/"
cp "$project_root/lib/sealed-carrier.sh" "$recipe_fixture/lib/"
cp "$project_root/lib/verify-sealed-carrier.py" "$recipe_fixture/lib/"
cp "$project_root/lib/sealed_export_chain.py" "$recipe_fixture/lib/"
fixture_producer_recipe="$(FRESH_ROOT="$recipe_fixture" \
  fresh_aot_producer_recipe_sha256 \
    "$output/wasmer-build.receipt" \
    "$output/postmaster-executor.receipt" \
    "$compiler_config" \
    "$target_triple" \
    "$manifest_source_fingerprint")"
[ "$manifest_producer_recipe" = "$fixture_producer_recipe" ] || {
  printf 'AOT producer recipe depends on paths outside its declared inputs\n' >&2
  exit 1
}
printf '# verifier policy mutation\n' >>"$recipe_fixture/lib/verify-sealed-carrier.py"
[ "$manifest_producer_recipe" != "$(FRESH_ROOT="$recipe_fixture" \
  fresh_aot_producer_recipe_sha256 \
    "$output/wasmer-build.receipt" \
    "$output/postmaster-executor.receipt" \
    "$compiler_config" \
    "$target_triple" \
    "$manifest_source_fingerprint")" ] || {
  printf 'AOT producer recipe does not bind the carrier verifier policy\n' >&2
  exit 1
}
cp "$project_root/lib/verify-sealed-carrier.py" "$recipe_fixture/lib/"
printf '# export chain policy mutation\n' >>"$recipe_fixture/lib/sealed_export_chain.py"
[ "$manifest_producer_recipe" != "$(FRESH_ROOT="$recipe_fixture" \
  fresh_aot_producer_recipe_sha256 \
    "$output/wasmer-build.receipt" \
    "$output/postmaster-executor.receipt" \
    "$compiler_config" \
    "$target_triple" \
    "$manifest_source_fingerprint")" ] || {
  printf 'AOT producer recipe does not bind sealed export lineage policy\n' >&2
  exit 1
}
[ "$manifest_producer_recipe" != "$(fresh_manifest_value "$output/wasmer-build.receipt" build_recipe_sha256)" ] || {
  printf 'AOT producer recipe collapsed to the runtime build recipe\n' >&2
  exit 1
}
different_source_fingerprint="$(printf different-source | fresh_sha256_stream)"
[ "$manifest_producer_recipe" != "$(fresh_aot_producer_recipe_sha256 \
  "$output/wasmer-build.receipt" \
  "$output/postmaster-executor.receipt" \
  "$compiler_config" \
  "$target_triple" \
  "$different_source_fingerprint")" ] || {
  printf 'AOT producer recipe does not bind the guest source fingerprint\n' >&2
  exit 1
}
sed 's/^rustc_version=.*/rustc_version=alternate-test-rustc/' \
  "$output/wasmer-build.receipt" >"$test_root/alternate-wasmer-build.receipt"
[ "$manifest_producer_recipe" != "$(fresh_aot_producer_recipe_sha256 \
  "$test_root/alternate-wasmer-build.receipt" \
  "$output/postmaster-executor.receipt" \
  "$compiler_config" \
  "$target_triple" \
  "$manifest_source_fingerprint")" ] || {
  printf 'AOT producer recipe does not bind the canonical build receipt\n' >&2
  exit 1
}
[ "$manifest_producer_recipe" != "$(fresh_aot_producer_recipe_sha256 \
  "$output/wasmer-build.receipt" \
  "$output/postmaster-executor.receipt" \
  "${compiler_config}-different" \
  "$target_triple" \
  "$manifest_source_fingerprint")" ] || {
  printf 'AOT producer recipe does not bind the compiler configuration\n' >&2
  exit 1
}
[ "$manifest_producer_recipe" != "$(WASMER_STACK_SIZE=16777216 \
  fresh_aot_producer_recipe_sha256 \
    "$output/wasmer-build.receipt" \
    "$output/postmaster-executor.receipt" \
    "$compiler_config" \
    "$target_triple" \
    "$manifest_source_fingerprint")" ] || {
  printf 'AOT producer recipe does not bind the runtime stack size\n' >&2
  exit 1
}
if fresh_aot_producer_recipe_sha256 \
  "$output/wasmer-build.receipt" \
  "$output/postmaster-executor.receipt" \
  "$compiler_config" \
  different-target \
  "$manifest_source_fingerprint" >/dev/null 2>&1
then
  printf 'AOT producer recipe accepted a target inconsistent with its receipt\n' >&2
  exit 1
fi

if "$project_root/bin/build-sealed-headless-carrier.sh" \
  --output "$output" \
  --cache-bucket "$cache_bucket" >/dev/null 2>&1
then
  printf 'carrier builder replaced an existing output unexpectedly\n' >&2
  exit 1
fi

"$project_root/bin/verify-sealed-headless-carrier.sh" "$output" >/dev/null
[ "$(python3 "$project_root/lib/verify-sealed-carrier.py" executor-selection "$output")" = \
  $'postmaster-product\tpostmaster-executor.receipt\t'"$(fresh_wasmer_bin_hash "$output/postmaster-executor.receipt")"$'\t'"$(fresh_wasmer_bin_hash "$output/bin/wasmer-headless")" ]

# The implicit publication path is derived from the finished exact payload
# inventory, not merely from the runtime ABI.  This keeps distinct PostgreSQL
# build profiles from racing for or aliasing one default directory.
default_build_log="$test_root/default-build.log"
"$project_root/bin/build-sealed-headless-carrier.sh" \
  --cache-bucket "$cache_bucket" >"$default_build_log"
default_output="$(sed -n 's/^built sealed headless WASIX PostgreSQL carrier: //p' "$default_build_log")"
[ -n "$default_output" ] && [ -d "$default_output" ] || {
  printf 'default carrier output was not published\n' >&2
  exit 1
}
default_payload_sha256="$(fresh_wasmer_bin_hash "$default_output/payload.files")"
expected_default_output="$FRESH_WORK_ROOT/carriers/wasix-postmaster-$POSTGRES_VERSION-${runtime_abi_id:0:16}-$default_payload_sha256"
[ "$default_output" = "$expected_default_output" ] || {
  printf 'default carrier output is not content-addressed: expected %s, got %s\n' \
    "$expected_default_output" "$default_output" >&2
  exit 1
}
grep -Fx "payload inventory SHA-256: $default_payload_sha256" "$default_build_log" >/dev/null
"$project_root/bin/verify-sealed-headless-carrier.sh" "$default_output" >/dev/null
[ "$(fresh_select_current_sealed_carrier)" = "$default_output" ] || {
  printf 'current carrier selection did not resolve the receipt-bound output\n' >&2
  exit 1
}
if "$project_root/bin/build-sealed-headless-carrier.sh" \
  --cache-bucket "$cache_bucket" >/dev/null 2>&1
then
  printf 'default carrier builder replaced an existing content identity\n' >&2
  exit 1
fi

expect_verifier_failure() {
  local label="$1"
  local carrier="$2"

  if "$project_root/bin/verify-sealed-headless-carrier.sh" "$carrier" \
    >"$test_root/$label.stdout" 2>"$test_root/$label.stderr"
  then
    printf 'sealed carrier verifier accepted %s\n' "$label" >&2
    exit 1
  fi
}

reindex_carrier() {
  local carrier="$1"

  chmod u+w "$carrier/payload.files"
  python3 - "$carrier" <<'PY'
import hashlib
import os
import stat
import sys

root = os.path.realpath(sys.argv[1])
inventory = os.path.join(root, "payload.files")
rows = []
for current, dirs, files in os.walk(root, followlinks=False):
    dirs.sort()
    files.sort()
    for name in files:
        path = os.path.join(current, name)
        if os.path.realpath(path) == inventory:
            continue
        info = os.lstat(path)
        if not stat.S_ISREG(info.st_mode):
            continue
        digest = hashlib.sha256()
        with open(path, "rb", buffering=0) as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        rows.append((os.path.relpath(path, root), info.st_size, digest.hexdigest()))
with open(inventory, "w", encoding="utf-8", newline="\n") as output:
    output.write("schema=oliphaunt.wasix-postmaster.payload-files.v1\n")
    for relative, size, digest in sorted(rows):
        output.write(f"{digest}\t{size}\t{relative}\n")
PY
  chmod 0444 "$carrier/payload.files"
}

legacy_manifest="$test_root/verifier-legacy-manifest-v4"
cp -a "$output" "$legacy_manifest"
chmod u+w "$legacy_manifest/manifest.json"
python3 - "$legacy_manifest/manifest.json" <<'PY'
import json
import sys

path = sys.argv[1]
with open(path, encoding="utf-8") as stream:
    manifest = json.load(stream)
manifest["schema"] = "oliphaunt.wasix-postmaster.sealed-aot.v4"
manifest["format-version"] = 5
with open(path, "w", encoding="utf-8", newline="\n") as stream:
    json.dump(manifest, stream, ensure_ascii=False, indent=2)
    stream.write("\n")
PY
chmod 0444 "$legacy_manifest/manifest.json"
reindex_carrier "$legacy_manifest"
expect_verifier_failure legacy-manifest-v4 "$legacy_manifest"

legacy_guest="$test_root/verifier-legacy-guest-v4"
cp -a "$output" "$legacy_guest"
chmod u+w "$legacy_guest/guest-build.receipt" "$legacy_guest/manifest.json"
sed 's/^schema=oliphaunt.wasix-postmaster.guest-build.v5$/schema=oliphaunt.wasix-postmaster.guest-build.v4/' \
  "$output/guest-build.receipt" >"$legacy_guest/guest-build.receipt"
python3 - "$legacy_guest" <<'PY'
import hashlib
import json
import os
import sys

root = sys.argv[1]
guest = os.path.join(root, "guest-build.receipt")
manifest_path = os.path.join(root, "manifest.json")
with open(guest, "rb") as stream:
    digest = hashlib.sha256(stream.read()).hexdigest()
with open(manifest_path, encoding="utf-8") as stream:
    manifest = json.load(stream)
manifest["guest-build-recipe-sha256"] = digest
with open(manifest_path, "w", encoding="utf-8", newline="\n") as stream:
    json.dump(manifest, stream, ensure_ascii=False, indent=2)
    stream.write("\n")
PY
chmod 0444 "$legacy_guest/guest-build.receipt" "$legacy_guest/manifest.json"
reindex_carrier "$legacy_guest"
expect_verifier_failure legacy-guest-v4 "$legacy_guest"

tampered="$test_root/verifier-tampered"
cp -a "$output" "$tampered"
chmod u+w "$tampered/bin/postgres"
printf 'tampered\n' >>"$tampered/bin/postgres"
chmod 0555 "$tampered/bin/postgres"
expect_verifier_failure tampered-payload "$tampered"

missing="$test_root/verifier-missing"
cp -a "$output" "$missing"
chmod u+w "$missing/share/postgresql"
mv "$missing/share/postgresql/postgresql.conf.sample" \
  "$test_root/missing-postgresql.conf.sample"
chmod 0555 "$missing/share/postgresql"
expect_verifier_failure missing-payload "$missing"

unexpected="$test_root/verifier-unexpected"
cp -a "$output" "$unexpected"
chmod u+w "$unexpected"
printf 'unexpected\n' >"$unexpected/unexpected.txt"
chmod 0444 "$unexpected/unexpected.txt"
chmod 0555 "$unexpected"
expect_verifier_failure unexpected-payload "$unexpected"

symlinked="$test_root/verifier-symlink"
cp -a "$output" "$symlinked"
chmod u+w "$symlinked"
ln -s bin/postgres "$symlinked/postgres-link"
chmod 0555 "$symlinked"
expect_verifier_failure symlink-entry "$symlinked"

special="$test_root/verifier-special"
cp -a "$output" "$special"
chmod u+w "$special"
mkfifo "$special/unexpected.fifo"
chmod 0555 "$special"
expect_verifier_failure special-entry "$special"

empty_directory="$test_root/verifier-empty-directory"
cp -a "$output" "$empty_directory"
chmod u+w "$empty_directory"
mkdir "$empty_directory/unrepresented-directory"
chmod 0555 "$empty_directory/unrepresented-directory" "$empty_directory"
expect_verifier_failure unrepresented-directory "$empty_directory"

writable_file="$test_root/verifier-writable-file"
cp -a "$output" "$writable_file"
chmod u+w "$writable_file/bin/postgres"
expect_verifier_failure writable-file "$writable_file"

writable_directory="$test_root/verifier-writable-directory"
cp -a "$output" "$writable_directory"
chmod u+w "$writable_directory/aot"
expect_verifier_failure writable-directory "$writable_directory"

unsafe_inventory="$test_root/verifier-unsafe-inventory"
cp -a "$output" "$unsafe_inventory"
chmod u+w "$unsafe_inventory/payload.files"
printf '%064d\t0\t../outside\n' 0 >>"$unsafe_inventory/payload.files"
chmod 0444 "$unsafe_inventory/payload.files"
expect_verifier_failure unsafe-inventory-path "$unsafe_inventory"

wrong_executor="$test_root/verifier-wrong-executor"
cp -a "$output" "$wrong_executor"
chmod u+w "$wrong_executor/bin/wasmer-headless"
printf 'different executor\n' >>"$wrong_executor/bin/wasmer-headless"
chmod 0555 "$wrong_executor/bin/wasmer-headless"
reindex_carrier "$wrong_executor"
expect_verifier_failure headless-receipt-identity "$wrong_executor"

wrong_manifest="$test_root/verifier-wrong-manifest"
cp -a "$output" "$wrong_manifest"
chmod u+w "$wrong_manifest/manifest.json"
python3 - "$wrong_manifest/manifest.json" <<'PY'
import json
import sys

path = sys.argv[1]
with open(path, encoding="utf-8") as stream:
    manifest = json.load(stream)
manifest["executor-sha256"] = "0" * 64
with open(path, "w", encoding="utf-8", newline="\n") as stream:
    json.dump(manifest, stream, ensure_ascii=False, indent=2)
    stream.write("\n")
PY
chmod 0444 "$wrong_manifest/manifest.json"
reindex_carrier "$wrong_manifest"
expect_verifier_failure manifest-executor-identity "$wrong_manifest"

wrong_receipt="$test_root/verifier-wrong-receipt"
cp -a "$output" "$wrong_receipt"
chmod u+w "$wrong_receipt/wasmer-build.receipt"
sed 's/^wasmer_headless_binary_sha256=.*/wasmer_headless_binary_sha256=0000000000000000000000000000000000000000000000000000000000000000/' \
  "$output/wasmer-build.receipt" >"$wrong_receipt/wasmer-build.receipt"
chmod 0444 "$wrong_receipt/wasmer-build.receipt"
reindex_carrier "$wrong_receipt"
expect_verifier_failure receipt-headless-identity "$wrong_receipt"

wrong_product_receipt="$test_root/verifier-wrong-product-receipt"
cp -a "$output" "$wrong_product_receipt"
chmod u+w "$wrong_product_receipt/postmaster-executor.receipt"
sed 's/^executor_binary_sha256=.*/executor_binary_sha256=0000000000000000000000000000000000000000000000000000000000000000/' \
  "$output/postmaster-executor.receipt" \
  >"$wrong_product_receipt/postmaster-executor.receipt"
chmod 0444 "$wrong_product_receipt/postmaster-executor.receipt"
reindex_carrier "$wrong_product_receipt"
expect_verifier_failure product-receipt-executor-identity "$wrong_product_receipt"

missing_product_receipt="$test_root/verifier-missing-product-receipt"
cp -a "$output" "$missing_product_receipt"
chmod u+w "$missing_product_receipt"
mv "$missing_product_receipt/postmaster-executor.receipt" \
  "$test_root/missing-postmaster-executor.receipt"
chmod 0555 "$missing_product_receipt"
reindex_carrier "$missing_product_receipt"
expect_verifier_failure missing-product-role-sidecar "$missing_product_receipt"

printf 'sealed headless carrier packaging tests passed\n'
