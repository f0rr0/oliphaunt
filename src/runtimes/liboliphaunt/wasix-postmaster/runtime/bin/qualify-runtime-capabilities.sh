#!/usr/bin/env bash

set -euo pipefail

FRESH_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$FRESH_ROOT/lib/common.sh"

UPSTREAM_WORK_ROOT="${UPSTREAM_WORK_ROOT:-$FRESH_WORK_ROOT/runtime}"
WASMER_BIN="${WASMER_BIN:-$UPSTREAM_WORK_ROOT/wasmer/target/release/wasmer}"
fresh_require_patched_wasmer "$WASMER_BIN"

portable_args=(--compile)
case "${OLIPHAUNT_WASIX_POSTMASTER_PORTABLE_INPUTS:-0}" in
	0) ;;
	1) portable_args=(--no-compile --portable-inputs) ;;
	*)
		echo 'OLIPHAUNT_WASIX_POSTMASTER_PORTABLE_INPUTS must be 0 or 1' >&2
		exit 2
		;;
esac

probes=(
	mmap-fixed
	mmap-writeback
	directory-fsync
	dir-readdir-unlink
	futex-timeout
	rlimit-stack
	spawn-shmem-reattach
	exec-shared-latch-sigurg
	posix-spawn-sigchld-default
	posix-spawn-sigchld
	waitpid-wnohang-any
	posix-spawn-blocking-wait
	posix-spawn-pipe
	epoll-listen-accept
	epoll-listen-after-vfork-exec
	epoll-listen-external
	epoll-listen-external-after-pipe
	epoll-ofd-lifecycle
	socket-nonblock
	dynamic-dlopen
	dynamic-vfork-exec
	wasm-eh-sjlj
)
if [ "$(uname -s)" = Linux ]; then
	# This advisory writeback primitive has exact Linux semantics and the
	# runtime deliberately reports it as unsupported on other hosts.
	probes+=(sync-file-range)
fi
probe_args=()
for probe in "${probes[@]}"; do
	probe_args+=(--probe "$probe")
done

exec env UPSTREAM_WORK_ROOT="$UPSTREAM_WORK_ROOT" \
	"$FRESH_ROOT/runtime/bin/validate-runtime-capabilities.sh" \
	--wasmer-bin "$WASMER_BIN" \
	"${portable_args[@]}" \
	--strict \
	"${probe_args[@]}" \
	"$@"
