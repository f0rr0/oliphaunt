#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$PROJECT_ROOT/../../../.." && pwd)"
RESEARCH_DOCS_ROOT="$REPO_ROOT/docs/internal/wasix-postmaster"
PATCH_ROOT="$PROJECT_ROOT/postgres/patches"
SERIES_FILE="$PATCH_ROOT/series"
MAIN_OPTIMIZATION_PATCH_ROOT="$REPO_ROOT/src/runtimes/liboliphaunt/wasix/assets/build/postgres/patches"
MAIN_OPTIMIZATION_SERIES="$PROJECT_ROOT/postgres/main-optimizations.series"
FORK_OVERLAY="$PROJECT_ROOT/postgres/overlays/wasix-core/src/backend/postmaster/fork_process.c"
PORT_OVERLAY="$PROJECT_ROOT/postgres/overlays/wasix-core/src/include/port/wasix-core.h"
SYSV_SHMEM_OVERLAY="$PROJECT_ROOT/postgres/overlays/wasix-core/src/backend/port/sysv_shmem.c"
CHECK_TEMP="$(mktemp -d)"
trap 'rm -rf -- "$CHECK_TEMP"' EXIT HUP INT TERM

fail() {
  printf 'wasix-postmaster check: %s\n' "$*" >&2
  exit 1
}

require_text() {
  local path="$1"
  local expected="$2"
  grep -Fq -- "$expected" "$path" || fail "$path must contain: $expected"
}

forbid_text() {
  local path="$1"
  local forbidden="$2"
  if grep -Fq -- "$forbidden" "$path"; then
    fail "$path must not contain: $forbidden"
  fi
}

require_text_before() {
  local path="$1"
  local required="$2"
  local later="$3"
  local required_line
  local later_line

  required_line="$(grep -nF -m1 -- "$required" "$path" | cut -d: -f1 || true)"
  later_line="$(grep -nF -m1 -- "$later" "$path" | cut -d: -f1 || true)"
  [ -n "$required_line" ] || fail "$path must contain: $required"
  [ -n "$later_line" ] || fail "$path must contain: $later"
  [ "$required_line" -lt "$later_line" ] ||
    fail "$path must check '$required' before '$later'"
}

require_adjacent_lines() {
  local path="$1"
  local first="$2"
  local second="$3"

  awk -v first="$first" -v second="$second" '
    previous == first && $0 == second { found = 1 }
    { previous = $0 }
    END { exit(found ? 0 : 1) }
  ' "$path" || fail "$path must contain adjacent lines: $first / $second"
}

require_moon_task_text() {
  local task="$1"
  local expected="$2"

  awk -v task="  $task:" -v expected="$expected" '
    /^  [[:alnum:]][[:alnum:]-]*:$/ { in_task = ($0 == task) }
    in_task && index($0, expected) { found = 1 }
    END { exit(found ? 0 : 1) }
  ' "$PROJECT_ROOT/moon.yml" ||
    fail "moon task $task must contain: $expected"
}

"$REPO_ROOT/tools/dev/bun.sh" "$REPO_ROOT/tools/policy/fetch-sources.mjs" \
  wasix-postmaster-runtime --validate-only ||
  fail "research source policy validation failed"

