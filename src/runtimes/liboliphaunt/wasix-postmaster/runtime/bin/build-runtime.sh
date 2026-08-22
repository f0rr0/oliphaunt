#!/usr/bin/env bash

set -euo pipefail

FRESH_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$FRESH_ROOT/lib/common.sh"

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

require_listed_test() {
	local listing="$1"
	local expected="$2"

	case "$listing" in
		*"$expected: test"*) ;;
		*)
			printf 'required focused test filter did not list %s\n' "$expected" >&2
			exit 2
			;;
	esac
}

require_listed_tests() {
	local listing="$1"
	shift
	local expected
	for expected in "$@"; do
		require_listed_test "$listing" "$expected"
	done
}

fresh_require_command cargo
fresh_require_command git
fresh_require_command python3
fresh_validate_postmaster_task_budget_profile

python3 "$FRESH_ROOT/runtime/bin/verify-source-lock.py"

LLVM_SYS_221_PREFIX="$(find_llvm_prefix)"
export LLVM_SYS_221_PREFIX

UPSTREAM_WORK_ROOT="$UPSTREAM_WORK_ROOT" \
	"$FRESH_ROOT/runtime/bin/prepare-upstream-checkouts.sh"
[ -f "$WASMER_ROOT/lib/cli/Cargo.toml" ] || {
	printf 'missing prepared Wasmer checkout: %s\n' "$WASMER_ROOT" >&2
	exit 2
}
while IFS=$'\t' read -r capability _owner _basis source_paths _rest; do
	case "${capability:-}" in ''|'#'*) continue ;; esac
	IFS=';' read -r -a source_refs <<<"$source_paths"
	for source_ref in "${source_refs[@]}"; do
		case "$source_ref" in
			project:*) source_path="$FRESH_ROOT/${source_ref#project:}" ;;
			wasmer:*) source_path="$WASMER_ROOT/${source_ref#wasmer:}" ;;
			wasix-libc:*) source_path="$WASIX_LIBC_ROOT/${source_ref#wasix-libc:}" ;;
			*) printf 'unknown capability source reference: %s\n' "$source_ref" >&2; exit 2 ;;
		esac
		[ -e "$source_path" ] || {
			printf 'missing source for capability %s: %s\n' "$capability" "$source_ref" >&2
			exit 2
		}
	done
done <"$FRESH_ROOT/runtime/capabilities.tsv"
python3 "$FRESH_ROOT/runtime/bin/verify-runtime-state-ownership.py" \
	--wasmer-root "$WASMER_ROOT"
python3 "$FRESH_ROOT/runtime/bin/verify-runtime-execution-ownership.py" \
	--wasmer-root "$WASMER_ROOT"
"$WASMER_ROOT/lib/oliphaunt-wasix-postmaster-executor/tests/check-dependency-policy.sh"

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

listed_tests="$(cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/wasix/Cargo.toml" \
	--lib \
	--no-default-features \
	--features sys-minimal,wasmer/cranelift \
	state::preinitialized_memory_image::tests \
	-- \
	--list)"
require_listed_tests "$listed_tests" \
	'state::preinitialized_memory_image::tests::attested_runtime_validation_is_single_flight' \
	'state::preinitialized_memory_image::tests::attested_runtime_audit_has_exact_terminal_conservation' \
	'state::preinitialized_memory_image::tests::attested_runtime_audit_reports_counter_overflow_without_wrapping'
cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/vm/Cargo.toml" \
	remap_shared_file_fixed_replaces_only_requested_pages
cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/vm/Cargo.toml" \
	remap_shared_file_fixed_accepts_a_partial_final_file_page
cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/vm/Cargo.toml" \
	remap_private_file_fixed_shares_clean_bytes_but_isolates_writes
cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/vm/Cargo.toml" \
	immutable_function_tables_are_shared_by_two_instances
cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/vm/Cargo.toml" \
	shared_function_tables_outlive_artifact_owner_and_peer_instance
cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/vm/Cargo.toml" \
	instance::allocator::tests::cached_offsets_produce_the_same_allocator_layout \
	-- \
	--exact
cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/vm/Cargo.toml" \
	trap::traphandlers::tests::tls_stack_reuses_mapping_without_global_queue \
	-- \
	--exact
