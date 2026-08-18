#!/usr/bin/env bash

set -euo pipefail

FRESH_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$FRESH_ROOT/lib/common.sh"
UPSTREAM_SOURCE_ROOT="$FRESH_ROOT/runtime"
UPSTREAM_WORK_ROOT="${UPSTREAM_WORK_ROOT:-$FRESH_WORK_ROOT/runtime}"

DOCKER_IMAGE="${DOCKER_IMAGE:-$FRESH_WASIX_DOCKER_IMAGE}"
WASIX_LIBC_ROOT="${WASIX_LIBC_ROOT:-$UPSTREAM_WORK_ROOT/wasix-libc}"
OUTPUT_PREFIX="${OUTPUT_PREFIX:-$UPSTREAM_WORK_ROOT/build/patched-wasixcc-sysroot}"
BUILD_LOG="${BUILD_LOG:-$UPSTREAM_WORK_ROOT/reports/wasix-libc-build.log}"
WASIX_LIBC_VARIANTS="${WASIX_LIBC_VARIANTS:-sysroot-ehpic sysroot-exnref-ehpic}"
WASIX_LIBC_PATCH="$UPSTREAM_SOURCE_ROOT/patches/wasix-libc/0001-postgres-wasix-blockers.patch"
VARIANT_MANIFEST_NAME=".oliphaunt-patched-sysroot.manifest"
CARRIER_MANIFEST_NAME=".oliphaunt-patched-sysroots.manifest"

usage() {
	cat <<EOF
usage: $0 [--no-build] [--portable-inputs] [--output-prefix PATH]

Builds the local wasix-libc checkout and overlays patched libc artifacts into a
copy of the pinned wasixcc EH/PIC sysroot variants. The output contains only the
variants explicitly named by WASIX_LIBC_VARIANTS.

--no-build reuses an already stamped carrier only after revalidating its exact
payload, source state, patch, image identity, and build parameters.
--portable-inputs permits --no-build to validate the stamped Docker image
identity without requiring that Linux-only builder image on the current host.

Environment:
  DOCKER_IMAGE      Docker image with wasixcc. Default: $DOCKER_IMAGE
  WASIX_LIBC_ROOT   wasix-libc checkout. Default: $WASIX_LIBC_ROOT
  OUTPUT_PREFIX     merged sysroot prefix. Default: $OUTPUT_PREFIX
  BUILD_LOG         libc build log. Default: $BUILD_LOG
  WASIX_LIBC_VARIANTS
                    Space-separated variants to rebuild and overlay. Supported:
                    sysroot-ehpic and sysroot-exnref-ehpic.
                    Default: $WASIX_LIBC_VARIANTS
EOF
}

fail() {
	printf 'build-patched-wasix-libc-sysroot: %s\n' "$*" >&2
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

require_manifest_value() {
	local manifest="$1"
	local key="$2"
	local expected="$3"
	local actual

	if ! actual="$(manifest_value "$manifest" "$key")"; then
		fail "manifest must contain exactly one $key field: $manifest"
	fi
	[ "$actual" = "$expected" ] ||
		fail "$key mismatch in $manifest: expected $expected, got ${actual:-<empty>}"
}

valid_sha256() {
	[ "${#1}" -eq 64 ] || return 1
	case "$1" in
		*[!0-9a-f]*) return 1 ;;
		*) return 0 ;;
	esac
}

normalize_variants() {
	local requested=()
	local normalized=()
	local variant
	local existing

	case "$WASIX_LIBC_VARIANTS" in
		*$'\n'*|*$'\r'*) fail 'WASIX_LIBC_VARIANTS must be a single line' ;;
	esac
	read -r -a requested <<<"$WASIX_LIBC_VARIANTS"
	[ "${#requested[@]}" -gt 0 ] || fail 'WASIX_LIBC_VARIANTS must select at least one variant'

	for variant in "${requested[@]}"; do
		case "$variant" in
			sysroot-ehpic|sysroot-exnref-ehpic) ;;
			*)
				fail "unsupported or non-PIC WASIX libc variant: $variant"
				;;
		esac
		for existing in "${normalized[@]}"; do
			[ "$existing" != "$variant" ] || fail "duplicate WASIX libc variant: $variant"
		done
		normalized+=("$variant")
	done
	WASIX_LIBC_VARIANTS="${normalized[*]}"
}