for required in \
  "$PROJECT_ROOT/README.md" \
  "$RESEARCH_DOCS_ROOT/architecture.md" \
  "$RESEARCH_DOCS_ROOT/libpq-latency-qualification.md" \
  "$RESEARCH_DOCS_ROOT/checkpoint-recycle-qualification.md" \
  "$RESEARCH_DOCS_ROOT/cold-ownership-qualification.md" \
  "$RESEARCH_DOCS_ROOT/shared-memory-backing-experiment.md" \
  "$RESEARCH_DOCS_ROOT/sealed-export-closure.md" \
  "$RESEARCH_DOCS_ROOT/semantic-cache-offers.md" \
  "$RESEARCH_DOCS_ROOT/semantic-wal-cache-offers.md" \
  "$RESEARCH_DOCS_ROOT/replay-status.md" \
  "$PROJECT_ROOT/postgres/product-patch-provenance.toml" \
  "$PROJECT_ROOT/postgres/experiment-patch-disposition.toml" \
  "$MAIN_OPTIMIZATION_SERIES" \
  "$FORK_OVERLAY" \
  "$PORT_OVERLAY" \
  "$SYSV_SHMEM_OVERLAY" \
  "$PROJECT_ROOT/sources.lock.toml" \
  "$PROJECT_ROOT/moon.yml" \
  "$SERIES_FILE" \
  "$PATCH_ROOT/0006-wasix-retry-proc-join-on-eintr.patch" \
  "$PATCH_ROOT/0007-wasix-semantic-relation-cache-offers.patch" \
  "$PATCH_ROOT/0007-wasix-semantic-relation-cache-offers.test.py" \
  "$PATCH_ROOT/0008-wasix-packed-atomic-latch-state.patch" \
  "$PATCH_ROOT/0008-wasix-packed-atomic-latch-state.test.py" \
  "$PATCH_ROOT/0009-wasix-inactive-durable-wal-cache-offer.patch" \
  "$PATCH_ROOT/0009-wasix-inactive-durable-wal-cache-offer.test.py" \
  "$PROJECT_ROOT/runtime/capabilities.tsv" \
  "$PROJECT_ROOT/runtime/bin/build-runtime.sh" \
  "$PROJECT_ROOT/runtime/patches/wasmer/0001-postgres-wasix-blockers.patch" \
  "$PROJECT_ROOT/runtime/bin/prepare-upstream-checkouts.sh" \
  "$PROJECT_ROOT/runtime/bin/verify-source-lock.py" \
  "$PROJECT_ROOT/runtime/bin/verify-source-lock.test.py" \
  "$PROJECT_ROOT/runtime/bin/verify-runtime-state-ownership.py" \
  "$PROJECT_ROOT/runtime/bin/verify-runtime-state-ownership.test.py" \
  "$PROJECT_ROOT/runtime/bin/verify-runtime-execution-ownership.py" \
  "$PROJECT_ROOT/runtime/bin/verify-runtime-execution-ownership.test.py" \
  "$PROJECT_ROOT/runtime/bin/verify-postmaster-wasm-import.py" \
  "$PROJECT_ROOT/runtime/bin/verify-postmaster-wasm-import.test.py" \
  "$PROJECT_ROOT/runtime/bin/verify-postmaster-concurrency-contract.py" \
  "$PROJECT_ROOT/runtime/bin/verify-postmaster-concurrency-contract.test.py" \
  "$PROJECT_ROOT/runtime/policies/sealed-main-runtime-exports.v1.txt" \
  "$PROJECT_ROOT/runtime/policies/sealed-main-dlsym-exports.v1.txt" \
  "$PROJECT_ROOT/runtime/policies/sealed-side-modules.v1.tsv" \
  "$PROJECT_ROOT/tools/sealed-export-closure/Cargo.toml" \
  "$PROJECT_ROOT/tools/sealed-export-closure/Cargo.lock" \
  "$PROJECT_ROOT/tools/sealed-export-closure/src/main.rs" \
  "$PROJECT_ROOT/bin/build-wasix-core.sh" \
  "$PROJECT_ROOT/bin/wasix-make.sh" \
  "$PROJECT_ROOT/bin/regress-suite-name.test.sh" \
  "$PROJECT_ROOT/bin/postgres-baseline.test.sh" \
  "$PROJECT_ROOT/bin/build-wasix-core.backend.test.sh" \
  "$PROJECT_ROOT/bin/seal-wasix-core-exports.sh" \
  "$PROJECT_ROOT/bin/seal-wasix-core-exports.test.sh" \
  "$PROJECT_ROOT/bin/seal-wasix-core-exports.transaction.test.sh" \
  "$PROJECT_ROOT/bin/build-sealed-headless-carrier.sh" \
  "$PROJECT_ROOT/bin/build-sealed-headless-carrier.test.sh" \
  "$PROJECT_ROOT/bin/precompile-wasix-core.sh" \
  "$PROJECT_ROOT/bin/seal-wasix-linear-memory.sh" \
  "$PROJECT_ROOT/bin/seal-wasix-linear-memory.test.sh" \
  "$PROJECT_ROOT/lib/verify-sealed-carrier.test.py" \
  "$PROJECT_ROOT/lib/durable_publication.py" \
  "$PROJECT_ROOT/lib/durable_publication.test.py" \
  "$PROJECT_ROOT/lib/durable_publication_crash.test.py" \
  "$PROJECT_ROOT/lib/cold_ownership_schema.py" \
  "$PROJECT_ROOT/lib/guest_build_provenance.py" \
  "$PROJECT_ROOT/lib/guest_build_provenance.test.py" \
  "$PROJECT_ROOT/lib/linear_memory_transaction.py" \
  "$PROJECT_ROOT/lib/linear_memory_transaction.test.py" \
  "$PROJECT_ROOT/lib/sealed_export_chain.py" \
  "$PROJECT_ROOT/lib/sealed_export_chain.test.py" \
  "$PROJECT_ROOT/bin/current-evidence-manifest.py" \
  "$PROJECT_ROOT/bin/run-frozen-measurement.py" \
  "$PROJECT_ROOT/bin/run-frozen-measurement.test.py" \
  "$PROJECT_ROOT/bin/bench-wasix-concurrent-query-suite.sh" \
  "$PROJECT_ROOT/bin/bench-shared-memory-provider-options.test.sh" \
  "$PROJECT_ROOT/bin/bench-memory-budget-options.test.sh" \
  "$PROJECT_ROOT/bin/prove-linux-cold-residency.py" \
  "$PROJECT_ROOT/bin/capture-linux-cgroup-v2.py" \
  "$PROJECT_ROOT/bin/classify-linux-file-residency.py" \
  "$PROJECT_ROOT/bin/classify-linux-file-residency.test.py" \
  "$PROJECT_ROOT/bin/validate-sealed-loader-audit.py" \
  "$PROJECT_ROOT/bin/validate-sealed-loader-audit.test.py" \
  "$PROJECT_ROOT/bin/validate-file-cache-telemetry.py" \
  "$PROJECT_ROOT/bin/validate-file-cache-telemetry.test.py" \
  "$PROJECT_ROOT/bin/validate-adaptive-file-cache-telemetry.py" \
  "$PROJECT_ROOT/bin/validate-adaptive-file-cache-telemetry.test.py" \
  "$PROJECT_ROOT/bin/validate-wasix-cold-ownership.py" \
  "$PROJECT_ROOT/bin/summarize-wasix-cold-ownership.py" \
  "$PROJECT_ROOT/bin/cold-ownership.test.py" \
  "$PROJECT_ROOT/bin/qualify-wasix-cold-ownership.sh" \
  "$PROJECT_ROOT/bin/qualify-wasix-cold-ownership.test.sh" \
  "$PROJECT_ROOT/bin/compare-postgres-settings.py" \
  "$PROJECT_ROOT/bin/compare-postgres-settings.test.py" \
  "$PROJECT_ROOT/bin/delta-pg-stat-io.py" \
  "$PROJECT_ROOT/bin/delta-pg-stat-io.test.py" \
  "$PROJECT_ROOT/bin/resource-evidence.test.sh" \
  "$PROJECT_ROOT/bin/resource-monitor-race-retry.test.sh" \
  "$PROJECT_ROOT/bin/process-tree-collector.test.sh" \
  "$PROJECT_ROOT/bin/connected-client-gate.test.sh" \
  "$PROJECT_ROOT/bin/smoke-wasix-concurrent-options.test.sh" \
  "$PROJECT_ROOT/bin/summarize-libpq-latency.sh" \
  "$PROJECT_ROOT/bin/summarize-libpq-latency.test.sh" \
  "$PROJECT_ROOT/bin/compare-libpq-latency.py" \
  "$PROJECT_ROOT/bin/compare-libpq-latency.test.py" \
  "$PROJECT_ROOT/bin/validate-host-fd-churn.sh" \
  "$PROJECT_ROOT/bin/validate-host-fd-churn.test.sh" \
  "$PROJECT_ROOT/bin/validate-memory-evidence.sh" \
  "$PROJECT_ROOT/bin/validate-memory-evidence.test.sh" \
  "$PROJECT_ROOT/bin/validate-wasix-lifecycle-plateau.py" \
  "$PROJECT_ROOT/bin/validate-wasix-lifecycle-plateau.test.py" \
  "$PROJECT_ROOT/bin/validate-wasix-lifecycle-memory-plateau.py" \
  "$PROJECT_ROOT/bin/validate-wasix-lifecycle-memory-plateau.test.py" \
  "$PROJECT_ROOT/bin/lifecycle-memory-checkpoint.test.sh" \
  "$PROJECT_ROOT/bin/freeze-wasix-lifecycle-evidence.py" \
  "$PROJECT_ROOT/bin/freeze-wasix-lifecycle-evidence.test.py" \
  "$PROJECT_ROOT/bin/freeze-wasix-lifecycle-policy.py" \
  "$PROJECT_ROOT/bin/freeze-wasix-lifecycle-policy.test.py" \
  "$PROJECT_ROOT/bin/qualify-wasix-single-backend.sh" \
  "$PROJECT_ROOT/bin/qualify-wasix-single-backend.test.sh" \
  "$PROJECT_ROOT/bin/qualify-wasix-libpq-latency.sh" \
  "$PROJECT_ROOT/bin/qualify-wasix-libpq-latency.test.sh" \
  "$PROJECT_ROOT/bin/qualify-wasix-immediate-recovery.sh" \
  "$PROJECT_ROOT/bin/qualify-wasix-immediate-recovery.test.sh" \
  "$PROJECT_ROOT/bin/qualify-wasix-checkpoint-recycle.sh" \
  "$PROJECT_ROOT/bin/qualify-wasix-checkpoint-recycle.test.sh" \
  "$PROJECT_ROOT/bin/validate-checkpoint-recycle.py" \
  "$PROJECT_ROOT/bin/validate-checkpoint-recycle.test.py" \
  "$PROJECT_ROOT/bin/validate-checkpoint-memory.py" \
  "$PROJECT_ROOT/bin/validate-checkpoint-memory.test.py" \
  "$PROJECT_ROOT/bin/validate-wal-recycle.py" \
  "$PROJECT_ROOT/bin/validate-wal-recycle.test.py" \
  "$PROJECT_ROOT/bin/extract-checkpoint-summary.py" \
  "$PROJECT_ROOT/bin/extract-checkpoint-summary.test.py" \
  "$PROJECT_ROOT/bin/summarize-checkpoint-qualification.py" \
  "$PROJECT_ROOT/bin/summarize-checkpoint-qualification.test.py" \
  "$PROJECT_ROOT/bin/verify-sealed-headless-carrier.sh" \
  "$PROJECT_ROOT/lib/postgres-profiles.sh" \
  "$PROJECT_ROOT/lib/postgres-profiles.test.sh" \
  "$PROJECT_ROOT/lib/wasix-build-lock.sh" \
  "$PROJECT_ROOT/lib/wasix-build-lock.test.sh" \
  "$PROJECT_ROOT/lib/shared_memory_provider.py" \
  "$PROJECT_ROOT/lib/shared_memory_provider.test.py" \
  "$PROJECT_ROOT/lib/qualification-identities.sh" \
  "$PROJECT_ROOT/lib/sealed-carrier.sh" \
  "$PROJECT_ROOT/lib/host-fd-telemetry.sh" \
  "$PROJECT_ROOT/lib/host-fd-telemetry.test.sh" \
  "$PROJECT_ROOT/lib/process-supervision.sh" \
  "$PROJECT_ROOT/lib/process-supervision.test.sh" \
  "$PROJECT_ROOT/lib/signal-owned-pid.py" \
  "$PROJECT_ROOT/lib/signal-owned-pid.test.py" \
  "$PROJECT_ROOT/lib/server-lifecycle.sh" \
  "$PROJECT_ROOT/lib/server-lifecycle.test.sh" \
  "$PROJECT_ROOT/lib/immutable-carrier.test.py" \
  "$PROJECT_ROOT/lib/verify-sealed-carrier.py" \
  "$PROJECT_ROOT/testdata/fake-postmaster-compiler.py" \
  "$PROJECT_ROOT/testdata/make-sealed-export-fixture.py" \
  "$PROJECT_ROOT/testdata/fake-sealed-wasmer.py" \
  "$PROJECT_ROOT/probes/libpq_latency_probe.c" \
  "$PROJECT_ROOT/probes/libpq_checkpoint_probe.c" \
  "$PROJECT_ROOT/bench/sql/checkpoint-workload-setup.sql" \
  "$PROJECT_ROOT/bench/sql/checkpoint-volume.sql" \
  "$PROJECT_ROOT/bench/sql/checkpoint-database-state.sql" \
  "$PROJECT_ROOT/runtime/bin/run-exec-backend-probes.sh" \
  "$PROJECT_ROOT/runtime/probes/directory_fsync_probe.c" \
  "$PROJECT_ROOT/runtime/probes/epoll_ofd_lifecycle_probe.c" \
  "$PROJECT_ROOT/runtime/probes/exec_shared_latch_sigurg_probe.c" \
  "$PROJECT_ROOT/runtime/probes/sync_file_range_probe.c" \
  "$PROJECT_ROOT/profiles/runtime-footprints/embedded-concurrent-v1.gucs" \
  "$PROJECT_ROOT/profiles/durability/safe-v1.gucs" \
  "$PROJECT_ROOT/profiles/checkpoint-policies/embedded-steady-v1.gucs" \
  "$PROJECT_ROOT/profiles/checkpoint-policies/embedded-steady-v1.tsv" \
  "$PROJECT_ROOT/profiles/memory-budgets/embedded-c4-lower-pressure-v1.tsv" \
  "$PROJECT_ROOT/profiles/lifecycle-baselines/relative-stabilized-idle-postmaster-exploratory-v1.tsv" \
  "$PROJECT_ROOT/bin/stress-wasix-initdb.sh" \
  "$PROJECT_ROOT/bin/stress-wasix-backend-waves.sh" \
  "$PROJECT_ROOT/bin/summarize-linux-smaps.sh" \
  "$PROJECT_ROOT/bin/summarize-linux-smaps.test.sh" \
  "$REPO_ROOT/src/sources/third-party/wasix-postmaster/wasmer.toml" \
  "$REPO_ROOT/src/sources/third-party/wasix-postmaster/wasmer-napi.toml" \
  "$REPO_ROOT/src/sources/third-party/wasix-postmaster/wasmer-test-files.toml" \
  "$REPO_ROOT/src/sources/third-party/wasix-postmaster/webassembly-testsuite.toml" \
  "$REPO_ROOT/src/sources/third-party/wasix-postmaster/wasix-libc.toml" \
  "$REPO_ROOT/src/sources/toolchains/wasix.toml" \
  "$REPO_ROOT/src/postgres/versions/18/source.toml" \
  "$REPO_ROOT/src/runtimes/liboliphaunt/wasix/assets/build/docker/Dockerfile" \
  "$REPO_ROOT/src/runtimes/liboliphaunt/wasix/assets/build/docker_wasix_env.sh"
do
  [ -f "$required" ] || fail "missing required file: $required"
done