if [ "$(uname -s)-$(uname -m)" = Linux-x86_64 ]; then
	cargo test \
		--locked \
		--target-dir "$WASMER_TARGET_DIR" \
		--manifest-path "$WASMER_ROOT/lib/compiler/Cargo.toml" \
		engine::code_memory::tests::strict_linux_x86_64::relocated_regular_file_preserves_base_bytes_permissions_and_execution \
		-- \
		--exact
fi
cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/compiler/Cargo.toml" \
	engine::trap::frame_info::tests \
	--lib
cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/wasix/Cargo.toml" \
	shared_memory_mapping \
	--lib \
	--no-default-features \
	--features sys-minimal,wasmer/cranelift
cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/wasix/Cargo.toml" \
	--lib \
	--no-default-features \
	--features sys-minimal,wasmer/cranelift \
	state::linker::dynamic_instance_export_tests
cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/wasix/Cargo.toml" \
	--lib \
	--no-default-features \
	--features sys-minimal,wasmer/cranelift \
	state::linker::single_slot_broadcast_tests
listed_tests="$(cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/wasix/Cargo.toml" \
	--lib \
	--no-default-features \
	--features sys-minimal,host-fs,wasmer/cranelift \
	fs::tests::host_file_size_refresh_observes_another_process_extension \
	-- \
	--list)"
require_listed_test "$listed_tests" \
	'fs::tests::host_file_size_refresh_observes_another_process_extension'
cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/wasix/Cargo.toml" \
	--lib \
	--no-default-features \
	--features sys-minimal,host-fs,wasmer/cranelift \
	fs::tests::host_file_size_refresh_observes_another_process_extension \
	-- \
	--exact
cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/wasix/Cargo.toml" \
	--lib \
	--no-default-features \
	--features sys-minimal,wasmer/cranelift \
	runtime::sealed_loader_audit::tests
cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/wasix/Cargo.toml" \
	--lib \
	--no-default-features \
	--features sys-minimal,wasmer/cranelift \
	state::preinitialized_memory_image::tests
cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/wasix/Cargo.toml" \
	--lib \
	--no-default-features \
	--features sys-minimal,wasmer/cranelift \
	syscalls::wasix::path_open2::tests
cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/virtual-fs/Cargo.toml" \
	host_file_defers_async_descriptor_until_async_io_is_requested
cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/virtual-fs/Cargo.toml" \
	file_advice
listed_tests="$(cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/virtual-fs/Cargo.toml" \
	shared_positioned_read \
	-- \
	--list)"
require_listed_tests "$listed_tests" \
	'advice_tests::virtual_file_shared_positioned_read_defaults_to_unsupported' \
	'host_fs::tests::host_file_shared_positioned_reads_are_concurrent_and_cursor_invariant'
cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/virtual-fs/Cargo.toml" \
	shared_positioned_read
listed_tests="$(cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/wasix/Cargo.toml" \
	--lib \
	--features wasmer/cranelift \
	live_shared_mapping_registry_blocks_backing_file_shrink \
	-- \
	--list)"
require_listed_test "$listed_tests" \
	'state::tests::live_shared_mapping_registry_blocks_backing_file_shrink'
cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/wasix/Cargo.toml" \
	--lib \
	--features wasmer/cranelift \
	state::tests::live_shared_mapping_registry_blocks_backing_file_shrink \
	-- \
	--exact
listed_tests="$(cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/wasix/Cargo.toml" \
	--lib \
	--features wasmer/cranelift \
	utils::store::tests \
	-- \
	--list)"
require_listed_tests "$listed_tests" \
	'utils::store::tests::sparse_snapshot_restores_imported_main_and_side_module_globals_to_fresh_store' \
	'utils::store::tests::sparse_snapshot_rejects_shape_mismatch_before_changing_any_global' \
	'utils::store::tests::const_heavy_store_allocation_scales_with_mutable_globals_only' \
	'utils::store::tests::persisted_unversioned_dense_snapshot_still_decodes_and_restores' \
	'utils::store::tests::capture_rejects_mutable_reference_global_before_raw_read' \
	'utils::store::tests::dense_restore_rejects_reference_shape_before_any_write'
cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/wasix/Cargo.toml" \
	--lib \
	--features wasmer/cranelift \
	utils::store::tests
listed_tests="$(cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/virtual-fs/Cargo.toml" \
	file_writeback \
	-- \
	--list)"
require_listed_test "$listed_tests" 'advice_tests::file_writeback_flags_preserve_the_linux_abi_bits'
require_listed_test "$listed_tests" 'advice_tests::virtual_file_writeback_defaults_to_unsupported'
cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/virtual-fs/Cargo.toml" \
	file_writeback
