#!/usr/bin/env bash

set -euo pipefail

UPSTREAM_SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FRESH_ROOT="$(cd "$UPSTREAM_SOURCE_ROOT/.." && pwd)"
REPO_ROOT="$(cd "$FRESH_ROOT/../../../.." && pwd)"
WASIX_BUILD_ROOT="$REPO_ROOT/assets/wasix-build"
UPSTREAM_WORK_ROOT="${UPSTREAM_WORK_ROOT:-$WASIX_BUILD_ROOT/work/upstream}"
PROBE_SOURCE_DIR="$UPSTREAM_SOURCE_ROOT/probes"

DOCKER_IMAGE="${DOCKER_IMAGE:-pglite-oxide-wasix-build:local}"
WASMER_BIN="${WASMER_BIN:-$UPSTREAM_WORK_ROOT/wasmer/target/release/wasmer}"
BUILD_DIR="$UPSTREAM_WORK_ROOT/build/probes"
REPORT_DIR="$UPSTREAM_WORK_ROOT/reports"
PATCHED_WASIXCC_SYSROOT_PREFIX="$UPSTREAM_WORK_ROOT/build/patched-wasixcc-sysroot"
WASIXCC_SYSROOT_PREFIX="${WASIXCC_SYSROOT_PREFIX-$PATCHED_WASIXCC_SYSROOT_PREFIX}"
STRICT=0
STRICT_DYNAMIC=0
COMPILE=auto
PROBES=()

usage() {
	cat <<EOF
usage: $0 [--wasmer-bin PATH] [--compile|--no-compile] [--strict] [--strict-dynamic] [--probe NAME]

Runs the small WASIX/PostgreSQL blocker probes against a Wasmer binary.

Environment:
  DOCKER_IMAGE               Docker image with wasixcc. Default: $DOCKER_IMAGE
  WASMER_BIN                 Wasmer binary under test. Default: pinned experiment Wasmer.
  WASIXCC_SYSROOT_PREFIX     Sysroot prefix passed through to wasixcc.
                              Repo-local host paths are translated to /work paths in Docker.
                              Default: $PATCHED_WASIXCC_SYSROOT_PREFIX
                              Set to an empty string to use the toolchain default.
  WASIXCC_SYSROOT            Optional exact sysroot passed through to wasixcc.
                              Repo-local host paths are translated to /work paths in Docker.

Examples:
  $0 --probe dynamic-dlopen --strict
  $0 --probe dynamic-fork-dlopen --strict-dynamic
EOF
}

while [ "$#" -gt 0 ]; do
	case "$1" in
		--wasmer-bin)
			WASMER_BIN="$2"
			shift 2
			;;
		--compile)
			COMPILE=yes
			shift
			;;
		--no-compile)
			COMPILE=no
			shift
			;;
		--strict)
			STRICT=1
			shift
			;;
		--strict-dynamic)
			STRICT_DYNAMIC=1
			shift
			;;
		--probe)
			PROBES+=("$2")
			shift 2
			;;
		-h|--help)
			usage
			exit 0
			;;
		*)
			echo "unknown argument: $1" >&2
			usage >&2
			exit 2
			;;
	esac
done

if [ ! -x "$WASMER_BIN" ]; then
	echo "Wasmer binary is not executable: $WASMER_BIN" >&2
	exit 127
fi
if ! command -v docker >/dev/null 2>&1; then
	echo "missing required command: docker" >&2
	exit 127
fi

probe_selected() {
	local name="$1"
	local probe

	if [ "${#PROBES[@]}" -eq 0 ]; then
		return 0
	fi
	for probe in "${PROBES[@]}"; do
		if [ "$probe" = "$name" ]; then
			return 0
		fi
	done
	return 1
}

known_probe() {
	case "$1" in
		mmap-fixed|mmap-writeback|dir-readdir-unlink|futex-timeout|shared-futex-fork|rlimit-stack|spawn-shmem-reattach|\
		posix-spawn-sigchld-default|posix-spawn-sigchld|\
		waitpid-wnohang-any|posix-spawn-blocking-wait|posix-spawn-pipe|\
		epoll-listen-accept|epoll-listen-after-vfork-exec|\
		epoll-listen-external|epoll-listen-external-after-pipe|\
		socket-nonblock|libc-eh-fork|dynamic-dlopen|dynamic-vfork-exec|dynamic-fork-dlopen|dynamic-fork-indirect|wasm-eh-sjlj)
			return 0
			;;
		*)
			return 1
			;;
	esac
}

