#!/usr/bin/env bash

# Product-wide serialization shared by every WASIX PostgreSQL producer.
# Profiles have distinct install directories but intentionally share mutable
# source defaults, so an install-scoped lock cannot protect the producer.
# Source lib/common.sh before this file.

fresh_lock_wasix_core_build() {
  local install="${1:-${WASIX_INSTALL_DIR:-}}"
  local managed_root lock_dir lock

  [ -n "$install" ] || {
    printf 'fresh_lock_wasix_core_build requires an install directory\n' >&2
    return 2
  }
  fresh_require_managed_generated_path "$install" wasix-core-install
  fresh_require_command flock
  managed_root="$(fresh_managed_generated_root)" || return
  lock_dir="$managed_root/producer-locks"
  fresh_require_managed_generated_path "$lock_dir" wasix-core-producer-locks
  mkdir -p "$lock_dir"
  [ -d "$lock_dir" ] && [ ! -L "$lock_dir" ] || {
    printf 'unsafe WASIX core build lock directory: %s\n' "$lock_dir" >&2
    return 2
  }
  lock="$lock_dir/wasix-core-producer.lock"
  fresh_require_managed_generated_path "$lock" wasix-core-producer-lock
  [ ! -L "$lock" ] || {
    printf 'unsafe WASIX core build lock: %s\n' "$lock" >&2
    return 2
  }
  if [ -n "${FRESH_WASIX_CORE_BUILD_LOCK_FD:-}" ]; then
    case "$FRESH_WASIX_CORE_BUILD_LOCK_FD" in
      *[!0-9]*|'')
        printf 'inherited WASIX core build lock descriptor is invalid\n' >&2
        return 2
        ;;
    esac
    [ "${FRESH_WASIX_CORE_BUILD_LOCK_INSTALL:-}" = "$install" ] &&
      [ "${FRESH_WASIX_CORE_BUILD_LOCK_PATH:-}" = "$lock" ] &&
      [ -f "$lock" ] && [ ! -L "$lock" ] &&
      flock -x "$FRESH_WASIX_CORE_BUILD_LOCK_FD" || {
      printf 'inherited WASIX core producer lock does not match %s\n' "$install" >&2
      return 2
    }
    return 0
  fi
  exec {FRESH_WASIX_CORE_BUILD_LOCK_FD}>"$lock"
  [ -f "$lock" ] && [ ! -L "$lock" ] || {
    printf 'WASIX core build lock changed while opening: %s\n' "$lock" >&2
    exec {FRESH_WASIX_CORE_BUILD_LOCK_FD}>&-
    unset FRESH_WASIX_CORE_BUILD_LOCK_FD
    return 2
  }
  flock -x "$FRESH_WASIX_CORE_BUILD_LOCK_FD" || {
    printf 'could not lock WASIX core producer for %s\n' "$install" >&2
    exec {FRESH_WASIX_CORE_BUILD_LOCK_FD}>&-
    unset FRESH_WASIX_CORE_BUILD_LOCK_FD
    return 2
  }
  [ -f "$lock" ] && [ ! -L "$lock" ] || {
    printf 'WASIX core build lock changed while locking: %s\n' "$lock" >&2
    exec {FRESH_WASIX_CORE_BUILD_LOCK_FD}>&-
    unset FRESH_WASIX_CORE_BUILD_LOCK_FD
    return 2
  }
  FRESH_WASIX_CORE_BUILD_LOCK_INSTALL="$install"
  FRESH_WASIX_CORE_BUILD_LOCK_PATH="$lock"
  export FRESH_WASIX_CORE_BUILD_LOCK_FD
  export FRESH_WASIX_CORE_BUILD_LOCK_INSTALL
  export FRESH_WASIX_CORE_BUILD_LOCK_PATH
}