if [ "$(uname -s)" = Linux ]; then
	listed_tests="$(cargo test \
		--locked \
		--target-dir "$WASMER_TARGET_DIR" \
		--manifest-path "$WASMER_ROOT/lib/virtual-fs/Cargo.toml" \
		host_file_range_writeback \
		-- \
		--list)"
	require_listed_test "$listed_tests" 'host_fs::tests::host_file_range_writeback_uses_existing_descriptor_without_async_clone'
	require_listed_test "$listed_tests" 'host_fs::tests::host_file_range_writeback_rejects_unrepresentable_ranges'
	require_listed_test "$listed_tests" 'host_fs::tests::host_file_range_writeback_accepts_maximum_finite_boundary'
	cargo test \
		--locked \
		--target-dir "$WASMER_TARGET_DIR" \
		--manifest-path "$WASMER_ROOT/lib/virtual-fs/Cargo.toml" \
		host_file_range_writeback
fi
cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/wasix/Cargo.toml" \
	--lib \
	--no-default-features \
	--features sys-minimal,wasmer/cranelift \
	syscalls::wasi::fd_advise::tests
listed_tests="$(cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/wasix/Cargo.toml" \
	--lib \
	--no-default-features \
	--features sys-minimal,wasmer/cranelift \
	syscalls::wasix::fd_sync_range::tests \
	-- \
	--list)"
require_listed_test "$listed_tests" 'syscalls::wasix::fd_sync_range::tests::fd_sync_range_read_only_advice_right_is_accepted'
require_listed_test "$listed_tests" 'syscalls::wasix::fd_sync_range::tests::fd_sync_range_directory_is_badf'
require_listed_tests "$listed_tests" \
	'syscalls::wasix::fd_sync_range::tests::fd_sync_range_maps_all_exact_flag_combinations' \
	'syscalls::wasix::fd_sync_range::tests::fd_sync_range_rejects_negative_overflowing_and_unknown_ranges' \
	'syscalls::wasix::fd_sync_range::tests::fd_sync_range_preserves_zero_length_and_maximum_finite_range' \
	'syscalls::wasix::fd_sync_range::tests::fd_sync_range_maps_unsupported_backends_to_nosys'
if [ "$(uname -s)" = Linux ]; then
	require_listed_test "$listed_tests" \
		'syscalls::wasix::fd_sync_range::tests::fd_sync_range_preserves_linux_writeback_errnos'
fi
cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/wasix/Cargo.toml" \
	--lib \
	--no-default-features \
	--features sys-minimal,wasmer/cranelift \
	syscalls::wasix::fd_sync_range::tests
listed_tests="$(cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/wasix/Cargo.toml" \
	--lib \
	--no-default-features \
	--features sys-minimal,wasmer/cranelift \
	required_import_tests \
	-- \
	--list)"
require_listed_test "$listed_tests" 'required_import_tests::oliphaunt_postmaster_fd_sync_range_has_exact_versioned_abi'
require_listed_test "$listed_tests" 'required_import_tests::explicit_wasi_import_object_includes_versioned_postmaster_namespace'
cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/wasix/Cargo.toml" \
	--lib \
	--no-default-features \
	--features sys-minimal,wasmer/cranelift \
	required_import_tests
listed_tests="$(cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/wasix/Cargo.toml" \
	--lib \
	--no-default-features \
	--features sys-minimal,wasmer/cranelift \
	os::task::control_plane::tests \
	-- \
	--list)"