require_text "$REPO_ROOT/src/postgres/versions/18/source.toml" 'version = "18.4"'
require_text "$PROJECT_ROOT/sources.lock.toml" 'version = "18.4"'
require_text "$PROJECT_ROOT/sources.lock.toml" 'tag = "REL_18_4"'
require_text "$PROJECT_ROOT/sources.lock.toml" 'commit = "1d1b3420beef28550afbb4692b664bd7f6bc2581"'
require_text "$PROJECT_ROOT/sources.lock.toml" 'napi_commit = "706383f42391cb4e4e82e5fd5e63a0ebf81ae19d"'
require_text "$PROJECT_ROOT/sources.lock.toml" 'commit = "34178a6272804f90448b5bd08dc7bcf0d85438e3"'
require_text "$REPO_ROOT/src/sources/third-party/wasix-postmaster/wasmer.toml" 'commit = "1d1b3420beef28550afbb4692b664bd7f6bc2581"'
require_text "$REPO_ROOT/src/sources/third-party/wasix-postmaster/wasmer-napi.toml" 'commit = "706383f42391cb4e4e82e5fd5e63a0ebf81ae19d"'
require_text "$REPO_ROOT/src/sources/third-party/wasix-postmaster/wasmer-test-files.toml" 'commit = "7f27e84c69af3b772f751d6c4a733d9f448b2c70"'
require_text "$REPO_ROOT/src/sources/third-party/wasix-postmaster/webassembly-testsuite.toml" 'commit = "7e0b83aba9dbbb6e0623c9334b0f73b3bb584b90"'
require_text "$REPO_ROOT/src/sources/third-party/wasix-postmaster/wasix-libc.toml" 'commit = "34178a6272804f90448b5bd08dc7bcf0d85438e3"'
require_text "$PROJECT_ROOT/lib/common.sh" 'target/oliphaunt-wasix-postmaster'
require_text "$PROJECT_ROOT/lib/common.sh" 'fresh_project_source_identity_path'
require_text "$PROJECT_ROOT/lib/common.sh" 'src/runtimes/liboliphaunt/wasix-postmaster'
require_text "$PROJECT_ROOT/lib/common.sh" 'REL_18_4'
require_text "$PROJECT_ROOT/lib/common.sh" 'WASIXCC_SYSROOT_VARIANT:-sysroot-exnref-ehpic'
require_text "$PROJECT_ROOT/lib/common.sh" 'oliphaunt.wasix-postmaster.wasmer-build.v2'
require_text "$PROJECT_ROOT/lib/common.sh" 'fresh_require_local_wasmer_build_state'
require_text "$PROJECT_ROOT/lib/common.sh" 'fresh_require_patched_wasmer_headless'
require_text "$PROJECT_ROOT/lib/common.sh" 'fresh_require_patched_postmaster_executor'
require_text "$PROJECT_ROOT/lib/common.sh" 'oliphaunt.wasix-postmaster.postmaster-executor-build.v3'
require_text "$PROJECT_ROOT/lib/common.sh" 'fresh_require_start_proof_tool'
require_text "$PROJECT_ROOT/lib/common.sh" 'fresh_require_memory_profile_tool'
require_text "$PROJECT_ROOT/lib/common.sh" 'fresh_require_patched_postmaster_compiler'
require_text "$PROJECT_ROOT/lib/common.sh" 'wasm32-max256m-u64-static4g-guard2g.v1'
require_text "$PROJECT_ROOT/lib/common.sh" 'fresh_validate_postmaster_task_budget_profile'
require_text "$PROJECT_ROOT/lib/common.sh" 'embedded-postmaster-v1-budget96.v2'
require_text "$PROJECT_ROOT/profiles/runtime-task-budgets/embedded-postmaster-v1.tsv" $'\t90\t1\t5\t96\t1\t1000'
require_text "$PROJECT_ROOT/lib/common.sh" 'FRESH_WASMER_WASIX_VERSION:-0.702.0-alpha.2'
require_text "$PROJECT_ROOT/runtime/bin/build-runtime.sh" 'WASMER_BUILD_RECEIPT_OUT'
require_text "$PROJECT_ROOT/runtime/bin/build-runtime.sh" '--locked'
require_text "$PROJECT_ROOT/runtime/bin/build-runtime.sh" '--target-dir'
require_text "$PROJECT_ROOT/runtime/bin/build-runtime.sh" 'fresh_require_local_wasmer_build_state'
require_text "$PROJECT_ROOT/runtime/bin/build-runtime.sh" 'OLIPHAUNT_WASIX_RUNTIME_ABI_ID'
require_text "$PROJECT_ROOT/runtime/bin/build-runtime.sh" 'file_advice'
require_text "$PROJECT_ROOT/runtime/bin/build-runtime.sh" 'syscalls::wasi::fd_advise::tests'
require_text "$PROJECT_ROOT/runtime/bin/build-runtime.sh" 'host_file_range_writeback'
require_text "$PROJECT_ROOT/runtime/bin/build-runtime.sh" 'syscalls::wasix::fd_sync_range::tests'
require_text "$PROJECT_ROOT/runtime/bin/build-runtime.sh" 'required_import_tests'
require_text "$PROJECT_ROOT/runtime/bin/build-runtime.sh" 'require_listed_test'
require_text "$PROJECT_ROOT/runtime/bin/build-runtime.sh" 'verify-source-lock.py'
require_text "$PROJECT_ROOT/runtime/bin/build-runtime.sh" 'postmaster_compiler_binary='
require_text "$PROJECT_ROOT/runtime/bin/build-runtime.sh" 'generic-baseline'
require_text "$PROJECT_ROOT/runtime/bin/build-runtime.sh" 'verify-runtime-state-ownership.py'
require_text "$PROJECT_ROOT/runtime/bin/prepare-upstream-checkouts.sh" 'verify-source-lock.py'
require_text "$PROJECT_ROOT/bin/build-wasix-core.sh" 'seal-wasix-core-exports.sh'
require_text "$PROJECT_ROOT/bin/build-wasix-core.sh" 'source "$FRESH_ROOT/lib/wasix-build-lock.sh"'
require_text "$PROJECT_ROOT/bin/build-wasix-core.sh" 'fresh_lock_wasix_core_build "$WASIX_INSTALL_DIR"'
require_text "$PROJECT_ROOT/bin/wasix-make.sh" 'source "$FRESH_ROOT/lib/wasix-build-lock.sh"'
require_text "$PROJECT_ROOT/bin/wasix-make.sh" 'fresh_lock_wasix_core_build "$WASIX_INSTALL_DIR"'
forbid_text "$PROJECT_ROOT/bin/wasix-make.sh" '.wasix-make.lock'
forbid_text "$PROJECT_ROOT/bin/build-wasix-core.sh" '.wasix-make.lock'
require_text_before "$PROJECT_ROOT/bin/apply-wasix-core-overlay.sh" \
  'fresh_require_managed_generated_path "$WASIX_SRC_DIR"' \
  'rm -rf "$WASIX_SRC_DIR"'
require_text_before "$PROJECT_ROOT/bin/prepare-baseline.sh" \
  'fresh_require_managed_generated_path "$BASELINE_DIR" BASELINE_DIR' \
  'rm -rf -- "$BASELINE_DIR"'
require_text "$PROJECT_ROOT/bin/prepare-baseline.sh" \
  'fresh_lock_postgres_baseline exclusive'
require_text "$PROJECT_ROOT/bin/prepare-baseline.sh" \
  'mv "$extracted" "$BASELINE_DIR"'
require_text_before "$PROJECT_ROOT/bin/pin-runtime-artifacts.sh" \
  'fresh_require_managed_generated_path "$old_root"' \
  'rm -rf "$tmp_root" "$old_root"'
require_text_before "$PROJECT_ROOT/bin/smoke-native-oracle.sh" \
  'fresh_require_managed_generated_path "$run_root"' \
  'rm -rf "$run_root"'
require_text_before "$PROJECT_ROOT/bin/smoke-wasix-core.sh" \
  'fresh_require_managed_generated_path "$pgdata"' \
  'rm -rf "$pgdata"'
require_text_before "$PROJECT_ROOT/bin/smoke-wasix-concurrent-connections.sh" \
  'fresh_require_managed_generated_path "$suite_root"' \
  'rm -rf "$suite_root" "$report_dir"'
for managed_script in \
  profile-native-query.sh \
  profile-wasix-query.sh \
  bench-wasix-query-suite.sh \
  bench-wasix-core-profiles.sh \
  bench-wasix-concurrent-query-suite.sh
do
  require_text "$PROJECT_ROOT/bin/$managed_script" \
    'fresh_require_managed_generated_path'
done
require_text "$PROJECT_ROOT/runtime/bin/build-patched-wasix-libc-sysroot.sh" \
  'fresh_require_managed_generated_path "$OUTPUT_PREFIX"'
for generated_root in UPSTREAM_WORK_ROOT WASMER_ROOT WASIX_LIBC_ROOT SIGNATURE_ROOT; do
  require_text "$PROJECT_ROOT/runtime/bin/prepare-upstream-checkouts.sh" \
    "fresh_require_managed_generated_path \"\$$generated_root\""
done
for label_script in \
  profile-native-query.sh \
  profile-wasix-query.sh \
  bench-wasix-query-suite.sh
do
  require_text "$PROJECT_ROOT/bin/$label_script" 'case "$run_label" in'
  require_text "$PROJECT_ROOT/bin/$label_script" '[!A-Za-z0-9]*|*[!A-Za-z0-9._-]*)'
done
require_text "$PROJECT_ROOT/bin/qualify-wasix-checkpoint-recycle.sh" \
  '[!A-Za-z0-9]*|*[!A-Za-z0-9._-]*)'
require_text "$PATCH_ROOT/0004-wasix-core-execbackend-initdb-runtime.patch" \
  '#if (defined(WIN32) && !defined(__CYGWIN__)) || defined(__wasi__)'
require_text "$PATCH_ROOT/0004-wasix-core-execbackend-initdb-runtime.patch" \
  'if ((pid = vfork()) == 0)'
require_text "$PATCH_ROOT/0004-wasix-core-execbackend-initdb-runtime.patch" \
  'if (execv(postgres_exec_path, argv) < 0)'
require_adjacent_lines "$PATCH_ROOT/0004-wasix-core-execbackend-initdb-runtime.patch" \
  '+#ifdef __wasi__' $'+\tif ((pid = vfork()) == 0)'
require_text "$PATCH_ROOT/0004-wasix-core-execbackend-initdb-runtime.patch" \
  '_exit(errno == ENOENT ? 127 : 126);'
require_text_before "$SYSV_SHMEM_OVERLAY" \
  'on_shmem_exit(WasixShmemDelete' \
  'ftruncate(WasixShmemFd'
require_text "$FORK_OVERLAY" 'errno = ENOTSUP;'
require_text "$PORT_OVERLAY" 'errno = ENOTSUP;'
copied_memory_fork_call='__wasi_proc_fork('"1"
if git -C "$REPO_ROOT" grep -nF -- "$copied_memory_fork_call" -- \
  "${PROJECT_ROOT#"$REPO_ROOT"/}" >/dev/null
then
  fail 'WASIX PostgreSQL sources must not invoke copied-memory fork'
fi
require_text "$PROJECT_ROOT/bin/seal-wasix-core-exports.sh" '--remove-unused-module-elements'
require_text "$PROJECT_ROOT/bin/seal-wasix-core-exports.sh" 'attest-final'
require_text "$PROJECT_ROOT/tools/sealed-export-closure/src/main.rs" 'structural-estimate-not-measured-rss'
require_text "$PROJECT_ROOT/tools/sealed-export-closure/src/main.rs" 'required_global_value_type'
require_text "$PROJECT_ROOT/tools/sealed-export-closure/src/main.rs" 'final exports do not exactly equal the derived seed closure'
require_text "$PROJECT_ROOT/runtime/policies/sealed-main-runtime-exports.v1.txt" 'WaitEventSetWait'
require_text "$PROJECT_ROOT/runtime/policies/sealed-side-modules.v1.tsv" 'lib/postgresql/plpgsql.so'
closure_tool_source="src/runtimes/liboliphaunt/wasix-postmaster/tools/sealed-export-closure/src/main.rs"
closure_tool_target="src/runtimes/liboliphaunt/wasix-postmaster/tools/sealed-export-closure/target/debug/tool"
if git -C "$REPO_ROOT" check-ignore -q -- "$closure_tool_source"; then
  fail 'sealed export closure source is ignored by product policy'
