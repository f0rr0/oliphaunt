#!/usr/bin/env bash

# Readers resolve once; publishing a selection never changes a directory in use.
fresh_resolve_guest_generation() {
  local base="$1" identity generation
  if [ ! -e "$base.current" ] && [ ! -L "$base.current" ]; then
    printf '%s\n' "$base"
    return
  fi
  [ -f "$base.current" ] && [ ! -L "$base.current" ] || return 2
  identity="$(cat "$base.current")" || return 2
  [[ "$identity" =~ ^[0-9a-f]{64}$ ]] || return 2
  generation="$base.generations/$identity"
  [ -d "$base.generations" ] && [ ! -L "$base.generations" ] &&
    [ -d "$generation" ] && [ ! -L "$generation" ] &&
    [ -f "$generation/guest-build.receipt" ] && [ ! -L "$generation/guest-build.receipt" ] || return 2
  printf '%s\n' "$generation"
}

fresh_publish_guest_generation() {
  local stage="$1" base="$2" identity destination existing
  identity="$(bun "$FRESH_ROOT/lib/guest-build-provenance.mts" seal-generation-identity "$stage")" || return
  fresh_is_sha256 "$identity" || return 2
  destination="$base.generations/$identity"
  [ "$(dirname "$stage")" = "$base.generations" ] || return 2
  existing="$(fresh_manifest_value "$stage/guest-build.receipt" installed_closure_sha256)" || return
  [ "$(bun "$FRESH_ROOT/lib/guest-build-provenance.mts" seal-identity "$stage")" = "$existing" ] || return 2
  if [ -e "$destination" ] || [ -L "$destination" ]; then
    [ -d "$destination" ] && [ ! -L "$destination" ] &&
      cmp -s "$stage/guest-build.receipt" "$destination/guest-build.receipt" &&
      [ "$(bun "$FRESH_ROOT/lib/guest-build-provenance.mts" generation-identity "$destination")" = "$identity" ] || return 2
    rm -rf -- "$stage"
  else
    fresh_atomic_publish_directory_noreplace "$stage" "$destination" || return
  fi
  bun "$FRESH_ROOT/lib/select-guest-generation.mts" "$base.current" "$identity" || return
  printf '%s\n' "$destination"
}