require_listed_test "$listed_tests" 'os::task::control_plane::tests::concurrent_parent_waiters_return_one_child_status'
require_listed_test "$listed_tests" 'os::task::control_plane::tests::concurrent_task_reservations_never_oversubscribe_limit'
require_listed_test "$listed_tests" 'os::task::control_plane::tests::duplicate_live_tid_is_rejected_without_count_or_slot_corruption'
require_listed_test "$listed_tests" 'os::task::control_plane::tests::main_thread_admission_failure_cannot_leave_published_process'
require_listed_test "$listed_tests" 'os::task::control_plane::tests::process_wait_status_has_exactly_one_concurrent_consumer'
require_listed_test "$listed_tests" 'os::task::control_plane::tests::public_process_construction_never_publishes_without_a_main_thread'
require_listed_test "$listed_tests" 'os::task::control_plane::tests::retirement_and_child_publication_linearize_without_leaking_permit'
require_listed_test "$listed_tests" 'os::task::control_plane::tests::retirement_seals_a_finished_process_against_new_threads'
require_listed_test "$listed_tests" 'os::task::control_plane::tests::tentative_process_is_invisible_and_abort_releases_last_object'
require_listed_test "$listed_tests" 'os::task::control_plane::tests::unpublished_process_guard_rolls_back_registry_and_parent_link'
require_listed_test "$listed_tests" 'os::task::control_plane::tests::child_adoption_rejects_a_permit_for_a_different_parent_without_panic'
require_listed_tests "$listed_tests" \
	'os::task::control_plane::tests::child_execution_admission_requires_exact_publication' \
	'os::task::control_plane::tests::failed_launch_rollback_waits_for_real_execution_quiescence' \
	'os::task::control_plane::tests::process_tree_barrier_waits_for_late_descendant_execution_quiescence' \
	'os::task::control_plane::tests::process_join_waits_for_pending_child_publication_ownership' \
	'os::task::control_plane::tests::execution_guard_publishes_terminal_before_quiescence' \
	'os::task::control_plane::tests::abandoned_host_execution_fails_closed_only_after_last_guard_clone' \
	'os::task::control_plane::tests::supplemental_parent_guard_requires_an_accepted_successor' \
	'os::task::control_plane::tests::repeated_parent_switch_guards_remain_bounded_without_a_task_successor' \
	'os::task::control_plane::tests::unrelated_task_or_thread_cannot_authorize_parent_guard_handoff' \
	'os::task::control_plane::tests::concurrent_guard_clones_have_one_linearizable_handoff_winner' \
	'os::task::control_plane::tests::abandoned_non_main_vfork_owner_terminalizes_whole_process_before_quiescence' \
	'os::task::control_plane::tests::vfork_parent_and_child_ownership_coexist_across_deep_sleep_handoffs' \
	'os::task::control_plane::tests::panicking_monitor_manager_terminates_and_reaps_before_quiescence'
cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/wasix/Cargo.toml" \
	--lib \
	--no-default-features \
	--features sys-minimal,wasmer/cranelift \
	os::task::control_plane::tests
listed_tests="$(cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/wasix/Cargo.toml" \
	--lib \
	--no-default-features \
	--features sys-minimal,wasmer/cranelift \
	state::env::tests \
	-- \
	--list)"
require_listed_test "$listed_tests" 'state::env::tests::reinit_rejects_a_running_epoch_without_mutation'
require_listed_test "$listed_tests" 'state::env::tests::reinit_rejects_live_background_thread_without_mutating_epoch'
require_listed_test "$listed_tests" 'state::env::tests::reinit_rejects_live_child_then_reaps_finished_child_exactly'
require_listed_test "$listed_tests" 'state::env::tests::reinit_cannot_cross_inflight_child_publication'
require_listed_test "$listed_tests" 'state::env::tests::repeated_reinit_uses_fresh_registered_epoch_and_plateaus_counts'
require_listed_test "$listed_tests" 'state::env::tests::sealed_epoch_is_terminal_after_later_reset_failure'
require_listed_test "$listed_tests" 'state::env::tests::public_fork_publishes_and_adopts_before_releasing_parent_permit'
require_listed_test "$listed_tests" 'state::env::tests::reinit_recursively_retires_finished_grandchildren'
require_listed_test "$listed_tests" 'state::env::tests::stale_environment_cannot_fork_or_start_threads_after_reinit'
require_listed_test "$listed_tests" 'state::env::tests::post_seal_main_thread_admission_failure_is_terminal_and_leak_free'
require_listed_tests "$listed_tests" \
	'state::env::tests::reinit_requires_terminal_status_and_execution_quiescence' \
	'state::env::tests::descendant_validation_failure_seals_no_process_in_tree' \
	'state::env::tests::repeated_child_construction_keeps_main_handle_owned_by_child' \
	'state::env::tests::retargeted_thread_clone_drops_calling_thread_execution_ownership' \
	'state::env::tests::swap_inner_uses_exact_physical_owner_for_immediate_and_deferred_restore'
cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/wasix/Cargo.toml" \
	--lib \
	--no-default-features \
	--features sys-minimal,wasmer/cranelift \
	state::env::tests
listed_tests="$(cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/wasix/Cargo.toml" \
	--lib \
	--no-default-features \
	--features sys-minimal,wasmer/cranelift \
	runtime::task_manager::lifecycle_tests \
	-- \
	--list)"
