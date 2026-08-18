#!/usr/bin/env bash

# This library is sourced after lib/common.sh by sealed-carrier tooling. Keep
# carrier provenance separate from the runtime build-recipe hash: changing
# packaging policy must not silently change the executor ABI.

# Publish a completed sibling directory without ever replacing or nesting
# beneath a concurrently created destination.  There is no race-free POSIX
# fallback for this operation, so unsupported hosts fail closed instead of
# weakening publication to a check-then-rename sequence.
fresh_atomic_publish_directory_noreplace() {
  local source="$1"
  local destination="$2"

  python3 - "$source" "$destination" <<'PY'
import ctypes
import errno
import os
from pathlib import Path
import stat
import sys

source = Path(sys.argv[1])
destination = Path(sys.argv[2])
source_info = os.lstat(source)
if not stat.S_ISDIR(source_info.st_mode) or stat.S_ISLNK(source_info.st_mode):
    raise SystemExit(f"atomic publication source is not a directory: {source}")
if source.parent.resolve(strict=True) != destination.parent.resolve(strict=True):
    raise SystemExit("atomic publication requires source and destination siblings")

libc = ctypes.CDLL(None, use_errno=True)
source_bytes = os.fsencode(source)
destination_bytes = os.fsencode(destination)
if sys.platform.startswith("linux"):
    rename = getattr(libc, "renameat2", None)
    if rename is None:
        raise SystemExit("host libc has no atomic no-replace directory rename")
    rename.argtypes = [
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_uint,
    ]
    rename.restype = ctypes.c_int
    result = rename(-100, source_bytes, -100, destination_bytes, 1)
elif sys.platform == "darwin":
    rename = getattr(libc, "renamex_np", None)
    if rename is None:
        raise SystemExit("host libc has no atomic exclusive directory rename")
    rename.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    result = rename(source_bytes, destination_bytes, 0x00000004)
else:
    raise SystemExit(
        f"no audited atomic no-replace directory publication for {sys.platform}"
    )
if result != 0:
    error = ctypes.get_errno()
    if error in (errno.EEXIST, errno.ENOTEMPTY):
        raise SystemExit(f"atomic publication destination already exists: {destination}")
    raise SystemExit(
        f"atomic no-replace directory publication failed: {os.strerror(error)}"
    )
PY
}

