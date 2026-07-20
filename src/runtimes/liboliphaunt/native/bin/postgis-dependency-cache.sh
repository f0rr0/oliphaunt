#!/usr/bin/env bash

oliphaunt_postgis_dependency_cache_validate_inputs() {
  local dependency_root="$1"
  local fingerprint="$2"
  shift 2

  if [ -z "$dependency_root" ] || [ "$dependency_root" = "/" ]; then
    echo "postgis-dependency-cache.sh: refusing unsafe dependency cache root: ${dependency_root:-<empty>}" >&2
    return 2
  fi
  if [[ ! "$fingerprint" =~ ^[0-9a-f]{64}$ ]]; then
    echo "postgis-dependency-cache.sh: dependency fingerprint must be a lowercase SHA-256" >&2
    return 2
  fi

  local build_root
  for build_root in "$@"; do
    if [ -z "$build_root" ] || [ "$build_root" = "/" ]; then
      echo "postgis-dependency-cache.sh: refusing unsafe dependency build root: ${build_root:-<empty>}" >&2
      return 2
    fi
  done
}

oliphaunt_postgis_dependency_cache_write_manifest() {
  local dependency_root="$1"
  local output="$2"
  (
    cd "$dependency_root"
    find . -type f ! -name '.oliphaunt-postgis-native-dependencies.*' -print |
      LC_ALL=C sort |
      while IFS= read -r file; do
        shasum -a 256 "$file"
      done
  ) > "$output"
}

oliphaunt_postgis_dependency_cache_is_complete() {
  local dependency_root="$1"
  local fingerprint="$2"
  local stamp="$dependency_root/.oliphaunt-postgis-native-dependencies.sha256"
  local manifest="$dependency_root/.oliphaunt-postgis-native-dependencies.manifest"
  local current_manifest="$dependency_root/.oliphaunt-postgis-native-dependencies.current.$$"

  [ -f "$stamp" ] && [ ! -L "$stamp" ] || return 1
  [ -f "$manifest" ] && [ ! -L "$manifest" ] && [ -s "$manifest" ] || return 1
  [ "$(<"$stamp")" = "$fingerprint" ] || return 1
  if find "$dependency_root" -type l -print -quit | grep -q .; then
    return 1
  fi

  rm -rf -- "$current_manifest"
  if ! oliphaunt_postgis_dependency_cache_write_manifest "$dependency_root" "$current_manifest"; then
    rm -f -- "$current_manifest"
    return 1
  fi
  if ! cmp -s "$current_manifest" "$manifest"; then
    rm -f -- "$current_manifest"
    return 1
  fi
  rm -f -- "$current_manifest"
}

oliphaunt_postgis_dependency_cache_prepare() {
  local dependency_root="$1"
  local fingerprint="$2"
  shift 2
  local -a build_roots=("$@")
  local stamp="$dependency_root/.oliphaunt-postgis-native-dependencies.sha256"

  oliphaunt_postgis_dependency_cache_validate_inputs \
    "$dependency_root" \
    "$fingerprint" \
    "${build_roots[@]}" || return

  if ! oliphaunt_postgis_dependency_cache_is_complete "$dependency_root" "$fingerprint"; then
    rm -rf -- "$dependency_root" "${build_roots[@]}"
  fi
  mkdir -p "$dependency_root"
  # A completion stamp is a lease for exactly one verified reuse attempt. Drop
  # it before builders inspect the cache so an interrupted repair/reuse cannot
  # be mistaken for a committed cache by the next process.
  rm -f -- "$stamp"
}

oliphaunt_postgis_dependency_cache_commit() {
  local dependency_root="$1"
  local fingerprint="$2"
  shift 2
  local stamp="$dependency_root/.oliphaunt-postgis-native-dependencies.sha256"
  local temporary_stamp="$dependency_root/.oliphaunt-postgis-native-dependencies.sha256.tmp.$$"
  local manifest="$dependency_root/.oliphaunt-postgis-native-dependencies.manifest"
  local temporary_manifest="$dependency_root/.oliphaunt-postgis-native-dependencies.manifest.tmp.$$"

  oliphaunt_postgis_dependency_cache_validate_inputs "$dependency_root" "$fingerprint" || return
  mkdir -p "$dependency_root"
  local required
  for required in "$@"; do
    case "$required" in
      "$dependency_root"/*) ;;
      *)
        echo "postgis-dependency-cache.sh: required output escapes dependency cache root: $required" >&2
        return 2
        ;;
    esac
    if [ ! -s "$required" ] || [ -L "$required" ]; then
      echo "postgis-dependency-cache.sh: required output is missing, empty, or linked: $required" >&2
      return 1
    fi
  done
  if find "$dependency_root" -type l -print -quit | grep -q .; then
    echo "postgis-dependency-cache.sh: dependency cache contains a symbolic link" >&2
    return 1
  fi
  rm -rf -- "$temporary_manifest" "$temporary_stamp"
  oliphaunt_postgis_dependency_cache_write_manifest "$dependency_root" "$temporary_manifest"
  if [ ! -s "$temporary_manifest" ]; then
    rm -f -- "$temporary_manifest"
    echo "postgis-dependency-cache.sh: refusing to commit an empty dependency cache" >&2
    return 1
  fi
  printf '%s\n' "$fingerprint" > "$temporary_stamp"
  mv -f -- "$temporary_manifest" "$manifest"
  mv -f -- "$temporary_stamp" "$stamp"
}