require_listed_tests "$listed_tests" \
	'runtime::task_manager::lifecycle_tests::canceled_task_wasm_terminalizes_exact_thread_before_quiescence' \
	'runtime::task_manager::lifecycle_tests::closed_worker_queue_drops_pending_execution_fail_closed' \
	'runtime::task_manager::lifecycle_tests::accepted_callback_conversion_is_the_only_successful_disarm' \
	'runtime::task_manager::lifecycle_tests::accepted_callback_panic_terminalizes_before_quiescence' \
	'runtime::task_manager::lifecycle_tests::rejected_successor_keeps_predecessor_until_fail_closed_drop' \
	'runtime::task_manager::lifecycle_tests::deep_sleep_handoff_keeps_thread_live_until_successor_guard_finishes'
cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/wasix/Cargo.toml" \
	--lib \
	--no-default-features \
	--features sys-minimal,wasmer/cranelift \
	runtime::task_manager::lifecycle_tests
listed_tests="$(cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/wasix/Cargo.toml" \
	--lib \
	--no-default-features \
	--features sys-minimal,wasmer/cranelift \
	runtime::task_manager::tokio::tests \
	-- \
	--list)"
require_listed_tests "$listed_tests" \
	'runtime::task_manager::tokio::tests::non_core_workers_retire_after_the_idle_timeout' \
	'runtime::task_manager::tokio::tests::memory_construction_failure_terminalizes_before_releasing_lease' \
	'runtime::task_manager::tokio::tests::instantiation_failure_terminalizes_before_releasing_lease' \
	'runtime::task_manager::tokio::tests::panicking_custom_task_wasm_callback_terminalizes_before_quiescence' \
	'runtime::task_manager::tokio::tests::accepted_restored_process_adopts_its_single_deferred_parent_guard' \
	'runtime::task_manager::tokio::tests::task_wasm_constructor_binds_owner_before_manager_instantiation' \
	'runtime::task_manager::tokio::tests::foreign_pending_token_cannot_accept_same_guest_thread' \
	'runtime::task_manager::tokio::tests::pending_task_drop_with_deferred_owner_is_fail_closed_and_bounded' \
	'runtime::task_manager::tokio::tests::module_start_observes_child_parent_after_exact_publication'
cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/wasix/Cargo.toml" \
	--lib \
	--no-default-features \
	--features sys-minimal,wasmer/cranelift \
	runtime::task_manager::tokio::tests
listed_tests="$(cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/wasix/Cargo.toml" \
	--lib \
	--no-default-features \
	--features sys-minimal,wasmer/cranelift \
	bin_factory::exec::lifecycle_tests \
	-- \
	--list)"
require_listed_test "$listed_tests" \
	'bin_factory::exec::lifecycle_tests::run_exec_panic_terminalizes_before_releasing_accepted_guard'
cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/wasix/Cargo.toml" \
	--lib \
	--no-default-features \
	--features sys-minimal,wasmer/cranelift \
	bin_factory::exec::lifecycle_tests
listed_tests="$(cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/wasix/Cargo.toml" \
	--lib \
	--no-default-features \
	--features sys-minimal,wasmer/cranelift \
	syscalls::wasix::proc_signal::tests \
	-- \
	--list)"
require_listed_tests "$listed_tests" \
	'syscalls::wasix::proc_signal::tests::absent_pid_returns_srch_for_liveness_probe' \
	'syscalls::wasix::proc_signal::tests::signal_zero_observes_existing_pid_without_delivery' \
	'syscalls::wasix::proc_signal::tests::real_signal_delivery_is_unchanged'
cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/wasix/Cargo.toml" \
	--lib \
	--no-default-features \
	--features sys-minimal,wasmer/cranelift \
	syscalls::wasix::proc_signal::tests
listed_tests="$(cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/wasix/Cargo.toml" \
	--lib \
	--no-default-features \
	--features sys-minimal,wasmer/cranelift \
	state::tests \
	-- \
	--list)"
