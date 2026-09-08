#!/usr/bin/env bash

set -euo pipefail

FRESH_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$FRESH_ROOT/lib/common.sh"

mode="all"
case "${1:-}" in
	"") ;;
	--build-only) mode="build"; shift ;;
	--tests-only) mode="tests"; shift ;;
	*) printf 'unknown argument: %s\n' "$1" >&2; exit 2 ;;
esac
[ "$#" -eq 0 ] || {
	printf 'unexpected argument: %s\n' "$1" >&2
	exit 2
}

UPSTREAM_WORK_ROOT="${UPSTREAM_WORK_ROOT:-$FRESH_WORK_ROOT/runtime}"
WASMER_ROOT="${WASMER_ROOT:-$UPSTREAM_WORK_ROOT/wasmer}"
LLVM_MAJOR=22
WASMER_PATCH="$FRESH_ROOT/runtime/patches/wasmer/0001-postgres-wasix-blockers.patch"
WASIX_LIBC_PATCH="$FRESH_ROOT/runtime/patches/wasix-libc/0001-postgres-wasix-blockers.patch"
WASMER_BUILD_RECEIPT_OUT="${WASMER_BUILD_RECEIPT_OUT:-$FRESH_WASMER_BUILD_RECEIPT}"
POSTMASTER_EXECUTOR_BUILD_RECEIPT_OUT="${POSTMASTER_EXECUTOR_BUILD_RECEIPT_OUT:-$FRESH_POSTMASTER_EXECUTOR_BUILD_RECEIPT}"
WASMER_TARGET_DIR="$WASMER_ROOT/target"
POSTMASTER_EXECUTOR_TARGET_DIR="$FRESH_POSTMASTER_EXECUTOR_TARGET_DIR"
POSTMASTER_COMPILER_TARGET_DIR="$FRESH_POSTMASTER_COMPILER_TARGET_DIR"
PORTABLE_INPUTS="${OLIPHAUNT_WASIX_POSTMASTER_PORTABLE_INPUTS:-0}"

case "$PORTABLE_INPUTS" in
	0|1) ;;
	*)
		printf 'OLIPHAUNT_WASIX_POSTMASTER_PORTABLE_INPUTS must be 0 or 1\n' >&2
		exit 2
		;;
esac

if [ -n "${CARGO_TARGET_DIR:-}" ] || [ -n "${CARGO_BUILD_TARGET:-}" ] ||
	{ [ -n "${CARGO_INCREMENTAL:-}" ] && [ "$CARGO_INCREMENTAL" != 0 ]; }; then
	printf 'build-runtime.sh owns Cargo target selection and disables incremental compilation; unset CARGO_TARGET_DIR/CARGO_BUILD_TARGET and use CARGO_INCREMENTAL=0\n' >&2
	exit 2
fi
export CARGO_INCREMENTAL=0

find_llvm_prefix() {
	local candidate
	local version

	if [ -n "${LLVM_SYS_221_PREFIX:-}" ]; then
		printf '%s\n' "$LLVM_SYS_221_PREFIX"
		return
	fi

	for candidate in llvm-config-22 llvm-config; do
		if ! command -v "$candidate" >/dev/null 2>&1; then
			continue
		fi
		version="$("$candidate" --version 2>/dev/null || true)"
		case "$version" in
			22|22.*)
				"$candidate" --prefix
				return
				;;
		esac
	done

	printf 'Wasmer LLVM builds require LLVM %s. Set LLVM_SYS_221_PREFIX or install llvm-config-%s.\n' \
		"$LLVM_MAJOR" "$LLVM_MAJOR" >&2
	return 2
}

fresh_require_command cargo
fresh_require_command git
fresh_validate_postmaster_task_budget_profile


LLVM_SYS_221_PREFIX="$(find_llvm_prefix)"
export LLVM_SYS_221_PREFIX

UPSTREAM_WORK_ROOT="$UPSTREAM_WORK_ROOT" \
	"$FRESH_ROOT/runtime/bin/prepare-upstream-checkouts.sh"