header_tree_sha256() {
	local include_root="$1"
	local entry
	local relative

	[ -d "$include_root" ] || fail "missing sysroot include tree: $include_root"
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

source_worktree_sha256() {
	local relative

	{
		printf 'commit\0%s\0' "$SOURCE_COMMIT"
		git -C "$WASIX_LIBC_ROOT" diff --binary --no-ext-diff HEAD --
		while IFS= read -r -d '' relative; do
			if [ -L "$WASIX_LIBC_ROOT/$relative" ]; then
				printf 'untracked-symlink\0%s\0%s\0' \
					"$relative" "$(readlink "$WASIX_LIBC_ROOT/$relative")"
			elif [ -f "$WASIX_LIBC_ROOT/$relative" ]; then
				printf 'untracked-file\0%s\0%s\0' \
					"$relative" "$(sha256_file "$WASIX_LIBC_ROOT/$relative")"
			fi
		done < <(git -C "$WASIX_LIBC_ROOT" ls-files --others --exclude-standard -z | LC_ALL=C sort -z)
	} | sha256_stream
}

variant_exnref() {
	case "$1" in
		sysroot-ehpic) printf 'no\n' ;;
		sysroot-exnref-ehpic) printf 'yes\n' ;;
		*) fail "cannot describe unsupported variant: $1" ;;
	esac
}

write_variant_manifest() {
	local variant="$1"
	local variant_root="$OUTPUT_PREFIX/$variant"
	local libc_archive="$variant_root/lib/wasm32-wasi/libc.a"
	local mman_archive="$variant_root/lib/wasm32-wasi/libwasi-emulated-mman.a"
	local manifest="$variant_root/$VARIANT_MANIFEST_NAME"
	local temporary="$manifest.tmp.$$"
	local manifest_sha256

	[ -f "$libc_archive" ] || fail "missing patched libc archive: $libc_archive"
	[ -f "$mman_archive" ] || fail "missing patched mmap archive: $mman_archive"
	[ -f "$variant_root/include/stdio.h" ] || fail "incomplete sysroot include tree: $variant_root/include"

	{
		printf 'schema=oliphaunt.wasix-libc-sysroot.v1\n'
		printf 'variant=%s\n' "$variant"
		printf 'source_commit=%s\n' "$SOURCE_COMMIT"
		printf 'source_worktree_sha256=%s\n' "$SOURCE_WORKTREE_SHA256"
		printf 'source_patch=%s\n' "$(fresh_project_source_identity_path "$WASIX_LIBC_PATCH")"
		printf 'source_patch_sha256=%s\n' "$SOURCE_PATCH_SHA256"
		printf 'docker_image=%s\n' "$DOCKER_IMAGE"
		printf 'docker_image_id=%s\n' "$DOCKER_IMAGE_ID"
		printf 'makefile=Makefile-eh\n'
		printf 'make_jobs=2\n'
		printf 'target_arch=wasm32\n'
		printf 'thread_model=posix\n'
		printf 'pic=yes\n'
		printf 'exnref_eh=%s\n' "$(variant_exnref "$variant")"
		printf 'check_symbols=no\n'
		printf 'cc=clang\n'
		printf 'ar=llvm-ar\n'
		printf 'nm=llvm-nm\n'
		printf 'libc_archive=lib/wasm32-wasi/libc.a\n'
		printf 'libc_archive_sha256=%s\n' "$(sha256_file "$libc_archive")"
		printf 'mman_archive=lib/wasm32-wasi/libwasi-emulated-mman.a\n'
		printf 'mman_archive_sha256=%s\n' "$(sha256_file "$mman_archive")"
		printf 'headers_sha256=%s\n' "$(header_tree_sha256 "$variant_root/include")"
	} >"$temporary"
	mv "$temporary" "$manifest"

	manifest_sha256="$(sha256_file "$manifest")"
	printf '%s\n' "$manifest_sha256" >"$variant_root/.fresh-sysroot-signature"
	printf '%s\t%s\n' "$variant" "$manifest_sha256"
}