probe_outputs_ready() {
	local probe

	for probe in "$@"; do
		case "$probe" in
			mmap-fixed)
				[ -f "$BUILD_DIR/mmap_fixed.pic.wasm" ] || return 1
				;;
			mmap-writeback)
				[ -f "$BUILD_DIR/mmap_writeback.pic.wasm" ] || return 1
				;;
			dir-readdir-unlink)
				[ -f "$BUILD_DIR/dir_readdir_unlink.pic.wasm" ] || return 1
				;;
			futex-timeout)
				[ -f "$BUILD_DIR/futex_timeout.pic.wasm" ] || return 1
				;;
			shared-futex-fork)
				[ -f "$BUILD_DIR/shared_futex_fork.pic.wasm" ] || return 1
				;;
			rlimit-stack)
				[ -f "$BUILD_DIR/rlimit_stack.pic.wasm" ] || return 1
				;;
			spawn-shmem-reattach)
				[ -f "$BUILD_DIR/spawn_shmem_reattach.pic.wasm" ] || return 1
				;;
			posix-spawn-sigchld-default)
				[ -f "$BUILD_DIR/posix_spawn_sigchld_default.pic.wasm" ] || return 1
				;;
			posix-spawn-sigchld)
				[ -f "$BUILD_DIR/posix_spawn_sigchld.pic.wasm" ] || return 1
				;;
			waitpid-wnohang-any)
				[ -f "$BUILD_DIR/waitpid_wnohang_any.pic.wasm" ] || return 1
				;;
			posix-spawn-blocking-wait)
				[ -f "$BUILD_DIR/posix_spawn_blocking_wait.pic.wasm" ] || return 1
				;;
			posix-spawn-pipe)
				[ -f "$BUILD_DIR/posix_spawn_pipe.pic.wasm" ] || return 1
				;;
			epoll-listen-accept)
				[ -f "$BUILD_DIR/epoll_listen_accept.pic.wasm" ] || return 1
				;;
			epoll-listen-after-vfork-exec)
				[ -f "$BUILD_DIR/epoll_listen_after_vfork_exec.pic.wasm" ] || return 1
				;;
			epoll-listen-external)
				[ -f "$BUILD_DIR/epoll_listen_external.pic.wasm" ] || return 1
				;;
			epoll-listen-external-after-pipe)
				[ -f "$BUILD_DIR/epoll_listen_external_after_pipe.pic.wasm" ] || return 1
				;;
			socket-nonblock)
				[ -f "$BUILD_DIR/socket_nonblock.pic.wasm" ] || return 1
				;;
			libc-eh-fork)
				[ -f "$BUILD_DIR/libc_eh_fork.pic.wasm" ] || return 1
				;;
			dynamic-dlopen)
				[ -f "$BUILD_DIR/dynamic_dlopen_probe.pic.wasm" ] || return 1
				[ -f "$BUILD_DIR/libwasix_dynamic_probe_side.so" ] || return 1
				;;
			dynamic-vfork-exec)
				[ -f "$BUILD_DIR/dynamic_vfork_exec.pic.wasm" ] || return 1
				;;
			dynamic-fork-dlopen)
				[ -f "$BUILD_DIR/dynamic_fork_dlopen_probe.pic.wasm" ] || return 1
				[ -f "$BUILD_DIR/libwasix_dynamic_probe_side.so" ] || return 1
				;;
			dynamic-fork-indirect)
				[ -f "$BUILD_DIR/dynamic_fork_indirect_probe.pic.wasm" ] || return 1
				;;
			wasm-eh-sjlj)
				[ -f "$BUILD_DIR/wasm_eh_sjlj.pic.wasm" ] || return 1
				;;
			*)
				return 1
				;;
		esac
	done
}

