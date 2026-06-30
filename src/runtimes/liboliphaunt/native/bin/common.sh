#!/usr/bin/env sh

oliphaunt_resolve_repo_root() {
  script_dir="${1:?oliphaunt_resolve_repo_root requires a script directory}"
  if repo_root="$(git -C "$script_dir" rev-parse --show-toplevel 2>/dev/null)"; then
    printf '%s\n' "$repo_root"
    return 0
  fi
  cd "$script_dir/../../../../.." && pwd
}

oliphaunt_native_release_cflags() {
  printf '%s' '-O2'
  case "${OLIPHAUNT_NATIVE_DEBUG_SYMBOLS:-0}" in
    1|true|TRUE|yes|YES|on|ON)
      printf ' %s' '-g'
      ;;
  esac
  while [ "$#" -gt 0 ]; do
    printf ' %s' "$1"
    shift
  done
}
