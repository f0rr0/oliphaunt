#!/usr/bin/env bash

set -euo pipefail

UPSTREAM_SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FRESH_ROOT="$(cd "$UPSTREAM_SOURCE_ROOT/.." && pwd)"
REPO_ROOT="$(cd "$FRESH_ROOT/../../../.." && pwd)"
WASIX_BUILD_ROOT="$REPO_ROOT/assets/wasix-build"
UPSTREAM_WORK_ROOT="${UPSTREAM_WORK_ROOT:-$WASIX_BUILD_ROOT/work/upstream}"

WASMER_REMOTE="${WASMER_REMOTE:-https://github.com/wasmerio/wasmer.git}"
WASMER_FETCH_REF="${WASMER_FETCH_REF:-refs/tags/v7.2.0-alpha.2}"
WASMER_REF="${WASMER_REF:-1d1b3420beef28550afbb4692b664bd7f6bc2581}"
WASMER_NAPI_REF="${WASMER_NAPI_REF:-706383f42391cb4e4e82e5fd5e63a0ebf81ae19d}"
WASIX_LIBC_REMOTE="${WASIX_LIBC_REMOTE:-https://github.com/wasix-org/wasix-libc.git}"
WASIX_LIBC_FETCH_REF="${WASIX_LIBC_FETCH_REF:-main}"
WASIX_LIBC_REF="${WASIX_LIBC_REF:-34178a6272804f90448b5bd08dc7bcf0d85438e3}"

WASMER_ROOT="${WASMER_ROOT:-$UPSTREAM_WORK_ROOT/wasmer}"
WASIX_LIBC_ROOT="${WASIX_LIBC_ROOT:-$UPSTREAM_WORK_ROOT/wasix-libc}"

FORCE=0
SKIP_PATCHES=0

usage() {
	cat <<EOF
usage: $0 [--force] [--skip-patches]

Prepares the ignored Wasmer and wasix-libc source checkouts used by the fresh
PostgreSQL/WASIX upstream blocker harness, then applies the tracked local patch
exports.

Environment:
  UPSTREAM_WORK_ROOT   ignored work root. Default: $UPSTREAM_WORK_ROOT
  WASMER_REMOTE        Wasmer git remote. Default: $WASMER_REMOTE
  WASMER_FETCH_REF     Wasmer ref to fetch. Default: $WASMER_FETCH_REF
  WASMER_REF           Wasmer commit to check out. Default: $WASMER_REF
  WASMER_NAPI_REF      Wasmer lib/napi submodule commit. Default: $WASMER_NAPI_REF
  WASIX_LIBC_REMOTE    wasix-libc git remote. Default: $WASIX_LIBC_REMOTE
  WASIX_LIBC_FETCH_REF wasix-libc ref to fetch. Default: $WASIX_LIBC_FETCH_REF
  WASIX_LIBC_REF       wasix-libc commit to check out. Default: $WASIX_LIBC_REF

Options:
  --force              Reset existing checkouts before applying patches.
                       This uses git reset --hard and git clean -fd, but not
                       git clean -x, so ignored build artifacts such as target/
                       are preserved.
  --skip-patches       Only fetch/check out source refs.
EOF
}

while [ "$#" -gt 0 ]; do
	case "$1" in
		--force)
			FORCE=1
			shift
			;;
		--skip-patches)
			SKIP_PATCHES=1
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

require_clean_or_force() {
	local root="$1"
	local name="$2"
	if [ ! -d "$root/.git" ]; then
		return
	fi
	if [ "$FORCE" -eq 1 ]; then
		return
	fi
	if ! git -C "$root" diff --quiet ||
		! git -C "$root" diff --cached --quiet ||
		[ -n "$(git -C "$root" ls-files --others --exclude-standard)" ]; then
		{
			printf '%s checkout is not clean: %s\n' "$name" "$root"
			printf 'Re-run with --force or set a different UPSTREAM_WORK_ROOT.\n'
		} >&2
		exit 2
	fi
}

prepare_checkout() {
	local name="$1"
	local root="$2"
	local remote="$3"
	local fetch_ref="$4"
	local checkout_ref="$5"

	require_clean_or_force "$root" "$name"
	mkdir -p "$(dirname "$root")"
	if [ ! -d "$root/.git" ]; then
		git init "$root" >/dev/null
		git -C "$root" remote add origin "$remote"
	else
		git -C "$root" remote set-url origin "$remote"
		if [ "$FORCE" -eq 1 ]; then
			git -C "$root" reset --hard >/dev/null
			git -C "$root" clean -fd >/dev/null
		fi
	fi

	if ! git -C "$root" fetch --depth=1 origin "$fetch_ref"; then
		git -C "$root" fetch origin "$fetch_ref"
	fi
	git -C "$root" checkout --detach "$checkout_ref" >/dev/null
}

apply_patch_export() {
	local name="$1"
	local root="$2"
	local patch="$3"

	if [ "$SKIP_PATCHES" -eq 1 ]; then
		return
	fi
	if ! git -C "$root" apply --check "$patch"; then
		{
			printf 'patch does not apply for %s: %s\n' "$name" "$patch"
			printf 'Reset the checkout with --force, inspect source drift, or refresh the tracked patch export.\n'
		} >&2
		exit 1
	fi
	git -C "$root" apply "$patch"
}

prepare_checkout "Wasmer" "$WASMER_ROOT" "$WASMER_REMOTE" "$WASMER_FETCH_REF" "$WASMER_REF"
git -C "$WASMER_ROOT" submodule update --init lib/napi
if git -C "$WASMER_ROOT/lib/napi" rev-parse --git-dir >/dev/null 2>&1; then
	actual_napi_ref="$(git -C "$WASMER_ROOT/lib/napi" rev-parse HEAD)"
	if [ "$actual_napi_ref" != "$WASMER_NAPI_REF" ]; then
		printf 'unexpected lib/napi submodule ref: %s (expected %s)\n' "$actual_napi_ref" "$WASMER_NAPI_REF" >&2
		exit 1
	fi
else
	printf 'lib/napi submodule is not a git checkout: %s\n' "$WASMER_ROOT/lib/napi" >&2
	exit 1
fi

prepare_checkout "wasix-libc" "$WASIX_LIBC_ROOT" "$WASIX_LIBC_REMOTE" "$WASIX_LIBC_FETCH_REF" "$WASIX_LIBC_REF"

apply_patch_export \
	"Wasmer" \
	"$WASMER_ROOT" \
	"$UPSTREAM_SOURCE_ROOT/patches/wasmer/0001-postgres-wasix-blockers.patch"
apply_patch_export \
	"wasix-libc" \
	"$WASIX_LIBC_ROOT" \
	"$UPSTREAM_SOURCE_ROOT/patches/wasix-libc/0001-postgres-wasix-blockers.patch"

printf 'prepared Wasmer checkout: %s\n' "$WASMER_ROOT"
printf '  base: %s\n' "$(git -C "$WASMER_ROOT" rev-parse HEAD)"
printf '  patch files changed: %s\n' "$(git -C "$WASMER_ROOT" status --short | wc -l | tr -d ' ')"
printf 'prepared wasix-libc checkout: %s\n' "$WASIX_LIBC_ROOT"
printf '  base: %s\n' "$(git -C "$WASIX_LIBC_ROOT" rev-parse HEAD)"
printf '  patch files changed: %s\n' "$(git -C "$WASIX_LIBC_ROOT" status --short | wc -l | tr -d ' ')"