reuse_existing_carrier() {
	local carrier_manifest="$OUTPUT_PREFIX/$CARRIER_MANIFEST_NAME"
	local validator="$UPSTREAM_SOURCE_ROOT/bin/validate-runtime-capabilities.sh"
	local variant
	local manifest

	[ -x "$validator" ] || fail "missing sysroot validator: $validator"
	[ -f "$carrier_manifest" ] ||
		fail "--no-build requires an existing stamped carrier: $carrier_manifest"
	require_manifest_value "$carrier_manifest" schema oliphaunt.wasix-libc-sysroots.v1
	require_manifest_value "$carrier_manifest" variants "$WASIX_LIBC_VARIANTS"

	for variant in "${SELECTED_VARIANTS[@]}"; do
		DOCKER_IMAGE="$DOCKER_IMAGE" \
			WASIXCC_SYSROOT_PREFIX="$OUTPUT_PREFIX" \
			WASIXCC_SYSROOT_VARIANT="$variant" \
			WASIXCC_SYSROOT="$OUTPUT_PREFIX/$variant" \
			"$validator" --validate-sysroot-only >/dev/null
		manifest="$OUTPUT_PREFIX/$variant/$VARIANT_MANIFEST_NAME"
		require_manifest_value "$manifest" source_commit "$SOURCE_COMMIT"
		require_manifest_value "$manifest" source_worktree_sha256 "$SOURCE_WORKTREE_SHA256"
		require_manifest_value "$manifest" source_patch_sha256 "$SOURCE_PATCH_SHA256"
		require_manifest_value "$manifest" docker_image "$DOCKER_IMAGE"
		require_manifest_value "$manifest" docker_image_id "$DOCKER_IMAGE_ID"
		require_manifest_value "$manifest" makefile Makefile-eh
		require_manifest_value "$manifest" make_jobs 2
		require_manifest_value "$manifest" target_arch wasm32
		require_manifest_value "$manifest" thread_model posix
		require_manifest_value "$manifest" pic yes
		require_manifest_value "$manifest" exnref_eh "$(variant_exnref "$variant")"
	done

	printf 'reused validated sysroot prefix: %s\n' "$OUTPUT_PREFIX"
	printf 'variants: %s\n' "$WASIX_LIBC_VARIANTS"
	printf 'carrier manifest: %s\n' "$carrier_manifest"
	printf 'sysroot signature: %s\n' "$(cat "$OUTPUT_PREFIX/.fresh-sysroot-signature")"
}

BUILD=1
PORTABLE_INPUTS=0
while [ "$#" -gt 0 ]; do
	case "$1" in
		--no-build)
			BUILD=0
			shift
			;;
		--portable-inputs)
			PORTABLE_INPUTS=1
			shift
			;;
		--output-prefix)
			[ "$#" -ge 2 ] || fail '--output-prefix requires a path'
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
[ "$PORTABLE_INPUTS" -eq 0 ] || [ "$BUILD" -eq 0 ] ||
	fail '--portable-inputs requires --no-build'

normalize_variants
SELECTED_VARIANTS=()
read -r -a SELECTED_VARIANTS <<<"$WASIX_LIBC_VARIANTS"
fresh_require_managed_generated_path "$WASIX_LIBC_ROOT" WASIX_LIBC_ROOT
fresh_require_managed_generated_path "$OUTPUT_PREFIX" OUTPUT_PREFIX
fresh_require_managed_generated_path "$BUILD_LOG" BUILD_LOG
for variant in "${SELECTED_VARIANTS[@]}"; do
	fresh_require_managed_generated_path \
		"$WASIX_LIBC_ROOT/build/patched-sysroots/$variant" \
		"wasix-libc $variant sysroot"
	fresh_require_managed_generated_path \
		"$WASIX_LIBC_ROOT/build/patched-objs/$variant" \
		"wasix-libc $variant object directory"
done
for variant in sysroot sysroot-eh sysroot-ehpic sysroot-exnref-eh sysroot-exnref-ehpic; do
	fresh_require_managed_generated_path "$OUTPUT_PREFIX/$variant" \
		"output $variant sysroot"