selected_probe_outputs_ready() {
	if [ "${#PROBES[@]}" -eq 0 ]; then
		probe_outputs_ready \
			mmap-fixed \
			mmap-writeback \
			dir-readdir-unlink \
			futex-timeout \
			shared-futex-fork \
			rlimit-stack \
			spawn-shmem-reattach \
			posix-spawn-sigchld-default \
			posix-spawn-sigchld \
			waitpid-wnohang-any \
			posix-spawn-blocking-wait \
			posix-spawn-pipe \
			epoll-listen-accept \
			epoll-listen-after-vfork-exec \
			epoll-listen-external \
			epoll-listen-external-after-pipe \
			socket-nonblock \
			libc-eh-fork \
			dynamic-dlopen \
			dynamic-vfork-exec \
			dynamic-fork-dlopen \
			dynamic-fork-indirect \
			wasm-eh-sjlj
		return
	fi

	probe_outputs_ready "${PROBES[@]}"
}

for probe in "${PROBES[@]}"; do
	if ! known_probe "$probe"; then
		echo "unknown probe: $probe" >&2
		usage >&2
		exit 2
	fi
done

WASMER_BIN_HASH="$(shasum -a 256 "$WASMER_BIN" | awk '{print $1}')"
WASMER_CACHE_DIR_FOR_BIN="$UPSTREAM_WORK_ROOT/tools/wasmer-cache/$WASMER_BIN_HASH"

mkdir -p \
	"$BUILD_DIR" \
	"$BUILD_DIR/dev-shm" \
	"$REPORT_DIR" \
	"$UPSTREAM_WORK_ROOT/tools/wasmer-home" \
	"$WASMER_CACHE_DIR_FOR_BIN"

sysroot_fingerprint() {
	local root="$1"

	if [ -z "$root" ]; then
		return
	fi
	if [ -f "$root/.fresh-sysroot-signature" ]; then
		printf 'sysroot_signature_file=%s\n' "$root/.fresh-sysroot-signature"
		cat "$root/.fresh-sysroot-signature"
		printf '\n'
		return
	fi
	if [ -d "$root" ]; then
		find "$root" -type f \( \
			-path '*/lib/wasm32-wasi/*.a' -o \
			-path '*/include/*.h' -o \
			-path '*/include/sys/*.h' -o \
			-path '*/include/netinet/*.h' \
		\) -print0 |
			sort -z |
			xargs -0 shasum -a 256
		return
	fi
	printf 'missing-sysroot=%s\n' "$root"
}

compile_signature() {
	{
		printf 'docker=%s\n' "$DOCKER_IMAGE"
		printf 'process_model=%s\n' 'ehpic-spawn-fork-dynamic-dlopen-noasyncify-v5'
		printf 'sysroot_prefix=%s\n' "${WASIXCC_SYSROOT_PREFIX:-}"
		sysroot_fingerprint "${WASIXCC_SYSROOT_PREFIX:-}"
		printf 'sysroot=%s\n' "${WASIXCC_SYSROOT:-}"
		sysroot_fingerprint "${WASIXCC_SYSROOT:-}"
		find "$PROBE_SOURCE_DIR" -type f -name '*.c' -print0 |
			sort -z |
			xargs -0 shasum -a 256
	} | shasum -a 256 | awk '{print $1}'
}