fi
git -C "$REPO_ROOT" check-ignore -q -- "$closure_tool_target" ||
  fail 'sealed export closure Cargo target is not ignored by product policy'
for exact_runtime_test in \
  'fd_sync_range_maps_all_exact_flag_combinations' \
  'fd_sync_range_rejects_negative_overflowing_and_unknown_ranges' \
  'fd_sync_range_observability_classifies_the_complete_signed_range' \
  'fd_sync_range_preserves_zero_length_and_maximum_finite_range' \
  'fd_sync_range_maps_unsupported_backends_to_nosys' \
  'fd_sync_range_read_only_advice_right_is_accepted' \
  'fd_sync_range_directory_is_badf' \
  'fd_sync_range_preserves_linux_writeback_errnos' \
  'child_execution_admission_requires_exact_publication' \
  'failed_launch_rollback_waits_for_real_execution_quiescence' \
  'execution_guard_publishes_terminal_before_quiescence' \
  'abandoned_host_execution_fails_closed_only_after_last_guard_clone' \
  'supplemental_parent_guard_requires_an_accepted_successor' \
  'vfork_parent_and_child_ownership_coexist_across_deep_sleep_handoffs' \
  'panicking_monitor_manager_terminates_and_reaps_before_quiescence' \
  'reinit_requires_terminal_status_and_execution_quiescence' \
  'descendant_validation_failure_seals_no_process_in_tree' \
  'repeated_child_construction_keeps_main_handle_owned_by_child' \
  'canceled_task_wasm_terminalizes_exact_thread_before_quiescence' \
  'closed_worker_queue_drops_pending_execution_fail_closed' \
  'accepted_callback_conversion_is_the_only_successful_disarm' \
  'accepted_callback_panic_terminalizes_before_quiescence' \
  'deep_sleep_handoff_keeps_thread_live_until_successor_guard_finishes' \
  'non_core_workers_retire_after_the_idle_timeout' \
  'memory_construction_failure_terminalizes_before_releasing_lease' \
  'instantiation_failure_terminalizes_before_releasing_lease' \
  'panicking_custom_task_wasm_callback_terminalizes_before_quiescence' \
  'module_start_observes_child_parent_after_exact_publication' \
  'run_exec_panic_terminalizes_before_releasing_accepted_guard' \
  'absent_pid_returns_srch_for_liveness_probe' \
  'signal_zero_observes_existing_pid_without_delivery' \
  'real_signal_delivery_is_unchanged' \
  'shared_futex_registry_uses_containing_mapping_only' \
  'runtime_state_snapshot_reports_compact_occupancy_without_pruning' \
  'shared_futex_registry_reuses_same_live_file' \
  'shared_futex_registry_pins_file_identity_until_last_live_reference' \
  'shared_futex_registry_replaces_entry_after_last_live_drop' \
  'shared_futex_registry_last_drop_racing_lookup_keeps_exact_replacement' \
  'forked_states_share_mapping_registry_and_return_to_zero_plateau' \
  'repeated_shared_futex_registry_churn_returns_to_slot_and_fd_plateau' \
  'shared_futex_registry_old_generation_cannot_remove_replacement' \
  'shared_futex_registry_prunes_stale_slots_in_bounded_order' \
  'direct_signal_controller_is_platform_neutral_and_rejects_finished_tasks' \
  'unix_supervisor_real_signals_restore_and_route_exclusively' \
  'wasi_runner_never_owns_host_lifecycle_by_default' \
  'lifecycle_bind_failure_kills_and_reaps_spawned_root' \
  'bind_panic_terminates_and_reaps_spawned_root' \
  'dropping_admitted_watcher_terminates_and_reaps_spawned_root' \
  'direct_root_spawn_has_no_effect_before_watcher_admission' \
  'runtime_policy_identity_requires_the_exact_postmaster_closure' \
  'runtime_policy_identity_parser_rejects_unknown_manifest_fields' \
  'runtime_policy_identity_selects_only_product_executables' \
  'product_runner_applies_the_same_guest_and_host_task_budget' \
  'blocking_worker_growth_is_bounded_by_the_host_task_budget' \
  'sealed_postmaster_policy_id_and_worker_configuration_are_stable' \
  'sealed_postmaster_runtime_has_exactly_two_tokio_workers' \
  'generic_runtime_policy_retains_tokio_default_worker_selection'
do
  require_text "$PROJECT_ROOT/runtime/bin/build-runtime.sh" "$exact_runtime_test"
done
for exact_runtime_test in \
  'cache_advice_generation_is_descriptor_relative_and_detects_mutation' \
  'pinned_file_is_owned_path_free_and_fails_closed_after_mutation' \
  'normal_sync_and_validation_fast_paths_do_not_wait_for_policy_mutex' \
  'contended_action_gate_never_blocks_relation_and_only_queues_proven_wal' \
  'wal_requires_canonical_complete_segment_without_alignment_trimming' \
  'one_hundred_wal_segments_are_bounded_and_only_one_acts_per_fresh_sample' \
  'deferred_wal_capacity_includes_inflight_budget_and_evicts_oldest' \
  'deferred_test_lock_contention_drops_once_with_exact_conservation' \
  'deferred_generation_invalidation_is_benign_and_advice_error_is_terminal' \
  'sampler_clock_and_breaker_degradation_flush_deferred_ownership' \
  'maintenance_expires_deferred_pin_without_an_advice_trigger' \
  'finalization_flushes_queue_and_publishes_terminal_zero_receipt' \
  'finalization_rejects_a_previously_published_live_snapshot' \
  'threaded_finalization_waits_for_action_then_publishes_terminal_zero' \
  'admission_word_and_seqcst_wait_protocol_cover_adversarial_interleavings' \
  'runtime_policy_identity_approved_config_hash_matches_compiled_default_telemetry' \
  'process_tree_join_precedes_one_shot_product_evidence_finalization'
do
  require_text "$PROJECT_ROOT/runtime/bin/build-runtime.sh" "$exact_runtime_test"
done
for exact_runtime_test in \
  'wait_dump_config_is_disabled_without_both_interval_and_file' \
  'wait_dump_zero_limit_means_unlimited_and_verbose_is_explicit' \
  'wait_dump_order_is_strictly_monotonic' \
  'runtime_state_record_schema_and_field_order_are_exact'
do
  require_text "$PROJECT_ROOT/runtime/bin/build-runtime.sh" "$exact_runtime_test"
