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

# Read the complete diagnostic payload before deciding whether it matches.
# A producer piped into `grep -q`/`rg -q` can receive SIGPIPE after the matcher
# exits on its first hit. Under `set -o pipefail`, that turns a successful
# readiness probe into a false failure. These helpers deliberately consume the
# complete payload so callers remain deterministic for large symbol tables.
oliphaunt_text_matches_ere() {
  [ "$#" -eq 2 ] || {
    echo "oliphaunt_text_matches_ere requires text and an extended regular expression" >&2
    return 2
  }
  printf '%s\n' "$1" | awk -v oliphaunt_pattern="$2" '
    $0 ~ oliphaunt_pattern { oliphaunt_found = 1 }
    END { exit oliphaunt_found ? 0 : 1 }
  '
}

oliphaunt_text_has_nm_symbol() {
  [ "$#" -eq 2 ] || {
    echo "oliphaunt_text_has_nm_symbol requires nm output and a symbol" >&2
    return 2
  }
  printf '%s\n' "$1" | awk -v oliphaunt_symbol="$2" '
    $NF == oliphaunt_symbol || $NF == "_" oliphaunt_symbol { oliphaunt_found = 1 }
    END { exit oliphaunt_found ? 0 : 1 }
  '
}

oliphaunt_tail_log_excerpt() {
  [ "$#" -ge 1 ] && [ "$#" -le 3 ] || {
    echo "oliphaunt_tail_log_excerpt requires a path and optional line/column limits" >&2
    return 2
  }
  [ -f "$1" ] || return 0
  tail -n "${2:-40}" "$1" | awk -v oliphaunt_columns="${3:-2000}" '
    length($0) > oliphaunt_columns {
      print substr($0, 1, oliphaunt_columns) " ... [line truncated]"
      next
    }
    { print }
  '
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
