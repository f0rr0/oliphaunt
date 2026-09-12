#!/usr/bin/env bash

oliphaunt_icu_canonical_data_archive() {
  local source_dir="${1:?ICU source dir is required}"
  printf '%s\n' "${OLIPHAUNT_ICU_DATA_ARCHIVE:-$source_dir/../../../icu-data/icudt76l.dat}"
}

oliphaunt_icu_canonical_data_sha256() {
  printf '%s\n' 'dbc14e1c48ef209f230adc2aa6854bd4d6bba8f5e6733e75897a4263d97920f0'
}

oliphaunt_icu_sha256() {
  local digest
  if command -v sha256sum >/dev/null 2>&1; then
    digest="$(sha256sum "$@")" || return 1
  elif command -v shasum >/dev/null 2>&1; then
    digest="$(shasum -a 256 "$@")" || return 1
  else
    echo "ICU hashing requires sha256sum or shasum" >&2
    return 127
  fi
  printf '%s\n' "${digest%% *}"
}

oliphaunt_icu_require_canonical_data() {
  local archive="${1:?ICU data archive is required}"
  [ -f "$archive" ] || {
    echo "missing pinned ICU 76.1 data archive at $archive; run \`bash third-party/tools/fetch-sources.sh native-runtime --force\` first" >&2
    return 1
  }
  local actual
  actual="$(oliphaunt_icu_sha256 < "$archive")" || return 1
  [ "$actual" = "$(oliphaunt_icu_canonical_data_sha256)" ] || {
    echo "ICU data archive checksum mismatch: expected $(oliphaunt_icu_canonical_data_sha256), got $actual" >&2
    return 1
  }
}

oliphaunt_icu_data_root_contains_data() {
  local data_root="${1:?ICU data root is required}"
  [ -d "$data_root" ] || return 1
  local root_name
  root_name="$(basename "$data_root")"
  if [[ "$root_name" == icudt* ]] &&
     find "$data_root" -mindepth 1 -type f -print -quit 2>/dev/null | grep -q .; then
    return 0
  fi
  if compgen -G "$data_root/icudt*.dat" >/dev/null; then
    return 0
  fi
  local child
  while IFS= read -r child; do
    if find "$child" -type f -print -quit 2>/dev/null | grep -q .; then
      return 0
    fi
  done < <(find "$data_root" -mindepth 1 -maxdepth 1 -type d -name 'icudt*' 2>/dev/null | LC_ALL=C sort)
  return 1
}

oliphaunt_icu_files_data_ready() {
  local data_root="${1:?ICU data root is required}"
  oliphaunt_icu_data_root_contains_data "$data_root" && return 0
  local child
  while IFS= read -r child; do
    if oliphaunt_icu_data_root_contains_data "$child"; then
      return 0
    fi
  done < <(find "$data_root" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | LC_ALL=C sort)
  return 1
}

oliphaunt_icu_install_canonical_data() {
  local archive="${1:?pinned ICU data archive is required}"
  local destination="${2:?ICU data destination is required}"
  oliphaunt_icu_require_canonical_data "$archive" || return 1
  local tmp_destination="$destination.tmp"

  rm -rf "$tmp_destination"
  mkdir -p "$tmp_destination"
  cp "$archive" "$tmp_destination/icudt76l.dat"
  rm -rf "$destination"
  mv "$tmp_destination" "$destination"
  oliphaunt_icu_files_data_ready "$destination"
}

oliphaunt_icu_data_source_dir() {
  local prefix="${1:?ICU prefix is required}"
  local installed_icu="$prefix/share/icu"
  if oliphaunt_icu_data_root_contains_data "$installed_icu"; then
    printf '%s\n' "$installed_icu"
    return 0
  fi

  local child
  while IFS= read -r child; do
    if [ -d "$child" ] && oliphaunt_icu_data_root_contains_data "$child"; then
      printf '%s\n' "$child"
      return 0
    fi
  done < <(find "$installed_icu" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | LC_ALL=C sort)
  return 1
}

oliphaunt_icu_stage_data() {
  local prefix="${1:?ICU prefix is required}"
  local destination="${2:?destination ICU data root is required}"
  local source
  source="$(oliphaunt_icu_data_source_dir "$prefix")" || return 1
  oliphaunt_icu_copy_files_data "$source" "$destination"
}

oliphaunt_icu_copy_files_data() {
  local source="${1:?source ICU data root is required}"
  local destination="${2:?destination ICU data root is required}"
  [ -d "$source" ] || return 1
  if find "$source" -type l -print -quit | grep -q .; then
    echo "ICU files-data source must not contain symbolic links: $source" >&2
    return 1
  fi
  rm -rf "$destination"
  mkdir -p "$destination"
  local copied=0
  local child name
  while IFS= read -r child; do
    name="$(basename "$child")"
    if [ -f "$child" ] && [[ "$name" =~ ^icudt[0-9]+[a-z]*[.]dat$ ]]; then
      cp -p "$child" "$destination/$name"
      copied=$((copied + 1))
    elif [ -d "$child" ] && [[ "$name" =~ ^icudt[0-9]+[a-z]*$ ]] &&
      find "$child" -type f -print -quit | grep -q .; then
      cp -pR "$child" "$destination/$name"
      copied=$((copied + 1))
    fi
  done < <(find "$source" -mindepth 1 -maxdepth 1 -print | LC_ALL=C sort)
  if [ "$copied" -ne 1 ]; then
    echo "ICU data root must contain exactly one canonical icudt files-data payload: $source" >&2
    rm -rf "$destination"
    return 1
  fi
  oliphaunt_icu_files_data_ready "$destination"
}