done
require_text "$PROJECT_ROOT/bin/build-wasix-core.sh" '#define HAVE_SYNC_FILE_RANGE 1'
require_text "$PROJECT_ROOT/bin/build-wasix-core.sh" 'verify-postmaster-wasm-import.py'
require_text "$PROJECT_ROOT/bin/build-wasix-core.sh" 'verify-postmaster-concurrency-contract.py'
require_text "$PROJECT_ROOT/bin/build-wasix-core.sh" 'WASIXCC_WASM_OPT_SUPPRESS_DEFAULT'
require_text "$PROJECT_ROOT/bin/build-wasix-core.sh" 'EXPECTED_ATOMIC_FENCE_TOTAL'
require_text "$PROJECT_ROOT/lib/common.sh" 'FRESH_WASIX_CORE_PROFILE_EXPECTED_FINAL_ATOMIC_FENCE_TOTAL="233"'
require_text "$PROJECT_ROOT/lib/common.sh" 'FRESH_WASIX_CORE_PROFILE_EXPECTED_ATOMIC_FENCE_TOTAL="1111"'
require_text "$PROJECT_ROOT/lib/common.sh" 'FRESH_WASIX_CORE_PROFILE_EXPECTED_FINAL_ATOMIC_FENCE_TOTAL="995"'
require_text "$PROJECT_ROOT/bin/build-sealed-headless-carrier.sh" 'oliphaunt.wasix-postmaster.sealed-aot.v5'
require_text "$PROJECT_ROOT/bin/build-sealed-headless-carrier.sh" 'postmaster-executor.receipt'
require_text "$PROJECT_ROOT/bin/build-sealed-headless-carrier.sh" '--executor-role'
require_text "$PROJECT_ROOT/bin/build-sealed-headless-carrier.sh" 'guest-build-recipe-sha256'
require_text "$PROJECT_ROOT/bin/build-wasix-core.sh" 'oliphaunt.wasix-postmaster.guest-build.v5'
require_text "$PROJECT_ROOT/bin/build-wasix-core.sh" 'wasix-postmaster.final-wasm-concurrency.receipt'
require_text "$PROJECT_ROOT/bin/build-wasix-core.sh" 'seal-wasix-linear-memory.sh'
require_text "$PROJECT_ROOT/bin/build-wasix-core.sh" 'seal-identity "$WASIX_INSTALL_DIR"'
require_text "$PROJECT_ROOT/bin/build-wasix-core.sh" 'durable_publication.py'
require_text "$PROJECT_ROOT/lib/durable_publication.py" 'os.O_EXCL'
require_text "$PROJECT_ROOT/lib/durable_publication.py" 'directory.fsync()'
require_text "$PROJECT_ROOT/lib/guest_build_provenance.py" 'synchronize_root_entry'
require_text "$PROJECT_ROOT/bin/seal-wasix-linear-memory.sh" 'linear_memory_transaction.py'
require_text "$PROJECT_ROOT/bin/seal-wasix-linear-memory.sh" '--allow-linear-memory-descendant'
require_text "$PROJECT_ROOT/bin/seal-wasix-linear-memory.sh" 'flock -n'
require_text "$PROJECT_ROOT/lib/linear_memory_transaction.py" 'linear-memory-transaction.v1'
require_text "$PROJECT_ROOT/lib/linear_memory_transaction.py" 'os.link(aggregate_source, aggregate_destination'
require_text "$PROJECT_ROOT/lib/sealed_export_chain.py" 'O_NOFOLLOW'
require_text "$PROJECT_ROOT/lib/sealed_export_chain.py" 'analyzer version differs from structural receipt'
require_text "$PROJECT_ROOT/bin/precompile-wasix-core.sh" 'verify-aot'
require_text "$PROJECT_ROOT/bin/precompile-wasix-core.sh" 'refuses pinned or foreign cache roots'
require_text "$PROJECT_ROOT/bin/build-sealed-headless-carrier.sh" 'fresh_atomic_publish_directory_noreplace'
require_text "$PROJECT_ROOT/bin/build-sealed-headless-carrier.sh" 'refuse pinned or foreign AOT cache roots'
require_text "$PROJECT_ROOT/runtime/patches/wasmer/0001-postgres-wasix-blockers.patch" 'pub fn native_cpu'
require_text "$PROJECT_ROOT/runtime/patches/wasmer/0001-postgres-wasix-blockers.patch" 'product_compiler_cpu_policy.rs'
require_text "$PROJECT_ROOT/runtime/patches/wasmer/0001-postgres-wasix-blockers.patch" 'memory-profile-core'
require_text "$PROJECT_ROOT/runtime/bin/verify-postmaster-concurrency-contract.py" 'i32.atomic.rmw.or'
require_text "$PROJECT_ROOT/runtime/bin/verify-postmaster-concurrency-contract.py" 'i32.atomic.rmw.and'
require_text "$PROJECT_ROOT/lib/guest_build_provenance.py" 'installed-closure.v1'
require_text "$PROJECT_ROOT/bin/build-sealed-headless-carrier.sh" '--emit-preinitialized-memory-image'
require_text "$PROJECT_ROOT/bin/build-sealed-headless-carrier.sh" 'independent memory image captures differ'
require_text "$PROJECT_ROOT/bin/build-sealed-headless-carrier.sh" 'payload.files'
require_text "$PROJECT_ROOT/bin/bench-wasix-concurrent-query-suite.sh" 'bulk_batch_wall_ms'
require_text "$PROJECT_ROOT/bin/bench-wasix-concurrent-query-suite.sh" 'whole_run_observed_cgroup_memory_peak_bytes'
require_text "$PROJECT_ROOT/bin/bench-wasix-concurrent-query-suite.sh" 'host_open_fd_count_total'
require_text "$PROJECT_ROOT/bin/bench-wasix-concurrent-query-suite.sh" 'assert_no_client_process_residue'
require_text "$PROJECT_ROOT/bin/bench-wasix-concurrent-query-suite.sh" 'libpq-latency-summary.tsv'
require_text "$PROJECT_ROOT/bin/bench-wasix-concurrent-query-suite.sh" 'effective-postgres-settings.tsv'
require_text "$PROJECT_ROOT/bin/bench-wasix-concurrent-query-suite.sh" 'host-fd-checkpoints.tsv'
require_text "$PROJECT_ROOT/bin/bench-wasix-concurrent-query-suite.sh" 'memory-evidence.tsv'
require_text "$PROJECT_ROOT/bin/bench-wasix-concurrent-query-suite.sh" '--runtime-footprint'
require_text "$PROJECT_ROOT/bin/bench-wasix-concurrent-query-suite.sh" '--durability'
require_text "$PROJECT_ROOT/bin/bench-wasix-concurrent-query-suite.sh" 'fresh_validate_postgres_profile_settings'
require_text "$PROJECT_ROOT/bin/bench-wasix-concurrent-query-suite.sh" '--cold-ownership'
require_text "$PROJECT_ROOT/bin/bench-wasix-concurrent-query-suite.sh" '--shared-memory-provider'
require_text "$PROJECT_ROOT/lib/shared_memory_provider.py" 'oliphaunt.wasix-postmaster.shared-memory-provider.v2'
require_text "$PROJECT_ROOT/lib/shared_memory_provider.py" 'oliphaunt.wasix-postmaster.shared-memory-release.v2'
require_text "$PROJECT_ROOT/lib/shared_memory_provider.py" 'anchored-parent-exact-inode-empty-rmdir-v2'
require_text "$PROJECT_ROOT/lib/shared_memory_provider.py" 'clean-postgresql-shutdown-v1'
require_text "$PROJECT_ROOT/lib/shared_memory_provider.py" 'post-process-drain-v1'
require_text "$PROJECT_ROOT/bin/bench-wasix-concurrent-query-suite.sh" '--cold-ownership-workloads'
require_text "$PROJECT_ROOT/bin/bench-wasix-concurrent-query-suite.sh" '--immutable-carrier-verification-scope'
require_text "$PROJECT_ROOT/bin/bench-wasix-concurrent-query-suite.sh" 'oliphaunt.wasix-postmaster.cold-ownership-mode.v1'
require_text "$PROJECT_ROOT/bin/bench-wasix-concurrent-query-suite.sh" '# FINAL COLD BOUNDARY:'
require_text "$PROJECT_ROOT/bin/prove-linux-cold-residency.py" 'POSIX_FADV_DONTNEED'
require_text "$PROJECT_ROOT/bin/prove-linux-cold-residency.py" 'mincore'
require_text "$PROJECT_ROOT/bin/validate-sealed-loader-audit.py" 'sealed-loader-receipt.v2'
require_text "$PROJECT_ROOT/bin/validate-sealed-loader-audit.py" 'residency_after_archive_release'
require_text "$PROJECT_ROOT/bin/validate-sealed-loader-audit.py" 'source_cache_eviction_errno'
require_text "$PROJECT_ROOT/lib/cold_ownership_schema.py" 'spawn_to_first_query_ms'
require_text "$PROJECT_ROOT/bin/validate-wasix-cold-ownership.py" 'SAMPLE_HEADER'
require_text "$PROJECT_ROOT/bin/qualify-wasix-cold-ownership.sh" 'research-only-non-release'
require_text "$PROJECT_ROOT/bin/qualify-wasix-cold-ownership.sh" 'global_drop_caches'
for memory_budget_option in \
  '--max-peak-pss-kib' \
  '--max-peak-pss-anon-kib' \
  '--max-peak-page-table-kib' \
  '--max-cgroup-high-events-delta' \
  '--max-psi-some-stall-fraction' \
  '--max-psi-full-stall-fraction'
do
  require_text "$PROJECT_ROOT/bin/bench-wasix-concurrent-query-suite.sh" \
    "$memory_budget_option"
done
require_text "$PROJECT_ROOT/bin/bench-wasix-concurrent-query-suite.sh" \
  'oliphaunt.wasix-postmaster.memory-budget.v1'
require_text "$PROJECT_ROOT/bin/bench-wasix-concurrent-query-suite.sh" \
  'assert_frozen_memory_budget'
require_text "$PROJECT_ROOT/bin/bench-wasix-concurrent-query-suite.sh" \
  'validate-wasix-lifecycle-plateau.py'
require_text "$PROJECT_ROOT/bin/bench-wasix-concurrent-query-suite.sh" \
  'validate-wasix-lifecycle-memory-plateau.py'
require_text "$PROJECT_ROOT/bin/bench-wasix-concurrent-query-suite.sh" \
  '--wasix-lifecycle-memory-checkpoint-every'
require_text "$PROJECT_ROOT/bin/bench-wasix-concurrent-query-suite.sh" \
  '--max-lifecycle-late-pss-slope-kib-per-1000'
require_text "$PROJECT_ROOT/bin/bench-wasix-concurrent-query-suite.sh" \
  'SELECT pg_log_standby_snapshot()'
require_text "$PROJECT_ROOT/bin/bench-wasix-concurrent-query-suite.sh" \
  'validate-adaptive-file-cache-telemetry.py'
require_text "$PROJECT_ROOT/bin/bench-wasix-concurrent-query-suite.sh" \
  '--adaptive-cache-evidence-policy'
require_text "$PROJECT_ROOT/bin/validate-adaptive-file-cache-telemetry.py" \
  'file-cache-admission-fallback.v1'
require_text "$PROJECT_ROOT/bin/validate-adaptive-file-cache-telemetry.py" \
  'adaptive terminal offer dispositions do not conserve offers'
require_text "$PROJECT_ROOT/bin/validate-adaptive-file-cache-telemetry.py" \
  'constrained-linux-wal-action-v1'
require_text "$PROJECT_ROOT/bin/validate-wasix-lifecycle-plateau.py" \
  'relative-to-stabilized-baseline'
require_text "$PROJECT_ROOT/profiles/memory-budgets/embedded-c4-lower-pressure-v1.tsv" \
  'research-only'
[ -x "$PROJECT_ROOT/bin/freeze-wasix-lifecycle-policy.py" ] ||
  fail "lifecycle policy freezer must be executable"
[ -x "$PROJECT_ROOT/bin/validate-wasix-lifecycle-memory-plateau.py" ] ||
  fail "lifecycle memory plateau validator must be executable"
[ -x "$PROJECT_ROOT/bin/lifecycle-memory-checkpoint.test.sh" ] ||
  fail "lifecycle memory checkpoint test must be executable"
require_text "$PROJECT_ROOT/bin/summarize-libpq-latency.sh" 'nearest-rank p50/p95/p99'
require_text "$PROJECT_ROOT/probes/libpq_latency_probe.c" 'CLOCK_MONOTONIC'
require_text "$PROJECT_ROOT/probes/libpq_latency_probe.c" 'PQconnectdb(conninfo)'
require_text "$PROJECT_ROOT/probes/libpq_latency_probe.c" 'PQconnectdb(options.conninfo)'
require_text "$PROJECT_ROOT/probes/libpq_latency_probe.c" 'PQfinish(connection)'
require_text "$PROJECT_ROOT/lib/process-supervision.sh" 'kill -TERM -- "-$pgid"'
require_text "$PROJECT_ROOT/lib/process-supervision.sh" 'kill -KILL -- "-$pgid"'
require_text "$PROJECT_ROOT/lib/process-supervision.sh" 'signal-owned-pid.py'
require_text "$PROJECT_ROOT/bin/qualify-wasix-single-backend.sh" 'derived_metrics_valid'
require_text "$PROJECT_ROOT/bin/qualify-wasix-single-backend.sh" 'bulk-batch residual'
require_text "$PROJECT_ROOT/bin/qualify-wasix-single-backend.sh" 'assert_frozen_carrier'
require_text "$PROJECT_ROOT/bin/qualify-wasix-single-backend.sh" 'compare-postgres-settings.py'
require_text "$PROJECT_ROOT/bin/qualify-wasix-single-backend.sh" '--runtime-footprint'
require_text "$PROJECT_ROOT/bin/qualify-wasix-single-backend.sh" '--durability'
require_text "$PROJECT_ROOT/bin/qualify-wasix-single-backend.sh" 'postgres-profile-resolution.tsv'
require_text "$PROJECT_ROOT/bin/qualify-wasix-single-backend.sh" 'assert_frozen_native_oracle'
require_text "$PROJECT_ROOT/bin/qualify-wasix-single-backend.sh" 'native-oracle-identity.tsv'
require_text "$PROJECT_ROOT/bin/qualify-wasix-single-backend.sh" \
  'adaptive-cache-verification.tsv'
