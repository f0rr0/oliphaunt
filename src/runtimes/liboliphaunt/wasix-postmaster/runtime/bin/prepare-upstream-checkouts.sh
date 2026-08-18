#!/usr/bin/env bash

set -euo pipefail

FRESH_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$FRESH_ROOT/lib/common.sh"
UPSTREAM_SOURCE_ROOT="$FRESH_ROOT/runtime"
UPSTREAM_WORK_ROOT="${UPSTREAM_WORK_ROOT:-$FRESH_WORK_ROOT/runtime}"
SOURCE_CHECKOUT_ROOT="${SOURCE_CHECKOUT_ROOT:-$REPO_ROOT/target/oliphaunt-sources/checkouts}"

WASMER_REF="${WASMER_REF:-$FRESH_WASMER_SOURCE_COMMIT}"
WASMER_NAPI_REF="${WASMER_NAPI_REF:-$FRESH_WASMER_NAPI_COMMIT}"
WASMER_TEST_FILES_REF="${WASMER_TEST_FILES_REF:-$FRESH_WASMER_TEST_FILES_COMMIT}"
WASMER_SPEC_REF="${WASMER_SPEC_REF:-$FRESH_WASMER_SPEC_COMMIT}"
WASIX_LIBC_REF="${WASIX_LIBC_REF:-$FRESH_WASIX_LIBC_SOURCE_COMMIT}"

WASMER_SOURCE_ROOT="${WASMER_SOURCE_ROOT:-$SOURCE_CHECKOUT_ROOT/wasmer-postmaster}"
WASMER_NAPI_SOURCE_ROOT="${WASMER_NAPI_SOURCE_ROOT:-$SOURCE_CHECKOUT_ROOT/wasmer-postmaster-napi}"
WASMER_TEST_FILES_SOURCE_ROOT="${WASMER_TEST_FILES_SOURCE_ROOT:-$SOURCE_CHECKOUT_ROOT/wasmer-postmaster-test-files}"
WASMER_SPEC_SOURCE_ROOT="${WASMER_SPEC_SOURCE_ROOT:-$SOURCE_CHECKOUT_ROOT/wasmer-postmaster-webassembly-testsuite}"
WASIX_LIBC_SOURCE_ROOT="${WASIX_LIBC_SOURCE_ROOT:-$SOURCE_CHECKOUT_ROOT/wasix-libc-postmaster}"
WASMER_ROOT="${WASMER_ROOT:-$UPSTREAM_WORK_ROOT/wasmer}"
WASIX_LIBC_ROOT="${WASIX_LIBC_ROOT:-$UPSTREAM_WORK_ROOT/wasix-libc}"
SIGNATURE_ROOT="$UPSTREAM_WORK_ROOT/.prepared"

fresh_require_command python3
python3 "$UPSTREAM_SOURCE_ROOT/bin/verify-source-lock.py"

FORCE=0
SKIP_PATCHES=0

usage() {
	cat <<EOF
usage: $0 [--force] [--skip-patches]

Creates disposable Wasmer and wasix-libc worktrees from the repository's
hardened, exact-pin source checkouts and applies the tracked runtime patches.
This command performs no network access and never patches the durable source
checkouts in place.

Source inputs:
  WASMER_SOURCE_ROOT       Default: $WASMER_SOURCE_ROOT
  WASMER_NAPI_SOURCE_ROOT  Default: $WASMER_NAPI_SOURCE_ROOT
  WASMER_TEST_FILES_SOURCE_ROOT
                            Default: $WASMER_TEST_FILES_SOURCE_ROOT
  WASMER_SPEC_SOURCE_ROOT  Default: $WASMER_SPEC_SOURCE_ROOT
  WASIX_LIBC_SOURCE_ROOT   Default: $WASIX_LIBC_SOURCE_ROOT

Generated worktrees:
  WASMER_ROOT              Default: $WASMER_ROOT
  WASIX_LIBC_ROOT          Default: $WASIX_LIBC_ROOT

Options:
  --force         Reset generated worktrees and reapply patches. Ignored build
                  artifacts such as target/ are preserved.
  --skip-patches  Materialize exact clean source worktrees only.
EOF
}

while [ "$#" -gt 0 ]; do
	case "$1" in
		--force) FORCE=1 ;;
		--skip-patches) SKIP_PATCHES=1 ;;
		-h|--help) usage; exit 0 ;;
		*) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
	esac
	shift
done

