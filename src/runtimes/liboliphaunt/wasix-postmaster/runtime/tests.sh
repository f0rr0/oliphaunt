#!/usr/bin/env bash
# Sourced by bin/build-runtime.sh --tests-only after preparing the pinned runtime.

run_tests() {
	local log
	log="$(mktemp)"
	if ! cargo test "$@" --color never 2>&1 | tee "$log"; then
		rm -f "$log"
		return 1
	fi
	if ! grep -Eq '^test result: ok\. [1-9][0-9]* passed;' "$log"; then
		printf 'runtime test selection ran no tests: %s\n' "$*" >&2
		rm -f "$log"
		return 1
	fi
	rm -f "$log"
}

run_tests \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/vm/Cargo.toml" \
	-- \
	remap_shared_file_fixed_replaces_only_requested_pages \
	remap_shared_file_fixed_accepts_a_partial_final_file_page \
	remap_private_file_fixed_shares_clean_bytes_but_isolates_writes \
	immutable_function_tables_are_shared_by_two_instances \
	shared_function_tables_outlive_artifact_owner_and_peer_instance
run_tests \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/vm/Cargo.toml" \
	-- \
	--exact \
	instance::allocator::tests::cached_offsets_produce_the_same_allocator_layout \
	trap::traphandlers::tests::tls_stack_reuses_mapping_without_global_queue
if [ "$(uname -s)-$(uname -m)" = Linux-x86_64 ]; then
	run_tests \
		--locked \
		--target-dir "$WASMER_TARGET_DIR" \
		--manifest-path "$WASMER_ROOT/lib/compiler/Cargo.toml" \
		-- \
		--exact \
		engine::code_memory::tests::strict_linux_x86_64::relocated_regular_file_preserves_base_bytes_permissions_and_execution
fi
run_tests \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/compiler/Cargo.toml" \
	--lib \
	-- \
	engine::trap::frame_info::tests
run_tests \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/wasix/Cargo.toml" \
	--lib \
	--no-default-features \
	--features sys-minimal,wasmer/cranelift \
	-- \
	shared_memory_mapping \
	state::linker::dynamic_instance_export_tests \
	state::linker::single_slot_broadcast_tests \
	runtime::sealed_loader_audit::tests \
	state::preinitialized_memory_image::tests \
	syscalls::wasix::path_open2::tests \
	syscalls::wasi::fd_advise::tests \
	syscalls::wasix::fd_sync_range::tests \
	required_import_tests \
	os::task::control_plane::tests \
	state::env::tests \
	runtime::task_manager::lifecycle_tests \
	runtime::task_manager::tokio::tests \
	bin_factory::exec::lifecycle_tests \
	syscalls::wasix::proc_signal::tests \
	state::tests \
	syscalls::wasix::proc_join::tests \
	fs::fd_list::tests::renumber \
	epoll
run_tests \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/wasix/Cargo.toml" \
	--lib \
	--no-default-features \
	--features sys-minimal,host-fs,wasmer/cranelift \
	-- \
	--exact \
	fs::tests::host_file_size_refresh_observes_another_process_extension
run_tests \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/virtual-fs/Cargo.toml" \
	-- \
	host_file_defers_async_descriptor_until_async_io_is_requested \
	file_advice \
	shared_positioned_read \
	file_writeback
run_tests \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/wasix/Cargo.toml" \
	--lib \
	--features wasmer/cranelift \
	-- \
	--exact \
	state::tests::live_shared_mapping_registry_blocks_backing_file_shrink
run_tests \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/wasix/Cargo.toml" \
	--lib \
	--features wasmer/cranelift \
	-- \
	utils::store::tests
if [ "$(uname -s)" = Linux ]; then
	run_tests \
		--locked \
		--target-dir "$WASMER_TARGET_DIR" \
		--manifest-path "$WASMER_ROOT/lib/virtual-fs/Cargo.toml" \
		-- \
		host_file_range_writeback
fi
run_tests \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/wasix/Cargo.toml" \
	--lib \
	--no-default-features \
	--features sys-minimal,wasmer/cranelift,ctrlc \
	-- \
	--test-threads=1 \
	os::task::task_join_handle::tests
run_tests \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/wasix/Cargo.toml" \
	--lib \
	--no-default-features \
	--features sys-minimal,wasmer/cranelift,ctrlc \
	-- \
	runners::wasi::
run_tests \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/api/Cargo.toml" \
	--test memory \
	--no-default-features \
	--features sys,headless \
	-- \
	--exact \
	private_file_remap_preserves_memory_base_growth_and_mapping_lifetime
run_tests \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/Cargo.toml" \
	--test compilers \
	--features test-llvm \
	-- \
	--exact \
	issues::llvm_rotates_and_atomic_fence_emit_expected_ir \
	wast::spec::data_drop0::llvm::llvm \
	wast::spec::memory_init::llvm::llvm
run_tests \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/oliphaunt-wasix-postmaster-executor/Cargo.toml" \
	--lib \
	--no-default-features \
	--features "$FRESH_POSTMASTER_EXECUTOR_FEATURES" \
	-- \
	sealed::tests::runtime_policy_identity_
run_tests \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/oliphaunt-wasix-postmaster-executor/Cargo.toml" \
	--lib \
	--no-default-features \
	--features cranelift,wat \
	-- \
	--exact \
	sealed::tests::selected_only_activation_and_success_are_single_flight
run_tests \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/oliphaunt-wasix-postmaster-executor/Cargo.toml" \
	--bin "$FRESH_START_PROOF_BINARY" \
	--no-default-features \
	--features "$FRESH_START_PROOF_FEATURES" \
	--
run_tests \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/cli/Cargo.toml" \
	--lib \
	--no-default-features \
	--features "$FRESH_WASMER_HEADLESS_FEATURES" \
	-- \
	commands::run::runtime::tests \
	commands::run::tests
run_tests \
	--locked \
	--target-dir "$POSTMASTER_EXECUTOR_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/Cargo.toml" \
	--package "$FRESH_POSTMASTER_EXECUTOR_PACKAGE" \
	--no-default-features \
	--features "$FRESH_POSTMASTER_EXECUTOR_FEATURES" \
	--
run_tests \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/api/Cargo.toml" \
	--test module \
	-- \
	serialized_artifact_inspector
run_tests \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/api/Cargo.toml" \
	--test module \
	-- \
	--exact \
	detached_module_executes_from_strict_relocated_regular_file_code_memory \
	detached_mmapped_module_executes_without_retaining_serializable_state
run_tests \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/api/Cargo.toml" \
	--test instance \
	-- \
	--exact \
	selectively_materialized_exports_remain_available_by_module_identity
run_tests \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/api/Cargo.toml" \
	--test instance \
	--no-default-features \
	--features sys,llvm,wat \
	-- \
	--exact \
	passive_data_drop_is_local_to_each_instance \
	passive_data_memory_init_preserves_contents_and_bounds
run_tests \
	--locked \
	--target-dir "$WASMER_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/lib/api/Cargo.toml" \
	--test module \
	--no-default-features \
	--features sys,llvm,wat \
	-- \
	--exact \
	detached_artifact_passive_data_has_instance_local_drop_state
run_tests \
	--locked \
	--target-dir "$POSTMASTER_EXECUTOR_TARGET_DIR" \
	--manifest-path "$WASMER_ROOT/Cargo.toml" \
	--package "$FRESH_POSTMASTER_EXECUTOR_PACKAGE" \
	--lib \
	--no-default-features \
	--features "$FRESH_MEMORY_PROFILE_FEATURES" \
	-- \
	memory_profile::wasm_tool::tests
