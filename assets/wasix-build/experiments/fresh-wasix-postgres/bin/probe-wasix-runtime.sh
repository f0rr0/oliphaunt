#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"

fresh_ensure_dirs
docker_bin="$(fresh_docker_bin)"
wasmer_bin="$(fresh_wasmer_bin)"

fresh_ensure_docker_image >/dev/null

probe_source_dir="$FRESH_ROOT/runtime-probes"
probe_build_dir="$FRESH_WORK_ROOT/builds/runtime-probes"
report="$REPORT_DIR/wasix-runtime-capabilities.md"
compile_log="$REPORT_DIR/wasix-runtime-probes.compile.log"
mmap_log="$REPORT_DIR/wasix-runtime-probe.mmap.log"
fork_pic_log="$REPORT_DIR/wasix-runtime-probe.fork-pic.log"
fork_shm_log="$REPORT_DIR/wasix-runtime-probe.fork-shm.log"
mkdir -p "$probe_build_dir"

fresh_write_report_header "$report" "WASIX Runtime Capability Probes"

{
  printf '## Scope\n\n'
  printf -- '- Wasmer: `%s`\n' "$("$wasmer_bin" --version 2>/dev/null || true)"
  printf -- '- wasixcc image: `%s`\n' "$FRESH_WASIX_DOCKER_IMAGE"
  printf -- '- Probe source directory: `%s`\n' "$probe_source_dir"
  printf -- '- Probe build directory: `%s`\n' "$probe_build_dir"
  printf -- '- Policy: record runtime/toolchain blockers as blockers; do not hide them with PostgreSQL success shims.\n\n'
  printf '## Official Capability Surface Checked\n\n'
  printf -- '- WASIX documents sockets, threads/futexes, `proc_fork`, `proc_spawn`, `proc_join`, pipes/events, polling, and filesystem calls: https://wasix.org/docs/explanation/features\n'
  printf -- '- Wasmer CLI documents LLVM/Cranelift/Singlepass, profiling, networking, threads, module linking, snapshots/journals, and cache controls: https://docs.wasmer.io/runtime/cli/\n'
  printf -- '- Wasmer dynamic-linking guidance requires PIC/EH for dynamic main modules and side modules: https://wasmer.io/es/posts/dynamic-linking-in-wasm-wasix\n\n'
} >>"$report"

: >"$compile_log"
"$docker_bin" run --rm \
  -v "$REPO_ROOT:/work" \
  -w /work \
  -e PROBE_SOURCE_DIR="${probe_source_dir#$REPO_ROOT/}" \
  -e PROBE_BUILD_DIR="${probe_build_dir#$REPO_ROOT/}" \
  "$FRESH_WASIX_DOCKER_IMAGE" \
  bash -lc '
    set -euo pipefail
    source ./assets/wasix-build/docker_wasix_env.sh
    mkdir -p "$PROBE_BUILD_DIR"
    WASIXCC_WASM_EXCEPTIONS=yes wasixcc -O0 -g3 -fPIC -pthread \
      "$PROBE_SOURCE_DIR/mmap_probe.c" \
      -o "$PROBE_BUILD_DIR/mmap_probe.wasm"
    WASIXCC_WASM_EXCEPTIONS=yes wasixcc -O0 -g3 -fPIC -pthread \
      "$PROBE_SOURCE_DIR/fork_shm_probe.c" \
      -o "$PROBE_BUILD_DIR/fork_shm_probe.pic.wasm"
    WASIXCC_WASM_EXCEPTIONS=no wasixcc -O0 -g3 -pthread \
      "$PROBE_SOURCE_DIR/libc_fork_shm_probe.c" \
      -o "$PROBE_BUILD_DIR/libc_fork_shm_probe.asyncify.wasm"
  ' >"$compile_log" 2>&1

run_probe() {
  local name="$1"
  local log="$2"
  shift 2

  set +e
  env WASMER_DIR="$FRESH_WORK_ROOT/tools/wasmer-home" \
    WASMER_CACHE_DIR="$FRESH_WORK_ROOT/tools/wasmer-cache" \
    "$wasmer_bin" run --quiet "$@" >"$log" 2>&1
  local status=$?
  set -e

  {
    printf '## %s\n\n' "$name"
    printf -- '- Exit code: `%s`\n' "$status"
    printf -- '- Log: `%s`\n\n' "$log"
    printf '```text\n'
    sed -n '1,80p' "$log"
    printf '```\n\n'
  } >>"$report"
}

run_probe "PIC mmap MAP_FIXED" "$mmap_log" \
  --enable-exceptions --enable-threads \
  --volume "$FRESH_WORK_ROOT:$FRESH_WORK_ROOT" \
  "$probe_build_dir/mmap_probe.wasm"

run_probe "PIC proc_fork" "$fork_pic_log" \
  --enable-exceptions --enable-threads \
  --volume "$FRESH_WORK_ROOT:$FRESH_WORK_ROOT" \
  "$probe_build_dir/fork_shm_probe.pic.wasm"

run_probe "Asyncify fork with MAP_SHARED shm" "$fork_shm_log" \
  --enable-threads \
  --volume "$FRESH_WORK_ROOT:$FRESH_WORK_ROOT" \
  "$probe_build_dir/libc_fork_shm_probe.asyncify.wasm"

{
  printf '## Interpretation\n\n'
  printf -- '- `MAP_FIXED` failure blocks EXEC_BACKEND shared-memory reattach, because PostgreSQL needs shared pointers to remain valid in child processes.\n'
  printf -- '- PIC `proc_fork` failure blocks the dynamic-linking lane from using fork directly.\n'
  printf -- '- Asyncify `fork()` succeeds as process control flow, but `MAP_SHARED` writes do not propagate back to the parent in this runtime, so it is not sufficient for PostgreSQL shared memory semantics.\n'
  printf -- '- A production-quality fix belongs in the WASIX runtime/toolchain shared-memory/process implementation, or in a PostgreSQL architecture explicitly based on a real shared-address primitive. Thread-backed backends would be a separate design, not the native process model.\n'
} >>"$report"

printf 'wrote WASIX runtime capability report to %s\n' "$report"