require_text "$PROJECT_ROOT/bin/qualify-wasix-single-backend.sh" \
  'constrained-linux-wal-action-v1'
require_text "$PROJECT_ROOT/bin/qualify-wasix-single-backend.sh" \
  '--shared-memory-provider'
require_text "$PROJECT_ROOT/bin/qualify-wasix-libpq-latency.sh" 'ABBA/BAAB'
require_text "$PROJECT_ROOT/bin/qualify-wasix-libpq-latency.sh" '--resource-detail off'
require_text "$PROJECT_ROOT/bin/qualify-wasix-libpq-latency.sh" 'qualification-plan.tsv'
require_text "$PROJECT_ROOT/bin/qualify-wasix-libpq-latency.sh" 'WASIX_WAIT_DUMP_FENCE_REQUEST_FILE'
require_text "$PROJECT_ROOT/bin/compare-libpq-latency.py" 'raw latency evidence'
require_text "$PROJECT_ROOT/bin/compare-libpq-latency.py" 'paired_p95_ratio_p95'
require_text "$RESEARCH_DOCS_ROOT/libpq-latency-qualification.md" 'true-libpq-safe-o2-c1-n1000-192m-v1'
require_text "$PROJECT_ROOT/bin/qualify-wasix-immediate-recovery.sh" 'received immediate shutdown request'
require_text "$PROJECT_ROOT/bin/qualify-wasix-immediate-recovery.sh" 'automatic recovery in progress'
require_text "$PROJECT_ROOT/bin/qualify-wasix-immediate-recovery.sh" 'wait_for_unassisted_exit'
require_text "$PROJECT_ROOT/bin/qualify-wasix-immediate-recovery.sh" 'cleanup_escalation'
require_text "$PROJECT_ROOT/bin/qualify-wasix-immediate-recovery.sh" 'fresh_validate_postgres_profile_settings'
require_text "$PROJECT_ROOT/bin/qualify-wasix-immediate-recovery.sh" '--immutable-carrier-receipt'
require_text "$PROJECT_ROOT/bin/qualify-wasix-immediate-recovery.sh" 'OLIPHAUNT_WASIX_REQUIRE_ZERO_WRITE_AOT=1'
require_text "$PROJECT_ROOT/bin/qualify-wasix-immediate-recovery.sh" '--expected-postgres-executions 3'
require_text "$PROJECT_ROOT/bin/qualify-wasix-immediate-recovery.sh" 'MemorySwapMax='
require_text "$PROJECT_ROOT/bin/qualify-wasix-immediate-recovery.sh" 'expected_outer_postgres_invocations'
require_text "$PROJECT_ROOT/README.md" 'bootstrap postgres as a fourth outer postmaster'
require_text "$PROJECT_ROOT/bin/qualify-wasix-checkpoint-recycle.sh" 'ABBA'
require_text "$PROJECT_ROOT/bin/qualify-wasix-checkpoint-recycle.sh" \
  'WASIX_CHECKPOINT_CGROUP_MEMORY_MAX:-256M'
require_text "$PROJECT_ROOT/bin/qualify-wasix-checkpoint-recycle.sh" \
  '"--property=MemoryMax=$cgroup_memory_max"'
require_text "$PROJECT_ROOT/bin/qualify-wasix-checkpoint-recycle.sh" 'research-only'
require_text "$PROJECT_ROOT/bin/qualify-wasix-checkpoint-recycle.sh" '--data-checksums'
require_text "$PROJECT_ROOT/bin/qualify-wasix-checkpoint-recycle.sh" 'pg_checksums_bin'
require_text "$PROJECT_ROOT/bin/qualify-wasix-checkpoint-recycle.sh" 'extract-checkpoint-summary.py'
require_text "$PROJECT_ROOT/bench/sql/checkpoint-workload-setup.sql" 'oliphaunt_checkpoint_transaction'
require_text "$PROJECT_ROOT/probes/libpq_checkpoint_probe.c" 'CLOCK_MONOTONIC'
require_text "$PROJECT_ROOT/probes/libpq_checkpoint_probe.c" 'scheduled_ns + interval_ns'
require_text "$PROJECT_ROOT/bin/validate-checkpoint-recycle.py" 'monotonic_schedule_grid'
require_text "$PROJECT_ROOT/bin/validate-checkpoint-memory.py" 'restart_high_events_per_second'
require_text "$PROJECT_ROOT/bin/validate-wal-recycle.py" 'cross_snapshot_reuse_transitions'
require_text "$PROJECT_ROOT/profiles/checkpoint-policies/embedded-steady-v1.tsv" 'research-only'
require_text "$RESEARCH_DOCS_ROOT/checkpoint-recycle-qualification.md" 'fresh execution context'
require_text "$PROJECT_ROOT/lib/postgres-profiles.sh" 'embedded-concurrent-v1.gucs'
require_text "$PROJECT_ROOT/lib/postgres-profiles.sh" 'safe-v1.gucs'
require_text "$PROJECT_ROOT/lib/postgres-profiles.sh" 'oliphaunt.wasix-postmaster.postgres-profile-resolution.v1'
require_text "$PROJECT_ROOT/lib/sealed-carrier.sh" 'oliphaunt.wasix-postmaster.aot-producer.v2'
require_text "$PROJECT_ROOT/lib/sealed-carrier.sh" 'oliphaunt.wasix-postmaster.memory-image.v2'
require_text "$PROJECT_ROOT/lib/sealed-carrier.sh" 'oliphaunt.wasix-postmaster.deterministic-start-proof.v1'
require_text "$PROJECT_ROOT/lib/sealed-carrier.sh" 'carrier-verifier-sha256'
require_text "$PROJECT_ROOT/lib/sealed-carrier.sh" 'fresh_verify_sealed_headless_carrier'
require_text "$PROJECT_ROOT/lib/sealed-carrier.sh" 'fresh_sealed_executor_selection'
require_text "$PROJECT_ROOT/bin/bench-wasix-concurrent-query-suite.sh" 'fresh_verify_sealed_headless_carrier'
require_text "$PROJECT_ROOT/bin/bench-wasix-concurrent-query-suite.sh" 'oliphaunt.wasix-postmaster.sealed-executor-selection.v1'
require_text "$PROJECT_ROOT/lib/verify-sealed-carrier.py" 'oliphaunt.wasix-postmaster.payload-files.v1'
require_text "$PROJECT_ROOT/lib/verify-sealed-carrier.py" 'llvm-shared-memory-init-restricted-effects.v1'
require_text "$PROJECT_ROOT/lib/verify-sealed-carrier.py" 'deterministic-start-proof-output-sha256'
require_text "$PROJECT_ROOT/lib/immutable-carrier.py" 'oliphaunt.wasix-postmaster.immutable-carrier-deployment.v2'
require_text "$PROJECT_ROOT/bin/verify-immutable-sealed-carrier.sh" '--fast'
require_text "$PROJECT_ROOT/lib/qualification-identities.sh" 'FRESH_QUALIFICATION_GUEST_BUILD_RECIPE_SHA256'
require_text "$PROJECT_ROOT/bin/current-evidence-manifest.py" 'research-only-non-release'
require_text "$PROJECT_ROOT/bin/current-evidence-manifest.py" 'artifact-identity-only'
require_text "$PROJECT_ROOT/bin/current-evidence-manifest.py" 'oliphaunt.wasix-postmaster.postmaster-executor-build.v3'
require_text "$PROJECT_ROOT/bin/current-evidence-manifest.py" 'run_carrier_verifier'
require_text "$PROJECT_ROOT/runtime/bin/run-exec-backend-probes.sh" '--probe posix-spawn-sigchld-default'
require_text "$PROJECT_ROOT/runtime/bin/run-exec-backend-probes.sh" '--probe waitpid-wnohang-any'
require_text "$PROJECT_ROOT/runtime/bin/run-exec-backend-probes.sh" '--probe dynamic-vfork-exec'
require_text "$PROJECT_ROOT/runtime/bin/run-exec-backend-probes.sh" '--probe wasm-eh-sjlj'
require_text "$PROJECT_ROOT/runtime/bin/run-exec-backend-probes.sh" '--probe epoll-ofd-lifecycle'
require_text "$PROJECT_ROOT/runtime/bin/run-exec-backend-probes.sh" '--probe sync-file-range'
require_text "$PROJECT_ROOT/runtime/bin/run-exec-backend-probes.sh" '--probe directory-fsync'
require_text "$PROJECT_ROOT/runtime/bin/run-exec-backend-probes.sh" '--probe exec-shared-latch-sigurg'
require_text "$PROJECT_ROOT/runtime/bin/run-blocker-probes.sh" 'epoll_ofd_lifecycle.pic.wasm'
require_text "$PROJECT_ROOT/runtime/bin/run-blocker-probes.sh" 'sync_file_range.pic.wasm'
require_text "$PROJECT_ROOT/runtime/bin/run-blocker-probes.sh" 'directory_fsync.pic.wasm'
require_text "$PROJECT_ROOT/runtime/capabilities.tsv" 'epoll-open-file-description-lifecycle'
require_text "$PROJECT_ROOT/runtime/capabilities.tsv" 'host-file-advice'
require_text "$PROJECT_ROOT/runtime/capabilities.tsv" 'semantic-relation-cache-offers'
require_text "$PROJECT_ROOT/runtime/capabilities.tsv" 'sealed-loader-residency-audit'
require_text "$PROJECT_ROOT/runtime/capabilities.tsv" 'postmaster-product-executor'
require_text "$PROJECT_ROOT/runtime/capabilities.tsv" 'semantic-inactive-durable-wal-cache-offers'
require_text "$PROJECT_ROOT/runtime/capabilities.tsv" 'host-range-writeback'
require_text "$PROJECT_ROOT/runtime/capabilities.tsv" 'host-directory-durability'
require_text "$PROJECT_ROOT/runtime/probes/directory_fsync_probe.c" 'rename(ORIGINAL, RENAMED)'
require_text "$PROJECT_ROOT/runtime/probes/directory_fsync_probe.c" 'fdatasync(duplicate_fd)'
require_text "$PROJECT_ROOT/runtime/probes/directory_fsync_probe.c" 'fsync(duplicate_fd)'
forbid_text "$PATCH_ROOT/0004-wasix-core-execbackend-initdb-runtime.patch" 'errno == EISDIR'
require_text "$PROJECT_ROOT/runtime/probes/sync_file_range_probe.c" 'O_RDONLY'
require_text "$PROJECT_ROOT/runtime/probes/sync_file_range_probe.c" 'SYNC_FILE_RANGE_WAIT_BEFORE == 1'
require_text "$PROJECT_ROOT/runtime/probes/sync_file_range_probe.c" 'oliphaunt_postmaster_v1'
require_text "$PROJECT_ROOT/runtime/bin/verify-postmaster-wasm-import.py" 'EXPECTED_MODULE = "oliphaunt_postmaster_v1"'
require_text "$PROJECT_ROOT/runtime/bin/verify-postmaster-wasm-import.py" '"fd_sync_range": ('
require_text "$PROJECT_ROOT/runtime/bin/verify-postmaster-wasm-import.py" '"fd_cache_offer": ('
require_text "$PROJECT_ROOT/runtime/bin/verify-postmaster-wasm-import.py" '"fd_cache_revoke": ('
require_text "$PROJECT_ROOT/runtime/bin/verify-postmaster-concurrency-contract.py" 'expected_total: int | None = None'
require_text "$PROJECT_ROOT/runtime/bin/verify-postmaster-concurrency-contract.py" '"SetLatch": 2'
require_text "$PROJECT_ROOT/runtime/bin/verify-postmaster-concurrency-contract.py" '"ResetLatch": 1'
require_text "$PROJECT_ROOT/runtime/bin/verify-postmaster-concurrency-contract.py" '"WaitEventSetWait": 1'
require_text "$PROJECT_ROOT/bin/bench-wasix-concurrent-query-suite.sh" 'content-addressed-read-only'
require_text "$PROJECT_ROOT/bin/bench-wasix-concurrent-query-suite.sh" 'assert_frozen_measurement_tool_closure'
require_text "$PROJECT_ROOT/runtime/probes/epoll_ofd_lifecycle_probe.c" 'PAYLOAD_OLD_ALIAS'
require_text "$PROJECT_ROOT/runtime/probes/epoll_ofd_lifecycle_probe.c" 'reused_read_fd != old_read_fd'
require_text "$PROJECT_ROOT/runtime/probes/epoll_ofd_lifecycle_probe.c" 'close(old_alias)'
require_text "$PROJECT_ROOT/runtime/probes/exec_shared_latch_sigurg_probe.c" 'kill(getpid(), 0)'
require_text "$PROJECT_ROOT/runtime/probes/exec_shared_latch_sigurg_probe.c" 'kill(child_pid, 0)'
require_text "$PROJECT_ROOT/runtime/probes/exec_shared_latch_sigurg_probe.c" 'errno != ESRCH'
require_text "$PROJECT_ROOT/moon.yml" 'liboliphaunt-wasix-postmaster:runtime-build'
require_text "$PROJECT_ROOT/moon.yml" 'liboliphaunt-wasix-postmaster:postgres-build'
require_text "$PROJECT_ROOT/moon.yml" 'liboliphaunt-wasix-postmaster:initdb-stress'
require_text "$PROJECT_ROOT/moon.yml" 'liboliphaunt-wasix-postmaster:smoke'
require_text "$PROJECT_ROOT/README.md" '## Build toolchain boundary'
require_text "$RESEARCH_DOCS_ROOT/architecture.md" 'EXEC_BACKEND'
require_text "$RESEARCH_DOCS_ROOT/concurrent-root-cause.md" 'PG_WASIX_ATOMIC_LATCH_STATE'
require_text "$PROJECT_ROOT/runtime/capabilities.tsv" 'cross-instance-packed-latch-state'
require_text "$PROJECT_ROOT/sources.lock.toml" '[current_postgresql_patches.packed_atomic_latch_state]'

