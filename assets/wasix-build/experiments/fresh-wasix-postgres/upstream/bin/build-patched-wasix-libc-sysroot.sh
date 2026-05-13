#!/usr/bin/env bash

set -euo pipefail

UPSTREAM_SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FRESH_ROOT="$(cd "$UPSTREAM_SOURCE_ROOT/.." && pwd)"
REPO_ROOT="$(cd "$FRESH_ROOT/../../../.." && pwd)"
WASIX_BUILD_ROOT="$REPO_ROOT/assets/wasix-build"
UPSTREAM_WORK_ROOT="${UPSTREAM_WORK_ROOT:-$WASIX_BUILD_ROOT/work/upstream}"

DOCKER_IMAGE="${DOCKER_IMAGE:-pglite-oxide-wasix-build:local}"
WASIX_LIBC_ROOT="${WASIX_LIBC_ROOT:-$UPSTREAM_WORK_ROOT/wasix-libc}"
OUTPUT_PREFIX="${OUTPUT_PREFIX:-$UPSTREAM_WORK_ROOT/build/patched-wasixcc-sysroot}"
BUILD_LOG="${BUILD_LOG:-$UPSTREAM_WORK_ROOT/reports/wasix-libc-build.log}"
WASIX_LIBC_VARIANTS="${WASIX_LIBC_VARIANTS:-sysroot sysroot-eh sysroot-ehpic sysroot-exnref-eh sysroot-exnref-ehpic}"

usage() {
	cat <<EOF
usage: $0 [--no-build] [--output-prefix PATH]

Builds the local wasix-libc checkout and overlays patched libc artifacts into a
copy of the pinned wasixcc sysroot variants.

Environment:
  DOCKER_IMAGE      Docker image with wasixcc. Default: $DOCKER_IMAGE
  WASIX_LIBC_ROOT   wasix-libc checkout. Default: $WASIX_LIBC_ROOT
  OUTPUT_PREFIX     merged sysroot prefix. Default: $OUTPUT_PREFIX
  BUILD_LOG         libc build log. Default: $BUILD_LOG
  WASIX_LIBC_VARIANTS
                    Space-separated sysroot variants to rebuild and overlay.
                    Default: $WASIX_LIBC_VARIANTS
EOF
}

BUILD=1
while [ "$#" -gt 0 ]; do
	case "$1" in
		--no-build)
			BUILD=0
			shift
			;;
		--output-prefix)
			OUTPUT_PREFIX="$2"
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

if ! command -v docker >/dev/null 2>&1; then
	echo "missing required command: docker" >&2
	exit 127
fi

mkdir -p "$(dirname "$BUILD_LOG")"

docker run --rm \
	-v "$REPO_ROOT:/work" \
	-w /work \
	-e "BUILD=$BUILD" \
	-e "WASIX_LIBC_ROOT=/work/${WASIX_LIBC_ROOT#$REPO_ROOT/}" \
	-e "OUTPUT_PREFIX=/work/${OUTPUT_PREFIX#$REPO_ROOT/}" \
	-e "BUILD_LOG=/work/${BUILD_LOG#$REPO_ROOT/}" \
	-e "WASIX_LIBC_VARIANTS=$WASIX_LIBC_VARIANTS" \
	"$DOCKER_IMAGE" \
	bash -lc '
		set -euo pipefail
		source ./assets/wasix-build/docker_wasix_env.sh
		export PATH=/opt/wasixcc-home/.wasixcc/llvm/bin:$PATH

		variant_sysroot() {
			printf "%s/build/patched-sysroots/%s" "$WASIX_LIBC_ROOT" "$1"
		}

		build_variant() {
			local variant="$1"
			local makefile="$2"
			local pic="$3"
			local exnref="$4"
			local sysroot
			local objdir

			sysroot="$(variant_sysroot "$variant")"
			objdir="build/patched-objs/$variant"
			rm -rf "$sysroot" "$WASIX_LIBC_ROOT/$objdir"

			local make_args=(
				-C "$WASIX_LIBC_ROOT"
				-f "$makefile"
				-j2
				TARGET_ARCH=wasm32
				THREAD_MODEL=posix
				PIC="$pic"
				OBJDIR="$objdir"
				SYSROOT="$sysroot"
				CHECK_SYMBOLS=no
				CC=clang
				AR=llvm-ar
				NM=llvm-nm
			)
			if [ -n "$exnref" ]; then
				make_args+=(EXNREF_EH="$exnref")
			fi

			make "${make_args[@]}" \
				"$sysroot/lib/wasm32-wasi/libc.a" \
				"$sysroot/lib/wasm32-wasi/libwasi-emulated-mman.a"
		}

		build_named_variant() {
			case "$1" in
				sysroot)
					build_variant sysroot Makefile no ""
					;;
				sysroot-eh)
					build_variant sysroot-eh Makefile-eh no no
					;;
				sysroot-ehpic)
					build_variant sysroot-ehpic Makefile-eh yes no
					;;
				sysroot-exnref-eh)
					build_variant sysroot-exnref-eh Makefile-eh no yes
					;;
				sysroot-exnref-ehpic)
					build_variant sysroot-exnref-ehpic Makefile-eh yes yes
					;;
				*)
					echo "unknown WASIX libc sysroot variant: $1" >&2
					exit 2
					;;
			esac
		}

		if [ "$BUILD" -eq 1 ]; then
			{
				for variant in $WASIX_LIBC_VARIANTS; do
					build_named_variant "$variant"
				done
			} >"$BUILD_LOG" 2>&1
		fi

		rm -rf "$OUTPUT_PREFIX"
		mkdir -p "$OUTPUT_PREFIX"
		cp -a /opt/wasixcc-home/.wasixcc/sysroot/. "$OUTPUT_PREFIX/"
		for sysroot in "$OUTPUT_PREFIX"/sysroot*; do
			variant="$(basename "$sysroot")"
			case " $WASIX_LIBC_VARIANTS " in
				*" $variant "*) ;;
				*) continue ;;
			esac
			artifact_root="$(variant_sysroot "$variant")"
			cp -a "$artifact_root/include/." "$sysroot/include/"
			cp "$artifact_root/lib/wasm32-wasi/libc.a" \
				"$sysroot/lib/wasm32-wasi/libc.a"
			cp "$artifact_root/lib/wasm32-wasi/libwasi-emulated-mman.a" \
				"$sysroot/lib/wasm32-wasi/libwasi-emulated-mman.a"
		done
	'

{
	printf 'output_prefix=%s\n' "$OUTPUT_PREFIX"
	printf 'variants=%s\n' "$WASIX_LIBC_VARIANTS"
	find "$OUTPUT_PREFIX" -type f \( \
		-path '*/lib/wasm32-wasi/*.a' -o \
		-path '*/include/*.h' -o \
		-path '*/include/sys/*.h' -o \
		-path '*/include/netinet/*.h' \
	\) -print0 |
		sort -z |
		xargs -0 shasum -a 256
} | shasum -a 256 | awk '{print $1}' >"$OUTPUT_PREFIX/.fresh-sysroot-signature"

printf 'merged sysroot prefix: %s\n' "$OUTPUT_PREFIX"
printf 'build log: %s\n' "$BUILD_LOG"
printf 'sysroot signature: %s\n' "$(cat "$OUTPUT_PREFIX/.fresh-sysroot-signature")"