# Identity of the exact AOT production recipe, separate from runtime ABI
# compatibility. The receipt binds native binaries and their build recipe;
# this adds the tracked precompiler plus the policy knobs and guest payload
# that produced a particular sealed artifact set.
fresh_aot_producer_recipe_sha256() {
  local receipt="$1"
  local product_receipt="$2"
  local compiler_config="$3"
  local target_triple="$4"
  local source_fingerprint="$5"
  local precompile_script="$FRESH_ROOT/bin/precompile-wasix-core.sh"
  local carrier_builder="$FRESH_ROOT/bin/build-sealed-headless-carrier.sh"
  local carrier_policy="$FRESH_ROOT/lib/sealed-carrier.sh"
  local carrier_verifier="$FRESH_ROOT/lib/verify-sealed-carrier.py"
  local export_chain_verifier="$FRESH_ROOT/lib/sealed_export_chain.py"
  local capture_stack_size="${WASMER_STACK_SIZE:-33554432}"
  local compiler_sha256

  [ -f "$receipt" ] && [ ! -L "$receipt" ] || {
    printf 'AOT producer receipt must be a regular file: %s\n' "$receipt" >&2
    return 2
  }
  [ -f "$product_receipt" ] && [ ! -L "$product_receipt" ] || {
    printf 'postmaster product build receipt must be a regular file: %s\n' \
      "$product_receipt" >&2
    return 2
  }
  [ -f "$precompile_script" ] && [ ! -L "$precompile_script" ] || {
    printf 'AOT producer script must be a regular file: %s\n' "$precompile_script" >&2
    return 2
  }
  [ -f "$carrier_builder" ] && [ ! -L "$carrier_builder" ] || {
    printf 'sealed carrier builder must be a regular file: %s\n' "$carrier_builder" >&2
    return 2
  }
  [ -f "$carrier_policy" ] && [ ! -L "$carrier_policy" ] || {
    printf 'sealed carrier policy must be a regular file: %s\n' "$carrier_policy" >&2
    return 2
  }
  [ -f "$carrier_verifier" ] && [ ! -L "$carrier_verifier" ] || {
    printf 'sealed carrier verifier must be a regular file: %s\n' "$carrier_verifier" >&2
    return 2
  }
  [ -f "$export_chain_verifier" ] && [ ! -L "$export_chain_verifier" ] || {
    printf 'sealed export chain verifier must be a regular file: %s\n' \
      "$export_chain_verifier" >&2
    return 2
  }
  [ -n "$compiler_config" ] && [ -n "$target_triple" ] || {
    printf 'AOT producer compiler config and target must be nonempty\n' >&2
    return 2
  }
  case "$capture_stack_size" in
    ''|*[!0-9]*)
      printf 'runtime stack size must be a positive integer\n' >&2
      return 2
      ;;
  esac
  [ "$capture_stack_size" -gt 0 ] || return 2
  fresh_is_sha256 "$source_fingerprint" || {
    printf 'AOT producer source fingerprint is not a lowercase SHA-256\n' >&2
    return 2
  }
  fresh_validate_wasmer_build_receipt_shape "$receipt" || return
  fresh_require_manifest_value \
    "$receipt" schema oliphaunt.wasix-postmaster.wasmer-build.v2 || return
  fresh_require_manifest_value \
    "$receipt" wasmer_features "$FRESH_WASMER_COMPILER_FEATURES" || return
  fresh_require_manifest_value \
    "$receipt" artifact_abi_version "$FRESH_WASMER_ARTIFACT_ABI_VERSION" || return
  fresh_require_manifest_value "$receipt" rustc_host "$target_triple" || return
  fresh_validate_postmaster_executor_build_receipt_shape "$product_receipt" || return
  fresh_require_manifest_value \
    "$product_receipt" schema \
    oliphaunt.wasix-postmaster.postmaster-executor-build.v3 || return
  fresh_require_manifest_value \
    "$product_receipt" wasmer_build_receipt_sha256 \
    "$(fresh_wasmer_bin_hash "$receipt")" || return
  fresh_require_manifest_value \
    "$product_receipt" runtime_abi_id \
    "$(fresh_manifest_value "$receipt" runtime_abi_id)" || return
  fresh_require_manifest_value \
    "$product_receipt" artifact_abi_version \
    "$FRESH_WASMER_ARTIFACT_ABI_VERSION" || return
  fresh_require_manifest_value \
    "$product_receipt" postmaster_compiler_binary \
    "$FRESH_POSTMASTER_COMPILER_BINARY" || return
  fresh_require_manifest_value \
    "$product_receipt" postmaster_compiler_features \
    "$FRESH_POSTMASTER_COMPILER_FEATURES" || return
  fresh_require_manifest_value \
    "$product_receipt" compiler_cpu_policy generic-baseline || return
  fresh_require_manifest_value \
    "$product_receipt" compiler_cpu_features none || return
  fresh_require_manifest_value \
    "$product_receipt" linear_memory_profile_id \
    "$FRESH_LINEAR_MEMORY_PROFILE_ID" || return
  compiler_sha256="$(fresh_manifest_value \
    "$product_receipt" postmaster_compiler_binary_sha256)" || return
  fresh_is_sha256 "$compiler_sha256" || return 2

  {
    printf '%s\0%s\0' schema oliphaunt.wasix-postmaster.aot-producer.v2
    printf '%s\0%s\0' receipt-sha256 "$(fresh_wasmer_bin_hash "$receipt")"
    printf '%s\0%s\0' product-receipt-sha256 "$(fresh_wasmer_bin_hash "$product_receipt")"
    printf '%s\0%s\0' compiler-sha256 "$compiler_sha256"
    printf '%s\0%s\0' producer-script-sha256 "$(fresh_wasmer_bin_hash "$precompile_script")"
    printf '%s\0%s\0' carrier-builder-sha256 "$(fresh_wasmer_bin_hash "$carrier_builder")"
    printf '%s\0%s\0' carrier-policy-sha256 "$(fresh_wasmer_bin_hash "$carrier_policy")"
    printf '%s\0%s\0' carrier-verifier-sha256 "$(fresh_wasmer_bin_hash "$carrier_verifier")"
    printf '%s\0%s\0' sealed-export-chain-verifier-sha256 "$(fresh_wasmer_bin_hash "$export_chain_verifier")"
    printf '%s\0%s\0' producer-engine llvm-opta
    printf '%s\0%s\0' compiler-config "$compiler_config"
    printf '%s\0%s\0' target-triple "$target_triple"
    printf '%s\0%s\0' cpu-policy generic-baseline
    printf '%s\0%s\0' cpu-features none
    printf '%s\0%s\0' wasm-features exceptions,threads
    printf '%s\0%s\0' artifact-abi-version "$FRESH_WASMER_ARTIFACT_ABI_VERSION"
    printf '%s\0%s\0' source-fingerprint "$source_fingerprint"
    printf '%s\0%s\0' capture-manifest oliphaunt.wasix-postmaster.sealed-aot.v3:4
    printf '%s\0%s\0' carrier-manifest oliphaunt.wasix-postmaster.sealed-aot.v5:6
    printf '%s\0%s\0' linear-memory-profile "$FRESH_LINEAR_MEMORY_PROFILE_ID"
    printf '%s\0%s\0' linear-memory-maximum-pages "$FRESH_LINEAR_MEMORY_MAXIMUM_PAGES"
    printf '%s\0%s\0' linear-memory-static-bound-pages "$FRESH_LINEAR_MEMORY_STATIC_BOUND_PAGES"
    printf '%s\0%s\0' linear-memory-static-offset-guard-bytes "$FRESH_LINEAR_MEMORY_STATIC_OFFSET_GUARD_BYTES"
    printf '%s\0%s\0' postmaster-executor-receipt-schema oliphaunt.wasix-postmaster.postmaster-executor-build.v3
    printf '%s\0%s\0' runtime-stack-size "$capture_stack_size"
  } | fresh_sha256_stream
}

