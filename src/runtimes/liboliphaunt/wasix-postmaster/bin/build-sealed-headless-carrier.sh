#!/usr/bin/env bash

set -euo pipefail

wasix_core_profile_explicit=0
if [ "${WASIX_CORE_PROFILE+x}" = x ] && [ -n "$WASIX_CORE_PROFILE" ]; then
  wasix_core_profile_explicit=1
fi
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"
source "$FRESH_ROOT/lib/sealed-carrier.sh"

usage() {
  cat <<'EOF'
Usage: build-sealed-headless-carrier.sh [options]

Build an atomic, compiler-free WASIX PostgreSQL carrier from an already
validated runtime receipt and precompiled AOT cache.

Options:
  --output DIR              Final carrier directory (must not already exist).
                            By default, publish below the work-root carriers
                            directory under the exact payload-inventory digest.
  --install-dir DIR         WASIX PostgreSQL prefix (default: WASIX_INSTALL_DIR)
  --postmaster-compiler FILE
                            Receipt-bound bounded-memory LLVM producer
  --postmaster-executor FILE
                            Product-specific sealed-postmaster executor
  --postmaster-executor-receipt FILE
                            Exact product executor build receipt
  --cache-bucket DIR        Exact precompiled AOT bucket
  --receipt FILE            Canonical Wasmer build receipt
  -h, --help                Show this help

The builder never compiles implicitly and never accepts host-native CPU AOT.
EOF
}

fail() {
  printf 'sealed carrier build: %s\n' "$*" >&2
  exit 2
}

output=""
install_dir="$WASIX_INSTALL_DIR"
postmaster_compiler="$FRESH_POSTMASTER_COMPILER_BIN"
postmaster_executor="$FRESH_POSTMASTER_EXECUTOR_BIN"
postmaster_executor_receipt="$FRESH_POSTMASTER_EXECUTOR_BUILD_RECEIPT"
receipt="${WASMER_BUILD_RECEIPT:-$FRESH_WASMER_BUILD_RECEIPT}"
cache_bucket=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --output|--install-dir|--postmaster-compiler|--postmaster-executor|--postmaster-executor-receipt|--cache-bucket|--receipt)
      option="$1"
      shift
      [ "$#" -gt 0 ] || fail "$option requires a value"
      case "$option" in
        --output) output="$1" ;;
        --install-dir) install_dir="$1" ;;
        --postmaster-compiler) postmaster_compiler="$1" ;;
        --postmaster-executor) postmaster_executor="$1" ;;
        --postmaster-executor-receipt) postmaster_executor_receipt="$1" ;;
        --cache-bucket) cache_bucket="$1" ;;
        --receipt) receipt="$1" ;;
      esac
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
  shift
done

selected_executor="$postmaster_executor"

fresh_require_command python3
fresh_require_command cp
fresh_require_command find
fresh_require_command flock
fresh_require_command sort

[ "$wasix_core_profile_explicit" -eq 1 ] || {
  fail 'WASIX_CORE_PROFILE must be explicit for a sealed qualification carrier'
}
core_profile="$(fresh_normalize_wasix_core_profile "$WASIX_CORE_PROFILE")" || exit
case "$core_profile" in
  release-o3) ;;
  *)
    fail "sealed qualification carriers require a release-o3 guest with a qualified final fence inventory, got: $core_profile"
    ;;
esac

fresh_require_patched_postmaster_compiler \
  "$postmaster_compiler" \
  "$postmaster_executor_receipt" \
  "$receipt" \
  "$postmaster_executor"
fresh_require_patched_postmaster_executor \
  "$selected_executor" "$postmaster_executor_receipt" "$receipt"

runtime_abi_id="$(fresh_manifest_value "$receipt" runtime_abi_id)"
output_is_explicit=1
if [ -n "$output" ]; then
  case "$output" in
    */.|*/..|.|..|/) fail "unsafe output directory: $output" ;;
  esac
  output_parent_input="$(dirname "$output")"
  output_name="$(basename "$output")"
  [ -n "$output_name" ] || fail "output directory has no basename: $output"
  case "$output_name" in
    *$'\n'*|*$'\r'*|*$'\t'*) fail "output directory basename contains a control delimiter" ;;
  esac
else
  # The complete payload identity is unavailable until manifest.json and the
  # exact inventory have been generated.  Keep unpublished construction in a
  # generic, private staging name and resolve the public path immediately
  # before the atomic rename.  This prevents two PostgreSQL build profiles
  # with the same runtime ABI from colliding at the old default path.
  output_is_explicit=0
  output_parent_input="$FRESH_WORK_ROOT/carriers"
  output_name="wasix-postmaster-$POSTGRES_VERSION-${runtime_abi_id:0:16}-unpublished"
fi
mkdir -p "$output_parent_input"
output_parent="$(cd "$output_parent_input" && pwd -P)"
if [ "$output_is_explicit" -eq 1 ]; then
  output="$output_parent/$output_name"
  [ ! -e "$output" ] && [ ! -L "$output" ] || fail "output already exists: $output"
fi

[ -d "$install_dir" ] && [ ! -L "$install_dir" ] || fail "missing regular WASIX install prefix: $install_dir"
install_dir="$(cd "$install_dir" && pwd -P)"
guest_build_receipt_source="$install_dir/guest-build.receipt"
[ -f "$guest_build_receipt_source" ] && [ ! -L "$guest_build_receipt_source" ] || {
  fail "missing regular guest build receipt: $guest_build_receipt_source"
}
python3 - "$guest_build_receipt_source" "$core_profile" "$POSTGRES_TAG" \
  "$POSTGRES_VERSION" "$WASIXCC_SYSROOT_VARIANT" <<'PY'
