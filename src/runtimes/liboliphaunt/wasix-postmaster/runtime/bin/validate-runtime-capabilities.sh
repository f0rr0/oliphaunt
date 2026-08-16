#!/usr/bin/env bash

set -euo pipefail

FRESH_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$FRESH_ROOT/lib/common.sh"
UPSTREAM_SOURCE_ROOT="$FRESH_ROOT/runtime"
UPSTREAM_WORK_ROOT="${UPSTREAM_WORK_ROOT:-$FRESH_WORK_ROOT/runtime}"
PROBE_SOURCE_DIR="$UPSTREAM_SOURCE_ROOT/probes"

DOCKER_IMAGE="${DOCKER_IMAGE:-$FRESH_WASIX_DOCKER_IMAGE}"
WASMER_BIN="${WASMER_BIN:-$UPSTREAM_WORK_ROOT/wasmer/target/release/wasmer}"
BUILD_DIR="$UPSTREAM_WORK_ROOT/build/probes"
REPORT_DIR="$UPSTREAM_WORK_ROOT/reports"
PATCHED_WASIXCC_SYSROOT_PREFIX="$UPSTREAM_WORK_ROOT/build/patched-wasixcc-sysroot"
WASIXCC_SYSROOT_PREFIX_WAS_SET=0
WASIXCC_SYSROOT_VARIANT_WAS_SET=0
WASIXCC_SYSROOT_WAS_SET=0
[ "${WASIXCC_SYSROOT_PREFIX+x}" = x ] && WASIXCC_SYSROOT_PREFIX_WAS_SET=1
[ "${WASIXCC_SYSROOT_VARIANT+x}" = x ] && WASIXCC_SYSROOT_VARIANT_WAS_SET=1
[ "${WASIXCC_SYSROOT+x}" = x ] && WASIXCC_SYSROOT_WAS_SET=1
WASIXCC_SYSROOT_PREFIX="${WASIXCC_SYSROOT_PREFIX-$PATCHED_WASIXCC_SYSROOT_PREFIX}"
WASIXCC_SYSROOT_VARIANT="${WASIXCC_SYSROOT_VARIANT-sysroot-ehpic}"
WASIXCC_SYSROOT="${WASIXCC_SYSROOT-}"
VARIANT_MANIFEST_NAME=".oliphaunt-patched-sysroot.manifest"
CARRIER_MANIFEST_NAME=".oliphaunt-patched-sysroots.manifest"
STRICT=0
COMPILE=auto
VALIDATE_SYSROOT_ONLY=0
PORTABLE_INPUTS=0
PROBES=()
WASMER_ARGS=()

usage() {
	cat <<EOF
usage: $0 [--wasmer-bin PATH] [--wasmer-arg ARG] [--compile|--no-compile] [--portable-inputs] [--strict] [--probe NAME]
          [--validate-sysroot-only]

Validates the WASIX/PostgreSQL runtime capabilities against a Wasmer binary.

Options:
  --wasmer-arg ARG           Extra argument passed to Wasmer run. Repeatable.

Environment:
  DOCKER_IMAGE               Docker image with wasixcc. Default: $DOCKER_IMAGE
  WASMER_BIN                 Wasmer binary under test. Default: pinned product Wasmer.
  WASIXCC_SYSROOT_PREFIX     Patched sysroot carrier passed through to wasixcc.
                              Repo-local host paths are translated to /work paths in Docker.
                              Default: $PATCHED_WASIXCC_SYSROOT_PREFIX
  WASIXCC_SYSROOT_VARIANT    Exact EH/PIC carrier variant to validate and use.
                              Supported: sysroot-ehpic, sysroot-exnref-ehpic.
                              Default: sysroot-ehpic
  WASIXCC_SYSROOT            Optional exact variant path. When provided without
                              prefix/variant overrides, both are inferred from it.
                              Repo-local host paths are translated to /work paths in Docker.

Examples:
  $0 --probe dynamic-dlopen --strict
  $0 --probe exec-shared-latch-sigurg --strict
EOF
}

while [ "$#" -gt 0 ]; do
	case "$1" in
		--wasmer-bin)
			[ "$#" -ge 2 ] || {
				echo '--wasmer-bin requires a path' >&2
				exit 2
			}
			WASMER_BIN="$2"
			shift 2
			;;
		--wasmer-arg)
			[ "$#" -ge 2 ] || {
				echo '--wasmer-arg requires an argument' >&2
				exit 2
			}
			WASMER_ARGS+=("$2")
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
		--portable-inputs)
			PORTABLE_INPUTS=1
			shift
			;;
		--strict)
			STRICT=1
			shift
			;;
		--probe)
			[ "$#" -ge 2 ] || {
				echo '--probe requires a name' >&2
				exit 2
			}
			PROBES+=("$2")
			shift 2
			;;
		--validate-sysroot-only)
			VALIDATE_SYSROOT_ONLY=1
			shift
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
[ "$PORTABLE_INPUTS" -eq 0 ] || [ "$COMPILE" = no ] || {
	echo '--portable-inputs requires --no-compile' >&2
	exit 2
}

fail_sysroot() {
	printf 'validate-runtime-capabilities: patched sysroot rejected: %s\n' "$*" >&2
	exit 2
}

sha256_file() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | awk '{print $1}'
	else
		shasum -a 256 "$1" | awk '{print $1}'
	fi
}

sha256_stream() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum | awk '{print $1}'
	else
		shasum -a 256 | awk '{print $1}'
	fi
}

strip_trailing_slashes() {
	local value="$1"

	while [ "$value" != / ] && [ "${value%/}" != "$value" ]; do
		value="${value%/}"
	done
	printf '%s\n' "$value"
}

valid_sha256() {
	[ "${#1}" -eq 64 ] || return 1
	case "$1" in
		*[!0-9a-f]*) return 1 ;;
		*) return 0 ;;
	esac
}