docker_path_for() {
	local path="$1"

	case "$path" in
		"$REPO_ROOT")
			printf '/work\n'
			;;
		"$REPO_ROOT"/*)
			printf '/work/%s\n' "${path#$REPO_ROOT/}"
			;;
		*)
			printf '%s\n' "$path"
			;;
	esac
}

compile_probes() {
	local signature_file="$BUILD_DIR/.compile-signature"
	local signature
	local docker_env=()

	if [ "${#PROBES[@]}" -ne 0 ]; then
		local filter_hash
		filter_hash="$(printf '%s\n' "${PROBES[@]}" | sort | shasum -a 256 | awk '{print $1}')"
		signature_file="$BUILD_DIR/.compile-signature.$filter_hash"
	fi

	signature="$(compile_signature)"
	if [ "$COMPILE" = "auto" ] &&
		[ -f "$signature_file" ] &&
		[ "$(cat "$signature_file")" = "$signature" ] &&
		selected_probe_outputs_ready; then
		return
	fi
	if [ "$COMPILE" = "no" ]; then
		return
	fi

	if [ -n "${WASIXCC_SYSROOT_PREFIX:-}" ]; then
		docker_env+=(-e "WASIXCC_SYSROOT_PREFIX=$(docker_path_for "$WASIXCC_SYSROOT_PREFIX")")
	fi
	if [ -n "${WASIXCC_SYSROOT:-}" ]; then
		docker_env+=(-e "WASIXCC_SYSROOT=$(docker_path_for "$WASIXCC_SYSROOT")")
	fi
	docker run --rm \
		-v "$REPO_ROOT:/work" \
		-w /work \
		"${docker_env[@]}" \
		-e "SELECTED_PROBES=${PROBES[*]:-}" \
		-e "PROBE_SOURCE_DIR=${PROBE_SOURCE_DIR#$REPO_ROOT/}" \
		-e "PROBE_BUILD_DIR=${BUILD_DIR#$REPO_ROOT/}" \
		"$DOCKER_IMAGE" \
		bash -lc '
			set -euo pipefail
			source ./assets/wasix-build/docker_wasix_env.sh
			mkdir -p "$PROBE_BUILD_DIR"
			selected_probe() {
				case " ${SELECTED_PROBES:-} " in
					"  ")
						return 0
						;;
					*" $1 "*)
						return 0
						;;
					*)
						return 1
						;;
				esac
			}
			if selected_probe mmap-fixed; then
			WASIXCC_WASM_EXCEPTIONS=yes wasixcc -O0 -g3 -fPIC -pthread \
				"$PROBE_SOURCE_DIR/mmap_fixed_probe.c" \
				-o "$PROBE_BUILD_DIR/mmap_fixed.pic.wasm"
			fi
			if selected_probe mmap-writeback; then
			WASIXCC_WASM_EXCEPTIONS=yes wasixcc -O0 -g3 -fPIC -pthread \
				"$PROBE_SOURCE_DIR/mmap_writeback_probe.c" \
				-o "$PROBE_BUILD_DIR/mmap_writeback.pic.wasm"
			fi
			if selected_probe dir-readdir-unlink; then
			WASIXCC_WASM_EXCEPTIONS=yes wasixcc -O0 -g3 -fPIC -pthread \
				"$PROBE_SOURCE_DIR/dir_readdir_unlink_probe.c" \
				-o "$PROBE_BUILD_DIR/dir_readdir_unlink.pic.wasm"
			fi
			if selected_probe futex-timeout; then
			WASIXCC_WASM_EXCEPTIONS=yes wasixcc -O0 -g3 -fPIC -pthread \
				"$PROBE_SOURCE_DIR/futex_timeout_probe.c" \
				-o "$PROBE_BUILD_DIR/futex_timeout.pic.wasm"
			fi
			if selected_probe shared-futex-fork; then
			WASIXCC_WASM_EXCEPTIONS=yes wasixcc -O0 -g3 -fPIC -pthread \
				"$PROBE_SOURCE_DIR/shared_futex_fork_probe.c" \
				-o "$PROBE_BUILD_DIR/shared_futex_fork.pic.wasm"
			fi
			if selected_probe rlimit-stack; then
			WASIXCC_WASM_EXCEPTIONS=yes wasixcc -O0 -g3 -fPIC -pthread \
				"$PROBE_SOURCE_DIR/rlimit_stack_probe.c" \
				-o "$PROBE_BUILD_DIR/rlimit_stack.pic.wasm"
			fi
			if selected_probe spawn-shmem-reattach; then
			WASIXCC_WASM_EXCEPTIONS=yes wasixcc -O0 -g3 -fPIC -pthread \
				"$PROBE_SOURCE_DIR/spawn_shmem_reattach_probe.c" \
				-o "$PROBE_BUILD_DIR/spawn_shmem_reattach.pic.wasm"
			fi
			if selected_probe posix-spawn-sigchld-default; then
			WASIXCC_WASM_EXCEPTIONS=yes wasixcc -O0 -g3 -fPIC -pthread \
				"$PROBE_SOURCE_DIR/posix_spawn_sigchld_default_probe.c" \
				-o "$PROBE_BUILD_DIR/posix_spawn_sigchld_default.pic.wasm"
			fi
			if selected_probe posix-spawn-sigchld; then
			WASIXCC_WASM_EXCEPTIONS=yes wasixcc -O0 -g3 -fPIC -pthread \
				"$PROBE_SOURCE_DIR/posix_spawn_sigchld_probe.c" \
				-o "$PROBE_BUILD_DIR/posix_spawn_sigchld.pic.wasm"
			fi
			if selected_probe waitpid-wnohang-any; then
			WASIXCC_WASM_EXCEPTIONS=yes wasixcc -O0 -g3 -fPIC -pthread \
				"$PROBE_SOURCE_DIR/waitpid_wnohang_any_probe.c" \
				-o "$PROBE_BUILD_DIR/waitpid_wnohang_any.pic.wasm"
			fi
			if selected_probe posix-spawn-blocking-wait; then
			WASIXCC_WASM_EXCEPTIONS=yes wasixcc -O0 -g3 -fPIC -pthread \
				"$PROBE_SOURCE_DIR/posix_spawn_blocking_wait_probe.c" \
				-o "$PROBE_BUILD_DIR/posix_spawn_blocking_wait.pic.wasm"
			fi
			if selected_probe posix-spawn-pipe; then
			WASIXCC_WASM_EXCEPTIONS=yes wasixcc -O0 -g3 -fPIC -pthread \
				"$PROBE_SOURCE_DIR/posix_spawn_pipe_probe.c" \
				-o "$PROBE_BUILD_DIR/posix_spawn_pipe.pic.wasm"
			fi
			if selected_probe epoll-listen-accept; then
			WASIXCC_WASM_EXCEPTIONS=yes wasixcc -O0 -g3 -fPIC -pthread \
				"$PROBE_SOURCE_DIR/epoll_listen_accept_probe.c" \
				-o "$PROBE_BUILD_DIR/epoll_listen_accept.pic.wasm"
			fi
			if selected_probe epoll-listen-after-vfork-exec; then
			WASIXCC_WASM_EXCEPTIONS=yes wasixcc -O0 -g3 -fPIC -pthread \
				"$PROBE_SOURCE_DIR/epoll_listen_after_vfork_exec_probe.c" \
				-o "$PROBE_BUILD_DIR/epoll_listen_after_vfork_exec.pic.wasm"
			fi
			if selected_probe epoll-listen-external; then
			WASIXCC_WASM_EXCEPTIONS=yes wasixcc -O0 -g3 -fPIC -pthread \
				"$PROBE_SOURCE_DIR/epoll_listen_external_probe.c" \
				-o "$PROBE_BUILD_DIR/epoll_listen_external.pic.wasm"
			fi
			if selected_probe epoll-listen-external-after-pipe; then
			WASIXCC_WASM_EXCEPTIONS=yes wasixcc -O0 -g3 -fPIC -pthread \
				"$PROBE_SOURCE_DIR/epoll_listen_external_after_pipe_probe.c" \
				-o "$PROBE_BUILD_DIR/epoll_listen_external_after_pipe.pic.wasm"
			fi
			if selected_probe socket-nonblock; then
			WASIXCC_WASM_EXCEPTIONS=yes wasixcc -O0 -g3 -fPIC -pthread \
				"$PROBE_SOURCE_DIR/socket_nonblock_probe.c" \
				-o "$PROBE_BUILD_DIR/socket_nonblock.pic.wasm"
			fi
			if selected_probe libc-eh-fork; then
			WASIXCC_WASM_EXCEPTIONS=yes wasixcc -O0 -g3 -fPIC -pthread \
				"$PROBE_SOURCE_DIR/libc_eh_fork_probe.c" \
				-o "$PROBE_BUILD_DIR/libc_eh_fork.pic.wasm"
			fi
			if selected_probe dynamic-dlopen || selected_probe dynamic-fork-dlopen; then
			WASIXCC_WASM_EXCEPTIONS=yes wasixcc -O0 -g3 -fPIC -sPIC=yes -pthread \
				-Wl,-shared \
				"$PROBE_SOURCE_DIR/dynamic_probe_side.c" \
				-o "$PROBE_BUILD_DIR/libwasix_dynamic_probe_side.so"
			fi
			if selected_probe dynamic-dlopen; then
			WASIXCC_WASM_EXCEPTIONS=yes wasixcc -O0 -g3 -fPIC -sPIC=yes -pthread \
				-sMODULE_KIND=dynamic-main \
				-sSTACK_SIZE=2MB \
				-sINITIAL_MEMORY=64MB \
				"$PROBE_SOURCE_DIR/dynamic_dlopen_probe.c" \
				-o "$PROBE_BUILD_DIR/dynamic_dlopen_probe.pic.wasm"
			fi
			if selected_probe dynamic-vfork-exec; then
			WASIXCC_WASM_EXCEPTIONS=yes wasixcc -O0 -g3 -fPIC -pthread \
				"$PROBE_SOURCE_DIR/dynamic_vfork_exec_probe.c" \
				-o "$PROBE_BUILD_DIR/dynamic_vfork_exec.pic.wasm"
			fi
			if selected_probe dynamic-fork-dlopen; then
			WASIXCC_WASM_EXCEPTIONS=yes wasixcc -O0 -g3 -fPIC -sPIC=yes -pthread \
				-sMODULE_KIND=dynamic-main \
				-sSTACK_SIZE=2MB \
				-sINITIAL_MEMORY=64MB \
				"$PROBE_SOURCE_DIR/dynamic_fork_dlopen_probe.c" \
				-o "$PROBE_BUILD_DIR/dynamic_fork_dlopen_probe.pic.wasm"
			fi
			if selected_probe dynamic-fork-indirect; then
			WASIXCC_WASM_EXCEPTIONS=yes wasixcc -O0 -g3 -fPIC -sPIC=yes -pthread \
				-sMODULE_KIND=dynamic-main \
				-sSTACK_SIZE=2MB \
				-sINITIAL_MEMORY=64MB \
				"$PROBE_SOURCE_DIR/dynamic_fork_indirect_probe.c" \
				-o "$PROBE_BUILD_DIR/dynamic_fork_indirect_probe.pic.wasm"
			fi
			if selected_probe wasm-eh-sjlj; then
			WASIXCC_WASM_EXCEPTIONS=yes wasixcc -O0 -g3 -fPIC -pthread \
				"$PROBE_SOURCE_DIR/wasm_eh_sjlj_probe.c" \
				-o "$PROBE_BUILD_DIR/wasm_eh_sjlj.pic.wasm"
			fi
		'
	printf '%s\n' "$signature" >"$signature_file"
}

write_header() {
	local report="$1"

	{
		printf '# WASIX Upstream Blocker Probes\n\n'
		printf -- '- Generated: `%s`\n' "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
		printf -- '- Upstream source root: `%s`\n' "$UPSTREAM_SOURCE_ROOT"
		printf -- '- Upstream work root: `%s`\n' "$UPSTREAM_WORK_ROOT"
		printf -- '- Wasmer under test: `%s`\n' "$WASMER_BIN"
		printf -- '- Wasmer binary hash: `%s`\n' "$WASMER_BIN_HASH"
		printf -- '- Wasmer cache dir: `%s`\n' "$WASMER_CACHE_DIR_FOR_BIN"
		printf -- '- Wasmer version: `%s`\n' "$("$WASMER_BIN" --version 2>/dev/null || true)"
		printf -- '- Docker image: `%s`\n' "$DOCKER_IMAGE"
		printf -- '- wasixcc sysroot prefix: `%s`\n' "${WASIXCC_SYSROOT_PREFIX:-}"
		printf -- '- wasixcc sysroot: `%s`\n\n' "${WASIXCC_SYSROOT:-}"
		printf -- '- Production process model: `EH/PIC dynamic-main + side-module dlopen + posix_spawn/proc_spawn2 + MAP_FIXED shared mmap reattach`\n'
		printf -- '- Decision probes: `dynamic-fork-dlopen` checks whether dynamic-main, copied proc_fork, shared mmap replay, and child-side dlopen compose; `dynamic-fork-indirect` checks copied fork through a function-pointer callsite. They are reported separately unless `--strict-dynamic` is set; they are not the extension-loading gate.\n'
		if [ "${#PROBES[@]}" -eq 0 ]; then
			printf -- '- Probe filter: `all`\n'
		else
			printf -- '- Probe filter: `%s`\n' "${PROBES[*]}"
		fi
	} >"$report"
}

run_probe() {
	local name="$1"
	local wasm="$2"
	local flags="$3"
	local report="$4"
	local log="$REPORT_DIR/$name.log"
	local status

	set +e
	env \
		WASMER_DIR="$UPSTREAM_WORK_ROOT/tools/wasmer-home" \
		WASMER_CACHE_DIR="$WASMER_CACHE_DIR_FOR_BIN" \
			"$WASMER_BIN" run --quiet $flags \
				--cwd "$UPSTREAM_WORK_ROOT" \
				--volume "$UPSTREAM_WORK_ROOT:$UPSTREAM_WORK_ROOT" \
				--volume "$BUILD_DIR:/lib" \
				--volume "$BUILD_DIR/dev-shm:/dev/shm" \
				"$wasm" >"$log" 2>&1
	status=$?
	set -e

	{
		printf '## %s\n\n' "$name"
		printf -- '- Exit code: `%s`\n' "$status"
		printf -- '- Log: `%s`\n\n' "$log"
		printf '```text\n'
		sed -n '1,120p' "$log"
		printf '```\n\n'
	} >>"$report"

	if [ "$status" -eq 0 ]; then
		printf 'PASS %s\n' "$name"
		return 0
	fi

	printf 'FAIL %s exit=%s\n' "$name" "$status"
	return 1
}

run_external_epoll_probe() {
	local name="$1"
	local wasm="$2"
	local log="$REPORT_DIR/$name.log"
	local connector_log="$REPORT_DIR/$name.connector.log"
	local status
	local port
	local wasmer_pid

	rm -f "$log" "$connector_log"
	set +e
	env \
		WASMER_DIR="$UPSTREAM_WORK_ROOT/tools/wasmer-home" \
		WASMER_CACHE_DIR="$WASMER_CACHE_DIR_FOR_BIN" \
			"$WASMER_BIN" run --quiet --enable-exceptions --enable-threads --net \
				--cwd "$UPSTREAM_WORK_ROOT" \
				--volume "$UPSTREAM_WORK_ROOT:$UPSTREAM_WORK_ROOT" \
				--volume "$BUILD_DIR:/lib" \
				--volume "$BUILD_DIR/dev-shm:/dev/shm" \
				"$wasm" >"$log" 2>&1 &
	wasmer_pid=$!

	for _ in $(seq 1 100); do
		port="$(awk '
			match($0, /port=[0-9]+/) {
				value = substr($0, RSTART + 5, RLENGTH - 5)
				print value
				exit
			}
		' "$log" 2>/dev/null)"
		if [ -z "$port" ]; then
			port="$(lsof -nP -a -p "$wasmer_pid" -iTCP -sTCP:LISTEN 2>/dev/null |
				awk '/TCP 127[.]0[.]0[.]1:/ {
					sub(/.*127[.]0[.]0[.]1:/, "", $0)
					sub(/ .*/, "", $0)
					print
					exit
				}')"
		fi
		if [ -n "$port" ]; then
			break
		fi
		if ! kill -0 "$wasmer_pid" 2>/dev/null; then
			break
		fi
		sleep 0.1
	done

	if [ -n "$port" ]; then
		printf x | nc -w 2 127.0.0.1 "$port" >"$connector_log" 2>&1
	else
		printf 'listener port was not visible from lsof\n' >"$connector_log"
	fi

	wait "$wasmer_pid"
	status=$?
	set -e

	{
		printf '## %s\n\n' "$name"
		printf -- '- Exit code: `%s`\n' "$status"
		printf -- '- Log: `%s`\n' "$log"
		printf -- '- Connector log: `%s`\n\n' "$connector_log"
		printf '```text\n'
		sed -n '1,120p' "$log"
		printf '```\n\n'
	} >>"$report"

	if [ "$status" -eq 0 ]; then
		printf 'PASS %s\n' "$name"
		return 0
	fi

	printf 'FAIL %s exit=%s\n' "$name" "$status"
	return 1
}