import re
import sys

path, expected_profile, postgres_tag, postgres_version, sysroot_variant = sys.argv[1:]
keys = (
    "schema",
    "core_profile",
    "guest_source_signature_sha256",
    "docker_image_id",
    "installed_closure_sha256",
    "child_backend",
    "effective_cflags",
    "effective_ldflags",
    "effective_wasm_opt",
    "effective_wasm_opt_flags",
    "effective_wasm_opt_suppress_default",
    "atomic_fence_total",
    "atomic_fence_set_latch",
    "atomic_fence_reset_latch",
    "atomic_fence_wait_event_set_wait",
    "latch_state_contract",
    "final_wasm_concurrency_receipt_sha256",
    "linear_memory_profile_id",
    "linear_memory_install_receipt_sha256",
    "postgres_tag",
    "postgres_version",
    "sysroot_variant",
)
with open(path, encoding="utf-8", newline="") as stream:
    text = stream.read()
if not text.endswith("\n") or "\r" in text:
    raise SystemExit("guest build receipt is not canonical newline text")
lines = text.splitlines()
if len(lines) != len(keys):
    raise SystemExit("guest build receipt field count differs")
values = {}
for expected, line in zip(keys, lines, strict=True):
    if "=" not in line:
        raise SystemExit(f"guest build receipt field has no separator: {expected}")
    key, value = line.split("=", 1)
    if key != expected or not value:
        raise SystemExit(f"guest build receipt field differs: {expected}")
    values[key] = value
if values["schema"] != "oliphaunt.wasix-postmaster.guest-build.v5":
    raise SystemExit("guest build receipt schema differs")
if values["core_profile"] != expected_profile:
    raise SystemExit("guest build receipt profile differs from explicit carrier profile")
if re.fullmatch(r"[0-9a-f]{64}", values["guest_source_signature_sha256"]) is None:
    raise SystemExit("guest build source signature is not a SHA-256")
if re.fullmatch(r"sha256:[0-9a-f]{64}", values["docker_image_id"]) is None:
    raise SystemExit("guest build Docker image ID is not immutable")
if re.fullmatch(r"[0-9a-f]{64}", values["installed_closure_sha256"]) is None:
    raise SystemExit("guest build installed closure identity is not a SHA-256")
if values["child_backend"] != "exec":
    raise SystemExit("sealed postmaster carrier requires the exec child backend")
if values["effective_wasm_opt"] not in {"yes", "no"}:
    raise SystemExit("guest build receipt wasm-opt mode differs")
if values["effective_wasm_opt_suppress_default"] != "yes":
    raise SystemExit("guest build receipt must suppress implicit wasm-opt defaults")
expected_fences = {
    "atomic_fence_set_latch": "2",
    "atomic_fence_reset_latch": "1",
    "atomic_fence_wait_event_set_wait": "1",
}
for key, expected in expected_fences.items():
    if values[key] != expected:
        raise SystemExit(f"guest build receipt concurrency fence contract differs: {key}")
if re.fullmatch(r"[1-9][0-9]*", values["atomic_fence_total"]) is None:
    raise SystemExit("guest build receipt atomic fence total is not canonical")
if values["latch_state_contract"] != "packed-atomic-v1":
    raise SystemExit("guest build receipt latch-state contract differs")
if re.fullmatch(
    r"[0-9a-f]{64}", values["final_wasm_concurrency_receipt_sha256"]
) is None:
    raise SystemExit("guest build final Wasm concurrency receipt identity differs")
if values["linear_memory_profile_id"] != "oliphaunt.wasix-postmaster.linear-memory.wasm32-max256m-u64-static4g-guard2g.v1":
    raise SystemExit("guest build linear-memory profile differs")
if re.fullmatch(
    r"[0-9a-f]{64}", values["linear_memory_install_receipt_sha256"]
) is None:
    raise SystemExit("guest build linear-memory install receipt identity differs")
if values["postgres_tag"] != postgres_tag or values["postgres_version"] != postgres_version:
    raise SystemExit("guest build receipt PostgreSQL version differs")
if values["sysroot_variant"] != sysroot_variant:
    raise SystemExit("guest build receipt sysroot variant differs")
PY
final_wasm_concurrency_receipt_source="$install_dir/share/postgresql/wasix-postmaster.final-wasm-concurrency.receipt"
[ -f "$final_wasm_concurrency_receipt_source" ] && \
  [ ! -L "$final_wasm_concurrency_receipt_source" ] || {
  fail "missing regular final Wasm concurrency receipt: $final_wasm_concurrency_receipt_source"
}
expected_final_wasm_concurrency_receipt_sha256="$(
  fresh_manifest_value "$guest_build_receipt_source" \
    final_wasm_concurrency_receipt_sha256
)"
actual_final_wasm_concurrency_receipt_sha256="$(
  fresh_wasmer_bin_hash "$final_wasm_concurrency_receipt_source"
)"
[ "$actual_final_wasm_concurrency_receipt_sha256" = \
  "$expected_final_wasm_concurrency_receipt_sha256" ] || {
  fail 'final Wasm concurrency receipt differs from guest build receipt'
}
linear_memory_receipt_relative="share/postgresql/wasix-postmaster.linear-memory-profile.receipt.json"
linear_memory_receipt_source="$install_dir/$linear_memory_receipt_relative"
[ -f "$linear_memory_receipt_source" ] && [ ! -L "$linear_memory_receipt_source" ] || {
  fail "missing regular linear-memory install receipt: $linear_memory_receipt_source"
}
linear_memory_install_receipt_sha256="$(fresh_wasmer_bin_hash "$linear_memory_receipt_source")"
fresh_is_sha256 "$linear_memory_install_receipt_sha256" ||
  fail 'linear-memory install receipt identity is invalid'