manifest_value() {
	local manifest="$1"
	local key="$2"

	awk -v expected_key="$key" '
		{
			separator = index($0, "=")
			if (separator > 0 && substr($0, 1, separator - 1) == expected_key) {
				count += 1
				value = substr($0, separator + 1)
			}
		}
		END {
			if (count != 1) exit 2
			print value
		}
	' "$manifest"
}

required_manifest_value() {
	local manifest="$1"
	local key="$2"
	local value

	if ! value="$(manifest_value "$manifest" "$key")"; then
		fail_sysroot "manifest must contain exactly one $key field: $manifest"
	fi
	[ -n "$value" ] || fail_sysroot "manifest field $key must not be empty: $manifest"
	printf '%s\n' "$value"
}

require_manifest_value() {
	local manifest="$1"
	local key="$2"
	local expected="$3"
	local actual

	actual="$(required_manifest_value "$manifest" "$key")"
	[ "$actual" = "$expected" ] ||
		fail_sysroot "$key mismatch in $manifest: expected $expected, got $actual"
}

header_tree_sha256() {
	local include_root="$1"
	local entry
	local relative

	[ -d "$include_root" ] || fail_sysroot "missing include tree: $include_root"
	[ ! -L "$include_root" ] || fail_sysroot "include tree must not be a symlink: $include_root"
	(
		cd "$include_root"
		while IFS= read -r -d '' entry; do
			relative="${entry#./}"
			if [ -L "$entry" ]; then
				printf 'symlink\0%s\0%s\0' "$relative" "$(readlink "$entry")"
			else
				printf 'file\0%s\0%s\0' "$relative" "$(sha256_file "$entry")"
			fi
		done < <(find . \( -type f -o -type l \) -print0 | LC_ALL=C sort -z)
	) | sha256_stream
}

carrier_variant_manifest_sha256() {
	local carrier_manifest="$1"
	local variant="$2"

	awk -F '\t' -v expected_variant="$variant" '
		$1 == expected_variant {
			if (NF != 2) exit 3
			count += 1
			value = $2
		}
		END {
			if (count != 1) exit 2
			print value
		}
	' "$carrier_manifest"
}