require_listed_tests "$listed_tests" \
	'state::tests::shared_memory_mapping_splits_reuse_futex_registry' \
	'state::tests::shared_futex_registry_uses_containing_mapping_only' \
	'state::tests::shared_file_identity_survives_file_clone' \
	'state::tests::shared_futex_registry_reuses_same_live_file' \
	'state::tests::shared_futex_registry_pins_file_identity_until_last_live_reference' \
	'state::tests::shared_futex_registry_replaces_entry_after_last_live_drop' \
	'state::tests::shared_futex_registry_last_drop_racing_lookup_keeps_exact_replacement' \
	'state::tests::forked_states_share_mapping_registry_and_return_to_zero_plateau' \
	'state::tests::repeated_shared_futex_registry_churn_returns_to_slot_and_fd_plateau' \
	'state::tests::shared_futex_registry_old_generation_cannot_remove_replacement' \
	'state::tests::shared_futex_registry_prunes_stale_slots_in_bounded_order'
cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/wasix/Cargo.toml" \
	--lib \
	--no-default-features \
	--features sys-minimal,wasmer/cranelift \
	state::tests
listed_tests="$(cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/wasix/Cargo.toml" \
	--lib \
	--no-default-features \
	--features sys-minimal,wasmer/cranelift,ctrlc \
	os::task::task_join_handle::tests \
	-- \
	--list)"
require_listed_test "$listed_tests" \
	'os::task::task_join_handle::tests::direct_signal_controller_is_platform_neutral_and_rejects_finished_tasks'
if [ "$(uname -s)" = Linux ]; then
	require_listed_test "$listed_tests" \
		'os::task::task_join_handle::tests::unix_supervisor_real_signals_restore_and_route_exclusively'
fi
cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/wasix/Cargo.toml" \
	--lib \
	--no-default-features \
	--features sys-minimal,wasmer/cranelift,ctrlc \
	os::task::task_join_handle::tests \
	-- \
	--test-threads=1
listed_tests="$(cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/wasix/Cargo.toml" \
	--lib \
	--no-default-features \
	--features sys-minimal,wasmer/cranelift,ctrlc \
		runners::wasi:: \
	-- \
	--list)"
require_listed_tests "$listed_tests" \
	'runners::wasi::host_lifecycle_tests::wasi_runner_never_owns_host_lifecycle_by_default' \
	'runners::wasi::host_lifecycle_tests::lifecycle_bind_failure_kills_and_reaps_spawned_root' \
	'runners::wasi::host_lifecycle_tests::bind_panic_terminates_and_reaps_spawned_root' \
	'runners::wasi::host_lifecycle_tests::dropping_admitted_watcher_terminates_and_reaps_spawned_root' \
	'runners::wasi::tests::direct_root_spawn_has_no_effect_before_watcher_admission'
cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/wasix/Cargo.toml" \
	--lib \
	--no-default-features \
	--features sys-minimal,wasmer/cranelift,ctrlc \
		runners::wasi::
listed_tests="$(cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/wasix/Cargo.toml" \
	--lib \
	--no-default-features \
	--features sys-minimal,wasmer/cranelift \
	syscalls::wasix::proc_join::tests \
	-- \
	--list)"
require_listed_test "$listed_tests" 'syscalls::wasix::proc_join::tests::any_child_blocking_wait_returns_one_serializable_claim'
require_listed_test "$listed_tests" 'syscalls::wasix::proc_join::tests::blocking_join_payload_survives_beyond_the_deep_sleep_threshold'
require_listed_test "$listed_tests" 'syscalls::wasix::proc_join::tests::explicit_blocking_wait_claims_and_reaps_before_serialization'
cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/wasix/Cargo.toml" \
	--lib \
	--no-default-features \
	--features sys-minimal,wasmer/cranelift \
	syscalls::wasix::proc_join::tests
listed_tests="$(cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/wasix/Cargo.toml" \
	--lib \
	--no-default-features \
	--features sys-minimal,wasmer/cranelift \
	fs::fd_list::tests::renumber \
	-- \
	--list)"
require_listed_test "$listed_tests" 'fs::fd_list::tests::renumber_is_an_atomic_move_and_preserves_source_descriptor_ownership'
require_listed_test "$listed_tests" 'fs::fd_list::tests::renumber_keeps_epoll_watch_until_moved_descriptor_final_close'
cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/wasix/Cargo.toml" \
	--lib \
	--no-default-features \
	--features sys-minimal,wasmer/cranelift \
	fs::fd_list::tests::renumber
listed_tests="$(cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/wasix/Cargo.toml" \
	--lib \
	--no-default-features \
	--features sys-minimal,wasmer/cranelift \
	epoll \
	-- \
	--list)"
