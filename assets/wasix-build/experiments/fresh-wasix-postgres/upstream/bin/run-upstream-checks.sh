#!/usr/bin/env bash

set -euo pipefail

UPSTREAM_SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FRESH_ROOT="$(cd "$UPSTREAM_SOURCE_ROOT/.." && pwd)"
REPO_ROOT="$(cd "$FRESH_ROOT/../../../.." && pwd)"
WASIX_BUILD_ROOT="$REPO_ROOT/assets/wasix-build"
UPSTREAM_WORK_ROOT="${UPSTREAM_WORK_ROOT:-$WASIX_BUILD_ROOT/work/upstream}"
WASMER_ROOT="$UPSTREAM_WORK_ROOT/wasmer"
WASMER_BIN="${WASMER_BIN:-$WASMER_ROOT/target/debug/wasmer}"
SYSROOT_PREFIX="$UPSTREAM_WORK_ROOT/build/patched-wasixcc-sysroot"

RUN_WASMER=1
RUN_LIBC_BUILD=1
RUN_PROBES=1
RUN_GROUNDING=1
PROBE_COMPILE=--compile

usage() {
	cat <<EOF
usage: $0 [--skip-grounding] [--skip-wasmer] [--skip-libc-build] [--skip-probes] [--no-compile-probes]

Runs the contained upstream checks for the PostgreSQL/WASIX blocker work.

Checks:
  - Code-grounding inventory against the local Wasmer and wasix-libc source trees.
  - Wasmer VM/API checks for fixed shared remapping support.
  - Optional patched wasix-libc sysroot rebuild.
  - WASIX blocker probes against the local patched Wasmer binary and patched sysroot.
EOF
}

while [ "$#" -gt 0 ]; do
	case "$1" in
		--skip-grounding)
			RUN_GROUNDING=0
			shift
			;;
		--skip-wasmer)
			RUN_WASMER=0
			shift
			;;
		--skip-libc-build)
			RUN_LIBC_BUILD=0
			shift
			;;
		--skip-probes)
			RUN_PROBES=0
			shift
			;;
		--no-compile-probes)
			PROBE_COMPILE=--no-compile
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

if [ "$RUN_GROUNDING" -eq 1 ]; then
	"$UPSTREAM_SOURCE_ROOT/bin/record-code-grounding.sh" --strict
fi

if [ "$RUN_WASMER" -eq 1 ]; then
	(
		cd "$WASMER_ROOT"
		cargo test --manifest-path lib/vm/Cargo.toml \
			remap_shared_file_fixed_replaces_only_requested_pages
		cargo check --manifest-path lib/api/Cargo.toml \
			--no-default-features --features sys,cranelift
		cargo check --manifest-path lib/wasix/Cargo.toml \
			--features wasmer/cranelift
		cargo test --manifest-path lib/wasix/Cargo.toml \
			fork_continuation_backend \
			--lib --no-default-features --features sys-minimal,wasmer/cranelift
		cargo test --manifest-path lib/wasix/Cargo.toml \
			shared_memory_mapping \
			--lib --no-default-features --features sys-minimal,wasmer/cranelift
		cargo build --manifest-path lib/cli/Cargo.toml --bin wasmer \
			--no-default-features --features llvm,wat
	)
fi

if [ "$RUN_LIBC_BUILD" -eq 1 ]; then
	"$UPSTREAM_SOURCE_ROOT/bin/build-patched-wasix-libc-sysroot.sh"
fi

if [ "$RUN_PROBES" -eq 1 ]; then
	repo_relative_sysroot="${SYSROOT_PREFIX#$REPO_ROOT/}"
	WASIXCC_SYSROOT_PREFIX="/work/$repo_relative_sysroot" \
		"$UPSTREAM_SOURCE_ROOT/bin/run-blocker-probes.sh" \
			--wasmer-bin "$WASMER_BIN" \
			--strict \
			"$PROBE_COMPILE"
fi