select_exact_sysroot() {
	local expected_sysroot
	local selected_basename

	if [ "$WASIXCC_SYSROOT_WAS_SET" -eq 1 ]; then
		[ -n "$WASIXCC_SYSROOT" ] || fail_sysroot 'WASIXCC_SYSROOT must not be empty'
		WASIXCC_SYSROOT="$(strip_trailing_slashes "$WASIXCC_SYSROOT")"
		selected_basename="${WASIXCC_SYSROOT##*/}"
		if [ "$WASIXCC_SYSROOT_VARIANT_WAS_SET" -eq 0 ]; then
			WASIXCC_SYSROOT_VARIANT="$selected_basename"
		fi
		if [ "$WASIXCC_SYSROOT_PREFIX_WAS_SET" -eq 0 ]; then
			WASIXCC_SYSROOT_PREFIX="${WASIXCC_SYSROOT%/*}"
		fi
	fi

	WASIXCC_SYSROOT_PREFIX="$(strip_trailing_slashes "$WASIXCC_SYSROOT_PREFIX")"
	[ -n "$WASIXCC_SYSROOT_PREFIX" ] || fail_sysroot 'WASIXCC_SYSROOT_PREFIX must not be empty'
	case "$WASIXCC_SYSROOT_VARIANT" in
		sysroot-ehpic)
			WASIXCC_EXCEPTION_MODE=yes
			EXPECTED_EXNREF_EH=no
			;;
		sysroot-exnref-ehpic)
			WASIXCC_EXCEPTION_MODE=exnref
			EXPECTED_EXNREF_EH=yes
			;;
		*)
			fail_sysroot "unsupported or non-PIC variant: $WASIXCC_SYSROOT_VARIANT"
			;;
	esac

	case "$WASIXCC_SYSROOT_PREFIX" in
		"$REPO_ROOT"/*) ;;
		*) fail_sysroot "carrier must be repo-local so Docker can mount it: $WASIXCC_SYSROOT_PREFIX" ;;
	esac
	case "/$WASIXCC_SYSROOT_PREFIX/" in
		*/../*|*/./*) fail_sysroot "carrier path must not contain dot segments: $WASIXCC_SYSROOT_PREFIX" ;;
	esac

	expected_sysroot="$WASIXCC_SYSROOT_PREFIX/$WASIXCC_SYSROOT_VARIANT"
	if [ "$WASIXCC_SYSROOT_WAS_SET" -eq 0 ]; then
		WASIXCC_SYSROOT="$expected_sysroot"
	fi
	[ "$WASIXCC_SYSROOT" = "$expected_sysroot" ] ||
		fail_sysroot "exact sysroot must equal prefix/variant ($expected_sysroot), got $WASIXCC_SYSROOT"
}

validate_exact_sysroot() {
	local carrier_variants
	local carrier_variant_list=()
	local carrier_variant
	local seen_variants=' '
	local selected_listed=0
	local candidate_root
	local candidate
	local indexed_manifest_sha256
	local signature
	local expected
	local actual
	local source_commit
	local source_patch_sha256
	local source_worktree_sha256
	local expected_patch="$UPSTREAM_SOURCE_ROOT/patches/wasix-libc/0001-postgres-wasix-blockers.patch"

	CARRIER_MANIFEST="$WASIXCC_SYSROOT_PREFIX/$CARRIER_MANIFEST_NAME"
	PATCHED_SYSROOT_MANIFEST="$WASIXCC_SYSROOT/$VARIANT_MANIFEST_NAME"
	[ -d "$WASIXCC_SYSROOT_PREFIX" ] || fail_sysroot "missing carrier: $WASIXCC_SYSROOT_PREFIX"
	[ ! -L "$WASIXCC_SYSROOT_PREFIX" ] || fail_sysroot "carrier must not be a symlink: $WASIXCC_SYSROOT_PREFIX"
	[ -d "$WASIXCC_SYSROOT" ] || fail_sysroot "missing selected variant: $WASIXCC_SYSROOT"
	[ ! -L "$WASIXCC_SYSROOT" ] || fail_sysroot "selected variant must not be a symlink: $WASIXCC_SYSROOT"
	if [ ! -f "$CARRIER_MANIFEST" ] || [ -L "$CARRIER_MANIFEST" ]; then
		fail_sysroot "missing regular carrier manifest: $CARRIER_MANIFEST"
	fi
	if [ ! -f "$PATCHED_SYSROOT_MANIFEST" ] || [ -L "$PATCHED_SYSROOT_MANIFEST" ]; then
		fail_sysroot "missing regular variant manifest: $PATCHED_SYSROOT_MANIFEST"
	fi

	require_manifest_value "$CARRIER_MANIFEST" schema oliphaunt.wasix-libc-sysroots.v1
	carrier_variants="$(required_manifest_value "$CARRIER_MANIFEST" variants)"
	read -r -a carrier_variant_list <<<"$carrier_variants"
	for carrier_variant in "${carrier_variant_list[@]}"; do
		case "$carrier_variant" in
			sysroot-ehpic|sysroot-exnref-ehpic) ;;
			*) fail_sysroot "carrier declares unsupported variant: $carrier_variant" ;;
		esac
		case "$seen_variants" in
			*" $carrier_variant "*) fail_sysroot "carrier declares duplicate variant: $carrier_variant" ;;
		esac
		seen_variants="$seen_variants$carrier_variant "
		[ -d "$WASIXCC_SYSROOT_PREFIX/$carrier_variant" ] ||
			fail_sysroot "carrier manifest names a missing variant: $carrier_variant"
		[ "$carrier_variant" != "$WASIXCC_SYSROOT_VARIANT" ] || selected_listed=1
	done
	[ "$selected_listed" -eq 1 ] ||
		fail_sysroot "carrier manifest does not list selected variant: $WASIXCC_SYSROOT_VARIANT"

	for candidate_root in "$WASIXCC_SYSROOT_PREFIX"/sysroot*; do
		[ -d "$candidate_root" ] || continue
		candidate="${candidate_root##*/}"
		case "$seen_variants" in
			*" $candidate "*) ;;
			*) fail_sysroot "carrier contains unlisted stock variant: $candidate" ;;
		esac
	done

	CARRIER_MANIFEST_SHA256="$(sha256_file "$CARRIER_MANIFEST")"
	valid_sha256 "$CARRIER_MANIFEST_SHA256" || fail_sysroot 'failed to hash carrier manifest'
	[ -f "$WASIXCC_SYSROOT_PREFIX/.fresh-sysroot-signature" ] ||
		fail_sysroot "missing carrier signature: $WASIXCC_SYSROOT_PREFIX/.fresh-sysroot-signature"
	signature="$(sed -n '1p' "$WASIXCC_SYSROOT_PREFIX/.fresh-sysroot-signature")"
	if [ "$(wc -l <"$WASIXCC_SYSROOT_PREFIX/.fresh-sysroot-signature" | tr -d ' ')" -ne 1 ] ||
		! valid_sha256 "$signature"; then
		fail_sysroot 'carrier signature is not one SHA-256 value'
	fi
	[ "$signature" = "$CARRIER_MANIFEST_SHA256" ] || fail_sysroot 'carrier signature does not match its manifest'

	PATCHED_SYSROOT_MANIFEST_SHA256="$(sha256_file "$PATCHED_SYSROOT_MANIFEST")"
	valid_sha256 "$PATCHED_SYSROOT_MANIFEST_SHA256" || fail_sysroot 'failed to hash variant manifest'
	if ! indexed_manifest_sha256="$(carrier_variant_manifest_sha256 "$CARRIER_MANIFEST" "$WASIXCC_SYSROOT_VARIANT")"; then
		fail_sysroot "carrier manifest must index selected variant exactly once: $WASIXCC_SYSROOT_VARIANT"
	fi
	valid_sha256 "$indexed_manifest_sha256" || fail_sysroot 'carrier has an invalid variant manifest hash'
	[ "$indexed_manifest_sha256" = "$PATCHED_SYSROOT_MANIFEST_SHA256" ] ||
		fail_sysroot 'carrier index does not match selected variant manifest'
	[ -f "$WASIXCC_SYSROOT/.fresh-sysroot-signature" ] ||
		fail_sysroot "missing selected variant signature: $WASIXCC_SYSROOT/.fresh-sysroot-signature"
	signature="$(sed -n '1p' "$WASIXCC_SYSROOT/.fresh-sysroot-signature")"
	if [ "$(wc -l <"$WASIXCC_SYSROOT/.fresh-sysroot-signature" | tr -d ' ')" -ne 1 ] ||
		! valid_sha256 "$signature"; then
		fail_sysroot 'variant signature is not one SHA-256 value'
	fi
	[ "$signature" = "$PATCHED_SYSROOT_MANIFEST_SHA256" ] ||
		fail_sysroot 'variant signature does not match its manifest'

	require_manifest_value "$PATCHED_SYSROOT_MANIFEST" schema oliphaunt.wasix-libc-sysroot.v1
	require_manifest_value "$PATCHED_SYSROOT_MANIFEST" variant "$WASIXCC_SYSROOT_VARIANT"
	require_manifest_value "$PATCHED_SYSROOT_MANIFEST" source_patch \
		"$(fresh_project_source_identity_path "$expected_patch")"
	require_manifest_value "$PATCHED_SYSROOT_MANIFEST" docker_image "$DOCKER_IMAGE"
	require_manifest_value "$PATCHED_SYSROOT_MANIFEST" makefile Makefile-eh
	require_manifest_value "$PATCHED_SYSROOT_MANIFEST" make_jobs 2
	require_manifest_value "$PATCHED_SYSROOT_MANIFEST" target_arch wasm32
	require_manifest_value "$PATCHED_SYSROOT_MANIFEST" thread_model posix
	require_manifest_value "$PATCHED_SYSROOT_MANIFEST" pic yes
	require_manifest_value "$PATCHED_SYSROOT_MANIFEST" exnref_eh "$EXPECTED_EXNREF_EH"
	require_manifest_value "$PATCHED_SYSROOT_MANIFEST" check_symbols no
	require_manifest_value "$PATCHED_SYSROOT_MANIFEST" cc clang
	require_manifest_value "$PATCHED_SYSROOT_MANIFEST" ar llvm-ar
	require_manifest_value "$PATCHED_SYSROOT_MANIFEST" nm llvm-nm
	require_manifest_value "$PATCHED_SYSROOT_MANIFEST" libc_archive lib/wasm32-wasi/libc.a
	require_manifest_value "$PATCHED_SYSROOT_MANIFEST" mman_archive lib/wasm32-wasi/libwasi-emulated-mman.a

	source_commit="$(required_manifest_value "$PATCHED_SYSROOT_MANIFEST" source_commit)"
	case "$source_commit" in
		*[!0-9a-f]*) fail_sysroot 'source_commit is not hexadecimal' ;;
	esac
	case "${#source_commit}" in
		40|64) ;;
		*) fail_sysroot 'source_commit is not a full Git object ID' ;;
	esac
	source_worktree_sha256="$(required_manifest_value "$PATCHED_SYSROOT_MANIFEST" source_worktree_sha256)"
	valid_sha256 "$source_worktree_sha256" || fail_sysroot 'source_worktree_sha256 is invalid'
	source_patch_sha256="$(required_manifest_value "$PATCHED_SYSROOT_MANIFEST" source_patch_sha256)"
	valid_sha256 "$source_patch_sha256" || fail_sysroot 'source_patch_sha256 is invalid'
	[ -f "$expected_patch" ] || fail_sysroot "local source patch is missing: $expected_patch"
	[ "$source_patch_sha256" = "$(sha256_file "$expected_patch")" ] ||
		fail_sysroot 'carrier was not built from the current wasix-libc patch'

	PATCHED_SYSROOT_DOCKER_IMAGE_ID="$(required_manifest_value "$PATCHED_SYSROOT_MANIFEST" docker_image_id)"
	case "$PATCHED_SYSROOT_DOCKER_IMAGE_ID" in
		sha256:*)
			valid_sha256 "${PATCHED_SYSROOT_DOCKER_IMAGE_ID#sha256:}" ||
				fail_sysroot 'docker_image_id is not a sha256 image identifier'
			;;
		*) fail_sysroot 'docker_image_id is not a sha256 image identifier' ;;
	esac

	for expected in \
		lib/wasm32-wasi/libc.a \
		lib/wasm32-wasi/libwasi-emulated-mman.a; do
		if [ ! -f "$WASIXCC_SYSROOT/$expected" ] || [ -L "$WASIXCC_SYSROOT/$expected" ]; then
			fail_sysroot "missing regular selected archive: $WASIXCC_SYSROOT/$expected"
		fi
	done
	actual="$(sha256_file "$WASIXCC_SYSROOT/lib/wasm32-wasi/libc.a")"
	expected="$(required_manifest_value "$PATCHED_SYSROOT_MANIFEST" libc_archive_sha256)"
	if ! valid_sha256 "$expected" || [ "$actual" != "$expected" ]; then
		fail_sysroot 'libc.a hash does not match selected variant manifest'
	fi
	actual="$(sha256_file "$WASIXCC_SYSROOT/lib/wasm32-wasi/libwasi-emulated-mman.a")"
	expected="$(required_manifest_value "$PATCHED_SYSROOT_MANIFEST" mman_archive_sha256)"
	if ! valid_sha256 "$expected" || [ "$actual" != "$expected" ]; then
		fail_sysroot 'libwasi-emulated-mman.a hash does not match selected variant manifest'
	fi
	PATCHED_SYSROOT_HEADERS_SHA256="$(header_tree_sha256 "$WASIXCC_SYSROOT/include")"
	expected="$(required_manifest_value "$PATCHED_SYSROOT_MANIFEST" headers_sha256)"
	if ! valid_sha256 "$expected" || [ "$PATCHED_SYSROOT_HEADERS_SHA256" != "$expected" ]; then
		fail_sysroot 'header tree hash does not match selected variant manifest'
	fi
}

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
		mmap-fixed|mmap-writeback|sync-file-range|directory-fsync|dir-readdir-unlink|futex-timeout|rlimit-stack|spawn-shmem-reattach|exec-shared-latch-sigurg|setitimer-epoll-one-shot|\
		posix-spawn-sigchld-default|posix-spawn-sigchld|\
		waitpid-wnohang-any|posix-spawn-blocking-wait|posix-spawn-pipe|\
		epoll-listen-accept|epoll-listen-after-vfork-exec|\
		epoll-listen-external|epoll-listen-external-after-pipe|epoll-ofd-lifecycle|\
		socket-nonblock|dynamic-dlopen|dynamic-vfork-exec|wasm-eh-sjlj)
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
			sync-file-range)
				[ -f "$BUILD_DIR/sync_file_range.pic.wasm" ] || return 1
				;;
			directory-fsync)
				[ -f "$BUILD_DIR/directory_fsync.pic.wasm" ] || return 1
				;;
			dir-readdir-unlink)
				[ -f "$BUILD_DIR/dir_readdir_unlink.pic.wasm" ] || return 1
				;;
			futex-timeout)
				[ -f "$BUILD_DIR/futex_timeout.pic.wasm" ] || return 1
				;;
			rlimit-stack)
				[ -f "$BUILD_DIR/rlimit_stack.pic.wasm" ] || return 1
				;;
			spawn-shmem-reattach)
				[ -f "$BUILD_DIR/spawn_shmem_reattach.pic.wasm" ] || return 1
				;;
			exec-shared-latch-sigurg)
				[ -f "$BUILD_DIR/exec_shared_latch_sigurg.pic.wasm" ] || return 1
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
			epoll-ofd-lifecycle)
				[ -f "$BUILD_DIR/epoll_ofd_lifecycle.pic.wasm" ] || return 1
				;;
			socket-nonblock)
				[ -f "$BUILD_DIR/socket_nonblock.pic.wasm" ] || return 1
				;;
			dynamic-dlopen)
				[ -f "$BUILD_DIR/dynamic_dlopen_probe.pic.wasm" ] || return 1
				[ -f "$BUILD_DIR/libwasix_dynamic_probe_side.so" ] || return 1
				;;
			dynamic-vfork-exec)
				[ -f "$BUILD_DIR/dynamic_vfork_exec.pic.wasm" ] || return 1
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
			sync-file-range \
			directory-fsync \
			dir-readdir-unlink \
			futex-timeout \
			rlimit-stack \
			spawn-shmem-reattach \
			exec-shared-latch-sigurg \
			setitimer-epoll-one-shot \
			posix-spawn-sigchld-default \
			posix-spawn-sigchld \
			waitpid-wnohang-any \
			posix-spawn-blocking-wait \
			posix-spawn-pipe \
			epoll-listen-accept \
			epoll-listen-after-vfork-exec \
			epoll-listen-external \
			epoll-listen-external-after-pipe \
			epoll-ofd-lifecycle \
			socket-nonblock \
			dynamic-dlopen \
			dynamic-vfork-exec \
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