done
[ -f "$WASIX_LIBC_PATCH" ] || fail "missing wasix-libc patch: $WASIX_LIBC_PATCH"
command -v git >/dev/null 2>&1 || fail 'missing required command: git'
if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
	fail 'missing required SHA-256 command: sha256sum or shasum'
fi
SOURCE_COMMIT="$(git -C "$WASIX_LIBC_ROOT" rev-parse --verify 'HEAD^{commit}')" ||
	fail "wasix-libc checkout is not a Git worktree: $WASIX_LIBC_ROOT"
if ! git -C "$WASIX_LIBC_ROOT" apply --reverse --check "$WASIX_LIBC_PATCH" >/dev/null 2>&1; then
	fail "required wasix-libc patch is not applied cleanly: $WASIX_LIBC_PATCH"
fi
SOURCE_PATCH_SHA256="$(sha256_file "$WASIX_LIBC_PATCH")"
SOURCE_WORKTREE_SHA256="$(source_worktree_sha256)"

if [ "$PORTABLE_INPUTS" -eq 1 ]; then
	first_variant_manifest="$OUTPUT_PREFIX/${SELECTED_VARIANTS[0]}/$VARIANT_MANIFEST_NAME"
	DOCKER_IMAGE_ID="$(manifest_value "$first_variant_manifest" docker_image_id)" ||
		fail "portable sysroot has no stamped Docker image identity: $first_variant_manifest"
	case "$DOCKER_IMAGE_ID" in
		sha256:*)
			valid_sha256 "${DOCKER_IMAGE_ID#sha256:}" ||
				fail 'portable sysroot Docker image identity is invalid'
			;;
		*) fail 'portable sysroot Docker image identity is invalid' ;;
	esac
else
	DOCKER_BIN="$(fresh_docker_bin)"
	if [ "$BUILD" -eq 1 ]; then
		fresh_ensure_docker_image "$DOCKER_IMAGE"
	fi
	DOCKER_IMAGE_ID="$(fresh_wasix_builder_image_id "$DOCKER_IMAGE")" ||
		fail "Docker image does not match the current builder recipe: $DOCKER_IMAGE"
fi

build_log_parent="$(dirname "$BUILD_LOG")"
output_parent="$(dirname "$OUTPUT_PREFIX")"
mkdir -p "$build_log_parent" "$output_parent"
[ -w "$build_log_parent" ] ||
	fail "WASIX libc build-log parent is not writable: $build_log_parent"
[ -w "$output_parent" ] ||
	fail "WASIX libc output parent is not writable: $output_parent"
if [ "$BUILD" -eq 0 ]; then
	reuse_existing_carrier
	exit 0
fi

