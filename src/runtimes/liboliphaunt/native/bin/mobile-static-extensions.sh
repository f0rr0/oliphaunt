#!/usr/bin/env bash

oliphaunt_mobile_static_specs_tsv() {
  local script_dir
  script_dir="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
  printf '%s\n' "$script_dir/../../../../../src/extensions/generated/mobile/static-extensions.tsv"
}

oliphaunt_mobile_static_extension_spec() {
  local extension="${1:?missing mobile static extension}"
  local spec_path
  spec_path="$(oliphaunt_mobile_static_specs_tsv)"
  [ -f "$spec_path" ] || return 1
  awk -F '\t' -v extension="$extension" '
    $1 == extension {
      printf "%s", $1
      for (field = 2; field <= 16; field++) {
        printf "|%s", $field
      }
      printf "\n"
      found = 1
      exit
    }
    END { exit found ? 0 : 1 }
  ' "$spec_path"
}

oliphaunt_mobile_static_supported_extensions() {
  local spec_path
  spec_path="$(oliphaunt_mobile_static_specs_tsv)"
  [ -f "$spec_path" ] || return 1
  awk -F '\t' 'NR > 2 && $1 != "" { print $1 }' "$spec_path"
}

oliphaunt_mobile_static_spec_field() {
  local spec="${1:?missing mobile static extension spec}"
  local field="${2:?missing mobile static extension spec field}"
  printf '%s\n' "$spec" | awk -F '|' -v field="$field" '{ print $field }'
}

oliphaunt_mobile_static_extension_sql_name() {
  oliphaunt_mobile_static_spec_field "$(oliphaunt_mobile_static_extension_spec "$1")" 1
}

oliphaunt_mobile_static_extension_module_stem() {
  oliphaunt_mobile_static_spec_field "$(oliphaunt_mobile_static_extension_spec "$1")" 2
}

oliphaunt_mobile_static_extension_kind() {
  oliphaunt_mobile_static_spec_field "$(oliphaunt_mobile_static_extension_spec "$1")" 3
}

oliphaunt_mobile_static_extension_dependencies() {
  local extension="${1:?missing mobile static extension}"
  if [ -n "${oliphaunt_mobile_target:-}" ]; then
    oliphaunt_mobile_static_extension_dependencies_for_target "$extension" "$oliphaunt_mobile_target"
    return 0
  fi
  oliphaunt_mobile_static_extension_dependency_field "$extension" 5
}

oliphaunt_mobile_static_extension_dependencies_for_target() {
  local extension="${1:?missing mobile static extension}"
  local target="${2:?missing mobile static target}"
  case "$target" in
    ios | ios-simulator | ios-device)
      oliphaunt_mobile_static_extension_dependency_field "$extension" 6 5
      ;;
    android | android-arm64 | android-x86_64 | arm64-v8a | x86_64)
      oliphaunt_mobile_static_extension_dependency_field "$extension" 7 5
      ;;
    *)
      oliphaunt_mobile_static_extension_dependency_field "$extension" 5
      ;;
  esac
}

oliphaunt_mobile_static_extension_dependency_field() {
  oliphaunt_mobile_static_extension_list_field "$@"
}

oliphaunt_mobile_static_extension_list_field() {
  local extension="${1:?missing mobile static extension}"
  local primary_field="${2:?missing list field}"
  local fallback_field="${3:-}"
  local spec values
  spec="$(oliphaunt_mobile_static_extension_spec "$extension")"
  values="$(oliphaunt_mobile_static_spec_field "$spec" "$primary_field")"
  if [ -z "$values" ] && [ -n "$fallback_field" ]; then
    values="$(oliphaunt_mobile_static_spec_field "$spec" "$fallback_field")"
  fi
  printf '%s\n' "$values" | tr ',' '\n' | sed '/^$/d'
}