if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
	echo 'missing required SHA-256 command: sha256sum or shasum' >&2
	exit 127
fi
select_exact_sysroot
validate_exact_sysroot

if [ "$VALIDATE_SYSROOT_ONLY" -eq 1 ]; then
	printf 'validated sysroot variant: %s\n' "$WASIXCC_SYSROOT_VARIANT"
	printf 'exact sysroot: %s\n' "$WASIXCC_SYSROOT"
	printf 'variant manifest sha256: %s\n' "$PATCHED_SYSROOT_MANIFEST_SHA256"
	exit 0
fi

if [ ! -x "$WASMER_BIN" ]; then
	echo "Wasmer binary is not executable: $WASMER_BIN" >&2
	exit 127
fi
if [ "$PORTABLE_INPUTS" -eq 1 ]; then
	CURRENT_DOCKER_IMAGE_ID="$PATCHED_SYSROOT_DOCKER_IMAGE_ID"
else
	DOCKER_BIN="$(fresh_docker_bin)"
	CURRENT_DOCKER_IMAGE_ID="$(fresh_wasix_builder_image_id "$DOCKER_IMAGE")" ||
		fail_sysroot "Docker image does not match the current builder recipe: $DOCKER_IMAGE"
	[ "$CURRENT_DOCKER_IMAGE_ID" = "$PATCHED_SYSROOT_DOCKER_IMAGE_ID" ] ||
		fail_sysroot "Docker image identity changed since carrier build: expected $PATCHED_SYSROOT_DOCKER_IMAGE_ID, got $CURRENT_DOCKER_IMAGE_ID"