fresh_require_managed_generated_path "$UPSTREAM_WORK_ROOT" UPSTREAM_WORK_ROOT
fresh_require_managed_generated_path "$WASMER_ROOT" WASMER_ROOT
fresh_require_managed_generated_path "$WASIX_LIBC_ROOT" WASIX_LIBC_ROOT
fresh_require_managed_generated_path "$SIGNATURE_ROOT" SIGNATURE_ROOT

sha256_stream() {
	if command -v shasum >/dev/null 2>&1; then
		shasum -a 256 | awk '{print $1}'
	else
		sha256sum | awk '{print $1}'
	fi
}

sha256_file() {
	if command -v shasum >/dev/null 2>&1; then
		shasum -a 256 "$1" | awk '{print $1}'
	else
		sha256sum "$1" | awk '{print $1}'
	fi
}

verify_durable_source() {
	local name="$1"
	local root="$2"
	local expected_ref="$3"

	if [ ! -d "$root/.git" ]; then
		printf 'missing durable %s source checkout: %s\n' "$name" "$root" >&2
		printf 'run: OLIPHAUNT_FETCH_SOURCES=1 moon run liboliphaunt-wasix-postmaster:source-fetch\n' >&2
		exit 2
	fi
	local actual_ref
	actual_ref="$(git -C "$root" rev-parse HEAD)"
	[ "$actual_ref" = "$expected_ref" ] || {
		printf '%s source checkout is %s, expected %s: %s\n' "$name" "$actual_ref" "$expected_ref" "$root" >&2
		exit 1
	}
	[ -z "$(git -C "$root" status --porcelain)" ] || {
		printf 'durable %s source checkout is dirty: %s\n' "$name" "$root" >&2
		exit 1
	}
}

worktree_state_hash() {
	local root="$1"
	{
		git -C "$root" diff --binary HEAD
		git -C "$root" ls-files --others --exclude-standard -z |
			while IFS= read -r -d '' path; do
				printf 'untracked:%s\n' "$path"
				sha256_file "$root/$path"
			done
	} | sha256_stream
}

worktree_is_prepared() {
	local root="$1"
	local ref="$2"
	local input_signature="$3"
	local signature_file="$4"

	[ -d "$root/.git" ] || return 1
	[ "$(git -C "$root" rev-parse HEAD)" = "$ref" ] || return 1
	[ -f "$signature_file" ] || return 1
	local expected
	expected="${input_signature}:$(worktree_state_hash "$root")"
	[ "$(cat "$signature_file")" = "$expected" ]
}

materialize_worktree() {
	local name="$1"
	local source_root="$2"
	local root="$3"
	local ref="$4"
	fresh_require_managed_generated_path "$root" "generated $name worktree"

	if [ -d "$root/.git" ]; then
		if [ "$FORCE" -eq 1 ]; then
			git -C "$root" reset --hard "$ref" >/dev/null
			git -C "$root" clean -fd >/dev/null
		elif [ "$(git -C "$root" rev-parse HEAD)" != "$ref" ] ||
			[ -n "$(git -C "$root" status --porcelain)" ]; then
			printf '%s generated worktree is not clean or not at its recorded patch signature: %s\n' "$name" "$root" >&2
			printf 'inspect it or rerun this generated-target operation with --force\n' >&2
			exit 2
		fi
	else
		mkdir -p "$(dirname "$root")"
		git clone --quiet --no-hardlinks "$source_root" "$root"
		git -C "$root" checkout --quiet --detach "$ref"
	fi
}

materialize_gitlink() {
	local label="$1"
	local relative_path="$2"
	local source_root="$3"
	local expected_ref="$4"
	local checkout="$WASMER_ROOT/$relative_path"
	local gitlink_ref
	fresh_require_managed_generated_path "$checkout" "generated Wasmer $label checkout"
	gitlink_ref="$(git -C "$WASMER_ROOT" ls-tree HEAD "$relative_path" | awk '{print $3}')"
	[ "$gitlink_ref" = "$expected_ref" ] || {
		printf 'Wasmer %s gitlink is %s, expected %s\n' "$relative_path" "$gitlink_ref" "$expected_ref" >&2
		exit 1
	}

	if [ -d "$checkout/.git" ]; then
		if [ "$FORCE" -eq 1 ]; then
			git -C "$checkout" reset --hard "$expected_ref" >/dev/null
			git -C "$checkout" clean -fd >/dev/null
		fi
	else
		rmdir "$checkout" 2>/dev/null || true
		mkdir -p "$(dirname "$checkout")"
		git clone --quiet --no-hardlinks "$source_root" "$checkout"
		git -C "$checkout" checkout --quiet --detach "$expected_ref"
	fi
	[ "$(git -C "$checkout" rev-parse HEAD)" = "$expected_ref" ] || {
		printf 'generated Wasmer %s checkout has the wrong revision\n' "$label" >&2
		exit 1
	}
	[ -z "$(git -C "$checkout" status --porcelain)" ] || {
		printf 'generated Wasmer %s checkout is dirty\n' "$label" >&2
		exit 1
	}
}