oliphaunt_mobile_static_dependency_archive_candidates() {
  local dependency_root="${1:?missing mobile static dependency root}"
  local dependency="${2:?missing mobile static dependency name}"
  case "$dependency" in
    geos-c) printf '%s\n' "$dependency_root/geos/lib/libgeos_c.a" ;;
    geos) printf '%s\n' "$dependency_root/geos/lib/libgeos.a" ;;
    json-c) printf '%s\n' "$dependency_root/json-c/lib/libjson-c.a" ;;
    libcharset) printf '%s\n' "$dependency_root/libiconv/lib/libcharset.a" ;;
    libiconv) printf '%s\n' "$dependency_root/libiconv/lib/libiconv.a" ;;
    libxml2) printf '%s\n' "$dependency_root/libxml2/lib/libxml2.a" ;;
    openssl)
      printf '%s\n' \
        "$dependency_root/openssl/libcrypto.a" \
        "$dependency_root/openssl/lib/libcrypto.a"
      ;;
    proj) printf '%s\n' "$dependency_root/proj/lib/libproj.a" ;;
    sqlite) printf '%s\n' "$dependency_root/sqlite/lib/libsqlite3.a" ;;
    uuid) printf '%s\n' "$dependency_root/uuid/lib/libuuid.a" ;;
    *)
      printf '%s\n' "$dependency_root/$dependency/lib$dependency.a"
      ;;
  esac
}

oliphaunt_mobile_static_dependency_archive_for_root() {
  local dependency_root="${1:?missing mobile static dependency root}"
  local dependency="${2:?missing mobile static dependency name}"
  local candidate
  while IFS= read -r candidate; do
    [ -n "$candidate" ] || continue
    if [ -f "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done < <(oliphaunt_mobile_static_dependency_archive_candidates "$dependency_root" "$dependency")
  return 1
}

oliphaunt_mobile_static_extension_source_rel() {
  oliphaunt_mobile_static_spec_field "$(oliphaunt_mobile_static_extension_spec "$1")" 4
}

oliphaunt_static_symbol_prefix() {
  local stem="${1:?missing mobile static module stem}"
  printf 'oliphaunt_static_'
  printf '%s' "$stem" | tr -c 'A-Za-z0-9_' '_'
  printf '\n'
}

oliphaunt_mobile_static_extension_source_dir() {
  local repo_root="${1:?missing repo root}"
  local build_dir="${2:?missing PostgreSQL build dir}"
  local extension="${3:?missing mobile static extension}"
  local rel
  rel="$(oliphaunt_mobile_static_extension_source_rel "$extension")"
  case "$(oliphaunt_mobile_static_extension_kind "$extension")" in
    contrib) printf '%s/%s\n' "$build_dir" "$rel" ;;
    external) printf '%s/%s\n' "$repo_root" "$rel" ;;
    *) return 1 ;;
  esac
}

oliphaunt_mobile_static_extension_source_files() {
  local repo_root="${1:?missing repo root}"
  local build_dir="${2:?missing PostgreSQL build dir}"
  local extension="${3:?missing mobile static extension}"
  local source_dir
  source_dir="$(oliphaunt_mobile_static_extension_source_dir "$repo_root" "$build_dir" "$extension")"
  local configured_source source_subdir used_configured_source
  used_configured_source=0
  while IFS= read -r configured_source; do
    [ -n "$configured_source" ] || continue
    printf '%s\n' "$source_dir/$configured_source"
    used_configured_source=1
  done < <(oliphaunt_mobile_static_extension_list_field "$extension" 15)
  while IFS= read -r source_subdir; do
    [ -n "$source_subdir" ] || continue
    if [ -d "$source_dir/$source_subdir" ]; then
      find "$source_dir/$source_subdir" -type f -name '*.c' -print | LC_ALL=C sort
      used_configured_source=1
    fi
  done < <(oliphaunt_mobile_static_extension_list_field "$extension" 16)
  [ "$used_configured_source" -eq 0 ] || return 0
  if find "$source_dir" -maxdepth 1 -type f -name '*.c' -print -quit | grep -q .; then
    find "$source_dir" -maxdepth 1 -type f -name '*.c' -print | LC_ALL=C sort
    return 0
  fi
  if [ -d "$source_dir/src" ]; then
    find "$source_dir/src" -maxdepth 1 -type f -name '*.c' -print | LC_ALL=C sort
  fi
}

