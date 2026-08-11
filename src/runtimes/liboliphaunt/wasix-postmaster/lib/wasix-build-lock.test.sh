#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$root/lib/common.sh"
source "$root/lib/wasix-build-lock.sh"

fresh_ensure_dirs
test_root="$(mktemp -d "$FRESH_WORK_ROOT/wasix-build-lock-test.XXXXXX")"
cleanup() { rm -rf -- "$test_root"; }
trap cleanup EXIT HUP INT TERM
install="$test_root/install/wasix-core"
other_install="$test_root/install/wasix-core-release-o3"
mkdir -p "$(dirname "$install")"

fresh_lock_wasix_core_build "$install"
[ -n "${FRESH_WASIX_CORE_BUILD_LOCK_FD:-}" ]
[ "$FRESH_WASIX_CORE_BUILD_LOCK_INSTALL" = "$install" ]
[ -f "$FRESH_WASIX_CORE_BUILD_LOCK_PATH" ]
[ ! -L "$FRESH_WASIX_CORE_BUILD_LOCK_PATH" ]
[ "$FRESH_WASIX_CORE_BUILD_LOCK_PATH" = \
  "$(fresh_managed_generated_root)/producer-locks/wasix-core-producer.lock" ]

bash -c '
  set -euo pipefail
  source "$1/lib/common.sh"
  source "$1/lib/wasix-build-lock.sh"
  fresh_lock_wasix_core_build "$2"
' _ "$root" "$install"

if (
  exec {competing_fd}>"$FRESH_WASIX_CORE_BUILD_LOCK_PATH"
  flock -n "$competing_fd"
); then
  echo 'a competing process acquired the held WASIX core build lock' >&2
  exit 1
fi

# Re-entering for the same install is idempotent; changing identity fails.
fresh_lock_wasix_core_build "$install"
if fresh_lock_wasix_core_build "$other_install" 2>/dev/null; then
  echo 'build lock accepted a second install identity' >&2
  exit 1
fi

# An independent profile/process must contend on the same product-wide lock,
# even though its install identity differs.
if (
  inherited_fd="$FRESH_WASIX_CORE_BUILD_LOCK_FD"
  exec {inherited_fd}>&-
  unset FRESH_WASIX_CORE_BUILD_LOCK_FD
  unset FRESH_WASIX_CORE_BUILD_LOCK_INSTALL
  unset FRESH_WASIX_CORE_BUILD_LOCK_PATH
  flock -n "$(fresh_managed_generated_root)/producer-locks/wasix-core-producer.lock" true
); then
  echo 'a distinct profile acquired the held WASIX core producer lock' >&2
  exit 1
fi

printf 'WASIX core build lock tests passed\n'