awk '
  $0 == "  - id: \"liboliphaunt-wasix\"" {
    if ((getline next_line) > 0 && next_line == "    scope: \"build\"") found = 1
  }
  END { exit(found ? 0 : 1) }
' "$PROJECT_ROOT/moon.yml" ||
  fail "moon project must declare liboliphaunt-wasix as its build-scope recipe owner"

require_moon_task_text check '"liboliphaunt-wasix:check"'
require_moon_task_text postgres-build '"/src/runtimes/liboliphaunt/wasix-postmaster/runtime/bin/verify-postmaster-wasm-import.py"'
require_moon_task_text linear-memory-test '"liboliphaunt-wasix-postmaster:runtime-build"'
require_moon_task_text linear-memory-test 'runInCI: false'
for toolchain_task in check runtime-build configure postgres-build blocker-probes regression; do
  require_moon_task_text "$toolchain_task" "/src/sources/toolchains/wasix.toml"
  require_moon_task_text "$toolchain_task" "/src/runtimes/liboliphaunt/wasix/assets/build/docker/**/*"
  require_moon_task_text "$toolchain_task" "/src/runtimes/liboliphaunt/wasix/assets/build/docker_wasix_env.sh"
done

[ ! -e "$PROJECT_ROOT/bin/install-wasmer.sh" ] ||
  fail "stock Wasmer downloader is forbidden; build the exact pinned patched runtime"
if find "$PROJECT_ROOT/bin" "$PROJECT_ROOT/lib" "$PROJECT_ROOT/runtime/bin" \
  -type f ! -name 'check-prior-art.sh' -print0 \
  | xargs -0 grep -nF 'github.com/wasmerio/wasmer/releases/download' \
  >/dev/null 2>&1
then
  fail "live scripts must not download an unverified stock Wasmer runtime"
fi

if [ -e "$PROJECT_ROOT/release.toml" ]; then
  fail "research project must not define release.toml"
fi
if grep -Fq 'release-product' "$PROJECT_ROOT/moon.yml"; then
  fail "research project must not carry the release-product tag"
fi