prepare_patched_worktree() {
	local name="$1"
	local source_root="$2"
	local root="$3"
	local ref="$4"
	local patch="$5"
	local extra_signature="${6:-}"
	local patch_signature="skip"
	if [ "$SKIP_PATCHES" -ne 1 ]; then
		patch_signature="$(sha256_file "$patch")"
	fi
	local input_signature="$ref:$patch_signature:$extra_signature"
	local signature_file="$SIGNATURE_ROOT/$name.signature"

	if [ "$FORCE" -ne 1 ] && worktree_is_prepared "$root" "$ref" "$input_signature" "$signature_file"; then
		printf '%s generated worktree already matches the recorded patch signature\n' "$name"
		return
	fi

	materialize_worktree "$name" "$source_root" "$root" "$ref"
	if [ "$name" = "wasmer" ]; then
		materialize_gitlink "N-API" "lib/napi" "$WASMER_NAPI_SOURCE_ROOT" "$WASMER_NAPI_REF"
		materialize_gitlink "test files" "wasmer-test-files" "$WASMER_TEST_FILES_SOURCE_ROOT" "$WASMER_TEST_FILES_REF"
		materialize_gitlink "WebAssembly testsuite" "tests/wast/spec" "$WASMER_SPEC_SOURCE_ROOT" "$WASMER_SPEC_REF"
	fi
	if [ "$SKIP_PATCHES" -ne 1 ]; then
		git -C "$root" apply --check "$patch"
		git -C "$root" apply "$patch"
	fi
	mkdir -p "$SIGNATURE_ROOT"
	printf '%s:%s' "$input_signature" "$(worktree_state_hash "$root")" >"$signature_file"
}

verify_durable_source "Wasmer" "$WASMER_SOURCE_ROOT" "$WASMER_REF"
verify_durable_source "Wasmer N-API" "$WASMER_NAPI_SOURCE_ROOT" "$WASMER_NAPI_REF"
verify_durable_source "Wasmer test files" "$WASMER_TEST_FILES_SOURCE_ROOT" "$WASMER_TEST_FILES_REF"
verify_durable_source "WebAssembly testsuite" "$WASMER_SPEC_SOURCE_ROOT" "$WASMER_SPEC_REF"
verify_durable_source "wasix-libc" "$WASIX_LIBC_SOURCE_ROOT" "$WASIX_LIBC_REF"

prepare_patched_worktree \
	"wasmer" \
	"$WASMER_SOURCE_ROOT" \
	"$WASMER_ROOT" \
	"$WASMER_REF" \
	"$UPSTREAM_SOURCE_ROOT/patches/wasmer/0001-postgres-wasix-blockers.patch" \
	"$WASMER_NAPI_REF:$WASMER_TEST_FILES_REF:$WASMER_SPEC_REF"
prepare_patched_worktree \
	"wasix-libc" \
	"$WASIX_LIBC_SOURCE_ROOT" \
	"$WASIX_LIBC_ROOT" \
	"$WASIX_LIBC_REF" \
	"$UPSTREAM_SOURCE_ROOT/patches/wasix-libc/0001-postgres-wasix-blockers.patch"

printf 'prepared Wasmer worktree: %s\n' "$WASMER_ROOT"
printf '  base: %s\n' "$(git -C "$WASMER_ROOT" rev-parse HEAD)"
printf '  patch files changed: %s\n' "$(git -C "$WASMER_ROOT" status --short | wc -l | tr -d ' ')"
printf 'prepared wasix-libc worktree: %s\n' "$WASIX_LIBC_ROOT"
printf '  base: %s\n' "$(git -C "$WASIX_LIBC_ROOT" rev-parse HEAD)"
printf '  patch files changed: %s\n' "$(git -C "$WASIX_LIBC_ROOT" status --short | wc -l | tr -d ' ')"