oliphaunt_mobile_static_extension_include_dirs() {
  local repo_root="${1:?missing repo root}"
  local build_dir="${2:?missing PostgreSQL build dir}"
  local extension="${3:?missing mobile static extension}"
  local dependency include_dir source_dir
  source_dir="$(oliphaunt_mobile_static_extension_source_dir "$repo_root" "$build_dir" "$extension")"
  printf '%s\n' "$source_dir"
  if [ -n "${OLIPHAUNT_MOBILE_STATIC_DEPENDENCY_ROOT:-}" ]; then
    while IFS= read -r dependency; do
      [ -n "$dependency" ] || continue
      printf '%s/%s/include\n' "$OLIPHAUNT_MOBILE_STATIC_DEPENDENCY_ROOT" "$dependency"
    done < <(oliphaunt_mobile_static_extension_list_field "$extension" 8)
  fi
  while IFS= read -r include_dir; do
    [ -n "$include_dir" ] || continue
    oliphaunt_mobile_static_expand_path "$repo_root" "$build_dir" "$source_dir" "$include_dir"
  done < <(oliphaunt_mobile_static_extension_list_field "$extension" 9)
}

oliphaunt_mobile_static_extension_cflags() {
  oliphaunt_mobile_static_extension_list_field "$1" 10
}

oliphaunt_mobile_static_extension_hash_inputs() {
  local repo_root="${1:?missing repo root}"
  local build_dir="${2:?missing PostgreSQL build dir}"
  local extension="${3:?missing mobile static extension}"
  local source_dir
  source_dir="$(oliphaunt_mobile_static_extension_source_dir "$repo_root" "$build_dir" "$extension")"
  if [ ! -d "$source_dir" ]; then
    return 0
  fi
  find "$source_dir" -maxdepth 3 -type f \( \
    -name '*.c' -o \
    -name '*.h' -o \
    -name '*.control' -o \
    -path '*/sql/*.sql' -o \
    -name '*.sql' -o \
    -name 'Makefile' \
  \) -print | LC_ALL=C sort
  local dependency_dir hash_dir hash_source_dependency
  while IFS= read -r hash_source_dependency; do
    [ -n "$hash_source_dependency" ] || continue
    dependency_dir="$repo_root/target/oliphaunt-sources/checkouts/$hash_source_dependency"
    oliphaunt_mobile_static_hash_tree "$dependency_dir"
  done < <(oliphaunt_mobile_static_extension_hash_source_dependencies "$extension")
  while IFS= read -r hash_dir; do
    [ -n "$hash_dir" ] || continue
    oliphaunt_mobile_static_hash_tree \
      "$(oliphaunt_mobile_static_expand_path "$repo_root" "$build_dir" "$source_dir" "$hash_dir")"
  done < <(oliphaunt_mobile_static_extension_list_field "$extension" 14)
}

oliphaunt_mobile_static_extension_hash_source_dependencies() {
  local extension="${1:?missing mobile static extension}"
  if [ -n "${oliphaunt_mobile_target:-}" ]; then
    case "$oliphaunt_mobile_target" in
      ios | ios-simulator | ios-device)
        oliphaunt_mobile_static_extension_list_field "$extension" 12 11
        return 0
        ;;
      android | android-arm64 | android-x86_64 | arm64-v8a | x86_64)
        oliphaunt_mobile_static_extension_list_field "$extension" 13 11
        return 0
        ;;
    esac
  fi
  oliphaunt_mobile_static_extension_list_field "$extension" 11
}

oliphaunt_mobile_static_expand_path() {
  local repo_root="${1:?missing repo root}"
  local build_dir="${2:?missing PostgreSQL build dir}"
  local source_dir="${3:?missing source dir}"
  local path="${4:?missing path}"
  case "$path" in
    repo:*) printf '%s/%s\n' "$repo_root" "${path#repo:}" ;;
    build:*) printf '%s/%s\n' "$build_dir" "${path#build:}" ;;
    source:*) printf '%s/%s\n' "$source_dir" "${path#source:}" ;;
    /*) printf '%s\n' "$path" ;;
    *) printf '%s/%s\n' "$repo_root" "$path" ;;
  esac
}

oliphaunt_mobile_static_hash_tree() {
  local dir="$1"
  [ -d "$dir" ] || return 0
  find "$dir" -maxdepth 3 -type f \( \
    -name '*.c' -o \
    -name '*.cc' -o \
    -name '*.cpp' -o \
    -name '*.h' -o \
    -name '*.hpp' -o \
    -name '*.in' -o \
    -name '*.conf' -o \
    -name 'CMakeLists.txt' -o \
    -name 'Configure' -o \
    -name 'VERSION.dat' -o \
    -name 'configure' -o \
    -name 'configure.ac' -o \
    -name 'Makefile' -o \
    -name 'Makefile.in' \
  \) -print | LC_ALL=C sort
}