fi

WASMER_BIN_HASH="$(sha256_file "$WASMER_BIN")"
WASMER_CACHE_DIR_FOR_BIN="$UPSTREAM_WORK_ROOT/tools/wasmer-cache/$WASMER_BIN_HASH"

mkdir -p \
	"$BUILD_DIR" \
	"$BUILD_DIR/dev-shm" \
	"$REPORT_DIR" \
	"$UPSTREAM_WORK_ROOT/tools/wasmer-home" \
	"$WASMER_CACHE_DIR_FOR_BIN"

compile_signature() {
	local source

	{
		printf 'docker=%s\n' "$DOCKER_IMAGE"
		printf 'docker_image_id=%s\n' "$CURRENT_DOCKER_IMAGE_ID"
		printf 'process_model=%s\n' 'ehpic-spawn-vfork-exec-dlopen-shmem-reattach-v6'
		printf 'sysroot_prefix=%s\n' "$WASIXCC_SYSROOT_PREFIX"
		printf 'sysroot_variant=%s\n' "$WASIXCC_SYSROOT_VARIANT"
		printf 'sysroot=%s\n' "$WASIXCC_SYSROOT"
		printf 'sysroot_exception_mode=%s\n' "$WASIXCC_EXCEPTION_MODE"
		printf 'carrier_manifest_sha256=%s\n' "$CARRIER_MANIFEST_SHA256"
		printf 'variant_manifest_sha256=%s\n' "$PATCHED_SYSROOT_MANIFEST_SHA256"
		printf 'headers_sha256=%s\n' "$PATCHED_SYSROOT_HEADERS_SHA256"
		while IFS= read -r -d '' source; do
			printf 'probe-source\0%s\0%s\0' \
				"${source#"$PROBE_SOURCE_DIR"/}" "$(sha256_file "$source")"
		done < <(find "$PROBE_SOURCE_DIR" -type f -name '*.c' -print0 | LC_ALL=C sort -z)
	} | sha256_stream
}