"$DOCKER_BIN" run --rm \
	-v "$REPO_ROOT:/work" \
	-w /work \
	-e "BUILD=$BUILD" \
	-e "WASIX_LIBC_ROOT=/work/${WASIX_LIBC_ROOT#"$REPO_ROOT"/}" \
	-e "OUTPUT_PREFIX=/work/${OUTPUT_PREFIX#"$REPO_ROOT"/}" \
	-e "BUILD_LOG=/work/${BUILD_LOG#"$REPO_ROOT"/}" \
	-e "WASIX_LIBC_VARIANTS=$WASIX_LIBC_VARIANTS" \
	-e "HOST_UID=$(id -u)" \
	-e "HOST_GID=$(id -g)" \
	"$DOCKER_IMAGE_ID" \
	bash -lc '
		set -euo pipefail
		source ./src/runtimes/liboliphaunt/wasix/assets/build/docker_wasix_env.sh
		export PATH=/opt/wasixcc-home/.wasixcc/llvm/bin:$PATH

		restore_host_ownership() {
			local command_status="$?"
			local ownership_failed=0
			local output_path

			trap - EXIT
			for output_path in "$WASIX_LIBC_ROOT/build" "$OUTPUT_PREFIX" "$BUILD_LOG"; do
				if [ -e "$output_path" ] &&
					! chown -R "$HOST_UID:$HOST_GID" "$output_path"; then
					printf "failed to restore host ownership for %s\n" "$output_path" >&2
					ownership_failed=1
				fi
			done
			if [ "$command_status" -eq 0 ] && [ "$ownership_failed" -ne 0 ]; then
				command_status="$ownership_failed"
			fi
			exit "$command_status"
		}
		trap restore_host_ownership EXIT

		variant_sysroot() {
			printf "%s/build/patched-sysroots/%s" "$WASIX_LIBC_ROOT" "$1"
		}

		build_variant() {
			local variant="$1"
			local exnref="$2"
			local sysroot
			local objdir

			sysroot="$(variant_sysroot "$variant")"
			objdir="build/patched-objs/$variant"
			rm -rf "$sysroot" "$WASIX_LIBC_ROOT/$objdir"

			make -C "$WASIX_LIBC_ROOT" \
				-f Makefile-eh \
				-j2 \
				TARGET_ARCH=wasm32 \
				THREAD_MODEL=posix \
				PIC=yes \
				EXNREF_EH="$exnref" \
				OBJDIR="$objdir" \
				SYSROOT="$sysroot" \
				CHECK_SYMBOLS=no \
				CC=clang \
				AR=llvm-ar \
				NM=llvm-nm \
				"$sysroot/lib/wasm32-wasi/libc.a" \
				"$sysroot/lib/wasm32-wasi/libwasi-emulated-mman.a"
		}

		build_named_variant() {
			case "$1" in
				sysroot-ehpic)
					build_variant sysroot-ehpic no
					;;
				sysroot-exnref-ehpic)
					build_variant sysroot-exnref-ehpic yes
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
		for variant in sysroot sysroot-eh sysroot-ehpic sysroot-exnref-eh sysroot-exnref-ehpic; do
			case " $WASIX_LIBC_VARIANTS " in
				*" $variant "*) ;;
				*) rm -rf "$OUTPUT_PREFIX/$variant" ;;
			esac
		done
		for variant in $WASIX_LIBC_VARIANTS; do
			sysroot="$OUTPUT_PREFIX/$variant"
			artifact_root="$(variant_sysroot "$variant")"
			[ -d "$sysroot/include" ] || {
				echo "pinned toolchain is missing selected variant: $variant" >&2
				exit 2
			}
			[ -d "$artifact_root/include" ] || {
				echo "patched headers are missing for selected variant: $variant" >&2
				exit 2
			}
			cp -a "$artifact_root/include/." "$sysroot/include/"
			cp "$artifact_root/lib/wasm32-wasi/libc.a" \
				"$sysroot/lib/wasm32-wasi/libc.a"
			cp "$artifact_root/lib/wasm32-wasi/libwasi-emulated-mman.a" \
				"$sysroot/lib/wasm32-wasi/libwasi-emulated-mman.a"
		done
	'

carrier_manifest="$OUTPUT_PREFIX/$CARRIER_MANIFEST_NAME"
carrier_manifest_temporary="$carrier_manifest.tmp.$$"
{
	printf 'schema=oliphaunt.wasix-libc-sysroots.v1\n'
	printf 'variants=%s\n' "$WASIX_LIBC_VARIANTS"
	for variant in "${SELECTED_VARIANTS[@]}"; do
		write_variant_manifest "$variant"
	done
} >"$carrier_manifest_temporary"
mv "$carrier_manifest_temporary" "$carrier_manifest"
sha256_file "$carrier_manifest" >"$OUTPUT_PREFIX/.fresh-sysroot-signature"

expected_count="${#SELECTED_VARIANTS[@]}"
actual_count=0
for sysroot in "$OUTPUT_PREFIX"/sysroot*; do
	[ -d "$sysroot" ] || continue
	actual_count=$((actual_count + 1))
	case " $WASIX_LIBC_VARIANTS " in
		*" $(basename "$sysroot") "*) ;;
		*) fail "unselected stock sysroot escaped pruning: $sysroot" ;;
	esac
done
[ "$actual_count" -eq "$expected_count" ] ||
	fail "carrier contains $actual_count sysroot variants; expected $expected_count"

printf 'merged sysroot prefix: %s\n' "$OUTPUT_PREFIX"
printf 'variants: %s\n' "$WASIX_LIBC_VARIANTS"
printf 'build log: %s\n' "$BUILD_LOG"
printf 'carrier manifest: %s\n' "$carrier_manifest"
printf 'sysroot signature: %s\n' "$(cat "$OUTPUT_PREFIX/.fresh-sysroot-signature")"
