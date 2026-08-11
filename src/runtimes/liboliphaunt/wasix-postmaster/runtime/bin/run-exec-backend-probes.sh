#!/usr/bin/env bash

set -euo pipefail

FRESH_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$FRESH_ROOT/lib/common.sh"

UPSTREAM_WORK_ROOT="${UPSTREAM_WORK_ROOT:-$FRESH_WORK_ROOT/runtime}"
WASMER_BIN="${WASMER_BIN:-$UPSTREAM_WORK_ROOT/wasmer/target/release/wasmer}"
fresh_require_patched_wasmer "$WASMER_BIN"

exec env UPSTREAM_WORK_ROOT="$UPSTREAM_WORK_ROOT" \
	"$FRESH_ROOT/runtime/bin/run-blocker-probes.sh" \
	--wasmer-bin "$WASMER_BIN" \
	--compile \
	--strict \
	--probe mmap-fixed \
	--probe mmap-writeback \
	--probe sync-file-range \
	--probe directory-fsync \
	--probe dir-readdir-unlink \
	--probe futex-timeout \
	--probe rlimit-stack \
	--probe spawn-shmem-reattach \
	--probe exec-shared-latch-sigurg \
	--probe posix-spawn-sigchld-default \
	--probe posix-spawn-sigchld \
	--probe waitpid-wnohang-any \
	--probe posix-spawn-blocking-wait \
	--probe posix-spawn-pipe \
	--probe epoll-listen-accept \
	--probe epoll-listen-after-vfork-exec \
	--probe epoll-listen-external \
	--probe epoll-listen-external-after-pipe \
	--probe epoll-ofd-lifecycle \
	--probe socket-nonblock \
	--probe dynamic-dlopen \
	--probe dynamic-vfork-exec \
	--probe wasm-eh-sjlj \
	"$@"