[ "$(fresh_manifest_value "$guest_build_receipt_source" linear_memory_profile_id)" = \
  "$FRESH_LINEAR_MEMORY_PROFILE_ID" ] || {
  fail 'guest build receipt linear-memory profile differs'
}
[ "$(fresh_manifest_value "$guest_build_receipt_source" linear_memory_install_receipt_sha256)" = \
  "$linear_memory_install_receipt_sha256" ] || {
  fail 'linear-memory install receipt differs from guest build receipt'
}
expected_atomic_fence_total="$(
  fresh_manifest_value "$guest_build_receipt_source" atomic_fence_total
)"
python3 "$FRESH_ROOT/runtime/bin/verify-postmaster-concurrency-contract.py" \
  --expected-total "$expected_atomic_fence_total" \
  --latch-state-contract packed-atomic-v1 \
  --verified-receipt "$final_wasm_concurrency_receipt_source" \
  --receipt-only \
  "$install_dir/bin/postgres" >/dev/null || {
  fail 'final Wasm concurrency receipt contract validation failed'
}
guest_build_recipe_sha256="$(fresh_wasmer_bin_hash "$guest_build_receipt_source")"
fresh_is_sha256 "$guest_build_recipe_sha256" || fail 'invalid guest build recipe identity'
guest_installed_closure_sha256="$(
  fresh_manifest_value "$guest_build_receipt_source" installed_closure_sha256
)"
fresh_is_sha256 "$guest_installed_closure_sha256" || {
  fail 'invalid guest installed closure identity'
}
actual_guest_installed_closure_sha256="$(
  python3 "$FRESH_ROOT/lib/guest_build_provenance.py" identity "$install_dir"
)" || exit
[ "$actual_guest_installed_closure_sha256" = \
  "$guest_installed_closure_sha256" ] || {
  fail 'guest install bytes differ from their build receipt'
}
share_source="$install_dir/share/postgresql"
[ -d "$share_source" ] && [ ! -L "$share_source" ] || fail "missing PostgreSQL support tree: $share_source"

compiler="$(fresh_wasmer_compiler)"
llvm_opt_level=aggressive
runtime_stack_size="${WASMER_STACK_SIZE:-33554432}"
case "$runtime_stack_size" in
  ''|*[!0-9]*) fail "WASMER_STACK_SIZE must be a positive integer" ;;
esac
[ "$runtime_stack_size" -gt 0 ] || fail "WASMER_STACK_SIZE must be greater than zero"
compiler_config="$(fresh_wasmer_compiler_cache_bucket \
  "$compiler" "$llvm_opt_level" "$FRESH_WASMER_ARTIFACT_ABI_VERSION")"
[ -z "${FRESH_PINNED_WASMER_CACHE_DIR:-}" ] || {
  fail "sealed product carriers refuse pinned or foreign AOT cache roots: $FRESH_PINNED_WASMER_CACHE_DIR"
}
expected_cache_bucket="$(fresh_wasmer_cache_dir "$postmaster_compiler")/compiled/$compiler_config"
if [ -z "$cache_bucket" ]; then
  cache_bucket="$expected_cache_bucket"
fi
[ -d "$cache_bucket" ] && [ ! -L "$cache_bucket" ] || fail "missing regular AOT cache bucket: $cache_bucket"
cache_bucket="$(cd "$cache_bucket" && pwd -P)"
[ -d "$expected_cache_bucket" ] && [ ! -L "$expected_cache_bucket" ] || {
  fail "missing receipt-bound AOT cache bucket: $expected_cache_bucket"
}
expected_cache_bucket="$(cd "$expected_cache_bucket" && pwd -P)"
[ "$cache_bucket" = "$expected_cache_bucket" ] || {
  fail "AOT cache bucket is not bound to the selected producer: expected $expected_cache_bucket, got $cache_bucket"
}

side_module_policy="$FRESH_ROOT/runtime/policies/sealed-side-modules.v1.tsv"
[ -f "$side_module_policy" ] && [ ! -L "$side_module_policy" ] || {
  fail "missing regular sealed side-module policy: $side_module_policy"
}

