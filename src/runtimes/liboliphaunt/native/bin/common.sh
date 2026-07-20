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

oliphaunt_native_external_extension_source_rel() {
  [ "$#" -eq 2 ] || {
    echo "oliphaunt_native_external_extension_source_rel requires a repository root and extension id" >&2
    return 2
  }
  case "$2" in
    postgis)
      printf '%s\n' 'target/oliphaunt-sources/checkouts/postgis'
      ;;
    *)
      awk -F '\t' -v extension="$2" '
        NR > 1 && ($1 == extension || $3 == "target/oliphaunt-sources/checkouts/" extension) {
          print $3
          found = 1
          exit
        }
        END { exit found ? 0 : 1 }
      ' "$1/src/extensions/generated/pgxs-build.tsv"
      ;;
  esac
}