docker_path_for() {
	local path="$1"

	case "$path" in
		"$REPO_ROOT")
			printf '/work\n'
			;;
		"$REPO_ROOT"/*)
			printf '/work/%s\n' "${path#"$REPO_ROOT"/}"
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
		filter_hash="$(printf '%s\n' "${PROBES[@]}" | LC_ALL=C sort | sha256_stream)"
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
		selected_probe_outputs_ready || {
			echo 'portable capability inputs do not contain the complete selected probe closure' >&2
			return 2
		}
		return
	fi

	if [ -n "${WASIXCC_SYSROOT_PREFIX:-}" ]; then
		docker_env+=(-e "WASIXCC_SYSROOT_PREFIX=$(docker_path_for "$WASIXCC_SYSROOT_PREFIX")")
	fi
	if [ -n "${WASIXCC_SYSROOT:-}" ]; then
		docker_env+=(-e "WASIXCC_SYSROOT=$(docker_path_for "$WASIXCC_SYSROOT")")
	fi
	"$DOCKER_BIN" run --rm \
		-v "$REPO_ROOT:/work" \
		-w /work \
		"${docker_env[@]}" \
		-e "HOST_UID=$(id -u)" \
		-e "HOST_GID=$(id -g)" \
		-e "WASIXCC_EXCEPTION_MODE=$WASIXCC_EXCEPTION_MODE" \
		-e "SELECTED_PROBES=${PROBES[*]:-}" \
		-e "PROBE_SOURCE_DIR=${PROBE_SOURCE_DIR#"$REPO_ROOT"/}" \
		-e "PROBE_BUILD_DIR=${BUILD_DIR#"$REPO_ROOT"/}" \
		"$CURRENT_DOCKER_IMAGE_ID" \
		bash -lc '
			set -euo pipefail
			source ./src/runtimes/liboliphaunt/wasix/assets/build/docker_wasix_env.sh
			restore_host_ownership() {
				local command_status="$?"

				trap - EXIT
				if [ -e "$PROBE_BUILD_DIR" ] &&
					! chown -R "$HOST_UID:$HOST_GID" "$PROBE_BUILD_DIR"; then
					printf "failed to restore host ownership for %s\n" "$PROBE_BUILD_DIR" >&2
					if [ "$command_status" -eq 0 ]; then
						command_status=1
					fi
				fi
				exit "$command_status"
			}
			trap restore_host_ownership EXIT
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
				WASIXCC_WASM_EXCEPTIONS="$WASIXCC_EXCEPTION_MODE" wasixcc -O0 -g3 -fPIC -pthread \
				"$PROBE_SOURCE_DIR/mmap_fixed_probe.c" \
				-o "$PROBE_BUILD_DIR/mmap_fixed.pic.wasm"
			fi
			if selected_probe mmap-writeback; then
				WASIXCC_WASM_EXCEPTIONS="$WASIXCC_EXCEPTION_MODE" wasixcc -O0 -g3 -fPIC -pthread \
				"$PROBE_SOURCE_DIR/mmap_writeback_probe.c" \
				-o "$PROBE_BUILD_DIR/mmap_writeback.pic.wasm"
			fi
			if selected_probe sync-file-range; then
				WASIXCC_WASM_EXCEPTIONS="$WASIXCC_EXCEPTION_MODE" wasixcc -O0 -g3 -fPIC -pthread \
				"$PROBE_SOURCE_DIR/sync_file_range_probe.c" \
				-o "$PROBE_BUILD_DIR/sync_file_range.pic.wasm"
			fi
			if selected_probe directory-fsync; then
				WASIXCC_WASM_EXCEPTIONS="$WASIXCC_EXCEPTION_MODE" wasixcc -O0 -g3 -fPIC -pthread \
				"$PROBE_SOURCE_DIR/directory_fsync_probe.c" \
				-o "$PROBE_BUILD_DIR/directory_fsync.pic.wasm"
			fi
			if selected_probe dir-readdir-unlink; then
				WASIXCC_WASM_EXCEPTIONS="$WASIXCC_EXCEPTION_MODE" wasixcc -O0 -g3 -fPIC -pthread \
				"$PROBE_SOURCE_DIR/dir_readdir_unlink_probe.c" \
				-o "$PROBE_BUILD_DIR/dir_readdir_unlink.pic.wasm"
			fi
			if selected_probe futex-timeout; then
				WASIXCC_WASM_EXCEPTIONS="$WASIXCC_EXCEPTION_MODE" wasixcc -O0 -g3 -fPIC -pthread \
				"$PROBE_SOURCE_DIR/futex_timeout_probe.c" \
				-o "$PROBE_BUILD_DIR/futex_timeout.pic.wasm"
			fi
			if selected_probe rlimit-stack; then
				WASIXCC_WASM_EXCEPTIONS="$WASIXCC_EXCEPTION_MODE" wasixcc -O0 -g3 -fPIC -pthread \
				"$PROBE_SOURCE_DIR/rlimit_stack_probe.c" \
				-o "$PROBE_BUILD_DIR/rlimit_stack.pic.wasm"
			fi
			if selected_probe spawn-shmem-reattach; then
				WASIXCC_WASM_EXCEPTIONS="$WASIXCC_EXCEPTION_MODE" wasixcc -O0 -g3 -fPIC -pthread \
					"$PROBE_SOURCE_DIR/spawn_shmem_reattach_probe.c" \
					-o "$PROBE_BUILD_DIR/spawn_shmem_reattach.pic.wasm"
			fi
			if selected_probe exec-shared-latch-sigurg; then
				WASIXCC_WASM_EXCEPTIONS="$WASIXCC_EXCEPTION_MODE" wasixcc -O0 -g3 -fPIC -pthread \
					"$PROBE_SOURCE_DIR/exec_shared_latch_sigurg_probe.c" \
					-o "$PROBE_BUILD_DIR/exec_shared_latch_sigurg.pic.wasm"
			fi
			if selected_probe posix-spawn-sigchld-default; then
				WASIXCC_WASM_EXCEPTIONS="$WASIXCC_EXCEPTION_MODE" wasixcc -O0 -g3 -fPIC -pthread \
				"$PROBE_SOURCE_DIR/posix_spawn_sigchld_default_probe.c" \
				-o "$PROBE_BUILD_DIR/posix_spawn_sigchld_default.pic.wasm"
			fi
			if selected_probe posix-spawn-sigchld; then
				WASIXCC_WASM_EXCEPTIONS="$WASIXCC_EXCEPTION_MODE" wasixcc -O0 -g3 -fPIC -pthread \
				"$PROBE_SOURCE_DIR/posix_spawn_sigchld_probe.c" \
				-o "$PROBE_BUILD_DIR/posix_spawn_sigchld.pic.wasm"
			fi
			if selected_probe waitpid-wnohang-any; then
				WASIXCC_WASM_EXCEPTIONS="$WASIXCC_EXCEPTION_MODE" wasixcc -O0 -g3 -fPIC -pthread \
				"$PROBE_SOURCE_DIR/waitpid_wnohang_any_probe.c" \
				-o "$PROBE_BUILD_DIR/waitpid_wnohang_any.pic.wasm"
			fi
			if selected_probe posix-spawn-blocking-wait; then
				WASIXCC_WASM_EXCEPTIONS="$WASIXCC_EXCEPTION_MODE" wasixcc -O0 -g3 -fPIC -pthread \
				"$PROBE_SOURCE_DIR/posix_spawn_blocking_wait_probe.c" \
				-o "$PROBE_BUILD_DIR/posix_spawn_blocking_wait.pic.wasm"
			fi
			if selected_probe posix-spawn-pipe; then
				WASIXCC_WASM_EXCEPTIONS="$WASIXCC_EXCEPTION_MODE" wasixcc -O0 -g3 -fPIC -pthread \
				"$PROBE_SOURCE_DIR/posix_spawn_pipe_probe.c" \
				-o "$PROBE_BUILD_DIR/posix_spawn_pipe.pic.wasm"
			fi
			if selected_probe epoll-listen-accept; then
				WASIXCC_WASM_EXCEPTIONS="$WASIXCC_EXCEPTION_MODE" wasixcc -O0 -g3 -fPIC -pthread \
				"$PROBE_SOURCE_DIR/epoll_listen_accept_probe.c" \
				-o "$PROBE_BUILD_DIR/epoll_listen_accept.pic.wasm"
			fi
			if selected_probe epoll-listen-after-vfork-exec; then
				WASIXCC_WASM_EXCEPTIONS="$WASIXCC_EXCEPTION_MODE" wasixcc -O0 -g3 -fPIC -pthread \
				"$PROBE_SOURCE_DIR/epoll_listen_after_vfork_exec_probe.c" \
				-o "$PROBE_BUILD_DIR/epoll_listen_after_vfork_exec.pic.wasm"
			fi
			if selected_probe epoll-listen-external; then
				WASIXCC_WASM_EXCEPTIONS="$WASIXCC_EXCEPTION_MODE" wasixcc -O0 -g3 -fPIC -pthread \
				"$PROBE_SOURCE_DIR/epoll_listen_external_probe.c" \
				-o "$PROBE_BUILD_DIR/epoll_listen_external.pic.wasm"
			fi
			if selected_probe epoll-listen-external-after-pipe; then
				WASIXCC_WASM_EXCEPTIONS="$WASIXCC_EXCEPTION_MODE" wasixcc -O0 -g3 -fPIC -pthread \
					"$PROBE_SOURCE_DIR/epoll_listen_external_after_pipe_probe.c" \
					-o "$PROBE_BUILD_DIR/epoll_listen_external_after_pipe.pic.wasm"
			fi
			if selected_probe epoll-ofd-lifecycle; then
				WASIXCC_WASM_EXCEPTIONS="$WASIXCC_EXCEPTION_MODE" wasixcc -O0 -g3 -fPIC -pthread \
					"$PROBE_SOURCE_DIR/epoll_ofd_lifecycle_probe.c" \
					-o "$PROBE_BUILD_DIR/epoll_ofd_lifecycle.pic.wasm"
			fi
			if selected_probe socket-nonblock; then
				WASIXCC_WASM_EXCEPTIONS="$WASIXCC_EXCEPTION_MODE" wasixcc -O0 -g3 -fPIC -pthread \
				"$PROBE_SOURCE_DIR/socket_nonblock_probe.c" \
				-o "$PROBE_BUILD_DIR/socket_nonblock.pic.wasm"
			fi
			if selected_probe dynamic-dlopen; then
				WASIXCC_WASM_EXCEPTIONS="$WASIXCC_EXCEPTION_MODE" wasixcc -O0 -g3 -fPIC -sPIC=yes -pthread \
				-Wl,-shared \
				"$PROBE_SOURCE_DIR/dynamic_probe_side.c" \
				-o "$PROBE_BUILD_DIR/libwasix_dynamic_probe_side.so"
			fi
			if selected_probe dynamic-dlopen; then
				WASIXCC_WASM_EXCEPTIONS="$WASIXCC_EXCEPTION_MODE" wasixcc -O0 -g3 -fPIC -sPIC=yes -pthread \
				-sMODULE_KIND=dynamic-main \
				-sSTACK_SIZE=2MB \
				-sINITIAL_MEMORY=64MB \
				"$PROBE_SOURCE_DIR/dynamic_dlopen_probe.c" \
				-o "$PROBE_BUILD_DIR/dynamic_dlopen_probe.pic.wasm"
			fi
			if selected_probe dynamic-vfork-exec; then
				WASIXCC_WASM_EXCEPTIONS="$WASIXCC_EXCEPTION_MODE" wasixcc -O0 -g3 -fPIC -pthread \
				"$PROBE_SOURCE_DIR/dynamic_vfork_exec_probe.c" \
				-o "$PROBE_BUILD_DIR/dynamic_vfork_exec.pic.wasm"
			fi
			if selected_probe wasm-eh-sjlj; then
				WASIXCC_WASM_EXCEPTIONS="$WASIXCC_EXCEPTION_MODE" wasixcc -O0 -g3 -fPIC -pthread \
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
		if [ "${#WASMER_ARGS[@]}" -eq 0 ]; then
			printf -- '- Extra Wasmer run arguments: `none`\n'
		else
			printf -- '- Extra Wasmer run arguments: `%s`\n' "${WASMER_ARGS[*]}"
		fi
		printf -- '- Wasmer version: `%s`\n' "$(
			env \
				WASMER_DIR="$UPSTREAM_WORK_ROOT/tools/wasmer-home" \
				WASMER_CACHE_DIR="$WASMER_CACHE_DIR_FOR_BIN" \
				"$WASMER_BIN" --version 2>/dev/null || true
		)"
		printf -- '- Docker image: `%s`\n' "$DOCKER_IMAGE"
		printf -- '- Docker image ID: `%s`\n' "$CURRENT_DOCKER_IMAGE_ID"
		printf -- '- wasixcc sysroot prefix: `%s`\n' "$WASIXCC_SYSROOT_PREFIX"
		printf -- '- wasixcc sysroot variant: `%s`\n' "$WASIXCC_SYSROOT_VARIANT"
		printf -- '- wasixcc exception mode: `%s`\n' "$WASIXCC_EXCEPTION_MODE"
		printf -- '- wasixcc exact sysroot: `%s`\n' "$WASIXCC_SYSROOT"
		printf -- '- sysroot carrier manifest SHA-256: `%s`\n' "$CARRIER_MANIFEST_SHA256"
		printf -- '- sysroot variant manifest: `%s`\n' "$PATCHED_SYSROOT_MANIFEST"
		printf -- '- sysroot variant manifest SHA-256: `%s`\n\n' "$PATCHED_SYSROOT_MANIFEST_SHA256"
			printf -- '- Selected product process model: `EH/PIC dynamic-main + side-module dlopen + posix_spawn/proc_spawn2 + MAP_FIXED shared mmap reattach`\n'
		printf -- '- Diagnostic probes: `setitimer-epoll-one-shot` is reported but does not affect strict acceptance until the runtime implements POSIX one-shot timer semantics.\n'
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
			"$WASMER_BIN" run --quiet "${WASMER_ARGS[@]}" $flags \
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
			"$WASMER_BIN" run --quiet "${WASMER_ARGS[@]}" --enable-exceptions --enable-threads --net \
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

compile_probes

report="$REPORT_DIR/runtime-capabilities.md"
write_header "$report"

failures=0
run_selected_probe "mmap-fixed" "$BUILD_DIR/mmap_fixed.pic.wasm" "--enable-exceptions --enable-threads"
run_selected_probe "mmap-writeback" "$BUILD_DIR/mmap_writeback.pic.wasm" "--enable-exceptions --enable-threads"
run_selected_probe "sync-file-range" "$BUILD_DIR/sync_file_range.pic.wasm" "--enable-exceptions --enable-threads"
run_selected_probe "directory-fsync" "$BUILD_DIR/directory_fsync.pic.wasm" "--enable-exceptions --enable-threads"
run_selected_probe "dir-readdir-unlink" "$BUILD_DIR/dir_readdir_unlink.pic.wasm" "--enable-exceptions --enable-threads"
run_selected_probe "futex-timeout" "$BUILD_DIR/futex_timeout.pic.wasm" "--enable-exceptions --enable-threads"
run_selected_probe "rlimit-stack" "$BUILD_DIR/rlimit_stack.pic.wasm" "--enable-exceptions --enable-threads --stack-size 33554432"
run_selected_probe "spawn-shmem-reattach" "$BUILD_DIR/spawn_shmem_reattach.pic.wasm" "--enable-exceptions --enable-threads"
run_selected_probe "exec-shared-latch-sigurg" "$BUILD_DIR/exec_shared_latch_sigurg.pic.wasm" "--enable-exceptions --enable-threads"
run_selected_probe "posix-spawn-sigchld-default" "$BUILD_DIR/posix_spawn_sigchld_default.pic.wasm" "--enable-exceptions --enable-threads"
run_selected_probe "posix-spawn-sigchld" "$BUILD_DIR/posix_spawn_sigchld.pic.wasm" "--enable-exceptions --enable-threads"
run_selected_probe "waitpid-wnohang-any" "$BUILD_DIR/waitpid_wnohang_any.pic.wasm" "--enable-exceptions --enable-threads"
run_selected_probe "posix-spawn-blocking-wait" "$BUILD_DIR/posix_spawn_blocking_wait.pic.wasm" "--enable-exceptions --enable-threads"
run_selected_probe "posix-spawn-pipe" "$BUILD_DIR/posix_spawn_pipe.pic.wasm" "--enable-exceptions --enable-threads"
run_selected_probe "epoll-listen-accept" "$BUILD_DIR/epoll_listen_accept.pic.wasm" "--enable-exceptions --enable-threads --net"
run_selected_probe "epoll-listen-after-vfork-exec" "$BUILD_DIR/epoll_listen_after_vfork_exec.pic.wasm" "--enable-exceptions --enable-threads --net"
run_selected_external_epoll_probe "epoll-listen-external" "$BUILD_DIR/epoll_listen_external.pic.wasm"
run_selected_external_epoll_probe "epoll-listen-external-after-pipe" "$BUILD_DIR/epoll_listen_external_after_pipe.pic.wasm"
run_selected_probe "epoll-ofd-lifecycle" "$BUILD_DIR/epoll_ofd_lifecycle.pic.wasm" "--enable-exceptions --enable-threads"
run_selected_probe "socket-nonblock" "$BUILD_DIR/socket_nonblock.pic.wasm" "--enable-exceptions --enable-threads --net"
run_selected_probe "dynamic-dlopen" "$BUILD_DIR/dynamic_dlopen_probe.pic.wasm" "--enable-exceptions --enable-threads"
run_selected_probe "dynamic-vfork-exec" "$BUILD_DIR/dynamic_vfork_exec.pic.wasm" "--enable-exceptions --enable-threads"
run_selected_probe "wasm-eh-sjlj" "$BUILD_DIR/wasm_eh_sjlj.pic.wasm" "--enable-exceptions --enable-threads"

{
	printf '## Summary\n\n'
	printf -- '- Failed probes: `%s`\n' "$failures"
	printf -- '- Strict mode: `%s`\n' "$STRICT"
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