require_listed_test "$listed_tests" 'os::epoll::tests::failed_older_mod_cannot_rollback_over_later_subscription'
require_listed_test "$listed_tests" 'os::epoll::tests::ofd_aware_keys_allow_dup_backed_old_watch_and_reused_numeric_fd'
require_listed_test "$listed_tests" 'syscalls::wasix::epoll_ctl::tests::failed_mod_rebuilds_active_old_subscription_with_fresh_identity'
cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/wasix/Cargo.toml" \
	--lib \
	--no-default-features \
	--features sys-minimal,wasmer/cranelift \
	epoll
cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/api/Cargo.toml" \
	--test memory \
	--no-default-features \
	--features sys,headless \
	private_file_remap_preserves_memory_base_growth_and_mapping_lifetime \
	-- \
	--exact
cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/Cargo.toml" \
	--test compilers \
	--features test-llvm \
	issues::llvm_rotates_and_atomic_fence_emit_expected_ir \
	-- \
	--exact
listed_tests="$(cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/Cargo.toml" \
	--test compilers \
	--features test-llvm \
	wast::spec::data_drop0::llvm::llvm \
	-- \
	--list)"
require_listed_test "$listed_tests" 'wast::spec::data_drop0::llvm::llvm'
cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/Cargo.toml" \
	--test compilers \
	--features test-llvm \
	wast::spec::data_drop0::llvm::llvm \
	-- \
	--exact
listed_tests="$(cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/Cargo.toml" \
	--test compilers \
	--features test-llvm \
	wast::spec::memory_init::llvm::llvm \
	-- \
	--list)"
require_listed_test "$listed_tests" 'wast::spec::memory_init::llvm::llvm'
cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/Cargo.toml" \
	--test compilers \
	--features test-llvm \
	wast::spec::memory_init::llvm::llvm \
	-- \
	--exact
listed_tests="$(cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/oliphaunt-wasix-postmaster-executor/Cargo.toml" \
	--lib \
	--no-default-features \
	--features "$FRESH_POSTMASTER_EXECUTOR_FEATURES" \
	sealed::tests::runtime_policy_identity_ \
	-- \
	--list)"
require_listed_tests "$listed_tests" \
	'sealed::tests::runtime_policy_identity_requires_the_exact_postmaster_closure' \
	'sealed::tests::runtime_policy_identity_parser_rejects_unknown_manifest_fields' \
	'sealed::tests::runtime_policy_identity_selects_only_product_executables'
cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/oliphaunt-wasix-postmaster-executor/Cargo.toml" \
	--lib \
	--no-default-features \
	--features "$FRESH_POSTMASTER_EXECUTOR_FEATURES" \
	sealed::tests::runtime_policy_identity_
listed_tests="$(cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/oliphaunt-wasix-postmaster-executor/Cargo.toml" \
	--lib \
	--no-default-features \
	--features cranelift,wat \
	sealed::tests::selected_only_activation_and_success_are_single_flight \
	-- \
	--list)"
require_listed_test "$listed_tests" \
	'sealed::tests::selected_only_activation_and_success_are_single_flight'
cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/oliphaunt-wasix-postmaster-executor/Cargo.toml" \
	--lib \
	--no-default-features \
	--features cranelift,wat \
	sealed::tests::selected_only_activation_and_success_are_single_flight \
	-- \
	--exact
cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/oliphaunt-wasix-postmaster-executor/Cargo.toml" \
	--bin "$FRESH_START_PROOF_BINARY" \
	--no-default-features \
	--features "$FRESH_START_PROOF_FEATURES"
listed_tests="$(cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/cli/Cargo.toml" \
	--lib \
	--no-default-features \
	--features "$FRESH_WASMER_HEADLESS_FEATURES" \
	commands::run::runtime::tests \
	-- \
	--list)"
require_listed_tests "$listed_tests" \
	'commands::run::runtime::tests::sealed_postmaster_policy_id_and_worker_configuration_are_stable' \
	'commands::run::runtime::tests::sealed_postmaster_runtime_has_exactly_two_tokio_workers' \
	'commands::run::runtime::tests::generic_runtime_policy_retains_tokio_default_worker_selection'
cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/cli/Cargo.toml" \
	--lib \
	--no-default-features \
	--features "$FRESH_WASMER_HEADLESS_FEATURES" \
	commands::run::runtime::tests
listed_tests="$(cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/cli/Cargo.toml" \
	--lib \
	--no-default-features \
	--features "$FRESH_WASMER_HEADLESS_FEATURES" \
	commands::run::tests \
	-- \
	--list)"