# Select the carrier produced from the current guest and runtime receipts.
# Content-addressed carriers intentionally survive rebuilds, so callers must
# not infer "current" from the number of directories below the work root.
# Full verification also excludes carriers sealed by an older packaging
# policy when only packaging inputs changed between builds.
fresh_select_current_sealed_carrier() {
  local carriers_root="${1:-$FRESH_WORK_ROOT/carriers}"
  local guest_receipt="$WASIX_INSTALL_DIR/guest-build.receipt"
  local wasmer_receipt="${WASMER_BUILD_RECEIPT:-$FRESH_WASMER_BUILD_RECEIPT}"
  local executor_receipt="$FRESH_POSTMASTER_EXECUTOR_BUILD_RECEIPT"
  local candidate
  local current_receipt
  local matches=()

  [ -d "$carriers_root" ] && [ ! -L "$carriers_root" ] || {
    printf 'sealed carrier root is not a regular directory: %s\n' \
      "$carriers_root" >&2
    return 2
  }
  for current_receipt in \
    "$guest_receipt" \
    "$wasmer_receipt" \
    "$executor_receipt"
  do
    [ -f "$current_receipt" ] && [ ! -L "$current_receipt" ] || {
      printf 'current carrier input is not a regular receipt: %s\n' \
        "$current_receipt" >&2
      return 2
    }
  done

  while IFS= read -r -d '' candidate; do
    [ ! -L "$candidate" ] || continue
    cmp -s "$candidate/guest-build.receipt" "$guest_receipt" || continue
    cmp -s "$candidate/wasmer-build.receipt" "$wasmer_receipt" || continue
    cmp -s "$candidate/postmaster-executor.receipt" "$executor_receipt" || continue
    fresh_verify_sealed_headless_carrier "$candidate" >/dev/null 2>&1 || continue
    matches+=("$candidate")
  done < <(find "$carriers_root" -mindepth 1 -maxdepth 1 -type d \
    -name 'wasix-postmaster-*' -print0 2>/dev/null)

  [ "${#matches[@]}" -eq 1 ] || {
    printf 'expected exactly one verified carrier for the current build receipts, found %s\n' \
      "${#matches[@]}" >&2
    return 2
  }
  printf '%s\n' "${matches[0]}"
}

# Resolve the exact product executor identity from the verified carrier closure.
fresh_sealed_executor_selection() {
  local carrier_root="$1"
  local verifier="$FRESH_ROOT/lib/verify-sealed-carrier.py"
  local selection extra

  selection="$(python3 "$verifier" executor-selection "$carrier_root")" || return
  IFS=$'\t' read -r \
    FRESH_SEALED_EXECUTOR_ROLE \
    FRESH_SEALED_EXECUTOR_RECEIPT_RELATIVE \
    FRESH_SEALED_EXECUTOR_RECEIPT_SHA256 \
    FRESH_SEALED_EXECUTOR_SHA256 \
    extra <<<"$selection"
  [ -z "${extra:-}" ] || {
    printf 'sealed executor selection has unexpected fields: %s\n' "$selection" >&2
    return 2
  }
  [ "$FRESH_SEALED_EXECUTOR_ROLE:$FRESH_SEALED_EXECUTOR_RECEIPT_RELATIVE" = \
    postmaster-product:postmaster-executor.receipt ] || {
    printf 'sealed executor selection role/receipt differs: %s\n' "$selection" >&2
    return 2
  }
  fresh_is_sha256 "$FRESH_SEALED_EXECUTOR_RECEIPT_SHA256" && \
    fresh_is_sha256 "$FRESH_SEALED_EXECUTOR_SHA256" || {
    printf 'sealed executor selection contains a malformed identity\n' >&2
    return 2
  }
  export FRESH_SEALED_EXECUTOR_ROLE
  export FRESH_SEALED_EXECUTOR_RECEIPT_RELATIVE
  export FRESH_SEALED_EXECUTOR_RECEIPT_SHA256
  export FRESH_SEALED_EXECUTOR_SHA256
}