required_modules=(
  bin/initdb
  bin/postgres
)
while IFS=$'\t' read -r relative aliases abi_policy extra; do
  case "$relative" in
    ""|'#'*) continue ;;
  esac
  [ -z "${extra:-}" ] && [ -n "${aliases:-}" ] && [ -n "${abi_policy:-}" ] || {
    fail "invalid sealed side-module policy row: $relative"
  }
  case "$relative" in
    lib/*.so|lib/*.so.*|lib/postgresql/*.so) ;;
    *) fail "invalid sealed side-module path: $relative" ;;
  esac
  required_modules+=("$relative")
done <"$side_module_policy"
[ "${#required_modules[@]}" -gt 2 ] || fail "sealed side-module policy is empty"
for relative in "${required_modules[@]}"; do
  source_path="$install_dir/$relative"
  [ -f "$source_path" ] && [ ! -L "$source_path" ] || fail "missing regular runtime-closure module: $source_path"
done
if find "$share_source" -type l -print -quit | grep -q .; then
  fail "PostgreSQL support tree contains a symbolic link: $share_source"
fi
if find "$share_source" ! -type d ! -type f -print -quit | grep -q .; then
  fail "PostgreSQL support tree contains a special file: $share_source"
fi

staging="$(mktemp -d "$output_parent/.${output_name}.tmp.XXXXXX")"
validation_root=""
chmod 0755 "$staging"
cleanup_validation_root() {
  if [ -n "${validation_root:-}" ] && [ -d "$validation_root" ]; then
    chmod -R u+w "$validation_root" 2>/dev/null || true
    rm -rf -- "$validation_root"
  fi
  validation_root=""
}
cleanup() {
  cleanup_validation_root
  if [ -n "${staging:-}" ] && [ -d "$staging" ]; then
    chmod -R u+w "$staging" 2>/dev/null || true
    rm -rf -- "$staging"
  fi
}
handle_signal() {
  local status="$1"
  trap - EXIT HUP INT TERM
  cleanup
  exit "$status"
}
trap cleanup EXIT
trap 'handle_signal 129' HUP
trap 'handle_signal 130' INT
trap 'handle_signal 143' TERM

mkdir -p \
  "$staging/bin" \
  "$staging/lib/postgresql" \
  "$staging/share/postgresql" \
  "$staging/aot"
cp -p "$selected_executor" "$staging/bin/wasmer-headless"
chmod 0555 "$staging/bin/wasmer-headless"
cp -pR "$share_source/." "$staging/share/postgresql/"

artifact_rows="$staging/.artifact-rows.tsv"
: >"$artifact_rows"

copy_artifact() {
  local name="$1"
  local kind="$2"
  local relative="$3"
  local alias="$4"
  local module_source="$install_dir/$relative"
  local module_sha256
  local module_hash
  local artifact_source
  local artifact_relative
  local artifact_sha256
  local module_size
  local artifact_size

  module_sha256="$(fresh_wasmer_bin_hash "$module_source")"
  fresh_is_sha256 "$module_sha256" || fail "invalid module digest: $module_source"
  module_hash="${module_sha256^^}"
  artifact_source="$cache_bucket/$module_hash.bin"
  [ -f "$artifact_source" ] && [ ! -L "$artifact_source" ] && [ -s "$artifact_source" ] || {
    fail "missing regular precompiled AOT artifact for $relative: $artifact_source"
  }

  mkdir -p "$staging/$(dirname "$relative")"
  cp -p "$module_source" "$staging/$relative"
  artifact_relative="aot/$module_hash.bin"
  cp -p "$artifact_source" "$staging/$artifact_relative"
  chmod 0444 "$staging/$artifact_relative"
  "$postmaster_compiler" verify-aot \
    "$staging/$relative" "$staging/$artifact_relative" >/dev/null || {
    fail "AOT artifact failed product compiler admission: $relative"
  }

  artifact_sha256="$(fresh_wasmer_bin_hash "$staging/$artifact_relative")"
  module_size="$(wc -c <"$staging/$relative" | tr -d '[:space:]')"
  artifact_size="$(wc -c <"$staging/$artifact_relative" | tr -d '[:space:]')"
  [ "$module_sha256" = "$(fresh_wasmer_bin_hash "$staging/$relative")" ] || {
    fail "module changed while copying: $module_source"
  }
  [ "$artifact_sha256" = "$(fresh_wasmer_bin_hash "$artifact_source")" ] || {
    fail "AOT artifact changed while copying: $artifact_source"
  }

  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$name" "$kind" "$artifact_relative" "$relative" "$artifact_sha256" \
    "$artifact_size" "$module_sha256" "$module_size" "$alias" >>"$artifact_rows"
}

copy_artifact runtime:initdb executable bin/initdb /bin/initdb
copy_artifact runtime:postgres executable bin/postgres /bin/postgres
while IFS=$'\t' read -r relative aliases abi_policy extra; do
  case "$relative" in
    ""|'#'*) continue ;;
  esac
  artifact_name="runtime:${relative##*/}"
  copy_artifact "$artifact_name" side-module "$relative" ""

  # Dynamic-loader aliases are policy, not ad-hoc carrier knowledge. Keep each
  # alias as a regular byte-identical file because sealed paths reject symlinks.
  if [ "$aliases" != - ]; then
    old_ifs="$IFS"
    IFS=','
    for alias_relative in $aliases; do
      IFS="$old_ifs"
      case "$alias_relative" in
        lib/*.so|lib/*.so.*|lib/postgresql/*.so) ;;
        *) fail "invalid sealed side-module alias: $alias_relative" ;;
      esac
      [ ! -e "$staging/$alias_relative" ] || {
        fail "duplicate sealed side-module alias: $alias_relative"
      }
      mkdir -p "$staging/$(dirname "$alias_relative")"
      cp -p "$staging/$relative" "$staging/$alias_relative"
      IFS=','
    done
    IFS="$old_ifs"
  fi
done <"$side_module_policy"

if find "$staging" -type l -print -quit | grep -q .; then
  fail "staged carrier contains a symbolic link"
fi
if find "$staging" ! -type d ! -type f -print -quit | grep -q .; then
  fail "staged carrier contains a special file"
fi

sealed_receipt="$staging/wasmer-build.receipt"
cp -p "$receipt" "$sealed_receipt"
chmod 0444 "$sealed_receipt"
sealed_postmaster_executor_receipt="$staging/postmaster-executor.receipt"
cp -p "$postmaster_executor_receipt" "$sealed_postmaster_executor_receipt"
chmod 0444 "$sealed_postmaster_executor_receipt"
sealed_product_build_receipt="$sealed_postmaster_executor_receipt"
guest_build_receipt="$staging/guest-build.receipt"
cp -p "$guest_build_receipt_source" "$guest_build_receipt"
chmod 0444 "$guest_build_receipt"
[ "$(fresh_wasmer_bin_hash "$guest_build_receipt")" = \
  "$guest_build_recipe_sha256" ] || {
  fail 'guest build receipt changed while packaging the carrier'
}
staged_guest_installed_closure_sha256="$(
  python3 "$FRESH_ROOT/lib/guest_build_provenance.py" identity "$staging"
)" || exit
[ "$staged_guest_installed_closure_sha256" = \
  "$guest_installed_closure_sha256" ] || {
  fail 'staged guest bytes differ from their build receipt'
}
actual_guest_installed_closure_sha256="$(
  python3 "$FRESH_ROOT/lib/guest_build_provenance.py" identity "$install_dir"
)" || exit
[ "$actual_guest_installed_closure_sha256" = \
  "$guest_installed_closure_sha256" ] || {
  fail 'guest install changed while the carrier was staged'
}

# From this point onward, derive every manifest identity from the immutable
# carrier snapshot, not from a mutable external pathname. Revalidating both
# binaries against that snapshot also closes the receipt/executor copy window.
fresh_require_patched_postmaster_compiler \
  "$postmaster_compiler" \
  "$sealed_product_build_receipt" \
  "$sealed_receipt" \
  "$postmaster_executor"
fresh_require_patched_postmaster_executor \
  "$staging/bin/wasmer-headless" \
  "$sealed_postmaster_executor_receipt" \
  "$sealed_receipt"
snapshot_runtime_abi_id="$(fresh_manifest_value "$sealed_receipt" runtime_abi_id)"
[ "$snapshot_runtime_abi_id" = "$runtime_abi_id" ] || {
  fail "runtime ABI changed while snapshotting the build receipt"
}
receipt="$sealed_receipt"

source_fingerprint="$(python3 - "$staging" <<'PY'
import hashlib
import os
import stat
import sys

root = os.path.realpath(sys.argv[1])
hasher = hashlib.sha256()
for subtree in ("bin", "lib", "share"):
    for current, dirs, files in os.walk(os.path.join(root, subtree), followlinks=False):
        dirs.sort()
        files.sort()
        for name in files:
            path = os.path.join(current, name)
            info = os.lstat(path)
            if not stat.S_ISREG(info.st_mode):
                raise SystemExit(f"non-regular carrier input: {path}")
            relative = os.path.relpath(path, root)
            if relative == "bin/wasmer-headless":
                continue
            digest = hashlib.sha256()
            with open(path, "rb", buffering=0) as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(chunk)
            for value in (relative, str(info.st_size), digest.hexdigest()):
                encoded = value.encode("utf-8")
                hasher.update(len(encoded).to_bytes(8, "big"))
                hasher.update(encoded)
print(hasher.hexdigest())
PY
)"
fresh_is_sha256 "$source_fingerprint" || fail "failed to compute PostgreSQL carrier fingerprint"

executor_sha256="$(fresh_wasmer_bin_hash "$staging/bin/wasmer-headless")"
executor_size="$(wc -c <"$staging/bin/wasmer-headless" | tr -d '[:space:]')"
target_triple="$(fresh_manifest_value "$receipt" rustc_host)"
host_abi="$(fresh_manifest_value "$receipt" host_abi)"
wasmer_source_commit="$(fresh_manifest_value "$receipt" wasmer_source_commit)"
wasmer_patch_sha256="$(fresh_manifest_value "$receipt" wasmer_patch_sha256)"
wasmer_cargo_lock_sha256="$(fresh_manifest_value "$receipt" wasmer_cargo_lock_sha256)"
producer_recipe_sha256="$(fresh_aot_producer_recipe_sha256 \
  "$receipt" "$sealed_product_build_receipt" "$compiler_config" \
  "$target_triple" "$source_fingerprint")"
fresh_is_sha256 "$producer_recipe_sha256" || fail "failed to compute AOT producer recipe identity"

write_sealed_manifest() {
  local output_path="$1"

  python3 - \
    "$artifact_rows" \
    "$staging" \
    "$output_path" \
    "$source_fingerprint" \
    "$core_profile" \
    "$guest_build_recipe_sha256" \
    "$target_triple" \
    "$host_abi" \
    "$compiler_config" \
    "$wasmer_source_commit" \
    "$wasmer_patch_sha256" \
    "$wasmer_cargo_lock_sha256" \
    "$runtime_abi_id" \
    "$producer_recipe_sha256" \
    "$executor_sha256" \
    "$executor_size" \
    "$POSTGRES_VERSION" \
    "$FRESH_WASMER_VERSION" \
    "$FRESH_WASMER_WASIX_VERSION" \
    "$FRESH_WASMER_ARTIFACT_ABI_VERSION" \
    "$linear_memory_receipt_relative" \
    "$linear_memory_install_receipt_sha256" <<'PY'
import hashlib
import json
import os
import sys

(
    rows_path,
    carrier_root,
    output_path,
    source_fingerprint,
    core_profile,
    guest_build_recipe_sha256,
    target_triple,
    host_abi,
    compiler_config,
    wasmer_source_commit,
    wasmer_patch_sha256,
    wasmer_cargo_lock_sha256,
    runtime_abi_id,
    producer_recipe_sha256,
    executor_sha256,
    executor_size,
    postgres_version,
    wasmer_version,
    wasmer_wasix_version,
    artifact_abi_version,
    linear_memory_receipt_path,
    linear_memory_receipt_sha256,
) = sys.argv[1:]

with open(os.path.join(carrier_root, linear_memory_receipt_path), "r", encoding="utf-8") as stream:
    linear_memory_receipt = json.load(stream)
if linear_memory_receipt.get("schema") != "oliphaunt.wasix-postmaster.linear-memory-install.v1":
    raise SystemExit("linear-memory install receipt schema differs")
profile_id = linear_memory_receipt.get("profile-id")
expected_profile = {
    "profile-id": "oliphaunt.wasix-postmaster.linear-memory.wasm32-max256m-u64-static4g-guard2g.v1",
    "address-width": "wasm32",
    "supported-host-pointer-width": "u64",
    "maximum-pages": 4096,
    "maximum-bytes": 268435456,
    "static-bound-pages": 65536,
    "static-offset-guard-bytes": 2147483648,
    "static-access-lowering": "wasmer-llvm-unchecked-reservation-and-guard-v1",
}
for key, expected in expected_profile.items():
    if linear_memory_receipt.get(key) != expected:
        raise SystemExit(f"linear-memory install receipt profile differs: {key}")
linear_memory_modules = {}
for record in linear_memory_receipt.get("modules", []):
    path = record.get("path")
    if not isinstance(path, str) or path in linear_memory_modules:
        raise SystemExit("linear-memory install receipt has invalid module paths")
    linear_memory_modules[path] = record

artifacts = []
with open(rows_path, "r", encoding="utf-8", newline="") as rows:
    for line_number, line in enumerate(rows, 1):
        fields = line.rstrip("\n").split("\t")
        if len(fields) != 9:
            raise SystemExit(f"invalid artifact metadata row {line_number}")
        name, kind, path, module_path, artifact_hash, artifact_size, module_hash, module_size, alias = fields
        try:
            linear_memory_record = linear_memory_modules[module_path]
        except KeyError:
            raise SystemExit(f"linear-memory receipt has no record for {module_path}")
        if linear_memory_record.get("module-sha256") != module_hash.lower():
            raise SystemExit(f"linear-memory receipt module digest differs for {module_path}")
        artifact = {
            "name": name,
            "kind": kind,
            "path": path,
            "module-path": module_path,
            "sha256": artifact_hash,
            "raw-sha256": artifact_hash,
            "raw-size": int(artifact_size),
            "module-sha256": module_hash,
            "module-size": int(module_size),
            "linear-memory": {
                "profile-id": profile_id,
                "source-module-sha256": linear_memory_record["source-module-sha256"],
                "install-receipt-sha256": linear_memory_receipt_sha256,
            },
            "compressed": False,
            "exec-aliases": [alias] if alias else [],
        }
        artifacts.append(artifact)

manifest = {
    "format-version": 6,
    "schema": "oliphaunt.wasix-postmaster.sealed-aot.v5",
    "source-lane": "wasix-postmaster",
    "source-fingerprint": source_fingerprint,
    "core-profile": core_profile,
    "guest-build-recipe-sha256": guest_build_recipe_sha256,
    "postgres-version": postgres_version,
    "target-triple": target_triple,
    "host-abi": host_abi,
    "engine": "llvm-opta",
    "compiler-config": compiler_config,
    "cpu-policy": "generic-baseline",
    "cpu-features": [],
    "wasmer-version": wasmer_version,
    "wasmer-wasix-version": wasmer_wasix_version,
    "wasmer-source-commit": wasmer_source_commit,
    "wasmer-patch-sha256": wasmer_patch_sha256,
    "wasmer-cargo-lock-sha256": wasmer_cargo_lock_sha256,
    "artifact-abi-version": int(artifact_abi_version),
    "runtime-abi-id": runtime_abi_id,
    "producer-recipe-sha256": producer_recipe_sha256,
    "executor-engine": "engine-headless",
    "executor-sha256": executor_sha256,
    "executor-size": int(executor_size),
    "linear-memory-profile": {
        "id": profile_id,
        "address-width": linear_memory_receipt["address-width"],
        "supported-host-pointer-width": linear_memory_receipt["supported-host-pointer-width"],
        "maximum-pages": linear_memory_receipt["maximum-pages"],
        "maximum-bytes": linear_memory_receipt["maximum-bytes"],
        "static-bound-pages": linear_memory_receipt["static-bound-pages"],
        "static-offset-guard-bytes": linear_memory_receipt["static-offset-guard-bytes"],
        "static-access-lowering": linear_memory_receipt["static-access-lowering"],
        "install-receipt-path": linear_memory_receipt_path,
        "install-receipt-sha256": linear_memory_receipt_sha256,
    },
    "wasm-features": ["exceptions", "threads"],
    "entrypoint": "runtime:postgres",
    "artifacts": artifacts,
}
with open(output_path, "x", encoding="utf-8", newline="\n") as output:
    json.dump(manifest, output, ensure_ascii=False, indent=2)
    output.write("\n")
PY
}

write_sealed_manifest "$staging/manifest.json"
rm "$artifact_rows"
chmod 0444 "$staging/manifest.json"

# Exercise the final sealed carrier before publication. A
# version probe is sufficient for the postgres entrypoint, but initdb must run
# its real bootstrap lifecycle: it reads the packaged share tree, loads libpq,
# creates writable relation files, and EXEC_BACKEND-spawns the sealed postgres
# alias.  Keep every writable path outside staging and remove it through the
# same signal-safe cleanup path as the unpublished carrier.
validation_root="$(mktemp -d "$output_parent/.${output_name}.validate.XXXXXX")"
mkdir -p \
  "$validation_root/home" \
  "$validation_root/cache" \
  "$validation_root/pgdata" \
  "$validation_root/dev-shm"
chmod 0700 "$validation_root/pgdata"
chmod 1777 "$validation_root/dev-shm"

# HostFS volumes are writable mappings.  Remove write permission from every
# staged payload before exposing it to the guest, and verify its complete
# content-and-mode fingerprint afterwards.  Only the disposable PGDATA and
# /dev/shm mappings are intentionally writable.
carrier_mode_snapshot="$validation_root/carrier-modes.json"
python3 - "$staging" "$carrier_mode_snapshot" <<'PY'
import json
import os
import stat
import sys

root = os.path.realpath(sys.argv[1])
modes = {}
for current, dirs, files in os.walk(root, followlinks=False):
    dirs.sort()
    files.sort()
    for name in [*dirs, *files]:
        path = os.path.join(current, name)
        modes[os.path.relpath(path, root)] = stat.S_IMODE(os.lstat(path).st_mode)
modes["."] = stat.S_IMODE(os.lstat(root).st_mode)
with open(sys.argv[2], "x", encoding="utf-8", newline="\n") as stream:
    json.dump(modes, stream, sort_keys=True)
    stream.write("\n")
PY
chmod -R a-w "$staging"
carrier_validation_fingerprint() {
  python3 - "$staging" <<'PY'
import hashlib
import os
import stat
import sys

root = os.path.realpath(sys.argv[1])
digest = hashlib.sha256()
for current, dirs, files in os.walk(root, followlinks=False):
    dirs.sort()
    files.sort()
    relative_directory = os.path.relpath(current, root)
    directory_mode = stat.S_IMODE(os.lstat(current).st_mode)
    digest.update(f"d\0{relative_directory}\0{directory_mode:o}\0".encode())
    for name in files:
        path = os.path.join(current, name)
        info = os.lstat(path)
        if not stat.S_ISREG(info.st_mode):
            raise SystemExit(f"carrier validation input is not regular: {path}")
        relative = os.path.relpath(path, root)
        file_digest = hashlib.sha256()
        with open(path, "rb", buffering=0) as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                file_digest.update(chunk)
        digest.update(
            f"f\0{relative}\0{stat.S_IMODE(info.st_mode):o}\0{info.st_size}\0{file_digest.hexdigest()}\0".encode()
        )
print(digest.hexdigest())
PY
}
validation_fingerprint="$(carrier_validation_fingerprint)"
fresh_is_sha256 "$validation_fingerprint" || fail "failed to fingerprint carrier before validation"

validation_common_args=(
  run
  --disable-cache
  --stack-size "$runtime_stack_size"
  --sealed-module-manifest "$staging/manifest.json"
  --enable-exceptions
  --enable-threads
  --net
  --volume "$staging:$staging"
  --volume "$staging/share:/share"
  --volume "$staging/lib:/lib"
  --volume "$validation_root/pgdata:/pgdata"
  --volume "$validation_root/dev-shm:/dev/shm"
)

postgres_validation_log="$validation_root/postgres.log"
set +e
env \
  WASMER_DIR="$validation_root/home" \
  WASMER_CACHE_DIR="$validation_root/cache" \
  "$staging/bin/wasmer-headless" "${validation_common_args[@]}" \
    "$staging/bin/postgres" -- --version >"$postgres_validation_log" 2>&1
postgres_validation_status=$?
set -e
if [ "$postgres_validation_status" -ne 0 ]; then
  sed 's/^/sealed postgres load check: /' "$postgres_validation_log" >&2
  fail "headless executor rejected sealed postgres"
fi

initdb_validation_log="$validation_root/initdb.log"
set +e
env \
  WASMER_DIR="$validation_root/home" \
  WASMER_CACHE_DIR="$validation_root/cache" \
  "$staging/bin/wasmer-headless" "${validation_common_args[@]}" \
    "$staging/bin/initdb" -- \
      -D /pgdata \
      -A trust \
      --no-locale \
      --encoding=UTF8 \
      --no-instructions >"$initdb_validation_log" 2>&1
initdb_validation_status=$?
set -e
if [ "$initdb_validation_status" -ne 0 ]; then
  sed 's/^/sealed initdb lifecycle check: /' "$initdb_validation_log" >&2
  fail "headless executor failed the sealed initdb lifecycle"
fi
for initialized_path in PG_VERSION global/pg_control; do
  if ! { [ -f "$validation_root/pgdata/$initialized_path" ] \
    && [ ! -L "$validation_root/pgdata/$initialized_path" ] \
    && [ -s "$validation_root/pgdata/$initialized_path" ]; }
  then
    fail "sealed initdb lifecycle did not create regular non-empty $initialized_path"
  fi
done

[ "$(carrier_validation_fingerprint)" = "$validation_fingerprint" ] || {
  fail "sealed validation mutated the staged carrier"
}
python3 - "$staging" "$carrier_mode_snapshot" <<'PY'
import json
import os
import sys

root = os.path.realpath(sys.argv[1])
with open(sys.argv[2], encoding="utf-8") as stream:
    modes = json.load(stream)
for relative, mode in modes.items():
    path = root if relative == "." else os.path.join(root, relative)
    os.chmod(path, mode, follow_symlinks=False)
PY
cleanup_validation_root

# The payload inventory covers every published regular file except itself.
# It also provides a portable verification surface for support files that are
# intentionally outside the strict AOT loader schema.
python3 - "$staging" "$staging/payload.files" <<'PY'
import hashlib
import os
import stat
import sys

root = os.path.realpath(sys.argv[1])
inventory = os.path.realpath(sys.argv[2])
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
            raise SystemExit(f"carrier contains non-regular file: {path}")
        relative = os.path.relpath(path, root)
        if any(character in relative for character in ("\n", "\r", "\t")):
            raise SystemExit(f"carrier path contains a control delimiter: {relative!r}")
        digest = hashlib.sha256()
        with open(path, "rb", buffering=0) as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        rows.append((relative, info.st_size, digest.hexdigest()))
with open(inventory, "x", encoding="utf-8", newline="\n") as output:
    output.write("schema=oliphaunt.wasix-postmaster.payload-files.v1\n")
    for relative, size, digest in sorted(rows):
        output.write(f"{digest}\t{size}\t{relative}\n")
PY
chmod 0444 "$staging/payload.files"

# A sealed carrier is an immutable deployment input, not a runtime cache or a
# scratch directory.  Normalize the published mode surface after the complete
# payload has been assembled: every directory is traversable/read-only and
# every regular file is read-only, while preserving whether a file was meant
# to be directly executable by the host.  The loader must place any ephemeral
# AOT snapshot in its separate scratch tier.  The cleanup trap deliberately
# restores owner write permission if a later publication check fails.
python3 - "$staging" <<'PY'
import os
import stat
import sys

root = os.path.realpath(sys.argv[1])
for current, directories, files in os.walk(root, topdown=False, followlinks=False):
    for name in files:
        path = os.path.join(current, name)
        info = os.lstat(path)
        if not stat.S_ISREG(info.st_mode):
            raise SystemExit(f"sealed carrier contains a non-regular file: {path}")
        executable = bool(stat.S_IMODE(info.st_mode) & 0o111)
        os.chmod(path, 0o555 if executable else 0o444, follow_symlinks=False)
    for name in directories:
        path = os.path.join(current, name)
        info = os.lstat(path)
        if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
            raise SystemExit(f"sealed carrier contains a non-directory: {path}")
        os.chmod(path, 0o555, follow_symlinks=False)
os.chmod(root, 0o555, follow_symlinks=False)
PY

# Reconsume the finished staging tree through the same verifier used by every
# sealed runtime entrypoint. This proves that the inventory is exact and that
# its manifest, receipt, executor, modules, and AOT artifacts form one
# internally consistent closure before any path is published.
fresh_verify_sealed_headless_carrier "$staging" || {
  fail "finished sealed carrier failed complete payload verification"
}

payload_inventory_sha256="$(fresh_wasmer_bin_hash "$staging/payload.files")"
fresh_is_sha256 "$payload_inventory_sha256" || {
  fail "failed to compute sealed carrier payload identity"
}
if [ "$output_is_explicit" -eq 0 ]; then
  output_name="wasix-postmaster-$POSTGRES_VERSION-${runtime_abi_id:0:16}-$payload_inventory_sha256"
  output="$output_parent/$output_name"
  [ ! -e "$output" ] && [ ! -L "$output" ] || {
    fail "content-addressed output already exists: $output"
  }
fi

# Durability is scoped to the carrier: flush each regular file, then each
# directory bottom-up.  This avoids a global sync while ensuring rename never
# publishes a directory whose verified bytes only lived in page cache.
python3 - "$staging" <<'PY'
import os
import stat
import sys

root = os.path.realpath(sys.argv[1])
directories = []
for current, dirs, files in os.walk(root, topdown=True, followlinks=False):
    directories.append(current)
    for name in files:
        path = os.path.join(current, name)
        info = os.lstat(path)
        if not stat.S_ISREG(info.st_mode):
            raise SystemExit(f"carrier contains non-regular file: {path}")
        flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(path, flags)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
for directory in reversed(directories):
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_DIRECTORY", 0)
    descriptor = os.open(directory, flags)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
PY

publication_lock_path="$output_parent/.${output_name}.publish.lock"
exec {publication_lock_fd}>"$publication_lock_path"
chmod 0600 "$publication_lock_path"
flock -n "$publication_lock_fd" ||
  fail "another process is publishing the same carrier output: $output"
[ ! -e "$output" ] && [ ! -L "$output" ] ||
  fail "carrier output appeared before atomic publication: $output"
fresh_atomic_publish_directory_noreplace "$staging" "$output" ||
  fail "could not atomically publish sealed carrier: $output"
staging=""
python3 - "$output_parent" <<'PY'
import os
import sys

flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_DIRECTORY", 0)
descriptor = os.open(sys.argv[1], flags)
try:
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY
trap - EXIT HUP INT TERM

printf 'built sealed headless WASIX PostgreSQL carrier: %s\n' "$output"
printf 'executor role: postmaster-product\n'
printf 'runtime ABI ID: %s\n' "$runtime_abi_id"
printf 'source fingerprint: %s\n' "$source_fingerprint"
printf 'payload inventory SHA-256: %s\n' "$payload_inventory_sha256"
printf 'payload inventory: %s\n' "$output/payload.files"