project_relative="${PROJECT_ROOT#"$REPO_ROOT"/}"
while IFS= read -r -d '' relative; do
  script="$REPO_ROOT/$relative"
  [ -e "$script" ] || continue
  case "$relative" in
    *.sh) bash -n "$script" || fail "shell syntax failed: $script" ;;
  esac
  case "$relative" in
    "$project_relative"/bin/*|"$project_relative"/runtime/bin/*)
      if [ "$(head -c 2 "$script")" = '#!' ]; then
        [ -x "$script" ] || fail "command entry point is not executable: $script"
      fi
      ;;
    "$project_relative"/lib/*)
      [ ! -x "$script" ] || fail "library source must not be executable: $script"
      ;;
  esac
done < <(git -C "$REPO_ROOT" ls-files -z -- \
  "${PROJECT_ROOT#"$REPO_ROOT"/}")

python3 "$PROJECT_ROOT/runtime/bin/verify-source-lock.py" ||
  fail "source lock reconciliation failed"
python3 "$PROJECT_ROOT/runtime/bin/verify-source-lock.test.py" ||
  fail "source lock verifier tests failed"
python3 "$PATCH_ROOT/0007-wasix-semantic-relation-cache-offers.test.py" ||
  fail "semantic relation cache-offer patch tests failed"
python3 "$PATCH_ROOT/0008-wasix-packed-atomic-latch-state.test.py" ||
  fail "packed atomic latch-state patch tests failed"
python3 "$PATCH_ROOT/0009-wasix-inactive-durable-wal-cache-offer.test.py" ||
  fail "inactive durable WAL cache-offer patch tests failed"
python3 "$PROJECT_ROOT/runtime/bin/verify-runtime-state-ownership.test.py" ||
  fail "runtime-state ownership verifier tests failed"
python3 "$PROJECT_ROOT/runtime/bin/verify-runtime-execution-ownership.test.py" ||
  fail "runtime execution ownership verifier tests failed"
python3 "$PROJECT_ROOT/bin/run-frozen-measurement.test.py" ||
  fail "frozen measurement-tool closure tests failed"
bash "$PROJECT_ROOT/lib/common.test.sh" || fail "patched Wasmer receipt selection tests failed"
bash "$PROJECT_ROOT/bin/postgres-baseline.test.sh" ||
  fail "PostgreSQL baseline identity tests failed"
bash "$PROJECT_ROOT/bin/build-wasix-core.backend.test.sh" ||
  fail "WASIX core backend validation tests failed"
bash "$PROJECT_ROOT/lib/host-fd-telemetry.test.sh" || fail "host FD telemetry tests failed"
bash "$PROJECT_ROOT/lib/process-supervision.test.sh" || fail "process supervision tests failed"
python3 "$PROJECT_ROOT/lib/signal-owned-pid.test.py" || fail "pidfd ownership tests failed"
bash "$PROJECT_ROOT/lib/server-lifecycle.test.sh" || fail "server lifecycle tests failed"
bash "$PROJECT_ROOT/lib/postgres-profiles.test.sh" || fail "PostgreSQL profile resolution tests failed"
python3 "$PROJECT_ROOT/lib/shared_memory_provider.test.py" ||
  fail "shared-memory provider lifecycle tests failed"
python3 "$PROJECT_ROOT/lib/immutable-carrier.test.py" ||
  fail "immutable carrier identity tests failed"
python3 "$PROJECT_ROOT/lib/verify-sealed-carrier.test.py" ||
  fail "sealed carrier schema verifier tests failed"
python3 "$PROJECT_ROOT/lib/sealed_export_chain.test.py" ||
  fail "sealed-export predecessor-chain tests failed"
python3 "$PROJECT_ROOT/lib/linear_memory_transaction.test.py" ||
  fail "linear-memory durable transaction tests failed"
python3 "$PROJECT_ROOT/lib/durable_publication.test.py" ||
  fail "durable receipt publication tests failed"
python3 "$PROJECT_ROOT/lib/durable_publication_crash.test.py" ||
  fail "durable receipt crash-boundary tests failed"
python3 "$PROJECT_ROOT/lib/guest_build_provenance.test.py" ||
  fail "durable guest closure provenance tests failed"
bash "$PROJECT_ROOT/bin/seal-wasix-core-exports.transaction.test.sh" ||
  fail "sealed export crash-recovery transaction tests failed"
bash "$PROJECT_ROOT/lib/wasix-build-lock.test.sh" ||
  fail "shared WASIX core build lock tests failed"
bash "$PROJECT_ROOT/bin/build-sealed-headless-carrier.test.sh" || fail "sealed headless carrier packaging tests failed"
bash "$PROJECT_ROOT/bin/qualify-wasix-single-backend.test.sh" || fail "single-backend qualifier evidence tests failed"
bash "$PROJECT_ROOT/bin/qualify-wasix-libpq-latency.test.sh" ||
  fail "true-libpq latency qualifier tests failed"
bash "$PROJECT_ROOT/bin/qualify-wasix-immediate-recovery.test.sh" ||
  fail "immediate-recovery exit tests failed"
python3 "$PROJECT_ROOT/bin/compare-libpq-latency.test.py" ||
  fail "true-libpq latency comparator tests failed"
python3 "$PROJECT_ROOT/bin/classify-linux-file-residency.test.py" ||
  fail "Linux file-residency classifier tests failed"
python3 "$PROJECT_ROOT/bin/validate-sealed-loader-audit.test.py" ||
  fail "sealed-loader residency audit tests failed"
python3 "$PROJECT_ROOT/bin/validate-file-cache-telemetry.test.py" ||
  fail "observe-only file-cache telemetry validation tests failed"
python3 "$PROJECT_ROOT/bin/validate-adaptive-file-cache-telemetry.test.py" ||
  fail "adaptive file-cache telemetry validation tests failed"
bash "$PROJECT_ROOT/bin/summarize-linux-smaps.test.sh" || fail "Linux smaps summary tests failed"
bash "$PROJECT_ROOT/bin/summarize-libpq-latency.test.sh" || fail "libpq latency evidence tests failed"
bash "$PROJECT_ROOT/bin/validate-host-fd-churn.test.sh" || fail "host FD churn validation tests failed"
bash "$PROJECT_ROOT/bin/validate-memory-evidence.test.sh" || fail "memory evidence validation tests failed"
bash "$PROJECT_ROOT/bin/bench-memory-budget-options.test.sh" ||
  fail "benchmark memory budget option tests failed"
bash "$PROJECT_ROOT/bin/bench-shared-memory-provider-options.test.sh" ||
  fail "benchmark shared-memory provider option tests failed"
bash "$PROJECT_ROOT/bin/bench-instrumentation-policy.test.sh" ||
  fail "benchmark instrumentation policy tests failed"
bash -n "$PROJECT_ROOT/bin/bench-wasix-concurrent-query-suite.sh" ||
  fail "concurrent benchmark syntax failed"
python3 "$PROJECT_ROOT/bin/freeze-wasix-lifecycle-evidence.test.py" ||
  fail "WASIX lifecycle evidence freezer tests failed"
python3 "$PROJECT_ROOT/bin/validate-wasix-lifecycle-plateau.test.py" ||
  fail "WASIX lifecycle plateau validation tests failed"
python3 "$PROJECT_ROOT/bin/validate-wasix-lifecycle-memory-plateau.test.py" ||
  fail "WASIX lifecycle memory plateau validation tests failed"
bash "$PROJECT_ROOT/bin/lifecycle-memory-checkpoint.test.sh" ||
  fail "WASIX lifecycle memory checkpoint integration tests failed"
python3 "$PROJECT_ROOT/bin/freeze-wasix-lifecycle-policy.test.py" ||
  fail "WASIX exact lifecycle policy freezer tests failed"
bash "$PROJECT_ROOT/bin/resource-evidence.test.sh" || fail "resource evidence tests failed"
bash "$PROJECT_ROOT/bin/resource-monitor-race-retry.test.sh" ||
  fail "resource monitor process-tree retry tests failed"
bash "$PROJECT_ROOT/bin/process-tree-collector.test.sh" ||
  fail "bounded process-tree collector tests failed"
bash "$PROJECT_ROOT/bin/connected-client-gate.test.sh" ||
  fail "connected client population-gate tests failed"
bash "$PROJECT_ROOT/bin/smoke-wasix-concurrent-options.test.sh" ||
  fail "concurrent smoke option tests failed"
python3 "$PROJECT_ROOT/bin/delta-pg-stat-io.test.py" || fail "pg_stat_io delta tests failed"
python3 "$PROJECT_ROOT/bin/compare-postgres-settings.test.py" || fail "PostgreSQL settings comparison tests failed"
python3 "$PROJECT_ROOT/runtime/bin/verify-postmaster-wasm-import.test.py" ||
  fail "postmaster Wasm import verifier tests failed"
python3 "$PROJECT_ROOT/runtime/bin/verify-postmaster-concurrency-contract.test.py" ||
  fail "postmaster Wasm concurrency contract verifier tests failed"
bash "$PROJECT_ROOT/bin/seal-wasix-core-exports.test.sh" ||
  fail "sealed export closure policy and analyzer tests failed"
bash "$PROJECT_ROOT/bin/qualify-wasix-checkpoint-recycle.test.sh" ||
  fail "checkpoint/recycle qualifier plan tests failed"
python3 "$PROJECT_ROOT/bin/validate-checkpoint-recycle.test.py" ||
  fail "checkpoint/recycle fixed-offer tests failed"
python3 "$PROJECT_ROOT/bin/validate-checkpoint-memory.test.py" ||
  fail "checkpoint/recycle memory tests failed"
python3 "$PROJECT_ROOT/bin/validate-wal-recycle.test.py" ||
  fail "WAL recycle evidence tests failed"
python3 "$PROJECT_ROOT/bin/extract-checkpoint-summary.test.py" ||
  fail "checkpoint summary extraction tests failed"
python3 "$PROJECT_ROOT/bin/summarize-checkpoint-qualification.test.py" ||
  fail "checkpoint/recycle paired summary tests failed"
python3 "$PROJECT_ROOT/bin/cold-ownership.test.py" ||
  fail "cold-ownership validation and summary tests failed"
bash "$PROJECT_ROOT/bin/qualify-wasix-cold-ownership.test.sh" ||
  fail "cold-ownership qualifier plan tests failed"
bash "$PROJECT_ROOT/bin/regress-suite-name.test.sh" ||
  fail "regression suite-name validation tests failed"

listed="$({
  while IFS= read -r patch_name || [ -n "$patch_name" ]; do
    case "$patch_name" in
      ''|'#'*) continue ;;
      /*|*../*) fail "unsafe PostgreSQL patch entry: $patch_name" ;;
    esac
    [ -f "$PATCH_ROOT/$patch_name" ] || fail "series names missing patch: $patch_name"
    printf '%s\n' "$patch_name"
  done <"$SERIES_FILE"
} | sort)"
actual="$(find "$PATCH_ROOT" -maxdepth 1 -type f -name '*.patch' -exec basename {} \; | sort)"
[ "$listed" = "$actual" ] || {
  printf 'listed patches:\n%s\nactual patches:\n%s\n' "$listed" "$actual" >&2
  fail "PostgreSQL patch series and directory differ"
}

forbid_text "$PROJECT_ROOT/postgres/experiment-patch-disposition.toml" \
  'status = "deferred'
listed_main_optimizations="$({
  while IFS= read -r patch_name || [ -n "$patch_name" ]; do
    case "$patch_name" in
      ''|'#'*) continue ;;
      0039*|0040*|0041*)
        fail \
          "binding-only main patch is forbidden in the multi-backend postmaster series: $patch_name"
        ;;
      */*) fail "unsafe main-optimization patch entry: $patch_name" ;;
    esac
    [ -f "$MAIN_OPTIMIZATION_PATCH_ROOT/$patch_name" ] && \
      [ ! -L "$MAIN_OPTIMIZATION_PATCH_ROOT/$patch_name" ] ||
      fail "main optimization series names missing regular patch: $patch_name"
    printf '%s\n' "$patch_name"
  done <"$MAIN_OPTIMIZATION_SERIES"
} | sort)"
declared_main_optimizations="$(
  sed -n 's|^current_patch = ".*/\([^/"]*\.patch\)"$|\1|p' \
    "$PROJECT_ROOT/postgres/experiment-patch-disposition.toml" | sort
)"
[ "$listed_main_optimizations" = "$declared_main_optimizations" ] || {
  printf 'main optimization series:\n%s\ndeclared adopted optimizations:\n%s\n' \
    "$listed_main_optimizations" "$declared_main_optimizations" >&2
  fail "main optimization series and adopted experiment dispositions differ"
}

while IFS= read -r patch; do
  git apply --numstat <"$patch" >/dev/null || fail "malformed patch: $patch"
done < <(find "$PATCH_ROOT" "$PROJECT_ROOT/runtime/patches" -type f -name '*.patch' -print | sort)
execbackend_patch="$PATCH_ROOT/0004-wasix-core-execbackend-initdb-runtime.patch"
[ "$(grep -Fxc $'+\t\t\tif (errno == EINTR)' "$execbackend_patch")" -eq 1 ] &&
  [ "$(grep -Fxc $'+\t\tif (nread < 0 && errno == EINTR)' "$execbackend_patch")" -eq 1 ] ||
  fail "WASIX exact/pipe readers do not both retry interrupted reads"
while IFS= read -r patch_name || [ -n "$patch_name" ]; do
  case "$patch_name" in
    ''|'#'*) continue ;;
  esac
  git apply --numstat <"$MAIN_OPTIMIZATION_PATCH_ROOT/$patch_name" >/dev/null ||
    fail "malformed main optimization patch: $patch_name"
done <"$MAIN_OPTIMIZATION_SERIES"

if find "$PROJECT_ROOT/bin" "$PROJECT_ROOT/lib" "$PROJECT_ROOT/runtime/bin" \
  -type f ! -name 'check-prior-art.sh' -print0 \
  | xargs -0 grep -nE 'assets/wasix-build|work/experiments/fresh-wasix-postgres|REL_18_3' \
  >/dev/null 2>&1
then
  fail "live scripts still reference the historical experiment layout"
fi

if grep -Fq 'Arc<HashMap>-style registry' "$PROJECT_ROOT/runtime/capabilities.tsv" ||
  grep -Fq 'not-implemented:registry-reuse-cleanup' "$PROJECT_ROOT/runtime/capabilities.tsv"
then
  fail "capability ledger contains the superseded shared-futex registry model"
fi

while IFS= read -r ref; do
  rel="${ref#project:}"
  [ -e "$PROJECT_ROOT/$rel" ] || fail "capability ledger references missing project path: $rel"
done < <(grep -oE 'project:[^;[:space:]]+' "$PROJECT_ROOT/runtime/capabilities.tsv" | sort -u)

while IFS= read -r ref; do
  rel="${ref#repo:}"
  [ -e "$REPO_ROOT/$rel" ] || fail "capability ledger references missing repository path: $rel"
done < <(grep -oE 'repo:[^;[:space:]]+' "$PROJECT_ROOT/runtime/capabilities.tsv" | sort -u)

printf 'wasix-postmaster prior-art checks passed\n'