# Validate the complete locally sealed carrier before it is published or used.
# The payload inventory is intentionally self-excluding, so this verifies it as
# the exact set of every other regular file and then checks that the manifest,
# receipt, headless executor, and AOT closure all agree.
fresh_verify_sealed_headless_carrier() {
  local carrier_input="$1"
  local carrier_root
  local manifest
  local receipt
  local headless
  local verifier="$FRESH_ROOT/lib/verify-sealed-carrier.py"
  local manifest_recipe_inputs
  local remaining_recipe_inputs
  local compiler_config
  local target_triple
  local source_fingerprint
  local expected_producer_recipe
  local product_receipt

  if [ ! -d "$carrier_input" ] || [ -L "$carrier_input" ]; then
    printf 'sealed carrier root must be a non-symlink directory: %s\n' "$carrier_input" >&2
    return 2
  fi
  carrier_root="$(cd "$carrier_input" && pwd -P)" || return
  manifest="$carrier_root/manifest.json"
  receipt="$carrier_root/wasmer-build.receipt"
  headless="$carrier_root/bin/wasmer-headless"

  if [ ! -f "$verifier" ] || [ -L "$verifier" ]; then
    printf 'missing regular sealed carrier verifier: %s\n' "$verifier" >&2
    return 2
  fi
  fresh_require_command python3 || return
  if [ ! -f "$manifest" ] || [ -L "$manifest" ]; then
    printf 'missing regular sealed carrier manifest: %s\n' "$manifest" >&2
    return 2
  fi
  if [ ! -f "$receipt" ] || [ -L "$receipt" ]; then
    printf 'missing regular sealed carrier receipt: %s\n' "$receipt" >&2
    return 2
  fi
  if [ ! -f "$headless" ] || [ -L "$headless" ] || [ ! -x "$headless" ]; then
    printf 'missing executable sealed headless runtime: %s\n' "$headless" >&2
    return 2
  fi

  fresh_sealed_executor_selection "$carrier_root" || return
  fresh_require_patched_postmaster_executor \
    "$headless" \
    "$carrier_root/$FRESH_SEALED_EXECUTOR_RECEIPT_RELATIVE" \
    "$receipt" || return
  product_receipt="$carrier_root/postmaster-executor.receipt"
  [ -f "$product_receipt" ] && [ ! -L "$product_receipt" ] || {
    printf 'missing receipt-bound product compiler identity: %s\n' \
      "$product_receipt" >&2
    return 2
  }

  manifest_recipe_inputs="$(
    python3 "$verifier" recipe-inputs "$carrier_root"
  )" || return
  case "$manifest_recipe_inputs" in
    *$'\n'*) ;;
    *)
      printf 'unable to read sealed carrier recipe inputs: %s\n' "$manifest" >&2
      return 2
      ;;
  esac
  compiler_config="${manifest_recipe_inputs%%$'\n'*}"
  remaining_recipe_inputs="${manifest_recipe_inputs#*$'\n'}"
  case "$remaining_recipe_inputs" in
    *$'\n'*) ;;
    *)
      printf 'unable to read sealed carrier recipe inputs: %s\n' "$manifest" >&2
      return 2
      ;;
  esac
  target_triple="${remaining_recipe_inputs%%$'\n'*}"
  source_fingerprint="${remaining_recipe_inputs#*$'\n'}"
  case "$source_fingerprint" in
    ''|*$'\n'*)
      printf 'unable to read sealed carrier recipe inputs: %s\n' "$manifest" >&2
      return 2
      ;;
  esac
  expected_producer_recipe="$(fresh_aot_producer_recipe_sha256 \
    "$receipt" "$product_receipt" "$compiler_config" \
    "$target_triple" "$source_fingerprint")" || return

  python3 "$verifier" verify \
    "$carrier_root" \
    "$expected_producer_recipe" \
    "$POSTGRES_VERSION" \
    "$FRESH_WASMER_VERSION" \
    "$FRESH_WASMER_WASIX_VERSION" \
    "$FRESH_WASMER_ARTIFACT_ABI_VERSION" \
    "$carrier_root"
}