[ -f "$WASMER_ROOT/lib/cli/Cargo.toml" ] || {
	printf 'missing prepared Wasmer checkout: %s\n' "$WASMER_ROOT" >&2
	exit 2
}
wasmer_cargo_lock="$WASMER_ROOT/Cargo.lock"
[ -f "$wasmer_cargo_lock" ] && [ ! -L "$wasmer_cargo_lock" ] || {
	printf 'missing regular Wasmer Cargo.lock: %s\n' "$wasmer_cargo_lock" >&2
	exit 2
}
rustc_host="$(rustc -vV | awk '/^host:/ {print $2}')"
[ -n "$rustc_host" ] || {
	printf 'rustc did not report a host target\n' >&2
	exit 2
}
runtime_abi_id="$(fresh_runtime_abi_id \
	"$(fresh_wasmer_bin_hash "$wasmer_cargo_lock")" \
	"$rustc_host" \
	"$(fresh_host_arch)" \
	"$(fresh_host_abi)")"
export OLIPHAUNT_WASIX_RUNTIME_ABI_ID="$runtime_abi_id"

source_wasmer_version="$(awk '
	$0 == "[workspace.package]" { in_package = 1; next }
	in_package && /^\[/ { exit }
	in_package && $1 == "version" { gsub(/"/, "", $3); print $3; exit }
' "$WASMER_ROOT/Cargo.toml")"
source_wasmer_wasix_version="$(awk '
	$0 == "[package]" { in_package = 1; next }
	in_package && /^\[/ { exit }
	in_package && $1 == "version" { gsub(/"/, "", $3); print $3; exit }
' "$WASMER_ROOT/lib/wasix/Cargo.toml")"
[ "$source_wasmer_version" = "$FRESH_WASMER_VERSION" ] || {
	printf 'prepared Wasmer version mismatch: expected %s, got %s\n' \
		"$FRESH_WASMER_VERSION" "${source_wasmer_version:-<empty>}" >&2
	exit 2
}
[ "$source_wasmer_wasix_version" = "$FRESH_WASMER_WASIX_VERSION" ] || {
	printf 'prepared wasmer-wasix version mismatch: expected %s, got %s\n' \
		"$FRESH_WASMER_WASIX_VERSION" "${source_wasmer_wasix_version:-<empty>}" >&2
	exit 2
}

if [ "$mode" != build ]; then
	source "$FRESH_ROOT/runtime/tests.sh"
fi

if [ "$mode" = tests ]; then
	printf 'patched Wasmer and Postmaster runtime tests passed\n'
	exit 0
fi

cargo build \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/cli/Cargo.toml" \
	--bin wasmer \
	--release \
	--no-default-features \
	--features "$FRESH_WASMER_COMPILER_FEATURES"
cargo build \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/cli/Cargo.toml" \
	--bin wasmer-headless \
	--release \
	--no-default-features \
	--features "$FRESH_WASMER_HEADLESS_FEATURES"
cargo build \
	--locked \
	--target-dir "$POSTMASTER_EXECUTOR_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/Cargo.toml" \
	--package "$FRESH_POSTMASTER_EXECUTOR_PACKAGE" \
	--bin "$FRESH_POSTMASTER_EXECUTOR_BINARY" \
	--release \
	--no-default-features \
	--features "$FRESH_POSTMASTER_EXECUTOR_FEATURES"
cargo build \
	--locked \
	--target-dir "$POSTMASTER_EXECUTOR_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/Cargo.toml" \
	--package "$FRESH_POSTMASTER_EXECUTOR_PACKAGE" \
	--bin "$FRESH_START_PROOF_BINARY" \
	--release \
	--no-default-features \
	--features "$FRESH_START_PROOF_FEATURES"
cargo build \
	--locked \
	--target-dir "$POSTMASTER_EXECUTOR_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/Cargo.toml" \
	--package "$FRESH_POSTMASTER_EXECUTOR_PACKAGE" \
	--bin "$FRESH_MEMORY_PROFILE_BINARY" \
	--release \
	--no-default-features \
	--features "$FRESH_MEMORY_PROFILE_FEATURES"
cargo build \
	--locked \
	--target-dir "$POSTMASTER_COMPILER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/Cargo.toml" \
	--package "$FRESH_POSTMASTER_EXECUTOR_PACKAGE" \
	--bin "$FRESH_POSTMASTER_COMPILER_BINARY" \
	--release \
	--no-default-features \
	--features "$FRESH_POSTMASTER_COMPILER_FEATURES"
if [ "$PORTABLE_INPUTS" -eq 1 ]; then
	UPSTREAM_WORK_ROOT="$UPSTREAM_WORK_ROOT" \
		"$FRESH_ROOT/runtime/bin/build-patched-wasix-libc-sysroot.sh" \
		--no-build --portable-inputs
elif [ -f "$WASIXCC_SYSROOT_PREFIX/.oliphaunt-patched-sysroots.manifest" ] && \
	UPSTREAM_WORK_ROOT="$UPSTREAM_WORK_ROOT" \
	"$FRESH_ROOT/runtime/bin/build-patched-wasix-libc-sysroot.sh" --no-build; then
	:
else
	UPSTREAM_WORK_ROOT="$UPSTREAM_WORK_ROOT" \
	"$FRESH_ROOT/runtime/bin/build-patched-wasix-libc-sysroot.sh"
fi

UPSTREAM_WORK_ROOT="$UPSTREAM_WORK_ROOT" \
	"$FRESH_ROOT/runtime/bin/prepare-upstream-checkouts.sh"

wasmer_bin="$WASMER_TARGET_DIR/release/wasmer"
wasmer_headless_bin="$WASMER_TARGET_DIR/release/wasmer-headless"
postmaster_executor_bin="$POSTMASTER_EXECUTOR_TARGET_DIR/release/$FRESH_POSTMASTER_EXECUTOR_BINARY"
start_proof_bin="$POSTMASTER_EXECUTOR_TARGET_DIR/release/$FRESH_START_PROOF_BINARY"
memory_profile_bin="$POSTMASTER_EXECUTOR_TARGET_DIR/release/$FRESH_MEMORY_PROFILE_BINARY"
postmaster_compiler_bin="$POSTMASTER_COMPILER_TARGET_DIR/release/$FRESH_POSTMASTER_COMPILER_BINARY"
carrier_manifest="$WASIXCC_SYSROOT_PREFIX/.oliphaunt-patched-sysroots.manifest"
variant_manifest="$WASIXCC_SYSROOT/.oliphaunt-patched-sysroot.manifest"
prepared_signature="$UPSTREAM_WORK_ROOT/.prepared/wasmer.signature"
libc_prepared_signature="$UPSTREAM_WORK_ROOT/.prepared/wasix-libc.signature"
for required in \
	"$wasmer_bin" \
	"$wasmer_headless_bin" \
	"$postmaster_executor_bin" \
	"$start_proof_bin" \
	"$memory_profile_bin" \
	"$postmaster_compiler_bin" \
	"$WASMER_PATCH" \
	"$WASIX_LIBC_PATCH" \
	"$carrier_manifest" \
	"$variant_manifest" \
	"$prepared_signature" \
	"$libc_prepared_signature" \
	"$WASMER_ROOT/Cargo.lock"
do
	[ -f "$required" ] || {
		printf 'missing Wasmer build-receipt input: %s\n' "$required" >&2
		exit 2
	}
done

mkdir -p "$(dirname "$WASMER_BUILD_RECEIPT_OUT")"
temporary_manifest="$WASMER_BUILD_RECEIPT_OUT.tmp.$$"
trap 'rm -f "$temporary_manifest"' EXIT
{
	printf 'schema=oliphaunt.wasix-postmaster.wasmer-build.v2\n'
	printf 'build_recipe_sha256=%s\n' "$(fresh_runtime_build_recipe_sha256)"
	printf 'wasmer_source_commit=%s\n' "$(git -C "$WASMER_ROOT" rev-parse HEAD)"
	printf 'wasmer_napi_commit=%s\n' "$(git -C "$WASMER_ROOT/lib/napi" rev-parse HEAD)"
	printf 'wasmer_test_files_commit=%s\n' "$(git -C "$WASMER_ROOT/wasmer-test-files" rev-parse HEAD)"
	printf 'wasmer_spec_commit=%s\n' "$(git -C "$WASMER_ROOT/tests/wast/spec" rev-parse HEAD)"
	printf 'wasmer_patch_sha256=%s\n' "$(fresh_wasmer_bin_hash "$WASMER_PATCH")"
	printf 'wasmer_prepared_signature_sha256=%s\n' "$(fresh_wasmer_bin_hash "$prepared_signature")"
	printf 'wasmer_cargo_lock_sha256=%s\n' "$(fresh_wasmer_bin_hash "$WASMER_ROOT/Cargo.lock")"
	printf 'wasmer_binary_sha256=%s\n' "$(fresh_wasmer_bin_hash "$wasmer_bin")"
	printf 'wasmer_features=%s\n' "$FRESH_WASMER_COMPILER_FEATURES"
	printf 'wasmer_headless_binary_sha256=%s\n' "$(fresh_wasmer_bin_hash "$wasmer_headless_bin")"
	printf 'wasmer_headless_features=%s\n' "$FRESH_WASMER_HEADLESS_FEATURES"
	printf 'runtime_abi_id=%s\n' "$runtime_abi_id"
	printf 'artifact_abi_version=%s\n' "$FRESH_WASMER_ARTIFACT_ABI_VERSION"
	printf 'wasix_libc_source_commit=%s\n' "$(git -C "$UPSTREAM_WORK_ROOT/wasix-libc" rev-parse HEAD)"
	printf 'wasix_libc_patch_sha256=%s\n' "$(fresh_wasmer_bin_hash "$WASIX_LIBC_PATCH")"
	printf 'wasix_libc_prepared_signature_sha256=%s\n' "$(fresh_wasmer_bin_hash "$libc_prepared_signature")"
	printf 'sysroot_carrier_manifest_sha256=%s\n' "$(fresh_wasmer_bin_hash "$carrier_manifest")"
	printf 'sysroot_variant=%s\n' "$WASIXCC_SYSROOT_VARIANT"
	printf 'sysroot_variant_manifest_sha256=%s\n' "$(fresh_wasmer_bin_hash "$variant_manifest")"
	printf 'host_platform=%s\n' "$(fresh_host_arch)"
	printf 'host_abi=%s\n' "$(fresh_host_abi)"
	printf 'rustc_host=%s\n' "$rustc_host"
	printf 'rustc_version=%s\n' "$(rustc --version)"
	printf 'llvm_version=%s\n' "$("$LLVM_SYS_221_PREFIX/bin/llvm-config" --version)"
} >"$temporary_manifest"
fresh_validate_wasmer_build_receipt_shape "$temporary_manifest"
fresh_require_local_wasmer_build_state "$temporary_manifest"
WASMER_BUILD_RECEIPT="$temporary_manifest" fresh_require_patched_wasmer "$wasmer_bin"
WASMER_BUILD_RECEIPT="$temporary_manifest" fresh_require_patched_wasmer_headless "$wasmer_headless_bin"
mv "$temporary_manifest" "$WASMER_BUILD_RECEIPT_OUT"
trap - EXIT
WASMER_BUILD_RECEIPT="$WASMER_BUILD_RECEIPT_OUT" fresh_require_patched_wasmer "$wasmer_bin"
WASMER_BUILD_RECEIPT="$WASMER_BUILD_RECEIPT_OUT" fresh_require_patched_wasmer_headless "$wasmer_headless_bin"

mkdir -p "$(dirname "$POSTMASTER_EXECUTOR_BUILD_RECEIPT_OUT")"
temporary_executor_receipt="$POSTMASTER_EXECUTOR_BUILD_RECEIPT_OUT.tmp.$$"
trap 'rm -f "$temporary_executor_receipt"' EXIT
{
	printf 'schema=oliphaunt.wasix-postmaster.postmaster-executor-build.v3\n'
	printf 'build_recipe_sha256=%s\n' "$(fresh_runtime_build_recipe_sha256)"
	printf 'wasmer_build_receipt_sha256=%s\n' "$(fresh_wasmer_bin_hash "$WASMER_BUILD_RECEIPT_OUT")"
	printf 'wasmer_source_commit=%s\n' "$(git -C "$WASMER_ROOT" rev-parse HEAD)"
	printf 'wasmer_patch_sha256=%s\n' "$(fresh_wasmer_bin_hash "$WASMER_PATCH")"
	printf 'wasmer_prepared_signature_sha256=%s\n' "$(fresh_wasmer_bin_hash "$prepared_signature")"
	printf 'wasmer_cargo_lock_sha256=%s\n' "$(fresh_wasmer_bin_hash "$WASMER_ROOT/Cargo.lock")"
	printf 'runtime_abi_id=%s\n' "$runtime_abi_id"
	printf 'artifact_abi_version=%s\n' "$FRESH_WASMER_ARTIFACT_ABI_VERSION"
	printf 'executor_package=%s\n' "$FRESH_POSTMASTER_EXECUTOR_PACKAGE"
	printf 'executor_binary=%s\n' "$FRESH_POSTMASTER_EXECUTOR_BINARY"
	printf 'executor_features=%s\n' "$FRESH_POSTMASTER_EXECUTOR_FEATURES"
	printf 'executor_role=%s\n' "$FRESH_POSTMASTER_EXECUTOR_ROLE"
	printf 'runtime_policy_id=%s\n' "$FRESH_POSTMASTER_EXECUTOR_RUNTIME_POLICY_ID"
	printf 'cli_contract=%s\n' "$FRESH_POSTMASTER_EXECUTOR_CLI_CONTRACT"
	printf 'executor_binary_sha256=%s\n' "$(fresh_wasmer_bin_hash "$postmaster_executor_bin")"
	printf 'start_proof_binary=%s\n' "$FRESH_START_PROOF_BINARY"
	printf 'start_proof_features=%s\n' "$FRESH_START_PROOF_FEATURES"
	printf 'start_proof_policy=%s\n' "$FRESH_START_PROOF_POLICY"
	printf 'start_proof_binary_sha256=%s\n' "$(fresh_wasmer_bin_hash "$start_proof_bin")"
	printf 'memory_profile_binary=%s\n' "$FRESH_MEMORY_PROFILE_BINARY"
	printf 'memory_profile_features=%s\n' "$FRESH_MEMORY_PROFILE_FEATURES"
	printf 'linear_memory_profile_id=%s\n' "$FRESH_LINEAR_MEMORY_PROFILE_ID"
	printf 'memory_profile_binary_sha256=%s\n' "$(fresh_wasmer_bin_hash "$memory_profile_bin")"
	printf 'postmaster_compiler_binary=%s\n' "$FRESH_POSTMASTER_COMPILER_BINARY"
	printf 'postmaster_compiler_features=%s\n' "$FRESH_POSTMASTER_COMPILER_FEATURES"
	printf 'compiler_cpu_policy=generic-baseline\n'
	printf 'compiler_cpu_features=none\n'
	printf 'postmaster_compiler_binary_sha256=%s\n' "$(fresh_wasmer_bin_hash "$postmaster_compiler_bin")"
	printf 'host_platform=%s\n' "$(fresh_host_arch)"
	printf 'host_abi=%s\n' "$(fresh_host_abi)"
	printf 'rustc_host=%s\n' "$rustc_host"
	printf 'rustc_version=%s\n' "$(rustc --version)"
} >"$temporary_executor_receipt"
fresh_validate_postmaster_executor_build_receipt_shape "$temporary_executor_receipt"
fresh_require_patched_postmaster_executor \
	"$postmaster_executor_bin" \
	"$temporary_executor_receipt" \
	"$WASMER_BUILD_RECEIPT_OUT"
fresh_require_start_proof_tool \
	"$start_proof_bin" \
	"$temporary_executor_receipt"
fresh_require_memory_profile_tool \
	"$memory_profile_bin" \
	"$temporary_executor_receipt"
fresh_require_patched_postmaster_compiler \
	"$postmaster_compiler_bin" \
	"$temporary_executor_receipt" \
	"$WASMER_BUILD_RECEIPT_OUT" \
	"$postmaster_executor_bin"
mv "$temporary_executor_receipt" "$POSTMASTER_EXECUTOR_BUILD_RECEIPT_OUT"
trap - EXIT
fresh_require_patched_postmaster_executor \
	"$postmaster_executor_bin" \
	"$POSTMASTER_EXECUTOR_BUILD_RECEIPT_OUT" \
	"$WASMER_BUILD_RECEIPT_OUT"
fresh_require_start_proof_tool \
	"$start_proof_bin" \
	"$POSTMASTER_EXECUTOR_BUILD_RECEIPT_OUT"
fresh_require_memory_profile_tool \
	"$memory_profile_bin" \
	"$POSTMASTER_EXECUTOR_BUILD_RECEIPT_OUT"
fresh_require_patched_postmaster_compiler \
	"$postmaster_compiler_bin" \
	"$POSTMASTER_EXECUTOR_BUILD_RECEIPT_OUT" \
	"$WASMER_BUILD_RECEIPT_OUT" \
	"$postmaster_executor_bin"

printf 'built patched Wasmer: %s\n' "$wasmer_bin"
printf 'Wasmer sha256: %s\n' "$(fresh_wasmer_bin_hash "$wasmer_bin")"
printf 'built patched headless Wasmer: %s\n' "$wasmer_headless_bin"
printf 'Headless Wasmer sha256: %s\n' "$(fresh_wasmer_bin_hash "$wasmer_headless_bin")"
printf 'built postmaster product executor: %s\n' "$postmaster_executor_bin"
printf 'Postmaster executor sha256: %s\n' "$(fresh_wasmer_bin_hash "$postmaster_executor_bin")"
printf 'built deterministic-start proof tool: %s\n' "$start_proof_bin"
printf 'Start proof tool sha256: %s\n' "$(fresh_wasmer_bin_hash "$start_proof_bin")"
printf 'built linear-memory profile tool: %s\n' "$memory_profile_bin"
printf 'Linear-memory profile tool sha256: %s\n' "$(fresh_wasmer_bin_hash "$memory_profile_bin")"
printf 'built postmaster product compiler: %s\n' "$postmaster_compiler_bin"
printf 'Postmaster product compiler sha256: %s\n' "$(fresh_wasmer_bin_hash "$postmaster_compiler_bin")"
printf 'Runtime ABI ID: %s\n' "$runtime_abi_id"
printf 'WASIX libc carrier: %s\n' "$WASIXCC_SYSROOT_PREFIX"
printf 'Wasmer build receipt: %s\n' "$WASMER_BUILD_RECEIPT_OUT"
printf 'Receipt sha256: %s\n' "$(fresh_wasmer_bin_hash "$WASMER_BUILD_RECEIPT_OUT")"
printf 'Postmaster executor build receipt: %s\n' "$POSTMASTER_EXECUTOR_BUILD_RECEIPT_OUT"
printf 'Postmaster executor receipt sha256: %s\n' \
	"$(fresh_wasmer_bin_hash "$POSTMASTER_EXECUTOR_BUILD_RECEIPT_OUT")"