run_selected_probe() {
	local name="$1"
	local wasm="$2"
	local flags="$3"

	if probe_selected "$name"; then
		run_probe "$name" "$wasm" "$flags" "$report" || failures=$((failures + 1))
	fi
}

run_selected_external_epoll_probe() {
	local name="$1"
	local wasm="$2"

	if probe_selected "$name"; then
		run_external_epoll_probe "$name" "$wasm" || failures=$((failures + 1))
	fi
}

run_selected_decision_probe() {
	local name="$1"
	local wasm="$2"
	local flags="$3"

	if probe_selected "$name"; then
		run_probe "$name" "$wasm" "$flags" "$report" || decision_failures=$((decision_failures + 1))
	fi
}

compile_probes

report="$REPORT_DIR/blocker-probes.md"
write_header "$report"

failures=0
decision_failures=0
run_selected_probe "mmap-fixed" "$BUILD_DIR/mmap_fixed.pic.wasm" "--enable-exceptions --enable-threads"
run_selected_probe "mmap-writeback" "$BUILD_DIR/mmap_writeback.pic.wasm" "--enable-exceptions --enable-threads"
run_selected_probe "dir-readdir-unlink" "$BUILD_DIR/dir_readdir_unlink.pic.wasm" "--enable-exceptions --enable-threads"
run_selected_probe "futex-timeout" "$BUILD_DIR/futex_timeout.pic.wasm" "--enable-exceptions --enable-threads"
run_selected_probe "shared-futex-fork" "$BUILD_DIR/shared_futex_fork.pic.wasm" "--enable-exceptions --enable-threads"
run_selected_probe "rlimit-stack" "$BUILD_DIR/rlimit_stack.pic.wasm" "--enable-exceptions --enable-threads --stack-size 33554432"
run_selected_probe "spawn-shmem-reattach" "$BUILD_DIR/spawn_shmem_reattach.pic.wasm" "--enable-exceptions --enable-threads"
run_selected_probe "posix-spawn-sigchld-default" "$BUILD_DIR/posix_spawn_sigchld_default.pic.wasm" "--enable-exceptions --enable-threads"
run_selected_probe "posix-spawn-sigchld" "$BUILD_DIR/posix_spawn_sigchld.pic.wasm" "--enable-exceptions --enable-threads"
run_selected_probe "waitpid-wnohang-any" "$BUILD_DIR/waitpid_wnohang_any.pic.wasm" "--enable-exceptions --enable-threads"
run_selected_probe "posix-spawn-blocking-wait" "$BUILD_DIR/posix_spawn_blocking_wait.pic.wasm" "--enable-exceptions --enable-threads"
run_selected_probe "posix-spawn-pipe" "$BUILD_DIR/posix_spawn_pipe.pic.wasm" "--enable-exceptions --enable-threads"
run_selected_probe "epoll-listen-accept" "$BUILD_DIR/epoll_listen_accept.pic.wasm" "--enable-exceptions --enable-threads --net"
run_selected_probe "epoll-listen-after-vfork-exec" "$BUILD_DIR/epoll_listen_after_vfork_exec.pic.wasm" "--enable-exceptions --enable-threads --net"
run_selected_external_epoll_probe "epoll-listen-external" "$BUILD_DIR/epoll_listen_external.pic.wasm"
run_selected_external_epoll_probe "epoll-listen-external-after-pipe" "$BUILD_DIR/epoll_listen_external_after_pipe.pic.wasm"
run_selected_probe "socket-nonblock" "$BUILD_DIR/socket_nonblock.pic.wasm" "--enable-exceptions --enable-threads --net"
run_selected_probe "libc-eh-fork" "$BUILD_DIR/libc_eh_fork.pic.wasm" "--enable-exceptions --enable-threads"
run_selected_probe "dynamic-dlopen" "$BUILD_DIR/dynamic_dlopen_probe.pic.wasm" "--enable-exceptions --enable-threads"
run_selected_probe "dynamic-vfork-exec" "$BUILD_DIR/dynamic_vfork_exec.pic.wasm" "--enable-exceptions --enable-threads"
run_selected_decision_probe "dynamic-fork-dlopen" "$BUILD_DIR/dynamic_fork_dlopen_probe.pic.wasm" "--enable-exceptions --enable-threads"
run_selected_decision_probe "dynamic-fork-indirect" "$BUILD_DIR/dynamic_fork_indirect_probe.pic.wasm" "--enable-exceptions --enable-threads"
run_selected_probe "wasm-eh-sjlj" "$BUILD_DIR/wasm_eh_sjlj.pic.wasm" "--enable-exceptions --enable-threads"

{
	printf '## Summary\n\n'
	printf -- '- Failed probes: `%s`\n' "$failures"
	printf -- '- Failed decision probes: `%s`\n' "$decision_failures"
	printf -- '- Strict mode: `%s`\n' "$STRICT"
	printf -- '- Strict dynamic mode: `%s`\n' "$STRICT_DYNAMIC"
	if [ "${#PROBES[@]}" -eq 0 ]; then
		printf -- '- Probe filter: `all`\n'
	else
		printf -- '- Probe filter: `%s`\n' "${PROBES[*]}"
	fi
} >>"$report"

printf 'wrote %s\n' "$report"

if [ "$STRICT" -eq 1 ] && [ "$failures" -ne 0 ]; then
	exit 1
fi
if [ "$STRICT_DYNAMIC" -eq 1 ] && [ "$decision_failures" -ne 0 ]; then
	exit 1
fi