require_listed_tests "$listed_tests" \
	'commands::run::tests::headless_stack_size_sets_vm_and_guest_limit'
cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/cli/Cargo.toml" \
	--lib \
	--no-default-features \
	--features "$FRESH_WASMER_HEADLESS_FEATURES" \
	commands::run::tests
listed_tests="$(cargo test \
	--locked \
	--target-dir "$POSTMASTER_EXECUTOR_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/Cargo.toml" \
	--package "$FRESH_POSTMASTER_EXECUTOR_PACKAGE" \
	--no-default-features \
	--features "$FRESH_POSTMASTER_EXECUTOR_FEATURES" \
	-- \
	--list)"
require_listed_tests "$listed_tests" \
	'args::tests::parses_the_complete_closed_product_contract' \
	'args::tests::denies_unknown_generic_wasmer_options' \
	'args::tests::required_abi_and_cache_assertions_fail_closed' \
	'execute::tests::product_runtime_policy_is_declared_at_the_execution_boundary' \
	'execute::tests::product_runner_applies_the_same_guest_and_host_task_budget' \
	'runtime::tests::blocking_worker_growth_is_bounded_by_the_host_task_budget' \
	'runtime::tests::runtime_policy_identity_is_stable' \
	'runtime::tests::runtime_has_exactly_two_tokio_workers'
cargo test \
	--locked \
	--target-dir "$POSTMASTER_EXECUTOR_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/Cargo.toml" \
	--package "$FRESH_POSTMASTER_EXECUTOR_PACKAGE" \
	--no-default-features \
	--features "$FRESH_POSTMASTER_EXECUTOR_FEATURES"
cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/api/Cargo.toml" \
	--test module \
	serialized_artifact_inspector
cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/api/Cargo.toml" \
	--test module \
	detached_module_executes_from_strict_relocated_regular_file_code_memory \
	-- \
	--exact
cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/api/Cargo.toml" \
	--test instance \
	selectively_materialized_exports_remain_available_by_module_identity \
	-- \
	--exact
listed_tests="$(cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/api/Cargo.toml" \
	--test instance \
	--no-default-features \
	--features sys,llvm,wat \
	passive_data_ \
	-- \
	--list)"
require_listed_test "$listed_tests" 'passive_data_drop_is_local_to_each_instance'
require_listed_test "$listed_tests" 'passive_data_memory_init_preserves_contents_and_bounds'
cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/api/Cargo.toml" \
	--test instance \
	--no-default-features \
	--features sys,llvm,wat \
	passive_data_drop_is_local_to_each_instance \
	-- \
	--exact
cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/api/Cargo.toml" \
	--test instance \
	--no-default-features \
	--features sys,llvm,wat \
	passive_data_memory_init_preserves_contents_and_bounds \
	-- \
	--exact
cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/api/Cargo.toml" \
	--test module \
	--no-default-features \
	--features sys,llvm,wat \
	detached_artifact_passive_data_has_instance_local_drop_state \
	-- \
	--exact
cargo test \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/api/Cargo.toml" \
	--test module \
	detached_mmapped_module_executes_without_retaining_serializable_state \
	-- \
	--exact
listed_tests="$(cargo test \
	--locked \
	--target-dir "$POSTMASTER_EXECUTOR_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/Cargo.toml" \
	--package "$FRESH_POSTMASTER_EXECUTOR_PACKAGE" \
	--lib \
	--no-default-features \
	--features "$FRESH_MEMORY_PROFILE_FEATURES" \
	memory_profile::wasm_tool::tests \
	-- \
	--list)"
require_listed_tests "$listed_tests" \
	'memory_profile::wasm_tool::tests::exact_width_u32_leb_encoding_fails_closed' \
	'memory_profile::wasm_tool::tests::invalid_memory_import_shapes_fail_closed' \
	'memory_profile::wasm_tool::tests::sealer_changes_only_the_explicit_memory_maximum' \
	'memory_profile::wasm_tool::tests::sealer_preserves_relocation_width_immediates' \
	'memory_profile::wasm_tool::tests::selected_profile_is_strictly_below_wasm32_end_wrap'
cargo test \
	--locked \
	--target-dir "$POSTMASTER_EXECUTOR_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/Cargo.toml" \
	--package "$FRESH_POSTMASTER_EXECUTOR_PACKAGE" \
	--lib \
	--no-default-features \
	--features "$FRESH_MEMORY_PROFILE_FEATURES" \
	memory_profile::wasm_tool::tests
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
