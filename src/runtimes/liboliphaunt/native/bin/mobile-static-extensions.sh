#!/usr/bin/env bash

oliphaunt_mobile_static_specs_tsv() {
  if [ -n "${OLIPHAUNT_MOBILE_STATIC_SPECS_TSV:-}" ]; then
    printf '%s\n' "$OLIPHAUNT_MOBILE_STATIC_SPECS_TSV"
    return 0
  fi
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

oliphaunt_native_component_contract_field() {
  local extension="${1:?missing extension}"
  local family="${2:?missing artifact family}"
  local kind="${3:?missing artifact kind}"
  local target="${4:?missing artifact target}"
  local field="${5:?missing component closure field}"
  local script_dir repo_root
  script_dir="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
  repo_root="$(CDPATH= cd -- "$script_dir/../../../../.." && pwd)"
  "$repo_root/tools/dev/bun.sh" \
    "$repo_root/src/extensions/tools/native-component-contract.mjs" \
    field "$extension" "$family" "$kind" "$target" "$field"
}

oliphaunt_mobile_native_component_target() {
  case "${1:?missing mobile target}" in
    ios | ios-simulator | ios-device | macos | macos-arm64) printf '%s\n' ios-xcframework ;;
    android | android-arm64 | arm64-v8a | android-arm64-v8a) printf '%s\n' android-arm64-v8a ;;
    android-x86_64 | x86_64) printf '%s\n' android-x86_64 ;;
    *) return 1 ;;
  esac
}

oliphaunt_mobile_static_extension_components_for_target() {
  local extension="${1:?missing mobile static extension}"
  local target
  target="$(oliphaunt_mobile_native_component_target "${2:?missing mobile target}")" || return 1
  oliphaunt_native_component_contract_field \
    "$extension" native native-static-registry "$target" components
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
    ios | ios-simulator | ios-device | macos | macos-arm64)
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
  local script_dir repo_root candidate
  script_dir="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
  repo_root="$(CDPATH= cd -- "$script_dir/../../../../.." && pwd)"
  while IFS= read -r candidate; do
    [ -n "$candidate" ] || continue
    printf '%s/%s\n' "$dependency_root" "$candidate"
  done < <(
    "$repo_root/tools/dev/bun.sh" \
      "$repo_root/src/extensions/tools/native-component-contract.mjs" \
      archive-candidates "$dependency"
  )
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
      ios | ios-simulator | ios-device | macos | macos-arm64)
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

# PostgreSQL installs dict_snowball as a loadable runtime-support module even
# though its SQL objects live in pg_catalog rather than in a CREATE EXTENSION
# product. Mobile runtimes cannot dlopen that module, so build the exact pinned
# PostgreSQL sources into liboliphaunt and expose them through the built-in
# static-extension registry.
oliphaunt_mobile_builtin_snowball_prefix() {
  printf '%s\n' 'oliphaunt_builtin_dict_snowball'
}

oliphaunt_mobile_builtin_snowball_source_files() {
  local postgres_build_dir="${1:?missing PostgreSQL build dir}"
  local source_root="$postgres_build_dir/src/backend/snowball"
  printf '%s\n' \
    "$source_root/dict_snowball.c" \
    "$source_root/libstemmer/api.c" \
    "$source_root/libstemmer/utilities.c"
  find "$source_root/libstemmer" -maxdepth 1 -type f -name 'stem_*.c' -print | LC_ALL=C sort
}

oliphaunt_mobile_builtin_snowball_sources_ready() {
  local postgres_build_dir="${1:?missing PostgreSQL build dir}"
  local source_root="$postgres_build_dir/src/backend/snowball"
  [ -f "$source_root/dict_snowball.c" ] &&
    [ -f "$source_root/libstemmer/api.c" ] &&
    [ -f "$source_root/libstemmer/utilities.c" ] &&
    [ -f "$source_root/libstemmer/stem_UTF_8_english.c" ]
}

oliphaunt_mobile_builtin_snowball_object_path() {
  local postgres_build_dir="${1:?missing PostgreSQL build dir}"
  local output_dir="${2:?missing output dir}"
  local source="${3:?missing Snowball source}"
  local source_root="$postgres_build_dir/src/backend/snowball"
  local source_rel="${source#"$source_root"/}"
  printf '%s/runtime-support/dict_snowball/%s.o\n' "$output_dir" "${source_rel%.c}"
}

oliphaunt_mobile_builtin_snowball_refresh_objects() {
  oliphaunt_mobile_builtin_snowball_sources_ready "$build_dir" || return 1
  local source object
  snowball_objects=()
  while IFS= read -r source; do
    [ -n "$source" ] || continue
    object="$(oliphaunt_mobile_builtin_snowball_object_path "$build_dir" "$out_dir" "$source")"
    snowball_objects+=("$object")
  done < <(oliphaunt_mobile_builtin_snowball_source_files "$build_dir")
}

oliphaunt_mobile_builtin_snowball_linked_symbols_ready() {
  local symbols="${1-}"
  local prefix
  prefix="$(oliphaunt_mobile_builtin_snowball_prefix)"
  local symbol
  for symbol in \
    "${prefix}_Pg_magic_func" \
    dsnowball_init \
    pg_finfo_dsnowball_init \
    dsnowball_lexize \
    pg_finfo_dsnowball_lexize
  do
    oliphaunt_text_has_nm_symbol "$symbols" "$symbol" || return 1
  done
}

oliphaunt_mobile_builtin_snowball_objects_ready() {
  oliphaunt_mobile_builtin_snowball_refresh_objects || return 1
  local object
  for object in ${snowball_objects[@]+"${snowball_objects[@]}"}; do
    [ -s "$object" ] || return 1
  done
  local dict_object="$out_dir/runtime-support/dict_snowball/dict_snowball.o"
  local symbols
  symbols="$("${snowball_nm[@]}" -g "$dict_object" 2>/dev/null || true)"
  oliphaunt_mobile_builtin_snowball_linked_symbols_ready "$symbols"
}

oliphaunt_build_mobile_builtin_snowball() {
  oliphaunt_mobile_builtin_snowball_refresh_objects || {
    echo "PostgreSQL Snowball sources are incomplete under $build_dir" >&2
    return 1
  }
  local prefix source object
  prefix="$(oliphaunt_mobile_builtin_snowball_prefix)"
  rm -rf "$out_dir/runtime-support/dict_snowball"
  while IFS= read -r source; do
    [ -n "$source" ] || continue
    object="$(oliphaunt_mobile_builtin_snowball_object_path "$build_dir" "$out_dir" "$source")"
    mkdir -p "$(dirname "$object")"
    if ! "${cc[@]}" $pg_extension_cflags \
      -DPg_magic_func="${prefix}_Pg_magic_func" \
      -I"$build_dir/src/include" \
      -I"$build_dir/src/include/port" \
      -I"$build_dir/src/include/snowball" \
      -I"$build_dir/src/include/snowball/libstemmer" \
      -c "$source" \
      -o "$object" >> "$make_log" 2>&1
    then
      echo "failed to compile built-in dict_snowball source: $source" >&2
      oliphaunt_tail_log_excerpt "$make_log" >&2 || true
      return 1
    fi
  done < <(oliphaunt_mobile_builtin_snowball_source_files "$build_dir")
  if ! oliphaunt_mobile_builtin_snowball_objects_ready; then
    echo "built-in dict_snowball object closure is incomplete" >&2
    return 1
  fi
}
