#!/usr/bin/env bash

oliphaunt_postgis_time_fail() {
  echo "PostGIS reproducible time: $*" >&2
  return 1
}

oliphaunt_postgis_source_date_epoch() {
  local repo_root="${1:?missing repository root}"
  local manifest="$repo_root/src/extensions/external/postgis/source.toml"
  local key_count epoch
  [ -f "$manifest" ] && [ ! -L "$manifest" ] ||
    oliphaunt_postgis_time_fail "canonical source manifest is not a regular file: $manifest" || return 1
  key_count="$(grep -Ec '^source_date_epoch[[:space:]]*=' "$manifest" || true)"
  [ "$key_count" = 1 ] ||
    oliphaunt_postgis_time_fail \
      "$manifest must declare exactly one canonical source_date_epoch integer" || return 1
  epoch="$(sed -nE 's/^source_date_epoch = ([0-9]+)$/\1/p' "$manifest")"
  [[ "$epoch" =~ ^[1-9][0-9]{0,11}$ ]] ||
    oliphaunt_postgis_time_fail \
      "$manifest source_date_epoch must be one canonical positive integer" || return 1
  [ "$epoch" -le 253402300799 ] ||
    oliphaunt_postgis_time_fail \
      "$manifest source_date_epoch exceeds the portable UTC range" || return 1
  printf '%s\n' "$epoch"
}

oliphaunt_postgis_enable_reproducible_time() {
  local repo_root="${1:?missing repository root}"
  local shim_dir="$repo_root/src/extensions/external/postgis/tools/reproducible-bin"
  local shim="$shim_dir/date"
  local resolved_date real_date
  [ -x "$shim" ] ||
    oliphaunt_postgis_time_fail "portable date shim is not executable: $shim" || return 1
  SOURCE_DATE_EPOCH="$(oliphaunt_postgis_source_date_epoch "$repo_root")" || return 1
  resolved_date="$(command -v date || true)"
  if [ "$resolved_date" = "$shim" ]; then
    real_date="${OLIPHAUNT_POSTGIS_REAL_DATE:-}"
  else
    # Never trust an inherited override on first enable. Capture the date command
    # selected by the producer's PATH before installing our scoped shim.
    real_date="$resolved_date"
  fi
  [ -n "$real_date" ] && [ -x "$real_date" ] && [ "$real_date" != "$shim" ] ||
    oliphaunt_postgis_time_fail "could not capture the host date command before installing the shim" || return 1
  OLIPHAUNT_POSTGIS_REAL_DATE="$real_date"
  case ":$PATH:" in
    *":$shim_dir:"*) ;;
    *) PATH="$shim_dir:$PATH" ;;
  esac
  export SOURCE_DATE_EPOCH OLIPHAUNT_POSTGIS_REAL_DATE PATH
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -euo pipefail
  [ "$#" = 1 ] || {
    echo "usage: reproducible-time.sh REPOSITORY_ROOT" >&2
    exit 2
  }
  oliphaunt_postgis_source_date_epoch "$1"
fi
